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
import { compareExactUnsignedDecimals } from "../features/spot/spot-exact-decimal.js";
import { IdempotencyConflictError } from "./control-plane-repository.js";
import { HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS } from "./hyperliquid-signer-nonce.js";

export const SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER = 32;
export const SPOT_INTENT_PENDING_CLAIM_GLOBAL_FUSE = 10_000;
export const SPOT_INTENT_PENDING_CLAIM_LEASE_MILLISECONDS = 30_000;
export const SPOT_INTENT_PREPARE_AUTHORITY_LEASE_MILLISECONDS = 15_000;
export const SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS = 10_000;
export const SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS = 15_000;
export const SPOT_INTENT_SUBMISSION_METADATA_LEASE_MILLISECONDS = 60_000;
export const SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS = 2_000;

const claimBudgetLockName = "loop.spot_intent.claim_budget.v1";
const maximumPostgresBigint = 9_223_372_036_854_775_807n;
const maximumPostgresInteger = 2_147_483_647;
const maximumUint64 = 18_446_744_073_709_551_615n;
const zeroAddress = `0x${"0".repeat(40)}`;

function hasNoAsciiControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
  });
}

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
const opaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim())
  .refine(hasNoAsciiControlCharacters);
const signerRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim())
  .refine(hasNoAsciiControlCharacters);
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
const nonceSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= maximumUint64);
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

const submissionWalletEvidenceSchema = z
  .object({
    ownerUserId: uuidSchema,
    privyUserId: opaqueProviderIdSchema,
    walletId: opaqueProviderIdSchema,
    accountAddress: addressSchema,
    accountKind: z.literal("master"),
    bindingVersion: bindingVersionSchema,
    verifiedAt: rfc3339Schema,
    expiresAt: rfc3339Schema,
  })
  .strict();

const submissionMarketEvidenceSchema = z
  .object({
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    dataset: z.literal("spotMetaAndAssetCtxs"),
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
    fetchedAt: rfc3339Schema,
    expiresAt: rfc3339Schema,
  })
  .strict();

const submissionAccountEvidenceSchema = z
  .object({
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    accountAddress: addressSchema,
    metadataVersion: metadataVersionSchema,
    balance: z
      .object({
        dataset: z.literal("spotClearinghouseState"),
        tokenIndex: nonnegativeIntegerSchema,
        tokenId: tokenIdSchema,
        available: nonnegativeDecimalSchema,
        fetchedAt: rfc3339Schema,
        expiresAt: rfc3339Schema,
      })
      .strict(),
    fees: z
      .object({
        dataset: z.literal("userFees"),
        currentTakerRate: nonnegativeDecimalSchema,
        fetchedAt: rfc3339Schema,
        expiresAt: rfc3339Schema,
      })
      .strict(),
  })
  .strict();

const submissionPolicyEvidenceSchema = z
  .object({
    ownerUserId: uuidSchema,
    intentId: uuidSchema,
    network: z.literal("testnet"),
    action: z.literal("spot_ioc_order"),
    decision: z.literal("allow"),
    policyVersion: policyVersionSchema,
    productEnabled: z.literal(true),
    legalEligible: z.literal(true),
    sanctionsEligible: z.literal(true),
    killSwitchOpen: z.literal(true),
    signerReady: z.literal(true),
    reconciliationReady: z.literal(true),
    checkedAt: rfc3339Schema,
    expiresAt: rfc3339Schema,
  })
  .strict();

const beginSubmissionInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    intentId: uuidSchema,
    requestId: uuidSchema,
    expectedReviewSha256: sha256Schema,
    walletEvidence: submissionWalletEvidenceSchema,
    marketEvidence: submissionMarketEvidenceSchema,
    accountEvidence: submissionAccountEvidenceSchema,
    policyEvidence: submissionPolicyEvidenceSchema,
  })
  .strict();

const submissionUnknownSchema = z
  .object({
    state: z.literal("unknown"),
    providerOrderId: z.null(),
    reasonCode: z.enum([
      "submission_transport_ambiguous",
      "submission_response_unclassified",
    ]),
  })
  .strict();

const recordSubmissionUnknownInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    intentId: uuidSchema,
    requestId: uuidSchema,
    transportAttemptId: uuidSchema,
    expectedOperationRecordVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
    expectedIntentRecordVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
    outcome: submissionUnknownSchema,
  })
  .strict();

const quarantineExpiredSubmissionsInputSchema = z
  .object({
    requestId: uuidSchema,
    limit: z.number().int().min(1).max(100),
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
    privyUserId: opaqueProviderIdSchema,
    walletId: opaqueProviderIdSchema,
    accountAddress: addressSchema,
    accountKind: z.literal("master"),
    bindingVersion: bindingVersionSchema,
    agentIdentityId: uuidSchema,
    clientOrderId: clientOrderIdSchema,
    reviewSha256: sha256Schema,
    factsObservedAt: rfc3339Schema,
    referenceSourceTime: rfc3339Schema,
    expiresAt: rfc3339Schema,
    walletVerifiedAt: rfc3339Schema,
    walletExpiresAt: rfc3339Schema,
  })
  .strict();

const currentWalletBindingRowSchema = z
  .object({
    privy_user_id: opaqueProviderIdSchema,
    binding_state: z.literal("bound"),
    wallet_id: opaqueProviderIdSchema,
    account_address: addressSchema,
    account_kind: z.literal("master"),
    binding_version: bindingVersionSchema,
  })
  .strict();

const currentOwnerRowSchema = z
  .object({ id: uuidSchema, privy_user_id: opaqueProviderIdSchema })
  .strict();

const activeAgentIdentityRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    network: z.literal("testnet"),
    binding_version: bindingVersionSchema,
    agent_address: addressSchema,
    agent_name: agentNameSchema,
    signer_ref: signerRefSchema,
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
    agent_valid_until: validDateSchema,
    state: z.literal("active"),
  })
  .strict();

const currentAgentValidityRowSchema = z
  .object({ is_current: z.literal(true) })
  .strict();

const prepareAuthorityValidityRowSchema = z
  .object({
    review_current: z.boolean(),
    agent_current: z.boolean(),
    agent_covers_review: z.boolean(),
    wallet_evidence_current: z.boolean(),
    wallet_evidence_bounded: z.boolean(),
  })
  .strict();

