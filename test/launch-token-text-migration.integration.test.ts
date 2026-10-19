import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Client, Pool } = pg;

const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrate(
  targetDatabaseUrl: string,
  direction: "up" | "down",
  count?: number,
): Promise<void> {
  await runner({
    databaseUrl: targetDatabaseUrl,
    dir: migrationsDirectory,
    direction,
    migrationsTable: "pgmigrations",
    log: () => undefined,
    ...(count === undefined ? {} : { count }),
  });
}

const constraints = [
  ["launch_projects", "launch_projects_ticker_check", "ticker"],
  ["launch2_instances", "launch2_instances_ticker_check", "ticker"],
  ["meme_tokens", "meme_tokens_symbol_check", "symbol"],
] as const;

describe("PostgreSQL UTF-8 ticker floor (migration 000094, Decision 0164)", () => {
  const databaseName = `loop_s243_test_${randomUUID().replaceAll("-", "")}`;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;

  async function definition(table: string, name: string): Promise<string> {
    const result = await pool.query<{ def: string }>({
      text: `
        select pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = $1 and c.conname = $2`,
      values: [table, name],
    });
    expect(result.rows, `${table}.${name}`).toHaveLength(1);
    return result.rows[0]!.def;
  }

  /** Evaluates a table's check on a value through a scratch table. */
  async function accepts(
    table: string,
    name: string,
    column: string,
    value: string,
  ): Promise<boolean> {
    const def = await definition(table, name);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `create temp table scratch (${column} text not null, constraint scratch_check ${def}) on commit drop`,
      );
      try {
        await client.query({
          text: `insert into scratch (${column}) values ($1)`,
          values: [value],
        });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "23514") return false;
        throw error;
      } finally {
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  }

  async function insertProject(ticker: string): Promise<string> {
    const user = await pool.query<{ id: string }>({
      text: "insert into public.loop_users (privy_user_id) values ($1) returning id",
      values: [`did:privy:${randomUUID()}`],
    });
    const projectId = randomUUID();
    await pool.query({
      text: "insert into public.launch_projects (project_id, owner_user_id, name, ticker) values ($1, $2, '项目', $3)",
      values: [projectId, user.rows[0]!.id, ticker],
    });
    return projectId;
  }

  beforeAll(async () => {
    const admin = new Client({
      connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
    } finally {
      await admin.end();
    }
    temporaryDatabaseUrl = databaseConnectionUrl(databaseUrl, databaseName);
    await migrate(temporaryDatabaseUrl, "up");
    pool = new Pool({ connectionString: temporaryDatabaseUrl });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    const admin = new Client({
      connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    try {
      await admin.query(
        `drop database if exists "${databaseName}" with (force)`,
      );
    } finally {
      await admin.end();
    }
  });

  it("accepts non-ASCII, lower-case and short tickers on all three tables", async () => {
    for (const [table, name, column] of constraints) {
      for (const value of [
        "狗狗币",
        "$1",
        "四",
        "doge",
        "🐸蛙",
        "👨‍👩‍👧",
        "フリーダム.オブ.マネー",
        "币安　人生",
        "a".repeat(80),
        "中".repeat(26),
        "DOGE",
      ]) {
        expect(
          await accepts(table, name, column, value),
          `${table} ${value}`,
        ).toBe(true);
      }
      for (const value of [
        "",
        " DOGE",
        "DOGE ",
        "　狗",
        "狗\t",
        "a".repeat(81),
        "中".repeat(27),
      ]) {
        expect(
          await accepts(table, name, column, value),
          `${table} ${JSON.stringify(value)}`,
        ).toBe(false);
      }
    }
  });

  it("stores a non-ASCII ticker in launch_projects", async () => {
    const projectId = await insertProject("狗狗币");
    const stored = await pool.query<{ ticker: string }>({
      text: "select ticker from public.launch_projects where project_id = $1",
      values: [projectId],
    });
    expect(stored.rows[0]?.ticker).toBe("狗狗币");
    await pool.query({
      text: "delete from public.launch_projects where project_id = $1",
      values: [projectId],
    });
  });

  it("refuses down while a row breaks the old pattern, then restores it", async () => {
    const projectId = await insertProject("doge");
    await expect(migrate(temporaryDatabaseUrl, "down", 1)).rejects.toThrow(
      /Decision 0164 down/u,
    );
    // Nothing changed: the new floor is still in place.
    expect(
      await definition("launch_projects", "launch_projects_ticker_check"),
    ).toContain("octet_length");
    await pool.query({
      text: "delete from public.launch_projects where project_id = $1",
      values: [projectId],
    });
    await migrate(temporaryDatabaseUrl, "down", 1);
    expect(
      await definition("launch_projects", "launch_projects_ticker_check"),
    ).toContain("[A-Z0-9]{2,12}");
    expect(
      await definition("launch2_instances", "launch2_instances_ticker_check"),
    ).toContain("[A-Z0-9]{2,12}");
    expect(
      await definition("meme_tokens", "meme_tokens_symbol_check"),
    ).toContain("[A-Z0-9]{2,10}");
    expect(
      await accepts(
        "launch_projects",
        "launch_projects_ticker_check",
        "ticker",
        "狗狗币",
      ),
    ).toBe(false);
    await migrate(temporaryDatabaseUrl, "up");
    expect(
      await accepts(
        "launch_projects",
        "launch_projects_ticker_check",
        "ticker",
        "狗狗币",
      ),
    ).toBe(true);
  }, 120_000);
});
