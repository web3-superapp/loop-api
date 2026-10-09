import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.hooks_launch_project_config_versions (
      project_id uuid not null references public.launch_projects(project_id) on delete restrict,
      config_version integer not null,
      owner_user_id uuid not null references public.loop_users(id) on delete restrict,
      template_version text not null,
      config_hash text not null,
      config jsonb not null,
      created_at timestamptz not null default clock_timestamp(),
      primary key (project_id, config_version),
      constraint hooks_launch_config_version_positive check (config_version > 0),
      constraint hooks_launch_template_fixed check (template_version = 'hooks_launch_v1'),
      constraint hooks_launch_config_hash_check check (config_hash ~ '^0x[0-9a-f]{64}$'),
      constraint hooks_launch_config_object check (
        jsonb_typeof(config) = 'object'
        and config ?& array[
          'templateVersion','templateHash','name','ticker','logoAssetUrl',
          'description','links','nftSaleStartAt','buybackRecipient',
          'fixedEconomics','configHash'
        ]
        and config - array[
          'templateVersion','templateHash','name','ticker','logoAssetUrl',
          'description','links','nftSaleStartAt','buybackRecipient',
          'fixedEconomics','configHash'
        ]::text[] = '{}'::jsonb
        and config->>'templateVersion' = template_version
        and config->>'configHash' = config_hash
      )
    );
    create index hooks_launch_config_owner_idx
      on public.hooks_launch_project_config_versions (owner_user_id, project_id, config_version desc);
    create function public.reject_hooks_launch_config_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'Hooks launch config versions are append-only';
    end;
    $$;
    create trigger hooks_launch_config_versions_immutable
      before update or delete on public.hooks_launch_project_config_versions
      for each row execute function public.reject_hooks_launch_config_mutation();
    comment on table public.hooks_launch_project_config_versions is
      'Append-only owner-authenticated Hooks launch configuration drafts. This relation records off-chain settings only and does not publish or activate a contract.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger hooks_launch_config_versions_immutable
      on public.hooks_launch_project_config_versions;
    drop function public.reject_hooks_launch_config_mutation();
    drop table public.hooks_launch_project_config_versions;
  `);
}
