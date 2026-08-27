import { randomUUID } from "node:crypto";

import { IdempotencyConflictError } from "../../database/control-plane-repository.js";
import {
  SpotIntentAuthorityStaleError,
  SpotIntentClaimLimitExceededError,
  SpotIntentPrepareClaimRequiredError,
  SpotIntentPrepareExpiredError,
  SpotIntentRepositoryUnavailableError,
  type SpotIntentRecord,
  type SpotIntentRepository,
} from "../../database/spot-intent-repository.js";
import {
  canonicalizeSpotIntentRequest,
  digestSpotIntentRequest,
} from "./spot-intent-contract.js";
import {
  SpotIntentClaimRateLimitedError,
  SpotIntentExpiredError,
  SpotIntentIdempotencyConflictError,
  SpotIntentNotFoundError,
  SpotIntentStaleError,
  type SpotIntentWorkflow,
} from "./spot-intent-service.js";
import {
  createSpotClientOrderId,
  parseSpotIntentPrepareAuthority,
  parseSpotIntentReviewDraft,
  sameSpotIntentPrepareAuthority,
  SpotIntentPrepareAuthorityRequiredError,
  SpotIntentPrepareAuthorityUnavailableError,
  SpotIntentReviewerUnavailableError,
  type SpotIntentPrepareAuthority,
  type SpotIntentPrepareAuthorityResolver,
  type SpotIntentReviewer,
} from "./spot-intent-prepare.js";
import { parseOwnedSpotIntentResource } from "./spot-intent-workflow.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "./spot-errors.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;

export type SpotIntentPrepareRepository = Pick<
  SpotIntentRepository,
  "claimPrepare" | "prepare" | "findOwned"
>;

export interface CreateSpotIntentPrepareWorkflowInput {
  readonly repository: SpotIntentPrepareRepository;
  readonly authorityResolver: SpotIntentPrepareAuthorityResolver;
  readonly reviewer: SpotIntentReviewer;
  readonly createUuid?: () => string;
  readonly createClientOrderId?: () => string;
  readonly now?: () => Date;
}

function unavailable(): never {
  throw new SpotUnavailableError();
}

function readNow(now: () => Date): number {
  let value: unknown;
  try {
    value = now();
  } catch {
    return unavailable();
  }
  if (!(value instanceof Date)) {
    return unavailable();
  }
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return unavailable();
  }
  return milliseconds;
}

function freshUuid(createUuid: () => string, used: Set<string>): string {
  let value: unknown;
  try {
    value = createUuid();
  } catch {
    return unavailable();
  }
  if (
    typeof value !== "string" ||
    !uuidPattern.test(value) ||
    used.has(value)
  ) {
    return unavailable();
  }
  used.add(value);
  return value;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof IdempotencyConflictError) {
    throw new SpotIntentIdempotencyConflictError();
  }
  if (error instanceof SpotIntentClaimLimitExceededError) {
    throw new SpotIntentClaimRateLimitedError();
  }
  if (error instanceof SpotIntentPrepareExpiredError) {
    throw new SpotIntentExpiredError();
  }
  if (error instanceof SpotIntentAuthorityStaleError) {
    throw new SpotIntentStaleError();
  }
  if (
    error instanceof SpotIntentPrepareClaimRequiredError ||
    error instanceof SpotIntentRepositoryUnavailableError
  ) {
    return unavailable();
  }
  return unavailable();
}

function assertRecordMatchesPrepare(
  record: SpotIntentRecord,
  expected: Readonly<{
    ownerUserId: string;
    requestSha256: string;
    marketId: string;
    side: "buy" | "sell";
    amountMode: "quote" | "base";
    amountValue: string;
  }>,
) {
  const resource = parseOwnedSpotIntentResource(
    record,
    expected.ownerUserId,
    record.id,
  );
  if (
    record.requestSha256 !== expected.requestSha256 ||
    resource.review.market_id !== expected.marketId ||
    resource.review.side !== expected.side ||
    resource.review.amount_mode !== expected.amountMode ||
    resource.review.amount_value !== expected.amountValue
  ) {
    return unavailable();
  }
  return resource;
}

