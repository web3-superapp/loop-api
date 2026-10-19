import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0163 (S245-api): an operator can take a MEME v2 instance off the
 * App lists without touching its chain facts.
 *
 * - `listing`: `visible | hidden`, default `visible` — every existing row
 *   stays visible, nothing else changes.
 * - `listing_reason`: the operator's note (1-280 characters), required
 *   while hidden; kept (not cleared) when restored so the last reason
 *   stays readable next to the audit row.
 * - `listing_updated_at` / `listing_updated_by`: the last change and the
 *   console actor that made it (null while never changed).
 *
 * The indexer never writes these columns (`registerActivatedInstances`
 * inserts with `on conflict do nothing`; every projection update names its
 * own columns), so a re-projection keeps the operator's choice.
 *
 * Number 000092 is taken by S238 on another branch; this migration has no
 * dependency on it. `down` refuses while a hidden row exists.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_instances
      add column listing text not null default 'visible',
      add column listing_reason text,
      add column listing_updated_at timestamptz,
      add column listing_updated_by text,
      add constraint launch2_instances_listing_check
        check (listing in ('visible', 'hidden')),
      add constraint launch2_instances_listing_reason_check
        check (listing_reason is null
          or char_length(listing_reason) between 1 and 280),
      add constraint launch2_instances_listing_updated_by_check
        check (listing_updated_by is null
          or char_length(listing_updated_by) between 1 and 128),
      add constraint launch2_instances_listing_hidden_check
        check (listing = 'visible' or (listing_reason is not null
          and listing_updated_at is not null
          and listing_updated_by is not null));

    comment on column public.launch2_instances.listing is
      'Decision 0163: visible | hidden. hidden drops the instance from the App lists (instances, overview, public MEME list, Square event posts); the detail by id stays readable. Operator-owned: the indexer never writes it.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.launch2_instances where listing <> 'visible')
      then
        raise exception 'hidden launch2 instances exist; refusing to roll back 000093';
      end if;
    end
    $$;

    alter table public.launch2_instances
      drop constraint launch2_instances_listing_hidden_check,
      drop constraint launch2_instances_listing_updated_by_check,
      drop constraint launch2_instances_listing_reason_check,
      drop constraint launch2_instances_listing_check,
      drop column listing_updated_by,
      drop column listing_updated_at,
      drop column listing_reason,
      drop column listing;
  `);
}
