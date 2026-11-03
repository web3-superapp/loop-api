import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0197 (S342-api, 主代理决策 0270): the in-app DApp browser.
 *
 * `wallet_intents.kind` admits `dapp_tx` (a transaction a DApp page asked
 * for, built on the launch slot's testnet) and `dapp_sign` (a
 * personal_sign / eth_signTypedData_v4 message signature). The payload /
 * review columns stay frozen by the 000021 trigger; a `dapp_sign` closes as
 * `confirmed` with the signature's SHA-256 in its `signature_reported`
 * event, so no column is added.
 *
 * `down` refuses while a DApp intent exists, then restores the 000106 kind
 * check.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.wallet_intents
      drop constraint wallet_intents_kind_check,
      add constraint wallet_intents_kind_check
        check (kind in (
          'send', 'approve', 'revoke', 'swap', 'send_nft',
          'dapp_tx', 'dapp_sign'
        ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.wallet_intents
        where kind in ('dapp_tx', 'dapp_sign')
      )
      then
        raise exception 'DApp wallet intents exist; refusing to roll back 000107';
      end if;
    end
    $$;

    alter table public.wallet_intents
      drop constraint wallet_intents_kind_check,
      add constraint wallet_intents_kind_check
        check (kind in ('send', 'approve', 'revoke', 'swap', 'send_nft'));
  `);
}
