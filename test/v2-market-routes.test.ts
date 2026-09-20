import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import type {
  BscIndexerRepository,
  IndexedPoolEventRecord,
  SwapCandleBucket,
} from "../src/database/bsc-indexer-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
  PoolRecord,
} from "../src/database/chain-registry-repository.js";
import {
  createUnavailableControlPlaneRepository,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import type {
  MarketFactCacheRecord,
  MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type { WatchlistV2Repository } from "../src/database/watchlist-v2-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { BscReadClient } from "../src/integrations/bsc/rpc-client.js";
import {
  MarketProviderError,
  type CandlesProvider,
  type MarketPairsProvider,
  type SecurityFactsProvider,
  type TokenLookupProvider,
  type TokenLookupSnapshot,
  type TokenPairsSnapshot,
} from "../src/integrations/market/market-data-provider.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const wbnbAssetId = `eip155:56:${wbnb}`;
const usdtAssetId = `eip155:56:${usdt}`;
const poolAddress = "0x36696169c63e42cd08ce11f5deebbcebae652050";
const poolId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const headNumber = 120_640_710n;
const headHash = `0x${"1".repeat(64)}`;
const observedAt = "2026-09-08T00:00:00.000Z";
/** Provider fetch time; inside the 30s price TTL for the cache assertion. */
const fetchedAt = new Date().toISOString();
const q96 = 2n ** 96n;
/** BSC WETH: not in the test registry, the address a user pastes into chat. */
const weth = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const wethAssetId = `eip155:56:${weth}`;
const wethPool = "0xd0e226f674bbf064f54ab47f42473ff80db98cba";
const quotaSecret = "unlisted-lookup-quota-secret-0123456789abcdef";

function lookupSnapshot(): TokenLookupSnapshot {
  return {
    tokenAddress: weth,
    symbol: "ETH",
    name: "Ethereum Token",
    decimals: 18,
    priceUsd: "2575.1402462078",
    fdvUsd: "1300404347.01321",
    marketCapUsd: "1300514252.30807",
    volumeH24Usd: "25016115.5564862",
    topPools: [
      {
        poolAddress: wethPool,
        dexId: "pancakeswap-v3-bsc",
        name: "ETH / WBNB 0.05%",
        baseTokenAddress: weth,
        quoteTokenAddress: wbnb,
        quoteTokenSymbol: "WBNB",
        reserveUsd: "16714230.2158",
        volumeH24Usd: "8336698.90737144",
        priceChangeH24: "-2.52",
        createdAt: "2025-11-14T06:46:14.000Z",
      },
    ],
  };
}

function lookupProviderFake(
  mode: "ok" | "unreachable" | "notFound" = "ok",
): TokenLookupProvider & { readonly calls: () => number } {
  let calls = 0;
  return {
    source: "geckoterminal",
    calls: () => calls,
    readToken: () => {
      calls += 1;
      if (mode === "unreachable") {
        return Promise.reject(
          new MarketProviderError(
            "market_provider_unreachable",
            "MARKET_PROVIDER_UNREACHABLE",
          ),
        );
      }
      if (mode === "notFound") {
        return Promise.reject(
          new MarketProviderError(
            "market_provider_rejected",
            "MARKET_TOKEN_NOT_FOUND",
            404,
          ),
        );
      }
      return Promise.resolve({
        value: lookupSnapshot(),
        source: "geckoterminal" as const,
        fetchedAt,
        rawDigest: "e".repeat(64),
      });
    },
  };
}

/** In-memory Decision 0024 quota buckets: exhaustion is reproduced by capacity. */
function controlPlaneFake(
  mode: "ok" | "exhausted" = "ok",
): ControlPlaneRepository & {
  readonly consumed: () => number;
} {
  let consumed = 0;
  return {
    ...createUnavailableControlPlaneRepository(),
    consumed: () => consumed,
    consumeIssuanceQuota: vi.fn(
      (input: { readonly buckets: readonly { subjectKind: string }[] }) => {
        consumed += 1;
        if (mode === "exhausted") {
          return Promise.reject(new IssuanceQuotaExceededError());
        }
        return Promise.resolve(
          input.buckets.map((bucket) => ({
            subjectKind: bucket.subjectKind,
            issuedCount: consumed,
            windowStartedAt: observedAt,
          })),
        );
      },
    ),
  };
}

const nativeAsset: AssetRecord = Object.freeze({
  assetId: "eip155:56:native",
  chainId: bscChainId,
  address: null,
  symbol: "BNB",
  name: "BNB",
  decimals: 18,
  status: "verified",
  sourceKind: "chain_native",
  sourceBlockNumber: null,
  sourceVerifiedAt: null,
  updatedAt: observedAt,
});

const wbnbAsset: AssetRecord = Object.freeze({
  assetId: wbnbAssetId,
  chainId: bscChainId,
  address: wbnb,
  symbol: "WBNB",
  name: "Wrapped BNB",
  decimals: 18,
  status: "pending",
  sourceKind: "chain_call",
  sourceBlockNumber: "120000000",
  sourceVerifiedAt: observedAt,
  updatedAt: observedAt,
});

const usdtAsset: AssetRecord = Object.freeze({
  ...wbnbAsset,
  assetId: usdtAssetId,
  address: usdt,
  symbol: "USDT",
  name: "Tether USD",
});

const pool: PoolRecord = Object.freeze({
  poolId,
  chainId: bscChainId,
  protocol: "pancakeswap_v3",
  address: poolAddress,
  token0AssetId: usdtAssetId,
  token1AssetId: wbnbAssetId,
  fee: 500,
  tickSpacing: 10,
  status: "registered",
});

function pairsSnapshot(): TokenPairsSnapshot {
  const base = {
    priceNative: null,
    priceChangeH24: "0.27",
    fdv: "1222740159",
    marketCap: "1222740159",
    buysH24: 1,
    sellsH24: 1,
    pairCreatedAt: "2023-04-05T14:12:23.000Z",
  } as const;
  return {
    tokenAddress: wbnb,
    pairs: [
      {
        ...base,
        pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
        dexId: "pancakeswap",
        labels: ["v3"],
        baseTokenAddress: wbnb,
        baseTokenSymbol: "WBNB",
        quoteTokenAddress: usdt,
        quoteTokenSymbol: "USDT",
        priceUsd: "747.39",
        liquidityUsd: "11937174.89",
        volumeH24: "219189066.89",
      },
      {
        ...base,
        pairAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
        dexId: "pancakeswap",
        labels: ["v2"],
        baseTokenAddress: wbnb,
        baseTokenSymbol: "WBNB",
        quoteTokenAddress: usdt,
        quoteTokenSymbol: "USDT",
        priceUsd: "746.63",
        liquidityUsd: "94854491.12",
        volumeH24: "29916520.68",
      },
    ],
  };
}

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "market,chain,watchlist",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
    STREAM_TOKEN_QUOTA_HMAC_SECRET: quotaSecret,
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    BSC_RPC_URLS: "https://rpc-a.example/",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function commonHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${validToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

function registryFake(
  assets: readonly AssetRecord[] = [nativeAsset, wbnbAsset, usdtAsset],
  pools: readonly PoolRecord[] = [],
): ChainRegistryRepository {
  return {
    getChain: vi.fn(() => Promise.resolve(null)),
    getAsset: vi.fn((assetId: string) =>
      Promise.resolve(
        assets.find((asset) => asset.assetId === assetId) ?? null,
      ),
    ),
    listAssets: vi.fn((assetIds: readonly string[]) =>
      Promise.resolve(
        assets.filter((asset) => assetIds.includes(asset.assetId)),
      ),
    ),
    listReadableAssets: vi.fn(() => Promise.resolve(assets)),
    upsertAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listPools: vi.fn(() => Promise.resolve(pools)),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

function cacheFake(): MarketFactCacheRepository {
  const rows = new Map<string, MarketFactCacheRecord>();
  return {
    get: vi.fn((subjectKey: string, factKind: string, source: string) =>
      Promise.resolve(rows.get(`${subjectKey}|${factKind}|${source}`) ?? null),
    ),
    put: vi.fn((input: MarketFactCacheRecord) => {
      const record: MarketFactCacheRecord = { ...input };
      rows.set(`${input.subjectKey}|${input.factKind}|${input.source}`, record);
      return Promise.resolve(record);
    }),
    findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
  };
}

function swapRecord(
  overrides: Partial<IndexedPoolEventRecord> = {},
): IndexedPoolEventRecord {
  return {
    transactionHash: `0x${"7".repeat(64)}`,
    logIndex: 3,
    blockNumber: (headNumber - 100n).toString(10),
    blockHash: `0x${"2".repeat(64)}`,
    blockTimestamp: observedAt,
    poolId,
    eventKind: "swap",
    payload: {
      sender: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
    },
    // token0 = USDT (+747.5 in), token1 = WBNB (−1 out): a WBNB buy.
    amount0: "747500000000000000000",
    amount1: "-1000000000000000000",
    sqrtPriceX96: "2897871225897311837660791230",
    removed: false,
    observedAt,
    ...overrides,
  };
}

function indexerFake(
  options: {
    readonly checkpoint?: boolean;
    readonly swaps?: readonly IndexedPoolEventRecord[];
    readonly hasMore?: boolean;
    readonly buckets?: readonly SwapCandleBucket[];
  } = {},
): BscIndexerRepository {
  const aggregateSwapCandles = vi.fn<
    BscIndexerRepository["aggregateSwapCandles"]
  >(() => Promise.resolve(options.buckets ?? []));
  const repository: BscIndexerRepository = {
    getCheckpoint: vi.fn((lane: string) =>
      Promise.resolve(
        options.checkpoint === false || lane !== "pool_event"
          ? null
          : {
              lastBlockNumber: (headNumber - 5n).toString(10),
              lastBlockHash: `0x${"3".repeat(64)}`,
              startedFromBlockNumber: "120000000",
              approvalCoverageFromBlockNumber: null,
              reorgCount: 0,
              updatedAt: observedAt,
            },
      ),
    ),
    commitTransferSegment: vi.fn(() => Promise.reject(new Error("not used"))),
    commitApprovalCoverageSegment: vi.fn(() =>
      Promise.reject(new Error("not used")),
    ),
    earliestWalletActivityBlockNumber: vi.fn(() => Promise.resolve(null)),
    listWalletTransfers: vi.fn(() =>
      Promise.resolve({ items: [], hasMore: false }),
    ),
    sumPendingIncoming: vi.fn(() => Promise.resolve([])),
    listLatestApprovals: vi.fn(() => Promise.resolve([])),
    hasOutgoingTransferTo: vi.fn(() => Promise.resolve(false)),
    commitPoolEventSegment: vi.fn(() => Promise.reject(new Error("not used"))),
    listPoolSwaps: vi.fn(() =>
      Promise.resolve({
        items: options.swaps ?? [swapRecord()],
        hasMore: options.hasMore ?? false,
      }),
    ),
    aggregateSwapCandles,
  };
  aggregateSpies.set(repository, aggregateSwapCandles);
  return repository;
}

const aggregateSpies = new WeakMap<
  BscIndexerRepository,
  Mock<BscIndexerRepository["aggregateSwapCandles"]>
>();

function aggregateSpy(repository: BscIndexerRepository) {
  const spy = aggregateSpies.get(repository);
  if (spy === undefined) {
    throw new Error("indexer fake was not created by indexerFake()");
  }
  return spy;
}

function watchlistFake(): WatchlistV2Repository {
  return {
    get: vi.fn(() =>
      Promise.resolve({
        version: 3,
        updatedAt: observedAt,
        groups: [
          {
            key: "default",
            name: "All",
            items: [{ assetId: wbnbAssetId }, { assetId: "eip155:56:native" }],
          },
        ],
      }),
    ),
    replace: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

function readClientFake(): BscReadClient {
  return {
    chainId: "eip155:56",
    chainReference: 56,
    confirmations: 15,
    reorgDepthBlocks: 64,
    endpointRefs: ["rpc-abcdefabcdef"],
    verifyChain: () => Promise.resolve("verified"),
    currentVerification: () => "verified",
    getHead: () =>
      Promise.resolve({
        blockNumber: headNumber,
        blockHash: headHash,
        observedAt,
      }),
    getBlockHash: () => Promise.resolve(headHash),
    readTokenIdentity: () => Promise.reject(new Error("not used")),
    readPoolIdentity: () => Promise.reject(new Error("not used")),
    readBalances: () => Promise.reject(new Error("not used")),
    readTransferLogs: () => Promise.resolve([]),
    readPoolEventLogs: () => Promise.resolve([]),
    readApprovalLogs: () => Promise.resolve([]),
    probeEndpoints: () => Promise.resolve([]),
  };
}

function pairsProviderFake(): MarketPairsProvider & {
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    source: "dexscreener",
    calls: () => calls,
    readTokenPairsBatch: (addresses: readonly string[]) => {
      calls += 1;
      return Promise.resolve({
        value: addresses.map((tokenAddress) =>
          tokenAddress === wbnb ? pairsSnapshot() : { tokenAddress, pairs: [] },
        ),
        source: "dexscreener" as const,
        fetchedAt,
        rawDigest: "d".repeat(64),
      });
    },
    readTokenPairs: (tokenAddress: string) => {
      calls += 1;
      if (tokenAddress !== wbnb) {
        return Promise.resolve({
          value: { tokenAddress, pairs: [] },
          source: "dexscreener" as const,
          fetchedAt: observedAt,
          rawDigest: "c".repeat(64),
        });
      }
      return Promise.resolve({
        value: pairsSnapshot(),
        source: "dexscreener" as const,
        fetchedAt,
        rawDigest: "a".repeat(64),
      });
    },
    readPair: (pairAddress: string) => {
      calls += 1;
      return Promise.resolve({
        value: { pairAddress, pair: null },
        source: "dexscreener" as const,
        fetchedAt,
        rawDigest: "e".repeat(64),
      });
    },
  };
}

function securityProviderFake(): SecurityFactsProvider {
  return {
    source: "goplus",
    readTokenSecurity: (tokenAddress: string) =>
      Promise.resolve({
        value: {
          tokenAddress,
          facts: [
            { fact: "openSource", value: "true" },
            { fact: "honeypot", value: "false" },
            { fact: "sellTax", value: "0.05" },
          ],
          holderCount: "8019338",
        },
        source: "goplus" as const,
        fetchedAt: observedAt,
        rawDigest: "b".repeat(64),
      }),
  };
}

function candlesProviderFake(): {
  readonly provider: CandlesProvider;
  readonly readPoolOhlcv: Mock<CandlesProvider["readPoolOhlcv"]>;
} {
  const readPoolOhlcv = vi.fn<CandlesProvider["readPoolOhlcv"]>((poolAddress) =>
    Promise.resolve({
      value: {
        poolAddress,
        candles: [
          {
            openTime: "2026-09-08T00:00:00.000Z",
            open: "747.12",
            high: "748.9",
            low: "746.5",
            close: "747.48",
            volume: "1234.5",
          },
        ],
      },
      source: "geckoterminal" as const,
      fetchedAt,
      rawDigest: "c".repeat(64),
    }),
  );
  return {
    provider: {
      source: "geckoterminal",
      readPoolOhlcv,
      readNewPools: vi.fn(() =>
        Promise.resolve({
          value: {
            pools: [
              {
                poolRef: {
                  kind: "address" as const,
                  address: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
                },
                dexId: "pancakeswap_v2",
                name: "WBNB / USDT",
                baseTokenAddress: wbnb,
                quoteTokenAddress: usdt,
                createdAt: "2026-09-17T06:44:36.000Z",
                reserveUsd: "13659.417",
                volumeH24Usd: "8957.0388621769",
              },
              {
                // A Uniswap V4 pool: keyed by pool id, registry match by base token.
                poolRef: {
                  kind: "poolId" as const,
                  poolId: `0x${"ab".repeat(32)}`,
                },
                dexId: "uniswap-v4-bsc",
                name: "WBNB / USDT",
                baseTokenAddress: wbnb,
                quoteTokenAddress: usdt,
                createdAt: "2026-09-17T06:50:00.000Z",
                reserveUsd: "42.5",
                volumeH24Usd: null,
              },
            ],
            omittedPoolCount: 0,
          },
          source: "geckoterminal" as const,
          fetchedAt,
          rawDigest: "d".repeat(64),
        }),
      ),
      readPoolTrades: vi.fn(() => Promise.reject(new Error("not used"))),
    },
    readPoolOhlcv,
  };
}

function fakes(
  options: {
    readonly providers?: boolean;
    readonly pools?: readonly PoolRecord[];
    readonly indexer?: BscIndexerRepository;
    readonly assets?: readonly AssetRecord[];
    readonly candlesProvider?: CandlesProvider;
    readonly tokenLookupProvider?: TokenLookupProvider | null;
    readonly controlPlane?: ControlPlaneRepository;
  } = {},
) {
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: options.controlPlane ?? controlPlaneFake(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    watchlistsV2: watchlistFake(),
    chainRegistry: registryFake(options.assets, options.pools ?? []),
    bscIndexer: options.indexer ?? indexerFake(),
    marketFacts: cacheFake(),
    internalUsers: {
      findByPrivyUserId: vi.fn<InternalUserRepository["findByPrivyUserId"]>(
        () => Promise.resolve({ id: accountId }),
      ),
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken: vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:verified-user" }),
    ),
  } satisfies PrivyAccessTokenVerifier;
  const pairsProvider =
    options.providers === false ? null : pairsProviderFake();
  const securityProvider =
    options.providers === false ? null : securityProviderFake();
  return {
    database,
    privyAccessTokenVerifier,
    pairsProvider,
    securityProvider,
    candlesProvider: options.candlesProvider ?? null,
    tokenLookupProvider:
      options.tokenLookupProvider === undefined
        ? null
        : options.tokenLookupProvider,
  };
}

describe("LOOP API V2 market module", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies = fakes(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      bscReadClient: readClientFake(),
      marketPairsProvider: dependencies.pairsProvider,
      securityFactsProvider: dependencies.securityProvider,
      candlesProvider: dependencies.candlesProvider,
      tokenLookupProvider: dependencies.tokenLookupProvider,
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("registers no market route when the module is disabled", async () => {
    const { app } = await createApp(fakes(), { V2_MODULES_ENABLED: "chain" });
    const response = await app.inject({
      method: "GET",
      url: "/v2/market/overview",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports marketRead available only with the composed runtime", async () => {
    const { app } = await createApp();
    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const projected = capabilities.json<{
      readonly capabilities: readonly {
        readonly capabilityId: string;
        readonly availability: string;
      }[];
    }>();
    expect(
      projected.capabilities.find(
        (capability) => capability.capabilityId === "marketRead",
      ),
    ).toMatchObject({ availability: "available", reasonCode: null });

    const { app: withoutCursor } = await createApp(fakes(), {
      V2_CURSOR_HMAC_SECRET: "",
    });
    const degraded = await withoutCursor.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    expect(
      degraded
        .json<typeof projected>()
        .capabilities.find(
          (capability) => capability.capabilityId === "marketRead",
        ),
    ).toMatchObject({
      availability: "unavailable",
      reasonCode: "MARKET_RUNTIME_UNAVAILABLE",
    });
  });

  it("returns every block as unavailable with a reason when no Provider is configured", async () => {
    const { app } = await createApp(fakes({ providers: false }));
    const asset = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}`,
      headers: commonHeaders(),
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("no-store");
    expect(asset.json()).toMatchObject({
      asset: { assetId: wbnbAssetId, symbol: "WBNB" },
      capability: { swappable: false, value: "viewable" },
      price: {
        value: null,
        quality: "unavailable",
        reasonCode: "MARKET_PROVIDER_DEXSCREENER_DISABLED",
      },
      volume24h: { quality: "unavailable" },
      primaryPair: null,
      community: { status: "unavailable", reasonCode: "COMMUNITY_NOT_BOUND" },
      security: {
        status: "unavailable",
        reasonCode: "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED",
      },
      holderCount: {
        quality: "unavailable",
        reasonCode: "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED",
      },
    });

    const overview = await app.inject({
      method: "GET",
      url: "/v2/market/overview",
      headers: commonHeaders(),
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      watchlist: { status: "available", version: 3 },
      trending: {
        status: "unavailable",
        reasonCode: "MARKET_PROVIDER_DEXSCREENER_DISABLED",
      },
      newPairs: {
        status: "unavailable",
        reasonCode: "MARKET_PROVIDER_GECKOTERMINAL_DISABLED",
      },
      smartMoney: {
        status: "unavailable",
        reasonCode: "SMART_MONEY_RUNTIME_DEFERRED",
      },
    });

    for (const [url, block, reasonCode] of [
      [
        `/v2/market/assets/${wbnbAssetId}/candles?interval=1h`,
        "candles",
        "MARKET_POOL_NOT_REGISTERED",
      ],
      [
        `/v2/market/assets/${wbnbAssetId}/trades`,
        "trades",
        "MARKET_POOL_NOT_REGISTERED",
      ],
      [
        "/v2/market/new-pairs",
        "newPairs",
        "MARKET_PROVIDER_GECKOTERMINAL_DISABLED",
      ],
      ["/v2/market/smart-money", "smartMoney", "SMART_MONEY_RUNTIME_DEFERRED"],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: commonHeaders(),
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.json()).toMatchObject({
        [block]: { status: "unavailable", reasonCode },
      });
    }
    const holders = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/holders`,
      headers: commonHeaders(),
    });
    expect(holders.json()).toMatchObject({
      holderCount: { quality: "unavailable" },
      distribution: {
        status: "unavailable",
        reasonCode: "HOLDER_DISTRIBUTION_NOT_SUPPORTED",
      },
    });
  });

  it("never publishes a GoPlus holder_count of 0 as a count; it is not reported (walkthrough B-9)", async () => {
    const dependencies = fakes();
    // A snapshot as the fact cache may already hold it: the provider's "0"
    // placeholder survived normalisation before the rule existed.
    const securityProvider: SecurityFactsProvider = {
      source: "goplus",
      readTokenSecurity: (tokenAddress: string) =>
        Promise.resolve({
          value: {
            tokenAddress,
            facts: [{ fact: "openSource", value: "true" }],
            holderCount: "0",
          },
          source: "goplus" as const,
          fetchedAt: observedAt,
          rawDigest: "b".repeat(64),
        }),
    };
    const { app } = await createApp({ ...dependencies, securityProvider });
    for (const url of [
      `/v2/market/assets/${wbnbAssetId}`,
      `/v2/market/assets/${wbnbAssetId}/holders`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: commonHeaders(),
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.json(), url).toMatchObject({
        holderCount: {
          quality: "unavailable",
          reasonCode: "MARKET_FACT_NOT_REPORTED",
        },
      });
      expect(response.body, url).not.toMatch(/"value":\s*"0"/);
    }
    // The security facts themselves are still published.
    const asset = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}`,
      headers: commonHeaders(),
    });
    expect(asset.json()).toMatchObject({
      security: { status: "available", source: "goplus" },
    });
  });

  it("publishes DexScreener and GoPlus facts with provenance and caches them", async () => {
    const { app, pairsProvider } = await createApp();
    const first = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}`,
      headers: commonHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      price: {
        value: "746.63",
        source: "dexscreener",
        fetchedAt,
        ttlSeconds: 30,
        quality: "fresh",
        reasonCode: null,
      },
      liquidityUsd: { value: "94854491.12" },
      volume24h: { value: "29916520.68" },
      priceChange24h: { value: "0.27" },
      primaryPair: {
        pairAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
        dexId: "pancakeswap",
        labels: ["v2"],
        quoteTokenSymbol: "USDT",
      },
      security: {
        status: "available",
        source: "goplus",
        quality: "fresh",
        facts: [
          { fact: "openSource", value: "true", source: "goplus", observedAt },
          { fact: "honeypot", value: "false", source: "goplus", observedAt },
          { fact: "sellTax", value: "0.05", source: "goplus", observedAt },
        ],
      },
      holderCount: { value: "8019338", source: "goplus", quality: "fresh" },
    });
    expect(first.body).not.toMatch(/"(value|price)":\s*\d/);
    await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}`,
      headers: commonHeaders(),
    });
    expect(pairsProvider?.calls()).toBe(1);
  });

  it("builds the overview with watchlist prices and a volume-ordered trending list", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/market/overview",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      readonly watchlist: {
        readonly items: readonly {
          readonly assetId: string;
          readonly price: {
            readonly value: string | null;
            readonly reasonCode: string | null;
          };
        }[];
      };
      readonly trending: {
        readonly status: string;
        readonly recommendationId: string;
        readonly rules: Record<string, string>;
        readonly items: readonly { readonly assetId: string }[];
      };
    }>();
    expect(body.watchlist.items.map((item) => item.assetId)).toEqual([
      wbnbAssetId,
      "eip155:56:native",
    ]);
    expect(body.watchlist.items[0]?.price.value).toBe("746.63");
    // The native row is priced through WBNB and labelled as a proxy.
    expect(body.watchlist.items[1]?.price).toMatchObject({
      value: "746.63",
      source: "dexscreener",
      quality: "proxied",
    });
    expect(body.trending.status).toBe("available");
    expect(body.trending.recommendationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.trending.rules).toEqual({
      configVersion: "marketTrendingV1",
      effectiveAt: "2026-09-08T00:00:00.000Z",
      ordering: "dexscreener_volume_h24_desc",
    });
    expect(body.trending.items.map((item) => item.assetId)).toEqual([
      wbnbAssetId,
    ]);
  });

  it("charts native BNB through the WBNB pool and labels the candles proxied", async () => {
    const bucket: SwapCandleBucket = {
      bucketStart: "2026-09-08T00:00:00.000Z",
      openSqrtPriceX96: (q96 * 2n).toString(10),
      closeSqrtPriceX96: q96.toString(10),
      highSqrtPriceX96: (q96 * 4n).toString(10),
      lowSqrtPriceX96: q96.toString(10),
      volumeRaw: "2500000000000000000",
      swapCount: 7,
    };
    const { app, database } = await createApp(
      fakes({ pools: [pool], indexer: indexerFake({ buckets: [bucket] }) }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/v2/market/assets/eip155:56:native/candles?interval=1h&limit=48",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      assetId: "eip155:56:native",
      interval: "1h",
      candles: {
        status: "available",
        quality: "proxied",
        source: "loop_indexer",
        labelKey: "market.candles.onChainSwapAggregate",
        proxyAsset: wbnbAssetId,
        pool: {
          address: poolAddress,
          protocol: "pancakeswap_v3",
          quoteAssetId: usdtAssetId,
          quoteSymbol: "USDT",
        },
        // The price unit names the asset that was actually priced.
        priceUnit: "USDT per WBNB",
        items: [
          {
            openTime: "2026-09-08T00:00:00.000Z",
            open: "0.25",
            close: "1",
            volume: "2.5",
            swapCount: 7,
          },
        ],
      },
    });
    // The WBNB pool is the one aggregated, with WBNB's token position.
    expect(aggregateSpy(database.bscIndexer)).toHaveBeenCalledWith(
      expect.objectContaining({ poolId, assetIsToken0: false }),
    );
  });

  it("publishes Provider OHLCV for native BNB as proxied through WBNB", async () => {
    const { provider, readPoolOhlcv } = candlesProviderFake();
    const { app } = await createApp(
      fakes({ pools: [pool], candlesProvider: provider }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/v2/market/assets/eip155:56:native/candles?interval=1h",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      assetId: "eip155:56:native",
      candles: {
        status: "available",
        quality: "proxied",
        source: "geckoterminal",
        labelKey: null,
        proxyAsset: wbnbAssetId,
        pool: { address: poolAddress, quoteAssetId: null, quoteSymbol: "USD" },
        priceUnit: "USD per WBNB",
        items: [{ open: "747.12", close: "747.48", swapCount: null }],
      },
    });
    // The Provider is asked about WBNB's address, never a native placeholder.
    expect(readPoolOhlcv).toHaveBeenCalledWith(
      poolAddress,
      "1h",
      120,
      expect.objectContaining({ tokenAddress: wbnb }),
    );
    // A non-native asset keeps its own quality and no proxy.
    const direct = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/candles?interval=1h`,
      headers: commonHeaders(),
    });
    expect(direct.json()).toMatchObject({
      candles: {
        quality: "fresh",
        proxyAsset: null,
        priceUnit: "USD per WBNB",
      },
    });
  });

  it("publishes the new-pairs omittedCount on the overview from the same fact as the new-pairs page (Decision 0053)", async () => {
    const { provider } = candlesProviderFake();
    const { app } = await createApp(fakes({ candlesProvider: provider }));
    const overview = await app.inject({
      method: "GET",
      url: "/v2/market/overview",
      headers: commonHeaders(),
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      newPairs: { status: "available", omittedCount: 0 },
    });
    const page = await app.inject({
      method: "GET",
      url: "/v2/market/new-pairs",
      headers: commonHeaders(),
    });
    expect(page.statusCode).toBe(200);
    expect(
      page.json<{ newPairs: { omittedCount: number } }>().newPairs.omittedCount,
    ).toBe(
      overview.json<{ newPairs: { omittedCount: number } }>().newPairs
        .omittedCount,
    );
  });

  it("marks the overview's new-pairs card unavailable with the page's reason when the fact cannot be read", async () => {
    const { provider } = candlesProviderFake();
    const failing: CandlesProvider = {
      ...provider,
      readNewPools: vi.fn(() =>
        Promise.reject(
          new MarketProviderError(
            "market_provider_unreachable",
            "MARKET_PROVIDER_UNREACHABLE",
          ),
        ),
      ),
    };
    const { app } = await createApp(fakes({ candlesProvider: failing }));
    const overview = await app.inject({
      method: "GET",
      url: "/v2/market/overview",
      headers: commonHeaders(),
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      newPairs: {
        status: "unavailable",
        reasonCode: "MARKET_PROVIDER_UNREACHABLE",
      },
      smartMoney: { status: "unavailable" },
    });
    expect(
      overview.json<{ newPairs: Record<string, unknown> }>().newPairs,
    ).not.toHaveProperty("omittedCount");
    const page = await app.inject({
      method: "GET",
      url: "/v2/market/new-pairs",
      headers: commonHeaders(),
    });
    expect(page.json()).toMatchObject({
      newPairs: {
        status: "unavailable",
        reasonCode: "MARKET_PROVIDER_UNREACHABLE",
      },
    });
  });

  it("lists address and Uniswap V4 pool-id pairs under poolRef with the registry match (Decision 0052)", async () => {
    const { provider } = candlesProviderFake();
    const { app } = await createApp(fakes({ candlesProvider: provider }));
    const response = await app.inject({
      method: "GET",
      url: "/v2/market/new-pairs",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      newPairs: {
        status: "available",
        source: "geckoterminal",
        quality: "fresh",
        omittedCount: 0,
        items: [
          {
            poolRef: {
              kind: "address",
              address: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
            },
            dexId: "pancakeswap_v2",
            baseTokenAddress: wbnb,
            registryAssetId: wbnbAssetId,
            reserveUsd: "13659.417",
          },
          {
            poolRef: { kind: "poolId", poolId: `0x${"ab".repeat(32)}` },
            dexId: "uniswap-v4-bsc",
            baseTokenAddress: wbnb,
            registryAssetId: wbnbAssetId,
            reserveUsd: "42.5",
            volumeH24Usd: null,
          },
        ],
      },
      riskScreening: {
        status: "unavailable",
        reasonCode: "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED",
      },
    });
  });

  it("keeps native candles unavailable when the wrapped native token is not registered", async () => {
    const { app } = await createApp(
      fakes({ pools: [pool], assets: [nativeAsset, usdtAsset] }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/v2/market/assets/eip155:56:native/candles?interval=1h",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candles: {
        status: "unavailable",
        reasonCode: "MARKET_NATIVE_ASSET_NOT_SUPPORTED",
      },
    });
  });

  it("derives candles from indexed swaps when no OHLCV Provider is enabled", async () => {
    const bucket: SwapCandleBucket = {
      bucketStart: "2026-09-08T00:00:00.000Z",
      openSqrtPriceX96: (q96 * 2n).toString(10),
      closeSqrtPriceX96: q96.toString(10),
      highSqrtPriceX96: (q96 * 4n).toString(10),
      lowSqrtPriceX96: q96.toString(10),
      volumeRaw: "2500000000000000000",
      swapCount: 7,
    };
    const { app, database } = await createApp(
      fakes({ pools: [pool], indexer: indexerFake({ buckets: [bucket] }) }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/candles?interval=1h&limit=48`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      assetId: wbnbAssetId,
      interval: "1h",
      candles: {
        status: "available",
        quality: "derived",
        source: "loop_indexer",
        labelKey: "market.candles.onChainSwapAggregate",
        pool: {
          address: poolAddress,
          protocol: "pancakeswap_v3",
          quoteAssetId: usdtAssetId,
          quoteSymbol: "USDT",
        },
        priceUnit: "USDT per WBNB",
        items: [
          {
            openTime: "2026-09-08T00:00:00.000Z",
            closeTime: "2026-09-08T01:00:00.000Z",
            // WBNB is token1, so the price is the inverse of sqrt²/2¹⁹².
            open: "0.25",
            high: "1",
            low: "0.0625",
            close: "1",
            volume: "2.5",
            swapCount: 7,
            isOpen: false,
          },
        ],
      },
    });
    expect(aggregateSpy(database.bscIndexer)).toHaveBeenCalledWith(
      expect.objectContaining({
        poolId,
        intervalSeconds: 3_600,
        assetIsToken0: false,
      }),
    );
    const invalid = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/candles?interval=2h`,
      headers: commonHeaders(),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("lists indexed swaps with direction, amounts, confirmations, and a bound cursor", async () => {
    const { app } = await createApp(
      fakes({ pools: [pool], indexer: indexerFake({ hasMore: true }) }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/trades?limit=1`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      readonly trades: {
        readonly items: readonly Record<string, unknown>[];
        readonly nextCursor: string | null;
        readonly freshness: Record<string, unknown>;
      };
    }>();
    expect(body.trades.items[0]).toMatchObject({
      direction: "buy",
      amountAsset: "1",
      amountQuote: "747.5",
      quoteAssetId: usdtAssetId,
      quoteSymbol: "USDT",
      priceAfter: "747.482453211647133359",
      confirmations: 101,
      status: "confirmed",
      poolAddress,
      isOwn: false,
    });
    expect(response.body).not.toContain(
      "0x0000000000000000000000000000000000000001",
    );
    expect(body.trades.freshness).toMatchObject({
      indexerBlockNumber: (headNumber - 5n).toString(10),
      headBlockNumber: headNumber.toString(10),
      lagBlocks: 5,
    });
    expect(body.trades.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const next = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/trades?cursor=${encodeURIComponent(body.trades.nextCursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(next.statusCode).toBe(200);
    const both = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/trades?cursor=${encodeURIComponent(body.trades.nextCursor ?? "")}&limit=5`,
      headers: commonHeaders(),
    });
    expect(both.statusCode).toBe(400);
    const foreign = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${usdtAssetId}/trades?cursor=${encodeURIComponent(body.trades.nextCursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(foreign.statusCode).toBe(400);
  });

  it("marks trades unavailable while the pool lane has never run", async () => {
    const { app } = await createApp(
      fakes({ pools: [pool], indexer: indexerFake({ checkpoint: false }) }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/trades`,
      headers: commonHeaders(),
    });
    expect(response.json()).toMatchObject({
      trades: {
        status: "unavailable",
        reasonCode: "BSC_POOL_INDEXER_NOT_STARTED",
      },
    });
  });

  it("marks swaps that touch the caller's own wallet as isOwn", async () => {
    const dependencies = fakes({ pools: [pool] });
    const database = {
      ...dependencies.database,
      accountWallets: {
        sync: vi.fn(() => Promise.reject(new Error("not used"))),
        list: vi.fn(() =>
          Promise.resolve([
            {
              walletId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
              providerWalletId: null,
              address: "0x0000000000000000000000000000000000000002",
              kind: "external" as const,
              status: "active" as const,
              isActive: true,
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
            },
          ]),
        ),
        get: vi.fn(() => Promise.resolve(null)),
        setActive: vi.fn(() => Promise.reject(new Error("not used"))),
        recordBalanceSnapshot: vi.fn(() => Promise.resolve()),
      },
    } satisfies Database;
    const { app } = await createApp({ ...dependencies, database });
    const response = await app.inject({
      method: "GET",
      url: `/v2/market/assets/${wbnbAssetId}/trades?limit=1`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ trades: { items: { isOwn: boolean }[] } }>().trades
        .items[0]?.isOwn,
    ).toBe(true);
  });

  it("rejects unknown assets, other chains, and stray headers", async () => {
    const { app } = await createApp();
    const unknown = await app.inject({
      method: "GET",
      url: "/v2/market/assets/eip155:56:0x0000000000000000000000000000000000000abc",
      headers: commonHeaders(),
    });
    expect(unknown.statusCode).toBe(404);
    const otherChain = await app.inject({
      method: "GET",
      url: `/v2/market/assets/eip155:1:${wbnb}`,
      headers: commonHeaders(),
    });
    expect(otherChain.statusCode).toBe(422);
    expect(otherChain.json()).toMatchObject({ code: "CHAIN_MISMATCH" });
    const withKey = await app.inject({
      method: "GET",
      url: "/v2/market/overview",
      headers: commonHeaders({
        "idempotency-key": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      }),
    });
    expect(withKey.statusCode).toBe(400);
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v2/market/overview",
      headers: commonHeaders({ authorization: undefined }),
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  describe("unregistered address lookup (Decision 0058)", () => {
    it("describes a registry-unknown address from GeckoTerminal with status unregistered and no swap capability", async () => {
      const lookup = lookupProviderFake();
      const deps = fakes({ tokenLookupProvider: lookup });
      const { app, database } = await createApp(deps);
      const response = await app.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        asset: {
          assetId: wethAssetId,
          chainId: "eip155:56",
          address: weth,
          symbol: "ETH",
          name: "Ethereum Token",
          decimals: 18,
          status: "unregistered",
          source: {
            kind: "provider_lookup",
            provider: "geckoterminal",
            ttlSeconds: 3_600,
            quality: "fresh",
            blockNumber: null,
            verifiedAt: null,
          },
        },
        capability: {
          viewable: true,
          swappable: false,
          value: "viewable",
          reasonCode: "ASSET_NOT_REGISTERED",
        },
        price: {
          value: "2575.1402462078",
          source: "geckoterminal",
          ttlSeconds: 60,
          quality: "fresh",
        },
        priceChange24h: { value: "-2.52", source: "geckoterminal" },
        liquidityUsd: { value: "16714230.2158" },
        volume24h: { value: "25016115.5564862" },
        marketCap: { value: "1300514252.30807" },
        fdv: { value: "1300404347.01321" },
        primaryPair: {
          pairAddress: wethPool,
          dexId: "pancakeswap-v3-bsc",
          labels: [],
          quoteTokenAddress: wbnb,
          quoteTokenSymbol: "WBNB",
          pairCreatedAt: "2025-11-14T06:46:14.000Z",
        },
        community: { status: "unavailable", reasonCode: "COMMUNITY_NOT_BOUND" },
        // GoPlus is keyed by address and answers for any token.
        security: { status: "available", source: "goplus" },
        holderCount: { value: "8019338", source: "goplus" },
        contractVersion: "2.0",
      });
      // The lookup consumed the quota; DexScreener was not consulted.
      expect(
        (
          database.controlPlane as ReturnType<typeof controlPlaneFake>
        ).consumed(),
      ).toBe(1);
      expect(deps.pairsProvider?.calls()).toBe(0);

      // A registered asset never consumes the lookup quota.
      const registered = await app.inject({
        method: "GET",
        url: `/v2/market/assets/${wbnbAssetId}`,
        headers: commonHeaders(),
      });
      expect(registered.statusCode).toBe(200);
      expect(registered.json()).toMatchObject({
        asset: { status: "pending", symbol: "WBNB" },
      });
      expect(
        (
          database.controlPlane as ReturnType<typeof controlPlaneFake>
        ).consumed(),
      ).toBe(1);
    });

    it("falls back to DexScreener when GeckoTerminal is disabled and publishes decimals as null", async () => {
      const pairsProvider: MarketPairsProvider & {
        readonly calls: () => number;
      } = {
        source: "dexscreener",
        calls: () => 0,
        readTokenPairsBatch: () => Promise.reject(new Error("not used")),
        readPair: () => Promise.reject(new Error("not used")),
        readTokenPairs: (tokenAddress: string) =>
          Promise.resolve({
            value: {
              tokenAddress,
              pairs: [
                {
                  ...pairsSnapshot().pairs[0]!,
                  pairAddress: "0x62fcb3c1794fb95bd8b1a97f6ad5d8a7e4943a1e",
                  baseTokenAddress: weth,
                  baseTokenSymbol: "ETH",
                  baseTokenName: "Ethereum Token",
                  priceUsd: "2576.66",
                  liquidityUsd: "899550.52",
                  volumeH24: "2926215.92",
                },
              ],
            },
            source: "dexscreener" as const,
            fetchedAt,
            rawDigest: "f".repeat(64),
          }),
      };
      const deps = { ...fakes(), pairsProvider };
      const { app } = await createApp(deps);
      const response = await app.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        asset: {
          status: "unregistered",
          symbol: "ETH",
          name: "Ethereum Token",
          decimals: null,
          source: { kind: "provider_lookup", provider: "dexscreener" },
        },
        price: { value: "2576.66", source: "dexscreener", ttlSeconds: 60 },
        primaryPair: {
          pairAddress: "0x62fcb3c1794fb95bd8b1a97f6ad5d8a7e4943a1e",
          dexId: "pancakeswap",
          labels: ["v3"],
        },
      });
    });

    it("answers 200 with unavailable blocks when the Providers cannot be reached, and 404 only when they say the token does not exist", async () => {
      const { app: unreachable } = await createApp(
        fakes({
          providers: false,
          tokenLookupProvider: lookupProviderFake("unreachable"),
        }),
      );
      const degraded = await unreachable.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(degraded.statusCode).toBe(200);
      expect(degraded.json()).toMatchObject({
        asset: {
          status: "unavailable",
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
        },
        capability: {
          viewable: false,
          swappable: false,
          value: "temporarily_unavailable",
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
        },
        price: {
          value: null,
          quality: "unavailable",
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
        },
        primaryPair: null,
        security: {
          status: "unavailable",
          reasonCode: "MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED",
        },
      });

      // GeckoTerminal 404 and DexScreener empty list: both affirmative.
      const { app: missing } = await createApp(
        fakes({ tokenLookupProvider: lookupProviderFake("notFound") }),
      );
      const notFound = await missing.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json()).toMatchObject({ code: "NOT_FOUND" });

      // GeckoTerminal 404 but DexScreener unreachable: not an answer.
      const unreachablePairs: MarketPairsProvider & {
        readonly calls: () => number;
      } = {
        source: "dexscreener",
        calls: () => 0,
        readTokenPairsBatch: () => Promise.reject(new Error("not used")),
        readPair: () => Promise.reject(new Error("not used")),
        readTokenPairs: () =>
          Promise.reject(
            new MarketProviderError(
              "market_provider_unreachable",
              "MARKET_PROVIDER_UNREACHABLE",
            ),
          ),
      };
      const { app: half } = await createApp({
        ...fakes({ tokenLookupProvider: lookupProviderFake("notFound") }),
        pairsProvider: unreachablePairs,
      });
      const partial = await half.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(partial.statusCode).toBe(200);
      expect(partial.json()).toMatchObject({
        asset: {
          status: "unavailable",
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
        },
      });

      // GeckoTerminal 404 with DexScreener disabled: the only enabled
      // Provider answered, so the token does not exist for LOOP.
      const { app: only } = await createApp(
        fakes({
          providers: false,
          tokenLookupProvider: lookupProviderFake("notFound"),
        }),
      );
      const onlyResponse = await only.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(onlyResponse.statusCode).toBe(404);
    });

    it("rejects a malformed or mixed-case address with 400 before any quota or Provider work", async () => {
      const lookup = lookupProviderFake();
      const deps = fakes({ tokenLookupProvider: lookup });
      const { app, database } = await createApp(deps);
      for (const assetId of [
        "eip155:56:0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
        "eip155:56:0x2170ed0880ac9a755fd29b2688956bd959f933",
        "eip155:56:2170ed0880ac9a755fd29b2688956bd959f933f8",
        "eip155:56:ETH",
      ]) {
        const response = await app.inject({
          method: "GET",
          url: `/v2/market/assets/${assetId}`,
          headers: commonHeaders(),
        });
        expect(response.statusCode, assetId).toBe(400);
        expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      }
      expect(
        (
          database.controlPlane as ReturnType<typeof controlPlaneFake>
        ).consumed(),
      ).toBe(0);
      expect(lookup.calls()).toBe(0);
    });

    it("returns 429 when the per-user lookup quota is exhausted and 503 when the quota runtime is missing", async () => {
      const exhaustedLookup = lookupProviderFake();
      const { app: exhausted } = await createApp(
        fakes({
          tokenLookupProvider: exhaustedLookup,
          controlPlane: controlPlaneFake("exhausted"),
        }),
      );
      const limited = await exhausted.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({
        code: "RATE_LIMITED",
        category: "rateLimit",
        retryable: true,
      });
      expect(exhaustedLookup.calls()).toBe(0);

      const { app: noQuota } = await createApp(
        fakes({ tokenLookupProvider: lookupProviderFake() }),
        { STREAM_TOKEN_QUOTA_HMAC_SECRET: "" },
      );
      const closed = await noQuota.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(closed.statusCode).toBe(503);
      expect(closed.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

      // The control-plane repository itself unavailable is the same closed state.
      const { app: noRepository } = await createApp(
        fakes({
          tokenLookupProvider: lookupProviderFake(),
          controlPlane: createUnavailableControlPlaneRepository(),
        }),
      );
      const closedRepository = await noRepository.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}`,
        headers: commonHeaders(),
      });
      expect(closedRepository.statusCode).toBe(503);
    });

    it("charts an unregistered address through GeckoTerminal OHLCV of its primary pair, else MARKET_POOL_NOT_REGISTERED", async () => {
      const candles = candlesProviderFake();
      const deps = fakes({
        tokenLookupProvider: lookupProviderFake(),
        candlesProvider: candles.provider,
      });
      const { app, database } = await createApp(deps);
      const response = await app.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}/candles?interval=1h&limit=5`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        assetId: wethAssetId,
        interval: "1h",
        candles: {
          status: "available",
          quality: "fresh",
          source: "geckoterminal",
          labelKey: null,
          proxyAsset: null,
          pool: {
            address: wethPool,
            protocol: "pancakeswap-v3-bsc",
            quoteAssetId: null,
            quoteSymbol: "USD",
          },
          priceUnit: "USD per ETH",
          items: [{ open: "747.12", close: "747.48", swapCount: null }],
        },
      });
      expect(candles.readPoolOhlcv).toHaveBeenCalledWith(
        wethPool,
        "1h",
        5,
        expect.objectContaining({ tokenAddress: weth }),
      );
      expect(
        (
          database.controlPlane as ReturnType<typeof controlPlaneFake>
        ).consumed(),
      ).toBe(1);

      const { app: withoutOhlcv } = await createApp(
        fakes({ tokenLookupProvider: lookupProviderFake() }),
      );
      const closed = await withoutOhlcv.inject({
        method: "GET",
        url: `/v2/market/assets/${wethAssetId}/candles?interval=1h`,
        headers: commonHeaders(),
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toMatchObject({
        candles: {
          status: "unavailable",
          reasonCode: "MARKET_POOL_NOT_REGISTERED",
        },
      });
    });
  });
});
