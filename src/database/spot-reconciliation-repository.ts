import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  parseSpotReview,
  type SpotReview,
} from "../features/spot/spot-intent-contract.js";
import type {
  LoadClaimedSpotIntentSubjectInput,
  SpotIntentReconciliationSubject,
  SpotReconciliationCanonicalAction,
  SpotReconciliationRepository,
} from "../features/spot/spot-reconciliation-contract.js";
import {
  StaleProviderOperationLeaseError,
  type CompleteReconciliationInput,
  type HoldReconciliationForOperatorInput,
  type LeaseProviderOperationsInput,
  type ProviderOperation,
  type QuarantineExpiredSubmissionsInput,
  type RescheduleReconciliationInput,
} from "./control-plane-repository.js";
import {
  createPostgresSpotIntentRepository,
  type SpotIntentSubmissionRecoveryRepository,
} from "./spot-intent-repository.js";

const maximumPostgresInteger = 2_147_483_647;
const zeroAddress = `0x${"0".repeat(40)}`;

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const bigintStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const positiveDecimalSchema = z
  .string()
  .max(128)
  .regex(/^([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/);
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== zeroAddress);
const tokenIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const clientOrderIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const providerCoinSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^([A-Z0-9][A-Z0-9._-]{0,30}\/[A-Z0-9][A-Z0-9._-]{0,30}|@(0|[1-9][0-9]{0,9}))$/,
  );
const nonnegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(maximumPostgresInteger);
const providerOperationStateSchema = z.enum([
  "prepared",
  "submitting",
  "accepted",
  "succeeded",
  "rejected",
  "failed",
  "unknown",
]);
const reconciliationStatusSchema = z.enum([
  "not_required",
  "pending",
  "leased",
  "operator_required",
  "complete",
]);
const canonicalActionSchema = z
  .object({
    type: z.literal("order"),
    orders: z.tuple([
      z
        .object({
          a: nonnegativeIntegerSchema,
          b: z.boolean(),
          p: positiveDecimalSchema,
          s: positiveDecimalSchema,
          r: z.literal(false),
          t: z
            .object({
              limit: z.object({ tif: z.literal("Ioc") }).strict(),
            })
            .strict(),
          c: clientOrderIdSchema,
        })
        .strict(),
    ]),
    grouping: z.literal("na"),
  })
  .strict();

const operationRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    domain: codeSchema,
    operation_kind: codeSchema,
    request_sha256: sha256Schema,
    state: providerOperationStateSchema,
    attempt_count: z.number().int().min(0).max(1),
    transport_attempt_id: uuidSchema.nullable(),
    attempt_committed_at: validDateSchema.nullable(),
    attempt_deadline_at: validDateSchema.nullable(),
    reconciliation_status: reconciliationStatusSchema,
    reconciliation_attempt_count: z.number().int().nonnegative(),
    reconcile_after: validDateSchema.nullable(),
    operator_required_at: validDateSchema.nullable(),
    lease_owner: uuidSchema.nullable(),
    lease_expires_at: validDateSchema.nullable(),
    fence_token: bigintStringSchema,
    record_version: bigintStringSchema,
    created_at: validDateSchema,
    updated_at: validDateSchema,
  })
  .strict();
const intentRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    domain: z.literal("hyperliquid"),
    operation_kind: z.literal("spot_intent"),
    request_sha256: sha256Schema,
    network: z.literal("testnet"),
    market_id: uuidSchema,
    provider_coin: providerCoinSchema,
    base_token_index: nonnegativeIntegerSchema,
    base_token_id: tokenIdSchema,
    quote_token_index: nonnegativeIntegerSchema,
    quote_token_id: tokenIdSchema,
    spot_pair_index: nonnegativeIntegerSchema,
    exchange_order_asset: nonnegativeIntegerSchema,
    metadata_version: z.string(),
    policy_version: codeSchema,
    side: z.enum(["buy", "sell"]),
    amount_mode: z.enum(["quote", "base"]),
    amount_value: positiveDecimalSchema,
    computed_base_size: positiveDecimalSchema,
    worst_ioc_limit_price: positiveDecimalSchema,
    account_address: addressSchema,
    account_kind: z.literal("master"),
    binding_version: bigintStringSchema,
    client_order_id: clientOrderIdSchema,
    canonical_action: z.unknown(),
    public_review: z.unknown(),
    review_sha256: sha256Schema,
    state: z.enum(["unknown", "reconciling"]),
    provider_order_id: z.string().nullable(),
    filled_base_size: z.string().nullable(),
    filled_quote_amount: z.string().nullable(),
    average_fill_price: z.string().nullable(),
    result_fee_amount: z.string().nullable(),
    result_fee_token_index: z.number().int().nullable(),
    result_fee_token_id: z.string().nullable(),
    result_fee_asset_display_identity: z.string().nullable(),
    result_observed_at: validDateSchema,
    result_reason_code: codeSchema.nullable(),
    record_version: bigintStringSchema,
  })
  .strict();

const quarantineInputSchema = z
  .object({
    requestId: uuidSchema,
    limit: z.number().int().min(1).max(100),
  })
  .strict();
const leaseInputSchema = z
  .object({
    workerId: uuidSchema,
    requestId: uuidSchema,
    limit: z.literal(1),
    leaseDurationMs: z.number().int().min(30_000).max(300_000),
  })
  .strict();
const leasedTransitionInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    operationId: uuidSchema,
    workerId: uuidSchema,
    fenceToken: bigintStringSchema,
    recordVersion: bigintStringSchema,
    requestId: uuidSchema,
  })
  .strict();
const completeInputSchema = leasedTransitionInputSchema
  .extend({
    state: z.enum(["accepted", "succeeded", "rejected", "failed"]),
    reasonCode: codeSchema.optional(),
  })
  .strict();
const rescheduleInputSchema = leasedTransitionInputSchema
  .extend({
    reasonCode: codeSchema,
    retryDelayMs: z.number().int().min(1_000).max(86_400_000),
  })
  .strict();
const holdInputSchema = leasedTransitionInputSchema
  .extend({ reasonCode: codeSchema })
  .strict();
const loadInputSchema = leasedTransitionInputSchema.omit({ requestId: true });

const operationReturningColumns = `
  id,
  owner_user_id,
  domain,
  operation_kind,
  request_sha256,
  state,
  attempt_count,
  transport_attempt_id,
  attempt_committed_at,
  attempt_deadline_at,
  reconciliation_status,
  reconciliation_attempt_count,
  reconcile_after,
  operator_required_at,
  lease_owner,
  lease_expires_at,
  fence_token::text as fence_token,
  record_version::text as record_version,
  created_at,
  updated_at
`;

type DatabaseClient = Pick<PoolClient, "query">;
type LockedIntent = z.infer<typeof intentRowSchema>;
type ParsedLeasedTransition = z.infer<typeof leasedTransitionInputSchema>;

export class SpotReconciliationRepositoryUnavailableError extends Error {
  readonly code = "spot_reconciliation_unavailable";

  constructor() {
    super("The Spot reconciliation repository is unavailable");
    this.name = "SpotReconciliationRepositoryUnavailableError";
  }
}

function failUnavailable(): never {
  throw new SpotReconciliationRepositoryUnavailableError();
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw new SpotReconciliationRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof StaleProviderOperationLeaseError ||
    error instanceof SpotReconciliationRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new SpotReconciliationRepositoryUnavailableError();
}