const submissionOperationStateSchema = z.enum([
  "prepared",
  "submitting",
  "accepted",
  "succeeded",
  "rejected",
  "failed",
  "unknown",
]);
const submissionOperationRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    domain: z.literal("hyperliquid"),
    operation_kind: z.literal("spot_intent"),
    request_sha256: sha256Schema,
    state: submissionOperationStateSchema,
    attempt_count: z.number().int().min(0).max(1),
    transport_attempt_id: uuidSchema.nullable(),
    attempt_committed_at: validDateSchema.nullable(),
    attempt_deadline_at: validDateSchema.nullable(),
    reconciliation_status: z.enum([
      "not_required",
      "pending",
      "leased",
      "operator_required",
      "complete",
    ]),
    record_version: z.string().regex(/^(0|[1-9][0-9]*)$/),
  })
  .strict();

const submissionJournalRowSchema = z
  .object({
    attempt_committed_at: validDateSchema,
    attempt_deadline_at: validDateSchema,
    record_version: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();

const submissionValidityRowSchema = z
  .object({
    review_current: z.boolean(),
    review_covers_attempt: z.boolean(),
    agent_current: z.boolean(),
    agent_covers_attempt: z.boolean(),
    wallet_evidence_current: z.boolean(),
    wallet_evidence_bounded: z.boolean(),
    wallet_evidence_covers_attempt: z.boolean(),
    market_evidence_current: z.boolean(),
    market_evidence_bounded: z.boolean(),
    market_evidence_covers_attempt: z.boolean(),
    policy_evidence_current: z.boolean(),
    policy_evidence_bounded: z.boolean(),
    policy_evidence_covers_attempt: z.boolean(),
    balance_evidence_current: z.boolean(),
    balance_evidence_bounded: z.boolean(),
    fee_evidence_current: z.boolean(),
    fee_evidence_bounded: z.boolean(),
    attempt_current: z.boolean(),
    attempt_remaining_milliseconds: z
      .number()
      .int()
      .min(0)
      .max(SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS),
  })
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
  readonly privyUserId: string;
  readonly walletId: string;
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
  /** Fresh server resolver observation, never route input. */
  readonly walletVerifiedAt: string;
  /** Short resolver lease checked against the database clock after lock waits. */
  readonly walletExpiresAt: string;
}

export interface BeginSpotIntentSubmissionInput {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly requestId: string;
  readonly expectedReviewSha256: string;
  /** Server-resolved authority. This object must never be built from route input. */
  readonly walletEvidence: Readonly<{
    ownerUserId: string;
    privyUserId: string;
    walletId: string;
    accountAddress: string;
    accountKind: "master";
    bindingVersion: string;
    /** Current resolver observation time, not the binding row update time. */
    verifiedAt: string;
    expiresAt: string;
  }>;
  /** Fresh server-side Hyperliquid metadata evidence, never client authority. */
  readonly marketEvidence: Readonly<{
    provider: "hyperliquid";
    network: "testnet";
    dataset: "spotMetaAndAssetCtxs";
    marketId: string;
    providerCoin: string;
    baseTokenIndex: number;
    baseTokenId: string;
    quoteTokenIndex: number;
    quoteTokenId: string;
    spotPairIndex: number;
    exchangeOrderAsset: number;
    metadataVersion: string;
    metadataSha256: string;
    fetchedAt: string;
    expiresAt: string;
  }>;
  /**
   * Sanitized private-account facts. They are checked with the database clock
   * immediately before the journal and after deferred constraints, but cannot
   * reserve funds or promise to cover the complete transport window.
   */
  readonly accountEvidence: Readonly<{
    provider: "hyperliquid";
    network: "testnet";
    accountAddress: string;
    metadataVersion: string;
    balance: Readonly<{
      dataset: "spotClearinghouseState";
      tokenIndex: number;
      tokenId: string;
      available: string;
      fetchedAt: string;
      expiresAt: string;
    }>;
    fees: Readonly<{
      dataset: "userFees";
      currentTakerRate: string;
      fetchedAt: string;
      expiresAt: string;
    }>;
  }>;
  /**
   * Short-lived, server-generated aggregate mutation gate. Every positive
   * field is literal so missing or unknown product, legal, signer, kill-switch,
   * or reconciliation evidence fails before nonce allocation.
   */
  readonly policyEvidence: Readonly<{
    ownerUserId: string;
    intentId: string;
    network: "testnet";
    action: "spot_ioc_order";
    decision: "allow";
    policyVersion: string;
    productEnabled: true;
    legalEligible: true;
    sanctionsEligible: true;
    killSwitchOpen: true;
    signerReady: true;
    reconciliationReady: true;
    checkedAt: string;
    expiresAt: string;
  }>;
}

export interface SpotIntentSubmissionAttempt {
  readonly intentId: string;
  readonly network: "testnet";
  readonly transportAttemptId: string;
  readonly operationRecordVersion: string;
  readonly attemptCommittedAt: string;
  readonly attemptDeadlineAt: string;
  /** DB-clock budget observed before commit; callers must only shorten it. */
  readonly writeStartBudgetMilliseconds: number;
  readonly nonce: string;
  readonly agentAddress: string;
  readonly signerRef: string;
  readonly canonicalAction: SpotCanonicalAction;
  readonly vaultAddress: null;
  /** Exact reviewed expiry in Unix milliseconds; the signer must not derive it. */
  readonly expiresAfter: string;
}

export type BeginSpotIntentSubmissionResult =
  | Readonly<{
      kind: "started";
      intent: SpotIntentRecord;
      attempt: SpotIntentSubmissionAttempt;
    }>
  | Readonly<{
      kind: "already_attempted";
      intent: SpotIntentRecord;
    }>
  | Readonly<{ kind: "not_found" }>;

export type SpotIntentSubmissionUnknown = Readonly<
  z.output<typeof submissionUnknownSchema>
>;

export interface RecordSpotIntentSubmissionUnknownInput {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly requestId: string;
  readonly transportAttemptId: string;
  readonly expectedOperationRecordVersion: string;
  readonly expectedIntentRecordVersion: string;
  /**
   * A server-normalized result. Provider payloads, errors, signatures, and
   * wire bytes must be parsed and discarded before this boundary.
   */
  readonly outcome: SpotIntentSubmissionUnknown;
}

export type RecordSpotIntentSubmissionUnknownResult =
  | Readonly<{ kind: "recorded"; intent: SpotIntentRecord }>
  | Readonly<{ kind: "already_recorded"; intent: SpotIntentRecord }>
  | Readonly<{ kind: "not_found" }>;

export interface QuarantineExpiredSpotIntentSubmissionsInput {
  readonly requestId: string;
  readonly limit: number;
}

export interface SpotIntentRepository {
  claimPrepare(
    input: ClaimSpotIntentPrepareInput,
  ): Promise<ClaimSpotIntentPrepareResult>;
  prepare(input: PrepareSpotIntentInput): Promise<{
    readonly created: boolean;
    readonly intent: SpotIntentRecord;
  }>;
  beginSubmission(
    input: BeginSpotIntentSubmissionInput,
  ): Promise<BeginSpotIntentSubmissionResult>;
  findOwned(
    ownerUserId: string,
    intentId: string,
  ): Promise<SpotIntentRecord | null>;
}

export interface SpotIntentSubmissionRecoveryRepository {
  recordSubmissionUnknown(
    input: RecordSpotIntentSubmissionUnknownInput,
  ): Promise<RecordSpotIntentSubmissionUnknownResult>;
  quarantineExpiredSubmissions(
    input: QuarantineExpiredSpotIntentSubmissionsInput,
  ): Promise<readonly SpotIntentRecord[]>;
}

export interface PostgresSpotIntentRepository
  extends SpotIntentRepository, SpotIntentSubmissionRecoveryRepository {}

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

export class SpotIntentSubmissionConflictError extends Error {
  readonly code = "spot_intent_submission_conflict";

  constructor() {
    super("The Spot submission attempt or outcome no longer matches");
    this.name = "SpotIntentSubmissionConflictError";
  }
}

interface ParsedPrepareInput extends Omit<
  PrepareSpotIntentInput,
  "canonicalAction" | "publicReview"
> {
  readonly canonicalAction: SpotCanonicalAction;
  readonly publicReview: SpotReview;
}

type ParsedBeginSpotIntentSubmissionInput = z.output<
  typeof beginSubmissionInputSchema
>;
type ParsedRecordSpotIntentSubmissionUnknownInput = z.output<
  typeof recordSubmissionUnknownInputSchema
>;

interface CurrentSpotAuthority {
  readonly authorizationId: string;
  readonly agentAddress: string;
  readonly signerRef: string;
}

interface SpotAuthorityCoordinates {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly walletId: string;
  readonly accountAddress: string;
  readonly accountKind: "master";
  readonly bindingVersion: string;
  readonly agentIdentityId: string;
}

interface PrepareSpotAuthorityValidityRequirement {
  readonly walletVerifiedAt: string;
  readonly walletExpiresAt: string;
  readonly reviewExpiresAt: string;
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
  input: Omit<
    ParsedPrepareInput,
    | "claimId"
    | "idempotencyKey"
    | "requestId"
    | "privyUserId"
    | "walletId"
    | "walletVerifiedAt"
    | "walletExpiresAt"
  >,
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
      privyUserId: rawInput.privyUserId,
      walletId: rawInput.walletId,
      accountAddress: rawInput.accountAddress,
      accountKind: rawInput.accountKind,
      bindingVersion: rawInput.bindingVersion,
      agentIdentityId: rawInput.agentIdentityId,
      clientOrderId: rawInput.clientOrderId,
      reviewSha256: rawInput.reviewSha256,
      factsObservedAt: rawInput.factsObservedAt,
      referenceSourceTime: rawInput.referenceSourceTime,
      expiresAt: rawInput.expiresAt,
      walletVerifiedAt: rawInput.walletVerifiedAt,
      walletExpiresAt: rawInput.walletExpiresAt,
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

async function lockOwnedIntent(
  client: DatabaseClient,
  ownerUserId: string,
  intentId: string,
): Promise<Readonly<{
  row: z.output<typeof intentRowSchema>;
  record: SpotIntentRecord;
}> | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${intentReturningColumns}
      from public.spot_intents as intent
      where intent.owner_user_id = $1 and intent.id = $2
      limit 1
      for update
    `,
    values: [ownerUserId, intentId],
  });
  const value = result.rows[0];
  if (value === undefined) {
    return null;
  }
  const row = intentRowSchema.safeParse(value);
  if (!row.success) {
    return failUnavailable();
  }
  return Object.freeze({ row: row.data, record: toSpotIntentRecord(value) });
}

async function lockSubmissionOperation(
  client: DatabaseClient,
  ownerUserId: string,
  intentId: string,
): Promise<z.output<typeof submissionOperationRowSchema> | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
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
        record_version::text as record_version
      from public.provider_operations
      where owner_user_id = $1 and id = $2
      limit 1
      for update
    `,
    values: [ownerUserId, intentId],
  });
  const value = result.rows[0];
  if (value === undefined) {
    return null;
  }
  const parsed = submissionOperationRowSchema.safeParse(value);
  return parsed.success ? parsed.data : failUnavailable();
}

