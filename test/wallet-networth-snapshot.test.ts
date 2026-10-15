import { describe, expect, it, vi } from "vitest";

import { loadConfig, loadReconciliationWorkerConfig } from "../src/config.js";
import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import type {
  WalletNetWorthSnapshotCandidate,
  WalletNetWorthSnapshotRepository,
} from "../src/database/wallet-networth-snapshot-repository.js";
import type { AssetPriceFact } from "../src/features/market/market-fact-service.js";
import {
  createWalletNetWorthHistoryService,
  walletNetWorthRangePolicy,
} from "../src/features/wallet/wallet-networth-history.js";
import {
  measureWalletNetWorth,
  priceReadFailure,
} from "../src/features/wallet/wallet-read-service.js";
import type { BscReadClient } from "../src/integrations/bsc/rpc-client.js";
import {
  createWalletNetWorthSnapshotLane,
  walletNetWorthSlotStart,
} from "../src/wallet-networth-snapshot-worker.js";

/**
 * Decision 0145 without PostgreSQL: the measurement (same valuation as the
 * balances netWorth; partial, never a zero), the lane's slots, pages and
 * counts, the history service's edges, and the configuration.
 */

const hourMs = 3_600_000;

function asset(address: string | null, decimals = 18): AssetRecord {
  return Object.freeze({
    assetId: address === null ? "eip155:56:native" : `eip155:56:${address}`,
    chainId: "eip155:56",
    address,
    symbol: "X",
    name: "X",
    decimals,
    status: "pending",
    sourceKind: "chain_call",
    sourceBlockNumber: null,
    sourceVerifiedAt: null,
    updatedAt: "2026-10-15T00:00:00.000Z",
  });
}

const tokenA = asset("0x00000000000000000000000000000000000000a1");
const tokenB = asset("0x00000000000000000000000000000000000000b1", 6);

function price(
  priceUsd: string | null,
  quality: "fresh" | "stale" = "fresh",
): AssetPriceFact {
  return {
    fact: {
      value: priceUsd === null ? null : {},
      fetchedAt: priceUsd === null ? null : "2026-10-15T11:59:00.000Z",
      quality: priceUsd === null ? "unavailable" : quality,
      reasonCode:
        priceUsd === null
          ? "MARKET_PAIR_NOT_FOUND"
          : quality === "stale"
            ? "MARKET_PROVIDER_RATE_LIMITED"
            : null,
      source: "dexscreener",
    },
    pair: priceUsd === null ? null : { priceUsd, priceChangeH24: null },
    proxyAsset: null,
  } as unknown as AssetPriceFact;
}

function client(
  raw: Readonly<Record<string, bigint | null>>,
): Pick<BscReadClient, "readBalances"> {
  return {
    readBalances: (_address, items) =>
      Promise.resolve({
        head: {
          blockNumber: 1n,
          blockHash: `0x${"1".repeat(64)}`,
          observedAt: "2026-10-15T12:00:00.000Z",
        },
        balances: items.map((item) => ({
          assetId: item.assetId,
          rawValue: raw[item.assetId] ?? null,
          reasonCode:
            raw[item.assetId] === undefined || raw[item.assetId] === null
              ? "BSC_BALANCE_CALL_FAILED"
              : null,
        })),
      }),
  };
}

