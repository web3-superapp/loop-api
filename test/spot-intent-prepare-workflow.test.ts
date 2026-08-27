import { describe, expect, it, vi } from "vitest";

import { IdempotencyConflictError } from "../src/database/control-plane-repository.js";
import {
  SpotIntentAuthorityStaleError,
  SpotIntentClaimLimitExceededError,
  SpotIntentPrepareExpiredError,
  type SpotIntentRecord,
} from "../src/database/spot-intent-repository.js";
import {
  canonicalizeSpotIntentRequest,
  createSpotReview,
  digestSpotIntentRequest,
  type SpotIntentRequest,
  type SpotReview,
} from "../src/features/spot/spot-intent-contract.js";
import {
  createSpotIntentPrepareWorkflow,
  type SpotIntentPrepareRepository,
} from "../src/features/spot/spot-intent-prepare-workflow.js";
import {
  createSpotClientOrderId,
  parseSpotIntentReviewDraft,
  SpotIntentPrepareAuthorityRequiredError,
  SpotIntentReviewerUnavailableError,
  type SpotIntentPrepareAuthority,
  type SpotIntentPrepareAuthorityResolver,
  type SpotIntentReviewDraft,
  type SpotIntentReviewer,
} from "../src/features/spot/spot-intent-prepare.js";
import {
  SpotIntentClaimRateLimitedError,
  SpotIntentExpiredError,
  SpotIntentIdempotencyConflictError,
  SpotIntentStaleError,
} from "../src/features/spot/spot-intent-service.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "../src/features/spot/spot-errors.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const foreignOwnerUserId = "22222222-2222-4222-8222-222222222222";
const intentId = "33333333-3333-4333-8333-333333333333";
const claimId = "44444444-4444-4444-8444-444444444444";
const marketId = "55555555-5555-4555-8555-555555555555";
const otherMarketId = "66666666-6666-4666-8666-666666666666";
const agentIdentityId = "77777777-7777-4777-8777-777777777777";
const idempotencyKey = "88888888-8888-4888-8888-888888888888";
const requestId = "99999999-9999-4999-8999-999999999999";
const dependencyRequestIds = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
] as const;
const privyUserId = "did:privy:spot-prepare";
const accountAddress = `0x${"12".repeat(20)}`;
const clientOrderId = `0x${"ab".repeat(16)}`;
const baseTokenId = `0x${"23".repeat(16)}`;
const quoteTokenId = `0x${"34".repeat(16)}`;
const metadataSha256 = "4".repeat(64);
const nowMilliseconds = 1_800_000_000_000;
const factsObservedAt = new Date(nowMilliseconds - 100).toISOString();
const expiresAt = new Date(nowMilliseconds + 14_000).toISOString();

const request = Object.freeze({
  market_id: marketId,
  side: "buy",
  amount: Object.freeze({ mode: "quote", value: "10" }),
  max_slippage_bps: 25,
}) satisfies SpotIntentRequest;
const requestSha256 = digestSpotIntentRequest(request);
const sellRequest = Object.freeze({
  market_id: marketId,
  side: "sell" as const,
  amount: Object.freeze({ mode: "base" as const, value: "0.2" }),
  max_slippage_bps: 25,
}) satisfies SpotIntentRequest;

function reviewFor(
  overrides: Readonly<{
    marketId?: string;
    expiresAt?: string;
    side?: "buy" | "sell";
    amountMode?: "quote" | "base";
    amountValue?: string;
    computedBaseSize?: string;
    referencePrice?: string;
    referenceSourceTime?: string;
    worstIocLimitPrice?: string;
    settlementBoundValue?: string;
    feeEstimate?: string;
    feeObservedAt?: string;
  }> = {},
): SpotReview {
  const side = overrides.side ?? "buy";
  return createSpotReview({
    version: "spot_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market_id: overrides.marketId ?? marketId,
    base_display_identity: "PURR",
    quote_display_identity: "USDC",
    side,
    amount_mode: overrides.amountMode ?? (side === "buy" ? "quote" : "base"),
    amount_value: overrides.amountValue ?? (side === "buy" ? "10" : "0.2"),
    computed_base_size:
      overrides.computedBaseSize ?? (side === "buy" ? "0.1998" : "0.2"),
    reference_price: overrides.referencePrice ?? "49.9",
    reference_source_time: overrides.referenceSourceTime ?? factsObservedAt,
    worst_ioc_limit_price: overrides.worstIocLimitPrice ?? "50",
    maximum_spend_or_minimum_receive: {
      kind: side === "buy" ? "maximum_spend" : "minimum_receive",
      asset_display_identity: "USDC",
      value: overrides.settlementBoundValue ?? (side === "buy" ? "10" : "9.99"),
    },
    fee_rate: "0.001",
    fee_estimate: overrides.feeEstimate ?? "0.01",
    fee_source: {
      dataset: "user_fees",
      observed_at: overrides.feeObservedAt ?? factsObservedAt,
    },
    metadata_version: "spot_meta_v1",
    policy_version: "spot_intent_v1",
    binding_epoch: "1",
    expires_at: overrides.expiresAt ?? expiresAt,
  });
}