function immutableIntentAuthorityMatches(
  first: SpotIntentRecord,
  second: SpotIntentRecord,
): boolean {
  return (
    first.id === second.id &&
    first.ownerUserId === second.ownerUserId &&
    first.requestSha256 === second.requestSha256 &&
    first.marketId === second.marketId &&
    first.providerCoin === second.providerCoin &&
    first.baseTokenIndex === second.baseTokenIndex &&
    first.baseTokenId === second.baseTokenId &&
    first.quoteTokenIndex === second.quoteTokenIndex &&
    first.quoteTokenId === second.quoteTokenId &&
    first.spotPairIndex === second.spotPairIndex &&
    first.exchangeOrderAsset === second.exchangeOrderAsset &&
    first.metadataVersion === second.metadataVersion &&
    first.metadataSha256 === second.metadataSha256 &&
    first.policyVersion === second.policyVersion &&
    first.accountAddress === second.accountAddress &&
    first.bindingVersion === second.bindingVersion &&
    first.agentIdentityId === second.agentIdentityId &&
    first.clientOrderId === second.clientOrderId &&
    first.reviewSha256 === second.reviewSha256 &&
    first.factsObservedAt === second.factsObservedAt &&
    first.referenceSourceTime === second.referenceSourceTime &&
    first.createdAt === second.createdAt &&
    JSON.stringify(first.canonicalAction) ===
      JSON.stringify(second.canonicalAction) &&
    JSON.stringify(first.publicReview) === JSON.stringify(second.publicReview)
  );
}

