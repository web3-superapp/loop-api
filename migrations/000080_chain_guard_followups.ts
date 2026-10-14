import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0135 (S176): chain guard follow-ups.
 *
 * - Two more incident kinds: `pool_protocol_fee_policy_nonzero` /
 *   `pool_protocol_fee_policy_high` (the fee controller's
 *   `protocolFeeForPool` ahead of the pool's slot0 fee).
 * - Manual resolution from the console: `resolution` ('auto' | 'manual';
 *   null exactly while the incident is open — existing resolved rows are
 *   backfilled 'auto'), `resolved_by` (the acting `admin_accounts.id`; null
 *   for the ADMIN_USERNAME bootstrap administrator and for 'auto'; no
 *   foreign key into admin_accounts, like every console fact), and
 *   `resolution_note` (required for 'manual', 1–500 characters).
 */

const chainGuardIncidentKindsV2 = [
  "usd1_paused",
  "usd1_address_frozen",
  "usd1_implementation_changed",
  "usd1_address_mismatch",
  "usd1_read_unsupported",
  "protocol_fee_controller_changed",
  "pool_protocol_fee_nonzero",
  "pool_protocol_fee_high",
  "account_balance_low",
  "pool_protocol_fee_policy_nonzero",
  "pool_protocol_fee_policy_high",
  "usd1_frozen_funds_drained",
  "usd1_frozen_funds_reallocated",
  "usd1_upgraded",
  "usd1_proxy_admin_changed",
  "usd1_proxy_admin_ownership_transferred",
  "usd1_owner_transferred",
] as const;

const chainGuardIncidentKindsV1 = chainGuardIncidentKindsV2.filter(
  (kind) => !kind.startsWith("pool_protocol_fee_policy_"),
);

function kindList(kinds: readonly string[]): string {
  return kinds.map((kind) => `'${kind}'`).join(", ");
}

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.chain_guard_incidents
      drop constraint chain_guard_incidents_kind_check,
      add constraint chain_guard_incidents_kind_check
        check (kind in (${kindList(chainGuardIncidentKindsV2)})),
      add column resolution text
        check (resolution in ('auto', 'manual')),
      add column resolved_by uuid,
      add column resolution_note text
        check (resolution_note is null
          or char_length(resolution_note) between 1 and 500);
    update public.chain_guard_incidents
      set resolution = 'auto'
      where resolved_at is not null;
    alter table public.chain_guard_incidents
      add constraint chain_guard_incidents_resolution_shape check (
        (resolved_at is null) = (resolution is null)
        and (resolution = 'manual' or (resolved_by is null and resolution_note is null))
        and (resolution is distinct from 'manual' or resolution_note is not null)
      );
    comment on column public.chain_guard_incidents.resolution is
      'Decision 0135: auto (the lane saw the condition cleared / the 24 h event window passed) or manual (POST /admin/v1/chain-guard/incidents/{id}/resolve); null while open.';
    comment on column public.chain_guard_incidents.resolved_by is
      'Decision 0135: admin_accounts.id of a manual resolve; null for the bootstrap administrator and for auto. Not a foreign key.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.chain_guard_incidents
        where kind like 'pool_protocol_fee_policy_%' or resolution = 'manual'
      ) then
        raise exception 'chain guard policy / manual incidents exist; refusing to roll back 000080';
      end if;
    end $$;
    alter table public.chain_guard_incidents
      drop constraint chain_guard_incidents_resolution_shape,
      drop column resolution_note,
      drop column resolved_by,
      drop column resolution,
      drop constraint chain_guard_incidents_kind_check,
      add constraint chain_guard_incidents_kind_check
        check (kind in (${kindList(chainGuardIncidentKindsV1)}));
  `);
}
