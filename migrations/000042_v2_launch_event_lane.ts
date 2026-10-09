import type { MigrationBuilder } from "node-pg-migrate";

const launchEventNames = [
  "SaleStateChanged",
  "Purchased",
  "SaleFinalized",
  "BudgetsFrozen",
  "RefundLiabilityFrozen",
  "Refunded",
  "VestingScheduleCreated",
  "Claimed",
  "PoolPrepared",
  "LiquidityAdded",
  "LPNFTLocked",
  "LiquidityRetryScheduled",
  "Paused",
  "Unpaused",
] as const;

const reviewEventTypesBefore = [
  "project_created",
  "project_updated",
  "project_submitted",
  "review_started",
  "project_approved",
  "project_returned",
  "project_rejected",
] as const;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * Decision 0077: the `launch_event` indexer lane, the Launch purchase Intent
 * prepare, and the Merkle eligibility evaluator.
 *
 * - `indexer_checkpoints.lane` admits `launch_event` (one row per launch
 *   chain slot).
 * - `launch_indexed_events` keeps every decoded event of a registered sale
 *   (reorged-out logs keep their row with `removed = true`, as in 0034).
 *   `purchase_records`, `entitlements`, `refund_liabilities`,
 *   `refund_claims`, and the pool columns of `launches` are projections of
 *   it; the four axes come from `getState` at the segment's last block.
 * - `launches` gains the registered sale's asset pair (`quote_asset_id`,
 *   `project_asset_id`), `state_config_version` (the `getState` configVersion of
 *   the projected tuple, 64 hex without `0x`), the pool reference, and the
 *   LP lock facts.
 * - `purchase_records` gains the on-chain round index and chain;
 *   `refund_claims` gains its log identity so a replayed `Refunded` log is
 *   one row.
 * - `launch_allowlists` (operator address lists) and
 *   `launch_round_allowlist_roots` (append-only computed roots with their
 *   sorted member set).
 * - `launch_intents` gains the remaining 03 §8.2 / 06 §4.1 bindings, its
 *   idempotency record, and the device broadcast report (transaction hash,
 *   whether the observed transaction matched the payload, report time).
 * - `launch_review_events.event_type` admits `sale_registered` (the
 *   `pnpm launch:register-sale` audit row).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.indexer_checkpoints
      drop constraint indexer_checkpoints_lane_check;
    alter table public.indexer_checkpoints
      add constraint indexer_checkpoints_lane_check
      check (lane in ('erc20_transfer', 'pool_event', 'launch_event'));

    create table public.launch_indexed_events (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      contract_address text not null,
      sale_id bigint not null,
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      event_name text not null,
      wallet_address text,
      payload jsonb not null,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, transaction_hash, log_index),
      constraint launch_indexed_events_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint launch_indexed_events_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint launch_indexed_events_log_check check (log_index >= 0),
      constraint launch_indexed_events_block_check check (block_number >= 0),
      constraint launch_indexed_events_contract_check
        check (contract_address ~ '^0x[0-9a-f]{40}$'),
      constraint launch_indexed_events_sale_check check (sale_id >= 1),
      constraint launch_indexed_events_name_check
        check (event_name in (${quoted(launchEventNames)})),
      constraint launch_indexed_events_wallet_check
        check (wallet_address is null or wallet_address ~ '^0x[0-9a-f]{40}$'),
      constraint launch_indexed_events_payload_check
        check (jsonb_typeof(payload) = 'object')
    );

    create index launch_indexed_events_launch_idx
      on public.launch_indexed_events (launch_id, event_name, block_number, log_index);
    create index launch_indexed_events_block_idx
      on public.launch_indexed_events (chain_id, block_number);

    comment on table public.launch_indexed_events is
      'Decoded LoopLaunchpad events (06 §3) of registered sales only (Decision 0077). Amounts are decimal strings inside payload. wallet_address is the buyer/wallet argument, an attribute and never a key. A reorged-out log keeps its row with removed = true.';

    alter table public.launches
      add column state_config_version text,
      add column pool_address text,
      add column pool_id uuid references public.pools(pool_id) on delete restrict,
      add column lp_token_id numeric(78, 0),
      add column lp_unlock_at timestamptz,
      add column quote_asset_id text references public.assets(asset_id) on delete restrict,
      add column project_asset_id text references public.assets(asset_id) on delete restrict,
      add constraint launches_state_config_version_check
        check (
          state_config_version is null
          or (state_config_version ~ '^[0-9a-f]{64}$' and snapshot_block_number is not null)
        ),
      add constraint launches_pool_address_check
        check (pool_address is null or pool_address ~ '^0x[0-9a-f]{40}$'),
      add constraint launches_lp_token_check
        check (lp_token_id is null or lp_token_id >= 0);

    comment on column public.launches.quote_asset_id is
      'USD1 on the launch chain, set by pnpm launch:register-sale after getSaleConfig.usd1 matched LAUNCH_USD1_ADDRESS (Decision 0077).';
    comment on column public.launches.project_asset_id is
      'Project token on the launch chain, set by pnpm launch:register-sale after getSaleConfig.projectToken matched the confirmed configuration (Decision 0077).';
    comment on column public.launches.state_config_version is
      'configVersion returned by getState together with state_tuple_digest at snapshot_block_number (Decision 0077); 64 hex, no 0x.';

    alter table public.purchase_records
      add column chain_id text references public.chains(chain_id) on delete restrict,
      add column round_index integer,
      add constraint purchase_records_round_index_check
        check (round_index is null or round_index between 0 and 65535);

    alter table public.refund_claims
      add column log_index integer,
      add column block_number bigint,
      add column removed boolean not null default false,
      add constraint refund_claims_log_check
        check (
          (log_index is null) = (block_number is null)
          and (log_index is null or (log_index >= 0 and block_number >= 0))
        );
    create unique index refund_claims_log_unique_idx
      on public.refund_claims (transaction_hash, log_index)
      where transaction_hash is not null and log_index is not null;

    create table public.launch_allowlists (
      allowlist_entry_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      round_index integer not null,
      address text not null,
      source text not null,
      added_at timestamptz not null default clock_timestamp(),
      constraint launch_allowlists_entry_unique unique (launch_id, round_index, address),
      constraint launch_allowlists_round_check check (round_index between 0 and 65535),
      constraint launch_allowlists_address_check check (address ~ '^0x[0-9a-f]{40}$'),
      constraint launch_allowlists_source_check
        check (source ~ '^[a-z][a-z0-9_.:-]{0,63}$')
    );

    comment on table public.launch_allowlists is
      'Operator-supplied allowlist addresses per launch round (tierModeV1 = whitelist), imported only by pnpm launch:allowlist import. The address is list data, never an account key.';

    create table public.launch_round_allowlist_roots (
      allowlist_root_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      round_index integer not null,
      snapshot_block bigint not null,
      snapshot_block_hash text not null,
      root text not null,
      leaf_count integer not null,
      mode text not null,
      members jsonb not null,
      computed_at timestamptz not null default clock_timestamp(),
      constraint launch_round_allowlist_roots_unique
        unique (launch_id, round_index, snapshot_block, root),
      constraint launch_round_allowlist_roots_round_check
        check (round_index between 0 and 65535),
      constraint launch_round_allowlist_roots_block_check check (snapshot_block >= 0),
      constraint launch_round_allowlist_roots_hash_check
        check (snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint launch_round_allowlist_roots_root_check check (root ~ '^[0-9a-f]{64}$'),
      constraint launch_round_allowlist_roots_count_check check (leaf_count >= 1),
      constraint launch_round_allowlist_roots_mode_check
        check (mode in ('whitelist', 'community', 'activity')),
      constraint launch_round_allowlist_roots_members_check
        check (jsonb_typeof(members) = 'array' and jsonb_array_length(members) = leaf_count)
    );

    create index launch_round_allowlist_roots_round_idx
      on public.launch_round_allowlist_roots (launch_id, round_index, computed_at desc);

    comment on table public.launch_round_allowlist_roots is
      'Append-only Merkle roots (leaf keccak256(abi.encodePacked(address)), sorted pairs) computed once per snapshot block by pnpm launch:allowlist compute (Decision 0077). members is the sorted lowercase address set; root is 64 hex without 0x. LOOP never writes the root on chain.';

    create function public.reject_launch_allowlist_root_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'launch_round_allowlist_roots are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger launch_round_allowlist_roots_append_only
      before update or delete on public.launch_round_allowlist_roots
      for each row execute function public.reject_launch_allowlist_root_mutation();

    alter table public.launch_intents
      add column sale_id bigint,
      add column round_index integer,
      add column min_token_amount_raw numeric(78, 0),
      add column deadline timestamptz,
      add column eligibility_proof jsonb,
      add column unsigned_transaction jsonb,
      add column policy jsonb,
      add column idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      add column transaction_hash text,
      add column payload_verified boolean not null default false,
      add column reported_at timestamptz,
      add constraint launch_intents_idempotency_unique unique (idempotency_record_id),
      add constraint launch_intents_transaction_hash_check
        check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
      add constraint launch_intents_report_check
        check (
          (transaction_hash is null) = (reported_at is null)
          and (state not in ('submitted', 'confirmed') or transaction_hash is not null)
        ),
      add constraint launch_intents_round_index_check
        check (round_index is null or round_index between 0 and 65535),
      add constraint launch_intents_min_token_check
        check (min_token_amount_raw is null or min_token_amount_raw >= 0),
      add constraint launch_intents_proof_check
        check (eligibility_proof is null or jsonb_typeof(eligibility_proof) = 'array'),
      add constraint launch_intents_unsigned_check
        check (unsigned_transaction is null or jsonb_typeof(unsigned_transaction) = 'object'),
      add constraint launch_intents_policy_check
        check (policy is null or jsonb_typeof(policy) = 'object');

    create unique index launch_intents_transaction_idx
      on public.launch_intents (transaction_hash)
      where transaction_hash is not null;

    comment on column public.launch_intents.transaction_hash is
      'Device broadcast report (Decision 0077): pending evidence only. The Intent becomes confirmed when the launch_event lane indexes a Purchased log of that transaction; history always reads the index.';

    alter table public.launch_review_events
      drop constraint launch_review_events_type_check;
    alter table public.launch_review_events
      add constraint launch_review_events_type_check
      check (event_type in (${quoted([...reviewEventTypesBefore, "sale_registered"])}));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.launch_indexed_events)
        or exists (select 1 from public.launch_allowlists)
        or exists (select 1 from public.launch_round_allowlist_roots)
        or exists (select 1 from public.launch_intents)
        or exists (select 1 from public.purchase_records)
        or exists (select 1 from public.refund_claims)
        or exists (select 1 from public.indexer_checkpoints where lane = 'launch_event')
        or exists (
          select 1 from public.launch_review_events where event_type = 'sale_registered'
        )
      then
        raise exception 'launch lane facts exist; refusing to roll back 000042';
      end if;
    end
    $$;

    alter table public.launch_review_events
      drop constraint launch_review_events_type_check;
    alter table public.launch_review_events
      add constraint launch_review_events_type_check
      check (event_type in (${quoted(reviewEventTypesBefore)}));

    drop index public.launch_intents_transaction_idx;
    alter table public.launch_intents
      drop constraint launch_intents_report_check,
      drop constraint launch_intents_transaction_hash_check,
      drop column reported_at,
      drop column payload_verified,
      drop column transaction_hash,
      drop constraint launch_intents_policy_check,
      drop constraint launch_intents_unsigned_check,
      drop constraint launch_intents_proof_check,
      drop constraint launch_intents_min_token_check,
      drop constraint launch_intents_round_index_check,
      drop constraint launch_intents_idempotency_unique,
      drop column idempotency_record_id,
      drop column policy,
      drop column unsigned_transaction,
      drop column eligibility_proof,
      drop column deadline,
      drop column min_token_amount_raw,
      drop column round_index,
      drop column sale_id;

    drop trigger launch_round_allowlist_roots_append_only
      on public.launch_round_allowlist_roots;
    drop function public.reject_launch_allowlist_root_mutation();
    drop table public.launch_round_allowlist_roots;
    drop table public.launch_allowlists;

    drop index public.refund_claims_log_unique_idx;
    alter table public.refund_claims
      drop constraint refund_claims_log_check,
      drop column removed,
      drop column block_number,
      drop column log_index;

    alter table public.purchase_records
      drop constraint purchase_records_round_index_check,
      drop column round_index,
      drop column chain_id;

    alter table public.launches
      drop column project_asset_id,
      drop column quote_asset_id,
      drop constraint launches_lp_token_check,
      drop constraint launches_pool_address_check,
      drop constraint launches_state_config_version_check,
      drop column lp_unlock_at,
      drop column lp_token_id,
      drop column pool_id,
      drop column pool_address,
      drop column state_config_version;

    drop table public.launch_indexed_events;

    alter table public.indexer_checkpoints
      drop constraint indexer_checkpoints_lane_check;
    alter table public.indexer_checkpoints
      add constraint indexer_checkpoints_lane_check
      check (lane in ('erc20_transfer', 'pool_event'));
  `);
}
