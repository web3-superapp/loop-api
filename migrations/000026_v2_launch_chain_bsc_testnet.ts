import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0038: the `launch` chain slot may name the BSC testnet.
 *
 * `launches.chain_id`, `indexer_checkpoints.chain_id`, and every `indexed_*`
 * table reference `public.chains` with `on delete restrict`, and migration
 * 000019 seeded only `eip155:56`. This migration seeds `eip155:97` so a
 * launch approved while `LAUNCH_CHAIN_ID=97` — and, once the 02 document
 * lands, a `launch_event` lane checkpoint — can be written. The row is
 * configuration, never proof that an endpoint is reachable or serves chain
 * 97 (`eth_chainId` is verified at runtime). No asset row is seeded: the
 * testnet has no Asset Registry, market, or ERC-20 surface in this step.
 *
 * `chains` is read only by primary key, so the new row appears in no
 * existing response.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    insert into public.chains (
      chain_id,
      namespace,
      reference,
      name,
      native_asset_id,
      confirmations,
      reorg_depth_blocks
    )
    values ('eip155:97', 'eip155', 97, 'BNB Smart Chain Testnet', 'eip155:97:native', 5, 15)
    on conflict (chain_id) do nothing;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.launches where chain_id = 'eip155:97')
        or exists (select 1 from public.indexer_checkpoints where chain_id = 'eip155:97')
      then
        raise exception
          'refusing to remove chain eip155:97 while launches or indexer checkpoints reference it';
      end if;
    end
    $$;
    delete from public.chains where chain_id = 'eip155:97';
  `);
}