function toProviderOperation(value: unknown): ProviderOperation {
  const row = operationRowSchema.parse(value);
  return Object.freeze({
    id: row.id,
    ownerUserId: row.owner_user_id,
    domain: row.domain,
    operationKind: row.operation_kind,
    requestSha256: row.request_sha256,
    state: row.state,
    attemptCount: row.attempt_count,
    transportAttemptId: row.transport_attempt_id,
    attemptCommittedAt: row.attempt_committed_at?.toISOString() ?? null,
    attemptDeadlineAt: row.attempt_deadline_at?.toISOString() ?? null,
    reconciliationStatus: row.reconciliation_status,
    reconciliationAttemptCount: row.reconciliation_attempt_count,
    reconcileAfter: row.reconcile_after?.toISOString() ?? null,
    operatorRequiredAt: row.operator_required_at?.toISOString() ?? null,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    fenceToken: row.fence_token,
    recordVersion: row.record_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function assertOperationAuthority(operation: ProviderOperation): void {
  if (
    operation.domain !== "hyperliquid" ||
    operation.operationKind !== "spot_intent" ||
    operation.state !== "unknown" ||
    operation.attemptCount !== 1 ||
    operation.transportAttemptId === null ||
    operation.attemptCommittedAt === null ||
    operation.attemptDeadlineAt === null
  ) {
    failUnavailable();
  }
}

async function lockIntent(
  client: DatabaseClient,
  operation: ProviderOperation,
): Promise<LockedIntent> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      /* loop_lock_claimed_spot_intent */
      select
        id,
        owner_user_id,
        domain,
        operation_kind,
        request_sha256,
        network,
        market_id,
        provider_coin,
        base_token_index,
        base_token_id,
        quote_token_index,
        quote_token_id,
        spot_pair_index,
        exchange_order_asset,
        metadata_version,
        policy_version,
        side,
        amount_mode,
        amount_value,
        computed_base_size,
        worst_ioc_limit_price,
        account_address,
        account_kind,
        binding_version::text as binding_version,
        client_order_id,
        canonical_action,
        public_review,
        review_sha256,
        state,
        provider_order_id,
        filled_base_size,
        filled_quote_amount,
        average_fill_price,
        result_fee_amount,
        result_fee_token_index,
        result_fee_token_id,
        result_fee_asset_display_identity,
        result_observed_at,
        result_reason_code,
        record_version::text as record_version
      from public.spot_intents
      where id = $1
      for update
    `,
    values: [operation.id],
  });
  const parsed = intentRowSchema.safeParse(result.rows[0]);
  if (!parsed.success || result.rows.length !== 1) {
    return failUnavailable();
  }
  const intent = parsed.data;
  if (
    intent.id !== operation.id ||
    intent.owner_user_id !== operation.ownerUserId ||
    intent.request_sha256 !== operation.requestSha256 ||
    intent.provider_order_id !== null ||
    intent.filled_base_size !== null ||
    intent.filled_quote_amount !== null ||
    intent.average_fill_price !== null ||
    intent.result_fee_amount !== null ||
    intent.result_fee_token_index !== null ||
    intent.result_fee_token_id !== null ||
    intent.result_fee_asset_display_identity !== null
  ) {
    return failUnavailable();
  }
  return intent;
}

async function appendAuditEvent(
  client: DatabaseClient,
  input: Readonly<{
    operation: ProviderOperation;
    requestId: string;
    eventType: string;
    fromReconciliationStatus: "pending" | "leased";
    outcome: string;
    reasonCode?: string;
  }>,
): Promise<void> {
  const result = await client.query({
    text: `
      insert into public.audit_events (
        owner_user_id,
        operation_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        from_reconciliation_status,
        to_reconciliation_status,
        outcome,
        reason_code,
        operation_version,
        fence_token,
        transport_attempt_id
      )
      values (
        $1, $2, $3, 'worker', $4, 'unknown', 'unknown', $5, $6, $7, $8,
        $9::bigint, $10::bigint, $11
      )
    `,
    values: [
      input.operation.ownerUserId,
      input.operation.id,
      input.requestId,
      input.eventType,
      input.fromReconciliationStatus,
      input.operation.reconciliationStatus,
      input.outcome,
      input.reasonCode ?? null,
      input.operation.recordVersion,
      input.operation.fenceToken,
      input.operation.transportAttemptId,
    ],
  });
  if (result.rowCount !== 1) {
    return failUnavailable();
  }
}

async function appendIntentEvent(
  client: DatabaseClient,
  input: Readonly<{
    operation: ProviderOperation;
    requestId: string;
    eventType: string;
    fromState: "unknown" | "reconciling";
    toState: "unknown" | "reconciling" | "operator_required";
    outcome: string;
    reasonCode?: string;
    intentVersion: string;
  }>,
): Promise<void> {
  const result = await client.query({
    text: `
      insert into public.spot_intent_events (
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
      values ($1, $2, $3, 'worker', $4, $5, $6, $7, $8, $9::bigint)
    `,
    values: [
      input.operation.id,
      input.operation.ownerUserId,
      input.requestId,
      input.eventType,
      input.fromState,
      input.toState,
      input.outcome,
      input.reasonCode ?? null,
      input.intentVersion,
    ],
  });
  if (result.rowCount !== 1) {
    return failUnavailable();
  }
}

async function leaseOne(
  client: DatabaseClient,
  input: z.infer<typeof leaseInputSchema>,
): Promise<readonly ProviderOperation[]> {
  const candidateResult = await client.query<Record<string, unknown>>({
    text: `
      select ${operationReturningColumns}
      from public.provider_operations
      where domain = 'hyperliquid'
        and operation_kind = 'spot_intent'
        and state = 'unknown'
        and (
          (
            reconciliation_status = 'pending'
            and reconcile_after <= clock_timestamp()
          )
          or (
            reconciliation_status = 'leased'
            and lease_expires_at <= clock_timestamp()
          )
        )
      order by reconcile_after, created_at, id
      for update skip locked
      limit $1
    `,
    values: [input.limit],
  });
  const candidateRow = candidateResult.rows[0];
  if (candidateRow === undefined) {
    return Object.freeze([]);
  }
  const candidate = toProviderOperation(candidateRow);
  assertOperationAuthority(candidate);
  if (
    candidate.reconciliationStatus !== "pending" &&
    candidate.reconciliationStatus !== "leased"
  ) {
    return failUnavailable();
  }
  const intent = await lockIntent(client, candidate);
  const firstLease = candidate.reconciliationStatus === "pending";
  if (
    (firstLease && intent.state !== "unknown") ||
    (!firstLease && intent.state !== "reconciling")
  ) {
    return failUnavailable();
  }

  const operationResult = await client.query<Record<string, unknown>>({
    text: `
      update public.provider_operations as operation
      set
        reconciliation_status = 'leased',
        reconciliation_attempt_count = operation.reconciliation_attempt_count + 1,
        lease_owner = $2,
        lease_expires_at = clock_timestamp()
          + ($3::integer * interval '1 millisecond'),
        fence_token = operation.fence_token + 1,
        record_version = operation.record_version + 1,
        updated_at = clock_timestamp()
      where operation.id = $1
        and operation.owner_user_id = $4
        and operation.domain = 'hyperliquid'
        and operation.operation_kind = 'spot_intent'
        and operation.state = 'unknown'
        and operation.reconciliation_status = $5
        and operation.record_version = $6::bigint
        and operation.fence_token = $7::bigint
        and (
          (
            operation.reconciliation_status = 'pending'
            and operation.reconcile_after <= clock_timestamp()
          )
          or (
            operation.reconciliation_status = 'leased'
            and operation.lease_expires_at <= clock_timestamp()
          )
        )
      returning ${operationReturningColumns}
    `,
    values: [
      candidate.id,
      input.workerId,
      input.leaseDurationMs,
      candidate.ownerUserId,
      candidate.reconciliationStatus,
      candidate.recordVersion,
      candidate.fenceToken,
    ],
  });
  const row = operationResult.rows[0];
  if (row === undefined || operationResult.rows.length !== 1) {
    return failUnavailable();
  }
  const operation = toProviderOperation(row);

  if (firstLease) {
    const intentResult = await client.query<{ record_version: string }>({
      text: `
        update public.spot_intents
        set
          state = 'reconciling',
          record_version = record_version + 1,
          updated_at = clock_timestamp()
        where id = $1
          and owner_user_id = $2
          and domain = 'hyperliquid'
          and operation_kind = 'spot_intent'
          and state = 'unknown'
          and record_version = $3::bigint
        returning record_version::text as record_version
      `,
      values: [intent.id, intent.owner_user_id, intent.record_version],
    });
    const intentVersion = intentResult.rows[0]?.record_version;
    if (intentVersion === undefined || intentResult.rows.length !== 1) {
      return failUnavailable();
    }
    await appendIntentEvent(client, {
      operation,
      requestId: input.requestId,
      eventType: "intent_reconciliation_leased",
      fromState: "unknown",
      toState: "reconciling",
      outcome: "leased",
      intentVersion,
    });
  }

  await appendAuditEvent(client, {
    operation,
    requestId: input.requestId,
    eventType: "reconciliation_leased",
    fromReconciliationStatus: candidate.reconciliationStatus,
    outcome: "leased",
  });
  return Object.freeze([operation]);
}

async function lockClaimedOperation(
  client: DatabaseClient,
  input: Omit<ParsedLeasedTransition, "requestId">,
): Promise<ProviderOperation> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      /* loop_lock_claimed_spot_operation */
      select ${operationReturningColumns}
      from public.provider_operations
      where id = $1
      for update
    `,
    values: [input.operationId],
  });
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    throw new StaleProviderOperationLeaseError();
  }
  let operation: ProviderOperation;
  try {
    operation = toProviderOperation(row);
  } catch {
    return failUnavailable();
  }
  assertOperationAuthority(operation);
  if (
    operation.ownerUserId !== input.ownerUserId ||
    operation.reconciliationStatus !== "leased" ||
    operation.leaseOwner !== input.workerId ||
    operation.fenceToken !== input.fenceToken ||
    operation.recordVersion !== input.recordVersion
  ) {
    throw new StaleProviderOperationLeaseError();
  }

  // This second statement executes only after FOR UPDATE has acquired the row
  // lock. It prevents a lease that expired while waiting for the lock from
  // authorizing a provider read.
  await assertClaimedLeaseCurrent(client, operation.id);
  return operation;
}

