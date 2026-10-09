import { describe, expect, it, vi } from "vitest";

import type {
  SpotIntentRecord,
  SpotIntentRepository,
  SpotIntentSubmissionAttempt,
} from "../src/database/spot-intent-repository.js";
import {
  SpotIntentAuthorityStaleError,
  SpotIntentPrepareExpiredError,
} from "../src/database/spot-intent-repository.js";
import {
  createSpotReview,
  parseSpotIntentResource,
  type SpotIntentResource,
} from "../src/features/spot/spot-intent-contract.js";
import {
  SpotIntentExpiredError,
  SpotIntentNotFoundError,
  SpotIntentStaleError,
} from "../src/features/spot/spot-intent-service.js";
import type {
  SpotIntentSubmissionEvidence,
  SpotIntentSubmissionPreflight,
  SpotIntentSubmissionRepository,
  SpotIntentSubmissionSubject,
  SpotIocExchangeWriter,
  SpotIocSignature,
  SpotIocSigner,
  SpotIocWriteStartAdmission,
  SpotIocWriteStartGuard,
} from "../src/features/spot/spot-intent-submission.js";
import { createSpotIntentSubmissionWorkflow } from "../src/features/spot/spot-intent-submission-workflow.js";
import { createDefaultClosedSpotIntentWorkflow } from "../src/features/spot/spot-intent-workflow.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "../src/features/spot/spot-errors.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const foreignOwnerUserId = "22222222-2222-4222-8222-222222222222";
const marketId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const idempotencyKey = "66666666-6666-4666-8666-666666666666";
const agentIdentityId = "77777777-7777-4777-8777-777777777777";
const createdAt = "2026-08-26T00:00:00.000Z";
const observedAt = "2026-08-26T00:00:05.000Z";
const expiresAt = "2026-08-26T00:00:15.000Z";
const clientOrderId = `0x${"ab".repeat(16)}`;
const metadataVersion = "b".repeat(64);

function review() {
  return createSpotReview({
    version: "spot_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market_id: marketId,
    base_display_identity: "PURR",
    quote_display_identity: "USDC",
    side: "buy",
    amount_mode: "quote",
    amount_value: "10",
    computed_base_size: "2",
    reference_price: "5",
    reference_source_time: createdAt,
    worst_ioc_limit_price: "5.01",
    maximum_spend_or_minimum_receive: {
      kind: "maximum_spend",
      asset_display_identity: "USDC",
      value: "10",
    },
    fee_rate: "0.001",
    fee_estimate: "0.01",
    fee_source: { dataset: "user_fees", observed_at: createdAt },
    metadata_version: metadataVersion,
    policy_version: "policy-v1",
    binding_epoch: "7",
    expires_at: expiresAt,
  });
}

function nonFillResult(
  state: "accepted" | "not_filled" | "rejected" | "unknown",
) {
  return {
    state,
    order_id: null,
    filled_base_size: null,
    average_fill_price: null,
    quote_amount: null,
    fee: null,
    fee_asset_display_identity: null,
    observed_at: observedAt,
    reason_code: state === "rejected" ? "provider_rejected" : null,
  } as const;
}

function resourceFor(
  state:
    | "prepared"
    | "expired"
    | "submitting"
    | "unknown"
    | "reconciling"
    | "filled",
): SpotIntentResource {
  const shared = {
    intent_id: intentId,
    review: review(),
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: state === "prepared" ? createdAt : observedAt,
  } as const;

  switch (state) {
    case "prepared":
    case "expired":
      return parseSpotIntentResource({
        ...shared,
        state,
        submission: { state: "not_started" },
        result: null,
      });
    case "submitting":
      return parseSpotIntentResource({
        ...shared,
        state,
        submission: { state: "attempted" },
        result: null,
      });
    case "unknown":
      return parseSpotIntentResource({
        ...shared,
        state,
        submission: { state: "attempted" },
        result: nonFillResult("unknown"),
      });
    case "reconciling":
      return parseSpotIntentResource({
        ...shared,
        state,
        submission: { state: "attempted" },
        result: nonFillResult("unknown"),
      });
    case "filled":
      return parseSpotIntentResource({
        ...shared,
        state,
        submission: { state: "attempted" },
        result: {
          state: "filled",
          order_id: "123",
          filled_base_size: "2",
          average_fill_price: "5",
          quote_amount: "10",
          fee: "0.01",
          fee_asset_display_identity: "USDC",
          observed_at: observedAt,
          reason_code: null,
        },
      });
  }
}

function recordFor(resource: SpotIntentResource): SpotIntentRecord {
  return Object.freeze({
    id: intentId,
    ownerUserId,
    requestSha256: "a".repeat(64),
    network: "testnet",
    marketId,
    providerCoin: "PURR/USDC",
    baseTokenIndex: 1,
    baseTokenId: `0x${"11".repeat(16)}`,
    quoteTokenIndex: 0,
    quoteTokenId: `0x${"22".repeat(16)}`,
    spotPairIndex: 0,
    exchangeOrderAsset: 10_000,
    metadataVersion,
    metadataSha256: metadataVersion,
    policyVersion: "policy-v1",
    accountAddress: `0x${"33".repeat(20)}`,
    bindingVersion: "7",
    agentIdentityId,
    clientOrderId,
    canonicalAction: Object.freeze({
      type: "order",
      orders: Object.freeze([
        Object.freeze({
          a: 10_000,
          b: true,
          p: "5.01",
          s: "2",
          r: false,
          t: Object.freeze({
            limit: Object.freeze({ tif: "Ioc" as const }),
          }),
          c: clientOrderId,
        }),
      ] as const),
      grouping: "na",
    }),
    publicReview: resource.review,
    reviewSha256: resource.review.review_digest,
    factsObservedAt: createdAt,
    referenceSourceTime: createdAt,
    state: resource.state,
    result: resource.result,
    recordVersion: resource.state === "prepared" ? "0" : "1",
    createdAt: resource.created_at,
    updatedAt: resource.updated_at,
    resource,
  });
}

