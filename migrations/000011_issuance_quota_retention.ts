import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create index issuance_rate_records_cleanup_idx
      on public.issuance_rate_records (
        window_started_at,
        capability,
        policy_version,
        subject_kind,
        subject_hmac
      );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop index public.issuance_rate_records_cleanup_idx;
  `);
}
