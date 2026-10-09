import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0111: operator console follow-ups (S130).
 *
 * - `mining_formula_versions.approved_by` may now also record the
 *   break-glass CLI (`pnpm mining:approve-formula --approved-by <name>`):
 *   `cli:<name>` with a null `approved_by_account_id`. A console approval
 *   keeps its shape (account name + account ID). The CLI name may not be
 *   the draft's author name (case-insensitive), beside the script check.
 *   The author / approver immutability trigger of 000056 is unchanged.
 * - `admin_account_commands.action` gains `account.unlock`
 *   (`POST /admin/v1/accounts/{accountId}/unlock`, Idempotency-Key).
 *
 * No new table, no new column.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.mining_formula_versions
      drop constraint mining_formula_versions_approved_by_check,
      add constraint mining_formula_versions_approved_by_check check (
        (approved_by is null and approved_by_account_id is null)
        or (approved_by is not null
          and status <> 'pending_approval'
          and approved_at is not null
          and (
            (approved_by_account_id is not null
              and approved_by ~ '^[A-Za-z0-9._@-]{1,64}$')
            or (approved_by_account_id is null
              and approved_by ~ '^cli:[A-Za-z0-9._@-]{1,60}$'
              and (draft_author is null
                or lower(approved_by) <> 'cli:' || lower(draft_author)))
          ))
      );

    alter table public.admin_account_commands
      drop constraint admin_account_commands_action_check,
      add constraint admin_account_commands_action_check
        check (action in ('account.create', 'account.disable',
          'account.reset_password', 'account.unlock'));

    comment on column public.mining_formula_versions.approved_by is
      'Decision 0110 / 0111: the console reviewer name (with approved_by_account_id), or cli:<name> for the break-glass mining:approve-formula CLI (account ID null).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (
        select 1 from public.mining_formula_versions
        where approved_by like 'cli:%'
      )
        or exists (
          select 1 from public.admin_account_commands
          where action = 'account.unlock'
        )
      then
        raise exception 'S130 facts exist; refusing to roll back 000058'
          using errcode = '55000';
      end if;
    end;
    $guard$;
    alter table public.admin_account_commands
      drop constraint admin_account_commands_action_check,
      add constraint admin_account_commands_action_check
        check (action in ('account.create', 'account.disable', 'account.reset_password'));
    alter table public.mining_formula_versions
      drop constraint mining_formula_versions_approved_by_check,
      add constraint mining_formula_versions_approved_by_check check (
        (approved_by is null) = (approved_by_account_id is null)
        and (approved_by is null
          or (approved_by ~ '^[A-Za-z0-9._@-]{1,64}$'
            and status <> 'pending_approval'
            and approved_at is not null))
      );
    comment on column public.mining_formula_versions.approved_by is null;
  `);
}
