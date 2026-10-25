import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0185 (S306): why an `account_wallets` row is archived.
 *
 * - `unlinked`: Privy no longer reports the wallet (the user unlinked it, or
 *   it moved to another Privy user).
 * - `external_limit_exceeded`: Privy reports it, but the account already
 *   holds `externalWalletLimit` (3) active external wallets.
 * - `address_conflict`: Privy reports it, but the same address is already an
 *   active wallet of another LOOP account; it is not given a second owner.
 *
 * Null = active, or archived before this migration (reason unknown). A row
 * that becomes active again clears it. Every reader that filters
 * `status = 'active'` (mining settlement / snapshot, trade attribution, the
 * indexer watch list) therefore ignores all three cases without change.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.account_wallets
      add column archived_reason text,
      add constraint account_wallets_archived_reason_check
        check (
          archived_reason is null
          or archived_reason in (
            'unlinked', 'external_limit_exceeded', 'address_conflict'
          )
        ),
      add constraint account_wallets_archived_reason_status_check
        check (archived_reason is null or status = 'archived');

    comment on column public.account_wallets.archived_reason is
      'Decision 0185: why the row is archived (unlinked | external_limit_exceeded | address_conflict). Null while active, or for rows archived before 000102.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.account_wallets
      drop constraint account_wallets_archived_reason_status_check,
      drop constraint account_wallets_archived_reason_check,
      drop column archived_reason;
  `);
}