function unknownResource(
  reasonCode:
    "submission_transport_ambiguous" | "submission_response_unclassified",
): SpotIntentResource {
  return parseSpotIntentResource({
    intent_id: intentId,
    state: "unknown",
    review: review(),
    submission: { state: "attempted" },
    result: {
      state: "unknown",
      order_id: null,
      filled_base_size: null,
      average_fill_price: null,
      quote_amount: null,
      fee: null,
      fee_asset_display_identity: null,
      observed_at: observedAt,
      reason_code: reasonCode,
    },
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: observedAt,
  });
}

function notSentResource(
  reasonCode:
    | "submission_signing_not_completed"
    | "submission_write_start_denied"
    | "submission_write_admission_expired",
): SpotIntentResource {
  return parseSpotIntentResource({
    intent_id: intentId,
    state: "rejected",
    review: review(),
    submission: { state: "attempted" },
    result: {
      state: "rejected",
      order_id: null,
      filled_base_size: null,
      average_fill_price: null,
      quote_amount: null,
      fee: null,
      fee_asset_display_identity: null,
      observed_at: observedAt,
      reason_code: reasonCode,
    },
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: observedAt,
  });
}

function submissionEvidence(): SpotIntentSubmissionEvidence {
  return Object.freeze({
    walletEvidence: Object.freeze({
      ownerUserId,
      privyUserId: "did:privy:spot-workflow",
      walletId: "privy-wallet-ref",
      accountAddress: `0x${"33".repeat(20)}`,
      accountKind: "master",
      bindingVersion: "7",
      verifiedAt: createdAt,
      expiresAt,
    }),
    marketEvidence: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "spotMetaAndAssetCtxs",
      marketId,
      providerCoin: "PURR/USDC",
      baseTokenIndex: 1,
      baseTokenId: `0x${"11".repeat(16)}`,
      quoteTokenIndex: 0,
      quoteTokenId: `0x${"22".repeat(16)}`,
      spotPairIndex: 0,
      exchangeOrderAsset: 10_000,
      metadataVersion,
      metadataSha256: metadataVersion,
      fetchedAt: createdAt,
      expiresAt,
    }),
    accountEvidence: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      accountAddress: `0x${"33".repeat(20)}`,
      metadataVersion,
      balance: Object.freeze({
        dataset: "spotClearinghouseState",
        tokenIndex: 0,
        tokenId: `0x${"22".repeat(16)}`,
        available: "10",
        fetchedAt: observedAt,
        expiresAt,
      }),
      fees: Object.freeze({
        dataset: "userFees",
        currentTakerRate: "0.001",
        fetchedAt: observedAt,
        expiresAt,
      }),
    }),
    policyEvidence: Object.freeze({
      ownerUserId,
      intentId,
      network: "testnet",
      action: "spot_ioc_order",
      decision: "allow",
      policyVersion: "policy-v1",
      productEnabled: true,
      legalEligible: true,
      sanctionsEligible: true,
      killSwitchOpen: true,
      signerReady: true,
      reconciliationReady: true,
      checkedAt: createdAt,
      expiresAt,
    }),
  });
}

function submissionSubject(
  record: SpotIntentRecord,
): SpotIntentSubmissionSubject {
  return Object.freeze({
    ownerUserId: record.ownerUserId,
    intentId: record.id,
    network: "testnet",
    marketId: record.marketId,
    providerCoin: record.providerCoin,
    baseTokenIndex: record.baseTokenIndex,
    baseTokenId: record.baseTokenId,
    baseDisplayIdentity: record.publicReview.base_display_identity,
    quoteTokenIndex: record.quoteTokenIndex,
    quoteTokenId: record.quoteTokenId,
    quoteDisplayIdentity: record.publicReview.quote_display_identity,
    spotPairIndex: record.spotPairIndex,
    exchangeOrderAsset: record.exchangeOrderAsset,
    metadataVersion: record.metadataVersion,
    metadataSha256: record.metadataSha256,
    policyVersion: record.policyVersion,
    accountAddress: record.accountAddress,
    bindingVersion: record.bindingVersion,
    agentIdentityId: record.agentIdentityId,
    reviewSha256: record.reviewSha256,
    side: record.publicReview.side,
    computedBaseSize: record.publicReview.computed_base_size,
    maximumSpendOrMinimumReceive: Object.freeze({
      kind: record.publicReview.maximum_spend_or_minimum_receive.kind,
      value: record.publicReview.maximum_spend_or_minimum_receive.value,
    }),
    feeRate: record.publicReview.fee_rate,
    expiresAt: record.publicReview.expires_at,
  });
}

function submissionAttempt(
  submitting: SpotIntentRecord,
): SpotIntentSubmissionAttempt {
  const attemptCommittedAt = new Date().toISOString();
  const attemptDeadlineAt = new Date(Date.now() + 10_000).toISOString();
  return Object.freeze({
    intentId,
    network: "testnet",
    transportAttemptId: "88888888-8888-4888-8888-888888888888",
    operationRecordVersion: "1",
    attemptCommittedAt,
    attemptDeadlineAt,
    writeStartBudgetMilliseconds: 10_000,
    nonce: "1760000000123",
    agentAddress: `0x${"44".repeat(20)}`,
    signerRef: "privy-server-wallet-ref",
    canonicalAction: submitting.canonicalAction,
    vaultAddress: null,
    expiresAfter: "1787702415000",
  });
}

