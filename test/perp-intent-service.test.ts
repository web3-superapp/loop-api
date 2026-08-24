import { describe, expect, it, vi } from "vitest";

import { IdempotencyConflictError } from "../src/database/control-plane-repository.js";
import type {
  PerpIntentRecord,
  PerpIntentRepository,
  PreparePerpIntentInput,
} from "../src/database/perp-intent-repository.js";
import {
  PerpIntentClaimLimitExceededError,
  PerpIntentRepositoryUnavailableError,
} from "../src/database/perp-intent-repository.js";
import type { PerpIntentRequest } from "../src/features/perp/perp-intent-contract.js";
import {
  createPerpIntentService,
  InvalidPerpIntentRequestError,
  PerpIntentClaimRateLimitedError,
  PerpIntentExpiredError,
  PerpIntentIdempotencyConflictError,
  PerpIntentNotFoundError,
  PerpIntentStaleError,
  PerpIntentUnavailableError,
  PerpIntentWalletBindingRequiredError,
  PerpMutationDisabledError,
  type PerpMutationGate,
} from "../src/features/perp/perp-intent-service.js";
import type { PerpWalletBindingResolver } from "../src/features/perp/wallet-binding-resolver.js";
import {
  HyperliquidPerpIntentReviewerUnavailableError,
  type HyperliquidPerpIntentReviewer,
  type ReviewPerpIntentInput,
} from "../src/integrations/hyperliquid/perp-intent-reviewer.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherOwnerUserId = "90d2fcae-e660-45fa-8629-b3a5979868e6";
const privyUserId = "did:privy:perp-intent-user";
const accountAddress = `0x${"12".repeat(20)}`;
const intentId = "c1d69ec4-f905-4ed2-bf1a-35cd1a49c306";
const idempotencyKey = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-08-25T00:00:01.000Z");
const fetchedAt = "2026-08-25T00:00:00.000Z";
const expiresAt = "2026-08-25T00:00:02.000Z";
const createdAt = "2026-08-24T23:59:59.000Z";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId,
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
});
const binding = Object.freeze({
  ownerUserId,
  privyUserId,
  accountAddress,
  accountKind: "master",
  bindingVersion: "7",
  verifiedAt: "2026-08-24T23:59:00.000Z",
  expiresAt: "2026-08-25T00:01:00.000Z",
});
const limitOrder = Object.freeze({
  action: "order",
  coin: "BTC",
  side: "buy",
  order_type: "limit",
  size: "0.01",
  limit_price: "64000.00",
  time_in_force: "gtc",
  reduce_only: false,
} as const satisfies PerpIntentRequest);

function reviewFor(input: ReviewPerpIntentInput) {
  const generated = input.items[0]?.generatedClientOrderId;
  if (generated === null || generated === undefined) {
    throw new Error("Expected a generated client order ID");
  }
  return {
    version: "perp_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    action: { ...input.request, client_order_id: generated },
    source: { fetched_at: fetchedAt, expires_at: expiresAt },
  };
}

function recordFromPrepare(
  input: PreparePerpIntentInput,
  state: PerpIntentRecord["state"] = "prepared",
): PerpIntentRecord {
  return Object.freeze({
    id: intentId,
    ownerUserId: input.ownerUserId,
    requestSha256: input.requestSha256,
    action: input.action,
    state,
    accountAddress: input.accountAddress,
    accountKind: input.accountKind,
    bindingVersion: input.bindingVersion,
    canonicalAction: input.canonicalAction,
    publicReview: input.publicReview,
    reviewSha256: input.reviewSha256,
    factsObservedAt: input.factsObservedAt,
    expiresAt: input.expiresAt,
    items: input.items.map((item) => ({
      ...item,
      resultState: null,
      resultOrderId: null,
      resultClientOrderId: null,
      filledSize: null,
      averageFillPrice: null,
      reasonCode: null,
      observedAt: null,
    })),
    result: null,
    createdAt,
    updatedAt: createdAt,
  });
}

