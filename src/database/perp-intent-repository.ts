import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  PERP_INTENT_BATCH_MAX_ITEMS,
  PERP_INTENT_IDEMPOTENCY_SCOPE,
  PERP_INTENT_REQUEST_DIGEST_VERSION,
  type PerpIntentActionKind,
  type PerpIntentRequest,
  type PerpIntentResourceState,
  type PerpIntentResult,
  type PerpIntentResultItemState,
  type PerpOrderTarget,
  type PerpPublicReview,
  parsePerpIntentRequest,
  parsePerpIntentResult,
  parsePerpPublicReviewForRequest,
} from "../features/perp/perp-intent-contract.js";
import { IdempotencyConflictError } from "./control-plane-repository.js";

export const PERP_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER = 32;
export const PERP_INTENT_PENDING_CLAIM_GLOBAL_FUSE = 10_000;

const claimBudgetLockName = "loop.perp_intent.claim_budget.v1";

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== "0x0000000000000000000000000000000000000000");
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => {
    try {
      return BigInt(value) <= 9_223_372_036_854_775_807n;
    } catch {
      return false;
    }
  });
const actionSchema = z.enum([
  "order",
  "cancel",
  "modify",
  "batch_modify",
  "update_leverage",
  "update_isolated_margin",
]);
const resourceStateSchema = z.enum([
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
const resultItemStateSchema = z.enum([
  "accepted",
  "partial",
  "filled",
  "cancelled",
  "rejected",
  "unknown",
]);
const coreCoinSchema = z.enum(["BTC", "ETH", "SOL"]);
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
const clientOrderIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const decimalStringSchema = z
  .string()
  .max(128)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

const storedItemInputSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(PERP_INTENT_BATCH_MAX_ITEMS - 1),
    coin: coreCoinSchema,
    targetKind: z.enum(["order_id", "client_order_id"]).nullable(),
    targetOrderId: uint64StringSchema.nullable(),
    targetClientOrderId: clientOrderIdSchema.nullable(),
    generatedClientOrderId: clientOrderIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const validTarget =
      (value.targetKind === null &&
        value.targetOrderId === null &&
        value.targetClientOrderId === null) ||
      (value.targetKind === "order_id" &&
        value.targetOrderId !== null &&
        value.targetClientOrderId === null) ||
      (value.targetKind === "client_order_id" &&
        value.targetOrderId === null &&
        value.targetClientOrderId !== null);

    if (!validTarget) {
      context.addIssue({
        code: "custom",
        message: "The Perp intent item target is inconsistent",
      });
    }
  });

const claimPrepareInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
  })
  .strict();

const prepareInputEnvelopeSchema = z
  .object({
    ownerUserId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    requestId: uuidSchema,
    accountAddress: addressSchema,
    accountKind: z.enum(["master", "subaccount"]),
    bindingVersion: bindingVersionSchema,
    action: actionSchema,
    reviewSha256: sha256Schema,
    factsObservedAt: rfc3339Schema,
    expiresAt: rfc3339Schema,
    items: z
      .array(storedItemInputSchema)
      .min(1)
      .max(PERP_INTENT_BATCH_MAX_ITEMS),
  })
  .strict();

const intentRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    request_sha256: sha256Schema,
    request_digest_version: z.literal(PERP_INTENT_REQUEST_DIGEST_VERSION),
    action: actionSchema,
    account_address: addressSchema,
    account_kind: z.enum(["master", "subaccount"]),
    binding_version: bindingVersionSchema,
    canonical_action: z.unknown(),
    public_review: z.unknown(),
    review_sha256: sha256Schema,
    facts_observed_at: validDateSchema,
    expires_at: validDateSchema,
    state: resourceStateSchema,
    result_observed_at: validDateSchema.nullable(),
    created_at: validDateSchema,
    updated_at: validDateSchema,
    items: z.array(z.unknown()),
  })
  .strict();

