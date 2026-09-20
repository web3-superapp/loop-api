import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0055 review follow-up.
 *
 * - `projection_lease`: the fence for projection bookkeeping. `ensurePersona`
 *   and `claimPendingProjections` each issue a fresh lease; `confirm` and
 *   `reset` write only while the row is still `pending` and still carries
 *   that lease, so a stale worker (or the add path racing the persona lane)
 *   never overwrites a newer outcome.
 * - A statement-level `before truncate` guard: personas are permanent, so a
 *   `truncate` (direct or cascaded from `loop_users`/`communities`) is
 *   refused while any row exists unless the operator sets
 *   `loop.allow_persona_truncate = 'on'` on the session. An empty table may
 *   still be truncated, which keeps test fixtures that reset an empty schema
 *   working without weakening the guard on real data.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.community_channel_personas
      add column projection_lease uuid;

    comment on column public.community_channel_personas.projection_lease is
      'Fence for confirm/reset: issued by ensurePersona and claimPendingProjections; cleared by reset.';

    create function public.guard_community_channel_persona_truncate()
    returns trigger
    language plpgsql
    as $function$
    begin
      if coalesce(current_setting('loop.allow_persona_truncate', true), '') = 'on'
      then
        return null;
      end if;
      if exists (select 1 from public.community_channel_personas) then
        raise exception
          'community_channel_personas cannot be truncated while personas exist'
          using errcode = '55000';
      end if;
      return null;
    end;
    $function$;

    create trigger community_channel_personas_truncate_guard
      before truncate on public.community_channel_personas
      for each statement
      execute function public.guard_community_channel_persona_truncate();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger community_channel_personas_truncate_guard
      on public.community_channel_personas;
    drop function public.guard_community_channel_persona_truncate();
    alter table public.community_channel_personas
      drop column projection_lease;
  `);
}