describe("Decision 0145 measureWalletNetWorth", () => {
  it("sums the valued rows like the balances netWorth and rounds to 6 places", async () => {
    const measured = await measureWalletNetWorth({
      readClient: client({
        [tokenA.assetId]: 1_234_567_890_123_456_789n,
        [tokenB.assetId]: 2_500_000n,
      }),
      address: "0x00000000000000000000000000000000000000ff",
      assets: [tokenA, tokenB],
      prices: [price("0.3333333"), price("1")],
    });
    // 1.234567890123456789 × 0.3333333 + 2.5 = 2.9115225… → 2.911523
    expect(measured).toEqual({
      netWorthUsd: "2.911523",
      quality: "fresh",
      unavailableCount: 0,
      asOf: "2026-10-15T11:59:00.000Z",
    });
  });

  it("is stale with a stale price and partial with an unvalued row", async () => {
    const stale = await measureWalletNetWorth({
      readClient: client({ [tokenA.assetId]: 10n ** 18n }),
      address: "0x00000000000000000000000000000000000000ff",
      assets: [tokenA],
      prices: [price("2", "stale")],
    });
    expect(stale).toMatchObject({ netWorthUsd: "2", quality: "stale" });
    const partial = await measureWalletNetWorth({
      readClient: client({ [tokenA.assetId]: 10n ** 18n }),
      address: "0x00000000000000000000000000000000000000ff",
      assets: [tokenA, tokenB],
      prices: [price("2", "stale"), price("1")],
    });
    expect(partial).toMatchObject({
      netWorthUsd: "2",
      quality: "partial",
      unavailableCount: 1,
    });
  });

  it("records nothing (null), never a zero, when no row can be valued", async () => {
    for (const prices of [
      priceReadFailure,
      [price(null), price(null)],
    ] as const) {
      expect(
        await measureWalletNetWorth({
          readClient: client({
            [tokenA.assetId]: 1n,
            [tokenB.assetId]: 1n,
          }),
          address: "0x00000000000000000000000000000000000000ff",
          assets: [tokenA, tokenB],
          prices,
        }),
      ).toBeNull();
    }
    expect(
      await measureWalletNetWorth({
        readClient: client({}),
        address: "0x00000000000000000000000000000000000000ff",
        assets: [],
        prices: [],
      }),
    ).toBeNull();
  });

  it("values a zero balance as zero when it is priced", async () => {
    const measured = await measureWalletNetWorth({
      readClient: client({ [tokenA.assetId]: 0n }),
      address: "0x00000000000000000000000000000000000000ff",
      assets: [tokenA],
      prices: [price("3")],
    });
    expect(measured).toMatchObject({ netWorthUsd: "0", quality: "fresh" });
  });
});

