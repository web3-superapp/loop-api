import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { createPostgresSupportTicketRepository } from "../src/database/support-ticket-repository.js";
import {
  normalizeSupportText,
  SupportTextInvalidError,
} from "../src/features/support/support-contract.js";
import {
  SupportTicketNotFoundError,
  SupportTicketStateError,
  type SupportTicketRecord,
  type SupportTicketRepository,
} from "../src/features/support/support-ticket-repository.js";

/**
 * Dev-only operator path that advances a support ticket (Decision 0037).
 *
 * `pnpm support:answer <ticketId> [note]` moves `open → answered` with an
 * optional sanitized reply note; `pnpm support:answer <ticketId> --close
 * [note]` moves `open|answered → closed`. The API never changes a ticket
 * status. The script refuses `NODE_ENV=production`; the reviewed Admin
 * console and RBAC land in D17.
 */

export type SupportAnswerErrorCode =
  | "support_answer_arguments_invalid"
  | "support_answer_database_unconfigured"
  | "support_answer_forbidden_in_production"
  | "support_answer_not_found"
  | "support_answer_invalid_transition"
  | "support_answer_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateSupportAnswerRepository = (databaseUrl: string) => {
  readonly repository: SupportTicketRepository;
  readonly close: () => Promise<void>;
};

export interface RunSupportAnswerOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createRepository?: CreateSupportAnswerRepository;
}

export class SupportAnswerError extends Error {
  constructor(readonly code: SupportAnswerErrorCode) {
    super("Support ticket advance failed");
    this.name = "SupportAnswerError";
  }
}

function defaultCreateRepository(databaseUrl: string): {
  readonly repository: SupportTicketRepository;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    application_name: "loop-api-support-answer",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresSupportTicketRepository(pool),
    close: () => pool.end(),
  };
}

export interface SupportAnswerRequest {
  readonly ticketId: string;
  readonly eventType: "answered" | "closed";
  readonly note: string | null;
  readonly databaseUrl: string;
}

/**
 * Parse and authorize the operator request. Production is refused before any
 * connection is opened, so the script cannot become an unreviewed production
 * admin path.
 */
export function parseSupportAnswerRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): SupportAnswerRequest {
  const nodeEnv = environment["NODE_ENV"]?.trim();
  if (nodeEnv === "production") {
    throw new SupportAnswerError("support_answer_forbidden_in_production");
  }

  const positional = argv.slice(2);
  const close = positional.includes("--close");
  const rest = positional.filter((value) => value !== "--close");
  const ticketId = rest[0];
  const rawNote = rest[1];
  if (
    rest.length < 1 ||
    rest.length > 2 ||
    ticketId === undefined ||
    !opaqueIdPattern.test(ticketId)
  ) {
    throw new SupportAnswerError("support_answer_arguments_invalid");
  }
  let note: string | null = null;
  if (rawNote !== undefined) {
    try {
      note = normalizeSupportText(rawNote);
    } catch (error) {
      if (error instanceof SupportTextInvalidError) {
        throw new SupportAnswerError("support_answer_arguments_invalid");
      }
      throw error;
    }
  }

  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new SupportAnswerError("support_answer_database_unconfigured");
  }

  return Object.freeze({
    ticketId,
    eventType: close ? "closed" : "answered",
    note,
    databaseUrl,
  });
}

export async function answerSupportTicket(
  request: SupportAnswerRequest,
  createRepository: CreateSupportAnswerRepository = defaultCreateRepository,
): Promise<SupportTicketRecord> {
  const { repository, close } = createRepository(request.databaseUrl);
  try {
    return await repository.advance({
      ticketId: request.ticketId,
      eventType: request.eventType,
      note: request.note,
      requestId: randomUUID(),
    });
  } catch (error) {
    if (error instanceof SupportTicketNotFoundError) {
      throw new SupportAnswerError("support_answer_not_found");
    }
    if (error instanceof SupportTicketStateError) {
      throw new SupportAnswerError("support_answer_invalid_transition");
    }
    throw new SupportAnswerError("support_answer_failed");
  } finally {
    await close();
  }
}

export async function runSupportAnswer(
  options: RunSupportAnswerOptions,
): Promise<0 | 1> {
  let request: SupportAnswerRequest;
  try {
    request = parseSupportAnswerRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof SupportAnswerError
        ? error.code
        : "support_answer_failed";
    options.stderr.write(`Support ticket advance refused (${code})\n`);
    return 1;
  }

  try {
    const record = await answerSupportTicket(request, options.createRepository);
    options.stdout.write(
      `Support ticket ${record.ticketId} is ${record.status} (events ${String(record.events.length)})\n`,
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof SupportAnswerError
        ? error.code
        : "support_answer_failed";
    options.stderr.write(`Support ticket advance failed (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runSupportAnswer({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
