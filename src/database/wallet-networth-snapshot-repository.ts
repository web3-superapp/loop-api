import type { Pool } from "pg";

import { normalizeDecimalString } from "../features/market/market-contract.js";
import { toIsoString } from "./v2-command-support.js";

/**
 * Decision 0145: `wallet_networth_snapshots` (migration 000085). One USD net
 * worth per wallet per snapshot slot; written by the
 * `wallet_networth_snapshot` worker lane, read by the net worth history
 * route. Values are canonical decimal strings, never JavaScript numbers.
 */

export type WalletNetWorthQuality = "fresh" | "stale" | "partial";

export const walletNetWorthQualities: readonly WalletNetWorthQuality[] =
  Object.freeze(["fresh", "stale", "partial"]);

export interface WalletNetWorthSnapshotRecord {
  readonly at: string;
  readonly netWorthUsd: string;
  readonly quality: WalletNetWorthQuality;
}

export interface WalletNetWorthSnapshotCandidate {
  readonly walletId: string;
  readonly address: string;
}

export interface WalletNetWorthSnapshotRepository {
  /**
   * Active wallets, in `wallet_id` order after `afterWalletId`, whose owner
   * had a device session seen since `activeSince` or whose balances were
   * read since then, and that have no snapshot at `at` yet.
   */
  listSnapshotCandidates(input: {
    readonly at: string;
    readonly activeSince: string;
    readonly afterWalletId: string | null;
    readonly limit: number;
  }): Promise<readonly WalletNetWorthSnapshotCandidate[]>;
  /** Inserts the rows; an existing `(wallet_id, at)` is kept. Returns the inserted count. */
  recordSnapshots(
    rows: readonly (WalletNetWorthSnapshotRecord & {
      readonly walletId: string;
    })[],
  ): Promise<number>;
  /**
   * The last snapshot of each `bucketSeconds` slot in `(since, until]`, at
   * most `limit` slots (the newest ones), oldest first.
   */
  readDownsampled(input: {
    readonly walletId: string;
    readonly since: string;
    readonly until: string;
    readonly bucketSeconds: number;
    readonly limit: number;
  }): Promise<readonly WalletNetWorthSnapshotRecord[]>;
  /**
   * Highest and lowest non-partial snapshot in `(since, until]` (the later
   * one on a tie).
   */
  readExtremes(input: {
    readonly walletId: string;
    readonly since: string;
    readonly until: string;
  }): Promise<{
    readonly high: WalletNetWorthSnapshotRecord | null;
    readonly low: WalletNetWorthSnapshotRecord | null;
  }>;
  /** The newest snapshot in `[notBefore, notAfter]`, or null. */
  readLatest(input: {
    readonly walletId: string;
    readonly notAfter: string;
    readonly notBefore: string | null;
  }): Promise<WalletNetWorthSnapshotRecord | null>;
}

export class WalletNetWorthSnapshotUnavailableError extends Error {
  readonly code = "wallet_networth_snapshot_unavailable";

  constructor() {
    super("The wallet net worth snapshots are unavailable");
    this.name = "WalletNetWorthSnapshotUnavailableError";
  }
}

interface SnapshotRow {
  readonly at: Date | string;
  readonly net_worth_usd: string;
  readonly quality: string;
}

function isQuality(value: string): value is WalletNetWorthQuality {
  return (walletNetWorthQualities as readonly string[]).includes(value);
}

function toRecord(row: SnapshotRow): WalletNetWorthSnapshotRecord {
  if (!isQuality(row.quality)) {
    throw new WalletNetWorthSnapshotUnavailableError();
  }
  return Object.freeze({
    at: toIsoString(row.at),
    netWorthUsd: normalizeDecimalString(row.net_worth_usd),
    quality: row.quality,
  });
}