async function assertClaimedLeaseCurrent(
  client: DatabaseClient,
  operationId: string,
): Promise<void> {
  const leaseCheck = await client.query<{ lease_valid: boolean }>({
    text: `
      select lease_expires_at > clock_timestamp() as lease_valid
      from public.provider_operations
      where id = $1
    `,
    values: [operationId],
  });
  if (leaseCheck.rows[0]?.lease_valid !== true) {
    throw new StaleProviderOperationLeaseError();
  }
}

async function transitionClaimedOperation(
  client: DatabaseClient,
  input:
    z.infer<typeof rescheduleInputSchema> | z.infer<typeof holdInputSchema>,
  target: "pending" | "operator_required",
): Promise<ProviderOperation> {
  const lockedOperation = await lockClaimedOperation(client, input);
  const intent = await lockIntent(client, lockedOperation);
  if (intent.state !== "reconciling") {
    return failUnavailable();
  }

  const operationResult = await client.query<Record<string, unknown>>({
    text: `
      update public.provider_operations as operation
      set
        reconciliation_status = $6,
        reconcile_after = case
          when $6 = 'pending' then clock_timestamp()
            + ($7::integer * interval '1 millisecond')
          else null
        end,
        operator_required_at = case
          when $6 = 'operator_required' then clock_timestamp()
          else null
        end,
        lease_owner = null,
        lease_expires_at = null,
        record_version = operation.record_version + 1,
        updated_at = clock_timestamp()
      where operation.id = $1
        and operation.owner_user_id = $2
        and operation.domain = 'hyperliquid'
        and operation.operation_kind = 'spot_intent'
        and operation.state = 'unknown'
        and operation.reconciliation_status = 'leased'
        and operation.lease_owner = $3
        and operation.fence_token = $4::bigint
        and operation.record_version = $5::bigint
        and operation.lease_expires_at > clock_timestamp()
      returning ${operationReturningColumns}
    `,
    values: [
      input.operationId,
      input.ownerUserId,
      input.workerId,
      input.fenceToken,
      input.recordVersion,
      target,
      "retryDelayMs" in input ? input.retryDelayMs : 0,
    ],
  });
  const operationRow = operationResult.rows[0];
  if (operationRow === undefined || operationResult.rows.length !== 1) {
    throw new StaleProviderOperationLeaseError();
  }
  const operation = toProviderOperation(operationRow);
  const intentResult = await client.query<{ record_version: string }>({
    text: `
      update public.spot_intents
      set
        state = $4,
        result_observed_at = case
          when $4 = 'operator_required' then clock_timestamp()
          else result_observed_at
        end,
        result_reason_code = case
          when $4 = 'operator_required' then $5
          else result_reason_code
        end,
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1
        and owner_user_id = $2
        and domain = 'hyperliquid'
        and operation_kind = 'spot_intent'
        and state = 'reconciling'
        and record_version = $3::bigint
      returning record_version::text as record_version
    `,
    values: [
      intent.id,
      intent.owner_user_id,
      intent.record_version,
      target === "pending" ? "unknown" : "operator_required",
      input.reasonCode,
    ],
  });
  const intentVersion = intentResult.rows[0]?.record_version;
  if (intentVersion === undefined || intentResult.rows.length !== 1) {
    return failUnavailable();
  }

  await appendAuditEvent(client, {
    operation,
    requestId: input.requestId,
    eventType:
      target === "pending"
        ? "reconciliation_rescheduled"
        : "reconciliation_operator_required",
    fromReconciliationStatus: "leased",
    outcome: target,
    reasonCode: input.reasonCode,
  });
  await appendIntentEvent(client, {
    operation,
    requestId: input.requestId,
    eventType:
      target === "pending"
        ? "intent_reconciliation_rescheduled"
        : "intent_reconciliation_operator_required",
    fromState: "reconciling",
    toState: target === "pending" ? "unknown" : "operator_required",
    outcome: target,
    reasonCode: input.reasonCode,
    intentVersion,
  });
  return operation;
}

