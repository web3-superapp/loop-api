import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import {
  requireAuthenticatedLoopPrincipal,
  type AuthenticatedLoopPrincipal,
} from "../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import {
  assertNoBody,
  assertNoBodyOrQuery,
} from "../core/http/request-input.js";
import {
  InvalidPerpReadRequestError,
  PERP_POSITIONS_MAX_LIMIT,
  PERP_PRIVATE_LIST_MAX_LIMIT,
  PerpReadUnavailableError,
  PerpWalletBindingRequiredError,
  type PerpPrivateReadRequest,
  type PerpPrivateReadService,
} from "../features/perp/private-read-service.js";
import type {
  HyperliquidPrivateListReadKind,
  HyperliquidPrivateReadKind,
} from "../integrations/hyperliquid/private-reader.js";

const decimalStringPattern =
  "^(?:(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?|-(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*))$";
const positiveDecimalStringPattern =
  "^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$";
const positiveIntegerDecimalStringPattern = "^[1-9][0-9]{0,18}$";
const unsignedIntegerStringPattern = "^(?:0|[1-9][0-9]*)$";
const clientOrderIdPattern = "^0x[0-9a-f]{32}$";
const transactionHashPattern = "^0x[0-9a-f]{64}$";
const opaqueCursorPattern = "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$";
const maximumOpaqueCursorLength = 1_536;

const decimalStringSchema = {
  type: "string",
  pattern: decimalStringPattern,
  maxLength: 128,
} as const;

const positiveDecimalStringSchema = {
  type: "string",
  pattern: positiveDecimalStringPattern,
  maxLength: 128,
} as const;

const positiveIntegerDecimalStringSchema = {
  type: "string",
  pattern: positiveIntegerDecimalStringPattern,
  maxLength: 20,
} as const;

const unsignedIntegerStringSchema = {
  type: "string",
  pattern: unsignedIntegerStringPattern,
  maxLength: 20,
} as const;

const coreCoinSchema = {
  type: "string",
  enum: ["BTC", "ETH", "SOL"],
} as const;

const nullableDecimalStringSchema = {
  anyOf: [decimalStringSchema, { type: "null" }],
} as const;

const opaqueCursorSchema = {
  type: "string",
  minLength: 45,
  maxLength: maximumOpaqueCursorLength,
  pattern: opaqueCursorPattern,
} as const;

const nullableOpaqueCursorSchema = {
  anyOf: [opaqueCursorSchema, { type: "null" }],
} as const;

function sourceSchema(dataset: HyperliquidPrivateReadKind) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "provider",
      "network",
      "market",
      "dex",
      "dataset",
      "fetched_at",
      "expires_at",
    ],
    properties: {
      provider: { type: "string", const: "hyperliquid" },
      network: { type: "string", const: "testnet" },
      market: { type: "string", const: "core_perps" },
      dex: { type: "string", const: "" },
      dataset: { type: "string", const: dataset },
      fetched_at: { type: "string", format: "date-time" },
      expires_at: { type: "string", format: "date-time" },
    },
  } as const;
}

const unavailableFactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: {
    state: { type: "string", const: "unavailable" },
  },
} as const;

function availableDecimalFactSchema(valueSchema: {
  readonly type: "string";
  readonly pattern: string;
  readonly maxLength: number;
}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["state", "value"],
    properties: {
      state: { type: "string", const: "available" },
      value: valueSchema,
    },
  } as const;
}

function optionalDecimalFactSchema(valueSchema: {
  readonly type: "string";
  readonly pattern: string;
  readonly maxLength: number;
}) {
  return {
    oneOf: [unavailableFactSchema, availableDecimalFactSchema(valueSchema)],
  } as const;
}

const configResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["scope", "assets", "fees", "capabilities", "source"],
  properties: {
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["network", "market", "dex", "coins"],
      properties: {
        network: { type: "string", const: "testnet" },
        market: { type: "string", const: "core_perps" },
        dex: { type: "string", const: "" },
        coins: {
          type: "array",
          items: coreCoinSchema,
          minItems: 3,
          maxItems: 3,
        },
      },
    },
    assets: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "coin",
          "size_decimals",
          "size_increment",
          "max_leverage",
          "margin_mode",
          "minimum_order_notional_usdc",
        ],
        properties: {
          coin: coreCoinSchema,
          size_decimals: {
            type: "integer",
            minimum: 0,
            maximum: 18,
          },
          size_increment: positiveDecimalStringSchema,
          max_leverage: positiveIntegerDecimalStringSchema,
          margin_mode: {
            type: "string",
            enum: ["cross_and_isolated", "isolated_only"],
          },
          minimum_order_notional_usdc: optionalDecimalFactSchema(
            positiveDecimalStringSchema,
          ),
        },
      },
    },
    fees: {
      type: "object",
      additionalProperties: false,
      required: ["maker_rate", "taker_rate"],
      properties: {
        maker_rate: optionalDecimalFactSchema(decimalStringSchema),
        taker_rate: optionalDecimalFactSchema(decimalStringSchema),
      },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: ["private_reads", "trading_mutations"],
      properties: {
        private_reads: { type: "string", const: "available" },
        trading_mutations: { type: "string", const: "disabled" },
      },
    },
    source: sourceSchema("config"),
  },
} as const;

const marginSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "account_value",
    "total_margin_used",
    "total_notional_position",
    "total_raw_usd",
  ],
  properties: {
    account_value: decimalStringSchema,
    total_margin_used: decimalStringSchema,
    total_notional_position: decimalStringSchema,
    total_raw_usd: decimalStringSchema,
  },
} as const;

const accountResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "margin_summary",
    "cross_margin_summary",
    "withdrawable",
    "cross_maintenance_margin_used",
    "source",
  ],
  properties: {
    margin_summary: marginSummarySchema,
    cross_margin_summary: marginSummarySchema,
    withdrawable: decimalStringSchema,
    cross_maintenance_margin_used: nullableDecimalStringSchema,
    source: sourceSchema("account"),
  },
} as const;

const positionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "coin",
    "side",
    "size",
    "entry_price",
    "leverage",
    "liquidation_price",
    "margin_used",
    "position_value",
    "return_on_equity",
    "unrealized_pnl",
    "position_mode",
  ],
  properties: {
    coin: coreCoinSchema,
    side: { type: "string", enum: ["long", "short"] },
    size: positiveDecimalStringSchema,
    entry_price: nullableDecimalStringSchema,
    leverage: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "value", "raw_usd"],
      properties: {
        mode: { type: "string", enum: ["cross", "isolated"] },
        value: positiveIntegerDecimalStringSchema,
        raw_usd: nullableDecimalStringSchema,
      },
    },
    liquidation_price: nullableDecimalStringSchema,
    margin_used: decimalStringSchema,
    position_value: decimalStringSchema,
    return_on_equity: decimalStringSchema,
    unrealized_pnl: decimalStringSchema,
    position_mode: { type: "string", const: "one_way" },
  },
} as const;

const orderSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "order_id",
    "client_order_id",
    "coin",
    "side",
    "order_type",
    "time_in_force",
    "limit_price",
    "original_size",
    "remaining_size",
    "reduce_only",
    "status",
    "created_at",
    "status_at",
  ],
  properties: {
    order_id: unsignedIntegerStringSchema,
    client_order_id: {
      anyOf: [
        { type: "string", pattern: clientOrderIdPattern },
        { type: "null" },
      ],
    },
    coin: coreCoinSchema,
    side: { type: "string", enum: ["buy", "sell"] },
    order_type: { type: "string", const: "limit" },
    time_in_force: { type: "string", enum: ["gtc", "alo", "ioc"] },
    limit_price: positiveDecimalStringSchema,
    original_size: positiveDecimalStringSchema,
    remaining_size: positiveDecimalStringSchema,
    reduce_only: { type: "boolean" },
    status: { type: "string", const: "open" },
    created_at: { type: "string", format: "date-time" },
    status_at: { type: "string", format: "date-time" },
  },
} as const;

const fillSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "trade_id",
    "order_id",
    "transaction_hash",
    "coin",
    "side",
    "price",
    "size",
    "start_position",
    "closed_pnl",
    "fee",
    "fee_asset",
    "crossed",
    "filled_at",
  ],
  properties: {
    trade_id: unsignedIntegerStringSchema,
    order_id: unsignedIntegerStringSchema,
    transaction_hash: { type: "string", pattern: transactionHashPattern },
    coin: coreCoinSchema,
    side: { type: "string", enum: ["buy", "sell"] },
    price: positiveDecimalStringSchema,
    size: positiveDecimalStringSchema,
    start_position: decimalStringSchema,
    closed_pnl: decimalStringSchema,
    fee: decimalStringSchema,
    fee_asset: { type: "string", const: "USDC" },
    crossed: { type: "boolean" },
    filled_at: { type: "string", format: "date-time" },
  },
} as const;

const fundingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "transaction_hash",
    "coin",
    "funding_rate",
    "position_size",
    "payment_usdc",
    "settled_at",
  ],
  properties: {
    transaction_hash: { type: "string", pattern: transactionHashPattern },
    coin: coreCoinSchema,
    funding_rate: decimalStringSchema,
    position_size: decimalStringSchema,
    payment_usdc: decimalStringSchema,
    settled_at: { type: "string", format: "date-time" },
  },
} as const;

const recentWindowCoverageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "started_at", "ended_at", "truncated"],
  properties: {
    kind: { type: "string", const: "recent_window" },
    started_at: { type: "string", format: "date-time" },
    ended_at: { type: "string", format: "date-time" },
    truncated: { type: "boolean" },
  },
} as const;

function listResponseSchema(
  kind: HyperliquidPrivateListReadKind,
  itemSchema: object,
  maximumItems: number,
  includeCoverage: boolean,
) {
  return {
    type: "object",
    headers: noStoreResponseHeaders(),
    additionalProperties: false,
    required: [
      "items",
      ...(includeCoverage ? ["coverage"] : []),
      "source",
      "next_cursor",
    ],
    properties: {
      items: {
        type: "array",
        items: itemSchema,
        maxItems: maximumItems,
      },
      ...(includeCoverage ? { coverage: recentWindowCoverageSchema } : {}),
      source: sourceSchema(kind),
      next_cursor: nullableOpaqueCursorSchema,
    },
  } as const;
}

const positionsResponseSchema = listResponseSchema(
  "positions",
  positionSchema,
  PERP_POSITIONS_MAX_LIMIT,
  false,
);
const ordersResponseSchema = listResponseSchema(
  "orders",
  orderSchema,
  PERP_PRIVATE_LIST_MAX_LIMIT,
  false,
);
const fillsResponseSchema = listResponseSchema(
  "fills",
  fillSchema,
  PERP_PRIVATE_LIST_MAX_LIMIT,
  true,
);
const fundingResponseSchema = listResponseSchema(
  "funding",
  fundingSchema,
  PERP_PRIVATE_LIST_MAX_LIMIT,
  true,
);

const positionsQueryStringSchema = listQueryStringSchema(
  PERP_POSITIONS_MAX_LIMIT,
);
const privateListQueryStringSchema = listQueryStringSchema(
  PERP_PRIVATE_LIST_MAX_LIMIT,
);

function listQueryStringSchema(maximumLimit: number) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: maximumLimit,
      },
      cursor: opaqueCursorSchema,
    },
    not: { required: ["limit", "cursor"] },
  } as const;
}

const errorResponses = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  409: errorResponseSchema(["bootstrap_required", "wallet_binding_required"]),
  503: errorResponseSchema([
    "authentication_unavailable",
    "perp_unavailable",
    "request_timeout",
  ]),
  500: errorResponseSchema(["internal_error"]),
} as const;

interface ListQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

function rawQueryEntries(request: FastifyRequest): readonly [string, string][] {
  const rawUrl = request.raw.url;

  if (rawUrl === undefined) {
    throw ApiError.invalidRequest();
  }

  try {
    return [...new URL(rawUrl, "http://loop.invalid").searchParams.entries()];
  } catch {
    throw ApiError.invalidRequest();
  }
}

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

function rawInputGuard(
  allowedQueryKeys: ReadonlySet<string>,
): onRequestHookHandler {
  return (request, _reply, done): void => {
    try {
      assertNoRawRequestBody(request);
      const seen = new Set<string>();

      for (const [key] of rawQueryEntries(request)) {
        if (!allowedQueryKeys.has(key) || seen.has(key)) {
          throw ApiError.invalidRequest();
        }
        seen.add(key);
      }

      if (seen.has("limit") && seen.has("cursor")) {
        throw ApiError.invalidRequest();
      }
    } catch (error) {
      done(error instanceof Error ? error : ApiError.invalidRequest());
      return;
    }

    done();
  };
}

const singletonRawInputGuard = rawInputGuard(new Set());
const listRawInputGuard = rawInputGuard(new Set(["limit", "cursor"]));