const itemRowSchema = z
  .object({
    item_index: z
      .number()
      .int()
      .min(0)
      .max(PERP_INTENT_BATCH_MAX_ITEMS - 1),
    coin: coreCoinSchema,
    target_kind: z.enum(["order_id", "client_order_id"]).nullable(),
    target_order_id: uint64StringSchema.nullable(),
    target_client_order_id: clientOrderIdSchema.nullable(),
    generated_client_order_id: clientOrderIdSchema.nullable(),
    result_state: resultItemStateSchema.nullable(),
    result_order_id: uint64StringSchema.nullable(),
    result_client_order_id: clientOrderIdSchema.nullable(),
    filled_size: decimalStringSchema.nullable(),
    average_fill_price: decimalStringSchema.nullable(),
    reason_code: reasonCodeSchema.nullable(),
    observed_at: rfc3339Schema.nullable(),
  })
  .strict();

const intentReturningColumns = `
  intent.id,
  intent.owner_user_id,
  intent.request_sha256,
  intent.request_digest_version,
  intent.action,
  intent.account_address,
  intent.account_kind,
  intent.binding_version::text as binding_version,
  intent.canonical_action,
  intent.public_review,
  intent.review_sha256,
  intent.facts_observed_at,
  intent.expires_at,
  case
    when intent.state = 'prepared'
      and intent.expires_at <= clock_timestamp()
    then 'expired'
    else intent.state
  end as state,
  intent.result_observed_at,
  intent.created_at,
  intent.updated_at,
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'item_index', item.item_index,
        'coin', item.coin,
        'target_kind', item.target_kind,
        'target_order_id', item.target_order_id,
        'target_client_order_id', item.target_client_order_id,
        'generated_client_order_id', item.generated_client_order_id,
        'result_state', item.result_state,
        'result_order_id', item.result_order_id,
        'result_client_order_id', item.result_client_order_id,
        'filled_size', item.filled_size,
        'average_fill_price', item.average_fill_price,
        'reason_code', item.reason_code,
        'observed_at', item.observed_at
      )
      order by item.item_index
    )
    from public.perp_intent_items as item
    where item.intent_id = intent.id
  ), '[]'::jsonb) as items
`;

export type PerpIntentAccountKind = "master" | "subaccount";
export type PerpIntentItemTargetKind = "order_id" | "client_order_id";

export interface PerpIntentStoredItem {
  readonly index: number;
  readonly coin: "BTC" | "ETH" | "SOL";
  readonly targetKind: PerpIntentItemTargetKind | null;
  readonly targetOrderId: string | null;
  readonly targetClientOrderId: string | null;
  readonly generatedClientOrderId: string | null;
  readonly resultState: PerpIntentResultItemState | null;
  readonly resultOrderId: string | null;
  readonly resultClientOrderId: string | null;
  readonly filledSize: string | null;
  readonly averageFillPrice: string | null;
  readonly reasonCode: string | null;
  readonly observedAt: string | null;
}

export interface PerpIntentRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly requestSha256: string;
  readonly action: PerpIntentActionKind;
  readonly state: PerpIntentResourceState;
  readonly accountAddress: string;
  readonly accountKind: PerpIntentAccountKind;
  readonly bindingVersion: string;
  readonly canonicalAction: PerpIntentRequest;
  readonly publicReview: PerpPublicReview;
  readonly reviewSha256: string;
  readonly factsObservedAt: string;
  readonly expiresAt: string;
  readonly items: readonly PerpIntentStoredItem[];
  readonly result: PerpIntentResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimPerpIntentPrepareInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
}

export type ClaimPerpIntentPrepareResult =
  | { readonly kind: "claimed" }
  | { readonly kind: "replay"; readonly intent: PerpIntentRecord };

