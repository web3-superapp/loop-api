import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { IdempotencyConflictError } from "../src/database/control-plane-repository.js";
import {
  PERP_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER,
  PerpIntentClaimLimitExceededError,
  PerpIntentPrepareExpiredError,
  PerpIntentRepositoryUnavailableError,
  type PreparePerpIntentInput,
} from "../src/database/perp-intent-repository.js";
import {
  createPostgresDatabase,
  type Database,
} from "../src/database/database.js";
import {
  PERP_INTENT_REQUEST_DIGEST_VERSION,
  type PerpIntentActionKind,
} from "../src/features/perp/perp-intent-contract.js";

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
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const reviewDigest = "c".repeat(64);
const accountAddress = "0x1111111111111111111111111111111111111111";
const generatedClientOrderId = "0x11111111111111111111111111111111";

const truncateAll = `
  truncate table
    public.price_alert_events,
    public.notification_preferences,
    public.notification_preference_versions,
    public.price_alert_definitions,
    public.watchlist_items,
    public.watchlist_groups,
    public.watchlist_versions,
    public.privacy_preferences,
    public.user_profiles,
    public.perp_agent_authorization_events,
    public.perp_agent_authorizations,
    public.perp_agent_identities,
    public.perp_intent_events,
    public.perp_intent_items,
    public.perp_intents,
    public.audit_events,
    public.provider_operations,
    public.idempotency_records,
    public.issuance_rate_records,
    public.loop_users
`;

function timestamps(): { fetchedAt: string; expiresAt: string } {
  const now = Date.now();
  return {
    fetchedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 55_000).toISOString(),
  };
}

function prepareInput(
  ownerUserId: string,
  overrides: Partial<PreparePerpIntentInput> = {},
): PreparePerpIntentInput {
  const { fetchedAt, expiresAt } = timestamps();
  const canonicalAction = {
    action: "order",
    coin: "BTC",
    side: "buy",
    order_type: "limit",
    size: "0.01",
    limit_price: "50000",
    time_in_force: "gtc",
    reduce_only: false,
  } as const;
  const publicReview = {
    version: "perp_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    action: {
      ...canonicalAction,
      client_order_id: generatedClientOrderId,
    },
    source: {
      fetched_at: fetchedAt,
      expires_at: expiresAt,
    },
  } as const;

  return {
    ownerUserId,
    idempotencyKey: randomUUID(),
    requestSha256: digestA,
    requestId: randomUUID(),
    accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    action: "order",
    canonicalAction,
    publicReview,
    reviewSha256: reviewDigest,
    factsObservedAt: fetchedAt,
    expiresAt,
    items: [
      {
        index: 0,
        coin: "BTC",
        targetKind: null,
        targetOrderId: null,
        targetClientOrderId: null,
        generatedClientOrderId,
      },
    ],
    ...overrides,
  };
}

interface DirectIntentItem {
  readonly targetKind: "order_id" | "client_order_id" | null;
  readonly generatedClientOrderId: string | null;
}

function testClientOrderId(index: number): string {
  return `0x${index.toString(16).padStart(32, "0")}`;
}