export function createPostgresWalletNetWorthSnapshotRepository(
  pool: Pool,
): WalletNetWorthSnapshotRepository {
  return Object.freeze({
    async listSnapshotCandidates(input: {
      readonly at: string;
      readonly activeSince: string;
      readonly afterWalletId: string | null;
      readonly limit: number;
    }) {
      const result = await pool.query<{
        readonly wallet_id: string;
        readonly address: string;
      }>({
        text: `
          select w.wallet_id::text as wallet_id, w.address
          from public.account_wallets as w
          where w.status = 'active'
            and ($3::uuid is null or w.wallet_id > $3::uuid)
            and (
              exists (
                select 1 from public.device_sessions as s
                where s.owner_user_id = w.owner_user_id
                  and s.last_seen_at >= $2::timestamptz
              )
              or exists (
                select 1 from public.wallet_balance_snapshots as b
                where b.wallet_id = w.wallet_id
                  and b.observed_at >= $2::timestamptz
              )
            )
            and not exists (
              select 1 from public.wallet_networth_snapshots as n
              where n.wallet_id = w.wallet_id and n.at = $1::timestamptz
            )
          order by w.wallet_id
          limit $4
        `,
        values: [input.at, input.activeSince, input.afterWalletId, input.limit],
      });
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({ walletId: row.wallet_id, address: row.address }),
        ),
      );
    },

    async recordSnapshots(
      rows: readonly (WalletNetWorthSnapshotRecord & {
        readonly walletId: string;
      })[],
    ) {
      if (rows.length === 0) {
        return 0;
      }
      const result = await pool.query({
        text: `
          insert into public.wallet_networth_snapshots
            (wallet_id, at, net_worth_usd, quality)
          select * from unnest(
            $1::uuid[], $2::timestamptz[], $3::numeric[], $4::text[]
          )
          on conflict (wallet_id, at) do nothing
        `,
        values: [
          rows.map((row) => row.walletId),
          rows.map((row) => row.at),
          rows.map((row) => row.netWorthUsd),
          rows.map((row) => row.quality),
        ],
      });
      return result.rowCount ?? 0;
    },

    async readDownsampled(input: {
      readonly walletId: string;
      readonly since: string;
      readonly until: string;
      readonly bucketSeconds: number;
      readonly limit: number;
    }) {
      const result = await pool.query<SnapshotRow>({
        text: `
          select at, net_worth_usd::text as net_worth_usd, quality
          from (
            select distinct on (floor(extract(epoch from at) / $4::integer))
              at, net_worth_usd, quality
            from public.wallet_networth_snapshots
            where wallet_id = $1::uuid
              and at > $2::timestamptz
              and at <= $3::timestamptz
            order by floor(extract(epoch from at) / $4::integer) desc, at desc
            limit $5
          ) as slots
          order by at asc
        `,
        values: [
          input.walletId,
          input.since,
          input.until,
          input.bucketSeconds,
          input.limit,
        ],
      });
      return Object.freeze(result.rows.map(toRecord));
    },

    async readExtremes(input: {
      readonly walletId: string;
      readonly since: string;
      readonly until: string;
    }) {
      const result = await pool.query<SnapshotRow & { readonly side: string }>({
        text: `
            (
              select 'high' as side, at, net_worth_usd::text as net_worth_usd, quality
              from public.wallet_networth_snapshots
              where wallet_id = $1::uuid and quality <> 'partial'
                and at > $2::timestamptz and at <= $3::timestamptz
              order by net_worth_usd desc, at desc
              limit 1
            )
            union all
            (
              select 'low' as side, at, net_worth_usd::text as net_worth_usd, quality
              from public.wallet_networth_snapshots
              where wallet_id = $1::uuid and quality <> 'partial'
                and at > $2::timestamptz and at <= $3::timestamptz
              order by net_worth_usd asc, at desc
              limit 1
            )
          `,
        values: [input.walletId, input.since, input.until],
      });
      const high = result.rows.find((row) => row.side === "high");
      const low = result.rows.find((row) => row.side === "low");
      return Object.freeze({
        high: high === undefined ? null : toRecord(high),
        low: low === undefined ? null : toRecord(low),
      });
    },

    async readLatest(input: {
      readonly walletId: string;
      readonly notAfter: string;
      readonly notBefore: string | null;
    }) {
      const result = await pool.query<SnapshotRow>({
        text: `
          select at, net_worth_usd::text as net_worth_usd, quality
          from public.wallet_networth_snapshots
          where wallet_id = $1::uuid
            and at <= $2::timestamptz
            and ($3::timestamptz is null or at >= $3::timestamptz)
          order by at desc
          limit 1
        `,
        values: [input.walletId, input.notAfter, input.notBefore],
      });
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },
  });
}
