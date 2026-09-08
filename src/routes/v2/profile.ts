import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import { loopIdPatternSource } from "../../features/identity/loop-id.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  avatarPeopleSlotCount,
  avatarPresetRefPatternSource,
  avatarPresets,
} from "../../features/profile/avatar-presets.js";
import {
  maximumBioCodePoints,
  maximumInterests,
  maximumRawTextLength,
  maximumRecordVersion,
  privacyVisibilityValues,
  profileInterestValues,
  profileStatusValues,
} from "../../features/profile/profile-v2-contract.js";
import {
  parseV2CommonRequestMetadata,
  parseV2WriteRequestMetadata,
  parseV2SessionWriteMetadata,
  v2CommonHeadersSchema,
  v2SessionHeaderNames,
  v2SessionWriteHeadersSchema,
} from "../../features/session/session-contract.js";
import type { V2ModuleRegistrar } from "./index.js";

const safeTextPattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const nullableAliasInputSchema = {
  anyOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: maximumRawTextLength,
      pattern: safeTextPattern,
      description:
        "Trimmed to 1-40 Unicode code points; control, bidirectional-control, and invisible formatting characters are rejected. Reserved words return ALIAS_RESERVED and operator-blocked terms return ALIAS_BLOCKED.",
    },
    { type: "null" },
  ],
} as const;

const aliasInputSchema = nullableAliasInputSchema.anyOf[0];

const nullableBioInputSchema = {
  anyOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: maximumRawTextLength,
      pattern: safeTextPattern,
      description: `Trimmed to 1-${maximumBioCodePoints} Unicode code points with the same character safety rules as alias.`,
    },
    { type: "null" },
  ],
} as const;

const nullableAvatarRefSchema = {
  anyOf: [
    {
      type: "string",
      pattern: avatarPresetRefPatternSource,
      maxLength: 64,
      description:
        "One preset avatar reference from GET /v2/profile/avatars. Upload is unavailable (AVATAR_STORAGE_NOT_SELECTED), so no other reference is accepted.",
    },
    { type: "null" },
  ],
} as const;

const nullableStoredAvatarRefSchema = {
  anyOf: [
    {
      type: "string",
      pattern: "^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$",
      maxLength: 134,
      description:
        "Opaque LOOP avatar reference. Values written through the frozen V1 contract may fall outside the preset catalog.",
    },
    { type: "null" },
  ],
} as const;

const interestsInputSchema = {
  type: "array",
  maxItems: maximumInterests,
  items: { type: "string", enum: [...profileInterestValues] },
  description: "Interest tracks; duplicates are removed server-side.",
} as const;

const interestsSchema = {
  type: "array",
  maxItems: maximumInterests,
  uniqueItems: true,
  items: { type: "string", enum: [...profileInterestValues] },
} as const;

const versionSchema = {
  type: "integer",
  minimum: 0,
  maximum: maximumRecordVersion,
} as const;

const nullableDateTimeSchema = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;

const profileProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "loopId",
    "alias",
    "avatarRef",
    "bio",
    "interests",
    "profileStatus",
    "activatedAt",
  ],
  properties: {
    loopId: {
      type: "string",
      pattern: loopIdPatternSource,
      description:
        "Server-assigned immutable public LOOP ID; presentation identity, never an authorization key.",
    },
    alias: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumRawTextLength },
        { type: "null" },
      ],
    },
    avatarRef: nullableStoredAvatarRefSchema,
    bio: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumRawTextLength },
        { type: "null" },
      ],
    },
    interests: interestsSchema,
    profileStatus: { type: "string", enum: [...profileStatusValues] },
    activatedAt: nullableDateTimeSchema,
  },
} as const;

const profileResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["profile", "version", "updatedAt", "contractVersion"],
  properties: {
    profile: profileProjectionSchema,
    version: versionSchema,
    updatedAt: nullableDateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const replaceProfileRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "profile"],
  properties: {
    expectedVersion: versionSchema,
    profile: {
      type: "object",
      additionalProperties: false,
      required: ["alias", "avatarRef", "bio", "interests"],
      properties: {
        alias: nullableAliasInputSchema,
        avatarRef: nullableAvatarRefSchema,
        bio: nullableBioInputSchema,
        interests: interestsInputSchema,
      },
    },
  },
} as const;

const activateProfileRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["alias", "avatarRef", "interests"],
  properties: {
    alias: aliasInputSchema,
    avatarRef: nullableAvatarRefSchema,
    interests: interestsInputSchema,
  },
} as const;

const visibilityValueSchema = {
  type: "string",
  enum: [...privacyVisibilityValues],
} as const;

const privacyValuesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["discoverable", "anonymousMode", "visibility"],
  properties: {
    discoverable: {
      type: "boolean",
      description: "Show the LOOP ID and allow search; presentation only.",
    },
    anonymousMode: {
      type: "boolean",
      description: "Show only the alias and never a wallet address.",
    },
    visibility: {
      type: "object",
      additionalProperties: false,
      required: ["totalAssets", "miningPower", "communities", "tradeHistory"],
      properties: {
        totalAssets: visibilityValueSchema,
        miningPower: visibilityValueSchema,
        communities: visibilityValueSchema,
        tradeHistory: visibilityValueSchema,
      },
    },
  },
} as const;

const privacyResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["privacy", "version", "updatedAt", "contractVersion"],
  properties: {
    privacy: privacyValuesSchema,
    version: versionSchema,
    updatedAt: nullableDateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const replacePrivacyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "privacy"],
  properties: {
    expectedVersion: versionSchema,
    privacy: privacyValuesSchema,
  },
} as const;

const avatarPresetsResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["avatars", "contractVersion"],
  properties: {
    avatars: {
      type: "array",
      minItems: avatarPresets.length,
      maxItems: avatarPresets.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["avatarRef", "atlas", "slot", "label"],
        properties: {
          avatarRef: {
            type: "string",
            pattern: avatarPresetRefPatternSource,
          },
          atlas: { type: "string", enum: ["people", "monogram"] },
          slot: {
            anyOf: [
              {
                type: "integer",
                minimum: 1,
                maximum: avatarPeopleSlotCount,
                description:
                  "1-based slot in the 4x3 people atlas (row-major).",
              },
              { type: "null" },
            ],
          },
          label: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
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
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

const casWriteErrors = {
  ...readErrors,
  422: v2ErrorResponseSchema([
    "VALIDATION_FAILED",
    "ALIAS_RESERVED",
    "ALIAS_BLOCKED",
  ]),
} as const;

const privacyWriteErrors = {
  ...readErrors,
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
} as const;

const activationErrors = {
  ...readErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema([
    "VALIDATION_FAILED",
    "ALIAS_RESERVED",
    "ALIAS_BLOCKED",
  ]),
} as const;

const publicErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema(["REQUEST_TIMEOUT"]),
} as const;

function hasRawHeader(request: FastifyRequest, expectedName: string): boolean {
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === expectedName) {
      return true;
    }
  }
  return false;
}

function validateCommonHeaders(request: FastifyRequest): Promise<void> {
  parseV2CommonRequestMetadata(request.raw.rawHeaders);
  return Promise.resolve();
}

/**
 * CAS replacements are idempotent through `expectedVersion`; a client
 * `Idempotency-Key` is rejected so a lost-response retry is never mistaken
 * for a durable command replay.
 */
const validateCasWriteHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2WriteRequestMetadata(request.raw.rawHeaders);
    if (hasRawHeader(request, v2SessionHeaderNames.idempotencyKey)) {
      throw V2ApiError.invalidRequest();
    }
    done();
  } catch (error) {
    done(error instanceof Error ? error : new Error("Header validation"));
  }
};

function validateActivationHeaders(request: FastifyRequest): Promise<void> {
  parseV2SessionWriteMetadata(request.raw.rawHeaders);
  return Promise.resolve();
}

function assertNoQuery(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).length > 0) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export const registerV2ProfileRoutes: V2ModuleRegistrar = (
  app: FastifyInstance,
  dependencies,
): void => {
  const { authenticateLoopBearer, profileService } = dependencies;

  app.get(
    "/v2/profile/avatars",
    {
      schema: {
        operationId: "listV2AvatarPresets",
        summary: "List the preset avatar catalog",
        description:
          "Public read-only preset avatars accepted by V2 profile writes. Avatar upload remains unavailable until a storage Provider is selected.",
        tags: ["profile"],
        querystring: emptyQueryStringSchema,
        response: {
          200: avatarPresetsResponseSchema,
          ...publicErrors,
        },
      },
      preValidation: assertNoBodyOrQuery,
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return reply.code(200).send(profileService.listAvatarPresets());
    },
  );

  app.get(
    "/v2/profile",
    {
      schema: {
        operationId: "getV2Profile",
        summary: "Get the authenticated LOOP profile with its LOOP ID",
        description:
          "Returns the owner-bound profile projection. A missing profile row is an explicit version-0 pending default; the LOOP ID is always present after bootstrap.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: profileResourceSchema,
          ...readErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await profileService.getProfile({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/profile",
    {
      schema: {
        operationId: "replaceV2Profile",
        summary: "Replace the authenticated LOOP profile",
        description:
          "Compare-and-swap replacement keyed by expectedVersion; the version is shared with the frozen V1 profile. An identical lost-response retry returns the committed resource. Idempotency-Key is not accepted.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: replaceProfileRequestSchema,
        response: {
          200: profileResourceSchema,
          ...casWriteErrors,
        },
      },
      onRequest: validateCasWriteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await profileService.replaceProfile({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/profile/loop-id",
    {
      schema: {
        operationId: "activateV2LoopId",
        summary: "Activate the LOOP ID with an alias, avatar, and interests",
        description:
          "One-time idempotent activation moving profileStatus from pending to active. The Idempotency-Key is bound to the owner, route, and canonical body; an already active profile returns the current resource.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        headers: v2SessionWriteHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: activateProfileRequestSchema,
        response: {
          200: profileResourceSchema,
          ...activationErrors,
        },
      },
      onRequest: validateActivationHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await profileService.activateProfile({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
        metadata: parseV2SessionWriteMetadata(request.raw.rawHeaders),
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/profile/privacy",
    {
      schema: {
        operationId: "getV2PrivacyPreferences",
        summary: "Get the authenticated LOOP privacy preferences",
        description:
          "Returns fail-closed owner-only defaults (version 0) without creating a row. Preferences are presentation choices, never authorization.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: privacyResourceSchema,
          ...readErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await profileService.getPrivacy({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/profile/privacy",
    {
      schema: {
        operationId: "replaceV2PrivacyPreferences",
        summary: "Replace the authenticated LOOP privacy preferences",
        description:
          "Compare-and-swap replacement keyed by expectedVersion, independent from the frozen V1 privacy resource. Idempotency-Key is not accepted.",
        tags: ["profile"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: replacePrivacyRequestSchema,
        response: {
          200: privacyResourceSchema,
          ...privacyWriteErrors,
        },
      },
      onRequest: validateCasWriteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await profileService.replacePrivacy({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
};
