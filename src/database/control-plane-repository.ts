import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const uuidSchema = z.string().uuid();
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const bigintStringSchema = z.string().regex(/^\d+$/);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
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
const terminalProviderOperationStateSchema = z.enum([
  "accepted",
  "succeeded",
  "rejected",
  "failed",
]);
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
const idempotencyRowSchema = z.object({ id: uuidSchema }).strict();

const prepareOperationInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    scope: codeSchema,
    idempotencyKey: uuidSchema,
    keySource: z.enum(["client", "server"]),
    requestSha256: sha256Schema,
    domain: codeSchema,
    operationKind: codeSchema,
    requestId: uuidSchema,
  })
  .strict();
const operationTransitionInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    operationId: uuidSchema,
    requestId: uuidSchema,
  })
  .strict();
const markSubmittingInputSchema = operationTransitionInputSchema
  .extend({
    attemptDurationMs: z.number().int().min(1_000).max(60_000),
  })
  .strict();
const submissionTransitionInputSchema = operationTransitionInputSchema
  .extend({
    transportAttemptId: uuidSchema,
    recordVersion: bigintStringSchema,
  })
  .strict();
const markUnknownInputSchema = submissionTransitionInputSchema
  .extend({
    reasonCode: codeSchema,
    retryDelayMs: z.number().int().min(0).max(86_400_000),
  })
  .strict();
const markProviderResultInputSchema = submissionTransitionInputSchema
  .extend({
    state: terminalProviderOperationStateSchema,
    reasonCode: codeSchema.optional(),
  })
  .strict();
const quarantineExpiredSubmissionsInputSchema = z
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
const completeReconciliationInputSchema = leasedTransitionInputSchema
  .extend({
    state: terminalProviderOperationStateSchema,
    reasonCode: codeSchema.optional(),
  })
  .strict();
const rescheduleReconciliationInputSchema = leasedTransitionInputSchema
  .extend({
    reasonCode: codeSchema,
    retryDelayMs: z.number().int().min(1_000).max(86_400_000),
  })
  .strict();
const holdReconciliationInputSchema = leasedTransitionInputSchema
  .extend({
    reasonCode: codeSchema,
  })
  .strict();
const issuanceQuotaBucketSchema = z
  .object({
    subjectKind: codeSchema,
    subjectHmac: sha256Schema,
    windowDurationSeconds: z.number().int().min(1).max(86_400),
    capacity: z.number().int().min(1).max(100_000),
  })
  .strict();
const issuanceQuotaInputSchema = z
  .object({
    capability: codeSchema,
    policyVersion: codeSchema,
    cost: z.number().int().min(1).max(100_000).default(1),
    buckets: z.array(issuanceQuotaBucketSchema).min(1).max(4),
  })
  .strict()
  .superRefine((value, context) => {
    const subjectKinds = value.buckets.map((bucket) => bucket.subjectKind);
    if (new Set(subjectKinds).size !== subjectKinds.length) {
      context.addIssue({
        code: "custom",
        message: "Quota subject kinds must be unique",
        path: ["buckets"],
      });
    }
  });

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

type ProviderOperationState = z.infer<typeof providerOperationStateSchema>;
type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>;
type TerminalProviderOperationState = z.infer<
  typeof terminalProviderOperationStateSchema
>;
type DatabaseClient = Pick<PoolClient, "query">;

