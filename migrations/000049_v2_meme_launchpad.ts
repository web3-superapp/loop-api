import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0101: the MEME curve launchpad (docs/10, S116).
 *
 * - `meme_tokens`: one App-created token, from `draft` to `graduated`. The
 *   curve snapshot columns (`v_usd1`, `v_token`, `real_usd1`, `sold`) are a
 *   projection of the newest non-removed `Trade` log; status, graduation,
 *   and residual columns are projections of `meme_indexed_events`. Chain
 *   tokens LOOP did not create are never stored.
 * - `meme_indexed_events`: decoded non-trade curve events of LOOP tokens
 *   (TokenCreated, CurveFull, Graduated, GraduationResidual,
 *   ResidualInjected, Paused, Unpaused). A reorged-out log keeps its row
 *   with `removed = true` (Decision 0034 discipline).
 * - `meme_trades`: decoded `Trade` logs; `price_after_e18` is
 *   `vUsd1After · 1e18 / vTokenAfter`. Same reorg discipline.
 * - `meme_holders`: per wallet net curve position (buys − sells), recomputed
 *   from `meme_trades`; frozen at graduation.
 * - `meme_salts`: the offline-mined CREATE2 salt pool (vanity suffix).
 * - `meme_intents`: create / buy / sell Intents (Decision 0077 shape).
 * - `indexer_checkpoints.lane` admits `meme_event`.
 * - `idempotency_records.digest_version` admits `meme_token_create_v1` and
 *   `meme_intent_v1`.
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
] as const;

function digestVersionList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const tokenStatuses =
  "'draft', 'pending_chain', 'trading', 'full', 'graduated', 'paused'";
