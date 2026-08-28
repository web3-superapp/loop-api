import { randomUUID } from "node:crypto";

import {
  SpotIntentAuthorityStaleError,
  SpotIntentPrepareExpiredError,
  type SpotIntentRecord,
} from "../../database/spot-intent-repository.js";
import {
  SpotIntentExpiredError,
  SpotIntentNotFoundError,
  SpotIntentStaleError,
  type SpotIntentWorkflow,
} from "./spot-intent-service.js";
import type {
  SpotIntentSubmissionEvidence,
  SpotIntentSubmissionPreflight,
  SpotIntentSubmissionRepository,
  SpotIntentSubmissionSubject,
  SpotIocExchangeWriter,
  SpotIocSignature,
  SpotIocSigner,
} from "./spot-intent-submission.js";
import { parseOwnedSpotIntentResource } from "./spot-intent-workflow.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "./spot-errors.js";

export interface CreateSpotIntentSubmissionWorkflowInput {
  readonly repository: SpotIntentSubmissionRepository;
  readonly preflight: SpotIntentSubmissionPreflight;
  readonly signer: SpotIocSigner;
  readonly writer: SpotIocExchangeWriter;
}

const writeStartSafetyMarginMilliseconds = 1_000;

function unavailable(): never {
  throw new SpotUnavailableError();
}

function preserveSafePreflightError(error: unknown): never {
  if (
    error instanceof SpotIntentExpiredError ||
    error instanceof SpotIntentStaleError ||
    error instanceof SpotWalletBindingRequiredError ||
    error instanceof SpotUnavailableError
  ) {
    throw error;
  }
  return unavailable();
}

function mapBeginSubmissionError(error: unknown): never {
  if (error instanceof SpotIntentPrepareExpiredError) {
    throw new SpotIntentExpiredError();
  }
  if (error instanceof SpotIntentAuthorityStaleError) {
    throw new SpotIntentStaleError();
  }
  return unavailable();
}

function assertEvidence(value: unknown): SpotIntentSubmissionEvidence {
  if (typeof value !== "object" || value === null) {
    return unavailable();
  }
  if (
    Object.keys(value).sort().join(",") !==
      "accountEvidence,marketEvidence,policyEvidence,walletEvidence" ||
    !("walletEvidence" in value) ||
    !("marketEvidence" in value) ||
    !("accountEvidence" in value) ||
    !("policyEvidence" in value)
  ) {
    return unavailable();
  }
  return value as SpotIntentSubmissionEvidence;
}

function assertSignature(value: unknown): SpotIocSignature {
  if (typeof value !== "object" || value === null) {
    return unavailable();
  }
  if (Object.keys(value).sort().join(",") !== "r,s,v") {
    return unavailable();
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["r"] !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(candidate["r"]) ||
    typeof candidate["s"] !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(candidate["s"]) ||
    (candidate["v"] !== 27 && candidate["v"] !== 28)
  ) {
    return unavailable();
  }
  return Object.freeze({
    r: candidate["r"],
    s: candidate["s"],
    v: candidate["v"],
  });
}

function createSubmissionSubject(
  record: SpotIntentRecord,
): SpotIntentSubmissionSubject {
  const review = record.publicReview;
  const order = record.canonicalAction.orders[0];
  const expectedBuy = review.side === "buy";
  if (
    review.market_id !== record.marketId ||
    review.metadata_version !== record.metadataVersion ||
    record.metadataSha256 !== record.metadataVersion ||
    review.policy_version !== record.policyVersion ||
    review.binding_epoch !== record.bindingVersion ||
    review.review_digest !== record.reviewSha256 ||
    review.expires_at !== record.resource.expires_at ||
    review.maximum_spend_or_minimum_receive.asset_display_identity !==
      review.quote_display_identity ||
    review.maximum_spend_or_minimum_receive.kind !==
      (expectedBuy ? "maximum_spend" : "minimum_receive") ||
    order.a !== record.exchangeOrderAsset ||
    order.b !== expectedBuy ||
    order.p !== review.worst_ioc_limit_price ||
    order.s !== review.computed_base_size ||
    order.c !== record.clientOrderId
  ) {
    return unavailable();
  }
  return Object.freeze({
    ownerUserId: record.ownerUserId,
    intentId: record.id,
    network: "testnet" as const,
    marketId: record.marketId,
    providerCoin: record.providerCoin,
    baseTokenIndex: record.baseTokenIndex,
    baseTokenId: record.baseTokenId,
    baseDisplayIdentity: review.base_display_identity,
    quoteTokenIndex: record.quoteTokenIndex,
    quoteTokenId: record.quoteTokenId,
    quoteDisplayIdentity: review.quote_display_identity,
    spotPairIndex: record.spotPairIndex,
    exchangeOrderAsset: record.exchangeOrderAsset,
    metadataVersion: record.metadataVersion,
    metadataSha256: record.metadataSha256,
    policyVersion: record.policyVersion,
    accountAddress: record.accountAddress,
    bindingVersion: record.bindingVersion,
    agentIdentityId: record.agentIdentityId,
    reviewSha256: record.reviewSha256,
    side: review.side,
    computedBaseSize: review.computed_base_size,
    maximumSpendOrMinimumReceive: Object.freeze({
      kind: review.maximum_spend_or_minimum_receive.kind,
      value: review.maximum_spend_or_minimum_receive.value,
    }),
    feeRate: review.fee_rate,
    expiresAt: review.expires_at,
  });
}

