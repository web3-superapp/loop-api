import type { IndexedTransferRecord } from "../../database/bsc-indexer-repository.js";
import { formatLaunch2Amount } from "../launch2/launch2-contract.js";

/**
 * Decision 0167 (S251): the wallet activity list merged with the wallet's
 * MEME v2 (launch2) activity on the Launch chain.
 *
 * Read-only: every launch2 row comes from the indexed read model
 * (`launch2_*` facts the `launch2_event` lane wrote), never from the chain.
 * The merge exists only while WALLET_ACTIVITY_LAUNCH2_EMIT is on; off keeps
 * the route byte-identical to before (Decision 0166 §D).
 *
 * One total order over both sources (newest first):
 *
 *   (occurredAt µs desc, blockNumber desc, logIndex desc, source desc,
 *    transactionHash desc)
 *
 * - ERC-20 rows: `occurredAt` = `indexed_transfers.observed_at` (the lane's
 *   observation time; the table holds no block time).
 * - launch2 rows: the fact's block time (`traded_at`, `swapped_at`,
 *   `minted_at`, `claimed_at`, `executed_at`).
 *
 * Block / log break ties within one second; `source` (`erc20` < `launch2`)
 * and the hash only make the order total across the two chains.
 */

export const walletLaunch2ActivityKinds = Object.freeze([
  "launch2_curve_buy",
  "launch2_curve_sell",
  "launch2_pool_buy",
  "launch2_pool_sell",
  "launch2_nft_mint",
  "launch2_reward_claim",
  "launch2_buyback",
] as const);
export type WalletLaunch2ActivityKind =
  (typeof walletLaunch2ActivityKinds)[number];

export type WalletActivitySource = "erc20" | "launch2";

/** The merged cursor position: the last row a page returned. */
export interface WalletActivitySortKey {
  /** Microseconds since the Unix epoch, a decimal integer string. */
  readonly atMicros: string;
  readonly blockNumber: string;
  readonly logIndex: number;
  readonly source: WalletActivitySource;
  readonly transactionHash: string;
}

export interface WalletTimedTransferRecord extends IndexedTransferRecord {
  /** `observed_at` in microseconds (the ISO `observedAt` keeps ms only). */
  readonly atMicros: string;
}

/**
 * One launch2 fact the wallet took part in. Amounts are raw 18-decimal
 * integer strings; null where the kind has no such amount.
 */
export interface WalletLaunch2ActivityRecord {
  readonly kind: WalletLaunch2ActivityKind;
  readonly chainId: string;
  readonly instanceId: string;
  readonly ticker: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly amountMeme: string | null;
  readonly amountUsd1: string | null;
  readonly taxUsd1: string | null;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly occurredAt: string;
  readonly atMicros: string;
}

export interface WalletActivityPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

/**
 * Decision 0167: the reads behind the merged list. Separate from the
 * indexer and launch2 repositories so neither port grows.
 */
export interface WalletActivityMergeRepository {
  /** The `launch2_event` checkpoint block of `chainId`; null = never ran. */
  getLaunch2Checkpoint(chainId: string): Promise<string | null>;
  listTransfersByTime(input: {
    readonly chainId: string;
    readonly address: string;
    readonly assetIds: readonly string[];
    readonly limit: number;
    readonly before?: WalletActivitySortKey;
  }): Promise<WalletActivityPage<WalletTimedTransferRecord>>;
  /**
   * The wallet's non-removed launch2 facts on `chainId`, every instance
   * (hidden listings included — a holder sees their own history, Decision
   * 0163 §3.2). Matching:
   *
   * - curve buy / sell: `launch2_trades.trader_address`;
   * - pool buy / sell: user swaps (Decision 0127 / 0158 filter) whose
   *   attributed wallet (Decision 0126 / 0132) or recipient is the address,
   *   or a buy whose transaction credited the address on the Hook
   *   (`launch2_dynamic_credit_entries` `in`, Decision 0146 / S200 0014
   *   delivery attribution included);
   * - NFT mint: `launch2_nft_mints.payer_address`;
   * - reward claim: `launch2_dynamic_claims.buyer_address`;
   * - buyback: an executed `launch2_buybacks` row of an instance whose
   *   `buyback_recipient` is the address (the MEME it received).
   */
  listLaunch2Activity(input: {
    readonly chainId: string;
    readonly address: string;
    readonly limit: number;
    readonly before?: WalletActivitySortKey;
  }): Promise<WalletActivityPage<WalletLaunch2ActivityRecord>>;
}

