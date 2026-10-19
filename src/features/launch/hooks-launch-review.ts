import { createHash } from "node:crypto";

import { z } from "zod";

import type { HooksLaunchLoopDynamicParams } from "./hooks-launch-config.js";
import {
  HooksLaunchBuybackRecipientFixedError,
  assertHooksLaunchFixedBuybackRecipient,
  hooksLaunchFactoryHashPolicy,
  hooksLaunchRejectionReasons,
  type HooksLaunchTemplateFactory,
} from "./hooks-launch-project-config.js";
import {
  launchTokenDescriptionMaxCodePoints,
  launchTokenTextMaxRawLength,
} from "./launch-token-text.js";

/**
 * Decision 0108: platform-side Hooks launch review (ported from the requirer
 * branch `codex/integrated-dual-pool-20261008` ops control plane, original
 * Decisions 0093/0094; the web console was not ported).
 *
 * Editor, approver, and testnet acceptor are separate scoped permissions on
 * individual `ops_operators` (LOOP users). Separation of duties is enforced
 * here and in the repository, never only by hiding a button:
 *
 * - the editor of a config version (the operator who saved it, or the
 *   project owner for an owner-saved draft) can never approve it;
 * - the project owner can never approve or accept their own project;
 * - a testnet acceptance needs an approved config and an acceptor who did
 *   not edit that version.
 *
 * Nothing here signs, broadcasts, deploys, or activates a contract.
 */

export const hooksLaunchOpsPermissions = [
  "audit.read",
  "launch.read",
  "launch.edit",
  "launch.approve",
  "testnet.read",
  "testnet.accept",
] as const;

export type HooksLaunchOpsPermission =
  (typeof hooksLaunchOpsPermissions)[number];

/** Permissions a deployment admin may scope to one launch project ID. */
export const hooksLaunchProjectScopedPermissions: ReadonlySet<HooksLaunchOpsPermission> =
  new Set([
    "launch.read",
    "launch.edit",
    "launch.approve",
    "testnet.read",
    "testnet.accept",
  ]);

export const hooksLaunchReviewErrorCodes = [
  "OPS_FORBIDDEN",
  "OPS_NOT_FOUND",
  "OPS_INVALID_COMMAND",
  "OPS_INVALID_LAUNCH_CONFIG",
  "OPS_LAUNCH_NOT_APPROVED",
  "OPS_LAUNCH_CONFIG_NOT_APPROVED",
  "OPS_VERSION_CONFLICT",
  "OPS_SELF_APPROVAL",
  "OPS_SELF_ACCEPTANCE",
  "OPS_IDEMPOTENCY_CONFLICT",
  "OPS_UNAVAILABLE",
  "OPS_COMMAND_FAILED",
  /** Decision 0122: a config names another buyback recipient. */
  "OPS_BUYBACK_RECIPIENT_FIXED",
  /** Decision 0122: the catalog project is not submitted / in review. */
  "OPS_LAUNCH_NOT_IN_REVIEW",
  /** Decision 0122: the config version was already approved or rejected. */
  "OPS_LAUNCH_CONFIG_DECIDED",
] as const;

export type HooksLaunchReviewErrorCode =
  (typeof hooksLaunchReviewErrorCodes)[number];

export class HooksLaunchReviewError extends Error {
  constructor(readonly code: HooksLaunchReviewErrorCode) {
    super(code);
    this.name = "HooksLaunchReviewError";
  }
}

