import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0108 (ported from requirer branch
 * `codex/integrated-dual-pool-20261008`; the subset of original migrations
 * 000047 `ops_control_plane`, 000049 `ops_bootstrap_audit`, and 000051
 * `ops_hooks_workbench_permissions` that the Hooks review flow needs).
 *
 * - `ops_operators`: individual platform operators, each a LOOP user
 *   (Privy-verified principal). `enabled=false` revokes every grant.
 * - `ops_grants`: scoped permissions (`*` or one launch project ID). Editor,
 *   approver, and acceptor are separate permissions; the service also
 *   refuses self-approval.
 * - `ops_operations`: operator command idempotency (operationId bound to
 *   actor + canonical request hash).
 * - `ops_audit`: append-only operator audit, including deployment-CLI
 *   bootstrap provenance.
 *
 * Not ported: `ops_mining_drafts` and `ops_jobs` (requirer ops mining
 * workbench), and the mining.* / community.review / support.manage
 * permissions. A later reviewed migration may extend the permission list.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.ops_operators (
      user_id uuid primary key references public.loop_users(id) on delete restrict,
      label text not null check (length(label) between 1 and 80),
      enabled boolean not null default false,
      updated_at timestamptz not null default clock_timestamp()
    );

    create table public.ops_grants (
      user_id uuid not null references public.ops_operators(user_id) on delete restrict,
      permission text not null,
      scope text not null default '*' check (length(scope) between 1 and 128),
      primary key (user_id, permission, scope),
      constraint ops_grants_permission_check check (permission in (
        'audit.read',
        'launch.read','launch.edit','launch.approve',
        'testnet.read','testnet.accept'
      ))
    );

    create table public.ops_operations (
      operation_id uuid primary key,
      actor_id uuid not null references public.ops_operators(user_id) on delete restrict,
      action text not null,
      target text not null,
      request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
      result jsonb not null,
      created_at timestamptz not null default clock_timestamp()
    );

    create table public.ops_audit (
      id bigint generated always as identity primary key,
      operation_id uuid not null,
      actor_id uuid references public.loop_users(id) on delete restrict,
      actor_kind text not null default 'user',
      source text not null default 'ops_api',
      action text not null,
      target text not null,
      reason text not null,
      outcome text not null check (outcome in ('succeeded','rejected','unknown')),
      code text,
      before_state jsonb,
      after_state jsonb,
      created_at timestamptz not null default clock_timestamp(),
      constraint ops_audit_actor_shape check (
        (actor_kind = 'user' and source = 'ops_api' and actor_id is not null
          and action <> 'operator.bootstrap')
        or (actor_kind = 'deployment_admin' and source = 'deployment_cli'
          and actor_id is null and action = 'operator.bootstrap'
          and target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
      ),
      constraint ops_audit_change_shape check (
        (before_state is null and after_state is null)
        or (source = 'deployment_cli' and before_state is not null and after_state is not null
          and jsonb_typeof(before_state) = 'object' and jsonb_typeof(after_state) = 'object'
          and before_state ?& array['enabled','grants'] and after_state ?& array['enabled','grants']
          and before_state - 'enabled' - 'grants' = '{}'::jsonb
          and after_state - 'enabled' - 'grants' = '{}'::jsonb
          and jsonb_typeof(before_state->'enabled') in ('boolean','null')
          and jsonb_typeof(after_state->'enabled') in ('boolean','null')
          and jsonb_typeof(before_state->'grants') = 'array'
          and jsonb_typeof(after_state->'grants') = 'array')
      )
    );
    create index ops_audit_cursor on public.ops_audit (id desc);

    create function public.ops_audit_append_only()
      returns trigger
      language plpgsql
    as $$
    begin
      raise exception 'ops_audit is append-only';
    end
    $$;
    create trigger ops_audit_no_update_delete
      before update or delete on public.ops_audit
      for each row execute function public.ops_audit_append_only();

    comment on table public.ops_operators is
      'Decision 0108: individual platform operators (LOOP users). No shared login; enabled=false revokes access.';
    comment on table public.ops_audit is
      'Decision 0108: append-only operator audit. deployment_cli rows carry sanitized before/after grant state.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (select 1 from public.ops_audit)
        or exists (select 1 from public.ops_operations)
        or exists (select 1 from public.ops_grants)
        or exists (select 1 from public.ops_operators)
      then
        raise exception 'operator facts exist; refusing to roll back 000052'
          using errcode = '55000';
      end if;
    end;
    $guard$;
    drop trigger ops_audit_no_update_delete on public.ops_audit;
    drop function public.ops_audit_append_only();
    drop table public.ops_audit;
    drop table public.ops_operations;
    drop table public.ops_grants;
    drop table public.ops_operators;
  `);
}
