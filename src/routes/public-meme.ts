import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";

import {
  publicClientKey,
  type PublicClientIpHeaderName,
} from "../core/http/client-ip.js";
import { V2ApiError } from "../core/http/v2-error.js";
import { opaqueIdPatternSource } from "../core/ids/opaque-id.js";
import { evmAddressPatternSource } from "../features/chain/chain-contract.js";
import { launch2Stages } from "../features/launch2/launch2-contract.js";
import { launch2DynamicRoundCloseRules } from "../features/launch2/launch2-dynamic.js";
import { launch2PublicReasonCodes } from "../features/launch2/launch2-public.js";
import type { Launch2Service } from "../features/launch2/launch2-service.js";

/**
 * Decision 0147: the public MEME page read surface `/public/v1/meme*`.
 *
 * Outside `/v2`, like the well-known files: no Bearer token, no
 * `X-Loop-Contract-Version`, no `Idempotency-Key`. A browser page on
 * another origin reads it, so every `/public/*` answer (errors included)
 * carries `Access-Control-Allow-Origin: *` and an `OPTIONS` preflight is
 * 204; `/v2` gets no CORS header. A 200 is `Cache-Control: public,
 * max-age=15`; every error is `no-store`.
 *
 * Only facts that are public on chain, or that any signed-in App user
 * already sees, appear: names, prices, the Hook's round state, indexed
 * fee and buyback totals, the bound community's public profile. Never a
 * wallet, user, viewer, owner, or buyer field.
 *
 * Abuse guard: a fixed one-minute window per visitor (in memory, per
 * process; `PUBLIC_RATE_LIMIT_PER_MINUTE`, default 120), 429
 * `RATE_LIMITED` with `Retry-After`, `X-RateLimit-Limit` and
 * `X-RateLimit-Remaining: 0`. S211: the visitor is `publicClientKey` —
 * with `TRUST_PROXY` on, the first public address among
 * `PUBLIC_CLIENT_IP_HEADERS` (default `x-forwarded-for`, right-most
 * public entry), else `request.ip`. Identical URLs share one answer for 5 s (only 200s), so
 * a burst costs at most one Hook read per instance per 5 s.
 *
 * S207 (Decision 0147 revision): concurrent reads of one URL share one
 * in-flight read (single-flight; a failure reaches every waiter as the
 * same 503, never a second upstream call), and each read has a time
 * budget well inside Fastify's 15 s `handlerTimeout` (detail 8 s, list
 * 10 s, candles 5 s) answering 503 `PUBLIC_UPSTREAM_TIMEOUT`. Before the
 * budget, a slow Hook read ran past `handlerTimeout`: Fastify sent its
 * `FST_ERR_HANDLER_TIMEOUT` through the error handler (projected to 500)
 * and the handler's own late send then logged "Reply was already sent".
 * The handler and the error handler never send twice or into a closed
 * response.
 *
 * Failures answer `{ code, reasonCode }` with the service's reason code
 * as is (503 `CAPABILITY_UNAVAILABLE` / `LAUNCH2_*`, 404 `NOT_FOUND`, 400
 * `INVALID_REQUEST`); a 503 never carries a partial body.
 */

export const publicMemeCacheControl = "public, max-age=15";
export const publicRateLimitWindowMs = 60_000;
/** Default of `PUBLIC_RATE_LIMIT_PER_MINUTE` (S211: configurable). */
export const publicRateLimitPerWindow = 120;
export const publicResponseMemoMs = 5_000;
/**
 * S207: time budget (ms) of one public read, chain reads included. All
 * stay well below the server's 15 s `handlerTimeout` / request abort
 * deadline so the page sees a sanitized 503, never the framework timeout.
 */
export const publicReadBudgetsMs = Object.freeze({
  detail: 8_000,
  list: 10_000,
  candles: 5_000,
});
export type PublicReadKind = keyof typeof publicReadBudgetsMs;
const publicMemoMaximumEntries = 500;
const publicRateLimitMaximumKeys = 10_000;

