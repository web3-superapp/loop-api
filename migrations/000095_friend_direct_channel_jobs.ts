import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0172 (S272-api): accepting a friend / message request guarantees
 * the pair's direct channel server-side.
 *
 * `friend_direct_channel_jobs` is a transactional outbox: the accept
 * transaction inserts (or re-arms) one row per unordered pair, and the
 * `friend_direct_channel` worker lane runs the same idempotent
 * `direct_get_or_create` chat operation that `POST /v2/chat/direct-channels`
 * runs. The row never holds Stream state; `direct_channels` /
 * `chat_operations` stay the authority.
 *
 * - `owner_user_id`: the account the operation is first created for (the
 *   accepter); the lane falls back to the other account when the target's
 *   privacy refuses the first direction.
 * - `operation_id` / `operation_owner_user_id`: the last chat operation the
 *   lane created, polled (never re-created) while it is non-terminal.
 * - `source`: `accept` (written by the accept transaction) or `backfill`
 *   (written by the `FRIEND_CHANNEL_BACKFILL_ENABLED` sweep).
 * - `state`: `pending` (due), `succeeded`, `skipped` (refused by the same
 *   rules as the route: no friendship, direct messages not allowed), `failed`
 *   (terminal chat operation failure or attempts exhausted).
 *
 * The account references cascade: the row is an outbox entry, never a fact
 * another table depends on, so removing an account removes its jobs.
 *
 * `down` drops the table (an outbox, nothing else references it).
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.friend_direct_channel_jobs (
      user_id_low uuid not null
        references public.loop_users(id) on delete cascade,
      user_id_high uuid not null
        references public.loop_users(id) on delete cascade,
      owner_user_id uuid not null
        references public.loop_users(id) on delete cascade,
      kind text not null default 'direct_get_or_create',
      source text not null,
      state text not null default 'pending',
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default clock_timestamp(),
      operation_id uuid,
      operation_owner_user_id uuid,
      last_error_code text,
      lease_worker_id uuid,
      lease_expires_at timestamptz,
      enqueued_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (user_id_low, user_id_high),
      constraint friend_direct_channel_jobs_pair_order_check
        check (user_id_low < user_id_high),
      constraint friend_direct_channel_jobs_owner_check
        check (owner_user_id in (user_id_low, user_id_high)),
      constraint friend_direct_channel_jobs_kind_check
        check (kind = 'direct_get_or_create'),
      constraint friend_direct_channel_jobs_source_check
        check (source in ('accept', 'backfill')),
      constraint friend_direct_channel_jobs_state_check
        check (state in ('pending', 'succeeded', 'skipped', 'failed')),
      constraint friend_direct_channel_jobs_attempts_check
        check (attempts between 0 and 1000),
      constraint friend_direct_channel_jobs_operation_pairing_check
        check (
          (operation_id is null and operation_owner_user_id is null)
          or (operation_id is not null
            and operation_owner_user_id in (user_id_low, user_id_high))
        ),
      constraint friend_direct_channel_jobs_error_code_check
        check (last_error_code is null
          or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint friend_direct_channel_jobs_lease_pairing_check
        check (
          (lease_worker_id is null and lease_expires_at is null)
          or (lease_worker_id is not null and lease_expires_at is not null)
        ),
      constraint friend_direct_channel_jobs_timestamp_check
        check (updated_at >= enqueued_at)
    );

    comment on table public.friend_direct_channel_jobs is
      'Decision 0172 transactional outbox: one row per accepted friend pair; the friend_direct_channel worker lane runs the idempotent direct_get_or_create chat operation for it. direct_channels stays the authority.';

    create index friend_direct_channel_jobs_due_idx
      on public.friend_direct_channel_jobs (next_attempt_at asc)
      where state = 'pending';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`drop table public.friend_direct_channel_jobs;`);
}
