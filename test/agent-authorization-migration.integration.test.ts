import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION } from "../src/database/agent-authorization-repository.js";

const { Client, Pool } = pg;
function requireDatabaseUrl(): string {
  const value = process.env["DATABASE_URL"];
  if (value === undefined || value.trim() === "") {
    throw new Error("DATABASE_URL is required for the integration test suite");
  }
  return value;
}

const databaseUrl = requireDatabaseUrl();

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

interface TemporaryDatabase {
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly pool: InstanceType<typeof Pool>;
}

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrate(
  targetDatabaseUrl: string,
  direction: "up" | "down",
  count = direction === "down" ? 1 : undefined,
): Promise<void> {
  await runner({
    databaseUrl: targetDatabaseUrl,
    dir: migrationsDirectory,
    direction,
    ...(count === undefined ? {} : { count }),
    migrationsTable: "pgmigrations",
    log: () => undefined,
  });
}

async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const databaseName = `loop_agent_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const targetDatabaseUrl = databaseConnectionUrl(databaseUrl, databaseName);
  try {
    await migrate(targetDatabaseUrl, "up");
    await migrate(targetDatabaseUrl, "down", 3);
    return {
      databaseName,
      databaseUrl: targetDatabaseUrl,
      pool: new Pool({ connectionString: targetDatabaseUrl }),
    };
  } catch (error) {
    await dropTemporaryDatabase(databaseName);
    throw error;
  }
}

async function dropTemporaryDatabase(databaseName: string): Promise<void> {
  const admin = new Client({
    connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
}

async function withTemporaryDatabase(
  operation: (database: TemporaryDatabase) => Promise<void>,
): Promise<void> {
  const database = await createTemporaryDatabase();
  try {
    await operation(database);
  } finally {
    await database.pool.end();
    await dropTemporaryDatabase(database.databaseName);
  }
}

async function insertReservedIdentity(
  client: Pick<InstanceType<typeof Pool>, "query">,
): Promise<string> {
  const owner = await client.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [`did:privy:agent-migration-${randomUUID()}`],
  });
  const ownerUserId = owner.rows[0]?.id;
  if (ownerUserId === undefined) {
    throw new Error("Temporary Agent owner setup failed");
  }
  const identityId = randomUUID();
  await client.query({
    text: `
      insert into public.perp_agent_identities (
        id,
        owner_user_id,
        agent_address,
        agent_name
      )
      values ($1, $2, $3, $4)
    `,
    values: [
      identityId,
      ownerUserId,
      `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
      "migration-guard-agent",
    ],
  });
  return identityId;
}

async function waitForBlockedIdentityLock(
  pool: InstanceType<typeof Pool>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>({
      text: `
        select exists (
          select 1
          from pg_locks
          where relation = 'public.perp_agent_identities'::regclass
            and mode = 'AccessExclusiveLock'
            and not granted
        ) as waiting
      `,
    });
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Down migration did not wait for the Agent identity writer");
}

describe("000004 Agent authorization migration against PostgreSQL", () => {
  it("round-trips an orphan scoped reservation and its digest version", async () => {
    await withTemporaryDatabase(async (database) => {
      const owner = await database.pool.query<{ id: string }>({
        text: `
          insert into public.loop_users (privy_user_id)
          values ($1)
          returning id
        `,
        values: [`did:privy:agent-orphan-${randomUUID()}`],
      });
      const ownerUserId = owner.rows[0]?.id;
      if (ownerUserId === undefined) {
        throw new Error("Temporary orphan owner setup failed");
      }
      await database.pool.query({
        text: `
          insert into public.idempotency_records (
            owner_user_id,
            scope,
            idempotency_key,
            key_source,
            request_sha256,
            digest_version
          )
          values ($1, 'perp_agent_authorization_issue', $2, 'server', $3, $4)
        `,
        values: [
          ownerUserId,
          randomUUID(),
          "a".repeat(64),
          AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
        ],
      });

      await migrate(database.databaseUrl, "down");
      const rolledBack = await database.pool.query<{
        agent_table: string | null;
        digest_version: string;
        latest_migration: string;
      }>({
        text: `
          select
            to_regclass('public.perp_agent_identities')::text as agent_table,
            (select digest_version
               from public.idempotency_records
               where scope = 'perp_agent_authorization_issue')
              as digest_version,
            (select name from public.pgmigrations order by run_on desc, id desc limit 1)
              as latest_migration
        `,
      });
      expect(rolledBack.rows[0]).toEqual({
        agent_table: null,
        digest_version: "sha256_v1",
        latest_migration: "000003_perp_intents",
      });

      await migrate(database.databaseUrl, "up", 1);
      const restored = await database.pool.query<{
        agent_table: string | null;
        digest_version: string;
        latest_migration: string;
      }>({
        text: `
          select
            to_regclass('public.perp_agent_identities')::text as agent_table,
            (select digest_version
               from public.idempotency_records
               where scope = 'perp_agent_authorization_issue')
              as digest_version,
            (select name from public.pgmigrations order by run_on desc, id desc limit 1)
              as latest_migration
        `,
      });
      expect(restored.rows[0]).toEqual({
        agent_table: "perp_agent_identities",
        digest_version: AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
        latest_migration: "000004_agent_authorizations",
      });
    });
  });

  it("refuses rollback when only a permanently reserved identity exists", async () => {
    await withTemporaryDatabase(async (database) => {
      const identityId = await insertReservedIdentity(database.pool);

      await expect(migrate(database.databaseUrl, "down")).rejects.toMatchObject(
        {
          code: "55000",
        },
      );

      const preserved = await database.pool.query<{
        identity_count: string;
        latest_migration: string;
      }>({
        text: `
          select
            (select count(*)::text
               from public.perp_agent_identities where id = $1)
              as identity_count,
            (select name from public.pgmigrations order by run_on desc, id desc limit 1)
              as latest_migration
        `,
        values: [identityId],
      });
      expect(preserved.rows[0]).toEqual({
        identity_count: "1",
        latest_migration: "000004_agent_authorizations",
      });
    });
  });

  it("waits for an in-flight identity writer and then refuses rollback", async () => {
    await withTemporaryDatabase(async (database) => {
      const writer = await database.pool.connect();
      try {
        await writer.query("begin");
        const identityId = await insertReservedIdentity(writer);
        const rollback = migrate(database.databaseUrl, "down");

        await waitForBlockedIdentityLock(database.pool);
        await writer.query("commit");

        await expect(rollback).rejects.toMatchObject({ code: "55000" });
        const preserved = await database.pool.query<{ count: string }>({
          text: `
            select count(*)::text as count
            from public.perp_agent_identities
            where id = $1
          `,
          values: [identityId],
        });
        expect(preserved.rows[0]?.count).toBe("1");
      } catch (error) {
        await writer.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        writer.release();
      }
    });
  });
});
