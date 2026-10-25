import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0183 (S300): community membership history for the mining
 * membership gate.
 *
 * `community_memberships` keeps only the current state: leaving deletes the
 * row and a ban flips `status` to `banned`, so "was this account a member
 * at second t of the hour" cannot be answered from it. The hourly settlement
 * needs exactly that (an NFT or a bound MEME counts only while its holder is
 * a member of the verified community), so this table records every
 * membership interval:
 *
 * - one row per interval `[joined_at, left_at)`; `left_at` null = still a
 *   member. At most one open row per (community, user).
 * - "member" means a `community_memberships` row whose status is not
 *   `banned` (the same rule as `communities.member_count`): `active` and
 *   `muted` are members, `banned` is not.
 * - maintained only by the `community_memberships_history` trigger, so every
 *   writer (join, create, leave, ban, unban, seeds) is covered:
 *   insert of a non-banned row → open at the row's `joined_at`;
 *   banned → non-banned → open at `clock_timestamp()`;
 *   non-banned → banned, or delete → close the open row at
 *   `clock_timestamp()`.
 * - backfill: every current non-banned membership opens one row at its
 *   `joined_at` (`source = 'backfill'`). History before this migration is
 *   not reconstructed (leaves before it are unknown).
 *
 * A community's creator (`communities.created_by_user_id`) is treated as a
 * member by the settlement / snapshot queries themselves, not by rows here:
 * most seeded communities have no owner membership row.
 *
 * Both foreign keys cascade: the history follows the user / community it
 * describes. `down` drops the trigger, function, and table.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.community_membership_history (
      history_id uuid primary key default gen_random_uuid(),
      community_id uuid not null
        references public.communities(community_id) on delete cascade,
      user_id uuid not null
        references public.loop_users(id) on delete cascade,
      joined_at timestamptz not null,
      left_at timestamptz,
      source text not null default 'trigger',
      created_at timestamptz not null default clock_timestamp(),
      constraint community_membership_history_interval_check
        check (left_at is null or left_at >= joined_at),
      constraint community_membership_history_source_check
        check (source in ('trigger', 'backfill'))
    );

    comment on table public.community_membership_history is
      'Decision 0183: membership intervals [joined_at, left_at) of community_memberships (non-banned = member), maintained by trigger; read by the hourly mining settlement membership gate.';

    create unique index community_membership_history_open_idx
      on public.community_membership_history (community_id, user_id)
      where left_at is null;
    create index community_membership_history_window_idx
      on public.community_membership_history (community_id, joined_at, left_at);
    create index community_membership_history_user_idx
      on public.community_membership_history (user_id, community_id);

    create function public.loop_community_membership_history()
    returns trigger
    language plpgsql
    as $function$
    declare
      old_member boolean := false;
      new_member boolean := false;
    begin
      if tg_op in ('UPDATE', 'DELETE') then
        old_member := old.status <> 'banned';
      end if;
      if tg_op in ('INSERT', 'UPDATE') then
        new_member := new.status <> 'banned';
      end if;
      if new_member and not old_member then
        insert into public.community_membership_history (
          community_id, user_id, joined_at
        )
        values (
          new.community_id,
          new.owner_user_id,
          case when tg_op = 'INSERT'
            then least(new.joined_at, clock_timestamp())
            else clock_timestamp()
          end
        )
        on conflict (community_id, user_id) where left_at is null do nothing;
      elsif old_member and not new_member then
        update public.community_membership_history
        set left_at = greatest(clock_timestamp(), joined_at)
        where community_id = old.community_id
          and user_id = old.owner_user_id
          and left_at is null;
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end;
    $function$;

    create trigger community_memberships_history
      after insert or update of status or delete on public.community_memberships
      for each row execute function public.loop_community_membership_history();

    insert into public.community_membership_history (
      community_id, user_id, joined_at, source
    )
    select community_id, owner_user_id, joined_at, 'backfill'
    from public.community_memberships
    where status <> 'banned';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger community_memberships_history on public.community_memberships;
    drop function public.loop_community_membership_history();
    drop table public.community_membership_history;
  `);
}