async function resolveAuthority(
  input: CreateSpotIntentPrepareWorkflowInput,
  expected: Readonly<{
    ownerUserId: string;
    privyUserId: string;
    requestId: string;
    signal: AbortSignal;
  }>,
): Promise<SpotIntentPrepareAuthority> {
  expected.signal.throwIfAborted();
  let value: unknown;
  try {
    value = await input.authorityResolver.resolve({
      ownerUserId: expected.ownerUserId,
      privyUserId: expected.privyUserId,
      network: "testnet",
      requestId: expected.requestId,
      signal: expected.signal,
    });
    expected.signal.throwIfAborted();
  } catch (error) {
    expected.signal.throwIfAborted();
    if (error instanceof SpotIntentPrepareAuthorityRequiredError) {
      throw new SpotWalletBindingRequiredError();
    }
    if (error instanceof SpotIntentPrepareAuthorityUnavailableError) {
      return unavailable();
    }
    return unavailable();
  }
  try {
    return parseSpotIntentPrepareAuthority(
      value,
      {
        ownerUserId: expected.ownerUserId,
        privyUserId: expected.privyUserId,
      },
      readNow(input.now ?? (() => new Date())),
    );
  } catch (error) {
    if (error instanceof SpotIntentPrepareAuthorityRequiredError) {
      throw new SpotWalletBindingRequiredError();
    }
    return unavailable();
  }
}

async function findOwnedRecord(
  repository: SpotIntentPrepareRepository,
  ownerUserId: string,
  intentId: string,
): Promise<SpotIntentRecord> {
  let record: SpotIntentRecord | null;
  try {
    record = await repository.findOwned(ownerUserId, intentId);
  } catch {
    return unavailable();
  }
  if (record === null) {
    throw new SpotIntentNotFoundError();
  }
  parseOwnedSpotIntentResource(record, ownerUserId, intentId);
  return record;
}

