import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0150 (S214-api): the mainnet switch. The Hooks deployment task
 * and executor nonce tables pinned `chain_id = 97` since 000054 / 000059;
 * with `LAUNCH_CHAIN_ID=56` + `LAUNCH_MAINNET_ACK` the same rows are written
 * for chain 56, so both checks widen to `chain_id in (56, 97)`. Every
 * existing row is 97 and stays valid. `hooks_testnet_acceptances` keeps
 * `chain_id = 97`: it is BSC Testnet acceptance evidence by definition.
 *
 * `down` restores the 97-only checks; it fails while any chain-56 row
 * exists (never deletes one).
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.hooks_launch_deployment_tasks
      drop constraint hooks_launch_deployment_tasks_chain_id_check,
      add constraint hooks_launch_deployment_tasks_chain_id_check
        check (chain_id in (56, 97));
    alter table public.hooks_launch_executor_nonces
      drop constraint hooks_launch_executor_nonces_chain_id_check,
      add constraint hooks_launch_executor_nonces_chain_id_check
        check (chain_id in (56, 97));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.hooks_launch_executor_nonces
      drop constraint hooks_launch_executor_nonces_chain_id_check,
      add constraint hooks_launch_executor_nonces_chain_id_check
        check (chain_id = 97);
    alter table public.hooks_launch_deployment_tasks
      drop constraint hooks_launch_deployment_tasks_chain_id_check,
      add constraint hooks_launch_deployment_tasks_chain_id_check
        check (chain_id = 97);
  `);
}
