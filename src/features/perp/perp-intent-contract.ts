import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

const coreCoins = ["BTC", "ETH", "SOL"] as const;
const actionKinds = [
  "order",
  "cancel",
  "modify",
  "batch_modify",
  "update_leverage",
  "update_isolated_margin",
] as const;
const resourceStates = [
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
] as const;
const resultItemStates = [
  "accepted",
  "partial",
  "filled",
  "cancelled",
  "rejected",
  "unknown",
] as const;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const isolatedMarginDeltaPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;
const safeReasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const maximumDecimalLength = 128;
const maximumUnsigned64 = 18_446_744_073_709_551_615n;
const clientOrderIdBytes = 16;
const requestDigestDomain = "loop.perp.intent.request.v1\0";

export const PERP_INTENT_IDEMPOTENCY_SCOPE = "perp_intent_prepare";
export const PERP_INTENT_REQUEST_DIGEST_VERSION = "perp_intent_request_v1";
export const PERP_INTENT_BATCH_MAX_ITEMS = 39;
export const PERP_INTENT_REVIEW_MAX_AGE_MS = 60_000;
export const PERP_MARKET_ORDER_REVIEW_MAX_AGE_MS = 2_000;

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export class InvalidPerpIntentContractError extends Error {
  readonly code = "invalid_perp_intent_contract";

  constructor() {
    super("The Perp intent contract value is invalid");
    this.name = "InvalidPerpIntentContractError";
  }
}

export class InvalidPerpIntentIdempotencyKeyError extends Error {
  readonly code = "invalid_perp_intent_idempotency_key";

  constructor() {
    super("The Perp intent idempotency key is invalid");
    this.name = "InvalidPerpIntentIdempotencyKeyError";
  }
}

const positiveDecimalStringSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(positiveDecimalPattern);
const positiveIntegerStringSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(positiveIntegerPattern);
const uint64StringSchema = z
  .string()
  .max(20)
  .regex(unsignedIntegerPattern)
  .refine((value) => {
    try {
      return BigInt(value) <= maximumUnsigned64;
    } catch {
      return false;
    }
  });
const clientOrderIdSchema = z.string().regex(clientOrderIdPattern);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const coreCoinSchema = z.enum(coreCoins);
const actionKindSchema = z.enum(actionKinds);
const sideSchema = z.enum(["buy", "sell"]);
const timeInForceSchema = z.enum(["gtc", "alo", "ioc"]);
const maxSlippagePercentSchema = positiveDecimalStringSchema.refine((value) => {
  const [integer = "", fraction = ""] = value.split(".");
  if (integer === "0") {
    return true;
  }
  return integer === "1" && !/[1-9]/.test(fraction);
});
const isolatedMarginDeltaSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(isolatedMarginDeltaPattern)
  .refine((value) => /[1-9]/.test(value));

const orderIdTargetSchema = z
  .object({
    kind: z.literal("order_id"),
    order_id: uint64StringSchema,
  })
  .strict();
const clientOrderIdTargetSchema = z
  .object({
    kind: z.literal("client_order_id"),
    client_order_id: clientOrderIdSchema,
  })
  .strict();
const orderTargetSchema = z.discriminatedUnion("kind", [
  orderIdTargetSchema,
  clientOrderIdTargetSchema,
]);

function targetIdentity(target: z.infer<typeof orderTargetSchema>): string {
  return target.kind === "order_id"
    ? `order_id:${target.order_id}`
    : `client_order_id:${target.client_order_id}`;
}

function hasUniqueTargets(
  modifications: readonly {
    readonly target: z.infer<typeof orderTargetSchema>;
  }[],
): boolean {
  const targets = new Set<string>();
  for (const modification of modifications) {
    const identity = targetIdentity(modification.target);
    if (targets.has(identity)) {
      return false;
    }
    targets.add(identity);
  }
  return true;
}

