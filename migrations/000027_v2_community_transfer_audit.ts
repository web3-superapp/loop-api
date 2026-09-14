import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0042: an ownership transfer audits both of its role changes.
 *
 * Decision 0031 rules both that `community_role_events` carries "one row per
 * ... role change" and that `idempotency_record_id` is unique. Transferring
 * ownership is the one command that changes two roles — the successor rises
 * to `owner` and the previous owner falls to `admin` — so the two rules
 * collided and the table could only ever record half of the only
 * irreversible governance action.
 *
 * The uniqueness therefore moves from `(idempotency_record_id)` to
 * `(idempotency_record_id, target_user_id)`. Every command path writes a
 * non-null `target_user_id`, so a replayed command still cannot append a
 * second row about the same subject; only the operator verification path
 * writes `(null, null)`, and it claims no idempotency record at all. No
 * column is added, no row is rewritten, and the append-only trigger stays in
 * force, so historical rows keep their shape.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.community_role_events
      drop constraint community_role_events_idempotency_unique;

    alter table public.community_role_events
      add constraint community_role_events_idempotency_unique
      unique (idempotency_record_id, target_user_id);

    comment on constraint community_role_events_idempotency_unique
      on public.community_role_events is
      'Decision 0042: one audit row per command per subject. An ownership transfer appends two rows under one idempotency record (the previous owner losing owner, the successor gaining it), and a replay still appends none.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1
        from public.community_role_events
        where idempotency_record_id is not null
        group by idempotency_record_id
        having count(*) > 1
      ) then
        raise exception
          'refusing to narrow the community audit uniqueness while a command holds more than one audit row';
      end if;
    end
    $$;

    alter table public.community_role_events
      drop constraint community_role_events_idempotency_unique;

    alter table public.community_role_events
      add constraint community_role_events_idempotency_unique
      unique (idempotency_record_id);
  `);
}
