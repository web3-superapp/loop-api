import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Preserve only the version association evidenced by each surviving row.
 * Older overwritten community weights cannot be reconstructed from current
 * weights or snapshot powers. Those formulas explicitly retain unknown history.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_formula_versions
      add column community_weight_history_status text not null default 'legacy_unknown';
    alter table public.mining_formula_versions
      alter column community_weight_history_status set default 'versioned',
      add constraint mining_formula_weight_history_status_check
        check (community_weight_history_status in ('legacy_unknown', 'versioned'));
    comment on column public.mining_formula_versions.community_weight_history_status is
      'legacy_unknown: pre-migration weights may have been overwritten; missing historical inputs are not recoverable or safe to fabricate. versioned: weights preserved per formula since creation.';

    alter table public.community_mining_weights
      drop constraint community_mining_weights_pkey,
      add column weight_id uuid not null default gen_random_uuid(),
      add column bound_asset_id text,
      add constraint community_mining_weights_pkey primary key (weight_id),
      add constraint community_mining_weights_version_community_unique
        unique (config_version, community_id);
    -- This is only the binding observed at migration, not proof of the
    -- historical binding. Existing formulas remain legacy_unknown.
    update public.community_mining_weights as weight
      set bound_asset_id = community.bound_asset_key
      from public.communities as community
      where community.community_id = weight.community_id;
    comment on column public.community_mining_weights.bound_asset_id is
      'Binding frozen when a weight is reviewed; migrated bindings are current observations only, with legacy_unknown formula provenance.';
    create unique index community_mining_weights_unversioned_community_idx
      on public.community_mining_weights (community_id)
      where config_version is null;
    comment on table public.community_mining_weights is
      'Version-scoped community weights. Published and retired formula inputs are immutable. Unversioned pending review rows are retained separately; legacy missing versions are unknown, never backfilled.';

    create function public.guard_published_mining_weight()
    returns trigger language plpgsql as $function$
    declare formula_status text;
    begin
      -- Lock the formula, the same lock used for edits and publication. A
      -- check without a row lock would allow a write racing publication.
      if TG_OP <> 'INSERT' and OLD.config_version is not null then
        select status into formula_status from public.mining_formula_versions
          where config_version = OLD.config_version for update;
        if formula_status <> 'pending_approval' then
          raise exception 'published mining weights are immutable' using errcode = '55000';
        end if;
      end if;
      if TG_OP <> 'DELETE' and NEW.config_version is not null then
        select status into formula_status from public.mining_formula_versions
          where config_version = NEW.config_version for update;
        if formula_status <> 'pending_approval' then
          raise exception 'published mining weights are immutable' using errcode = '55000';
        end if;
      end if;
      if TG_OP = 'DELETE' then return OLD; end if;
      return NEW;
    end;
    $function$;
    create trigger community_mining_weights_immutable_published
      before insert or update or delete on public.community_mining_weights
      for each row execute function public.guard_published_mining_weight();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (
        select 1 from public.community_mining_weights
        group by community_id having count(*) > 1
      ) then
        raise exception 'refusing rollback that would discard mining weight history'
          using errcode = '55000';
      end if;
    end;
    $guard$;
    drop trigger community_mining_weights_immutable_published on public.community_mining_weights;
    drop function public.guard_published_mining_weight();
    drop index public.community_mining_weights_unversioned_community_idx;
    alter table public.community_mining_weights
      drop constraint community_mining_weights_version_community_unique,
      drop constraint community_mining_weights_pkey,
      drop column weight_id,
      drop column bound_asset_id,
      add constraint community_mining_weights_pkey primary key (community_id);
    alter table public.mining_formula_versions
      drop column community_weight_history_status;
  `);
}