export interface PublicMemeRouteOptions {
  readonly service: Launch2Service;
  /** Test seam: the clock of the rate limiter and the memo (ms). */
  readonly nowMs?: () => number;
  /** Requests per window per visitor (`PUBLIC_RATE_LIMIT_PER_MINUTE`). */
  readonly ratePerWindow?: number;
  /** S211: `TRUST_PROXY`; off keys the limiter on `request.ip`. */
  readonly trustProxy?: boolean;
  /** S211: `PUBLIC_CLIENT_IP_HEADERS`, read in order when trusted. */
  readonly clientIpHeaders?: readonly PublicClientIpHeaderName[];
  /** Test seam: per-read time budgets (ms). */
  readonly budgetsMs?: Partial<Record<PublicReadKind, number>>;
}

// ---------------------------------------------------------------------------
// Schemas (the OpenAPI source)
// ---------------------------------------------------------------------------

const unsignedDecimalSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,40})(\\.[0-9]{1,18})?$",
} as const;
const nullableUnsignedDecimalSchema = {
  anyOf: [unsignedDecimalSchema, { type: "null" }],
} as const;
const uintStringSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})$",
} as const;
const addressSchema = {
  type: "string",
  pattern: evmAddressPatternSource,
} as const;
const nullableAddressSchema = {
  anyOf: [addressSchema, { type: "null" }],
} as const;
const bytes32Schema = { type: "string", pattern: "^0x[0-9a-f]{64}$" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;
const nullableStringSchema = {
  anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
} as const;
const nullableUrlSchema = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }],
} as const;
const stageSchema = { type: "string", enum: [...launch2Stages] } as const;
const bpsSchema = { type: "integer", minimum: 0, maximum: 10_000 } as const;

const publicHeadersSchema = {
  "access-control-allow-origin": { type: "string", const: "*" },
  "cache-control": { type: "string", const: publicMemeCacheControl },
} as const;

export const publicErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "reasonCode"],
  properties: {
    code: {
      type: "string",
      enum: [
        "INVALID_REQUEST",
        "NOT_FOUND",
        "RATE_LIMITED",
        "CAPABILITY_UNAVAILABLE",
        "INTERNAL_ERROR",
      ],
    },
    reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
  },
} as const;

const publicErrors = {
  400: {
    ...publicErrorSchema,
    description: `INVALID_REQUEST: ${launch2PublicReasonCodes.limitInvalid} | ${launch2PublicReasonCodes.stageInvalid} | ${launch2PublicReasonCodes.intervalUnsupported}`,
  },
  404: {
    ...publicErrorSchema,
    description: "NOT_FOUND: LAUNCH2_INSTANCE_NOT_FOUND | PUBLIC_NOT_FOUND",
  },
  429: {
    ...publicErrorSchema,
    headers: {
      "access-control-allow-origin": { type: "string", const: "*" },
      "cache-control": { type: "string", const: "no-store" },
      "retry-after": { type: "string", pattern: "^[1-9][0-9]{0,1}$" },
      "x-ratelimit-limit": { type: "string", pattern: "^[1-9][0-9]{1,4}$" },
      "x-ratelimit-remaining": { type: "string", const: "0" },
    },
    description: `RATE_LIMITED: ${launch2PublicReasonCodes.rateLimited} (Retry-After seconds; X-RateLimit-Limit = PUBLIC_RATE_LIMIT_PER_MINUTE, X-RateLimit-Remaining = 0). Per visitor: with TRUST_PROXY on, the first public address among PUBLIC_CLIENT_IP_HEADERS, else the peer.`,
  },
  503: {
    ...publicErrorSchema,
    description:
      "CAPABILITY_UNAVAILABLE with the launch2 reason as is (PUBLIC_UPSTREAM_TIMEOUT when the read exceeds its time budget, LAUNCH2_REPOSITORY_UNAVAILABLE, LAUNCH2_CHAIN_READ_FAILED, LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED, LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH, LAUNCH2_DYNAMIC_FACTORY_UNKNOWN, LAUNCH2_DYNAMIC_ROUTER_MISMATCH, LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED, LAUNCH2_DYNAMIC_HOOK_MISMATCH, LAUNCH2_DYNAMIC_HOOK_NOT_INITIALIZED, V2_LAUNCH2_MODULE_DEFERRED, …); never a partial body.",
  },
} as const;

const instanceParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instanceId"],
  properties: { instanceId: { type: "string", maxLength: 64 } },
} as const;

const listItemDynamicSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["armed", "currentDynamicTaxBps"],
      properties: {
        armed: { type: "boolean" },
        currentDynamicTaxBps: bpsSchema,
      },
    },
    { type: "null" },
  ],
} as const;

export const publicMemeListSchema = {
  type: "object",
  additionalProperties: false,
  headers: publicHeadersSchema,
  required: ["items", "generatedAt"],
  properties: {
    items: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "instanceId",
          "name",
          "symbol",
          "logoUrl",
          "stage",
          "memeTokenAddress",
          "communityName",
          "lastPriceUsd1",
          "dynamic",
          "dynamicReasonCode",
        ],
        properties: {
          instanceId: { type: "string", pattern: opaqueIdPatternSource },
          name: { type: "string", minLength: 1 },
          symbol: { type: "string", minLength: 1 },
          logoUrl: nullableUrlSchema,
          stage: stageSchema,
          memeTokenAddress: addressSchema,
          communityName: nullableStringSchema,
          lastPriceUsd1: nullableUnsignedDecimalSchema,
          dynamic: listItemDynamicSchema,
          dynamicReasonCode: {
            anyOf: [
              { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
              { type: "null" },
            ],
            description:
              "Set (with dynamic null) when this graduated LoopDynamic row's Hook read is unavailable — the reason the detail answers with its 503. Null otherwise.",
          },
        },
      },
    },
    generatedAt: dateTimeSchema,
  },
} as const;

const dynamicSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "hookKind",
        "armed",
        "currentRound",
        "currentDynamicTaxBps",
        "maxDynamicFeeBps",
        "baseBuyFeeBps",
        "buyFeeToken",
        "baseSellFeeBps",
        "pendingPotUsd1",
        "carryUsd1",
        "currentRoundDynamicFeesUsd1",
        "roundCloseRule",
        "lastClosedRound",
        "asOfBlock",
      ],
      properties: {
        hookKind: { type: "string", const: "loopDynamic" },
        armed: {
          type: "boolean",
          description:
            "The Hook's armed(): a reward round is active (悬挂状态开启).",
        },
        currentRound: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "roundId",
                "startCandle",
                "openPriceUsd1",
                "buyerCount",
                "totalBuyWeightUsd1",
              ],
              properties: {
                roundId: uintStringSchema,
                startCandle: uintStringSchema,
                openPriceUsd1: {
                  ...unsignedDecimalSchema,
                  description:
                    "Open price of the current 5-minute candle: the round closes at the first candle that closes at or above its open (Decision 0144).",
                },
                buyerCount: { type: "integer", minimum: 0 },
                totalBuyWeightUsd1: unsignedDecimalSchema,
              },
            },
            { type: "null" },
          ],
        },
        currentDynamicTaxBps: {
          ...bpsSchema,
          description:
            "Dynamic sell tax at the current price: min(drop, cap) in bps; 0 = base 2 % only.",
        },
        maxDynamicFeeBps: bpsSchema,
        baseBuyFeeBps: {
          ...bpsSchema,
          description:
            "Base buy fee in bps. Decision 0152: with buyFeeToken usd1 (S209 Hook) it is taken from the USD1 input — fee = floor(amountIn × bps / 10,000), the pool swaps the rest, the MEME output is untaxed; with meme (pre-S209 Hook) from the MEME output.",
        },
        buyFeeToken: {
          type: "string",
          enum: ["meme", "usd1"],
          description:
            "Decision 0152 (loop-contracts Decision 0015): the token the base buy fee is charged in — usd1 for an S209 Hook (address bits 0x10CC), meme before (0x10C4).",
        },
        baseSellFeeBps: bpsSchema,
        pendingPotUsd1: {
          ...unsignedDecimalSchema,
          description:
            "carry + the armed round's dynamic fees (= dynamic-pool potUsd1). At close half goes to the round's buyers, half is carried.",
        },
        carryUsd1: unsignedDecimalSchema,
        currentRoundDynamicFeesUsd1: unsignedDecimalSchema,
        roundCloseRule: {
          type: "string",
          enum: [...launch2DynamicRoundCloseRules],
        },
        lastClosedRound: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["roundId", "closedAt", "allocationUsd1", "buyerCount"],
              properties: {
                roundId: uintStringSchema,
                closedAt: dateTimeSchema,
                allocationUsd1: unsignedDecimalSchema,
                buyerCount: { type: "integer", minimum: 0 },
              },
            },
            { type: "null" },
          ],
        },
        asOfBlock: uintStringSchema,
      },
    },
    { type: "null" },
  ],
} as const;

