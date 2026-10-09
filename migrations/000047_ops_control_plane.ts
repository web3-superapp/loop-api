import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.ops_operators (
      user_id uuid primary key references public.loop_users(id),
      label text not null check(length(label) between 1 and 80),
      enabled boolean not null default false,
      updated_at timestamptz not null default clock_timestamp()
    );
    create table public.ops_grants (
      user_id uuid not null references public.ops_operators(user_id),
      permission text not null check(permission in ('audit.read','mining.read','mining.edit','mining.approve','mining.snapshot','community.review','support.manage')),
      scope text not null default '*' check(length(scope) between 1 and 128),
      primary key(user_id,permission,scope)
    );
    create table public.ops_mining_drafts (
      id uuid primary key, package jsonb not null, revision integer not null default 1 check(revision>0),
      content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
      state text not null default 'draft' check(state in ('draft','review','published')),
      editor_id uuid not null references public.ops_operators(user_id),
      contributors uuid[] not null,
      approver_id uuid references public.ops_operators(user_id),
      reason text not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
    create table public.ops_operations (
      operation_id uuid primary key, actor_id uuid not null references public.ops_operators(user_id),
      action text not null, target text not null, request_hash text not null, result jsonb not null,
      created_at timestamptz not null default clock_timestamp()
    );
    create table public.ops_audit (
      id bigint generated always as identity primary key,
      operation_id uuid not null, actor_id uuid not null references public.loop_users(id),
      action text not null, target text not null, reason text not null,
      outcome text not null check(outcome in ('succeeded','rejected','unknown')),
      code text, created_at timestamptz not null default clock_timestamp()
    );
    create index ops_audit_cursor on public.ops_audit(id desc);
  `);
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql(
    `drop table public.ops_audit; drop table public.ops_operations; drop table public.ops_mining_drafts; drop table public.ops_grants; drop table public.ops_operators;`,
  );
}