const limitOrderRequestSchema = z
  .object({
    action: z.literal("order"),
    coin: coreCoinSchema,
    side: sideSchema,
    order_type: z.literal("limit"),
    size: positiveDecimalStringSchema,
    limit_price: positiveDecimalStringSchema,
    time_in_force: timeInForceSchema,
    reduce_only: z.boolean(),
  })
  .strict();
const marketOrderRequestSchema = z
  .object({
    action: z.literal("order"),
    coin: coreCoinSchema,
    side: sideSchema,
    order_type: z.literal("market"),
    size: positiveDecimalStringSchema,
    max_slippage_percent: maxSlippagePercentSchema,
    reduce_only: z.boolean(),
  })
  .strict();
const cancelRequestSchema = z
  .object({
    action: z.literal("cancel"),
    coin: coreCoinSchema,
    target: orderTargetSchema,
  })
  .strict();
const modifyRequestSchema = z
  .object({
    action: z.literal("modify"),
    coin: coreCoinSchema,
    target: orderTargetSchema,
    side: sideSchema,
    size: positiveDecimalStringSchema,
    limit_price: positiveDecimalStringSchema,
    time_in_force: timeInForceSchema,
    reduce_only: z.boolean(),
  })
  .strict();
const batchModificationRequestSchema = z
  .object({
    coin: coreCoinSchema,
    target: orderTargetSchema,
    side: sideSchema,
    size: positiveDecimalStringSchema,
    limit_price: positiveDecimalStringSchema,
    time_in_force: timeInForceSchema,
    reduce_only: z.boolean(),
  })
  .strict();
const batchModifyRequestSchema = z
  .object({
    action: z.literal("batch_modify"),
    modifications: z
      .array(batchModificationRequestSchema)
      .min(1)
      .max(PERP_INTENT_BATCH_MAX_ITEMS)
      .refine(hasUniqueTargets),
  })
  .strict();
const updateLeverageRequestSchema = z
  .object({
    action: z.literal("update_leverage"),
    coin: coreCoinSchema,
    margin_mode: z.enum(["cross", "isolated"]),
    leverage: positiveIntegerStringSchema,
  })
  .strict();
const updateIsolatedMarginRequestSchema = z
  .object({
    action: z.literal("update_isolated_margin"),
    coin: coreCoinSchema,
    margin_delta_usdc: isolatedMarginDeltaSchema,
  })
  .strict();

const requestSchema = z.union([
  limitOrderRequestSchema,
  marketOrderRequestSchema,
  cancelRequestSchema,
  modifyRequestSchema,
  batchModifyRequestSchema,
  updateLeverageRequestSchema,
  updateIsolatedMarginRequestSchema,
]);

const limitOrderReviewActionSchema = limitOrderRequestSchema.extend({
  client_order_id: clientOrderIdSchema,
});
const marketOrderReviewActionSchema = marketOrderRequestSchema.extend({
  final_limit_price: positiveDecimalStringSchema,
  client_order_id: clientOrderIdSchema,
});
const modifyReviewActionSchema = modifyRequestSchema.extend({
  replacement_client_order_id: clientOrderIdSchema,
});
const batchModificationReviewSchema = batchModificationRequestSchema.extend({
  replacement_client_order_id: clientOrderIdSchema,
});
const batchModifyReviewActionSchema = z
  .object({
    action: z.literal("batch_modify"),
    modifications: z
      .array(batchModificationReviewSchema)
      .min(1)
      .max(PERP_INTENT_BATCH_MAX_ITEMS)
      .refine(
        (modifications) =>
          hasUniqueTargets(modifications) &&
          new Set(
            modifications.map(
              (modification) => modification.replacement_client_order_id,
            ),
          ).size === modifications.length,
      ),
  })
  .strict();
