import { describe, expect, it } from "vitest";

import {
  compareSortKeys,
  mergeActivityPages,
  projectLaunch2ActivityItem,
  sortKeyOfEntry,
  type WalletLaunch2ActivityRecord,
  type WalletTimedTransferRecord,
} from "../src/features/wallet/wallet-activity-launch2.js";

/** Decision 0167: the merged order, page merge, and launch2 row shape. */

const transfer = (
  atMicros: string,
  block: string,
  log: number,
): WalletTimedTransferRecord => ({
  transactionHash: `0x${String(log).padStart(64, "7")}`,
  logIndex: log,
  blockNumber: block,
  blockHash: `0x${"2".repeat(64)}`,
  assetId: "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  fromAddress: `0x${"b2".repeat(20)}`,
  toAddress: `0x${"a1".repeat(20)}`,
  rawValue: "1",
  removed: false,
  observedAt: new Date(Number(BigInt(atMicros) / 1000n)).toISOString(),
  atMicros,
});

const launch2 = (
  atMicros: string,
  block: string,
  log: number,
  overrides: Partial<WalletLaunch2ActivityRecord> = {},
): WalletLaunch2ActivityRecord => ({
  kind: "launch2_curve_buy",
  chainId: "eip155:97",
  instanceId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
  ticker: "WIND",
  name: "Evening Wind",
  logoUrl: null,
  amountMeme: "1000000000000000000000",
  amountUsd1: "10200000000000000000",
  taxUsd1: "200000000000000000",
  transactionHash: `0x${String(log).padStart(64, "9")}`,
  logIndex: log,
  blockNumber: block,
  occurredAt: new Date(Number(BigInt(atMicros) / 1000n)).toISOString(),
  atMicros,
  ...overrides,
});

describe("Decision 0167: merged wallet activity order", () => {
  it("orders by time, then block, log, source, hash (newest first)", () => {
    const page = mergeActivityPages({
      transfers: {
        items: [
          transfer("1800000005000000", "900", 1),
          transfer("1800000001000000", "800", 4),
        ],
        hasMore: false,
      },
      launch2: {
        items: [
          launch2("1800000003000000", "50", 2),
          // Same second as the next one: block / log decide.
          launch2("1800000001000000", "70", 3),
          launch2("1800000001000000", "70", 1),
        ],
        hasMore: false,
      },
      pageSize: 10,
    });
    expect(
      page.entries.map(
        (entry) => `${entry.source}:${entry.record.blockNumber}`,
      ),
    ).toEqual([
      "erc20:900",
      "launch2:50",
      // 800 > 70 at the same microsecond: the block decides across chains
      // only as a tie-break; the order stays total.
      "erc20:800",
      "launch2:70",
      "launch2:70",
    ]);
    expect(page.entries.at(-1)?.record.logIndex).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it("keeps the first pageSize rows and reports more when either side has more", () => {
    const merged = mergeActivityPages({
      transfers: {
        items: [transfer("3000", "3", 0), transfer("1000", "1", 0)],
        hasMore: false,
      },
      launch2: { items: [launch2("2000", "2", 0)], hasMore: false },
      pageSize: 2,
    });
    expect(merged.entries.map((entry) => entry.source)).toEqual([
      "erc20",
      "launch2",
    ]);
    expect(merged.hasMore).toBe(true);

    const exact = mergeActivityPages({
      transfers: { items: [transfer("3000", "3", 0)], hasMore: false },
      launch2: { items: [launch2("2000", "2", 0)], hasMore: false },
      pageSize: 2,
    });
    expect(exact.hasMore).toBe(false);

    const upstream = mergeActivityPages({
      transfers: { items: [], hasMore: false },
      launch2: { items: [launch2("2000", "2", 0)], hasMore: true },
      pageSize: 2,
    });
    expect(upstream.hasMore).toBe(true);
  });

  it("compares microseconds exactly and keeps the two sources apart", () => {
    const a = sortKeyOfEntry({
      source: "erc20",
      record: transfer("1800000000000001", "1", 0),
    });
    const b = sortKeyOfEntry({
      source: "erc20",
      record: transfer("1800000000000000", "1", 0),
    });
    expect(compareSortKeys(a, b)).toBeGreaterThan(0);
    const sameErc20 = { ...b, source: "erc20" as const };
    const sameLaunch2 = { ...b, source: "launch2" as const };
    expect(compareSortKeys(sameLaunch2, sameErc20)).toBeGreaterThan(0);
    expect(compareSortKeys(sameErc20, sameErc20)).toBe(0);
  });
});

describe("Decision 0167: launch2 activity row", () => {
  it("formats 18-decimal amounts and counts confirmations on the Launch chain head", () => {
    expect(projectLaunch2ActivityItem(launch2("1000", "100", 2), 104n)).toEqual(
      {
        kind: "launch2_curve_buy",
        chainId: "eip155:97",
        instanceId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
        ticker: "WIND",
        name: "Evening Wind",
        logoUrl: null,
        amountMeme: "1000",
        amountUsd1: "10.2",
        taxUsd1: "0.2",
        transactionHash: `0x${"2".padStart(64, "9")}`,
        logIndex: 2,
        blockNumber: "100",
        occurredAt: "1970-01-01T00:00:00.001Z",
        confirmations: 5,
      },
    );
  });

  it("keeps null amounts null and confirmations null without a head", () => {
    const item = projectLaunch2ActivityItem(
      launch2("1000", "100", 0, {
        kind: "launch2_reward_claim",
        amountMeme: null,
        taxUsd1: null,
        amountUsd1: "1250000000000000000",
      }),
      null,
    );
    expect(item).toMatchObject({
      amountMeme: null,
      amountUsd1: "1.25",
      taxUsd1: null,
      confirmations: null,
    });
    // A head behind the row (another endpoint lagging) floors at zero.
    expect(
      projectLaunch2ActivityItem(launch2("1000", "100", 0), 50n).confirmations,
    ).toBe(0);
  });
});
