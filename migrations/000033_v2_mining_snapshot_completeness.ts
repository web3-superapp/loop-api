import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0057: a Mining snapshot says whether it valued every holding it
 * weights, and a snapshot that did not is never read as the latest one.
 *
 * Before this migration the lane dropped an asset it could not price and
 * published the rest as a complete snapshot; an account's real holding then
 * read as `power: 0`. Every row now carries a `status`:
 *
 * - `complete`   — every positive, weighted holding has a reference price;
 *                  the only status a read path uses.
 * - `incomplete` — the run could not price at least one positive holding;
 *                  `unread_inputs` lists `{assetId, reasonCode}`; the row has
 *                  no numbers (`total_power = '0'`, `account_count = 0`, no
 *                  power rows — a trigger refuses them) and may have no
 *                  price version.
 * - `invalidated` — a snapshot the operator withdrew after the fact
 *                  (`pnpm mining:invalidate-snapshots`), with the reason and
 *                  time; never read as latest, never deleted.
 *
 * Existing rows default to `complete`: that is what the old writer claimed
 * about them. Rows it published while a price was unreadable are found and
 * withdrawn by the operator script, not guessed at here.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_snapshots
      alter column price_version drop not null,
      add column status text not null default 'complete',
      add column unread_inputs jsonb not null default '[]'::jsonb,
      add column invalidated_at timestamptz,
      add column invalidation_reason text,
      add constraint mining_snapshots_status_check
        check (status in ('complete', 'incomplete', 'invalidated')),
      add constraint mining_snapshots_unread_inputs_array_check
        check (jsonb_typeof(unread_inputs) = 'array'),
      add constraint mining_snapshots_incomplete_unread_check
        check ((status = 'incomplete') = (jsonb_array_length(unread_inputs) > 0)),
      add constraint mining_snapshots_incomplete_numbers_check
        check (status <> 'incomplete' or (total_power = '0' and account_count = 0)),
      add constraint mining_snapshots_price_version_presence_check
        check (status = 'incomplete' or price_version is not null),
      add constraint mining_snapshots_invalidation_check
        check (
          ((status = 'invalidated') = (invalidated_at is not null))
          and ((status = 'invalidated') = (invalidation_reason is not null))
          and (invalidation_reason is null or invalidation_reason ~ '^[A-Z][A-Z0-9_]{0,63}$')
        );

    create index mining_snapshots_complete_recent_idx
      on public.mining_snapshots (computed_at desc, snapshot_id desc)
      where status = 'complete';

    create index mining_snapshots_version_recent_idx
      on public.mining_snapshots (formula_version, computed_at desc, snapshot_id desc);

    comment on column public.mining_snapshots.status is
      'Decision 0057: complete = every positive weighted holding priced (the only status reads use); incomplete = at least one unread holding, no numbers; invalidated = withdrawn by an operator.';
    comment on column public.mining_snapshots.unread_inputs is
      'Decision 0057: [{assetId, reasonCode}] the run could not value; non-empty exactly when status = incomplete.';

    create or replace function public.mining_snapshot_powers_require_complete()
    returns trigger
    language plpgsql
    as $$
    declare
      parent_status text;
    begin
      select status into parent_status
      from public.mining_snapshots
      where snapshot_id = new.snapshot_id;
      if parent_status is distinct from 'complete' then
        raise exception 'mining_snapshot_powers require a complete snapshot (status: %)', coalesce(parent_status, 'missing')
          using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;

    create trigger mining_snapshot_powers_require_complete
      before insert or update on public.mining_snapshot_powers
      for each row execute function public.mining_snapshot_powers_require_complete();

    create or replace function public.mining_snapshots_guard_update()
    returns trigger
    language plpgsql
    as $$
    begin
      if old.status <> 'complete' or new.status <> 'invalidated' then
        raise exception 'mining_snapshots allow only complete -> invalidated (was %, now %)', old.status, new.status
          using errcode = 'check_violation';
      end if;
      if new.block_number is distinct from old.block_number
        or new.block_hash is distinct from old.block_hash
        or new.formula_version is distinct from old.formula_version
        or new.price_version is distinct from old.price_version
        or new.total_power is distinct from old.total_power
        or new.account_count is distinct from old.account_count
        or new.computed_at is distinct from old.computed_at
        or new.unread_inputs is distinct from old.unread_inputs
      then
        raise exception 'mining_snapshots are append-only apart from invalidation'
          using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;

    create trigger mining_snapshots_guard_update
      before update on public.mining_snapshots
      for each row execute function public.mining_snapshots_guard_update();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1
        from public.mining_snapshots
        where status <> 'complete'
      ) then
        raise exception
          'refusing to drop the snapshot status while an incomplete or invalidated snapshot exists';
      end if;
    end
    $$;

    drop trigger mining_snapshots_guard_update on public.mining_snapshots;
    drop function public.mining_snapshots_guard_update();
    drop trigger mining_snapshot_powers_require_complete on public.mining_snapshot_powers;
    drop function public.mining_snapshot_powers_require_complete();
    drop index public.mining_snapshots_version_recent_idx;
    drop index public.mining_snapshots_complete_recent_idx;

    alter table public.mining_snapshots
      drop constraint mining_snapshots_invalidation_check,
      drop constraint mining_snapshots_price_version_presence_check,
      drop constraint mining_snapshots_incomplete_numbers_check,
      drop constraint mining_snapshots_incomplete_unread_check,
      drop constraint mining_snapshots_unread_inputs_array_check,
      drop constraint mining_snapshots_status_check,
      drop column invalidation_reason,
      drop column invalidated_at,
      drop column unread_inputs,
      drop column status,
      alter column price_version set not null;
  `);
}
