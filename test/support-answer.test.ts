import { describe, expect, it, vi } from "vitest";

import {
  parseSupportAnswerRequest,
  runSupportAnswer,
  SupportAnswerError,
  type CreateSupportAnswerRepository,
} from "../scripts/support-answer.js";
import {
  createUnavailableSupportTicketRepository,
  SupportTicketNotFoundError,
  SupportTicketStateError,
  type SupportTicketRecord,
} from "../src/features/support/support-ticket-repository.js";

const ticketId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const databaseUrl = "postgres://loop_api:local@127.0.0.1:5433/loop_api_s8";

const answered: SupportTicketRecord = {
  ticketId,
  ownerUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
  category: "mining",
  body: "为什么我的币没有权重",
  status: "answered",
  createdAt: "2026-09-09T01:00:00.000Z",
  updatedAt: "2026-09-09T02:00:00.000Z",
  lastEventAt: "2026-09-09T02:00:00.000Z",
  events: [
    {
      eventVersion: 0,
      eventType: "created",
      actor: "user",
      note: null,
      occurredAt: "2026-09-09T01:00:00.000Z",
    },
    {
      eventVersion: 1,
      eventType: "answered",
      actor: "operator",
      note: "已处理",
      occurredAt: "2026-09-09T02:00:00.000Z",
    },
  ],
};

function outputWriter() {
  let output = "";
  return {
    contents: () => output,
    write(value: string): boolean {
      output += value;
      return true;
    },
  };
}

function repositoryFake(error?: Error) {
  const advance = vi.fn(() =>
    error === undefined ? Promise.resolve(answered) : Promise.reject(error),
  );
  const close = vi.fn(() => Promise.resolve());
  const create: CreateSupportAnswerRepository = () => ({
    repository: { ...createUnavailableSupportTicketRepository(), advance },
    close,
  });
  return { advance, close, create };
}

function expectCode(operation: () => unknown, code: string): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SupportAnswerError);
  expect((caught as SupportAnswerError).code).toBe(code);
}

describe("support:answer operator script", () => {
  it("refuses production before opening a connection", () => {
    expectCode(
      () =>
        parseSupportAnswerRequest(["node", "script", ticketId], {
          NODE_ENV: "production",
          DATABASE_URL: databaseUrl,
        }),
      "support_answer_forbidden_in_production",
    );
  });

  it("parses the ticket id, the optional sanitized note, and --close", () => {
    expect(
      parseSupportAnswerRequest(["node", "script", ticketId, "  已处理 "], {
        NODE_ENV: "development",
        DATABASE_URL: databaseUrl,
      }),
    ).toEqual({
      ticketId,
      eventType: "answered",
      note: "已处理",
      databaseUrl,
    });
    expect(
      parseSupportAnswerRequest(["node", "script", "--close", ticketId], {
        DATABASE_URL: databaseUrl,
      }),
    ).toMatchObject({ eventType: "closed", note: null });
    for (const argv of [
      ["node", "script"],
      ["node", "script", "not-a-uuid"],
      ["node", "script", ticketId, "badnote"],
      ["node", "script", ticketId, "a", "b"],
    ]) {
      expectCode(
        () => parseSupportAnswerRequest(argv, { DATABASE_URL: databaseUrl }),
        "support_answer_arguments_invalid",
      );
    }
    expectCode(
      () => parseSupportAnswerRequest(["node", "script", ticketId], {}),
      "support_answer_database_unconfigured",
    );
  });

  it("advances the ticket through the repository and closes the pool", async () => {
    const fake = repositoryFake();
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runSupportAnswer({
      argv: ["node", "script", ticketId, "已处理"],
      environment: { NODE_ENV: "development", DATABASE_URL: databaseUrl },
      stdout,
      stderr,
      createRepository: fake.create,
    });
    expect(exitCode).toBe(0);
    expect(fake.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId,
        eventType: "answered",
        note: "已处理",
      }),
    );
    expect(fake.close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toBe(
      `Support ticket ${ticketId} is answered (events 2)\n`,
    );
    expect(stderr.contents()).toBe("");
  });

  it("reports not-found and invalid transitions as distinct refusals", async () => {
    for (const [error, code] of [
      [new SupportTicketNotFoundError(), "support_answer_not_found"],
      [new SupportTicketStateError(), "support_answer_invalid_transition"],
      [new Error("boom"), "support_answer_failed"],
    ] as const) {
      const fake = repositoryFake(error);
      const stderr = outputWriter();
      const exitCode = await runSupportAnswer({
        argv: ["node", "script", ticketId],
        environment: { DATABASE_URL: databaseUrl },
        stdout: outputWriter(),
        stderr,
        createRepository: fake.create,
      });
      expect(exitCode).toBe(1);
      expect(stderr.contents()).toBe(
        `Support ticket advance failed (${code})\n`,
      );
      expect(fake.close).toHaveBeenCalledOnce();
    }
  });
});