const publicReviewActionSchema = z.union([
  limitOrderReviewActionSchema,
  marketOrderReviewActionSchema,
  cancelRequestSchema,
  modifyReviewActionSchema,
  batchModifyReviewActionSchema,
  updateLeverageRequestSchema,
  updateIsolatedMarginRequestSchema,
]);
const publicReviewSchema = z
  .object({
    version: z.literal("perp_review_v1"),
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    market: z.literal("core_perps"),
    dex: z.literal(""),
    action: publicReviewActionSchema,
    source: z
      .object({
        fetched_at: rfc3339Schema,
        expires_at: rfc3339Schema,
      })
      .strict(),
  })
  .strict()
  .refine(
    (review) =>
      Date.parse(review.source.fetched_at) <
      Date.parse(review.source.expires_at),
  );

const resultItemSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(PERP_INTENT_BATCH_MAX_ITEMS - 1),
    state: z.enum(resultItemStates),
    order_id: uint64StringSchema.nullable(),
    client_order_id: clientOrderIdSchema.nullable(),
    filled_size: positiveDecimalStringSchema.nullable(),
    average_fill_price: positiveDecimalStringSchema.nullable(),
    reason_code: z.string().regex(safeReasonCodePattern).nullable(),
  })
  .strict();
const resultSchema = z
  .object({
    observed_at: rfc3339Schema.nullable(),
    items: z.array(resultItemSchema).min(1).max(PERP_INTENT_BATCH_MAX_ITEMS),
  })
  .strict()
  .refine((result) => {
    const indexes = new Set<number>();
    for (const item of result.items) {
      if (indexes.has(item.index)) {
        return false;
      }
      indexes.add(item.index);
    }
    return true;
  });

const resourceSchema = z
  .object({
    intent_id: z.string().regex(uuidPattern),
    action: actionKindSchema,
    state: z.enum(resourceStates),
    review: publicReviewSchema,
    expires_at: rfc3339Schema,
    submission: z
      .object({
        state: z.enum(["disabled", "requires_revalidation"]),
      })
      .strict(),
    result: resultSchema.nullable(),
    created_at: rfc3339Schema,
    updated_at: rfc3339Schema,
  })
  .strict()
  .refine((resource) => resource.action === resource.review.action.action)
  .refine(
    (resource) => resource.expires_at === resource.review.source.expires_at,
  )
  .refine((resource) => {
    if (resource.result === null) {
      return true;
    }

    const expectedItemCount =
      resource.review.action.action === "batch_modify"
        ? resource.review.action.modifications.length
        : 1;
    return (
      resource.result.items.length === expectedItemCount &&
      resource.result.items.every((item, index) => item.index === index)
    );
  });

type ParsedPerpIntentRequest = z.infer<typeof requestSchema>;
type ParsedPerpPublicReview = z.infer<typeof publicReviewSchema>;
type ParsedPerpIntentResult = z.infer<typeof resultSchema>;
type ParsedPerpIntentResource = z.infer<typeof resourceSchema>;

export type PerpIntentActionKind = (typeof actionKinds)[number];
export type PerpIntentRequest = DeepReadonly<ParsedPerpIntentRequest>;
export type PerpOrderTarget = DeepReadonly<z.infer<typeof orderTargetSchema>>;
export type PerpPublicReview = DeepReadonly<ParsedPerpPublicReview>;
export type PerpPublicReviewAction = DeepReadonly<
  z.infer<typeof publicReviewActionSchema>
>;
export type PerpIntentResult = DeepReadonly<ParsedPerpIntentResult>;
export type PerpIntentResource = DeepReadonly<ParsedPerpIntentResource>;
export type PerpIntentResourceState = (typeof resourceStates)[number];
export type PerpIntentResultItemState = (typeof resultItemStates)[number];

function invalidContract(): never {
  throw new InvalidPerpIntentContractError();
}

