import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  parseSpotContract,
  type DeepReadonly,
} from "./spot-contract-support.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalPositiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const canonicalNonnegativeDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const safeVersionPattern = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const safeAssetIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;
const safeReasonPattern = /^[a-z][a-z0-9_]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const uint64Pattern = /^(?:0|[1-9][0-9]{0,19})$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const maximumBindingVersion = 9_223_372_036_854_775_807n;
const requestDigestDomain = "loop.spot.intent.request.v1\0";
const reviewDigestDomain = "loop.spot.review.v1\0";

export const SPOT_INTENT_IDEMPOTENCY_SCOPE = "spot_intent_prepare";
export const SPOT_INTENT_REQUEST_DIGEST_VERSION = "spot_intent_request_v1";
export const SPOT_REVIEW_VERSION = "spot_review_v1";

const uuidSchema = z.string().regex(uuidPattern);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const positiveDecimalSchema = z
  .string()
  .max(128)
  .regex(canonicalPositiveDecimalPattern);
const nonnegativeDecimalSchema = z
  .string()
  .max(128)
  .regex(canonicalNonnegativeDecimalPattern);
const assetIdentitySchema = z.string().regex(safeAssetIdentityPattern);
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= maximumBindingVersion);
const uint64Schema = z
  .string()
  .regex(uint64Pattern)
  .refine((value) => BigInt(value) <= maximumUint64);

const amountSchema = z
  .object({
    mode: z.enum(["quote", "base"]),
    value: positiveDecimalSchema,
  })
  .strict();

const requestSchema = z
  .object({
    market_id: uuidSchema,
    side: z.enum(["buy", "sell"]),
    amount: amountSchema,
    max_slippage_bps: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine(
    (request) =>
      (request.side === "buy" && request.amount.mode === "quote") ||
      (request.side === "sell" && request.amount.mode === "base"),
  );

const settlementBoundSchema = z
  .object({
    kind: z.enum(["maximum_spend", "minimum_receive"]),
    asset_display_identity: assetIdentitySchema,
    value: positiveDecimalSchema,
  })
  .strict();

const feeSourceSchema = z
  .object({
    dataset: z.literal("user_fees"),
    observed_at: rfc3339Schema,
  })
  .strict();

const reviewBodySchema = z
  .object({
    version: z.literal(SPOT_REVIEW_VERSION),
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    market_id: uuidSchema,
    base_display_identity: assetIdentitySchema,
    quote_display_identity: assetIdentitySchema,
    side: z.enum(["buy", "sell"]),
    amount_mode: z.enum(["quote", "base"]),
    amount_value: positiveDecimalSchema,
    computed_base_size: positiveDecimalSchema,
    reference_price: positiveDecimalSchema,
    reference_source_time: rfc3339Schema,
    worst_ioc_limit_price: positiveDecimalSchema,
    maximum_spend_or_minimum_receive: settlementBoundSchema,
    fee_rate: nonnegativeDecimalSchema,
    fee_estimate: nonnegativeDecimalSchema,
    fee_source: feeSourceSchema,
    metadata_version: z.string().regex(safeVersionPattern),
    policy_version: z.string().regex(safeVersionPattern),
    binding_epoch: bindingVersionSchema,
    expires_at: rfc3339Schema,
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.base_display_identity === review.quote_display_identity ||
      !(
        (review.side === "buy" && review.amount_mode === "quote") ||
        (review.side === "sell" && review.amount_mode === "base")
      )
    ) {
      context.addIssue({ code: "custom" });
    }
    const expectedBound =
      review.side === "buy" ? "maximum_spend" : "minimum_receive";
    if (
      review.maximum_spend_or_minimum_receive.kind !== expectedBound ||
      review.maximum_spend_or_minimum_receive.asset_display_identity !==
        review.quote_display_identity
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximum_spend_or_minimum_receive"],
      });
    }
    const referenceTime = Date.parse(review.reference_source_time);
    if (
      referenceTime >= Date.parse(review.expires_at) ||
      Date.parse(review.fee_source.observed_at) >= Date.parse(review.expires_at)
    ) {
      context.addIssue({ code: "custom", path: ["expires_at"] });
    }
  });

const reviewSchema = reviewBodySchema
  .safeExtend({ review_digest: z.string().regex(sha256Pattern) })
  .refine((review) => {
    const { review_digest: digest, ...body } = review;
    return digest === digestReviewBody(body);
  });

const filledResultProperties = {
  order_id: uint64Schema.nullable(),
  filled_base_size: positiveDecimalSchema,
  average_fill_price: positiveDecimalSchema,
  quote_amount: positiveDecimalSchema,
  fee: nonnegativeDecimalSchema,
  fee_asset_display_identity: assetIdentitySchema,
  observed_at: rfc3339Schema,
  reason_code: z.string().regex(safeReasonPattern).nullable(),
} as const;

const nonFillResultProperties = {
  order_id: uint64Schema.nullable(),
  filled_base_size: z.null(),
  average_fill_price: z.null(),
  quote_amount: z.null(),
  fee: z.null(),
  fee_asset_display_identity: z.null(),
  observed_at: rfc3339Schema,
  reason_code: z.string().regex(safeReasonPattern).nullable(),
} as const;

const resultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("filled"), ...filledResultProperties }).strict(),
  z
    .object({
      state: z.literal("partially_filled"),
      ...filledResultProperties,
    })
    .strict(),
  z
    .object({ state: z.literal("accepted"), ...nonFillResultProperties })
    .strict(),
  z
    .object({ state: z.literal("not_filled"), ...nonFillResultProperties })
    .strict(),
  z
    .object({ state: z.literal("rejected"), ...nonFillResultProperties })
    .strict(),
  z
    .object({ state: z.literal("unknown"), ...nonFillResultProperties })
    .strict(),
  z
    .object({
      state: z.literal("operator_required"),
      ...nonFillResultProperties,
    })
    .strict(),
]);

const resourceSchema = z
  .object({
    intent_id: uuidSchema,
    state: z.enum([
      "prepared",
      "submitting",
      "accepted",
      "filled",
      "partially_filled",
      "not_filled",
      "rejected",
      "unknown",
      "reconciling",
      "operator_required",
      "expired",
    ]),
    review: reviewSchema,
    submission: z
      .object({ state: z.enum(["not_started", "ready", "attempted"]) })
      .strict(),
    result: resultSchema.nullable(),
    expires_at: rfc3339Schema,
    created_at: rfc3339Schema,
    updated_at: rfc3339Schema,
  })
  .strict()
  .superRefine((resource, context) => {
    const createdAt = Date.parse(resource.created_at);
    const updatedAt = Date.parse(resource.updated_at);
    const expiresAt = Date.parse(resource.expires_at);
    if (
      resource.expires_at !== resource.review.expires_at ||
      createdAt > updatedAt ||
      createdAt >= expiresAt ||
      Date.parse(resource.review.reference_source_time) > createdAt ||
      Date.parse(resource.review.fee_source.observed_at) > createdAt
    ) {
      context.addIssue({ code: "custom" });
    }
    if (resource.state === "prepared" || resource.state === "expired") {
      if (resource.result !== null) {
        context.addIssue({ code: "custom", path: ["result"] });
      }
      if (resource.submission.state === "attempted") {
        context.addIssue({ code: "custom", path: ["submission"] });
      }
      return;
    }

    if (resource.submission.state !== "attempted") {
      context.addIssue({ code: "custom", path: ["submission"] });
    }
    if (resource.state === "submitting") {
      if (resource.result !== null) {
        context.addIssue({ code: "custom", path: ["result"] });
      }
      return;
    }
    if (resource.result === null) {
      context.addIssue({ code: "custom", path: ["result"] });
      return;
    }
    const resultObservedAt = Date.parse(resource.result.observed_at);
    if (resultObservedAt < createdAt || resultObservedAt > updatedAt) {
      context.addIssue({ code: "custom", path: ["result", "observed_at"] });
    }
    if (resource.state === "reconciling") {
      if (
        resource.result.state !== "accepted" &&
        resource.result.state !== "unknown"
      ) {
        context.addIssue({ code: "custom", path: ["result", "state"] });
      }
      return;
    }
    if (resource.result.state !== resource.state) {
      context.addIssue({ code: "custom", path: ["result", "state"] });
    }
  });

export type SpotIntentRequest = DeepReadonly<z.output<typeof requestSchema>>;
export type SpotReviewBody = DeepReadonly<z.output<typeof reviewBodySchema>>;
export type SpotReview = DeepReadonly<z.output<typeof reviewSchema>>;
export type SpotIntentResult = DeepReadonly<z.output<typeof resultSchema>>;
export type SpotIntentResource = DeepReadonly<z.output<typeof resourceSchema>>;

export class InvalidSpotIntentIdempotencyKeyError extends Error {
  readonly code = "invalid_spot_intent_idempotency_key";

  constructor() {
    super("The Spot intent idempotency key is invalid");
    this.name = "InvalidSpotIntentIdempotencyKeyError";
  }
}

function digestReviewBody(value: z.output<typeof reviewBodySchema>): string {
  return createHash("sha256")
    .update(reviewDigestDomain, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function parseSpotIntentId(value: unknown): string {
  return parseSpotContract(uuidSchema, value);
}

export function parseSpotIntentRequest(value: unknown): SpotIntentRequest {
  return parseSpotContract(requestSchema, value);
}

export function canonicalizeSpotIntentRequest(value: unknown): string {
  return canonicalJson(parseSpotIntentRequest(value));
}

export function digestSpotIntentRequest(value: unknown): string {
  return createHash("sha256")
    .update(requestDigestDomain, "utf8")
    .update(canonicalizeSpotIntentRequest(value), "utf8")
    .digest("hex");
}

export function parseSpotReviewBody(value: unknown): SpotReviewBody {
  return parseSpotContract(reviewBodySchema, value);
}

export function digestSpotReview(value: unknown): string {
  return digestReviewBody(parseSpotReviewBody(value));
}

export function createSpotReview(value: unknown): SpotReview {
  const body = parseSpotReviewBody(value);
  return parseSpotContract(reviewSchema, {
    ...body,
    review_digest: digestReviewBody(body),
  });
}

export function parseSpotReview(value: unknown): SpotReview {
  return parseSpotContract(reviewSchema, value);
}

export function parseSpotIntentResult(value: unknown): SpotIntentResult {
  return parseSpotContract(resultSchema, value);
}

export function parseSpotIntentResource(value: unknown): SpotIntentResource {
  return parseSpotContract(resourceSchema, value);
}

export function parseSpotIntentIdempotencyKey(
  rawHeaders: readonly string[],
): string {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length !== 1 || !uuidPattern.test(values[0] ?? "")) {
    throw new InvalidSpotIntentIdempotencyKeyError();
  }
  return values[0] as string;
}