function canonicalActionMatchesIntent(
  action: SpotReconciliationCanonicalAction,
  intent: LockedIntent,
): boolean {
  const order = action.orders[0];
  return (
    order.a === intent.exchange_order_asset &&
    order.b === (intent.side === "buy") &&
    order.p === intent.worst_ioc_limit_price &&
    order.s === intent.computed_base_size &&
    order.c === intent.client_order_id
  );
}

function reviewMatchesIntent(
  review: SpotReview,
  intent: LockedIntent,
): boolean {
  return (
    review.market_id === intent.market_id &&
    review.side === intent.side &&
    review.amount_mode === intent.amount_mode &&
    review.amount_value === intent.amount_value &&
    review.computed_base_size === intent.computed_base_size &&
    review.worst_ioc_limit_price === intent.worst_ioc_limit_price &&
    review.metadata_version === intent.metadata_version &&
    review.policy_version === intent.policy_version &&
    review.binding_epoch === intent.binding_version &&
    review.review_digest === intent.review_sha256
  );
}

function freezeCanonicalAction(
  action: z.infer<typeof canonicalActionSchema>,
): SpotReconciliationCanonicalAction {
  const sourceOrder = action.orders[0];
  const order = Object.freeze({
    a: sourceOrder.a,
    b: sourceOrder.b,
    p: sourceOrder.p,
    s: sourceOrder.s,
    r: false as const,
    t: Object.freeze({
      limit: Object.freeze({ tif: "Ioc" as const }),
    }),
    c: sourceOrder.c,
  });
  const orders = Object.freeze<[typeof order]>([order]);
  return Object.freeze({
    type: "order" as const,
    orders,
    grouping: "na" as const,
  });
}

