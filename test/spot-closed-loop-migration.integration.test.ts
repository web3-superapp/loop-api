import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg, { type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const { Client, Pool } = pg;

const spotTables = [
  "spot_agent_identities",
  "spot_agent_identity_events",
  "spot_intents",
  "spot_intent_events",
  "spot_agent_authorizations",
  "spot_agent_authorization_events",
  "hyperliquid_signer_nonce_state",
  "hyperliquid_signer_nonce_allocations",
] as const;
const fixturePrivyPrefix = "did:privy:spot-migration:";
const accountAddress = `0x${"1".repeat(40)}`;
const baseTokenId = `0x${"2".repeat(32)}`;
const quoteTokenId = `0x${"3".repeat(32)}`;

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

interface OwnerFixture {
  readonly ownerUserId: string;
}

interface SpotIdentityFixture extends OwnerFixture {
  readonly identityId: string;
  readonly agentAddress: string;
}

interface SpotOperationFixture extends SpotIdentityFixture {
  readonly operationId: string;
  readonly requestSha256: string;
}

interface AuthorizationReservation {
  readonly signer: "owner" | "other";
  readonly purpose: "spot_agent_authorization" | "spot_ioc_order";
  readonly nonce: string;
  readonly highWater: string;
}

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function randomHex(length: number): string {
  return randomUUID().replaceAll("-", "").padEnd(length, "0").slice(0, length);
}

function requestDigest(): string {
  return randomHex(32).repeat(2);
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
  const databaseName = `loop_spot_migration_${randomUUID().replaceAll("-", "")}`;
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
    const pool = new Pool({ connectionString: targetDatabaseUrl });
    for (;;) {
      const latest = await latestMigration(pool);
      if (latest === "000007_hyperliquid_spot_closed_loop") {
        break;
      }
      if (latest === undefined) {
        await pool.end();
        throw new Error(
          "Migration 000007_hyperliquid_spot_closed_loop was not found",
        );
      }
      await migrate(targetDatabaseUrl, "down", 1);
    }
    return {
      databaseName,
      databaseUrl: targetDatabaseUrl,
      pool,
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

async function inTransaction<Result>(
  pool: InstanceType<typeof Pool>,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertOwner(
  client: Pick<PoolClient, "query">,
  label: string,
): Promise<OwnerFixture> {
  const inserted = await client.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [`${fixturePrivyPrefix}${label}:${randomUUID()}`],
  });
  const ownerUserId = inserted.rows[0]?.id;
  if (ownerUserId === undefined) {
    throw new Error("Spot migration owner setup failed");
  }
  return { ownerUserId };
}

async function insertIdentity(
  client: Pick<PoolClient, "query">,
  owner: OwnerFixture,
  label: string,
): Promise<SpotIdentityFixture> {
  const identityId = randomUUID();
  const agentAddress = `0x${randomHex(40)}`;
  await client.query({
    text: `
      insert into public.spot_agent_identities (
        id,
        owner_user_id,
        binding_version,
        agent_address,
        agent_name,
        signer_ref
      )
      values ($1, $2, 1, $3, $4, $5)
    `,
    values: [
      identityId,
      owner.ownerUserId,
      agentAddress,
      `spot-${label}`,
      `privy-signer:${randomUUID()}`,
    ],
  });
  return { ...owner, identityId, agentAddress };
}

async function insertProviderOperation(
  client: Pick<PoolClient, "query">,
  owner: OwnerFixture,
  input: {
    readonly kind: "spot_intent" | "spot_agent_authorization";
    readonly scope: string;
    readonly digestVersion: string;
  },
): Promise<Pick<SpotOperationFixture, "operationId" | "requestSha256">> {
  const operationId = randomUUID();
  const requestSha256 = requestDigest();
  const idempotency = await client.query<{ id: string }>({
    text: `
      insert into public.idempotency_records (
        owner_user_id,
        scope,
        idempotency_key,
        key_source,
        request_sha256,
        digest_version
      )
      values ($1, $2, $3, 'server', $4, $5)
      returning id
    `,
    values: [
      owner.ownerUserId,
      input.scope,
      randomUUID(),
      requestSha256,
      input.digestVersion,
    ],
  });
  const idempotencyId = idempotency.rows[0]?.id;
  if (idempotencyId === undefined) {
    throw new Error("Spot migration idempotency setup failed");
  }
  await client.query({
    text: `
      insert into public.provider_operations (
        id,
        owner_user_id,
        idempotency_record_id,
        domain,
        operation_kind,
        request_sha256
      )
      values ($1, $2, $3, 'hyperliquid', $4, $5)
    `,
    values: [
      operationId,
      owner.ownerUserId,
      idempotencyId,
      input.kind,
      requestSha256,
    ],
  });
  return { operationId, requestSha256 };
}

async function insertPreparedIntent(
  client: Pick<PoolClient, "query">,
  identity: SpotIdentityFixture,
  input: {
    readonly scope?: string;
    readonly digestVersion?: string;
  } = {},
): Promise<SpotOperationFixture> {
  const operation = await insertProviderOperation(client, identity, {
    kind: "spot_intent",
    scope: input.scope ?? "spot_intent_prepare",
    digestVersion: input.digestVersion ?? "spot_intent_request_v1",
  });
  await client.query({
    text: `
      with observed as (
        select
          clock_timestamp() - interval '1 second' as source_at,
          clock_timestamp() + interval '5 minutes' as expires_at
      )
      insert into public.spot_intents (
        id,
        owner_user_id,
        request_sha256,
        market_id,
        provider_coin,
        base_token_index,
        base_token_id,
        quote_token_index,
        quote_token_id,
        spot_pair_index,
        exchange_order_asset,
        metadata_version,
        metadata_sha256,
        policy_version,
        side,
        amount_mode,
        amount_value,
        computed_base_size,
        reference_price,
        worst_ioc_limit_price,
        maximum_spend_or_minimum_receive,
        fee_rate,
        fee_estimate,
        account_address,
        binding_version,
        agent_identity_id,
        client_order_id,
        canonical_action,
        public_review,
        review_sha256,
        facts_observed_at,
        reference_source_time,
        expires_at
      )
      select
        $1,
        $2,
        $3,
        $4,
        '@0',
        1,
        $5,
        0,
        $6,
        0,
        10000,
        $7,
        $8,
        'spot_policy_v1',
        'buy',
        'quote',
        '10',
        '1',
        '10',
        '11',
        '11',
        '0.001',
        '0.01',
        $9,
        1,
        $10,
        $11,
        '{}'::jsonb,
        '{}'::jsonb,
        $12,
        source_at,
        source_at,
        expires_at
      from observed
    `,
    values: [
      operation.operationId,
      identity.ownerUserId,
      operation.requestSha256,
      randomUUID(),
      baseTokenId,
      quoteTokenId,
      randomHex(64),
      requestDigest(),
      accountAddress,
      identity.identityId,
      `0x${randomHex(32)}`,
      requestDigest(),
    ],
  });
  return { ...identity, ...operation };
}

async function insertNonceState(
  client: Pick<PoolClient, "query">,
  input: {
    readonly signerAddress: string;
    readonly signerKind: "owner_wallet" | "spot_agent";
    readonly highWater: string;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.hyperliquid_signer_nonce_state (
        network,
        signer_address,
        signer_kind,
        last_allocated_nonce
      )
      values ('testnet', $1, $2, $3::numeric)
    `,
    values: [input.signerAddress, input.signerKind, input.highWater],
  });
}

async function insertNonceAllocation(
  client: Pick<PoolClient, "query">,
  operation: Pick<SpotOperationFixture, "operationId" | "ownerUserId">,
  input: {
    readonly signerAddress: string;
    readonly signerKind: "owner_wallet" | "spot_agent";
    readonly purpose: "spot_agent_authorization" | "spot_ioc_order";
    readonly nonce: string;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.hyperliquid_signer_nonce_allocations (
        operation_id,
        owner_user_id,
        network,
        signer_address,
        signer_kind,
        purpose,
        nonce
      )
      values ($1, $2, 'testnet', $3, $4, $5, $6::numeric)
    `,
    values: [
      operation.operationId,
      operation.ownerUserId,
      input.signerAddress,
      input.signerKind,
      input.purpose,
      input.nonce,
    ],
  });
}

async function insertPreparedAuthorization(
  client: Pick<PoolClient, "query">,
  label: string,
  reservation?: AuthorizationReservation,
): Promise<SpotOperationFixture> {
  const owner = await insertOwner(client, label);
  const identity = await insertIdentity(client, owner, label);
  const operation = await insertProviderOperation(client, owner, {
    kind: "spot_agent_authorization",
    scope: "spot_agent_authorization_issue",
    digestVersion: "spot_agent_authorization_issue_v1",
  });
  await client.query({
    text: `
      with validity as (
        select
          clock_timestamp() + interval '5 minutes' as signing_expires_at,
          clock_timestamp() + interval '1 day' as agent_valid_until
      )
      insert into public.spot_agent_authorizations (
        id,
        owner_user_id,
        request_sha256,
        agent_identity_id,
        account_address,
        binding_version,
        signer_wallet_address,
        agent_address,
        agent_name,
        authorization_nonce,
        agent_valid_until,
        public_review,
        review_sha256,
        typed_data_primary_type,
        signing_digest,
        typed_data_json_sha256,
        signing_expires_at
      )
      select
        $1,
        $2,
        $3,
        $4,
        $5,
        1,
        $5,
        $6,
        $7,
        1000,
        agent_valid_until,
        '{}'::jsonb,
        $8,
        'HyperliquidTransaction:ApproveAgent',
        $9,
        $10,
        signing_expires_at
      from validity
    `,
    values: [
      operation.operationId,
      owner.ownerUserId,
      operation.requestSha256,
      identity.identityId,
      accountAddress,
      identity.agentAddress,
      `spot-${label}`,
      requestDigest(),
      `0x${requestDigest()}`,
      requestDigest(),
    ],
  });

  const fixture = { ...identity, ...operation };
  if (reservation !== undefined) {
    const signerAddress =
      reservation.signer === "owner" ? accountAddress : `0x${randomHex(40)}`;
    await insertNonceState(client, {
      signerAddress,
      signerKind: "owner_wallet",
      highWater: reservation.highWater,
    });
    await insertNonceAllocation(client, fixture, {
      signerAddress,
      signerKind: "owner_wallet",
      purpose: reservation.purpose,
      nonce: reservation.nonce,
    });
  }
  return fixture;
}

async function advanceIntentToSubmitting(
  client: Pick<PoolClient, "query">,
  fixture: SpotOperationFixture,
  allocateNonce: boolean,
): Promise<void> {
  if (allocateNonce) {
    await insertNonceState(client, {
      signerAddress: fixture.agentAddress,
      signerKind: "spot_agent",
      highWater: "2000",
    });
    await insertNonceAllocation(client, fixture, {
      signerAddress: fixture.agentAddress,
      signerKind: "spot_agent",
      purpose: "spot_ioc_order",
      nonce: "2000",
    });
  }
  await client.query({
    text: `
      update public.provider_operations
      set
        state = 'submitting',
        attempt_count = 1,
        transport_attempt_id = $2,
        attempt_committed_at = clock_timestamp(),
        attempt_deadline_at = clock_timestamp() + interval '15 seconds',
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1
    `,
    values: [fixture.operationId, randomUUID()],
  });
  await client.query({
    text: `
      update public.spot_intents
      set
        state = 'submitting',
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1
    `,
    values: [fixture.operationId],
  });
}

async function clearSpotFixtures(
  pool: InstanceType<typeof Pool>,
): Promise<void> {
  await pool.query(`
    truncate table
      public.spot_agent_authorization_events,
      public.spot_intent_events,
      public.spot_agent_identity_events,
      public.hyperliquid_signer_nonce_allocations,
      public.hyperliquid_signer_nonce_state,
      public.spot_agent_authorizations,
      public.spot_intents,
      public.spot_agent_identities
  `);
  await pool.query(`
    delete from public.provider_operations
    where domain = 'hyperliquid'
      and operation_kind in ('spot_intent', 'spot_agent_authorization')
  `);
  await pool.query(`
    delete from public.idempotency_records
    where scope in (
      'spot_intent_prepare',
      'spot_agent_authorization_issue',
      'spot_migration_generic'
    )
  `);
  await pool.query({
    text: `
      delete from public.loop_users
      where privy_user_id like $1
    `,
    values: [`${fixturePrivyPrefix}%`],
  });
}

async function latestMigration(
  pool: InstanceType<typeof Pool>,
): Promise<string | undefined> {
  const result = await pool.query<{ name: string }>({
    text: `
      select name
      from public.pgmigrations
      order by run_on desc, id desc
      limit 1
    `,
  });
  return result.rows[0]?.name;
}

async function waitForBlockedSpotLock(
  pool: InstanceType<typeof Pool>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>({
      text: `
        select exists (
          select 1
          from pg_locks
          where relation = 'public.spot_agent_identities'::regclass
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
  throw new Error("Down migration did not wait for the Spot identity writer");
}

describe("000007 Hyperliquid Spot closed-loop migration against PostgreSQL", () => {
  it("round-trips the eight Spot relations and exact digest domain", async () => {
    await withTemporaryDatabase(async (database) => {
      expect(await latestMigration(database.pool)).toBe(
        "000007_hyperliquid_spot_closed_loop",
      );
      const created = await database.pool.query<{
        relation_name: string;
      }>({
        text: `
          select relname as relation_name
          from pg_class
          where oid = any($1::regclass[])
          order by relname
        `,
        values: [spotTables.map((table) => `public.${table}`)],
      });
      expect(created.rows.map(({ relation_name }) => relation_name)).toEqual(
        [...spotTables].sort(),
      );

      await migrate(database.databaseUrl, "down");
      expect(await latestMigration(database.pool)).toBe(
        "000006_perp_wallet_bindings",
      );
      const rolledBack = await database.pool.query<{
        digest_constraint: string;
        perp_binding: string | null;
        remaining_spot_relations: string;
      }>({
        text: `
          select
            pg_get_constraintdef(oid) as digest_constraint,
            to_regclass('public.perp_wallet_bindings')::text as perp_binding,
            (
              select count(*)::text
              from pg_class
              where relname = any($1::text[])
                and relnamespace = 'public'::regnamespace
            ) as remaining_spot_relations
          from pg_constraint
          where conrelid = 'public.idempotency_records'::regclass
            and conname = 'idempotency_records_digest_version_check'
        `,
        values: [[...spotTables]],
      });
      expect(rolledBack.rows[0]).toMatchObject({
        perp_binding: "perp_wallet_bindings",
        remaining_spot_relations: "0",
      });
      expect(rolledBack.rows[0]?.digest_constraint).not.toContain(
        "spot_intent_request_v1",
      );
      expect(rolledBack.rows[0]?.digest_constraint).not.toContain(
        "spot_agent_authorization_issue_v1",
      );

      await migrate(database.databaseUrl, "up", 1);
      expect(await latestMigration(database.pool)).toBe(
        "000007_hyperliquid_spot_closed_loop",
      );
      const restored = await database.pool.query<{ definition: string }>({
        text: `
          select pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = 'public.idempotency_records'::regclass
            and conname = 'idempotency_records_digest_version_check'
        `,
      });
      expect(restored.rows[0]?.definition).toContain("spot_intent_request_v1");
      expect(restored.rows[0]?.definition).toContain(
        "spot_agent_authorization_issue_v1",
      );
    });
  });

  it("refuses rollback for every independently durable Spot authority", async () => {
    await withTemporaryDatabase(async (database) => {
      const assertGuarded = async (): Promise<void> => {
        await expect(
          migrate(database.databaseUrl, "down"),
        ).rejects.toMatchObject({ code: "55000" });
        expect(await latestMigration(database.pool)).toBe(
          "000007_hyperliquid_spot_closed_loop",
        );
      };

      const orphanOwner = await insertOwner(database.pool, "orphan-digest");
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
          values ($1, 'spot_intent_prepare', $2, 'client', $3,
                  'spot_intent_request_v1')
        `,
        values: [orphanOwner.ownerUserId, randomUUID(), requestDigest()],
      });
      await assertGuarded();
      await clearSpotFixtures(database.pool);

      const identityOwner = await insertOwner(database.pool, "identity-only");
      await insertIdentity(database.pool, identityOwner, "identity-only");
      await assertGuarded();
      await clearSpotFixtures(database.pool);

      await insertNonceState(database.pool, {
        signerAddress: `0x${randomHex(40)}`,
        signerKind: "spot_agent",
        highWater: "3000",
      });
      await assertGuarded();
      await clearSpotFixtures(database.pool);

      await inTransaction(database.pool, async (client) => {
        const owner = await insertOwner(client, "provider-only");
        const identity = await insertIdentity(client, owner, "provider-only");
        await insertPreparedIntent(client, identity, {
          scope: "spot_migration_generic",
          digestVersion: "sha256_v1",
        });
      });
      await database.pool.query(`
        truncate table
          public.spot_agent_authorization_events,
          public.spot_intent_events,
          public.spot_agent_identity_events,
          public.hyperliquid_signer_nonce_allocations,
          public.hyperliquid_signer_nonce_state,
          public.spot_agent_authorizations,
          public.spot_intents,
          public.spot_agent_identities
      `);
      await assertGuarded();
    });
  });

  it("waits for an in-flight Spot writer before refusing rollback", async () => {
    await withTemporaryDatabase(async (database) => {
      const writer = await database.pool.connect();
      try {
        await writer.query("begin");
        const owner = await insertOwner(writer, "lock-writer");
        const identity = await insertIdentity(writer, owner, "lock-writer");
        const rollback = migrate(database.databaseUrl, "down");

        await waitForBlockedSpotLock(database.pool);
        await writer.query("commit");

        await expect(rollback).rejects.toMatchObject({ code: "55000" });
        const preserved = await database.pool.query<{ count: string }>({
          text: `
            select count(*)::text as count
            from public.spot_agent_identities
            where id = $1
          `,
          values: [identity.identityId],
        });
        expect(preserved.rows[0]?.count).toBe("1");
        expect(await latestMigration(database.pool)).toBe(
          "000007_hyperliquid_spot_closed_loop",
        );
      } catch (error) {
        await writer.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        writer.release();
      }
    });
  });

  it("enforces deferred projection and exact nonce allocation invariants", async () => {
    await withTemporaryDatabase(async (database) => {
      await expect(
        inTransaction(database.pool, async (client) => {
          const owner = await insertOwner(client, "missing-projection");
          await insertProviderOperation(client, owner, {
            kind: "spot_intent",
            scope: "spot_intent_prepare",
            digestVersion: "spot_intent_request_v1",
          });
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message: "Spot provider operation has no domain projection",
      });

      await expect(
        inTransaction(database.pool, async (client) => {
          await insertPreparedAuthorization(client, "missing-reservation");
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message: "Spot Agent authorization has no exact nonce reservation",
      });

      await expect(
        inTransaction(database.pool, async (client) => {
          const owner = await insertOwner(client, "early-order-nonce");
          const identity = await insertIdentity(
            client,
            owner,
            "early-order-nonce",
          );
          const fixture = await insertPreparedIntent(client, identity);
          await insertNonceState(client, {
            signerAddress: fixture.agentAddress,
            signerKind: "spot_agent",
            highWater: "2000",
          });
          await insertNonceAllocation(client, fixture, {
            signerAddress: fixture.agentAddress,
            signerKind: "spot_agent",
            purpose: "spot_ioc_order",
            nonce: "2000",
          });
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message:
          "Spot order nonce cannot be allocated before its attempt journal",
      });

      await expect(
        inTransaction(database.pool, async (client) => {
          const owner = await insertOwner(client, "missing-order-nonce");
          const identity = await insertIdentity(
            client,
            owner,
            "missing-order-nonce",
          );
          const fixture = await insertPreparedIntent(client, identity);
          await advanceIntentToSubmitting(client, fixture, false);
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message: "Spot provider attempt has no exact nonce allocation",
      });

      const invalidReservations: readonly AuthorizationReservation[] = [
        {
          signer: "other",
          purpose: "spot_agent_authorization",
          nonce: "1000",
          highWater: "1000",
        },
        {
          signer: "owner",
          purpose: "spot_ioc_order",
          nonce: "1000",
          highWater: "1000",
        },
        {
          signer: "owner",
          purpose: "spot_agent_authorization",
          nonce: "1001",
          highWater: "1001",
        },
        {
          signer: "owner",
          purpose: "spot_agent_authorization",
          nonce: "1000",
          highWater: "1001",
        },
      ];
      for (const [index, reservation] of invalidReservations.entries()) {
        const expectedMessage =
          index === invalidReservations.length - 1
            ? "nonce allocation is not the current persisted high-water mark"
            : "Spot Agent authorization has no exact nonce reservation";
        await expect(
          inTransaction(database.pool, async (client) => {
            await insertPreparedAuthorization(
              client,
              `invalid-reservation-${index}`,
              reservation,
            );
          }),
        ).rejects.toMatchObject({ code: "23514", message: expectedMessage });
      }
    });
  });

  it("accepts one exact authorization reservation and keeps nonce history monotonic", async () => {
    await withTemporaryDatabase(async (database) => {
      const fixture = await inTransaction(database.pool, async (client) =>
        insertPreparedAuthorization(client, "valid-reservation", {
          signer: "owner",
          purpose: "spot_agent_authorization",
          nonce: "1000",
          highWater: "1000",
        }),
      );
      const persisted = await database.pool.query<{
        allocation_count: string;
        authorization_nonce: string;
        high_water: string;
      }>({
        text: `
          select
            agent_auth.authorization_nonce::text as authorization_nonce,
            nonce_state.last_allocated_nonce::text as high_water,
            count(allocation.operation_id)::text as allocation_count
          from public.spot_agent_authorizations as agent_auth
          join public.hyperliquid_signer_nonce_allocations as allocation
            on allocation.operation_id = agent_auth.id
          join public.hyperliquid_signer_nonce_state as nonce_state
            on nonce_state.network = allocation.network
           and nonce_state.signer_address = allocation.signer_address
          where agent_auth.id = $1
          group by agent_auth.authorization_nonce,
                   nonce_state.last_allocated_nonce
        `,
        values: [fixture.operationId],
      });
      expect(persisted.rows[0]).toEqual({
        allocation_count: "1",
        authorization_nonce: "1000",
        high_water: "1000",
      });

      await expect(
        database.pool.query({
          text: `
            update public.hyperliquid_signer_nonce_allocations
            set nonce = 1001
            where operation_id = $1
          `,
          values: [fixture.operationId],
        }),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        database.pool.query({
          text: `
            delete from public.hyperliquid_signer_nonce_allocations
            where operation_id = $1
          `,
          values: [fixture.operationId],
        }),
      ).rejects.toMatchObject({ code: "55000" });

      await database.pool.query({
        text: `
          update public.hyperliquid_signer_nonce_state
          set
            last_allocated_nonce = 1001,
            updated_at = clock_timestamp()
          where network = 'testnet'
            and signer_address = $1
        `,
        values: [accountAddress],
      });
      await expect(
        database.pool.query({
          text: `
            update public.hyperliquid_signer_nonce_state
            set
              last_allocated_nonce = 1000,
              updated_at = clock_timestamp()
            where network = 'testnet'
              and signer_address = $1
          `,
          values: [accountAddress],
        }),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        database.pool.query({
          text: `
            delete from public.hyperliquid_signer_nonce_state
            where network = 'testnet'
              and signer_address = $1
          `,
          values: [accountAddress],
        }),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("requires exact fill and fee presence before terminal success", async () => {
    await withTemporaryDatabase(async (database) => {
      const fixture = await inTransaction(database.pool, async (client) => {
        const owner = await insertOwner(client, "fill-presence");
        const identity = await insertIdentity(client, owner, "fill-presence");
        return insertPreparedIntent(client, identity);
      });
      await inTransaction(database.pool, async (client) => {
        await advanceIntentToSubmitting(client, fixture, true);
      });

      await expect(
        database.pool.query({
          text: `
            update public.spot_intents
            set
              state = 'filled',
              filled_base_size = '1',
              filled_quote_amount = '10',
              average_fill_price = '10',
              result_observed_at = clock_timestamp(),
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where id = $1
          `,
          values: [fixture.operationId],
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "spot_intents_fill_presence_check",
      });

      await expect(
        database.pool.query({
          text: `
            update public.spot_intents
            set
              state = 'rejected',
              filled_base_size = '1',
              filled_quote_amount = '10',
              average_fill_price = '10',
              result_fee_amount = '0.01',
              result_fee_token_index = 0,
              result_fee_token_id = $2,
              result_fee_asset_display_identity = 'USDC',
              result_observed_at = clock_timestamp(),
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where id = $1
          `,
          values: [fixture.operationId, quoteTokenId],
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "spot_intents_fill_presence_check",
      });

      await inTransaction(database.pool, async (client) => {
        await client.query({
          text: `
            update public.provider_operations
            set
              state = 'succeeded',
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where id = $1
          `,
          values: [fixture.operationId],
        });
        await client.query({
          text: `
            update public.spot_intents
            set
              state = 'filled',
              provider_order_id = '42',
              filled_base_size = '1',
              filled_quote_amount = '10',
              average_fill_price = '10',
              result_fee_amount = '0.01',
              result_fee_token_index = 0,
              result_fee_token_id = $2,
              result_fee_asset_display_identity = 'USDC',
              result_observed_at = clock_timestamp(),
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where id = $1
          `,
          values: [fixture.operationId, quoteTokenId],
        });
      });

      const result = await database.pool.query<{
        fee: string;
        state: string;
      }>({
        text: `
          select state, result_fee_amount as fee
          from public.spot_intents
          where id = $1
        `,
        values: [fixture.operationId],
      });
      expect(result.rows[0]).toEqual({ fee: "0.01", state: "filled" });
    });
  });
});
