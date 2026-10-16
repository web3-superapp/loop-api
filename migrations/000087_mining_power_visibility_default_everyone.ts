import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0148: mining power is visible to everyone by default.
 *
 * `privacy_preferences_v2.mining_power_visibility` defaulted to `self`
 * (000015), so every other account on the power rank read "only visible to
 * the owner". The 2026-10-16 ruling flips the default to `everyone`.
 *
 * Existing rows: a row is only written by an explicit privacy replacement,
 * and a replacement always carries the whole document, so a stored `self`
 * cannot be told apart from the old default the client sent back while the
 * owner changed another switch (`record_version` / `updated_at` are per row,
 * not per field). Every stored `self` is therefore moved to `everyone`, with
 * `record_version + 1` and a fresh `updated_at` so a client holding the old
 * version re-reads before it writes. The owner can switch it back in the
 * privacy centre. `everyone` rows are not touched.
 *
 * `down` restores only the column default; it does not move rows back.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.privacy_preferences_v2
      alter column mining_power_visibility set default 'everyone';

    update public.privacy_preferences_v2
      set mining_power_visibility = 'everyone',
        record_version = record_version + 1,
        updated_at = greatest(clock_timestamp(), updated_at)
      where mining_power_visibility = 'self';

    comment on column public.privacy_preferences_v2.mining_power_visibility is
      'Decision 0148: whether other accounts see this account''s mining power number (rank rows, member rows). Defaults to everyone; a missing row reads as everyone. Stored self values were moved to everyone by migration 000087; the owner may set self again.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.privacy_preferences_v2
      alter column mining_power_visibility set default 'self';

    comment on column public.privacy_preferences_v2.mining_power_visibility is null;
  `);
}
