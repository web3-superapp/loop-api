import { describe, expect, it, vi } from "vitest";

import type { MarketConfig } from "../src/config.js";
import type {
  MarketFactCacheRecord,
  MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import { createMarketFactService } from "../src/features/market/market-fact-service.js";
import type {
  MarketPairsProvider,
  TokenPairsSnapshot,
} from "../src/integrations/market/market-data-provider.js";
import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import {
  createUnavailableMiningRepository,
  type MiningFormulaRecord,
  type MiningRepository,
  type WriteIncompleteMiningSnapshotInput,
  type WriteMiningSnapshotInput,
} from "../src/features/mining/mining-repository.js";
import { calls } from "./s7-route-fakes.js";
import {
  createMiningSnapshotWorker,
  type MiningPriceReader,
} from "../src/mining-snapshot-worker.js";

const loopAssetId = "eip155:56:0x0000000000000000000000000000000000000001";
const communityAssetId = "eip155:56:0x0000000000000000000000000000000000000002";
const alice = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const hash = `0x${"b".repeat(64)}`;

/** TEST-ONLY formula fixture; no approved formula exists in the product. */
const approvedTestFormula: MiningFormulaRecord = {
  configVersion: "miningFormulaTestOnly",
  formula: {
    kind: "holding_times_reference_price_times_weight",
    expressionKey: "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
    dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
    assetWeights: { [loopAssetId]: "1" },
    referralBoost: { status: "pending_approval" },
  },
  weightRange: {
    loop: { status: "approved", descriptionKey: "k" },
    community: { status: "pending_approval", descriptionKey: "k" },
    reviewFactorKeys: [],
  },
  priceGuardRules: [],
  status: "approved",
  effectiveAt: "2026-09-08T00:00:00.000Z",
  approvedAt: "2026-09-08T00:00:00.000Z",
  createdAt: "2026-09-08T00:00:00.000Z",
};

const loopAsset: AssetRecord = Object.freeze({
  assetId: loopAssetId,
  chainId: bscChainId,
  address: "0x0000000000000000000000000000000000000001",
  symbol: "LOOP",
  name: "LOOP",
  decimals: 18,
  status: "verified",
  sourceKind: "chain_call",
  sourceBlockNumber: "1",
  sourceVerifiedAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
});

function repositoryFake(
  overrides: Partial<MiningRepository> = {},
): MiningRepository {
  return {
    ...createUnavailableMiningRepository(),
    getApprovedFormula: vi.fn(() => Promise.resolve(null)),
    listBalanceInputs: vi.fn(() =>
      Promise.resolve([
        {
          ownerUserId: alice,
          walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
          assetId: loopAssetId,
          decimals: 18,
          rawValue: "4000000000000000000",
          blockNumber: "500",
          blockHash: hash,
          source: "chain" as const,
        },
      ]),
    ),
    listCommunityWeightInputs: vi.fn((configVersion: string) =>
      Promise.resolve(
        configVersion === approvedTestFormula.configVersion
          ? []
          : [
              {
                communityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                assetId: communityAssetId,
                weight: "0.9",
                status: "approved" as const,
              },
            ],
      ),
    ),
    writeSnapshot: vi.fn((input: WriteMiningSnapshotInput) =>
      Promise.resolve({
        snapshotId: input.snapshotId,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        formulaVersion: input.formulaVersion,
        priceVersion: input.priceVersion,
        totalPower: input.totalPower,
        accountCount: 1,
        computedAt: "2026-09-08T00:05:00.000Z",
        holdingsSource: input.holdingsSource,
      }),
    ),
    writeIncompleteSnapshot: vi.fn(
      (input: WriteIncompleteMiningSnapshotInput) =>
        Promise.resolve({
          snapshotId: input.snapshotId,
          status: "incomplete" as const,
          formulaVersion: input.formulaVersion,
          blockNumber: input.blockNumber,
          computedAt: "2026-09-08T00:05:00.000Z",
          unreadInputs: input.unreadInputs,
          invalidatedAt: null,
          invalidationReason: null,
        }),
    ),
    ...overrides,
  };
}

function priceReader(
  quality: "fresh" | "stale",
  proxyAsset: string | null = null,
  pairFound = true,
): MiningPriceReader {
  return {
    readAssetPrice: vi.fn(() =>
      Promise.resolve({
        fact: {
          value: {
            tokenAddress: "0x0000000000000000000000000000000000000001",
            pairs: [],
          },
          source: "dexscreener" as const,
          fetchedAt: "2026-09-08T00:04:00.000Z",
          ttlSeconds: 30,
          quality,
          reasonCode: null,
          rawDigest: null,
        },
        // `pair` is null when the fresh fact lists no pair with the asset
        // as base (the 2026-09-20 USDT case).
        pair: !pairFound
          ? null
          : {
              pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
              dexId: "pancakeswap",
              labels: [],
              baseTokenAddress: "0x0000000000000000000000000000000000000001",
              baseTokenSymbol: "LOOP",
              quoteTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
              quoteTokenSymbol: "USDT",
              priceUsd: "0.5",
              priceNative: null,
              liquidityUsd: "1000",
              volumeH24: null,
              priceChangeH24: null,
              fdv: null,
              marketCap: null,
              buysH24: null,
              sellsH24: null,
              pairCreatedAt: null,
            },
        proxyAsset,
      }),
    ),
    readPair: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

const deepPairAddress = "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae";
const shallowPairAddress = "0x172fcd41e0913e95784454622d1c3724f546f849";

/**
 * A pair in which the weighted asset is the *quote* token: `priceUsd` is the
 * base token in USD, `priceNative` the base token in asset units, so the
 * asset is `priceUsd / priceNative` (Decision 0059).
 */
function quotePair(priceUsd: string, liquidityUsd: string) {
  return {
    pairAddress: liquidityUsd === "1000" ? deepPairAddress : shallowPairAddress,
    dexId: "pancakeswap",
    labels: [] as string[],
    baseTokenAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    baseTokenSymbol: "WBNB",
    quoteTokenAddress: "0x0000000000000000000000000000000000000001",
    quoteTokenSymbol: "LOOP",
    priceUsd,
    priceNative: "1",
    liquidityUsd,
    volumeH24: null,
    priceChangeH24: null,
    fdv: null,
    marketCap: null,
    buysH24: null,
    sellsH24: null,
    pairCreatedAt: null,
  };
}

describe("mining-snapshot lane", () => {
  it("is idle with MINING_FORMULA_BASELINE_PENDING and reads nothing else without an approved formula", async () => {
    const repository = repositoryFake();
    const prices = priceReader("fresh");
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices,
    });
    expect(worker.lane).toBe("mining-snapshot");
    const result = await worker.runOnce();
    expect(result).toEqual({
      kind: "idle",
      holdingsSource: null,
      reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      snapshotId: null,
      powerRowCount: 0,
      skipped: [],
      unread: [],
    });
    expect(calls(repository, "listBalanceInputs")).not.toHaveBeenCalled();
    expect(calls(prices, "readAssetPrice")).not.toHaveBeenCalled();
    expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
  });

  it("computes and writes a snapshot under an approved formula with fresh prices", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: priceReader("fresh"),
      createUuid: () => "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({
      kind: "snapshotted",
      snapshotId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      powerRowCount: 1,
    });
    expect(calls(repository, "writeSnapshot")).toHaveBeenCalledWith(
      expect.objectContaining({
        formulaVersion: "miningFormulaTestOnly",
        blockNumber: "500",
        blockHash: hash,
        priceVersion: "dexscreener:2026-09-08T00:04:00.000Z",
        totalPower: "2",
        powers: [
          expect.objectContaining({
            ownerUserId: alice,
            assetId: loopAssetId,
            power: "2",
          }),
        ],
      }),
    );
  });

  it("asks for community weights of the approved formula version only and never weights an asset the formula does not list", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
      listBalanceInputs: vi.fn(() =>
        Promise.resolve([
          {
            ownerUserId: alice,
            walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
            assetId: communityAssetId,
            decimals: 18,
            rawValue: "1000000000000000000",
            blockNumber: "500",
            blockHash: hash,
            source: "chain" as const,
          },
        ]),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([])) },
      prices: priceReader("fresh"),
    });
    const result = await worker.runOnce();
    expect(calls(repository, "listCommunityWeightInputs")).toHaveBeenCalledWith(
      "miningFormulaTestOnly",
    );
    expect(result.kind).toBe("idle");
    // The community asset is not in the formula's assetWeights, so no price
    // is even read for it and it is skipped as unweighted (Decision 0043).
    expect(result.skipped).toEqual([
      {
        assetId: communityAssetId,
        reasonCode: "MINING_ASSET_WEIGHT_NOT_CONFIGURED",
      },
    ]);
    expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
  });

  it("records an incomplete attempt and publishes nothing when a held asset's price is stale, an undeclared proxy, or has no base pair (Decision 0057)", async () => {
    for (const [quality, proxy, pairFound, reasonCode] of [
      ["stale", null, true, "MINING_PRICE_NOT_FRESH"],
      [
        "fresh",
        "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        true,
        "MINING_PRICE_PROXY_NOT_DECLARED",
      ],
      ["fresh", null, false, "MINING_PRICE_PAIR_NOT_FOUND"],
    ] as const) {
      const repository = repositoryFake({
        getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
      });
      const results: unknown[] = [];
      const worker = createMiningSnapshotWorker({
        repository,
        registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
        prices: priceReader(quality, proxy, pairFound),
        createUuid: () => "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
        onRunResult: (result) => results.push(result),
      });
      const result = await worker.runOnce();
      expect(result).toEqual({
        kind: "incomplete",
        holdingsSource: null,
        reasonCode: "MINING_SNAPSHOT_INCOMPLETE",
        snapshotId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
        powerRowCount: 0,
        skipped: [],
        unread: [{ assetId: loopAssetId, reasonCode }],
      });
      expect(results).toEqual([result]);
      expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
      expect(calls(repository, "writeIncompleteSnapshot")).toHaveBeenCalledWith(
        {
          snapshotId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
          blockNumber: "500",
          blockHash: hash,
          formulaVersion: "miningFormulaTestOnly",
          priceVersion: null,
          unreadInputs: [{ assetId: loopAssetId, reasonCode }],
        },
      );
    }
  });

  it("recovers on the next tick once the price is readable again: a complete snapshot follows an incomplete attempt (Decision 0057)", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
    });
    let pairFound = false;
    const prices: MiningPriceReader = {
      readAssetPrice: vi.fn(
        (
          asset: Pick<AssetRecord, "address" | "status">,
          options: { readonly requireFresh: true },
        ) =>
          priceReader("fresh", null, pairFound).readAssetPrice(asset, options),
      ),
      readPair: vi.fn(() => Promise.reject(new Error("not used"))),
    };
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices,
    });
    expect((await worker.runOnce()).kind).toBe("incomplete");
    pairFound = true;
    const recovered = await worker.runOnce();
    expect(recovered).toMatchObject({
      kind: "snapshotted",
      powerRowCount: 1,
      unread: [],
    });
    expect(calls(repository, "writeIncompleteSnapshot")).toHaveBeenCalledTimes(
      1,
    );
    expect(calls(repository, "writeSnapshot")).toHaveBeenCalledTimes(1);
  });

  it("records no attempt when only a zero balance lacks a price: nothing was held, so nothing was unread (Decision 0057)", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
      listBalanceInputs: vi.fn(() =>
        Promise.resolve([
          {
            ownerUserId: alice,
            walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
            assetId: loopAssetId,
            decimals: 18,
            rawValue: "0",
            blockNumber: "500",
            blockHash: hash,
            source: "chain" as const,
          },
        ]),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: priceReader("fresh", null, false),
    });
    const result = await worker.runOnce();
    expect(result.kind).toBe("idle");
    expect(result.reasonCode).toBe("MINING_PRICE_PAIR_NOT_FOUND");
    expect(calls(repository, "writeIncompleteSnapshot")).not.toHaveBeenCalled();
    expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
  });

  it("writes a proxied row when the version declares the proxy and the proxy's own observation is fresh (Decision 0044)", async () => {
    const wbnb = "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() =>
        Promise.resolve({
          ...approvedTestFormula,
          formula: {
            ...approvedTestFormula.formula,
            priceProxies: { [loopAssetId]: wbnb },
          },
        }),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: priceReader("fresh", wbnb),
    });
    const result = await worker.runOnce();
    expect(result.kind).toBe("snapshotted");
    expect(calls(repository, "writeSnapshot")).toHaveBeenCalledWith(
      expect.objectContaining({
        powers: [
          expect.objectContaining({
            assetId: loopAssetId,
            referencePriceQuality: "proxied",
            referencePriceProxyAssetId: wbnb,
            power: "2",
          }),
        ],
      }),
    );
  });

  it("derives a declared stable price from the quote side of the deepest pair and carries it as derived (Decision 0059)", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() =>
        Promise.resolve({
          ...approvedTestFormula,
          formula: {
            ...approvedTestFormula.formula,
            referencePricing: {
              [loopAssetId]: {
                kind: "stable" as const,
                pegUsd: "1",
                guardBps: 200,
              },
            },
          },
        }),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      // No pair has the asset as base, exactly as DexScreener answered for
      // BSC USDT from 2026-09-18; one pair has it as the quote token.
      prices: {
        readAssetPrice: vi.fn(() =>
          Promise.resolve({
            fact: {
              value: {
                tokenAddress: loopAsset.address as string,
                pairs: [quotePair("0.5", "10"), quotePair("1", "1000")],
              },
              source: "dexscreener" as const,
              fetchedAt: "2026-09-08T00:04:00.000Z",
              ttlSeconds: 30,
              quality: "fresh" as const,
              reasonCode: null,
              rawDigest: null,
            },
            pair: null,
            proxyAsset: null,
          }),
        ),
        readPair: vi.fn(() => Promise.reject(new Error("not used"))),
      },
    });
    const result = await worker.runOnce();
    expect(result.kind).toBe("snapshotted");
    expect(calls(repository, "writeSnapshot")).toHaveBeenCalledWith(
      expect.objectContaining({
        powers: [
          expect.objectContaining({
            assetId: loopAssetId,
            referencePriceUsd: "1",
            referencePriceQuality: "derived",
            referencePriceProxyAssetId: null,
            referencePricePairAddress: deepPairAddress,
            power: "4",
          }),
        ],
      }),
    );
  });

  it("records the holding as unread when the derived price leaves the declared band (Decisions 0057 and 0059)", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() =>
        Promise.resolve({
          ...approvedTestFormula,
          formula: {
            ...approvedTestFormula.formula,
            referencePricing: {
              [loopAssetId]: {
                kind: "stable" as const,
                pegUsd: "1",
                guardBps: 200,
              },
            },
          },
        }),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: {
        readAssetPrice: vi.fn(() =>
          Promise.resolve({
            fact: {
              value: {
                tokenAddress: loopAsset.address as string,
                pairs: [quotePair("0.5", "1000")],
              },
              source: "dexscreener" as const,
              fetchedAt: "2026-09-08T00:04:00.000Z",
              ttlSeconds: 30,
              quality: "fresh" as const,
              reasonCode: null,
              rawDigest: null,
            },
            pair: null,
            proxyAsset: null,
          }),
        ),
        readPair: vi.fn(() => Promise.reject(new Error("not used"))),
      },
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({
      kind: "incomplete",
      unread: [
        { assetId: loopAssetId, reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" },
      ],
    });
    expect(calls(repository, "writeSnapshot")).not.toHaveBeenCalled();
  });

  it("reads a declared pair by its own address and never falls back to the token pair list (Decision 0059)", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() =>
        Promise.resolve({
          ...approvedTestFormula,
          formula: {
            ...approvedTestFormula.formula,
            referencePricing: {
              [loopAssetId]: {
                kind: "pair" as const,
                pairAddress: deepPairAddress,
              },
            },
          },
        }),
      ),
    });
    const readAssetPrice = vi.fn(() =>
      Promise.reject(new Error("the declared pair is authoritative")),
    );
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: {
        readAssetPrice,
        readPair: vi.fn((pairAddress: string) =>
          Promise.resolve({
            value: {
              pairAddress,
              pair: {
                ...quotePair("1", "1000"),
                baseTokenAddress: loopAsset.address as string,
                baseTokenSymbol: "LOOP",
                quoteTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
                quoteTokenSymbol: "USDT",
                priceUsd: "0.25",
              },
            },
            source: "dexscreener" as const,
            fetchedAt: "2026-09-08T00:04:00.000Z",
            ttlSeconds: 30,
            quality: "fresh" as const,
            reasonCode: null,
            rawDigest: null,
          }),
        ),
      },
    });
    const result = await worker.runOnce();
    expect(result.kind).toBe("snapshotted");
    expect(readAssetPrice).not.toHaveBeenCalled();
    expect(calls(repository, "writeSnapshot")).toHaveBeenCalledWith(
      expect.objectContaining({
        powers: [
          expect.objectContaining({
            assetId: loopAssetId,
            referencePriceUsd: "0.25",
            // The asset is the declared pair's base token: nothing was
            // inverted, so nothing is derived.
            referencePriceQuality: "fresh",
            referencePricePairAddress: deepPairAddress,
            power: "1",
          }),
        ],
      }),
    );
  });

  it("refetches an expired price fact and takes the freshly observed derived price (Decisions 0059 and 0060)", async () => {
    // The lane asks for a fresh fact; the cache row is older than its TTL,
    // so the fact service must reach the Provider again. The cached value
    // would derive 0.9 — outside the declared ±2 % band — so a snapshot can
    // only complete if the *refetched* observation is the one used.
    const marketConfig: MarketConfig = Object.freeze({
      dexscreener: {
        enabled: true,
        budgetApiPerMinute: 120,
        budgetWorkerPerMinute: 120,
      },
      geckoterminal: { enabled: false, rateLimitPerMinute: 30 },
      goplus: null,
      priceTtlSeconds: 30,
      securityTtlSeconds: 600,
      candlesTtlSeconds: 60,
      staleGraceSeconds: 900,
      unlistedPriceTtlSeconds: 60,
      unlistedMetadataTtlSeconds: 3_600,
    });
    const tokenAddress = loopAsset.address as string;
    const pairsFor = (priceUsd: string): TokenPairsSnapshot => ({
      tokenAddress,
      pairs: [{ ...quotePair(priceUsd, "1000") }],
    });
    const rows = new Map<string, MarketFactCacheRecord>();
    rows.set(`token:${tokenAddress}`, {
      subjectKey: `token:${tokenAddress}`,
      factKind: "token_pairs",
      source: "dexscreener",
      // Observed ten minutes ago: past the 30 s TTL, inside the grace window.
      fetchedAt: "2026-09-21T00:00:00.000Z",
      ttlSeconds: 30,
      rawDigest: "a".repeat(64),
      value: pairsFor("0.9") as unknown as Record<string, unknown>,
    });
    const cache: MarketFactCacheRepository = {
      get: vi.fn((subjectKey: string) =>
        Promise.resolve(rows.get(subjectKey) ?? null),
      ),
      put: vi.fn((record: MarketFactCacheRecord) => {
        rows.set(record.subjectKey, record);
        return Promise.resolve(record);
      }),
      findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
    };
    const readTokenPairs = vi.fn(() =>
      Promise.resolve({
        value: pairsFor("1"),
        source: "dexscreener" as const,
        fetchedAt: "2026-09-21T00:10:00.000Z",
        rawDigest: "b".repeat(64),
      }),
    );
    const provider: MarketPairsProvider = {
      source: "dexscreener",
      readTokenPairs,
      readTokenPairsBatch: vi.fn(() => Promise.reject(new Error("not used"))),
      readPair: vi.fn(() => Promise.reject(new Error("not used"))),
    };
    const prices = createMarketFactService({
      config: marketConfig,
      cache,
      pairsProvider: provider,
      securityProvider: null,
      candlesProvider: null,
      tokenLookupProvider: null,
      now: () => new Date("2026-09-21T00:10:00.000Z"),
    });
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() =>
        Promise.resolve({
          ...approvedTestFormula,
          formula: {
            ...approvedTestFormula.formula,
            referencePricing: {
              [loopAssetId]: {
                kind: "stable" as const,
                pegUsd: "1",
                guardBps: 200,
              },
            },
          },
        }),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices,
    });
    const result = await worker.runOnce();
    expect(result.kind).toBe("snapshotted");
    // The expired row was not served: the Provider was asked again.
    expect(readTokenPairs).toHaveBeenCalledTimes(1);
    expect(calls(repository, "writeSnapshot")).toHaveBeenCalledWith(
      expect.objectContaining({
        // Freshness and the price version are the observation just made.
        priceVersion: "dexscreener:2026-09-21T00:10:00.000Z",
        powers: [
          expect.objectContaining({
            assetId: loopAssetId,
            referencePriceUsd: "1",
            referencePriceQuality: "derived",
            referencePricePairAddress: deepPairAddress,
            power: "4",
          }),
        ],
      }),
    );
    // The refetched fact replaced the expired row in the cache.
    expect(rows.get(`token:${tokenAddress}`)?.fetchedAt).toBe(
      "2026-09-21T00:10:00.000Z",
    );
  });

  it("stops the loop on abort and reports infrastructure backoff on a failure", async () => {
    const backoffs: unknown[] = [];
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() =>
        Promise.reject(new Error("database unavailable")),
      ),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([])) },
      prices: priceReader("fresh"),
      onInfrastructureBackoff: (event) => backoffs.push(event),
    });
    const controller = new AbortController();
    const running = worker.run(controller.signal);
    await vi.waitFor(() => expect(backoffs.length).toBeGreaterThan(0));
    controller.abort();
    await running;
    expect(backoffs[0]).toMatchObject({
      reasonCode: "mining_snapshot_unavailable",
      consecutiveFailureCount: 1,
      retryDelayMs: 1_000,
    });
  });

  it("excludes the Development seed's holdings unless the lane was told to include them (Decision 0061)", async () => {
    const repository = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
    });
    const worker = createMiningSnapshotWorker({
      repository,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: priceReader("fresh"),
    });
    await worker.runOnce();
    expect(calls(repository, "listBalanceInputs")).toHaveBeenCalledWith({
      includeMockSeedHoldings: false,
    });

    const opted = repositoryFake({
      getApprovedFormula: vi.fn(() => Promise.resolve(approvedTestFormula)),
      listBalanceInputs: vi.fn(() =>
        Promise.resolve([
          {
            ownerUserId: alice,
            walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
            assetId: loopAssetId,
            decimals: 18,
            rawValue: "4000000000000000000",
            blockNumber: "500",
            blockHash: hash,
            source: "mock_seed" as const,
          },
        ]),
      ),
    });
    const optedWorker = createMiningSnapshotWorker({
      repository: opted,
      registry: { listAssets: vi.fn(() => Promise.resolve([loopAsset])) },
      prices: priceReader("fresh"),
      includeMockSeedHoldings: true,
    });
    const result = await optedWorker.runOnce();
    expect(calls(opted, "listBalanceInputs")).toHaveBeenCalledWith({
      includeMockSeedHoldings: true,
    });
    expect(result).toMatchObject({
      kind: "snapshotted",
      holdingsSource: "mock_seed",
    });
    expect(calls(opted, "writeSnapshot")).toHaveBeenCalledWith(
      expect.objectContaining({ holdingsSource: "mock_seed" }),
    );
  });
});