function fixedRecord(
  state: PerpIntentRecord["state"] = "prepared",
  recordExpiresAt = expiresAt,
): PerpIntentRecord {
  const generatedClientOrderId = `0x${"ab".repeat(16)}`;
  const publicReview = {
    version: "perp_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    action: { ...limitOrder, client_order_id: generatedClientOrderId },
    source: { fetched_at: fetchedAt, expires_at: recordExpiresAt },
  } as const;
  return Object.freeze({
    id: intentId,
    ownerUserId,
    requestSha256: "a".repeat(64),
    action: "order",
    state,
    accountAddress,
    accountKind: "master",
    bindingVersion: "7",
    canonicalAction: limitOrder,
    publicReview,
    reviewSha256: "b".repeat(64),
    factsObservedAt: fetchedAt,
    expiresAt: recordExpiresAt,
    items: [
      {
        index: 0,
        coin: "BTC",
        targetKind: null,
        targetOrderId: null,
        targetClientOrderId: null,
        generatedClientOrderId,
        resultState: null,
        resultOrderId: null,
        resultClientOrderId: null,
        filledSize: null,
        averageFillPrice: null,
        reasonCode: null,
        observedAt: null,
      },
    ] as const,
    result: null,
    createdAt,
    updatedAt: createdAt,
  });
}

function harness(options: { readonly gate?: PerpMutationGate } = {}) {
  const calls: string[] = [];
  const claimPrepare = vi.fn<PerpIntentRepository["claimPrepare"]>(() => {
    calls.push("claim");
    return Promise.resolve({ kind: "claimed" });
  });
  const prepare = vi.fn<PerpIntentRepository["prepare"]>((input) => {
    calls.push("persist");
    return Promise.resolve({ created: true, intent: recordFromPrepare(input) });
  });
  const findOwned = vi.fn<PerpIntentRepository["findOwned"]>(() =>
    Promise.resolve(fixedRecord()),
  );
  const resolve = vi.fn<PerpWalletBindingResolver["resolve"]>(() => {
    calls.push("binding");
    return Promise.resolve(binding);
  });
  const review = vi.fn<HyperliquidPerpIntentReviewer["review"]>((input) => {
    calls.push("review");
    return Promise.resolve(reviewFor(input));
  });
  const repository = {
    claimPrepare,
    prepare,
    findOwned,
  } satisfies PerpIntentRepository;
  const service = createPerpIntentService({
    repository,
    bindingResolver: { resolve },
    reviewer: { review },
    ...(options.gate === undefined ? {} : { mutationGate: options.gate }),
    now: () => now,
  });
  return {
    calls,
    claimPrepare,
    findOwned,
    prepare,
    repository,
    resolve,
    review,
    service,
  };
}

function prepareInput(body: unknown = limitOrder) {
  return {
    principal,
    idempotencyKey,
    requestId,
    body,
    signal: new AbortController().signal,
  };
}