function createAttemptSignal(
  attempt: Readonly<{
    attemptDeadlineAt: string;
    writeStartBudgetMilliseconds: number;
  }>,
  requestSignal: AbortSignal,
  beginCallStartedAt: number,
): AbortSignal {
  const deadline = Date.parse(attempt.attemptDeadlineAt);
  const beginElapsed = Math.max(0, performance.now() - beginCallStartedAt);
  const databaseBudget =
    attempt.writeStartBudgetMilliseconds -
    beginElapsed -
    writeStartSafetyMarginMilliseconds;
  const absoluteBudget =
    deadline - Date.now() - writeStartSafetyMarginMilliseconds;
  const budget = Math.floor(Math.min(databaseBudget, absoluteBudget));
  if (
    !Number.isFinite(deadline) ||
    !Number.isSafeInteger(attempt.writeStartBudgetMilliseconds) ||
    attempt.writeStartBudgetMilliseconds < 0 ||
    budget <= 0
  ) {
    return unavailable();
  }
  return AbortSignal.any([requestSignal, AbortSignal.timeout(budget)]);
}

function assertBeforeAttemptDeadline(
  attemptDeadlineAt: string,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  if (Date.now() >= Date.parse(attemptDeadlineAt)) {
    return unavailable();
  }
}

export function createSpotIntentSubmissionWorkflow(
  input: CreateSpotIntentSubmissionWorkflowInput,
): SpotIntentWorkflow {
  async function findOwnedRecord(
    ownerUserId: string,
    intentId: string,
  ): Promise<SpotIntentRecord> {
    let record: SpotIntentRecord | null;
    try {
      record = await input.repository.findOwned(ownerUserId, intentId);
    } catch {
      return unavailable();
    }
    if (record === null) {
      throw new SpotIntentNotFoundError();
    }
    parseOwnedSpotIntentResource(record, ownerUserId, intentId);
    return record;
  }

  return Object.freeze({
    prepare(): Promise<never> {
      return Promise.reject(new SpotUnavailableError());
    },
    async findOwned(
      workflowInput: Parameters<SpotIntentWorkflow["findOwned"]>[0],
    ) {
      const record = await findOwnedRecord(
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
      const record = await findOwnedRecord(
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      const currentResource = parseOwnedSpotIntentResource(
        record,
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      if (currentResource.state === "expired") {
        throw new SpotIntentExpiredError();
      }
      if (currentResource.state !== "prepared") {
        return currentResource;
      }
      const subject = createSubmissionSubject(record);

      let evidence: SpotIntentSubmissionEvidence;
      try {
        workflowInput.signal.throwIfAborted();
        evidence = assertEvidence(
          await input.preflight.prepare({
            ownerUserId: workflowInput.ownerUserId,
            privyUserId: workflowInput.privyUserId,
            intentId: workflowInput.intentId,
            marketId: record.marketId,
            network: "testnet",
            action: "spot_ioc_order",
            expectedReviewSha256: record.reviewSha256,
            subject,
            requestId: workflowInput.requestId,
            signal: workflowInput.signal,
          }),
        );
        workflowInput.signal.throwIfAborted();
      } catch (error) {
        return preserveSafePreflightError(error);
      }

      let begun: Awaited<
        ReturnType<SpotIntentSubmissionRepository["beginSubmission"]>
      >;
      const beginCallStartedAt = performance.now();
      try {
        begun = await input.repository.beginSubmission({
          ownerUserId: workflowInput.ownerUserId,
          intentId: workflowInput.intentId,
          requestId: workflowInput.requestId,
          expectedReviewSha256: record.reviewSha256,
          ...evidence,
        });
      } catch (error) {
        return mapBeginSubmissionError(error);
      }

      if (begun.kind === "not_found") {
        throw new SpotIntentNotFoundError();
      }
      if (begun.kind === "already_attempted") {
        const resource = parseOwnedSpotIntentResource(
          begun.intent,
          workflowInput.ownerUserId,
          workflowInput.intentId,
        );
        if (
          resource.state === "prepared" ||
          resource.state === "expired" ||
          resource.submission.state !== "attempted"
        ) {
          return unavailable();
        }
        return resource;
      }

      const submittingResource = parseOwnedSpotIntentResource(
        begun.intent,
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      if (
        submittingResource.state !== "submitting" ||
        submittingResource.submission.state !== "attempted" ||
        begun.attempt.intentId !== workflowInput.intentId
      ) {
        return unavailable();
      }

      const attemptSignal = createAttemptSignal(
        begun.attempt,
        workflowInput.signal,
        beginCallStartedAt,
      );

      let signature: SpotIocSignature;
      try {
        assertBeforeAttemptDeadline(
          begun.attempt.attemptDeadlineAt,
          attemptSignal,
        );
        signature = assertSignature(
          await input.signer.sign({
            signingRequestId: randomUUID(),
            network: begun.attempt.network,
            signerRef: begun.attempt.signerRef,
            expectedSignerAddress: begun.attempt.agentAddress,
            action: begun.attempt.canonicalAction,
            nonce: begun.attempt.nonce,
            vaultAddress: begun.attempt.vaultAddress,
            expiresAfter: begun.attempt.expiresAfter,
            attemptDeadlineAt: begun.attempt.attemptDeadlineAt,
            signal: attemptSignal,
          }),
        );
        assertBeforeAttemptDeadline(
          begun.attempt.attemptDeadlineAt,
          attemptSignal,
        );
      } catch {
        return unavailable();
      }

      let reasonCode:
        "submission_transport_ambiguous" | "submission_response_unclassified";
      try {
        assertBeforeAttemptDeadline(
          begun.attempt.attemptDeadlineAt,
          attemptSignal,
        );
      } catch {
        return unavailable();
      }
      try {
        await input.writer.submit({
          transportAttemptId: begun.attempt.transportAttemptId,
          network: begun.attempt.network,
          action: begun.attempt.canonicalAction,
          nonce: begun.attempt.nonce,
          signature,
          vaultAddress: begun.attempt.vaultAddress,
          expiresAfter: begun.attempt.expiresAfter,
          attemptDeadlineAt: begun.attempt.attemptDeadlineAt,
          signal: attemptSignal,
        });
        reasonCode = "submission_response_unclassified";
      } catch {
        reasonCode = "submission_transport_ambiguous";
      }

      let recorded: Awaited<
        ReturnType<SpotIntentSubmissionRepository["recordSubmissionUnknown"]>
      >;
      try {
        recorded = await input.repository.recordSubmissionUnknown({
          ownerUserId: workflowInput.ownerUserId,
          intentId: workflowInput.intentId,
          requestId: randomUUID(),
          transportAttemptId: begun.attempt.transportAttemptId,
          expectedOperationRecordVersion: begun.attempt.operationRecordVersion,
          expectedIntentRecordVersion: begun.intent.recordVersion,
          outcome: {
            state: "unknown",
            providerOrderId: null,
            reasonCode,
          },
        });
      } catch {
        return unavailable();
      }
      if (recorded.kind === "not_found") {
        return unavailable();
      }
      const resource = parseOwnedSpotIntentResource(
        recorded.intent,
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      if (
        resource.state !== "unknown" ||
        resource.submission.state !== "attempted"
      ) {
        return unavailable();
      }
      return resource;
    },
  });
}
