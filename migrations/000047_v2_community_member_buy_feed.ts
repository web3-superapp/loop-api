import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0097 (S108): the `community_member_buy_feed` worker lane.
 *
 * 1. `community_feed_cursors`: how far a feed lane has consumed the
 *    `pool_event` indexer lane, as a `(block_number, log_index)` position.
 *    `last_log_index = 2147483647` means "every log of that block". The
 *    cursor never passes the `pool_event` checkpoint.
 * 2. `community_member_buy_events`: one row per (swap log, community) the
 *    lane matched to an active member, with what it did about it. The
 *    primary key is the de-duplication key; `stream_message_id` is the
 *    deterministic Stream message ID of a row the lane sent (or is sending).
 *
 * 3. `account_wallets_active_address_idx`: the lane resolves a swap's
 *    recipient / sender to an account by address.
 *
 * Both tables are derived from `indexed_pool_events`; rolling back drops them
 * and the lane starts again from the then-current checkpoint.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.community_feed_cursors (
      lane text not null,
      chain_id text not null
        references public.chains(chain_id) on delete restrict,
      last_block_number bigint not null,
      last_log_index integer not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (lane, chain_id),
      constraint community_feed_cursors_lane_check
        check (lane in ('community_member_buy_feed')),
      constraint community_feed_cursors_position_check
        check (last_block_number >= 0 and last_log_index >= 0),
      constraint community_feed_cursors_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.community_feed_cursors is
      'Decision 0097: consumption position of a community feed lane over indexed_pool_events. Never ahead of the pool_event indexer checkpoint; last_log_index 2147483647 means the whole block.';

    create table public.community_member_buy_events (
      chain_id text not null
        references public.chains(chain_id) on delete restrict,
      transaction_hash text not null,
      log_index integer not null,
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      buyer_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      block_number bigint not null,
      outcome text not null,
      stream_message_id text,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, transaction_hash, log_index, community_id),
      constraint community_member_buy_events_transaction_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint community_member_buy_events_log_index_check
        check (log_index >= 0),
      constraint community_member_buy_events_block_check
        check (block_number >= 0),
      constraint community_member_buy_events_outcome_check
        check (outcome in (
          'pending',
          'sent',
          'rejected',
          'truncated',
          'skipped_not_buy',
          'skipped_private',
          'skipped_no_channel'
        )),
      constraint community_member_buy_events_message_id_check
        check (
          stream_message_id is null
          or stream_message_id ~ '^loop_buy_[0-9a-f]{32}$'
        ),
      constraint community_member_buy_events_message_required_check
        check (
          outcome not in ('pending', 'sent', 'rejected')
          or stream_message_id is not null
        ),
      constraint community_member_buy_events_message_absent_check
        check (
          outcome in ('pending', 'sent', 'rejected')
          or stream_message_id is null
        ),
      constraint community_member_buy_events_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.community_member_buy_events is
      'Decision 0097: swaps of a community''s bound asset matched to an active member wallet, with the lane outcome. The key de-duplicates; only outcome sent produced a Stream message (pending is being sent).';

    create index community_member_buy_events_pending_idx
      on public.community_member_buy_events (chain_id, block_number, log_index)
      where outcome = 'pending';
    create index community_member_buy_events_community_idx
      on public.community_member_buy_events (community_id, block_number desc);

    create index account_wallets_active_address_idx
      on public.account_wallets (address)
      where status = 'active';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop index public.account_wallets_active_address_idx;
    drop table public.community_member_buy_events;
    drop table public.community_feed_cursors;
  `);
}
