import { readFileSync } from "node:fs";

import type { FastifyInstance } from "fastify";
import { TimeoutError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import {
  AccountWalletNotFoundError,
  AccountWalletObservationEmptyError,
  AccountWalletVersionConflictError,
  type AccountWalletRecord,
  type AccountWalletRepository,
} from "../src/database/account-wallet-repository.js";
import type {
  BscIndexerRepository,
  IndexedTransferRecord,
} from "../src/database/bsc-indexer-repository.js";
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
import {
  WatchlistV2VersionConflictError,
  type WatchlistV2Group,
  type WatchlistV2Repository,
  type WatchlistV2Snapshot,
} from "../src/database/watchlist-v2-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscReadClient,
  type ChainVerificationState,
} from "../src/integrations/bsc/rpc-client.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import type { HooksLaunchFactoryReader } from "../src/features/launch/hooks-launch-deployment.js";
import type {
  CachedFact,
  MarketFactService,
} from "../src/features/market/market-fact-service.js";
import type { TokenPairsSnapshot } from "../src/integrations/market/market-data-provider.js";
import type {
  WalletNetWorthSnapshotRecord,
  WalletNetWorthSnapshotRepository,
} from "../src/database/wallet-networth-snapshot-repository.js";
import type { FiatFxRateRepository } from "../src/database/fiat-fx-rate-repository.js";
import type {
  PrivyBalanceReader,
  PrivyWalletReader,
} from "../src/integrations/privy/wallet-reader.js";
import {
  compareSortKeys,
  sortKeyOfEntry,
  type WalletActivityMergeRepository,
  type WalletActivitySortKey,
  type WalletLaunch2ActivityRecord,
  type WalletTimedTransferRecord,
} from "../src/features/wallet/wallet-activity-launch2.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const walletId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const otherWalletId = "1c3d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbAssetId = `eip155:56:${wbnb}`;
const walletAddress = "0x00000000000000000000000000000000000000a1";
const counterparty = "0x00000000000000000000000000000000000000b2";
const headNumber = 44_000_000n;
const headHash = `0x${"1".repeat(64)}`;
const launchHeadNumber = 52_000_000n;
const launchHeadHash = `0x${"9".repeat(64)}`;
const observedAt = "2026-09-08T00:00:00.000Z";

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
  sourceBlockNumber: "43000000",
  sourceVerifiedAt: observedAt,
  updatedAt: observedAt,
});

const walletRecord: AccountWalletRecord = Object.freeze({
  walletId,
  providerWalletId: "wallet_privy_1",
  address: walletAddress,
  kind: "embedded",
  status: "active",
  isActive: true,
  firstSeenAt: observedAt,
  lastSeenAt: observedAt,
});

const transferRecord: IndexedTransferRecord = Object.freeze({
  transactionHash: `0x${"7".repeat(64)}`,
  logIndex: 3,
  blockNumber: (headNumber - 100n).toString(10),
  blockHash: `0x${"2".repeat(64)}`,
  assetId: wbnbAssetId,
  fromAddress: counterparty,
  toAddress: walletAddress,
  rawValue: "1500000000000000000",
  removed: false,
  observedAt,
});

interface BalancesBody {
  readonly snapshot: { readonly blockNumber: string };
  readonly gasReservePolicy: Record<string, unknown>;
  readonly balances: readonly {
    readonly assetId: string;
    readonly balance: Record<string, unknown>;
    readonly pending: Record<string, unknown>;
    readonly valuation: Record<string, unknown>;
    readonly crossCheck: Record<string, unknown>;
  }[];
  readonly netWorth: Record<string, unknown>;
}

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "chain,wallet,watchlist",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
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
  assets: readonly AssetRecord[] = [nativeAsset, wbnbAsset],
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
    listPools: vi.fn(() => Promise.resolve([])),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

