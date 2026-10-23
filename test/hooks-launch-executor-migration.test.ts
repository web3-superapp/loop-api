import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import * as executor from "../migrations/000059_hooks_deployment_executor.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

/** Decision 0112: migration contract of 000059. */
function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("000059 Hooks deployment executor", () => {
  const sql = captureSql(executor.up);

  it("extends the task state machine and guards every transition", () => {
    for (const status of [
      "claimed",
      "broadcast",
      "confirmed",
      "verified",
      "activated",
      "failed",
      "reorged",
    ]) {
      expect(sql).toContain(`'${status}'`);
    }
    for (const transition of [
      "awaiting_executor>claimed",
      "claimed>broadcast",
      "broadcast>confirmed",
      "broadcast>reorged",
      "confirmed>verified",
      "verified>activated",
      "reorged>claimed",
      "failed>claimed",
    ]) {
      expect(sql).toContain(`'${transition}'`);
    }
    expect(sql).toContain("deployment task failure is not retryable");
    expect(sql).toContain(
      "deployment transaction hash changes only when broadcast",
    );
    expect(sql).toContain("hooks_deployment_lease_shape");
  });

  it("adds append-only events and nonce reservations", () => {
    expect(sql).toContain("create table public.hooks_launch_deployment_events");
    expect(sql).toContain("hooks_deployment_event_immutable");
    expect(sql).toContain("create table public.hooks_launch_executor_nonces");
    expect(sql).toContain("where state = 'pending'");
    expect(sql).not.toMatch(/private|secret/iu);
  });

  it("refuses to roll back executor evidence", () => {
    expect(captureSql(executor.down)).toContain(
      "refusing to remove Hooks executor evidence",
    );
  });

  it("is the head migration and registers the new relations", () => {
    expect(latestMigrationName).toBe("000099_launch_review_inbox");
    expect(requiredDatabaseRelations).toEqual(
      expect.arrayContaining([
        "public.hooks_launch_deployment_events",
        "public.hooks_launch_executor_nonces",
      ]),
    );
  });
});