const eventNames =
  "'TokenCreated', 'CurveFull', 'Graduated', 'GraduationResidual', 'ResidualInjected', 'Paused', 'Unpaused'";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.indexer_checkpoints
      drop constraint indexer_checkpoints_lane_check;
    alter table public.indexer_checkpoints
      add constraint indexer_checkpoints_lane_check
      check (lane in ('erc20_transfer', 'pool_event', 'launch_event', 'meme_event'));

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
${digestVersionList([...digestVersionsBefore, "meme_token_create_v1", "meme_intent_v1"])}
      ));

    create table public.meme_tokens (
      meme_token_id uuid primary key,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      contract_address text not null,
      contract_version text not null,
      creator_user_id uuid not null references public.loop_users(id) on delete restrict,
      creator_wallet_id uuid,
      creator_wallet text,
      name text not null,
      symbol text not null,
      description text not null default '',
      image_media_id uuid references public.media_objects(media_id) on delete restrict,
      links jsonb not null default '{}'::jsonb,
      metadata_hash text not null,
      salt text,
      predicted_address text,
      vanity boolean not null default false,
      token_address text,
      asset_id text references public.assets(asset_id) on delete restrict,
      status text not null default 'draft',
      created_block bigint,
      created_tx_hash text,
      chain_created_at timestamptz,
      v_usd1 numeric(78, 0) not null default 6000000000000000000000,
      v_token numeric(78, 0) not null default 1073000000000000000000000000,
      real_usd1 numeric(78, 0) not null default 0,
      sold numeric(78, 0) not null default 0,
      snapshot_block_number bigint,
      holder_count integer not null default 0,
      trade_count integer not null default 0,
      last_trade_at timestamptz,
      full_at timestamptz,
      graduated_at timestamptz,
      pool_address text,
      graduation_tx_hash text,
      lp_token_id numeric(78, 0),
      usd1_to_pool numeric(78, 0),
      tokens_to_pool numeric(78, 0),
      graduation_fee_usd1 numeric(78, 0),
      residual_usd1 numeric(78, 0),
      residual_tokens numeric(78, 0),
      graduation_attempts integer not null default 0,
      graduation_error text,
      graduation_next_attempt_at timestamptz,
      graduation_needs_operator boolean not null default false,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint meme_tokens_idempotency_unique unique (idempotency_record_id),
      constraint meme_tokens_contract_check check (contract_address ~ '^0x[0-9a-f]{40}$'),
      constraint meme_tokens_wallet_check
        check (creator_wallet is null or creator_wallet ~ '^0x[0-9a-f]{40}$'),
      constraint meme_tokens_name_check
        check (char_length(name) between 1 and 32 and name = btrim(name)),
      constraint meme_tokens_symbol_check check (symbol ~ '^[A-Z0-9]{2,10}$'),
      constraint meme_tokens_description_check check (char_length(description) <= 500),
      constraint meme_tokens_links_check check (jsonb_typeof(links) = 'object'),
      constraint meme_tokens_metadata_hash_check check (metadata_hash ~ '^0x[0-9a-f]{64}$'),
      constraint meme_tokens_salt_check check (salt is null or salt ~ '^0x[0-9a-f]{64}$'),
      constraint meme_tokens_predicted_check
        check (
          (salt is null) = (predicted_address is null)
          and (predicted_address is null or predicted_address ~ '^0x[0-9a-f]{40}$')
        ),
      constraint meme_tokens_token_address_check
        check (token_address is null or token_address ~ '^0x[0-9a-f]{40}$'),
      constraint meme_tokens_status_check check (status in (${tokenStatuses})),
      constraint meme_tokens_on_chain_check
        check (status in ('draft', 'pending_chain') or token_address is not null),
      constraint meme_tokens_curve_check
        check (v_usd1 > 0 and v_token > 0 and real_usd1 >= 0 and sold >= 0),
      constraint meme_tokens_counts_check check (holder_count >= 0 and trade_count >= 0),
      constraint meme_tokens_pool_check
        check (pool_address is null or pool_address ~ '^0x[0-9a-f]{40}$'),
      constraint meme_tokens_tx_check
        check (
          (created_tx_hash is null or created_tx_hash ~ '^0x[0-9a-f]{64}$')
          and (graduation_tx_hash is null or graduation_tx_hash ~ '^0x[0-9a-f]{64}$')
        ),
      constraint meme_tokens_attempts_check check (graduation_attempts >= 0),
      constraint meme_tokens_timestamp_check check (updated_at >= created_at)
    );

    create unique index meme_tokens_token_address_idx
      on public.meme_tokens (chain_id, token_address)
      where token_address is not null;
    create unique index meme_tokens_salt_idx
      on public.meme_tokens (salt)
      where salt is not null;
    create index meme_tokens_creator_created_idx
      on public.meme_tokens (creator_user_id, created_at desc);
    create index meme_tokens_status_created_idx
      on public.meme_tokens (status, chain_created_at desc, meme_token_id);
    create index meme_tokens_graduated_idx
      on public.meme_tokens (graduated_at desc, meme_token_id)
      where status = 'graduated';

    comment on table public.meme_tokens is
      'Decision 0101: MEME tokens created through the App (POST /v2/meme/tokens). Curve and status columns are projections of the meme_event lane; chain tokens LOOP did not create are never stored. creator_wallet is an attribute, never a key.';
    comment on column public.meme_tokens.metadata_hash is
      'keccak256 of the canonical memeMetadataV1 JSON; compared with TokenCreated.metadataHash.';

    create table public.meme_indexed_events (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      contract_address text not null,
      token_address text not null,
      meme_token_id uuid not null references public.meme_tokens(meme_token_id) on delete restrict,
      event_name text not null,
      payload jsonb not null,
      event_at timestamptz,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, transaction_hash, log_index),
      constraint meme_indexed_events_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$' and block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint meme_indexed_events_log_check check (log_index >= 0 and block_number >= 0),
      constraint meme_indexed_events_address_check
        check (contract_address ~ '^0x[0-9a-f]{40}$' and token_address ~ '^0x[0-9a-f]{40}$'),
      constraint meme_indexed_events_name_check check (event_name in (${eventNames})),
      constraint meme_indexed_events_payload_check check (jsonb_typeof(payload) = 'object')
    );

    create index meme_indexed_events_token_idx
      on public.meme_indexed_events (meme_token_id, block_number, log_index);
    create index meme_indexed_events_block_idx
      on public.meme_indexed_events (chain_id, block_number);

    create table public.meme_trades (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      token_address text not null,
      meme_token_id uuid not null references public.meme_tokens(meme_token_id) on delete restrict,
      wallet text not null,
      is_buy boolean not null,
      usd1_amount numeric(78, 0) not null,
      token_amount numeric(78, 0) not null,
      fee_usd1 numeric(78, 0) not null,
      v_usd1_after numeric(78, 0) not null,
      v_token_after numeric(78, 0) not null,
      sold_after numeric(78, 0) not null,
      price_after_e18 numeric(78, 0) not null,
      traded_at timestamptz not null,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, transaction_hash, log_index),
      constraint meme_trades_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$' and block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint meme_trades_log_check check (log_index >= 0 and block_number >= 0),
      constraint meme_trades_address_check
        check (token_address ~ '^0x[0-9a-f]{40}$' and wallet ~ '^0x[0-9a-f]{40}$'),
      constraint meme_trades_amount_check
        check (
          usd1_amount >= 0 and token_amount >= 0 and fee_usd1 >= 0
          and v_usd1_after > 0 and v_token_after > 0 and sold_after >= 0
          and price_after_e18 >= 0
        )
    );

    create index meme_trades_token_time_idx
      on public.meme_trades (meme_token_id, traded_at desc, block_number desc, log_index desc)
      where not removed;
    create index meme_trades_time_idx
      on public.meme_trades (traded_at)
      where not removed;
    create index meme_trades_block_idx
      on public.meme_trades (chain_id, block_number);
    create index meme_trades_wallet_idx
      on public.meme_trades (wallet, traded_at desc);

    comment on table public.meme_trades is
      'Decision 0101: LoopMemeCurve Trade logs of LOOP tokens. usd1_amount is wallet-side (buy: paid incl. fee; sell: received after fee). wallet is an attribute, never a key; the account is resolved at read time from account_wallets. A reorged-out log keeps its row with removed = true.';

    create table public.meme_holders (
      meme_token_id uuid not null references public.meme_tokens(meme_token_id) on delete restrict,
      wallet text not null,
      balance numeric(78, 0) not null,
      frozen_at timestamptz,
      updated_at timestamptz not null default clock_timestamp(),
      primary key (meme_token_id, wallet),
      constraint meme_holders_wallet_check check (wallet ~ '^0x[0-9a-f]{40}$'),
      constraint meme_holders_balance_check check (balance > 0)
    );

    create index meme_holders_balance_idx
      on public.meme_holders (meme_token_id, balance desc, wallet);

    comment on table public.meme_holders is
      'Decision 0101: net curve position per wallet (buys − sells from meme_trades), recomputed per segment; ERC-20 transfers between wallets are not tracked. Frozen at graduation.';

    create table public.meme_salts (
      salt text primary key,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      contract_address text not null,
      token_implementation text not null,
      predicted_address text not null,
      suffix text not null,
      status text not null default 'free',
      reserved_by_token_id uuid references public.meme_tokens(meme_token_id) on delete restrict,
      reserved_at timestamptz,
      used_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      constraint meme_salts_salt_check check (salt ~ '^0x[0-9a-f]{64}$'),
      constraint meme_salts_address_check
        check (
          contract_address ~ '^0x[0-9a-f]{40}$'
          and token_implementation ~ '^0x[0-9a-f]{40}$'
          and predicted_address ~ '^0x[0-9a-f]{40}$'
        ),
      constraint meme_salts_suffix_check
        check (suffix ~ '^[0-9a-f]{0,8}$' and right(predicted_address, char_length(suffix)) = suffix),
      constraint meme_salts_status_check check (status in ('free', 'reserved', 'used')),
      constraint meme_salts_reservation_check
        check (
          (status = 'free' and reserved_by_token_id is null and reserved_at is null)
          or (status = 'reserved' and reserved_by_token_id is not null and reserved_at is not null)
          or status = 'used'
        )
    );

    create index meme_salts_free_idx
      on public.meme_salts (chain_id, contract_address, token_implementation, suffix, created_at)
      where status = 'free';
    create index meme_salts_reserved_idx
      on public.meme_salts (reserved_at)
      where status = 'reserved';

    comment on table public.meme_salts is
      'Decision 0101: CREATE2 salts mined offline so the clone address ends in MEME_VANITY_SUFFIX. A salt is not bound to its creator on chain: a salt taken by someone else is marked used and the draft gets another.';

    create table public.meme_intents (
      intent_id uuid primary key,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      wallet_id uuid not null,
      wallet_address text not null,
      meme_token_id uuid not null references public.meme_tokens(meme_token_id) on delete restrict,
      kind text not null,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      contract_address text not null,
      token_address text,
      usd1_amount_raw numeric(78, 0) not null,
      token_amount_raw numeric(78, 0) not null,
      expected_out_raw numeric(78, 0) not null,
      min_out_raw numeric(78, 0) not null,
      fee_raw numeric(78, 0) not null,
      refund_raw numeric(78, 0) not null,
      deadline timestamptz not null,
      snapshot_block_number bigint not null,
      snapshot_block_hash text not null,
      calldata jsonb not null,
      unsigned_transaction jsonb not null,
      approval jsonb,
      policy jsonb not null,
      payload_digest text not null,
      state text not null,
      reason_code text,
      transaction_hash text,
      payload_verified boolean not null default false,
      reported_at timestamptz,
      receipt jsonb,
      reconcile_after timestamptz,
      expires_at timestamptz not null,
      idempotency_record_id uuid not null
        references public.idempotency_records(id) on delete restrict,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint meme_intents_idempotency_unique unique (idempotency_record_id),
      constraint meme_intents_kind_check check (kind in ('create', 'buy', 'sell')),
      constraint meme_intents_state_check
        check (state in ('prepared', 'broadcast_reported', 'confirmed', 'failed', 'expired')),
      constraint meme_intents_address_check
        check (
          wallet_address ~ '^0x[0-9a-f]{40}$'
          and contract_address ~ '^0x[0-9a-f]{40}$'
          and (token_address is null or token_address ~ '^0x[0-9a-f]{40}$')
        ),
      constraint meme_intents_amount_check
        check (
          usd1_amount_raw >= 0 and token_amount_raw >= 0 and expected_out_raw >= 0
          and min_out_raw >= 0 and fee_raw >= 0 and refund_raw >= 0
        ),
      constraint meme_intents_snapshot_check
        check (snapshot_block_number >= 0 and snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint meme_intents_json_check
        check (
          jsonb_typeof(calldata) = 'object'
          and jsonb_typeof(unsigned_transaction) = 'object'
          and (approval is null or jsonb_typeof(approval) = 'object')
          and jsonb_typeof(policy) = 'object'
        ),
      constraint meme_intents_digest_check check (payload_digest ~ '^[0-9a-f]{64}$'),
      constraint meme_intents_reason_code_check
        check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      constraint meme_intents_transaction_hash_check
        check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint meme_intents_report_check
        check (
          (transaction_hash is null) = (reported_at is null)
          and (state not in ('broadcast_reported', 'confirmed') or transaction_hash is not null)
        ),
      constraint meme_intents_receipt_check
        check (
          receipt is null
          or (jsonb_typeof(receipt) = 'object' and receipt ->> 'status' in ('success', 'reverted'))
        )
    );

    create unique index meme_intents_transaction_idx
      on public.meme_intents (transaction_hash)
      where transaction_hash is not null;
    create index meme_intents_reconcile_idx
      on public.meme_intents (chain_id, reconcile_after nulls first, intent_id)
      where state = 'broadcast_reported';
    create index meme_intents_owner_idx
      on public.meme_intents (owner_user_id, created_at desc);

    comment on table public.meme_intents is
      'Decision 0101: MEME create / buy / sell Intents (the Decision 0077 discipline). The broadcast report is pending evidence; confirmed comes from the meme_event lane (TokenCreated / Trade of that transaction) or the receipt reconcile part.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.meme_tokens)
        or exists (select 1 from public.meme_salts)
        or exists (select 1 from public.indexer_checkpoints where lane = 'meme_event')
        or exists (
          select 1 from public.idempotency_records
          where digest_version in ('meme_token_create_v1', 'meme_intent_v1')
        )
      then
        raise exception 'meme launchpad facts exist; refusing to roll back 000049';
      end if;
    end
    $$;

    drop table public.meme_intents;
    drop table public.meme_salts;
    drop table public.meme_holders;
    drop table public.meme_trades;
    drop table public.meme_indexed_events;
    drop table public.meme_tokens;

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
${digestVersionList(digestVersionsBefore)}
      ));

    alter table public.indexer_checkpoints
      drop constraint indexer_checkpoints_lane_check;
    alter table public.indexer_checkpoints
      add constraint indexer_checkpoints_lane_check
      check (lane in ('erc20_transfer', 'pool_event', 'launch_event'));
  `);
}
