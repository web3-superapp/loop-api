import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { launchChainIds } from "../../features/chain/chain-contract.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import {
  createV2CapabilitiesProjection,
  createV2ClientPolicyProjection,
  v2CapabilityIds,
  v2ContractVersion,
  v2PolicyNotYetEffectiveReasonCode,
  v2ProductConfigVersion,
  v2ProductEffectiveAt,
  type V2ProductPolicyRuntime,
} from "../../features/meta/product-policy.js";
import {
  clientVersionMaximumLength,
  clientVersionMinimumLength,
  clientVersionSemver2PatternSource,
} from "../../features/session/client-version.js";
import { createV2AboutProjection } from "../../features/meta/about.js";
import {
  openSourceAttributionEntries,
  openSourceAttributionSource,
  openSourceAttributionSummary,
} from "../../features/meta/open-source-attribution.js";

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
      enum: [
        "CLIENT_VERSION_POLICY_UNAVAILABLE",
        v2PolicyNotYetEffectiveReasonCode,
      ],
      description:
        "POLICY_NOT_YET_EFFECTIVE means a complete policy exists but its effectiveAt is still in the future.",
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
    reasonCode: {
      type: "string",
      enum: ["TERMS_POLICY_UNAVAILABLE", v2PolicyNotYetEffectiveReasonCode],
    },
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
      minItems: v2CapabilityIds.length,
      maxItems: v2CapabilityIds.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capabilityId", "availability", "reasonCode", "evidence"],
        properties: {
          capabilityId: {
            type: "string",
            enum: [...v2CapabilityIds],
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
              launchChainId: {
                type: "string",
                enum: [...launchChainIds],
                description:
                  "Present on the launch capability only (Decision 0038): the chain slot the Launch module points at.",
              },
            },
          },
        },
      },
    },
  },
} as const;

const aboutResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "contractVersion",
    "configVersions",
    "termsGate",
    "openSource",
    "clientBuild",
  ],
  properties: {
    contractVersion: { type: "string", const: v2ContractVersion },
    configVersions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["module", "configVersion", "effectiveAt"],
        properties: {
          module: { type: "string", pattern: "^[a-z][A-Za-z0-9]{0,63}$" },
          configVersion: configVersionSchema,
          effectiveAt: {
            anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
          },
        },
      },
      description:
        "Every mutable rule snapshot the backend publishes. Consumers display them; they must not pin them.",
    },
    termsGate: {
      oneOf: [termsGateUnavailableSchema, termsGateAvailableSchema],
    },
    openSource: {
      type: "object",
      additionalProperties: false,
      required: ["source", "summary", "entries"],
      properties: {
        source: { type: "string", const: openSourceAttributionSource },
        summary: { type: "string", const: openSourceAttributionSummary },
        entries: {
          type: "array",
          minItems: openSourceAttributionEntries.length,
          maxItems: openSourceAttributionEntries.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "purpose", "license"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 128 },
              purpose: { type: "string", minLength: 1, maxLength: 256 },
              license: { type: "string", minLength: 1, maxLength: 64 },
            },
          },
        },
      },
    },
    clientBuild: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode"],
      properties: {
        status: { type: "string", const: "local" },
        reasonCode: { type: "string", const: "CLIENT_BUILD_IS_DEVICE_LOCAL" },
      },
      description:
        "The app version and build number are known only to the device; the backend never reports them.",
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
  runtime: V2ProductPolicyRuntime,
): void {
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
      return reply
        .code(200)
        .send(createV2ClientPolicyProjection(config, new Date()));
    },
  );

  app.get(
    "/v2/meta/about",
    {
      schema: {
        operationId: "getV2About",
        summary: "Get the public about/legal projection",
        description:
          "Public, no token: contract version, every published configVersion, the terms gate slot, and the open-source attribution summary compiled from docs/open-source-attribution.md.",
        tags: ["meta"],
        querystring: emptyQueryStringSchema,
        response: {
          200: aboutResponseSchema,
          ...metaErrorResponses,
        },
      },
      preValidation: assertNoBodyOrQuery,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply.code(200).send(createV2AboutProjection(config, new Date()));
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
      // Evaluated per request, exactly like the client policy: chain
      // verification is probed asynchronously, so a projection captured at
      // composition time would keep reporting a stale pending or unreachable
      // state after the endpoint recovered.
      reply.header("cache-control", "no-store");
      return reply
        .code(200)
        .send(createV2CapabilitiesProjection(config, runtime));
    },
  );
}