export interface ProviderOperation {
  readonly id: string;
  readonly ownerUserId: string;
  readonly domain: string;
  readonly operationKind: string;
  readonly requestSha256: string;
  readonly state: ProviderOperationState;
  readonly attemptCount: number;
  readonly transportAttemptId: string | null;
  readonly attemptCommittedAt: string | null;
  readonly attemptDeadlineAt: string | null;
  readonly reconciliationStatus: ReconciliationStatus;
  readonly reconciliationAttemptCount: number;
  readonly reconcileAfter: string | null;
  readonly operatorRequiredAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly fenceToken: string;
  readonly recordVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PrepareProviderOperationInput {
  readonly ownerUserId: string;
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly keySource: "client" | "server";
  readonly requestSha256: string;
  readonly domain: string;
  readonly operationKind: string;
  readonly requestId: string;
}

export interface OperationTransitionInput {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly requestId: string;
}

export interface MarkProviderOperationSubmittingInput extends OperationTransitionInput {
  readonly attemptDurationMs: number;
}

export interface SubmissionTransitionInput extends OperationTransitionInput {
  readonly transportAttemptId: string;
  readonly recordVersion: string;
}

export interface MarkProviderOperationUnknownInput extends SubmissionTransitionInput {
  readonly reasonCode: string;
  readonly retryDelayMs: number;
}

export interface MarkProviderOperationResultInput extends SubmissionTransitionInput {
  readonly state: TerminalProviderOperationState;
  readonly reasonCode?: string;
}

export interface QuarantineExpiredSubmissionsInput {
  readonly requestId: string;
  readonly limit: number;
}

export interface LeaseProviderOperationsInput {
  readonly workerId: string;
  readonly requestId: string;
  readonly limit: 1;
  readonly leaseDurationMs: number;
}

export interface LeasedOperationTransitionInput {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly workerId: string;
  readonly fenceToken: string;
  readonly recordVersion: string;
  readonly requestId: string;
}

export interface CompleteReconciliationInput extends LeasedOperationTransitionInput {
  readonly state: TerminalProviderOperationState;
  readonly reasonCode?: string;
}

export interface RescheduleReconciliationInput extends LeasedOperationTransitionInput {
  readonly reasonCode: string;
  readonly retryDelayMs: number;
}

export interface HoldReconciliationForOperatorInput extends LeasedOperationTransitionInput {
  readonly reasonCode: string;
}

export interface IssuanceQuotaBucket {
  readonly subjectKind: string;
  readonly subjectHmac: string;
  readonly windowDurationSeconds: number;
  readonly capacity: number;
}

export interface ConsumeIssuanceQuotaInput {
  readonly capability: string;
  readonly policyVersion: string;
  readonly cost?: number;
  readonly buckets: readonly IssuanceQuotaBucket[];
}

export interface IssuanceQuotaConsumption {
  readonly subjectKind: string;
  readonly issuedCount: number;
  readonly windowStartedAt: string;
}

export interface ControlPlaneRepository {
  prepareProviderOperation(input: PrepareProviderOperationInput): Promise<{
    readonly created: boolean;
    readonly operation: ProviderOperation;
  }>;
  findProviderOperation(
    ownerUserId: string,
    operationId: string,
  ): Promise<ProviderOperation | null>;
  markProviderOperationSubmitting(
    input: MarkProviderOperationSubmittingInput,
  ): Promise<ProviderOperation>;
  markProviderOperationUnknown(
    input: MarkProviderOperationUnknownInput,
  ): Promise<ProviderOperation>;
  markProviderOperationResult(
    input: MarkProviderOperationResultInput,
  ): Promise<ProviderOperation>;
  quarantineExpiredSubmissions(
    input: QuarantineExpiredSubmissionsInput,
  ): Promise<readonly ProviderOperation[]>;
  leaseProviderOperationsForReconciliation(
    input: LeaseProviderOperationsInput,
  ): Promise<readonly ProviderOperation[]>;
  completeProviderOperationReconciliation(
    input: CompleteReconciliationInput,
  ): Promise<ProviderOperation>;
  rescheduleProviderOperationReconciliation(
    input: RescheduleReconciliationInput,
  ): Promise<ProviderOperation>;
  holdProviderOperationForOperator(
    input: HoldReconciliationForOperatorInput,
  ): Promise<ProviderOperation>;
  consumeIssuanceQuota(
    input: ConsumeIssuanceQuotaInput,
  ): Promise<readonly IssuanceQuotaConsumption[]>;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key is already bound to a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class InvalidProviderOperationStateError extends Error {
  constructor() {
    super("The provider operation cannot make the requested transition");
    this.name = "InvalidProviderOperationStateError";
  }
}

export class StaleProviderOperationLeaseError extends Error {
  constructor() {
    super("The provider operation lease is stale");
    this.name = "StaleProviderOperationLeaseError";
  }
}

export class IssuanceQuotaExceededError extends Error {
  constructor() {
    super("The issuance quota is exhausted");
    this.name = "IssuanceQuotaExceededError";
  }
}

export class ControlPlaneUnavailableError extends Error {
  constructor() {
    super("The control plane is unavailable");
    this.name = "ControlPlaneUnavailableError";
  }
}

function toProviderOperation(row: unknown): ProviderOperation {
  const parsed = operationRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    ownerUserId: parsed.owner_user_id,
    domain: parsed.domain,
    operationKind: parsed.operation_kind,
    requestSha256: parsed.request_sha256,
    state: parsed.state,
    attemptCount: parsed.attempt_count,
    transportAttemptId: parsed.transport_attempt_id,
    attemptCommittedAt: parsed.attempt_committed_at?.toISOString() ?? null,
    attemptDeadlineAt: parsed.attempt_deadline_at?.toISOString() ?? null,
    reconciliationStatus: parsed.reconciliation_status,
    reconciliationAttemptCount: parsed.reconciliation_attempt_count,
    reconcileAfter: parsed.reconcile_after?.toISOString() ?? null,
    operatorRequiredAt: parsed.operator_required_at?.toISOString() ?? null,
    leaseOwner: parsed.lease_owner,
    leaseExpiresAt: parsed.lease_expires_at?.toISOString() ?? null,
    fenceToken: parsed.fence_token,
    recordVersion: parsed.record_version,
    createdAt: parsed.created_at.toISOString(),
    updatedAt: parsed.updated_at.toISOString(),
  });
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
      throw new Error("Control-plane transaction rollback failed", {
        cause: error,
      });
    }

    throw error;
  } finally {
    client.release();
  }
}

