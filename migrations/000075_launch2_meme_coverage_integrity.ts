import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0129 §2 (S157, patch to Decision 0125): MEME transfer coverage
 * integrity of the `launch2_event` lane.
 *
 * - `launch2_instances.meme_transfers_coverage_failures`: consecutive
 *   failed coverage checks (no deploy-block mint, or a negative balance).
 *   The lane re-scans while it is below 3 and stops at 3 (operator reset:
 *   set it to 0 and `meme_transfers_target_block` to null).
 * - A coverage marked complete before this migration whose indexed
 *   transfers fail the same check (the 2026-10-12 incident: an endpoint
 *   answered `[]` for old blocks) is un-marked, so the lane checks it again
 *   and re-scans it. Transfer rows are not touched.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_instances
      add column meme_transfers_coverage_failures integer not null default 0
        constraint launch2_instances_meme_transfers_coverage_failures_check
          check (meme_transfers_coverage_failures >= 0);
    comment on column public.launch2_instances.meme_transfers_coverage_failures is
      'Decision 0129: consecutive failed MEME transfer coverage checks (deploy-block mint missing or a negative balance). At 3 the lane stops re-scanning; reset to 0 with meme_transfers_target_block = null to retry.';

    update public.launch2_instances i
    set meme_transfers_complete_at = null
    where i.meme_transfers_complete_at is not null
      and (
        not exists (
          select 1 from public.launch2_meme_transfers t
          where t.instance_id = i.instance_id and not t.removed
            and t.from_address = '0x0000000000000000000000000000000000000000'
            and t.block_number = i.deploy_block_number)
        or exists (
          select 1 from (
            select t.to_address as address, t.amount as delta
            from public.launch2_meme_transfers t
            where t.instance_id = i.instance_id and not t.removed
            union all
            select t.from_address, -t.amount
            from public.launch2_meme_transfers t
            where t.instance_id = i.instance_id and not t.removed
          ) flow
          where flow.address <> '0x0000000000000000000000000000000000000000'
          group by flow.address
          having sum(flow.delta) < 0)
      );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch2_instances
      drop column meme_transfers_coverage_failures;
  `);
}
