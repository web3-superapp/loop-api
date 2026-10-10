import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0114 (S134): the MEME v2 (`launch2`) read model.
 *
 * - `launch2_instances`: one row per activated Hooks launch (the S132 task
 *   is the registry: launchId, the 11 module addresses, the signed sale
 *   start); the `launch2_event` lane owns every projection column (stage,
 *   next change, NFT sold, curve sold / reserve / price, snapshot, graduation,
 *   buyback summary).
 * - `launch2_events`: every decoded log of the Factory and the instance
 *   modules (raw, `removed` on a reorg rewind).
 * - `launch2_nft_mints`, `launch2_trades`, `launch2_buybacks`: typed facts of
 *   `NftMinted`, `CurveBought` / `CurveSold`, `BuybackCompleted` (a
 *   `rejected` buyback has no log; the column admits it for the keeper).
 * - `launch2_snapshot_members`: the cutoff holder list the lane rebuilt from
 *   the NFT transfers, with the Merkle proof when it reproduces the
 *   published root.
 * - `launch2_positions`: per instance and address — NFT minted / held,
 *   curve bought / sold, the cumulative-buy quota both rounds share.
 * - `launch2_intents`: prepared NFT mint / curve buy / sell signing requests
 *   (device signing exit, never signed here).
 * - `indexer_checkpoints.lane` admits `launch2_event`;
 *   `idempotency_records.digest_version` admits `launch2_intent_v1`.
 */

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
  "launch_intent_v1",
  "meme_token_create_v1",
  "meme_intent_v1",
] as const;