function indexerFake(options: { readonly checkpoint?: boolean } = {}) {
  const repository: BscIndexerRepository = {
    getCheckpoint: vi.fn(() =>
      Promise.resolve(
        options.checkpoint === false
          ? null
          : {
              lastBlockNumber: (headNumber - 5n).toString(10),
              lastBlockHash: `0x${"3".repeat(64)}`,
              startedFromBlockNumber: "43000000",
              approvalCoverageFromBlockNumber: "43000000",
              reorgCount: 2,
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
      Promise.resolve({ items: [transferRecord], hasMore: false }),
    ),
    sumPendingIncoming: vi.fn(() =>
      Promise.resolve([
        { assetId: wbnbAssetId, rawValue: "250000000000000000" },
      ]),
    ),
    listLatestApprovals: vi.fn(() => Promise.resolve([])),
    hasOutgoingTransferTo: vi.fn(() => Promise.resolve(false)),
    commitPoolEventSegment: vi.fn(() => Promise.reject(new Error("not used"))),
    listPoolSwaps: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
    aggregateSwapCandles: vi.fn(() => Promise.resolve([])),
  };
  return repository;
}

function walletRepositoryFake(
  options: {
    readonly setActiveError?: Error;
    readonly emptyObservation?: boolean;
  } = {},
) {
  const setActive = vi.fn(() =>
    options.setActiveError === undefined
      ? Promise.resolve([walletRecord])
      : Promise.reject(options.setActiveError),
  );
  const recordBalanceSnapshot = vi.fn(() => Promise.resolve());
  const repository: AccountWalletRepository = {
    sync: vi.fn((request: { readonly observed: readonly unknown[] }) =>
      options.emptyObservation === true && request.observed.length === 0
        ? Promise.reject(new AccountWalletObservationEmptyError())
        : Promise.resolve([walletRecord]),
    ),
    list: vi.fn(() => Promise.resolve([walletRecord])),
    get: vi.fn((_ownerUserId: string, requestedWalletId: string) =>
      Promise.resolve(requestedWalletId === walletId ? walletRecord : null),
    ),
    setActive,
    recordBalanceSnapshot,
  };
  return { repository, setActive, recordBalanceSnapshot };
}

function watchlistRepositoryFake(
  options: { readonly conflict?: boolean } = {},
) {
  let snapshot: WatchlistV2Snapshot = Object.freeze({
    version: 1,
    updatedAt: observedAt,
    groups: Object.freeze([
      Object.freeze({
        key: "default",
        name: "All",
        items: Object.freeze([{ assetId: wbnbAssetId }]),
      }),
    ]),
  });
  const replace = vi.fn(
    (input: {
      readonly expectedVersion: number;
      readonly groups: readonly WatchlistV2Group[];
    }) => {
      if (options.conflict === true) {
        return Promise.reject(new WatchlistV2VersionConflictError());
      }
      snapshot = Object.freeze({
        version: input.expectedVersion + 1,
        updatedAt: observedAt,
        groups: input.groups,
      });
      return Promise.resolve(snapshot);
    },
  );
  const repository: WatchlistV2Repository = {
    get: vi.fn(() => Promise.resolve(snapshot)),
    replace,
    listDistinctAssetIds: vi.fn(() => Promise.resolve([])),
  };
  return { repository, replace };
}

function readClientFake(
  options: {
    readonly configured?: boolean;
    readonly failTokenBalance?: boolean;
  } = {},
) {
  const configured = options.configured !== false;
  const client: BscReadClient = {
    chainId: "eip155:56",
    chainReference: 56,
    confirmations: 15,
    reorgDepthBlocks: 64,
    endpointRefs: configured ? ["rpc-abcdefabcdef"] : [],
    verifyChain: () => Promise.resolve(configured ? "verified" : "unknown"),
    currentVerification: () => (configured ? "verified" : "unknown"),
    getHead: () =>
      configured
        ? Promise.resolve({
            blockNumber: headNumber,
            blockHash: headHash,
            observedAt,
          })
        : Promise.reject(new BscReadUnavailableError("BSC_RPC_NOT_CONFIGURED")),
    getBlockHash: () => Promise.resolve(headHash),
    readTokenIdentity: () => Promise.reject(new Error("not used")),
    readPoolIdentity: () => Promise.reject(new Error("not used")),
    readBalances: () =>
      configured
        ? Promise.resolve({
            head: {
              blockNumber: headNumber,
              blockHash: headHash,
              observedAt,
            },
            balances: [
              {
                assetId: "eip155:56:native",
                rawValue: 7_000_000_000_000_000_000n,
                reasonCode: null,
              },
              options.failTokenBalance === true
                ? {
                    assetId: wbnbAssetId,
                    rawValue: null,
                    reasonCode: "BSC_BALANCE_CALL_FAILED",
                  }
                : {
                    assetId: wbnbAssetId,
                    rawValue: 1_500_000_000_000_000_000n,
                    reasonCode: null,
                  },
            ],
          })
        : Promise.reject(new BscReadUnavailableError("BSC_RPC_NOT_CONFIGURED")),
    readTransferLogs: () => Promise.resolve([]),
    readPoolEventLogs: () => Promise.resolve([]),
    readApprovalLogs: () => Promise.resolve([]),
    probeEndpoints: () =>
      Promise.resolve(
        configured
          ? [
              {
                endpointRef: "rpc-abcdefabcdef",
                label: "rpc-a.example",
                status: "healthy" as const,
                latencyMs: 42,
                blockNumber: headNumber.toString(10),
                blockLagBlocks: 0,
                chainVerification: "verified" as const,
                observedAt,
              },
            ]
          : [],
      ),
  };
  return client;
}

/**
 * The launch slot's own client (Decision 0038): chain 97, native balance
 * only. `verification` drives what the slot reports; `configured: false`
 * is the unavailable client with the slot's reason code.
 */
function launchClientFake(
  options: {
    readonly configured?: boolean;
    readonly verification?: ChainVerificationState;
    readonly failBalance?: boolean;
  } = {},
): BscReadClient {
  const configured = options.configured !== false;
  const verification = options.verification ?? "verified";
  const rejectRead = (): Promise<never> =>
    Promise.reject(
      !configured
        ? new BscReadUnavailableError("LAUNCH_CHAIN_RPC_NOT_CONFIGURED")
        : verification === "mismatched"
          ? new BscChainMismatchError()
          : new BscReadUnavailableError("BSC_RPC_UNREACHABLE"),
    );
  const head = {
    blockNumber: launchHeadNumber,
    blockHash: launchHeadHash,
    observedAt,
  };
  return {
    chainId: "eip155:97",
    chainReference: 97,
    confirmations: 5,
    reorgDepthBlocks: 15,
    endpointRefs: configured ? ["rpc-fedcbafedcba"] : [],
    verifyChain: () => Promise.resolve(configured ? verification : "unknown"),
    currentVerification: () => (configured ? verification : "unknown"),
    getHead: () =>
      configured && verification === "verified"
        ? Promise.resolve(head)
        : rejectRead(),
    getBlockHash: () => Promise.resolve(launchHeadHash),
    readTokenIdentity: () => Promise.reject(new Error("not used")),
    readPoolIdentity: () => Promise.reject(new Error("not used")),
    readBalances: (_owner, items) =>
      configured && verification === "verified"
        ? Promise.resolve({
            head,
            balances: items.map((item) => ({
              assetId: item.assetId,
              rawValue:
                options.failBalance === true
                  ? null
                  : 2_500_000_000_000_000_000n,
              reasonCode:
                options.failBalance === true ? "BSC_BALANCE_CALL_FAILED" : null,
            })),
          })
        : rejectRead(),
    readTransferLogs: () => Promise.resolve([]),
    readPoolEventLogs: () => Promise.resolve([]),
    readApprovalLogs: () => Promise.resolve([]),
    probeEndpoints: () => Promise.resolve([]),
  };
}

function privyReadersFake(
  options: { readonly matched?: boolean; readonly empty?: boolean } = {},
) {
  const listEthereumWallets = vi.fn(() =>
    Promise.resolve(
      options.empty === true
        ? []
        : [
            {
              address: walletAddress,
              kind: "embedded" as const,
              providerWalletId: "wallet_privy_1",
            },
          ],
    ),
  );
  const walletReader: PrivyWalletReader = { listEthereumWallets };
  const balanceReader: PrivyBalanceReader = {
    readBscBalances: vi.fn(() =>
      Promise.resolve([
        {
          asset: "bnb",
          rawValue:
            options.matched === false
              ? "6000000000000000000"
              : "7000000000000000000",
          decimals: 18,
        },
      ]),
    ),
  };
  return { walletReader, balanceReader, listEthereumWallets };
}

function fakes(
  options: {
    readonly configured?: boolean;
    readonly checkpoint?: boolean;
    readonly matched?: boolean;
    readonly setActiveError?: Error;
    readonly watchlistConflict?: boolean;
    readonly assets?: readonly AssetRecord[];
    readonly failTokenBalance?: boolean;
    readonly emptyPrivyWallets?: boolean;
  } = {},
) {
  const walletFake = walletRepositoryFake({
    ...(options.setActiveError === undefined
      ? {}
      : { setActiveError: options.setActiveError }),
    ...(options.emptyPrivyWallets === true ? { emptyObservation: true } : {}),
  });
  const watchlistFake = watchlistRepositoryFake(
    options.watchlistConflict === true ? { conflict: true } : {},
  );
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    watchlistsV2: watchlistFake.repository,
    chainRegistry: registryFake(options.assets),
    accountWallets: walletFake.repository,
    bscIndexer: indexerFake(
      options.checkpoint === false ? { checkpoint: false } : {},
    ),
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
  const readers = privyReadersFake({
    ...(options.matched === false ? { matched: false } : {}),
    ...(options.emptyPrivyWallets === true ? { empty: true } : {}),
  });

  return {
    database,
    privyAccessTokenVerifier,
    bscReadClient: readClientFake({
      ...(options.configured === false ? { configured: false } : {}),
      ...(options.failTokenBalance === true ? { failTokenBalance: true } : {}),
    }),
    ...readers,
    ...walletFake,
    watchlistReplace: watchlistFake.replace,
  };
}

describe("LOOP API V2 chain, wallet, and watchlist modules", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies: ReturnType<typeof fakes> & {
      readonly launchChainReadClient?: BscReadClient;
      readonly hooksLaunchFactoryReader?: HooksLaunchFactoryReader;
    } = fakes(),
    overrides: Readonly<Record<string, string>> = {},
    marketFactService?: MarketFactService,
  ) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      bscReadClient: dependencies.bscReadClient,
      ...(dependencies.launchChainReadClient === undefined
        ? {}
        : { launchChainReadClient: dependencies.launchChainReadClient }),
      ...(dependencies.hooksLaunchFactoryReader === undefined
        ? {}
        : { hooksLaunchFactoryReader: dependencies.hooksLaunchFactoryReader }),
      privyWalletReader: dependencies.walletReader,
      privyBalanceReader: dependencies.balanceReader,
      ...(marketFactService === undefined ? {} : { marketFactService }),
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("registers no chain, wallet, or watchlist route when the modules are disabled", async () => {
    const { app } = await createApp(fakes(), { V2_MODULES_ENABLED: "" });
    for (const url of [
      "/v2/chain/status",
      `/v2/assets/${wbnbAssetId}`,
      "/v2/wallets",
      `/v2/wallets/${walletId}/balances`,
      "/v2/watchlist",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: commonHeaders(),
      });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("fails the chain status closed when no RPC endpoint is configured", async () => {
    const { app } = await createApp(fakes({ configured: false }), {
      BSC_RPC_URLS: "",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/chain/status",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      category: "availability",
      retryable: true,
      detailsSafe: null,
      providerReferenceSafe: null,
    });

    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const projected = capabilities.json<{
      readonly capabilities: readonly {
        readonly capabilityId: string;
        readonly availability: string;
        readonly reasonCode: string | null;
      }[];
    }>();
    const bscRead = projected.capabilities.find(
      (capability) => capability.capabilityId === "bscRead",
    );
    expect(bscRead).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_RPC_NOT_CONFIGURED",
    });
  });

  it("reports bscRead available once the chain probe verified chain 56", async () => {
    const { app } = await createApp();
    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const bscRead = capabilities
      .json<{
        readonly capabilities: readonly {
          readonly capabilityId: string;
          readonly availability: string;
          readonly reasonCode: string | null;
        }[];
      }>()
      .capabilities.find((capability) => capability.capabilityId === "bscRead");
    expect(bscRead).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
  });

  it("re-reads the live verification state on every capability request", async () => {
    const dependencies = fakes();
    let verification: "unknown" | "verified" = "unknown";
    const client = {
      ...dependencies.bscReadClient,
      currentVerification: () => verification,
    };
    const { app } = await createApp({ ...dependencies, bscReadClient: client });

    const readBscRead = async (): Promise<Record<string, unknown>> => {
      const response = await app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      return (
        response
          .json<{
            readonly capabilities: readonly Record<string, unknown>[];
          }>()
          .capabilities.find(
            (capability) => capability["capabilityId"] === "bscRead",
          ) ?? {}
      );
    };

    expect(await readBscRead()).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_CHAIN_VERIFICATION_PENDING",
    });
    // The probe lands after composition; the projection must follow it.
    verification = "verified";
    expect(await readBscRead()).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
  });

  it("re-probes a stalled chain verification from the capability projection instead of sustaining the closed state (preflight 2026-09-16)", async () => {
    const dependencies = fakes();
    // `endpoint` is what eth_chainId would answer now; `probed` is what the
    // client last observed, which is all the projection may report.
    let endpoint: "unreachable" | "verified" = "unreachable";
    let probed: "unknown" | "unreachable" | "verified" = "unknown";
    const verifyChain = vi.fn(() => {
      probed = endpoint;
      return Promise.resolve(probed);
    });
    const client = {
      ...dependencies.bscReadClient,
      verifyChain,
      currentVerification: () => probed,
    };
    let clock = 0;
    const app = await buildApp({
      config: testConfig(),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      bscReadClient: client,
      privyWalletReader: dependencies.walletReader,
      privyBalanceReader: dependencies.balanceReader,
      chainVerificationWatch: {
        // Startup gets a single probe here so the projection path is what
        // heals the state.
        retry: {
          maxAttempts: 1,
          initialDelayMs: 0,
          maxDelayMs: 0,
          maxTotalMs: 0,
        },
        reprobeThrottleMs: 30_000,
        monotonicMs: () => clock,
        sleep: () => Promise.resolve(),
      },
      logger: false,
    });
    apps.push(app);
    await vi.waitFor(() => expect(verifyChain).toHaveBeenCalledTimes(1));
    expect(probed).toBe("unreachable");

    const readBscRead = async (): Promise<Record<string, unknown>> => {
      const response = await app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      return (
        response
          .json<{
            readonly capabilities: readonly Record<string, unknown>[];
          }>()
          .capabilities.find(
            (capability) => capability["capabilityId"] === "bscRead",
          ) ?? {}
      );
    };

    // Reading a non-terminal state reports it honestly and schedules one
    // background re-probe; the endpoint is still down, so nothing changes.
    expect(await readBscRead()).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_RPC_UNREACHABLE",
    });
    expect(verifyChain).toHaveBeenCalledTimes(2);
    clock = 10_000;
    expect(await readBscRead()).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_RPC_UNREACHABLE",
    });
    // Throttled: no second re-probe inside the window.
    expect(verifyChain).toHaveBeenCalledTimes(2);

    // The endpoint recovers. The next read past the window still reports
    // what the client knows (unreachable) but triggers the re-probe that
    // heals it; the read after that is available with no client action.
    endpoint = "verified";
    clock = 30_000;
    expect(await readBscRead()).toMatchObject({
      availability: "unavailable",
      reasonCode: "BSC_RPC_UNREACHABLE",
    });
    expect(verifyChain).toHaveBeenCalledTimes(3);
    expect(await readBscRead()).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
    // Verified is terminal: no further probes, however long it runs.
    clock = 600_000;
    await readBscRead();
    expect(verifyChain).toHaveBeenCalledTimes(3);
  });

  it("publishes endpoint health behind opaque references and the indexer lag", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/chain/status",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{
      readonly rpc: {
        readonly status: string;
        readonly head: { readonly blockNumber: string } | null;
        readonly endpoints: readonly {
          readonly endpointRef: string;
          readonly label: string;
        }[];
      };
      readonly indexer: readonly {
        readonly lagBlocks: number | null;
        readonly reorgCount: number | null;
      }[];
      readonly chain: { readonly confirmations: number };
    }>();
    expect(body.rpc.status).toBe("available");
    expect(body.rpc.head?.blockNumber).toBe(headNumber.toString(10));
    expect(body.rpc.endpoints[0]?.endpointRef).toBe("rpc-abcdefabcdef");
    // The host name is the displayable label (Decision 0049); the URL itself
    // (scheme, path, any key) is never published.
    expect(body.rpc.endpoints[0]?.label).toBe("rpc-a.example");
    expect(body.indexer[0]?.lagBlocks).toBe(5);
    expect(body.indexer[0]?.reorgCount).toBe(2);
    expect(body.chain.confirmations).toBe(15);
    expect(response.body).not.toContain("https://");
    expect(response.body).not.toContain("example/");
  });

  it("keeps chain status, balances, and capabilities byte-identical to the S5 baseline while the launch slot is shared (Decision 0038)", async () => {
    // The fixtures were generated from the integration/v2 sources at
    // 25ca0c3 (before this decision) with these same fakes. Decision 0072
    // added the `logo` field to every balance row; the balances fixture
    // was regenerated with it. Decision 0089: without the `market` module
    // the logo proxy route is not served, so every logo is
    // TOKEN_LOGO_PROXY_UNAVAILABLE here (regenerated again). Decision 0095
    // renamed the avatarUpload reason to AVATAR_STORAGE_UNAVAILABLE.
    const baseline = (name: string): string =>
      readFileSync(
        new URL(`./fixtures/s9-baseline/${name}.json`, import.meta.url),
        "utf8",
      ).trimEnd();
    const apps = [
      await createApp(),
      await createApp(fakes(), { LAUNCH_CHAIN_ID: "56" }),
      // An injected launch client is ignored while the slot is shared: the
      // seam cannot make LAUNCH_CHAIN_ID=56 publish a second chain.
      await createApp({
        ...fakes(),
        launchChainReadClient: launchClientFake(),
      }),
      // Decision 0039: a blank evidence reference is the same as an unset
      // one, so the capabilities document stays byte-identical as well.
      await createApp(fakes(), {
        LAUNCH_CHAIN_ID: "56",
        STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF: "",
      }),
    ];
    for (const { app } of apps) {
      const status = await app.inject({
        method: "GET",
        url: "/v2/chain/status",
        headers: commonHeaders(),
      });
      expect(status.statusCode).toBe(200);
      expect(status.body).toBe(baseline("chain-status"));

      const balances = await app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/balances`,
        headers: commonHeaders(),
      });
      expect(balances.statusCode).toBe(200);
      expect(balances.body).toBe(baseline("wallet-balances"));

      const capabilities = await app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.body).toBe(baseline("capabilities"));
    }
  });

  it("publishes the launch slot's testnet status and tBNB balance beside the primary chain", async () => {
    const { app } = await createApp(
      { ...fakes(), launchChainReadClient: launchClientFake() },
      { LAUNCH_CHAIN_ID: "97" },
    );
    const status = await app.inject({
      method: "GET",
      url: "/v2/chain/status",
      headers: commonHeaders(),
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json<{
      readonly chain: { readonly chainId: string };
      readonly rpc: { readonly status: string };
      readonly launchChain: Record<string, unknown>;
    }>();
    // The primary slot is untouched.
    expect(statusBody.chain.chainId).toBe("eip155:56");
    expect(statusBody.rpc.status).toBe("available");
    expect(statusBody.launchChain).toEqual({
      chainId: "eip155:97",
      chainReference: 97,
      verification: "verified",
      confirmations: 5,
      reorgDepthBlocks: 15,
      head: {
        blockNumber: launchHeadNumber.toString(10),
        blockHash: launchHeadHash,
        observedAt,
      },
      reasonCode: null,
    });
    expect(status.body).not.toContain("https://");
    expect(status.body).not.toContain("example/");

    const balances = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(balances.statusCode).toBe(200);
    const balancesBody = balances.json<
      BalancesBody & { readonly launchChain: Record<string, unknown> }
    >();
    // Primary rows and snapshot are exactly the mainnet facts.
    expect(balancesBody.snapshot.blockNumber).toBe(headNumber.toString(10));
    expect(balancesBody.balances.map((row) => row.assetId)).toEqual([
      "eip155:56:native",
      wbnbAssetId,
    ]);
    expect(balancesBody.launchChain).toEqual({
      chainId: "eip155:97",
      availability: "available",
      reasonCode: null,
      nativeBalance: {
        assetId: "eip155:97:native",
        symbol: "tBNB",
        decimals: 18,
        // The Trust Wallet rule covers BSC mainnet only (Decision 0072).
        logo: {
          status: "unavailable",
          reasonCode: "TOKEN_LOGO_CHAIN_UNSUPPORTED",
        },
        rawValue: "2500000000000000000",
        displayBalance: "2.5",
        availableBalance: "2.5",
        spendableBalance: "2.495",
        gasReserve: "0.005",
        snapshot: {
          blockNumber: launchHeadNumber.toString(10),
          blockHash: launchHeadHash,
          observedAt,
          confirmations: 5,
        },
      },
    });

    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const bscRead = capabilities
      .json<{
        readonly capabilities: readonly {
          readonly capabilityId: string;
          readonly availability: string;
        }[];
      }>()
      .capabilities.find((capability) => capability.capabilityId === "bscRead");
    expect(bscRead?.availability).toBe("available");
  });

  it("adds USD1 balance and allowance to launchChain only when LAUNCH_USD1_ADDRESS is configured (Decision 0077)", async () => {
    const usd1 = "0x2222222222222222222222222222222222222222";
    const launchContract = "0x1111111111111111111111111111111111111111";
    const base = launchClientFake();
    const client = {
      ...base,
      readBalances: (
        owner: string,
        items: readonly { assetId: string; address: string | null }[],
      ) =>
        items.some((item) => item.address === usd1)
          ? Promise.resolve({
              head: {
                blockNumber: launchHeadNumber,
                blockHash: launchHeadHash,
                observedAt,
              },
              balances: items.map((item) => ({
                assetId: item.assetId,
                rawValue: 7_000_000_000_000_000_000n,
                reasonCode: null,
              })),
            })
          : base.readBalances(owner, items),
      readAllowances: (
        _owner: string,
        items: readonly { assetId: string; spender: string }[],
      ) =>
        Promise.resolve({
          head: {
            blockNumber: launchHeadNumber,
            blockHash: launchHeadHash,
            observedAt,
          },
          allowances: items.map((item) => ({
            assetId: item.assetId,
            spender: item.spender,
            rawValue: 5_000_000_000_000_000_000n,
            reasonCode: null,
          })),
        }),
    } as unknown as BscReadClient;
    const { app } = await createApp(
      { ...fakes(), launchChainReadClient: client },
      {
        LAUNCH_CHAIN_ID: "97",
        LAUNCH_CONTRACT_ADDRESS: launchContract,
        LAUNCH_CONTRACT_VERSION: "1.0.0",
        LAUNCH_CONTRACT_START_BLOCK: "1",
        LAUNCH_USD1_ADDRESS: usd1,
      },
    );
    const balances = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(balances.statusCode).toBe(200);
    const launchChain = balances.json<{
      readonly launchChain: Record<string, unknown>;
    }>().launchChain;
    expect(launchChain["usd1"]).toEqual({
      balance: "7000000000000000000",
      allowance: "5000000000000000000",
    });
    // Additive: every pre-existing key is unchanged.
    expect(Object.keys(launchChain).sort()).toEqual([
      "availability",
      "chainId",
      "nativeBalance",
      "reasonCode",
      "usd1",
    ]);
    // Without the keys the block is absent (previous test: byte shape unchanged).
    const { app: blank } = await createApp(
      { ...fakes(), launchChainReadClient: client },
      { LAUNCH_CHAIN_ID: "97" },
    );
    const plain = await blank.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(
      plain.json<{ readonly launchChain: Record<string, unknown> }>()
        .launchChain,
    ).not.toHaveProperty("usd1");
  });

  it("reads launchChain.usd1 on the Hooks Factory's usd1(), the env address only without a Factory (Decision 0165)", async () => {
    const envUsd1 = "0x2222222222222222222222222222222222222222";
    const factoryUsd1 = "0x3a120000000000000000000000000000000a0195";
    const launchContract = "0x1111111111111111111111111111111111111111";
    const balanceTokens: (string | null)[] = [];
    const allowanceRequests: { token: string; spender: string }[] = [];
    const base = launchClientFake();
    const client = {
      ...base,
      readBalances: (
        owner: string,
        items: readonly { assetId: string; address: string | null }[],
      ) =>
        items.length === 1 && items[0]?.address !== null
          ? (balanceTokens.push(items[0]?.address ?? null),
            Promise.resolve({
              head: {
                blockNumber: launchHeadNumber,
                blockHash: launchHeadHash,
                observedAt,
              },
              balances: items.map((item) => ({
                assetId: item.assetId,
                rawValue:
                  item.address === factoryUsd1
                    ? 7_000_000_000_000_000_000n
                    : 1n,
                reasonCode: null,
              })),
            }))
          : base.readBalances(owner, items),
      readAllowances: (
        _owner: string,
        items: readonly { assetId: string; token: string; spender: string }[],
      ) => {
        allowanceRequests.push(
          ...items.map((item) => ({
            token: item.token,
            spender: item.spender,
          })),
        );
        return Promise.resolve({
          head: {
            blockNumber: launchHeadNumber,
            blockHash: launchHeadHash,
            observedAt,
          },
          allowances: items.map((item) => ({
            assetId: item.assetId,
            spender: item.spender,
            rawValue: 0n,
            reasonCode: null,
          })),
        });
      },
    } as unknown as BscReadClient;
    let usd1Reads = 0;
    const factory = (usd1: () => Promise<string>): HooksLaunchFactoryReader =>
      ({
        factoryAddress: "0xd05e00000000000000000000000000000000c8d4",
        chainId: 97,
        hookKind: "officialTax",
        usd1: () => {
          usd1Reads += 1;
          return usd1();
        },
      }) as unknown as HooksLaunchFactoryReader;
    const env = {
      LAUNCH_CHAIN_ID: "97",
      LAUNCH_CONTRACT_ADDRESS: launchContract,
      LAUNCH_CONTRACT_VERSION: "1.0.0",
      LAUNCH_CONTRACT_START_BLOCK: "1",
      LAUNCH_USD1_ADDRESS: envUsd1,
      HOOKS_LAUNCH_ENABLED: "on",
    };
    const read = async (app: FastifyInstance) => {
      const response = await app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/balances`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ readonly launchChain: Record<string, unknown> }>()
        .launchChain;
    };

    // Factory composed: the USD1 token is its usd1(), never the env one;
    // the allowance spender is still LAUNCH_CONTRACT_ADDRESS.
    const { app } = await createApp(
      {
        ...fakes(),
        launchChainReadClient: client,
        hooksLaunchFactoryReader: factory(() => Promise.resolve(factoryUsd1)),
      },
      env,
    );
    const withFactory = await read(app);
    expect(withFactory["usd1"]).toEqual({
      balance: "7000000000000000000",
      allowance: "0",
    });
    expect(balanceTokens).toEqual([factoryUsd1]);
    expect(allowanceRequests).toEqual([
      { token: factoryUsd1, spender: launchContract },
    ]);
    expect(usd1Reads).toBe(1);

    // Factory read fails: the pair is absent (never the env token), the
    // native balance is still published.
    balanceTokens.length = 0;
    const { app: failing } = await createApp(
      {
        ...fakes(),
        launchChainReadClient: client,
        hooksLaunchFactoryReader: factory(() =>
          Promise.reject(new Error("Hooks launch factory read unavailable")),
        ),
      },
      env,
    );
    const failed = await read(failing);
    expect(failed).not.toHaveProperty("usd1");
    expect(failed["availability"]).toBe("available");
    expect(balanceTokens).toEqual([]);

    // No Factory (Hooks launch off): LAUNCH_USD1_ADDRESS is the fallback.
    const { app: noFactory } = await createApp(
      { ...fakes(), launchChainReadClient: client },
      { ...env, HOOKS_LAUNCH_ENABLED: "off" },
    );
    const fallback = await read(noFactory);
    expect(fallback["usd1"]).toEqual({ balance: "1", allowance: "0" });
    expect(balanceTokens).toEqual([envUsd1]);
  });

  it("publishes launchUsd1 at the root only while the launch slot is shared and the contract keys are set (Decision 0081)", async () => {
    const usd1 = "0x2222222222222222222222222222222222222222";
    const launchContract = "0x1111111111111111111111111111111111111111";
    const contractKeys = {
      LAUNCH_CONTRACT_ADDRESS: launchContract,
      LAUNCH_CONTRACT_VERSION: "1.0.0",
      LAUNCH_CONTRACT_START_BLOCK: "1",
      LAUNCH_USD1_ADDRESS: usd1,
    };
    const baseline = readFileSync(
      new URL("./fixtures/s9-baseline/wallet-balances.json", import.meta.url),
      "utf8",
    ).trimEnd();
    const allowanceSpenders: string[] = [];
    const primaryWithUsd1 = (allowanceBlock: bigint): BscReadClient => {
      const base = readClientFake();
      return {
        ...base,
        readBalances: (
          owner: string,
          items: readonly { assetId: string; address: string | null }[],
        ) =>
          items.length === 1 && items[0]?.address === usd1
            ? Promise.resolve({
                head: {
                  blockNumber: headNumber,
                  blockHash: headHash,
                  observedAt,
                },
                balances: [
                  {
                    assetId: items[0].assetId,
                    rawValue: 9_000_000_000_000_000_000n,
                    reasonCode: null,
                  },
                ],
              })
            : base.readBalances(owner, items),
        readAllowances: (
          _owner: string,
          items: readonly { assetId: string; spender: string }[],
        ) => {
          allowanceSpenders.push(...items.map((item) => item.spender));
          return Promise.resolve({
            head: {
              blockNumber: allowanceBlock,
              blockHash: headHash,
              observedAt,
            },
            allowances: items.map((item) => ({
              assetId: item.assetId,
              spender: item.spender,
              rawValue: 4_000_000_000_000_000_000n,
              reasonCode: null,
            })),
          });
        },
      } as unknown as BscReadClient;
    };
    const read = async (app: FastifyInstance) =>
      app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/balances`,
        headers: commonHeaders(),
      });

    const { app } = await createApp(
      { ...fakes(), bscReadClient: primaryWithUsd1(headNumber) },
      { LAUNCH_CHAIN_ID: "56", ...contractKeys },
    );
    const shared = await read(app);
    expect(shared.statusCode).toBe(200);
    const body = shared.json<Record<string, unknown>>();
    expect(body["launchUsd1"]).toEqual({
      balance: "9000000000000000000",
      allowance: "4000000000000000000",
    });
    expect(body).not.toHaveProperty("launchChain");
    expect(allowanceSpenders).toEqual([launchContract]);
    // Additive only: without the new key the document is the S5 baseline.
    const rest = { ...body };
    delete rest["launchUsd1"];
    expect(JSON.stringify(rest)).toBe(baseline);

    // The two values from different blocks are no fact: the key is absent.
    const { app: skewed } = await createApp(
      { ...fakes(), bscReadClient: primaryWithUsd1(headNumber + 1n) },
      { LAUNCH_CHAIN_ID: "56", ...contractKeys },
    );
    expect((await read(skewed)).body).toBe(baseline);

    // A primary client without the allowance surface fails closed: absent.
    const { app: noAllowance } = await createApp(fakes(), {
      LAUNCH_CHAIN_ID: "56",
      ...contractKeys,
    });
    expect((await read(noAllowance)).body).toBe(baseline);

    // No contract keys on the shared slot: byte-identical baseline.
    const { app: blank } = await createApp(
      { ...fakes(), bscReadClient: primaryWithUsd1(headNumber) },
      { LAUNCH_CHAIN_ID: "56" },
    );
    expect((await read(blank)).body).toBe(baseline);

    // A separate slot keeps USD1 under launchChain and never at the root.
    const { app: separate } = await createApp(
      {
        ...fakes(),
        bscReadClient: primaryWithUsd1(headNumber),
        launchChainReadClient: launchClientFake(),
      },
      { LAUNCH_CHAIN_ID: "97", ...contractKeys },
    );
    const split = (await read(separate)).json<Record<string, unknown>>();
    expect(split).toHaveProperty("launchChain");
    expect(split).not.toHaveProperty("launchUsd1");
  });

  it("reports the launch slot's failures inside launchChain without failing the primary reads", async () => {
    const cases: readonly {
      readonly client: BscReadClient;
      readonly reasonCode: string;
      readonly verification: ChainVerificationState;
      /**
       * A balance read forces the probe, so "verification pending" cannot
       * survive it: the fake then answers as unreachable.
       */
      readonly balancesReasonCode?: string;
    }[] = [
      {
        client: launchClientFake({ configured: false }),
        reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
        verification: "unknown",
      },
      {
        client: launchClientFake({ verification: "mismatched" }),
        reasonCode: "LAUNCH_CHAIN_ID_MISMATCH",
        verification: "mismatched",
      },
      {
        client: launchClientFake({ verification: "unreachable" }),
        reasonCode: "LAUNCH_CHAIN_RPC_UNREACHABLE",
        verification: "unreachable",
      },
      {
        client: launchClientFake({ verification: "unknown" }),
        reasonCode: "LAUNCH_CHAIN_VERIFICATION_PENDING",
        verification: "unknown",
        balancesReasonCode: "LAUNCH_CHAIN_RPC_UNREACHABLE",
      },
    ];
    for (const testCase of cases) {
      const { app } = await createApp(
        { ...fakes(), launchChainReadClient: testCase.client },
        { LAUNCH_CHAIN_ID: "97" },
      );
      const status = await app.inject({
        method: "GET",
        url: "/v2/chain/status",
        headers: commonHeaders(),
      });
      expect(status.statusCode, testCase.reasonCode).toBe(200);
      expect(
        status.json<{ readonly launchChain: unknown }>().launchChain,
        testCase.reasonCode,
      ).toEqual({
        chainId: "eip155:97",
        chainReference: 97,
        verification: testCase.verification,
        confirmations: 5,
        reorgDepthBlocks: 15,
        head: null,
        reasonCode: testCase.reasonCode,
      });

      const balances = await app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/balances`,
        headers: commonHeaders(),
      });
      expect(balances.statusCode, testCase.reasonCode).toBe(200);
      const body = balances.json<
        BalancesBody & { readonly launchChain: unknown }
      >();
      expect(body.balances).toHaveLength(2);
      expect(body.launchChain, testCase.reasonCode).toEqual({
        chainId: "eip155:97",
        availability: "unavailable",
        reasonCode: testCase.balancesReasonCode ?? testCase.reasonCode,
        nativeBalance: null,
      });
    }

    // A failed eth_getBalance keeps the slot's identity and names the call.
    const { app } = await createApp(
      {
        ...fakes(),
        launchChainReadClient: launchClientFake({ failBalance: true }),
      },
      { LAUNCH_CHAIN_ID: "97" },
    );
    const balances = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(
      balances.json<{ readonly launchChain: unknown }>().launchChain,
    ).toEqual({
      chainId: "eip155:97",
      availability: "unavailable",
      reasonCode: "BSC_BALANCE_CALL_FAILED",
      nativeBalance: null,
    });
  });

  it("composes the unavailable launch client when LAUNCH_CHAIN_ID=97 has no endpoints", async () => {
    const { app } = await createApp(fakes(), { LAUNCH_CHAIN_ID: "97" });
    const status = await app.inject({
      method: "GET",
      url: "/v2/chain/status",
      headers: commonHeaders(),
    });
    expect(status.statusCode).toBe(200);
    expect(
      status.json<{ readonly launchChain: unknown }>().launchChain,
    ).toEqual({
      chainId: "eip155:97",
      chainReference: 97,
      verification: "unknown",
      confirmations: 5,
      reorgDepthBlocks: 15,
      head: null,
      reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
    });
  });

  it("projects a registry asset with a non-swappable capability", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/assets/${wbnbAssetId}`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      asset: {
        assetId: wbnbAssetId,
        symbol: "WBNB",
        decimals: 18,
        status: "pending",
        source: { kind: "chain_call", blockNumber: "43000000" },
      },
      capability: { viewable: true, swappable: false, value: "viewable" },
      contractVersion: "2.0",
    });
  });

  it("returns NOT_FOUND for an asset outside the registry", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/assets/eip155:56:0x00000000000000000000000000000000000000ff",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects an asset ID from another chain with CHAIN_MISMATCH", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/assets/eip155:1:${wbnb}`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "CHAIN_MISMATCH" });
  });

  it("projects the Privy wallet inventory with each wallet's public address", async () => {
    const { app, listEthereumWallets } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/wallets",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(listEthereumWallets).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      wallets: [
        {
          walletId,
          kind: "embedded",
          provider: "privy",
          address: walletAddress,
          isActive: true,
        },
      ],
      activeWalletId: walletId,
      source: { provider: "privy" },
    });
  });

  it("compare-and-swaps the active wallet and rejects an idempotency key", async () => {
    const { app, setActive } = await createApp();
    const accepted = await app.inject({
      method: "PUT",
      url: "/v2/wallets/active",
      headers: commonHeaders(),
      payload: { walletId, expectedActiveWalletId: null },
    });
    expect(accepted.statusCode).toBe(200);
    expect(setActive).toHaveBeenCalledWith({
      ownerUserId: accountId,
      walletId,
      expectedActiveWalletId: null,
    });

    const withKey = await app.inject({
      method: "PUT",
      url: "/v2/wallets/active",
      headers: commonHeaders({
        "idempotency-key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      payload: { walletId, expectedActiveWalletId: null },
    });
    expect(withKey.statusCode).toBe(400);
    expect(withKey.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("maps a concurrent active-wallet switch to VERSION_CONFLICT", async () => {
    const { app } = await createApp(
      fakes({ setActiveError: new AccountWalletVersionConflictError() }),
    );
    const response = await app.inject({
      method: "PUT",
      url: "/v2/wallets/active",
      headers: commonHeaders(),
      payload: { walletId, expectedActiveWalletId: otherWalletId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("maps an unknown wallet selection to NOT_FOUND", async () => {
    const { app } = await createApp(
      fakes({ setActiveError: new AccountWalletNotFoundError() }),
    );
    const response = await app.inject({
      method: "PUT",
      url: "/v2/wallets/active",
      headers: commonHeaders(),
      payload: { walletId: otherWalletId, expectedActiveWalletId: null },
    });
    expect(response.statusCode).toBe(404);
  });

  it("separates display, spendable, gas reserve, pending, and valuation", async () => {
    const { app, recordBalanceSnapshot } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<BalancesBody>();

    expect(body.snapshot.blockNumber).toBe(headNumber.toString(10));
    expect(body.gasReservePolicy).toMatchObject({
      nativeReserveRaw: "5000000000000000",
      nativeReserve: "0.005",
    });
    const native = body.balances.find(
      (balance) => balance.assetId === "eip155:56:native",
    );
    expect(native).toMatchObject({
      balance: {
        status: "available",
        displayBalance: "7",
        availableBalance: "7",
        spendableBalance: "6.995",
        gasReserve: "0.005",
      },
      crossCheck: {
        source: "privy",
        status: "matched",
        reasonCode: null,
        blockDelta: null,
      },
    });
    const token = body.balances.find(
      (balance) => balance.assetId === wbnbAssetId,
    );
    expect(token).toMatchObject({
      balance: { status: "available", displayBalance: "1.5", gasReserve: "0" },
      pending: { status: "available", displayValue: "0.25" },
      crossCheck: {
        status: "unavailable",
        reasonCode: "PRIVY_ASSET_MAPPING_UNAVAILABLE",
        blockDelta: null,
      },
    });
    expect(token?.valuation).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_RUNTIME_UNAVAILABLE",
    });
    expect(body.netWorth).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_RUNTIME_UNAVAILABLE",
    });
    expect(recordBalanceSnapshot).toHaveBeenCalledTimes(2);
  });

  function marketFactsFake(
    quality: "fresh" | "stale" | "unavailable",
    priceChangeH24: string | null = null,
  ): MarketFactService {
    const fact: CachedFact<TokenPairsSnapshot> = {
      value:
        quality === "unavailable"
          ? null
          : {
              tokenAddress: wbnb,
              pairs: [
                {
                  pairAddress: "0x172fcd41e0913e95784454622d1c3724f546f849",
                  dexId: "pancakeswap",
                  labels: ["v3"],
                  baseTokenAddress: wbnb,
                  baseTokenSymbol: "WBNB",
                  quoteTokenAddress:
                    "0x55d398326f99059ff775485246999027b3197955",
                  quoteTokenSymbol: "USDT",
                  priceUsd: "747.39",
                  priceNative: null,
                  liquidityUsd: "1",
                  volumeH24: null,
                  priceChangeH24,
                  fdv: null,
                  marketCap: null,
                  buysH24: null,
                  sellsH24: null,
                  pairCreatedAt: null,
                },
              ],
            },
      source: "dexscreener",
      fetchedAt: quality === "unavailable" ? null : observedAt,
      ttlSeconds: 30,
      quality,
      reasonCode: quality === "fresh" ? null : "MARKET_PROVIDER_RATE_LIMITED",
      rawDigest: null,
    };
    const assetPrice = (asset: { readonly address: string | null }) =>
      Promise.resolve({
        fact,
        pair: fact.value?.pairs[0] ?? null,
        proxyAsset: asset.address === null ? wbnbAssetId : null,
      });
    return {
      readTokenPairs: vi.fn(() => Promise.resolve(fact)),
      recallPrimaryPairPriceChange: vi.fn(() => Promise.resolve(null)),
      readTokenPairsBatch: vi.fn(() => Promise.reject(new Error("not used"))),
      readPair: vi.fn(() => Promise.reject(new Error("not used"))),
      readAssetPrice: vi.fn(assetPrice),
      readAssetPrices: vi.fn(
        (assets: readonly { readonly address: string | null }[]) =>
          Promise.all(assets.map(assetPrice)),
      ),
      readTokenSecurity: vi.fn(() => Promise.reject(new Error("not used"))),
      readPoolOhlcv: vi.fn(() => Promise.reject(new Error("not used"))),
      readNewPools: vi.fn(() => Promise.reject(new Error("not used"))),
      readUnlistedToken: vi.fn(() => Promise.reject(new Error("not used"))),
      candlesProviderEnabled: false,
    };
  }

  it("values token rows from a fresh Provider price and the native row through the WBNB proxy", async () => {
    const { app } = await createApp(fakes(), {}, marketFactsFake("fresh"));
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<BalancesBody>();
    const token = body.balances.find((row) => row.assetId === wbnbAssetId);
    expect(token?.valuation).toEqual({
      status: "available",
      priceSource: "dexscreener",
      fetchedAt: observedAt,
      quality: "fresh",
      reasonCode: null,
      proxyAsset: null,
      priceUsd: "747.39",
      valueUsd: "1121.085",
      change24hPct: null,
    });
    const native = body.balances.find(
      (row) => row.assetId === "eip155:56:native",
    );
    expect(native?.valuation).toEqual({
      status: "available",
      priceSource: "dexscreener",
      fetchedAt: observedAt,
      quality: "proxied",
      reasonCode: null,
      proxyAsset: wbnbAssetId,
      priceUsd: "747.39",
      valueUsd: "5231.73",
      change24hPct: null,
    });
    // Decision 0100: the Provider reported no 24h number for a valued row,
    // so the net-worth change is unknown rather than a partial sum.
    expect(body.netWorth).toEqual({
      status: "available",
      valuationCurrency: "USD",
      valueUsd: "6352.815",
      unavailableCount: 0,
      quality: "fresh",
      priceSource: "dexscreener",
      asOf: observedAt,
      isSpendable: false,
      change24h: null,
      change24hUnavailable: { reasonCode: "PRICE_CHANGE_PARTIAL" },
    });
  });

  it("derives the net-worth 24h change from the same price read (Decision 0100)", async () => {
    for (const [pct, usd] of [
      // 6352.815 * 5 / 105 and 6352.815 * -20 / 80.
      ["5", "302.515"],
      ["-20", "-1588.20375"],
    ] as const) {
      const { app } = await createApp(
        fakes(),
        {},
        marketFactsFake("fresh", pct),
      );
      const body = (
        await app.inject({
          method: "GET",
          url: `/v2/wallets/${walletId}/balances`,
          headers: commonHeaders(),
        })
      ).json<BalancesBody>();
      expect(
        body.balances.find((row) => row.assetId === wbnbAssetId)?.valuation,
      ).toMatchObject({ change24hPct: pct });
      expect(body.netWorth).toMatchObject({
        status: "available",
        valueUsd: "6352.815",
        change24h: { usd, pct },
      });
      expect(body.netWorth).not.toHaveProperty("change24hUnavailable");
    }
  });

  it("passes a stale price through as stale and closes valuation without a usable price", async () => {
    const stale = await createApp(fakes(), {}, marketFactsFake("stale"));
    const staleBody = (
      await stale.app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/balances`,
        headers: commonHeaders(),
      })
    ).json<BalancesBody>();
    expect(
      staleBody.balances.find((row) => row.assetId === wbnbAssetId)?.valuation,
    ).toMatchObject({
      status: "available",
      quality: "stale",
      reasonCode: "MARKET_PROVIDER_RATE_LIMITED",
      valueUsd: "1121.085",
    });
    expect(staleBody.netWorth).toMatchObject({
      status: "available",
      quality: "stale",
    });

    const closed = await createApp(
      fakes({ failTokenBalance: true }),
      {},
      marketFactsFake("unavailable"),
    );
    const closedBody = (
      await closed.app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/balances`,
        headers: commonHeaders(),
      })
    ).json<BalancesBody>();
    expect(
      closedBody.balances.find((row) => row.assetId === wbnbAssetId)?.valuation,
    ).toEqual({ status: "unavailable", reasonCode: "BALANCE_UNAVAILABLE" });
    expect(closedBody.netWorth).toMatchObject({
      status: "partial",
      valueUsd: "0",
      unavailableCount: 2,
    });
  });

  it("applies the configured native gas reserve", async () => {
    const { app } = await createApp(fakes(), {
      WALLET_GAS_RESERVE_BNB: "0.02",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    const body = response.json<BalancesBody>();
    expect(body.gasReservePolicy).toEqual({
      configVersion: "walletGasReserveV1",
      nativeReserveRaw: "20000000000000000",
      nativeReserve: "0.02",
    });
    const native = body.balances.find(
      (balance) => balance.assetId === "eip155:56:native",
    );
    expect(native?.balance).toMatchObject({
      gasReserve: "0.02",
      spendableBalance: "6.98",
    });
  });

  it("rejects a gas reserve above one BNB at startup", () => {
    expect(() => testConfig({ WALLET_GAS_RESERVE_BNB: "2" })).toThrow(
      /must not exceed 1 BNB/,
    );
    expect(() => testConfig({ WALLET_GAS_RESERVE_BNB: "abc" })).toThrow(
      /non-negative decimal/,
    );
  });

  it("keeps a row for an asset whose chain call failed", async () => {
    const { app } = await createApp(fakes({ failTokenBalance: true }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<BalancesBody>();
    // Every readable registry asset still yields exactly one row.
    expect(body.balances.map((balance) => balance.assetId)).toEqual([
      "eip155:56:native",
      wbnbAssetId,
    ]);
    expect(
      body.balances.find((balance) => balance.assetId === wbnbAssetId)?.balance,
    ).toEqual({ status: "unavailable", reasonCode: "BSC_BALANCE_CALL_FAILED" });
    expect(
      body.balances.find((balance) => balance.assetId === "eip155:56:native")
        ?.balance,
    ).toMatchObject({ status: "available", displayBalance: "7" });
  });

  it("refuses to archive the inventory when Privy reports no wallet", async () => {
    const { app } = await createApp(fakes({ emptyPrivyWallets: true }));
    const response = await app.inject({
      method: "GET",
      url: "/v2/wallets",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "PROVIDER_DISCONNECTED" });
  });

  it("reports a Privy balance mismatch as unaligned without changing the RPC value", async () => {
    const { app } = await createApp(fakes({ matched: false }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    const body = response.json<BalancesBody>();
    const native = body.balances.find(
      (balance) => balance.assetId === "eip155:56:native",
    );
    // A source that does not report its block can only be `unaligned`.
    expect(native?.crossCheck).toMatchObject({
      status: "unaligned",
      reasonCode: "PRIVY_BALANCE_BLOCK_UNALIGNED",
      blockDelta: null,
    });
    expect(native?.balance).toMatchObject({
      status: "available",
      rawValue: "7000000000000000000",
    });
  });

  it("reports pending as unavailable when the indexer never ran", async () => {
    const { app } = await createApp(fakes({ checkpoint: false }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    const body = response.json<BalancesBody>();
    expect(body.balances[0]?.pending).toEqual({
      status: "unavailable",
      reasonCode: "BSC_INDEXER_NOT_STARTED",
    });
  });

  it("fails balances closed when the chain read is unavailable", async () => {
    const { app } = await createApp(fakes({ configured: false }), {
      BSC_RPC_URLS: "",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/balances`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("projects indexed activity with confirmations and freshness", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/activity`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      walletId,
      items: [
        {
          assetId: wbnbAssetId,
          direction: "in",
          counterpartyAddress: counterparty,
          displayValue: "1.5",
          confirmations: 101,
          status: "confirmed",
        },
      ],
      nextCursor: null,
      freshness: { lagBlocks: 5 },
      nativeTransfers: {
        status: "unavailable",
        reasonCode: "NATIVE_TRANSFER_SCAN_NOT_SUPPORTED",
      },
    });
  });

  it("reads the activity head beside the database reads, not after them (Decision 0088)", async () => {
    const dependencies = fakes();
    const base = readClientFake();
    let releaseHead: (() => void) | undefined;
    const headAsked = vi.fn();
    const client: BscReadClient = {
      ...base,
      getHead: () => {
        headAsked();
        return new Promise((resolve) => {
          releaseHead = () => {
            resolve({
              blockNumber: headNumber,
              blockHash: headHash,
              observedAt,
            });
          };
        });
      },
    };
    const listWalletTransfers = vi.fn<
      BscIndexerRepository["listWalletTransfers"]
    >(() => Promise.resolve({ items: [transferRecord], hasMore: false }));
    const { app } = await createApp({
      ...dependencies,
      database: {
        ...dependencies.database,
        bscIndexer: {
          ...dependencies.database.bscIndexer,
          listWalletTransfers,
        },
      },
      bscReadClient: client,
    });
    const pending = app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/activity`,
      headers: commonHeaders(),
    });
    await vi.waitFor(() => {
      expect(listWalletTransfers).toHaveBeenCalledTimes(1);
    });
    // The head was asked before the transfer page was, and has not answered.
    expect(headAsked).toHaveBeenCalledTimes(1);
    releaseHead?.();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freshness: { lagBlocks: 5 } });
  });

  describe("Decision 0167: WALLET_ACTIVITY_LAUNCH2_EMIT", () => {
    const launchInstanceId = "2f6a1c3e-5b7d-4e9f-8a1b-3c5d7e9f1a2b";
    const secondInstanceId = "3a7b2d4f-6c8e-4f0a-9b2c-4d6e8f0a2b3c";
    /**
     * Captured from `ab9f70d` (before Decision 0167) with the same fakes:
     * two transfer rows, `limit=2`, more to come. The cursor and the
     * freshness observation time vary per call and are masked.
     */
    const baselineBody =
      '{"walletId":"0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e","items":[{"assetId":"eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c","symbol":"WBNB","decimals":18,"direction":"in","counterpartyAddress":"0x00000000000000000000000000000000000000b2","rawValue":"1500000000000000000","displayValue":"1.5","transactionHash":"0x7777777777777777777777777777777777777777777777777777777777777777","logIndex":3,"blockNumber":"43999900","blockHash":"0x2222222222222222222222222222222222222222222222222222222222222222","confirmations":101,"status":"confirmed","observedAt":"2026-09-08T00:00:00.000Z"},{"assetId":"eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c","symbol":"WBNB","decimals":18,"direction":"out","counterpartyAddress":"0x00000000000000000000000000000000000000b2","rawValue":"1","displayValue":"0.000000000000000001","transactionHash":"0x8888888888888888888888888888888888888888888888888888888888888888","logIndex":0,"blockNumber":"43999900","blockHash":"0x2222222222222222222222222222222222222222222222222222222222222222","confirmations":101,"status":"reorged","observedAt":"2026-09-08T00:00:00.000Z"}],"nextCursor":"<cursor>","freshness":{"indexerBlockNumber":"43999995","headBlockNumber":"44000000","lagBlocks":5,"observedAt":"<now>"},"nativeTransfers":{"status":"unavailable","reasonCode":"NATIVE_TRANSFER_SCAN_NOT_SUPPORTED"},"crossChain":{"status":"unavailable","reasonCode":"CROSS_CHAIN_ACTIVITY_NOT_SUPPORTED"},"contractVersion":"2.0"}';
    const secondTransfer: IndexedTransferRecord = {
      ...transferRecord,
      transactionHash: `0x${"8".repeat(64)}`,
      logIndex: 0,
      fromAddress: walletAddress,
      toAddress: counterparty,
      rawValue: "1",
      removed: true,
    };
    const mask = (body: string): string =>
      body
        .replace(/"nextCursor":"[^"]+"/u, '"nextCursor":"<cursor>"')
        .replace(/("lagBlocks":[0-9]+,"observedAt":)"[^"]+"/u, '$1"<now>"');
    const micros = (iso: string): string =>
      (BigInt(Date.parse(iso)) * 1000n).toString(10);
    const timedTransfer = (
      record: IndexedTransferRecord,
    ): WalletTimedTransferRecord => ({
      ...record,
      atMicros: micros(record.observedAt),
    });
    const launch2Record = (
      kind: WalletLaunch2ActivityRecord["kind"],
      at: string,
      block: string,
      log: number,
      overrides: Partial<WalletLaunch2ActivityRecord> = {},
    ): WalletLaunch2ActivityRecord => ({
      kind,
      chainId: "eip155:97",
      instanceId: launchInstanceId,
      ticker: "WIND",
      name: "Evening Wind",
      logoUrl: "https://example.com/wind.png",
      amountMeme: "1000000000000000000000",
      amountUsd1: "10200000000000000000",
      taxUsd1: "200000000000000000",
      transactionHash: `0x${block.padStart(64, "a")}`,
      logIndex: log,
      blockNumber: block,
      occurredAt: at,
      atMicros: micros(at),
      ...overrides,
    });
    function mergeFake(
      options: {
        readonly transfers?: readonly WalletTimedTransferRecord[];
        readonly launch2?: readonly WalletLaunch2ActivityRecord[];
        readonly checkpoint?: string | null | Error;
        readonly launch2Error?: Error;
      } = {},
    ) {
      const page = <T>(
        rows: readonly T[],
        limit: number,
        key: (row: T) => WalletActivitySortKey,
        before: WalletActivitySortKey | undefined,
      ) => {
        const after = rows
          .filter(
            (row) =>
              before === undefined || compareSortKeys(key(row), before) < 0,
          )
          .sort((a, b) => compareSortKeys(key(b), key(a)));
        return Promise.resolve({
          items: after.slice(0, limit),
          hasMore: after.length > limit,
        });
      };
      const repository = {
        getLaunch2Checkpoint: vi.fn<
          WalletActivityMergeRepository["getLaunch2Checkpoint"]
        >(() => {
          const checkpoint =
            options.checkpoint === undefined ? "52000000" : options.checkpoint;
          return checkpoint instanceof Error
            ? Promise.reject(checkpoint)
            : Promise.resolve(checkpoint);
        }),
        listTransfersByTime: vi.fn<
          WalletActivityMergeRepository["listTransfersByTime"]
        >((input) =>
          page(
            options.transfers ?? [],
            input.limit,
            (row) => sortKeyOfEntry({ source: "erc20", record: row }),
            input.before,
          ),
        ),
        listLaunch2Activity: vi.fn<
          WalletActivityMergeRepository["listLaunch2Activity"]
        >((input) =>
          options.launch2Error !== undefined
            ? Promise.reject(options.launch2Error)
            : page(
                options.launch2 ?? [],
                input.limit,
                (row) => sortKeyOfEntry({ source: "launch2", record: row }),
                input.before,
              ),
        ),
      } satisfies WalletActivityMergeRepository;
      return repository;
    }
    async function mergedApp(
      repository: WalletActivityMergeRepository | undefined,
      emit: "on" | "off" | "unset",
      extra: Partial<ReturnType<typeof fakes>["database"]> = {},
    ) {
      const dependencies = fakes();
      return createApp(
        {
          ...dependencies,
          launchChainReadClient: launchClientFake(),
          database: {
            ...dependencies.database,
            ...extra,
            ...(repository === undefined
              ? {}
              : { walletActivityMerge: repository }),
          },
        },
        {
          LAUNCH_CHAIN_ID: "97",
          ...(emit === "unset" ? {} : { WALLET_ACTIVITY_LAUNCH2_EMIT: emit }),
        },
      );
    }

    for (const emit of ["off", "unset"] as const) {
      it(`keeps the activity bytes and cursor of before (${emit})`, async () => {
        const merge = mergeFake();
        const listWalletTransfers = vi.fn<
          BscIndexerRepository["listWalletTransfers"]
        >(() =>
          Promise.resolve({
            items: [transferRecord, secondTransfer],
            hasMore: true,
          }),
        );
        const { app } = await mergedApp(merge, emit, {
          bscIndexer: { ...indexerFake(), listWalletTransfers },
        });
        const first = await app.inject({
          method: "GET",
          url: `/v2/wallets/${walletId}/activity?limit=2`,
          headers: commonHeaders(),
        });
        expect(first.statusCode).toBe(200);
        expect(mask(first.body)).toBe(baselineBody);
        const cursor = first.json<{ nextCursor: string }>().nextCursor;
        const next = await app.inject({
          method: "GET",
          url: `/v2/wallets/${walletId}/activity?cursor=${cursor}`,
          headers: commonHeaders(),
        });
        expect(next.statusCode).toBe(200);
        // The block / log cursor of before, same page size.
        expect(listWalletTransfers).toHaveBeenLastCalledWith(
          expect.objectContaining({
            limit: 2,
            beforeBlockNumber: "43999900",
            beforeLogIndex: 0,
          }),
        );
        // Nothing of the merge is read while the switch is off.
        expect(merge.getLaunch2Checkpoint).not.toHaveBeenCalled();
        expect(merge.listTransfersByTime).not.toHaveBeenCalled();
        expect(merge.listLaunch2Activity).not.toHaveBeenCalled();
      });
    }

    it("mixes launch2 rows into the list newest first (on)", async () => {
      // 晚风-style: two instances, buy / sell / mint / claim / pool trades,
      // and two transfers on the primary chain between them.
      const transfers = [
        timedTransfer({
          ...transferRecord,
          observedAt: "2026-10-19T10:00:00.000Z",
        }),
        timedTransfer({
          ...secondTransfer,
          removed: false,
          observedAt: "2026-10-19T07:30:00.000Z",
        }),
      ];
      const launch2 = [
        launch2Record(
          "launch2_nft_mint",
          "2026-10-19T06:00:00.000Z",
          "100",
          0,
          {
            amountMeme: null,
            amountUsd1: "100000000000000000000",
            taxUsd1: null,
          },
        ),
        launch2Record(
          "launch2_curve_buy",
          "2026-10-19T08:00:00.000Z",
          "200",
          1,
        ),
        launch2Record(
          "launch2_curve_sell",
          "2026-10-19T09:00:00.000Z",
          "300",
          2,
          {
            amountUsd1: "4900000000000000000",
            taxUsd1: "100000000000000000",
            amountMeme: "500000000000000000000",
          },
        ),
        launch2Record(
          "launch2_pool_buy",
          "2026-10-19T11:00:00.000Z",
          "400",
          3,
          {
            instanceId: secondInstanceId,
            ticker: "MOON",
            name: "Moon",
            logoUrl: null,
            taxUsd1: null,
          },
        ),
        launch2Record(
          "launch2_reward_claim",
          "2026-10-19T12:00:00.000Z",
          "500",
          0,
          {
            instanceId: secondInstanceId,
            ticker: "MOON",
            name: "Moon",
            logoUrl: null,
            amountMeme: null,
            taxUsd1: null,
            amountUsd1: "1250000000000000000",
          },
        ),
      ];
      const merge = mergeFake({ transfers, launch2 });
      const listWalletTransfers = vi.fn<
        BscIndexerRepository["listWalletTransfers"]
      >(() => Promise.resolve({ items: [], hasMore: false }));
      const { app } = await mergedApp(merge, "on", {
        bscIndexer: { ...indexerFake(), listWalletTransfers },
      });
      const response = await app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        readonly items: readonly Record<string, unknown>[];
        readonly launch2: Record<string, unknown>;
        readonly nextCursor: string | null;
      }>();
      expect(
        body.items.map((item) =>
          typeof item["kind"] === "string" ? item["kind"] : "transfer",
        ),
      ).toEqual([
        "launch2_reward_claim",
        "launch2_pool_buy",
        "transfer",
        "launch2_curve_sell",
        "launch2_curve_buy",
        "transfer",
        "launch2_nft_mint",
      ]);
      expect(body.items[0]).toEqual({
        kind: "launch2_reward_claim",
        chainId: "eip155:97",
        instanceId: secondInstanceId,
        ticker: "MOON",
        name: "Moon",
        logoUrl: null,
        amountMeme: null,
        amountUsd1: "1.25",
        taxUsd1: null,
        transactionHash: `0x${"500".padStart(64, "a")}`,
        logIndex: 0,
        blockNumber: "500",
        occurredAt: "2026-10-19T12:00:00.000Z",
        // Launch chain head (52000000) + 1 − 500.
        confirmations: 51_999_501,
      });
      expect(body.items[3]).toMatchObject({
        kind: "launch2_curve_sell",
        amountMeme: "500",
        amountUsd1: "4.9",
        taxUsd1: "0.1",
      });
      // A transfer row keeps exactly its keys of before.
      expect(Object.keys(body.items[2] ?? {})).toEqual([
        "assetId",
        "symbol",
        "decimals",
        "direction",
        "counterpartyAddress",
        "rawValue",
        "displayValue",
        "transactionHash",
        "logIndex",
        "blockNumber",
        "blockHash",
        "confirmations",
        "status",
        "observedAt",
      ]);
      expect(body.launch2).toEqual({
        status: "available",
        chainId: "eip155:97",
        indexerBlockNumber: "52000000",
        headBlockNumber: "52000000",
      });
      expect(body.nextCursor).toBeNull();
      // The merged list reads transfers by time, not by block.
      expect(listWalletTransfers).not.toHaveBeenCalled();
      expect(merge.listLaunch2Activity).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: "eip155:97",
          address: walletAddress,
          limit: 25,
        }),
      );
    });

    it("pages the merged list with one cursor and no row twice (on)", async () => {
      const transfers = [
        timedTransfer({
          ...transferRecord,
          observedAt: "2026-10-19T10:00:00.000Z",
        }),
      ];
      const launch2 = [
        launch2Record(
          "launch2_curve_buy",
          "2026-10-19T11:00:00.000Z",
          "300",
          0,
        ),
        // Same block time as the transfer: the higher block goes first.
        launch2Record(
          "launch2_curve_sell",
          "2026-10-19T10:00:00.000Z",
          "200",
          5,
        ),
        launch2Record("launch2_nft_mint", "2026-10-19T09:00:00.000Z", "100", 0),
      ];
      const merge = mergeFake({ transfers, launch2 });
      const { app } = await mergedApp(merge, "on");
      const seen: string[] = [];
      let url = `/v2/wallets/${walletId}/activity?limit=1`;
      for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: commonHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json<{
          readonly items: readonly {
            readonly kind?: string;
            readonly blockNumber: string;
          }[];
          readonly nextCursor: string | null;
        }>();
        expect(body.items).toHaveLength(1);
        const item = body.items[0];
        seen.push(`${item?.kind ?? "transfer"}:${item?.blockNumber ?? ""}`);
        if (body.nextCursor === null) break;
        url = `/v2/wallets/${walletId}/activity?cursor=${body.nextCursor}`;
      }
      expect(seen).toEqual([
        "launch2_curve_buy:300",
        "transfer:43999900",
        "launch2_curve_sell:200",
        "launch2_nft_mint:100",
      ]);
    });

    it("refuses a cursor of the other mode", async () => {
      const listWalletTransfers = vi.fn<
        BscIndexerRepository["listWalletTransfers"]
      >(() => Promise.resolve({ items: [transferRecord], hasMore: true }));
      const { app: off } = await mergedApp(mergeFake(), "off", {
        bscIndexer: { ...indexerFake(), listWalletTransfers },
      });
      const offPage = await off.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity?limit=1`,
        headers: commonHeaders(),
      });
      const offCursor = offPage.json<{ nextCursor: string }>().nextCursor;
      const { app: on } = await mergedApp(
        mergeFake({
          transfers: [timedTransfer(transferRecord)],
          launch2: [
            launch2Record(
              "launch2_curve_buy",
              "2026-10-19T11:00:00.000Z",
              "1",
              0,
            ),
          ],
        }),
        "on",
      );
      const stale = await on.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity?cursor=${offCursor}`,
        headers: commonHeaders(),
      });
      expect(stale.statusCode).toBe(400);
      expect(stale.json()).toMatchObject({ code: "INVALID_REQUEST" });

      const onPage = await on.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity?limit=1`,
        headers: commonHeaders(),
      });
      const onCursor = onPage.json<{ nextCursor: string }>().nextCursor;
      const back = await off.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity?cursor=${onCursor}`,
        headers: commonHeaders(),
      });
      expect(back.statusCode).toBe(400);
    });

    it("reports the launch2 leg unavailable without failing the page (on)", async () => {
      for (const [options, reasonCode] of [
        [{ checkpoint: null }, "LAUNCH2_INDEXER_NOT_STARTED"],
        [{ checkpoint: new Error("db") }, "LAUNCH2_ACTIVITY_READ_FAILED"],
        [{ launch2Error: new Error("db") }, "LAUNCH2_ACTIVITY_READ_FAILED"],
      ] as const) {
        const merge = mergeFake({
          transfers: [timedTransfer(transferRecord)],
          launch2: [
            launch2Record(
              "launch2_curve_buy",
              "2026-10-19T11:00:00.000Z",
              "1",
              0,
            ),
          ],
          ...options,
        });
        const { app } = await mergedApp(merge, "on");
        const response = await app.inject({
          method: "GET",
          url: `/v2/wallets/${walletId}/activity`,
          headers: commonHeaders(),
        });
        expect(response.statusCode, reasonCode).toBe(200);
        const body = response.json<{
          readonly items: readonly Record<string, unknown>[];
          readonly launch2: Record<string, unknown>;
        }>();
        expect(body.launch2).toEqual({ status: "unavailable", reasonCode });
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).not.toHaveProperty("kind");
      }
    });

    it("fails closed without the merge reads, and keeps INDEXING_DELAYED (on)", async () => {
      const { app } = await mergedApp(undefined, "on");
      const response = await app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

      const { app: delayed } = await mergedApp(mergeFake(), "on", {
        bscIndexer: indexerFake({ checkpoint: false }),
      });
      const late = await delayed.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity`,
        headers: commonHeaders(),
      });
      expect(late.statusCode).toBe(503);
      expect(late.json()).toMatchObject({ code: "INDEXING_DELAYED" });
    });

    it("counts launch2 confirmations as null when the Launch head is unreadable (on)", async () => {
      const dependencies = fakes();
      const database = {
        ...dependencies.database,
        walletActivityMerge: mergeFake({
          launch2: [
            launch2Record(
              "launch2_curve_buy",
              "2026-10-19T11:00:00.000Z",
              "1",
              0,
            ),
          ],
        }),
      };
      const { app } = await createApp(
        {
          ...dependencies,
          launchChainReadClient: launchClientFake({ configured: false }),
          database,
        },
        { LAUNCH_CHAIN_ID: "97", WALLET_ACTIVITY_LAUNCH2_EMIT: "on" },
      );
      const response = await app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/activity`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [{ kind: "launch2_curve_buy", confirmations: null }],
        launch2: { status: "available", headBlockNumber: null },
      });
    });
  });

  it("reports INDEXING_DELAYED instead of an empty activity page", async () => {
    const { app } = await createApp(fakes({ checkpoint: false }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/activity`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "INDEXING_DELAYED" });
  });

  it("returns the receive address and an EIP-681 request for BSC only", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${walletId}/receive`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      walletId,
      networks: [
        {
          chainId: "eip155:56",
          name: "BNB Smart Chain",
          address: walletAddress,
          uri: `ethereum:${walletAddress}@56`,
          warningKey: "wallet.receive.bscOnly",
        },
      ],
      contractVersion: "2.0",
    });
  });

  it("returns NOT_FOUND for a wallet owned by another account", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/wallets/${otherWalletId}/receive`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(404);
  });

  it("projects the watchlist with registry identity per asset", async () => {
    // `market` serves the logo proxy route the items' logos point at.
    const { app } = await createApp(fakes(), {
      V2_MODULES_ENABLED: "chain,wallet,watchlist,market",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/watchlist",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: 1,
      updatedAt: observedAt,
      groups: [
        {
          key: "default",
          name: "All",
          items: [
            {
              assetId: wbnbAssetId,
              asset: {
                symbol: "WBNB",
                name: "Wrapped BNB",
                decimals: 18,
                status: "pending",
              },
              logo: {
                status: "available",
                url: `http://127.0.0.1:3000/v2/market/logos/eip155:56/${wbnb}.png`,
                source: "trustwallet",
                observedAt: null,
              },
              reasonCode: null,
            },
          ],
        },
      ],
      contractVersion: "2.0",
    });
  });

  it("replaces the watchlist through compare-and-swap and rejects an unknown asset", async () => {
    const { app, watchlistReplace } = await createApp();
    const accepted = await app.inject({
      method: "PUT",
      url: "/v2/watchlist",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 1,
        groups: [
          { key: "mining", name: "Mining", items: [{ assetId: wbnbAssetId }] },
        ],
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ version: 2 });
    expect(watchlistReplace).toHaveBeenCalledTimes(1);

    const unknown = await app.inject({
      method: "PUT",
      url: "/v2/watchlist",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 2,
        groups: [
          {
            key: "mining",
            name: "Mining",
            items: [
              {
                assetId: "eip155:56:0x00000000000000000000000000000000000000ff",
              },
            ],
          },
        ],
      },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(watchlistReplace).toHaveBeenCalledTimes(1);
  });

  it("maps a stale watchlist version to VERSION_CONFLICT", async () => {
    const { app } = await createApp(fakes({ watchlistConflict: true }));
    const response = await app.inject({
      method: "PUT",
      url: "/v2/watchlist",
      headers: commonHeaders(),
      payload: {
        expectedVersion: 0,
        groups: [
          { key: "mining", name: "Mining", items: [{ assetId: wbnbAssetId }] },
        ],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "VERSION_CONFLICT" });
  });

  describe("RPC timeouts on the balances legs (Decision 0082)", () => {
    const usd1 = "0x2222222222222222222222222222222222222222";
    const launchContract = "0x1111111111111111111111111111111111111111";
    const contractKeys = {
      LAUNCH_CONTRACT_ADDRESS: launchContract,
      LAUNCH_CONTRACT_VERSION: "1.0.0",
      LAUNCH_CONTRACT_START_BLOCK: "1",
      LAUNCH_USD1_ADDRESS: usd1,
    };
    /** The error viem's point-read transport raised in production. */
    const rpcTimeout = (): TimeoutError =>
      new TimeoutError({
        body: { method: "eth_getBlockByNumber", params: ["latest", false] },
        url: "https://bsc-rpc.publicnode.com",
      });
    const readBalances = async (app: FastifyInstance) =>
      app.inject({
        method: "GET",
        url: `/v2/wallets/${walletId}/balances`,
        headers: commonHeaders(),
      });

    /** A launch slot whose every chain read times out, like `readHead`. */
    function timingOutLaunchClient(): BscReadClient {
      return {
        ...launchClientFake(),
        getHead: () => Promise.reject(rpcTimeout()),
        readBalances: () => Promise.reject(rpcTimeout()),
        readAllowances: () => Promise.reject(rpcTimeout()),
      } as unknown as BscReadClient;
    }

    it("asks the primary block once more after a point-read timeout and serves 200", async () => {
      const base = readClientFake();
      const primaryRead = vi
        .fn<BscReadClient["readBalances"]>()
        .mockRejectedValueOnce(rpcTimeout())
        .mockImplementation((owner, items) => base.readBalances(owner, items));
      const { app } = await createApp({
        ...fakes(),
        bscReadClient: { ...base, readBalances: primaryRead },
      });
      const response = await readBalances(app);
      expect(response.statusCode).toBe(200);
      expect(primaryRead).toHaveBeenCalledTimes(2);
      expect(
        response.json<{ readonly snapshot: { readonly blockNumber: string } }>()
          .snapshot.blockNumber,
      ).toBe(headNumber.toString(10));
    });

    it("reports a primary chain that times out twice as CAPABILITY_UNAVAILABLE, never INTERNAL_ERROR", async () => {
      const base = readClientFake();
      const primaryRead = vi.fn<BscReadClient["readBalances"]>(() =>
        Promise.reject(rpcTimeout()),
      );
      const { app } = await createApp({
        ...fakes(),
        bscReadClient: {
          ...base,
          getHead: () => Promise.reject(rpcTimeout()),
          readBalances: primaryRead,
        },
      });
      const response = await readBalances(app);
      expect(response.statusCode).toBe(503);
      expect(primaryRead).toHaveBeenCalledTimes(2);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        retryable: true,
        detailsSafe: { reasonCode: "BSC_RPC_UNREACHABLE" },
        providerReferenceSafe: null,
      });
      expect(response.body).not.toContain("publicnode");
    });

    it("asks once more after a chain-id probe that did not answer", async () => {
      const base = readClientFake();
      const primaryRead = vi
        .fn<BscReadClient["readBalances"]>()
        .mockRejectedValueOnce(
          new BscReadUnavailableError("BSC_RPC_UNREACHABLE"),
        )
        .mockImplementation((owner, items) => base.readBalances(owner, items));
      const { app } = await createApp({
        ...fakes(),
        bscReadClient: { ...base, readBalances: primaryRead },
      });
      const response = await readBalances(app);
      expect(response.statusCode).toBe(200);
      expect(primaryRead).toHaveBeenCalledTimes(2);
    });

    it("does not retry a primary failure that is final", async () => {
      const base = readClientFake();
      const primaryRead = vi.fn<BscReadClient["readBalances"]>(() =>
        Promise.reject(new BscChainMismatchError()),
      );
      const { app } = await createApp({
        ...fakes(),
        bscReadClient: { ...base, readBalances: primaryRead },
      });
      const response = await readBalances(app);
      expect(response.statusCode).toBe(503);
      expect(primaryRead).toHaveBeenCalledTimes(1);
    });

    it("keeps the page 200 when the launch slot's head read times out", async () => {
      const { app } = await createApp(
        { ...fakes(), launchChainReadClient: timingOutLaunchClient() },
        { LAUNCH_CHAIN_ID: "97", ...contractKeys },
      );
      const response = await readBalances(app);
      expect(response.statusCode).toBe(200);
      const body = response.json<
        BalancesBody & { readonly launchChain: unknown }
      >();
      expect(body.balances).toHaveLength(2);
      // The usd1 pair is absent (never null, never a guess).
      expect(body.launchChain).toEqual({
        chainId: "eip155:97",
        availability: "unavailable",
        reasonCode: "LAUNCH_CHAIN_RPC_UNREACHABLE",
        nativeBalance: null,
      });
    });

    it("reports an unclassified launch-slot failure inside launchChain", async () => {
      const client = {
        ...launchClientFake(),
        readBalances: () => Promise.reject(new TypeError("unexpected shape")),
      } as unknown as BscReadClient;
      const { app } = await createApp(
        { ...fakes(), launchChainReadClient: client },
        { LAUNCH_CHAIN_ID: "97" },
      );
      const response = await readBalances(app);
      expect(response.statusCode).toBe(200);
      expect(
        response.json<{ readonly launchChain: unknown }>().launchChain,
      ).toEqual({
        chainId: "eip155:97",
        availability: "unavailable",
        reasonCode: "BSC_BALANCE_CALL_FAILED",
        nativeBalance: null,
      });
    });

    it("leaves launchUsd1 absent on a shared slot whose USD1 reads time out", async () => {
      const base = readClientFake();
      const primary = {
        ...base,
        readBalances: (
          owner: string,
          items: readonly { assetId: string; address: string | null }[],
        ) =>
          items.length === 1 && items[0]?.address === usd1
            ? Promise.reject(rpcTimeout())
            : base.readBalances(owner, items),
        readAllowances: () => Promise.reject(rpcTimeout()),
      } as unknown as BscReadClient;
      const { app } = await createApp(
        { ...fakes(), bscReadClient: primary },
        { LAUNCH_CHAIN_ID: "56", ...contractKeys },
      );
      const response = await readBalances(app);
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty("launchUsd1");
      expect(body).not.toHaveProperty("launchChain");
    });

    describe("USD1 allowance pinned to the balance block (S86b)", () => {
      /**
       * A slot whose USD1 balance read observes `balanceHead`, and whose
       * allowance read answers at the pinned block when given one, else at
       * the next block (the ~3% race S86b removes). `refusePinned` stands for
       * an endpoint that no longer serves the pinned block.
       */
      function pinningClient(
        base: BscReadClient,
        balanceHead: bigint,
        blockHash: string,
        options: {
          readonly pinnedAt: (bigint | undefined)[];
          readonly refusePinned?: boolean;
        },
      ): BscReadClient {
        return {
          ...base,
          readBalances: (
            owner: string,
            items: readonly { assetId: string; address: string | null }[],
          ) =>
            items.length === 1 && items[0]?.address === usd1
              ? Promise.resolve({
                  head: { blockNumber: balanceHead, blockHash, observedAt },
                  balances: [
                    {
                      assetId: items[0].assetId,
                      rawValue: 9_000_000_000_000_000_000n,
                      reasonCode: null,
                    },
                  ],
                })
              : base.readBalances(owner, items),
          readAllowances: (
            _owner: string,
            items: readonly { assetId: string; spender: string }[],
            readOptions?: { readonly atBlock?: bigint },
          ) => {
            options.pinnedAt.push(readOptions?.atBlock);
            if (options.refusePinned === true) {
              return Promise.reject(
                new BscReadUnavailableError("BSC_PINNED_BLOCK_UNAVAILABLE"),
              );
            }
            return Promise.resolve({
              head: {
                blockNumber: readOptions?.atBlock ?? balanceHead + 1n,
                blockHash,
                observedAt,
              },
              allowances: items.map((item) => ({
                assetId: item.assetId,
                spender: item.spender,
                rawValue: 4_000_000_000_000_000_000n,
                reasonCode: null,
              })),
            });
          },
        } as unknown as BscReadClient;
      }
      const pair = {
        balance: "9000000000000000000",
        allowance: "4000000000000000000",
      };

      it("reads launchChain.usd1 at the block its balance read observed", async () => {
        const pinnedAt: (bigint | undefined)[] = [];
        const { app } = await createApp(
          {
            ...fakes(),
            launchChainReadClient: pinningClient(
              launchClientFake(),
              launchHeadNumber,
              launchHeadHash,
              { pinnedAt },
            ),
          },
          { LAUNCH_CHAIN_ID: "97", ...contractKeys },
        );
        const response = await readBalances(app);
        expect(response.statusCode).toBe(200);
        expect(
          response.json<{ readonly launchChain: Record<string, unknown> }>()
            .launchChain["usd1"],
        ).toEqual(pair);
        expect(pinnedAt).toEqual([launchHeadNumber]);
      });

      it("reads the shared-slot launchUsd1 at the block its balance read observed", async () => {
        const pinnedAt: (bigint | undefined)[] = [];
        const { app } = await createApp(
          {
            ...fakes(),
            bscReadClient: pinningClient(
              readClientFake(),
              headNumber,
              headHash,
              { pinnedAt },
            ),
          },
          { LAUNCH_CHAIN_ID: "56", ...contractKeys },
        );
        const response = await readBalances(app);
        expect(response.statusCode).toBe(200);
        expect(response.json<Record<string, unknown>>()["launchUsd1"]).toEqual(
          pair,
        );
        expect(pinnedAt).toEqual([headNumber]);
      });

      it("omits the pair, never a 500, when the endpoint refuses the pinned block", async () => {
        const separatePinned: (bigint | undefined)[] = [];
        const { app: separate } = await createApp(
          {
            ...fakes(),
            launchChainReadClient: pinningClient(
              launchClientFake(),
              launchHeadNumber,
              launchHeadHash,
              { pinnedAt: separatePinned, refusePinned: true },
            ),
          },
          { LAUNCH_CHAIN_ID: "97", ...contractKeys },
        );
        const split = await readBalances(separate);
        expect(split.statusCode).toBe(200);
        const launchChain = split.json<{
          readonly launchChain: Record<string, unknown>;
        }>().launchChain;
        expect(launchChain).not.toHaveProperty("usd1");
        expect(launchChain["availability"]).toBe("available");
        expect(separatePinned).toEqual([launchHeadNumber]);

        const sharedPinned: (bigint | undefined)[] = [];
        const { app: shared } = await createApp(
          {
            ...fakes(),
            bscReadClient: pinningClient(
              readClientFake(),
              headNumber,
              headHash,
              { pinnedAt: sharedPinned, refusePinned: true },
            ),
          },
          { LAUNCH_CHAIN_ID: "56", ...contractKeys },
        );
        const joined = await readBalances(shared);
        expect(joined.statusCode).toBe(200);
        expect(joined.json<Record<string, unknown>>()).not.toHaveProperty(
          "launchUsd1",
        );
        expect(sharedPinned).toEqual([headNumber]);
      });
    });

    it("leaves every row unvalued when the price read fails outright", async () => {
      const facts = marketFactsFake("fresh");
      const { app } = await createApp(
        fakes(),
        {},
        {
          ...facts,
          readAssetPrices: vi.fn(() => Promise.reject(rpcTimeout())),
        },
      );
      const response = await readBalances(app);
      expect(response.statusCode).toBe(200);
      const body = response.json<BalancesBody>();
      for (const row of body.balances) {
        expect(row.valuation).toEqual({
          status: "unavailable",
          reasonCode: "MARKET_PROVIDER_UNREACHABLE",
        });
        expect(row.balance["status"]).toBe("available");
      }
    });
  });

  it("requires the V2 contract header and a Bearer token", async () => {
    const { app } = await createApp();
    const withoutContract = await app.inject({
      method: "GET",
      url: "/v2/watchlist",
      headers: commonHeaders({ "x-loop-contract-version": undefined }),
    });
    expect(withoutContract.statusCode).toBe(400);

    const withoutToken = await app.inject({
      method: "GET",
      url: "/v2/watchlist",
      headers: commonHeaders({ authorization: undefined }),
    });
    expect(withoutToken.statusCode).toBe(401);
    expect(withoutToken.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
  });

  describe("Decision 0145 net worth history", () => {
    const historyUrl = (range: string, id = walletId) =>
      `/v2/wallets/${id}/networth/history?range=${range}`;

    function snapshotsFake(
      options: {
        readonly fail?: boolean;
        readonly points?: readonly WalletNetWorthSnapshotRecord[];
        readonly baseline?: WalletNetWorthSnapshotRecord | null;
      } = {},
    ) {
      const reject = (): Promise<never> =>
        Promise.reject(new Error("relation does not exist"));
      const points = options.points ?? [];
      const readDownsampled = vi.fn(() =>
        options.fail === true ? reject() : Promise.resolve(points),
      );
      const repository: WalletNetWorthSnapshotRepository = {
        listSnapshotCandidates: vi.fn(() => reject()),
        recordSnapshots: vi.fn(() => reject()),
        readDownsampled,
        readExtremes: vi.fn(() =>
          options.fail === true
            ? reject()
            : Promise.resolve({
                high: points.at(0) ?? null,
                low: points.at(-1) ?? null,
              }),
        ),
        readLatest: vi.fn((input: { readonly notBefore: string | null }) =>
          options.fail === true
            ? reject()
            : Promise.resolve(
                input.notBefore === null
                  ? (points.at(-1) ?? null)
                  : (options.baseline ?? null),
              ),
        ),
      };
      return { repository, readDownsampled };
    }

    async function historyApp(
      snapshots: WalletNetWorthSnapshotRepository | undefined,
      overrides: Readonly<Record<string, string>> = {},
      facts: MarketFactService | undefined = marketFactsFake("fresh"),
      fiatRates?: FiatFxRateRepository,
    ) {
      const dependencies = fakes();
      return createApp(
        {
          ...dependencies,
          database: {
            ...dependencies.database,
            ...(snapshots === undefined
              ? {}
              : { walletNetWorthSnapshots: snapshots }),
            ...(fiatRates === undefined ? {} : { fiatFxRates: fiatRates }),
          },
        },
        overrides,
        facts,
      );
    }

    it("answers the documented document with current valued live like the balances netWorth", async () => {
      const baseline = {
        at: "2026-10-14T11:00:00.000Z",
        netWorthUsd: "6000",
        quality: "fresh" as const,
      };
      const points = [
        {
          at: "2026-10-14T13:00:00.000Z",
          netWorthUsd: "6500",
          quality: "fresh" as const,
        },
        {
          at: "2026-10-15T11:00:00.000Z",
          netWorthUsd: "6100.5",
          quality: "partial" as const,
        },
      ];
      const fake = snapshotsFake({ points, baseline });
      const fetchedAt = new Date(Date.now() - 3_600_000).toISOString();
      const readLatestRate = vi.fn(() =>
        Promise.resolve({
          base: "USD",
          quote: "CNY",
          rate: "7.113",
          source: "ecb",
          providerAsOf: "2026-10-15",
          fetchedAt,
          quality: "fresh" as const,
        }),
      );
      const { app } = await historyApp(
        fake.repository,
        {},
        marketFactsFake("fresh"),
        {
          recordRate: vi.fn(() => Promise.resolve()),
          readLatest: readLatestRate,
        },
      );
      const response = await app.inject({
        method: "GET",
        url: historyUrl("7d"),
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<Record<string, unknown>>();
      // 1.5 WBNB + 7 BNB (WBNB proxy) at 747.39.
      expect(body).toMatchObject({
        walletId,
        range: "7d",
        points,
        current: {
          netWorthUsd: "6352.815",
          quality: "fresh",
          origin: "live",
        },
        change24h: { usd: "352.815", pct: "5.8803", baselineAt: baseline.at },
        high: { netWorthUsd: "6500", at: points[0]?.at },
        low: { netWorthUsd: "6100.5", at: points[1]?.at },
        fiat: {
          currency: "CNY",
          rate: "7.113",
          amount: "45187.57",
          source: "ecb",
          asOf: "2026-10-15",
          fetchedAt,
          quality: "fresh",
        },
        source: "dexscreener",
        contractVersion: "2.0",
      });
      expect(fake.readDownsampled).toHaveBeenCalledWith(
        expect.objectContaining({ bucketSeconds: 14_400, limit: 120 }),
      );
      expect(readLatestRate).toHaveBeenCalledWith({
        base: "USD",
        quote: "CNY",
      });
    });

    it("publishes fiat null when the rate read fails, without failing the history", async () => {
      const { app } = await historyApp(
        snapshotsFake().repository,
        {},
        marketFactsFake("fresh"),
        {
          recordRate: vi.fn(() => Promise.resolve()),
          readLatest: vi.fn(() =>
            Promise.reject(new Error("relation does not exist")),
          ),
        },
      );
      const response = await app.inject({
        method: "GET",
        url: historyUrl("1d"),
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        current: { netWorthUsd: "6352.815" },
        fiat: null,
      });
    });

    it("answers current alone, without a 24 h change or fiat, before the first snapshot", async () => {
      const { app } = await historyApp(snapshotsFake().repository);
      const response = await app.inject({
        method: "GET",
        url: historyUrl("1d"),
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        points: [],
        current: { netWorthUsd: "6352.815", origin: "live" },
        change24h: null,
        high: { netWorthUsd: "6352.815" },
        low: { netWorthUsd: "6352.815" },
        fiat: null,
      });
    });

    it("rejects an unknown range, a missing range, and an extra query field", async () => {
      const { app } = await historyApp(snapshotsFake().repository);
      for (const url of [
        historyUrl("2d"),
        `/v2/wallets/${walletId}/networth/history`,
        `${historyUrl("1d")}&cursor=x`,
      ]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: commonHeaders(),
        });
        expect(response.statusCode, url).toBe(400);
        expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      }
    });

    it("requires a Bearer token and only reads the caller's own wallet", async () => {
      const { app } = await historyApp(snapshotsFake().repository);
      const anonymous = await app.inject({
        method: "GET",
        url: historyUrl("1d"),
        headers: commonHeaders({ authorization: undefined }),
      });
      expect(anonymous.statusCode).toBe(401);
      const foreign = await app.inject({
        method: "GET",
        url: historyUrl("1d", otherWalletId),
        headers: commonHeaders(),
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({ code: "NOT_FOUND" });
    });

    it("answers 503 WALLET_NETWORTH_HISTORY_UNAVAILABLE when the snapshots cannot be read or are not composed", async () => {
      for (const snapshots of [
        snapshotsFake({ fail: true }).repository,
        undefined,
      ]) {
        const { app } = await historyApp(snapshots);
        const response = await app.inject({
          method: "GET",
          url: historyUrl("30d"),
          headers: commonHeaders(),
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          code: "CAPABILITY_UNAVAILABLE",
          detailsSafe: { reasonCode: "WALLET_NETWORTH_HISTORY_UNAVAILABLE" },
        });
      }
    });

    it("falls back to the newest snapshot when nothing can be valued live, and answers 503 WALLET_NETWORTH_CURRENT_UNAVAILABLE without one", async () => {
      const unpriced = marketFactsFake("unavailable");
      const latest = {
        at: "2026-10-15T11:00:00.000Z",
        netWorthUsd: "10",
        quality: "fresh" as const,
      };
      const { app } = await historyApp(
        snapshotsFake({ points: [latest] }).repository,
        {},
        unpriced,
      );
      const response = await app.inject({
        method: "GET",
        url: historyUrl("1d"),
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        current: {
          netWorthUsd: "10",
          at: latest.at,
          quality: "stale",
          origin: "snapshot",
        },
      });

      const { app: empty } = await historyApp(
        snapshotsFake().repository,
        {},
        unpriced,
      );
      const none = await empty.inject({
        method: "GET",
        url: historyUrl("1d"),
        headers: commonHeaders(),
      });
      expect(none.statusCode).toBe(503);
      expect(none.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "WALLET_NETWORTH_CURRENT_UNAVAILABLE" },
      });
    });
  });
});
