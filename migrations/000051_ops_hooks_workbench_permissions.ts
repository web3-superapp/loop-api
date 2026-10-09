import type { MigrationBuilder } from "node-pg-migrate";

/** Decision 0094: grant Hooks administration to individual Development ops. */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.ops_grants
      drop constraint ops_grants_permission_check;
    alter table public.ops_grants
      add constraint ops_grants_permission_check check (permission in (
        'audit.read','mining.read','mining.edit','mining.approve',
        'mining.snapshot','community.review','support.manage',
        'launch.read','launch.edit','launch.approve',
        'testnet.read','testnet.accept'
      ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (
        select 1 from public.ops_grants
        where permission in (
          'launch.read','launch.edit','launch.approve',
          'testnet.read','testnet.accept'
        )
      ) then
        raise exception 'refusing to remove active Hooks workbench grants'
          using errcode = '55000';
      end if;
    end;
    $guard$;
    alter table public.ops_grants
      drop constraint ops_grants_permission_check;
    alter table public.ops_grants
      add constraint ops_grants_permission_check check (permission in (
        'audit.read','mining.read','mining.edit','mining.approve',
        'mining.snapshot','community.review','support.manage'
      ));
  `);
}
