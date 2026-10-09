import type { MigrationBuilder } from "node-pg-migrate";
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.hooks_launch_deployment_tasks (
      job_id uuid primary key,
      project_id uuid not null,
      config_version integer not null,
      owner_user_id uuid not null references public.loop_users(id),
      chain_id integer not null check (chain_id = 97),
      factory_address text not null check (factory_address ~ '^0x[0-9a-f]{40}$'),
      project_owner text not null check (project_owner ~ '^0x[0-9a-f]{40}$'),
      owner_nonce text not null check (owner_nonce ~ '^(0|[1-9][0-9]*)$' and length(owner_nonce)<=78),
      binding_hash text not null check (binding_hash ~ '^0x[0-9a-f]{64}$'),
      meme_address text not null check (meme_address ~ '^0x[0-9a-f]{36}6666$'),
      hook_address text not null check (hook_address ~ '^0x[0-9a-f]{40}$'),
      status text not null default 'awaiting_executor' check (status in ('awaiting_executor','cancelled')),
      created_at timestamptz not null default clock_timestamp(),
      foreign key (project_id,config_version) references public.hooks_launch_config_approvals(project_id,config_version)
    );
    create unique index hooks_deployment_active_version on public.hooks_launch_deployment_tasks(project_id,config_version) where status='awaiting_executor';
    create unique index hooks_deployment_active_nonce on public.hooks_launch_deployment_tasks(chain_id,factory_address,project_owner,owner_nonce) where status='awaiting_executor';
    create table public.hooks_launch_deployment_authorizations (
      job_id uuid not null references public.hooks_launch_deployment_tasks(job_id),
      fingerprint text not null check (fingerprint ~ '^0x[0-9a-f]{64}$'),
      signed_payload jsonb not null check (jsonb_typeof(signed_payload)='object'),
      created_at timestamptz not null default clock_timestamp(),
      primary key(job_id,fingerprint)
    );
    create table public.hooks_launch_submission_commands (
      owner_user_id uuid not null references public.loop_users(id),
      idempotency_key uuid not null,
      fingerprint text not null check (fingerprint ~ '^0x[0-9a-f]{64}$'),
      job_id uuid not null references public.hooks_launch_deployment_tasks(job_id),
      created_at timestamptz not null default clock_timestamp(),
      primary key(owner_user_id,idempotency_key)
    );
    create function public.guard_hooks_deployment_task() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then raise exception 'deployment tasks retain audit history'; end if;
      if (to_jsonb(NEW)-'status') is distinct from (to_jsonb(OLD)-'status')
        or OLD.status != 'awaiting_executor' or NEW.status != 'cancelled' then
        raise exception 'invalid deployment task mutation';
      end if;
      return NEW;
    end;
    $$;
    create trigger hooks_deployment_task_guard before update or delete on public.hooks_launch_deployment_tasks for each row execute function public.guard_hooks_deployment_task();
    create trigger hooks_deployment_authorization_immutable before update or delete on public.hooks_launch_deployment_authorizations for each row execute function public.reject_hooks_review_mutation();
    create trigger hooks_submission_command_immutable before update or delete on public.hooks_launch_submission_commands for each row execute function public.reject_hooks_review_mutation();
  `);
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from public.hooks_launch_deployment_tasks) then raise exception 'refusing to remove signed deployment evidence'; end if;
    end $$;
    drop table public.hooks_launch_submission_commands;
    drop table public.hooks_launch_deployment_authorizations;
    drop table public.hooks_launch_deployment_tasks;
    drop function public.guard_hooks_deployment_task();
  `);
}
