import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  parseSpotIntentResource,
  parseSpotIntentResult,
  parseSpotReview,
  SPOT_INTENT_IDEMPOTENCY_SCOPE,
  SPOT_INTENT_REQUEST_DIGEST_VERSION,
  type SpotIntentResource,
  type SpotIntentResult,
  type SpotReview,
} from "../features/spot/spot-intent-contract.js";
import { IdempotencyConflictError } from "./control-plane-repository.js";

export const SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER = 32;
export const SPOT_INTENT_PENDING_CLAIM_GLOBAL_FUSE = 10_000;
export const SPOT_INTENT_PENDING_CLAIM_LEASE_MILLISECONDS = 30_000;

const claimBudgetLockName = "loop.spot_intent.claim_budget.v1";
const maximumPostgresBigint = 9_223_372_036_854_775_807n;
const maximumPostgresInteger = 2_147_483_647;
const zeroAddress = `0x${"0".repeat(40)}`;

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const positiveDecimalSchema = z
  .string()
  .max(128)
  .regex(/^([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/);
const nonnegativeDecimalSchema = z
  .string()
  .max(128)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== zeroAddress);
const tokenIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const providerCoinSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^([A-Z0-9][A-Z0-9._-]{0,30}\/[A-Z0-9][A-Z0-9._-]{0,30}|@(0|[1-9][0-9]{0,9}))$/,
  );
const metadataVersionSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const policyVersionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const agentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value === value.trim())
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/);
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= maximumPostgresBigint);
const clientOrderIdSchema = z.string().regex(/^0x[0-9a-f]{32}$/);
const nonnegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(maximumPostgresInteger);
const stateSchema = z.enum([
  "prepared",
  "submitting",
  "accepted",
  "partially_filled",
  "filled",
  "not_filled",
  "rejected",
  "unknown",
  "reconciling",
  "operator_required",
  "expired",
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
    claimId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    requestId: uuidSchema,
    marketId: uuidSchema,
    providerCoin: providerCoinSchema,
    baseTokenIndex: nonnegativeIntegerSchema,
    baseTokenId: tokenIdSchema,
    quoteTokenIndex: nonnegativeIntegerSchema,
    quoteTokenId: tokenIdSchema,
    spotPairIndex: nonnegativeIntegerSchema,
    exchangeOrderAsset: nonnegativeIntegerSchema,
    metadataVersion: metadataVersionSchema,
    metadataSha256: sha256Schema,
    policyVersion: policyVersionSchema,
    side: z.enum(["buy", "sell"]),
    amountMode: z.enum(["quote", "base"]),
    amountValue: positiveDecimalSchema,
    computedBaseSize: positiveDecimalSchema,
    referencePrice: positiveDecimalSchema,
    worstIocLimitPrice: positiveDecimalSchema,
    maximumSpendOrMinimumReceive: positiveDecimalSchema,
    feeRate: nonnegativeDecimalSchema,
    feeEstimate: nonnegativeDecimalSchema,
    accountAddress: addressSchema,
    accountKind: z.literal("master"),
    bindingVersion: bindingVersionSchema,
    agentIdentityId: uuidSchema,
    clientOrderId: clientOrderIdSchema,
    reviewSha256: sha256Schema,
    factsObservedAt: rfc3339Schema,
    referenceSourceTime: rfc3339Schema,
    expiresAt: rfc3339Schema,
  })
  .strict();

const currentWalletBindingRowSchema = z
  .object({
    binding_state: z.literal("bound"),
    account_address: addressSchema,
    account_kind: z.literal("master"),
    binding_version: bindingVersionSchema,
  })
  .strict();

const currentOwnerRowSchema = z.object({ id: uuidSchema }).strict();

const activeAgentIdentityRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    network: z.literal("testnet"),
    binding_version: bindingVersionSchema,
    agent_address: addressSchema,
    agent_name: agentNameSchema,
    lifecycle_state: z.literal("active"),
  })
  .strict();

const activeAgentAuthorizationRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    agent_identity_id: uuidSchema,
    network: z.literal("testnet"),
    action: z.literal("approve_agent"),
    account_address: addressSchema,
    account_kind: z.literal("master"),
    binding_version: bindingVersionSchema,
    agent_address: addressSchema,
    agent_name: agentNameSchema,
    state: z.literal("active"),
  })
  .strict();

const currentAgentValidityRowSchema = z
  .object({ is_current: z.literal(true) })
  .strict();

const intentRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    domain: z.literal("hyperliquid"),
    operation_kind: z.literal("spot_intent"),
    request_sha256: sha256Schema,
    request_digest_version: z.literal(SPOT_INTENT_REQUEST_DIGEST_VERSION),
    network: z.literal("testnet"),
    market_id: uuidSchema,
    provider_coin: providerCoinSchema,
    base_token_index: nonnegativeIntegerSchema,
    base_token_id: tokenIdSchema,
    quote_token_index: nonnegativeIntegerSchema,
    quote_token_id: tokenIdSchema,
    spot_pair_index: nonnegativeIntegerSchema,
    exchange_order_asset: nonnegativeIntegerSchema,
    metadata_version: metadataVersionSchema,
    metadata_sha256: sha256Schema,
    policy_version: policyVersionSchema,
    side: z.enum(["buy", "sell"]),
    amount_mode: z.enum(["quote", "base"]),
    amount_value: positiveDecimalSchema,
    computed_base_size: positiveDecimalSchema,
    reference_price: positiveDecimalSchema,
    worst_ioc_limit_price: positiveDecimalSchema,
    maximum_spend_or_minimum_receive: positiveDecimalSchema,
    fee_rate: nonnegativeDecimalSchema,
    fee_estimate: nonnegativeDecimalSchema,
    account_address: addressSchema,
    account_kind: z.literal("master"),
    binding_version: bindingVersionSchema,
    agent_identity_id: uuidSchema,
    client_order_id: clientOrderIdSchema,
    canonical_action: z.unknown(),
    public_review: z.unknown(),
    review_sha256: sha256Schema,
    facts_observed_at: validDateSchema,
    reference_source_time: validDateSchema,
    expires_at: validDateSchema,
    stored_state: stateSchema,
    state: stateSchema,
    provider_order_id: z.string().nullable(),
    filled_base_size: positiveDecimalSchema.nullable(),
    filled_quote_amount: positiveDecimalSchema.nullable(),
    average_fill_price: positiveDecimalSchema.nullable(),
    result_fee_amount: nonnegativeDecimalSchema.nullable(),
    result_fee_token_index: nonnegativeIntegerSchema.nullable(),
    result_fee_token_id: tokenIdSchema.nullable(),
    result_fee_asset_display_identity: z.string().nullable(),
    result_observed_at: validDateSchema.nullable(),
    result_reason_code: z.string().nullable(),
    record_version: z.string().regex(/^(0|[1-9][0-9]*)$/),
    created_at: validDateSchema,
    updated_at: validDateSchema,
  })
  .strict();

const intentReturningColumns = `
  intent.id,
  intent.owner_user_id,
  intent.domain,
  intent.operation_kind,
  intent.request_sha256,
  intent.request_digest_version,
  intent.network,
  intent.market_id,
  intent.provider_coin,
  intent.base_token_index,
  intent.base_token_id,
  intent.quote_token_index,
  intent.quote_token_id,
  intent.spot_pair_index,
  intent.exchange_order_asset,
  intent.metadata_version,
  intent.metadata_sha256,
  intent.policy_version,
  intent.side,
  intent.amount_mode,
  intent.amount_value,
  intent.computed_base_size,
  intent.reference_price,
  intent.worst_ioc_limit_price,
  intent.maximum_spend_or_minimum_receive,
  intent.fee_rate,
  intent.fee_estimate,
  intent.account_address,
  intent.account_kind,
  intent.binding_version::text as binding_version,
  intent.agent_identity_id,
  intent.client_order_id,
  intent.canonical_action,
  intent.public_review,
  intent.review_sha256,
  intent.facts_observed_at,
  intent.reference_source_time,
  intent.expires_at,
  intent.state as stored_state,
  case
    when intent.state = 'prepared'
      and intent.expires_at <= clock_timestamp()
    then 'expired'
    else intent.state
  end as state,
  intent.provider_order_id,
  intent.filled_base_size,
  intent.filled_quote_amount,
  intent.average_fill_price,
  intent.result_fee_amount,
  intent.result_fee_token_index,
  intent.result_fee_token_id,
  intent.result_fee_asset_display_identity,
  intent.result_observed_at,
  intent.result_reason_code,
  intent.record_version::text as record_version,
  intent.created_at,
  intent.updated_at
`;

export interface SpotCanonicalAction {
  readonly type: "order";
  readonly orders: readonly [
    Readonly<{
      readonly a: number;
      readonly b: boolean;
      readonly p: string;
      readonly s: string;
      readonly r: false;
      readonly t: Readonly<{
        readonly limit: Readonly<{ readonly tif: "Ioc" }>;
      }>;
      readonly c: string;
    }>,
  ];
  readonly grouping: "na";
}