function expectedSubmissionAuthorityMatches(
  input: ParsedBeginSpotIntentSubmissionInput,
  intent: SpotIntentRecord,
): boolean {
  const wallet = input.walletEvidence;
  const market = input.marketEvidence;
  const account = input.accountEvidence;
  const policy = input.policyEvidence;
  const review = intent.publicReview;
  const expectedBalance =
    review.side === "buy"
      ? Object.freeze({
          tokenIndex: intent.quoteTokenIndex,
          tokenId: intent.quoteTokenId,
          required: review.maximum_spend_or_minimum_receive.value,
          kind: "maximum_spend" as const,
        })
      : Object.freeze({
          tokenIndex: intent.baseTokenIndex,
          tokenId: intent.baseTokenId,
          required: review.computed_base_size,
          kind: "minimum_receive" as const,
        });
  return (
    input.ownerUserId === wallet.ownerUserId &&
    input.ownerUserId === policy.ownerUserId &&
    input.intentId === policy.intentId &&
    input.expectedReviewSha256 === intent.reviewSha256 &&
    wallet.accountAddress === intent.accountAddress &&
    wallet.bindingVersion === intent.bindingVersion &&
    market.marketId === intent.marketId &&
    market.providerCoin === intent.providerCoin &&
    market.baseTokenIndex === intent.baseTokenIndex &&
    market.baseTokenId === intent.baseTokenId &&
    market.quoteTokenIndex === intent.quoteTokenIndex &&
    market.quoteTokenId === intent.quoteTokenId &&
    market.spotPairIndex === intent.spotPairIndex &&
    market.exchangeOrderAsset === intent.exchangeOrderAsset &&
    market.exchangeOrderAsset === 10_000 + market.spotPairIndex &&
    market.metadataVersion === intent.metadataVersion &&
    market.metadataSha256 === intent.metadataSha256 &&
    account.accountAddress === intent.accountAddress &&
    account.metadataVersion === intent.metadataVersion &&
    account.balance.tokenIndex === expectedBalance.tokenIndex &&
    account.balance.tokenId === expectedBalance.tokenId &&
    review.maximum_spend_or_minimum_receive.kind === expectedBalance.kind &&
    compareExactUnsignedDecimals(
      account.balance.available,
      expectedBalance.required,
    ) >= 0 &&
    compareExactUnsignedDecimals(
      account.fees.currentTakerRate,
      review.fee_rate,
    ) <= 0 &&
    policy.policyVersion === intent.policyVersion
  );
}

function expectedGenericState(
  spotState: z.output<typeof stateSchema>,
): z.output<typeof submissionOperationStateSchema> | null {
  switch (spotState) {
    case "prepared":
    case "expired":
      return "prepared";
    case "submitting":
      return "submitting";
    case "accepted":
      return "accepted";
    case "partially_filled":
    case "filled":
    case "not_filled":
      return "succeeded";
    case "rejected":
      return "rejected";
    case "unknown":
    case "reconciling":
    case "operator_required":
      return "unknown";
  }
}

function assertSubmissionProjection(
  operation: z.output<typeof submissionOperationRowSchema>,
  intent: z.output<typeof intentRowSchema>,
): void {
  if (
    operation.id !== intent.id ||
    operation.owner_user_id !== intent.owner_user_id ||
    operation.request_sha256 !== intent.request_sha256 ||
    operation.state !== expectedGenericState(intent.stored_state)
  ) {
    return failUnavailable();
  }
  if (operation.state === "prepared") {
    if (
      operation.attempt_count !== 0 ||
      operation.transport_attempt_id !== null ||
      operation.attempt_committed_at !== null ||
      operation.attempt_deadline_at !== null ||
      operation.reconciliation_status !== "not_required" ||
      operation.record_version !== "0"
    ) {
      return failUnavailable();
    }
    return;
  }
  if (
    operation.attempt_count !== 1 ||
    operation.transport_attempt_id === null ||
    operation.attempt_committed_at === null ||
    operation.attempt_deadline_at === null ||
    operation.attempt_deadline_at <= operation.attempt_committed_at ||
    operation.record_version !== intent.record_version
  ) {
    return failUnavailable();
  }
}

function assertSubmissionValidity(value: unknown, finalCheck: boolean): number {
  const parsed = submissionValidityRowSchema.safeParse(value);
  if (!parsed.success) {
    return failUnavailable();
  }
  const validity = parsed.data;
  if (!validity.review_current || !validity.review_covers_attempt) {
    throw new SpotIntentPrepareExpiredError();
  }
  if (
    !validity.agent_current ||
    !validity.agent_covers_attempt ||
    !validity.wallet_evidence_current ||
    !validity.wallet_evidence_bounded ||
    !validity.wallet_evidence_covers_attempt ||
    !validity.market_evidence_current ||
    !validity.market_evidence_bounded ||
    !validity.market_evidence_covers_attempt ||
    !validity.policy_evidence_current ||
    !validity.policy_evidence_bounded ||
    !validity.policy_evidence_covers_attempt ||
    !validity.balance_evidence_current ||
    !validity.balance_evidence_bounded ||
    !validity.fee_evidence_current ||
    !validity.fee_evidence_bounded ||
    (finalCheck && !validity.attempt_current)
  ) {
    throw new SpotIntentAuthorityStaleError();
  }
  return validity.attempt_remaining_milliseconds;
}

