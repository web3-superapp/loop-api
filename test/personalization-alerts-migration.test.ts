import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000005_personalization_alerts.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000005 personalization and alerts migration contract", () => {
  it("adds every owner-bound relation and the alert digest version", () => {
    const statement = captureSql(up);

    for (const relation of [
      "user_profiles",
      "privacy_preferences",
      "watchlist_versions",
      "watchlist_groups",
      "watchlist_items",
      "price_alert_definitions",
      "notification_preference_versions",
      "notification_preferences",
      "price_alert_events",
    ]) {
      expect(statement).toContain(`create table public.${relation}`);
    }
    expect(statement).toContain("'price_alert_create_v1'");
    expect(statement).toContain(
      "references public.loop_users(id) on delete restrict",
    );
  });

  it("binds alert creation to owner, idempotency record, and digest", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "create_idempotency_record_id uuid not null unique",
    );
    expect(statement).toContain(
      "create_idempotency_record_id,\n          owner_user_id,\n          create_request_sha256",
    );
    expect(statement).toContain(
      "references public.idempotency_records (\n          id,\n          owner_user_id,\n          request_sha256",
    );
    expect(statement).toContain("check (state = 'inactive')");
  });

  it("derives bounded Watchlist positions and preserves append-only history", () => {
    const statement = captureSql(up);

    expect(statement).toContain("check (position between 0 and 19)");
    expect(statement).toContain("check (position between 0 and 99)");
    expect(statement).toContain("price_alert_events is append-only");
    expect(statement).toContain(
      "before update or delete on public.price_alert_events",
    );
  });

  it("locks all data and refuses destructive rollback when records exist", () => {
    const statement = captureSql(down);
    const lockIndex = statement.indexOf("lock table");
    const guardIndex = statement.indexOf("do $guard$");
    const firstDropIndex = statement.indexOf(
      "drop table public.price_alert_events",
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(statement).toContain("in access exclusive mode");
    expect(guardIndex).toBeGreaterThan(lockIndex);
    expect(statement).toContain(
      "cannot roll back 000005_personalization_alerts while personalization or alert records exist",
    );
    expect(statement).toContain("using errcode = '55000'");
    expect(firstDropIndex).toBeGreaterThan(guardIndex);
    expect(statement).toContain(
      "'perp_agent_authorization_issue_v1'\n      ));",
    );
  });
});