export function createSpotIntentPrepareWorkflow(
  input: CreateSpotIntentPrepareWorkflowInput,
): SpotIntentWorkflow {
  // Keep this workflow out of runtime composition until repository.prepare
  // validates the resolver's wallet-evidence lease with the DB clock after
  // lock waits and proves the active Agent covers the review expiry.
  const createUuid = input.createUuid ?? randomUUID;
  const createClientOrderId =
    input.createClientOrderId ?? (() => createSpotClientOrderId());
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async prepare(workflowInput: Parameters<SpotIntentWorkflow["prepare"]>[0]) {
      if (!(workflowInput.signal instanceof AbortSignal)) {
        return unavailable();
      }
      workflowInput.signal.throwIfAborted();
      try {
        if (
          canonicalizeSpotIntentRequest(workflowInput.request) !==
            workflowInput.canonicalRequest ||
          digestSpotIntentRequest(workflowInput.request) !==
            workflowInput.requestSha256
        ) {
          return unavailable();
        }
      } catch {
        return unavailable();
      }

      let claim: Awaited<
        ReturnType<SpotIntentPrepareRepository["claimPrepare"]>
      >;
      try {
        claim = await input.repository.claimPrepare({
          ownerUserId: workflowInput.ownerUserId,
          idempotencyKey: workflowInput.idempotencyKey,
          requestSha256: workflowInput.requestSha256,
        });
      } catch (error) {
        return mapRepositoryError(error);
      }
      workflowInput.signal.throwIfAborted();
      if (claim.kind === "replay") {
        return assertRecordMatchesPrepare(claim.intent, {
          ownerUserId: workflowInput.ownerUserId,
          requestSha256: workflowInput.requestSha256,
          marketId: workflowInput.request.market_id,
          side: workflowInput.request.side,
          amountMode: workflowInput.request.amount.mode,
          amountValue: workflowInput.request.amount.value,
        });
      }
      if (claim.kind === "pending") {
        return unavailable();
      }

      const usedRequestIds = new Set([workflowInput.requestId]);
      const firstAuthority = await resolveAuthority(input, {
        ownerUserId: workflowInput.ownerUserId,
        privyUserId: workflowInput.privyUserId,
        requestId: freshUuid(createUuid, usedRequestIds),
        signal: workflowInput.signal,
      });

      let clientOrderId: string;
      try {
        clientOrderId = createClientOrderId();
      } catch {
        return unavailable();
      }
      if (!clientOrderIdPattern.test(clientOrderId)) {
        return unavailable();
      }
      workflowInput.signal.throwIfAborted();

      let draftValue: unknown;
      try {
        draftValue = await input.reviewer.review({
          ownerUserId: workflowInput.ownerUserId,
          network: "testnet",
          request: workflowInput.request,
          requestSha256: workflowInput.requestSha256,
          authority: firstAuthority,
          clientOrderId,
          requestId: freshUuid(createUuid, usedRequestIds),
          signal: workflowInput.signal,
        });
        workflowInput.signal.throwIfAborted();
      } catch (error) {
        workflowInput.signal.throwIfAborted();
        if (error instanceof SpotIntentReviewerUnavailableError) {
          return unavailable();
        }
        return unavailable();
      }

      let draft;
      try {
        draft = parseSpotIntentReviewDraft(draftValue, {
          request: workflowInput.request,
          authority: firstAuthority,
          clientOrderId,
          observedAtMilliseconds: readNow(now),
        });
      } catch {
        return unavailable();
      }

      const currentAuthority = await resolveAuthority(input, {
        ownerUserId: workflowInput.ownerUserId,
        privyUserId: workflowInput.privyUserId,
        requestId: freshUuid(createUuid, usedRequestIds),
        signal: workflowInput.signal,
      });
      if (!sameSpotIntentPrepareAuthority(firstAuthority, currentAuthority)) {
        throw new SpotIntentStaleError();
      }
      workflowInput.signal.throwIfAborted();

      let prepared: Awaited<ReturnType<SpotIntentPrepareRepository["prepare"]>>;
      try {
        prepared = await input.repository.prepare({
          ...draft,
          ownerUserId: workflowInput.ownerUserId,
          claimId: claim.claimId,
          idempotencyKey: workflowInput.idempotencyKey,
          requestSha256: workflowInput.requestSha256,
          requestId: workflowInput.requestId,
          marketId: workflowInput.request.market_id,
          side: workflowInput.request.side,
          amountMode: workflowInput.request.amount.mode,
          amountValue: workflowInput.request.amount.value,
          accountAddress: currentAuthority.accountAddress,
          accountKind: currentAuthority.accountKind,
          bindingVersion: currentAuthority.bindingVersion,
          agentIdentityId: currentAuthority.agentIdentityId,
          clientOrderId,
        });
      } catch (error) {
        return mapRepositoryError(error);
      }

      return assertRecordMatchesPrepare(prepared.intent, {
        ownerUserId: workflowInput.ownerUserId,
        requestSha256: workflowInput.requestSha256,
        marketId: workflowInput.request.market_id,
        side: workflowInput.request.side,
        amountMode: workflowInput.request.amount.mode,
        amountValue: workflowInput.request.amount.value,
      });
    },

    async findOwned(
      workflowInput: Parameters<SpotIntentWorkflow["findOwned"]>[0],
    ) {
      const record = await findOwnedRecord(
        input.repository,
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      return parseOwnedSpotIntentResource(
        record,
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
    },

    async submit(workflowInput: Parameters<SpotIntentWorkflow["submit"]>[0]) {
      if (!(workflowInput.signal instanceof AbortSignal)) {
        return unavailable();
      }
      workflowInput.signal.throwIfAborted();
      const record = await findOwnedRecord(
        input.repository,
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      const resource = parseOwnedSpotIntentResource(
        record,
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      if (resource.state === "expired") {
        throw new SpotIntentExpiredError();
      }
      if (resource.state !== "prepared") {
        return resource;
      }
      return unavailable();
    },
  });
}