describe("Decision 0145 wallet_networth_snapshot lane", () => {
  function repositoryFake(
    candidates: readonly WalletNetWorthSnapshotCandidate[],
  ) {
    const recorded: unknown[] = [];
    const listSnapshotCandidates = vi.fn(
      (input: {
        readonly afterWalletId: string | null;
        readonly limit: number;
      }) => {
        const start =
          input.afterWalletId === null
            ? 0
            : candidates.findIndex(
                (candidate) => candidate.walletId === input.afterWalletId,
              ) + 1;
        return Promise.resolve(candidates.slice(start, start + input.limit));
      },
    );
    const repository: WalletNetWorthSnapshotRepository = {
      listSnapshotCandidates,
      recordSnapshots: vi.fn((rows: readonly unknown[]) => {
        recorded.push(...rows);
        return Promise.resolve(rows.length);
      }),
      readDownsampled: vi.fn(() => Promise.reject(new Error("not used"))),
      readExtremes: vi.fn(() => Promise.reject(new Error("not used"))),
      readLatest: vi.fn(() => Promise.reject(new Error("not used"))),
    };
    return { repository, recorded, listSnapshotCandidates };
  }

  const wallets = ["a", "b", "c", "d", "e"].map((letter) => ({
    walletId: `00000000-0000-4000-8000-00000000000${letter}`,
    address: `0x${letter.repeat(40)}`,
  }));

  it("pages the candidates by wallet id, writes the slot start, and counts unvalued and failed wallets", async () => {
    const fake = repositoryFake(wallets);
    const readPrices = vi.fn(() => Promise.resolve([price("2")]));
    const lane = createWalletNetWorthSnapshotLane({
      repository: fake.repository,
      listAssets: () => Promise.resolve([tokenA]),
      readPrices,
      readClient: {
        readBalances: (address, items) =>
          address === wallets[1]?.address
            ? Promise.reject(new Error("rpc down"))
            : client({
                [tokenA.assetId]:
                  address === wallets[3]?.address ? null : 10n ** 18n,
              }).readBalances(address, items),
      },
      intervalMs: hourMs,
      batchSize: 2,
      now: () => new Date("2026-10-15T12:34:56.000Z"),
    });
    const result = await lane.runOnce();
    expect(result).toEqual({
      at: "2026-10-15T12:00:00.000Z",
      candidateCount: 5,
      writtenCount: 3,
      unvaluedCount: 1,
      failedCount: 1,
      priceReadFailed: false,
    });
    // Prices are read once per pass, not per wallet.
    expect(readPrices).toHaveBeenCalledTimes(1);
    expect(
      fake.listSnapshotCandidates.mock.calls.map((call) => call[0]),
    ).toEqual([
      expect.objectContaining({
        afterWalletId: null,
        limit: 2,
        at: "2026-10-15T12:00:00.000Z",
        activeSince: "2026-09-15T12:34:56.000Z",
      }),
      expect.objectContaining({ afterWalletId: wallets[1]?.walletId }),
      expect.objectContaining({ afterWalletId: wallets[3]?.walletId }),
    ]);
    expect(fake.recorded).toEqual(
      [0, 2, 4].map((index) => ({
        walletId: wallets[index]?.walletId,
        at: "2026-10-15T12:00:00.000Z",
        netWorthUsd: "2",
        quality: "fresh",
      })),
    );
  });

  it("writes nothing when the price read fails outright", async () => {
    const fake = repositoryFake(wallets.slice(0, 2));
    const lane = createWalletNetWorthSnapshotLane({
      repository: fake.repository,
      listAssets: () => Promise.resolve([tokenA]),
      readPrices: () => Promise.reject(new Error("provider down")),
      readClient: client({ [tokenA.assetId]: 1n }),
      intervalMs: hourMs,
      batchSize: 200,
    });
    expect(await lane.runOnce()).toMatchObject({
      candidateCount: 2,
      writtenCount: 0,
      unvaluedCount: 2,
      priceReadFailed: true,
    });
    expect(fake.recorded).toEqual([]);
  });

  it("aligns slots to the interval", () => {
    expect(
      new Date(
        walletNetWorthSlotStart(Date.parse("2026-10-15T12:59:59.999Z"), hourMs),
      ).toISOString(),
    ).toBe("2026-10-15T12:00:00.000Z");
    expect(
      new Date(
        walletNetWorthSlotStart(Date.parse("2026-10-15T13:00:00.000Z"), hourMs),
      ).toISOString(),
    ).toBe("2026-10-15T13:00:00.000Z");
  });

  it("backs off on a database error and keeps running", async () => {
    vi.useFakeTimers();
    try {
      const backoffs: unknown[] = [];
      const repository = repositoryFake([]).repository;
      const lane = createWalletNetWorthSnapshotLane({
        repository: {
          ...repository,
          listSnapshotCandidates: () => Promise.reject(new Error("db down")),
        },
        listAssets: () => Promise.resolve([tokenA]),
        readPrices: () => Promise.resolve([price("1")]),
        readClient: client({}),
        intervalMs: hourMs,
        batchSize: 200,
        onInfrastructureBackoff: (event) => backoffs.push(event),
      });
      const controller = new AbortController();
      const running = lane.run(controller.signal);
      await vi.advanceTimersByTimeAsync(3_500);
      controller.abort();
      await running;
      expect(backoffs.length).toBeGreaterThanOrEqual(2);
      expect(backoffs[0]).toMatchObject({
        lane: "wallet_networth_snapshot",
        consecutiveFailureCount: 1,
        retryDelayMs: 1_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Decision 0145 history service edges", () => {
  const walletId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
  const wallets = {
    get: vi.fn((_owner: string, id: string) =>
      Promise.resolve(
        id === walletId
          ? {
              walletId,
              providerWalletId: null,
              address: `0x${"a".repeat(40)}`,
              kind: "external" as const,
              status: "active" as const,
              isActive: true,
              firstSeenAt: "2026-10-01T00:00:00.000Z",
              lastSeenAt: "2026-10-01T00:00:00.000Z",
            }
          : null,
      ),
    ),
  };

  it("publishes a null pct when the 24 h baseline is zero", async () => {
    const service = createWalletNetWorthHistoryService({
      wallets,
      snapshots: {
        listSnapshotCandidates: vi.fn(),
        recordSnapshots: vi.fn(),
        readDownsampled: () => Promise.resolve([]),
        readExtremes: () => Promise.resolve({ high: null, low: null }),
        readLatest: (input) =>
          Promise.resolve(
            input.notBefore === null
              ? null
              : {
                  at: "2026-10-14T12:00:00.000Z",
                  netWorthUsd: "0",
                  quality: "fresh" as const,
                },
          ),
      },
      measure: () =>
        Promise.resolve({
          netWorthUsd: "5",
          quality: "partial" as const,
          unavailableCount: 1,
          asOf: "2026-10-15T12:00:00.000Z",
        }),
      fiatCnyPerUsd: null,
      now: () => new Date("2026-10-15T12:10:00.000Z"),
    });
    const result = await service.getHistory({
      principal: { userId: "u" },
      walletId,
      range: "1d",
      signal: new AbortController().signal,
    });
    expect(result.change24h).toEqual({
      usd: "5",
      pct: null,
      baselineAt: "2026-10-14T12:00:00.000Z",
    });
    // A partial current never becomes the high / low.
    expect(result.high).toBeNull();
    expect(result.low).toBeNull();
  });

  it("refuses an unknown range before any read", async () => {
    const service = createWalletNetWorthHistoryService({
      wallets,
      snapshots: null,
      measure: null,
      fiatCnyPerUsd: null,
    });
    await expect(
      service.getHistory({
        principal: { userId: "u" },
        walletId,
        range: "2d",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("keeps every range within 120 points", () => {
    for (const policy of Object.values(walletNetWorthRangePolicy)) {
      expect(
        policy.windowMs / (policy.bucketSeconds * 1_000),
      ).toBeLessThanOrEqual(120);
    }
  });
});

describe("Decision 0145 configuration", () => {
  const appBase = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  };

  it("parses FIAT_CNY_PER_USD into a canonical positive decimal or null", () => {
    expect(loadConfig(appBase).fiatCnyPerUsd).toBeNull();
    expect(
      loadConfig({ ...appBase, FIAT_CNY_PER_USD: "" }).fiatCnyPerUsd,
    ).toBeNull();
    expect(
      loadConfig({ ...appBase, FIAT_CNY_PER_USD: "7.1130" }).fiatCnyPerUsd,
    ).toBe("7.113");
    for (const bad of ["0", "-7", "7.123456789", "1000", "7e0", "abc"]) {
      expect(
        () => loadConfig({ ...appBase, FIAT_CNY_PER_USD: bad }),
        bad,
      ).toThrow(/FIAT_CNY_PER_USD/);
    }
  });

  it("turns the lane off and bounds its interval and batch", () => {
    const workerBase = {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    };
    expect(
      loadReconciliationWorkerConfig({
        ...workerBase,
        WALLET_NETWORTH_SNAPSHOT_ENABLED: "false",
      }).walletNetWorthSnapshot,
    ).toBeNull();
    expect(
      loadReconciliationWorkerConfig({
        ...workerBase,
        WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS: "60000",
        WALLET_NETWORTH_SNAPSHOT_BATCH: "50",
      }).walletNetWorthSnapshot,
    ).toEqual({ intervalMs: 60_000, batchSize: 50 });
    for (const bad of [
      { WALLET_NETWORTH_SNAPSHOT_INTERVAL_MS: "59999" },
      { WALLET_NETWORTH_SNAPSHOT_BATCH: "0" },
      { WALLET_NETWORTH_SNAPSHOT_BATCH: "1001" },
    ]) {
      expect(() =>
        loadReconciliationWorkerConfig({ ...workerBase, ...bad }),
      ).toThrow();
    }
  });
});