function list(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const address = (column: string): string =>
  `${column} text not null check (${column} ~ '^0x[0-9a-f]{40}$')`;
const amount = (column: string): string =>
  `${column} numeric(78, 0) not null default 0 check (${column} >= 0)`;
const factKey = `
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      log_index integer not null check (log_index >= 0),
      block_number bigint not null check (block_number >= 0),
      block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.indexer_checkpoints
      drop constraint indexer_checkpoints_lane_check;
    alter table public.indexer_checkpoints
      add constraint indexer_checkpoints_lane_check
      check (lane in ('erc20_transfer', 'pool_event', 'launch_event', 'meme_event', 'launch2_event'));

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (${list([...digestVersionsBefore, "launch2_intent_v1"])}));

    create table public.launch2_instances (
      instance_id uuid primary key,
      job_id uuid not null unique references public.hooks_launch_deployment_tasks(job_id) on delete restrict,
      project_id uuid not null,
      config_version integer not null check (config_version > 0),
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      ${address("factory_address")},
      launch_id text not null unique check (launch_id ~ '^0x[0-9a-f]{64}$'),
      config_hash text not null check (config_hash ~ '^0x[0-9a-f]{64}$'),
      ${address("project_owner")},
      name text not null check (char_length(name) between 1 and 64),
      ticker text not null check (ticker ~ '^[A-Z0-9]{2,12}$'),
      logo_url text check (logo_url is null or char_length(logo_url) <= 2048),
      meme_address text not null check (meme_address ~ '^0x[0-9a-f]{36}6666$'),
      ${address("hook_address")},
      ${address("nft_address")},
      ${address("curve_address")},
      ${address("gate_address")},
      ${address("escrow_address")},
      ${address("snapshots_address")},
      ${address("graduation_adapter_address")},
      ${address("buyback_adapter_address")},
      ${address("price_recorder_address")},
      ${address("buyback_executor_address")},
      ${address("buyback_recipient")},
      nft_sale_start timestamptz not null,
      deploy_block_number bigint not null check (deploy_block_number >= 0),
      activation_block_number bigint check (activation_block_number >= 0),
      registered_at timestamptz not null default clock_timestamp(),
      -- Lane-owned projection.
      deployed_event_seen boolean not null default false,
      activated_at timestamptz,
      activated_block_number bigint,
      hold_reason text check (hold_reason in ('LAUNCH2_DEPLOYED_EVENT_MISMATCH', 'LAUNCH2_ACTIVATION_MISSING')),
      stage text not null default 'upcoming' check (stage in (
        'upcoming', 'nft_sale', 'snapshot_pending', 'priority', 'public', 'graduated', 'paused')),
      next_change_at timestamptz,
      nft_minted_count bigint not null default 0 check (nft_minted_count >= 0),
      ${amount("sold_supply")},
      ${amount("reserve_usd1")},
      ${amount("price_e18")},
      trade_count bigint not null default 0 check (trade_count >= 0),
      ${amount("buy_volume_usd1")},
      ${amount("tax_usd1")},
      snapshot_root text check (snapshot_root ~ '^0x[0-9a-f]{64}$'),
      snapshot_data_hash text check (snapshot_data_hash ~ '^0x[0-9a-f]{64}$'),
      snapshot_cutoff_block bigint check (snapshot_cutoff_block >= 0),
      snapshot_cutoff_block_hash text check (snapshot_cutoff_block_hash ~ '^0x[0-9a-f]{64}$'),
      snapshot_published_at timestamptz,
      snapshot_published_block bigint check (snapshot_published_block >= 0),
      snapshot_transaction_hash text check (snapshot_transaction_hash ~ '^0x[0-9a-f]{64}$'),
      snapshot_verification text check (snapshot_verification in ('verified', 'mismatch')),
      snapshot_member_count integer check (snapshot_member_count >= 0),
      snapshot_signers jsonb check (snapshot_signers is null or jsonb_typeof(snapshot_signers) = 'array'),
      graduated_at timestamptz,
      graduation_block bigint check (graduation_block >= 0),
      graduation_transaction_hash text check (graduation_transaction_hash ~ '^0x[0-9a-f]{64}$'),
      official_pool_id text check (official_pool_id ~ '^0x[0-9a-f]{64}$'),
      buyback_paused boolean not null default false,
      buyback_count bigint not null default 0 check (buyback_count >= 0),
      ${amount("buyback_usd1")},
      ${amount("buyback_meme")},
      last_buyback_at timestamptz,
      projected_at timestamptz not null default clock_timestamp(),
      constraint launch2_instances_snapshot_shape check (
        (snapshot_root is null) = (snapshot_published_at is null)
        and (snapshot_root is null) = (snapshot_cutoff_block is null)
        and (snapshot_verification is null or snapshot_root is not null)),
      constraint launch2_instances_graduation_shape check (
        (graduated_at is null) = (official_pool_id is null)),
      foreign key (project_id, config_version)
        references public.hooks_launch_config_approvals(project_id, config_version) on delete restrict
    );
    create index launch2_instances_stage_idx
      on public.launch2_instances (stage, activated_at desc, instance_id desc);
    create index launch2_instances_owner_idx
      on public.launch2_instances (owner_user_id, registered_at desc);

    create table public.launch2_events (
      ${factKey}
      contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
      event_name text not null check (event_name in (
        'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
        'SnapshotPublished', 'CurveBought', 'CurveSold', 'Graduated',
        'BuybackCompleted', 'BuybackPausedEvent', 'BuybackResumed')),
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      event_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index)
    );
    create index launch2_events_instance_idx
      on public.launch2_events (instance_id, event_name, block_number, log_index);
    create index launch2_events_block_idx
      on public.launch2_events (chain_id, block_number) where not removed;

    create table public.launch2_nft_mints (
      ${factKey}
      ${address("payer_address")},
      token_id numeric(78, 0) not null check (token_id > 0),
      ${amount("amount_usd1")},
      minted_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index)
    );
    create index launch2_nft_mints_instance_idx
      on public.launch2_nft_mints (instance_id, minted_at desc) where not removed;

    create table public.launch2_trades (
      trade_id uuid not null unique,
      ${factKey}
      side text not null check (side in ('buy', 'sell')),
      ${address("trader_address")},
      ${amount("meme_amount")},
      ${amount("usd1_gross")},
      ${amount("usd1_net")},
      ${amount("tax_usd1")},
      ${amount("refund_usd1")},
      cumulative_bought numeric(78, 0) check (cumulative_bought >= 0),
      sold_after numeric(78, 0) check (sold_after >= 0),
      traded_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index),
      constraint launch2_trades_buy_shape check ((side = 'buy') = (cumulative_bought is not null))
    );
    create index launch2_trades_instance_idx
      on public.launch2_trades (instance_id, block_number desc, log_index desc) where not removed;
    create index launch2_trades_trader_idx
      on public.launch2_trades (trader_address, instance_id) where not removed;

    create table public.launch2_buybacks (
      buyback_id uuid not null unique,
      ${factKey}
      outcome text not null check (outcome in ('executed', 'rejected')),
      reason_code text check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      ${amount("usd1_spent")},
      ${amount("meme_delivered")},
      ${amount("min_meme_out")},
      ${amount("reference_price_e18")},
      ${amount("spot_price_e18")},
      executed_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index),
      constraint launch2_buybacks_outcome_shape check ((outcome = 'rejected') = (reason_code is not null))
    );
    create index launch2_buybacks_instance_idx
      on public.launch2_buybacks (instance_id, executed_at desc, buyback_id desc) where not removed;

    create table public.launch2_snapshot_members (
      member_id bigint generated always as identity primary key,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      ${address("member_address")},
      leaf text not null check (leaf ~ '^0x[0-9a-f]{64}$'),
      proof jsonb check (proof is null or jsonb_typeof(proof) = 'array'),
      nft_balance integer not null check (nft_balance > 0),
      created_at timestamptz not null default clock_timestamp(),
      unique (instance_id, member_address)
    );

    create table public.launch2_positions (
      position_id bigint generated always as identity primary key,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      ${address("holder_address")},
      nft_minted_token_id numeric(78, 0) check (nft_minted_token_id > 0),
      nft_held integer not null default 0 check (nft_held >= 0),
      ${amount("curve_bought")},
      ${amount("curve_sold")},
      ${amount("cumulative_bought")},
      ${amount("usd1_spent")},
      ${amount("usd1_received")},
      ${amount("tax_usd1")},
      buy_count integer not null default 0 check (buy_count >= 0),
      sell_count integer not null default 0 check (sell_count >= 0),
      snapshot_member boolean not null default false,
      last_activity_at timestamptz,
      updated_at timestamptz not null default clock_timestamp(),
      unique (instance_id, holder_address)
    );
    create index launch2_positions_holder_idx
      on public.launch2_positions (holder_address, instance_id);

    create table public.launch2_intents (
      intent_id uuid primary key,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      idempotency_record_id uuid not null unique
        references public.idempotency_records(id) on delete restrict,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      wallet_id uuid not null,
      ${address("wallet_address")},
      kind text not null check (kind in ('nft_mint', 'buy', 'sell')),
      chain_id text not null references public.chains(chain_id) on delete restrict,
      ${address("contract_address")},
      ${amount("amount_in")},
      ${amount("expected_out")},
      ${amount("min_out")},
      ${amount("tax_usd1")},
      ${amount("refund_usd1")},
      deadline timestamptz not null,
      snapshot_block_number bigint not null check (snapshot_block_number >= 0),
      snapshot_block_hash text not null check (snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
      calldata jsonb not null check (jsonb_typeof(calldata) = 'object'),
      unsigned_transaction jsonb not null check (jsonb_typeof(unsigned_transaction) = 'object'),
      approval jsonb check (approval is null or jsonb_typeof(approval) = 'object'),
      policy jsonb not null check (jsonb_typeof(policy) = 'object'),
      payload_digest text not null check (payload_digest ~ '^[0-9a-f]{64}$'),
      state text not null default 'prepared' check (state = 'prepared'),
      expires_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp()
    );
    create index launch2_intents_owner_idx
      on public.launch2_intents (owner_user_id, created_at desc);

    create function public.reject_launch2_intent_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'launch2 intents are append-only';
    end;
    $$;
    create trigger launch2_intents_immutable
      before update or delete on public.launch2_intents
      for each row execute function public.reject_launch2_intent_mutation();

    comment on table public.launch2_instances is
      'Decision 0114: activated Hooks launches (registry from the S132 deployment task) and the launch2_event lane projection.';
    comment on table public.launch2_intents is
      'Decision 0114: prepared signing requests for the device signing exit; never signed or broadcast here.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_instances)
        or exists (select 1 from public.indexer_checkpoints where lane = 'launch2_event')
        or exists (select 1 from public.idempotency_records where digest_version = 'launch2_intent_v1')
      then raise exception 'refusing to remove launch2 read-model evidence'; end if;
    end $$;
    drop trigger launch2_intents_immutable on public.launch2_intents;
    drop function public.reject_launch2_intent_mutation();
    drop table public.launch2_intents;
    drop table public.launch2_positions;
    drop table public.launch2_snapshot_members;
    drop table public.launch2_buybacks;
    drop table public.launch2_trades;
    drop table public.launch2_nft_mints;
    drop table public.launch2_events;
    drop table public.launch2_instances;
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (${list(digestVersionsBefore)}));
    alter table public.indexer_checkpoints
      drop constraint indexer_checkpoints_lane_check;
    alter table public.indexer_checkpoints
      add constraint indexer_checkpoints_lane_check
      check (lane in ('erc20_transfer', 'pool_event', 'launch_event', 'meme_event'));
  `);
}