async function readOperation(
  client: DatabaseClient,
  ownerUserId: string,
  operationId: string,
): Promise<ProviderOperation | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${operationReturningColumns}
      from public.provider_operations
      where owner_user_id = $1 and id = $2
      limit 1
    `,
    values: [ownerUserId, operationId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toProviderOperation(row);
}

interface AuditTransitionInput {
  readonly operation: ProviderOperation;
  readonly requestId: string;
  readonly actorType: "api" | "worker";
  readonly eventType: string;
  readonly fromState: ProviderOperationState | null;
  readonly fromReconciliationStatus: ReconciliationStatus | null;
  readonly outcome: string;
  readonly reasonCode?: string;
}

async function appendAuditEvent(
  client: DatabaseClient,
  rawInput: AuditTransitionInput,
): Promise<void> {
  const input = z
    .object({
      requestId: uuidSchema,
      actorType: z.enum(["api", "worker"]),
      eventType: codeSchema,
      outcome: codeSchema,
      reasonCode: codeSchema.optional(),
    })
    .strict()
    .parse({
      requestId: rawInput.requestId,
      actorType: rawInput.actorType,
      eventType: rawInput.eventType,
      outcome: rawInput.outcome,
      ...(rawInput.reasonCode === undefined
        ? {}
        : { reasonCode: rawInput.reasonCode }),
    });
  const operation = rawInput.operation;

  await client.query({
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
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12::bigint, $13::bigint, $14
      )
    `,
    values: [
      operation.ownerUserId,
      operation.id,
      input.requestId,
      input.actorType,
      input.eventType,
      rawInput.fromState,
      operation.state,
      rawInput.fromReconciliationStatus,
      operation.reconciliationStatus,
      input.outcome,
      input.reasonCode ?? null,
      operation.recordVersion,
      operation.fenceToken,
      operation.transportAttemptId,
    ],
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new ControlPlaneUnavailableError());
}

export function createUnavailableControlPlaneRepository(): ControlPlaneRepository {
  return {
    prepareProviderOperation: unavailable,
    findProviderOperation: unavailable,
    markProviderOperationSubmitting: unavailable,
    markProviderOperationUnknown: unavailable,
    markProviderOperationResult: unavailable,
    quarantineExpiredSubmissions: unavailable,
    leaseProviderOperationsForReconciliation: unavailable,
    completeProviderOperationReconciliation: unavailable,
    rescheduleProviderOperationReconciliation: unavailable,
    holdProviderOperationForOperator: unavailable,
    consumeIssuanceQuota: unavailable,
  };
}