describe("Perp intent service", () => {
  it("prepares a strict persisted review in claim-binding-review-persist order", async () => {
    const inputs = harness();
    const resource = await inputs.service.prepare(prepareInput());

    expect(inputs.calls).toEqual([
      "claim",
      "binding",
      "review",
      "binding",
      "persist",
    ]);
    expect(resource).toMatchObject({
      intent_id: intentId,
      action: "order",
      state: "prepared",
      submission: { state: "disabled" },
      result: null,
    });
    expect(Object.isFrozen(resource)).toBe(true);
    expect(JSON.stringify(resource)).not.toContain(accountAddress);
    expect(JSON.stringify(resource)).not.toContain("requestSha256");

    const persisted = inputs.prepare.mock.calls[0]?.[0];
    expect(persisted).toBeDefined();
    expect(persisted).toMatchObject({
      ownerUserId,
      idempotencyKey,
      requestId,
      accountAddress,
      accountKind: "master",
      bindingVersion: "7",
      action: "order",
      canonicalAction: limitOrder,
      factsObservedAt: fetchedAt,
      expiresAt,
    });
    expect(persisted?.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted?.reviewSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted?.items).toHaveLength(1);
    expect(persisted?.items[0]?.generatedClientOrderId).toMatch(
      /^0x[0-9a-f]{32}$/,
    );
    expect(persisted?.items[0]).toMatchObject({
      index: 0,
      coin: "BTC",
      targetKind: null,
      targetOrderId: null,
      targetClientOrderId: null,
    });
    expect(resource.review.action).toMatchObject({
      ...limitOrder,
      client_order_id: persisted?.items[0]?.generatedClientOrderId,
    });
  });

  it("returns an exact idempotent replay before wallet or reviewer work", async () => {
    const inputs = harness();
    inputs.claimPrepare.mockImplementationOnce((input) =>
      Promise.resolve({
        kind: "replay",
        intent: { ...fixedRecord(), requestSha256: input.requestSha256 },
      }),
    );

    const resource = await inputs.service.prepare(prepareInput());

    expect(resource.intent_id).toBe(intentId);
    expect(inputs.resolve).not.toHaveBeenCalled();
    expect(inputs.review).not.toHaveBeenCalled();
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("does not expose a replay record bound to another owner or digest", async () => {
    const inputs = harness();
    inputs.claimPrepare.mockResolvedValueOnce({
      kind: "replay",
      intent: { ...fixedRecord(), ownerUserId: otherOwnerUserId },
    });

    await expect(inputs.service.prepare(prepareInput())).rejects.toBeInstanceOf(
      PerpIntentIdempotencyConflictError,
    );
    expect(inputs.resolve).not.toHaveBeenCalled();
    expect(inputs.review).not.toHaveBeenCalled();
  });

  it("maps an owner or digest idempotency conflict before wallet and reviewer work", async () => {
    const inputs = harness();
    inputs.claimPrepare.mockRejectedValueOnce(new IdempotencyConflictError());

    await expect(inputs.service.prepare(prepareInput())).rejects.toBeInstanceOf(
      PerpIntentIdempotencyConflictError,
    );
    expect(inputs.resolve).not.toHaveBeenCalled();
    expect(inputs.review).not.toHaveBeenCalled();
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("maps a durable pending-claim budget rejection before wallet and reviewer work", async () => {
    const inputs = harness();
    inputs.claimPrepare.mockRejectedValueOnce(
      new PerpIntentClaimLimitExceededError(),
    );

    await expect(inputs.service.prepare(prepareInput())).rejects.toBeInstanceOf(
      PerpIntentClaimRateLimitedError,
    );
    expect(inputs.resolve).not.toHaveBeenCalled();
    expect(inputs.review).not.toHaveBeenCalled();
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("requires an eligible current binding before reviewer work", async () => {
    const inputs = harness();
    inputs.resolve.mockResolvedValueOnce(null);

    await expect(inputs.service.prepare(prepareInput())).rejects.toBeInstanceOf(
      PerpIntentWalletBindingRequiredError,
    );
    expect(inputs.review).not.toHaveBeenCalled();
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("fails closed when the reviewer is unavailable or changes a material request field", async () => {
    const unavailable = harness();
    unavailable.review.mockRejectedValueOnce(
      new HyperliquidPerpIntentReviewerUnavailableError(),
    );
    await expect(
      unavailable.service.prepare(prepareInput()),
    ).rejects.toBeInstanceOf(PerpIntentUnavailableError);
    expect(unavailable.prepare).not.toHaveBeenCalled();

    const changed = harness();
    changed.review.mockImplementationOnce((input) =>
      Promise.resolve({
        ...reviewFor(input),
        action: {
          ...reviewFor(input).action,
          size: "999",
        },
      }),
    );
    await expect(
      changed.service.prepare(prepareInput()),
    ).rejects.toBeInstanceOf(PerpIntentUnavailableError);
    expect(changed.prepare).not.toHaveBeenCalled();
  });

  it("rejects a reviewer that swaps the pre-generated cloid", async () => {
    const inputs = harness();
    inputs.review.mockImplementationOnce((input) =>
      Promise.resolve({
        ...reviewFor(input),
        action: {
          ...reviewFor(input).action,
          client_order_id: `0x${"ff".repeat(16)}`,
        },
      }),
    );

    await expect(inputs.service.prepare(prepareInput())).rejects.toBeInstanceOf(
      PerpIntentUnavailableError,
    );
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("rejects stale review facts and a market review older than two seconds", async () => {
    const oldLimit = harness();
    oldLimit.review.mockImplementationOnce((input) =>
      Promise.resolve({
        ...reviewFor(input),
        source: {
          fetched_at: "2026-08-24T23:58:00.000Z",
          expires_at: "2026-08-25T00:00:02.000Z",
        },
      }),
    );
    await expect(
      oldLimit.service.prepare(prepareInput()),
    ).rejects.toBeInstanceOf(PerpIntentStaleError);

    const market = {
      action: "order",
      coin: "ETH",
      side: "sell",
      order_type: "market",
      size: "0.2",
      max_slippage_percent: "0.50",
      reduce_only: false,
    } as const satisfies PerpIntentRequest;
    const oldMarket = harness();
    oldMarket.review.mockImplementationOnce((input) => {
      const generated = input.items[0]?.generatedClientOrderId;
      if (generated === null || generated === undefined) {
        throw new Error("Expected generated client order ID");
      }
      return Promise.resolve({
        version: "perp_review_v1",
        provider: "hyperliquid",
        network: "testnet",
        market: "core_perps",
        dex: "",
        action: {
          ...input.request,
          final_limit_price: "3100",
          client_order_id: generated,
        },
        source: {
          fetched_at: "2026-08-24T23:59:58.999Z",
          expires_at: "2026-08-25T00:00:02.000Z",
        },
      });
    });
    await expect(
      oldMarket.service.prepare(prepareInput(market)),
    ).rejects.toBeInstanceOf(PerpIntentStaleError);

    expect(oldLimit.prepare).not.toHaveBeenCalled();
    expect(oldMarket.prepare).not.toHaveBeenCalled();
  });

  it("rechecks wallet-binding expiry after reviewer latency", async () => {
    let currentNow = now;
    const expiresDuringReview = new Date(now.getTime() + 500);
    const inputs = harness();
    inputs.resolve.mockResolvedValue({
      ...binding,
      expiresAt: expiresDuringReview.toISOString(),
    });
    inputs.review.mockImplementationOnce((input) => {
      currentNow = expiresDuringReview;
      return Promise.resolve(reviewFor(input));
    });
    const service = createPerpIntentService({
      repository: inputs.repository,
      bindingResolver: { resolve: inputs.resolve },
      reviewer: { review: inputs.review },
      now: () => currentNow,
    });

    await expect(service.prepare(prepareInput())).rejects.toBeInstanceOf(
      PerpIntentWalletBindingRequiredError,
    );
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("rejects wallet-binding rotation while the review is being prepared", async () => {
    const inputs = harness();
    inputs.resolve.mockResolvedValueOnce(binding).mockResolvedValueOnce({
      ...binding,
      accountAddress: `0x${"34".repeat(20)}`,
      bindingVersion: "8",
    });

    await expect(inputs.service.prepare(prepareInput())).rejects.toBeInstanceOf(
      PerpIntentStaleError,
    );
    expect(inputs.resolve).toHaveBeenCalledTimes(2);
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("denies prepared submission before any resolver, reviewer, or state mutation", async () => {
    const inputs = harness();

    await expect(
      inputs.service.submit({
        principal,
        intentId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PerpMutationDisabledError);

    expect(inputs.findOwned).toHaveBeenCalledWith(ownerUserId, intentId);
    expect(inputs.resolve).not.toHaveBeenCalled();
    expect(inputs.review).not.toHaveBeenCalled();
    expect(inputs.claimPrepare).not.toHaveBeenCalled();
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("does not permit a custom gate to imply a provider executor exists", async () => {
    const assertAllowed = vi.fn<PerpMutationGate["assertAllowed"]>(() =>
      Promise.resolve(),
    );
    const inputs = harness({ gate: { assertAllowed } });

    await expect(
      inputs.service.submit({
        principal,
        intentId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PerpIntentUnavailableError);
    expect(assertAllowed).toHaveBeenCalledOnce();
    expect(inputs.prepare).not.toHaveBeenCalled();
  });

  it("returns a terminal resource without invoking the mutation gate", async () => {
    const assertAllowed = vi.fn<PerpMutationGate["assertAllowed"]>(() =>
      Promise.reject(new Error("must not run")),
    );
    const inputs = harness({ gate: { assertAllowed } });
    inputs.findOwned.mockResolvedValueOnce(fixedRecord("accepted"));

    const resource = await inputs.service.submit({
      principal,
      intentId,
      signal: new AbortController().signal,
    });
    expect(resource.state).toBe("accepted");
    expect(assertAllowed).not.toHaveBeenCalled();
  });

  it("rejects both projected and just-expired prepared intents before the disabled gate", async () => {
    const assertAllowed = vi.fn<PerpMutationGate["assertAllowed"]>(() =>
      Promise.reject(new Error("must not run")),
    );
    const inputs = harness({ gate: { assertAllowed } });
    inputs.findOwned.mockResolvedValueOnce(fixedRecord("expired"));

    await expect(
      inputs.service.submit({
        principal,
        intentId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PerpIntentExpiredError);

    inputs.findOwned.mockResolvedValueOnce(
      fixedRecord("prepared", now.toISOString()),
    );

    await expect(
      inputs.service.submit({
        principal,
        intentId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PerpIntentExpiredError);
    expect(assertAllowed).not.toHaveBeenCalled();
  });

  it("uses the same not-found error for a missing or foreign owner resource", async () => {
    const inputs = harness();
    inputs.findOwned.mockResolvedValue(null);

    await expect(
      inputs.service.get({ principal, intentId }),
    ).rejects.toBeInstanceOf(PerpIntentNotFoundError);
    expect(inputs.findOwned).toHaveBeenCalledWith(ownerUserId, intentId);

    await expect(
      inputs.service.get({
        principal: {
          userId: otherOwnerUserId,
          privyUserId: "did:privy:other",
          streamUserId: "loop_90d2fcaee66045fa8629b3a5979868e6",
        },
        intentId,
      }),
    ).rejects.toBeInstanceOf(PerpIntentNotFoundError);
  });

  it("defends against a repository returning a foreign record and maps repository outages", async () => {
    const inputs = harness();
    inputs.findOwned.mockResolvedValueOnce({
      ...fixedRecord(),
      ownerUserId: otherOwnerUserId,
    });

    await expect(
      inputs.service.get({ principal, intentId }),
    ).rejects.toBeInstanceOf(PerpIntentNotFoundError);

    inputs.findOwned.mockRejectedValueOnce(
      new PerpIntentRepositoryUnavailableError(),
    );
    await expect(
      inputs.service.get({ principal, intentId }),
    ).rejects.toBeInstanceOf(PerpIntentUnavailableError);
  });

  it("rejects forged service authority before repository or provider work", async () => {
    const inputs = harness();
    const forged = {
      ...prepareInput(),
      accountAddress,
    } as Parameters<typeof inputs.service.prepare>[0];

    await expect(inputs.service.prepare(forged)).rejects.toBeInstanceOf(
      InvalidPerpIntentRequestError,
    );
    expect(inputs.claimPrepare).not.toHaveBeenCalled();
    expect(inputs.resolve).not.toHaveBeenCalled();
    expect(inputs.review).not.toHaveBeenCalled();
  });
});