function assertJsonDataTree(value: unknown, ancestors: WeakSet<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return invalidContract();
    }
    return;
  }
  if (typeof value !== "object") {
    return invalidContract();
  }

  if (ancestors.has(value)) {
    return invalidContract();
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return invalidContract();
      }

      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
        return invalidContract();
      }

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return invalidContract();
        }
        assertJsonDataTree(descriptor.value, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidContract();
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return invalidContract();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return invalidContract();
      }
      assertJsonDataTree(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

function parseStrict<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): DeepReadonly<z.output<Schema>> {
  try {
    assertJsonDataTree(value, new WeakSet());
    return deepFreeze(schema.parse(value));
  } catch (error) {
    if (error instanceof InvalidPerpIntentContractError) {
      throw error;
    }
    throw new InvalidPerpIntentContractError();
  }
}

export function parsePerpIntentRequest(value: unknown): PerpIntentRequest {
  return parseStrict(requestSchema, value);
}

export function parsePerpPublicReview(value: unknown): PerpPublicReview {
  return parseStrict(publicReviewSchema, value);
}

export function parsePerpIntentResult(value: unknown): PerpIntentResult {
  return parseStrict(resultSchema, value);
}

export function parsePerpIntentResource(value: unknown): PerpIntentResource {
  return parseStrict(resourceSchema, value);
}

function requestFromReviewAction(
  reviewAction: PerpPublicReviewAction,
): PerpIntentRequest {
  switch (reviewAction.action) {
    case "order":
      return reviewAction.order_type === "limit"
        ? parsePerpIntentRequest({
            action: reviewAction.action,
            coin: reviewAction.coin,
            side: reviewAction.side,
            order_type: reviewAction.order_type,
            size: reviewAction.size,
            limit_price: reviewAction.limit_price,
            time_in_force: reviewAction.time_in_force,
            reduce_only: reviewAction.reduce_only,
          })
        : parsePerpIntentRequest({
            action: reviewAction.action,
            coin: reviewAction.coin,
            side: reviewAction.side,
            order_type: reviewAction.order_type,
            size: reviewAction.size,
            max_slippage_percent: reviewAction.max_slippage_percent,
            reduce_only: reviewAction.reduce_only,
          });
    case "cancel":
      return parsePerpIntentRequest({
        action: reviewAction.action,
        coin: reviewAction.coin,
        target: reviewAction.target,
      });
    case "modify":
      return parsePerpIntentRequest({
        action: reviewAction.action,
        coin: reviewAction.coin,
        target: reviewAction.target,
        side: reviewAction.side,
        size: reviewAction.size,
        limit_price: reviewAction.limit_price,
        time_in_force: reviewAction.time_in_force,
        reduce_only: reviewAction.reduce_only,
      });
    case "batch_modify":
      return parsePerpIntentRequest({
        action: reviewAction.action,
        modifications: reviewAction.modifications.map((modification) => ({
          coin: modification.coin,
          target: modification.target,
          side: modification.side,
          size: modification.size,
          limit_price: modification.limit_price,
          time_in_force: modification.time_in_force,
          reduce_only: modification.reduce_only,
        })),
      });
    case "update_leverage":
      return parsePerpIntentRequest({
        action: reviewAction.action,
        coin: reviewAction.coin,
        margin_mode: reviewAction.margin_mode,
        leverage: reviewAction.leverage,
      });
    case "update_isolated_margin":
      return parsePerpIntentRequest({
        action: reviewAction.action,
        coin: reviewAction.coin,
        margin_delta_usdc: reviewAction.margin_delta_usdc,
      });
  }
}

/**
 * Parses a public review and proves that it contains the exact client business
 * intent. The only review-only fields are server-generated client-order IDs
 * and the provider-derived final limit price for a market intent.
 */
export function parsePerpPublicReviewForRequest(
  requestValue: unknown,
  reviewValue: unknown,
): PerpPublicReview {
  const request = parsePerpIntentRequest(requestValue);
  const review = parsePerpPublicReview(reviewValue);
  const reviewedRequest = requestFromReviewAction(review.action);

  if (
    canonicalizePerpIntentRequest(request) !==
    canonicalizePerpIntentRequest(reviewedRequest)
  ) {
    return invalidContract();
  }
  return review;
}