export interface SpotIntentRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly requestSha256: string;
  readonly network: "testnet";
  readonly marketId: string;
  readonly providerCoin: string;
  readonly baseTokenIndex: number;
  readonly baseTokenId: string;
  readonly quoteTokenIndex: number;
  readonly quoteTokenId: string;
  readonly spotPairIndex: number;
  readonly exchangeOrderAsset: number;
  readonly metadataVersion: string;
  readonly metadataSha256: string;
  readonly policyVersion: string;
  readonly accountAddress: string;
  readonly bindingVersion: string;
  readonly agentIdentityId: string;
  readonly clientOrderId: string;
  readonly canonicalAction: SpotCanonicalAction;
  readonly publicReview: SpotReview;
  readonly reviewSha256: string;
  readonly factsObservedAt: string;
  readonly referenceSourceTime: string;
  readonly state: SpotIntentResource["state"];
  readonly result: SpotIntentResult | null;
  readonly recordVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resource: SpotIntentResource;
}

export interface ClaimSpotIntentPrepareInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
}

export type ClaimSpotIntentPrepareResult =
  | { readonly kind: "claimed"; readonly claimId: string }
  | { readonly kind: "pending" }
  | { readonly kind: "replay"; readonly intent: SpotIntentRecord };

export interface PrepareSpotIntentInput {
  readonly ownerUserId: string;
  readonly claimId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly marketId: string;
  readonly providerCoin: string;
  readonly baseTokenIndex: number;
  readonly baseTokenId: string;
  readonly quoteTokenIndex: number;
  readonly quoteTokenId: string;
  readonly spotPairIndex: number;
  readonly exchangeOrderAsset: number;
  readonly metadataVersion: string;
  readonly metadataSha256: string;
  readonly policyVersion: string;
  readonly side: "buy" | "sell";
  readonly amountMode: "quote" | "base";
  readonly amountValue: string;
  readonly computedBaseSize: string;
  readonly referencePrice: string;
  readonly worstIocLimitPrice: string;
  readonly maximumSpendOrMinimumReceive: string;
  readonly feeRate: string;
  readonly feeEstimate: string;
  readonly accountAddress: string;
  readonly accountKind: "master";
  readonly bindingVersion: string;
  readonly agentIdentityId: string;
  readonly clientOrderId: string;
  readonly canonicalAction: unknown;
  readonly publicReview: unknown;
  readonly reviewSha256: string;
  readonly factsObservedAt: string;
  readonly referenceSourceTime: string;
  readonly expiresAt: string;
}

export interface SpotIntentRepository {
  claimPrepare(
    input: ClaimSpotIntentPrepareInput,
  ): Promise<ClaimSpotIntentPrepareResult>;
  prepare(input: PrepareSpotIntentInput): Promise<{
    readonly created: boolean;
    readonly intent: SpotIntentRecord;
  }>;
  findOwned(
    ownerUserId: string,
    intentId: string,
  ): Promise<SpotIntentRecord | null>;
}

export class SpotIntentPrepareClaimRequiredError extends Error {
  readonly code = "spot_intent_prepare_claim_required";

  constructor() {
    super("The Spot intent preparation claim is missing or no longer held");
    this.name = "SpotIntentPrepareClaimRequiredError";
  }
}

export class SpotIntentPrepareExpiredError extends Error {
  readonly code = "spot_intent_expired";

  constructor() {
    super("The Spot intent review is already expired");
    this.name = "SpotIntentPrepareExpiredError";
  }
}

export class SpotIntentAuthorityStaleError extends Error {
  readonly code = "spot_intent_stale";

  constructor() {
    super("The Spot wallet binding or active Agent epoch changed");
    this.name = "SpotIntentAuthorityStaleError";
  }
}

export class SpotIntentClaimLimitExceededError extends Error {
  readonly code = "spot_intent_claim_rate_limited";

  constructor() {
    super("The Spot intent pending-claim budget is exhausted");
    this.name = "SpotIntentClaimLimitExceededError";
  }
}

export class SpotIntentRepositoryUnavailableError extends Error {
  readonly code = "spot_unavailable";

  constructor() {
    super("The Spot intent repository is unavailable");
    this.name = "SpotIntentRepositoryUnavailableError";
  }
}

interface ParsedPrepareInput extends Omit<
  PrepareSpotIntentInput,
  "canonicalAction" | "publicReview"
> {
  readonly canonicalAction: SpotCanonicalAction;
  readonly publicReview: SpotReview;
}

