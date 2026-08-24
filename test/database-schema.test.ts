import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("database schema readiness contract", () => {
  it("tracks the newest append-only migration", async () => {
    const migrationNames = (
      await readdir(resolve(repositoryRoot, "migrations"))
    )
      .filter((name) => /^\d{6}_[a-z0-9_]+\.ts$/.test(name))
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();

    expect(migrationNames.at(-1)).toBe(latestMigrationName);
  });

  it("requires every relation introduced through the current migration head", () => {
    expect(requiredDatabaseRelations).toEqual([
      "public.loop_users",
      "public.provider_operations",
      "public.idempotency_records",
      "public.audit_events",
      "public.issuance_rate_records",
    ]);
    expect(new Set(requiredDatabaseRelations).size).toBe(
      requiredDatabaseRelations.length,
    );
  });
});
