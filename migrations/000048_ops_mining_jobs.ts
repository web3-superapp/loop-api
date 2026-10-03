import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
create table public.ops_jobs (
 id uuid primary key, actor_id uuid not null references public.ops_operators(user_id),
 action text not null check(action in ('mining.snapshot','mining.trial')),
 target text not null, payload jsonb not null,
 state text not null default 'queued' check(state in ('queued','complete','held')),
 attempts integer not null default 0, result jsonb, evidence jsonb, input_hash text,
 created_at timestamptz not null default clock_timestamp(), completed_at timestamptz
);
`);
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql("drop table public.ops_jobs");
}
