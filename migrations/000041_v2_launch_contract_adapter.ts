import type { MigrationBuilder } from "node-pg-migrate";

const digestVersionsBefore = [
  "sha256_v1",
  "perp_intent_request_v1",
  "perp_agent_authorization_issue_v1",
  "price_alert_create_v1",
  "spot_intent_request_v1",
  "spot_agent_authorization_issue_v1",
  "social_command_v1",
  "chat_channel_command_v1",
  "community_command_v1",
  "social_graph_command_v1",
  "communication_command_v1",
  "price_alert_create_v2",
  "launch_command_v1",
  "referral_command_v1",
  "support_ticket_create_v1",
  "community_ai_ask_v1",
  "community_ai_report_v1",
] as const;

function digestVersionList(versions: readonly string[]): string {
  return versions.map((version) => `        '${version}'`).join(",\n");
}

/**
 * Decision 0076: the Launch contract interface (LOOP 06) is the baseline.
 *
 * - `launches_axes_unavailable_check` keeps its name and admits, per axis,
 *   `unavailable` plus exactly the 06 §2 names. Nothing writes an axis in
 *   this step; the S83b event lane will.
 * - `launches` gains the sale registry: `sale_id` (the contract's `saleId`,
 *   from 1), `contract_version` (semver of the contract the sale lives on),
 *   and `config_version_onchain` (the expected `configVersion` bytes32).
 *   `contract_address` already exists (000023). A registered sale names its
 *   contract and version; one contract never registers one sale twice.
 * - `idempotency_records.digest_version` reserves `launch_intent_v1` for the
 *   S83b Intent prepare.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launches
      drop constraint launches_axes_unavailable_check;
    alter table public.launches
      add constraint launches_axes_unavailable_check
      check (
        sale_state in (
          'unavailable', 'SCHEDULED', 'LIVE', 'ENDED', 'SUCCEEDED', 'FAILED', 'CANCELLED'
        )
        and entitlement_state in (
          'unavailable', 'NONE', 'FROZEN', 'VESTING', 'COMPLETED', 'REFUNDING', 'REFUNDED'
        )
        and liquidity_state in (
          'unavailable', 'NOT_STARTED', 'PREPARING', 'V3_LIVE', 'LP_LOCKED', 'COMPLETED',
          'RETRY_SCHEDULED'
        )
        and operational_state in ('unavailable', 'ACTIVE', 'PAUSED')
      );

    alter table public.launches
      add column sale_id bigint,
      add column contract_version text,
      add column config_version_onchain text;

    alter table public.launches
      add constraint launches_sale_id_check
        check (sale_id is null or sale_id >= 1),
      add constraint launches_contract_version_check
        check (
          contract_version is null
          or contract_version ~ '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$'
        ),
      add constraint launches_config_version_onchain_check
        check (config_version_onchain is null or config_version_onchain ~ '^0x[0-9a-f]{64}$'),
      add constraint launches_sale_registry_check
        check (
          sale_id is null
          or (contract_address is not null and contract_version is not null)
        );

    create unique index launches_sale_unique_idx
      on public.launches (chain_id, contract_address, sale_id)
      where sale_id is not null;

    comment on column public.launches.sale_id is
      'LoopLaunchpad saleId (06 §1) on contract_address; null until the sale is registered (Decision 0076).';
    comment on column public.launches.contract_version is
      'Semantic version of the contract the sale lives on; must equal LAUNCH_CONTRACT_VERSION for a chain read.';
    comment on column public.launches.config_version_onchain is
      'Expected on-chain configVersion (bytes32); a differing getState/getSaleConfig value fails closed.';

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
${digestVersionList([...digestVersionsBefore, "launch_intent_v1"])}
      ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.launches
        where sale_state <> 'unavailable'
          or entitlement_state <> 'unavailable'
          or liquidity_state <> 'unavailable'
          or operational_state <> 'unavailable'
          or sale_id is not null
          or contract_version is not null
          or config_version_onchain is not null
      ) then
        raise exception 'launch chain facts exist; refusing to roll back 000041';
      end if;
      if exists (
        select 1 from public.idempotency_records
        where digest_version = 'launch_intent_v1'
      ) then
        raise exception 'launch_intent_v1 records exist; refusing to roll back 000041';
      end if;
    end
    $$;

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
${digestVersionList(digestVersionsBefore)}
      ));

    drop index public.launches_sale_unique_idx;
    alter table public.launches
      drop constraint launches_sale_registry_check,
      drop constraint launches_config_version_onchain_check,
      drop constraint launches_contract_version_check,
      drop constraint launches_sale_id_check,
      drop column config_version_onchain,
      drop column contract_version,
      drop column sale_id;

    alter table public.launches
      drop constraint launches_axes_unavailable_check;
    alter table public.launches
      add constraint launches_axes_unavailable_check
      check (
        sale_state = 'unavailable'
        and entitlement_state = 'unavailable'
        and liquidity_state = 'unavailable'
        and operational_state = 'unavailable'
      );
  `);
}
