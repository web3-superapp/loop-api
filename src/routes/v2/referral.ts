import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  noStoreResponseHeaders,
  emptyQueryStringSchema,
} from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { inviteCodePatternSource } from "../../features/referral/invite-code.js";
import {
  referralMaximumDepth,
  referralValidationStatuses,
} from "../../features/referral/referral-contract.js";
import { referralInviteeStatuses } from "../../features/referral/referral-repository.js";
import {
  referralInviteePaging,
  type ReferralService,
} from "../../features/referral/referral-service.js";
import {
  opaqueIdPatternSource,
  storedAvatarRefPatternSource,
} from "../../features/community/community-contract.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  assertNoQuery,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import { unavailableSchema } from "./launch-schemas.js";

/**
 * V2 referral module routes (D19 relationship slice, Decision 0036).
 * Registered only when `V2_MODULES_ENABLED` contains `referral`.
 */

const dateTimeSchema = { type: "string", format: "date-time" } as const;

const claimWindowSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "activatedAt", "closesAt"],
      properties: {
        status: { type: "string", enum: ["open", "closed"] },
        activatedAt: dateTimeSchema,
        closesAt: dateTimeSchema,
      },
    },
    unavailableSchema,
  ],
} as const;

const bindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "inviter", "claimWindow"],
  properties: {
    status: { type: "string", enum: ["bound", "unbound"] },
    inviter: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "depth",
            "validationStatus",
            "lockedAt",
            "effectiveFrom",
            "configVersion",
          ],
          properties: {
            depth: { type: "integer", const: 1 },
            validationStatus: {
              type: "string",
              enum: [...referralValidationStatuses],
            },
            lockedAt: dateTimeSchema,
            effectiveFrom: dateTimeSchema,
            configVersion: {
              type: "string",
              pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            },
          },
        },
        { type: "null" },
      ],
      description:
        "The inviter is never identified: only the binding state, its validation status, and its lock time are published.",
    },
    claimWindow: claimWindowSchema,
  },
} as const;

const powerSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,18})?$",
} as const;

/** Decision 0162: the referral power of the newest settled hour. */
const boostAvailableSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "referralPower",
    "nftReferralPower",
    "assetReferralPower",
    "levels",
    "epochId",
    "hourStart",
    "hourEnd",
  ],
  properties: {
    status: { type: "string", const: "available" },
    referralPower: {
      ...powerSchema,
      description:
        "nftReferralPower + assetReferralPower of the newest settled hour (Mining Power, not money). 0 when the caller had no row in that hour.",
    },
    nftReferralPower: powerSchema,
    assetReferralPower: powerSchema,
    levels: {
      type: "array",
      minItems: referralMaximumDepth,
      maxItems: referralMaximumDepth,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "effectiveMembers", "nftPower", "assetPower"],
        properties: {
          level: { type: "integer", minimum: 1, maximum: referralMaximumDepth },
          effectiveMembers: {
            type: "integer",
            minimum: 0,
            description:
              "Members of this level with self power > 0 in the hour.",
          },
          nftPower: powerSchema,
          assetPower: powerSchema,
        },
      },
    },
    epochId: { type: "string", format: "uuid" },
    hourStart: dateTimeSchema,
    hourEnd: dateTimeSchema,
  },
} as const;

const referralStatsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["directCount", "validCount", "level2to5Count", "validAsOf"],
  properties: {
    directCount: {
      type: "integer",
      minimum: 0,
      description: "Direct invitees in force (depth 1, not invalidated).",
    },
    validCount: {
      type: "integer",
      minimum: 0,
      description:
        "Direct invitees in force whose own (self) power was > 0 in the newest settled hour (docs/38 §5.2 有效成员). 0 before the first settled hour.",
    },
    level2to5Count: {
      type: "integer",
      minimum: 0,
      description: "In-force relationships of depth 2..5.",
    },
    validAsOf: {
      anyOf: [dateTimeSchema, { type: "null" }],
      description:
        "hourEnd of the settled hour validCount was read from; null before the first one.",
    },
  },
} as const;

const inviteesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: {
      type: "string",
      minLength: 3,
      maxLength: 1_536,
      pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: referralInviteePaging.maximumLimit,
      description: `Default ${String(referralInviteePaging.defaultLimit)}. Not allowed together with cursor.`,
    },
  },
} as const;

const inviteeListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: referralInviteePaging.maximumLimit,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "publicProfileId",
          "alias",
          "avatarRef",
          "boundAt",
          "validationStatus",
        ],
        properties: {
          publicProfileId: {
            anyOf: [
              { type: "string", pattern: opaqueIdPatternSource },
              { type: "null" },
            ],
            description:
              "Opens GET /v2/public-profiles/{publicProfileId}. Null when the invitee has no active profile or has blocked the caller (the row is still listed).",
          },
          alias: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: 1024 },
              { type: "null" },
            ],
            description:
              "Shown as is, never masked: `discoverable` only governs search (Decision 0096 / docs/09 B9), the same rule message requests follow.",
          },
          avatarRef: {
            anyOf: [
              { type: "string", pattern: storedAvatarRefPatternSource },
              { type: "null" },
            ],
          },
          boundAt: {
            ...dateTimeSchema,
            description: "When the invitee claimed the caller's code.",
          },
          validationStatus: {
            type: "string",
            enum: [...referralInviteeStatuses],
            description:
              "valid = own power > 0 in the newest settled hour; invalid = the relationship was invalidated; pending = anything else (no settled hour yet, or no own power).",
          },
        },
      },
    },
    nextCursor: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const referralResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  // Decision 0166: inviteLink / stats are optional (REFERRAL_CENTER_EMIT).
  required: [
    "inviteCode",
    "binding",
    "levels",
    "boost",
    "rules",
    "contractVersion",
  ],
  properties: {
    inviteCode: {
      type: "object",
      additionalProperties: false,
      required: ["code", "issuedAt"],
      properties: {
        code: { type: "string", pattern: inviteCodePatternSource },
        issuedAt: dateTimeSchema,
      },
    },
    inviteLink: {
      type: "string",
      format: "uri",
      description:
        "Decision 0162: {PUBLIC_BASE_URL}/i/{code}. With LOOP installed the system opens the app (Universal Link / App Link, path /i/*); otherwise a landing page offers copy-code-and-download. Decision 0166: OPTIONAL key — sent only with REFERRAL_CENTER_EMIT=on (default off); the server may enable it only once every supported client is at build >= 31.",
    },
    binding: bindingSchema,
    levels: {
      type: "array",
      minItems: referralMaximumDepth,
      maxItems: referralMaximumDepth,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "boostPercent", "counts", "total"],
        properties: {
          level: { type: "integer", minimum: 1, maximum: referralMaximumDepth },
          boostPercent: { type: "string", pattern: "^(0|[1-9][0-9]?)$" },
          counts: {
            type: "object",
            additionalProperties: false,
            required: [...referralValidationStatuses],
            properties: Object.fromEntries(
              referralValidationStatuses.map((status) => [
                status,
                { type: "integer", minimum: 0 },
              ]),
            ) as Record<
              (typeof referralValidationStatuses)[number],
              { readonly type: "integer"; readonly minimum: 0 }
            >,
          },
          total: { type: "integer", minimum: 0 },
        },
      },
    },
    stats: {
      ...referralStatsSchema,
      description:
        "Decision 0162: direct / valid / depth 2..5 counts. Decision 0166: OPTIONAL key — sent only with REFERRAL_CENTER_EMIT=on (default off); the server may enable it only once every supported client is at build >= 31.",
    },
    boost: {
      anyOf: [boostAvailableSchema, unavailableSchema],
      description:
        "Decision 0162: available from the newest settled mining hour; unavailable MINING_REFERRAL_BOOST_PENDING before the first one. Decision 0166: with REFERRAL_CENTER_EMIT off (default) always unavailable MINING_REFERRAL_BOOST_PENDING (builds <= 30 decode only that branch).",
    },
    rules: {
      type: "object",
      additionalProperties: false,
      required: [
        "configVersion",
        "effectiveAt",
        "appliesTo",
        "maximumDepth",
        "claimWindowDays",
      ],
      properties: {
        configVersion: { type: "string", const: "referralRulesV1" },
        effectiveAt: dateTimeSchema,
        appliesTo: { type: "string", const: "miningPower" },
        maximumDepth: { type: "integer", const: referralMaximumDepth },
        claimWindowDays: { type: "integer", const: 7 },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const claimRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inviteCode"],
  properties: {
    inviteCode: {
      type: "string",
      minLength: 5,
      maxLength: 32,
      description:
        "LOOP-XXXXC (four Crockford Base32 symbols plus one check symbol). Case and the prefix are normalised server-side.",
    },
  },
} as const;

const claimResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["binding", "contractVersion"],
  properties: {
    binding: bindingSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const readErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "VERSION_CONFLICT",
  ]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema(["CAPABILITY_UNAVAILABLE", "REQUEST_TIMEOUT"]),
} as const;

