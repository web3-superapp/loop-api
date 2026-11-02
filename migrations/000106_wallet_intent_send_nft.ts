import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0194 (S339-api, 主代理决策 0267): send a LOOP Launch project NFT.
 *
 * 1. `wallet_intents.kind` admits `send_nft` (an ERC-721
 *    `safeTransferFrom` of a launch2 `ProjectNFT`, built on the launch
 *    slot). The payload / review columns stay frozen by the 000021 trigger.
 * 2. `launch2_instances (chain_id, nft_address)` index: the send path looks
 *    an instance up by its NFT contract.
 *
 * `down` refuses while a `send_nft` intent exists, then drops the index and
 * restores the 000021 kind check.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.wallet_intents
      drop constraint wallet_intents_kind_check,
      add constraint wallet_intents_kind_check
        check (kind in ('send', 'approve', 'revoke', 'swap', 'send_nft'));

    create index launch2_instances_nft_address_idx
      on public.launch2_instances (chain_id, nft_address);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.wallet_intents where kind = 'send_nft')
      then
        raise exception 'send_nft wallet intents exist; refusing to roll back 000106';
      end if;
    end
    $$;

    drop index public.launch2_instances_nft_address_idx;

    alter table public.wallet_intents
      drop constraint wallet_intents_kind_check,
      add constraint wallet_intents_kind_check
        check (kind in ('send', 'approve', 'revoke', 'swap'));
  `);
}
