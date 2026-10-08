import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0095 (S107): social identity.
 *
 * 1. `media_objects`: uploaded avatars and community logos, re-encoded to a
 *    512 x 512 WebP. Immutable rows; `media_id` is the only public key.
 * 2. `communities.logo_ref` additionally accepts `logo:media/{uuid}`.
 * 3. `privacy_preferences_v2`: `total_assets_visibility` and
 *    `trade_history_visibility` default to `everyone`, and every stored
 *    `self` of those two columns becomes `everyone` (docs/09 B11).
 * 4. `friendships` may be deleted (the friend-removal decision migration
 *    000013 waited for); updates stay refused.
 * 5. `social_graph_events` gains the `friendship_removed` event type.
 * 6. Two partial indexes let the public trades read find a wallet's swaps
 *    by `payload.recipient` / `payload.sender` without a table scan.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.media_objects (
      media_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      kind text not null,
      content_type text not null,
      bytes bytea not null,
      width integer not null,
      height integer not null,
      sha256 text not null,
      idempotency_key uuid not null,
      request_sha256 text not null,
      created_at timestamptz not null default clock_timestamp(),
      constraint media_objects_owner_idempotency_unique
        unique (owner_user_id, idempotency_key),
      constraint media_objects_kind_check
        check (kind in ('avatar', 'community_logo')),
      constraint media_objects_content_type_check
        check (content_type = 'image/webp'),
      constraint media_objects_bytes_check
        check (octet_length(bytes) between 1 and 1048576),
      constraint media_objects_dimensions_check
        check (width between 1 and 4096 and height between 1 and 4096),
      constraint media_objects_sha256_check
        check (sha256 ~ '^[0-9a-f]{64}$'),
      constraint media_objects_request_sha256_check
        check (request_sha256 ~ '^[0-9a-f]{64}$')
    );

    comment on table public.media_objects is
      'Decision 0095: uploaded avatars and community logos, re-encoded server-side to 512x512 WebP. Immutable; media_id is the only public identifier and owner_user_id never leaves the API.';

    create index media_objects_owner_created_idx
      on public.media_objects (owner_user_id, created_at desc);

    create function public.reject_media_object_update()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'media_objects are immutable' using errcode = '55000';
    end;
    $function$;

    create trigger media_objects_immutable
      before update on public.media_objects
      for each row execute function public.reject_media_object_update();

    alter table public.communities
      drop constraint communities_logo_ref_check;
    alter table public.communities
      add constraint communities_logo_ref_check
      check (
        logo_ref is null
        or logo_ref ~ '^avatar:preset/community-(0[1-9]|1[0-2])$'
        or logo_ref ~ '^logo:media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      );

    alter table public.privacy_preferences_v2
      alter column total_assets_visibility set default 'everyone',
      alter column trade_history_visibility set default 'everyone';

    update public.privacy_preferences_v2
    set
      total_assets_visibility = 'everyone',
      trade_history_visibility = 'everyone',
      record_version = record_version + 1,
      updated_at = greatest(clock_timestamp(), updated_at)
    where total_assets_visibility = 'self'
      or trade_history_visibility = 'self';

    drop trigger friendships_immutable on public.friendships;

    create function public.reject_friendship_update()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'friendships cannot be updated; delete removes a friendship'
        using errcode = '55000';
    end;
    $function$;

    create trigger friendships_no_update
      before update on public.friendships
      for each row execute function public.reject_friendship_update();

    alter table public.social_graph_events
      drop constraint social_graph_events_type_check;
    alter table public.social_graph_events
      add constraint social_graph_events_type_check
      check (event_type in (
        'followed',
        'unfollowed',
        'blocked',
        'unblocked',
        'message_request_sent',
        'message_request_accepted',
        'message_request_ignored',
        'message_request_reported',
        'friendship_removed'
      ));

    create index indexed_pool_events_swap_recipient_idx
      on public.indexed_pool_events (
        chain_id, (payload ->> 'recipient'), block_number desc, log_index desc
      )
      where event_kind = 'swap';
    create index indexed_pool_events_swap_sender_idx
      on public.indexed_pool_events (
        chain_id, (payload ->> 'sender'), block_number desc, log_index desc
      )
      where event_kind = 'swap';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table public.social_graph_events in access exclusive mode;
    lock table public.communities in access exclusive mode;

    do $guard$
    begin
      if exists (
        select 1 from public.social_graph_events
        where event_type = 'friendship_removed'
      )
      then
        raise exception
          'refusing rollback while friendship removals are recorded'
          using errcode = '55000';
      end if;
      if exists (
        select 1 from public.communities where logo_ref like 'logo:media/%'
      )
      then
        raise exception
          'refusing rollback while communities use uploaded logos'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop index public.indexed_pool_events_swap_sender_idx;
    drop index public.indexed_pool_events_swap_recipient_idx;

    alter table public.social_graph_events
      drop constraint social_graph_events_type_check;
    alter table public.social_graph_events
      add constraint social_graph_events_type_check
      check (event_type in (
        'followed',
        'unfollowed',
        'blocked',
        'unblocked',
        'message_request_sent',
        'message_request_accepted',
        'message_request_ignored',
        'message_request_reported'
      ));

    drop trigger friendships_no_update on public.friendships;
    drop function public.reject_friendship_update();
    create trigger friendships_immutable
      before update or delete on public.friendships
      for each row execute function public.reject_friendship_mutation();

    alter table public.privacy_preferences_v2
      alter column total_assets_visibility set default 'self',
      alter column trade_history_visibility set default 'self';

    alter table public.communities
      drop constraint communities_logo_ref_check;
    alter table public.communities
      add constraint communities_logo_ref_check
      check (
        logo_ref is null
        or logo_ref ~ '^avatar:preset/community-(0[1-9]|1[0-2])$'
      );

    drop table public.media_objects;
    drop function public.reject_media_object_update();
  `);
}