export const publicMemeDetailSchema = {
  type: "object",
  additionalProperties: false,
  headers: publicHeadersSchema,
  required: [
    "instance",
    "community",
    "price",
    "dynamic",
    "totals",
    "generatedAt",
  ],
  properties: {
    instance: {
      type: "object",
      additionalProperties: false,
      required: [
        "instanceId",
        "name",
        "symbol",
        "logoUrl",
        "description",
        "stage",
        "graduatedAt",
        "createdAt",
        "memeTokenAddress",
        "hookAddress",
        "poolId",
        "escrowAddress",
        "perAddressCurveCapMeme",
        "chainId",
        "explorerBaseUrl",
        "socials",
      ],
      properties: {
        instanceId: { type: "string", pattern: opaqueIdPatternSource },
        name: { type: "string", minLength: 1 },
        symbol: { type: "string", minLength: 1 },
        logoUrl: nullableUrlSchema,
        description: nullableStringSchema,
        stage: stageSchema,
        graduatedAt: nullableDateTimeSchema,
        createdAt: dateTimeSchema,
        memeTokenAddress: addressSchema,
        hookAddress: nullableAddressSchema,
        poolId: { anyOf: [bytes32Schema, { type: "null" }] },
        escrowAddress: nullableAddressSchema,
        perAddressCurveCapMeme: {
          ...unsignedDecimalSchema,
          description:
            "Decision 0152 (loop-contracts Decision 0015): the curve's per-address lifetime purchase cap in MEME, read from the chain — maxCumulativeBuy() (S209, a Factory parameter) or MAX_CUMULATIVE_BUY() (5,000,000 before); the verified value when the chain is unreachable.",
        },
        chainId: { type: "string", pattern: "^eip155:[1-9][0-9]{0,9}$" },
        explorerBaseUrl: nullableUrlSchema,
        socials: {
          type: "object",
          additionalProperties: false,
          required: ["website", "x", "telegram"],
          properties: {
            website: nullableUrlSchema,
            x: nullableUrlSchema,
            telegram: nullableUrlSchema,
          },
        },
      },
    },
    community: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "communityId",
            "name",
            "slogan",
            "description",
            "memberCount",
            "verified",
            "avatarUrl",
          ],
          properties: {
            communityId: { type: "string", pattern: opaqueIdPatternSource },
            name: { type: "string", minLength: 1 },
            slogan: {
              ...nullableStringSchema,
              description:
                "First non-empty line of the community description, ≤ 60 code points (communities keep no separate tagline).",
            },
            description: nullableStringSchema,
            memberCount: { type: "integer", minimum: 0 },
            verified: { type: "boolean" },
            avatarUrl: {
              type: "null",
              description:
                "Always null: community logos are App presets or authenticated media.",
            },
          },
        },
        { type: "null" },
      ],
    },
    price: {
      type: "object",
      additionalProperties: false,
      required: ["lastPriceUsd1", "change24hPct", "asOf"],
      properties: {
        lastPriceUsd1: nullableUnsignedDecimalSchema,
        change24hPct: {
          anyOf: [
            { type: "string", pattern: "^-?(0|[1-9][0-9]{0,40})\\.[0-9]{2}$" },
            { type: "null" },
          ],
        },
        asOf: dateTimeSchema,
      },
    },
    dynamic: dynamicSchema,
    totals: {
      type: "object",
      additionalProperties: false,
      required: [
        "curveTaxUsd1",
        "poolBaseBuyFeeMeme",
        "poolBaseBuyFeeUsd1",
        "poolBaseSellFeeUsd1",
        "dynamicFeesUsd1",
        "totalTaxUsd1Equivalent",
        "rewardsAllocatedUsd1",
        "rewardsClaimedUsd1",
        "buyback",
      ],
      properties: {
        curveTaxUsd1: unsignedDecimalSchema,
        poolBaseBuyFeeMeme: {
          ...unsignedDecimalSchema,
          description:
            "Σ official-pool buy fees charged in MEME: OfficialTax and pre-S209 LoopDynamic Hooks.",
        },
        poolBaseBuyFeeUsd1: {
          ...unsignedDecimalSchema,
          description:
            "Decision 0152: Σ LoopDynamic buy fees charged in USD1 (S209 Hooks, from the input); 0 otherwise.",
        },
        poolBaseSellFeeUsd1: unsignedDecimalSchema,
        dynamicFeesUsd1: unsignedDecimalSchema,
        totalTaxUsd1Equivalent: {
          ...nullableUnsignedDecimalSchema,
          description:
            "curveTaxUsd1 + poolBaseSellFeeUsd1 + poolBaseBuyFeeUsd1 + dynamicFeesUsd1 + poolBaseBuyFeeMeme × lastPriceUsd1 (floored); null when there is MEME tax but no price.",
        },
        rewardsAllocatedUsd1: unsignedDecimalSchema,
        rewardsClaimedUsd1: unsignedDecimalSchema,
        buyback: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "executedCount",
                "spentUsd1",
                "boughtMeme",
                "escrowRemainingUsd1",
                "recipientAddress",
                "lastAt",
              ],
              properties: {
                executedCount: { type: "integer", minimum: 0 },
                spentUsd1: unsignedDecimalSchema,
                boughtMeme: unsignedDecimalSchema,
                escrowRemainingUsd1: unsignedDecimalSchema,
                recipientAddress: addressSchema,
                lastAt: nullableDateTimeSchema,
              },
            },
            { type: "null" },
          ],
        },
      },
    },
    generatedAt: dateTimeSchema,
  },
} as const;