export interface PreparePerpIntentItemInput {
  readonly index: number;
  readonly coin: "BTC" | "ETH" | "SOL";
  readonly targetKind: PerpIntentItemTargetKind | null;
  readonly targetOrderId: string | null;
  readonly targetClientOrderId: string | null;
  readonly generatedClientOrderId: string | null;
}

export interface PreparePerpIntentInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly accountAddress: string;
  readonly accountKind: PerpIntentAccountKind;
  readonly bindingVersion: string;
  readonly action: PerpIntentActionKind;
  readonly canonicalAction: PerpIntentRequest;
  readonly publicReview: PerpPublicReview;
  readonly reviewSha256: string;
  readonly factsObservedAt: string;
  readonly expiresAt: string;
  readonly items: readonly PreparePerpIntentItemInput[];
}

export interface PerpIntentRepository {
  claimPrepare(
    input: ClaimPerpIntentPrepareInput,
  ): Promise<ClaimPerpIntentPrepareResult>;
  prepare(input: PreparePerpIntentInput): Promise<{
    readonly created: boolean;
    readonly intent: PerpIntentRecord;
  }>;
  findOwned(
    ownerUserId: string,
    intentId: string,
  ): Promise<PerpIntentRecord | null>;
}

export class PerpIntentPrepareExpiredError extends Error {
  readonly code = "perp_intent_expired";

  constructor() {
    super("The Perp intent review is already expired");
    this.name = "PerpIntentPrepareExpiredError";
  }
}

export class PerpIntentClaimLimitExceededError extends Error {
  readonly code = "perp_intent_claim_rate_limited";

  constructor() {
    super("The Perp intent pending-claim budget is exhausted");
    this.name = "PerpIntentClaimLimitExceededError";
  }
}

export class PerpIntentRepositoryUnavailableError extends Error {
  readonly code = "perp_intent_unavailable";

  constructor() {
    super("The Perp intent repository is unavailable");
    this.name = "PerpIntentRepositoryUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new PerpIntentRepositoryUnavailableError());
}

export function createUnavailablePerpIntentRepository(): PerpIntentRepository {
  return Object.freeze({
    claimPrepare: unavailable,
    prepare: unavailable,
    findOwned: unavailable,
  });
}

type DatabaseClient = Pick<PoolClient, "query">;

interface ParsedPrepareInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly accountAddress: string;
  readonly accountKind: PerpIntentAccountKind;
  readonly bindingVersion: string;
  readonly action: PerpIntentActionKind;
  readonly canonicalAction: PerpIntentRequest;
  readonly publicReview: PerpPublicReview;
  readonly reviewSha256: string;
  readonly factsObservedAt: string;
  readonly expiresAt: string;
  readonly items: readonly PreparePerpIntentItemInput[];
}

function itemMatchesTarget(
  item: PreparePerpIntentItemInput,
  target: PerpOrderTarget,
): boolean {
  return target.kind === "order_id"
    ? item.targetKind === "order_id" &&
        item.targetOrderId === target.order_id &&
        item.targetClientOrderId === null
    : item.targetKind === "client_order_id" &&
        item.targetOrderId === null &&
        item.targetClientOrderId === target.client_order_id;
}

function itemHasNoTarget(item: PreparePerpIntentItemInput): boolean {
  return (
    item.targetKind === null &&
    item.targetOrderId === null &&
    item.targetClientOrderId === null
  );
}

