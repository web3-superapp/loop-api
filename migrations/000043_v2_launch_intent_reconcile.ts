import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0080: receipt reconciliation of reported Launch purchase Intents
 * (the 0035 `wallet-intent-reconcile` lane extended to `launch_intents`).
 *
 * - `receipt`: the finalized receipt fact the lane read at or past the launch
 *   slot's confirmation depth (`status`, `blockNumber`, `blockHash`,
 *   `gasUsed`, `effectiveGasPrice`, `confirmations`, `observedAt`). A
 *   `success` receipt keeps the Intent `confirmed` even before the
 *   `launch_event` lane indexes its Purchased log.
 * - `reason_code`: why a reconciled Intent left `submitted` without a
 *   successful receipt (`LAUNCH_TX_REVERTED`, `LAUNCH_TX_NOT_OBSERVED`,
 *   `LAUNCH_TX_PAYLOAD_MISMATCH`).
 * - `revert_reason`: the decoded revert reason of a `reverted` Intent when a
 *   read surface provides one; null otherwise (the only case today).
 * - `reconcile_after`: lease/pacing column of the lane.
 * - `launch_intents_report_check` now also requires a transaction hash for
 *   `reverted` and `failed`.
 *
 * The state check of 000023 already admits every target state.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.launch_intents
      add column receipt jsonb,
      add column reason_code text,
      add column revert_reason text,
      add column reconcile_after timestamptz,
      add constraint launch_intents_receipt_check
        check (
          receipt is null
          or (
            jsonb_typeof(receipt) = 'object'
            and receipt ->> 'status' in ('success', 'reverted')
          )
        ),
      add constraint launch_intents_reason_code_check
        check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      add constraint launch_intents_revert_reason_check
        check (
          revert_reason is null
          or (state = 'reverted' and char_length(revert_reason) between 1 and 256)
        ),
      drop constraint launch_intents_report_check,
      add constraint launch_intents_report_check
        check (
          (transaction_hash is null) = (reported_at is null)
          and (
            state not in ('submitted', 'confirmed', 'reverted', 'failed')
            or transaction_hash is not null
          )
        );

    create index launch_intents_reconcile_idx
      on public.launch_intents (chain_id, reconcile_after nulls first, intent_id)
      where state = 'submitted' and transaction_hash is not null;

    comment on column public.launch_intents.receipt is
      'Decision 0080: receipt fact read by the wallet-intent-reconcile lane at or past the launch slot confirmation depth. status success keeps the Intent confirmed independently of the launch_event lane; status reverted is final.';
    comment on column public.launch_intents.revert_reason is
      'Decision 0080: decoded revert reason when a read surface provides one; null when none does (public endpoints expose no trace).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.launch_intents
        where receipt is not null
          or reason_code is not null
          or state in ('reverted', 'failed')
          or (state = 'expired' and transaction_hash is not null)
      )
      then
        raise exception 'reconciled launch intents exist; refusing to roll back 000043';
      end if;
    end
    $$;

    drop index public.launch_intents_reconcile_idx;
    alter table public.launch_intents
      drop constraint launch_intents_report_check,
      add constraint launch_intents_report_check
        check (
          (transaction_hash is null) = (reported_at is null)
          and (state not in ('submitted', 'confirmed') or transaction_hash is not null)
        ),
      drop constraint launch_intents_revert_reason_check,
      drop constraint launch_intents_reason_code_check,
      drop constraint launch_intents_receipt_check,
      drop column reconcile_after,
      drop column revert_reason,
      drop column reason_code,
      drop column receipt;
  `);
}
