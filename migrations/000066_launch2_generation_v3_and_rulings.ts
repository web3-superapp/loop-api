import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0122 (S145): MEME v2 on the v3 Factory generation and the
 * requirer rulings of 2026-10-10 (launch side).
 *
 * 1. `launch2_instances.factory_generation` (`v2` | `v3`): the bytecode
 *    generation of the Factory that deployed the instance, written by the
 *    `launch2_event` lane at registration from the configured Factory list
 *    (current + `LAUNCH2_LEGACY_FACTORIES`). Every row that exists before
 *    this migration came from a price-protected Factory and is back-filled
 *    to `v2`; there is no default afterwards.
 * 2. Zero-holder opening (v3): `launch2_events` admits
 *    `PublicRoundOpenedWithoutHolders`; the instance keeps the indexed
 *    opening (`opened_without_holders_at / _block / _tx`), never together
 *    with a published snapshot root.
 * 3. `launch2_buybacks.min_meme_out / reference_price_e18 / spot_price_e18`
 *    become nullable: v3 `BuybackCompleted` has no such fields (all three
 *    null), v2 rows keep all three.
 * 4. `launch2_snapshot_publications.action`: `publish_snapshot` (the
 *    Decision 0118 row) or `open_without_holders` (the publisher's
 *    `openPublicWithoutSnapshot()` transaction for a v3 instance whose sale
 *    ended with zero mints: no members, zero root / dataHash, no snapshot
 *    signatures). Same status machine, same nonce discipline.
 * 5. Review rejections (requirer ruling 7): `launch_project_rejections`
 *    (catalog material review) and `hooks_launch_config_rejections` (one
 *    config version), both append-only, reason
 *    `incomplete_materials | name_or_ticker_conflict |
 *    buyback_recipient_invalid | community_binding_mismatch | other`
 *    (`other` needs a note). A config version is approved or rejected,
 *    never both (both paths lock the version row; a trigger refuses the
 *    second fact as a backstop).
 */