type DatabaseClient = Pick<PoolClient, "query">;

function failUnavailable(): never {
  throw new SpotIntentRepositoryUnavailableError();
}

function freezeCanonicalAction(
  value: z.output<typeof canonicalActionSchema>,
): SpotCanonicalAction {
  const order = value.orders[0];
  const frozenOrder = Object.freeze({
    ...order,
    t: Object.freeze({
      limit: Object.freeze({ ...order.t.limit }),
    }),
  });
  return Object.freeze({
    type: value.type,
    orders: Object.freeze([frozenOrder] as const),
    grouping: value.grouping,
  });
}

function projectionMatches(
  input: Omit<ParsedPrepareInput, "claimId" | "idempotencyKey" | "requestId">,
): boolean {
  const review = input.publicReview;
  const order = input.canonicalAction.orders[0];
  const factsObservedAt = Date.parse(input.factsObservedAt);
  return (
    review.review_digest === input.reviewSha256 &&
    review.market_id === input.marketId &&
    review.side === input.side &&
    review.amount_mode === input.amountMode &&
    review.amount_value === input.amountValue &&
    review.computed_base_size === input.computedBaseSize &&
    review.reference_price === input.referencePrice &&
    review.reference_source_time === input.referenceSourceTime &&
    review.worst_ioc_limit_price === input.worstIocLimitPrice &&
    review.maximum_spend_or_minimum_receive.value ===
      input.maximumSpendOrMinimumReceive &&
    review.fee_rate === input.feeRate &&
    review.fee_estimate === input.feeEstimate &&
    review.metadata_version === input.metadataVersion &&
    review.policy_version === input.policyVersion &&
    review.binding_epoch === input.bindingVersion &&
    review.expires_at === input.expiresAt &&
    input.exchangeOrderAsset === 10_000 + input.spotPairIndex &&
    input.baseTokenIndex !== input.quoteTokenIndex &&
    input.baseTokenId !== input.quoteTokenId &&
    ((input.side === "buy" && input.amountMode === "quote") ||
      (input.side === "sell" && input.amountMode === "base")) &&
    input.referenceSourceTime === review.reference_source_time &&
    Date.parse(input.referenceSourceTime) <= factsObservedAt &&
    Date.parse(review.fee_source.observed_at) <= factsObservedAt &&
    factsObservedAt < Date.parse(input.expiresAt) &&
    order.a === input.exchangeOrderAsset &&
    order.b === (input.side === "buy") &&
    order.p === input.worstIocLimitPrice &&
    order.s === input.computedBaseSize &&
    order.c === input.clientOrderId
  );
}

