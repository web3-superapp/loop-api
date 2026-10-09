import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  communityAiBriefReasonCodes,
  communityAiCapabilityIds,
  communityAiReportReasons,
  communityAiSourceKinds,
  maximumQuestionCodePoints,
  maximumReportNoteCodePoints,
  minimumQuestionCodePoints,
} from "../../features/community-ai/community-ai-contract.js";
import { opaqueIdPatternSource } from "../../features/community/community-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { readErrors } from "./community-schemas.js";

/**
 * Community AI route schemas (Decision 0066). They are the OpenAPI source, so
 * every object is closed: a field the contract does not name cannot reach the
 * client, and a model-produced key can never become part of the response.
 */

const sourceIdSchema = {
  type: "string",
  pattern: "^s[1-9][0-9]{0,2}$",
  description:
    "Handle of one assembled knowledge source, stable only inside this answer.",
} as const;

const reasonCodeSchema = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{0,63}$",
} as const;

const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceId", "kind", "label", "observedAt"],
  properties: {
    sourceId: sourceIdSchema,
    kind: { type: "string", enum: [...communityAiSourceKinds] },
    label: { type: "string", minLength: 1, maxLength: 200 },
    observedAt: { type: "string", format: "date-time" },
  },
} as const;

const omittedSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "reasonCode"],
  properties: {
    kind: {
      type: "string",
      enum: [...communityAiSourceKinds, "announcements"],
    },
    reasonCode: reasonCodeSchema,
  },
} as const;

const contractVersionSchema = {
  type: "string",
  const: v2ContractVersion,
} as const;

export const communityAiAskRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["question"],
  properties: {
    question: {
      type: "string",
      minLength: minimumQuestionCodePoints,
      maxLength: 4_096,
      description: `A community question of ${String(minimumQuestionCodePoints)} to ${String(maximumQuestionCodePoints)} code points after trimming. It is never logged.`,
    },
  },
} as const;

export const communityAiAnswerResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "answerId",
    "answer",
    "refusal",
    "citations",
    "sources",
    "omittedSources",
    "model",
    "generatedAt",
    "disclaimer",
    "contractVersion",
  ],
  properties: {
    answerId: { type: "string", pattern: opaqueIdPatternSource },
    answer: {
      type: "string",
      maxLength: 8_000,
      description:
        "The model's answer. Empty only when `refusal` explains why it declined.",
    },
    refusal: {
      anyOf: [{ type: "string", maxLength: 2_000 }, { type: "null" }],
    },
    citations: {
      type: "array",
      maxItems: 12,
      items: sourceSchema,
      description:
        "Only sources this request assembled. A source ID the model invented is dropped before the response is built.",
    },
    sources: { type: "array", maxItems: 16, items: sourceSchema },
    omittedSources: {
      type: "array",
      maxItems: 16,
      items: omittedSourceSchema,
    },
    model: { type: "string", minLength: 1, maxLength: 128 },
    generatedAt: { type: "string", format: "date-time" },
    disclaimer: { type: "string", minLength: 1, maxLength: 500 },
    contractVersion: contractVersionSchema,
  },
} as const;

const capabilitySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "capabilityId",
    "title",
    "summary",
    "availability",
    "reasonCode",
    "adminOnly",
  ],
  properties: {
    capabilityId: { type: "string", enum: [...communityAiCapabilityIds] },
    title: { type: "string", minLength: 1, maxLength: 40 },
    summary: { type: "string", minLength: 1, maxLength: 200 },
    availability: { type: "string", enum: ["available", "unavailable"] },
    reasonCode: { anyOf: [reasonCodeSchema, { type: "null" }] },
    adminOnly: { type: "boolean" },
  },
} as const;

const briefSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "messageCount",
        "bounded",
        "windowHours",
        "summary",
        "model",
        "generatedAt",
      ],
      properties: {
        status: { type: "string", const: "available" },
        messageCount: { type: "integer", minimum: 0 },
        bounded: {
          type: "boolean",
          description:
            "True when the count is a floor: a full message page was still inside the window.",
        },
        windowHours: { type: "integer", minimum: 1, maximum: 168 },
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        model: { type: "string", minLength: 1, maxLength: 128 },
        generatedAt: { type: "string", format: "date-time" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode"],
      properties: {
        status: { type: "string", const: "unavailable" },
        reasonCode: {
          type: "string",
          enum: [...communityAiBriefReasonCodes],
          description:
            "COMMUNITY_AI_BRIEF_PENDING means a summary is being generated in the background; re-read the overview later. The Provider codes classify the last failed generation.",
        },
      },
    },
  ],
} as const;

export const communityAiOverviewResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "capabilities",
    "knowledge",
    "exampleQuestions",
    "brief",
    "disclaimer",
    "contractVersion",
  ],
  properties: {
    capabilities: {
      type: "array",
      maxItems: 8,
      items: capabilitySchema,
      description:
        "The eight prototype abilities. `communityAnalytics` is present only for an owner or admin.",
    },
    knowledge: {
      type: "object",
      additionalProperties: false,
      required: [
        "sourceCount",
        "updatedAt",
        "sources",
        "omittedSources",
        "documents",
      ],
      properties: {
        sourceCount: { type: "integer", minimum: 0 },
        updatedAt: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
        sources: { type: "array", maxItems: 16, items: sourceSchema },
        omittedSources: {
          type: "array",
          maxItems: 16,
          items: omittedSourceSchema,
        },
        documents: {
          type: "object",
          additionalProperties: false,
          required: ["status", "reasonCode"],
          properties: {
            status: { type: "string", const: "unavailable" },
            reasonCode: reasonCodeSchema,
          },
          description:
            "LOOP has live sources, not a document corpus: a document count is never published.",
        },
      },
    },
    exampleQuestions: {
      type: "array",
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    brief: briefSchema,
    disclaimer: { type: "string", minLength: 1, maxLength: 500 },
    contractVersion: contractVersionSchema,
  },
} as const;

export const communityAiReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string", enum: [...communityAiReportReasons] },
    note: {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
      description: `Optional free text of at most ${String(maximumReportNoteCodePoints)} code points after trimming.`,
    },
  },
} as const;

export const communityAiReportResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answerId", "reportId", "reason", "createdAt", "contractVersion"],
  properties: {
    answerId: { type: "string", pattern: opaqueIdPatternSource },
    reportId: { type: "string", pattern: opaqueIdPatternSource },
    reason: { type: "string", enum: [...communityAiReportReasons] },
    createdAt: { type: "string", format: "date-time" },
    contractVersion: contractVersionSchema,
  },
} as const;

export const communityAiAnswerParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["communityId", "answerId"],
  properties: {
    communityId: { type: "string", pattern: opaqueIdPatternSource },
    answerId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

/** The AI reads and writes share one catalog: both can be quota refused. */
export const communityAiReadErrors = {
  ...readErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED"]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

export const communityAiCommandErrors = {
  ...communityAiReadErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
} as const;
