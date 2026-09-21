import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../src/database/account-wallet-repository.js";
import type { BscIndexerRepository } from "../src/database/bsc-indexer-repository.js";
import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import type { AssetRegistryService } from "../src/features/chain/asset-registry-service.js";
import type {
  AssetPriceFact,
  MarketFactService,
} from "../src/features/market/market-fact-service.js";
import {
  createWalletReadService,
  walletReasonCodes,
  type WalletBalancesResource,
} from "../src/features/wallet/wallet-read-service.js";
import type {
  BscBalanceReadResult,
  BscReadClient,
} from "../src/integrations/bsc/rpc-client.js";
import type {
  PrivyBalanceReader,
  PrivyWalletReader,
} from "../src/integrations/privy/wallet-reader.js";

/**
 * The wallet page reads one block, one Provider price per asset, one Provider
 * balance view, and one launch-slot balance. These cases pin how those reads
 * relate to each other in time (Decision 0063) and that relating them
 * differently never changes the document that is published.
 */

const walletId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const walletAddress = "0x00000000000000000000000000000000000000a1";
const observedAt = "2026-09-20T00:00:00.000Z";
const headNumber = 44_000_000n;
const headHash = `0x${"1".repeat(64)}`;
const launchHeadHash = `0x${"9".repeat(64)}`;
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

const principal: AuthenticatedLoopPrincipal = Object.freeze({
  userId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
  privyUserId: "did:privy:verified-user",
  streamUserId: "stream-user",
});

function asset(
  overrides: Partial<AssetRecord> & { assetId: string },
): AssetRecord {
  return Object.freeze({
    chainId: "eip155:56",
    address: null,
    symbol: "BNB",
    name: "BNB",
    decimals: 18,
    status: "verified",
    sourceKind: "chain_native",
    sourceBlockNumber: null,
    sourceVerifiedAt: null,
    updatedAt: observedAt,
    ...overrides,
  });
}

const assets: readonly AssetRecord[] = Object.freeze([
  asset({ assetId: "eip155:56:native" }),
  asset({
    assetId: `eip155:56:${usdt}`,
    address: usdt,
    symbol: "USDT",
    name: "Tether USD",
    sourceKind: "chain_call",
  }),
  asset({
    assetId: `eip155:56:${wbnb}`,
    address: wbnb,
    symbol: "WBNB",
    name: "Wrapped BNB",
    sourceKind: "chain_call",
  }),
]);

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

