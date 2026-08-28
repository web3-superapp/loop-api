import { describe, expect, it, vi } from "vitest";

import {
  digestSpotIntentRequest,
  type SpotIntentRequest,
} from "../src/features/spot/spot-intent-contract.js";
import {
  SpotIntentReviewerUnavailableError,
  type SpotIntentPrepareAuthority,
  type SpotIntentReviewer,
} from "../src/features/spot/spot-intent-prepare.js";
import {
  HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
  type HyperliquidSpotBalancesSnapshot,
  type HyperliquidSpotBookSnapshot,
  type HyperliquidSpotInfoReader,
  type HyperliquidSpotMetadataSnapshot,
  type HyperliquidSpotUserFeesSnapshot,
} from "../src/integrations/hyperliquid/spot-info-contract.js";
import {
  createHyperliquidSpotIntentReviewer,
  type HyperliquidSpotIntentReviewerPolicy,
} from "../src/integrations/hyperliquid/spot-intent-reviewer.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const marketId = "22222222-2222-4222-8222-222222222222";
const agentIdentityId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const accountAddress = `0x${"12".repeat(20)}`;
const clientOrderId = `0x${"ab".repeat(16)}`;
const baseTokenId = `0x${"23".repeat(16)}`;
const metadataVersion = "a".repeat(64);
const nowMilliseconds = 1_800_000_000_000;

const policy = Object.freeze({
  version: "spot_ioc_test_v1",
  maximumQuoteNotional: "100",
  maximumTakerFeeRate: "0.001",
});

function timestamp(offsetMilliseconds: number): string {
  return new Date(nowMilliseconds + offsetMilliseconds).toISOString();
}

function metadata(
  overrides: Partial<HyperliquidSpotMetadataSnapshot> = {},
): HyperliquidSpotMetadataSnapshot {
  return Object.freeze({
    markets: Object.freeze([
      Object.freeze({
        marketId,
        coin: "@7",
        base: Object.freeze({
          tokenIndex: 1,
          tokenId: baseTokenId,
          symbol: "BASE",
          fullName: "Base",
          sizeDecimals: 2,
          weiDecimals: 8,
        }),
        quote: Object.freeze({
          tokenIndex: 0,
          tokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
          symbol: "USDC",
          fullName: "USD Coin",
          sizeDecimals: 8,
          weiDecimals: 8,
        }),
        spotPairIndex: 7,
        exchangeOrderAsset: 10_007,
        context: Object.freeze({
          previousDayPrice: "4.9",
          dayNotionalVolume: "1000",
          markPrice: "5",
          midPrice: "4.995",
          circulatingSupply: "1000000",
          totalSupply: "1000000",
          dayBaseVolume: "200",
        }),
      }),
    ]),
    metadataVersion,
    source: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "spotMetaAndAssetCtxs",
      fetchedAt: timestamp(-500),
      expiresAt: timestamp(5_000),
    }),
    ...overrides,
  });
}

function book(
  overrides: Partial<HyperliquidSpotBookSnapshot> = {},
): HyperliquidSpotBookSnapshot {
  const bids = Object.freeze([
    Object.freeze({ price: "4.99", size: "1.00", orderCount: "2" }),
    Object.freeze({ price: "4.98", size: "3.00", orderCount: "1" }),
  ]);
  const asks = Object.freeze([
    Object.freeze({ price: "5.00", size: "2.00", orderCount: "2" }),
    Object.freeze({ price: "5.01", size: "4.00", orderCount: "1" }),
  ]);
  return Object.freeze({
    marketId,
    coin: "@7",
    bids,
    asks,
    bestBid: bids[0]!,
    bestAsk: asks[0]!,
    source: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "l2Book",
      providerTime: timestamp(-200),
      fetchedAt: timestamp(-100),
      expiresAt: timestamp(1_800),
      metadataVersion,
    }),
    ...overrides,
  });
}