async function validateSubmissionWindow(
  client: DatabaseClient,
  input: ParsedBeginSpotIntentSubmissionInput,
  authorizationId: string,
  attemptDeadlineAt: string | null,
): Promise<number> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      ), submission_window as (
        select
          database_clock.observed_at,
          coalesce(
            $4::timestamptz,
            database_clock.observed_at
              + ($5::integer * interval '1 millisecond')
          ) as attempt_deadline_at
        from database_clock
      )
      select
        submission_window.observed_at < intent.expires_at
          as review_current,
        submission_window.attempt_deadline_at < intent.expires_at
          as review_covers_attempt,
        submission_window.observed_at < agent_authorization.agent_valid_until
          as agent_current,
        submission_window.attempt_deadline_at
          < agent_authorization.agent_valid_until as agent_covers_attempt,
        $6::timestamptz <= submission_window.observed_at
          and submission_window.observed_at < $7::timestamptz
          as wallet_evidence_current,
        $6::timestamptz < $7::timestamptz
          and $7::timestamptz <= $6::timestamptz
            + ($8::integer * interval '1 millisecond')
          as wallet_evidence_bounded,
        submission_window.attempt_deadline_at < $7::timestamptz
          as wallet_evidence_covers_attempt,
        $9::timestamptz <= submission_window.observed_at
          and submission_window.observed_at < $10::timestamptz
          as market_evidence_current,
        $9::timestamptz < $10::timestamptz
          and $10::timestamptz <= $9::timestamptz
            + ($11::integer * interval '1 millisecond')
          as market_evidence_bounded,
        submission_window.attempt_deadline_at < $10::timestamptz
          as market_evidence_covers_attempt,
        $12::timestamptz <= submission_window.observed_at
          and submission_window.observed_at < $13::timestamptz
          as policy_evidence_current,
        $12::timestamptz < $13::timestamptz
          and $13::timestamptz <= $12::timestamptz
            + ($8::integer * interval '1 millisecond')
          as policy_evidence_bounded,
        submission_window.attempt_deadline_at < $13::timestamptz
          as policy_evidence_covers_attempt,
        $14::timestamptz <= submission_window.observed_at
          and submission_window.observed_at < $15::timestamptz
          as balance_evidence_current,
        $14::timestamptz < $15::timestamptz
          and $15::timestamptz <= $14::timestamptz
            + ($18::integer * interval '1 millisecond')
          as balance_evidence_bounded,
        $16::timestamptz <= submission_window.observed_at
          and submission_window.observed_at < $17::timestamptz
          as fee_evidence_current,
        $16::timestamptz < $17::timestamptz
          and $17::timestamptz <= $16::timestamptz
            + ($18::integer * interval '1 millisecond')
          as fee_evidence_bounded,
        submission_window.observed_at
          < submission_window.attempt_deadline_at as attempt_current,
        greatest(
          0,
          floor(
            extract(
              epoch from (
                submission_window.attempt_deadline_at
                - submission_window.observed_at
              )
            ) * 1000
          )
        )::integer as attempt_remaining_milliseconds
      from public.spot_intents as intent
      join public.spot_agent_authorizations as agent_authorization
        on agent_authorization.id = $3
        and agent_authorization.owner_user_id = intent.owner_user_id
        and agent_authorization.agent_identity_id = intent.agent_identity_id
        and agent_authorization.state = 'active'
      cross join submission_window
      where intent.id = $1
        and intent.owner_user_id = $2
      limit 1
    `,
    values: [
      input.intentId,
      input.ownerUserId,
      authorizationId,
      attemptDeadlineAt,
      SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS,
      input.walletEvidence.verifiedAt,
      input.walletEvidence.expiresAt,
      SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS,
      input.marketEvidence.fetchedAt,
      input.marketEvidence.expiresAt,
      SPOT_INTENT_SUBMISSION_METADATA_LEASE_MILLISECONDS,
      input.policyEvidence.checkedAt,
      input.policyEvidence.expiresAt,
      input.accountEvidence.balance.fetchedAt,
      input.accountEvidence.balance.expiresAt,
      input.accountEvidence.fees.fetchedAt,
      input.accountEvidence.fees.expiresAt,
      SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS,
    ],
  });
  return assertSubmissionValidity(result.rows[0], attemptDeadlineAt !== null);
}

async function allocateSpotAgentNonce(
  client: DatabaseClient,
  agentAddress: string,
): Promise<string> {
  const result = await client.query<{ nonce: string }>({
    text: `
      with database_clock as (
        select
          clock_timestamp() as observed_at,
          floor(extract(epoch from clock_timestamp()) * 1000)::numeric
            as unix_milliseconds
      )
      insert into public.hyperliquid_signer_nonce_state (
        network,
        signer_address,
        signer_kind,
        last_allocated_nonce,
        created_at,
        updated_at
      )
      select
        'testnet',
        $1,
        'spot_agent',
        database_clock.unix_milliseconds,
        database_clock.observed_at,
        database_clock.observed_at
      from database_clock
      on conflict (network, signer_address)
      do update set
        last_allocated_nonce = greatest(
          hyperliquid_signer_nonce_state.last_allocated_nonce + 1,
          excluded.last_allocated_nonce
        ),
        updated_at = greatest(
          hyperliquid_signer_nonce_state.updated_at,
          excluded.updated_at
        )
      where hyperliquid_signer_nonce_state.signer_kind = excluded.signer_kind
        and greatest(
          hyperliquid_signer_nonce_state.last_allocated_nonce + 1,
          excluded.last_allocated_nonce
        ) < excluded.last_allocated_nonce + $2::numeric
      returning last_allocated_nonce::text as nonce
    `,
    values: [agentAddress, HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS],
  });
  const nonce = result.rows[0]?.nonce;
  return nonce !== undefined && nonceSchema.safeParse(nonce).success
    ? nonce
    : failUnavailable();
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

async function validatePrepareAuthorityWindow(
  client: DatabaseClient,
  ownerUserId: string,
  authorizationId: string,
  requirement: PrepareSpotAuthorityValidityRequirement,
): Promise<void> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      select
        database_clock.observed_at < $5::timestamptz as review_current,
        database_clock.observed_at < agent_authorization.agent_valid_until
          as agent_current,
        $5::timestamptz <= agent_authorization.agent_valid_until
          as agent_covers_review,
        $3::timestamptz <= database_clock.observed_at
          and database_clock.observed_at < $4::timestamptz
          as wallet_evidence_current,
        $3::timestamptz < $4::timestamptz
          and $4::timestamptz <= $3::timestamptz
            + ($6::integer * interval '1 millisecond')
          as wallet_evidence_bounded
      from public.spot_agent_authorizations as agent_authorization
      cross join database_clock
      where agent_authorization.id = $1
        and agent_authorization.owner_user_id = $2
        and agent_authorization.state = 'active'
      limit 1
    `,
    values: [
      authorizationId,
      ownerUserId,
      requirement.walletVerifiedAt,
      requirement.walletExpiresAt,
      requirement.reviewExpiresAt,
      SPOT_INTENT_PREPARE_AUTHORITY_LEASE_MILLISECONDS,
    ],
  });
  const validity = prepareAuthorityValidityRowSchema.safeParse(result.rows[0]);
  if (!validity.success) {
    throw new SpotIntentAuthorityStaleError();
  }
  if (!validity.data.review_current) {
    throw new SpotIntentPrepareExpiredError();
  }
  if (
    !validity.data.agent_current ||
    !validity.data.agent_covers_review ||
    !validity.data.wallet_evidence_current ||
    !validity.data.wallet_evidence_bounded
  ) {
    throw new SpotIntentAuthorityStaleError();
  }
}