function authority(
  overrides: Partial<SpotIntentPrepareAuthority> = {},
): SpotIntentPrepareAuthority {
  return Object.freeze({
    ownerUserId,
    privyUserId,
    accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    agentIdentityId,
    verifiedAt: new Date(nowMilliseconds - 500).toISOString(),
    expiresAt: new Date(nowMilliseconds + 14_000).toISOString(),
    ...overrides,
  });
}

function draftFor(
  overrides: Partial<SpotIntentReviewDraft> = {},
): SpotIntentReviewDraft {
  const publicReview = overrides.publicReview ?? reviewFor();
  return Object.freeze({
    providerCoin: "PURR/USDC",
    baseTokenIndex: 1,
    baseTokenId,
    quoteTokenIndex: 0,
    quoteTokenId,
    spotPairIndex: 0,
    exchangeOrderAsset: 10_000,
    metadataVersion: "spot_meta_v1",
    metadataSha256,
    policyVersion: "spot_intent_v1",
    computedBaseSize: publicReview.computed_base_size,
    referencePrice: publicReview.reference_price,
    worstIocLimitPrice: publicReview.worst_ioc_limit_price,
    maximumSpendOrMinimumReceive:
      publicReview.maximum_spend_or_minimum_receive.value,
    feeRate: publicReview.fee_rate,
    feeEstimate: publicReview.fee_estimate,
    canonicalAction: Object.freeze({
      type: "order",
      orders: Object.freeze([
        Object.freeze({
          a: 10_000,
          b: publicReview.side === "buy",
          p: publicReview.worst_ioc_limit_price,
          s: publicReview.computed_base_size,
          r: false,
          t: Object.freeze({
            limit: Object.freeze({ tif: "Ioc" }),
          }),
          c: clientOrderId,
        }),
      ] as const),
      grouping: "na",
    }),
    publicReview,
    reviewSha256: publicReview.review_digest,
    factsObservedAt,
    referenceSourceTime: publicReview.reference_source_time,
    expiresAt: publicReview.expires_at,
    ...overrides,
  });
}

function preparedRecord(
  overrides: Partial<SpotIntentRecord> = {},
): SpotIntentRecord {
  const publicReview = overrides.publicReview ?? reviewFor();
  const canonicalAction =
    overrides.canonicalAction ?? draftFor().canonicalAction;
  const resource = Object.freeze({
    intent_id: intentId,
    state: "prepared" as const,
    review: publicReview,
    submission: Object.freeze({ state: "ready" as const }),
    result: null,
    expires_at: publicReview.expires_at,
    created_at: new Date(nowMilliseconds).toISOString(),
    updated_at: new Date(nowMilliseconds).toISOString(),
  });
  return Object.freeze({
    id: intentId,
    ownerUserId,
    requestSha256,
    network: "testnet",
    marketId,
    providerCoin: "PURR/USDC",
    baseTokenIndex: 1,
    baseTokenId,
    quoteTokenIndex: 0,
    quoteTokenId,
    spotPairIndex: 0,
    exchangeOrderAsset: 10_000,
    metadataVersion: "spot_meta_v1",
    metadataSha256,
    policyVersion: "spot_intent_v1",
    accountAddress,
    bindingVersion: "1",
    agentIdentityId,
    clientOrderId,
    canonicalAction,
    publicReview,
    reviewSha256: publicReview.review_digest,
    factsObservedAt,
    referenceSourceTime: factsObservedAt,
    state: "prepared",
    result: null,
    recordVersion: "0",
    createdAt: resource.created_at,
    updatedAt: resource.updated_at,
    resource,
    ...overrides,
  });
}

function workflowInput(signal = new AbortController().signal) {
  return Object.freeze({
    ownerUserId,
    privyUserId,
    idempotencyKey,
    requestId,
    request,
    canonicalRequest: canonicalizeSpotIntentRequest(request),
    requestSha256,
    signal,
  });
}

