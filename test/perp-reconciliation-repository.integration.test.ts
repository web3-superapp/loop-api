import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { StaleProviderOperationLeaseError } from "../src/database/control-plane-repository.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import type { PreparePerpIntentInput } from "../src/database/perp-intent-repository.js";
import { PerpReconciliationRepositoryUnavailableError } from "../src/database/perp-reconciliation-repository.js";
import type { PerpOrderReconciliationResolution } from "../src/features/perp/perp-reconciliation-contract.js";

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
const requestSha256 = "a".repeat(64);
const reviewSha256 = "b".repeat(64);
const accountAddress = "0x1111111111111111111111111111111111111111";
const generatedClientOrderId = "0x11111111111111111111111111111111";

const truncateAll = `
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
    public.device_session_events,
    public.device_session_commands,
    public.device_sessions,
    public.loop_users
`;

function prepareInput(
  ownerUserId: string,
  orderType: "limit" | "market" = "limit",
): PreparePerpIntentInput {
  const now = Date.now();
  const fetchedAt = new Date(now - 500).toISOString();
  const expiresAt = new Date(
    now + (orderType === "limit" ? 55_000 : 1_000),
  ).toISOString();
  const canonicalAction =
    orderType === "limit"
      ? {
          action: "order" as const,
          coin: "BTC" as const,
          side: "buy" as const,
          order_type: "limit" as const,
          size: "0.01",
          limit_price: "50000",
          time_in_force: "gtc" as const,
          reduce_only: false,
        }
      : {
          action: "order" as const,
          coin: "BTC" as const,
          side: "buy" as const,
          order_type: "market" as const,
          size: "0.01",
          max_slippage_percent: "0.5",
          reduce_only: false,
        };
  const reviewAction =
    canonicalAction.order_type === "limit"
      ? { ...canonicalAction, client_order_id: generatedClientOrderId }
      : {
          ...canonicalAction,
          final_limit_price: "50500",
          client_order_id: generatedClientOrderId,
        };

  return {
    ownerUserId,
    idempotencyKey: randomUUID(),
    requestSha256,
    requestId: randomUUID(),
    accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    action: "order",
    canonicalAction,
    publicReview: {
      version: "perp_review_v1",
      provider: "hyperliquid",
      network: "testnet",
      market: "core_perps",
      dex: "",
      action: reviewAction,
      source: { fetched_at: fetchedAt, expires_at: expiresAt },
    },
    reviewSha256,
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
  };
}