function canonicalTarget(target: PerpOrderTarget): Record<string, string> {
  return target.kind === "order_id"
    ? { kind: target.kind, order_id: target.order_id }
    : { kind: target.kind, client_order_id: target.client_order_id };
}

function canonicalModification(
  modification: Extract<
    ParsedPerpIntentRequest,
    { action: "batch_modify" }
  >["modifications"][number],
): Record<string, unknown> {
  return {
    coin: modification.coin,
    target: canonicalTarget(modification.target),
    side: modification.side,
    size: modification.size,
    limit_price: modification.limit_price,
    time_in_force: modification.time_in_force,
    reduce_only: modification.reduce_only,
  };
}

export function canonicalizePerpIntentRequest(
  value: PerpIntentRequest,
): string {
  const request = parsePerpIntentRequest(value);

  switch (request.action) {
    case "order":
      return request.order_type === "limit"
        ? JSON.stringify({
            action: request.action,
            coin: request.coin,
            side: request.side,
            order_type: request.order_type,
            size: request.size,
            limit_price: request.limit_price,
            time_in_force: request.time_in_force,
            reduce_only: request.reduce_only,
          })
        : JSON.stringify({
            action: request.action,
            coin: request.coin,
            side: request.side,
            order_type: request.order_type,
            size: request.size,
            max_slippage_percent: request.max_slippage_percent,
            reduce_only: request.reduce_only,
          });
    case "cancel":
      return JSON.stringify({
        action: request.action,
        coin: request.coin,
        target: canonicalTarget(request.target),
      });
    case "modify":
      return JSON.stringify({
        action: request.action,
        coin: request.coin,
        target: canonicalTarget(request.target),
        side: request.side,
        size: request.size,
        limit_price: request.limit_price,
        time_in_force: request.time_in_force,
        reduce_only: request.reduce_only,
      });
    case "batch_modify":
      return JSON.stringify({
        action: request.action,
        modifications: request.modifications.map(canonicalModification),
      });
    case "update_leverage":
      return JSON.stringify({
        action: request.action,
        coin: request.coin,
        margin_mode: request.margin_mode,
        leverage: request.leverage,
      });
    case "update_isolated_margin":
      return JSON.stringify({
        action: request.action,
        coin: request.coin,
        margin_delta_usdc: request.margin_delta_usdc,
      });
  }
}

export function digestPerpIntentRequest(value: PerpIntentRequest): string {
  return createHash("sha256")
    .update(requestDigestDomain, "utf8")
    .update(canonicalizePerpIntentRequest(value), "utf8")
    .digest("hex");
}

export function parsePerpIntentIdempotencyKey(
  rawHeaders: readonly string[],
): string {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    throw new InvalidPerpIntentIdempotencyKeyError();
  }

  const headers: readonly unknown[] = rawHeaders;
  const values: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index];
    const value = headers[index + 1];
    if (typeof name !== "string" || typeof value !== "string") {
      throw new InvalidPerpIntentIdempotencyKeyError();
    }
    if (name.toLowerCase() === "idempotency-key") {
      values.push(value);
    }
  }

  const value = values[0];
  if (values.length !== 1 || value === undefined || !uuidPattern.test(value)) {
    throw new InvalidPerpIntentIdempotencyKeyError();
  }
  return value;
}

export type PerpClientOrderIdRandomBytes = (size: number) => Uint8Array;

export function createPerpClientOrderId(
  createRandomBytes: PerpClientOrderIdRandomBytes = randomBytes,
): string {
  const bytes = createRandomBytes(clientOrderIdBytes);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== clientOrderIdBytes
  ) {
    throw new TypeError("Perp client order ID entropy is invalid");
  }
  return `0x${Buffer.from(bytes).toString("hex")}`;
}