const rejectionReasons = `('incomplete_materials', 'name_or_ticker_conflict',
  'buyback_recipient_invalid', 'community_binding_mismatch', 'other')`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_instances
      add column factory_generation text not null default 'v2'
        constraint launch2_instances_factory_generation_check
          check (factory_generation in ('v2', 'v3')),
      add column opened_without_holders_at timestamptz,
      add column opened_without_holders_block numeric(78, 0)
        constraint launch2_instances_opened_without_holders_block_check
          check (opened_without_holders_block >= 0),
      add column opened_without_holders_tx text
        constraint launch2_instances_opened_without_holders_tx_check
          check (opened_without_holders_tx ~ '^0x[0-9a-f]{64}$'),
      add constraint launch2_instances_opened_without_holders_shape check (
        (opened_without_holders_at is null) = (opened_without_holders_block is null)
        and (opened_without_holders_at is null) = (opened_without_holders_tx is null)
        and (opened_without_holders_at is null or snapshot_root is null)
        and (opened_without_holders_at is null or factory_generation <> 'v2'));
    alter table public.launch2_instances
      alter column factory_generation drop default;

    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
        'SnapshotPublished', 'PublicRoundOpenedWithoutHolders', 'CurveBought',
        'CurveSold', 'Graduated', 'BuybackCompleted', 'BuybackPausedEvent',
        'BuybackResumed'));

    alter table public.launch2_buybacks
      alter column min_meme_out drop not null,
      alter column min_meme_out drop default,
      alter column reference_price_e18 drop not null,
      alter column reference_price_e18 drop default,
      alter column spot_price_e18 drop not null,
      alter column spot_price_e18 drop default,
      add constraint launch2_buybacks_protection_shape check (
        (min_meme_out is null) = (reference_price_e18 is null)
        and (min_meme_out is null) = (spot_price_e18 is null));

    alter table public.launch2_snapshot_publications
      add column action text not null default 'publish_snapshot'
        constraint launch2_snapshot_publications_action_check
          check (action in ('publish_snapshot', 'open_without_holders')),
      drop constraint launch2_snapshot_publications_members_check,
      drop constraint launch2_snapshot_publications_member_count_check,
      drop constraint launch2_snapshot_publications_root_check,
      drop constraint launch2_snapshot_publications_data_hash_check,
      drop constraint launch2_snapshot_publications_signer_addresses_check,
      drop constraint launch2_snapshot_publications_signatures_check;
    alter table public.launch2_snapshot_publications
      add constraint launch2_snapshot_publication_action_shape check (
        jsonb_typeof(members) = 'array'
        and jsonb_typeof(signer_addresses) = 'array'
        and jsonb_typeof(signatures) = 'array'
        and root ~ '^0x[0-9a-f]{64}$'
        and data_hash ~ '^0x[0-9a-f]{64}$'
        and (
          (action = 'publish_snapshot'
            and jsonb_array_length(members) > 0 and member_count > 0
            and jsonb_array_length(signer_addresses) = 2
            and jsonb_array_length(signatures) = 2)
          or (action = 'open_without_holders'
            and jsonb_array_length(members) = 0 and member_count = 0
            and root = '0x0000000000000000000000000000000000000000000000000000000000000000'
            and data_hash = '0x0000000000000000000000000000000000000000000000000000000000000000'
            and jsonb_array_length(signer_addresses) = 0
            and jsonb_array_length(signatures) = 0)));

    create table public.launch_project_rejections (
      rejection_id uuid primary key,
      project_id uuid not null references public.launch_projects(project_id) on delete restrict,
      material_version integer not null check (material_version >= 1),
      reason_code text not null check (reason_code in ${rejectionReasons}),
      note text check (note is null or length(trim(note)) between 1 and 500),
      reviewer_user_id uuid not null references public.ops_operators(user_id) on delete restrict,
      created_at timestamptz not null default clock_timestamp(),
      constraint launch_project_rejections_other_note check (reason_code <> 'other' or note is not null),
      unique (project_id, material_version)
    );
    create index launch_project_rejections_project_idx
      on public.launch_project_rejections (project_id, created_at desc);

    create table public.hooks_launch_config_rejections (
      project_id uuid not null,
      config_version integer not null,
      config_hash text not null check (config_hash ~ '^0x[0-9a-f]{64}$'),
      reviewer_id uuid not null references public.ops_operators(user_id) on delete restrict,
      reason_code text not null check (reason_code in ${rejectionReasons}),
      note text check (note is null or length(trim(note)) between 1 and 500),
      rejected_at timestamptz not null default clock_timestamp(),
      constraint hooks_launch_config_rejections_other_note check (reason_code <> 'other' or note is not null),
      primary key (project_id, config_version),
      foreign key (project_id, config_version)
        references public.hooks_launch_project_config_versions(project_id, config_version) on delete restrict
    );

    create function public.reject_launch_rejection_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception 'launch review rejections are append-only';
    end;
    $$;
    create trigger launch_project_rejections_immutable
      before update or delete on public.launch_project_rejections
      for each row execute function public.reject_launch_rejection_mutation();
    create trigger hooks_launch_config_rejections_immutable
      before update or delete on public.hooks_launch_config_rejections
      for each row execute function public.reject_launch_rejection_mutation();

    create function public.guard_hooks_config_single_decision()
    returns trigger language plpgsql as $$
    begin
      if TG_TABLE_NAME = 'hooks_launch_config_rejections' then
        if exists (select 1 from public.hooks_launch_config_approvals a
          where a.project_id = NEW.project_id and a.config_version = NEW.config_version) then
          raise exception 'config version already approved';
        end if;
      elsif exists (select 1 from public.hooks_launch_config_rejections r
          where r.project_id = NEW.project_id and r.config_version = NEW.config_version) then
        raise exception 'config version already rejected';
      end if;
      return NEW;
    end;
    $$;
    create trigger hooks_launch_config_rejections_single_decision
      before insert on public.hooks_launch_config_rejections
      for each row execute function public.guard_hooks_config_single_decision();
    create trigger hooks_launch_config_approvals_single_decision
      before insert on public.hooks_launch_config_approvals
      for each row execute function public.guard_hooks_config_single_decision();

    comment on table public.launch_project_rejections is
      'Decision 0122: reviewer rejections of catalog project material (append-only); the applicant may edit and resubmit.';
    comment on table public.hooks_launch_config_rejections is
      'Decision 0122: reviewer rejections of one Hooks config version (append-only); the owner saves a new version to resubmit.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch_project_rejections)
        or exists (select 1 from public.hooks_launch_config_rejections)
        or exists (select 1 from public.launch2_snapshot_publications where action <> 'publish_snapshot')
        or exists (select 1 from public.launch2_events where event_name = 'PublicRoundOpenedWithoutHolders')
        or exists (select 1 from public.launch2_buybacks where min_meme_out is null)
        or exists (select 1 from public.launch2_instances where factory_generation <> 'v2')
      then raise exception 'refusing to remove v3 generation / rejection evidence'; end if;
    end $$;
    drop trigger hooks_launch_config_approvals_single_decision on public.hooks_launch_config_approvals;
    drop table public.hooks_launch_config_rejections;
    drop table public.launch_project_rejections;
    drop function public.guard_hooks_config_single_decision();
    drop function public.reject_launch_rejection_mutation();

    alter table public.launch2_snapshot_publications
      drop constraint launch2_snapshot_publication_action_shape,
      drop column action,
      add constraint launch2_snapshot_publications_members_check
        check (jsonb_typeof(members) = 'array' and jsonb_array_length(members) > 0),
      add constraint launch2_snapshot_publications_member_count_check check (member_count > 0),
      add constraint launch2_snapshot_publications_root_check check (root ~ '^0x[0-9a-f]{64}$'),
      add constraint launch2_snapshot_publications_data_hash_check check (data_hash ~ '^0x[0-9a-f]{64}$'),
      add constraint launch2_snapshot_publications_signer_addresses_check check (
        jsonb_typeof(signer_addresses) = 'array' and jsonb_array_length(signer_addresses) = 2),
      add constraint launch2_snapshot_publications_signatures_check check (
        jsonb_typeof(signatures) = 'array' and jsonb_array_length(signatures) = 2);

    alter table public.launch2_buybacks
      drop constraint launch2_buybacks_protection_shape,
      alter column min_meme_out set default 0,
      alter column min_meme_out set not null,
      alter column reference_price_e18 set default 0,
      alter column reference_price_e18 set not null,
      alter column spot_price_e18 set default 0,
      alter column spot_price_e18 set not null;

    alter table public.launch2_events
      drop constraint launch2_events_event_name_check;
    alter table public.launch2_events
      add constraint launch2_events_event_name_check check (event_name in (
        'LaunchDeployed', 'LaunchActivated', 'NftMinted', 'Transfer',
        'SnapshotPublished', 'CurveBought', 'CurveSold', 'Graduated',
        'BuybackCompleted', 'BuybackPausedEvent', 'BuybackResumed'));

    alter table public.launch2_instances
      drop constraint launch2_instances_opened_without_holders_shape,
      drop column opened_without_holders_tx,
      drop column opened_without_holders_block,
      drop column opened_without_holders_at,
      drop column factory_generation;
  `);
}
