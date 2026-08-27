import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { SpotCanonicalAction } from "../../database/spot-intent-repository.js";
import {
  addExactUnsignedDecimals,
  compareExactUnsignedDecimals,
  exactUnsignedDecimalsEqual,
  multiplyExactUnsignedDecimals,
} from "./spot-exact-decimal.js";
import {
  parseSpotContract,
  type DeepReadonly,
} from "./spot-contract-support.js";
import {
  parseSpotReview,
  type SpotIntentRequest,
  type SpotReview,
} from "./spot-intent-contract.js";

const maximumPostgresBigint = 9_223_372_036_854_775_807n;
const maximumPostgresInteger = 2_147_483_647;
const zeroAddress = `0x${"0".repeat(40)}`;

export const SPOT_INTENT_PREPARE_POLICY_V1 = Object.freeze({
  defaultMaxSlippageBasisPoints: 25,
  maximumMaxSlippageBasisPoints: 100,
  maximumAuthorityLeaseMilliseconds: 15_000,
  maximumReviewLifetimeMilliseconds: 15_000,
  maximumReferenceAgeMilliseconds: 2_000,
  maximumFeeAgeMilliseconds: 15_000,
});

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalTimestampSchema = z
  .string()
  .max(24)
  .datetime({ offset: false, precision: 3 })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const positiveDecimalSchema = z
  .string()
  .max(128)
  .regex(/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/);
const nonnegativeDecimalSchema = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
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
    /^(?:[A-Z0-9][A-Z0-9._-]{0,30}\/[A-Z0-9][A-Z0-9._-]{0,30}|@(?:0|[1-9][0-9]{0,9}))$/,
  );
const metadataVersionSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const policyVersionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const opaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim())
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    }),
  );
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

