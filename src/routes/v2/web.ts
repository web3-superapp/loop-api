import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
  preHandlerAsyncHookHandler,
} from "fastify";

import {
  requireAuthenticatedLoopPrincipal,
  requireAuthenticatedPrivyPrincipal,
} from "../../core/http/authentication.js";
import {
  publicClientKey,
  type PublicClientIpHeaderName,
} from "../../core/http/client-ip.js";
import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { evmAddressPatternSource } from "../../features/chain/chain-contract.js";
import { loopIdPatternSource } from "../../features/identity/loop-id.js";
import { maximumRawTextLength } from "../../features/profile/profile-v2-contract.js";
import { inviteCodePatternSource } from "../../features/referral/invite-code.js";
import { referralDashboardPageSize } from "../../features/referral/referral-service.js";
import {
  parseWebWriteMetadata,
  webInviteeStatuses,
  webReasonCodes,
  webWriteHeadersSchema,
} from "../../features/web/web-registration-contract.js";
import type { WebRegistrationService } from "../../features/web/web-registration-service.js";
import type { WebRateLimiter } from "../../features/web/web-rate-limit.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  assertNoQuery,
} from "./community-schemas.js";

/**
 * Decision 0179: the web registration surface `/v2/web/*` for the LOOP
 * website (same Privy App as the App).
 *
 * CORS, only inside this scope: an `Origin` equal to one of `WEB_ORIGINS`
 * is echoed in `Access-Control-Allow-Origin` (never `*`, no credentials —
 * the Privy token travels in `Authorization`, never in a cookie); every
 * answer carries `Vary: Origin` and `Cross-Origin-Resource-Policy:
 * cross-origin` (helmet's `same-origin` would block the website). An
 * `OPTIONS` preflight is 204 with the allowed methods and headers when the
 * origin is listed, 204 without any `Access-Control-Allow-*` header when it
 * is not (the browser then refuses). Every other route stays same-origin.
 *
 * Errors keep the seven-field V2 envelope (the app-level `/v2` error
 * handler); refusals carry `detailsSafe.reasonCode`.
 */

export const webCorsAllowedMethods = "GET, POST, PUT, OPTIONS";
export const webCorsAllowedHeaders =
  "authorization, content-type, idempotency-key, x-loop-contract-version";
export const webCorsExposedHeaders = "retry-after, x-request-id";
export const webCorsMaxAgeSeconds = 600;

export interface WebRouteOptions {
  readonly service: WebRegistrationService;
  readonly origins: readonly string[];
  readonly authenticatePrivyBearer: preHandlerAsyncHookHandler;
  readonly authenticateLoopBearer: preHandlerAsyncHookHandler;
  /** Limiter of the unauthenticated invite preview. */
  readonly previewLimiter: WebRateLimiter;
  readonly trustProxy: boolean;
  readonly clientIpHeaders: readonly PublicClientIpHeaderName[];
}

const dateTimeSchema = { type: "string", format: "date-time" } as const;
const loopIdSchema = { type: "string", pattern: loopIdPatternSource } as const;
const nullableUsernameSchema = {
  anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
} as const;
const nullableUrlSchema = {
  anyOf: [{ type: "string", format: "uri", maxLength: 2048 }, { type: "null" }],
} as const;
const safeTextPattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const sessionResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "loopId",
    "username",
    "usernameRequired",
    "walletAddress",
    "invite",
    "observedAt",
  ],
  properties: {
    loopId: loopIdSchema,
    username: {
      ...nullableUsernameSchema,
      description: "The active profile's alias; null until a username is set.",
    },
    usernameRequired: {
      type: "boolean",
      description:
        "true while the profile is not activated: PUT /v2/web/profile/username before claiming an invite code.",
    },
    walletAddress: {
      anyOf: [
        { type: "string", pattern: evmAddressPatternSource },
        { type: "null" },
      ],
      description:
        "The wallet LOOP already knows for the account (selected, else earliest active); null until the App has synced one.",
    },
    invite: {
      type: "object",
      additionalProperties: false,
      required: ["bound", "windowEndsAt", "canClaim"],
      properties: {
        bound: { type: "boolean" },
        windowEndsAt: {
          anyOf: [dateTimeSchema, { type: "null" }],
          description:
            "End of the 7-day claim window (activation + 7 days); null before the username (activation).",
        },
        canClaim: {
          type: "boolean",
          description:
            "Not bound, the referral module is available, and the window is not closed. Before the username is set the window has not started yet: set the username first, then claim.",
        },
      },
    },
    observedAt: dateTimeSchema,
  },
} as const;

const usernameRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username"],
  properties: {
    username: {
      type: "string",
      minLength: 1,
      maxLength: maximumRawTextLength,
      pattern: safeTextPattern,
      description:
        "Same rule as the App alias: trimmed to 1-40 Unicode code points, no control / bidi / invisible formatting characters, not unique. Reserved words → 422 ALIAS_RESERVED, operator-blocked terms → 422 ALIAS_BLOCKED, over 40 code points → 422 VALIDATION_FAILED.",
    },
  },
} as const;

const usernameResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["username"],
  properties: { username: { type: "string", minLength: 1 } },
} as const;

const claimRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: {
      type: "string",
      minLength: 1,
      maxLength: 32,
      description:
        "LOOP-XXXXC invite code; case, the LOOP- prefix, and I/L/O look-alikes are normalised server-side.",
    },
  },
} as const;

const claimResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["bound", "already_bound"] },
    inviterLoopId: {
      ...loopIdSchema,
      description:
        "bound: the new inviter. already_bound: present only when the existing inviter owns the submitted code; another existing inviter is never identified.",
    },
  },
} as const;

const previewQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: { code: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

const previewResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["valid", "inviter"],
  properties: {
    valid: { type: "boolean" },
    inviter: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["username", "loopId"],
          properties: {
            username: nullableUsernameSchema,
            loopId: loopIdSchema,
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

const dashboardQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description:
        "The previous page's nextCursor (owner-bound, opaque). Omit for the first page.",
    },
  },
} as const;

const nonNegativeCountSchema = { type: "integer", minimum: 0 } as const;

const dashboardResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "code",
    "inviteLink",
    "stats",
    "invitees",
    "nextCursor",
    "inviter",
    "binding",
    "observedAt",
  ],
  properties: {
    code: {
      type: "string",
      pattern: inviteCodePatternSource,
      description:
        "The caller's own invite code (LOOP-XXXXC). Issued on the account's first invite-center read (App or website), before the username is set; never changes.",
    },
    inviteLink: {
      type: "string",
      format: "uri",
      description:
        "{PUBLIC_BASE_URL}/i/{code}, the same link the App shares (Universal Link / App Link; 302 to the website when WEB_BASE_URL is set).",
    },
    stats: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "direct",
            "valid",
            "deeper",
            "pendingVerification",
            "validAsOf",
          ],
          properties: {
            direct: {
              ...nonNegativeCountSchema,
              description: "Direct invitees in force (depth 1).",
            },
            valid: {
              ...nonNegativeCountSchema,
              description:
                "Direct invitees in force whose own mining power was > 0 in the newest settled hour.",
            },
            deeper: {
              ...nonNegativeCountSchema,
              description: "In-force relationships of depth 2 to 5.",
            },
            pendingVerification: {
              ...nonNegativeCountSchema,
              description: "direct - valid.",
            },
            validAsOf: {
              ...dateTimeSchema,
              description: "End of the settled hour `valid` is read from.",
            },
          },
        },
        { type: "null" },
      ],
      description:
        "Null before the first settled mining hour or when the figures cannot be read (unknown, never zeros).",
    },
    invitees: {
      type: "array",
      maxItems: referralDashboardPageSize,
      description:
        "Direct invitees (depth 1, in force and void), newest binding first; the App's invite list.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["loopId", "username", "depth", "status", "joinedAt"],
        properties: {
          loopId: {
            anyOf: [loopIdSchema, { type: "null" }],
            description: "Null when the invitee blocked the caller.",
          },
          username: {
            ...nullableUsernameSchema,
            description:
              "Active profile alias; null before the invitee set a username or when the invitee blocked the caller.",
          },
          depth: { type: "integer", minimum: 1, maximum: 1 },
          status: {
            type: "string",
            enum: webInviteeStatuses,
            description:
              "valid: own mining power > 0 in the newest settled hour; pending: in force, not (yet) valid; void: relationship invalidated.",
          },
          joinedAt: {
            ...dateTimeSchema,
            description: "Binding time of the relationship.",
          },
        },
      },
    },
    nextCursor: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      description:
        "Present when more invitees exist: GET again with ?cursor=. The other fields are re-read on every page.",
    },
    inviter: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["loopId", "username"],
          properties: {
            loopId: loopIdSchema,
            username: nullableUsernameSchema,
          },
        },
        { type: "null" },
      ],
      description: "The caller's direct inviter; null when unbound.",
    },
    binding: {
      type: "object",
      additionalProperties: false,
      required: ["bound", "windowEndsAt", "canClaim"],
      properties: {
        bound: { type: "boolean" },
        windowEndsAt: {
          anyOf: [dateTimeSchema, { type: "null" }],
          description:
            "Activation + 7 days; null before the username (activation).",
        },
        canClaim: {
          type: "boolean",
          description:
            "Not bound and the window is not closed (before the username: set it first, then claim).",
        },
      },
    },
    observedAt: dateTimeSchema,
  },
} as const;

const metaResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["appStore", "observedAt"],
  properties: {
    appStore: {
      type: "object",
      additionalProperties: false,
      required: ["ios", "android", "testflight"],
      properties: {
        ios: nullableUrlSchema,
        android: nullableUrlSchema,
        testflight: nullableUrlSchema,
      },
    },
    observedAt: dateTimeSchema,
  },
} as const;

const bearer401 = v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
  includeBearerChallenge: true,
});
const common500 = v2ErrorResponseSchema(["INTERNAL_ERROR"]);
const common503 = v2ErrorResponseSchema([
  "CAPABILITY_UNAVAILABLE",
  "PROVIDER_DISCONNECTED",
  "REQUEST_TIMEOUT",
]);

const optionalEmptyBodySchema = {
  anyOf: [
    { type: "object", additionalProperties: false, properties: {} },
    { type: "null" },
  ],
} as const;

function validateWriteHeaders(request: FastifyRequest): Promise<void> {
  parseWebWriteMetadata(request.raw.rawHeaders);
  return Promise.resolve();
}

function sendNoStore(reply: FastifyReply, body: unknown) {
  reply.header("cache-control", "no-store");
  return reply.code(200).send(body);
}

export function registerV2WebRoutes(
  app: FastifyInstance,
  options: WebRouteOptions,
): void {
  const allowed = new Set(options.origins);

  function applyCors(request: FastifyRequest, reply: FastifyReply): boolean {
    reply.header("vary", "origin");
    reply.header("cross-origin-resource-policy", "cross-origin");
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !allowed.has(origin)) return false;
    reply.header("access-control-allow-origin", origin);
    reply.header("access-control-expose-headers", webCorsExposedHeaders);
    return true;
  }

  function limitPreview(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    const retryAfter = options.previewLimiter.admit(
      publicClientKey(request, options.trustProxy, options.clientIpHeaders),
    );
    if (retryAfter === null) {
      done();
      return;
    }
    reply.header("retry-after", String(retryAfter));
    reply.header("x-ratelimit-limit", String(options.previewLimiter.perWindow));
    reply.header("x-ratelimit-remaining", "0");
    done(
      V2ApiError.fromCode("RATE_LIMITED", {
        reasonCode: webReasonCodes.rateLimited,
        retryAfterSeconds: retryAfter,
      }),
    );
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
          applyCors(request, reply);
          done();
        },
      );

      scope.options(
        "/*",
        { schema: { hide: true } },
        async (request, reply) => {
          reply.header("cache-control", "no-store");
          if (applyCors(request, reply)) {
            reply.header("access-control-allow-methods", webCorsAllowedMethods);
            reply.header("access-control-allow-headers", webCorsAllowedHeaders);
            reply.header(
              "access-control-max-age",
              String(webCorsMaxAgeSeconds),
            );
          }
          return reply.code(204).send();
        },
      );

      scope.post(
        "/session",
        {
          schema: {
            operationId: "createWebSession",
            summary: "Sign in on the website: get or create the LOOP account",
            description:
              "Decision 0179. Verifies the Privy access token (same Privy App and verifier as the App). The first call for a Privy user creates the LOOP account and its LOOP ID; later calls (website or App) return the same account. No App device session is created and no device / platform / client-version header is read. Idempotency-Key is required and validated; the operation is naturally idempotent (get-or-create).",
            tags: ["web"],
            security: [{ privyBearer: [] }],
            headers: webWriteHeadersSchema,
            body: optionalEmptyBodySchema,
            response: {
              200: sessionResponseSchema,
              400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
              401: bearer401,
              409: v2ErrorResponseSchema(["VERSION_CONFLICT"]),
              500: common500,
              503: common503,
            },
          },
          onRequest: validateWriteHeaders,
          preValidation: assertNoQuery,
          preHandler: options.authenticatePrivyBearer,
        },
        async (request, reply) =>
          sendNoStore(
            reply,
            await options.service.session({
              principal: requireAuthenticatedPrivyPrincipal(request),
            }),
          ),
      );

      scope.put(
        "/profile/username",
        {
          schema: {
            operationId: "setWebUsername",
            summary: "Set the LOOP username (profile alias)",
            description:
              "Decision 0179. Same rules and services as the App: a pending profile is activated with this alias (the App's one-time activation command; the Idempotency-Key replays it, the same key with another username is 409 IDEMPOTENCY_CONFLICT); an active profile has its alias replaced (compare-and-swap, one automatic retry on a concurrent edit; setting the current name is a no-op). Activation starts the 7-day invite-claim window. 409 ACCOUNT_BOOTSTRAP_REQUIRED before POST /v2/web/session.",
            tags: ["web"],
            security: [{ privyBearer: [] }],
            headers: webWriteHeadersSchema,
            body: usernameRequestSchema,
            response: {
              200: usernameResponseSchema,
              400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
              401: bearer401,
              409: v2ErrorResponseSchema([
                "ACCOUNT_BOOTSTRAP_REQUIRED",
                "IDEMPOTENCY_CONFLICT",
                "VERSION_CONFLICT",
              ]),
              422: v2ErrorResponseSchema([
                "ALIAS_BLOCKED",
                "ALIAS_RESERVED",
                "VALIDATION_FAILED",
              ]),
              500: common500,
              503: common503,
            },
          },
          onRequest: validateWriteHeaders,
          preValidation: assertNoQuery,
          preHandler: options.authenticateLoopBearer,
        },
        async (request, reply) => {
          const body = request.body as { readonly username: string };
          return sendNoStore(
            reply,
            await options.service.setUsername({
              principal: requireAuthenticatedLoopPrincipal(request),
              username: body.username,
              metadata: parseWebWriteMetadata(request.raw.rawHeaders),
              requestId: request.id,
            }),
          );
        },
      );

      scope.post(
        "/referral/claim",
        {
          schema: {
            operationId: "claimWebReferral",
            summary: "Bind the account to an inviter with an invite code",
            description:
              "Decision 0179. The App's claim service and every check unchanged: once per account, only after the username (activation) and inside the 7-day window, not the caller's own code, no cycle; edges up to depth 5 in one transaction; the same Idempotency-Key replays the original result. An account that is already bound gets 200 already_bound (no write). Refusals carry detailsSafe.reasonCode: 400 REFERRAL_CODE_INVALID, 404 REFERRAL_CODE_UNKNOWN, 403 REFERRAL_CLAIM_WINDOW_CLOSED, 409 PROFILE_ACTIVATION_REQUIRED, 422 REFERRAL_SELF_INVITE | REFERRAL_CYCLE.",
            tags: ["web"],
            security: [{ privyBearer: [] }],
            headers: webWriteHeadersSchema,
            body: claimRequestSchema,
            response: {
              200: claimResponseSchema,
              400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
              401: bearer401,
              403: v2ErrorResponseSchema(["POLICY_BLOCKED"]),
              404: v2ErrorResponseSchema(["NOT_FOUND"]),
              409: v2ErrorResponseSchema([
                "ACCOUNT_BOOTSTRAP_REQUIRED",
                "DATA_STALE",
                "IDEMPOTENCY_CONFLICT",
                "PROFILE_ACTIVATION_REQUIRED",
                "VERSION_CONFLICT",
              ]),
              422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
              500: common500,
              503: common503,
            },
          },
          onRequest: validateWriteHeaders,
          preValidation: assertNoQuery,
          preHandler: options.authenticateLoopBearer,
        },
        async (request, reply) => {
          const body = request.body as { readonly code: string };
          return sendNoStore(
            reply,
            await options.service.claim({
              principal: requireAuthenticatedLoopPrincipal(request),
              code: body.code,
              metadata: parseWebWriteMetadata(request.raw.rawHeaders),
              requestId: request.id,
            }),
          );
        },
      );

      scope.get(
        "/referral/preview",
        {
          schema: {
            operationId: "previewWebInviteCode",
            summary: "Who invited me: the owner of an invite code",
            description:
              "Decision 0179. No authentication, no contract headers. valid=false (inviter null) for a malformed or unknown code; otherwise the owner's LOOP ID and username (null until the owner activated a profile). Nothing else about the owner is published. Per-visitor fixed one-minute window (PUBLIC_RATE_LIMIT_PER_MINUTE, the Decision 0147 limiter): 429 RATE_LIMITED / WEB_RATE_LIMITED with Retry-After.",
            tags: ["web"],
            querystring: previewQuerySchema,
            response: {
              200: previewResponseSchema,
              400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
              429: v2ErrorResponseSchema(["RATE_LIMITED"]),
              500: common500,
              503: v2ErrorResponseSchema(["CAPABILITY_UNAVAILABLE"]),
            },
          },
          onRequest: limitPreview,
        },
        async (request, reply) => {
          const query = request.query as { readonly code: string };
          return sendNoStore(
            reply,
            await options.service.preview({ code: query.code }),
          );
        },
      );

      scope.get(
        "/referral/me",
        {
          schema: {
            operationId: "getWebReferralDashboard",
            summary: "My invites: code, link, counts, invitees, inviter",
            description:
              "Decision 0180. Bearer only (no contract, idempotency, or device headers are read). The App's invite-center reads: the invite code is issued on the first read (also before the username), stats use the Decision 0162 source (valid = the invitee's own power > 0 in the newest settled hour), invitees are the direct ones newest first, 100 a page with an owner-bound cursor. Invitees show only LOOP ID and username. 409 ACCOUNT_BOOTSTRAP_REQUIRED before POST /v2/web/session; 503 V2_REFERRAL_MODULE_DEFERRED / V2_CURSOR_NOT_CONFIGURED / WEB_REPOSITORY_UNAVAILABLE.",
            tags: ["web"],
            security: [{ privyBearer: [] }],
            querystring: dashboardQuerySchema,
            response: {
              200: dashboardResponseSchema,
              400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
              401: bearer401,
              409: v2ErrorResponseSchema(["ACCOUNT_BOOTSTRAP_REQUIRED"]),
              500: common500,
              503: common503,
            },
          },
          preValidation: assertNoBodyV2,
          preHandler: options.authenticateLoopBearer,
        },
        async (request, reply) => {
          const query = request.query as { readonly cursor?: string };
          return sendNoStore(
            reply,
            await options.service.referralDashboard({
              principal: requireAuthenticatedLoopPrincipal(request),
              requestId: request.id,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            }),
          );
        },
      );

      scope.get(
        "/meta",
        {
          schema: {
            operationId: "getWebMeta",
            summary: "Download links of the LOOP app",
            description:
              "Decision 0179. No authentication, no contract headers. WEB_APP_LINKS_IOS / WEB_APP_LINKS_ANDROID / WEB_APP_LINKS_TESTFLIGHT (https), null when not configured.",
            tags: ["web"],
            response: {
              200: metaResponseSchema,
              400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
              500: common500,
            },
          },
          preValidation: assertNoBodyOrQueryV2,
        },
        async (_request, reply) => sendNoStore(reply, options.service.meta()),
      );

      pluginDone();
    },
    { prefix: "/v2/web" },
  );
}
