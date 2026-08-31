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
  const databaseName = `loop_alias_${randomUUID().replaceAll("-", "")}`;
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
    await migrate(targetDatabaseUrl, "down", 2);
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

async function createProfile(
  database: TemporaryDatabase,
  alias: string,
): Promise<string> {
  const owner = await database.pool.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [`did:privy:alias-migration:${randomUUID()}`],
  });
  const ownerUserId = owner.rows[0]?.id;
  if (ownerUserId === undefined) {
    throw new Error("Temporary alias-migration owner setup failed");
  }
  await database.pool.query({
    text: `
      insert into public.user_profiles (owner_user_id, alias)
      values ($1, $2)
    `,
    values: [ownerUserId, alias],
  });
  return ownerUserId;
}

describe("000012 alias discovery migration against PostgreSQL", () => {
  it("fails closed without mutating an unsafe alias accepted by 000011", async () => {
    await withTemporaryDatabase(async (database) => {
      const ownerUserId = await createProfile(database, "safe\u206aname");

      await expect(
        migrate(database.databaseUrl, "up", 1),
      ).rejects.toMatchObject({ code: "55000" });

      const preserved = await database.pool.query<{
        alias: string;
        latest_migration: string;
        search_key_function: string | null;
        safety_function: string | null;
      }>({
        text: `
          select
            profile.alias,
            (
              select name
              from public.pgmigrations
              order by run_on desc, id desc
              limit 1
            ) as latest_migration,
            to_regprocedure(
              'public.loop_alias_search_key_unicode17_v1(text)'
            )::text as search_key_function,
            to_regprocedure('public.loop_alias_text_is_safe(text)')::text
              as safety_function
          from public.user_profiles as profile
          where profile.owner_user_id = $1
        `,
        values: [ownerUserId],
      });
      expect(preserved.rows[0]).toEqual({
        alias: "safe\u206aname",
        latest_migration: "000011_issuance_quota_retention",
        search_key_function: null,
        safety_function: null,
      });
    });
  });

  it("tightens alias storage, creates ordered indexes, and restores 000011 on an empty rollback", async () => {
    await withTemporaryDatabase(async (database) => {
      const ownerUserId = await createProfile(database, "Safe Name");
      await migrate(database.databaseUrl, "up", 1);

      const safety = await database.pool.query<{
        safe_text: boolean;
        deprecated_bidi: boolean;
        supplementary_tag: boolean;
        line_separator: boolean;
      }>({
        text: `
          select
            public.loop_alias_text_is_safe('Safe 😀') as safe_text,
            public.loop_alias_text_is_safe('safe' || chr(8298))
              as deprecated_bidi,
            public.loop_alias_text_is_safe('safe' || chr(917536))
              as supplementary_tag,
            public.loop_alias_text_is_safe('safe' || chr(8232))
              as line_separator
        `,
      });
      expect(safety.rows[0]).toEqual({
        safe_text: true,
        deprecated_bidi: false,
        supplementary_tag: false,
        line_separator: false,
      });

      const canonical = await database.pool.query<{
        combining_key: string;
        compatibility_key: string;
        precomposed_key: string;
      }>({
        text: `
          select
            public.loop_alias_search_key_unicode17_v1(
              chr(42993) || chr(769) || 'am'
            ) as combining_key,
            public.loop_alias_search_key_unicode17_v1(
              chr(42993) || 'am'
            ) as compatibility_key,
            public.loop_alias_search_key_unicode17_v1('Śam')
              as precomposed_key
        `,
      });
      expect(canonical.rows[0]).toEqual({
        combining_key: "śam",
        compatibility_key: "sam",
        precomposed_key: "śam",
      });

      await expect(
        database.pool.query({
          text: `
            update public.user_profiles
            set alias = $2
            where owner_user_id = $1
          `,
          values: [ownerUserId, "safe\u206aname"],
        }),
      ).rejects.toMatchObject({ code: "23514" });

      const indexes = await database.pool.query<{ indexdef: string }>({
        text: `
          select indexdef
          from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'user_profiles_alias_search_prefix_idx',
              'group_alias_reservations_search_prefix_idx'
            )
          order by indexname
        `,
      });
      expect(indexes.rows).toHaveLength(2);
      for (const row of indexes.rows) {
        expect(row.indexdef).toContain('COLLATE "C"');
        expect(row.indexdef).not.toContain("text_pattern_ops");
      }

      await database.pool.query({
        text: "delete from public.user_profiles where owner_user_id = $1",
        values: [ownerUserId],
      });
      await database.pool.query({
        text: "delete from public.loop_users where id = $1",
        values: [ownerUserId],
      });
      await migrate(database.databaseUrl, "down", 1);

      const rolledBack = await database.pool.query<{
        latest_migration: string;
        public_profile_column_count: string;
        search_key_function: string | null;
        safety_function: string | null;
      }>({
        text: `
          select
            (
              select name
              from public.pgmigrations
              order by run_on desc, id desc
              limit 1
            ) as latest_migration,
            (
              select count(*)::text
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'user_profiles'
                and column_name = 'public_profile_id'
            ) as public_profile_column_count,
            to_regprocedure(
              'public.loop_alias_search_key_unicode17_v1(text)'
            )::text as search_key_function,
            to_regprocedure('public.loop_alias_text_is_safe(text)')::text
              as safety_function
        `,
      });
      expect(rolledBack.rows[0]).toEqual({
        latest_migration: "000011_issuance_quota_retention",
        public_profile_column_count: "0",
        search_key_function: null,
        safety_function: null,
      });

      await expect(createProfile(database, "safe\u206aname")).resolves.toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });
  });
});