async function insertDirectIntent(
  client: PoolClient,
  input: {
    readonly ownerUserId: string;
    readonly action: PerpIntentActionKind;
    readonly items: readonly DirectIntentItem[];
    readonly network?: string;
    readonly market?: string;
    readonly dex?: string;
  },
): Promise<void> {
  const operationId = randomUUID();
  const requestSha256 = randomUUID().replaceAll("-", "").repeat(2);
  const idempotency = await client.query<{ id: string }>({
    text: `
      insert into public.idempotency_records (
        owner_user_id,
        scope,
        idempotency_key,
        key_source,
        request_sha256
      )
      values ($1, 'perp_intent_direct_test', $2, 'server', $3)
      returning id
    `,
    values: [input.ownerUserId, randomUUID(), requestSha256],
  });
  const idempotencyId = idempotency.rows[0]?.id;
  if (idempotencyId === undefined) {
    throw new Error("Direct idempotency setup failed");
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
      values ($1, $2, $3, 'hyperliquid', 'perp_intent', $4)
    `,
    values: [operationId, input.ownerUserId, idempotencyId, requestSha256],
  });
  await client.query({
    text: `
      insert into public.perp_intents (
        id,
        owner_user_id,
        request_sha256,
        action,
        network,
        market,
        dex,
        account_address,
        account_kind,
        binding_version,
        canonical_action,
        public_review,
        review_sha256,
        facts_observed_at,
        expires_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, 'master', 1,
        '{}'::jsonb, '{}'::jsonb, $9,
        clock_timestamp() - interval '1 second',
        clock_timestamp() + interval '30 seconds'
      )
    `,
    values: [
      operationId,
      input.ownerUserId,
      requestSha256,
      input.action,
      input.network ?? "testnet",
      input.market ?? "core_perps",
      input.dex ?? "",
      accountAddress,
      reviewDigest,
    ],
  });

  for (const [index, item] of input.items.entries()) {
    await client.query({
      text: `
        insert into public.perp_intent_items (
          intent_id,
          owner_user_id,
          item_index,
          coin,
          target_kind,
          target_order_id,
          target_client_order_id,
          generated_client_order_id
        )
        values (
          $1, $2, $3, 'BTC', $4,
          case when $4 = 'order_id' then $5 else null end,
          case when $4 = 'client_order_id' then $6 else null end,
          $7
        )
      `,
      values: [
        operationId,
        input.ownerUserId,
        index,
        item.targetKind,
        String(index + 1),
        testClientOrderId(500 + index),
        item.generatedClientOrderId,
      ],
    });
  }
}

async function commitDirectIntent(
  pool: InstanceType<typeof Pool>,
  input: Parameters<typeof insertDirectIntent>[1],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await insertDirectIntent(client, input);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("PostgreSQL Perp intent repository", () => {
  let database: Database;
  const inspectionPool = new Pool({ connectionString: databaseUrl });

  beforeAll(() => {
    database = createPostgresDatabase(config, logger);
  });

  beforeEach(async () => {
    await inspectionPool.query(truncateAll);
  });

  afterAll(async () => {
    await database.close();
    await inspectionPool.query(truncateAll);
    await inspectionPool.end();
  });

  it("atomically creates one reviewed intent for concurrent identical prepares", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-concurrent",
    );
    const input = prepareInput(owner.id);

    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        database.perpIntents.prepare(input),
      ),
    );
    const counts = await inspectionPool.query<{
      audit_count: string;
      domain_event_count: string;
      idempotency_count: string;
      intent_count: string;
      item_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.perp_intents)
            as intent_count,
          (select count(*)::text from public.perp_intent_items)
            as item_count,
          (select count(*)::text from public.audit_events)
            as audit_count,
          (select count(*)::text from public.perp_intent_events)
            as domain_event_count
      `,
    });

    expect(new Set(results.map(({ intent }) => intent.id)).size).toBe(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results[0]?.intent).toMatchObject({
      ownerUserId: owner.id,
      action: "order",
      state: "prepared",
      accountAddress,
      accountKind: "master",
      bindingVersion: "1",
      result: null,
    });
    expect(results[0]?.intent.items).toEqual([
      expect.objectContaining({
        index: 0,
        coin: "BTC",
        generatedClientOrderId,
        resultState: null,
      }),
    ]);
    expect(counts.rows[0]).toEqual({
      audit_count: "1",
      domain_event_count: "1",
      idempotency_count: "1",
      intent_count: "1",
      item_count: "1",
      operation_count: "1",
    });
  });

  it("claims before review work, recovers an abandoned claim, and later replays", async () => {
    const firstOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-owner-one",
    );
    const secondOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-owner-two",
    );
    const input = prepareInput(firstOwner.id);

    await expect(
      database.perpIntents.claimPrepare({
        ownerUserId: firstOwner.id,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
      }),
    ).resolves.toEqual({ kind: "claimed" });
    await expect(
      database.perpIntents.claimPrepare({
        ownerUserId: firstOwner.id,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
      }),
    ).resolves.toEqual({ kind: "claimed" });

    const reservedCounts = await inspectionPool.query<{
      digest_version: string;
      idempotency_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select digest_version from public.idempotency_records limit 1)
            as digest_version
      `,
    });
    expect(reservedCounts.rows[0]).toEqual({
      digest_version: PERP_INTENT_REQUEST_DIGEST_VERSION,
      idempotency_count: "1",
      operation_count: "0",
    });

    const prepared = await database.perpIntents.prepare(input);
    await expect(
      database.perpIntents.claimPrepare({
        ownerUserId: firstOwner.id,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
      }),
    ).resolves.toMatchObject({
      kind: "replay",
      intent: { id: prepared.intent.id },
    });
    await expect(
      database.perpIntents.claimPrepare({
        ownerUserId: firstOwner.id,
        idempotencyKey: input.idempotencyKey,
        requestSha256: digestB,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      database.perpIntents.claimPrepare({
        ownerUserId: secondOwner.id,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      database.perpIntents.prepare({
        ...input,
        ownerUserId: secondOwner.id,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const counts = await inspectionPool.query<{
      idempotency_count: string;
      intent_count: string;
      operation_count: string;
      request_digest_version: string;
    }>({
      text: `
        select
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.perp_intents)
            as intent_count,
          (select request_digest_version from public.perp_intents limit 1)
            as request_digest_version
      `,
    });
    expect(counts.rows[0]).toEqual({
      idempotency_count: "1",
      intent_count: "1",
      operation_count: "1",
      request_digest_version: PERP_INTENT_REQUEST_DIGEST_VERSION,
    });
  });

  it("atomically bounds pending claims while preserving replay, conflict, and slot release", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-claim-budget",
    );
    const foreignOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-claim-budget-foreign",
    );
    const claims = Array.from(
      { length: PERP_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER + 1 },
      () => ({
        ownerUserId: owner.id,
        idempotencyKey: randomUUID(),
        requestSha256: digestA,
      }),
    );

    const admitted = await Promise.allSettled(
      claims.map(async (claim) => database.perpIntents.claimPrepare(claim)),
    );
    expect(
      admitted.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(PERP_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER);
    const limited = admitted.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(limited?.reason).toBeInstanceOf(PerpIntentClaimLimitExceededError);

    const acceptedIndex = admitted.findIndex(
      (result) => result.status === "fulfilled",
    );
    const acceptedClaim = claims[acceptedIndex];
    expect(acceptedClaim).toBeDefined();
    await expect(
      database.perpIntents.claimPrepare(acceptedClaim!),
    ).resolves.toEqual({ kind: "claimed" });
    await expect(
      database.perpIntents.claimPrepare({
        ...acceptedClaim!,
        requestSha256: digestB,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      database.perpIntents.claimPrepare({
        ...acceptedClaim!,
        ownerUserId: foreignOwner.id,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    await expect(
      database.perpIntents.prepare(
        prepareInput(owner.id, {
          idempotencyKey: acceptedClaim!.idempotencyKey,
          requestSha256: acceptedClaim!.requestSha256,
        }),
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      database.perpIntents.claimPrepare({
        ownerUserId: owner.id,
        idempotencyKey: randomUUID(),
        requestSha256: digestA,
      }),
    ).resolves.toEqual({ kind: "claimed" });

    const count = await inspectionPool.query<{
      pending_count: string;
      total_count: string;
    }>({
      text: `
        select
          count(*)::text as total_count,
          count(*) filter (
            where not exists (
              select 1
              from public.provider_operations as operation
              where operation.idempotency_record_id = claim.id
            )
          )::text as pending_count
        from public.idempotency_records as claim
        where claim.scope = 'perp_intent_prepare'
      `,
    });
    expect(count.rows[0]).toEqual({
      pending_count: String(PERP_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER),
      total_count: String(PERP_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER + 1),
    });
  });

  it("atomically rejects concurrent cross-owner and cross-digest claims", async () => {
    const firstOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-claim-first",
    );
    const secondOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-claim-second",
    );
    const crossOwnerKey = randomUUID();
    const crossOwner = await Promise.allSettled([
      database.perpIntents.claimPrepare({
        ownerUserId: firstOwner.id,
        idempotencyKey: crossOwnerKey,
        requestSha256: digestA,
      }),
      database.perpIntents.claimPrepare({
        ownerUserId: secondOwner.id,
        idempotencyKey: crossOwnerKey,
        requestSha256: digestA,
      }),
    ]);
    expect(
      crossOwner.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      crossOwner.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
    const crossOwnerFailure = crossOwner.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(crossOwnerFailure?.reason).toBeInstanceOf(IdempotencyConflictError);

    const crossDigestKey = randomUUID();
    const crossDigest = await Promise.allSettled([
      database.perpIntents.claimPrepare({
        ownerUserId: firstOwner.id,
        idempotencyKey: crossDigestKey,
        requestSha256: digestA,
      }),
      database.perpIntents.claimPrepare({
        ownerUserId: firstOwner.id,
        idempotencyKey: crossDigestKey,
        requestSha256: digestB,
      }),
    ]);
    expect(
      crossDigest.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      crossDigest.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
    const crossDigestFailure = crossDigest.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(crossDigestFailure?.reason).toBeInstanceOf(IdempotencyConflictError);

    const counts = await inspectionPool.query<{
      idempotency_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.provider_operations)
            as operation_count
      `,
    });
    expect(counts.rows[0]).toEqual({
      idempotency_count: "2",
      operation_count: "0",
    });
  });

  it("keeps owned reads indistinguishable from missing records", async () => {
    const firstOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-find-owner",
    );
    const secondOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-find-foreign",
    );
    const prepared = await database.perpIntents.prepare(
      prepareInput(firstOwner.id),
    );

    await expect(
      database.perpIntents.findOwned(firstOwner.id, prepared.intent.id),
    ).resolves.toMatchObject({ id: prepared.intent.id });
    await expect(
      database.perpIntents.findOwned(secondOwner.id, prepared.intent.id),
    ).resolves.toBeNull();
    await expect(
      database.perpIntents.findOwned(firstOwner.id, randomUUID()),
    ).resolves.toBeNull();
  });

  it("uses the PostgreSQL clock for expiry and rolls back every generic and domain row", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-expired",
    );
    const fetchedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() - 1_000).toISOString();
    const base = prepareInput(owner.id);
    const expiredInput = prepareInput(owner.id, {
      idempotencyKey: base.idempotencyKey,
      requestSha256: base.requestSha256,
      factsObservedAt: fetchedAt,
      expiresAt,
      publicReview: {
        ...base.publicReview,
        source: { fetched_at: fetchedAt, expires_at: expiresAt },
      },
    });

    await expect(
      database.perpIntents.prepare(expiredInput),
    ).rejects.toBeInstanceOf(PerpIntentPrepareExpiredError);

    const counts = await inspectionPool.query<{ total: string }>({
      text: `
        select (
          (select count(*) from public.idempotency_records)
          + (select count(*) from public.provider_operations)
          + (select count(*) from public.perp_intents)
          + (select count(*) from public.perp_intent_items)
          + (select count(*) from public.audit_events)
          + (select count(*) from public.perp_intent_events)
        )::text as total
      `,
    });
    expect(counts.rows[0]?.total).toBe("0");
  });

  it("projects an elapsed prepared review as expired from the database clock", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-expiry-projection",
    );
    const base = prepareInput(owner.id);
    const fetchedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const prepared = await database.perpIntents.prepare({
      ...base,
      factsObservedAt: fetchedAt,
      expiresAt,
      publicReview: {
        ...base.publicReview,
        source: { fetched_at: fetchedAt, expires_at: expiresAt },
      },
    });
    await inspectionPool.query("select pg_sleep(2.1)");

    await expect(
      database.perpIntents.findOwned(owner.id, prepared.intent.id),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("enforces immutable reviews, append-only events, result presence, and complete action items", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-schema-guards",
    );
    const prepared = await database.perpIntents.prepare(prepareInput(owner.id));

    await expect(
      inspectionPool.query({
        text: `update public.perp_intents set canonical_action = '{}'::jsonb where id = $1`,
        values: [prepared.intent.id],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      inspectionPool.query({
        text: `update public.perp_intent_events set outcome = 'changed' where intent_id = $1`,
        values: [prepared.intent.id],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      inspectionPool.query({
        text: `delete from public.perp_intent_events where intent_id = $1`,
        values: [prepared.intent.id],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      inspectionPool.query({
        text: `
          update public.perp_intent_items
          set result_order_id = '1'
          where intent_id = $1
        `,
        values: [prepared.intent.id],
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      inspectionPool.query({
        text: `delete from public.perp_intent_items where intent_id = $1`,
        values: [prepared.intent.id],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      inspectionPool.query({
        text: `
          update public.perp_intent_items
          set
            result_state = 'filled',
            filled_size = '0',
            observed_at = clock_timestamp()
          where intent_id = $1
        `,
        values: [prepared.intent.id],
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces every action-to-item shape at the deferred database boundary", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-action-items",
    );
    const validCases = [
      {
        action: "order",
        items: [
          {
            targetKind: null,
            generatedClientOrderId: testClientOrderId(100),
          },
        ],
      },
      {
        action: "cancel",
        items: [{ targetKind: "order_id", generatedClientOrderId: null }],
      },
      {
        action: "modify",
        items: [
          {
            targetKind: "order_id",
            generatedClientOrderId: testClientOrderId(101),
          },
        ],
      },
      {
        action: "batch_modify",
        items: [
          {
            targetKind: "order_id",
            generatedClientOrderId: testClientOrderId(102),
          },
          {
            targetKind: "client_order_id",
            generatedClientOrderId: testClientOrderId(103),
          },
        ],
      },
      {
        action: "update_leverage",
        items: [{ targetKind: null, generatedClientOrderId: null }],
      },
      {
        action: "update_isolated_margin",
        items: [{ targetKind: null, generatedClientOrderId: null }],
      },
    ] as const;

    for (const direct of validCases) {
      await expect(
        commitDirectIntent(inspectionPool, {
          ownerUserId: owner.id,
          action: direct.action,
          items: direct.items,
        }),
      ).resolves.toBeUndefined();
    }

    const invalidCases = [
      {
        action: "order",
        items: [
          {
            targetKind: "order_id",
            generatedClientOrderId: testClientOrderId(200),
          },
        ],
      },
      {
        action: "cancel",
        items: [{ targetKind: null, generatedClientOrderId: null }],
      },
      {
        action: "modify",
        items: [{ targetKind: "order_id", generatedClientOrderId: null }],
      },
      {
        action: "batch_modify",
        items: [
          {
            targetKind: null,
            generatedClientOrderId: testClientOrderId(201),
          },
        ],
      },
      {
        action: "update_leverage",
        items: [
          {
            targetKind: null,
            generatedClientOrderId: testClientOrderId(202),
          },
        ],
      },
      {
        action: "update_isolated_margin",
        items: [{ targetKind: "order_id", generatedClientOrderId: null }],
      },
    ] as const;

    for (const direct of invalidCases) {
      await expect(
        commitDirectIntent(inspectionPool, {
          ownerUserId: owner.id,
          action: direct.action,
          items: direct.items,
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects Mainnet, non-Core markets, and non-empty dex values in storage", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-testnet-core",
    );
    const item = {
      targetKind: null,
      generatedClientOrderId: testClientOrderId(300),
    } as const;

    await expect(
      commitDirectIntent(inspectionPool, {
        ownerUserId: owner.id,
        action: "order",
        items: [item],
        network: "mainnet",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      commitDirectIntent(inspectionPool, {
        ownerUserId: owner.id,
        action: "order",
        items: [item],
        market: "hip3",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      commitDirectIntent(inspectionPool, {
        ownerUserId: owner.id,
        action: "order",
        items: [item],
        dex: "spot",
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces global generated cloid uniqueness and rolls back the losing intent", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:perp-intent-cloid-unique",
    );
    const first = prepareInput(owner.id);
    await database.perpIntents.prepare(first);

    await expect(
      database.perpIntents.prepare(
        prepareInput(owner.id, {
          idempotencyKey: randomUUID(),
          requestSha256: digestB,
        }),
      ),
    ).rejects.toBeInstanceOf(PerpIntentRepositoryUnavailableError);

    const counts = await inspectionPool.query<{
      idempotency_count: string;
      intent_count: string;
      item_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.perp_intents)
            as intent_count,
          (select count(*)::text from public.perp_intent_items)
            as item_count
      `,
    });
    expect(counts.rows[0]).toEqual({
      idempotency_count: "1",
      intent_count: "1",
      item_count: "1",
      operation_count: "1",
    });
  });

  it("keeps secret, signing, nonce, and raw-provider columns out of intent storage", async () => {
    const columns = await inspectionPool.query<{ column_name: string }>({
      text: `
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name in (
            'perp_intents',
            'perp_intent_items',
            'perp_intent_events'
          )
      `,
    });
    const forbidden =
      /(secret|signature|nonce|private_key|signed_payload|raw|provider_response|authorization_payload)/;
    expect(
      columns.rows.filter(({ column_name }) => forbidden.test(column_name)),
    ).toEqual([]);
  });
});
