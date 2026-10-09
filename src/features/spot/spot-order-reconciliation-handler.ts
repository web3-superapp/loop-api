import { z } from "zod";

import type {
  AtomicDomainReconciliationHandler,
  AuthoritativeReadResult,
} from "../reconciliation/authoritative-reader.js";
import type {
  SpotIntentReconciliationSubject,
  SpotIntentTerminalResolution,
  SpotReconciliationRepository,
} from "./spot-reconciliation-contract.js";
import {
  parseSpotIntentTerminalResolution,
  spotIntentTerminalResolutionMatchesAuthority,
} from "./spot-reconciliation-terminal.js";

const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const retryAfterMsSchema = z.number().int().min(0).max(86_400_000);
const unresolvedReadResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pending"),
      reasonCode: reasonCodeSchema.optional(),
      retryAfterMs: retryAfterMsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retry"),
      reasonCode: reasonCodeSchema,
      retryAfterMs: retryAfterMsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("operator_required"),
      reasonCode: reasonCodeSchema,
    })
    .strict(),
]);
const resolvedReadResultSchema = z
  .object({
    kind: z.literal("resolved"),
    resolution: z.unknown(),
  })
  .strict();
const supportedSpotIocSubjectSchema = z.object({
  network: z.literal("testnet"),
  accountKind: z.literal("master"),
  exchangeOrderAsset: z.number().int().nonnegative(),
  side: z.enum(["buy", "sell"]),
  computedBaseSize: z.string(),
  worstIocLimitPrice: z.string(),
  clientOrderId: z.string(),
  canonicalAction: z
    .object({
      type: z.literal("order"),
      orders: z.tuple([
        z
          .object({
            a: z.number().int().nonnegative(),
            b: z.boolean(),
            p: z.string(),
            s: z.string(),
            r: z.literal(false),
            t: z
              .object({
                limit: z.object({ tif: z.literal("Ioc") }).strict(),
              })
              .strict(),
            c: z.string(),
          })
          .strict(),
      ]),
      grouping: z.literal("na"),
    })
    .strict(),
});

export type SpotOrderAuthoritativeReadResult =
  | Readonly<{
      kind: "resolved";
      resolution: SpotIntentTerminalResolution;
    }>
  | Readonly<{
      kind: "pending";
      reasonCode?: string;
      retryAfterMs?: number;
    }>
  | Readonly<{
      kind: "retry";
      reasonCode: string;
      retryAfterMs?: number;
    }>
  | Readonly<{
      kind: "operator_required";
      reasonCode: string;
    }>;

export interface SpotOrderAuthoritativeReader {
  read(input: {
    readonly readRequestId: string;
    readonly subject: SpotIntentReconciliationSubject;
    readonly signal: AbortSignal;
  }): Promise<SpotOrderAuthoritativeReadResult>;
}

export interface CreateSpotOrderReconciliationHandlerInput {
  readonly repository: SpotReconciliationRepository;
  readonly reader: SpotOrderAuthoritativeReader;
}

function operatorRequired(reasonCode: string): AuthoritativeReadResult {
  return Object.freeze({ kind: "operator_required", reasonCode });
}

function unresolvedResult(
  result: z.infer<typeof unresolvedReadResultSchema>,
): AuthoritativeReadResult {
  if (result.kind === "operator_required") {
    return Object.freeze({
      kind: result.kind,
      reasonCode: result.reasonCode,
    });
  }
  if (result.kind === "retry") {
    return Object.freeze({
      kind: result.kind,
      reasonCode: result.reasonCode,
      ...(result.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.retryAfterMs }),
    });
  }
  return Object.freeze({
    kind: result.kind,
    ...(result.reasonCode === undefined
      ? {}
      : { reasonCode: result.reasonCode }),
    ...(result.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: result.retryAfterMs }),
  });
}

function isSupportedSpotIocOrder(subject: unknown): boolean {
  const parsed = supportedSpotIocSubjectSchema.safeParse(subject);
  if (!parsed.success) {
    return false;
  }
  const supported = parsed.data;
  const [order] = supported.canonicalAction.orders;
  return (
    order.a === supported.exchangeOrderAsset &&
    order.b === (supported.side === "buy") &&
    order.p === supported.worstIocLimitPrice &&
    order.s === supported.computedBaseSize &&
    order.c === supported.clientOrderId
  );
}

/**
 * Bridges one generic fenced lease to the Spot-only read/finalize boundary.
 * This handler contains no signer, Exchange action, retrying writer, or replay
 * capability, and it never delegates completion back to the generic writer.
 */
export function createSpotOrderReconciliationHandler(
  input: CreateSpotOrderReconciliationHandlerInput,
): AtomicDomainReconciliationHandler {
  return async (runInput) => {
    if (
      runInput.subject.domain !== "hyperliquid" ||
      runInput.subject.operationKind !== "spot_intent" ||
      runInput.subject.transportAttemptId === null ||
      runInput.lease.attemptCommittedAt === null
    ) {
      return operatorRequired("invalid_spot_reconciliation_subject");
    }

    const subject = await input.repository.loadClaimedSpotIntentSubject({
      ownerUserId: runInput.subject.ownerUserId,
      operationId: runInput.subject.operationId,
      workerId: runInput.lease.workerId,
      fenceToken: runInput.lease.fenceToken,
      recordVersion: runInput.lease.recordVersion,
    });

    if (
      subject.operationId !== runInput.subject.operationId ||
      subject.ownerUserId !== runInput.subject.ownerUserId ||
      subject.transportAttemptId !== runInput.subject.transportAttemptId ||
      subject.attemptCommittedAt !== runInput.lease.attemptCommittedAt
    ) {
      return operatorRequired("invalid_spot_reconciliation_subject");
    }
    if (!isSupportedSpotIocOrder(subject)) {
      return operatorRequired("unsupported_spot_reconciliation_action");
    }

    const rawResult: unknown = await input.reader.read({
      readRequestId: runInput.readRequestId,
      subject,
      signal: runInput.signal,
    });
    runInput.signal.throwIfAborted();

    const resolvedEnvelope = resolvedReadResultSchema.safeParse(rawResult);
    if (!resolvedEnvelope.success) {
      const unresolved = unresolvedReadResultSchema.safeParse(rawResult);
      return unresolved.success
        ? unresolvedResult(unresolved.data)
        : operatorRequired("invalid_spot_reconciliation_result");
    }

    let resolution: SpotIntentTerminalResolution;
    try {
      resolution = parseSpotIntentTerminalResolution(
        resolvedEnvelope.data.resolution,
      );
    } catch {
      return operatorRequired("invalid_spot_reconciliation_result");
    }
    if (!spotIntentTerminalResolutionMatchesAuthority(subject, resolution)) {
      return operatorRequired("invalid_spot_reconciliation_result");
    }

    runInput.signal.throwIfAborted();
    await input.repository.finalizeSpotIntentResolution({
      ownerUserId: runInput.subject.ownerUserId,
      operationId: runInput.subject.operationId,
      workerId: runInput.lease.workerId,
      fenceToken: runInput.lease.fenceToken,
      recordVersion: runInput.lease.recordVersion,
      expectedIntentRecordVersion: subject.intentRecordVersion,
      requestId: runInput.finalizationRequestId,
      resolution,
    });

    return Object.freeze({
      kind: "resolved",
      state: resolution.state === "rejected" ? "rejected" : "succeeded",
      ...(resolution.reasonCode === null
        ? {}
        : { reasonCode: resolution.reasonCode }),
    });
  };
}
