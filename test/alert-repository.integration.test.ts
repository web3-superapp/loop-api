import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AlertExpiryNotFutureError,
  AlertIdempotencyConflictError,
  AlertIdempotencyResourceDeletedError,
  AlertRepositoryUnavailableError,
  AlertVersionConflictError,
  createPostgresAlertRepository,
  type AlertRepository,
  type CreatePriceAlertInput,
} from "../src/database/alert-repository.js";
import {
  digestPriceAlertCreate,
  notificationEventTypes,
  PRICE_ALERT_CREATE_DIGEST_VERSION,
  type NotificationPreference,
  type PriceAlertDefinition,
} from "../src/features/alerts/alert-contract.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

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
    public.perp_wallet_binding_events,
    public.perp_wallet_bindings,
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

const definition = Object.freeze({
  asset_key: "BTC",
  condition: "above",
  threshold_decimal: "64000.00",
  expires_at: null,
} as const satisfies PriceAlertDefinition);

function createInput(
  ownerUserId: string,
  overrides: Partial<CreatePriceAlertInput> = {},
): CreatePriceAlertInput {
  const desired = overrides.definition ?? definition;
  return {
    ownerUserId,
    idempotencyKey: randomUUID(),
    requestSha256: digestPriceAlertCreate(desired),
    definition: desired,
    ...overrides,
  };
}

function desiredPreferences(
  enabledEvent: (typeof notificationEventTypes)[number],
): readonly NotificationPreference[] {
  return notificationEventTypes.map((eventType) => ({
    event_type: eventType,
    enabled: eventType === enabledEvent,
  }));
}