function parsePrepareInput(
  rawInput: PrepareSpotIntentInput,
): ParsedPrepareInput {
  try {
    const envelope = prepareInputEnvelopeSchema.parse({
      ownerUserId: rawInput.ownerUserId,
      claimId: rawInput.claimId,
      idempotencyKey: rawInput.idempotencyKey,
      requestSha256: rawInput.requestSha256,
      requestId: rawInput.requestId,
      marketId: rawInput.marketId,
      providerCoin: rawInput.providerCoin,
      baseTokenIndex: rawInput.baseTokenIndex,
      baseTokenId: rawInput.baseTokenId,
      quoteTokenIndex: rawInput.quoteTokenIndex,
      quoteTokenId: rawInput.quoteTokenId,
      spotPairIndex: rawInput.spotPairIndex,
      exchangeOrderAsset: rawInput.exchangeOrderAsset,
      metadataVersion: rawInput.metadataVersion,
      metadataSha256: rawInput.metadataSha256,
      policyVersion: rawInput.policyVersion,
      side: rawInput.side,
      amountMode: rawInput.amountMode,
      amountValue: rawInput.amountValue,
      computedBaseSize: rawInput.computedBaseSize,
      referencePrice: rawInput.referencePrice,
      worstIocLimitPrice: rawInput.worstIocLimitPrice,
      maximumSpendOrMinimumReceive: rawInput.maximumSpendOrMinimumReceive,
      feeRate: rawInput.feeRate,
      feeEstimate: rawInput.feeEstimate,
      accountAddress: rawInput.accountAddress,
      accountKind: rawInput.accountKind,
      bindingVersion: rawInput.bindingVersion,
      agentIdentityId: rawInput.agentIdentityId,
      clientOrderId: rawInput.clientOrderId,
      reviewSha256: rawInput.reviewSha256,
      factsObservedAt: rawInput.factsObservedAt,
      referenceSourceTime: rawInput.referenceSourceTime,
      expiresAt: rawInput.expiresAt,
    });
    const canonicalAction = freezeCanonicalAction(
      canonicalActionSchema.parse(rawInput.canonicalAction),
    );
    const publicReview = parseSpotReview(rawInput.publicReview);
    const parsed = Object.freeze({
      ...envelope,
      canonicalAction,
      publicReview,
    });
    if (!projectionMatches(parsed)) {
      return failUnavailable();
    }
    return parsed;
  } catch (error) {
    if (error instanceof SpotIntentRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

function buildResult(
  row: z.output<typeof intentRowSchema>,
): SpotIntentResult | null {
  if (
    row.state === "prepared" ||
    row.state === "submitting" ||
    row.state === "expired"
  ) {
    return null;
  }
  const observedAt = row.result_observed_at?.toISOString();
  if (observedAt === undefined) {
    return failUnavailable();
  }
  if (row.state === "filled" || row.state === "partially_filled") {
    return parseSpotIntentResult({
      state: row.state,
      order_id: row.provider_order_id,
      filled_base_size: row.filled_base_size,
      average_fill_price: row.average_fill_price,
      quote_amount: row.filled_quote_amount,
      fee: row.result_fee_amount,
      fee_asset_display_identity: row.result_fee_asset_display_identity,
      observed_at: observedAt,
      reason_code: row.result_reason_code,
    });
  }
  const resultState = row.state === "reconciling" ? "unknown" : row.state;
  return parseSpotIntentResult({
    state: resultState,
    order_id: row.provider_order_id,
    filled_base_size: null,
    average_fill_price: null,
    quote_amount: null,
    fee: null,
    fee_asset_display_identity: null,
    observed_at: observedAt,
    reason_code: row.result_reason_code,
  });
}

function toSpotIntentRecord(value: unknown): SpotIntentRecord {
  try {
    const row = intentRowSchema.parse(value);
    const canonicalAction = freezeCanonicalAction(
      canonicalActionSchema.parse(row.canonical_action),
    );
    const publicReview = parseSpotReview(row.public_review);
    const projectionInput = {
      ownerUserId: row.owner_user_id,
      requestSha256: row.request_sha256,
      marketId: row.market_id,
      providerCoin: row.provider_coin,
      baseTokenIndex: row.base_token_index,
      baseTokenId: row.base_token_id,
      quoteTokenIndex: row.quote_token_index,
      quoteTokenId: row.quote_token_id,
      spotPairIndex: row.spot_pair_index,
      exchangeOrderAsset: row.exchange_order_asset,
      metadataVersion: row.metadata_version,
      metadataSha256: row.metadata_sha256,
      policyVersion: row.policy_version,
      side: row.side,
      amountMode: row.amount_mode,
      amountValue: row.amount_value,
      computedBaseSize: row.computed_base_size,
      referencePrice: row.reference_price,
      worstIocLimitPrice: row.worst_ioc_limit_price,
      maximumSpendOrMinimumReceive: row.maximum_spend_or_minimum_receive,
      feeRate: row.fee_rate,
      feeEstimate: row.fee_estimate,
      accountAddress: row.account_address,
      accountKind: row.account_kind,
      bindingVersion: row.binding_version,
      agentIdentityId: row.agent_identity_id,
      clientOrderId: row.client_order_id,
      canonicalAction,
      publicReview,
      reviewSha256: row.review_sha256,
      factsObservedAt: row.facts_observed_at.toISOString(),
      referenceSourceTime: row.reference_source_time.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    } as const;
    if (!projectionMatches(projectionInput)) {
      return failUnavailable();
    }
    const result = buildResult(row);
    const submissionState =
      row.state === "prepared" || row.state === "expired"
        ? "ready"
        : "attempted";
    const resource = parseSpotIntentResource({
      intent_id: row.id,
      state: row.state,
      review: publicReview,
      submission: { state: submissionState },
      result,
      expires_at: row.expires_at.toISOString(),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
    return Object.freeze({
      id: row.id,
      ownerUserId: row.owner_user_id,
      requestSha256: row.request_sha256,
      network: row.network,
      marketId: row.market_id,
      providerCoin: row.provider_coin,
      baseTokenIndex: row.base_token_index,
      baseTokenId: row.base_token_id,
      quoteTokenIndex: row.quote_token_index,
      quoteTokenId: row.quote_token_id,
      spotPairIndex: row.spot_pair_index,
      exchangeOrderAsset: row.exchange_order_asset,
      metadataVersion: row.metadata_version,
      metadataSha256: row.metadata_sha256,
      policyVersion: row.policy_version,
      accountAddress: row.account_address,
      bindingVersion: row.binding_version,
      agentIdentityId: row.agent_identity_id,
      clientOrderId: row.client_order_id,
      canonicalAction,
      publicReview,
      reviewSha256: row.review_sha256,
      factsObservedAt: row.facts_observed_at.toISOString(),
      referenceSourceTime: row.reference_source_time.toISOString(),
      state: resource.state,
      result,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      resource,
    });
  } catch (error) {
    if (error instanceof SpotIntentRepositoryUnavailableError) {
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
    const result = await operation(client);
    await client.query("set constraints all immediate");
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw new SpotIntentRepositoryUnavailableError();
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
): Promise<SpotIntentRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${intentReturningColumns}
      from public.spot_intents as intent
      where intent.owner_user_id = $1 and intent.id = $2
      limit 1
    `,
    values: [ownerUserId, intentId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toSpotIntentRecord(row);
}

async function lockClaim(
  client: DatabaseClient,
  input: ClaimSpotIntentPrepareInput,
): Promise<{
  readonly id: string;
  readonly created: boolean;
}> {
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
    values: [SPOT_INTENT_IDEMPOTENCY_SCOPE, input.idempotencyKey],
  });
  const existing = existingResult.rows[0];
  if (existing !== undefined) {
    if (
      existing.owner_user_id !== input.ownerUserId ||
      existing.key_source !== "client" ||
      existing.request_sha256 !== input.requestSha256 ||
      existing.digest_version !== SPOT_INTENT_REQUEST_DIGEST_VERSION
    ) {
      throw new IdempotencyConflictError();
    }
    return Object.freeze({ id: existing.id, created: false });
  }

  await assertPendingClaimBudgetAvailable(client, input.ownerUserId);

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
      SPOT_INTENT_IDEMPOTENCY_SCOPE,
      input.idempotencyKey,
      input.requestSha256,
      SPOT_INTENT_REQUEST_DIGEST_VERSION,
    ],
  });
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    return failUnavailable();
  }
  return Object.freeze({ id, created: true });
}

async function assertPendingClaimBudgetAvailable(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<void> {
  const budget = await client.query<{
    owner_pending: string;
    global_pending: string;
  }>({
    text: `
      select
        count(*) filter (where claim.owner_user_id = $2)::text
          as owner_pending,
        count(*)::text as global_pending
      from public.idempotency_records as claim
      where claim.scope = $1
        and claim.last_seen_at >
          clock_timestamp() - ($3::integer * interval '1 millisecond')
        and not exists (
          select 1
          from public.provider_operations as operation
          where operation.idempotency_record_id = claim.id
        )
    `,
    values: [
      SPOT_INTENT_IDEMPOTENCY_SCOPE,
      ownerUserId,
      SPOT_INTENT_PENDING_CLAIM_LEASE_MILLISECONDS,
    ],
  });
  const ownerPending = Number.parseInt(budget.rows[0]?.owner_pending ?? "", 10);
  const globalPending = Number.parseInt(
    budget.rows[0]?.global_pending ?? "",
    10,
  );
  if (
    !Number.isSafeInteger(ownerPending) ||
    !Number.isSafeInteger(globalPending)
  ) {
    return failUnavailable();
  }
  if (
    ownerPending >= SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER ||
    globalPending >= SPOT_INTENT_PENDING_CLAIM_GLOBAL_FUSE
  ) {
    throw new SpotIntentClaimLimitExceededError();
  }
}

async function reacquireStaleClaim(
  client: DatabaseClient,
  claimId: string,
  ownerUserId: string,
): Promise<boolean> {
  const staleResult = await client.query<{ stale: boolean }>({
    text: `
      select (
        claim.last_seen_at <=
          clock_timestamp() - ($2::integer * interval '1 millisecond')
        and not exists (
          select 1
          from public.provider_operations as operation
          where operation.idempotency_record_id = claim.id
        )
      ) as stale
      from public.idempotency_records as claim
      where claim.id = $1
    `,
    values: [claimId, SPOT_INTENT_PENDING_CLAIM_LEASE_MILLISECONDS],
  });
  if (staleResult.rows[0]?.stale !== true) {
    return false;
  }

  await assertPendingClaimBudgetAvailable(client, ownerUserId);

  const result = await client.query<{ id: string }>({
    text: `
      update public.idempotency_records as claim
      set last_seen_at = clock_timestamp()
      where claim.id = $1
        and claim.last_seen_at <=
          clock_timestamp() - ($2::integer * interval '1 millisecond')
        and not exists (
          select 1
          from public.provider_operations as operation
          where operation.idempotency_record_id = claim.id
        )
      returning claim.id
    `,
    values: [claimId, SPOT_INTENT_PENDING_CLAIM_LEASE_MILLISECONDS],
  });
  return result.rows[0]?.id === claimId;
}

async function readClaimedIntent(
  client: DatabaseClient,
  input: ClaimSpotIntentPrepareInput,
  claimId: string,
): Promise<SpotIntentRecord | null> {
  const result = await client.query<{
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
    values: [claimId],
  });
  const existing = result.rows[0];
  if (existing === undefined) {
    return null;
  }
  if (
    existing.owner_user_id !== input.ownerUserId ||
    existing.domain !== "hyperliquid" ||
    existing.operation_kind !== "spot_intent" ||
    existing.request_sha256 !== input.requestSha256
  ) {
    throw new IdempotencyConflictError();
  }
  const intent = await readOwnedIntent(client, input.ownerUserId, existing.id);
  return intent ?? failUnavailable();
}

async function assertCurrentAuthority(
  client: DatabaseClient,
  input: Pick<
    ParsedPrepareInput,
    "ownerUserId" | "accountAddress" | "bindingVersion" | "agentIdentityId"
  >,
): Promise<void> {
  const ownerResult = await client.query<Record<string, unknown>>({
    text: `
      select id
      from public.loop_users
      where id = $1
      limit 1
      for update
    `,
    values: [input.ownerUserId],
  });
  const owner = currentOwnerRowSchema.safeParse(ownerResult.rows[0]);
  if (!owner.success || owner.data.id !== input.ownerUserId) {
    throw new SpotIntentAuthorityStaleError();
  }

  const walletResult = await client.query<Record<string, unknown>>({
    text: `
      select
        binding_state,
        account_address,
        account_kind,
        binding_version::text as binding_version
      from public.perp_wallet_bindings
      where owner_user_id = $1
      limit 1
      for update
    `,
    values: [input.ownerUserId],
  });
  const wallet = currentWalletBindingRowSchema.safeParse(walletResult.rows[0]);
  if (
    !wallet.success ||
    wallet.data.account_address !== input.accountAddress ||
    wallet.data.binding_version !== input.bindingVersion
  ) {
    throw new SpotIntentAuthorityStaleError();
  }

  const agentResult = await client.query<Record<string, unknown>>({
    text: `
      select
        id,
        owner_user_id,
        network,
        binding_version::text as binding_version,
        agent_address,
        agent_name,
        lifecycle_state
      from public.spot_agent_identities
      where id = $1 and owner_user_id = $2
      limit 1
      for update
    `,
    values: [input.agentIdentityId, input.ownerUserId],
  });
  const agent = activeAgentIdentityRowSchema.safeParse(agentResult.rows[0]);
  if (
    !agent.success ||
    agent.data.id !== input.agentIdentityId ||
    agent.data.owner_user_id !== input.ownerUserId ||
    agent.data.binding_version !== input.bindingVersion
  ) {
    throw new SpotIntentAuthorityStaleError();
  }

  const authorizationResult = await client.query<Record<string, unknown>>({
    text: `
      select
        id,
        owner_user_id,
        agent_identity_id,
        network,
        action,
        account_address,
        account_kind,
        binding_version::text as binding_version,
        agent_address,
        agent_name,
        state
      from public.spot_agent_authorizations
      where owner_user_id = $1
        and agent_identity_id = $2
        and state = 'active'
      order by agent_valid_until desc, created_at desc, id desc
      limit 1
      for update
    `,
    values: [input.ownerUserId, input.agentIdentityId],
  });
  const authorization = activeAgentAuthorizationRowSchema.safeParse(
    authorizationResult.rows[0],
  );
  if (
    !authorization.success ||
    authorization.data.owner_user_id !== input.ownerUserId ||
    authorization.data.agent_identity_id !== input.agentIdentityId ||
    authorization.data.account_address !== input.accountAddress ||
    authorization.data.binding_version !== input.bindingVersion ||
    authorization.data.agent_address !== agent.data.agent_address ||
    authorization.data.agent_name !== agent.data.agent_name
  ) {
    throw new SpotIntentAuthorityStaleError();
  }

  const validityResult = await client.query<Record<string, unknown>>({
    text: `
      select clock_timestamp() < agent_valid_until as is_current
      from public.spot_agent_authorizations
      where id = $1
        and owner_user_id = $2
        and state = 'active'
    `,
    values: [authorization.data.id, input.ownerUserId],
  });
  if (
    !currentAgentValidityRowSchema.safeParse(validityResult.rows[0]).success
  ) {
    throw new SpotIntentAuthorityStaleError();
  }
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof SpotIntentPrepareClaimRequiredError ||
    error instanceof SpotIntentPrepareExpiredError ||
    error instanceof SpotIntentAuthorityStaleError ||
    error instanceof SpotIntentClaimLimitExceededError ||
    error instanceof SpotIntentRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new SpotIntentRepositoryUnavailableError();
}

export function createPostgresSpotIntentRepository(
  pool: Pool,
): SpotIntentRepository {
  return Object.freeze({
    async claimPrepare(
      rawInput: ClaimSpotIntentPrepareInput,
    ): Promise<ClaimSpotIntentPrepareResult> {
      try {
        const input = claimPrepareInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const claim = await lockClaim(client, input);
          const existingIntent = await readClaimedIntent(
            client,
            input,
            claim.id,
          );
          if (existingIntent !== null) {
            return Object.freeze({
              kind: "replay" as const,
              intent: existingIntent,
            });
          }
          if (
            !claim.created &&
            !(await reacquireStaleClaim(client, claim.id, input.ownerUserId))
          ) {
            return Object.freeze({ kind: "pending" as const });
          }
          return Object.freeze({
            kind: "claimed" as const,
            claimId: claim.id,
          });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async prepare(rawInput: PrepareSpotIntentInput): Promise<{
      readonly created: boolean;
      readonly intent: SpotIntentRecord;
    }> {
      try {
        const input = parsePrepareInput(rawInput);
        return await withTransaction(pool, async (client) => {
          const claim = await lockClaim(client, input);
          if (claim.created || claim.id !== input.claimId) {
            throw new SpotIntentPrepareClaimRequiredError();
          }
          const existingIntent = await readClaimedIntent(
            client,
            input,
            claim.id,
          );
          if (existingIntent !== null) {
            return Object.freeze({ created: false, intent: existingIntent });
          }

          await assertCurrentAuthority(client, input);
          const operationId = randomUUID();
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
              values ($1, $2, $3, 'hyperliquid', 'spot_intent', $4)
            `,
            values: [
              operationId,
              input.ownerUserId,
              claim.id,
              input.requestSha256,
            ],
          });
          const intentResult = await client.query<{ id: string }>({
            text: `
              with database_clock as (
                select clock_timestamp() as observed_at
              )
              insert into public.spot_intents (
                id,
                owner_user_id,
                request_sha256,
                request_digest_version,
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
                account_kind,
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
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                $21, $22, $23, $24, $25, $26, $27::bigint, $28, $29,
                $30::jsonb, $31::jsonb, $32, $33::timestamptz,
                $34::timestamptz, $35::timestamptz
              from database_clock
              where $33::timestamptz <= database_clock.observed_at
                and $35::timestamptz > database_clock.observed_at
              returning id
            `,
            values: [
              operationId,
              input.ownerUserId,
              input.requestSha256,
              SPOT_INTENT_REQUEST_DIGEST_VERSION,
              input.marketId,
              input.providerCoin,
              input.baseTokenIndex,
              input.baseTokenId,
              input.quoteTokenIndex,
              input.quoteTokenId,
              input.spotPairIndex,
              input.exchangeOrderAsset,
              input.metadataVersion,
              input.metadataSha256,
              input.policyVersion,
              input.side,
              input.amountMode,
              input.amountValue,
              input.computedBaseSize,
              input.referencePrice,
              input.worstIocLimitPrice,
              input.maximumSpendOrMinimumReceive,
              input.feeRate,
              input.feeEstimate,
              input.accountAddress,
              input.accountKind,
              input.bindingVersion,
              input.agentIdentityId,
              input.clientOrderId,
              JSON.stringify(input.canonicalAction),
              JSON.stringify(input.publicReview),
              input.reviewSha256,
              input.factsObservedAt,
              input.referenceSourceTime,
              input.expiresAt,
            ],
          });
          if (intentResult.rows[0] === undefined) {
            throw new SpotIntentPrepareExpiredError();
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
            values: [input.ownerUserId, operationId, input.requestId],
          });
          await client.query({
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
                intent_version
              )
              values (
                $1, $2, $3, 'api', 'intent_prepared', null, 'prepared',
                'prepared', 0
              )
            `,
            values: [operationId, input.ownerUserId, input.requestId],
          });

          const intent = await readOwnedIntent(
            client,
            input.ownerUserId,
            operationId,
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
    ): Promise<SpotIntentRecord | null> {
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
