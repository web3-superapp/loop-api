import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0132 (S170): a Hooks launch config saved for a LoopDynamic
 * Factory carries `poolHookKind: "loopDynamic"` next to the eleven
 * Decision 0108 keys (its `fixedEconomics` already holds the Hook
 * parameters; that object is not constrained here). The config-object
 * check admits that one optional key with that one value; an OfficialTax
 * config is unchanged. Versions stay append-only.
 */

const required = `array[
          'templateVersion','templateHash','name','ticker','logoAssetUrl',
          'description','links','nftSaleStartAt','buybackRecipient',
          'fixedEconomics','configHash'
        ]`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.hooks_launch_project_config_versions
      drop constraint hooks_launch_config_object;
    alter table public.hooks_launch_project_config_versions
      add constraint hooks_launch_config_object check (
        jsonb_typeof(config) = 'object'
        and config ?& ${required}
        and config - (${required} || array['poolHookKind'])::text[] = '{}'::jsonb
        and (not config ? 'poolHookKind'
          or config->>'poolHookKind' = 'loopDynamic')
        and config->>'templateVersion' = template_version
        and config->>'configHash' = config_hash
      );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.hooks_launch_project_config_versions
        where config ? 'poolHookKind')
      then raise exception 'refusing to remove LoopDynamic Hooks launch configs'; end if;
    end $$;
    alter table public.hooks_launch_project_config_versions
      drop constraint hooks_launch_config_object;
    alter table public.hooks_launch_project_config_versions
      add constraint hooks_launch_config_object check (
        jsonb_typeof(config) = 'object'
        and config ?& ${required}
        and config - ${required}::text[] = '{}'::jsonb
        and config->>'templateVersion' = template_version
        and config->>'configHash' = config_hash
      );
  `);
}
