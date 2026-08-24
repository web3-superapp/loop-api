import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../core/http/request-input.js";
import {
  parsePerpIntentIdempotencyKey,
  parsePerpIntentRequest,
} from "../features/perp/perp-intent-contract.js";
import {
  PerpIntentClaimRateLimitedError,
  InvalidPerpIntentRequestError,
  PerpIntentExpiredError,
  PerpIntentIdempotencyConflictError,
  PerpIntentNotFoundError,
  PerpIntentStaleError,
  PerpIntentUnavailableError,
  PerpIntentWalletBindingRequiredError,
  PerpMutationDisabledError,
  type PerpIntentService,
} from "../features/perp/perp-intent-service.js";

const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const positiveDecimalPattern =
  "^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$";
const positiveIntegerPattern = "^[1-9][0-9]*$";
const clientOrderIdPattern = "^0x[0-9a-f]{32}$";
const isolatedMarginDeltaPattern =
  "^(?:(?:[1-9][0-9]*(?:\\.[0-9]{1,6})?|0\\.(?=[0-9]{0,5}[1-9])[0-9]{1,6})|-(?:[1-9][0-9]*(?:\\.[0-9]{1,6})?|0\\.(?=[0-9]{0,5}[1-9])[0-9]{1,6}))$";
const maxSlippagePercentPattern = "^(?:1(?:\\.0+)?|0\\.(?=[0-9]*[1-9])[0-9]+)$";

function boundedUnsignedIntegerPattern(maximum: string): string {
  const branches = ["0", `[1-9][0-9]{0,${maximum.length - 2}}`];

  for (let index = 0; index < maximum.length; index += 1) {
    const digit = Number.parseInt(maximum[index] ?? "", 10);
    const minimumDigit = index === 0 ? 1 : 0;
    const maximumLowerDigit = digit - 1;
    if (maximumLowerDigit < minimumDigit) {
      continue;
    }

    const prefix = maximum.slice(0, index);
    const range =
      minimumDigit === maximumLowerDigit
        ? String(minimumDigit)
        : `[${minimumDigit}-${maximumLowerDigit}]`;
    const remaining = maximum.length - index - 1;
    branches.push(
      `${prefix}${range}${remaining === 0 ? "" : `[0-9]{${remaining}}`}`,
    );
  }

  branches.push(maximum);
  return `^(?:${branches.join("|")})$`;
}

const uint64Pattern = boundedUnsignedIntegerPattern("18446744073709551615");

const coreCoinSchema = {
  type: "string",
  enum: ["BTC", "ETH", "SOL"],
} as const;
const sideSchema = { type: "string", enum: ["buy", "sell"] } as const;
const timeInForceSchema = {
  type: "string",
  enum: ["gtc", "alo", "ioc"],
} as const;
const positiveDecimalSchema = {
  type: "string",
  maxLength: 128,
  pattern: positiveDecimalPattern,
} as const;
const positiveIntegerSchema = {
  type: "string",
  maxLength: 128,
  pattern: positiveIntegerPattern,
} as const;
const maxSlippagePercentSchema = {
  type: "string",
  maxLength: 128,
  pattern: maxSlippagePercentPattern,
} as const;
const uint64Schema = {
  type: "string",
  maxLength: 20,
  pattern: uint64Pattern,
} as const;
const clientOrderIdSchema = {
  type: "string",
  pattern: clientOrderIdPattern,
} as const;
const orderTargetSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "order_id"],
      properties: {
        kind: { type: "string", const: "order_id" },
        order_id: uint64Schema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "client_order_id"],
      properties: {
        kind: { type: "string", const: "client_order_id" },
        client_order_id: clientOrderIdSchema,
      },
    },
  ],
} as const;