export const publicMemeCandlesSchema = {
  type: "object",
  additionalProperties: false,
  headers: publicHeadersSchema,
  required: ["interval", "source", "candles", "generatedAt"],
  properties: {
    interval: { type: "string", const: "5m" },
    source: { type: "string", enum: ["pool", "curve"] },
    candles: {
      type: "array",
      maxItems: 300,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["t", "o", "h", "l", "c", "v"],
        properties: {
          t: dateTimeSchema,
          o: unsignedDecimalSchema,
          h: unsignedDecimalSchema,
          l: unsignedDecimalSchema,
          c: unsignedDecimalSchema,
          v: nullableUnsignedDecimalSchema,
        },
      },
    },
    generatedAt: dateTimeSchema,
  },
} as const;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface PublicError {
  readonly statusCode: number;
  readonly code: string;
  readonly reasonCode: string;
}

function publicErrorOf(error: unknown): PublicError {
  if (error instanceof V2ApiError) {
    const reason = error.detailsSafe?.["reasonCode"];
    const statusCode = error.statusCode;
    const code =
      statusCode === 404
        ? "NOT_FOUND"
        : statusCode === 503
          ? "CAPABILITY_UNAVAILABLE"
          : statusCode === 429
            ? "RATE_LIMITED"
            : statusCode >= 400 && statusCode < 500
              ? "INVALID_REQUEST"
              : "INTERNAL_ERROR";
    return {
      statusCode:
        code === "INTERNAL_ERROR"
          ? 500
          : code === "INVALID_REQUEST"
            ? 400
            : statusCode,
      code,
      reasonCode:
        typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)
          ? reason
          : code === "NOT_FOUND"
            ? launch2PublicReasonCodes.notFound
            : code,
    };
  }
  // S207 backstop: Fastify's own `handlerTimeout` (a FastifyError with
  // statusCode 503) is a timeout like the route budget, not a 500.
  if (errorCodeOf(error) === "FST_ERR_HANDLER_TIMEOUT") {
    return {
      statusCode: 503,
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: launch2PublicReasonCodes.upstreamTimeout,
    };
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return {
      statusCode: 400,
      code: "INVALID_REQUEST",
      reasonCode: "PUBLIC_REQUEST_INVALID",
    };
  }
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    reasonCode: "INTERNAL_ERROR",
  };
}

