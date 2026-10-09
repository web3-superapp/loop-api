import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0110: mining formula approval separated from drafting (S129).
 *
 * - `draft_author_kind` / `draft_author` / `draft_author_account_id`: who
 *   saved a console draft. `admin_account` = a console account
 *   (`admin_accounts.id`), `admin_bootstrap` = the ADMIN_USERNAME bootstrap
 *   administrator (environment, no account ID). Null for every version
 *   created before this migration or by a script: such a draft cannot be
 *   approved from the console (409 ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN); it
 *   has to be saved again as a new draft.
 * - `approved_by` / `approved_by_account_id`: the console account that
 *   approved the version (null for script approvals and older rows).
 * - The database refuses an approver equal to the draft's author account
 *   and an approval of a draft without a known author, beside the service
 *   check, and keeps both facts immutable once written.
 * - No foreign key to `admin_accounts` (like `admin_audit_log`): accounts
 *   are never deleted, and a key would pull this table into every
 *   `TRUNCATE loop_users CASCADE`.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_formula_versions
      add column draft_author_kind text,
      add column draft_author text,
      add column draft_author_account_id uuid,
      add column approved_by text,
      add column approved_by_account_id uuid,
      add constraint mining_formula_versions_draft_author_check check (
        (draft_author_kind is null and draft_author is null
          and draft_author_account_id is null)
        or (draft_author_kind = 'admin_account'
          and draft_author ~ '^[A-Za-z0-9._@-]{1,64}$'
          and draft_author_account_id is not null)
        or (draft_author_kind = 'admin_bootstrap'
          and draft_author ~ '^[A-Za-z0-9._@-]{1,64}$'
          and draft_author_account_id is null)
      ),
      add constraint mining_formula_versions_approved_by_check check (
        (approved_by is null) = (approved_by_account_id is null)
        and (approved_by is null
          or (approved_by ~ '^[A-Za-z0-9._@-]{1,64}$'
            and status <> 'pending_approval'
            and approved_at is not null))
      ),
      add constraint mining_formula_versions_separation_check check (
        approved_by_account_id is null
        or (draft_author_kind is not null
          and draft_author_account_id is distinct from approved_by_account_id)
      );

    create function public.mining_formula_versions_author_guard()
      returns trigger
      language plpgsql
    as $$
    begin
      if (OLD.draft_author_kind is not null
          and (NEW.draft_author_kind is distinct from OLD.draft_author_kind
            or NEW.draft_author is distinct from OLD.draft_author
            or NEW.draft_author_account_id is distinct from OLD.draft_author_account_id))
        or (OLD.draft_author_kind is null and NEW.draft_author_kind is not null)
      then
        raise exception 'mining formula draft author is set once, on insert';
      end if;
      if OLD.approved_by is not null
        and (NEW.approved_by is distinct from OLD.approved_by
          or NEW.approved_by_account_id is distinct from OLD.approved_by_account_id)
      then
        raise exception 'mining formula approver is immutable';
      end if;
      return NEW;
    end
    $$;
    create trigger mining_formula_versions_author_guard
      before update on public.mining_formula_versions
      for each row execute function public.mining_formula_versions_author_guard();

    comment on column public.mining_formula_versions.draft_author_account_id is
      'Decision 0110: admin_accounts.id of the console account that saved the draft (null for the bootstrap administrator and for versions without a known author). The approver must be another account.';
    comment on column public.mining_formula_versions.approved_by_account_id is
      'Decision 0110: admin_accounts.id of the reviewer who approved the version in the console (null for script approvals).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (
        select 1 from public.mining_formula_versions
        where draft_author_kind is not null or approved_by is not null
      )
      then
        raise exception 'formula author facts exist; refusing to roll back 000056'
          using errcode = '55000';
      end if;
    end;
    $guard$;
    drop trigger mining_formula_versions_author_guard
      on public.mining_formula_versions;
    drop function public.mining_formula_versions_author_guard();
    alter table public.mining_formula_versions
      drop constraint mining_formula_versions_separation_check,
      drop constraint mining_formula_versions_approved_by_check,
      drop constraint mining_formula_versions_draft_author_check,
      drop column approved_by_account_id,
      drop column approved_by,
      drop column draft_author_account_id,
      drop column draft_author,
      drop column draft_author_kind;
  `);
}
