import multipart from "@fastify/multipart";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import {
  feedbackCategories,
  feedbackContextKeys,
  feedbackLimits,
  feedbackReasonCodes,
  feedbackStatuses,
} from "../../features/feedback/feedback-contract.js";
import type { FeedbackService } from "../../features/feedback/feedback-service.js";
import {
  mediaIdPatternSource,
  mediaMaximumUploadBytes,
} from "../../features/media/media-contract.js";
import {
  assertNoBodyV2,
  assertNoQuery,
  cursorSchema,
  nullableCursorSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import { prepareMultipartBody, readSingleFile } from "./media.js";

/**
 * Decision 0193 (主代理决策 0262, docs/52 §二): beta feedback on the App —
 * `POST /v2/media/feedback-images`, `POST /v2/feedback`,
 * `GET /v2/feedback/mine`. Always registered; BETA_FEEDBACK_ENABLED=off
 * answers 503 CAPABILITY_UNAVAILABLE / BETA_FEEDBACK_DISABLED. Multipart
 * parsing is registered inside the upload's own plugin scope only.
 */

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const absoluteMediaUrlSchema = {
  type: "string",
  maxLength: 2048,
  pattern:
    "/v2/media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$",
  description: "Absolute `<PUBLIC_BASE_URL>/v2/media/<mediaId>.webp`.",
} as const;

const uploadResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["mediaId", "url"],
  properties: {
    mediaId: { type: "string", pattern: mediaIdPatternSource },
    url: absoluteMediaUrlSchema,
  },
} as const;

const createdResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["feedback"],
  properties: {
    feedback: {
      type: "object",
      additionalProperties: false,
      required: ["id", "status", "createdAt"],
      properties: {
        id: uuidSchema,
        status: { type: "string", enum: [...feedbackStatuses] },
        createdAt: dateTimeSchema,
      },
    },
  },
} as const;

const mineResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: {
      type: "array",
      maxItems: feedbackLimits.minePageSize,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "body", "status", "createdAt", "images"],
        properties: {
          id: uuidSchema,
          category: { type: "string", enum: [...feedbackCategories] },
          body: {
            type: "string",
            minLength: 1,
            maxLength: feedbackLimits.bodyMax,
          },
          status: { type: "string", enum: [...feedbackStatuses] },
          createdAt: dateTimeSchema,
          images: {
            type: "array",
            maxItems: feedbackLimits.imagesMax,
            items: absoluteMediaUrlSchema,
          },
        },
      },
    },
    nextCursor: nullableCursorSchema,
  },
} as const;

const createBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "body"],
  properties: {
    category: { type: "string", enum: [...feedbackCategories] },
    body: {
      type: "string",
      description: `1–${String(feedbackLimits.bodyMax)} code points after trim (CRLF → LF). Empty: 422 ${feedbackReasonCodes.bodyEmpty}; longer: 422 ${feedbackReasonCodes.bodyTooLong}; NUL: 422 ${feedbackReasonCodes.bodyInvalid}.`,
    },
    mediaIds: {
      type: "array",
      maxItems: 16,
      items: { type: "string", maxLength: 64 },
      description: `Optional (default []), at most ${String(feedbackLimits.imagesMax)} (more: 422 ${feedbackReasonCodes.tooManyImages}), in display order. Each must be the caller's own upload from POST /v2/media/feedback-images within the last 24 hours (else 422 ${feedbackReasonCodes.mediaNotOwned}), not attached to another report (422 ${feedbackReasonCodes.mediaInUse}), not repeated (422 ${feedbackReasonCodes.mediaDuplicate}).`,
    },
    context: {
      type: "object",
      description: `Optional client environment. Only ${feedbackContextKeys.join(", ")} are kept (any other key is dropped); string values are trimmed and cut to ${String(feedbackLimits.contextValueMax)} code points, numbers become strings, other values are dropped.`,
    },
  },
} as const;

const readErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  409: v2ErrorResponseSchema(["ACCOUNT_BOOTSTRAP_REQUIRED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

const commandErrors = {
  ...readErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

const uploadBodySchema = {
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            format: "binary",
            description:
              "Required, the only part. JPEG, PNG, WebP or HEIC/HEIF by content, at most 5 MiB, both sides at least 64 px. Stored as WebP inside 1440 x 1440 (aspect ratio kept, never enlarged, metadata stripped).",
          },
        },
      },
    },
  },
} as const;