function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(code)
    ? code
    : null;
}

/**
 * The error's message for the log: one line, ≤ 200 code points, URLs
 * replaced (a provider error could carry an RPC URL with its key).
 */
function safeErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const line = error.message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "<url>")
    .replace(/\s+/gu, " ")
    .trim();
  return [...line].slice(0, 200).join("");
}

/**
 * S207: the reply was already sent (Fastify's handler timeout, or the
 * error handler) or the client's response stream is gone: never write
 * again. `request.raw.destroyed` is not used — on Node 24 an
 * `IncomingMessage` is destroyed once its (empty) body is read, while the
 * client is still waiting (see `request-abort-signal.ts`).
 */
export function publicReplyClosed(reply: FastifyReply): boolean {
  return reply.sent || reply.raw.destroyed;
}

function publicTimeoutError(): V2ApiError {
  return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
    reasonCode: launch2PublicReasonCodes.upstreamTimeout,
  });
}

/** `read` settles, or the signal aborts first: 503 PUBLIC_UPSTREAM_TIMEOUT. */
function withDeadline<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(publicTimeoutError());
      return;
    }
    const onAbort = () => reject(publicTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function setCorsHeaders(reply: FastifyReply): void {
  reply.header("access-control-allow-origin", "*");
  reply.header("cross-origin-resource-policy", "cross-origin");
}

export function registerPublicMemeRoutes(
  app: FastifyInstance,
  options: PublicMemeRouteOptions,
): void {
  const nowMs = options.nowMs ?? Date.now;
  const ratePerWindow = options.ratePerWindow ?? publicRateLimitPerWindow;
  const trustProxy = options.trustProxy ?? false;
  const clientIpHeaders = options.clientIpHeaders ?? ["x-forwarded-for"];
  const windows = new Map<string, { start: number; count: number }>();
  const memo = new Map<string, { at: number; body: unknown }>();

  function admit(key: string): number | null {
    const at = nowMs();
    let window = windows.get(key);
    if (window === undefined || at - window.start >= publicRateLimitWindowMs) {
      if (windows.size >= publicRateLimitMaximumKeys) {
        for (const [entry, value] of windows) {
          if (at - value.start >= publicRateLimitWindowMs)
            windows.delete(entry);
        }
        if (windows.size >= publicRateLimitMaximumKeys) windows.clear();
      }
      window = { start: at, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= ratePerWindow) return null;
    return Math.max(
      1,
      Math.ceil((window.start + publicRateLimitWindowMs - at) / 1000),
    );
  }

  const budgets: Record<PublicReadKind, number> = {
    ...publicReadBudgetsMs,
    ...options.budgetsMs,
  };
  const flights = new Map<string, Promise<unknown>>();

  /**
   * Decision 0147 memo + S207 single-flight: a 200 of one URL is shared
   * for 5 s; while a read of that URL is in flight every request joins it
   * (one upstream call, one shared answer or 503). The shared answer
   * settles at the budget (503 PUBLIC_UPSTREAM_TIMEOUT); the flight stays
   * registered until the underlying read itself settles, so a timed-out
   * read is never piled on, and a late success still fills the memo.
   */
  function shared(
    request: FastifyRequest,
    kind: PublicReadKind,
    read: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    const key = request.raw.url ?? request.url;
    const hit = memo.get(key);
    if (hit !== undefined && nowMs() - hit.at < publicResponseMemoMs) {
      return Promise.resolve(hit.body);
    }
    const inFlight = flights.get(key);
    if (inFlight !== undefined) return inFlight;
    const signal = AbortSignal.timeout(budgets[kind]);
    const underlying = Promise.resolve().then(() => read(signal));
    const answer = withDeadline(underlying, signal);
    flights.set(key, answer);
    // Every waiter handles `answer`; this keeps a flight nobody awaits
    // from becoming an unhandled rejection.
    answer.catch(() => undefined);
    underlying.then(
      (body) => {
        if (memo.size >= publicMemoMaximumEntries) memo.clear();
        memo.set(key, { at: nowMs(), body });
        if (flights.get(key) === answer) flights.delete(key);
      },
      () => {
        if (flights.get(key) === answer) flights.delete(key);
      },
    );
    return answer;
  }

  function sendOk(reply: FastifyReply, body: unknown) {
    if (publicReplyClosed(reply)) return reply;
    reply.header("cache-control", publicMemeCacheControl);
    return reply.code(200).send(body);
  }

  void app.register(
    (scope, _pluginOptions, pluginDone) => {
      scope.addHook(
        "onRequest",
        (
          request: FastifyRequest,
          reply: FastifyReply,
          done: HookHandlerDoneFunction,
        ) => {
          setCorsHeaders(reply);
          if (request.method === "OPTIONS") {
            done();
            return;
          }
          const retryAfter = admit(
            publicClientKey(request, trustProxy, clientIpHeaders),
          );
          if (retryAfter !== null) {
            reply.header("cache-control", "no-store");
            reply.header("retry-after", String(retryAfter));
            reply.header("x-ratelimit-limit", String(ratePerWindow));
            reply.header("x-ratelimit-remaining", "0");
            void reply.code(429).send({
              code: "RATE_LIMITED",
              reasonCode: launch2PublicReasonCodes.rateLimited,
            });
            return;
          }
          done();
        },
      );

      scope.setErrorHandler(async (error, request, reply) => {
        const projected = publicErrorOf(error);
        if (projected.code === "INTERNAL_ERROR") {
          request.log.error(
            {
              requestId: request.id,
              errorClass: error instanceof Error ? error.name : typeof error,
              errorCode: errorCodeOf(error),
              errorMessage: safeErrorMessage(error),
            },
            "Unhandled error in public request",
          );
        } else if (projected.statusCode === 503) {
          request.log.info(
            {
              requestId: request.id,
              reasonCode: projected.reasonCode,
              errorCode: errorCodeOf(error),
            },
            "Public read unavailable",
          );
        }
        if (publicReplyClosed(reply)) {
          // S207: never a second send (e.g. a late failure after the
          // framework's handler timeout) and never into a closed stream.
          return reply;
        }
        setCorsHeaders(reply);
        reply.header("cache-control", "no-store");
        return reply.code(projected.statusCode).send({
          code: projected.code,
          reasonCode: projected.reasonCode,
        });
      });

      scope.setNotFoundHandler(async (_request, reply) => {
        setCorsHeaders(reply);
        reply.header("cache-control", "no-store");
        return reply.code(404).send({
          code: "NOT_FOUND",
          reasonCode: launch2PublicReasonCodes.notFound,
        });
      });

      scope.options(
        "/*",
        { schema: { hide: true } },
        async (_request, reply) => {
          reply.header("access-control-allow-methods", "GET, OPTIONS");
          reply.header("access-control-allow-headers", "Content-Type");
          reply.header("access-control-max-age", "600");
          reply.header("cache-control", "no-store");
          return reply.code(204).send();
        },
      );

      scope.get(
        "/v1/meme",
        {
          schema: {
            operationId: "listPublicMemes",
            summary: "Public MEME list for the MEME web page",
            description:
              "Decision 0147. No authentication, no contract headers; CORS `*`, `Cache-Control: public, max-age=15`, per-IP rate limit. Activated launch2 instances, newest first. stage: all (default) | graduated | curve (not graduated); limit 1–50 (default 50). dynamic: the LoopDynamic Hook's armed() and current dynamic sell tax (bps) for a graduated LoopDynamic instance, null otherwise. A row whose Hook read is unavailable keeps dynamic null and names the 503 reason in dynamicReasonCode (the detail of that instance answers the 503).",
            tags: ["public"],
            querystring: {
              type: "object",
              properties: {
                stage: {
                  type: "string",
                  maxLength: 16,
                  description: "all (default) | graduated | curve",
                },
                limit: {
                  type: "string",
                  maxLength: 8,
                  description: "1–50, default 50",
                },
              },
            },
            response: {
              200: publicMemeListSchema,
              400: publicErrors[400],
              429: publicErrors[429],
              503: publicErrors[503],
            },
          },
        },
        async (request, reply) => {
          const query = request.query as Record<string, unknown>;
          const body = await shared(request, "list", (signal) =>
            options.service.listPublicMemes({
              signal,
              ...(query["stage"] === undefined
                ? {}
                : { stage: query["stage"] }),
              ...(query["limit"] === undefined
                ? {}
                : { limit: query["limit"] }),
            }),
          );
          return sendOk(reply, body);
        },
      );

      scope.get(
        "/v1/meme/:instanceId",
        {
          schema: {
            operationId: "getPublicMeme",
            summary: "One MEME's public page facts",
            description:
              "Decision 0147. instance (identity, contracts, explorer, socials from the creator's saved links), the bound community's public profile (null when none), the indexed last price with its 24 h change, dynamic (graduated LoopDynamic only: the Hook read at one block — armed, current round, current dynamic tax, pending pot = carry + the round's dynamic fees, last closed round; null for OfficialTax or before graduation), totals (curve 10 % tax, pool base buy fee in MEME / base sell fee in USD1, dynamic fees, USD1 equivalent at the last price, rewards allocated / claimed, buyback ledger). Hook read failures answer 503 with the launch2 reason as is.",
            tags: ["public"],
            params: instanceParamsSchema,
            response: {
              200: publicMemeDetailSchema,
              404: publicErrors[404],
              429: publicErrors[429],
              503: publicErrors[503],
            },
          },
        },
        async (request, reply) => {
          const { instanceId } = request.params as { instanceId: string };
          const body = await shared(request, "detail", (signal) =>
            options.service.getPublicMeme({ instanceId, signal }),
          );
          return sendOk(reply, body);
        },
      );

      scope.get(
        "/v1/meme/:instanceId/candles",
        {
          schema: {
            operationId: "listPublicMemeCandles",
            summary: "One MEME's public 5-minute candles",
            description:
              "Decision 0147. interval: 5m only (any other value 400 PUBLIC_CANDLE_INTERVAL_UNSUPPORTED); limit 1–300 (default 300), newest buckets, oldest first. Graduated: source pool — a LoopDynamic Hook's own CandleClosed candles (open / close, high / low widened to the bucket's swaps, volume = swap USD1), else the indexed pool swaps; not graduated: source curve — curve trades priced at the curve's marginal price after each trade, volume = USD1 gross. Prices are USD1 per MEME.",
            tags: ["public"],
            params: instanceParamsSchema,
            querystring: {
              type: "object",
              properties: {
                interval: { type: "string", maxLength: 16 },
                limit: { type: "string", maxLength: 8 },
              },
            },
            response: {
              200: publicMemeCandlesSchema,
              400: publicErrors[400],
              404: publicErrors[404],
              429: publicErrors[429],
              503: publicErrors[503],
            },
          },
        },
        async (request, reply) => {
          const { instanceId } = request.params as { instanceId: string };
          const query = request.query as Record<string, unknown>;
          const body = await shared(request, "candles", (signal) =>
            options.service.listPublicMemeCandles({
              instanceId,
              signal,
              ...(query["interval"] === undefined
                ? {}
                : { interval: query["interval"] }),
              ...(query["limit"] === undefined
                ? {}
                : { limit: query["limit"] }),
            }),
          );
          return sendOk(reply, body);
        },
      );
      pluginDone();
    },
    { prefix: "/public" },
  );
}