const authoritySchema = z
  .object({
    ownerUserId: uuidSchema,
    privyUserId: opaqueProviderIdSchema,
    accountAddress: addressSchema,
    accountKind: z.literal("master"),
    bindingVersion: bindingVersionSchema,
    agentIdentityId: uuidSchema,
    verifiedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict()
  .refine(
    (authority) =>
      Date.parse(authority.verifiedAt) < Date.parse(authority.expiresAt),
  );

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

const reviewDraftSchema = z
  .object({
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
    computedBaseSize: positiveDecimalSchema,
    referencePrice: positiveDecimalSchema,
    worstIocLimitPrice: positiveDecimalSchema,
    maximumSpendOrMinimumReceive: positiveDecimalSchema,
    feeRate: nonnegativeDecimalSchema,
    feeEstimate: nonnegativeDecimalSchema,
    canonicalAction: canonicalActionSchema,
    publicReview: z.unknown(),
    reviewSha256: sha256Schema,
    factsObservedAt: canonicalTimestampSchema,
    referenceSourceTime: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict();

export type SpotIntentPrepareAuthority = DeepReadonly<
  z.output<typeof authoritySchema>
>;

export interface SpotIntentReviewDraft {
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
  readonly computedBaseSize: string;
  readonly referencePrice: string;
  readonly worstIocLimitPrice: string;
  readonly maximumSpendOrMinimumReceive: string;
  readonly feeRate: string;
  readonly feeEstimate: string;
  readonly canonicalAction: SpotCanonicalAction;
  readonly publicReview: SpotReview;
  readonly reviewSha256: string;
  readonly factsObservedAt: string;
  readonly referenceSourceTime: string;
  readonly expiresAt: string;
}

export interface SpotIntentPrepareAuthorityResolver {
  resolve(input: {
    readonly ownerUserId: string;
    readonly privyUserId: string;
    readonly network: "testnet";
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface SpotIntentReviewer {
  review(input: {
    readonly ownerUserId: string;
    readonly network: "testnet";
    readonly request: SpotIntentRequest;
    readonly requestSha256: string;
    readonly authority: SpotIntentPrepareAuthority;
    readonly clientOrderId: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export class SpotIntentPrepareAuthorityRequiredError extends Error {
  readonly code = "spot_intent_prepare_authority_required";

  constructor() {
    super("A current Spot wallet and Agent authority is required");
    this.name = "SpotIntentPrepareAuthorityRequiredError";
  }
}

export class SpotIntentPrepareAuthorityUnavailableError extends Error {
  readonly code = "spot_intent_prepare_authority_unavailable";

  constructor() {
    super("Spot preparation authority is unavailable");
    this.name = "SpotIntentPrepareAuthorityUnavailableError";
  }
}

export class SpotIntentReviewerUnavailableError extends Error {
  readonly code = "spot_intent_reviewer_unavailable";

  constructor() {
    super("The Spot intent reviewer is unavailable");
    this.name = "SpotIntentReviewerUnavailableError";
  }
}

export function createUnavailableSpotIntentPrepareAuthorityResolver(): SpotIntentPrepareAuthorityResolver {
  return Object.freeze({
    resolve: () =>
      Promise.reject(new SpotIntentPrepareAuthorityUnavailableError()),
  });
}

export function createUnavailableSpotIntentReviewer(): SpotIntentReviewer {
  return Object.freeze({
    review: () => Promise.reject(new SpotIntentReviewerUnavailableError()),
  });
}

export function createSpotClientOrderId(
  createRandomBytes: (size: number) => Uint8Array = randomBytes,
): string {
  let bytes: Uint8Array;
  try {
    bytes = createRandomBytes(16);
  } catch {
    throw new SpotIntentReviewerUnavailableError();
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    throw new SpotIntentReviewerUnavailableError();
  }
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function parseSpotIntentPrepareAuthority(
  value: unknown,
  expected: Readonly<{ ownerUserId: string; privyUserId: string }>,
  observedAtMilliseconds: number,
): SpotIntentPrepareAuthority {
  const authority = parseSpotContract(authoritySchema, value);
  const verifiedAt = Date.parse(authority.verifiedAt);
  const expiresAt = Date.parse(authority.expiresAt);
  if (
    authority.ownerUserId !== expected.ownerUserId ||
    authority.privyUserId !== expected.privyUserId ||
    !Number.isSafeInteger(observedAtMilliseconds) ||
    observedAtMilliseconds < 0 ||
    verifiedAt > observedAtMilliseconds ||
    expiresAt <= observedAtMilliseconds ||
    expiresAt - verifiedAt >
      SPOT_INTENT_PREPARE_POLICY_V1.maximumAuthorityLeaseMilliseconds
  ) {
    throw new SpotIntentPrepareAuthorityUnavailableError();
  }
  return authority;
}

export function sameSpotIntentPrepareAuthority(
  left: SpotIntentPrepareAuthority,
  right: SpotIntentPrepareAuthority,
): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    left.privyUserId === right.privyUserId &&
    left.accountAddress === right.accountAddress &&
    left.bindingVersion === right.bindingVersion &&
    left.agentIdentityId === right.agentIdentityId
  );
}

export function parseSpotIntentReviewDraft(
  value: unknown,
  expected: Readonly<{
    request: SpotIntentRequest;
    authority: SpotIntentPrepareAuthority;
    clientOrderId: string;
    observedAtMilliseconds: number;
  }>,
): SpotIntentReviewDraft {
  const draft = parseSpotContract(reviewDraftSchema, value);
  const review = parseSpotReview(draft.publicReview);
  const parsedOrder = draft.canonicalAction.orders[0];
  if (parsedOrder === undefined) {
    throw new SpotIntentReviewerUnavailableError();
  }
  const order = Object.freeze({
    ...parsedOrder,
    t: Object.freeze({
      limit: Object.freeze({ ...parsedOrder.t.limit }),
    }),
  });
  const canonicalAction: SpotCanonicalAction = Object.freeze({
    type: draft.canonicalAction.type,
    orders: Object.freeze([order] as const),
    grouping: draft.canonicalAction.grouping,
  });
  const factsObservedAt = Date.parse(draft.factsObservedAt);
  const referenceSourceTime = Date.parse(draft.referenceSourceTime);
  const feeObservedAt = Date.parse(review.fee_source.observed_at);
  const expiresAt = Date.parse(draft.expiresAt);
  const expectedBuy = expected.request.side === "buy";
  const priceDirection = compareExactUnsignedDecimals(
    draft.worstIocLimitPrice,
    draft.referencePrice,
  );
  const maximumSlippageBasisPoints =
    expected.request.max_slippage_bps ??
    SPOT_INTENT_PREPARE_POLICY_V1.defaultMaxSlippageBasisPoints;
  const scaledWorstPrice = multiplyExactUnsignedDecimals(
    draft.worstIocLimitPrice,
    "10000",
  );
  const scaledSlippageLimit = multiplyExactUnsignedDecimals(
    draft.referencePrice,
    String(
      expectedBuy
        ? 10_000 + maximumSlippageBasisPoints
        : 10_000 - maximumSlippageBasisPoints,
    ),
  );
  const actionNotional = multiplyExactUnsignedDecimals(order.p, order.s);
  const minimumFeeAtReviewedRate =
    actionNotional === null
      ? null
      : multiplyExactUnsignedDecimals(actionNotional, draft.feeRate);
  const maximumSpendWithFee =
    actionNotional === null
      ? null
      : addExactUnsignedDecimals([actionNotional, draft.feeEstimate]);
  const minimumReceiveWithFee = addExactUnsignedDecimals([
    draft.maximumSpendOrMinimumReceive,
    draft.feeEstimate,
  ]);
  const priceWithinSlippage =
    scaledWorstPrice !== null &&
    scaledSlippageLimit !== null &&
    (expectedBuy
      ? compareExactUnsignedDecimals(scaledWorstPrice, scaledSlippageLimit) <= 0
      : compareExactUnsignedDecimals(scaledWorstPrice, scaledSlippageLimit) >=
        0);
  const amountBoundIsValid =
    actionNotional !== null &&
    minimumFeeAtReviewedRate !== null &&
    compareExactUnsignedDecimals(draft.feeEstimate, minimumFeeAtReviewedRate) >=
      0 &&
    (expectedBuy
      ? exactUnsignedDecimalsEqual(
          draft.maximumSpendOrMinimumReceive,
          expected.request.amount.value,
        ) &&
        maximumSpendWithFee !== null &&
        compareExactUnsignedDecimals(
          maximumSpendWithFee,
          draft.maximumSpendOrMinimumReceive,
        ) <= 0
      : exactUnsignedDecimalsEqual(
          draft.computedBaseSize,
          expected.request.amount.value,
        ) &&
        minimumReceiveWithFee !== null &&
        compareExactUnsignedDecimals(actionNotional, minimumReceiveWithFee) >=
          0);

  if (
    !clientOrderIdSchema.safeParse(expected.clientOrderId).success ||
    !Number.isSafeInteger(expected.observedAtMilliseconds) ||
    expected.observedAtMilliseconds < 0 ||
    maximumSlippageBasisPoints >
      SPOT_INTENT_PREPARE_POLICY_V1.maximumMaxSlippageBasisPoints ||
    !priceWithinSlippage ||
    !amountBoundIsValid ||
    draft.baseTokenIndex === draft.quoteTokenIndex ||
    draft.baseTokenId === draft.quoteTokenId ||
    draft.exchangeOrderAsset !== 10_000 + draft.spotPairIndex ||
    review.review_digest !== draft.reviewSha256 ||
    review.market_id !== expected.request.market_id ||
    review.side !== expected.request.side ||
    review.amount_mode !== expected.request.amount.mode ||
    review.amount_value !== expected.request.amount.value ||
    review.computed_base_size !== draft.computedBaseSize ||
    review.reference_price !== draft.referencePrice ||
    review.reference_source_time !== draft.referenceSourceTime ||
    review.worst_ioc_limit_price !== draft.worstIocLimitPrice ||
    review.maximum_spend_or_minimum_receive.value !==
      draft.maximumSpendOrMinimumReceive ||
    review.fee_rate !== draft.feeRate ||
    review.fee_estimate !== draft.feeEstimate ||
    review.metadata_version !== draft.metadataVersion ||
    review.policy_version !== draft.policyVersion ||
    review.binding_epoch !== expected.authority.bindingVersion ||
    review.expires_at !== draft.expiresAt ||
    draft.referenceSourceTime !== review.reference_source_time ||
    referenceSourceTime > factsObservedAt ||
    feeObservedAt > factsObservedAt ||
    factsObservedAt - referenceSourceTime >
      SPOT_INTENT_PREPARE_POLICY_V1.maximumReferenceAgeMilliseconds ||
    factsObservedAt - feeObservedAt >
      SPOT_INTENT_PREPARE_POLICY_V1.maximumFeeAgeMilliseconds ||
    !canonicalTimestampSchema.safeParse(review.fee_source.observed_at)
      .success ||
    factsObservedAt > expected.observedAtMilliseconds ||
    factsObservedAt >= expiresAt ||
    expiresAt <= expected.observedAtMilliseconds ||
    expiresAt - factsObservedAt >
      SPOT_INTENT_PREPARE_POLICY_V1.maximumReviewLifetimeMilliseconds ||
    order.a !== draft.exchangeOrderAsset ||
    order.b !== expectedBuy ||
    order.p !== draft.worstIocLimitPrice ||
    order.s !== draft.computedBaseSize ||
    order.c !== expected.clientOrderId ||
    (expectedBuy ? priceDirection < 0 : priceDirection > 0)
  ) {
    throw new SpotIntentReviewerUnavailableError();
  }

  return Object.freeze({
    providerCoin: draft.providerCoin,
    baseTokenIndex: draft.baseTokenIndex,
    baseTokenId: draft.baseTokenId,
    quoteTokenIndex: draft.quoteTokenIndex,
    quoteTokenId: draft.quoteTokenId,
    spotPairIndex: draft.spotPairIndex,
    exchangeOrderAsset: draft.exchangeOrderAsset,
    metadataVersion: draft.metadataVersion,
    metadataSha256: draft.metadataSha256,
    policyVersion: draft.policyVersion,
    computedBaseSize: draft.computedBaseSize,
    referencePrice: draft.referencePrice,
    worstIocLimitPrice: draft.worstIocLimitPrice,
    maximumSpendOrMinimumReceive: draft.maximumSpendOrMinimumReceive,
    feeRate: draft.feeRate,
    feeEstimate: draft.feeEstimate,
    canonicalAction,
    publicReview: review,
    reviewSha256: draft.reviewSha256,
    factsObservedAt: draft.factsObservedAt,
    referenceSourceTime: draft.referenceSourceTime,
    expiresAt: draft.expiresAt,
  });
}
