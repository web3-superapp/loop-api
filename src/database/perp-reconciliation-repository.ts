import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  type FinalizePerpOrderReconciliationInput,
  type LoadClaimedPerpReconciliationSubjectInput,
  type PerpOrderReconciliationResolution,
  type PerpReconciliationItemIdentity,
  type PerpReconciliationRepository,
  type PerpReconciliationSubject,
} from "../features/perp/perp-reconciliation-contract.js";
import {
  type PerpIntentRequest,
  parsePerpIntentRequest,
} from "../features/perp/perp-intent-contract.js";
import { StaleProviderOperationLeaseError } from "./control-plane-repository.js";

const uuidSchema = z.string().uuid();
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const bigintStringSchema = z.string().regex(/^\d+$/);
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== "0x0000000000000000000000000000000000000000");
const clientOrderIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const uint64StringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => {
    try {
      return BigInt(value) <= 18_446_744_073_709_551_615n;
    } catch {
      return false;
    }
  });
const positiveDecimalStringSchema = z
  .string()
  .max(128)
  .regex(/^([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const actionSchema = z.enum([
  "order",
  "cancel",
  "modify",
  "batch_modify",
  "update_leverage",
  "update_isolated_margin",
]);
const intentStateSchema = z.enum([
  "prepared",
  "submitting",
  "accepted",
  "partial",
  "filled",
  "cancelled",
  "rejected",
  "unknown",
  "reconciling",
  "expired",
]);
const resolvedIntentStateSchema = z.enum([
  "accepted",
  "partial",
  "filled",
  "cancelled",
  "rejected",
]);

const loadInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    operationId: uuidSchema,
    workerId: uuidSchema,
    fenceToken: bigintStringSchema,
    recordVersion: bigintStringSchema,
  })
  .strict();

const resolutionItemSchema = z
  .object({
    index: z.literal(0),
    coin: z.enum(["BTC", "ETH", "SOL"]),
    generatedClientOrderId: clientOrderIdSchema,
    state: resolvedIntentStateSchema,
    providerOrderId: uint64StringSchema,
    clientOrderId: clientOrderIdSchema,
    filledSize: positiveDecimalStringSchema.nullable(),
    averageFillPrice: positiveDecimalStringSchema.nullable(),
    reasonCode: codeSchema.nullable(),
  })
  .strict();

const resolutionSchema = z
  .object({
    genericState: z.enum(["accepted", "succeeded", "rejected"]),
    intentState: resolvedIntentStateSchema,
    observedAt: rfc3339Schema,
    reasonCode: codeSchema.nullable(),
    items: z.array(resolutionItemSchema).length(1),
  })
  .strict()
  .superRefine((value, context) => {
    const item = value.items[0];
    if (item === undefined || item.state !== value.intentState) {
      context.addIssue({
        code: "custom",
        message: "The Perp reconciliation item state is inconsistent",
        path: ["items", 0, "state"],
      });
      return;
    }
    if (item.reasonCode !== value.reasonCode) {
      context.addIssue({
        code: "custom",
        message: "The Perp reconciliation reason codes are inconsistent",
        path: ["reasonCode"],
      });
    }

    const stateFactsAreCoherent = (() => {
      switch (item.state) {
        case "accepted":
          return (
            value.genericState === "accepted" &&
            item.filledSize === null &&
            item.averageFillPrice === null &&
            item.reasonCode === null
          );
        case "partial":
          return (
            value.genericState === "accepted" &&
            item.filledSize !== null &&
            item.reasonCode === null
          );
        case "filled":
          return (
            value.genericState === "succeeded" &&
            item.filledSize !== null &&
            item.reasonCode === null
          );
        case "cancelled":
          return (
            value.genericState === "succeeded" &&
            item.reasonCode !== null &&
            (item.filledSize !== null || item.averageFillPrice === null)
          );
        case "rejected":
          return (
            value.genericState === "rejected" &&
            item.filledSize === null &&
            item.averageFillPrice === null &&
            item.reasonCode !== null
          );
      }
    })();
    if (!stateFactsAreCoherent) {
      context.addIssue({
        code: "custom",
        message: "The Perp reconciliation state facts are inconsistent",
        path: ["items", 0],
      });
    }
  });

const finalizeInputSchema = loadInputSchema
  .extend({
    expectedIntentRecordVersion: bigintStringSchema,
    requestId: uuidSchema,
    resolution: resolutionSchema,
  })
  .strict();

const operationRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    domain: codeSchema,
    operation_kind: codeSchema,
    request_sha256: sha256Schema,
    state: z.enum([
      "prepared",
      "submitting",
      "accepted",
      "succeeded",
      "rejected",
      "failed",
      "unknown",
    ]),
    attempt_committed_at: validDateSchema.nullable(),
    transport_attempt_id: uuidSchema.nullable(),
    reconciliation_status: z.enum([
      "not_required",
      "pending",
      "leased",
      "operator_required",
      "complete",
    ]),
    lease_owner: uuidSchema.nullable(),
    lease_expires_at: validDateSchema.nullable(),
    lease_valid: z.boolean(),
    fence_token: bigintStringSchema,
    record_version: bigintStringSchema,
  })
  .strict();

const intentRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    domain: codeSchema,
    operation_kind: codeSchema,
    request_sha256: sha256Schema,
    action: actionSchema,
    network: z.string(),
    market: z.string(),
    dex: z.string(),
    account_address: addressSchema,
    account_kind: z.enum(["master", "subaccount"]),
    canonical_action: z.unknown(),
    state: intentStateSchema,
    result_observed_at: validDateSchema.nullable(),
    result_reason_code: codeSchema.nullable(),
    record_version: bigintStringSchema,
  })
  .strict();

const itemRowSchema = z
  .object({
    item_index: z.number().int().min(0).max(38),
    coin: z.enum(["BTC", "ETH", "SOL"]),
    target_kind: z.enum(["order_id", "client_order_id"]).nullable(),
    target_order_id: uint64StringSchema.nullable(),
    target_client_order_id: clientOrderIdSchema.nullable(),
    generated_client_order_id: clientOrderIdSchema.nullable(),
    result_state: z
      .enum([
        "accepted",
        "partial",
        "filled",
        "cancelled",
        "rejected",
        "unknown",
      ])
      .nullable(),
    result_order_id: uint64StringSchema.nullable(),
    result_client_order_id: clientOrderIdSchema.nullable(),
    filled_size: positiveDecimalStringSchema.nullable(),
    average_fill_price: positiveDecimalStringSchema.nullable(),
    reason_code: codeSchema.nullable(),
    observed_at: validDateSchema.nullable(),
  })
  .strict();

type ParsedLoadInput = z.infer<typeof loadInputSchema>;
type ParsedFinalizeInput = z.infer<typeof finalizeInputSchema>;
type LockedOperation = z.infer<typeof operationRowSchema>;
type LockedIntent = z.infer<typeof intentRowSchema>;
type DatabaseClient = Pick<PoolClient, "query">;

interface LockedSubject {
  readonly operation: LockedOperation;
  readonly intent: LockedIntent;
  readonly canonicalAction: PerpIntentRequest;
  readonly items: readonly PerpReconciliationItemIdentity[];
}

export class PerpReconciliationRepositoryUnavailableError extends Error {
  readonly code = "perp_reconciliation_unavailable";

  constructor() {
    super("The Perp reconciliation repository is unavailable");
    this.name = "PerpReconciliationRepositoryUnavailableError";
  }
}

function failUnavailable(): never {
  throw new PerpReconciliationRepositoryUnavailableError();
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
      throw new PerpReconciliationRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof StaleProviderOperationLeaseError ||
    error instanceof PerpReconciliationRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new PerpReconciliationRepositoryUnavailableError();
}

function targetMatches(
  item: PerpReconciliationItemIdentity,
  target: Readonly<
    | { kind: "order_id"; order_id: string }
    | { kind: "client_order_id"; client_order_id: string }
  >,
): boolean {
  return target.kind === "order_id"
    ? item.targetKind === "order_id" &&
        item.targetOrderId === target.order_id &&
        item.targetClientOrderId === null
    : item.targetKind === "client_order_id" &&
        item.targetOrderId === null &&
        item.targetClientOrderId === target.client_order_id;
}

function hasNoTarget(item: PerpReconciliationItemIdentity): boolean {
  return (
    item.targetKind === null &&
    item.targetOrderId === null &&
    item.targetClientOrderId === null
  );
}

function itemSetMatchesAction(
  action: PerpIntentRequest,
  items: readonly PerpReconciliationItemIdentity[],
): boolean {
  switch (action.action) {
    case "order": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        item.index === 0 &&
        item.coin === action.coin &&
        hasNoTarget(item) &&
        item.generatedClientOrderId !== null
      );
    }
    case "cancel": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        item.index === 0 &&
        item.coin === action.coin &&
        targetMatches(item, action.target) &&
        item.generatedClientOrderId === null
      );
    }
    case "modify": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        item.index === 0 &&
        item.coin === action.coin &&
        targetMatches(item, action.target) &&
        item.generatedClientOrderId !== null
      );
    }
    case "batch_modify":
      return (
        items.length === action.modifications.length &&
        items.every((item, index) => {
          const modification = action.modifications[index];
          return (
            modification !== undefined &&
            item.index === index &&
            item.coin === modification.coin &&
            targetMatches(item, modification.target) &&
            item.generatedClientOrderId !== null
          );
        })
      );
    case "update_leverage":
    case "update_isolated_margin": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        item.index === 0 &&
        item.coin === action.coin &&
        hasNoTarget(item) &&
        item.generatedClientOrderId === null
      );
    }
  }
}