const limitOrderProperties = {
  action: { type: "string", const: "order" },
  coin: coreCoinSchema,
  side: sideSchema,
  order_type: { type: "string", const: "limit" },
  size: positiveDecimalSchema,
  limit_price: positiveDecimalSchema,
  time_in_force: timeInForceSchema,
  reduce_only: { type: "boolean" },
} as const;
const marketOrderProperties = {
  action: { type: "string", const: "order" },
  coin: coreCoinSchema,
  side: sideSchema,
  order_type: { type: "string", const: "market" },
  size: positiveDecimalSchema,
  max_slippage_percent: maxSlippagePercentSchema,
  reduce_only: { type: "boolean" },
} as const;
const cancelProperties = {
  action: { type: "string", const: "cancel" },
  coin: coreCoinSchema,
  target: orderTargetSchema,
} as const;
const modificationProperties = {
  coin: coreCoinSchema,
  target: orderTargetSchema,
  side: sideSchema,
  size: positiveDecimalSchema,
  limit_price: positiveDecimalSchema,
  time_in_force: timeInForceSchema,
  reduce_only: { type: "boolean" },
} as const;
const modifyProperties = {
  action: { type: "string", const: "modify" },
  ...modificationProperties,
} as const;
const batchModificationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "coin",
    "target",
    "side",
    "size",
    "limit_price",
    "time_in_force",
    "reduce_only",
  ],
  properties: modificationProperties,
} as const;
const batchModifyProperties = {
  action: { type: "string", const: "batch_modify" },
  modifications: {
    type: "array",
    minItems: 1,
    maxItems: 39,
    items: batchModificationSchema,
  },
} as const;
const updateLeverageProperties = {
  action: { type: "string", const: "update_leverage" },
  coin: coreCoinSchema,
  margin_mode: { type: "string", enum: ["cross", "isolated"] },
  leverage: positiveIntegerSchema,
} as const;
const updateIsolatedMarginProperties = {
  action: { type: "string", const: "update_isolated_margin" },
  coin: coreCoinSchema,
  margin_delta_usdc: {
    type: "string",
    maxLength: 128,
    pattern: isolatedMarginDeltaPattern,
  },
} as const;

function objectSchema(
  properties: Readonly<Record<string, object>>,
  required: readonly string[],
) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  } as const;
}

const intentRequestSchema = {
  oneOf: [
    objectSchema(limitOrderProperties, [
      "action",
      "coin",
      "side",
      "order_type",
      "size",
      "limit_price",
      "time_in_force",
      "reduce_only",
    ]),
    objectSchema(marketOrderProperties, [
      "action",
      "coin",
      "side",
      "order_type",
      "size",
      "max_slippage_percent",
      "reduce_only",
    ]),
    objectSchema(cancelProperties, ["action", "coin", "target"]),
    objectSchema(modifyProperties, [
      "action",
      "coin",
      "target",
      "side",
      "size",
      "limit_price",
      "time_in_force",
      "reduce_only",
    ]),
    objectSchema(batchModifyProperties, ["action", "modifications"]),
    objectSchema(updateLeverageProperties, [
      "action",
      "coin",
      "margin_mode",
      "leverage",
    ]),
    objectSchema(updateIsolatedMarginProperties, [
      "action",
      "coin",
      "margin_delta_usdc",
    ]),
  ],
} as const;

const reviewActionSchema = {
  oneOf: [
    objectSchema(
      { ...limitOrderProperties, client_order_id: clientOrderIdSchema },
      [
        "action",
        "coin",
        "side",
        "order_type",
        "size",
        "limit_price",
        "time_in_force",
        "reduce_only",
        "client_order_id",
      ],
    ),
    objectSchema(
      {
        ...marketOrderProperties,
        final_limit_price: positiveDecimalSchema,
        client_order_id: clientOrderIdSchema,
      },
      [
        "action",
        "coin",
        "side",
        "order_type",
        "size",
        "max_slippage_percent",
        "reduce_only",
        "final_limit_price",
        "client_order_id",
      ],
    ),
    objectSchema(cancelProperties, ["action", "coin", "target"]),
    objectSchema(
      {
        ...modifyProperties,
        replacement_client_order_id: clientOrderIdSchema,
      },
      [
        "action",
        "coin",
        "target",
        "side",
        "size",
        "limit_price",
        "time_in_force",
        "reduce_only",
        "replacement_client_order_id",
      ],
    ),
    objectSchema(
      {
        action: { type: "string", const: "batch_modify" },
        modifications: {
          type: "array",
          minItems: 1,
          maxItems: 39,
          items: objectSchema(
            {
              ...modificationProperties,
              replacement_client_order_id: clientOrderIdSchema,
            },
            [
              "coin",
              "target",
              "side",
              "size",
              "limit_price",
              "time_in_force",
              "reduce_only",
              "replacement_client_order_id",
            ],
          ),
        },
      },
      ["action", "modifications"],
    ),
    objectSchema(updateLeverageProperties, [
      "action",
      "coin",
      "margin_mode",
      "leverage",
    ]),
    objectSchema(updateIsolatedMarginProperties, [
      "action",
      "coin",
      "margin_delta_usdc",
    ]),
  ],
} as const;

const publicReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "provider",
    "network",
    "market",
    "dex",
    "action",
    "source",
  ],
  properties: {
    version: { type: "string", const: "perp_review_v1" },
    provider: { type: "string", const: "hyperliquid" },
    network: { type: "string", const: "testnet" },
    market: { type: "string", const: "core_perps" },
    dex: { type: "string", const: "" },
    action: reviewActionSchema,
    source: {
      type: "object",
      additionalProperties: false,
      required: ["fetched_at", "expires_at"],
      properties: {
        fetched_at: { type: "string", format: "date-time" },
        expires_at: { type: "string", format: "date-time" },
      },
    },
  },
} as const;

const nullableUint64Schema = {
  anyOf: [uint64Schema, { type: "null" }],
} as const;
const nullableClientOrderIdSchema = {
  anyOf: [clientOrderIdSchema, { type: "null" }],
} as const;
const nullablePositiveDecimalSchema = {
  anyOf: [positiveDecimalSchema, { type: "null" }],
} as const;
const intentResultSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["observed_at", "items"],
      properties: {
        observed_at: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 39,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "index",
              "state",
              "order_id",
              "client_order_id",
              "filled_size",
              "average_fill_price",
              "reason_code",
            ],
            properties: {
              index: { type: "integer", minimum: 0, maximum: 38 },
              state: {
                type: "string",
                enum: [
                  "accepted",
                  "partial",
                  "filled",
                  "cancelled",
                  "rejected",
                  "unknown",
                ],
              },
              order_id: nullableUint64Schema,
              client_order_id: nullableClientOrderIdSchema,
              filled_size: nullablePositiveDecimalSchema,
              average_fill_price: nullablePositiveDecimalSchema,
              reason_code: {
                anyOf: [
                  {
                    type: "string",
                    pattern: "^[a-z][a-z0-9_]{0,63}$",
                  },
                  { type: "null" },
                ],
              },
            },
          },
        },
      },
    },
  ],
} as const;

const intentResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "intent_id",
    "action",
    "state",
    "review",
    "expires_at",
    "submission",
    "result",
    "created_at",
    "updated_at",
  ],
  properties: {
    intent_id: { type: "string", pattern: uuidPattern },
    action: {
      type: "string",
      enum: [
        "order",
        "cancel",
        "modify",
        "batch_modify",
        "update_leverage",
        "update_isolated_margin",
      ],
    },
    state: {
      type: "string",
      enum: [
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
      ],
    },
    review: publicReviewSchema,
    expires_at: { type: "string", format: "date-time" },
    submission: {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: {
        state: {
          type: "string",
          enum: ["disabled", "requires_revalidation"],
        },
      },
    },
    result: intentResultSchema,
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
} as const;

const intentIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent_id"],
  properties: {
    intent_id: { type: "string", pattern: uuidPattern },
  },
} as const;

const prepareHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", pattern: uuidPattern },
  },
} as const;

const prepareErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  409: errorResponseSchema([
    "bootstrap_required",
    "wallet_binding_required",
    "idempotency_conflict",
    "perp_intent_stale",
  ]),
  429: errorResponseSchema(["perp_intent_claim_rate_limited"]),
  503: errorResponseSchema([
    "authentication_unavailable",
    "perp_unavailable",
    "request_timeout",
  ]),
  500: errorResponseSchema(["internal_error"]),
} as const;

const readErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  404: errorResponseSchema(["perp_intent_not_found"]),
  409: errorResponseSchema(["bootstrap_required"]),
  503: errorResponseSchema([
    "authentication_unavailable",
    "perp_unavailable",
    "request_timeout",
  ]),
  500: errorResponseSchema(["internal_error"]),
} as const;

