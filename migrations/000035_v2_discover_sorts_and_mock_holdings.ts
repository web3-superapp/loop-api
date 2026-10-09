import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0061, three facts that had no column:
 *
 * 1. `wallet_balance_snapshots.source` — where an observed balance came
 *    from. `chain` is an RPC observation of a real address (everything
 *    written so far, and everything the wallet page writes). `mock_seed` is
 *    a Development row written by `ops/seed-mock.sh --holdings` so the
 *    Mining formula can be checked against holdings nobody has to buy. The
 *    two are never mixed silently: the snapshot lane includes `mock_seed`
 *    only under `MINING_MOCK_HOLDINGS_ENABLED`, and every snapshot says
 *    which kinds it counted.
 *
 * 2. `mining_snapshots.holdings_source` — `chain`, `mock_seed` or `mixed`,
 *    derived from the rows that actually produced power. It travels to the
 *    client on the `snapshot` block so a demo number is labelled as one.
 *    Existing rows are `chain`: no mock row could have entered them, since
 *    the column that marks one did not exist.
 *
 * 3. `community_channel_activity` — what the community-channel sync lane
 *    observed about an official channel through Stream: the messages of the
 *    last seven days, Stream's own lifetime `message_count`, and
 *    `last_message_at`. `observed_at` is mandatory, because an activity
 *    number without the time it was measured is not a fact. It is the only
 *    source of `GET /v2/communities?sort=activity`; with no row the sort is
 *    `unavailable`, never an invented zero ordering.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.wallet_balance_snapshots
      add column source text not null default 'chain',
      add constraint wallet_balance_snapshots_source_check
        check (source in ('chain', 'mock_seed'));

    comment on column public.wallet_balance_snapshots.source is
      'Decision 0061: chain = observed over RPC for a real address (the only kind the wallet page reads or writes); mock_seed = a Development row written by ops/seed-mock.sh --holdings, included by the mining lane only under MINING_MOCK_HOLDINGS_ENABLED and never shown as a wallet balance.';

    create index wallet_balance_snapshots_source_idx
      on public.wallet_balance_snapshots (source)
      where source <> 'chain';

    alter table public.mining_snapshots
      add column holdings_source text not null default 'chain',
      add constraint mining_snapshots_holdings_source_check
        check (holdings_source in ('chain', 'mock_seed', 'mixed'));

    comment on column public.mining_snapshots.holdings_source is
      'Decision 0061: which kinds of observed balance produced the power rows of this snapshot — chain, mock_seed, or mixed. Published on the snapshot block so a client can say that a number includes demonstration holdings.';

    create table public.community_channel_activity (
      community_id uuid primary key
        references public.communities (community_id) on delete cascade,
      stream_channel_id text not null,
      window_days integer not null,
      recent_message_count bigint not null,
      recent_count_bounded boolean not null,
      total_message_count bigint,
      last_message_at timestamptz,
      observed_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint community_channel_activity_window_check
        check (window_days = 7),
      constraint community_channel_activity_recent_count_check
        check (recent_message_count >= 0),
      constraint community_channel_activity_total_count_check
        check (total_message_count is null or total_message_count >= 0),
      constraint community_channel_activity_channel_id_check
        check (stream_channel_id ~ '^loop_community_[0-9a-f]{32}$')
    );

    create index community_channel_activity_recent_idx
      on public.community_channel_activity
        (recent_message_count desc, community_id asc);

    create index community_channel_activity_observed_idx
      on public.community_channel_activity (observed_at asc);

    comment on table public.community_channel_activity is
      'Decision 0061: the community-channel sync lane''s observation of an official Stream channel. One row per community, replaced by the newest observation. Only the discover sort sort=activity reads it.';

    comment on column public.community_channel_activity.recent_message_count is
      'Messages created inside the last window_days as counted from the message page Stream returned. A lower bound when recent_count_bounded is true.';

    comment on column public.community_channel_activity.recent_count_bounded is
      'True when the message page Stream returned was full and its oldest message is still inside the window: more messages exist than were counted, so the number is a floor and the client is told so.';

    comment on column public.community_channel_activity.total_message_count is
      'Stream''s own lifetime message_count for the channel when it publishes one; null when it does not. Never used for ordering.';

    comment on column public.community_channel_activity.observed_at is
      'When the lane read the channel. Mandatory: an activity count without its observation time is not a fact.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.community_channel_activity;

    alter table public.mining_snapshots
      drop constraint mining_snapshots_holdings_source_check,
      drop column holdings_source;

    do $$
    begin
      if exists (
        select 1
        from public.wallet_balance_snapshots
        where source <> 'chain'
      ) then
        raise exception
          'refusing to drop the balance source while a non-chain balance row exists';
      end if;
    end
    $$;

    drop index public.wallet_balance_snapshots_source_idx;

    alter table public.wallet_balance_snapshots
      drop constraint wallet_balance_snapshots_source_check,
      drop column source;
  `);
}
