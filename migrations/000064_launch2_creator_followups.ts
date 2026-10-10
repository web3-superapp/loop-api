import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0120 (S142): MEME v2 creator follow-ups.
 *
 * 1. `launch_projects.kind` (`ido` | `launch2`): which product a catalog
 *    project belongs to. Existing rows with a Hooks config version are
 *    back-filled to `launch2`; a create with `kind: launch2` sets it, and
 *    so does a trigger on every Hooks config version insert (owner save and
 *    operator `launch.config.save` alike); nothing sets it back to `ido`.
 * 2. `launch2_instances.stage` admits `closed_no_holders`.
 * 3. `launch2_snapshot_closures`: the publisher's evidence that an instance
 *    ended its NFT sale with no holder (ProjectNFT.totalMinted() = 0 at a
 *    confirmed cutoff block, indexer caught up). One immutable row per
 *    instance; the stage becomes `closed_no_holders` and neither worker
 *    waits on it again.
 * 4. `launch2_snapshot_publication_releases`: a platform administrator's
 *    retry grant for a blocked publication (latest attempt `failed` or
 *    `mismatch`). Append-only; the grant releases every attempt up to and
 *    including `released_attempt` from the publisher's blocking / budget
 *    rules, so the next tick starts attempt `released_attempt + 1`. The
 *    released publication rows themselves stay untouched (evidence).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch_projects
      add column kind text not null default 'ido'
        constraint launch_projects_kind_check check (kind in ('ido', 'launch2'));
    update public.launch_projects p set kind = 'launch2'
      where exists (select 1 from public.hooks_launch_project_config_versions c
        where c.project_id = p.project_id);
    create index launch_projects_owner_kind_idx
      on public.launch_projects (owner_user_id, kind, created_at desc, project_id desc);
    create function public.mark_launch_project_launch2()
    returns trigger language plpgsql as $$
    begin
      update public.launch_projects set kind = 'launch2'
        where project_id = NEW.project_id and kind <> 'launch2';
      return NEW;
    end;
    $$;
    create trigger hooks_config_version_marks_launch2
      after insert on public.hooks_launch_project_config_versions
      for each row execute function public.mark_launch_project_launch2();

    alter table public.launch2_instances
      drop constraint launch2_instances_stage_check;
    alter table public.launch2_instances
      add constraint launch2_instances_stage_check check (stage in (
        'upcoming', 'nft_sale', 'snapshot_pending', 'closed_no_holders',
        'priority', 'public', 'graduated', 'paused'));

    create table public.launch2_snapshot_closures (
      instance_id uuid primary key references public.launch2_instances(instance_id) on delete restrict,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      reason text not null check (reason = 'no_holders'),
      snapshots_address text not null check (snapshots_address ~ '^0x[0-9a-f]{40}$'),
      sale_end_at timestamptz not null,
      cutoff_block bigint not null check (cutoff_block >= 0),
      cutoff_block_hash text not null check (cutoff_block_hash ~ '^0x[0-9a-f]{64}$'),
      total_minted numeric(78, 0) not null check (total_minted = 0),
      created_at timestamptz not null default clock_timestamp()
    );

    create table public.launch2_snapshot_publication_releases (
      release_id uuid primary key,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      project_id uuid not null,
      released_publication_id uuid not null
        references public.launch2_snapshot_publications(publication_id) on delete restrict,
      released_attempt integer not null check (released_attempt between 1 and 100),
      released_status text not null check (released_status in ('failed', 'mismatch')),
      released_failure_code text not null check (released_failure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      actor text not null check (actor ~ '^[A-Za-z0-9._@-]{1,64}$'),
      actor_account_id uuid,
      reason text not null check (length(trim(reason)) between 1 and 500),
      request_id uuid not null,
      created_at timestamptz not null default clock_timestamp()
    );
    create unique index launch2_snapshot_release_attempt
      on public.launch2_snapshot_publication_releases (instance_id, released_attempt);

    create function public.reject_launch2_snapshot_evidence_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'launch2 snapshot closures and releases are append-only';
    end;
    $$;
    create trigger launch2_snapshot_closures_immutable
      before update or delete on public.launch2_snapshot_closures
      for each row execute function public.reject_launch2_snapshot_evidence_mutation();
    create trigger launch2_snapshot_publication_releases_immutable
      before update or delete on public.launch2_snapshot_publication_releases
      for each row execute function public.reject_launch2_snapshot_evidence_mutation();

    comment on table public.launch2_snapshot_closures is
      'Decision 0120: NFT sale ended with no holder (totalMinted = 0 at a confirmed cutoff); stage closed_no_holders.';
    comment on table public.launch2_snapshot_publication_releases is
      'Decision 0120: platform-administrator retry grants for blocked snapshot publications (append-only).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_snapshot_closures)
        or exists (select 1 from public.launch2_snapshot_publication_releases)
        or exists (select 1 from public.launch2_instances where stage = 'closed_no_holders')
      then raise exception 'refusing to remove snapshot closure / release evidence'; end if;
    end $$;
    drop table public.launch2_snapshot_publication_releases;
    drop table public.launch2_snapshot_closures;
    drop function public.reject_launch2_snapshot_evidence_mutation();
    alter table public.launch2_instances
      drop constraint launch2_instances_stage_check;
    alter table public.launch2_instances
      add constraint launch2_instances_stage_check check (stage in (
        'upcoming', 'nft_sale', 'snapshot_pending', 'priority', 'public', 'graduated', 'paused'));
    drop trigger hooks_config_version_marks_launch2
      on public.hooks_launch_project_config_versions;
    drop function public.mark_launch_project_launch2();
    drop index public.launch_projects_owner_kind_idx;
    alter table public.launch_projects drop column kind;
  `);
}
