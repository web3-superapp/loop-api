import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.ops_audit
      alter column actor_id drop not null,
      add column actor_kind text not null default 'user',
      add column source text not null default 'ops_api',
      add column before_state jsonb,
      add column after_state jsonb;

    -- Earlier CLI records incorrectly identified the target as the actor.
    -- Their historical grant states cannot be reconstructed and stay unknown.
    update public.ops_audit set actor_id=null, actor_kind='deployment_admin', source='deployment_cli'
      where action='operator.bootstrap';

    alter table public.ops_audit add constraint ops_audit_actor_shape check (
      (actor_kind='user' and source='ops_api' and actor_id is not null and action <> 'operator.bootstrap')
      or (actor_kind='deployment_admin' and source='deployment_cli' and actor_id is null
        and action='operator.bootstrap'
        and target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
    );
    alter table public.ops_audit add constraint ops_audit_change_shape check (
      (before_state is null and after_state is null)
      or (source='deployment_cli' and before_state is not null and after_state is not null
        and jsonb_typeof(before_state)='object' and jsonb_typeof(after_state)='object'
        and before_state ?& array['enabled','grants'] and after_state ?& array['enabled','grants']
        and before_state - 'enabled' - 'grants' = '{}'::jsonb
        and after_state - 'enabled' - 'grants' = '{}'::jsonb
        and jsonb_typeof(before_state->'enabled') in ('boolean','null')
        and jsonb_typeof(after_state->'enabled') in ('boolean','null')
        and jsonb_typeof(before_state->'grants')='array'
        and jsonb_typeof(after_state->'grants')='array')
    );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from public.ops_audit where actor_kind <> 'user') then
        raise exception 'Cannot downgrade deployment CLI audit without losing actor provenance';
      end if;
    end $$;
    alter table public.ops_audit
      drop constraint ops_audit_change_shape,
      drop constraint ops_audit_actor_shape,
      drop column after_state,
      drop column before_state,
      drop column source,
      drop column actor_kind,
      alter column actor_id set not null;
  `);
}