function harness() {
  const calls: string[] = [];
  const record = preparedRecord();
  const claimPrepare = vi.fn<SpotIntentPrepareRepository["claimPrepare"]>(
    () => {
      calls.push("claim");
      return Promise.resolve({ kind: "claimed", claimId });
    },
  );
  const prepare = vi.fn<SpotIntentPrepareRepository["prepare"]>((input) => {
    calls.push("prepare");
    expect(input.clientOrderId).toBe(clientOrderId);
    return Promise.resolve({ created: true, intent: record });
  });
  const findOwned = vi.fn<SpotIntentPrepareRepository["findOwned"]>(() =>
    Promise.resolve(record),
  );
  const repository = { claimPrepare, prepare, findOwned };
  const resolve = vi.fn<SpotIntentPrepareAuthorityResolver["resolve"]>(() => {
    calls.push(`authority:${resolve.mock.calls.length}`);
    return Promise.resolve(authority());
  });
  const review = vi.fn<SpotIntentReviewer["review"]>(() => {
    calls.push("review");
    return Promise.resolve(draftFor());
  });
  let uuidIndex = 0;
  const createUuid = vi.fn<() => string>(() => {
    const value = dependencyRequestIds[uuidIndex];
    uuidIndex += 1;
    if (value === undefined) {
      throw new Error("unexpected UUID request");
    }
    return value;
  });
  const createClientOrderId = vi.fn(() => {
    calls.push("cloid");
    return clientOrderId;
  });
  const now = vi.fn(() => new Date(nowMilliseconds));
  const workflow = createSpotIntentPrepareWorkflow({
    repository,
    authorityResolver: { resolve },
    reviewer: { review },
    createUuid,
    createClientOrderId,
    now,
  });
  return {
    calls,
    claimPrepare,
    createClientOrderId,
    createUuid,
    findOwned,
    now,
    prepare,
    record,
    repository,
    resolve,
    review,
    workflow,
  };
}

