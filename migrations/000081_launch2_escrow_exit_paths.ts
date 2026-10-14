import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0137 (S179-api): the two NFT-escrow exit paths of loop-contracts
 * S175 (Decision 0011). Nothing here changes an instance of a Factory
 * without them (every Factory deployed before S175).
 *
 * 1. `launch2_events` admits `PublicRoundOpenedAfterTimeout` (snapshots
 *    role: anyone opened the public round once `snapshotTimeoutAt()` passed
 *    without a snapshot) and `RefundClaimed` (escrow role).
 * 2. `launch2_instances.opened_after_timeout_*`: the lane's projection of
 *    the first non-removed `PublicRoundOpenedAfterTimeout` (all or none;
 *    never together with a snapshot root or a zero-holder opening — the
 *    registry makes the three exclusive via `rootPublishedAt`).
 * 3. `launch2_nft_refunds`: typed `RefundClaimed` facts (same key and reorg
 *    discipline as the other launch2 facts); one non-removed refund per
 *    (instance, token) — the escrow pays each token once.
 * 4. `launch2_intents.kind` admits `nft_refund` (`claimRefund(tokenId)` for
 *    the device signing exit); `launch2_nft_refund_reports` keeps the hash
 *    the device reported (append-only; the indexed log stays the truth).
 * 5. `launch2_snapshot_publications.action` admits `open_after_timeout`
 *    (the publisher's `openPublicAfterTimeout()` fallback, same shape as
 *    `open_without_holders`: no members / signatures, zero root and
 *    dataHash; the cutoff columns hold the head block the decision was taken
 *    at).
 */

const eventNames = `
  'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
  'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
  'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
  'BuybackResumed', 'Swap', 'RouterSwap',
  'LoopHookBound', 'SellFeeCharged', 'CandleClosed', 'EmptyCandlesSkipped',
  'RoundActivated', 'RoundClosed', 'BuyCredited', 'BuyNotCredited',
  'BuyFeeCharged', 'RewardClaimed'`;

const exitEventNames = `'PublicRoundOpenedAfterTimeout', 'RefundClaimed'`;

