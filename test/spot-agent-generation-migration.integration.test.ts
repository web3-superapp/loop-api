import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { describe, expect, it } from "vitest";

const { Client, Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}
const requiredDatabaseUrl = databaseUrl;

const migrationsDirectory = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
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

async function latestMigration(
  pool: InstanceType<typeof Pool>,
): Promise<string | null> {
  const result = await pool.query<{ name: string }>({
    text: `
      select name
      from public.pgmigrations
      order by run_on desc, id desc
      limit 1
    `,
  });
  return result.rows[0]?.name ?? null;
}

async function migrateDownTo(
  database: TemporaryDatabase,
  targetMigration: string,
): Promise<void> {
  for (;;) {
    const latest = await latestMigration(database.pool);
    if (latest === targetMigration) {
      return;
    }
    if (latest === null) {
      throw new Error(`Migration ${targetMigration} was not found`);
    }
    await migrate(database.databaseUrl, "down", 1);
  }
}

async function dropTemporaryDatabase(databaseName: string): Promise<void> {
  const admin = new Client({
    connectionString: databaseConnectionUrl(requiredDatabaseUrl, "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
}

async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const databaseName = `loop_spot_generation_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString: databaseConnectionUrl(requiredDatabaseUrl, "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const targetDatabaseUrl = databaseConnectionUrl(
    requiredDatabaseUrl,
    databaseName,
  );
  try {
    await migrate(targetDatabaseUrl, "up");
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

function randomAddress(): string {
  return `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`;
}

async function insertOwner(
  pool: InstanceType<typeof Pool>,
  label: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [`did:privy:spot-generation:${label}:${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("Owner fixture failed");
  }
  return id;
}

async function insertLegacyIdentity(
  pool: InstanceType<typeof Pool>,
  ownerUserId: string,
  label: string,
): Promise<string> {
  const identityId = randomUUID();
  await pool.query({
    text: `
      insert into public.spot_agent_identities (
        id,
        owner_user_id,
        binding_version,
        agent_address,
        agent_name,
        signer_ref,
        created_at,
        updated_at
      )
      values ($1, $2, 1, $3, $4, $5, $6, $6)
    `,
    values: [
      identityId,
      ownerUserId,
      randomAddress(),
      `Loop-${label}`,
      `privy-server-wallet:${randomUUID()}`,
      "2026-08-24T00:00:00.000Z",
    ],
  });
  await pool.query({
    text: `
      insert into public.spot_agent_identity_events (
        agent_identity_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        identity_version,
        occurred_at
      )
      values (
        $1, $2, $3, 'api', 'identity_reserved', null, 'reserved',
        'reserved', 0, $4
      )
    `,
    values: [identityId, ownerUserId, randomUUID(), "2026-08-24T00:00:01.000Z"],
  });
  return identityId;
}

async function retireIdentity(
  pool: InstanceType<typeof Pool>,
  identityId: string,
): Promise<void> {
  await pool.query({
    text: `
      update public.spot_agent_identities
      set
        lifecycle_state = 'retired',
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1
    `,
    values: [identityId],
  });
}

async function insertGeneration(
  pool: InstanceType<typeof Pool>,
  ownerUserId: string,
  generation: string,
): Promise<string> {
  const identityId = randomUUID();
  await pool.query({
    text: `
      insert into public.spot_agent_identities (
        id,
        owner_user_id,
        binding_version,
        agent_generation,
        agent_address,
        agent_name,
        signer_ref
      )
      values ($1, $2, 1, $3::bigint, $4, $5, $6)
    `,
    values: [
      identityId,
      ownerUserId,
      generation,
      randomAddress(),
      `Loop-${generation}-${randomUUID().slice(0, 8)}`,
      `privy-server-wallet:${randomUUID()}`,
    ],
  });
  return identityId;
}

describe("000008 Spot Agent generation migration against PostgreSQL", () => {
  it("backfills legacy identities as generation one without rewriting history", async () => {
    await withTemporaryDatabase(async (database) => {
      await migrateDownTo(database, "000007_hyperliquid_spot_closed_loop");
      const ownerUserId = await insertOwner(database.pool, "backfill");
      const identityId = await insertLegacyIdentity(
        database.pool,
        ownerUserId,
        "backfill",
      );
      const before = await database.pool.query({
        text: `
          select
            identity.record_version::text as record_version,
            identity.created_at,
            identity.updated_at,
            event.occurred_at,
            event.identity_version::text as identity_version
          from public.spot_agent_identities as identity
          join public.spot_agent_identity_events as event
            on event.agent_identity_id = identity.id
          where identity.id = $1
        `,
        values: [identityId],
      });

      await migrate(database.databaseUrl, "up", 1);
      expect(await latestMigration(database.pool)).toBe(
        "000008_spot_agent_generations",
      );
      const after = await database.pool.query({
        text: `
          select
            identity.agent_generation::text as agent_generation,
            identity.record_version::text as record_version,
            identity.created_at,
            identity.updated_at,
            event.occurred_at,
            event.identity_version::text as identity_version
          from public.spot_agent_identities as identity
          join public.spot_agent_identity_events as event
            on event.agent_identity_id = identity.id
          where identity.id = $1
        `,
        values: [identityId],
      });
      expect(after.rows[0]).toMatchObject({
        ...before.rows[0],
        agent_generation: "1",
      });

      const column = await database.pool.query<{
        column_default: string | null;
        data_type: string;
        is_nullable: string;
      }>({
        text: `
          select data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'spot_agent_identities'
            and column_name = 'agent_generation'
        `,
      });
      expect(column.rows[0]).toEqual({
        data_type: "bigint",
        is_nullable: "NO",
        column_default: null,
      });
      await expect(
        database.pool.query({
          text: `
            insert into public.spot_agent_identities (
              id, owner_user_id, binding_version, agent_address,
              agent_name, signer_ref
            )
            values ($1, $2, 2, $3, $4, $5)
          `,
          values: [
            randomUUID(),
            ownerUserId,
            randomAddress(),
            "Loop-no-default",
            `privy-server-wallet:${randomUUID()}`,
          ],
        }),
      ).rejects.toMatchObject({ code: "23502" });
    });
  });

  it("keeps exactly one current generation while retaining terminal history", async () => {
    await withTemporaryDatabase(async (database) => {
      const ownerUserId = await insertOwner(database.pool, "unique");
      const generationOne = await insertGeneration(
        database.pool,
        ownerUserId,
        "1",
      );
      await expect(
        insertGeneration(database.pool, ownerUserId, "2"),
      ).rejects.toMatchObject({ code: "23505" });

      await retireIdentity(database.pool, generationOne);
      const generationTwo = await insertGeneration(
        database.pool,
        ownerUserId,
        "2",
      );
      await retireIdentity(database.pool, generationTwo);
      await expect(
        insertGeneration(database.pool, ownerUserId, "2"),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        insertGeneration(database.pool, ownerUserId, "3"),
      ).resolves.toBeTypeOf("string");
    });
  });

  it("keeps operator hold current until the controlled retirement transition", async () => {
    await withTemporaryDatabase(async (database) => {
      const ownerUserId = await insertOwner(database.pool, "operator-hold");
      const generationOne = await insertGeneration(
        database.pool,
        ownerUserId,
        "1",
      );
      await database.pool.query({
        text: `
          update public.spot_agent_identities
          set
            lifecycle_state = 'operator_hold',
            record_version = 1,
            updated_at = clock_timestamp()
          where id = $1
        `,
        values: [generationOne],
      });
      await expect(
        insertGeneration(database.pool, ownerUserId, "2"),
      ).rejects.toMatchObject({ code: "23505" });

      await retireIdentity(database.pool, generationOne);
      await expect(
        insertGeneration(database.pool, ownerUserId, "2"),
      ).resolves.toBeTypeOf("string");
    });
  });

  it("round-trips generation one but refuses lossy rollback after generation two", async () => {
    await withTemporaryDatabase(async (database) => {
      const legacyOwner = await insertOwner(database.pool, "down-one");
      await insertGeneration(database.pool, legacyOwner, "1");

      await migrate(database.databaseUrl, "down", 1);
      expect(await latestMigration(database.pool)).toBe(
        "000007_hyperliquid_spot_closed_loop",
      );
      const generationColumn = await database.pool.query<{
        relation: string | null;
      }>({
        text: `
          select to_regclass('public.spot_agent_identities')::text as relation
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'spot_agent_identities'
            and column_name = 'agent_generation'
        `,
      });
      expect(generationColumn.rowCount).toBe(0);

      await migrate(database.databaseUrl, "up", 1);
      const generationOne = await database.pool.query<{ id: string }>({
        text: `
          select id
          from public.spot_agent_identities
          where owner_user_id = $1
        `,
        values: [legacyOwner],
      });
      await retireIdentity(database.pool, String(generationOne.rows[0]?.id));
      await insertGeneration(database.pool, legacyOwner, "2");

      await expect(
        migrate(database.databaseUrl, "down", 1),
      ).rejects.toMatchObject({ code: "55000" });
      expect(await latestMigration(database.pool)).toBe(
        "000008_spot_agent_generations",
      );
      const preserved = await database.pool.query<{ generations: string[] }>({
        text: `
          select array_agg(agent_generation::text order by agent_generation)
            as generations
          from public.spot_agent_identities
          where owner_user_id = $1
        `,
        values: [legacyOwner],
      });
      expect(preserved.rows[0]?.generations).toEqual(["1", "2"]);
    });
  });
});
