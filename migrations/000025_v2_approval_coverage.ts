import type { MigrationBuilder } from "node-pg-migrate";

/**
 * S6 integration finding 4 (Decision 0035, revision 2026-09-09).
 *
 * `indexed_approvals` rides the `erc20_transfer` lane checkpoint, but the
 * table only exists since migration 000021: every block the lane indexed
 * before that has transfers and no `Approval` rows. A checkpoint alone
 * therefore cannot prove that "no approvals" means "none on chain".
 *
 * `approval_coverage_from_block` is the first block from which the lane has
 * decoded `Approval` logs contiguously up to `last_block_number`. It is null
 * until the lane advances under approval-aware code, is lowered by an
 * approval-coverage backfill (`pnpm indexer:backfill --lane erc20_transfer
 * --from X`), and never rises. Only the transfer lane uses it.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.indexer_checkpoints
      add column approval_coverage_from_block bigint;
    alter table public.indexer_checkpoints
      add constraint indexer_checkpoints_approval_coverage_check
      check (
        approval_coverage_from_block is null
        or (
          lane = 'erc20_transfer'
          and approval_coverage_from_block >= 0
          and approval_coverage_from_block <= last_block_number + 1
        )
      );
    comment on column public.indexer_checkpoints.approval_coverage_from_block is
      'First block from which Approval logs are stored contiguously up to last_block_number; null means the approvals inventory is not yet trustworthy for any wallet.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.indexer_checkpoints
      drop constraint indexer_checkpoints_approval_coverage_check;
    alter table public.indexer_checkpoints
      drop column approval_coverage_from_block;
  `);
}