describe("uncomposed Spot intent prepare coordinator", () => {
  it("claims first, resolves authority twice, and persists only an exact review", async () => {
    const input = harness();
    const requestInput = workflowInput();

    const result = await input.workflow.prepare(requestInput);

    expect(input.calls).toEqual([
      "claim",
      "authority:1",
      "cloid",
      "review",
      "authority:2",
      "prepare",
    ]);
    expect(input.claimPrepare).toHaveBeenCalledWith({
      ownerUserId,
      idempotencyKey,
      requestSha256,
    });
    expect(input.resolve).toHaveBeenNthCalledWith(1, {
      ownerUserId,
      privyUserId,
      network: "testnet",
      requestId: dependencyRequestIds[0],
      signal: requestInput.signal,
    });
    expect(input.review).toHaveBeenCalledWith({
      ownerUserId,
      network: "testnet",
      request,
      requestSha256,
      authority: authority(),
      clientOrderId,
      requestId: dependencyRequestIds[1],
      signal: requestInput.signal,
    });
    expect(input.resolve).toHaveBeenNthCalledWith(2, {
      ownerUserId,
      privyUserId,
      network: "testnet",
      requestId: dependencyRequestIds[2],
      signal: requestInput.signal,
    });
    expect(input.createUuid).toHaveBeenCalledTimes(3);
    expect(input.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId,
        claimId,
        idempotencyKey,
        requestSha256,
        requestId,
        marketId,
        side: "buy",
        amountMode: "quote",
        amountValue: "10",
        accountAddress,
        bindingVersion: "1",
        agentIdentityId,
        clientOrderId,
      }),
    );
    expect(result).toEqual(input.record.resource);
    const serialized = JSON.stringify(result);
    for (const secret of [
      accountAddress,
      agentIdentityId,
      clientOrderId,
      baseTokenId,
      quoteTokenId,
      metadataSha256,
      "PURR/USDC",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each(["replay", "pending"] as const)(
    "%s performs no authority, quote, CLOID, or persistence work",
    async (kind) => {
      const input = harness();
      input.claimPrepare.mockResolvedValueOnce(
        kind === "replay"
          ? { kind, intent: input.record }
          : { kind: "pending" },
      );

      const result = input.workflow.prepare(workflowInput());

      if (kind === "replay") {
        await expect(result).resolves.toEqual(input.record.resource);
      } else {
        await expect(result).rejects.toBeInstanceOf(SpotUnavailableError);
      }
      expect(input.resolve).not.toHaveBeenCalled();
      expect(input.review).not.toHaveBeenCalled();
      expect(input.createUuid).not.toHaveBeenCalled();
      expect(input.createClientOrderId).not.toHaveBeenCalled();
      expect(input.now).not.toHaveBeenCalled();
      expect(input.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["canonical request", { canonicalRequest: "{}" }],
    ["request digest", { requestSha256: "f".repeat(64) }],
  ] as const)(
    "rejects a mismatched %s before claiming",
    async (_label, drift) => {
      const input = harness();

      await expect(
        input.workflow.prepare({ ...workflowInput(), ...drift }),
      ).rejects.toBeInstanceOf(SpotUnavailableError);

      expect(input.claimPrepare).not.toHaveBeenCalled();
      expect(input.resolve).not.toHaveBeenCalled();
      expect(input.review).not.toHaveBeenCalled();
      expect(input.createUuid).not.toHaveBeenCalled();
      expect(input.createClientOrderId).not.toHaveBeenCalled();
      expect(input.now).not.toHaveBeenCalled();
      expect(input.prepare).not.toHaveBeenCalled();
    },
  );

  it("rejects every mismatched replay before dependency work", async () => {
    const mismatchedRecords = [
      preparedRecord({ ownerUserId: foreignOwnerUserId }),
      preparedRecord({ requestSha256: "e".repeat(64) }),
      preparedRecord({ publicReview: reviewFor({ marketId: otherMarketId }) }),
    ];

    for (const record of mismatchedRecords) {
      const input = harness();
      input.claimPrepare.mockResolvedValueOnce({
        kind: "replay",
        intent: record,
      });

      await expect(
        input.workflow.prepare(workflowInput()),
      ).rejects.toBeInstanceOf(SpotUnavailableError);
      expect(input.resolve).not.toHaveBeenCalled();
      expect(input.review).not.toHaveBeenCalled();
      expect(input.createUuid).not.toHaveBeenCalled();
      expect(input.createClientOrderId).not.toHaveBeenCalled();
      expect(input.now).not.toHaveBeenCalled();
      expect(input.prepare).not.toHaveBeenCalled();
    }
  });

  it("rejects authority drift after review without persisting", async () => {
    const input = harness();
    input.resolve
      .mockResolvedValueOnce(authority())
      .mockResolvedValueOnce(authority({ bindingVersion: "2" }));

    await expect(
      input.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotIntentStaleError);

    expect(input.review).toHaveBeenCalledOnce();
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["account", { accountAddress: `0x${"56".repeat(20)}` }],
    ["binding epoch", { bindingVersion: "2" }],
    [
      "Agent identity",
      { agentIdentityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ],
  ] as const)("rejects %s drift after review", async (_label, drift) => {
    const input = harness();
    input.resolve
      .mockResolvedValueOnce(authority())
      .mockResolvedValueOnce(authority(drift));

    await expect(
      input.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotIntentStaleError);

    expect(input.resolve).toHaveBeenCalledTimes(2);
    expect(input.review).toHaveBeenCalledOnce();
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it("allows a refreshed authority lease when its identity is unchanged", async () => {
    const input = harness();
    input.resolve.mockResolvedValueOnce(authority()).mockResolvedValueOnce(
      authority({
        verifiedAt: new Date(nowMilliseconds - 100).toISOString(),
        expiresAt: new Date(nowMilliseconds + 14_500).toISOString(),
      }),
    );

    await expect(input.workflow.prepare(workflowInput())).resolves.toEqual(
      input.record.resource,
    );
    expect(input.resolve).toHaveBeenCalledTimes(2);
    expect(input.prepare).toHaveBeenCalledOnce();
  });

  it("rejects authority and review expiry at the observed-time boundary", async () => {
    const expiredAuthority = harness();
    expiredAuthority.resolve.mockResolvedValueOnce(
      authority({
        verifiedAt: new Date(nowMilliseconds - 1).toISOString(),
        expiresAt: new Date(nowMilliseconds).toISOString(),
      }),
    );
    await expect(
      expiredAuthority.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(expiredAuthority.review).not.toHaveBeenCalled();

    const expiredReview = harness();
    const boundaryExpiry = new Date(nowMilliseconds).toISOString();
    expiredReview.review.mockResolvedValueOnce(
      draftFor({
        publicReview: reviewFor({ expiresAt: boundaryExpiry }),
        expiresAt: boundaryExpiry,
      }),
    );
    await expect(
      expiredReview.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(expiredReview.resolve).toHaveBeenCalledOnce();
    expect(expiredReview.prepare).not.toHaveBeenCalled();
  });

  it("maps an explicitly missing authority but sanitizes malformed authority", async () => {
    const required = harness();
    required.resolve.mockRejectedValueOnce(
      new SpotIntentPrepareAuthorityRequiredError(),
    );
    await expect(
      required.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotWalletBindingRequiredError);
    expect(required.review).not.toHaveBeenCalled();

    const malformed = harness();
    malformed.resolve.mockResolvedValueOnce({
      ...authority(),
      signerRef: "must-not-cross-this-boundary",
    });
    await expect(
      malformed.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(malformed.review).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong owner", { ownerUserId: foreignOwnerUserId }],
    ["wrong Privy identity", { privyUserId: "did:privy:other" }],
    [
      "future verification",
      { verifiedAt: new Date(nowMilliseconds + 1).toISOString() },
    ],
    [
      "overlong authority lease",
      {
        verifiedAt: new Date(nowMilliseconds - 1_001).toISOString(),
        expiresAt: new Date(nowMilliseconds + 14_001).toISOString(),
      },
    ],
  ] as const)("rejects authority with %s", async (_label, invalidAuthority) => {
    const input = harness();
    input.resolve.mockResolvedValueOnce(authority(invalidAuthority));

    await expect(
      input.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    expect(input.resolve).toHaveBeenCalledOnce();
    expect(input.review).not.toHaveBeenCalled();
    expect(input.createClientOrderId).not.toHaveBeenCalled();
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it("rechecks authority freshness after review latency", async () => {
    const input = harness();
    input.now
      .mockReturnValueOnce(new Date(nowMilliseconds))
      .mockReturnValueOnce(new Date(nowMilliseconds))
      .mockReturnValueOnce(new Date(nowMilliseconds + 14_000));

    await expect(
      input.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    expect(input.resolve).toHaveBeenCalledTimes(2);
    expect(input.review).toHaveBeenCalledOnce();
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong CLOID",
      () =>
        draftFor({
          canonicalAction: {
            ...draftFor().canonicalAction,
            orders: [
              {
                ...draftFor().canonicalAction.orders[0],
                c: `0x${"cd".repeat(16)}`,
              },
            ],
          },
        }),
    ],
    [
      "wrong wire asset",
      () =>
        draftFor({
          canonicalAction: {
            ...draftFor().canonicalAction,
            orders: [{ ...draftFor().canonicalAction.orders[0], a: 10_001 }],
          },
        }),
    ],
    [
      "wrong wire side",
      () =>
        draftFor({
          canonicalAction: {
            ...draftFor().canonicalAction,
            orders: [{ ...draftFor().canonicalAction.orders[0], b: false }],
          },
        }),
    ],
    [
      "wrong wire price",
      () =>
        draftFor({
          canonicalAction: {
            ...draftFor().canonicalAction,
            orders: [{ ...draftFor().canonicalAction.orders[0], p: "49.99" }],
          },
        }),
    ],
    [
      "wrong wire size",
      () =>
        draftFor({
          canonicalAction: {
            ...draftFor().canonicalAction,
            orders: [{ ...draftFor().canonicalAction.orders[0], s: "1" }],
          },
        }),
    ],
    [
      "wrong market",
      () => draftFor({ publicReview: reviewFor({ marketId: otherMarketId }) }),
    ],
    [
      "expired review",
      () =>
        draftFor({
          publicReview: reviewFor({
            expiresAt: new Date(nowMilliseconds - 1).toISOString(),
          }),
        }),
    ],
    [
      "non-aggressive buy price",
      () =>
        draftFor({
          worstIocLimitPrice: "48",
          canonicalAction: {
            ...draftFor().canonicalAction,
            orders: [{ ...draftFor().canonicalAction.orders[0], p: "48" }],
          },
          publicReview: reviewFor({ worstIocLimitPrice: "48" }),
        }),
    ],
    [
      "price beyond the requested slippage cap",
      () => draftFor({ publicReview: reviewFor({ referencePrice: "49" }) }),
    ],
    [
      "action notional above the requested maximum spend",
      () => draftFor({ publicReview: reviewFor({ computedBaseSize: "1" }) }),
    ],
    [
      "gross buy notional that leaves no room for its fee",
      () => draftFor({ publicReview: reviewFor({ computedBaseSize: "0.2" }) }),
    ],
    [
      "fee estimate below the exact reviewed rate",
      () => draftFor({ publicReview: reviewFor({ feeEstimate: "0.001" }) }),
    ],
    [
      "public maximum spend different from the requested quote amount",
      () =>
        draftFor({
          publicReview: reviewFor({ settlementBoundValue: "11" }),
        }),
    ],
    [
      "stale reference source",
      () =>
        draftFor({
          publicReview: reviewFor({
            referenceSourceTime: new Date(
              Date.parse(factsObservedAt) - 2_001,
            ).toISOString(),
          }),
        }),
    ],
    [
      "stale fee source",
      () =>
        draftFor({
          publicReview: reviewFor({
            feeObservedAt: new Date(
              Date.parse(factsObservedAt) - 15_001,
            ).toISOString(),
          }),
        }),
    ],
    [
      "noncanonical fee timestamp",
      () =>
        draftFor({
          publicReview: reviewFor({
            feeObservedAt: factsObservedAt.replace("Z", "+00:00"),
          }),
        }),
    ],
    [
      "review lifetime above fifteen seconds",
      () => {
        const tooLate = new Date(
          Date.parse(factsObservedAt) + 15_001,
        ).toISOString();
        return draftFor({
          publicReview: reviewFor({ expiresAt: tooLate }),
          expiresAt: tooLate,
        });
      },
    ],
    [
      "future facts observation",
      () =>
        draftFor({
          factsObservedAt: new Date(nowMilliseconds + 1).toISOString(),
        }),
    ],
    ["metadata version drift", () => draftFor({ metadataVersion: "other" })],
    ["policy version drift", () => draftFor({ policyVersion: "other" })],
  ] as const)(
    "rejects a reviewer draft with %s",
    async (_label, createDraft) => {
      const input = harness();
      input.review.mockResolvedValueOnce(createDraft());

      await expect(
        input.workflow.prepare(workflowInput()),
      ).rejects.toBeInstanceOf(SpotUnavailableError);

      expect(input.resolve).toHaveBeenCalledOnce();
      expect(input.prepare).not.toHaveBeenCalled();
    },
  );

  it("rejects a slippage preference above the v1 product cap", async () => {
    const input = harness();
    const overCapRequest = Object.freeze({ ...request, max_slippage_bps: 101 });

    await expect(
      input.workflow.prepare({
        ...workflowInput(),
        request: overCapRequest,
        canonicalRequest: canonicalizeSpotIntentRequest(overCapRequest),
        requestSha256: digestSpotIntentRequest(overCapRequest),
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);

    expect(input.resolve).toHaveBeenCalledOnce();
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it("accepts exact sell-base math inside the reviewed price cap", () => {
    const sellReview = reviewFor({
      side: "sell",
      referencePrice: "50.1",
      worstIocLimitPrice: "50",
    });

    const parsed = parseSpotIntentReviewDraft(
      draftFor({ publicReview: sellReview }),
      {
        request: sellRequest,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      },
    );

    expect(parsed.publicReview.side).toBe("sell");
    expect(parsed.canonicalAction.orders[0]).toMatchObject({
      b: false,
      p: "50",
      s: "0.2",
    });
  });

  it.each([
    [
      "sell size above the requested base amount",
      reviewFor({
        side: "sell",
        computedBaseSize: "1",
        referencePrice: "50.1",
        worstIocLimitPrice: "50",
        settlementBoundValue: "9.99",
        feeEstimate: "0.05",
      }),
    ],
    [
      "sell price beyond the requested slippage cap",
      reviewFor({
        side: "sell",
        referencePrice: "50.1",
        worstIocLimitPrice: "49.9",
        settlementBoundValue: "9.97",
      }),
    ],
    [
      "sell minimum receive that ignores its fee",
      reviewFor({
        side: "sell",
        referencePrice: "50.1",
        worstIocLimitPrice: "50",
        settlementBoundValue: "10",
      }),
    ],
  ] as const)("rejects %s", (_label, invalidReview) => {
    expect(() =>
      parseSpotIntentReviewDraft(draftFor({ publicReview: invalidReview }), {
        request: sellRequest,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      }),
    ).toThrow(SpotIntentReviewerUnavailableError);
  });

  it("enforces the exact requested slippage boundary", () => {
    const atBoundary = reviewFor({
      referencePrice: "40",
      worstIocLimitPrice: "40.1",
    });
    expect(
      parseSpotIntentReviewDraft(draftFor({ publicReview: atBoundary }), {
        request,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      }).worstIocLimitPrice,
    ).toBe("40.1");

    const overBoundary = reviewFor({
      referencePrice: "40",
      worstIocLimitPrice: "40.1001",
    });
    expect(() =>
      parseSpotIntentReviewDraft(draftFor({ publicReview: overBoundary }), {
        request,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      }),
    ).toThrow(SpotIntentReviewerUnavailableError);
  });

  it("locks the 25 bps default and preserves an explicit zero bps cap", () => {
    const requestWithoutSlippage = Object.freeze({
      market_id: marketId,
      side: "buy" as const,
      amount: Object.freeze({ mode: "quote" as const, value: "10" }),
    }) satisfies SpotIntentRequest;
    const defaultBoundary = reviewFor({
      referencePrice: "40",
      worstIocLimitPrice: "40.1",
    });
    expect(() =>
      parseSpotIntentReviewDraft(draftFor({ publicReview: defaultBoundary }), {
        request: requestWithoutSlippage,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      }),
    ).not.toThrow();
    const beyondDefault = reviewFor({
      referencePrice: "40",
      worstIocLimitPrice: "40.1001",
    });
    expect(() =>
      parseSpotIntentReviewDraft(draftFor({ publicReview: beyondDefault }), {
        request: requestWithoutSlippage,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      }),
    ).toThrow(SpotIntentReviewerUnavailableError);

    const zeroSlippageRequest = Object.freeze({
      ...requestWithoutSlippage,
      max_slippage_bps: 0,
    });
    const exactPrice = reviewFor({
      referencePrice: "40",
      worstIocLimitPrice: "40",
    });
    expect(() =>
      parseSpotIntentReviewDraft(draftFor({ publicReview: exactPrice }), {
        request: zeroSlippageRequest,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      }),
    ).not.toThrow();
    const aboveZero = reviewFor({
      referencePrice: "40",
      worstIocLimitPrice: "40.0001",
    });
    expect(() =>
      parseSpotIntentReviewDraft(draftFor({ publicReview: aboveZero }), {
        request: zeroSlippageRequest,
        authority: authority(),
        clientOrderId,
        observedAtMilliseconds: nowMilliseconds,
      }),
    ).toThrow(SpotIntentReviewerUnavailableError);
  });

  it.each([
    [new IdempotencyConflictError(), SpotIntentIdempotencyConflictError],
    [new SpotIntentClaimLimitExceededError(), SpotIntentClaimRateLimitedError],
  ] as const)("maps safe claim failures", async (failure, expected) => {
    const input = harness();
    input.claimPrepare.mockRejectedValueOnce(failure);

    await expect(
      input.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(expected);
    expect(input.resolve).not.toHaveBeenCalled();
  });

  it.each([
    [new SpotIntentPrepareExpiredError(), SpotIntentExpiredError],
    [new SpotIntentAuthorityStaleError(), SpotIntentStaleError],
    [new Error("sensitive database failure"), SpotUnavailableError],
  ] as const)("maps safe prepare failures", async (failure, expected) => {
    const input = harness();
    input.prepare.mockRejectedValueOnce(failure);

    await expect(
      input.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(expected);
  });

  it("stops at abort boundaries without later reads or persistence", async () => {
    const beforeClaim = harness();
    const firstController = new AbortController();
    firstController.abort();
    await expect(
      beforeClaim.workflow.prepare(workflowInput(firstController.signal)),
    ).rejects.toThrow();
    expect(beforeClaim.claimPrepare).not.toHaveBeenCalled();

    const afterClaim = harness();
    const claimController = new AbortController();
    afterClaim.claimPrepare.mockImplementationOnce(() => {
      claimController.abort();
      return Promise.resolve({ kind: "claimed", claimId });
    });
    await expect(
      afterClaim.workflow.prepare(workflowInput(claimController.signal)),
    ).rejects.toThrow();
    expect(afterClaim.resolve).not.toHaveBeenCalled();
    expect(afterClaim.createClientOrderId).not.toHaveBeenCalled();

    const afterCloid = harness();
    const cloidController = new AbortController();
    afterCloid.createClientOrderId.mockImplementationOnce(() => {
      cloidController.abort();
      return clientOrderId;
    });
    await expect(
      afterCloid.workflow.prepare(workflowInput(cloidController.signal)),
    ).rejects.toThrow();
    expect(afterCloid.review).not.toHaveBeenCalled();
    expect(afterCloid.prepare).not.toHaveBeenCalled();

    const duringReview = harness();
    const secondController = new AbortController();
    duringReview.review.mockImplementationOnce(() => {
      secondController.abort();
      return Promise.resolve(draftFor());
    });
    await expect(
      duringReview.workflow.prepare(workflowInput(secondController.signal)),
    ).rejects.toThrow();
    expect(duringReview.resolve).toHaveBeenCalledOnce();
    expect(duringReview.prepare).not.toHaveBeenCalled();

    const beforeSubmit = harness();
    const submitController = new AbortController();
    submitController.abort();
    await expect(
      beforeSubmit.workflow.submit({
        ownerUserId,
        privyUserId,
        intentId,
        requestId,
        signal: submitController.signal,
      }),
    ).rejects.toThrow();
    expect(beforeSubmit.findOwned).not.toHaveBeenCalled();
  });

  it("fails before authority reads when dependency UUIDs or CLOIDs are invalid", async () => {
    const duplicateUuid = harness();
    duplicateUuid.createUuid.mockReturnValueOnce(requestId);
    await expect(
      duplicateUuid.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(duplicateUuid.resolve).not.toHaveBeenCalled();

    const beforeReviewCollision = harness();
    beforeReviewCollision.createUuid
      .mockReturnValueOnce(dependencyRequestIds[0])
      .mockReturnValueOnce(dependencyRequestIds[0]);
    await expect(
      beforeReviewCollision.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(beforeReviewCollision.resolve).toHaveBeenCalledOnce();
    expect(beforeReviewCollision.review).not.toHaveBeenCalled();

    const beforeSecondAuthorityCollision = harness();
    beforeSecondAuthorityCollision.createUuid
      .mockReturnValueOnce(dependencyRequestIds[0])
      .mockReturnValueOnce(dependencyRequestIds[1])
      .mockReturnValueOnce(dependencyRequestIds[1]);
    await expect(
      beforeSecondAuthorityCollision.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(beforeSecondAuthorityCollision.resolve).toHaveBeenCalledOnce();
    expect(beforeSecondAuthorityCollision.review).toHaveBeenCalledOnce();
    expect(beforeSecondAuthorityCollision.prepare).not.toHaveBeenCalled();

    const malformedCloid = harness();
    malformedCloid.createClientOrderId.mockReturnValueOnce("0x01");
    await expect(
      malformedCloid.workflow.prepare(workflowInput()),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(malformedCloid.resolve).toHaveBeenCalledOnce();
    expect(malformedCloid.review).not.toHaveBeenCalled();
  });

  it("sanitizes reviewer failures without leaking the server CLOID", async () => {
    const input = harness();
    input.review.mockRejectedValueOnce(
      new Error(`sensitive reviewer failure for ${clientOrderId}`),
    );

    const error = await input.workflow
      .prepare(workflowInput())
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SpotUnavailableError);
    expect(String(error)).not.toContain(clientOrderId);
    expect(JSON.stringify(error)).not.toContain(clientOrderId);
    expect(input.prepare).not.toHaveBeenCalled();
  });

  it("keeps owner lookup fail-closed and submission unavailable", async () => {
    const input = harness();
    await expect(
      input.workflow.findOwned({ ownerUserId, intentId }),
    ).resolves.toEqual(input.record.resource);

    input.findOwned.mockResolvedValueOnce(null);
    await expect(
      input.workflow.findOwned({ ownerUserId: foreignOwnerUserId, intentId }),
    ).rejects.toThrow();

    await expect(
      input.workflow.submit({
        ownerUserId,
        privyUserId,
        intentId,
        requestId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
  });
});

describe("Spot client order ID generation", () => {
  it("uses exactly 128 random bits and returns lowercase wire text", () => {
    const createRandomBytes = vi.fn(() =>
      Uint8Array.from({ length: 16 }, (_value, index) => index),
    );

    expect(createSpotClientOrderId(createRandomBytes)).toBe(
      "0x000102030405060708090a0b0c0d0e0f",
    );
    expect(createRandomBytes).toHaveBeenCalledWith(16);
  });

  it("rejects malformed entropy without exposing it", () => {
    let error: unknown;
    try {
      createSpotClientOrderId(() => {
        throw new Error("sensitive-rng-material");
      });
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(SpotIntentReviewerUnavailableError);
    expect(String(error)).not.toContain("sensitive-rng-material");

    expect(() => createSpotClientOrderId(() => new Uint8Array(15))).toThrow(
      SpotIntentReviewerUnavailableError,
    );
  });
});