function toSubject(
  operation: ProviderOperation,
  intent: LockedIntent,
): SpotIntentReconciliationSubject {
  if (
    operation.transportAttemptId === null ||
    operation.attemptCommittedAt === null ||
    intent.state !== "reconciling"
  ) {
    return failUnavailable();
  }
  const canonicalAction = canonicalActionSchema.safeParse(
    intent.canonical_action,
  );
  let review: SpotReview;
  try {
    review = parseSpotReview(intent.public_review);
  } catch {
    return failUnavailable();
  }
  if (
    !canonicalAction.success ||
    !canonicalActionMatchesIntent(canonicalAction.data, intent) ||
    !reviewMatchesIntent(review, intent)
  ) {
    return failUnavailable();
  }
  return Object.freeze({
    operationId: operation.id,
    ownerUserId: operation.ownerUserId,
    network: "testnet" as const,
    transportAttemptId: operation.transportAttemptId,
    attemptCommittedAt: operation.attemptCommittedAt,
    intentRecordVersion: intent.record_version,
    marketId: intent.market_id,
    providerCoin: intent.provider_coin,
    baseTokenIndex: intent.base_token_index,
    baseTokenId: intent.base_token_id,
    baseDisplayIdentity: review.base_display_identity,
    quoteTokenIndex: intent.quote_token_index,
    quoteTokenId: intent.quote_token_id,
    quoteDisplayIdentity: review.quote_display_identity,
    spotPairIndex: intent.spot_pair_index,
    exchangeOrderAsset: intent.exchange_order_asset,
    side: intent.side,
    amountMode: intent.amount_mode,
    amountValue: intent.amount_value,
    computedBaseSize: intent.computed_base_size,
    worstIocLimitPrice: intent.worst_ioc_limit_price,
    accountAddress: intent.account_address,
    accountKind: intent.account_kind,
    clientOrderId: intent.client_order_id,
    canonicalAction: freezeCanonicalAction(canonicalAction.data),
  });
}