async function lockClaimedOperation(
  client: DatabaseClient,
  input: ParsedLoadInput,
): Promise<LockedOperation> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        id,
        owner_user_id,
        domain,
        operation_kind,
        request_sha256,
        state,
        attempt_committed_at,
        transport_attempt_id,
        reconciliation_status,
        lease_owner,
        lease_expires_at,
        lease_expires_at is not null
          and lease_expires_at > clock_timestamp() as lease_valid,
        fence_token::text as fence_token,
        record_version::text as record_version
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
  const parsed = operationRowSchema.safeParse(row);
  if (!parsed.success) {
    return failUnavailable();
  }
  const operation = parsed.data;
  if (
    operation.domain !== "hyperliquid" ||
    operation.operation_kind !== "perp_intent" ||
    operation.attempt_committed_at === null ||
    operation.transport_attempt_id === null
  ) {
    return failUnavailable();
  }
  if (
    operation.owner_user_id !== input.ownerUserId ||
    operation.state !== "unknown" ||
    operation.reconciliation_status !== "leased" ||
    operation.lease_owner !== input.workerId ||
    operation.fence_token !== input.fenceToken ||
    operation.record_version !== input.recordVersion ||
    !operation.lease_valid
  ) {
    throw new StaleProviderOperationLeaseError();
  }
  return operation;
}

async function lockIntent(
  client: DatabaseClient,
  operation: LockedOperation,
): Promise<{
  readonly intent: LockedIntent;
  readonly canonicalAction: PerpIntentRequest;
}> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        id,
        owner_user_id,
        domain,
        operation_kind,
        request_sha256,
        action,
        network,
        market,
        dex,
        account_address,
        account_kind,
        canonical_action,
        state,
        result_observed_at,
        result_reason_code,
        record_version::text as record_version
      from public.perp_intents
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
  let canonicalAction: PerpIntentRequest;
  try {
    canonicalAction = parsePerpIntentRequest(intent.canonical_action);
  } catch {
    return failUnavailable();
  }
  if (
    intent.id !== operation.id ||
    intent.owner_user_id !== operation.owner_user_id ||
    intent.domain !== operation.domain ||
    intent.operation_kind !== operation.operation_kind ||
    intent.request_sha256 !== operation.request_sha256 ||
    intent.network !== "testnet" ||
    intent.market !== "core_perps" ||
    intent.dex !== "" ||
    intent.action !== canonicalAction.action ||
    (intent.state !== "unknown" && intent.state !== "reconciling") ||
    intent.result_observed_at !== null ||
    intent.result_reason_code !== null
  ) {
    return failUnavailable();
  }
  return Object.freeze({ intent, canonicalAction });
}

