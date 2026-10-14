import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0134 (S174): the `chain_guard` lane's incidents and log cursor.
 *
 * - `chain_guard_incidents`: one row per observed risk on the launch chain
 *   (USD1 paused / an address of ours frozen / implementation changed /
 *   Uniswap v4 protocol fee on one of our pools / a low BNB balance …).
 *   `subject` is the chain fact the incident is about (a lower-case address
 *   or a 32-byte pool id); it is never a key of any other table. At most one
 *   unresolved row exists per (chain, kind, subject): a repeat sighting moves
 *   `last_seen_at`, a cleared condition sets `resolved_at`. Rows are never
 *   deleted; a later sighting after resolution opens a new row.
 * - `chain_guard_cursors`: the last block whose USD1 / ProxyAdmin logs the
 *   lane has read, per chain.
 */

const chainGuardIncidentKindsV1 = [
  "usd1_paused",
  "usd1_address_frozen",
  "usd1_implementation_changed",
  "usd1_address_mismatch",
  "usd1_read_unsupported",
  "protocol_fee_controller_changed",
  "pool_protocol_fee_nonzero",
  "pool_protocol_fee_high",
  "account_balance_low",
  "usd1_frozen_funds_drained",
  "usd1_frozen_funds_reallocated",
  "usd1_upgraded",
  "usd1_proxy_admin_changed",
  "usd1_proxy_admin_ownership_transferred",
  "usd1_owner_transferred",
] as const;

const kinds = chainGuardIncidentKindsV1.map((kind) => `'${kind}'`).join(", ");

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.chain_guard_incidents (
      incident_id uuid primary key,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      kind text not null check (kind in (${kinds})),
      subject text not null
        check (subject ~ '^0x[0-9a-f]{40}$' or subject ~ '^0x[0-9a-f]{64}$'),
      details jsonb not null default '{}'::jsonb
        check (jsonb_typeof(details) = 'object'),
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      resolved_at timestamptz,
      constraint chain_guard_incidents_seen_order
        check (last_seen_at >= first_seen_at),
      constraint chain_guard_incidents_resolved_order
        check (resolved_at is null or resolved_at >= first_seen_at)
    );
    create unique index chain_guard_incidents_open_key
      on public.chain_guard_incidents (chain_id, kind, subject)
      where resolved_at is null;
    create index chain_guard_incidents_recent_idx
      on public.chain_guard_incidents (chain_id, last_seen_at desc);

    create table public.chain_guard_cursors (
      chain_id text primary key references public.chains(chain_id) on delete restrict,
      last_block_number bigint not null check (last_block_number >= 0),
      updated_at timestamptz not null
    );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.chain_guard_cursors;
    drop table public.chain_guard_incidents;
  `);
}
