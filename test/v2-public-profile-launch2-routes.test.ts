import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type {
  Launch2AddressHolding,
  Launch2Service,
} from "../src/features/launch2/launch2-service.js";
import type {
  ProfileCommunityRecord,
  PublicProfileRecord,
  PublicProfileRepository,
  TimedTradeRow,
  TradeRow,
} from "../src/features/profile/public-profile-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import {
  compareSortKeys,
  type WalletActivityMergeRepository,
  type WalletActivitySortKey,
  type WalletLaunch2ActivityRecord,
} from "../src/features/wallet/wallet-activity-launch2.js";
import type {
  WalletBalancesResource,
  WalletReadService,
} from "../src/features/wallet/wallet-read-service.js";
import type { BscReadClient } from "../src/integrations/bsc/rpc-client.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

/**
 * Decision 0169 (S260): the public profile's joined-communities list, and
 * holdings / trades merged with the owner's Launch-chain (MEME v2) facts
 * behind PROFILE_LAUNCH2_EMIT (default off, byte-identical).
 */

const viewerId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const targetUserId = "f7bf09f6-0171-46b9-9acd-5ad494f211bd";
const targetProfileId = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const walletId = "11111111-2222-4333-8444-555555555555";
const walletAddress = "0x00000000000000000000000000000000000000aa";
const cursorSecret = "c".repeat(48);
const quotaSecret = "q".repeat(48);
const token = "eip155:56:0x1111111111111111111111111111111111111111";
const usdt = "eip155:56:0x55d398326f99059ff775485246999027b3197955";
const wbnb = "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const windId = "2f6a1c3e-5b7d-4e9f-8a1b-3c5d7e9f1a2b";
const moonId = "3a7b2d4f-6c8e-4f0a-9b2c-4d6e8f0a2b3c";
const wad = 10n ** 18n;
const launchHead = 52_000_100n;
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];

const micros = (iso: string): string =>
  (BigInt(Date.parse(iso)) * 1000n).toString(10);
