import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1',
        'price_alert_create_v1',
        'spot_intent_request_v1',
        'spot_agent_authorization_issue_v1',
        'social_command_v1',
        'chat_channel_command_v1',
        'community_command_v1',
        'social_graph_command_v1'
      ));

    create table public.communities (
      community_id uuid primary key default gen_random_uuid(),
      name text not null,
      name_search_key text generated always as (
        public.loop_alias_search_key_unicode17_v1(name)
      ) stored,
      slug text not null,
      description text,
      logo_ref text,
      verification_status text not null default 'pending',
      bound_asset_key text,
      member_count integer not null default 0,
      config_version text not null default 'communityV1',
      created_by_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      verified_at timestamptz,
      record_version integer not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint communities_slug_unique unique (slug),
      constraint communities_name_check
        check (
          char_length(name) between 1 and 40
          and name = btrim(name)
          and public.loop_alias_text_is_safe(name)
        ),
      constraint communities_slug_check
        check (slug ~ '^[a-z0-9-]{3,32}$'),
      constraint communities_description_check
        check (
          description is null
          or (
            char_length(description) between 1 and 280
            and description = btrim(description)
            and public.loop_alias_text_is_safe(description)
          )
        ),
      constraint communities_logo_ref_check
        check (
          logo_ref is null
          or logo_ref ~ '^avatar:preset/community-(0[1-9]|1[0-2])$'
        ),
      constraint communities_verification_status_check
        check (verification_status in ('pending', 'verified', 'rejected')),
      constraint communities_verification_pairing_check
        check (
          (verification_status = 'verified' and verified_at is not null)
          or (verification_status <> 'verified' and verified_at is null)
        ),
      constraint communities_bound_asset_key_check
        check (
          bound_asset_key is null
          or bound_asset_key ~ '^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$'
        ),
      constraint communities_member_count_check check (member_count >= 0),
      constraint communities_config_version_check
        check (config_version = 'communityV1'),
      constraint communities_record_version_check check (record_version > 0),
      constraint communities_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.communities is
      'LOOP community record (Decision 0031). PostgreSQL is the truth for community identity, verification, and the server-maintained member_count. bound_asset_key is stored but not resolved before D10.';

    create index communities_verified_members_idx
      on public.communities (member_count desc, community_id asc)
      where verification_status = 'verified';
    create index communities_verified_newest_idx
      on public.communities (created_at desc, community_id desc)
      where verification_status = 'verified';
    create index communities_name_search_prefix_idx
      on public.communities (name_search_key collate "C", community_id);
    create index communities_slug_search_prefix_idx
      on public.communities (slug collate "C", community_id);

    create table public.community_memberships (
      membership_id uuid primary key default gen_random_uuid(),
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      role text not null default 'member',
      status text not null default 'active',
      joined_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      record_version integer not null default 1,
      constraint community_memberships_community_owner_unique
        unique (community_id, owner_user_id),
      constraint community_memberships_role_check
        check (role in ('owner', 'admin', 'member')),
      constraint community_memberships_status_check
        check (status in ('active', 'muted', 'banned')),
      constraint community_memberships_owner_active_check
        check (role <> 'owner' or status = 'active'),
      constraint community_memberships_record_version_check
        check (record_version > 0),
      constraint community_memberships_timestamp_check
        check (updated_at >= joined_at)
    );

    comment on table public.community_memberships is
      'One row per (community, account). role is owner|admin|member; status is active|muted|banned. A banned row is retained so the account cannot rejoin until unbanned.';

    create unique index community_memberships_one_owner_idx
      on public.community_memberships (community_id)
      where role = 'owner';
    create index community_memberships_listing_idx
      on public.community_memberships (
        community_id,
        role,
        joined_at asc,
        membership_id asc
      )
      where status <> 'banned';
    create index community_memberships_owner_joined_idx
      on public.community_memberships (owner_user_id, joined_at desc)
      where status <> 'banned';

    create function public.loop_community_membership_counts()
    returns trigger
    language plpgsql
    as $function$
    declare
      old_counted boolean := false;
      new_counted boolean := false;
    begin
      if tg_op in ('UPDATE', 'DELETE') then
        old_counted := old.status <> 'banned';
      end if;
      if tg_op in ('INSERT', 'UPDATE') then
        new_counted := new.status <> 'banned';
      end if;
      if tg_op = 'UPDATE' and new.community_id is distinct from old.community_id then
        raise exception 'community membership cannot move between communities'
          using errcode = '55000';
      end if;
      if new_counted and not old_counted then
        update public.communities
        set
          member_count = member_count + 1,
          updated_at = greatest(clock_timestamp(), updated_at)
        where community_id = coalesce(new.community_id, old.community_id);
      elsif old_counted and not new_counted then
        update public.communities
        set
          member_count = member_count - 1,
          updated_at = greatest(clock_timestamp(), updated_at)
        where community_id = coalesce(new.community_id, old.community_id);
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end;
    $function$;

    create trigger community_memberships_member_count
      after insert or update of status or delete on public.community_memberships
      for each row execute function public.loop_community_membership_counts();

    create table public.community_role_events (
      event_id uuid primary key default gen_random_uuid(),
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      actor_user_id uuid
        references public.loop_users(id) on delete restrict,
      actor_type text not null default 'member',
      target_user_id uuid
        references public.loop_users(id) on delete restrict,
      event_type text not null,
      from_role text,
      to_role text,
      from_status text,
      to_status text,
      reason_code text,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      request_id uuid,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint community_role_events_idempotency_unique
        unique (idempotency_record_id),
      constraint community_role_events_actor_type_check
        check (actor_type in ('member', 'operator')),
      constraint community_role_events_actor_pairing_check
        check (
          (actor_type = 'member' and actor_user_id is not null)
          or (actor_type = 'operator' and actor_user_id is null)
        ),
      constraint community_role_events_type_check
        check (event_type in (
          'community_created',
          'community_profile_updated',
          'community_verified',
          'community_rejected',
          'member_joined',
          'member_left',
          'role_changed',
          'member_muted',
          'member_unmuted',
          'member_banned',
          'member_unbanned'
        )),
      constraint community_role_events_role_check
        check (
          (from_role is null or from_role in ('owner', 'admin', 'member'))
          and (to_role is null or to_role in ('owner', 'admin', 'member'))
        ),
      constraint community_role_events_status_check
        check (
          (from_status is null or from_status in ('active', 'muted', 'banned'))
          and (to_status is null or to_status in ('active', 'muted', 'banned'))
        ),
      constraint community_role_events_reason_check
        check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    comment on table public.community_role_events is
      'Append-only community audit (Decision 0031). Every membership, role, mute, ban, creation, and verification change writes one row; role_changed carries the RoleChanged semantics.';

    create index community_role_events_community_idx
      on public.community_role_events (community_id, occurred_at desc, event_id);

    create function public.reject_community_audit_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'community_role_events are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger community_role_events_append_only
      before update or delete on public.community_role_events
      for each row execute function public.reject_community_audit_mutation();

    create table public.follow_edges (
      follower_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      followee_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      created_at timestamptz not null default clock_timestamp(),
      primary key (follower_user_id, followee_user_id),
      constraint follow_edges_no_self_follow_check
        check (follower_user_id <> followee_user_id)
    );

    comment on table public.follow_edges is
      'Directed follow graph (Decision 0031). No consent is required; a block removes both directions.';

    create index follow_edges_followee_idx
      on public.follow_edges (followee_user_id, created_at desc, follower_user_id desc);
    create index follow_edges_follower_idx
      on public.follow_edges (follower_user_id, created_at desc, followee_user_id desc);

    create table public.user_blocks (
      block_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      kind text not null,
      stable_id text not null,
      target_user_id uuid
        references public.loop_users(id) on delete restrict,
      reason_code text not null default 'user_request',
      created_at timestamptz not null default clock_timestamp(),
      constraint user_blocks_owner_kind_stable_unique
        unique (owner_user_id, kind, stable_id),
      constraint user_blocks_kind_check
        check (kind in ('user', 'contract', 'domain')),
      constraint user_blocks_stable_id_check
        check (char_length(stable_id) between 1 and 256),
      constraint user_blocks_target_pairing_check
        check (
          (kind = 'user' and target_user_id is not null)
          or (kind <> 'user' and target_user_id is null)
        ),
      constraint user_blocks_no_self_block_check
        check (target_user_id is null or target_user_id <> owner_user_id),
      constraint user_blocks_reason_check
        check (reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    comment on table public.user_blocks is
      'Owner-scoped block list (Decision 0031). Only kind=user is writable in this step; contract and domain blocks remain unavailable. stable_id for a user is the target public_profile_id.';

    create unique index user_blocks_owner_target_user_idx
      on public.user_blocks (owner_user_id, target_user_id)
      where kind = 'user';
    create index user_blocks_target_user_idx
      on public.user_blocks (target_user_id)
      where kind = 'user';

    create table public.social_graph_events (
      event_id uuid primary key default gen_random_uuid(),
      actor_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      event_type text not null,
      target_user_id uuid
        references public.loop_users(id) on delete restrict,
      subject_id uuid,
      result_status text,
      reason_code text,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      request_id uuid,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint social_graph_events_idempotency_unique
        unique (idempotency_record_id),
      constraint social_graph_events_type_check
        check (event_type in (
          'followed',
          'unfollowed',
          'blocked',
          'unblocked',
          'message_request_accepted',
          'message_request_ignored',
          'message_request_reported'
        )),
      constraint social_graph_events_result_check
        check (
          result_status is null
          or result_status ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint social_graph_events_reason_check
        check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    comment on table public.social_graph_events is
      'Append-only follow/block/message-request audit (Decision 0031). idempotency_record_id binds each durable command replay to its first result.';

    create index social_graph_events_actor_idx
      on public.social_graph_events (actor_user_id, occurred_at desc, event_id);

    create trigger social_graph_events_append_only
      before update or delete on public.social_graph_events
      for each row execute function public.reject_community_audit_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.social_graph_events,
      public.user_blocks,
      public.follow_edges,
      public.community_role_events,
      public.community_memberships,
      public.communities,
      public.idempotency_records
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.social_graph_events)
        or exists (select 1 from public.user_blocks)
        or exists (select 1 from public.follow_edges)
        or exists (select 1 from public.community_role_events)
        or exists (select 1 from public.community_memberships)
        or exists (select 1 from public.communities)
        or exists (
          select 1 from public.idempotency_records
          where digest_version in (
            'community_command_v1',
            'social_graph_command_v1'
          )
        )
      then
        raise exception
          'refusing destructive rollback of v2 community and social graph data'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger social_graph_events_append_only on public.social_graph_events;
    drop table public.social_graph_events;
    drop index public.user_blocks_target_user_idx;
    drop index public.user_blocks_owner_target_user_idx;
    drop table public.user_blocks;
    drop table public.follow_edges;
    drop trigger community_role_events_append_only
      on public.community_role_events;
    drop function public.reject_community_audit_mutation();
    drop table public.community_role_events;
    drop trigger community_memberships_member_count
      on public.community_memberships;
    drop function public.loop_community_membership_counts();
    drop table public.community_memberships;
    drop table public.communities;

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1',
        'price_alert_create_v1',
        'spot_intent_request_v1',
        'spot_agent_authorization_issue_v1',
        'social_command_v1',
        'chat_channel_command_v1'
      ));
  `);
}
