import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0110: operator console login throttling shared by every API
 * instance (S129), replacing the per-process global lock of Decision 0105.
 *
 * One row per bucket:
 * - `scope = 'username'`, `subject_key` = the lower-cased login name (a
 *   name outside the account name pattern shares the `~malformed` bucket,
 *   so arbitrary typed text — possibly a password — is never stored).
 *   Consecutive failures; `ADMIN_LOGIN_USERNAME_MAX_FAILURES` (default 5)
 *   locks that name for `ADMIN_LOGIN_USERNAME_LOCK_SECONDS` (default 900).
 *   A successful login deletes the row.
 * - `scope = 'ip'`, `subject_key` = the client address (IPv6 by /64).
 *   `ADMIN_LOGIN_IP_MAX_FAILURES` (default 50) failures inside
 *   `ADMIN_LOGIN_IP_WINDOW_SECONDS` (default 900) lock the address for
 *   `ADMIN_LOGIN_IP_LOCK_SECONDS` (default 900). A success refunds only its
 *   own reservation.
 *
 * A login reserves one failure in both buckets (row-locked) before the
 * password is verified, so concurrent attempts on several instances cannot
 * pass a lock. Rows idle for a day are deleted by the next login. Not a
 * fact table: no audit trigger; the lock events are in `admin_audit_log`.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.admin_login_attempts (
      scope text not null,
      subject_key text not null,
      failure_count integer not null default 0,
      window_started_at timestamptz not null default clock_timestamp(),
      locked_until timestamptz,
      updated_at timestamptz not null default clock_timestamp(),
      primary key (scope, subject_key),
      constraint admin_login_attempts_scope_check
        check (scope in ('username', 'ip')),
      constraint admin_login_attempts_subject_check
        check (char_length(subject_key) between 1 and 64),
      constraint admin_login_attempts_failure_count_check
        check (failure_count >= 0)
    );
    create index admin_login_attempts_updated_idx
      on public.admin_login_attempts (updated_at);

    comment on table public.admin_login_attempts is
      'Decision 0110: operator console login failure buckets per lower-cased username and per client address; shared by every API instance.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.admin_login_attempts;
  `);
}
