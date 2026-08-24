import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createPostgresDatabase,
  type Database,
} from "../src/database/database.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const config = loadConfig({
  NODE_ENV: "test",
  API_DOCS_ENABLED: "false",
  LOG_LEVEL: "silent",
  DATABASE_URL: databaseUrl,
});
const logger = {
  error: () => undefined,
} as unknown as FastifyBaseLogger;

describe("PostgreSQL internal-user repository", () => {
  let database: Database;
  const inspectionPool = new Pool({ connectionString: databaseUrl });

  beforeAll(() => {
    database = createPostgresDatabase(config, logger);
  });

  beforeEach(async () => {
    await inspectionPool.query("truncate table public.loop_users");
  });

  afterAll(async () => {
    await database.close();
    await inspectionPool.query("truncate table public.loop_users");
    await inspectionPool.end();
  });

  it("returns one stable UUID for sequential calls", async () => {
    const first = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:sequential",
    );
    const second = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:sequential",
    );
    const count = await inspectionPool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users",
    );

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toEqual(first);
    expect(count.rows[0]?.count).toBe("1");
  });

  it("returns one UUID under concurrent first bootstrap", async () => {
    const users = await Promise.all(
      Array.from({ length: 20 }, async () =>
        database.internalUsers.getOrCreateByPrivyUserId("did:privy:concurrent"),
      ),
    );
    const ids = new Set(users.map((user) => user.id));
    const count = await inspectionPool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users",
    );

    expect(ids.size).toBe(1);
    expect(count.rows[0]?.count).toBe("1");
  });

  it("creates distinct UUIDs for distinct verified identities", async () => {
    const first =
      await database.internalUsers.getOrCreateByPrivyUserId("did:privy:first");
    const second =
      await database.internalUsers.getOrCreateByPrivyUserId("did:privy:second");

    expect(first.id).not.toBe(second.id);
  });

  it("rejects an invalid provider ID before insertion", async () => {
    await expect(
      database.internalUsers.getOrCreateByPrivyUserId("x".repeat(256)),
    ).rejects.toThrow();
    const count = await inspectionPool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users",
    );

    expect(count.rows[0]?.count).toBe("0");
  });
});