export function createPostgresControlPlaneRepository(
  pool: Pool,
): ControlPlaneRepository {
  return {
    async prepareProviderOperation(rawInput) {
      const input = prepareOperationInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const idempotencyResult = await client.query<Record<string, unknown>>({
          text: `
            insert into public.idempotency_records (
              owner_user_id,
              scope,
              idempotency_key,
              key_source,
              request_sha256
            )
            values ($1, $2, $3, $4, $5)
            on conflict (scope, idempotency_key)
            do update set last_seen_at = clock_timestamp()
            where idempotency_records.owner_user_id = excluded.owner_user_id
              and idempotency_records.key_source = excluded.key_source
              and idempotency_records.request_sha256 = excluded.request_sha256
              and idempotency_records.digest_version = excluded.digest_version
            returning id
          `,
          values: [
            input.ownerUserId,
            input.scope,
            input.idempotencyKey,
            input.keySource,
            input.requestSha256,
          ],
        });
        const idempotency = idempotencyRowSchema.safeParse(
          idempotencyResult.rows[0],
        );

        if (!idempotency.success) {
          throw new IdempotencyConflictError();
        }

        const operationResult = await client.query<Record<string, unknown>>({
          text: `
            insert into public.provider_operations (
              owner_user_id,
              idempotency_record_id,
              domain,
              operation_kind,
              request_sha256
            )
            values ($1, $2, $3, $4, $5)
            on conflict (idempotency_record_id) do nothing
            returning ${operationReturningColumns}
          `,
          values: [
            input.ownerUserId,
            idempotency.data.id,
            input.domain,
            input.operationKind,
            input.requestSha256,
          ],
        });
        const insertedRow = operationResult.rows[0];

        if (insertedRow !== undefined) {
          const operation = toProviderOperation(insertedRow);
          await appendAuditEvent(client, {
            operation,
            requestId: input.requestId,
            actorType: "api",
            eventType: "operation_prepared",
            fromState: null,
            fromReconciliationStatus: null,
            outcome: "prepared",
          });
          return Object.freeze({ created: true, operation });
        }

        const existing = await client.query<Record<string, unknown>>({
          text: `
            select ${operationReturningColumns}
            from public.provider_operations
            where idempotency_record_id = $1
            limit 1
          `,
          values: [idempotency.data.id],
        });
        const operation = toProviderOperation(existing.rows[0]);

        if (
          operation.ownerUserId !== input.ownerUserId ||
          operation.requestSha256 !== input.requestSha256 ||
          operation.domain !== input.domain ||
          operation.operationKind !== input.operationKind
        ) {
          throw new IdempotencyConflictError();
        }

        return Object.freeze({ created: false, operation });
      });
    },

    async findProviderOperation(rawOwnerUserId, rawOperationId) {
      const ownerUserId = uuidSchema.parse(rawOwnerUserId);
      const operationId = uuidSchema.parse(rawOperationId);
      return readOperation(pool, ownerUserId, operationId);
    },

    async markProviderOperationSubmitting(rawInput) {
      const input = markSubmittingInputSchema.parse(rawInput);
      const transportAttemptId = randomUUID();

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            update public.provider_operations
            set
              state = 'submitting',
              attempt_count = 1,
              transport_attempt_id = $3,
              attempt_committed_at = clock_timestamp(),
              attempt_deadline_at = clock_timestamp()
                + ($4::integer * interval '1 millisecond'),
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where id = $1
              and owner_user_id = $2
              and state = 'prepared'
              and reconciliation_status = 'not_required'
              and attempt_count = 0
            returning ${operationReturningColumns}
          `,
          values: [
            input.operationId,
            input.ownerUserId,
            transportAttemptId,
            input.attemptDurationMs,
          ],
        });
        const row = result.rows[0];

        if (row === undefined) {
          throw new InvalidProviderOperationStateError();
        }

        const operation = toProviderOperation(row);
        await appendAuditEvent(client, {
          operation,
          requestId: input.requestId,
          actorType: "api",
          eventType: "provider_submission_started",
          fromState: "prepared",
          fromReconciliationStatus: "not_required",
          outcome: "submitting",
        });
        return operation;
      });
    },

    async markProviderOperationUnknown(rawInput) {
      const input = markUnknownInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            update public.provider_operations
            set
              state = 'unknown',
              reconciliation_status = 'pending',
              reconcile_after = clock_timestamp()
                + ($5::integer * interval '1 millisecond'),
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where id = $1
              and owner_user_id = $2
              and state = 'submitting'
              and reconciliation_status = 'not_required'
              and transport_attempt_id = $3
              and record_version = $4::bigint
            returning ${operationReturningColumns}
          `,
          values: [
            input.operationId,
            input.ownerUserId,
            input.transportAttemptId,
            input.recordVersion,
            input.retryDelayMs,
          ],
        });
        const row = result.rows[0];

        if (row === undefined) {
          throw new InvalidProviderOperationStateError();
        }

        const operation = toProviderOperation(row);
        await appendAuditEvent(client, {
          operation,
          requestId: input.requestId,
          actorType: "api",
          eventType: "provider_submission_unknown",
          fromState: "submitting",
          fromReconciliationStatus: "not_required",
          outcome: "unknown",
          reasonCode: input.reasonCode,
        });
        return operation;
      });
    },

    async markProviderOperationResult(rawInput) {
      const input = markProviderResultInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            update public.provider_operations
            set
              state = $5,
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where id = $1
              and owner_user_id = $2
              and state = 'submitting'
              and reconciliation_status = 'not_required'
              and transport_attempt_id = $3
              and record_version = $4::bigint
            returning ${operationReturningColumns}
          `,
          values: [
            input.operationId,
            input.ownerUserId,
            input.transportAttemptId,
            input.recordVersion,
            input.state,
          ],
        });
        const row = result.rows[0];

        if (row === undefined) {
          throw new InvalidProviderOperationStateError();
        }

        const operation = toProviderOperation(row);
        await appendAuditEvent(client, {
          operation,
          requestId: input.requestId,
          actorType: "api",
          eventType: "provider_submission_resolved",
          fromState: "submitting",
          fromReconciliationStatus: "not_required",
          outcome: input.state,
          ...(input.reasonCode === undefined
            ? {}
            : { reasonCode: input.reasonCode }),
        });
        return operation;
      });
    },

    async quarantineExpiredSubmissions(rawInput) {
      const input = quarantineExpiredSubmissionsInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            with due as (
              select id as operation_id
              from public.provider_operations
              where state = 'submitting'
                and reconciliation_status = 'not_required'
                and attempt_deadline_at <= clock_timestamp()
              order by attempt_deadline_at, id
              for update skip locked
              limit $1
            )
            update public.provider_operations as operation
            set
              state = 'unknown',
              reconciliation_status = 'pending',
              reconcile_after = clock_timestamp(),
              record_version = operation.record_version + 1,
              updated_at = clock_timestamp()
            from due
            where operation.id = due.operation_id
            returning ${operationReturningColumns}
          `,
          values: [input.limit],
        });
        const operations = result.rows.map(toProviderOperation);

        for (const operation of operations) {
          await appendAuditEvent(client, {
            operation,
            requestId: input.requestId,
            actorType: "worker",
            eventType: "submission_deadline_quarantined",
            fromState: "submitting",
            fromReconciliationStatus: "not_required",
            outcome: "unknown",
            reasonCode: "submission_deadline_elapsed",
          });
        }

        return Object.freeze(operations);
      });
    },

    async leaseProviderOperationsForReconciliation(rawInput) {
      const input = leaseInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            with due as (
              select
                id as operation_id,
                reconciliation_status as previous_reconciliation_status
              from public.provider_operations
              where state = 'unknown'
                and (
                  (
                    reconciliation_status = 'pending'
                    and reconcile_after <= clock_timestamp()
                  )
                  or
                  (
                    reconciliation_status = 'leased'
                    and lease_expires_at <= clock_timestamp()
                  )
                )
              order by reconcile_after, created_at, id
              for update skip locked
              limit $1
            )
            update public.provider_operations as operation
            set
              reconciliation_status = 'leased',
              reconciliation_attempt_count =
                operation.reconciliation_attempt_count + 1,
              lease_owner = $2,
              lease_expires_at = clock_timestamp()
                + ($3::integer * interval '1 millisecond'),
              fence_token = operation.fence_token + 1,
              record_version = operation.record_version + 1,
              updated_at = clock_timestamp()
            from due
            where operation.id = due.operation_id
            returning
              ${operationReturningColumns},
              due.previous_reconciliation_status
          `,
          values: [input.limit, input.workerId, input.leaseDurationMs],
        });
        const operations: ProviderOperation[] = [];

        for (const row of result.rows) {
          const previousStatus = reconciliationStatusSchema.parse(
            row["previous_reconciliation_status"],
          );
          const operation = toProviderOperation(
            Object.fromEntries(
              Object.entries(row).filter(
                ([key]) => key !== "previous_reconciliation_status",
              ),
            ),
          );
          await appendAuditEvent(client, {
            operation,
            requestId: input.requestId,
            actorType: "worker",
            eventType: "reconciliation_leased",
            fromState: "unknown",
            fromReconciliationStatus: previousStatus,
            outcome: "leased",
          });
          operations.push(operation);
        }

        return Object.freeze(operations);
      });
    },

    async completeProviderOperationReconciliation(rawInput) {
      const input = completeReconciliationInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            with locked as materialized (
              select id as operation_id
              from public.provider_operations
              where id = $1
                and owner_user_id = $2
                and state = 'unknown'
                and reconciliation_status = 'leased'
                and lease_owner = $3
                and fence_token = $4::bigint
                and record_version = $5::bigint
              for update
            )
            update public.provider_operations as operation
            set
              state = $6,
              reconciliation_status = 'complete',
              reconcile_after = null,
              operator_required_at = null,
              lease_owner = null,
              lease_expires_at = null,
              record_version = operation.record_version + 1,
              updated_at = clock_timestamp()
            from locked
            where operation.id = locked.operation_id
              and operation.lease_expires_at > clock_timestamp()
            returning ${operationReturningColumns}
          `,
          values: [
            input.operationId,
            input.ownerUserId,
            input.workerId,
            input.fenceToken,
            input.recordVersion,
            input.state,
          ],
        });
        const row = result.rows[0];

        if (row === undefined) {
          throw new StaleProviderOperationLeaseError();
        }

        const operation = toProviderOperation(row);
        await appendAuditEvent(client, {
          operation,
          requestId: input.requestId,
          actorType: "worker",
          eventType: "reconciliation_resolved",
          fromState: "unknown",
          fromReconciliationStatus: "leased",
          outcome: input.state,
          ...(input.reasonCode === undefined
            ? {}
            : { reasonCode: input.reasonCode }),
        });
        return operation;
      });
    },

    async rescheduleProviderOperationReconciliation(rawInput) {
      const input = rescheduleReconciliationInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            with locked as materialized (
              select id as operation_id
              from public.provider_operations
              where id = $1
                and owner_user_id = $2
                and state = 'unknown'
                and reconciliation_status = 'leased'
                and lease_owner = $3
                and fence_token = $4::bigint
                and record_version = $5::bigint
              for update
            )
            update public.provider_operations as operation
            set
              reconciliation_status = 'pending',
              reconcile_after = clock_timestamp()
                + ($6::integer * interval '1 millisecond'),
              operator_required_at = null,
              lease_owner = null,
              lease_expires_at = null,
              record_version = operation.record_version + 1,
              updated_at = clock_timestamp()
            from locked
            where operation.id = locked.operation_id
              and operation.lease_expires_at > clock_timestamp()
            returning ${operationReturningColumns}
          `,
          values: [
            input.operationId,
            input.ownerUserId,
            input.workerId,
            input.fenceToken,
            input.recordVersion,
            input.retryDelayMs,
          ],
        });
        const row = result.rows[0];

        if (row === undefined) {
          throw new StaleProviderOperationLeaseError();
        }

        const operation = toProviderOperation(row);
        await appendAuditEvent(client, {
          operation,
          requestId: input.requestId,
          actorType: "worker",
          eventType: "reconciliation_rescheduled",
          fromState: "unknown",
          fromReconciliationStatus: "leased",
          outcome: "pending",
          reasonCode: input.reasonCode,
        });
        return operation;
      });
    },

    async holdProviderOperationForOperator(rawInput) {
      const input = holdReconciliationInputSchema.parse(rawInput);

      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            with locked as materialized (
              select id as operation_id
              from public.provider_operations
              where id = $1
                and owner_user_id = $2
                and state = 'unknown'
                and reconciliation_status = 'leased'
                and lease_owner = $3
                and fence_token = $4::bigint
                and record_version = $5::bigint
              for update
            )
            update public.provider_operations as operation
            set
              reconciliation_status = 'operator_required',
              reconcile_after = null,
              operator_required_at = clock_timestamp(),
              lease_owner = null,
              lease_expires_at = null,
              record_version = operation.record_version + 1,
              updated_at = clock_timestamp()
            from locked
            where operation.id = locked.operation_id
              and operation.lease_expires_at > clock_timestamp()
            returning ${operationReturningColumns}
          `,
          values: [
            input.operationId,
            input.ownerUserId,
            input.workerId,
            input.fenceToken,
            input.recordVersion,
          ],
        });
        const row = result.rows[0];

        if (row === undefined) {
          throw new StaleProviderOperationLeaseError();
        }

        const operation = toProviderOperation(row);
        await appendAuditEvent(client, {
          operation,
          requestId: input.requestId,
          actorType: "worker",
          eventType: "reconciliation_operator_required",
          fromState: "unknown",
          fromReconciliationStatus: "leased",
          outcome: "operator_required",
          reasonCode: input.reasonCode,
        });
        return operation;
      });
    },

    async consumeIssuanceQuota(rawInput) {
      const input = issuanceQuotaInputSchema.parse(rawInput);
      const buckets = [...input.buckets].sort((left, right) => {
        const leftKey = `${left.subjectKind}:${left.subjectHmac}`;
        const rightKey = `${right.subjectKind}:${right.subjectHmac}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });

      return withTransaction(pool, async (client) => {
        const consumptions: IssuanceQuotaConsumption[] = [];
        const observedAtResult = await client.query<{ observed_at: Date }>({
          text: "select clock_timestamp() as observed_at",
        });
        const observedAt = z
          .object({ observed_at: validDateSchema })
          .strict()
          .parse(observedAtResult.rows[0]).observed_at;

        for (const bucket of buckets) {
          const result = await client.query<{
            issued_count: number;
            window_started_at: Date;
          }>({
            text: `
              with quota_window as (
                select to_timestamp(
                  floor(
                    extract(epoch from $7::timestamptz) / $5::integer
                  ) * $5::integer
                ) as window_started_at
              )
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
              select $1, $2, $3, $4, window_started_at, $5, $6, $8::integer
              from quota_window
              where $8::integer <= $6::integer
              on conflict (
                capability,
                policy_version,
                subject_kind,
                subject_hmac,
                window_started_at
              )
              do update set
                issued_count = issuance_rate_records.issued_count +
                  excluded.issued_count,
                updated_at = clock_timestamp()
              where issuance_rate_records.window_duration_seconds =
                    excluded.window_duration_seconds
                and issuance_rate_records.capacity = excluded.capacity
                and issuance_rate_records.issued_count <=
                    issuance_rate_records.capacity - excluded.issued_count
              returning issued_count, window_started_at
            `,
            values: [
              input.capability,
              input.policyVersion,
              bucket.subjectKind,
              bucket.subjectHmac,
              bucket.windowDurationSeconds,
              bucket.capacity,
              observedAt,
              input.cost,
            ],
          });
          const parsed = z
            .object({
              issued_count: z.number().int().positive(),
              window_started_at: validDateSchema,
            })
            .strict()
            .safeParse(result.rows[0]);

          if (!parsed.success) {
            throw new IssuanceQuotaExceededError();
          }

          consumptions.push(
            Object.freeze({
              subjectKind: bucket.subjectKind,
              issuedCount: parsed.data.issued_count,
              windowStartedAt: parsed.data.window_started_at.toISOString(),
            }),
          );
        }

        return Object.freeze(consumptions);
      });
    },
  };
}
