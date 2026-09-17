import {
  noStoreResponseHeaders,
  streamUserIdPattern,
} from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  maximumRawTextLength,
  opaqueIdPatternSource,
  publicProfileIdPatternSource,
  storedAvatarRefPatternSource,
} from "../../features/community/community-contract.js";
import {
  handRaiseStates,
  streamCallCidPatternSource,
  voiceRoomProvisionStates,
  voiceRoomRoles,
  voiceRoomStates,
} from "../../features/communication/communication-contract.js";
import { loopIdPatternSource } from "../../features/identity/loop-id.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { commandErrors, readErrors } from "./community-schemas.js";

/**
 * V2 communication route schemas (Decision 0032). Route schemas are the
 * OpenAPI source: every bounded object rejects unknown properties, every
 * unavailable projection carries a machine reason code, and no Provider or
 * internal identifier is ever projected.
 */

const canonicalUuidV4PatternSource = opaqueIdPatternSource;

export const communicationCommandErrors = {
  ...commandErrors,
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

export const communicationTokenErrors = {
  ...commandErrors,
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

export const communicationReadErrors = readErrors;

export const communityIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["communityId"],
  properties: {
    communityId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const voiceRoomIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["voiceRoomId"],
  properties: {
    voiceRoomId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const voiceRoomSpeakerParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["voiceRoomId", "publicProfileId"],
  properties: {
    voiceRoomId: { type: "string", pattern: opaqueIdPatternSource },
    publicProfileId: { type: "string", pattern: publicProfileIdPatternSource },
  },
} as const;

export const chatOperationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operationId"],
  properties: {
    operationId: { type: "string", pattern: canonicalUuidV4PatternSource },
  },
} as const;

export const chatGroupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["groupId"],
  properties: {
    groupId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const streamTokenResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["apiKey", "token", "expiresAt", "user", "contractVersion"],
  properties: {
    apiKey: { type: "string", minLength: 1, maxLength: 512 },
    token: { type: "string", minLength: 32, maxLength: 16_384 },
    expiresAt: { type: "string", format: "date-time" },
    user: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", pattern: streamUserIdPattern } },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const createChatGroupRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "friendPublicProfileIds"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description:
        "Trimmed server-side and limited to 1-60 Unicode code points.",
    },
    friendPublicProfileIds: {
      type: "array",
      minItems: 2,
      maxItems: 29,
      uniqueItems: true,
      items: { type: "string", pattern: publicProfileIdPatternSource },
      description:
        "Two through twenty-nine accepted friends; the backend adds the caller.",
    },
  },
} as const;

export const createDirectChannelRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetPublicProfileId"],
  properties: {
    targetPublicProfileId: {
      type: "string",
      pattern: publicProfileIdPatternSource,
    },
  },
} as const;

const chatGroupResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["groupId", "name", "friendPublicProfileIds", "streamCid"],
  properties: {
    groupId: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: maximumRawTextLength },
    friendPublicProfileIds: {
      type: "array",
      minItems: 2,
      maxItems: 29,
      uniqueItems: true,
      items: { type: "string", format: "uuid" },
    },
    streamCid: {
      type: "string",
      pattern: "^messaging:loop_group_[0-9a-f]{32}$",
    },
  },
} as const;

const chatDirectResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetPublicProfileId", "streamCid"],
  properties: {
    targetPublicProfileId: { type: "string", format: "uuid" },
    streamCid: {
      type: "string",
      pattern: "^messaging:loop_direct_[0-9a-f]{32}$",
    },
  },
} as const;

export const chatOperationResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "operationId",
    "kind",
    "status",
    "terminal",
    "retryAfterMs",
    "result",
    "error",
    "createdAt",
    "updatedAt",
    "contractVersion",
  ],
  properties: {
    operationId: { type: "string", format: "uuid" },
    kind: { type: "string", enum: ["groupCreate", "directGetOrCreate"] },
    status: {
      type: "string",
      enum: [
        "pending",
        "submitting",
        "reconciling",
        "succeeded",
        "failed",
        "operatorRequired",
      ],
      description:
        "The V1 operation state machine, camelCased. operatorRequired is a terminal unresolved result, not a disguised failure.",
    },
    terminal: { type: "boolean" },
    retryAfterMs: {
      anyOf: [
        { type: "integer", minimum: 1, maximum: 60_000 },
        { type: "null" },
      ],
    },
    result: {
      anyOf: [chatGroupResultSchema, chatDirectResultSchema, { type: "null" }],
    },
    error: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: {
            code: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
          },
        },
        { type: "null" },
      ],
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const pendingChatOperationResourceSchema = {
  ...chatOperationResourceSchema,
  headers: {
    ...noStoreResponseHeaders(),
    location: {
      type: "string",
      pattern: `^/v2/chat/operations/${canonicalUuidV4PatternSource.slice(1, -1)}$`,
      description: "Owner-bound polling location for a nonterminal operation",
    },
    "retry-after": {
      type: "string",
      pattern: "^[1-9][0-9]*$",
      description: "Minimum polling delay in seconds",
    },
  },
} as const;

export const chatGroupMembershipResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["groupId", "membership", "contractVersion"],
  properties: {
    groupId: { type: "string", format: "uuid" },
    membership: {
      type: "null",
      description: "The caller is no longer a member of this group.",
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const identitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["publicProfileId", "loopId", "alias", "avatarRef"],
  properties: {
    publicProfileId: { type: "string", pattern: publicProfileIdPatternSource },
    loopId: { type: "string", pattern: loopIdPatternSource },
    alias: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumRawTextLength },
        { type: "null" },
      ],
    },
    avatarRef: {
      anyOf: [
        { type: "string", pattern: storedAvatarRefPatternSource },
        { type: "null" },
      ],
    },
  },
} as const;

const handRaiseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["handRaiseId", "sequence", "state", "createdAt"],
  properties: {
    handRaiseId: { type: "string", pattern: opaqueIdPatternSource },
    sequence: {
      type: "string",
      pattern: "^[1-9][0-9]{0,18}$",
      description:
        "Monotonic queue position allocated under the room row lock. It is a decimal string, never a JavaScript number.",
    },
    state: { type: "string", enum: [...handRaiseStates] },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const unavailableProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
  },
} as const;

const observedParticipantsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "participantCount", "memberCount", "observedAt"],
  properties: {
    status: { type: "string", const: "available" },
    participantCount: {
      type: "integer",
      minimum: 0,
      description:
        "Devices connected to the live Stream call session right now (the sum of the session's per-role participant counts). 0 when Stream reports no live session. This is the only field that means 'people in the room now'; a LOOP join grant alone does not raise it.",
    },
    memberCount: {
      type: "integer",
      minimum: 0,
      description:
        "Accounts Stream lets into the call (call members). It includes the host and anyone LOOP has joined, whether or not their device is connected. It is authorization, not presence.",
    },
    observedAt: {
      type: "string",
      format: "date-time",
      description:
        "When both Stream reads completed. The member count is accumulated across a bounded number of Stream member pages; a truncated walk, or any failed read, reports the whole block as unavailable instead.",
    },
  },
} as const;

const voiceRoomBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "room",
    "viewer",
    "participants",
    "providerSync",
    "contractVersion",
  ],
  properties: {
    room: {
      type: "object",
      additionalProperties: false,
      required: [
        "voiceRoomId",
        "communityId",
        "communityName",
        "callCid",
        "state",
        "provisionState",
        "backstage",
        "createdAt",
        "endedAt",
      ],
      properties: {
        voiceRoomId: { type: "string", pattern: opaqueIdPatternSource },
        communityId: { type: "string", pattern: opaqueIdPatternSource },
        communityName: {
          type: "string",
          minLength: 1,
          maxLength: maximumRawTextLength,
          description:
            "The community's name as `GET /v2/communities/{communityId}` publishes it, read from the same row at response time (Decision 0052). Intended for the room banner; it is a display value, never an identifier.",
        },
        callCid: { type: "string", pattern: streamCallCidPatternSource },
        state: { type: "string", enum: [...voiceRoomStates] },
        provisionState: {
          type: "string",
          enum: [...voiceRoomProvisionStates],
          description:
            "Whether the Stream call itself is confirmed. Only `provisioned` may be joined.",
        },
        backstage: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" },
        endedAt: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
    },
    viewer: {
      type: "object",
      additionalProperties: false,
      required: [
        "role",
        "canInviteSpeakers",
        "canMuteAll",
        "canEndRoom",
        "handRaise",
        "expiresAt",
      ],
      properties: {
        role: {
          anyOf: [
            { type: "string", enum: [...voiceRoomRoles] },
            { type: "null" },
          ],
        },
        canInviteSpeakers: { type: "boolean" },
        canMuteAll: { type: "boolean" },
        canEndRoom: { type: "boolean" },
        handRaise: { anyOf: [handRaiseSchema, { type: "null" }] },
        expiresAt: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
          description:
            "When the current join grant lapses. Refresh with POST /v2/video/token and re-join.",
        },
      },
    },
    participants: {
      type: "object",
      additionalProperties: false,
      required: ["speakerCount", "listenerCount", "joinedCount", "observed"],
      properties: {
        speakerCount: {
          type: "integer",
          minimum: 0,
          description:
            "LOOP-side role intent (voice_room_members with role=speaker). The host is not a speaker. It is not a Stream presence or online count.",
        },
        listenerCount: {
          type: "integer",
          minimum: 0,
          description:
            "LOOP-side role intent (voice_room_members with role=listener). The host is not a listener. It is not a Stream presence or online count.",
        },
        joinedCount: {
          type: "integer",
          minimum: 0,
          description:
            "Every LOOP member currently joined, including the host (1 + speakerCount + listenerCount on a live room). It is a LOOP authorization record, not a Stream presence count.",
        },
        observed: {
          oneOf: [observedParticipantsSchema, unavailableProjectionSchema],
        },
      },
    },
    providerSync: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode"],
      properties: {
        status: { type: "string", enum: ["confirmed", "unconfirmed"] },
        reasonCode: {
          anyOf: [
            { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
            { type: "null" },
          ],
          description:
            "Set when the single Stream write for this command was not confirmed. The LOOP transition committed; the provider fact did not.",
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const voiceRoomResourceSchema = {
  ...voiceRoomBodySchema,
  headers: noStoreResponseHeaders(),
} as const;

export const voiceRoomCurrentResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["current", "reasonCode", "contractVersion"],
  properties: {
    current: {
      anyOf: [voiceRoomBodySchema, { type: "null" }],
    },
    reasonCode: {
      anyOf: [
        { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        { type: "null" },
      ],
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const handRaiseQueueResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["handRaiseId", "sequence", "state", "createdAt", "profile"],
        properties: {
          ...handRaiseSchema.properties,
          profile: identitySchema,
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;
