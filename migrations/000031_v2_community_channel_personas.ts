import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0055: one server-generated, immutable persona per
 * (community, account) for the official community channel. LOOP PostgreSQL
 * is the authority; `projection_state` only records whether Stream echoed the
 * exact member custom data. A persona is never deleted, recycled, or renamed:
 * leaving, being banned, and rejoining all resume the same name.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.community_channel_personas (
      persona_id uuid primary key default gen_random_uuid(),
      community_id uuid not null
        references public.communities(community_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      alias text not null,
      alias_version integer not null default 1,
      projection_state text not null default 'pending',
      confirmed_at timestamptz,
      projection_attempts integer not null default 0,
      next_projection_at timestamptz not null default clock_timestamp(),
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint community_channel_personas_owner_unique
        unique (community_id, owner_user_id),
      constraint community_channel_personas_alias_unique
        unique (community_id, alias),
      constraint community_channel_personas_alias_check
        check (alias ~ '^[A-Z][a-z]{2,15}-[0-9]{4}$'),
      constraint community_channel_personas_alias_version_check
        check (alias_version = 1),
      constraint community_channel_personas_projection_state_check
        check (projection_state in ('pending', 'confirmed')),
      constraint community_channel_personas_projection_pairing_check
        check (
          (projection_state = 'pending' and confirmed_at is null)
          or (projection_state = 'confirmed' and confirmed_at is not null)
        ),
      constraint community_channel_personas_attempts_check
        check (projection_attempts >= 0),
      constraint community_channel_personas_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.community_channel_personas is
      'Decision 0055: server-generated immutable per-community chat personas. The alias never encodes an identifier; projection_state records only the bounded Stream member-custom projection.';

    create index community_channel_personas_pending_idx
      on public.community_channel_personas (next_projection_at, persona_id)
      where projection_state = 'pending';

    create function public.guard_community_channel_persona_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'INSERT' then
        if new.projection_state <> 'pending'
          or new.confirmed_at is not null
        then
          raise exception 'community persona projection must start pending'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if tg_op = 'DELETE' then
        raise exception 'community_channel_personas cannot be deleted'
          using errcode = '55000';
      end if;

      if new.persona_id is distinct from old.persona_id
        or new.community_id is distinct from old.community_id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.alias is distinct from old.alias
        or new.alias_version is distinct from old.alias_version
        or new.created_at is distinct from old.created_at
      then
        raise exception 'community persona identity is immutable'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    create trigger community_channel_personas_guard
      before insert or update or delete on public.community_channel_personas
      for each row execute function public.guard_community_channel_persona_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (select 1 from public.community_channel_personas) then
        raise exception
          'refusing destructive rollback of community channel personas'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger community_channel_personas_guard
      on public.community_channel_personas;
    drop function public.guard_community_channel_persona_mutation();
    drop table public.community_channel_personas;
  `);
}