function itemSetMatchesReview(
  action: PerpIntentRequest,
  review: PerpPublicReview,
  items: readonly PreparePerpIntentItemInput[],
): boolean {
  switch (action.action) {
    case "order": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        review.action.action === "order" &&
        item.coin === action.coin &&
        itemHasNoTarget(item) &&
        item.generatedClientOrderId === review.action.client_order_id
      );
    }
    case "cancel": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        item.coin === action.coin &&
        itemMatchesTarget(item, action.target) &&
        item.generatedClientOrderId === null
      );
    }
    case "modify": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        review.action.action === "modify" &&
        item.coin === action.coin &&
        itemMatchesTarget(item, action.target) &&
        item.generatedClientOrderId ===
          review.action.replacement_client_order_id
      );
    }
    case "batch_modify": {
      if (
        review.action.action !== "batch_modify" ||
        items.length !== action.modifications.length ||
        review.action.modifications.length !== action.modifications.length
      ) {
        return false;
      }
      const reviewedModifications = review.action.modifications;
      return items.every((item, index) => {
        const modification = action.modifications[index];
        const reviewedModification = reviewedModifications[index];
        return (
          modification !== undefined &&
          reviewedModification !== undefined &&
          item.coin === modification.coin &&
          itemMatchesTarget(item, modification.target) &&
          item.generatedClientOrderId ===
            reviewedModification.replacement_client_order_id
        );
      });
    }
    case "update_leverage":
    case "update_isolated_margin": {
      const item = items[0];
      return (
        items.length === 1 &&
        item !== undefined &&
        item.coin === action.coin &&
        itemHasNoTarget(item) &&
        item.generatedClientOrderId === null
      );
    }
  }
}

function failUnavailable(): never {
  throw new PerpIntentRepositoryUnavailableError();
}

