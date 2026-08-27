import { describe, expect, it, vi } from "vitest";

import type {
  SpotIntentRecord,
  SpotIntentRepository,
} from "../src/database/spot-intent-repository.js";
import {
  createSpotReview,
  parseSpotIntentResource,
  type SpotIntentResource,
} from "../src/features/spot/spot-intent-contract.js";
import {
  SpotIntentExpiredError,
  SpotIntentNotFoundError,
} from "../src/features/spot/spot-intent-service.js";
import { createDefaultClosedSpotIntentWorkflow } from "../src/features/spot/spot-intent-workflow.js";
import { SpotUnavailableError } from "../src/features/spot/spot-errors.js";

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
    metadata_version: "meta-v1",
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
    metadataVersion: "meta-v1",
    metadataSha256: "b".repeat(64),
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
