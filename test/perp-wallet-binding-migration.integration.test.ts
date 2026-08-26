import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { describe, expect, it } from "vitest";

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

async function migrateDownTo(
  targetDatabaseUrl: string,
  targetMigration: string,
): Promise<void> {
  const client = new Client({ connectionString: targetDatabaseUrl });
  await client.connect();
  try {
    for (;;) {
      const result = await client.query<{ name: string }>({
        text: `
          select name
          from public.pgmigrations
          order by run_on desc, id desc
          limit 1
        `,
      });
      if (result.rows[0]?.name === targetMigration) {
        return;
      }
      if (result.rows[0] === undefined) {
        throw new Error(`Migration ${targetMigration} was not found`);
      }
      await migrate(targetDatabaseUrl, "down", 1);
    }
  } finally {
    await client.end();
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

async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const databaseName = `loop_wallet_binding_${randomUUID().replaceAll("-", "")}`;
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
    await migrateDownTo(targetDatabaseUrl, "000006_perp_wallet_bindings");
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

describe("000006 Perp wallet-binding migration against PostgreSQL", () => {
  it("round-trips only while both durable relations are empty", async () => {
    await withTemporaryDatabase(async (database) => {
      await migrate(database.databaseUrl, "down");
      const rolledBack = await database.pool.query<{
        binding_table: string | null;
        event_table: string | null;
        identity_constraint_count: string;
        latest_migration: string;
      }>({
        text: `
          select
            to_regclass('public.perp_wallet_bindings')::text as binding_table,
            to_regclass('public.perp_wallet_binding_events')::text as event_table,
            (
              select count(*)::text
              from information_schema.table_constraints
              where table_schema = 'public'
                and table_name = 'loop_users'
                and constraint_name = 'loop_users_id_privy_user_id_unique'
            ) as identity_constraint_count,
            (
              select name
              from public.pgmigrations
              order by run_on desc, id desc
              limit 1
            ) as latest_migration
        `,
      });
      expect(rolledBack.rows[0]).toEqual({
        binding_table: null,
        event_table: null,
        identity_constraint_count: "0",
        latest_migration: "000005_personalization_alerts",
      });

      await migrate(database.databaseUrl, "up", 1);
      const restored = await database.pool.query<{
        binding_table: string | null;
        event_table: string | null;
        latest_migration: string;
      }>({
        text: `
          select
            to_regclass('public.perp_wallet_bindings')::text as binding_table,
            to_regclass('public.perp_wallet_binding_events')::text as event_table,
            (
              select name
              from public.pgmigrations
              order by run_on desc, id desc
              limit 1
            ) as latest_migration
        `,
      });
      expect(restored.rows[0]).toEqual({
        binding_table: "perp_wallet_bindings",
        event_table: "perp_wallet_binding_events",
        latest_migration: "000006_perp_wallet_bindings",
      });
    });
  });

  it("refuses down migration once a permanent binding epoch exists", async () => {
    await withTemporaryDatabase(async (database) => {
      const owner = await database.pool.query<{
        id: string;
        privy_user_id: string;
      }>({
        text: `
          insert into public.loop_users (privy_user_id)
          values ($1)
          returning id, privy_user_id
        `,
        values: [`did:privy:wallet-binding-migration:${randomUUID()}`],
      });
      const ownerRow = owner.rows[0];
      if (ownerRow === undefined) {
        throw new Error("Temporary wallet-binding owner setup failed");
      }
      await database.pool.query({
        text: `
          with observed as (
            select clock_timestamp() as observed_at
          )
          insert into public.perp_wallet_bindings (
            owner_user_id,
            privy_user_id,
            binding_state,
            wallet_id,
            account_address,
            account_kind,
            binding_version,
            last_verified_at,
            created_at,
            updated_at
          )
          select
            $1,
            $2,
            'bound',
            null,
            $3,
            'master',
            1,
            observed_at,
            observed_at,
            observed_at
          from observed
        `,
        values: [ownerRow.id, ownerRow.privy_user_id, `0x${"7".repeat(40)}`],
      });

      await expect(migrate(database.databaseUrl, "down")).rejects.toMatchObject(
        { code: "55000" },
      );
      const preserved = await database.pool.query<{
        binding_count: string;
        latest_migration: string;
      }>({
        text: `
          select
            (
              select count(*)::text
              from public.perp_wallet_bindings
              where owner_user_id = $1
            ) as binding_count,
            (
              select name
              from public.pgmigrations
              order by run_on desc, id desc
              limit 1
            ) as latest_migration
        `,
        values: [ownerRow.id],
      });
      expect(preserved.rows[0]).toEqual({
        binding_count: "1",
        latest_migration: "000006_perp_wallet_bindings",
      });
    });
  });
});