function mapPerpReadError(error: unknown): never {
  if (error instanceof InvalidPerpReadRequestError) {
    throw ApiError.invalidRequest();
  }

  if (error instanceof PerpWalletBindingRequiredError) {
    throw ApiError.walletBindingRequired();
  }

  if (error instanceof PerpReadUnavailableError) {
    throw ApiError.perpUnavailable();
  }

  throw error;
}

function serviceInput(
  principal: AuthenticatedLoopPrincipal,
  kind: HyperliquidPrivateReadKind,
  signal: AbortSignal,
  query?: ListQuery,
): PerpPrivateReadRequest {
  return query?.limit !== undefined
    ? { principal, kind, limit: query.limit, signal }
    : query?.cursor !== undefined
      ? { principal, kind, cursor: query.cursor, signal }
      : { principal, kind, signal };
}

function registerSingletonReadRoute(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: PerpPrivateReadService,
  input: {
    readonly kind: "config" | "account";
    readonly operationId: string;
    readonly summary: string;
    readonly responseSchema: object;
  },
): void {
  app.get(
    `/v1/perp/${input.kind}`,
    {
      schema: {
        operationId: input.operationId,
        summary: input.summary,
        description:
          "Returns a strict Hyperliquid Testnet Core-perpetual projection for the server-resolved current wallet binding.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: { 200: input.responseSchema, ...errorResponses },
      },
      onRequest: singletonRawInputGuard,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);

      try {
        const result = await service.read(
          serviceInput(principal, input.kind, request.signal),
        );
        reply.header("cache-control", "no-store");
        return reply.code(200).send(result);
      } catch (error) {
        return mapPerpReadError(error);
      }
    },
  );
}

function registerListReadRoute(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: PerpPrivateReadService,
  input: {
    readonly kind: HyperliquidPrivateListReadKind;
    readonly operationId: string;
    readonly summary: string;
    readonly querySchema: object;
    readonly responseSchema: object;
  },
): void {
  app.get<{ Querystring: ListQuery }>(
    `/v1/perp/${input.kind}`,
    {
      schema: {
        operationId: input.operationId,
        summary: input.summary,
        description:
          "Returns a bounded Hyperliquid Testnet Core-perpetual projection for the server-resolved current wallet binding. Pagination cursors are opaque and owner-bound.",
        tags: ["perp"],
        security: [{ privyBearer: [] }],
        querystring: input.querySchema,
        response: { 200: input.responseSchema, ...errorResponses },
      },
      onRequest: listRawInputGuard,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);

      try {
        const result = await service.read(
          serviceInput(principal, input.kind, request.signal, request.query),
        );
        reply.header("cache-control", "no-store");
        return reply.code(200).send(result);
      } catch (error) {
        return mapPerpReadError(error);
      }
    },
  );
}

export function registerPerpPrivateReadRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: PerpPrivateReadService,
): void {
  registerSingletonReadRoute(app, authenticateLoopBearer, service, {
    kind: "config",
    operationId: "getPerpConfig",
    summary: "Get private Perp configuration",
    responseSchema: configResponseSchema,
  });
  registerSingletonReadRoute(app, authenticateLoopBearer, service, {
    kind: "account",
    operationId: "getPerpAccount",
    summary: "Get the current Perp account",
    responseSchema: accountResponseSchema,
  });
  registerListReadRoute(app, authenticateLoopBearer, service, {
    kind: "positions",
    operationId: "listPerpPositions",
    summary: "List current Perp positions",
    querySchema: positionsQueryStringSchema,
    responseSchema: positionsResponseSchema,
  });
  registerListReadRoute(app, authenticateLoopBearer, service, {
    kind: "orders",
    operationId: "listPerpOrders",
    summary: "List current open Perp orders",
    querySchema: privateListQueryStringSchema,
    responseSchema: ordersResponseSchema,
  });
  registerListReadRoute(app, authenticateLoopBearer, service, {
    kind: "fills",
    operationId: "listPerpFills",
    summary: "List recent Perp fills",
    querySchema: privateListQueryStringSchema,
    responseSchema: fillsResponseSchema,
  });
  registerListReadRoute(app, authenticateLoopBearer, service, {
    kind: "funding",
    operationId: "listPerpFunding",
    summary: "List recent Perp funding ledger entries",
    querySchema: privateListQueryStringSchema,
    responseSchema: fundingResponseSchema,
  });
}
