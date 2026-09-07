import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import {
  createV2ProductPolicyProjection,
  v2ContractVersion,
  v2ProductConfigVersion,
  v2ProductEffectiveAt,
} from "../../features/meta/product-policy.js";
import {
  clientVersionMaximumLength,
  clientVersionMinimumLength,
  clientVersionSemver2PatternSource,
} from "../../features/session/client-version.js";

const nullableUrlSchema = {
  anyOf: [
    { type: "string", format: "uri", minLength: 1, maxLength: 2_048 },
    { type: "null" },
  ],
} as const;

const nullableReasonCodeSchema = {
  anyOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Z][A-Z0-9_]*$",
    },
    { type: "null" },
  ],
} as const;

const semverSchema = {
  type: "string",
  minLength: clientVersionMinimumLength,
  maxLength: clientVersionMaximumLength,
  pattern: clientVersionSemver2PatternSource,
} as const;

const httpsUrlSchema = {
  type: "string",
  format: "uri",
  minLength: 9,
  maxLength: 2_048,
  pattern: "^https://",
} as const;

const platformValuesSchema = <T>(value: T) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["ios", "android"],
    properties: { ios: value, android: value },
  }) as const;

const configVersionSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
} as const;

/**
 * Version gate variants with exact, disjoint key sets (Decision 0029). The
 * available variant is emitted only when the complete fail-closed version
 * policy is configured.
 */
const versionGateUnavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "minimumSupportedVersions", "storeUrls", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    minimumSupportedVersions: platformValuesSchema({ type: "null" }),
    storeUrls: platformValuesSchema({ type: "null" }),
    reasonCode: {
      type: "string",
      const: "CLIENT_VERSION_POLICY_UNAVAILABLE",
    },
  },
} as const;

const versionGateAvailableSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "minimumSupportedVersions",
    "forceUpdateBelow",
    "storeUrls",
    "reasonCode",
  ],
  properties: {
    status: { type: "string", const: "available" },
    minimumSupportedVersions: platformValuesSchema(semverSchema),
    forceUpdateBelow: platformValuesSchema(semverSchema),
    storeUrls: platformValuesSchema(httpsUrlSchema),
    reasonCode: { type: "null" },
  },
} as const;

const termsGateUnavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "requiredVersion", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    requiredVersion: { type: "null" },
    reasonCode: { type: "string", const: "TERMS_POLICY_UNAVAILABLE" },
  },
} as const;

const termsGateAvailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "requiredVersion", "reasonCode"],
  properties: {
    status: { type: "string", const: "available" },
    requiredVersion: { type: "string", minLength: 1, maxLength: 128 },
    reasonCode: { type: "null" },
  },
} as const;

const clientPolicyResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "contractVersion",
    "configVersion",
    "effectiveAt",
    "defaultRoute",
    "navigation",
    "versionGate",
    "regionGate",
    "termsGate",
  ],
  properties: {
    contractVersion: { type: "string", const: v2ContractVersion },
    configVersion: configVersionSchema,
    effectiveAt: { type: "string", format: "date-time" },
    defaultRoute: { type: "string", const: "community" },
    navigation: {
      type: "object",
      additionalProperties: false,
      required: ["primaryTabs"],
      properties: {
        primaryTabs: {
          type: "array",
          minItems: 5,
          maxItems: 5,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["community", "mining", "launch", "market", "wallet"],
          },
        },
      },
    },
    versionGate: {
      oneOf: [versionGateUnavailableSchema, versionGateAvailableSchema],
    },
    regionGate: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode", "supportUrl", "readOnlyAssetAccess"],
      properties: {
        status: {
          type: "string",
          enum: ["allowed", "blocked", "unavailable"],
        },
        reasonCode: nullableReasonCodeSchema,
        supportUrl: nullableUrlSchema,
        readOnlyAssetAccess: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
      },
    },
    termsGate: {
      oneOf: [termsGateUnavailableSchema, termsGateAvailableSchema],
    },
  },
} as const;

const capabilitiesResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["contractVersion", "configVersion", "effectiveAt", "capabilities"],
  properties: {
    contractVersion: { type: "string", const: v2ContractVersion },
    configVersion: { type: "string", const: v2ProductConfigVersion },
    effectiveAt: {
      type: "string",
      format: "date-time",
      const: v2ProductEffectiveAt,
    },
    capabilities: {
      type: "array",
      minItems: 16,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capabilityId", "availability", "reasonCode", "evidence"],
        properties: {
          capabilityId: {
            type: "string",
            enum: [
              "privyAuthentication",
              "accountSession",
              "streamChatToken",
              "streamVideoToken",
              "community",
              "bscRead",
              "walletRead",
              "privySwap",
              "sendApprovals",
              "launch",
              "mining",
              "pushNotifications",
              "pay",
              "bridge",
              "dappExecution",
              "communityAi",
            ],
          },
          availability: {
            type: "string",
            enum: ["available", "deferred", "unavailable"],
          },
          reasonCode: nullableReasonCodeSchema,
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["status", "reasonCode"],
            properties: {
              status: {
                type: "string",
                enum: ["notApplicable", "pending"],
              },
              reasonCode: nullableReasonCodeSchema,
            },
          },
        },
      },
    },
  },
} as const;

const metaErrorResponses = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema(["REQUEST_TIMEOUT"]),
} as const;

export function registerV2MetaRoutes(
  app: FastifyInstance,
  config: AppConfig,
  sessionRuntimeAvailable: boolean,
): void {
  const projection = createV2ProductPolicyProjection(
    config,
    sessionRuntimeAvailable,
  );

  app.get(
    "/v2/meta/client-policy",
    {
      schema: {
        operationId: "getV2ClientPolicy",
        summary: "Get the versioned LOOP client policy baseline",
        description:
          "Returns the Development client policy projection. An unavailable gate is unknown and must not be interpreted as approval.",
        tags: ["meta"],
        querystring: emptyQueryStringSchema,
        response: {
          200: clientPolicyResponseSchema,
          ...metaErrorResponses,
        },
      },
      preValidation: assertNoBodyOrQuery,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply.code(200).send(projection.clientPolicy);
    },
  );

  app.get(
    "/v2/meta/capabilities",
    {
      schema: {
        operationId: "getV2Capabilities",
        summary: "Get fail-closed LOOP module capability projections",
        description:
          "Reports backend configuration and external-evidence state separately. Availability here is not production-integration evidence.",
        tags: ["meta"],
        querystring: emptyQueryStringSchema,
        response: {
          200: capabilitiesResponseSchema,
          ...metaErrorResponses,
        },
      },
      preValidation: assertNoBodyOrQuery,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply.code(200).send(projection.capabilities);
    },
  );
}
