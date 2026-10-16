import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MigrationBuilder } from "node-pg-migrate";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  down,
  up,
} from "../migrations/000087_mining_power_visibility_default_everyone.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0148, migration 000087 on PostgreSQL: the column default moves to
 * `everyone`, every stored `self` is moved to `everyone` with a new record
 * version, `everyone` rows are untouched, and `down` restores only the
 * default.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: connectionUrl(databaseUrl, "postgres"),
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function sqlOf(operation: (pgm: MigrationBuilder) => void): string {
  const statements: string[] = [];
  operation({
    sql: (statement: string) => statements.push(statement),
  } as unknown as MigrationBuilder);
  return statements.join("\n");
}

describe("000087 mining power visibility default (Decision 0148)", () => {
  const databaseName = `loop_s205m_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;

  async function user(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s205m:${randomUUID()}`],
    );
    return result.rows[0]!.id;
  }

  async function row(owner: string) {
    const result = await pool.query<{
      mining_power_visibility: string;
      record_version: number;
      anonymous_mode: boolean;
      updated_ok: boolean;
    }>(
      `select mining_power_visibility, record_version, anonymous_mode,
         updated_at >= created_at as updated_ok
       from public.privacy_preferences_v2 where owner_user_id = $1`,
      [owner],
    );
    return result.rows[0];
  }

  async function columnDefault(): Promise<string | null> {
    const result = await pool.query<{ column_default: string | null }>(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'privacy_preferences_v2'
         and column_name = 'mining_power_visibility'`,
    );
    return result.rows[0]?.column_default ?? null;
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    const url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("defaults a new row to everyone after the migration", async () => {
    expect(await columnDefault()).toBe("'everyone'::text");
    const owner = await user();
    await pool.query(
      "insert into public.privacy_preferences_v2 (owner_user_id) values ($1)",
      [owner],
    );
    expect(await row(owner)).toMatchObject({
      mining_power_visibility: "everyone",
      record_version: 1,
    });
  });

  it("moves every stored self to everyone with a new version and leaves everyone rows alone; down restores only the default", async () => {
    // Back to the 000015 default to stand rows up as they were before 0148.
    await pool.query(sqlOf(down));
    expect(await columnDefault()).toBe("'self'::text");
    const defaulted = await user();
    const chosen = await user();
    const open = await user();
    await pool.query(
      "insert into public.privacy_preferences_v2 (owner_user_id) values ($1)",
      [defaulted],
    );
    await pool.query(
      `insert into public.privacy_preferences_v2
         (owner_user_id, anonymous_mode, mining_power_visibility, record_version)
       values ($1, true, 'self', 3), ($2, false, 'everyone', 2)`,
      [chosen, open],
    );

    await pool.query(sqlOf(up));
    expect(await columnDefault()).toBe("'everyone'::text");
    // Flipped: the old default and a stored self alike, version + 1.
    expect(await row(defaulted)).toEqual({
      mining_power_visibility: "everyone",
      record_version: 2,
      anonymous_mode: false,
      updated_ok: true,
    });
    expect(await row(chosen)).toEqual({
      mining_power_visibility: "everyone",
      record_version: 4,
      anonymous_mode: true,
      updated_ok: true,
    });
    // Not flipped: already everyone, version unchanged.
    expect(await row(open)).toEqual({
      mining_power_visibility: "everyone",
      record_version: 2,
      anonymous_mode: false,
      updated_ok: true,
    });
    // Re-running is a no-op for the rows.
    await pool.query(sqlOf(up));
    expect((await row(chosen))?.record_version).toBe(4);

    await pool.query(sqlOf(down));
    expect(await columnDefault()).toBe("'self'::text");
    expect((await row(chosen))?.mining_power_visibility).toBe("everyone");
    await pool.query(sqlOf(up));
  });
});