function writeStartAdmission(input: {
  readonly writeAdmissionId: string;
  readonly subject: SpotIntentSubmissionSubject;
  readonly attempt: SpotIntentSubmissionAttempt;
  readonly intentRecordVersion: string;
}): SpotIocWriteStartAdmission {
  const checkedAtMilliseconds = Date.now();
  const expiresAtMilliseconds = Math.min(
    checkedAtMilliseconds + 500,
    Date.parse(input.attempt.attemptDeadlineAt),
  );
  return Object.freeze({
    decision: "allow",
    writeAdmissionId: input.writeAdmissionId,
    ownerUserId: input.subject.ownerUserId,
    intentId: input.subject.intentId,
    network: input.attempt.network,
    transportAttemptId: input.attempt.transportAttemptId,
    operationRecordVersion: input.attempt.operationRecordVersion,
    intentRecordVersion: input.intentRecordVersion,
    agentIdentityId: input.subject.agentIdentityId,
    agentAddress: input.attempt.agentAddress,
    reviewSha256: input.subject.reviewSha256,
    checkedAt: new Date(checkedAtMilliseconds).toISOString(),
    expiresAt: new Date(expiresAtMilliseconds).toISOString(),
  });
}

function fakeSubmissionDependencies() {
  const prepared = recordFor(resourceFor("prepared"));
  const submitting = recordFor(resourceFor("submitting"));
  const unclassified = Object.freeze({
    ...recordFor(unknownResource("submission_response_unclassified")),
    recordVersion: "2",
  });
  const transportAmbiguous = Object.freeze({
    ...recordFor(unknownResource("submission_transport_ambiguous")),
    recordVersion: "2",
  });
  const signingNotCompleted = Object.freeze({
    ...recordFor(notSentResource("submission_signing_not_completed")),
    recordVersion: "2",
  });
  const writeStartDenied = Object.freeze({
    ...recordFor(notSentResource("submission_write_start_denied")),
    recordVersion: "2",
  });
  const writeAdmissionExpired = Object.freeze({
    ...recordFor(notSentResource("submission_write_admission_expired")),
    recordVersion: "2",
  });
  const attempt = submissionAttempt(submitting);
  const repository = {
    findOwned: vi.fn<SpotIntentSubmissionRepository["findOwned"]>(() =>
      Promise.resolve(prepared),
    ),
    beginSubmission: vi.fn<SpotIntentSubmissionRepository["beginSubmission"]>(
      () => Promise.resolve({ kind: "started", intent: submitting, attempt }),
    ),
    recordSubmissionNotSent: vi.fn<
      SpotIntentSubmissionRepository["recordSubmissionNotSent"]
    >(() => Promise.resolve({ kind: "recorded", intent: writeStartDenied })),
    recordSubmissionUnknown: vi.fn<
      SpotIntentSubmissionRepository["recordSubmissionUnknown"]
    >(() => Promise.resolve({ kind: "recorded", intent: unclassified })),
  } satisfies SpotIntentSubmissionRepository;
  const preflight = {
    prepare: vi.fn<SpotIntentSubmissionPreflight["prepare"]>(() =>
      Promise.resolve(submissionEvidence()),
    ),
  } satisfies SpotIntentSubmissionPreflight;
  const signature = Object.freeze({
    r: `0x${"55".repeat(32)}`,
    s: `0x${"66".repeat(32)}`,
    v: 27,
  }) satisfies SpotIocSignature;
  const signer = {
    sign: vi.fn<SpotIocSigner["sign"]>(() => Promise.resolve(signature)),
  } satisfies SpotIocSigner;
  const writeStartGuard = {
    authorize: vi.fn<SpotIocWriteStartGuard["authorize"]>((guardInput) =>
      Promise.resolve(
        writeStartAdmission({
          writeAdmissionId: guardInput.writeAdmissionId,
          subject: guardInput.subject,
          attempt,
          intentRecordVersion: guardInput.expectedIntentRecordVersion,
        }),
      ),
    ),
  } satisfies SpotIocWriteStartGuard;
  const writer = {
    submit: vi.fn<SpotIocExchangeWriter["submit"]>(() => Promise.resolve()),
  } satisfies SpotIocExchangeWriter;
  const workflow = createSpotIntentSubmissionWorkflow({
    repository,
    preflight,
    signer,
    writeStartGuard,
    writer,
  });
  return {
    attempt,
    preflight,
    prepared,
    repository,
    signature,
    signer,
    signingNotCompleted,
    submitting,
    transportAmbiguous,
    unclassified,
    writeAdmissionExpired,
    writeStartDenied,
    writeStartGuard,
    workflow,
    writer,
  };
}

function repositoryWith(
  findOwnedImplementation: SpotIntentRepository["findOwned"],
) {
  const repository = {
    claimPrepare: vi.fn<SpotIntentRepository["claimPrepare"]>(),
    prepare: vi.fn<SpotIntentRepository["prepare"]>(),
    beginSubmission: vi.fn<SpotIntentRepository["beginSubmission"]>(),
    findOwned: vi.fn<SpotIntentRepository["findOwned"]>(
      findOwnedImplementation,
    ),
  } satisfies SpotIntentRepository;
  return repository;
}

function submitInput(signal = new AbortController().signal) {
  return {
    ownerUserId,
    privyUserId: "did:privy:spot-workflow",
    intentId,
    requestId,
    signal,
  } as const;
}