function fees(
  overrides: Partial<HyperliquidSpotUserFeesSnapshot> = {},
): HyperliquidSpotUserFeesSnapshot {
  return Object.freeze({
    accountSpotMakerRate: "-0.0001",
    accountSpotTakerRate: "0.000700",
    source: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "userFees",
      fetchedAt: timestamp(-100),
      expiresAt: timestamp(1_900),
    }),
    ...overrides,
  });
}

function unusedBalances(): HyperliquidSpotBalancesSnapshot {
  return Object.freeze({
    items: Object.freeze([]),
    source: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "spotClearinghouseState",
      fetchedAt: timestamp(-100),
      expiresAt: timestamp(1_900),
      metadataVersion,
    }),
  });
}

interface HarnessOverrides {
  readonly metadata?: HyperliquidSpotMetadataSnapshot;
  readonly book?: HyperliquidSpotBookSnapshot;
  readonly fees?: HyperliquidSpotUserFeesSnapshot;
  readonly readMetadata?: HyperliquidSpotInfoReader["readMetadata"];
  readonly now?: () => Date;
  readonly policy?: HyperliquidSpotIntentReviewerPolicy;
  readonly timeoutMilliseconds?: number;
}

function harness(overrides: HarnessOverrides = {}) {
  const readMetadata = vi.fn<HyperliquidSpotInfoReader["readMetadata"]>(
    overrides.readMetadata ??
      (() => Promise.resolve(overrides.metadata ?? metadata())),
  );
  const readBook = vi.fn<HyperliquidSpotInfoReader["readBook"]>(() =>
    Promise.resolve(overrides.book ?? book()),
  );
  const readUserFees = vi.fn<HyperliquidSpotInfoReader["readUserFees"]>(() =>
    Promise.resolve(overrides.fees ?? fees()),
  );
  const readBalances = vi.fn<HyperliquidSpotInfoReader["readBalances"]>(() =>
    Promise.resolve(unusedBalances()),
  );
  const infoReader = Object.freeze({
    readMetadata,
    readBook,
    readBalances,
    readUserFees,
  });
  const reviewer = createHyperliquidSpotIntentReviewer({
    infoReader,
    policy: overrides.policy ?? policy,
    now: overrides.now ?? (() => new Date(nowMilliseconds)),
    timeoutMilliseconds: overrides.timeoutMilliseconds ?? 1_000,
  });
  return {
    infoReader,
    readBalances,
    readBook,
    readMetadata,
    readUserFees,
    reviewer,
  };
}

function authority(): SpotIntentPrepareAuthority {
  return Object.freeze({
    ownerUserId,
    privyUserId: "did:privy:spot-reviewer",
    walletId: "wallet-spot-reviewer",
    accountAddress,
    accountKind: "master",
    bindingVersion: "7",
    agentIdentityId,
    verifiedAt: timestamp(-500),
    expiresAt: timestamp(14_000),
  });
}

function buyRequest(
  overrides: Partial<SpotIntentRequest> = {},
): SpotIntentRequest {
  return Object.freeze({
    market_id: marketId,
    side: "buy",
    amount: Object.freeze({ mode: "quote", value: "25.00" }),
    max_slippage_bps: 25,
    ...overrides,
  });
}

function sellRequest(): SpotIntentRequest {
  return Object.freeze({
    market_id: marketId,
    side: "sell",
    amount: Object.freeze({ mode: "base", value: "3.000" }),
    max_slippage_bps: 25,
  });
}

function reviewInput(
  request: SpotIntentRequest,
  overrides: Partial<Parameters<SpotIntentReviewer["review"]>[0]> = {},
): Parameters<SpotIntentReviewer["review"]>[0] {
  return Object.freeze({
    ownerUserId,
    network: "testnet",
    request,
    requestSha256: digestSpotIntentRequest(request),
    authority: authority(),
    clientOrderId,
    requestId,
    signal: new AbortController().signal,
    ...overrides,
  });
}