async function seedWalletBinding(
  pool: InstanceType<typeof Pool>,
  ownerUserId: string,
): Promise<void> {
  const result = await pool.query({
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
        owner.id,
        owner.privy_user_id,
        'bound',
        null,
        $2,
        'master',
        1,
        observed.observed_at,
        observed.observed_at,
        observed.observed_at
      from public.loop_users as owner
      cross join observed
      where owner.id = $1
      returning owner_user_id
    `,
    values: [ownerUserId, accountAddress],
  });
  expect(result.rows).toHaveLength(1);
}

async function markIntentUnknown(
  pool: InstanceType<typeof Pool>,
  ownerUserId: string,
  intentId: string,
): Promise<void> {
  const result = await pool.query({
    text: `
      with changed as (
        update public.perp_intents
        set
          state = 'unknown',
          record_version = record_version + 1,
          updated_at = clock_timestamp()
        where id = $1
          and owner_user_id = $2
          and state = 'prepared'
        returning id, owner_user_id, record_version
      )
      insert into public.perp_intent_events (
        intent_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        reason_code,
        intent_version
      )
      select
        id, owner_user_id, $3, 'api', 'intent_submission_unknown',
        'prepared', 'unknown', 'unknown', 'submission_unknown', record_version
      from changed
    `,
    values: [intentId, ownerUserId, randomUUID()],
  });
  expect(result.rowCount).toBe(1);
}

interface LeasedIntent {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly workerId: string;
  readonly fenceToken: string;
  readonly recordVersion: string;
  readonly intentRecordVersion: string;
}

interface FinalizedProjectionRow {
  readonly operation_state: string;
  readonly reconciliation_status: string;
  readonly lease_owner: string | null;
  readonly operation_version: string;
  readonly intent_state: string;
  readonly intent_version: string;
  readonly result_observed_at: Date;
  readonly item_state: string;
  readonly result_order_id: string | null;
  readonly result_client_order_id: string | null;
  readonly filled_size: string | null;
  readonly average_fill_price: string | null;
  readonly observed_at: Date;
  readonly audit_request_id: string;
  readonly audit_outcome: string;
  readonly audit_version: string;
  readonly event_request_id: string;
  readonly event_outcome: string;
  readonly event_version: string;
}

async function prepareLeasedIntent(
  database: PostgresDatabase,
  inspectionPool: InstanceType<typeof Pool>,
  orderType: "limit" | "market" = "limit",
): Promise<LeasedIntent> {
  const owner = await database.internalUsers.getOrCreateByPrivyUserId(
    `did:privy:perp-reconciliation-${randomUUID()}`,
  );
  await seedWalletBinding(inspectionPool, owner.id);
  const prepared = await database.perpIntents.prepare(
    prepareInput(owner.id, orderType),
  );
  const submitting =
    await database.controlPlane.markProviderOperationSubmitting({
      ownerUserId: owner.id,
      operationId: prepared.intent.id,
      requestId: randomUUID(),
      attemptDurationMs: 10_000,
    });
  if (submitting.transportAttemptId === null) {
    throw new Error("The test submission did not receive a transport attempt");
  }
  await database.controlPlane.markProviderOperationUnknown({
    ownerUserId: owner.id,
    operationId: prepared.intent.id,
    requestId: randomUUID(),
    transportAttemptId: submitting.transportAttemptId,
    recordVersion: submitting.recordVersion,
    reasonCode: "submission_unknown",
    retryDelayMs: 0,
  });
  await markIntentUnknown(inspectionPool, owner.id, prepared.intent.id);
  const workerId = randomUUID();
  const leased =
    await database.controlPlane.leaseProviderOperationsForReconciliation({
      workerId,
      requestId: randomUUID(),
      limit: 1,
      leaseDurationMs: 30_000,
    });
  const operation = leased[0];
  if (operation === undefined) {
    throw new Error("The test operation was not leased");
  }
  const subject = await database.perpReconciliation.loadClaimedSubject({
    ownerUserId: owner.id,
    operationId: operation.id,
    workerId,
    fenceToken: operation.fenceToken,
    recordVersion: operation.recordVersion,
  });

  return {
    ownerUserId: owner.id,
    operationId: operation.id,
    workerId,
    fenceToken: operation.fenceToken,
    recordVersion: operation.recordVersion,
    intentRecordVersion: subject.intentRecordVersion,
  };
}

function partialResolution(
  observedAt: string = new Date().toISOString(),
): PerpOrderReconciliationResolution {
  return {
    genericState: "accepted",
    intentState: "partial",
    observedAt,
    reasonCode: null,
    items: [
      {
        index: 0,
        coin: "BTC",
        generatedClientOrderId,
        state: "partial",
        providerOrderId: "18446744073709551615",
        clientOrderId: generatedClientOrderId,
        filledSize: "0.004",
        averageFillPrice: null,
        reasonCode: null,
      },
    ],
  };
}

function resolutionForState(
  state: "accepted" | "partial" | "filled" | "cancelled" | "rejected",
): PerpOrderReconciliationResolution {
  const reasonCode =
    state === "cancelled" || state === "rejected"
      ? `hyperliquid_${state}`
      : null;
  const filledSize = state === "partial" || state === "filled" ? "0.004" : null;
  return {
    genericState:
      state === "accepted" || state === "partial"
        ? "accepted"
        : state === "rejected"
          ? "rejected"
          : "succeeded",
    intentState: state,
    observedAt: new Date().toISOString(),
    reasonCode,
    items: [
      {
        index: 0,
        coin: "BTC",
        generatedClientOrderId,
        state,
        providerOrderId: "123",
        clientOrderId: generatedClientOrderId,
        filledSize,
        averageFillPrice: null,
        reasonCode,
      },
    ],
  };
}

function leaseIdentity(leased: LeasedIntent): {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly workerId: string;
  readonly fenceToken: string;
  readonly recordVersion: string;
} {
  return {
    ownerUserId: leased.ownerUserId,
    operationId: leased.operationId,
    workerId: leased.workerId,
    fenceToken: leased.fenceToken,
    recordVersion: leased.recordVersion,
  };
}

async function reconciliationSnapshot(
  pool: InstanceType<typeof Pool>,
  operationId: string,
): Promise<unknown> {
  const result = await pool.query<{ snapshot: unknown }>({
    text: `
      select jsonb_build_object(
        'operation_state', operation.state,
        'reconciliation_status', operation.reconciliation_status,
        'lease_owner', operation.lease_owner,
        'lease_expires_at', operation.lease_expires_at,
        'operation_version', operation.record_version,
        'intent_state', intent.state,
        'intent_result_observed_at', intent.result_observed_at,
        'intent_result_reason_code', intent.result_reason_code,
        'intent_version', intent.record_version,
        'item_result_state', item.result_state,
        'item_result_order_id', item.result_order_id,
        'item_result_client_order_id', item.result_client_order_id,
        'item_filled_size', item.filled_size,
        'item_average_fill_price', item.average_fill_price,
        'item_reason_code', item.reason_code,
        'item_observed_at', item.observed_at,
        'audit_count', (
          select count(*) from public.audit_events
          where operation_id = operation.id
        ),
        'event_count', (
          select count(*) from public.perp_intent_events
          where intent_id = intent.id
        )
      ) as snapshot
      from public.provider_operations as operation
      join public.perp_intents as intent on intent.id = operation.id
      join public.perp_intent_items as item on item.intent_id = intent.id
      where operation.id = $1
    `,
    values: [operationId],
  });
  return result.rows[0]?.snapshot;
}

describe("PostgreSQL Perp reconciliation repository", () => {
  let database: PostgresDatabase;
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

  it("accepts only the complete state, fill, average-price, and reason matrix at runtime", async () => {
    const runtimeRepository = database.perpReconciliation as unknown as {
      finalizeOrderResolution(input: unknown): Promise<void>;
    };
    const runtimeInput = (resolution: unknown): unknown => ({
      ownerUserId: randomUUID(),
      operationId: randomUUID(),
      workerId: randomUUID(),
      fenceToken: "1",
      recordVersion: "1",
      expectedIntentRecordVersion: "1",
      requestId: randomUUID(),
      resolution,
    });

    for (const state of [
      "accepted",
      "partial",
      "filled",
      "cancelled",
      "rejected",
    ] as const) {
      await expect(
        runtimeRepository.finalizeOrderResolution(
          runtimeInput(resolutionForState(state)),
        ),
      ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    }
    for (const state of ["partial", "filled", "cancelled"] as const) {
      const withAverage = resolutionForState(state);
      const item = withAverage.items[0]!;
      await expect(
        runtimeRepository.finalizeOrderResolution(
          runtimeInput({
            ...withAverage,
            items: [
              {
                ...item,
                filledSize: item.filledSize ?? "0.001",
                averageFillPrice: "50000",
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    }

    const partial = resolutionForState("partial");
    const partialItem = partial.items[0]!;
    const invalidResolutions: readonly unknown[] = [
      {
        ...partial,
        items: [{ ...partialItem, providerOrderId: null }],
      },
      {
        ...resolutionForState("accepted"),
        items: [
          {
            ...resolutionForState("accepted").items[0]!,
            filledSize: "0.001",
          },
        ],
      },
      {
        ...partial,
        reasonCode: "hyperliquid_open",
        items: [{ ...partialItem, reasonCode: "hyperliquid_open" }],
      },
      {
        ...resolutionForState("accepted"),
        reasonCode: "hyperliquid_open",
        items: [
          {
            ...resolutionForState("accepted").items[0]!,
            reasonCode: "hyperliquid_open",
          },
        ],
      },
      {
        ...resolutionForState("filled"),
        items: [
          {
            ...resolutionForState("filled").items[0]!,
            filledSize: null,
          },
        ],
      },
      {
        ...resolutionForState("cancelled"),
        reasonCode: null,
        items: [
          {
            ...resolutionForState("cancelled").items[0]!,
            reasonCode: null,
          },
        ],
      },
      {
        ...resolutionForState("rejected"),
        items: [
          {
            ...resolutionForState("rejected").items[0]!,
            filledSize: "0.001",
          },
        ],
      },
      {
        ...resolutionForState("rejected"),
        reasonCode: null,
        items: [
          {
            ...resolutionForState("rejected").items[0]!,
            reasonCode: null,
          },
        ],
      },
      {
        ...resolutionForState("cancelled"),
        items: [
          {
            ...resolutionForState("cancelled").items[0]!,
            averageFillPrice: "50000",
          },
        ],
      },
      {
        ...resolutionForState("cancelled"),
        reasonCode: "hyperliquid_cancelled",
        items: [
          {
            ...resolutionForState("cancelled").items[0]!,
            reasonCode: "hyperliquid_margin_cancelled",
          },
        ],
      },
      {
        ...resolutionForState("filled"),
        genericState: "accepted",
      },
      {
        ...partial,
        items: [{ ...partialItem, state: "accepted" }],
      },
    ];

    for (const resolution of invalidResolutions) {
      await expect(
        runtimeRepository.finalizeOrderResolution(runtimeInput(resolution)),
      ).rejects.toBeInstanceOf(PerpReconciliationRepositoryUnavailableError);
    }
  });

  it("atomically finalizes the generic lease, limit-order intent, item, audit, and domain event", async () => {
    const leased = await prepareLeasedIntent(database, inspectionPool);
    const requestId = randomUUID();
    const observedAt = new Date().toISOString();

    await database.perpReconciliation.finalizeOrderResolution({
      ...leaseIdentity(leased),
      expectedIntentRecordVersion: leased.intentRecordVersion,
      requestId,
      resolution: partialResolution(observedAt),
    });

    const result = await inspectionPool.query<FinalizedProjectionRow>({
      text: `
        select
          operation.state as operation_state,
          operation.reconciliation_status,
          operation.lease_owner,
          operation.record_version::text as operation_version,
          intent.state as intent_state,
          intent.record_version::text as intent_version,
          intent.result_observed_at,
          item.result_state as item_state,
          item.result_order_id,
          item.result_client_order_id,
          item.filled_size,
          item.average_fill_price,
          item.observed_at,
          audit.request_id::text as audit_request_id,
          audit.outcome as audit_outcome,
          audit.operation_version::text as audit_version,
          event.request_id::text as event_request_id,
          event.outcome as event_outcome,
          event.intent_version::text as event_version
        from public.provider_operations as operation
        join public.perp_intents as intent on intent.id = operation.id
        join public.perp_intent_items as item on item.intent_id = intent.id
        join public.audit_events as audit
          on audit.operation_id = operation.id
          and audit.event_type = 'reconciliation_resolved'
        join public.perp_intent_events as event
          on event.intent_id = intent.id
          and event.event_type = 'intent_reconciliation_resolved'
        where operation.id = $1
      `,
      values: [leased.operationId],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      operation_state: "accepted",
      reconciliation_status: "complete",
      lease_owner: null,
      operation_version: "4",
      intent_state: "partial",
      intent_version: "2",
      item_state: "partial",
      result_order_id: "18446744073709551615",
      result_client_order_id: generatedClientOrderId,
      filled_size: "0.004",
      average_fill_price: null,
      audit_request_id: requestId,
      audit_outcome: "accepted",
      audit_version: "4",
      event_request_id: requestId,
      event_outcome: "partial",
      event_version: "2",
    });
    expect(result.rows[0]?.result_observed_at.toISOString()).toBe(observedAt);
    expect(result.rows[0]?.observed_at.toISOString()).toBe(observedAt);
  });

  it("discards stale lease identities without changing either projection", async () => {
    const leased = await prepareLeasedIntent(database, inspectionPool);

    await expect(
      database.perpReconciliation.loadClaimedSubject({
        ...leaseIdentity(leased),
        fenceToken: String(BigInt(leased.fenceToken) + 1n),
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    await expect(
      database.perpReconciliation.finalizeOrderResolution({
        ...leaseIdentity(leased),
        recordVersion: String(BigInt(leased.recordVersion) + 1n),
        expectedIntentRecordVersion: leased.intentRecordVersion,
        requestId: randomUUID(),
        resolution: partialResolution(),
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);

    const result = await inspectionPool.query({
      text: `
        select
          operation.state as operation_state,
          operation.reconciliation_status,
          operation.record_version::text as operation_version,
          intent.state as intent_state,
          intent.record_version::text as intent_version,
          item.result_state
        from public.provider_operations as operation
        join public.perp_intents as intent on intent.id = operation.id
        join public.perp_intent_items as item on item.intent_id = intent.id
        where operation.id = $1
      `,
      values: [leased.operationId],
    });
    expect(result.rows[0]).toEqual({
      operation_state: "unknown",
      reconciliation_status: "leased",
      operation_version: "3",
      intent_state: "unknown",
      intent_version: "1",
      result_state: null,
    });
  });

  it("rejects a stale domain version or mismatched generated client-order identity", async () => {
    const leased = await prepareLeasedIntent(database, inspectionPool);

    await expect(
      database.perpReconciliation.finalizeOrderResolution({
        ...leaseIdentity(leased),
        expectedIntentRecordVersion: String(
          BigInt(leased.intentRecordVersion) + 1n,
        ),
        requestId: randomUUID(),
        resolution: partialResolution(),
      }),
    ).rejects.toBeInstanceOf(PerpReconciliationRepositoryUnavailableError);

    const mismatchedResolution = partialResolution();
    await expect(
      database.perpReconciliation.finalizeOrderResolution({
        ...leaseIdentity(leased),
        expectedIntentRecordVersion: leased.intentRecordVersion,
        requestId: randomUUID(),
        resolution: {
          ...mismatchedResolution,
          items: [
            {
              ...mismatchedResolution.items[0]!,
              generatedClientOrderId: "0x22222222222222222222222222222222",
              clientOrderId: "0x22222222222222222222222222222222",
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(PerpReconciliationRepositoryUnavailableError);

    const result = await inspectionPool.query({
      text: `
        select
          operation.state as operation_state,
          operation.reconciliation_status,
          operation.record_version::text as operation_version,
          intent.state as intent_state,
          intent.record_version::text as intent_version,
          item.result_state
        from public.provider_operations as operation
        join public.perp_intents as intent on intent.id = operation.id
        join public.perp_intent_items as item on item.intent_id = intent.id
        where operation.id = $1
      `,
      values: [leased.operationId],
    });
    expect(result.rows[0]).toEqual({
      operation_state: "unknown",
      reconciliation_status: "leased",
      operation_version: "3",
      intent_state: "unknown",
      intent_version: "1",
      result_state: null,
    });
  });

  it.each(["intent", "item"] as const)(
    "refuses to overwrite a nonempty existing %s result projection",
    async (projection) => {
      const leased = await prepareLeasedIntent(database, inspectionPool);
      if (projection === "intent") {
        await inspectionPool.query({
          text: `
            update public.perp_intents
            set
              result_observed_at = clock_timestamp(),
              result_reason_code = 'submission_unknown'
            where id = $1
          `,
          values: [leased.operationId],
        });
      } else {
        await inspectionPool.query({
          text: `
            update public.perp_intent_items
            set
              result_state = 'unknown',
              result_order_id = '123',
              result_client_order_id = $2,
              reason_code = 'submission_unknown',
              observed_at = clock_timestamp(),
              updated_at = clock_timestamp()
            where intent_id = $1 and item_index = 0
          `,
          values: [leased.operationId, generatedClientOrderId],
        });
      }
      const before = await reconciliationSnapshot(
        inspectionPool,
        leased.operationId,
      );

      await expect(
        database.perpReconciliation.finalizeOrderResolution({
          ...leaseIdentity(leased),
          expectedIntentRecordVersion: leased.intentRecordVersion,
          requestId: randomUUID(),
          resolution: partialResolution(),
        }),
      ).rejects.toBeInstanceOf(PerpReconciliationRepositoryUnavailableError);

      await expect(
        reconciliationSnapshot(inspectionPool, leased.operationId),
      ).resolves.toEqual(before);
    },
  );

  it("rolls back every resolved row when the final domain event cannot append", async () => {
    const leased = await prepareLeasedIntent(database, inspectionPool);
    await inspectionPool.query({
      text: `
        insert into public.perp_intent_events (
          intent_id,
          owner_user_id,
          request_id,
          actor_type,
          event_type,
          from_state,
          to_state,
          outcome,
          intent_version
        )
        values (
          $1, $2, $3, 'worker', 'fault_injection', 'unknown', 'partial',
          'partial', 2
        )
      `,
      values: [leased.operationId, leased.ownerUserId, randomUUID()],
    });
    const requestId = randomUUID();

    await expect(
      database.perpReconciliation.finalizeOrderResolution({
        ...leaseIdentity(leased),
        expectedIntentRecordVersion: leased.intentRecordVersion,
        requestId,
        resolution: partialResolution(),
      }),
    ).rejects.toBeInstanceOf(PerpReconciliationRepositoryUnavailableError);

    const result = await inspectionPool.query({
      text: `
        select
          operation.state as operation_state,
          operation.reconciliation_status,
          operation.record_version::text as operation_version,
          intent.state as intent_state,
          intent.record_version::text as intent_version,
          intent.result_observed_at,
          item.result_state,
          item.observed_at,
          (
            select count(*)::text
            from public.audit_events
            where request_id = $2
          ) as final_audit_count,
          (
            select count(*)::text
            from public.perp_intent_events
            where request_id = $2
          ) as final_event_count
        from public.provider_operations as operation
        join public.perp_intents as intent on intent.id = operation.id
        join public.perp_intent_items as item on item.intent_id = intent.id
        where operation.id = $1
      `,
      values: [leased.operationId, requestId],
    });
    expect(result.rows[0]).toEqual({
      operation_state: "unknown",
      reconciliation_status: "leased",
      operation_version: "3",
      intent_state: "unknown",
      intent_version: "1",
      result_observed_at: null,
      result_state: null,
      observed_at: null,
      final_audit_count: "0",
      final_event_count: "0",
    });
  });

  it("refuses to finalize a market order in the limit-order-only slice", async () => {
    const leased = await prepareLeasedIntent(
      database,
      inspectionPool,
      "market",
    );

    await expect(
      database.perpReconciliation.finalizeOrderResolution({
        ...leaseIdentity(leased),
        expectedIntentRecordVersion: leased.intentRecordVersion,
        requestId: randomUUID(),
        resolution: partialResolution(),
      }),
    ).rejects.toBeInstanceOf(PerpReconciliationRepositoryUnavailableError);

    const operation = await database.controlPlane.findProviderOperation(
      leased.ownerUserId,
      leased.operationId,
    );
    expect(operation).toMatchObject({
      state: "unknown",
      reconciliationStatus: "leased",
      recordVersion: "3",
    });
    const intent = await database.perpIntents.findOwned(
      leased.ownerUserId,
      leased.operationId,
    );
    expect(intent).toMatchObject({ state: "unknown", result: null });
  });
});