const zeroHash =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const actionShape = (actions: string): string => `
  jsonb_typeof(members) = 'array'
  and jsonb_typeof(signer_addresses) = 'array'
  and jsonb_typeof(signatures) = 'array'
  and root ~ '^0x[0-9a-f]{64}$'
  and data_hash ~ '^0x[0-9a-f]{64}$'
  and (
    (action = 'publish_snapshot'
      and jsonb_array_length(members) > 0 and member_count > 0
      and jsonb_array_length(signer_addresses) = 2
      and jsonb_array_length(signatures) = 2)
    or (action in (${actions})
      and jsonb_array_length(members) = 0 and member_count = 0
      and root = '${zeroHash}'
      and data_hash = '${zeroHash}'
      and jsonb_array_length(signer_addresses) = 0
      and jsonb_array_length(signatures) = 0))`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        ${eventNames},
        ${exitEventNames}));

    alter table public.launch2_instances
      add column opened_after_timeout_at timestamptz,
      add column opened_after_timeout_block numeric(78, 0)
        check (opened_after_timeout_block >= 0),
      add column opened_after_timeout_tx text
        check (opened_after_timeout_tx ~ '^0x[0-9a-f]{64}$'),
      add column opened_after_timeout_total_minted numeric(78, 0)
        check (opened_after_timeout_total_minted >= 0),
      add constraint launch2_instances_opened_after_timeout_shape check (
        (opened_after_timeout_at is null) = (opened_after_timeout_block is null)
        and (opened_after_timeout_at is null) = (opened_after_timeout_tx is null)
        and (opened_after_timeout_at is null) = (opened_after_timeout_total_minted is null)
        and (opened_after_timeout_at is null
          or (snapshot_root is null and opened_without_holders_at is null
            and factory_generation <> 'v2')));

    create table public.launch2_nft_refunds (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      log_index integer not null check (log_index >= 0),
      block_number bigint not null check (block_number >= 0),
      block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      escrow_address text not null check (escrow_address ~ '^0x[0-9a-f]{40}$'),
      token_id numeric(78, 0) not null check (token_id > 0),
      owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
      amount_usd1 numeric(78, 0) not null check (amount_usd1 > 0),
      remaining_recorded_usd1 numeric(78, 0) not null check (remaining_recorded_usd1 >= 0),
      refunded_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index)
    );
    create unique index launch2_nft_refunds_token_once
      on public.launch2_nft_refunds (instance_id, token_id)
      where not removed;
    create index launch2_nft_refunds_owner_idx
      on public.launch2_nft_refunds (instance_id, owner_address)
      where not removed;

    alter table public.launch2_intents
      drop constraint launch2_intents_kind_check;
    alter table public.launch2_intents
      add constraint launch2_intents_kind_check
      check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell',
        'dynamic_claim', 'nft_refund'));

    create table public.launch2_nft_refund_reports (
      intent_id uuid primary key references public.launch2_intents(intent_id) on delete restrict,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      wallet_id uuid not null,
      wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
      token_id numeric(78, 0) not null check (token_id > 0),
      transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      reported_at timestamptz not null default clock_timestamp()
    );
    create index launch2_nft_refund_reports_tx_idx
      on public.launch2_nft_refund_reports (transaction_hash);
    create function public.reject_launch2_nft_refund_report_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'launch2 NFT refund reports are append-only';
    end;
    $$;
    create trigger launch2_nft_refund_reports_immutable
      before update or delete on public.launch2_nft_refund_reports
      for each row execute function public.reject_launch2_nft_refund_report_mutation();

    alter table public.launch2_snapshot_publications
      drop constraint launch2_snapshot_publications_action_check,
      add constraint launch2_snapshot_publications_action_check
        check (action in ('publish_snapshot', 'open_without_holders', 'open_after_timeout')),
      drop constraint launch2_snapshot_publication_action_shape,
      add constraint launch2_snapshot_publication_action_shape check (
        ${actionShape("'open_without_holders', 'open_after_timeout'")});

    comment on table public.launch2_nft_refunds is
      'Decision 0137: NftEscrow RefundClaimed logs (S175 Factories; one refund per NFT).';
    comment on table public.launch2_nft_refund_reports is
      'Decision 0137: transaction hashes the device reported for nft_refund intents (append-only).';
    comment on column public.launch2_instances.opened_after_timeout_at is
      'Decision 0137: PublicRoundOpenedAfterTimeout.openedAt (public round, no early round).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_nft_refunds)
        or exists (select 1 from public.launch2_nft_refund_reports)
        or exists (select 1 from public.launch2_intents where kind = 'nft_refund')
        or exists (select 1 from public.launch2_events where event_name in (${exitEventNames}))
        or exists (select 1 from public.launch2_instances where opened_after_timeout_at is not null)
        or exists (select 1 from public.launch2_snapshot_publications where action = 'open_after_timeout')
      then raise exception 'refusing to remove launch2 escrow exit evidence'; end if;
    end $$;
    alter table public.launch2_snapshot_publications
      drop constraint launch2_snapshot_publication_action_shape,
      add constraint launch2_snapshot_publication_action_shape check (
        ${actionShape("'open_without_holders'")}),
      drop constraint launch2_snapshot_publications_action_check,
      add constraint launch2_snapshot_publications_action_check
        check (action in ('publish_snapshot', 'open_without_holders'));
    drop table public.launch2_nft_refund_reports;
    drop function public.reject_launch2_nft_refund_report_mutation();
    alter table public.launch2_intents
      drop constraint launch2_intents_kind_check;
    alter table public.launch2_intents
      add constraint launch2_intents_kind_check
      check (kind in ('nft_mint', 'buy', 'sell', 'pool_buy', 'pool_sell', 'dynamic_claim'));
    drop table public.launch2_nft_refunds;
    alter table public.launch2_instances
      drop constraint launch2_instances_opened_after_timeout_shape,
      drop column opened_after_timeout_total_minted,
      drop column opened_after_timeout_tx,
      drop column opened_after_timeout_block,
      drop column opened_after_timeout_at;
    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        ${eventNames}));
  `);
}