async function assertCurrentAuthority(
  client: DatabaseClient,
  input: SpotAuthorityCoordinates,
  prepareRequirement: PrepareSpotAuthorityValidityRequirement | null,
): Promise<CurrentSpotAuthority> {
  const ownerResult = await client.query<Record<string, unknown>>({
    text: `
      select id, privy_user_id
      from public.loop_users
      where id = $1
      limit 1
      for update
    `,
    values: [input.ownerUserId],
  });
  const owner = currentOwnerRowSchema.safeParse(ownerResult.rows[0]);
  if (
    !owner.success ||
    owner.data.id !== input.ownerUserId ||
    owner.data.privy_user_id !== input.privyUserId
  ) {
    throw new SpotIntentAuthorityStaleError();
  }

  const walletResult = await client.query<Record<string, unknown>>({
    text: `
      select
        privy_user_id,
        binding_state,
        wallet_id,
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
    wallet.data.privy_user_id !== input.privyUserId ||
    wallet.data.wallet_id !== input.walletId ||
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
        signer_ref,
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
        agent_valid_until,
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

  if (prepareRequirement === null) {
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
  } else {
    await validatePrepareAuthorityWindow(
      client,
      input.ownerUserId,
      authorization.data.id,
      prepareRequirement,
    );
  }
  return Object.freeze({
    authorizationId: authorization.data.id,
    agentAddress: agent.data.agent_address,
    signerRef: agent.data.signer_ref,
  });
}

async function beginSubmissionTransaction(
  client: PoolClient,
  input: ParsedBeginSpotIntentSubmissionInput,
): Promise<BeginSpotIntentSubmissionResult> {
  const discovered = await readOwnedIntent(
    client,
    input.ownerUserId,
    input.intentId,
  );
  if (discovered === null) {
    return Object.freeze({ kind: "not_found" as const });
  }
  if (discovered.state === "expired") {
    throw new SpotIntentPrepareExpiredError();
  }
  if (discovered.state !== "prepared") {
    return Object.freeze({
      kind: "already_attempted" as const,
      intent: discovered,
    });
  }
  if (!expectedSubmissionAuthorityMatches(input, discovered)) {
    throw new SpotIntentAuthorityStaleError();
  }

  const authority = await assertCurrentAuthority(
    client,
    {
      ownerUserId: input.ownerUserId,
      privyUserId: input.walletEvidence.privyUserId,
      walletId: input.walletEvidence.walletId,
      accountAddress: discovered.accountAddress,
      accountKind: "master",
      bindingVersion: discovered.bindingVersion,
      agentIdentityId: discovered.agentIdentityId,
    },
    null,
  );
  const operation = await lockSubmissionOperation(
    client,
    input.ownerUserId,
    input.intentId,
  );
  const locked = await lockOwnedIntent(
    client,
    input.ownerUserId,
    input.intentId,
  );
  if (operation === null || locked === null) {
    return failUnavailable();
  }
  if (!immutableIntentAuthorityMatches(discovered, locked.record)) {
    return failUnavailable();
  }
  assertSubmissionProjection(operation, locked.row);
  if (locked.record.state === "expired") {
    throw new SpotIntentPrepareExpiredError();
  }
  if (operation.state !== "prepared") {
    return Object.freeze({
      kind: "already_attempted" as const,
      intent: locked.record,
    });
  }
  if (
    locked.row.stored_state !== "prepared" ||
    !expectedSubmissionAuthorityMatches(input, locked.record)
  ) {
    throw new SpotIntentAuthorityStaleError();
  }

  await validateSubmissionWindow(
    client,
    input,
    authority.authorizationId,
    null,
  );

  const transportAttemptId = randomUUID();
  const journalResult = await client.query<Record<string, unknown>>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      update public.provider_operations as operation
      set
        state = 'submitting',
        attempt_count = 1,
        transport_attempt_id = $3,
        attempt_committed_at = database_clock.observed_at,
        attempt_deadline_at = database_clock.observed_at
          + ($4::integer * interval '1 millisecond'),
        record_version = operation.record_version + 1,
        updated_at = database_clock.observed_at
      from database_clock
      where operation.id = $1
        and operation.owner_user_id = $2
        and operation.domain = 'hyperliquid'
        and operation.operation_kind = 'spot_intent'
        and operation.state = 'prepared'
        and operation.attempt_count = 0
        and operation.transport_attempt_id is null
        and operation.attempt_committed_at is null
        and operation.attempt_deadline_at is null
        and operation.reconciliation_status = 'not_required'
        and operation.record_version = 0
      returning
        operation.attempt_committed_at,
        operation.attempt_deadline_at,
        operation.record_version::text as record_version
    `,
    values: [
      input.intentId,
      input.ownerUserId,
      transportAttemptId,
      SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS,
    ],
  });
  const journal = submissionJournalRowSchema.safeParse(journalResult.rows[0]);
  if (!journal.success || journal.data.record_version !== "1") {
    return failUnavailable();
  }

  const projectionResult = await client.query<{ record_version: string }>({
    text: `
      update public.spot_intents as intent
      set
        state = 'submitting',
        record_version = intent.record_version + 1,
        updated_at = clock_timestamp()
      where intent.id = $1
        and intent.owner_user_id = $2
        and intent.state = 'prepared'
        and intent.record_version = 0
      returning intent.record_version::text as record_version
    `,
    values: [input.intentId, input.ownerUserId],
  });
  if (projectionResult.rows[0]?.record_version !== "1") {
    return failUnavailable();
  }

  const nonce = await allocateSpotAgentNonce(client, authority.agentAddress);
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
      values (
        $1, $2, 'testnet', $3, 'spot_agent', 'spot_ioc_order', $4::numeric
      )
    `,
    values: [input.intentId, input.ownerUserId, authority.agentAddress, nonce],
  });
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
        $1, $2, $3, 'api', 'provider_submission_started',
        'prepared', 'submitting', 'not_required', 'not_required',
        'submission_started', 1, 0, $4
      )
    `,
    values: [
      input.ownerUserId,
      input.intentId,
      input.requestId,
      transportAttemptId,
    ],
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
        $1, $2, $3, 'api', 'intent_submission_started',
        'prepared', 'submitting', 'submission_started', 1
      )
    `,
    values: [input.intentId, input.ownerUserId, input.requestId],
  });

  // Force every deferred cross-projection/nonce invariant before the final
  // DB-clock check. If trigger evaluation waits, the subsequent check observes
  // that delay and rolls back the entire journal and nonce high-water advance.
  await client.query("set constraints all immediate");
  const writeStartBudgetMilliseconds = await validateSubmissionWindow(
    client,
    input,
    authority.authorizationId,
    journal.data.attempt_deadline_at.toISOString(),
  );

  const intent = await readOwnedIntent(
    client,
    input.ownerUserId,
    input.intentId,
  );
  if (
    intent === null ||
    intent.state !== "submitting" ||
    intent.recordVersion !== "1" ||
    !immutableIntentAuthorityMatches(locked.record, intent)
  ) {
    return failUnavailable();
  }
  return Object.freeze({
    kind: "started" as const,
    intent,
    attempt: Object.freeze({
      intentId: intent.id,
      network: "testnet" as const,
      transportAttemptId,
      operationRecordVersion: journal.data.record_version,
      attemptCommittedAt: journal.data.attempt_committed_at.toISOString(),
      attemptDeadlineAt: journal.data.attempt_deadline_at.toISOString(),
      writeStartBudgetMilliseconds,
      nonce,
      agentAddress: authority.agentAddress,
      signerRef: authority.signerRef,
      canonicalAction: intent.canonicalAction,
      vaultAddress: null,
      expiresAfter: locked.row.expires_at.getTime().toString(),
    }),
  });
}

type ParsedSubmissionUnknown = z.output<typeof submissionUnknownSchema>;
type PersistedSubmissionUnknown = Readonly<
  Omit<ParsedSubmissionUnknown, "reasonCode"> & {
    readonly reasonCode:
      ParsedSubmissionUnknown["reasonCode"] | "submission_deadline_elapsed";
  }
>;
type LockedSpotIntent = NonNullable<
  Awaited<ReturnType<typeof lockOwnedIntent>>
>;

function storedSubmissionUnknownMatches(
  operation: z.output<typeof submissionOperationRowSchema>,
  locked: LockedSpotIntent,
  transportAttemptId: string,
  expectedOperationRecordVersion: string,
  expectedIntentRecordVersion: string,
  outcome: ParsedSubmissionUnknown,
): boolean {
  const result = locked.record.result;
  return (
    operation.transport_attempt_id === transportAttemptId &&
    expectedOperationRecordVersion === "1" &&
    expectedIntentRecordVersion === "1" &&
    operation.state === "unknown" &&
    operation.reconciliation_status === "pending" &&
    operation.record_version === "2" &&
    locked.record.recordVersion === "2" &&
    locked.row.stored_state === "unknown" &&
    locked.record.state === "unknown" &&
    result !== null &&
    result.state === "unknown" &&
    result.order_id === null &&
    result.reason_code === outcome.reasonCode &&
    locked.row.filled_base_size === null &&
    locked.row.filled_quote_amount === null &&
    locked.row.average_fill_price === null &&
    locked.row.result_fee_amount === null &&
    locked.row.result_fee_token_index === null &&
    locked.row.result_fee_token_id === null &&
    locked.row.result_fee_asset_display_identity === null
  );
}

interface PersistSubmissionUnknownOptions {
  readonly actorType: "api" | "worker";
  readonly auditEventType:
    "provider_submission_uncertain" | "submission_deadline_quarantined";
  readonly intentEventType:
    "intent_submission_uncertain" | "intent_submission_deadline_quarantined";
}

async function persistSubmissionUnknown(
  client: DatabaseClient,
  input: Readonly<{
    ownerUserId: string;
    intentId: string;
    requestId: string;
    transportAttemptId: string;
    expectedOperationRecordVersion: string;
    expectedIntentRecordVersion: string;
    outcome: PersistedSubmissionUnknown;
  }>,
  operation: z.output<typeof submissionOperationRowSchema>,
  locked: LockedSpotIntent,
  options: PersistSubmissionUnknownOptions,
): Promise<SpotIntentRecord> {
  if (
    operation.state !== "submitting" ||
    operation.reconciliation_status !== "not_required" ||
    operation.transport_attempt_id !== input.transportAttemptId ||
    operation.record_version !== input.expectedOperationRecordVersion ||
    locked.record.recordVersion !== input.expectedIntentRecordVersion ||
    operation.record_version !== "1" ||
    locked.row.stored_state !== "submitting" ||
    locked.record.recordVersion !== "1"
  ) {
    throw new SpotIntentSubmissionConflictError();
  }

  const observedResult = await client.query<{ observed_at: Date }>(
    "select clock_timestamp() as observed_at",
  );
  const observedAt = validDateSchema.safeParse(
    observedResult.rows[0]?.observed_at,
  );
  if (!observedAt.success) {
    return failUnavailable();
  }
  const observedAtIso = observedAt.data.toISOString();
  const operationResult = await client.query<{ record_version: string }>({
    text: `
      update public.provider_operations as operation
      set
        state = 'unknown',
        reconciliation_status = 'pending',
        reconcile_after = $5::timestamptz,
        operator_required_at = null,
        lease_owner = null,
        lease_expires_at = null,
        record_version = operation.record_version + 1,
        updated_at = $5::timestamptz
      where operation.id = $1
        and operation.owner_user_id = $2
        and operation.domain = 'hyperliquid'
        and operation.operation_kind = 'spot_intent'
        and operation.state = 'submitting'
        and operation.reconciliation_status = 'not_required'
        and operation.transport_attempt_id = $3
        and operation.record_version = $4::bigint
      returning operation.record_version::text as record_version
    `,
    values: [
      input.intentId,
      input.ownerUserId,
      input.transportAttemptId,
      operation.record_version,
      observedAtIso,
    ],
  });
  const operationVersion = operationResult.rows[0]?.record_version;
  if (operationVersion === undefined) {
    return failUnavailable();
  }

  const intentResult = await client.query<{ record_version: string }>({
    text: `
      update public.spot_intents as intent
      set
        state = 'unknown',
        provider_order_id = null,
        filled_base_size = null,
        filled_quote_amount = null,
        average_fill_price = null,
        result_fee_amount = null,
        result_fee_token_index = null,
        result_fee_token_id = null,
        result_fee_asset_display_identity = null,
        result_observed_at = $4::timestamptz,
        result_reason_code = $5,
        record_version = intent.record_version + 1,
        updated_at = $4::timestamptz
      where intent.id = $1
        and intent.owner_user_id = $2
        and intent.domain = 'hyperliquid'
        and intent.operation_kind = 'spot_intent'
        and intent.state = 'submitting'
        and intent.record_version = $3::bigint
      returning intent.record_version::text as record_version
    `,
    values: [
      input.intentId,
      input.ownerUserId,
      locked.record.recordVersion,
      observedAtIso,
      input.outcome.reasonCode,
    ],
  });
  const intentVersion = intentResult.rows[0]?.record_version;
  if (
    intentVersion === undefined ||
    operationVersion !== intentVersion ||
    operationVersion !== "2"
  ) {
    return failUnavailable();
  }

  const auditResult = await client.query({
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
        $1, $2, $3, $4, $5, 'submitting', 'unknown',
        'not_required', 'pending', 'unknown', $6, $7::bigint, 0, $8
      )
    `,
    values: [
      input.ownerUserId,
      input.intentId,
      input.requestId,
      options.actorType,
      options.auditEventType,
      input.outcome.reasonCode,
      operationVersion,
      input.transportAttemptId,
    ],
  });
  const eventResult = await client.query({
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
      values (
        $1, $2, $3, $4, $5, 'submitting', 'unknown', 'unknown', $6,
        $7::bigint
      )
    `,
    values: [
      input.intentId,
      input.ownerUserId,
      input.requestId,
      options.actorType,
      options.intentEventType,
      input.outcome.reasonCode,
      intentVersion,
    ],
  });
  if (auditResult.rowCount !== 1 || eventResult.rowCount !== 1) {
    return failUnavailable();
  }

  const intent = await readOwnedIntent(
    client,
    input.ownerUserId,
    input.intentId,
  );
  if (
    intent === null ||
    intent.recordVersion !== intentVersion ||
    intent.state !== "unknown" ||
    intent.result === null
  ) {
    return failUnavailable();
  }
  return intent;
}

async function recordSubmissionUnknownTransaction(
  client: PoolClient,
  input: ParsedRecordSpotIntentSubmissionUnknownInput,
): Promise<RecordSpotIntentSubmissionUnknownResult> {
  const operation = await lockSubmissionOperation(
    client,
    input.ownerUserId,
    input.intentId,
  );
  if (operation === null) {
    return Object.freeze({ kind: "not_found" as const });
  }
  const locked = await lockOwnedIntent(
    client,
    input.ownerUserId,
    input.intentId,
  );
  if (locked === null) {
    return failUnavailable();
  }
  assertSubmissionProjection(operation, locked.row);

  if (operation.state !== "submitting") {
    if (
      storedSubmissionUnknownMatches(
        operation,
        locked,
        input.transportAttemptId,
        input.expectedOperationRecordVersion,
        input.expectedIntentRecordVersion,
        input.outcome,
      )
    ) {
      return Object.freeze({
        kind: "already_recorded" as const,
        intent: locked.record,
      });
    }
    throw new SpotIntentSubmissionConflictError();
  }

  const intent = await persistSubmissionUnknown(
    client,
    input,
    operation,
    locked,
    Object.freeze({
      actorType: "api" as const,
      auditEventType: "provider_submission_uncertain" as const,
      intentEventType: "intent_submission_uncertain" as const,
    }),
  );
  return Object.freeze({ kind: "recorded" as const, intent });
}

async function quarantineExpiredSubmissionTransactions(
  client: PoolClient,
  input: z.output<typeof quarantineExpiredSubmissionsInputSchema>,
): Promise<readonly SpotIntentRecord[]> {
  const candidates = await client.query<{
    id: string;
    owner_user_id: string;
  }>({
    text: `
      select operation.id, operation.owner_user_id
      from public.provider_operations as operation
      where operation.domain = 'hyperliquid'
        and operation.operation_kind = 'spot_intent'
        and operation.state = 'submitting'
        and operation.reconciliation_status = 'not_required'
        and operation.attempt_deadline_at <= clock_timestamp()
      order by operation.attempt_deadline_at, operation.id
      for update skip locked
      limit $1
    `,
    values: [input.limit],
  });
  const quarantined: SpotIntentRecord[] = [];
  for (const candidate of candidates.rows) {
    const ownerUserId = uuidSchema.safeParse(candidate.owner_user_id);
    const intentId = uuidSchema.safeParse(candidate.id);
    if (!ownerUserId.success || !intentId.success) {
      return failUnavailable();
    }
    const operation = await lockSubmissionOperation(
      client,
      ownerUserId.data,
      intentId.data,
    );
    const locked = await lockOwnedIntent(
      client,
      ownerUserId.data,
      intentId.data,
    );
    if (
      operation === null ||
      locked === null ||
      operation.transport_attempt_id === null
    ) {
      return failUnavailable();
    }
    assertSubmissionProjection(operation, locked.row);
    quarantined.push(
      await persistSubmissionUnknown(
        client,
        Object.freeze({
          ownerUserId: ownerUserId.data,
          intentId: intentId.data,
          requestId: input.requestId,
          transportAttemptId: operation.transport_attempt_id,
          expectedOperationRecordVersion: operation.record_version,
          expectedIntentRecordVersion: locked.record.recordVersion,
          outcome: Object.freeze({
            state: "unknown" as const,
            providerOrderId: null,
            reasonCode: "submission_deadline_elapsed",
          }),
        }),
        operation,
        locked,
        Object.freeze({
          actorType: "worker" as const,
          auditEventType: "submission_deadline_quarantined" as const,
          intentEventType: "intent_submission_deadline_quarantined" as const,
        }),
      ),
    );
  }
  return Object.freeze(quarantined);
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof SpotIntentPrepareClaimRequiredError ||
    error instanceof SpotIntentPrepareExpiredError ||
    error instanceof SpotIntentAuthorityStaleError ||
    error instanceof SpotIntentClaimLimitExceededError ||
    error instanceof SpotIntentSubmissionConflictError ||
    error instanceof SpotIntentRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new SpotIntentRepositoryUnavailableError();
}

export function createPostgresSpotIntentRepository(
  pool: Pool,
): PostgresSpotIntentRepository {
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

          const authority = await assertCurrentAuthority(client, input, {
            walletVerifiedAt: input.walletVerifiedAt,
            walletExpiresAt: input.walletExpiresAt,
            reviewExpiresAt: input.expiresAt,
          });
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

          // Force deferred cross-projection checks before the final DB-clock
          // authority validation. Any wait here must not outlive the resolver
          // evidence or the review while still committing a prepared intent.
          await client.query("set constraints all immediate");
          await validatePrepareAuthorityWindow(
            client,
            input.ownerUserId,
            authority.authorizationId,
            {
              walletVerifiedAt: input.walletVerifiedAt,
              walletExpiresAt: input.walletExpiresAt,
              reviewExpiresAt: input.expiresAt,
            },
          );

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

    async beginSubmission(
      rawInput: BeginSpotIntentSubmissionInput,
    ): Promise<BeginSpotIntentSubmissionResult> {
      try {
        const input = beginSubmissionInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) =>
          beginSubmissionTransaction(client, input),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async recordSubmissionUnknown(
      rawInput: RecordSpotIntentSubmissionUnknownInput,
    ): Promise<RecordSpotIntentSubmissionUnknownResult> {
      try {
        const input = recordSubmissionUnknownInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) =>
          recordSubmissionUnknownTransaction(client, input),
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async quarantineExpiredSubmissions(
      rawInput: QuarantineExpiredSpotIntentSubmissionsInput,
    ): Promise<readonly SpotIntentRecord[]> {
      try {
        const input = quarantineExpiredSubmissionsInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) =>
          quarantineExpiredSubmissionTransactions(client, input),
        );
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