function assertNoRawRequestBody(request: FastifyRequest): void {
  const contentLength = request.headers["content-length"];
  const transferEncoding = request.headers["transfer-encoding"];
  if (
    (contentLength !== undefined && contentLength !== "0") ||
    transferEncoding !== undefined
  ) {
    throw ApiError.invalidRequest();
  }
}

const prepareIdempotencyGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parsePerpIntentIdempotencyKey(request.raw.rawHeaders);
  } catch {
    done(ApiError.invalidRequest());
    return;
  }
  done();
};

const noRawBodyGuard: onRequestHookHandler = (request, _reply, done): void => {
  try {
    assertNoRawRequestBody(request);
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

function assertStrictPrepareInput(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }

  try {
    parsePerpIntentRequest(request.body);
  } catch {
    throw ApiError.invalidRequest();
  }
  return Promise.resolve();
}

function mapPerpIntentError(error: unknown): never {
  if (error instanceof InvalidPerpIntentRequestError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof PerpIntentIdempotencyConflictError) {
    throw ApiError.idempotencyConflict();
  }
  if (error instanceof PerpIntentClaimRateLimitedError) {
    throw ApiError.perpIntentClaimRateLimited();
  }
  if (error instanceof PerpIntentWalletBindingRequiredError) {
    throw ApiError.walletBindingRequired();
  }
  if (error instanceof PerpIntentNotFoundError) {
    throw ApiError.perpIntentNotFound();
  }
  if (error instanceof PerpIntentExpiredError) {
    throw ApiError.perpIntentExpired();
  }
  if (error instanceof PerpIntentStaleError) {
    throw ApiError.perpIntentStale();
  }
  if (error instanceof PerpMutationDisabledError) {
    throw ApiError.perpMutationDisabled();
  }
  if (error instanceof PerpIntentUnavailableError) {
    throw ApiError.perpUnavailable();
  }
  throw error;
}

export function registerPerpIntentRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: PerpIntentService,
): void {
  app.post(
    "/v1/perp/intents",
    {
      schema: {
        operationId: "preparePerpIntent",
        summary: "Prepare a reviewed Perp intent",
        description:
          "Creates or replays one owner-bound Hyperliquid Testnet Core-perpetual review. Preparation never submits a provider mutation.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        headers: prepareHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: intentRequestSchema,
        response: { 200: intentResourceSchema, ...prepareErrors },
      },
      onRequest: prepareIdempotencyGuard,
      preValidation: assertStrictPrepareInput,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      let idempotencyKey: string;
      try {
        idempotencyKey = parsePerpIntentIdempotencyKey(request.raw.rawHeaders);
      } catch {
        throw ApiError.invalidRequest();
      }

      try {
        const resource = await service.prepare({
          principal,
          idempotencyKey,
          requestId: request.id,
          body: request.body,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapPerpIntentError(error);
      }
    },
  );

  app.get<{ Params: { intent_id: string } }>(
    "/v1/perp/intents/:intent_id",
    {
      schema: {
        operationId: "getPerpIntent",
        summary: "Get a Perp intent",
        description:
          "Returns only the current authenticated owner's persisted Perp intent projection.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        params: intentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: intentResourceSchema, ...readErrors },
      },
      onRequest: noRawBodyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const resource = await service.get({
          principal,
          intentId: request.params.intent_id,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapPerpIntentError(error);
      }
    },
  );

  app.post<{ Params: { intent_id: string } }>(
    "/v1/perp/intents/:intent_id/submit",
    {
      schema: {
        operationId: "submitPerpIntent",
        summary: "Submit a prepared Perp intent",
        description:
          "Checks the persisted review and the action-specific mutation gate. The current production gate denies before any provider or signer work.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        params: intentIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: intentResourceSchema,
          ...readErrors,
          403: errorResponseSchema(["perp_mutation_disabled"]),
          409: errorResponseSchema([
            "bootstrap_required",
            "perp_intent_expired",
          ]),
        },
      },
      onRequest: noRawBodyGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const resource = await service.submit({
          principal,
          intentId: request.params.intent_id,
          signal: request.signal,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      } catch (error) {
        return mapPerpIntentError(error);
      }
    },
  );
}