const switchNote = `BETA_FEEDBACK_ENABLED=off: 503 CAPABILITY_UNAVAILABLE / ${feedbackReasonCodes.disabled}. Without the database (or the cursor secret): 503 CAPABILITY_UNAVAILABLE / ${feedbackReasonCodes.repositoryUnavailable}.`;

function idempotencyKey(request: FastifyRequest): string {
  return parseV2CommandMetadata(request.raw.rawHeaders).idempotencyKey;
}

export function registerV2FeedbackRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: FeedbackService,
): void {
  void app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        fileSize: mediaMaximumUploadBytes,
        files: 1,
        fields: 0,
        parts: 1,
      },
    });

    scope.post(
      "/v2/media/feedback-images",
      {
        schema: {
          operationId: "uploadV2FeedbackImage",
          summary: "Upload a beta feedback screenshot",
          description: `Decision 0193. multipart/form-data with one part \`file\`: the Decision 0095 input rules (sniffed by content: JPEG/PNG/WebP/HEIC, <= 5 MiB, both sides >= 64 px), stored as a WebP that keeps the aspect ratio inside 1440 x 1440 (quality 82, metadata stripped; never pinned to IPFS). Answers \`{ mediaId, url }\`, \`url\` the absolute public media URL. Put \`mediaId\` into POST /v2/feedback \`mediaIds\` within 24 hours. 422 VALIDATION_FAILED reason codes MEDIA_TYPE_UNSUPPORTED | MEDIA_TOO_LARGE | MEDIA_DIMENSIONS_TOO_SMALL | MEDIA_DECODE_FAILED. Idempotency-Key replays the stored object for the same bytes and conflicts for different bytes. The six-uploads-per-minute limit is shared with the other upload routes (429 RATE_LIMITED). ${switchNote}`,
          tags: ["feedback"],
          security: [{ privyBearer: [] }],
          consumes: ["multipart/form-data"],
          headers: v2CommandHeadersSchema,
          querystring: emptyQueryStringSchema,
          body: uploadBodySchema,
          response: { 201: uploadResourceSchema, ...commandErrors },
        },
        onRequest: validateCommandHeaders,
        preValidation: prepareMultipartBody,
        preHandler: authenticateLoopBearer,
      },
      async (request, reply) => {
        const resource = await service.uploadImage({
          principal: requireAuthenticatedLoopPrincipal(request),
          idempotencyKey: idempotencyKey(request),
          readBytes: () => readSingleFile(request),
        });
        reply.header("cache-control", "no-store");
        return reply.code(201).send(resource);
      },
    );
  });

  app.post(
    "/v2/feedback",
    {
      schema: {
        operationId: "createV2Feedback",
        summary: "Submit a beta feedback report",
        description: `Decision 0193. Creates an \`open\` report. Idempotency-Key (UUIDv4, required): the same key and body replays the first report (200), another body is 409 IDEMPOTENCY_CONFLICT; first write 201. At most ${String(feedbackLimits.dailyMax)} reports per account in a rolling 24 hours: 429 RATE_LIMITED / ${feedbackReasonCodes.dailyLimit}. 422 VALIDATION_FAILED carries detailsSafe.reasonCode + field (body / mediaIds). ${switchNote}`,
        tags: ["feedback"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createBodySchema,
        response: {
          200: createdResourceSchema,
          201: createdResourceSchema,
          ...commandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const created = await service.submit({
        principal: requireAuthenticatedLoopPrincipal(request),
        idempotencyKey: idempotencyKey(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(created.replayed ? 200 : 201).send(created.resource);
    },
  );

  app.get(
    "/v2/feedback/mine",
    {
      schema: {
        operationId: "listV2MyFeedback",
        summary: "The caller's beta feedback reports",
        description: `Decision 0193. The caller's reports, newest first, ${String(feedbackLimits.minePageSize)} per page; \`nextCursor\` (null on the last page) continues and is bound to the caller. \`images\` are absolute media URLs in display order. ${switchNote}`,
        tags: ["feedback"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { cursor: cursorSchema },
        },
        response: { 200: mineResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const resource = await service.listMine({
        principal: requireAuthenticatedLoopPrincipal(request),
        cursor: query["cursor"],
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
