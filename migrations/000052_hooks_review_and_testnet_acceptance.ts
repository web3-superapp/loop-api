import type { MigrationBuilder } from "node-pg-migrate";

/** Decision 0094: immutable independent approval and BSC Testnet evidence. */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.hooks_launch_project_config_versions
      add column edited_by_operator_id uuid references public.ops_operators(user_id) on delete restrict;

    create table public.hooks_launch_config_approvals (
      project_id uuid not null,
      config_version integer not null,
      config_hash text not null check (config_hash ~ '^0x[0-9a-f]{64}$'),
      approver_id uuid not null references public.ops_operators(user_id) on delete restrict,
      reason text not null check (length(trim(reason)) between 1 and 500),
      approved_at timestamptz not null default clock_timestamp(),
      primary key (project_id, config_version),
      foreign key (project_id, config_version)
        references public.hooks_launch_project_config_versions(project_id, config_version) on delete restrict
    );

    create table public.hooks_testnet_acceptances (
      acceptance_id uuid primary key,
      project_id uuid not null,
      config_version integer not null,
      chain_id integer not null check (chain_id = 97),
      config_hash text not null check (config_hash ~ '^0x[0-9a-f]{64}$'),
      contract_manifest_hash text not null check (contract_manifest_hash ~ '^0x[0-9a-f]{64}$'),
      checklist_version text not null check (checklist_version ~ '^hooks-testnet-v[1-9][0-9]*$'),
      outcome text not null check (outcome in ('passed','failed','incomplete')),
      evidence jsonb not null check (jsonb_typeof(evidence)='array' and jsonb_array_length(evidence) between 1 and 50),
      actor_id uuid not null references public.ops_operators(user_id) on delete restrict,
      reason text not null check (length(trim(reason)) between 1 and 500),
      created_at timestamptz not null default clock_timestamp(),
      foreign key (project_id, config_version)
        references public.hooks_launch_project_config_versions(project_id, config_version) on delete restrict,
      foreign key (project_id, config_version)
        references public.hooks_launch_config_approvals(project_id, config_version) on delete restrict,
      constraint hooks_testnet_evidence_items check (
        not jsonb_path_exists(evidence, '$[*] ? (@.label.type() != "string" || @.uri.type() != "string")')
      )
    );
    create index hooks_testnet_acceptance_project_idx
      on public.hooks_testnet_acceptances(project_id, created_at desc);

    create function public.reject_hooks_review_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'Hooks approvals and testnet acceptance are append-only';
    end;
    $$;
    create trigger hooks_launch_config_approvals_immutable
      before update or delete on public.hooks_launch_config_approvals
      for each row execute function public.reject_hooks_review_mutation();
    create trigger hooks_testnet_acceptances_immutable
      before update or delete on public.hooks_testnet_acceptances
      for each row execute function public.reject_hooks_review_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists(select 1 from public.hooks_launch_config_approvals)
        or exists(select 1 from public.hooks_testnet_acceptances) then
        raise exception 'refusing to remove Hooks review or acceptance evidence'
          using errcode = '55000';
      end if;
    end;
    $guard$;
    drop trigger hooks_testnet_acceptances_immutable on public.hooks_testnet_acceptances;
    drop trigger hooks_launch_config_approvals_immutable on public.hooks_launch_config_approvals;
    drop table public.hooks_testnet_acceptances;
    drop table public.hooks_launch_config_approvals;
    drop function public.reject_hooks_review_mutation();
    alter table public.hooks_launch_project_config_versions drop column edited_by_operator_id;
  `);
}
