import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0125 (S148): mining and launch2 follow-ups of the S138
 * integration run.
 *
 * 1. `launch_projects.community_id` (nullable): the community the project
 *    owner names for the MEME. When the `launch2_event` lane registers the
 *    deployed MEME in the Asset Registry it binds that community to it
 *    (once per instance; the outcome is kept on the instance).
 * 2. `launch_project_approvals`: append-only reviewer approvals of the
 *    catalog material (`materialVersion`), the console counterpart of
 *    `launch_project_rejections`; a material version is approved or
 *    rejected, never both.
 * 3. `launch2_instances`:
 *    - `meme_transfers_target_block` / `meme_transfers_complete_at`: the
 *      MEME ERC-20 `Transfer` coverage. The lane re-scans an instance from
 *      its deploy block once; coverage is complete when the checkpoint
 *      reaches the block the re-scan started below.
 *    - `community_binding` / `community_binding_at`: the outcome of the
 *      one automatic community binding attempt.
 * 4. `launch2_meme_transfers`: every MEME ERC-20 `Transfer` of a launch2
 *    instance (raw facts, `removed` on a reorg rewind). Post-graduation
 *    balances for the mining asset track come from here.
 *
 * Nothing existing is rewritten.
 */

const communityBindingOutcomes = [
  "bound",
  "already_bound",
  "conflict",
  "not_owner",
  "community_unavailable",
  "asset_blocked",
  "none",
] as const;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch_projects
      add column community_id uuid
        references public.communities(community_id) on delete restrict;
    comment on column public.launch_projects.community_id is
      'Decision 0125: the community the owner names for the MEME (owner of that community at save time). The launch2_event lane binds it to the registered MEME asset.';

    create table public.launch_project_approvals (
      approval_id uuid primary key,
      project_id uuid not null references public.launch_projects(project_id) on delete restrict,
      material_version integer not null check (material_version >= 1),
      reviewer_user_id uuid not null references public.ops_operators(user_id) on delete restrict,
      reason text not null check (length(trim(reason)) between 1 and 500),
      created_at timestamptz not null default clock_timestamp(),
      unique (project_id, material_version)
    );
    create index launch_project_approvals_project_idx
      on public.launch_project_approvals (project_id, created_at desc);

    create function public.reject_launch_project_decision_twice()
    returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'launch_project_approvals' and exists (
        select 1 from public.launch_project_rejections
        where project_id = new.project_id and material_version = new.material_version)
      or tg_table_name = 'launch_project_rejections' and exists (
        select 1 from public.launch_project_approvals
        where project_id = new.project_id and material_version = new.material_version)
      then
        raise exception 'launch project material version already decided (Decision 0125)'
          using errcode = '23514';
      end if;
      return new;
    end;
    $$;
    create trigger launch_project_approvals_once
      before insert on public.launch_project_approvals
      for each row execute function public.reject_launch_project_decision_twice();
    create trigger launch_project_rejections_once
      before insert on public.launch_project_rejections
      for each row execute function public.reject_launch_project_decision_twice();

    alter table public.launch2_instances
      add column meme_transfers_target_block numeric(78, 0)
        constraint launch2_instances_meme_transfers_target_block_check
          check (meme_transfers_target_block >= 0),
      add column meme_transfers_complete_at timestamptz,
      add column community_binding text
        constraint launch2_instances_community_binding_check
          check (community_binding in (${communityBindingOutcomes
            .map((value) => `'${value}'`)
            .join(", ")})),
      add column community_binding_at timestamptz,
      add constraint launch2_instances_meme_transfers_shape check (
        meme_transfers_complete_at is null or meme_transfers_target_block is not null),
      add constraint launch2_instances_community_binding_shape check (
        (community_binding is null) = (community_binding_at is null));

    create table public.launch2_meme_transfers (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      log_index integer not null check (log_index >= 0),
      block_number bigint not null check (block_number >= 0),
      block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      from_address text not null check (from_address ~ '^0x[0-9a-f]{40}$'),
      to_address text not null check (to_address ~ '^0x[0-9a-f]{40}$'),
      amount numeric(78, 0) not null check (amount >= 0),
      transferred_at timestamptz not null,
      primary key (chain_id, transaction_hash, log_index)
    );
    create index launch2_meme_transfers_instance_idx
      on public.launch2_meme_transfers (instance_id, transferred_at, block_number, log_index)
      where not removed;
    create index launch2_meme_transfers_block_idx
      on public.launch2_meme_transfers (chain_id, block_number) where not removed;
    comment on table public.launch2_meme_transfers is
      'Decision 0125: MEME ERC-20 Transfer logs of launch2 instances, indexed by the launch2_event lane from the deploy block. A reorged-out log keeps its row with removed = true.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.launch2_meme_transfers;
    alter table public.launch2_instances
      drop constraint launch2_instances_community_binding_shape,
      drop constraint launch2_instances_meme_transfers_shape,
      drop column community_binding_at,
      drop column community_binding,
      drop column meme_transfers_complete_at,
      drop column meme_transfers_target_block;
    drop trigger launch_project_rejections_once on public.launch_project_rejections;
    drop trigger launch_project_approvals_once on public.launch_project_approvals;
    drop function public.reject_launch_project_decision_twice();
    drop table public.launch_project_approvals;
    alter table public.launch_projects drop column community_id;
  `);
}
