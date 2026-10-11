import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0127 (S151): one project owner, many Hooks launch projects.
 *
 * `LoopLaunchFactory.deployLaunch` rejects a second deployment with the same
 * `keccak(projectOwner, configVersion)` (`VersionAlreadyUsed`). Config
 * versions used to start at 1 per project, so an owner's second project
 * collided with the first (BSC Testnet round five,
 * `HOOKS_LAUNCH_ALREADY_DEPLOYED`). New versions are now allocated per
 * owner across all projects (`allocateHooksLaunchConfigVersion`); this
 * table is the monotonic counter whose row lock serialises the allocation.
 *
 * Backfill: each owner's counter starts at the highest version any of the
 * owner's projects already used, so the next save of any project is above
 * every historical version. No existing config, approval, task or instance
 * row is touched; deployed instances keep their versions.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.hooks_launch_owner_config_versions (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      last_config_version integer not null
        constraint hooks_launch_owner_config_versions_positive
          check (last_config_version > 0),
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );

    insert into public.hooks_launch_owner_config_versions (
      owner_user_id, last_config_version
    )
    select owner_user_id, max(config_version)
    from public.hooks_launch_project_config_versions
    group by owner_user_id;

    create function public.guard_hooks_launch_owner_config_version()
    returns trigger language plpgsql as $$
    begin
      if NEW.owner_user_id is distinct from OLD.owner_user_id
        or NEW.last_config_version <= OLD.last_config_version then
        raise exception 'Hooks launch owner config versions only increase';
      end if;
      return NEW;
    end;
    $$;
    create trigger hooks_launch_owner_config_versions_monotonic
      before update on public.hooks_launch_owner_config_versions
      for each row execute function public.guard_hooks_launch_owner_config_version();

    comment on table public.hooks_launch_owner_config_versions is
      'Decision 0127: per project-owner monotonic Hooks config version counter (the Factory dedupes keccak(projectOwner, configVersion) across projects).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger hooks_launch_owner_config_versions_monotonic
      on public.hooks_launch_owner_config_versions;
    drop function public.guard_hooks_launch_owner_config_version();
    drop table public.hooks_launch_owner_config_versions;
  `);
}