describe("Hyperliquid Spot intent reviewer", () => {
  it("builds a strict buy+quote review from BBO, depth, and a conservative fee", async () => {
    const testHarness = harness();

    const draft = await testHarness.reviewer.review(reviewInput(buyRequest()));

    expect(draft).toMatchObject({
      providerCoin: "@7",
      baseTokenIndex: 1,
      quoteTokenIndex: 0,
      spotPairIndex: 7,
      exchangeOrderAsset: 10_007,
      metadataVersion,
      metadataSha256: metadataVersion,
      policyVersion: policy.version,
      computedBaseSize: "4.98",
      referencePrice: "5",
      worstIocLimitPrice: "5.0125",
      maximumSpendOrMinimumReceive: "25.00",
      feeRate: "0.001",
      feeEstimate: "0.025",
      factsObservedAt: timestamp(0),
      referenceSourceTime: timestamp(-200),
      expiresAt: timestamp(15_000),
    });
    expect(draft).toHaveProperty(
      "canonicalAction.orders.0",
      expect.objectContaining({
        a: 10_007,
        b: true,
        p: "5.0125",
        s: "4.98",
        r: false,
        c: clientOrderId,
      }),
    );
    expect(draft).toHaveProperty(
      "publicReview.maximum_spend_or_minimum_receive",
      {
        kind: "maximum_spend",
        asset_display_identity: "USDC",
        value: "25.00",
      },
    );
    expect(testHarness.readMetadata).toHaveBeenCalledTimes(1);
    expect(testHarness.readBook).toHaveBeenCalledTimes(1);
    expect(testHarness.readBook.mock.calls[0]?.[0].marketId).toBe(marketId);
    expect(testHarness.readBook.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(testHarness.readUserFees).toHaveBeenCalledTimes(1);
    expect(testHarness.readUserFees.mock.calls[0]?.[0].accountAddress).toBe(
      accountAddress,
    );
    expect(testHarness.readUserFees.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(testHarness.readBalances).not.toHaveBeenCalled();
  });

  it("preserves exact sell input while normalizing wire size and minimum receive", async () => {
    const testHarness = harness();

    const draft = await testHarness.reviewer.review(reviewInput(sellRequest()));

    expect(draft).toMatchObject({
      computedBaseSize: "3",
      referencePrice: "4.99",
      worstIocLimitPrice: "4.9776",
      maximumSpendOrMinimumReceive: "14.91783",
      feeRate: "0.001",
      feeEstimate: "0.01497",
    });
    expect(draft).toHaveProperty("publicReview.amount_value", "3.000");
    expect(draft).toHaveProperty(
      "publicReview.maximum_spend_or_minimum_receive.kind",
      "minimum_receive",
    );
    expect(draft).toHaveProperty("canonicalAction.orders.0.b", false);
  });

  it("rejects malformed policy input before any provider read", async () => {
    const testHarness = harness();
    const request = buyRequest({ max_slippage_bps: 101 });

    await expect(
      testHarness.reviewer.review(reviewInput(request)),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);

    expect(testHarness.readMetadata).not.toHaveBeenCalled();
    expect(testHarness.readBook).not.toHaveBeenCalled();
    expect(testHarness.readUserFees).not.toHaveBeenCalled();
  });

  it("enforces the explicit maximum quote risk before a buy provider read", async () => {
    const testHarness = harness();
    const request = buyRequest({
      amount: Object.freeze({ mode: "quote", value: "100.01" }),
    });

    await expect(
      testHarness.reviewer.review(reviewInput(request)),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);

    expect(testHarness.readMetadata).not.toHaveBeenCalled();
  });

  it("rejects a request digest or owner mismatch before any provider read", async () => {
    const testHarness = harness();
    const request = buyRequest();

    await expect(
      testHarness.reviewer.review(
        reviewInput(request, { requestSha256: "f".repeat(64) }),
      ),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
    await expect(
      testHarness.reviewer.review(
        reviewInput(request, {
          ownerUserId: "55555555-5555-4555-8555-555555555555",
        }),
      ),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);

    expect(testHarness.readMetadata).not.toHaveBeenCalled();
  });

  it("rejects a sell amount that exceeds lot precision before book and fee reads", async () => {
    const testHarness = harness();
    const request = Object.freeze({
      market_id: marketId,
      side: "sell" as const,
      amount: Object.freeze({ mode: "base" as const, value: "3.001" }),
      max_slippage_bps: 25,
    });

    await expect(
      testHarness.reviewer.review(reviewInput(request)),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);

    expect(testHarness.readMetadata).toHaveBeenCalledTimes(1);
    expect(testHarness.readBook).not.toHaveBeenCalled();
    expect(testHarness.readUserFees).not.toHaveBeenCalled();
  });

  it("rejects insufficient bounded depth instead of shrinking the order", async () => {
    const sparseBook = book();
    const asks = Object.freeze([
      Object.freeze({ price: "5", size: "2", orderCount: "1" }),
      Object.freeze({ price: "5.01", size: "2.97", orderCount: "1" }),
    ]);
    const testHarness = harness({
      book: Object.freeze({
        ...sparseBook,
        asks,
        bestAsk: asks[0]!,
      }),
    });

    await expect(
      testHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
  });

  it("does not count sell depth one price unit beyond the IOC limit", async () => {
    const shallowBook = book();
    const bids = Object.freeze([
      Object.freeze({ price: "4.99", size: "2.99", orderCount: "2" }),
      Object.freeze({ price: "4.9775", size: "5", orderCount: "1" }),
    ]);
    const testHarness = harness({
      book: Object.freeze({
        ...shallowBook,
        bids,
        bestBid: bids[0]!,
      }),
    });

    await expect(
      testHarness.reviewer.review(reviewInput(sellRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
  });

  it("rejects a sell whose BBO notional exceeds the explicit risk cap", async () => {
    const deepBook = book();
    const bids = Object.freeze([
      Object.freeze({ price: "4.99", size: "30", orderCount: "2" }),
      Object.freeze({ price: "4.98", size: "30", orderCount: "1" }),
    ]);
    const testHarness = harness({
      book: Object.freeze({
        ...deepBook,
        bids,
        bestBid: bids[0]!,
      }),
    });
    const request = Object.freeze({
      market_id: marketId,
      side: "sell" as const,
      amount: Object.freeze({ mode: "base" as const, value: "21" }),
      max_slippage_bps: 25,
    });

    await expect(
      testHarness.reviewer.review(reviewInput(request)),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
  });

  it("accepts exactly 10 quote notional and rejects the next lower lot", async () => {
    const zeroFees = fees({ accountSpotTakerRate: "0" });
    const testHarness = harness({
      fees: zeroFees,
      policy: Object.freeze({
        ...policy,
        version: "spot_ioc_zero_fee_test_v1",
        maximumTakerFeeRate: "0",
      }),
    });
    const exactRequest = buyRequest({
      amount: Object.freeze({ mode: "quote", value: "10" }),
      max_slippage_bps: 0,
    });

    const exact = await testHarness.reviewer.review(reviewInput(exactRequest));
    expect(exact).toMatchObject({
      computedBaseSize: "2",
      worstIocLimitPrice: "5",
      feeEstimate: "0",
    });

    const belowRequest = buyRequest({
      amount: Object.freeze({ mode: "quote", value: "9.99" }),
      max_slippage_bps: 0,
    });
    await expect(
      testHarness.reviewer.review(reviewInput(belowRequest)),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
  });

  it("fails closed for stale or metadata-inconsistent evidence", async () => {
    const staleFees = fees({
      source: Object.freeze({
        ...fees().source,
        expiresAt: timestamp(0),
      }),
    });
    const staleHarness = harness({ fees: staleFees });
    await expect(
      staleHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);

    const inconsistentBook = book({
      source: Object.freeze({
        ...book().source,
        metadataVersion: "b".repeat(64),
      }),
    });
    const inconsistentHarness = harness({ book: inconsistentBook });
    await expect(
      inconsistentHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
  });

  it("locks the known Testnet USDC precision before atomic fee rounding", async () => {
    const original = metadata();
    const originalMarket = original.markets[0]!;
    const testHarness = harness({
      metadata: Object.freeze({
        ...original,
        markets: Object.freeze([
          Object.freeze({
            ...originalMarket,
            quote: Object.freeze({
              ...originalMarket.quote,
              weiDecimals: 18,
            }),
          }),
        ]),
      }),
    });

    await expect(
      testHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
    expect(testHarness.readBook).not.toHaveBeenCalled();
    expect(testHarness.readUserFees).not.toHaveBeenCalled();
  });

  it("rejects shape drift that bypasses the strict Info reader type", async () => {
    const invalidBook = book();
    const asks = Object.freeze([
      Object.freeze({ price: "5.00001", size: "2", orderCount: "1" }),
      Object.freeze({ price: "5.01", size: "4", orderCount: "1" }),
    ]);
    const testHarness = harness({
      book: Object.freeze({
        ...invalidBook,
        asks,
        bestAsk: asks[0]!,
      }),
    });

    await expect(
      testHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
  });

  it("rejects an anomalous taker rate above the explicit reviewer policy", async () => {
    const testHarness = harness({
      fees: fees({ accountSpotTakerRate: "0.0010001" }),
    });

    await expect(
      testHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
  });

  it("rounds the reviewed fee ceiling up to the locked USDC atomic unit", async () => {
    const testHarness = harness({
      fees: fees({ accountSpotTakerRate: "0.000000002" }),
      policy: Object.freeze({
        ...policy,
        version: "spot_ioc_atomic_fee_test_v1",
        maximumTakerFeeRate: "0.000000003",
      }),
    });

    const draft = await testHarness.reviewer.review(reviewInput(buyRequest()));

    expect(draft).toMatchObject({
      feeRate: "0.000000003",
      feeEstimate: "0.00000008",
    });
  });

  it("preserves an external abort and sanitizes an unknown dependency error", async () => {
    const reason = new Error("caller stopped");
    const controller = new AbortController();
    controller.abort(reason);
    const abortedHarness = harness();
    await expect(
      abortedHarness.reviewer.review(
        reviewInput(buyRequest(), { signal: controller.signal }),
      ),
    ).rejects.toBe(reason);

    const failedHarness = harness({
      readMetadata: () => Promise.reject(new Error("provider secret detail")),
    });
    await expect(
      failedHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toEqual(new SpotIntentReviewerUnavailableError());
  });

  it("maps its bounded dependency deadline to an unavailable review", async () => {
    const testHarness = harness({
      timeoutMilliseconds: 10,
      readMetadata: () => new Promise(() => undefined),
    });

    await expect(
      testHarness.reviewer.review(reviewInput(buyRequest())),
    ).rejects.toBeInstanceOf(SpotIntentReviewerUnavailableError);
    expect(testHarness.readBook).not.toHaveBeenCalled();
    expect(testHarness.readUserFees).not.toHaveBeenCalled();
  });

  it("rejects invalid adapter caps at construction", () => {
    const testHarness = harness();

    expect(() =>
      createHyperliquidSpotIntentReviewer({
        infoReader: testHarness.infoReader,
        policy: { ...policy, maximumTakerFeeRate: "1" },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createHyperliquidSpotIntentReviewer({
        infoReader: testHarness.infoReader,
        policy,
        timeoutMilliseconds: 15_000,
      }),
    ).toThrow(TypeError);
  });
});
