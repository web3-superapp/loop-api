import { readFileSync } from "node:fs";

import type { FastifyInstance } from "fastify";
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
import type {
  CachedFact,
  MarketFactService,
} from "../src/features/market/market-fact-service.js";
import type { TokenPairsSnapshot } from "../src/integrations/market/market-data-provider.js";
import type {
  PrivyBalanceReader,
  PrivyWalletReader,
} from "../src/integrations/privy/wallet-reader.js";

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
    // was regenerated with it (rule URLs only: no market runtime here).
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
                  priceChangeH24: null,
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
    });
    expect(body.netWorth).toEqual({
      status: "available",
      valuationCurrency: "USD",
      valueUsd: "6352.815",
      unavailableCount: 0,
      quality: "fresh",
      priceSource: "dexscreener",
      asOf: observedAt,
      isSpendable: false,
    });
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
    const { app } = await createApp();
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
                url: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/logo.png",
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
});