describe("default-closed Spot intent workflow", () => {
  it("returns only the owner-scoped public intent resource", async () => {
    const record = recordFor(resourceFor("prepared"));
    const repository = repositoryWith(() => Promise.resolve(record));
    const workflow = createDefaultClosedSpotIntentWorkflow({ repository });

    const result = await workflow.findOwned({ ownerUserId, intentId });

    expect(result).toEqual(record.resource);
    expect(repository.findOwned).toHaveBeenCalledWith(ownerUserId, intentId);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "accountAddress",
      "account_address",
      "agentIdentityId",
      "agent_identity_id",
      "canonicalAction",
      "canonical_action",
      "clientOrderId",
      "client_order_id",
      "cloid",
      "nonce",
      "signerRef",
      "signer_ref",
      "transportAttemptId",
      "transport_attempt_id",
      "writeStartBudgetMilliseconds",
      "write_start_budget_milliseconds",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("makes missing and foreign-owner intents indistinguishable", async () => {
    const repository = repositoryWith(() => Promise.resolve(null));
    const workflow = createDefaultClosedSpotIntentWorkflow({ repository });

    const missing = workflow.findOwned({ ownerUserId, intentId });
    const foreign = workflow.findOwned({
      ownerUserId: foreignOwnerUserId,
      intentId,
    });

    await expect(missing).rejects.toBeInstanceOf(SpotIntentNotFoundError);
    await expect(foreign).rejects.toBeInstanceOf(SpotIntentNotFoundError);
  });

  it("sanitizes repository failures and inconsistent records", async () => {
    const unavailableRepository = repositoryWith(() =>
      Promise.reject(new Error("sensitive repository detail")),
    );
    const unavailableWorkflow = createDefaultClosedSpotIntentWorkflow({
      repository: unavailableRepository,
    });
    await expect(
      unavailableWorkflow.findOwned({ ownerUserId, intentId }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    const inconsistent = Object.freeze({
      ...recordFor(resourceFor("prepared")),
      ownerUserId: foreignOwnerUserId,
    });
    const inconsistentRepository = repositoryWith(() =>
      Promise.resolve(inconsistent),
    );
    const inconsistentWorkflow = createDefaultClosedSpotIntentWorkflow({
      repository: inconsistentRepository,
    });
    await expect(
      inconsistentWorkflow.findOwned({ ownerUserId, intentId }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
  });

  it("denies prepare and a first submit before every repository mutation", async () => {
    const repository = repositoryWith(() =>
      Promise.resolve(recordFor(resourceFor("prepared"))),
    );
    const workflow = createDefaultClosedSpotIntentWorkflow({ repository });
    const controller = new AbortController();
    controller.abort();

    await expect(
      workflow.prepare({
        ownerUserId,
        privyUserId: "did:privy:spot-workflow",
        idempotencyKey,
        requestId,
        request: {
          market_id: marketId,
          side: "buy",
          amount: { mode: "quote", value: "10" },
        },
        canonicalRequest: JSON.stringify({ market_id: marketId }),
        requestSha256: "a".repeat(64),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    await expect(
      workflow.submit(submitInput(controller.signal)),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    expect(repository.claimPrepare).not.toHaveBeenCalled();
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(repository.beginSubmission).not.toHaveBeenCalled();
    expect(repository.findOwned).toHaveBeenCalledTimes(1);
  });

  it("returns an already-attempted resource without reopening submission", async () => {
    const resources = [
      resourceFor("submitting"),
      resourceFor("unknown"),
      resourceFor("reconciling"),
      resourceFor("filled"),
    ];
    const repository = repositoryWith(() => {
      const resource = resources.shift();
      return Promise.resolve(
        resource === undefined ? null : recordFor(resource),
      );
    });
    const workflow = createDefaultClosedSpotIntentWorkflow({ repository });

    for (const expectedState of [
      "submitting",
      "unknown",
      "reconciling",
      "filled",
    ] as const) {
      await expect(workflow.submit(submitInput())).resolves.toMatchObject({
        intent_id: intentId,
        state: expectedState,
        submission: { state: "attempted" },
      });
    }

    expect(repository.beginSubmission).not.toHaveBeenCalled();
  });

  it("rejects an expired intent without opening a submission attempt", async () => {
    const repository = repositoryWith(() =>
      Promise.resolve(recordFor(resourceFor("expired"))),
    );
    const workflow = createDefaultClosedSpotIntentWorkflow({ repository });

    await expect(workflow.submit(submitInput())).rejects.toBeInstanceOf(
      SpotIntentExpiredError,
    );
    expect(repository.beginSubmission).not.toHaveBeenCalled();
  });
});

describe("fake-only Spot intent submission workflow", () => {
  it("opens one attempt, signs exact fields, writes once, and hands off as unknown", async () => {
    const input = fakeSubmissionDependencies();
    const calls: string[] = [];
    input.repository.findOwned.mockImplementation(() => {
      calls.push("find_owned");
      return Promise.resolve(input.prepared);
    });
    input.preflight.prepare.mockImplementation(() => {
      calls.push("preflight");
      return Promise.resolve(submissionEvidence());
    });
    input.repository.beginSubmission.mockImplementation(() => {
      calls.push("begin_submission");
      return Promise.resolve({
        kind: "started",
        intent: input.submitting,
        attempt: input.attempt,
      });
    });
    input.signer.sign.mockImplementation(() => {
      calls.push("sign");
      return Promise.resolve(input.signature);
    });
    input.writeStartGuard.authorize.mockImplementation((guardInput) => {
      calls.push("guard");
      return Promise.resolve(
        writeStartAdmission({
          writeAdmissionId: guardInput.writeAdmissionId,
          subject: guardInput.subject,
          attempt: input.attempt,
          intentRecordVersion: guardInput.expectedIntentRecordVersion,
        }),
      );
    });
    input.writer.submit.mockImplementation(() => {
      calls.push("write");
      return Promise.resolve();
    });
    input.repository.recordSubmissionUnknown.mockImplementation(() => {
      calls.push("record_unknown");
      return Promise.resolve({ kind: "recorded", intent: input.unclassified });
    });

    const workflowSubmitInput = submitInput();
    const resource = await input.workflow.submit(workflowSubmitInput);

    expect(resource).toEqual(input.unclassified.resource);
    expect(calls).toEqual([
      "find_owned",
      "preflight",
      "begin_submission",
      "sign",
      "guard",
      "write",
      "record_unknown",
    ]);
    expect(input.preflight.prepare).toHaveBeenCalledWith({
      ownerUserId,
      privyUserId: "did:privy:spot-workflow",
      intentId,
      marketId,
      network: "testnet",
      action: "spot_ioc_order",
      expectedReviewSha256: input.prepared.reviewSha256,
      subject: submissionSubject(input.prepared),
      requestId,
      signal: workflowSubmitInput.signal,
    });
    expect(input.repository.beginSubmission).toHaveBeenCalledWith({
      ownerUserId,
      intentId,
      requestId,
      expectedReviewSha256: input.prepared.reviewSha256,
      ...submissionEvidence(),
    });
    expect(input.signer.sign).toHaveBeenCalledOnce();
    const signingInput = input.signer.sign.mock.calls[0]?.[0];
    expect(Object.keys(signingInput ?? {}).sort()).toEqual([
      "action",
      "attemptDeadlineAt",
      "expectedSignerAddress",
      "expiresAfter",
      "network",
      "nonce",
      "signal",
      "signerRef",
      "signingRequestId",
      "vaultAddress",
    ]);
    expect(signingInput).toMatchObject({
      network: "testnet",
      signerRef: input.attempt.signerRef,
      expectedSignerAddress: input.attempt.agentAddress,
      action: input.attempt.canonicalAction,
      nonce: input.attempt.nonce,
      vaultAddress: null,
      expiresAfter: input.attempt.expiresAfter,
      attemptDeadlineAt: input.attempt.attemptDeadlineAt,
    });
    expect(signingInput?.signingRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(signingInput?.signingRequestId).not.toBe(requestId);
    const guardInput = input.writeStartGuard.authorize.mock.calls[0]?.[0];
    expect(Object.keys(guardInput ?? {}).sort()).toEqual([
      "attempt",
      "expectedIntentRecordVersion",
      "privyUserId",
      "signal",
      "subject",
      "writeAdmissionId",
    ]);
    expect(guardInput).toMatchObject({
      privyUserId: "did:privy:spot-workflow",
      subject: submissionSubject(input.prepared),
      attempt: {
        intentId,
        network: "testnet",
        transportAttemptId: input.attempt.transportAttemptId,
        operationRecordVersion: input.attempt.operationRecordVersion,
        attemptDeadlineAt: input.attempt.attemptDeadlineAt,
        agentAddress: input.attempt.agentAddress,
      },
      expectedIntentRecordVersion: input.submitting.recordVersion,
      signal: signingInput?.signal,
    });
    expect(Object.keys(guardInput?.attempt ?? {}).sort()).toEqual([
      "agentAddress",
      "attemptDeadlineAt",
      "intentId",
      "network",
      "operationRecordVersion",
      "transportAttemptId",
    ]);
    expect(guardInput?.writeAdmissionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(guardInput?.writeAdmissionId).not.toBe(requestId);
    expect(guardInput?.writeAdmissionId).not.toBe(
      signingInput?.signingRequestId,
    );
    const writerInput = input.writer.submit.mock.calls[0]?.[0];
    expect(Object.keys(writerInput ?? {}).sort()).toEqual([
      "action",
      "attemptDeadlineAt",
      "expiresAfter",
      "network",
      "nonce",
      "signal",
      "signature",
      "transportAttemptId",
      "vaultAddress",
      "writeAdmissionExpiresAt",
    ]);
    expect(input.writer.submit).toHaveBeenCalledWith({
      transportAttemptId: input.attempt.transportAttemptId,
      network: "testnet",
      action: input.attempt.canonicalAction,
      nonce: input.attempt.nonce,
      signature: input.signature,
      vaultAddress: null,
      expiresAfter: input.attempt.expiresAfter,
      attemptDeadlineAt: input.attempt.attemptDeadlineAt,
      writeAdmissionExpiresAt: writerInput?.writeAdmissionExpiresAt,
      signal: signingInput?.signal,
    });
    expect(signingInput?.signal).toBeInstanceOf(AbortSignal);
    expect(signingInput?.signal).not.toBe(workflowSubmitInput.signal);
    const recoveryInput =
      input.repository.recordSubmissionUnknown.mock.calls[0]?.[0];
    expect(recoveryInput).toMatchObject({
      ownerUserId,
      intentId,
      transportAttemptId: input.attempt.transportAttemptId,
      expectedOperationRecordVersion: input.attempt.operationRecordVersion,
      expectedIntentRecordVersion: input.submitting.recordVersion,
      outcome: {
        state: "unknown",
        providerOrderId: null,
        reasonCode: "submission_response_unclassified",
      },
    });
    expect(recoveryInput?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(recoveryInput?.requestId).not.toBe(requestId);
    expect(recoveryInput?.requestId).not.toBe(signingInput?.signingRequestId);
    expect(recoveryInput?.requestId).not.toBe(guardInput?.writeAdmissionId);
    expect(JSON.stringify(recoveryInput)).not.toContain(input.signature.r);
    expect(JSON.stringify(recoveryInput)).not.toContain(input.attempt.nonce);
    const serialized = JSON.stringify(resource);
    for (const forbidden of [
      input.attempt.nonce,
      input.attempt.agentAddress,
      input.attempt.signerRef,
      input.attempt.transportAttemptId,
      "canonicalAction",
      "writeStartBudgetMilliseconds",
      input.signature.r,
      input.signature.s,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("records every writer rejection as transport ambiguity without retrying", async () => {
    const input = fakeSubmissionDependencies();
    input.writer.submit.mockRejectedValueOnce(
      new Error("secret provider response after bytes were sent"),
    );
    input.repository.recordSubmissionUnknown.mockResolvedValueOnce({
      kind: "recorded",
      intent: input.transportAmbiguous,
    });

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.transportAmbiguous.resource,
    );

    expect(input.writer.submit).toHaveBeenCalledOnce();
    expect(input.repository.recordSubmissionNotSent).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          state: "unknown",
          providerOrderId: null,
          reasonCode: "submission_transport_ambiguous",
        },
      }),
    );
    expect(
      JSON.stringify(input.repository.recordSubmissionUnknown.mock.calls),
    ).not.toContain("secret provider response");
  });

  it("never signs or writes when a concurrent winner already opened the attempt", async () => {
    const input = fakeSubmissionDependencies();
    input.repository.beginSubmission.mockResolvedValueOnce({
      kind: "already_attempted",
      intent: input.submitting,
    });

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.submitting.resource,
    );

    expect(input.preflight.prepare).toHaveBeenCalledOnce();
    expect(input.repository.beginSubmission).toHaveBeenCalledOnce();
    expect(input.signer.sign).not.toHaveBeenCalled();
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionNotSent).not.toHaveBeenCalled();
  });

  it("stops an aborted request before preflight, journal, or nonce allocation", async () => {
    const input = fakeSubmissionDependencies();
    const controller = new AbortController();
    controller.abort();

    await expect(
      input.workflow.submit(submitInput(controller.signal)),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    expect(input.preflight.prepare).not.toHaveBeenCalled();
    expect(input.repository.beginSubmission).not.toHaveBeenCalled();
    expect(input.signer.sign).not.toHaveBeenCalled();
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionNotSent).not.toHaveBeenCalled();
  });

  it("admits only one fake writer under concurrent submissions", async () => {
    const input = fakeSubmissionDependencies();
    let winnerSelected = false;
    input.repository.beginSubmission.mockImplementation(() => {
      if (!winnerSelected) {
        winnerSelected = true;
        return Promise.resolve({
          kind: "started",
          intent: input.submitting,
          attempt: input.attempt,
        });
      }
      return Promise.resolve({
        kind: "already_attempted",
        intent: input.submitting,
      });
    });

    const results = await Promise.all([
      input.workflow.submit(submitInput()),
      input.workflow.submit(submitInput()),
    ]);

    expect(
      results.map((resource) => parseSpotIntentResource(resource).state).sort(),
    ).toEqual(["submitting", "unknown"]);
    expect(input.repository.beginSubmission).toHaveBeenCalledTimes(2);
    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(input.writer.submit).toHaveBeenCalledOnce();
    expect(input.repository.recordSubmissionUnknown).toHaveBeenCalledOnce();
    expect(input.repository.recordSubmissionNotSent).not.toHaveBeenCalled();
  });

  it("records a signing failure as proven-not-sent and never reopens it", async () => {
    const input = fakeSubmissionDependencies();
    input.signer.sign.mockRejectedValueOnce(
      new Error("secret remote signer failure"),
    );
    input.repository.recordSubmissionNotSent.mockResolvedValueOnce({
      kind: "recorded",
      intent: input.signingNotCompleted,
    });
    input.repository.findOwned
      .mockResolvedValueOnce(input.prepared)
      .mockResolvedValueOnce(input.signingNotCompleted);

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.signingNotCompleted.resource,
    );
    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.signingNotCompleted.resource,
    );

    expect(input.repository.beginSubmission).toHaveBeenCalledOnce();
    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(input.writeStartGuard.authorize).not.toHaveBeenCalled();
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionNotSent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId,
        intentId,
        transportAttemptId: input.attempt.transportAttemptId,
        expectedOperationRecordVersion: input.attempt.operationRecordVersion,
        expectedIntentRecordVersion: input.submitting.recordVersion,
        outcome: {
          state: "rejected",
          providerOrderId: null,
          reasonCode: "submission_signing_not_completed",
        },
      }),
    );
    expect(
      input.repository.recordSubmissionNotSent.mock.calls[0]?.[0].requestId,
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("never invokes the writer after a slow signer crosses the persisted deadline", async () => {
    const input = fakeSubmissionDependencies();
    input.repository.recordSubmissionNotSent.mockResolvedValueOnce({
      kind: "recorded",
      intent: input.signingNotCompleted,
    });
    const deadline = Date.parse(input.attempt.attemptDeadlineAt);
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(deadline - 5_000)
      .mockReturnValueOnce(deadline - 4_999)
      .mockReturnValue(deadline + 1);

    try {
      await expect(input.workflow.submit(submitInput())).resolves.toEqual(
        input.signingNotCompleted.resource,
      );
    } finally {
      now.mockRestore();
    }

    expect(input.repository.beginSubmission).toHaveBeenCalledOnce();
    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(
      input.repository.recordSubmissionNotSent.mock.calls[0]?.[0].outcome
        .reasonCode,
    ).toBe("submission_signing_not_completed");
    expect(input.writeStartGuard.authorize).not.toHaveBeenCalled();
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
  });

  it("refuses a DB budget that cannot preserve the writer safety margin", async () => {
    const input = fakeSubmissionDependencies();
    input.repository.recordSubmissionNotSent.mockResolvedValueOnce({
      kind: "recorded",
      intent: input.signingNotCompleted,
    });
    input.repository.beginSubmission.mockResolvedValueOnce({
      kind: "started",
      intent: input.submitting,
      attempt: Object.freeze({
        ...input.attempt,
        writeStartBudgetMilliseconds: 500,
      }),
    });

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.signingNotCompleted.resource,
    );

    expect(input.repository.beginSubmission).toHaveBeenCalledOnce();
    expect(input.signer.sign).not.toHaveBeenCalled();
    expect(
      input.repository.recordSubmissionNotSent.mock.calls[0]?.[0].outcome
        .reasonCode,
    ).toBe("submission_signing_not_completed");
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
  });

  it("records a final write-start guard failure as proven-not-sent", async () => {
    const input = fakeSubmissionDependencies();
    input.writeStartGuard.authorize.mockRejectedValueOnce(
      new Error("secret final authority failure"),
    );

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.writeStartDenied.resource,
    );

    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(input.writeStartGuard.authorize).toHaveBeenCalledOnce();
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionNotSent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          state: "rejected",
          providerOrderId: null,
          reasonCode: "submission_write_start_denied",
        },
      }),
    );
    expect(
      JSON.stringify(input.repository.recordSubmissionNotSent.mock.calls),
    ).not.toContain("secret final authority failure");
  });

  it("strictly binds the final admission to the durable attempt", async () => {
    const mutations = [
      (admission: SpotIocWriteStartAdmission) => ({
        ...admission,
        transportAttemptId: "99999999-9999-4999-8999-999999999999",
      }),
      (admission: SpotIocWriteStartAdmission) => ({
        ...admission,
        unexpected: "field",
      }),
      (admission: SpotIocWriteStartAdmission) => ({
        ...admission,
        expiresAt: new Date(
          Date.parse(admission.checkedAt) + 1_001,
        ).toISOString(),
      }),
      (admission: SpotIocWriteStartAdmission) => ({
        ...admission,
        checkedAt: "2026-02-30T00:00:00.000Z",
      }),
    ] as const;

    for (const mutate of mutations) {
      const input = fakeSubmissionDependencies();
      input.writeStartGuard.authorize.mockImplementationOnce((guardInput) => {
        const admission = writeStartAdmission({
          writeAdmissionId: guardInput.writeAdmissionId,
          subject: guardInput.subject,
          attempt: input.attempt,
          intentRecordVersion: guardInput.expectedIntentRecordVersion,
        });
        return Promise.resolve(mutate(admission));
      });

      await expect(input.workflow.submit(submitInput())).resolves.toEqual(
        input.writeStartDenied.resource,
      );
      expect(input.writeStartGuard.authorize).toHaveBeenCalledOnce();
      expect(input.writer.submit).not.toHaveBeenCalled();
      expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
      expect(
        input.repository.recordSubmissionNotSent.mock.calls[0]?.[0].outcome
          .reasonCode,
      ).toBe("submission_write_start_denied");
    }
  });

  it("rechecks a valid admission immediately before writer invocation", async () => {
    const input = fakeSubmissionDependencies();
    input.repository.recordSubmissionNotSent.mockResolvedValueOnce({
      kind: "recorded",
      intent: input.writeAdmissionExpired,
    });
    const base = Date.now();
    let readCount = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      const value = base + readCount * 200;
      readCount += 1;
      return value;
    });
    input.writeStartGuard.authorize.mockImplementationOnce((guardInput) =>
      Promise.resolve({
        decision: "allow",
        writeAdmissionId: guardInput.writeAdmissionId,
        ownerUserId: guardInput.subject.ownerUserId,
        intentId: guardInput.subject.intentId,
        network: guardInput.attempt.network,
        transportAttemptId: guardInput.attempt.transportAttemptId,
        operationRecordVersion: guardInput.attempt.operationRecordVersion,
        intentRecordVersion: guardInput.expectedIntentRecordVersion,
        agentIdentityId: guardInput.subject.agentIdentityId,
        agentAddress: guardInput.attempt.agentAddress,
        reviewSha256: guardInput.subject.reviewSha256,
        checkedAt: new Date(base + 100).toISOString(),
        expiresAt: new Date(base + 1_000).toISOString(),
      }),
    );

    try {
      await expect(input.workflow.submit(submitInput())).resolves.toEqual(
        input.writeAdmissionExpired.resource,
      );
    } finally {
      now.mockRestore();
    }

    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(input.writeStartGuard.authorize).toHaveBeenCalledOnce();
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
    expect(
      input.repository.recordSubmissionNotSent.mock.calls[0]?.[0].outcome
        .reasonCode,
    ).toBe("submission_write_admission_expired");
  });

  it("never falls through to the writer when proven-not-sent persistence fails", async () => {
    const input = fakeSubmissionDependencies();
    input.signer.sign.mockRejectedValueOnce(new Error("signer unavailable"));
    input.repository.recordSubmissionNotSent.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    input.repository.findOwned
      .mockResolvedValueOnce(input.prepared)
      .mockResolvedValueOnce(input.submitting);

    await expect(input.workflow.submit(submitInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.submitting.resource,
    );

    expect(input.repository.beginSubmission).toHaveBeenCalledOnce();
    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(input.writeStartGuard.authorize).not.toHaveBeenCalled();
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionNotSent).toHaveBeenCalledOnce();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
  });

  it("accepts an exact proven-not-sent persistence replay", async () => {
    const input = fakeSubmissionDependencies();
    input.writeStartGuard.authorize.mockRejectedValueOnce(
      new Error("final guard denied"),
    );
    input.repository.recordSubmissionNotSent.mockResolvedValueOnce({
      kind: "already_recorded",
      intent: input.writeStartDenied,
    });

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.writeStartDenied.resource,
    );
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionNotSent).toHaveBeenCalledOnce();
  });

  it("aborts a pending signer before the persisted writer window", async () => {
    const input = fakeSubmissionDependencies();
    input.repository.recordSubmissionNotSent.mockResolvedValueOnce({
      kind: "recorded",
      intent: input.signingNotCompleted,
    });
    input.repository.beginSubmission.mockResolvedValueOnce({
      kind: "started",
      intent: input.submitting,
      attempt: Object.freeze({
        ...input.attempt,
        writeStartBudgetMilliseconds: 1_100,
      }),
    });
    input.signer.sign.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          const rejectDeadline = () => {
            reject(new Error("fake signer deadline elapsed"));
          };

          if (signal.aborted) {
            rejectDeadline();
            return;
          }
          signal.addEventListener("abort", rejectDeadline, { once: true });
        }),
    );

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.signingNotCompleted.resource,
    );

    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(
      input.repository.recordSubmissionNotSent.mock.calls[0]?.[0].outcome
        .reasonCode,
    ).toBe("submission_signing_not_completed");
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
  });

  it("preserves only safe preflight errors and sanitizes unknown failures", async () => {
    const cases = [
      [new SpotIntentExpiredError(), SpotIntentExpiredError],
      [new SpotIntentStaleError(), SpotIntentStaleError],
      [new SpotWalletBindingRequiredError(), SpotWalletBindingRequiredError],
      [new SpotUnavailableError(), SpotUnavailableError],
      [new Error("secret preflight detail"), SpotUnavailableError],
    ] as const;

    for (const [failure, expected] of cases) {
      const input = fakeSubmissionDependencies();
      input.preflight.prepare.mockRejectedValueOnce(failure);

      await expect(input.workflow.submit(submitInput())).rejects.toBeInstanceOf(
        expected,
      );
      expect(input.repository.beginSubmission).not.toHaveBeenCalled();
      expect(input.signer.sign).not.toHaveBeenCalled();
      expect(input.writer.submit).not.toHaveBeenCalled();
    }
  });

  it("maps repository expiry, stale authority, and missing races before signing", async () => {
    const failures = [
      [new SpotIntentPrepareExpiredError(), SpotIntentExpiredError],
      [new SpotIntentAuthorityStaleError(), SpotIntentStaleError],
    ] as const;

    for (const [failure, expected] of failures) {
      const input = fakeSubmissionDependencies();
      input.repository.beginSubmission.mockRejectedValueOnce(failure);

      await expect(input.workflow.submit(submitInput())).rejects.toBeInstanceOf(
        expected,
      );
      expect(input.signer.sign).not.toHaveBeenCalled();
      expect(input.writer.submit).not.toHaveBeenCalled();
    }

    const missing = fakeSubmissionDependencies();
    missing.repository.beginSubmission.mockResolvedValueOnce({
      kind: "not_found",
    });
    await expect(missing.workflow.submit(submitInput())).rejects.toBeInstanceOf(
      SpotIntentNotFoundError,
    );
    expect(missing.signer.sign).not.toHaveBeenCalled();
    expect(missing.writer.submit).not.toHaveBeenCalled();
  });

  it("rejects a malformed fake signature before the writer boundary", async () => {
    const input = fakeSubmissionDependencies();
    input.repository.recordSubmissionNotSent.mockResolvedValueOnce({
      kind: "recorded",
      intent: input.signingNotCompleted,
    });
    input.signer.sign.mockResolvedValueOnce({
      r: "0xshort",
      s: input.signature.s,
      v: 27,
    });

    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.signingNotCompleted.resource,
    );

    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(
      input.repository.recordSubmissionNotSent.mock.calls[0]?.[0].outcome
        .reasonCode,
    ).toBe("submission_signing_not_completed");
    expect(input.writer.submit).not.toHaveBeenCalled();
    expect(input.repository.recordSubmissionUnknown).not.toHaveBeenCalled();
  });

  it("accepts an exact recovery replay and sanitizes a missing recovery row", async () => {
    const replay = fakeSubmissionDependencies();
    replay.repository.recordSubmissionUnknown.mockResolvedValueOnce({
      kind: "already_recorded",
      intent: replay.unclassified,
    });
    await expect(replay.workflow.submit(submitInput())).resolves.toEqual(
      replay.unclassified.resource,
    );
    expect(replay.writer.submit).toHaveBeenCalledOnce();

    const missing = fakeSubmissionDependencies();
    missing.repository.recordSubmissionUnknown.mockResolvedValueOnce({
      kind: "not_found",
    });
    await expect(missing.workflow.submit(submitInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(missing.writer.submit).toHaveBeenCalledOnce();
  });

  it("does not replay a writer when unknown persistence fails", async () => {
    const input = fakeSubmissionDependencies();
    input.repository.recordSubmissionUnknown.mockRejectedValueOnce(
      new Error("secret persistence failure"),
    );
    input.repository.findOwned
      .mockResolvedValueOnce(input.prepared)
      .mockResolvedValueOnce(input.submitting);

    await expect(input.workflow.submit(submitInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    await expect(input.workflow.submit(submitInput())).resolves.toEqual(
      input.submitting.resource,
    );

    expect(input.repository.beginSubmission).toHaveBeenCalledOnce();
    expect(input.signer.sign).toHaveBeenCalledOnce();
    expect(input.writer.submit).toHaveBeenCalledOnce();
    expect(input.repository.recordSubmissionUnknown).toHaveBeenCalledOnce();
  });
});
