import { readFileSync } from "node:fs";

import { parse } from "lossless-json";
import { describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoQuota } from "../src/integrations/hyperliquid/info-quota.js";
import {
  HYPERLIQUID_SPOT_INFO_WEIGHT,
  HYPERLIQUID_SPOT_PRIVATE_SOURCE_TTL_MILLISECONDS,
  HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
  HyperliquidSpotInfoUnavailableError,
  type HyperliquidSpotInfoRequest,
  type HyperliquidSpotInfoTransport,
  type HyperliquidSpotMarketAllowlistEntry,
} from "../src/integrations/hyperliquid/spot-info-contract.js";
import { createHyperliquidSpotInfoReader } from "../src/integrations/hyperliquid/spot-info-reader.js";

const marketId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const accountAddress = `0x${"12".repeat(20)}`;
const baseTokenId = "0xc4bf3f870c0e9465323c0b6ed28096c2";
const bookProviderTime = 1_787_726_758_664;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const allowlist = Object.freeze([
  Object.freeze({
    marketId,
    baseTokenId,
    quoteTokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
    spotPairIndex: 0,
  }),
] satisfies readonly HyperliquidSpotMarketAllowlistEntry[]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Fixture record expected");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Fixture array expected");
  }
  return value;
}

function fixtureResponse(name: string): unknown {
  const fixture = record(
    parse(
      readFileSync(
        new URL(
          `../contracts/hyperliquid-spot/fixtures/${name}`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  return fixture["response"];
}

function metadataResponse(): unknown {
  return fixtureResponse("provider-spot-meta-purr-testnet.json");
}

function bookResponse(): unknown {
  return fixtureResponse("provider-l2-book-purr-testnet.json");
}

function balancesResponse(): unknown {
  return parse(`{
    "balances":[
      {"coin":"USDC","token":0,"total":"14.60","hold":"2.350","entryNtl":"0.0"},
      {"coin":"PURR","token":1,"total":"100000.0","hold":"0.0","entryNtl":"462520.0"}
    ]
  }`);
}

function feesResponse(): unknown {
  return parse(`{
    "dailyUserVlm":[],
    "feeSchedule":{},
    "userCrossRate":"0.00045",
    "userAddRate":"0.00015",
    "userSpotCrossRate":"0.000700",
    "userSpotAddRate":"-0.000010",
    "activeReferralDiscount":"0.0",
    "trial":null,
    "feeTrialEscrow":"0.0",
    "nextTrialAvailableTimestamp":null,
    "stakingLink":null,
    "activeStakingDiscount":{"bpsOfMaxSupply":"0.0","discount":"0.0"}
  }`);
}

interface HarnessOptions {
  readonly markets?: readonly HyperliquidSpotMarketAllowlistEntry[];
  readonly metadata?: unknown;
  readonly book?: unknown;
  readonly balances?: unknown;
  readonly fees?: unknown;
  readonly reserveWeight?: HyperliquidInfoQuota["reserveWeight"];
  readonly post?: HyperliquidSpotInfoTransport["post"];
}

function harness(options: HarnessOptions = {}) {
  let nowMilliseconds = bookProviderTime + 100;
  const events: string[] = [];
  const responses: Record<HyperliquidSpotInfoRequest["type"], unknown> = {
    spotMetaAndAssetCtxs: options.metadata ?? metadataResponse(),
    l2Book: options.book ?? bookResponse(),
    spotClearinghouseState: options.balances ?? balancesResponse(),
    userFees: options.fees ?? feesResponse(),
  };
  const reserveWeight = vi.fn<HyperliquidInfoQuota["reserveWeight"]>(
    options.reserveWeight ??
      ((cost, signal) => {
        signal.throwIfAborted();
        events.push(`reserve:${cost}`);
        return Promise.resolve();
      }),
  );
  const post = vi.fn<HyperliquidSpotInfoTransport["post"]>(
    options.post ??
      ((request, signal, callId) => {
        signal.throwIfAborted();
        events.push(`post:${request.type}:${callId}`);
        return Promise.resolve(responses[request.type]);
      }),
  );
  const reader = createHyperliquidSpotInfoReader({
    markets: options.markets ?? allowlist,
    quota: { reserveWeight },
    transport: { post },
    now: () => new Date(nowMilliseconds),
  });

  return {
    events,
    post,
    reader,
    reserveWeight,
    responses,
    setNow(value: number) {
      nowMilliseconds = value;
    },
  };
}

function mutateMetadata(mutator: (response: unknown[]) => void): unknown {
  const response = array(metadataResponse());
  mutator(response);
  return response;
}

function mutateBook(
  mutator: (response: Record<string, unknown>) => void,
): unknown {
  const response = record(bookResponse());
  mutator(response);
  return response;
}

function metadataWithUnrelatedFullProviderShape(): unknown {
  const response = array(metadataResponse());
  const meta = record(response[0]);
  array(meta["tokens"]).push(
    parse(`{
      "name":"TestPascal1 ",
      "szDecimals":2,
      "weiDecimals":8,
      "index":2,
      "tokenId":"0x11111111111111111111111111111111",
      "isCanonical":false,
      "evmContract":null,
      "fullName":null,
      "deployerTradingFeeShare":"0.0",
      "deployerLabel":"Public test deployer"
    }`),
  );
  array(meta["universe"]).push(
    parse(`{
      "tokens":[2,0],
      "name":"@1",
      "index":1,
      "isCanonical":false
    }`),
  );
  array(response[1]).push(
    parse(`{
      "prevDayPx":"0.0",
      "dayNtlVlm":"0.0",
      "markPx":"1.0",
      "midPx":null,
      "circulatingSupply":"0.0",
      "coin":"@1",
      "totalSupply":"0.0",
      "dayBaseVlm":"0.0"
    }`),
  );
  array(response[1]).push(
    parse(`{
      "prevDayPx":"0.0",
      "dayNtlVlm":"0.0",
      "markPx":"1.0",
      "midPx":null,
      "circulatingSupply":"0.0",
      "coin":"#10",
      "totalSupply":"0.0",
      "dayBaseVlm":"0.0"
    }`),
  );
  return response;
}

function firstBookLevel(
  response: Record<string, unknown>,
  side: 0 | 1,
): Record<string, unknown> {
  const levels = array(response["levels"]);
  return record(array(levels[side])[0]);
}

describe("Hyperliquid Spot Info reader", () => {
  it("maps the committed PURR/USDC fixture through all four provider identifiers", async () => {
    const testHarness = harness();

    const snapshot = await testHarness.reader.readMetadata({
      signal: new AbortController().signal,
    });

    expect(snapshot.markets).toHaveLength(1);
    expect(snapshot.markets[0]).toMatchObject({
      marketId,
      coin: "PURR/USDC",
      base: {
        tokenIndex: 1,
        tokenId: baseTokenId,
        symbol: "PURR",
        sizeDecimals: 0,
      },
      quote: {
        tokenIndex: 0,
        tokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
        symbol: "USDC",
        sizeDecimals: 8,
      },
      spotPairIndex: 0,
      exchangeOrderAsset: 10_000,
    });
    expect(snapshot.metadataVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.source).toMatchObject({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "spotMetaAndAssetCtxs",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.markets)).toBe(true);
    expect(Object.isFrozen(snapshot.markets[0]?.base)).toBe(true);
  });

  it("accepts official full-provider shapes on unrelated markets without weakening the allowlist", async () => {
    const testHarness = harness({
      metadata: metadataWithUnrelatedFullProviderShape(),
    });

    const snapshot = await testHarness.reader.readMetadata({
      signal: new AbortController().signal,
    });

    expect(snapshot.markets).toHaveLength(1);
    expect(snapshot.markets[0]).toMatchObject({
      marketId,
      coin: "PURR/USDC",
      base: { tokenId: baseTokenId, symbol: "PURR" },
      quote: {
        tokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
        symbol: "USDC",
      },
    });
  });

  it("uses the provider @pair-index coin for non-PURR Spot books", async () => {
    const indexedBaseTokenId = "0x11111111111111111111111111111111";
    const metadata = mutateMetadata((response) => {
      const meta = record(response[0]);
      const base = record(array(meta["tokens"])[1]);
      base["name"] = "OTHER";
      base["tokenId"] = indexedBaseTokenId;
      const pair = record(array(meta["universe"])[0]);
      pair["name"] = "@1";
      pair["index"] = parse("1");
      record(array(response[1])[0])["coin"] = "@1";
    });
    const book = mutateBook((response) => {
      response["coin"] = "@1";
    });
    const testHarness = harness({
      metadata,
      book,
      markets: [
        {
          marketId,
          baseTokenId: indexedBaseTokenId,
          quoteTokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
          spotPairIndex: 1,
        },
      ],
    });

    const metadataSnapshot = await testHarness.reader.readMetadata({
      signal: new AbortController().signal,
    });
    expect(metadataSnapshot.markets[0]).toMatchObject({
      coin: "@1",
      spotPairIndex: 1,
      exchangeOrderAsset: 10_001,
    });

    const snapshot = await testHarness.reader.readBook({
      marketId,
      signal: new AbortController().signal,
    });

    expect(snapshot.coin).toBe("@1");
    expect(testHarness.post).toHaveBeenLastCalledWith(
      { type: "l2Book", coin: "@1", nSigFigs: 5, mantissa: null },
      expect.any(AbortSignal),
      expect.stringMatching(uuidPattern),
    );
  });

  it("reserves quota before every real call, creates fresh UUIDs, and caches metadata for exactly 60 seconds", async () => {
    const testHarness = harness();
    const signal = new AbortController().signal;

    const first = await testHarness.reader.readMetadata({ signal });
    const cached = await testHarness.reader.readMetadata({ signal });
    expect(cached).toBe(first);
    expect(testHarness.reserveWeight).toHaveBeenCalledTimes(1);
    expect(testHarness.post).toHaveBeenCalledTimes(1);
    expect(testHarness.events[0]).toBe(
      `reserve:${HYPERLIQUID_SPOT_INFO_WEIGHT.spotMetaAndAssetCtxs}`,
    );
    expect(testHarness.events[1]).toMatch(
      /^post:spotMetaAndAssetCtxs:[0-9a-f-]+$/,
    );

    testHarness.setNow(Date.parse(first.source.expiresAt));
    const refreshed = await testHarness.reader.readMetadata({ signal });
    expect(refreshed).not.toBe(first);
    expect(refreshed.metadataVersion).toBe(first.metadataVersion);
    expect(testHarness.reserveWeight).toHaveBeenCalledTimes(2);
    expect(testHarness.post).toHaveBeenCalledTimes(2);
    const callIds = testHarness.post.mock.calls.map((call) => call[2]);
    expect(callIds).toHaveLength(2);
    expect(callIds.every((value) => uuidPattern.test(value))).toBe(true);
    expect(new Set(callIds).size).toBe(2);
    expect(testHarness.events).toEqual([
      `reserve:${HYPERLIQUID_SPOT_INFO_WEIGHT.spotMetaAndAssetCtxs}`,
      `post:spotMetaAndAssetCtxs:${callIds[0]}`,
      `reserve:${HYPERLIQUID_SPOT_INFO_WEIGHT.spotMetaAndAssetCtxs}`,
      `post:spotMetaAndAssetCtxs:${callIds[1]}`,
    ]);
  });

  it("returns one fresh, ordered, uncrossed, precision-safe book", async () => {
    const testHarness = harness();

    const snapshot = await testHarness.reader.readBook({
      marketId,
      signal: new AbortController().signal,
    });

    expect(testHarness.reserveWeight.mock.calls.map((call) => call[0])).toEqual(
      [
        HYPERLIQUID_SPOT_INFO_WEIGHT.spotMetaAndAssetCtxs,
        HYPERLIQUID_SPOT_INFO_WEIGHT.l2Book,
      ],
    );
    expect(testHarness.post.mock.calls.map((call) => call[0])).toEqual([
      { type: "spotMetaAndAssetCtxs" },
      {
        type: "l2Book",
        coin: "PURR/USDC",
        nSigFigs: 5,
        mantissa: null,
      },
    ]);
    expect(snapshot.bestBid).toEqual({
      price: "4.5795",
      size: "100000.0",
      orderCount: "1",
    });
    expect(snapshot.bestAsk.price).toBe("4.6252");
    expect(snapshot.source.providerTime).toBe(
      new Date(bookProviderTime).toISOString(),
    );
    expect(Date.parse(snapshot.source.expiresAt)).toBe(
      bookProviderTime + 2_000,
    );
    expect(Object.isFrozen(snapshot.bids)).toBe(true);
    expect(Object.isFrozen(snapshot.bestBid)).toBe(true);
  });

  it("accepts the bounded provider spread field without treating it as quote authority", async () => {
    const book = mutateBook((response) => {
      response["spread"] = "0.0457";
    });
    const testHarness = harness({ book });

    const snapshot = await testHarness.reader.readBook({
      marketId,
      signal: new AbortController().signal,
    });

    expect(snapshot.bestBid.price).toBe("4.5795");
    expect(snapshot.bestAsk.price).toBe("4.6252");
    expect(snapshot).not.toHaveProperty("spread");
  });

  it.each([
    [
      "unknown top-level metadata field",
      () =>
        mutateMetadata((response) => {
          record(response[0])["futureField"] = true;
        }),
    ],
    [
      "context count drift",
      () =>
        mutateMetadata((response) => {
          array(response[1]).pop();
        }),
    ],
    [
      "duplicate token identifier",
      () =>
        mutateMetadata((response) => {
          const tokens = array(record(response[0])["tokens"]);
          record(tokens[1])["tokenId"] = record(tokens[0])["tokenId"];
        }),
    ],
    [
      "context coin misalignment",
      () =>
        mutateMetadata((response) => {
          record(array(response[1])[0])["coin"] = "OTHER/USDC";
        }),
    ],
    [
      "non-canonical allowlisted pair",
      () =>
        mutateMetadata((response) => {
          record(array(record(response[0])["universe"])[0])["isCanonical"] =
            false;
        }),
    ],
    [
      "delisted allowlisted pair",
      () =>
        mutateMetadata((response) => {
          record(array(record(response[0])["universe"])[0])["isDelisted"] =
            true;
        }),
    ],
    [
      "unsafe allowlisted token display",
      () =>
        mutateMetadata((response) => {
          const meta = record(response[0]);
          record(array(meta["tokens"])[1])["name"] = "purr";
          record(array(meta["universe"])[0])["name"] = "@0";
          record(array(response[1])[0])["coin"] = "@0";
        }),
    ],
    [
      "unavailable midpoint on the allowlisted pair",
      () =>
        mutateMetadata((response) => {
          record(array(response[1])[0])["midPx"] = null;
        }),
    ],
    [
      "zero previous-day price on the allowlisted pair",
      () =>
        mutateMetadata((response) => {
          record(array(response[1])[0])["prevDayPx"] = "0.0";
        }),
    ],
  ])(
    "fails closed on %s without exposing provider data",
    async (_label, make) => {
      const testHarness = harness({ metadata: make() });

      let failure: unknown;
      try {
        await testHarness.reader.readMetadata({
          signal: new AbortController().signal,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
      expect(String(failure)).not.toContain(baseTokenId);
      expect(String(failure)).not.toContain("futureField");
    },
  );

  it.each([
    [
      "price with more than five significant figures",
      () =>
        mutateBook((response) => {
          firstBookLevel(response, 0)["px"] = "4.57951";
        }),
      bookProviderTime + 100,
    ],
    [
      "size finer than the base token size decimals",
      () =>
        mutateBook((response) => {
          firstBookLevel(response, 0)["sz"] = "100000.1";
        }),
      bookProviderTime + 100,
    ],
    [
      "duplicate bid level",
      () =>
        mutateBook((response) => {
          const levels = array(response["levels"]);
          const bids = array(levels[0]);
          record(bids[1])["px"] = record(bids[0])["px"];
        }),
      bookProviderTime + 100,
    ],
    [
      "crossed book",
      () =>
        mutateBook((response) => {
          firstBookLevel(response, 0)["px"] = "4.6252";
        }),
      bookProviderTime + 100,
    ],
    ["two-second-old book", bookResponse, bookProviderTime + 2_000],
    [
      "book more than one second in the future",
      bookResponse,
      bookProviderTime - 1_001,
    ],
  ])("rejects %s", async (_label, make, now) => {
    const testHarness = harness({ book: make() });
    testHarness.setNow(now);

    await expect(
      testHarness.reader.readBook({
        marketId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
  });

  it("accepts integer prices regardless of significant-figure count", async () => {
    const book = mutateBook((response) => {
      const levels = array(response["levels"]);
      const bids = array(levels[0]);
      const asks = array(levels[1]);
      ["123456", "123455", "123454"].forEach((price, index) => {
        record(bids[index])["px"] = price;
      });
      ["123457", "123458", "123459"].forEach((price, index) => {
        record(asks[index])["px"] = price;
      });
    });
    const testHarness = harness({ book });

    const snapshot = await testHarness.reader.readBook({
      marketId,
      signal: new AbortController().signal,
    });

    expect(snapshot.bestBid.price).toBe("123456");
    expect(snapshot.bestAsk.price).toBe("123457");
  });

  it("maps exact Spot balances and subtracts hold without Number arithmetic", async () => {
    const testHarness = harness();

    const snapshot = await testHarness.reader.readBalances({
      accountAddress,
      signal: new AbortController().signal,
    });

    expect(testHarness.reserveWeight.mock.calls.map((call) => call[0])).toEqual(
      [
        HYPERLIQUID_SPOT_INFO_WEIGHT.spotMetaAndAssetCtxs,
        HYPERLIQUID_SPOT_INFO_WEIGHT.spotClearinghouseState,
      ],
    );
    expect(
      snapshot.items.map(({ total, hold, available, entryNotional }) => ({
        total,
        hold,
        available,
        entryNotional,
      })),
    ).toEqual([
      {
        total: "14.60",
        hold: "2.350",
        available: "12.25",
        entryNotional: "0.0",
      },
      {
        total: "100000.0",
        hold: "0.0",
        available: "100000",
        entryNotional: "462520.0",
      },
    ]);
    expect(snapshot.items.map(({ token }) => token)).toMatchObject([
      { tokenIndex: 0, symbol: "USDC" },
      { tokenIndex: 1, symbol: "PURR" },
    ]);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0])).toBe(true);
  });

  it.each([
    [
      "hold larger than total",
      `{"balances":[{"coin":"USDC","token":0,"total":"1","hold":"1.1","entryNtl":"0"}]}`,
    ],
    [
      "duplicate token",
      `{"balances":[{"coin":"USDC","token":0,"total":"1","hold":"0","entryNtl":"0"},{"coin":"USDC","token":0,"total":"2","hold":"0","entryNtl":"0"}]}`,
    ],
    [
      "unknown token",
      `{"balances":[{"coin":"USDC","token":999,"total":"1","hold":"0","entryNtl":"0"}]}`,
    ],
    [
      "coin and token mismatch",
      `{"balances":[{"coin":"PURR","token":0,"total":"1","hold":"0","entryNtl":"0"}]}`,
    ],
    [
      "unknown balance field",
      `{"balances":[{"coin":"USDC","token":0,"total":"1","hold":"0","entryNtl":"0","wallet":"authority"}]}`,
    ],
  ])("rejects %s", async (_label, body) => {
    const testHarness = harness({ balances: parse(body) });

    await expect(
      testHarness.reader.readBalances({
        accountAddress,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
  });

  it("maps only exact account Spot rates with private freshness, shared quota, and fresh call UUIDs", async () => {
    const testHarness = harness();
    const signal = new AbortController().signal;

    const first = await testHarness.reader.readUserFees({
      accountAddress,
      signal,
    });
    testHarness.setNow(bookProviderTime + 101);
    const second = await testHarness.reader.readUserFees({
      accountAddress,
      signal,
    });

    expect(first).toEqual({
      accountSpotMakerRate: "-0.000010",
      accountSpotTakerRate: "0.000700",
      source: {
        provider: "hyperliquid",
        network: "testnet",
        dataset: "userFees",
        fetchedAt: new Date(bookProviderTime + 100).toISOString(),
        expiresAt: new Date(
          bookProviderTime +
            100 +
            HYPERLIQUID_SPOT_PRIVATE_SOURCE_TTL_MILLISECONDS,
        ).toISOString(),
      },
    });
    expect(first).not.toHaveProperty("accountAddress");
    expect(first).not.toHaveProperty("feeSchedule");
    expect(first).not.toHaveProperty("activeReferralDiscount");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.source)).toBe(true);
    expect(second.source.fetchedAt).not.toBe(first.source.fetchedAt);
    expect(testHarness.reserveWeight.mock.calls.map((call) => call[0])).toEqual(
      [
        HYPERLIQUID_SPOT_INFO_WEIGHT.userFees,
        HYPERLIQUID_SPOT_INFO_WEIGHT.userFees,
      ],
    );
    expect(testHarness.post.mock.calls.map((call) => call[0])).toEqual([
      { type: "userFees", user: accountAddress },
      { type: "userFees", user: accountAddress },
    ]);
    const callIds = testHarness.post.mock.calls.map((call) => call[2]);
    expect(callIds.every((value) => uuidPattern.test(value))).toBe(true);
    expect(new Set(callIds).size).toBe(2);
  });

  it.each([
    [
      "numeric maker rate",
      `{"userSpotAddRate":0.0004,"userSpotCrossRate":"0.0007"}`,
    ],
    [
      "scientific taker rate",
      `{"userSpotAddRate":"0.0004","userSpotCrossRate":"7e-4"}`,
    ],
    ["missing maker rate", `{"userSpotCrossRate":"0.0007"}`],
    [
      "negative taker rate",
      `{"userSpotAddRate":"0.0004","userSpotCrossRate":"-0.0007"}`,
    ],
    [
      "extra wallet authority",
      `{"userSpotAddRate":"0.0004","userSpotCrossRate":"0.0007","wallet":"authority"}`,
    ],
  ])("rejects malformed user fees: %s", async (_label, body) => {
    const testHarness = harness({ fees: parse(body) });

    await expect(
      testHarness.reader.readUserFees({
        accountAddress,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
  });

  it("rejects caller-supplied fee authority before quota or transport", async () => {
    const testHarness = harness();
    const input = {
      accountAddress,
      signal: new AbortController().signal,
      wallet: accountAddress,
    };

    await expect(
      testHarness.reader.readUserFees(
        input as Parameters<typeof testHarness.reader.readUserFees>[0],
      ),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
    expect(testHarness.reserveWeight).not.toHaveBeenCalled();
    expect(testHarness.post).not.toHaveBeenCalled();
  });

  it("never returns stale metadata when a refresh fails", async () => {
    const testHarness = harness();
    const signal = new AbortController().signal;
    const first = await testHarness.reader.readMetadata({ signal });
    testHarness.responses.spotMetaAndAssetCtxs = { raw: "shape drift" };
    testHarness.setNow(Date.parse(first.source.expiresAt));

    await expect(
      testHarness.reader.readMetadata({ signal }),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
    expect(testHarness.post).toHaveBeenCalledTimes(2);
  });

  it("does not perform HTTP when quota fails or the outer operation aborts", async () => {
    const quotaPost = vi.fn<HyperliquidSpotInfoTransport["post"]>();
    const quotaHarness = harness({
      reserveWeight: () => Promise.reject(new Error("private quota detail")),
      post: quotaPost,
    });
    await expect(
      quotaHarness.reader.readMetadata({
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
    expect(quotaPost).not.toHaveBeenCalled();

    const controller = new AbortController();
    const reason = new Error("outer read stopped");
    const abortPost = vi.fn<HyperliquidSpotInfoTransport["post"]>();
    const abortHarness = harness({
      reserveWeight: (_cost, signal) => {
        controller.abort(reason);
        signal.throwIfAborted();
        return Promise.resolve();
      },
      post: abortPost,
    });
    await expect(
      abortHarness.reader.readMetadata({ signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(abortPost).not.toHaveBeenCalled();
  });

  it("rejects a mutable authority configuration that is not stable Testnet USDC plus pair identity", () => {
    expect(() =>
      createHyperliquidSpotInfoReader({
        markets: [
          {
            marketId,
            baseTokenId,
            quoteTokenId: baseTokenId,
            spotPairIndex: 0,
          },
        ],
        quota: { reserveWeight: () => Promise.resolve() },
        transport: { post: () => Promise.resolve({}) },
      }),
    ).toThrow(TypeError);
  });
});