export function sortKeyOfTransfer(
  record: WalletTimedTransferRecord,
): WalletActivitySortKey {
  return {
    atMicros: record.atMicros,
    blockNumber: record.blockNumber,
    logIndex: record.logIndex,
    source: "erc20",
    transactionHash: record.transactionHash,
  };
}

export function sortKeyOfLaunch2(
  record: WalletLaunch2ActivityRecord,
): WalletActivitySortKey {
  return {
    atMicros: record.atMicros,
    blockNumber: record.blockNumber,
    logIndex: record.logIndex,
    source: "launch2",
    transactionHash: record.transactionHash,
  };
}

function compareBigint(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Ascending comparison of the merged key; the list is its reverse. */
export function compareSortKeys(
  a: WalletActivitySortKey,
  b: WalletActivitySortKey,
): number {
  return (
    compareBigint(a.atMicros, b.atMicros) ||
    compareBigint(a.blockNumber, b.blockNumber) ||
    a.logIndex - b.logIndex ||
    compareText(a.source, b.source) ||
    compareText(a.transactionHash, b.transactionHash)
  );
}

export type MergedActivityEntry =
  | { readonly source: "erc20"; readonly record: WalletTimedTransferRecord }
  | {
      readonly source: "launch2";
      readonly record: WalletLaunch2ActivityRecord;
    };

export function sortKeyOfEntry(
  entry: MergedActivityEntry,
): WalletActivitySortKey {
  return entry.source === "erc20"
    ? sortKeyOfTransfer(entry.record)
    : sortKeyOfLaunch2(entry.record);
}

/**
 * Merge two pages that each hold the newest `pageSize + 1` rows after the
 * same cursor: the first `pageSize` of the union are the merged page, and
 * there is more when either source had more or the union overflowed.
 */
export function mergeActivityPages(input: {
  readonly transfers: WalletActivityPage<WalletTimedTransferRecord>;
  readonly launch2: WalletActivityPage<WalletLaunch2ActivityRecord>;
  readonly pageSize: number;
}): { readonly entries: readonly MergedActivityEntry[]; hasMore: boolean } {
  const all: MergedActivityEntry[] = [
    ...input.transfers.items.map((record): MergedActivityEntry => ({
      source: "erc20",
      record,
    })),
    ...input.launch2.items.map((record): MergedActivityEntry => ({
      source: "launch2",
      record,
    })),
  ];
  all.sort((a, b) => compareSortKeys(sortKeyOfEntry(b), sortKeyOfEntry(a)));
  const entries = all.slice(0, input.pageSize);
  return {
    entries,
    hasMore:
      all.length > input.pageSize ||
      input.transfers.hasMore ||
      input.launch2.hasMore,
  };
}

/** The `/v2` row of one launch2 fact (Decision 0167 key list). */
export interface WalletLaunch2ActivityItem {
  readonly kind: WalletLaunch2ActivityKind;
  readonly chainId: string;
  readonly instanceId: string;
  readonly ticker: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly amountMeme: string | null;
  readonly amountUsd1: string | null;
  readonly taxUsd1: string | null;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly occurredAt: string;
  readonly confirmations: number | null;
}

function decimal(raw: string | null): string | null {
  return raw === null ? null : formatLaunch2Amount(BigInt(raw));
}

export function projectLaunch2ActivityItem(
  record: WalletLaunch2ActivityRecord,
  headBlockNumber: bigint | null,
): WalletLaunch2ActivityItem {
  const block = BigInt(record.blockNumber);
  return Object.freeze({
    kind: record.kind,
    chainId: record.chainId,
    instanceId: record.instanceId,
    ticker: record.ticker,
    name: record.name,
    logoUrl: record.logoUrl,
    amountMeme: decimal(record.amountMeme),
    amountUsd1: decimal(record.amountUsd1),
    taxUsd1: decimal(record.taxUsd1),
    transactionHash: record.transactionHash,
    logIndex: record.logIndex,
    blockNumber: record.blockNumber,
    occurredAt: record.occurredAt,
    confirmations:
      headBlockNumber === null
        ? null
        : Number(
            headBlockNumber + 1n > block ? headBlockNumber + 1n - block : 0n,
          ),
  });
}