const claimErrors = {
  ...readErrors,
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
} as const;

function commandContext(request: FastifyRequest): {
  readonly idempotencyKey: string;
  readonly requestId: string;
} {
  return {
    idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
      .idempotencyKey,
    requestId: request.id,
  };
}

export function registerV2ReferralRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer } = dependencies;
  const service: ReferralService = dependencies.referralService;

  app.get(
    "/v2/referral",
    {
      schema: {
        operationId: "getV2Referral",
        summary:
          "Get the caller's invite code, link, binding, counts, and boost",
        description:
          "Issues the account's invite code on first read (one per account, random, unique, LOOP-XXXXC). Decision 0162 adds `inviteLink` ({PUBLIC_BASE_URL}/i/{code}), `stats` (direct / valid / depth 2..5 counts; valid = own power > 0 in the newest settled hour) and an available `boost` (the caller's referral power of the newest settled mining hour, all five levels). Before the first settled hour the boost stays unavailable with MINING_REFERRAL_BOOST_PENDING (Decision 0046). Decision 0162 §E: in `levels[].counts`, `valid` uses the same source as `stats.validCount` (the invitee's own power > 0 in the newest settled hour); every other in-force edge keeps its stored pending_* status. The claim window is [activatedAt, activatedAt + 7 days).",
        tags: ["referral"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: referralResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.getReferral({
        principal: requireAuthenticatedLoopPrincipal(request),
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/referral/invitees",
    {
      schema: {
        operationId: "listV2ReferralInvitees",
        summary: "List the caller's direct invitees",
        description:
          "Decision 0162: depth-1 relationships of the caller (in force and invalidated), newest binding first, keyset paged with an owner-bound cursor (cursor and limit are exclusive). Profiles are shown as is (discoverable governs search only); a profile is null when the invitee blocked the caller. 503 CAPABILITY_UNAVAILABLE / V2_CURSOR_NOT_CONFIGURED without the cursor secret.",
        tags: ["referral"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: inviteesQuerySchema,
        response: { 200: inviteeListResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listInvitees({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/referral/claim",
    {
      schema: {
        operationId: "claimV2Referral",
        summary: "Bind the caller to an inviter with an invite code",
        description:
          "Allowed once, only for an activated profile inside its 7-day window. Unactivated → 409 PROFILE_ACTIVATION_REQUIRED; window closed → 403 POLICY_BLOCKED; unknown code → 404; self-invite or cycle → 422 VALIDATION_FAILED; already bound → 409 DATA_STALE. Edges are materialised from the inviter chain up to depth 5 in one transaction; the same Idempotency-Key replays the original result.",
        tags: ["referral"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: claimRequestSchema,
        response: { 200: claimResourceSchema, ...claimErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.claim({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        ...commandContext(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