async function createOwner(
  pool: InstanceType<typeof Pool>,
  label: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [`did:privy:alert-${label}-${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("Alert owner setup failed");
  }
  return id;
}

describe("PostgreSQL Alert repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let repository: AlertRepository;

  beforeAll(() => {
    repository = createPostgresAlertRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(truncateAll);
  });

  afterAll(async () => {
    await pool.query(truncateAll);
    await pool.end();
  });

  it("returns truthful empty defaults without fixture rows", async () => {
    const ownerUserId = await createOwner(pool, "empty");

    await expect(
      repository.listOwned({ ownerUserId, limit: 50, offset: 0 }),
    ).resolves.toEqual({ records: [], nextOffset: null });
    await expect(
      repository.listHistory({ ownerUserId, limit: 50, offset: 0 }),
    ).resolves.toEqual({ records: [], nextOffset: null });
    await expect(
      repository.getNotificationPreferences(ownerUserId),
    ).resolves.toEqual({
      recordVersion: 0,
      preferences: notificationEventTypes.map((eventType) => ({
        event_type: eventType,
        enabled: false,
      })),
    });

    const counts = await pool.query<{ total: string }>({
      text: `
        select (
          (select count(*) from public.price_alert_definitions)
          + (select count(*) from public.price_alert_events)
          + (select count(*) from public.notification_preference_versions)
          + (select count(*) from public.notification_preferences)
        )::text as total
      `,
    });
    expect(counts.rows[0]?.total).toBe("0");
  });

  it("creates one resource for concurrent same-key same-digest requests", async () => {
    const ownerUserId = await createOwner(pool, "concurrent-create");
    const input = createInput(ownerUserId);

    const results = await Promise.all(
      Array.from({ length: 16 }, async () => repository.create(input)),
    );
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(results.map(({ alert }) => alert.id)).size).toBe(1);
    expect(results[0]?.alert).toMatchObject({
      ownerUserId,
      assetKey: "BTC",
      condition: "above",
      thresholdDecimal: "64000.00",
      state: "inactive",
      recordVersion: 1,
      deletedAt: null,
    });

    const counts = await pool.query<{
      alert_count: string;
      digest_version: string;
      idempotency_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.price_alert_definitions)
            as alert_count,
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select digest_version from public.idempotency_records limit 1)
            as digest_version
      `,
    });
    expect(counts.rows[0]).toEqual({
      alert_count: "1",
      digest_version: PRICE_ALERT_CREATE_DIGEST_VERSION,
      idempotency_count: "1",
    });
  });

  it("rejects idempotency reuse with another digest or owner", async () => {
    const ownerUserId = await createOwner(pool, "idempotency-owner");
    const foreignOwnerUserId = await createOwner(pool, "idempotency-foreign");
    const input = createInput(ownerUserId);
    await repository.create(input);
    const changedDefinition = {
      ...definition,
      threshold_decimal: "65000",
    } satisfies PriceAlertDefinition;

    await expect(
      repository.create({
        ...input,
        definition: changedDefinition,
        requestSha256: digestPriceAlertCreate(changedDefinition),
      }),
    ).rejects.toBeInstanceOf(AlertIdempotencyConflictError);
    await expect(
      repository.create({ ...input, ownerUserId: foreignOwnerUserId }),
    ).rejects.toBeInstanceOf(AlertIdempotencyConflictError);
  });

  it("replays the original create after replacement and returns the current resource", async () => {
    const ownerUserId = await createOwner(pool, "replace-create-replay");
    const input = createInput(ownerUserId);
    const created = await repository.create(input);
    const replacement = {
      ...definition,
      threshold_decimal: "65000",
    } satisfies PriceAlertDefinition;
    const updated = await repository.replaceOwned({
      ownerUserId,
      alertId: created.alert.id,
      expectedVersion: 1,
      definition: replacement,
    });
    expect(updated).toMatchObject({
      ownerUserId,
      createRequestSha256: input.requestSha256,
      thresholdDecimal: "65000",
      recordVersion: 2,
    });

    await expect(repository.create(input)).resolves.toEqual({
      created: false,
      alert: updated,
    });
  });

  it("reports a deleted resource when replay follows replacement and deletion", async () => {
    const ownerUserId = await createOwner(pool, "replace-delete-replay");
    const input = createInput(ownerUserId);
    const created = await repository.create(input);
    const updated = await repository.replaceOwned({
      ownerUserId,
      alertId: created.alert.id,
      expectedVersion: 1,
      definition: {
        ...definition,
        threshold_decimal: "65000",
      },
    });
    expect(updated).toMatchObject({
      createRequestSha256: input.requestSha256,
      recordVersion: 2,
    });
    if (updated === null) {
      throw new Error("Expected the alert replacement to exist");
    }
    await repository.softDeleteOwned({
      ownerUserId,
      alertId: created.alert.id,
      expectedVersion: updated.recordVersion,
    });

    await expect(repository.create(input)).rejects.toBeInstanceOf(
      AlertIdempotencyResourceDeletedError,
    );
  });

  it("recomputes the create digest at the repository boundary", async () => {
    const ownerUserId = await createOwner(pool, "digest-boundary");

    await expect(
      repository.create(
        createInput(ownerUserId, { requestSha256: "0".repeat(64) }),
      ),
    ).rejects.toBeInstanceOf(AlertRepositoryUnavailableError);
    await expect(
      repository.listOwned({ ownerUserId, limit: 50, offset: 0 }),
    ).resolves.toEqual({ records: [], nextOffset: null });
  });

  it("rolls back the idempotency record when a new expiry is not future", async () => {
    const ownerUserId = await createOwner(pool, "expired");
    const expired = {
      ...definition,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    } satisfies PriceAlertDefinition;

    await expect(
      repository.create(createInput(ownerUserId, { definition: expired })),
    ).rejects.toBeInstanceOf(AlertExpiryNotFutureError);
    const counts = await pool.query<{ alerts: string; idempotency: string }>({
      text: `
        select
          (select count(*)::text from public.price_alert_definitions) as alerts,
          (select count(*)::text from public.idempotency_records) as idempotency
      `,
    });
    expect(counts.rows[0]).toEqual({ alerts: "0", idempotency: "0" });
  });

  it("isolates list and item reads by owner", async () => {
    const ownerUserId = await createOwner(pool, "read-owner");
    const foreignOwnerUserId = await createOwner(pool, "read-foreign");
    const created = await repository.create(createInput(ownerUserId));

    await expect(
      repository.findOwned(ownerUserId, created.alert.id),
    ).resolves.toMatchObject({ id: created.alert.id });
    await expect(
      repository.findOwned(foreignOwnerUserId, created.alert.id),
    ).resolves.toBeNull();
    await expect(
      repository.listOwned({
        ownerUserId: foreignOwnerUserId,
        limit: 50,
        offset: 0,
      }),
    ).resolves.toEqual({ records: [], nextOffset: null });
  });

  it("replaces once, accepts identical retry, and rejects stale divergence", async () => {
    const ownerUserId = await createOwner(pool, "replace");
    const created = await repository.create(createInput(ownerUserId));
    const replacement = {
      asset_key: "ETH",
      condition: "at_or_below",
      threshold_decimal: "3000.50",
      expires_at: null,
    } as const satisfies PriceAlertDefinition;

    const updated = await repository.replaceOwned({
      ownerUserId,
      alertId: created.alert.id,
      expectedVersion: 1,
      definition: replacement,
    });
    expect(updated).toMatchObject({
      assetKey: "ETH",
      condition: "at_or_below",
      recordVersion: 2,
    });
    await expect(
      repository.replaceOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
        definition: replacement,
      }),
    ).resolves.toMatchObject({ recordVersion: 2 });
    await expect(
      repository.replaceOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
        definition,
      }),
    ).rejects.toBeInstanceOf(AlertVersionConflictError);
  });

  it("uses the database clock to reject an expired replacement", async () => {
    const ownerUserId = await createOwner(pool, "replace-expired");
    const created = await repository.create(createInput(ownerUserId));
    const expired = {
      ...definition,
      expires_at: "2000-01-01T00:00:00.000Z",
    } satisfies PriceAlertDefinition;

    await expect(
      repository.replaceOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
        definition: expired,
      }),
    ).rejects.toBeInstanceOf(AlertExpiryNotFutureError);
    await expect(
      repository.findOwned(ownerUserId, created.alert.id),
    ).resolves.toMatchObject({ recordVersion: 1, expiresAt: null });
  });

  it("serializes divergent replacements from one version", async () => {
    const ownerUserId = await createOwner(pool, "replace-race");
    const created = await repository.create(createInput(ownerUserId));
    const results = await Promise.allSettled([
      repository.replaceOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
        definition: { ...definition, threshold_decimal: "65000" },
      }),
      repository.replaceOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
        definition: { ...definition, threshold_decimal: "66000" },
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(AlertVersionConflictError);
  });

  it("soft-deletes without enumerating foreign, absent, or repeated targets", async () => {
    const ownerUserId = await createOwner(pool, "delete-owner");
    const foreignOwnerUserId = await createOwner(pool, "delete-foreign");
    const createRequest = createInput(ownerUserId);
    const created = await repository.create(createRequest);

    await expect(
      repository.softDeleteOwned({
        ownerUserId: foreignOwnerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.softDeleteOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(AlertVersionConflictError);
    await expect(
      repository.softDeleteOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.softDeleteOwned({
        ownerUserId,
        alertId: created.alert.id,
        expectedVersion: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.findOwned(ownerUserId, created.alert.id),
    ).resolves.toBeNull();
    await expect(repository.create(createRequest)).rejects.toBeInstanceOf(
      AlertIdempotencyResourceDeletedError,
    );
  });

  it("versions the exact preference set atomically with identical retry", async () => {
    const ownerUserId = await createOwner(pool, "preferences");
    const foreignOwnerUserId = await createOwner(pool, "preferences-foreign");
    const desired = desiredPreferences("price_alert_triggered");

    const first = await repository.replaceNotificationPreferences({
      ownerUserId,
      expectedVersion: 0,
      preferences: desired,
    });
    expect(first).toEqual({ recordVersion: 1, preferences: desired });
    await expect(
      repository.replaceNotificationPreferences({
        ownerUserId,
        expectedVersion: 0,
        preferences: desired,
      }),
    ).resolves.toEqual({ recordVersion: 1, preferences: desired });
    await expect(
      repository.replaceNotificationPreferences({
        ownerUserId,
        expectedVersion: 0,
        preferences: desiredPreferences("security_notice"),
      }),
    ).rejects.toBeInstanceOf(AlertVersionConflictError);
    await expect(
      repository.getNotificationPreferences(ownerUserId),
    ).resolves.toEqual({ recordVersion: 1, preferences: desired });
    await expect(
      repository.getNotificationPreferences(foreignOwnerUserId),
    ).resolves.toEqual({
      recordVersion: 0,
      preferences: notificationEventTypes.map((eventType) => ({
        event_type: eventType,
        enabled: false,
      })),
    });
  });

  it("allows one of two concurrent divergent preference snapshots", async () => {
    const ownerUserId = await createOwner(pool, "preference-race");
    const results = await Promise.allSettled([
      repository.replaceNotificationPreferences({
        ownerUserId,
        expectedVersion: 0,
        preferences: desiredPreferences("security_notice"),
      }),
      repository.replaceNotificationPreferences({
        ownerUserId,
        expectedVersion: 0,
        preferences: desiredPreferences("support_update"),
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected") {
      throw new Error("Expected one version-conflict rejection");
    }
    expect(rejected.reason as unknown).toBeInstanceOf(
      AlertVersionConflictError,
    );
  });

  it("reads only persisted owner history newest first with stable pagination", async () => {
    const ownerUserId = await createOwner(pool, "history-owner");
    const foreignOwnerUserId = await createOwner(pool, "history-foreign");
    const alert = (await repository.create(createInput(ownerUserId))).alert;
    const foreignAlert = (
      await repository.create(createInput(foreignOwnerUserId))
    ).alert;
    const olderId = randomUUID();
    const newerId = randomUUID();
    await pool.query({
      text: `
        insert into public.price_alert_events (
          id, owner_user_id, alert_id, asset_key, condition,
          threshold_decimal, value_decimal, source, source_fact_ref,
          observed_at, created_at
        ) values
          ($1, $2, $3, 'BTC', 'above', '64000.00', '65000.00',
           'test_evaluator', 'fact:test:older',
           clock_timestamp() - interval '2 seconds',
           clock_timestamp() - interval '1 second'),
          ($4, $2, $3, 'BTC', 'above', '64000.00', '66000.00',
           'test_evaluator', 'fact:test:newer',
           clock_timestamp() - interval '1 second', clock_timestamp()),
          ($5, $6, $7, 'ETH', 'below', '3000', '2900',
           'test_evaluator', 'fact:test:foreign',
           clock_timestamp() - interval '1 second', clock_timestamp())
      `,
      values: [
        olderId,
        ownerUserId,
        alert.id,
        newerId,
        randomUUID(),
        foreignOwnerUserId,
        foreignAlert.id,
      ],
    });

    const firstPage = await repository.listHistory({
      ownerUserId,
      limit: 1,
      offset: 0,
    });
    const secondPage = await repository.listHistory({
      ownerUserId,
      limit: 1,
      offset: 1,
    });
    expect(firstPage).toMatchObject({
      records: [
        {
          id: newerId,
          alertId: alert.id,
          valueDecimal: "66000.00",
          source: "test_evaluator",
          sourceFactRef: "fact:test:newer",
        },
      ],
      nextOffset: 1,
    });
    expect(secondPage).toMatchObject({
      records: [{ id: olderId }],
      nextOffset: null,
    });

    await expect(
      repository.softDeleteOwned({
        ownerUserId,
        alertId: alert.id,
        expectedVersion: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.listHistory({ ownerUserId, limit: 50, offset: 0 }),
    ).resolves.toMatchObject({ records: [{ id: newerId }, { id: olderId }] });
    await expect(
      pool.query({
        text: `
          update public.price_alert_events
          set source_fact_ref = 'fact:test:mutated'
          where id = $1
        `,
        values: [newerId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `delete from public.price_alert_events where id = $1`,
        values: [newerId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