const hash32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const hooksLaunchOperatorConfigSchema = z
  .object({
    // Decision 0164: shape only; `parseHooksLaunchDraft` (repository)
    // applies the shared name / ticker rule.
    name: z.string().trim().min(1).max(launchTokenTextMaxRawLength),
    ticker: z.string().trim().min(1).max(launchTokenTextMaxRawLength),
    logoAssetUrl: z.url().startsWith("https://"),
    // Decision 0154: characters, not UTF-16 units (an emoji is two).
    description: z
      .string()
      .refine(
        (value) =>
          Array.from(value).length <= launchTokenDescriptionMaxCodePoints,
      ),
    links: z.array(z.url().startsWith("https://")).max(8),
    nftSaleStartAt: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    buybackRecipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();

const hooksTestnetAcceptanceSchema = z
  .object({
    configVersion: z.number().int().positive().max(2_147_483_647),
    configHash: hash32Schema,
    contractManifestHash: hash32Schema,
    checklistVersion: z.string().regex(/^hooks-testnet-v[1-9][0-9]*$/),
    outcome: z.enum(["passed", "failed", "incomplete"]),
    evidence: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(100),
            uri: z.union([
              z.url().startsWith("https://"),
              z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

const commandBase = {
  operationId: z.uuid(),
  target: z.uuid(),
  reason: z.string().trim().min(1).max(500),
};

/**
 * Decision 0122 (requirer ruling 7): a rejection names one of five reasons;
 * `other` needs a note (1–500 characters after trim). The note is shown
 * to the applicant.
 */
const rejectionFields = {
  reasonCode: z.enum(hooksLaunchRejectionReasons),
  note: z.string().trim().min(1).max(500).nullable(),
};
function requireOtherNote(
  value: { readonly reasonCode: string; readonly note: string | null },
  context: z.RefinementCtx,
): void {
  if (value.reasonCode === "other" && value.note === null) {
    context.addIssue({
      code: "custom",
      message: "other requires a note",
      path: ["note"],
    });
  }
}

export const hooksLaunchReviewCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...commandBase,
      action: z.literal("launch.config.save"),
      payload: z
        .object({
          expectedVersion: z.number().int().nonnegative().max(2_147_483_646),
          config: hooksLaunchOperatorConfigSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      action: z.literal("launch.config.approve"),
      payload: z
        .object({
          configVersion: z.number().int().positive().max(2_147_483_647),
          configHash: hash32Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      action: z.literal("testnet.acceptance.record"),
      payload: hooksTestnetAcceptanceSchema,
    })
    .strict(),
  // Decision 0122: reviewer rejections.
  z
    .object({
      ...commandBase,
      action: z.literal("launch.config.reject"),
      payload: z
        .object({
          configVersion: z.number().int().positive().max(2_147_483_647),
          configHash: hash32Schema,
          ...rejectionFields,
        })
        .strict()
        .superRefine(requireOtherNote),
    })
    .strict(),
  // Decision 0125: reviewer approval of the catalog material (the console
  // counterpart of `pnpm launch:review <id> approve`).
  z
    .object({
      ...commandBase,
      action: z.literal("launch.project.approve"),
      payload: z
        .object({
          materialVersion: z.number().int().positive().max(2_147_483_647),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      action: z.literal("launch.project.reject"),
      payload: z
        .object({
          materialVersion: z.number().int().positive().max(2_147_483_647),
          ...rejectionFields,
        })
        .strict()
        .superRefine(requireOtherNote),
    })
    .strict(),
]);

export type HooksLaunchReviewCommand = z.infer<
  typeof hooksLaunchReviewCommandSchema
>;

export function hooksLaunchCommandPermission(
  action: HooksLaunchReviewCommand["action"],
): HooksLaunchOpsPermission {
  if (action === "launch.config.save") return "launch.edit";
  // Decision 0122: rejecting follows the approval permission model.
  if (
    action === "launch.config.approve" ||
    action === "launch.config.reject" ||
    action === "launch.project.approve" ||
    action === "launch.project.reject"
  ) {
    return "launch.approve";
  }
  return "testnet.accept";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  const encoded: unknown = JSON.stringify(value);
  if (typeof encoded !== "string") {
    throw new HooksLaunchReviewError("OPS_INVALID_COMMAND");
  }
  return encoded;
}

/** SHA-256 of the canonical JSON form; binds an operationId to its content. */
export function hooksLaunchCommandHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface HooksLaunchOperatorSession {
  readonly operatorId: string;
  readonly label: string;
  readonly grants: readonly {
    readonly permission: string;
    readonly scope: string;
  }[];
}

export interface HooksLaunchReviewCommandResult {
  readonly operationId: string;
  readonly result: unknown;
  readonly replayed: boolean;
}

export interface HooksLaunchReviewPage {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor: string | null;
}

export interface HooksLaunchReviewRepository {
  session(actor: string): Promise<HooksLaunchOperatorSession>;
  listProjects(actor: string, before?: string): Promise<HooksLaunchReviewPage>;
  listTestnetAcceptances(
    actor: string,
    before?: string,
  ): Promise<HooksLaunchReviewPage>;
  execute(
    actor: string,
    command: HooksLaunchReviewCommand,
    context?: HooksLaunchReviewExecuteContext,
  ): Promise<HooksLaunchReviewCommandResult>;
}

/**
 * Decision 0119: `launch.config.save` hashes the config for the target
 * Factory's `nftSaleDuration()`; the service reads it before the
 * transaction and the repository refuses a save without it.
 */
export interface HooksLaunchReviewExecuteContext {
  readonly nftSaleDurationSeconds?: number;
  /** Decision 0132: a LoopDynamic target Factory's Hook parameters. */
  readonly loopDynamic?: HooksLaunchLoopDynamicParams;
}

export interface HooksLaunchReviewService {
  session(actor: string): Promise<HooksLaunchOperatorSession>;
  listProjects(actor: string, before?: string): Promise<HooksLaunchReviewPage>;
  listTestnetAcceptances(
    actor: string,
    before?: string,
  ): Promise<HooksLaunchReviewPage>;
  /** Parses an untrusted command body before any database work. */
  execute(
    actor: string,
    body: unknown,
  ): Promise<HooksLaunchReviewCommandResult>;
}

/**
 * The service fails closed (`OPS_UNAVAILABLE`) without a repository and
 * validates the command shape before the repository authorizes it.
 */
export function createHooksLaunchReviewService(input: {
  readonly repository: HooksLaunchReviewRepository | null;
  /** The target Factory (Decision 0119); null fails config saves closed. */
  readonly factory?: HooksLaunchTemplateFactory | null;
  /**
   * Decision 0122: `LAUNCH2_BUYBACK_RECIPIENT`; an operator save naming
   * another address is `OPS_BUYBACK_RECIPIENT_FIXED`, none configured
   * `OPS_UNAVAILABLE`. Absent = not configured.
   */
  readonly fixedBuybackRecipient?: string | null;
}): HooksLaunchReviewService {
  function requireRepository(): HooksLaunchReviewRepository {
    if (input.repository === null) {
      throw new HooksLaunchReviewError("OPS_UNAVAILABLE");
    }
    return input.repository;
  }
  function requireActor(actor: string): string {
    if (!z.uuid().safeParse(actor).success) {
      throw new HooksLaunchReviewError("OPS_FORBIDDEN");
    }
    return actor;
  }
  function requireCursor(before: string | undefined): string | undefined {
    if (before !== undefined && !z.uuid().safeParse(before).success) {
      throw new HooksLaunchReviewError("OPS_INVALID_COMMAND");
    }
    return before;
  }
  return Object.freeze({
    async session(actor: string) {
      return requireRepository().session(requireActor(actor));
    },
    async listProjects(actor: string, before?: string) {
      return requireRepository().listProjects(
        requireActor(actor),
        requireCursor(before),
      );
    },
    async listTestnetAcceptances(actor: string, before?: string) {
      return requireRepository().listTestnetAcceptances(
        requireActor(actor),
        requireCursor(before),
      );
    },
    async execute(actor: string, body: unknown) {
      const repository = requireRepository();
      const parsed = hooksLaunchReviewCommandSchema.safeParse(body);
      if (!parsed.success) {
        throw new HooksLaunchReviewError("OPS_INVALID_COMMAND");
      }
      const operator = requireActor(actor);
      if (parsed.data.action !== "launch.config.save") {
        return repository.execute(operator, parsed.data);
      }
      try {
        assertHooksLaunchFixedBuybackRecipient(
          input.fixedBuybackRecipient ?? null,
          parsed.data.payload.config.buybackRecipient,
        );
      } catch (error) {
        throw new HooksLaunchReviewError(
          error instanceof HooksLaunchBuybackRecipientFixedError
            ? "OPS_BUYBACK_RECIPIENT_FIXED"
            : "OPS_UNAVAILABLE",
        );
      }
      const factory = input.factory ?? null;
      let policy: Awaited<ReturnType<typeof hooksLaunchFactoryHashPolicy>>;
      try {
        if (factory === null) throw new Error("no Factory");
        policy = await hooksLaunchFactoryHashPolicy(factory);
      } catch {
        throw new HooksLaunchReviewError("OPS_UNAVAILABLE");
      }
      // OfficialTax: exactly the pre-0132 context (no loopDynamic key).
      return repository.execute(operator, parsed.data, policy);
    },
  } satisfies HooksLaunchReviewService);
}