async function lockItems(
  client: DatabaseClient,
  intent: LockedIntent,
): Promise<readonly PerpReconciliationItemIdentity[]> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        item_index,
        coin,
        target_kind,
        target_order_id,
        target_client_order_id,
        generated_client_order_id,
        result_state,
        result_order_id,
        result_client_order_id,
        filled_size,
        average_fill_price,
        reason_code,
        observed_at
      from public.perp_intent_items
      where intent_id = $1 and owner_user_id = $2
      order by item_index
      for update
    `,
    values: [intent.id, intent.owner_user_id],
  });

  try {
    return Object.freeze(
      result.rows.map((row) => {
        const parsed = itemRowSchema.parse(row);
        const targetIsValid =
          (parsed.target_kind === null &&
            parsed.target_order_id === null &&
            parsed.target_client_order_id === null) ||
          (parsed.target_kind === "order_id" &&
            parsed.target_order_id !== null &&
            parsed.target_client_order_id === null) ||
          (parsed.target_kind === "client_order_id" &&
            parsed.target_order_id === null &&
            parsed.target_client_order_id !== null);
        if (!targetIsValid) {
          return failUnavailable();
        }
        if (
          parsed.result_state !== null ||
          parsed.result_order_id !== null ||
          parsed.result_client_order_id !== null ||
          parsed.filled_size !== null ||
          parsed.average_fill_price !== null ||
          parsed.reason_code !== null ||
          parsed.observed_at !== null
        ) {
          return failUnavailable();
        }
        return Object.freeze({
          index: parsed.item_index,
          coin: parsed.coin,
          targetKind: parsed.target_kind,
          targetOrderId: parsed.target_order_id,
          targetClientOrderId: parsed.target_client_order_id,
          generatedClientOrderId: parsed.generated_client_order_id,
        });
      }),
    );
  } catch (error) {
    if (error instanceof PerpReconciliationRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

async function lockSubject(
  client: DatabaseClient,
  input: ParsedLoadInput,
): Promise<LockedSubject> {
  const operation = await lockClaimedOperation(client, input);
  const { intent, canonicalAction } = await lockIntent(client, operation);
  const items = await lockItems(client, intent);
  if (!itemSetMatchesAction(canonicalAction, items)) {
    return failUnavailable();
  }
  return Object.freeze({ operation, intent, canonicalAction, items });
}

function toSubject(locked: LockedSubject): PerpReconciliationSubject {
  const attemptCommittedAt = locked.operation.attempt_committed_at;
  if (attemptCommittedAt === null) {
    return failUnavailable();
  }
  return Object.freeze({
    operationId: locked.operation.id,
    ownerUserId: locked.operation.owner_user_id,
    action: locked.intent.action,
    accountAddress: locked.intent.account_address,
    accountKind: locked.intent.account_kind,
    attemptCommittedAt: attemptCommittedAt.toISOString(),
    intentRecordVersion: locked.intent.record_version,
    canonicalAction: locked.canonicalAction,
    items: locked.items,
  });
}

function normalizeResolution(
  resolution: z.infer<typeof resolutionSchema>,
): PerpOrderReconciliationResolution {
  return Object.freeze({
    genericState: resolution.genericState,
    intentState: resolution.intentState,
    observedAt: new Date(resolution.observedAt).toISOString(),
    reasonCode: resolution.reasonCode,
    items: Object.freeze(
      resolution.items.map((item) => Object.freeze({ ...item })),
    ),
  });
}

async function writeResolvedItems(
  client: DatabaseClient,
  subject: LockedSubject,
  resolution: PerpOrderReconciliationResolution,
): Promise<void> {
  const storedItem = subject.items[0];
  const resolvedItem = resolution.items[0];
  if (
    subject.items.length !== 1 ||
    storedItem === undefined ||
    resolvedItem === undefined ||
    storedItem.index !== 0 ||
    resolvedItem.index !== storedItem.index ||
    resolvedItem.coin !== storedItem.coin ||
    storedItem.generatedClientOrderId === null ||
    resolvedItem.generatedClientOrderId !== storedItem.generatedClientOrderId ||
    resolvedItem.clientOrderId !== storedItem.generatedClientOrderId
  ) {
    return failUnavailable();
  }

  const result = await client.query({
    text: `
      update public.perp_intent_items
      set
        result_state = $7,
        result_order_id = $8,
        result_client_order_id = $9,
        filled_size = $10,
        average_fill_price = $11,
        reason_code = $12,
        observed_at = $13::timestamptz,
        updated_at = clock_timestamp()
      where intent_id = $1
        and owner_user_id = $2
        and item_index = $3
        and coin = $4
        and target_kind is null
        and target_order_id is null
        and target_client_order_id is null
        and generated_client_order_id = $5
        and item_index = $6
    `,
    values: [
      subject.intent.id,
      subject.intent.owner_user_id,
      storedItem.index,
      storedItem.coin,
      storedItem.generatedClientOrderId,
      resolvedItem.index,
      resolvedItem.state,
      resolvedItem.providerOrderId,
      resolvedItem.clientOrderId,
      resolvedItem.filledSize,
      resolvedItem.averageFillPrice,
      resolvedItem.reasonCode,
      resolution.observedAt,
    ],
  });
  if (result.rowCount !== 1) {
    return failUnavailable();
  }
}

async function writeResolvedIntent(
  client: DatabaseClient,
  subject: LockedSubject,
  input: ParsedFinalizeInput,
  resolution: PerpOrderReconciliationResolution,
): Promise<{
  readonly fromState: "unknown" | "reconciling";
  readonly version: string;
}> {
  const result = await client.query<{
    from_state: "unknown" | "reconciling";
    record_version: string;
  }>({
    text: `
      with locked as materialized (
        select id, state as from_state
        from public.perp_intents
        where id = $1
          and owner_user_id = $2
          and domain = 'hyperliquid'
          and operation_kind = 'perp_intent'
          and action = 'order'
          and state in ('unknown', 'reconciling')
          and record_version = $3::bigint
      )
      update public.perp_intents as intent
      set
        state = $4,
        result_observed_at = $5::timestamptz,
        result_reason_code = $6,
        record_version = intent.record_version + 1,
        updated_at = clock_timestamp()
      from locked
      where intent.id = locked.id
      returning
        locked.from_state,
        intent.record_version::text as record_version
    `,
    values: [
      subject.intent.id,
      subject.intent.owner_user_id,
      input.expectedIntentRecordVersion,
      resolution.intentState,
      resolution.observedAt,
      resolution.reasonCode,
    ],
  });
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    return failUnavailable();
  }
  return Object.freeze({
    fromState: row.from_state,
    version: row.record_version,
  });
}

async function writeResolvedOperation(
  client: DatabaseClient,
  subject: LockedSubject,
  input: ParsedFinalizeInput,
  resolution: PerpOrderReconciliationResolution,
): Promise<string> {
  const result = await client.query<{ record_version: string }>({
    text: `
      update public.provider_operations
      set
        state = $6,
        reconciliation_status = 'complete',
        reconcile_after = null,
        operator_required_at = null,
        lease_owner = null,
        lease_expires_at = null,
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1
        and owner_user_id = $2
        and domain = 'hyperliquid'
        and operation_kind = 'perp_intent'
        and state = 'unknown'
        and reconciliation_status = 'leased'
        and lease_owner = $3
        and fence_token = $4::bigint
        and record_version = $5::bigint
        and lease_expires_at > clock_timestamp()
      returning record_version::text as record_version
    `,
    values: [
      subject.operation.id,
      subject.operation.owner_user_id,
      input.workerId,
      input.fenceToken,
      input.recordVersion,
      resolution.genericState,
    ],
  });
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    throw new StaleProviderOperationLeaseError();
  }
  return row.record_version;
}

async function appendResolutionEvents(
  client: DatabaseClient,
  subject: LockedSubject,
  input: ParsedFinalizeInput,
  resolution: PerpOrderReconciliationResolution,
  operationVersion: string,
  intentTransition: Readonly<{
    fromState: "unknown" | "reconciling";
    version: string;
  }>,
): Promise<void> {
  const audit = await client.query({
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
        $1, $2, $3, 'worker', 'reconciliation_resolved', 'unknown', $4,
        'leased', 'complete', $4, $5, $6::bigint, $7::bigint, $8
      )
    `,
    values: [
      subject.operation.owner_user_id,
      subject.operation.id,
      input.requestId,
      resolution.genericState,
      resolution.reasonCode,
      operationVersion,
      subject.operation.fence_token,
      subject.operation.transport_attempt_id,
    ],
  });
  if (audit.rowCount !== 1) {
    return failUnavailable();
  }

  const event = await client.query({
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
        reason_code,
        intent_version
      )
      values (
        $1, $2, $3, 'worker', 'intent_reconciliation_resolved', $4, $5,
        $5, $6, $7::bigint
      )
    `,
    values: [
      subject.intent.id,
      subject.intent.owner_user_id,
      input.requestId,
      intentTransition.fromState,
      resolution.intentState,
      resolution.reasonCode,
      intentTransition.version,
    ],
  });
  if (event.rowCount !== 1) {
    return failUnavailable();
  }
}

export function createPostgresPerpReconciliationRepository(
  pool: Pool,
): PerpReconciliationRepository {
  return Object.freeze({
    async loadClaimedSubject(
      rawInput: LoadClaimedPerpReconciliationSubjectInput,
    ): Promise<PerpReconciliationSubject> {
      try {
        const input = loadInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) =>
          toSubject(await lockSubject(client, input)),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async finalizeOrderResolution(
      rawInput: FinalizePerpOrderReconciliationInput,
    ): Promise<void> {
      try {
        const parsed = finalizeInputSchema.parse(rawInput);
        const resolution = normalizeResolution(parsed.resolution);
        await withTransaction(pool, async (client) => {
          const subject = await lockSubject(client, parsed);
          if (
            subject.intent.record_version !==
              parsed.expectedIntentRecordVersion ||
            subject.canonicalAction.action !== "order" ||
            subject.canonicalAction.order_type !== "limit"
          ) {
            return failUnavailable();
          }
          await writeResolvedItems(client, subject, resolution);
          const intentTransition = await writeResolvedIntent(
            client,
            subject,
            parsed,
            resolution,
          );
          const operationVersion = await writeResolvedOperation(
            client,
            subject,
            parsed,
            resolution,
          );
          await appendResolutionEvents(
            client,
            subject,
            parsed,
            resolution,
            operationVersion,
            intentTransition,
          );
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
