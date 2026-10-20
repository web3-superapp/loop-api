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
import {
  PublicProfileIdempotencyConflictError,
  PublicProfileTargetNotFoundError,
  type PublicProfileRecord,
  type PublicProfileRepository,
  type TradeRow,
} from "../src/features/profile/public-profile-repository.js";
import { tradeEventId } from "../src/features/profile/public-profile-service.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type {
  WalletBalancesResource,
  WalletReadService,
} from "../src/features/wallet/wallet-read-service.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

/** Decision 0095: public profiles, holdings, trades, friend removal, recommended. */

const viewerId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const targetUserId = "f7bf09f6-0171-46b9-9acd-5ad494f211bd";
const targetProfileId = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const walletId = "11111111-2222-4333-8444-555555555555";
const walletAddress = "0x00000000000000000000000000000000000000aa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cursorSecret = "c".repeat(48);
const quotaSecret = "q".repeat(48);
const token = "eip155:56:0x1111111111111111111111111111111111111111";
const usdt = "eip155:56:0x55d398326f99059ff775485246999027b3197955";
const wbnb = "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const txA = `0x${"a".repeat(64)}`;
const txB = `0x${"b".repeat(64)}`;
const txC = `0x${"c".repeat(64)}`;
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];

function record(
  overrides: Partial<PublicProfileRecord> = {},
): PublicProfileRecord {
  return {
    targetUserId,
    publicProfileId: targetProfileId,
    loopId: "LOOP-7HJKMNPQ",
    alias: "frog_maxi",
    avatarRef: "avatar:media/22222222-2222-4222-8222-222222222222",
    bio: "gm",
    joinedAt: "2026-09-07T01:00:00.000Z",
    counts: { followers: 3, following: 2, communities: 1 },
    relationship: {
      following: true,
      followedBy: false,
      friendship: "pending_out",
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

function asset(assetId: string, symbol: string, decimals: number): AssetRecord {
  return {
    assetId,
    chainId: "eip155:56",
    address: assetId.split(":")[2] ?? null,
    symbol,
    name: symbol,
    decimals,
    status: "verified",
    sourceKind: "chain_call",
    sourceBlockNumber: "1",
    sourceVerifiedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const assets = new Map([
  [token, asset(token, "FROG", 18)],
  [usdt, asset(usdt, "USDT", 18)],
  [wbnb, asset(wbnb, "WBNB", 18)],
]);

const trades: TradeRow[] = [
  {
    source: "swap",
    transactionHash: txA,
    logIndex: 5,
    blockNumber: "300",
    blockTimestamp: "2026-10-01T00:00:00.000Z",
    token0AssetId: token,
    token1AssetId: usdt,
    amount0: "-2500000000000000000",
    amount1: "10000000000000000000",
  },
  {
    source: "swap",
    transactionHash: txB,
    logIndex: 1,
    blockNumber: "200",
    blockTimestamp: "2026-09-30T00:00:00.000Z",
    token0AssetId: wbnb,
    token1AssetId: token,
    amount0: "-1000000000000000000",
    amount1: "4000000000000000000",
  },
  {
    source: "transfer",
    transactionHash: txC,
    logIndex: 0,
    blockNumber: "100",
    blockTimestamp: null,
    assetId: usdt,
    direction: "in",
    rawValue: "1500000000000000000",
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

function fakes() {
  const repository = {
    findProfile: vi.fn<PublicProfileRepository["findProfile"]>(() =>
      Promise.resolve(record()),
    ),
    getActiveWallet: vi.fn<PublicProfileRepository["getActiveWallet"]>(() =>
      Promise.resolve({ walletId, address: walletAddress }),
    ),
    hasTransferCheckpoint: vi.fn(() => Promise.resolve(true)),
    listTrades: vi.fn<PublicProfileRepository["listTrades"]>((input) => {
      const start =
        input.before === undefined
          ? 0
          : trades.findIndex(
              (row) =>
                BigInt(row.blockNumber) <
                BigInt(input.before?.blockNumber ?? "0"),
            );
      const page = trades.slice(start, start + input.limit);
      return Promise.resolve({
        items: page,
        hasMore: start + input.limit < trades.length,
      });
    }),
    listTradesByTime: vi.fn<PublicProfileRepository["listTradesByTime"]>(() =>
      Promise.reject(new Error("PROFILE_LAUNCH2_EMIT is off")),
    ),
    listProfileCommunities: vi.fn<
      PublicProfileRepository["listProfileCommunities"]
    >(() => Promise.resolve({ items: [], hasMore: false })),
    removeFriend: vi.fn<PublicProfileRepository["removeFriend"]>(() =>
      Promise.resolve({ publicProfileId: targetProfileId, removed: true }),
    ),
    listVerifiedCommunitiesByIds: vi.fn<
      PublicProfileRepository["listVerifiedCommunitiesByIds"]
    >((ids) =>
      Promise.resolve(
        ids.map((communityId, index) => ({
          communityId,
          name: `Community ${index}`,
          slug: `community-${index}`,
          description: null,
          logoRef: null,
          verificationStatus: "verified" as const,
          boundAssetKey: null,
          memberCount: index,
          createdAt: "2026-09-01T00:00:00.000Z",
          configVersion: "communityV1",
        })),
      ),
    ),
  } satisfies PublicProfileRepository;
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
  return { database, repository, getBalances, privyAccessTokenVerifier };
}

function headers(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    authorization: "Bearer header.payload.signature",
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete result[name];
    } else {
      result[name] = value;
    }
  }
  return result;
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

describe("LOOP API V2 public profiles (Decision 0095)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies = fakes(),
    overrides: Readonly<Record<string, string>> = {},
    withWallet = true,
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
        DATABASE_URL:
          "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
        ...overrides,
      }),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      ...(withWallet
        ? {
            walletReadService: {
              getBalances: dependencies.getBalances,
            } as unknown as WalletReadService,
          }
        : {}),
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("projects a public profile by ID and by case-insensitive LOOP ID", async () => {
    const { app, repository } = await createApp();
    const byId = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}`,
      headers: headers(),
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.headers["cache-control"]).toBe("no-store");
    expect(byId.json()).toEqual({
      publicProfileId: targetProfileId,
      loopId: "LOOP-7HJKMNPQ",
      alias: "frog_maxi",
      avatarRef: "avatar:media/22222222-2222-4222-8222-222222222222",
      bio: "gm",
      joinedAt: "2026-09-07T01:00:00.000Z",
      counts: { followers: 3, following: 2, communities: 1 },
      relationship: {
        following: true,
        followedBy: false,
        friendship: "pending_out",
        blocked: false,
        blockedBy: false,
      },
      visibility: { holdings: true, trades: true },
      contractVersion: "2.0",
    });
    expect(byId.body).not.toContain(targetUserId);
    expect(repository.findProfile).toHaveBeenCalledWith({
      viewerUserId: viewerId,
      lookup: { publicProfileId: targetProfileId },
    });

    const byLoopId = await app.inject({
      method: "GET",
      url: "/v2/profiles/by-loop-id/loop-7hjkmnpq",
      headers: headers(),
    });
    expect(byLoopId.statusCode).toBe(200);
    expect(repository.findProfile).toHaveBeenLastCalledWith({
      viewerUserId: viewerId,
      lookup: { loopId: "LOOP-7HJKMNPQ" },
    });

    // A well-formed ID outside the LOOP alphabet names nobody.
    const impossible = await app.inject({
      method: "GET",
      url: "/v2/profiles/by-loop-id/LOOP-IIIIIIII",
      headers: headers(),
    });
    expectEnvelope(impossible, 404, "PROFILE_NOT_FOUND");
  });

  it("answers 404 PROFILE_NOT_FOUND for a missing profile and when the target blocked the viewer", async () => {
    const dependencies = fakes();
    dependencies.repository.findProfile.mockResolvedValueOnce(null);
    dependencies.repository.findProfile.mockResolvedValue(
      record({
        relationship: {
          following: false,
          followedBy: false,
          friendship: "friends",
          blocked: false,
          blockedBy: true,
        },
      }),
    );
    const { app, getBalances } = await createApp(dependencies);
    for (const url of [
      `/v2/profiles/${targetProfileId}`,
      `/v2/profiles/${targetProfileId}`,
      `/v2/profiles/${targetProfileId}/holdings`,
      `/v2/profiles/${targetProfileId}/trades`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: headers(),
      });
      expectEnvelope(response, 404, "PROFILE_NOT_FOUND");
    }
    expect(getBalances).not.toHaveBeenCalled();
  });

  it("lists held assets with USD values from the owner's active wallet and never the address", async () => {
    const { app, getBalances } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/holdings`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
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
      ],
      observedAt: "2026-10-08T00:00:01.000Z",
      contractVersion: "2.0",
    });
    expect(response.body).not.toContain(walletAddress);
    expect(getBalances.mock.calls[0]?.[0]).toMatchObject({
      principal: { userId: targetUserId },
      walletId,
    });
  });

  it("reports hidden, unbound, unreadable, and uncomposed holdings without a zero", async () => {
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
    const hiddenApp = await createApp(hidden);
    for (const path of ["holdings", "trades"]) {
      const response = await hiddenApp.app.inject({
        method: "GET",
        url: `/v2/profiles/${targetProfileId}/${path}`,
        headers: headers(),
      });
      expect(response.json()).toMatchObject({
        status: "hidden",
        reasonCode: null,
        items: [],
      });
    }
    expect(hidden.getBalances).not.toHaveBeenCalled();

    // The owner always sees their own data.
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
    const selfApp = await createApp(self);
    const own = await selfApp.app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/holdings`,
      headers: headers(),
    });
    expect(own.json()).toMatchObject({ status: "available" });

    const unbound = fakes();
    unbound.repository.getActiveWallet.mockResolvedValue(null);
    const unboundApp = await createApp(unbound);
    const noWallet = await unboundApp.app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/holdings`,
      headers: headers(),
    });
    expect(noWallet.json()).toEqual({
      status: "unavailable",
      reasonCode: "WALLET_NOT_BOUND",
      totalUsd: null,
      items: [],
      observedAt: null,
      contractVersion: "2.0",
    });

    const chainDown = fakes();
    chainDown.getBalances.mockRejectedValue(V2ApiError.capabilityUnavailable());
    const chainApp = await createApp(chainDown);
    const unreadable = await chainApp.app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/holdings`,
      headers: headers(),
    });
    expect(unreadable.json()).toMatchObject({
      status: "unavailable",
      reasonCode: "BSC_READ_UNAVAILABLE",
      totalUsd: null,
      items: [],
    });

    const noRuntime = await createApp(
      fakes(),
      { V2_MODULES_ENABLED: "community" },
      false,
    );
    const uncomposed = await noRuntime.app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/holdings`,
      headers: headers(),
    });
    expect(uncomposed.json()).toMatchObject({
      status: "unavailable",
      reasonCode: "WALLET_RUNTIME_UNAVAILABLE",
    });
  });

  it("classifies swaps as buy/sell of the non-quote token and pages with an opaque cursor", async () => {
    const { app } = await createApp();
    const first = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/trades?limit=2`,
      headers: headers(),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      status: string;
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(page.status).toBe("available");
    expect(page.items).toEqual([
      {
        eventId: tradeEventId("eip155:56", txA, 5),
        kind: "buy",
        assetId: token,
        symbol: "FROG",
        amount: "2.5",
        usdValue: "10",
        blockTimestamp: "2026-10-01T00:00:00.000Z",
        blockNumber: "300",
        txHash: txA,
      },
      {
        eventId: tradeEventId("eip155:56", txB, 1),
        kind: "sell",
        assetId: token,
        symbol: "FROG",
        amount: "4",
        usdValue: null,
        blockTimestamp: "2026-09-30T00:00:00.000Z",
        blockNumber: "200",
        txHash: txB,
      },
    ]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(first.body).not.toContain(walletAddress);

    const second = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/trades?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
      headers: headers(),
    });
    expect(second.json()).toMatchObject({
      status: "available",
      nextCursor: null,
      items: [
        {
          kind: "transfer_in",
          assetId: usdt,
          amount: "1.5",
          usdValue: "1.5",
          blockTimestamp: null,
          blockNumber: "100",
        },
      ],
    });

    const forged = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/trades?cursor=forged`,
      headers: headers(),
    });
    expectEnvelope(forged, 400, "INVALID_REQUEST");
    const tooMany = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/trades?limit=51`,
      headers: headers(),
    });
    expectEnvelope(tooMany, 400, "INVALID_REQUEST");
  });

  it("reports trades unavailable before the indexer starts or without a wallet", async () => {
    const notStarted = fakes();
    notStarted.repository.hasTransferCheckpoint.mockResolvedValue(false);
    const { app } = await createApp(notStarted);
    const response = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}/trades`,
      headers: headers(),
    });
    expect(response.json()).toEqual({
      status: "unavailable",
      reasonCode: "BSC_INDEXER_NOT_STARTED",
      items: [],
      nextCursor: null,
      contractVersion: "2.0",
    });
    expect(notStarted.repository.listTrades).not.toHaveBeenCalled();
  });

  it("removes a friend idempotently with the write headers", async () => {
    const { app, repository } = await createApp();
    const response = await app.inject({
      method: "DELETE",
      url: `/v2/friends/${targetProfileId}`,
      headers: headers({ "idempotency-key": idempotencyKey }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      publicProfileId: targetProfileId,
      friendship: "none",
      removed: true,
      contractVersion: "2.0",
    });
    expect(repository.removeFriend.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId: viewerId,
      targetPublicProfileId: targetProfileId,
      idempotencyKey,
      requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });

    const missingKey = await app.inject({
      method: "DELETE",
      url: `/v2/friends/${targetProfileId}`,
      headers: headers(),
    });
    expectEnvelope(missingKey, 400, "INVALID_REQUEST");

    repository.removeFriend.mockRejectedValueOnce(
      new PublicProfileIdempotencyConflictError(),
    );
    const conflict = await app.inject({
      method: "DELETE",
      url: `/v2/friends/${targetProfileId}`,
      headers: headers({ "idempotency-key": idempotencyKey }),
    });
    expectEnvelope(conflict, 409, "IDEMPOTENCY_CONFLICT");

    repository.removeFriend.mockRejectedValueOnce(
      new PublicProfileTargetNotFoundError(),
    );
    const missing = await app.inject({
      method: "DELETE",
      url: `/v2/friends/${targetProfileId}`,
      headers: headers({ "idempotency-key": idempotencyKey }),
    });
    expectEnvelope(missing, 404, "NOT_FOUND");
  });

  it("lists recommended communities with the first five pre-selected, and an empty list when unset", async () => {
    const ids = Array.from(
      { length: 7 },
      (_, index) => `0000000${index}-0000-4000-8000-000000000000`,
    );
    const { app } = await createApp(fakes(), {
      RECOMMENDED_COMMUNITY_IDS: ids.join(", "),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/communities/recommended",
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: { communityId: string }[];
      defaultSelectedIds: string[];
    }>();
    expect(body.items.map((item) => item.communityId)).toEqual(ids);
    expect(body.defaultSelectedIds).toEqual(ids.slice(0, 5));

    const unset = await createApp();
    const empty = await unset.app.inject({
      method: "GET",
      url: "/v2/communities/recommended",
      headers: headers(),
    });
    expect(empty.json()).toEqual({
      items: [],
      defaultSelectedIds: [],
      contractVersion: "2.0",
    });
  });

  it("requires the bearer and the contract headers on every read", async () => {
    const { app } = await createApp();
    const anonymous = await app.inject({
      method: "GET",
      url: `/v2/profiles/${targetProfileId}`,
      headers: headers({ authorization: undefined }),
    });
    expectEnvelope(anonymous, 401, "AUTH_REQUIRED");
    const noVersion = await app.inject({
      method: "GET",
      url: "/v2/communities/recommended",
      headers: headers({ "x-loop-contract-version": undefined }),
    });
    expect(noVersion.statusCode).toBe(400);
    const badId = await app.inject({
      method: "GET",
      url: "/v2/profiles/not-a-uuid",
      headers: headers(),
    });
    expectEnvelope(badId, 400, "INVALID_REQUEST");
  });
});