function parsePrepareInput(
  rawInput: PreparePerpIntentInput,
): ParsedPrepareInput {
  try {
    const envelope = prepareInputEnvelopeSchema.parse({
      ownerUserId: rawInput.ownerUserId,
      idempotencyKey: rawInput.idempotencyKey,
      requestSha256: rawInput.requestSha256,
      requestId: rawInput.requestId,
      accountAddress: rawInput.accountAddress,
      accountKind: rawInput.accountKind,
      bindingVersion: rawInput.bindingVersion,
      action: rawInput.action,
      reviewSha256: rawInput.reviewSha256,
      factsObservedAt: rawInput.factsObservedAt,
      expiresAt: rawInput.expiresAt,
      items: rawInput.items,
    });
    const canonicalAction = parsePerpIntentRequest(rawInput.canonicalAction);
    const publicReview = parsePerpPublicReviewForRequest(
      canonicalAction,
      rawInput.publicReview,
    );

    if (
      canonicalAction.action !== envelope.action ||
      publicReview.action.action !== envelope.action ||
      publicReview.source.fetched_at !== envelope.factsObservedAt ||
      publicReview.source.expires_at !== envelope.expiresAt ||
      Date.parse(envelope.factsObservedAt) >= Date.parse(envelope.expiresAt)
    ) {
      return failUnavailable();
    }

    const indexes = envelope.items.map(({ index }) => index);
    if (
      new Set(indexes).size !== indexes.length ||
      indexes.some((index, position) => index !== position) ||
      !itemSetMatchesReview(canonicalAction, publicReview, envelope.items)
    ) {
      return failUnavailable();
    }

    return Object.freeze({
      ...envelope,
      canonicalAction,
      publicReview,
      items: Object.freeze(
        envelope.items.map((item) => Object.freeze({ ...item })),
      ),
    });
  } catch (error) {
    if (error instanceof PerpIntentRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

function parseStoredItem(value: unknown): PerpIntentStoredItem {
  const parsed = itemRowSchema.parse(value);
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

  return Object.freeze({
    index: parsed.item_index,
    coin: parsed.coin,
    targetKind: parsed.target_kind,
    targetOrderId: parsed.target_order_id,
    targetClientOrderId: parsed.target_client_order_id,
    generatedClientOrderId: parsed.generated_client_order_id,
    resultState: parsed.result_state,
    resultOrderId: parsed.result_order_id,
    resultClientOrderId: parsed.result_client_order_id,
    filledSize: parsed.filled_size,
    averageFillPrice: parsed.average_fill_price,
    reasonCode: parsed.reason_code,
    observedAt: parsed.observed_at,
  });
}

function toPerpIntentRecord(value: unknown): PerpIntentRecord {
  try {
    const parsed = intentRowSchema.parse(value);
    const canonicalAction = parsePerpIntentRequest(parsed.canonical_action);
    const publicReview = parsePerpPublicReviewForRequest(
      canonicalAction,
      parsed.public_review,
    );
    const items = Object.freeze(parsed.items.map(parseStoredItem));
    const preparedItems = items.map((item) => ({
      index: item.index,
      coin: item.coin,
      targetKind: item.targetKind,
      targetOrderId: item.targetOrderId,
      targetClientOrderId: item.targetClientOrderId,
      generatedClientOrderId: item.generatedClientOrderId,
    }));

    if (
      canonicalAction.action !== parsed.action ||
      publicReview.action.action !== parsed.action ||
      Date.parse(publicReview.source.fetched_at) !==
        parsed.facts_observed_at.getTime() ||
      Date.parse(publicReview.source.expires_at) !==
        parsed.expires_at.getTime() ||
      items.some(({ index }, position) => index !== position) ||
      !itemSetMatchesReview(canonicalAction, publicReview, preparedItems)
    ) {
      return failUnavailable();
    }

    const itemsWithResult = items.filter(
      ({ resultState }) => resultState !== null,
    );
    if (
      itemsWithResult.length !== 0 &&
      itemsWithResult.length !== items.length
    ) {
      return failUnavailable();
    }

    let result: PerpIntentResult | null = null;
    if (itemsWithResult.length > 0) {
      result = parsePerpIntentResult({
        observed_at: parsed.result_observed_at?.toISOString() ?? null,
        items: items.map((item) => ({
          index: item.index,
          state: item.resultState,
          order_id: item.resultOrderId,
          client_order_id: item.resultClientOrderId,
          filled_size: item.filledSize,
          average_fill_price: item.averageFillPrice,
          reason_code: item.reasonCode,
        })),
      });
    }

    return Object.freeze({
      id: parsed.id,
      ownerUserId: parsed.owner_user_id,
      requestSha256: parsed.request_sha256,
      action: parsed.action,
      state: parsed.state,
      accountAddress: parsed.account_address,
      accountKind: parsed.account_kind,
      bindingVersion: parsed.binding_version,
      canonicalAction,
      publicReview,
      reviewSha256: parsed.review_sha256,
      factsObservedAt: publicReview.source.fetched_at,
      expiresAt: publicReview.source.expires_at,
      items,
      result,
      createdAt: parsed.created_at.toISOString(),
      updatedAt: parsed.updated_at.toISOString(),
    });
  } catch (error) {
    if (error instanceof PerpIntentRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw new PerpIntentRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

async function readOwnedIntent(
  client: DatabaseClient,
  ownerUserId: string,
  intentId: string,
): Promise<PerpIntentRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${intentReturningColumns}
      from public.perp_intents as intent
      where intent.owner_user_id = $1 and intent.id = $2
      limit 1
    `,
    values: [ownerUserId, intentId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toPerpIntentRecord(row);
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof PerpIntentClaimLimitExceededError ||
    error instanceof PerpIntentPrepareExpiredError ||
    error instanceof PerpIntentRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new PerpIntentRepositoryUnavailableError();
}

async function reservePerpIntentClaim(
  client: DatabaseClient,
  input: ClaimPerpIntentPrepareInput,
): Promise<string> {
  await client.query({
    text: "select pg_advisory_xact_lock(hashtext($1))",
    values: [claimBudgetLockName],
  });

  const existingResult = await client.query<{
    id: string;
    owner_user_id: string;
    key_source: string;
    request_sha256: string;
    digest_version: string;
  }>({
    text: `
      select id, owner_user_id, key_source, request_sha256, digest_version
      from public.idempotency_records
      where scope = $1 and idempotency_key = $2
      for update
    `,
    values: [PERP_INTENT_IDEMPOTENCY_SCOPE, input.idempotencyKey],
  });
  const existing = existingResult.rows[0];
  if (existing !== undefined) {
    if (
      existing.owner_user_id !== input.ownerUserId ||
      existing.key_source !== "client" ||
      existing.request_sha256 !== input.requestSha256 ||
      existing.digest_version !== PERP_INTENT_REQUEST_DIGEST_VERSION
    ) {
      throw new IdempotencyConflictError();
    }

    await client.query({
      text: `
        update public.idempotency_records
        set last_seen_at = clock_timestamp()
        where id = $1
      `,
      values: [existing.id],
    });
    return existing.id;
  }

  const budgetResult = await client.query<{
    global_pending: string;
    owner_pending: string;
  }>({
    text: `
      select
        count(*) filter (where claim.owner_user_id = $2)::text
          as owner_pending,
        count(*)::text as global_pending
      from public.idempotency_records as claim
      where claim.scope = $1
        and not exists (
          select 1
          from public.provider_operations as operation
          where operation.idempotency_record_id = claim.id
        )
    `,
    values: [PERP_INTENT_IDEMPOTENCY_SCOPE, input.ownerUserId],
  });
  const ownerPending = Number.parseInt(
    budgetResult.rows[0]?.owner_pending ?? "",
    10,
  );
  const globalPending = Number.parseInt(
    budgetResult.rows[0]?.global_pending ?? "",
    10,
  );
  if (
    !Number.isSafeInteger(ownerPending) ||
    !Number.isSafeInteger(globalPending)
  ) {
    throw new PerpIntentRepositoryUnavailableError();
  }
  if (
    ownerPending >= PERP_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER ||
    globalPending >= PERP_INTENT_PENDING_CLAIM_GLOBAL_FUSE
  ) {
    throw new PerpIntentClaimLimitExceededError();
  }

  const inserted = await client.query<{ id: string }>({
    text: `
      insert into public.idempotency_records (
        owner_user_id,
        scope,
        idempotency_key,
        key_source,
        request_sha256,
        digest_version
      )
      values ($1, $2, $3, 'client', $4, $5)
      returning id
    `,
    values: [
      input.ownerUserId,
      PERP_INTENT_IDEMPOTENCY_SCOPE,
      input.idempotencyKey,
      input.requestSha256,
      PERP_INTENT_REQUEST_DIGEST_VERSION,
    ],
  });
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new PerpIntentRepositoryUnavailableError();
  }
  return id;
}

export function createPostgresPerpIntentRepository(
  pool: Pool,
): PerpIntentRepository {
  return Object.freeze({
    async claimPrepare(
      rawInput: ClaimPerpIntentPrepareInput,
    ): Promise<ClaimPerpIntentPrepareResult> {
      try {
        const input = claimPrepareInputSchema.parse(rawInput);

        return await withTransaction(pool, async (client) => {
          const idempotencyId = await reservePerpIntentClaim(client, input);

          const operationResult = await client.query<{ id: string }>({
            text: `
              select id
              from public.provider_operations
              where idempotency_record_id = $1
              limit 1
            `,
            values: [idempotencyId],
          });
          const operationId = operationResult.rows[0]?.id;
          if (operationId === undefined) {
            return Object.freeze({ kind: "claimed" as const });
          }

          const intent = await readOwnedIntent(
            client,
            input.ownerUserId,
            operationId,
          );
          if (intent === null) {
            return failUnavailable();
          }
          return Object.freeze({ kind: "replay" as const, intent });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async prepare(rawInput: PreparePerpIntentInput): Promise<{
      readonly created: boolean;
      readonly intent: PerpIntentRecord;
    }> {
      try {
        const input = parsePrepareInput(rawInput);

        return await withTransaction(pool, async (client) => {
          const idempotencyId = await reservePerpIntentClaim(client, input);

          const operationId = randomUUID();
          const operationResult = await client.query<{ id: string }>({
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
              on conflict (idempotency_record_id) do nothing
              returning id
            `,
            values: [
              operationId,
              input.ownerUserId,
              idempotencyId,
              input.requestSha256,
            ],
          });
          const insertedOperationId = operationResult.rows[0]?.id;

          if (insertedOperationId === undefined) {
            const existingOperation = await client.query<{
              id: string;
              owner_user_id: string;
              domain: string;
              operation_kind: string;
              request_sha256: string;
            }>({
              text: `
                select id, owner_user_id, domain, operation_kind, request_sha256
                from public.provider_operations
                where idempotency_record_id = $1
                limit 1
              `,
              values: [idempotencyId],
            });
            const existing = existingOperation.rows[0];
            if (
              existing === undefined ||
              existing.owner_user_id !== input.ownerUserId ||
              existing.domain !== "hyperliquid" ||
              existing.operation_kind !== "perp_intent" ||
              existing.request_sha256 !== input.requestSha256
            ) {
              throw new IdempotencyConflictError();
            }

            const intent = await readOwnedIntent(
              client,
              input.ownerUserId,
              existing.id,
            );
            if (intent === null) {
              return failUnavailable();
            }
            return Object.freeze({ created: false, intent });
          }

          const intentResult = await client.query<{ id: string }>({
            text: `
              with database_clock as (
                select clock_timestamp() as observed_at
              )
              insert into public.perp_intents (
                id,
                owner_user_id,
                request_sha256,
                request_digest_version,
                action,
                account_address,
                account_kind,
                binding_version,
                canonical_action,
                public_review,
                review_sha256,
                facts_observed_at,
                expires_at
              )
              select
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8::bigint,
                $9::jsonb,
                $10::jsonb,
                $11,
                $12::timestamptz,
                $13::timestamptz
              from database_clock
              where $12::timestamptz <= database_clock.observed_at
                and $13::timestamptz > database_clock.observed_at
              returning id
            `,
            values: [
              insertedOperationId,
              input.ownerUserId,
              input.requestSha256,
              PERP_INTENT_REQUEST_DIGEST_VERSION,
              input.action,
              input.accountAddress,
              input.accountKind,
              input.bindingVersion,
              JSON.stringify(input.canonicalAction),
              JSON.stringify(input.publicReview),
              input.reviewSha256,
              input.factsObservedAt,
              input.expiresAt,
            ],
          });
          if (intentResult.rows[0] === undefined) {
            throw new PerpIntentPrepareExpiredError();
          }

          for (const item of input.items) {
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
                values ($1, $2, $3, $4, $5, $6, $7, $8)
              `,
              values: [
                insertedOperationId,
                input.ownerUserId,
                item.index,
                item.coin,
                item.targetKind,
                item.targetOrderId,
                item.targetClientOrderId,
                item.generatedClientOrderId,
              ],
            });
          }

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
                operation_version,
                fence_token,
                transport_attempt_id
              )
              values (
                $1, $2, $3, 'api', 'operation_prepared', null, 'prepared',
                null, 'not_required', 'prepared', 0, 0, null
              )
            `,
            values: [input.ownerUserId, insertedOperationId, input.requestId],
          });

          await client.query({
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
                $1, $2, $3, 'api', 'intent_prepared', null, 'prepared',
                'prepared', 0
              )
            `,
            values: [insertedOperationId, input.ownerUserId, input.requestId],
          });

          const intent = await readOwnedIntent(
            client,
            input.ownerUserId,
            insertedOperationId,
          );
          if (intent === null) {
            return failUnavailable();
          }
          return Object.freeze({ created: true, intent });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async findOwned(
      rawOwnerUserId: string,
      rawIntentId: string,
    ): Promise<PerpIntentRecord | null> {
      try {
        const ownerUserId = uuidSchema.parse(rawOwnerUserId);
        const intentId = uuidSchema.parse(rawIntentId);
        return await readOwnedIntent(pool, ownerUserId, intentId);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
