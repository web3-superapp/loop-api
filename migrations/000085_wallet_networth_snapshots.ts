import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0145 (S199-api): hourly wallet net worth snapshots.
 *
 * `wallet_networth_snapshots` holds one USD net worth per wallet per
 * snapshot slot (`at` is the start of the slot, e.g. the top of the hour),
 * written by the `wallet_networth_snapshot` worker lane and read by
 * `GET /v2/wallets/:walletId/networth/history`. `quality` is `fresh`,
 * `stale` (a stale underlying price) or `partial` (at least one registry
 * row unvalued; the value excludes it). A wallet nothing could be valued
 * for gets no row, never a zero.
 *
 * `down` drops the table and its index.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.wallet_networth_snapshots (
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete cascade,
      at timestamptz not null,
      net_worth_usd numeric not null,
      quality text not null,
      created_at timestamptz not null default clock_timestamp(),
      primary key (wallet_id, at),
      constraint wallet_networth_snapshots_value_check
        check (net_worth_usd >= 0),
      constraint wallet_networth_snapshots_quality_check
        check (quality in ('fresh', 'stale', 'partial'))
    );

    create index wallet_networth_snapshots_recent_idx
      on public.wallet_networth_snapshots (wallet_id, at desc);

    comment on table public.wallet_networth_snapshots is
      'Decision 0145: hourly USD net worth per wallet (display information, never a balance). at is the snapshot slot start; partial means some registry rows were unvalued.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.wallet_networth_snapshots;
  `);
}
