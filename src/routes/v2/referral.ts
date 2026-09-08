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
import type { ReferralService } from "../../features/referral/referral-service.js";
import {
  assertNoBodyOrQueryV2,
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

const referralResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
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
    boost: unavailableSchema,
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
        summary: "Get the caller's invite code, binding, and level counts",
        description:
          "Issues the account's invite code on first read (one per account, random, unique). Counts per level are grouped by validationStatus; `valid` needs an approved Mining formula (D19), so the boost stays unavailable with MINING_FORMULA_BASELINE_PENDING. The claim window is [activatedAt, activatedAt + 7 days).",
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