export function createPostgresSpotReconciliationRepository(
  pool: Pool,
  submissionRecovery: SpotIntentSubmissionRecoveryRepository = createPostgresSpotIntentRepository(
    pool,
  ),
): SpotReconciliationRepository {
  return Object.freeze({
    async quarantineExpiredSubmissions(
      rawInput: QuarantineExpiredSubmissionsInput,
    ) {
      try {
        const input = quarantineInputSchema.parse(rawInput);
        await submissionRecovery.quarantineExpiredSubmissions(input);
        // ReconciliationService intentionally ignores this list. Returning an
        // empty list avoids a post-commit read race with another worker that
        // may already have leased or finalized the quarantined operation.
        return Object.freeze([]);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async leaseProviderOperationsForReconciliation(
      rawInput: LeaseProviderOperationsInput,
    ) {
      try {
        const input = leaseInputSchema.parse(rawInput);
        return await withTransaction(pool, (client) => leaseOne(client, input));
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    completeProviderOperationReconciliation(
      rawInput: CompleteReconciliationInput,
    ): Promise<ProviderOperation> {
      return Promise.resolve()
        .then(() => {
          completeInputSchema.parse(rawInput);
          throw new StaleProviderOperationLeaseError();
        })
        .catch((error: unknown) => translateRepositoryError(error));
    },

    async rescheduleProviderOperationReconciliation(
      rawInput: RescheduleReconciliationInput,
    ) {
      try {
        const input = rescheduleInputSchema.parse(rawInput);
        return await withTransaction(pool, (client) =>
          transitionClaimedOperation(client, input, "pending"),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async holdProviderOperationForOperator(
      rawInput: HoldReconciliationForOperatorInput,
    ) {
      try {
        const input = holdInputSchema.parse(rawInput);
        return await withTransaction(pool, (client) =>
          transitionClaimedOperation(client, input, "operator_required"),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async loadClaimedSpotIntentSubject(
      rawInput: LoadClaimedSpotIntentSubjectInput,
    ): Promise<SpotIntentReconciliationSubject> {
      try {
        const input = loadInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const operation = await lockClaimedOperation(client, input);
          const intent = await lockIntent(client, operation);
          // The projection lock can also wait. Recheck with the database clock
          // after both authority rows are held before exposing read material.
          await assertClaimedLeaseCurrent(client, operation.id);
          return toSubject(operation, intent);
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
