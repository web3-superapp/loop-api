import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  IdempotencyConflictError,
  InvalidProviderOperationStateError,
  IssuanceQuotaExceededError,
  StaleProviderOperationLeaseError,
  type PrepareProviderOperationInput,
} from "../src/database/control-plane-repository.js";
import {
  createPostgresDatabase,
  type Database,
} from "../src/database/database.js";
import { latestMigrationName } from "../src/database/schema.js";

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
const ipSubjectHmac = "c".repeat(64);
const userSubjectHmac = "d".repeat(64);

const truncateControlPlane = `
  truncate table
    public.chat_operation_events,
    public.communication_group_members,
    public.direct_channels,
    public.social_operation_events,
    public.social_operations,
    public.friendships,
    public.friend_requests,
    public.social_privacy_preferences,
    public.chat_operations,
    public.price_alert_events,
    public.notification_preferences,
    public.notification_preference_versions,
    public.price_alert_definitions,
    public.watchlist_items,
    public.watchlist_groups,
    public.watchlist_versions,
    public.group_alias_reservations,
    public.communication_groups,
    public.privacy_preferences,
    public.user_profiles,
    public.spot_agent_authorization_events,
    public.spot_intent_events,
    public.spot_agent_identity_events,
    public.hyperliquid_signer_nonce_allocations,
    public.hyperliquid_signer_nonce_state,
    public.spot_agent_authorizations,
    public.spot_intents,
    public.spot_agent_identities,
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

function prepareInput(
  ownerUserId: string,
  overrides: Partial<PrepareProviderOperationInput> = {},
): PrepareProviderOperationInput {
  return {
    ownerUserId,
    scope: "perp_order_submit",
    idempotencyKey: randomUUID(),
    keySource: "client",
    requestSha256: digestA,
    domain: "hyperliquid",
    operationKind: "perp_order_submit",
    requestId: randomUUID(),
    ...overrides,
  };
}

describe("PostgreSQL control-plane repository", () => {
  let database: Database;
  const inspectionPool = new Pool({ connectionString: databaseUrl });

  beforeAll(() => {
    database = createPostgresDatabase(config, logger);
  });

  beforeEach(async () => {
    await inspectionPool.query(truncateControlPlane);
  });

  afterAll(async () => {
    await database.close();
    await inspectionPool.query(truncateControlPlane);
    await inspectionPool.end();
  });

  it("reports ready only at the current migration head", async () => {
    await expect(database.ping()).resolves.toBeUndefined();

    const migration = await inspectionPool.query<{ name: string }>({
      text: `
        select name
        from public.pgmigrations
        order by id desc
        limit 1
      `,
    });

    expect(migration.rows[0]?.name).toBe(latestMigrationName);
  });

  it("installs the time-leading issuance quota cleanup index", async () => {
    const index = await inspectionPool.query<{ indexdef: string }>({
      text: `
        select indexdef
        from pg_indexes
        where schemaname = 'public'
          and tablename = 'issuance_rate_records'
          and indexname = 'issuance_rate_records_cleanup_idx'
      `,
    });

    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toMatch(
      /\(window_started_at, capability, policy_version, subject_kind, subject_hmac\)$/,
    );
  });

  it.each([
    ["invalid request UUID", { requestId: "not-a-uuid", limit: 1 }],
    ["zero limit", { requestId: randomUUID(), limit: 0 }],
    ["oversized limit", { requestId: randomUUID(), limit: 1_001 }],
  ] as const)("rejects %s before quota cleanup SQL", async (_name, input) => {
    await expect(
      database.controlPlane.deleteExpiredIssuanceQuotaRecords(input),
    ).rejects.toHaveProperty("name", "ZodError");

    const records = await inspectionPool.query<{ count: string }>({
      text: "select count(*)::text as count from public.issuance_rate_records",
    });
    expect(records.rows[0]).toEqual({ count: "0" });
  });

  it("creates one operation for concurrent identical idempotent requests", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:concurrent-operation",
    );
    const input = prepareInput(owner.id, {
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        database.controlPlane.prepareProviderOperation(input),
      ),
    );
    const counts = await inspectionPool.query<{
      audit_count: string;
      idempotency_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.audit_events)
            as audit_count
      `,
    });

    expect(new Set(results.map(({ operation }) => operation.id)).size).toBe(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(counts.rows[0]).toEqual({
      audit_count: "1",
      idempotency_count: "1",
      operation_count: "1",
    });
  });

  it("rejects reuse of a scoped key with another digest or owner", async () => {
    const firstOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:idempotency-owner-one",
    );
    const secondOwner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:idempotency-owner-two",
    );
    const idempotencyKey = randomUUID();
    const original = prepareInput(firstOwner.id, { idempotencyKey });

    await database.controlPlane.prepareProviderOperation(original);

    await expect(
      database.controlPlane.prepareProviderOperation({
        ...original,
        requestSha256: digestB,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      database.controlPlane.prepareProviderOperation({
        ...original,
        ownerUserId: secondOwner.id,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const counts = await inspectionPool.query<{
      idempotency_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.idempotency_records)
            as idempotency_count
      `,
    });
    expect(counts.rows[0]).toEqual({
      idempotency_count: "1",
      operation_count: "1",
    });
  });

  it("enforces one submission and fenced reconciliation through reschedule", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:reconciliation-lifecycle",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const submitting =
      await database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      });

    expect(submitting).toMatchObject({
      state: "submitting",
      attemptCount: 1,
      recordVersion: "1",
      fenceToken: "0",
    });
    expect(submitting.transportAttemptId).not.toBeNull();
    await expect(
      database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(InvalidProviderOperationStateError);

    const unknown = await database.controlPlane.markProviderOperationUnknown({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      transportAttemptId: submitting.transportAttemptId ?? "",
      recordVersion: submitting.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_timeout",
      retryDelayMs: 0,
    });
    expect(unknown).toMatchObject({
      state: "unknown",
      reconciliationStatus: "pending",
      attemptCount: 1,
      reconciliationAttemptCount: 0,
      recordVersion: "2",
      fenceToken: "0",
    });

    const firstWorkerId = randomUUID();
    const firstLease = (
      await database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId: firstWorkerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    expect(firstLease).toMatchObject({
      reconciliationStatus: "leased",
      reconciliationAttemptCount: 1,
      leaseOwner: firstWorkerId,
      recordVersion: "3",
      fenceToken: "1",
    });

    const rescheduled =
      await database.controlPlane.rescheduleProviderOperationReconciliation({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        workerId: firstWorkerId,
        fenceToken: firstLease?.fenceToken ?? "",
        recordVersion: firstLease?.recordVersion ?? "",
        requestId: randomUUID(),
        reasonCode: "provider_pending",
        retryDelayMs: 60_000,
      });
    expect(rescheduled).toMatchObject({
      reconciliationStatus: "pending",
      reconciliationAttemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      recordVersion: "4",
      fenceToken: "1",
    });

    await expect(
      database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId: randomUUID(),
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual([]);

    await inspectionPool.query({
      text: `
        update public.provider_operations
        set reconcile_after = clock_timestamp() - interval '1 millisecond'
        where id = $1
      `,
      values: [prepared.operation.id],
    });

    const secondWorkerId = randomUUID();
    const secondLease = (
      await database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId: secondWorkerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    expect(secondLease).toMatchObject({
      reconciliationStatus: "leased",
      reconciliationAttemptCount: 2,
      leaseOwner: secondWorkerId,
      recordVersion: "5",
      fenceToken: "2",
    });

    await expect(
      database.controlPlane.completeProviderOperationReconciliation({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        workerId: firstWorkerId,
        fenceToken: firstLease?.fenceToken ?? "",
        recordVersion: firstLease?.recordVersion ?? "",
        requestId: randomUUID(),
        state: "succeeded",
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);

    const completed =
      await database.controlPlane.completeProviderOperationReconciliation({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        workerId: secondWorkerId,
        fenceToken: secondLease?.fenceToken ?? "",
        recordVersion: secondLease?.recordVersion ?? "",
        requestId: randomUUID(),
        state: "succeeded",
      });
    expect(completed).toMatchObject({
      state: "succeeded",
      reconciliationStatus: "complete",
      reconciliationAttemptCount: 2,
      reconcileAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      recordVersion: "6",
      fenceToken: "2",
    });
    await expect(
      database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(InvalidProviderOperationStateError);
    await expect(
      database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId: randomUUID(),
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual([]);
  });

  it("quarantines an expired submission without allowing a second submit", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:expired-submission",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const submitting =
      await database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      });

    await inspectionPool.query({
      text: `
        update public.provider_operations
        set attempt_deadline_at = attempt_committed_at + interval '1 microsecond'
        where id = $1
      `,
      values: [prepared.operation.id],
    });

    const quarantined =
      await database.controlPlane.quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      id: prepared.operation.id,
      state: "unknown",
      attemptCount: 1,
      transportAttemptId: submitting.transportAttemptId,
      reconciliationStatus: "pending",
      recordVersion: "2",
    });
    await expect(
      database.controlPlane.quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(InvalidProviderOperationStateError);
  });

  it("allows only one of two concurrent submission transitions", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:concurrent-submission",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, async () =>
        database.controlPlane.markProviderOperationSubmitting({
          ownerUserId: owner.id,
          operationId: prepared.operation.id,
          requestId: randomUUID(),
          attemptDurationMs: 60_000,
        }),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(
      InvalidProviderOperationStateError,
    );

    const persisted = await database.controlPlane.findProviderOperation(
      owner.id,
      prepared.operation.id,
    );
    expect(persisted).toMatchObject({
      state: "submitting",
      attemptCount: 1,
      recordVersion: "1",
    });
  });

  it("allows only one worker to lease the same due operation", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:concurrent-reconciliation-lease",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const submitting =
      await database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      });
    await database.controlPlane.markProviderOperationUnknown({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      transportAttemptId: submitting.transportAttemptId ?? "",
      recordVersion: submitting.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_timeout",
      retryDelayMs: 0,
    });

    const leases = await Promise.all(
      [randomUUID(), randomUUID()].map(async (workerId) =>
        database.controlPlane.leaseProviderOperationsForReconciliation({
          workerId,
          requestId: randomUUID(),
          limit: 1,
          leaseDurationMs: 30_000,
        }),
      ),
    );

    expect(leases.flat()).toHaveLength(1);
    expect(leases.filter((lease) => lease.length === 1)).toHaveLength(1);
    expect(leases.filter((lease) => lease.length === 0)).toHaveLength(1);
  });

  it("reclaims an expired lease with a new fence and rejects the old worker", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:expired-lease-reclaim",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const submitting =
      await database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      });
    await database.controlPlane.markProviderOperationUnknown({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      transportAttemptId: submitting.transportAttemptId ?? "",
      recordVersion: submitting.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_timeout",
      retryDelayMs: 0,
    });
    const firstWorkerId = randomUUID();
    const firstLease = (
      await database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId: firstWorkerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    await inspectionPool.query({
      text: `
        update public.provider_operations
        set lease_expires_at = clock_timestamp() - interval '1 millisecond'
        where id = $1
      `,
      values: [prepared.operation.id],
    });

    const secondWorkerId = randomUUID();
    const secondLease = (
      await database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId: secondWorkerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    expect(secondLease).toMatchObject({
      leaseOwner: secondWorkerId,
      reconciliationStatus: "leased",
      reconciliationAttemptCount: 2,
      fenceToken: "2",
      recordVersion: "4",
    });
    await expect(
      database.controlPlane.completeProviderOperationReconciliation({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        workerId: firstWorkerId,
        fenceToken: firstLease?.fenceToken ?? "",
        recordVersion: firstLease?.recordVersion ?? "",
        requestId: randomUUID(),
        state: "succeeded",
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);

    const leaseAudits = await inspectionPool.query<{
      from_reconciliation_status: string;
      operation_version: string;
    }>({
      text: `
        select
          from_reconciliation_status,
          operation_version::text as operation_version
        from public.audit_events
        where operation_id = $1 and event_type = 'reconciliation_leased'
        order by operation_version
      `,
      values: [prepared.operation.id],
    });
    expect(leaseAudits.rows).toEqual([
      { from_reconciliation_status: "pending", operation_version: "3" },
      { from_reconciliation_status: "leased", operation_version: "4" },
    ]);
  });

  it("rejects a completion blocked until after its lease expires", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:wall-clock-lease-expiry",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const submitting =
      await database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      });
    await database.controlPlane.markProviderOperationUnknown({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      transportAttemptId: submitting.transportAttemptId ?? "",
      recordVersion: submitting.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_timeout",
      retryDelayMs: 0,
    });
    const workerId = randomUUID();
    const lease = (
      await database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    await inspectionPool.query({
      text: `
        update public.provider_operations
        set lease_expires_at = clock_timestamp() + interval '1 second'
        where id = $1
      `,
      values: [prepared.operation.id],
    });

    const locker = await inspectionPool.connect();
    let lockerOpen = false;

    try {
      await locker.query("begin");
      lockerOpen = true;
      await locker.query({
        text: `
          select id
          from public.provider_operations
          where id = $1
          for update
        `,
        values: [prepared.operation.id],
      });

      const completion =
        database.controlPlane.completeProviderOperationReconciliation({
          ownerUserId: owner.id,
          operationId: prepared.operation.id,
          workerId,
          fenceToken: lease?.fenceToken ?? "",
          recordVersion: lease?.recordVersion ?? "",
          requestId: randomUUID(),
          state: "succeeded",
        });
      let waiterObserved = false;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const waiting = await inspectionPool.query<{ waiting: boolean }>({
          text: `
            select exists (
              select 1
              from pg_stat_activity
              where datname = current_database()
                and wait_event_type = 'Lock'
                and query like '%loop_complete_provider_operation_reconciliation%'
            ) as waiting
          `,
        });
        waiterObserved = waiting.rows[0]?.waiting === true;
        if (waiterObserved) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(waiterObserved).toBe(true);
      await inspectionPool.query("select pg_sleep(1.1)");
      await locker.query("commit");
      lockerOpen = false;
      await expect(completion).rejects.toBeInstanceOf(
        StaleProviderOperationLeaseError,
      );
    } finally {
      if (lockerOpen) {
        await locker.query("rollback");
      }
      locker.release();
    }
  });

  it("holds an unknown operation for an operator without leasing it again", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:operator-hold",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const submitting =
      await database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      });
    await database.controlPlane.markProviderOperationUnknown({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      transportAttemptId: submitting.transportAttemptId ?? "",
      recordVersion: submitting.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_timeout",
      retryDelayMs: 0,
    });

    const workerId = randomUUID();
    const lease = (
      await database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    const held = await database.controlPlane.holdProviderOperationForOperator({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      workerId,
      fenceToken: lease?.fenceToken ?? "",
      recordVersion: lease?.recordVersion ?? "",
      requestId: randomUUID(),
      reasonCode: "reconciler_unavailable",
    });

    expect(held).toMatchObject({
      state: "unknown",
      reconciliationStatus: "operator_required",
      reconcileAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      recordVersion: "4",
      fenceToken: "1",
    });
    expect(held.operatorRequiredAt).not.toBeNull();
    await expect(
      database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId: randomUUID(),
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual([]);
  });

  it("consumes concurrent multi-bucket issuance quota atomically", async () => {
    const input = {
      capability: "stream_token",
      policyVersion: "policy_v1",
      buckets: [
        {
          subjectKind: "ip",
          subjectHmac: ipSubjectHmac,
          windowDurationSeconds: 60,
          capacity: 5,
        },
        {
          subjectKind: "user",
          subjectHmac: userSubjectHmac,
          windowDurationSeconds: 60,
          capacity: 3,
        },
      ],
    } as const;

    const attempts = await Promise.all(
      Array.from({ length: 20 }, async (_value, index) => {
        try {
          const consumption = await database.controlPlane.consumeIssuanceQuota({
            ...input,
            buckets:
              index % 2 === 0 ? input.buckets : [...input.buckets].reverse(),
          });
          return { ok: true as const, consumption };
        } catch (error: unknown) {
          return { ok: false as const, error };
        }
      }),
    );
    const succeeded = attempts.filter(({ ok }) => ok);
    const rejected = attempts.filter(({ ok }) => !ok);

    expect(succeeded).toHaveLength(3);
    expect(rejected).toHaveLength(17);
    for (const result of succeeded) {
      expect(result.consumption).toHaveLength(2);
    }
    for (const result of rejected) {
      expect(result.error).toBeInstanceOf(IssuanceQuotaExceededError);
    }

    const counters = await inspectionPool.query<{
      capacity: number;
      issued_count: number;
      subject_kind: string;
    }>({
      text: `
        select subject_kind, capacity, issued_count
        from public.issuance_rate_records
        order by subject_kind
      `,
    });
    expect(counters.rows).toEqual([
      { capacity: 5, issued_count: 3, subject_kind: "ip" },
      { capacity: 3, issued_count: 3, subject_kind: "user" },
    ]);
  });

  it("charges a weighted cost atomically without partially consuming buckets", async () => {
    const input = {
      capability: "hyperliquid_info",
      policyVersion: "hyperliquid_info_v1",
      cost: 20,
      buckets: [
        {
          subjectKind: "global",
          subjectHmac: ipSubjectHmac,
          windowDurationSeconds: 60,
          capacity: 60,
        },
        {
          subjectKind: "user",
          subjectHmac: userSubjectHmac,
          windowDurationSeconds: 60,
          capacity: 40,
        },
      ],
    } as const;

    await expect(
      database.controlPlane.consumeIssuanceQuota(input),
    ).resolves.toEqual([
      expect.objectContaining({ subjectKind: "global", issuedCount: 20 }),
      expect.objectContaining({ subjectKind: "user", issuedCount: 20 }),
    ]);
    await expect(
      database.controlPlane.consumeIssuanceQuota(input),
    ).resolves.toEqual([
      expect.objectContaining({ subjectKind: "global", issuedCount: 40 }),
      expect.objectContaining({ subjectKind: "user", issuedCount: 40 }),
    ]);
    await expect(
      database.controlPlane.consumeIssuanceQuota(input),
    ).rejects.toBeInstanceOf(IssuanceQuotaExceededError);

    const counters = await inspectionPool.query<{
      issued_count: number;
      subject_kind: string;
    }>({
      text: `
        select subject_kind, issued_count
        from public.issuance_rate_records
        where capability = 'hyperliquid_info'
        order by subject_kind
      `,
    });
    expect(counters.rows).toEqual([
      { issued_count: 40, subject_kind: "global" },
      { issued_count: 40, subject_kind: "user" },
    ]);
  });

  it("deletes only quota windows retained for seven complete days", async () => {
    await inspectionPool.query({
      text: `
        insert into public.issuance_rate_records (
          capability,
          policy_version,
          subject_kind,
          subject_hmac,
          window_started_at,
          window_duration_seconds,
          capacity,
          issued_count
        )
        values
          (
            'stream_chat_token', 'stream_token_v1', 'ip', $1,
            clock_timestamp() - interval '7 days 2 minutes',
            60, 10, 1
          ),
          (
            'stream_chat_token', 'stream_token_v1', 'ip', $2,
            clock_timestamp() - interval '7 days 30 seconds',
            60, 10, 1
          ),
          (
            'stream_video_token', 'stream_token_v1', 'user', $3,
            clock_timestamp()
              - interval '7 days 23 hours 59 minutes',
            86400, 10, 1
          ),
          (
            'stream_video_token', 'stream_token_v1', 'user', $4,
            date_trunc('minute', clock_timestamp()),
            60, 10, 1
          )
      `,
      values: ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)],
    });

    await expect(
      database.controlPlane.deleteExpiredIssuanceQuotaRecords({
        requestId: randomUUID(),
        limit: 1_000,
      }),
    ).resolves.toEqual({ deletedCount: 1 });

    const retained = await inspectionPool.query<{ subject_hmac: string }>({
      text: `
        select subject_hmac
        from public.issuance_rate_records
        order by subject_hmac
      `,
    });
    expect(retained.rows).toEqual([
      { subject_hmac: "2".repeat(64) },
      { subject_hmac: "3".repeat(64) },
      { subject_hmac: "4".repeat(64) },
    ]);
  });

  it("uses skip-locked bounded batches across concurrent cleanup replicas", async () => {
    await inspectionPool.query({
      text: `
        insert into public.issuance_rate_records (
          capability,
          policy_version,
          subject_kind,
          subject_hmac,
          window_started_at,
          window_duration_seconds,
          capacity,
          issued_count
        )
        select
          'stream_chat_token',
          'stream_token_v1',
          'ip',
          lpad(to_hex(sequence), 64, '0'),
          clock_timestamp() - interval '8 days',
          60,
          10,
          1
        from generate_series(1, 1005) as sequence
      `,
    });

    const results = await Promise.all([
      database.controlPlane.deleteExpiredIssuanceQuotaRecords({
        requestId: randomUUID(),
        limit: 600,
      }),
      database.controlPlane.deleteExpiredIssuanceQuotaRecords({
        requestId: randomUUID(),
        limit: 600,
      }),
    ]);
    const deletedCounts = results.map(({ deletedCount }) => deletedCount);
    expect(deletedCounts.every((deletedCount) => deletedCount <= 600)).toBe(
      true,
    );
    expect(deletedCounts.reduce((total, value) => total + value, 0)).toBe(
      1_005,
    );

    const remaining = await inspectionPool.query<{ count: string }>({
      text: "select count(*)::text as count from public.issuance_rate_records",
    });
    expect(remaining.rows[0]).toEqual({ count: "0" });
  });

  it("skips a locked expired row without delaying cleanup of another row", async () => {
    const lockedSubjectHmac = "5".repeat(64);
    const availableSubjectHmac = "6".repeat(64);
    await inspectionPool.query({
      text: `
        insert into public.issuance_rate_records (
          capability,
          policy_version,
          subject_kind,
          subject_hmac,
          window_started_at,
          window_duration_seconds,
          capacity,
          issued_count
        )
        values
          (
            'stream_chat_token', 'stream_token_v1', 'ip', $1,
            clock_timestamp() - interval '8 days', 60, 10, 1
          ),
          (
            'stream_chat_token', 'stream_token_v1', 'ip', $2,
            clock_timestamp() - interval '8 days', 60, 10, 1
          )
      `,
      values: [lockedSubjectHmac, availableSubjectHmac],
    });
    const lockedClient = await inspectionPool.connect();
    let transactionOpen = false;

    try {
      await lockedClient.query("begin");
      transactionOpen = true;
      await lockedClient.query({
        text: `
          select subject_hmac
          from public.issuance_rate_records
          where subject_hmac = $1
          for update
        `,
        values: [lockedSubjectHmac],
      });

      await expect(
        database.controlPlane.deleteExpiredIssuanceQuotaRecords({
          requestId: randomUUID(),
          limit: 1_000,
        }),
      ).resolves.toEqual({ deletedCount: 1 });

      const whileLocked = await lockedClient.query<{ subject_hmac: string }>({
        text: `
          select subject_hmac
          from public.issuance_rate_records
          order by subject_hmac
        `,
      });
      expect(whileLocked.rows).toEqual([{ subject_hmac: lockedSubjectHmac }]);

      await lockedClient.query("commit");
      transactionOpen = false;
      await expect(
        database.controlPlane.deleteExpiredIssuanceQuotaRecords({
          requestId: randomUUID(),
          limit: 1_000,
        }),
      ).resolves.toEqual({ deletedCount: 1 });
    } finally {
      if (transactionOpen) {
        await lockedClient.query("rollback");
      }
      lockedClient.release();
    }
  });

  it("keeps a versioned append-only audit without JSON or raw payload fields", async () => {
    const owner = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:audit-contract",
    );
    const prepared = await database.controlPlane.prepareProviderOperation(
      prepareInput(owner.id),
    );
    const submitting =
      await database.controlPlane.markProviderOperationSubmitting({
        ownerUserId: owner.id,
        operationId: prepared.operation.id,
        requestId: randomUUID(),
        attemptDurationMs: 60_000,
      });
    await database.controlPlane.markProviderOperationUnknown({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      transportAttemptId: submitting.transportAttemptId ?? "",
      recordVersion: submitting.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_timeout",
      retryDelayMs: 0,
    });
    const workerId = randomUUID();
    const lease = (
      await database.controlPlane.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    await database.controlPlane.holdProviderOperationForOperator({
      ownerUserId: owner.id,
      operationId: prepared.operation.id,
      workerId,
      fenceToken: lease?.fenceToken ?? "",
      recordVersion: lease?.recordVersion ?? "",
      requestId: randomUUID(),
      reasonCode: "reconciler_unavailable",
    });

    const events = await inspectionPool.query<{
      event_type: string;
      operation_version: string;
      reason_code: string | null;
    }>({
      text: `
        select
          event_type,
          operation_version::text as operation_version,
          reason_code
        from public.audit_events
        where operation_id = $1
        order by operation_version
      `,
      values: [prepared.operation.id],
    });
    expect(events.rows).toEqual([
      {
        event_type: "operation_prepared",
        operation_version: "0",
        reason_code: null,
      },
      {
        event_type: "provider_submission_started",
        operation_version: "1",
        reason_code: null,
      },
      {
        event_type: "provider_submission_unknown",
        operation_version: "2",
        reason_code: "provider_timeout",
      },
      {
        event_type: "reconciliation_leased",
        operation_version: "3",
        reason_code: null,
      },
      {
        event_type: "reconciliation_operator_required",
        operation_version: "4",
        reason_code: "reconciler_unavailable",
      },
    ]);

    const auditColumns = await inspectionPool.query<{
      column_name: string;
      data_type: string;
    }>({
      text: `
        select column_name, data_type
        from information_schema.columns
        where table_schema = 'public' and table_name = 'audit_events'
        order by ordinal_position
      `,
    });
    expect(auditColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "id",
      "owner_user_id",
      "operation_id",
      "request_id",
      "actor_type",
      "event_type",
      "from_state",
      "to_state",
      "from_reconciliation_status",
      "to_reconciliation_status",
      "outcome",
      "reason_code",
      "operation_version",
      "fence_token",
      "transport_attempt_id",
      "occurred_at",
    ]);
    expect(
      auditColumns.rows.some(({ data_type }) =>
        ["json", "jsonb"].includes(data_type),
      ),
    ).toBe(false);
    expect(
      auditColumns.rows.some(({ column_name }) =>
        /body|metadata|payload|provider_response|secret|signature/.test(
          column_name,
        ),
      ),
    ).toBe(false);

    const auditEventId = await inspectionPool.query<{ id: string }>({
      text: `
        select id
        from public.audit_events
        where operation_id = $1
        order by operation_version
        limit 1
      `,
      values: [prepared.operation.id],
    });
    await expect(
      inspectionPool.query({
        text: "update public.audit_events set outcome = 'changed' where id = $1",
        values: [auditEventId.rows[0]?.id],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      inspectionPool.query({
        text: "delete from public.audit_events where id = $1",
        values: [auditEventId.rows[0]?.id],
      }),
    ).rejects.toMatchObject({ code: "55000" });

    const count = await inspectionPool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.audit_events
        where operation_id = $1
      `,
      values: [prepared.operation.id],
    });
    expect(count.rows[0]?.count).toBe("5");
  });
});