const hash = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`;

function record(
  overrides: Partial<PublicProfileRecord> = {},
): PublicProfileRecord {
  return {
    targetUserId,
    publicProfileId: targetProfileId,
    loopId: "LOOP-7HJKMNPQ",
    alias: "evening_wind",
    avatarRef: null,
    bio: null,
    joinedAt: "2026-09-07T01:00:00.000Z",
    counts: { followers: 0, following: 0, communities: 3 },
    relationship: {
      following: false,
      followedBy: false,
      friendship: "none",
      blocked: false,
      blockedBy: false,
    },
    visibility: {
      totalAssets: "everyone",
      tradeHistory: "everyone",
      communities: "everyone",
    },
    ...overrides,
  };
}

function asset(assetId: string, symbol: string): AssetRecord {
  return {
    assetId,
    chainId: "eip155:56",
    address: assetId.split(":")[2] ?? null,
    symbol,
    name: symbol,
    decimals: 18,
    status: "verified",
    sourceKind: "chain_call",
    sourceBlockNumber: "1",
    sourceVerifiedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const assets = new Map([
  [token, asset(token, "FROG")],
  [usdt, asset(usdt, "USDT")],
  [wbnb, asset(wbnb, "WBNB")],
]);

/** Primary-chain rows, newest first in both orders (block and time). */
const primaryTrades: TimedTradeRow[] = [
  {
    source: "swap",
    transactionHash: hash("a"),
    logIndex: 5,
    blockNumber: "300",
    blockTimestamp: "2026-10-19T11:20:00.000Z",
    token0AssetId: token,
    token1AssetId: usdt,
    amount0: "-2500000000000000000",
    amount1: "10000000000000000000",
    atMicros: micros("2026-10-19T11:20:00.000Z"),
  },
  {
    source: "swap",
    transactionHash: hash("b"),
    logIndex: 1,
    blockNumber: "200",
    blockTimestamp: "2026-10-19T10:50:00.000Z",
    token0AssetId: wbnb,
    token1AssetId: token,
    amount0: "-1000000000000000000",
    amount1: "4000000000000000000",
    atMicros: micros("2026-10-19T10:50:00.000Z"),
  },
  {
    source: "transfer",
    transactionHash: hash("c"),
    logIndex: 0,
    blockNumber: "100",
    blockTimestamp: null,
    assetId: usdt,
    direction: "in",
    rawValue: "1500000000000000000",
    // No block time: ordered by its observation time.
    atMicros: micros("2026-10-19T10:00:00.000Z"),
  },
];

function untimed(row: TimedTradeRow): TradeRow {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "atMicros"),
  ) as unknown as TradeRow;
}

function launch2Row(
  kind: WalletLaunch2ActivityRecord["kind"],
  at: string,
  block: string,
  overrides: Partial<WalletLaunch2ActivityRecord> = {},
): WalletLaunch2ActivityRecord {
  return {
    kind,
    chainId: "eip155:97",
    instanceId: windId,
    ticker: "WIND",
    name: "Evening Wind",
    logoUrl: "https://example.com/wind.png",
    amountMeme: "1000000000000000000000",
    amountUsd1: "10200000000000000000",
    taxUsd1: "200000000000000000",
    transactionHash: `0x${block.padStart(64, "d")}`,
    logIndex: 1,
    blockNumber: block,
    occurredAt: at,
    atMicros: micros(at),
    ...overrides,
  };
}

/** 晚风: WIND mint / curve buy / curve sell, MOON pool buy / sell. */
const launch2Rows: WalletLaunch2ActivityRecord[] = [
  launch2Row("launch2_nft_mint", "2026-10-19T10:20:00.000Z", "52000000", {
    amountMeme: null,
    amountUsd1: "100000000000000000000",
    taxUsd1: null,
  }),
  launch2Row("launch2_curve_buy", "2026-10-19T10:30:00.000Z", "52000010"),
  launch2Row("launch2_curve_sell", "2026-10-19T10:40:00.000Z", "52000020", {
    amountUsd1: "4900000000000000000",
    taxUsd1: "100000000000000000",
  }),
  launch2Row("launch2_pool_buy", "2026-10-19T11:00:00.000Z", "52000030", {
    instanceId: moonId,
    ticker: "MOON",
    name: "Moon",
    logoUrl: null,
    amountMeme: "392000000000000000000",
    amountUsd1: "20000000000000000000",
    taxUsd1: null,
  }),
  launch2Row("launch2_pool_sell", "2026-10-19T11:10:00.000Z", "52000040", {
    instanceId: moonId,
    ticker: "MOON",
    name: "Moon",
    logoUrl: null,
    amountMeme: "100000000000000000000",
    amountUsd1: "4800000000000000000",
    taxUsd1: "200000000000000000",
  }),
];

const holdings: Launch2AddressHolding[] = [
  {
    instanceId: windId,
    chainId: "eip155:97",
    ticker: "WIND",
    name: "Evening Wind",
    logoUrl: "https://example.com/wind.png",
    stage: "public",
    nftHeld: 1,
    memeRaw: 900n * wad,
    priceE18: (102n * wad) / 10_000n,
  },
  {
    instanceId: moonId,
    chainId: "eip155:97",
    ticker: "MOON",
    name: "Moon",
    logoUrl: null,
    stage: "graduated",
    nftHeld: 0,
    memeRaw: 292n * wad,
    priceE18: (5n * wad) / 100n,
  },
];

const communities: ProfileCommunityRecord[] = [
  {
    communityId: "aaaaaaaa-0000-4000-8000-000000000003",
    name: "Wind Club",
    slug: "wind-club",
    logoRef: "avatar:preset/community-03",
    memberCount: 42,
    verificationStatus: "verified",
    label: null,
    joinedAt: "2026-10-03T00:00:00.000Z",
    joinedAtMicros: micros("2026-10-03T00:00:00.000Z"),
  },
  {
    communityId: "aaaaaaaa-0000-4000-8000-000000000002",
    name: "Moon Riders",
    slug: "moon-riders",
    logoRef: null,
    memberCount: 7,
    verificationStatus: "verified",
    label: null,
    joinedAt: "2026-10-02T00:00:00.000Z",
    joinedAtMicros: micros("2026-10-02T00:00:00.000Z"),
  },
  {
    communityId: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "Frogs",
    slug: "frogs",
    logoRef: "logo:media/22222222-2222-4222-8222-222222222222",
    memberCount: 1,
    verificationStatus: "verified",
    label: null,
    joinedAt: "2026-10-01T00:00:00.000Z",
    joinedAtMicros: micros("2026-10-01T00:00:00.000Z"),
  },
];

function balances(): WalletBalancesResource {
  const row = (
    assetId: string,
    rawValue: string,
    displayBalance: string,
    valueUsd: string | null,
  ) => ({
    assetId,
    symbol: assets.get(assetId)?.symbol ?? "X",
    name: assets.get(assetId)?.name ?? "X",
    decimals: 18,
    address: null,
    logo: {
      status: "available",
      url: "https://logo.test/x.png",
      source: "trustwallet",
      observedAt: null,
    },
    balance: {
      status: "available",
      rawValue,
      displayBalance,
      availableBalance: displayBalance,
      spendableBalance: displayBalance,
      gasReserve: "0",
    },
    pending: { status: "unavailable", reasonCode: "X" },
    valuation:
      valueUsd === null
        ? { status: "unavailable", reasonCode: "MARKET_PAIR_NOT_FOUND" }
        : {
            status: "available",
            priceSource: "dexscreener",
            fetchedAt: "2026-10-08T00:00:00.000Z",
            quality: "fresh",
            reasonCode: null,
            proxyAsset: null,
            priceUsd: "1",
            valueUsd,
          },
    crossCheck: {
      source: "privy",
      status: "unavailable",
      reasonCode: "X",
      blockDelta: null,
    },
  });
  return {
    walletId,
    snapshot: {
      blockNumber: "1000",
      blockHash: `0x${"d".repeat(64)}`,
      observedAt: "2026-10-08T00:00:01.000Z",
      confirmations: 15,
    },
    gasReservePolicy: {
      configVersion: "walletGasReserveV1",
      nativeReserveRaw: "0",
      nativeReserve: "0",
    },
    balances: [
      row(usdt, "12000000000000000000", "12", "12"),
      row(token, "0", "0", "0"),
      row(wbnb, "500000000000000000", "0.5", "300.25"),
    ],
    netWorth: { status: "unavailable", reasonCode: "X" },
    contractVersion: "2.0",
  } as unknown as WalletBalancesResource;
}

function pageAfter<T>(
  rows: readonly T[],
  limit: number,
  key: (row: T) => WalletActivitySortKey,
  before: WalletActivitySortKey | undefined,
) {
  const after = rows
    .filter(
      (row) => before === undefined || compareSortKeys(key(row), before) < 0,
    )
    .sort((a, b) => compareSortKeys(key(b), key(a)));
  return Promise.resolve({
    items: after.slice(0, limit),
    hasMore: after.length > limit,
  });
}

const primaryKey = (row: TimedTradeRow): WalletActivitySortKey => ({
  atMicros: row.atMicros,
  blockNumber: row.blockNumber,
  logIndex: row.logIndex,
  source: "erc20",
  transactionHash: row.transactionHash,
});
const launch2Key = (
  row: WalletLaunch2ActivityRecord,
): WalletActivitySortKey => ({
  atMicros: row.atMicros,
  blockNumber: row.blockNumber,
  logIndex: row.logIndex,
  source: "launch2",
  transactionHash: row.transactionHash,
});

function fakes(
  options: {
    readonly checkpoint?: string | null | Error;
    readonly launch2Error?: Error;
    readonly holdingsError?: Error;
    readonly withMerge?: boolean;
  } = {},
) {
  const repository = {
    findProfile: vi.fn<PublicProfileRepository["findProfile"]>(() =>
      Promise.resolve(record()),
    ),
    getActiveWallet: vi.fn<PublicProfileRepository["getActiveWallet"]>(() =>
      Promise.resolve({ walletId, address: walletAddress }),
    ),
    hasTransferCheckpoint: vi.fn<
      PublicProfileRepository["hasTransferCheckpoint"]
    >(() => Promise.resolve(true)),
    listTrades: vi.fn<PublicProfileRepository["listTrades"]>((input) => {
      const rows = primaryTrades.map(untimed);
      const start =
        input.before === undefined
          ? 0
          : rows.findIndex(
              (row) =>
                BigInt(row.blockNumber) <
                BigInt(input.before?.blockNumber ?? "0"),
            );
      return Promise.resolve({
        items: rows.slice(start, start + input.limit),
        hasMore: start + input.limit < rows.length,
      });
    }),
    listTradesByTime: vi.fn<PublicProfileRepository["listTradesByTime"]>(
      (input) =>
        pageAfter(primaryTrades, input.limit, primaryKey, input.before),
    ),
    listProfileCommunities: vi.fn<
      PublicProfileRepository["listProfileCommunities"]
    >((input) => {
      const after = communities.filter(
        (row) =>
          input.before === undefined ||
          BigInt(row.joinedAtMicros) < BigInt(input.before.joinedAtMicros) ||
          (row.joinedAtMicros === input.before.joinedAtMicros &&
            row.communityId < input.before.communityId),
      );
      return Promise.resolve({
        items: after.slice(0, input.limit),
        hasMore: after.length > input.limit,
      });
    }),
    removeFriend: vi.fn<PublicProfileRepository["removeFriend"]>(() =>
      Promise.resolve({ publicProfileId: targetProfileId, removed: true }),
    ),
    listVerifiedCommunitiesByIds: vi.fn<
      PublicProfileRepository["listVerifiedCommunitiesByIds"]
    >(() => Promise.resolve([])),
  } satisfies PublicProfileRepository;
  const merge = {
    getLaunch2Checkpoint: vi.fn<
      WalletActivityMergeRepository["getLaunch2Checkpoint"]
    >(() => {
      const checkpoint =
        options.checkpoint === undefined ? "52000050" : options.checkpoint;
      return checkpoint instanceof Error
        ? Promise.reject(checkpoint)
        : Promise.resolve(checkpoint);
    }),
    listTransfersByTime: vi.fn<
      WalletActivityMergeRepository["listTransfersByTime"]
    >(() => Promise.reject(new Error("not used by profiles"))),
    listLaunch2Activity: vi.fn<
      WalletActivityMergeRepository["listLaunch2Activity"]
    >((input) =>
      options.launch2Error !== undefined
        ? Promise.reject(options.launch2Error)
        : pageAfter(launch2Rows, input.limit, launch2Key, input.before),
    ),
  } satisfies WalletActivityMergeRepository;
  const listAddressHoldings = vi.fn<Launch2Service["listAddressHoldings"]>(
    () =>
      options.holdingsError !== undefined
        ? Promise.reject(options.holdingsError)
        : Promise.resolve(holdings),
  );
  const getBalances = vi.fn<WalletReadService["getBalances"]>(() =>
    Promise.resolve(balances()),
  );
  const chainRegistry = {
    getAsset: vi.fn((assetId: string) =>
      Promise.resolve(assets.get(assetId) ?? null),
    ),
  } as unknown as ChainRegistryRepository;
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    publicProfiles: repository,
    chainRegistry,
    ...(options.withMerge === false ? {} : { walletActivityMerge: merge }),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: vi.fn<InternalUserRepository["findByPrivyUserId"]>(
        () => Promise.resolve({ id: viewerId }),
      ),
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: viewerId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken: vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:verified-user" }),
    ),
  } satisfies PrivyAccessTokenVerifier;
  const launchHeadRead = vi.fn(() =>
    Promise.resolve({
      blockNumber: launchHead,
      blockHash: `0x${"9".repeat(64)}`,
      observedAt: "2026-10-19T12:00:00.000Z",
    }),
  );
  const launchChainReadClient = {
    chainId: "eip155:97",
    chainReference: 97,
    confirmations: 5,
    reorgDepthBlocks: 12,
    endpointRefs: [],
    getHead: launchHeadRead,
  } as unknown as BscReadClient;
  return {
    database,
    repository,
    merge,
    listAddressHoldings,
    getBalances,
    privyAccessTokenVerifier,
    launchChainReadClient,
    launchHeadRead,
  };
}

function headers(): Record<string, string> {
  return {
    authorization: "Bearer header.payload.signature",
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
}

function expectEnvelope(
  response: { statusCode: number; json: <T>() => T },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  const body = response.json<Record<string, unknown>>();
  expect(Object.keys(body).sort()).toEqual(errorKeys);
  expect(body["code"]).toBe(code);
}

const maskCursor = (body: string): string =>
  body.replace(/"nextCursor":"[^"]+"/u, '"nextCursor":"<cursor>"');

/**
 * Captured from `0ceab3d` (before Decision 0169) with these fakes; only the
 * random cursor is masked.
 */
const baseline = {
  holdings:
    '{"status":"available","reasonCode":null,"totalUsd":"312.25","items":[{"assetId":"eip155:56:0x55d398326f99059ff775485246999027b3197955","symbol":"USDT","name":"USDT","logoUrl":"https://logo.test/x.png","balance":"12","usdValue":"12"},{"assetId":"eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c","symbol":"WBNB","name":"WBNB","logoUrl":"https://logo.test/x.png","balance":"0.5","usdValue":"300.25"}],"observedAt":"2026-10-08T00:00:01.000Z","contractVersion":"2.0"}',
  tradesFirst:
    '{"status":"available","reasonCode":null,"items":[{"eventId":"fe85b1cc-b3d3-5bb6-b9f4-70c3c8a58ef8","kind":"buy","assetId":"eip155:56:0x1111111111111111111111111111111111111111","symbol":"FROG","amount":"2.5","usdValue":"10","blockTimestamp":"2026-10-19T11:20:00.000Z","blockNumber":"300","txHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"eventId":"8df9be96-f1bc-5269-ac30-a9c19633b341","kind":"sell","assetId":"eip155:56:0x1111111111111111111111111111111111111111","symbol":"FROG","amount":"4","usdValue":null,"blockTimestamp":"2026-10-19T10:50:00.000Z","blockNumber":"200","txHash":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"nextCursor":"<cursor>","contractVersion":"2.0"}',
  tradesSecond:
    '{"status":"available","reasonCode":null,"items":[{"eventId":"d5814d36-3610-56bf-8593-c2ca3714aa3a","kind":"transfer_in","assetId":"eip155:56:0x55d398326f99059ff775485246999027b3197955","symbol":"USDT","amount":"1.5","usdValue":"1.5","blockTimestamp":null,"blockNumber":"100","txHash":"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"nextCursor":null,"contractVersion":"2.0"}',
  hiddenHoldings:
    '{"status":"hidden","reasonCode":null,"totalUsd":null,"items":[],"observedAt":null,"contractVersion":"2.0"}',
  hiddenTrades:
    '{"status":"hidden","reasonCode":null,"items":[],"nextCursor":null,"contractVersion":"2.0"}',
  unboundHoldings:
    '{"status":"unavailable","reasonCode":"WALLET_NOT_BOUND","totalUsd":null,"items":[],"observedAt":null,"contractVersion":"2.0"}',
  unboundTrades:
    '{"status":"unavailable","reasonCode":"WALLET_NOT_BOUND","items":[],"nextCursor":null,"contractVersion":"2.0"}',
  notIndexedTrades:
    '{"status":"unavailable","reasonCode":"BSC_INDEXER_NOT_STARTED","items":[],"nextCursor":null,"contractVersion":"2.0"}',
} as const;

describe("LOOP API V2 public profile communities and launch2 merge (Decision 0169)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies = fakes(),
    emit: "on" | "off" | "unset" = "unset",
    options: {
      readonly withWallet?: boolean;
      readonly env?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        V2_MODULES_ENABLED: "community,wallet",
        V2_CURSOR_HMAC_SECRET: cursorSecret,
        STREAM_TOKEN_QUOTA_HMAC_SECRET: quotaSecret,
        PRIVY_APP_ID: "app_test",
        PRIVY_APP_SECRET: "secret_test",
        LAUNCH_CHAIN_ID: "97",
        DATABASE_URL:
          "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
        ...(emit === "unset" ? {} : { PROFILE_LAUNCH2_EMIT: emit }),
        ...options.env,
      }),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      launchChainReadClient: dependencies.launchChainReadClient,
      launch2Service: {
        listAddressHoldings: dependencies.listAddressHoldings,
      } as unknown as Launch2Service,
      ...(options.withWallet === false
        ? {}
        : {
            walletReadService: {
              getBalances: dependencies.getBalances,
            } as unknown as WalletReadService,
          }),
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  async function get(app: FastifyInstance, path: string) {
    return app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}${path}`,
      headers: headers(),
    });
  }

  describe("PROFILE_LAUNCH2_EMIT off (default)", () => {
    for (const emit of ["unset", "off"] as const) {
      it(`keeps holdings and trades byte-identical to before (${emit})`, async () => {
        const dependencies = fakes();
        const { app } = await createApp(dependencies, emit);
        expect((await get(app, "/holdings")).body).toBe(baseline.holdings);
        const first = await get(app, "/trades?limit=2");
        expect(maskCursor(first.body)).toBe(baseline.tradesFirst);
        const cursor = first.json<{ nextCursor: string }>().nextCursor;
        expect(
          (
            await get(
              app,
              `/trades?limit=2&cursor=${encodeURIComponent(cursor)}`,
            )
          ).body,
        ).toBe(baseline.tradesSecond);
        // Nothing new is read.
        expect(dependencies.listAddressHoldings).not.toHaveBeenCalled();
        expect(dependencies.merge.getLaunch2Checkpoint).not.toHaveBeenCalled();
        expect(dependencies.merge.listLaunch2Activity).not.toHaveBeenCalled();
        expect(dependencies.repository.listTradesByTime).not.toHaveBeenCalled();
        expect(dependencies.launchHeadRead).not.toHaveBeenCalled();

        const hidden = fakes();
        hidden.repository.findProfile.mockResolvedValue(
          record({
            visibility: {
              totalAssets: "self",
              tradeHistory: "self",
              communities: "self",
            },
          }),
        );
        const hiddenApp = await createApp(hidden, emit);
        expect((await get(hiddenApp.app, "/holdings")).body).toBe(
          baseline.hiddenHoldings,
        );
        expect((await get(hiddenApp.app, "/trades")).body).toBe(
          baseline.hiddenTrades,
        );
        const unbound = fakes();
        unbound.repository.getActiveWallet.mockResolvedValue(null);
        const unboundApp = await createApp(unbound, emit);
        expect((await get(unboundApp.app, "/holdings")).body).toBe(
          baseline.unboundHoldings,
        );
        expect((await get(unboundApp.app, "/trades")).body).toBe(
          baseline.unboundTrades,
        );
        const notIndexed = fakes();
        notIndexed.repository.hasTransferCheckpoint.mockResolvedValue(false);
        const notIndexedApp = await createApp(notIndexed, emit);
        expect((await get(notIndexedApp.app, "/trades")).body).toBe(
          baseline.notIndexedTrades,
        );
      });
    }
  });

  describe("PROFILE_LAUNCH2_EMIT on: holdings", () => {
    const launch2HoldingKeys = [
      "kind",
      "chainId",
      "instanceId",
      "ticker",
      "name",
      "logoUrl",
      "amountMeme",
      "nftCount",
      "stage",
      "valueUsd1",
    ];

    it("appends the owner's Launch-chain MEME and NFT holdings and the launch2 block", async () => {
      const dependencies = fakes();
      const { app } = await createApp(dependencies, "on");
      const response = await get(app, "/holdings");
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        items: Record<string, unknown>[];
      }>();
      expect(body).toEqual({
        status: "available",
        reasonCode: null,
        totalUsd: "312.25",
        items: [
          {
            assetId: usdt,
            symbol: "USDT",
            name: "USDT",
            logoUrl: "https://logo.test/x.png",
            balance: "12",
            usdValue: "12",
          },
          {
            assetId: wbnb,
            symbol: "WBNB",
            name: "WBNB",
            logoUrl: "https://logo.test/x.png",
            balance: "0.5",
            usdValue: "300.25",
          },
          {
            kind: "launch2_meme",
            chainId: "eip155:97",
            instanceId: windId,
            ticker: "WIND",
            name: "Evening Wind",
            logoUrl: "https://example.com/wind.png",
            amountMeme: "900",
            nftCount: null,
            stage: "public",
            valueUsd1: "9.18",
          },
          {
            kind: "launch2_nft",
            chainId: "eip155:97",
            instanceId: windId,
            ticker: "WIND",
            name: "Evening Wind",
            logoUrl: "https://example.com/wind.png",
            amountMeme: null,
            nftCount: 1,
            stage: "public",
            valueUsd1: null,
          },
          {
            kind: "launch2_meme",
            chainId: "eip155:97",
            instanceId: moonId,
            ticker: "MOON",
            name: "Moon",
            logoUrl: null,
            amountMeme: "292",
            nftCount: null,
            stage: "graduated",
            valueUsd1: "14.6",
          },
        ],
        observedAt: "2026-10-08T00:00:01.000Z",
        launch2: {
          status: "available",
          chainId: "eip155:97",
          indexerBlockNumber: "52000050",
          headBlockNumber: launchHead.toString(),
        },
        contractVersion: "2.0",
      });
      for (const item of body.items.slice(2)) {
        expect(Object.keys(item)).toEqual(launch2HoldingKeys);
      }
      // The primary rows keep their exact keys and order.
      expect(response.body.startsWith(baseline.holdings.slice(0, 40))).toBe(
        true,
      );
      expect(response.body).not.toContain(walletAddress);
      expect(dependencies.listAddressHoldings).toHaveBeenCalledWith({
        address: walletAddress,
      });
      expect(dependencies.merge.getLaunch2Checkpoint).toHaveBeenCalledWith(
        "eip155:97",
      );
    });

    it("never reads launch2 for a hidden or unbound profile, and shows the owner their own", async () => {
      const hidden = fakes();
      hidden.repository.findProfile.mockResolvedValue(
        record({
          visibility: {
            totalAssets: "self",
            tradeHistory: "self",
            communities: "everyone",
          },
        }),
      );
      const hiddenApp = await createApp(hidden, "on");
      expect((await get(hiddenApp.app, "/holdings")).body).toBe(
        baseline.hiddenHoldings,
      );
      expect((await get(hiddenApp.app, "/trades")).body).toBe(
        baseline.hiddenTrades,
      );
      expect(hidden.listAddressHoldings).not.toHaveBeenCalled();
      expect(hidden.merge.listLaunch2Activity).not.toHaveBeenCalled();

      const unbound = fakes();
      unbound.repository.getActiveWallet.mockResolvedValue(null);
      const unboundApp = await createApp(unbound, "on");
      expect((await get(unboundApp.app, "/holdings")).body).toBe(
        baseline.unboundHoldings,
      );
      expect((await get(unboundApp.app, "/trades")).body).toBe(
        baseline.unboundTrades,
      );
      expect(unbound.listAddressHoldings).not.toHaveBeenCalled();

      const self = fakes();
      self.repository.findProfile.mockResolvedValue(
        record({
          targetUserId: viewerId,
          visibility: {
            totalAssets: "self",
            tradeHistory: "self",
            communities: "self",
          },
        }),
      );
      const selfApp = await createApp(self, "on");
      const own = (await get(selfApp.app, "/holdings")).json<{
        items: unknown[];
        launch2: unknown;
      }>();
      expect(own.items).toHaveLength(5);
      expect(own.launch2).toMatchObject({ status: "available" });
    });

    it("reports each launch2 failure in the block and keeps the primary rows", async () => {
      const cases = [
        [fakes({ checkpoint: null }), "LAUNCH2_INDEXER_NOT_STARTED"],
        [
          fakes({ checkpoint: new Error("db") }),
          "LAUNCH2_HOLDINGS_READ_FAILED",
        ],
        [
          fakes({ holdingsError: new Error("rpc") }),
          "LAUNCH2_HOLDINGS_READ_FAILED",
        ],
        [fakes({ withMerge: false }), "LAUNCH2_REPOSITORY_UNAVAILABLE"],
      ] as const;
      for (const [dependencies, reasonCode] of cases) {
        const { app } = await createApp(dependencies, "on");
        const response = await get(app, "/holdings");
        expect(response.statusCode).toBe(200);
        const body = response.json<{
          items: unknown[];
          launch2: unknown;
          status: string;
        }>();
        expect(body.status).toBe("available");
        expect(body.items).toHaveLength(2);
        expect(body.launch2).toEqual({ status: "unavailable", reasonCode });
      }
    });

    it("keeps the launch2 rows when the primary chain is unreadable, and an unreadable balance emits no MEME row", async () => {
      const dependencies = fakes();
      dependencies.getBalances.mockRejectedValue(
        V2ApiError.capabilityUnavailable(),
      );
      dependencies.listAddressHoldings.mockResolvedValue([
        holdings[1]!,
        { ...holdings[0]!, memeRaw: null },
      ]);
      const { app } = await createApp(dependencies, "on");
      expect((await get(app, "/holdings")).json()).toEqual({
        status: "unavailable",
        reasonCode: "BSC_READ_UNAVAILABLE",
        totalUsd: null,
        items: [
          {
            kind: "launch2_meme",
            chainId: "eip155:97",
            instanceId: moonId,
            ticker: "MOON",
            name: "Moon",
            logoUrl: null,
            amountMeme: "292",
            nftCount: null,
            stage: "graduated",
            valueUsd1: "14.6",
          },
          {
            kind: "launch2_nft",
            chainId: "eip155:97",
            instanceId: windId,
            ticker: "WIND",
            name: "Evening Wind",
            logoUrl: "https://example.com/wind.png",
            amountMeme: null,
            nftCount: 1,
            stage: "public",
            valueUsd1: null,
          },
        ],
        observedAt: null,
        launch2: {
          status: "available",
          chainId: "eip155:97",
          indexerBlockNumber: "52000050",
          headBlockNumber: launchHead.toString(),
        },
        contractVersion: "2.0",
      });

      // Without the wallet runtime the primary leg is unavailable as before.
      const noRuntime = fakes();
      const noRuntimeApp = await createApp(noRuntime, "on", {
        withWallet: false,
      });
      const body = (await get(noRuntimeApp.app, "/holdings")).json<{
        reasonCode: string;
        items: unknown[];
      }>();
      expect(body.reasonCode).toBe("WALLET_RUNTIME_UNAVAILABLE");
      expect(body.items).toHaveLength(3);
    });

    it("leaves a zero balance and a missing price out of the value", async () => {
      const dependencies = fakes();
      dependencies.listAddressHoldings.mockResolvedValue([
        { ...holdings[0]!, memeRaw: 0n, nftHeld: 0 },
        { ...holdings[1]!, priceE18: 0n },
      ]);
      dependencies.launchHeadRead.mockRejectedValue(new Error("rpc"));
      const { app } = await createApp(dependencies, "on");
      const body = (await get(app, "/holdings")).json<{
        items: Record<string, unknown>[];
        launch2: unknown;
      }>();
      expect(body.items.slice(2)).toEqual([
        expect.objectContaining({
          instanceId: moonId,
          amountMeme: "292",
          valueUsd1: null,
        }),
      ]);
      expect(body.launch2).toMatchObject({ headBlockNumber: null });
    });
  });

  describe("PROFILE_LAUNCH2_EMIT on: trades", () => {
    const launch2TradeKeys = [
      "kind",
      "chainId",
      "instanceId",
      "ticker",
      "name",
      "logoUrl",
      "amountMeme",
      "amountUsd1",
      "taxUsd1",
      "transactionHash",
      "logIndex",
      "blockNumber",
      "occurredAt",
      "confirmations",
    ];
    const expectedOrder = [
      hash("a"),
      launch2Rows[4]!.transactionHash,
      launch2Rows[3]!.transactionHash,
      hash("b"),
      launch2Rows[2]!.transactionHash,
      launch2Rows[1]!.transactionHash,
      launch2Rows[0]!.transactionHash,
      hash("c"),
    ];
    const rowHash = (item: Record<string, unknown>): unknown =>
      item["txHash"] ?? item["transactionHash"];

    it("mixes the launch2 activity in by time with the Decision 0167 row shape", async () => {
      const dependencies = fakes();
      const { app } = await createApp(dependencies, "on");
      const response = await get(app, "/trades?limit=50");
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        status: string;
        reasonCode: unknown;
        items: Record<string, unknown>[];
        nextCursor: unknown;
        launch2: unknown;
      }>();
      expect(body.status).toBe("available");
      expect(body.reasonCode).toBeNull();
      expect(body.nextCursor).toBeNull();
      expect(body.items.map(rowHash)).toEqual(expectedOrder);
      expect(body.launch2).toEqual({
        status: "available",
        chainId: "eip155:97",
        indexerBlockNumber: "52000050",
        headBlockNumber: launchHead.toString(),
      });
      // Primary rows are the very objects of the unmerged list.
      const before = JSON.parse(baseline.tradesFirst) as {
        items: unknown[];
      };
      expect(body.items[0]).toEqual(before.items[0]);
      expect(body.items[3]).toEqual(before.items[1]);
      expect(body.items[1]).toEqual({
        kind: "launch2_pool_sell",
        chainId: "eip155:97",
        instanceId: moonId,
        ticker: "MOON",
        name: "Moon",
        logoUrl: null,
        amountMeme: "100",
        amountUsd1: "4.8",
        taxUsd1: "0.2",
        transactionHash: launch2Rows[4]!.transactionHash,
        logIndex: 1,
        blockNumber: "52000040",
        occurredAt: "2026-10-19T11:10:00.000Z",
        confirmations: Number(launchHead + 1n - 52_000_040n),
      });
      for (const index of [1, 2, 4, 5, 6]) {
        expect(Object.keys(body.items[index]!)).toEqual(launch2TradeKeys);
      }
      expect(response.body).not.toContain(walletAddress);
      expect(dependencies.repository.listTrades).not.toHaveBeenCalled();
    });

    it("walks the same rows once at every page size", async () => {
      const { app } = await createApp(fakes(), "on");
      for (const size of [1, 2, 3, 7, 8]) {
        const seen: unknown[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page += 1) {
          const response = await get(
            app,
            `/trades?limit=${size}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
          );
          expect(response.statusCode).toBe(200);
          const body = response.json<{
            items: Record<string, unknown>[];
            nextCursor: string | null;
          }>();
          expect(body.items.length).toBeLessThanOrEqual(size);
          seen.push(...body.items.map(rowHash));
          cursor = body.nextCursor;
          if (cursor === null) break;
        }
        expect(seen, `limit=${size}`).toEqual(expectedOrder);
      }
    });

    it("refuses a cursor of the other mode", async () => {
      const offApp = await createApp(fakes(), "off");
      const offCursor = (await get(offApp.app, "/trades?limit=1")).json<{
        nextCursor: string;
      }>().nextCursor;
      const onApp = await createApp(fakes(), "on");
      const onCursor = (await get(onApp.app, "/trades?limit=1")).json<{
        nextCursor: string;
      }>().nextCursor;
      expectEnvelope(
        await get(onApp.app, `/trades?cursor=${encodeURIComponent(offCursor)}`),
        400,
        "INVALID_REQUEST",
      );
      expectEnvelope(
        await get(offApp.app, `/trades?cursor=${encodeURIComponent(onCursor)}`),
        400,
        "INVALID_REQUEST",
      );
    });

    it("settles the launch2 leg on its own and keeps primary status semantics", async () => {
      for (const [dependencies, reasonCode] of [
        [fakes({ checkpoint: null }), "LAUNCH2_INDEXER_NOT_STARTED"],
        [
          fakes({ checkpoint: new Error("db") }),
          "LAUNCH2_ACTIVITY_READ_FAILED",
        ],
        [
          fakes({ launch2Error: new Error("db") }),
          "LAUNCH2_ACTIVITY_READ_FAILED",
        ],
        [fakes({ withMerge: false }), "LAUNCH2_REPOSITORY_UNAVAILABLE"],
      ] as const) {
        const { app } = await createApp(dependencies, "on");
        const body = (await get(app, "/trades")).json<{
          status: string;
          items: Record<string, unknown>[];
          launch2: unknown;
        }>();
        expect(body.status).toBe("available");
        expect(body.items.map(rowHash)).toEqual([
          hash("a"),
          hash("b"),
          hash("c"),
        ]);
        expect(body.launch2).toEqual({ status: "unavailable", reasonCode });
      }

      // Primary indexer not started: status says so, launch2 rows stand.
      const notIndexed = fakes();
      notIndexed.repository.hasTransferCheckpoint.mockResolvedValue(false);
      const notIndexedApp = await createApp(notIndexed, "on");
      const body = (await get(notIndexedApp.app, "/trades")).json<{
        status: string;
        reasonCode: string;
        items: Record<string, unknown>[];
      }>();
      expect(body.status).toBe("unavailable");
      expect(body.reasonCode).toBe("BSC_INDEXER_NOT_STARTED");
      expect(body.items.map((item) => item["kind"])).toEqual([
        "launch2_pool_sell",
        "launch2_pool_buy",
        "launch2_curve_sell",
        "launch2_curve_buy",
        "launch2_nft_mint",
      ]);
      expect(notIndexed.repository.listTradesByTime).not.toHaveBeenCalled();

      // An unreadable Launch head: confirmations and head are null.
      const headless = fakes();
      headless.launchHeadRead.mockRejectedValue(new Error("rpc"));
      const headlessApp = await createApp(headless, "on");
      const headlessBody = (await get(headlessApp.app, "/trades")).json<{
        items: Record<string, unknown>[];
        launch2: unknown;
      }>();
      expect(headlessBody.items[1]).toMatchObject({ confirmations: null });
      expect(headlessBody.launch2).toMatchObject({ headBlockNumber: null });
    });

    it("applies tradeHistory to everyone but the owner, friend or not", async () => {
      for (const friendship of ["friends", "none"] as const) {
        const hidden = fakes();
        hidden.repository.findProfile.mockResolvedValue(
          record({
            relationship: {
              following: true,
              followedBy: true,
              friendship,
              blocked: false,
              blockedBy: false,
            },
            visibility: {
              totalAssets: "everyone",
              tradeHistory: "self",
              communities: "everyone",
            },
          }),
        );
        const { app } = await createApp(hidden, "on");
        expect((await get(app, "/trades")).body).toBe(baseline.hiddenTrades);
        expect(hidden.merge.listLaunch2Activity).not.toHaveBeenCalled();
      }
      const self = fakes();
      self.repository.findProfile.mockResolvedValue(
        record({
          targetUserId: viewerId,
          visibility: {
            totalAssets: "self",
            tradeHistory: "self",
            communities: "self",
          },
        }),
      );
      const { app } = await createApp(self, "on");
      expect(
        (await get(app, "/trades")).json<{ items: unknown[] }>().items,
      ).toHaveLength(8);
    });
  });

  describe("GET /v2/profiles/{id}/communities", () => {
    it("adds label to every row only with COMMUNITY_LABEL_EMIT on (Decision 0175)", async () => {
      const labelled = communities.map((item, index) => ({
        ...item,
        label: index === 0 ? "共识社区" : null,
      }));
      for (const emit of ["off", "on"] as const) {
        const dependencies = fakes();
        dependencies.repository.listProfileCommunities.mockResolvedValue({
          items: labelled,
          hasMore: false,
        });
        const { app } = await createApp(dependencies, "unset", {
          env: { COMMUNITY_LABEL_EMIT: emit },
        });
        const response = await get(app, "/communities");
        expect(response.statusCode).toBe(200);
        const items = response.json<{ items: Record<string, unknown>[] }>()
          .items;
        if (emit === "off") {
          expect(response.body).not.toContain('"label"');
          expect(response.body).not.toContain("共识社区");
        } else {
          expect(items.map((item) => item["label"])).toEqual([
            "共识社区",
            null,
            null,
          ]);
          expect(items[0]).toMatchObject({ verificationStatus: "verified" });
        }
      }
    });

    it("lists the joined communities newest first with an opaque cursor", async () => {
      const dependencies = fakes();
      const { app } = await createApp(dependencies);
      const all = await get(app, "/communities");
      expect(all.statusCode).toBe(200);
      expect(all.headers["cache-control"]).toBe("no-store");
      expect(all.json()).toEqual({
        status: "available",
        items: communities.map((item) => ({
          communityId: item.communityId,
          name: item.name,
          slug: item.slug,
          logoRef: item.logoRef,
          memberCount: item.memberCount,
          verificationStatus: item.verificationStatus,
          joinedAt: item.joinedAt,
        })),
        nextCursor: null,
        contractVersion: "2.0",
      });
      expect(Object.keys(all.json<{ items: object[] }>().items[0]!)).toEqual([
        "communityId",
        "name",
        "slug",
        "logoRef",
        "memberCount",
        "verificationStatus",
        "joinedAt",
      ]);
      expect(
        dependencies.repository.listProfileCommunities,
      ).toHaveBeenCalledWith({
        ownerUserId: targetUserId,
        limit: 20,
        before: undefined,
      });

      const first = await get(app, "/communities?limit=2");
      const firstBody = first.json<{
        items: { communityId: string }[];
        nextCursor: string;
      }>();
      expect(firstBody.items.map((item) => item.communityId)).toEqual([
        communities[0]!.communityId,
        communities[1]!.communityId,
      ]);
      expect(firstBody.nextCursor).toEqual(expect.any(String));
      // Later pages carry only the cursor and keep the first page's size.
      const second = await get(
        app,
        `/communities?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      );
      expect(
        dependencies.repository.listProfileCommunities,
      ).toHaveBeenLastCalledWith({
        ownerUserId: targetUserId,
        limit: 2,
        before: {
          joinedAtMicros: communities[1]!.joinedAtMicros,
          communityId: communities[1]!.communityId,
        },
      });
      expect(second.json()).toMatchObject({
        status: "available",
        items: [{ communityId: communities[2]!.communityId }],
        nextCursor: null,
      });
      // The cursor is bound to its route: trades refuse it.
      expectEnvelope(
        await get(
          app,
          `/trades?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        ),
        400,
        "INVALID_REQUEST",
      );
    });

    it("never sends a logo reference the App cannot render", async () => {
      const dependencies = fakes();
      dependencies.repository.listProfileCommunities.mockResolvedValue({
        items: [{ ...communities[0]!, logoRef: "https://evil.example/x.png" }],
        hasMore: false,
      });
      const { app } = await createApp(dependencies);
      expect((await get(app, "/communities")).json()).toMatchObject({
        items: [{ logoRef: null, verificationStatus: "verified" }],
      });
    });

    it("hides the list unless visibility is everyone, friend or not; the owner always sees it", async () => {
      for (const friendship of ["friends", "pending_out", "none"] as const) {
        for (const [communitiesVisibility, visible] of [
          ["self", false],
          ["everyone", true],
        ] as const) {
          const dependencies = fakes();
          dependencies.repository.findProfile.mockResolvedValue(
            record({
              relationship: {
                following: false,
                followedBy: false,
                friendship,
                blocked: false,
                blockedBy: false,
              },
              visibility: {
                totalAssets: "everyone",
                tradeHistory: "everyone",
                communities: communitiesVisibility,
              },
            }),
          );
          const { app } = await createApp(dependencies);
          const response = await get(app, "/communities");
          expect(response.statusCode).toBe(200);
          if (visible) {
            expect(response.json()).toMatchObject({ status: "available" });
          } else {
            expect(response.body).toBe(
              '{"status":"unavailable","reasonCode":"PROFILE_COMMUNITIES_HIDDEN","contractVersion":"2.0"}',
            );
            expect(
              dependencies.repository.listProfileCommunities,
            ).not.toHaveBeenCalled();
          }
        }
      }
      const self = fakes();
      self.repository.findProfile.mockResolvedValue(
        record({
          targetUserId: viewerId,
          visibility: {
            totalAssets: "self",
            tradeHistory: "self",
            communities: "self",
          },
        }),
      );
      const { app } = await createApp(self);
      expect((await get(app, "/communities")).json()).toMatchObject({
        status: "available",
        items: [{}, {}, {}],
      });
    });

    it("answers 404 for a missing or blocking profile and 400 for a bad page", async () => {
      const missing = fakes();
      missing.repository.findProfile.mockResolvedValue(null);
      const missingApp = await createApp(missing);
      expectEnvelope(
        await get(missingApp.app, "/communities"),
        404,
        "PROFILE_NOT_FOUND",
      );
      const blocking = fakes();
      blocking.repository.findProfile.mockResolvedValue(
        record({
          relationship: {
            following: false,
            followedBy: false,
            friendship: "none",
            blocked: false,
            blockedBy: true,
          },
        }),
      );
      const blockingApp = await createApp(blocking);
      expectEnvelope(
        await get(blockingApp.app, "/communities"),
        404,
        "PROFILE_NOT_FOUND",
      );
      const { app } = await createApp();
      for (const query of [
        "?limit=0",
        "?limit=51",
        "?cursor=garbage",
        "?other=1",
      ]) {
        expectEnvelope(
          await get(app, `/communities${query}`),
          400,
          "INVALID_REQUEST",
        );
      }
      const unavailable = fakes();
      unavailable.repository.listProfileCommunities.mockRejectedValue(
        new (
          await import("../src/features/profile/public-profile-repository.js")
        ).PublicProfileRepositoryUnavailableError(),
      );
      const unavailableApp = await createApp(unavailable);
      expectEnvelope(
        await get(unavailableApp.app, "/communities"),
        503,
        "CAPABILITY_UNAVAILABLE",
      );
    });
  });
});