/** A promise a test resolves by hand, so leg order is decided by the test. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function balanceResult(): BscBalanceReadResult {
  return {
    head: { blockNumber: headNumber, blockHash: headHash, observedAt },
    balances: assets.map((entry, index) => ({
      assetId: entry.assetId,
      rawValue: BigInt(index + 1) * 1_000_000_000_000_000_000n,
      reasonCode: null,
    })),
  };
}

function priceFact(priceUsd: string): AssetPriceFact {
  return Object.freeze({
    fact: Object.freeze({
      value: Object.freeze({
        tokenAddress: usdt,
        pairs: [],
        unrepresentablePairCount: 0,
      }),
      source: "dexscreener" as const,
      fetchedAt: observedAt,
      ttlSeconds: 30,
      quality: "fresh" as const,
      reasonCode: null,
      rawDigest: null,
    }),
    pair: Object.freeze({
      pairAddress: `0x${"4".repeat(40)}`,
      dexId: "pancakeswap",
      baseTokenAddress: usdt,
      baseTokenSymbol: "USDT",
      quoteTokenAddress: wbnb,
      quoteTokenSymbol: "WBNB",
      priceUsd,
      priceNative: null,
      liquidityUsd: "1000000",
      volumeH24: null,
      priceChangeH24: null,
      fdv: null,
      marketCap: null,
      buysH24: null,
      sellsH24: null,
      pairCreatedAt: null,
    }),
    proxyAsset: null,
  }) as unknown as AssetPriceFact;
}

interface Harness {
  readonly service: ReturnType<typeof createWalletReadService>;
  readonly started: string[];
  readonly logger: { debug: ReturnType<typeof vi.fn> };
  readonly listEthereumWallets: ReturnType<typeof vi.fn>;
  readonly recordBalanceSnapshot: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    readonly chainBalances?: () => Promise<BscBalanceReadResult>;
    readonly launchBalances?: () => Promise<BscBalanceReadResult>;
    readonly privyBalances?: () => Promise<
      readonly { asset: string; rawValue: string; decimals: number }[]
    >;
    readonly prices?: () => Promise<readonly AssetPriceFact[]>;
    readonly walletInventoryTtlMs?: number;
    readonly now?: () => Date;
  } = {},
): Harness {
  const started: string[] = [];
  const recordBalanceSnapshot = vi.fn(() => Promise.resolve());
  const repository: AccountWalletRepository = {
    sync: vi.fn(() => Promise.resolve([walletRecord])),
    list: vi.fn(() => Promise.resolve([walletRecord])),
    get: vi.fn(() => {
      started.push("walletRecord");
      return Promise.resolve(walletRecord);
    }),
    setActive: vi.fn(() => Promise.resolve([walletRecord])),
    recordBalanceSnapshot,
  };
  const indexerRepository = {
    getCheckpoint: vi.fn(() => {
      started.push("checkpoint");
      return Promise.resolve({
        lastBlockNumber: (headNumber - 5n).toString(10),
        lastBlockHash: `0x${"3".repeat(64)}`,
        startedFromBlockNumber: "43000000",
        approvalCoverageFromBlockNumber: "43000000",
        reorgCount: 0,
        updatedAt: observedAt,
      });
    }),
    sumPendingIncoming: vi.fn(() => Promise.resolve([])),
  } as unknown as BscIndexerRepository;
  const assetRegistry: AssetRegistryService = {
    getAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listReadableAssets: vi.fn(() => {
      started.push("assetRegistry");
      return Promise.resolve(assets);
    }),
    registerFromChain: vi.fn(() => Promise.reject(new Error("not used"))),
  };
  const readClient = {
    chainId: "eip155:56",
    chainReference: 56,
    confirmations: 15,
    reorgDepthBlocks: 64,
    endpointRefs: ["rpc-abcdefabcdef"],
    verifyChain: () => Promise.resolve("verified" as const),
    currentVerification: () => "verified" as const,
    readBalances: vi.fn(() => {
      started.push("chainBalances");
      return (
        options.chainBalances ?? (() => Promise.resolve(balanceResult()))
      )();
    }),
  } as unknown as BscReadClient;
  const launchChainReadClient = {
    chainId: "eip155:97",
    chainReference: 97,
    confirmations: 5,
    reorgDepthBlocks: 15,
    endpointRefs: ["rpc-fedcbafedcba"],
    verifyChain: () => Promise.resolve("verified" as const),
    currentVerification: () => "verified" as const,
    readBalances: vi.fn(() => {
      started.push("launchChain");
      return (
        options.launchBalances ??
        ((): Promise<BscBalanceReadResult> =>
          Promise.resolve({
            head: {
              blockNumber: 52_000_000n,
              blockHash: launchHeadHash,
              observedAt,
            },
            balances: [
              {
                assetId: "eip155:97:native",
                rawValue: 5_000_000_000_000_000_000n,
                reasonCode: null,
              },
            ],
          }))
      )();
    }),
  } as unknown as BscReadClient;
  const listEthereumWallets = vi.fn(() =>
    Promise.resolve([
      {
        address: walletAddress,
        kind: "embedded" as const,
        providerWalletId: "wallet_privy_1",
      },
    ]),
  );
  const walletReader: PrivyWalletReader = { listEthereumWallets };
  const balanceReader: PrivyBalanceReader = {
    readBscBalances: vi.fn(() => {
      started.push("privyCrossCheck");
      return (
        options.privyBalances ??
        (() =>
          Promise.resolve([
            { asset: "bnb", rawValue: "1000000000000000000", decimals: 18 },
          ]))
      )();
    }),
  };
  const marketFacts = {
    readAssetPrices: vi.fn(() => {
      started.push("assetPrices");
      return (
        options.prices ??
        (() => Promise.resolve(assets.map(() => priceFact("1.5"))))
      )();
    }),
  } as unknown as MarketFactService;
  const logger = { debug: vi.fn() };
  const service = createWalletReadService({
    repository,
    indexerRepository,
    assetRegistry,
    readClient,
    walletReader,
    balanceReader,
    cursorCodec: null,
    marketFacts,
    gasReserveRawWei: 1_000_000_000_000_000n,
    chainId: "eip155:56",
    chainName: "BNB Smart Chain",
    chainReference: 56,
    launchChainReadClient,
    logger,
    ...(options.walletInventoryTtlMs === undefined
      ? {}
      : { walletInventoryTtlMs: options.walletInventoryTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    service,
    started,
    logger,
    listEthereumWallets,
    recordBalanceSnapshot,
  };
}

function getBalances(subject: Harness): Promise<WalletBalancesResource> {
  return subject.service.getBalances({
    principal,
    walletId,
    signal: new AbortController().signal,
  });
}

describe("wallet balances read", () => {
  it("has the prices, the launch slot, and the Provider balance view in flight at the same time", async () => {
    const prices = deferred<readonly AssetPriceFact[]>();
    const launch = deferred<BscBalanceReadResult>();
    const privy =
      deferred<
        readonly { asset: string; rawValue: string; decimals: number }[]
      >();
    const subject = harness({
      prices: () => prices.promise,
      launchBalances: () => launch.promise,
      privyBalances: () => privy.promise,
    });

    const pending = getBalances(subject);
    await vi.waitFor(() => {
      expect(subject.started).toContain("assetPrices");
      expect(subject.started).toContain("launchChain");
      expect(subject.started).toContain("privyCrossCheck");
    });

    // None of the three has answered yet, so none of them was waiting for
    // another to finish.
    prices.resolve(assets.map(() => priceFact("2")));
    launch.resolve({
      head: {
        blockNumber: 52_000_000n,
        blockHash: launchHeadHash,
        observedAt,
      },
      balances: [
        {
          assetId: "eip155:97:native",
          rawValue: 5_000_000_000_000_000_000n,
          reasonCode: null,
        },
      ],
    });
    privy.resolve([
      { asset: "bnb", rawValue: "1000000000000000000", decimals: 18 },
    ]);

    const resource = await pending;
    expect(resource.snapshot.blockNumber).toBe(headNumber.toString(10));
    expect(resource.balances).toHaveLength(assets.length);
  });

  it("publishes the same document however the legs are ordered", async () => {
    const inOrder = await getBalances(harness());
    const slowPrices = deferred<readonly AssetPriceFact[]>();
    const outOfOrder = harness({ prices: () => slowPrices.promise });
    const pending = getBalances(outOfOrder);
    await vi.waitFor(() => {
      expect(outOfOrder.started).toContain("assetPrices");
    });
    slowPrices.resolve(assets.map(() => priceFact("1.5")));

    expect(await pending).toEqual(inOrder);
  });

  it("keeps the registry order of the rows and prices each row from its own fact", async () => {
    const resource = await getBalances(
      harness({
        prices: () =>
          Promise.resolve([priceFact("10"), priceFact("20"), priceFact("30")]),
      }),
    );

    expect(resource.balances.map((row) => row.assetId)).toEqual(
      assets.map((entry) => entry.assetId),
    );
    expect(
      resource.balances.map((row) =>
        row.valuation.status === "available" ? row.valuation.priceUsd : null,
      ),
    ).toEqual(["10", "20", "30"]);
    expect(
      resource.balances.map((row) =>
        row.valuation.status === "available" ? row.valuation.valueUsd : null,
      ),
    ).toEqual(["10", "40", "90"]);
  });

  it("reports the launch slot unreadable when it does not answer in time, and still publishes the block it did read", async () => {
    vi.useFakeTimers();
    try {
      const subject = harness({
        launchBalances: () => new Promise<BscBalanceReadResult>(() => {}),
      });
      const pending = getBalances(subject);
      await vi.advanceTimersByTimeAsync(3_000);
      const resource = await pending;

      expect(resource.launchChain).toEqual({
        chainId: "eip155:97",
        availability: "unavailable",
        reasonCode: "LAUNCH_CHAIN_RPC_UNREACHABLE",
        nativeBalance: null,
      });
      expect(resource.snapshot.blockHash).toBe(headHash);
      expect(resource.balances[0]?.balance.status).toBe("available");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a Provider balance view that failed as an unavailable cross-check, never as a balance", async () => {
    const resource = await getBalances(
      harness({
        privyBalances: () => Promise.reject(new Error("provider down")),
      }),
    );

    expect(resource.balances[0]?.crossCheck).toEqual({
      source: "privy",
      status: "unavailable",
      reasonCode: walletReasonCodes.privyCrossCheckFailed,
      blockDelta: null,
    });
    expect(resource.balances[0]?.balance).toMatchObject({
      status: "available",
      rawValue: "1000000000000000000",
    });
  });

  it("logs one segment timing line that carries no address, amount, or wallet identity", async () => {
    const subject = harness();
    await getBalances(subject);

    expect(subject.logger.debug).toHaveBeenCalledTimes(1);
    const [context, message] = subject.logger.debug.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toBe("Wallet balances read segment timings");
    expect(context["assetCount"]).toBe(assets.length);
    expect(Object.keys(context["segmentsMs"] as object)).toEqual(
      expect.arrayContaining([
        "assetPrices",
        "chainBalances",
        "launchChain",
        "privyCrossCheck",
      ]),
    );
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(walletAddress);
    expect(serialized).not.toContain(walletId);
    expect(serialized).not.toContain(principal.userId);
    expect(serialized).not.toContain("1000000000000000000");
  });
});

describe("wallet inventory reuse", () => {
  it("serves one Privy observation for the window and reports when it was observed", async () => {
    let currentMs = Date.parse(observedAt);
    const subject = harness({
      walletInventoryTtlMs: 30_000,
      now: () => new Date(currentMs),
    });

    const first = await subject.service.listWallets({
      principal,
      signal: new AbortController().signal,
    });
    currentMs += 29_000;
    const second = await subject.service.listWallets({
      principal,
      signal: new AbortController().signal,
    });

    expect(subject.listEthereumWallets).toHaveBeenCalledTimes(1);
    expect(second.source.observedAt).toBe(first.source.observedAt);
    expect(first.source.observedAt).toBe(observedAt);

    currentMs += 2_000;
    const third = await subject.service.listWallets({
      principal,
      signal: new AbortController().signal,
    });
    expect(subject.listEthereumWallets).toHaveBeenCalledTimes(2);
    expect(third.source.observedAt).toBe(new Date(currentMs).toISOString());
  });

  it("asks the Provider every time when the window is disabled", async () => {
    const subject = harness({ walletInventoryTtlMs: 0 });

    await subject.service.listWallets({
      principal,
      signal: new AbortController().signal,
    });
    await subject.service.listWallets({
      principal,
      signal: new AbortController().signal,
    });

    expect(subject.listEthereumWallets).toHaveBeenCalledTimes(2);
  });
});
