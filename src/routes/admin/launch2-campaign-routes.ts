import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import {
  AdminApiError,
  adminApiPrefix,
} from "../../features/admin/admin-contract.js";
import type { AdminLaunch2CampaignService } from "../../features/admin/admin-launch2-campaigns.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import type { AdminWriteContext } from "../../features/admin/admin-service.js";
import {
  launch2CampaignLimits,
  launch2CampaignLinkKinds,
  launch2CampaignReasonCodes,
  launch2CampaignStatuses,
} from "../../features/launch2/launch2-campaigns.js";
import {
  campaignCoverMaximumUploadBytes,
  mediaReasonCodes,
} from "../../features/media/media-contract.js";
import {
  adminErrors,
  adminSecurity,
  auditReferenceSchema,
  guardedSessionErrors,
} from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0140 console routes: the launch desk campaigns under
 * `/admin/v1/launch2/campaigns` — reads with console.read, writes (create,
 * update, publish, archive, cover upload) with console.write
 * (platform_admin), each write audited in its own transaction.
 */

export interface AdminLaunch2CampaignRouteDependencies {
  readonly service: AdminLaunch2CampaignService;
  readonly guard: (permission: AdminPermission) => AdminRouteGuard;
  readonly context: (request: FastifyRequest) => AdminWriteContext;
}

const base = `${adminApiPrefix}/launch2/campaigns`;
const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const uuidV4Source =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const optionalIdempotencyHeadersSchema = {
  type: "object",
  properties: {
    "idempotency-key": {
      type: "string",
      pattern: uuidV4Source,
      description:
        "Optional lower-case UUIDv4. Create and cover upload: the same key with the same body (cover: the same bytes) replays the first result (create: 200 `replayed: true`); another body is 409 ADMIN_CONFLICT / ADMIN_IDEMPOTENCY_CONFLICT. Update / publish / archive accept it and do not deduplicate (a repeated publish / archive is 409 CAMPAIGN_STATUS_CONFLICT; a repeated full PATCH writes the same values again).",
    },
  },
} as const;

const linkSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "value"],
  properties: {
    kind: { type: "string", enum: [...launch2CampaignLinkKinds] },
    value: {
      type: "string",
      description:
        "route: an App route starting with one `/` (e.g. /launch2/instance?id=…); url: an absolute https:// URL without credentials. No whitespace, ≤ 1024 characters.",
    },
  },
} as const;

export const adminLaunch2CampaignSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "campaignId",
    "title",
    "subtitle",
    "coverMediaId",
    "coverUrl",
    "startsAt",
    "endsAt",
    "ctaLabel",
    "link",
    "pinned",
    "sortOrder",
    "status",
    "createdBy",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    campaignId: uuidSchema,
    title: { type: "string", minLength: 1, maxLength: 24 },
    subtitle: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 60 },
        { type: "null" },
      ],
    },
    coverMediaId: { anyOf: [uuidSchema, { type: "null" }] },
    coverUrl: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Absolute URL of the cover (GET /v2/media/{id}.webp).",
    },
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    ctaLabel: { type: "string", minLength: 1, maxLength: 8 },
    link: linkSchema,
    pinned: { type: "boolean" },
    sortOrder: { type: "integer" },
    status: { type: "string", enum: [...launch2CampaignStatuses] },
    createdBy: {
      anyOf: [uuidSchema, { type: "null" }],
      description:
        "The creating console account id; null for the ADMIN_USERNAME bootstrap administrator.",
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const listResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "generatedAt"],
  properties: {
    items: {
      type: "array",
      maxItems: launch2CampaignLimits.adminListMax,
      items: adminLaunch2CampaignSchema,
    },
    generatedAt: dateTimeSchema,
  },
} as const;

const readResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["campaign"],
  properties: { campaign: adminLaunch2CampaignSchema },
} as const;

const writeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["campaign", "audit"],
  properties: {
    campaign: adminLaunch2CampaignSchema,
    audit: auditReferenceSchema,
  },
} as const;

const createResourceSchema = {
  ...writeResourceSchema,
  required: [...writeResourceSchema.required, "replayed"],
  properties: {
    ...writeResourceSchema.properties,
    replayed: { type: "boolean" },
  },
} as const;

const coverResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["mediaId", "coverUrl"],
  properties: {
    mediaId: uuidSchema,
    coverUrl: { type: "string" },
  },
} as const;

/** JSON types only: every length / format rule answers 422 from the service. */
const fieldProperties = {
  title: { type: "string", description: "1–24 characters after trim." },
  subtitle: {
    // null first: the coercing validator would turn null into "".
    anyOf: [{ type: "null" }, { type: "string" }],
    description: "0–60 characters after trim; empty or null = none.",
  },
  coverMediaId: {
    anyOf: [{ type: "null" }, { type: "string" }],
    description:
      "mediaId from POST …/campaigns/cover; null clears the cover. Unknown or not a campaign cover → 422 CAMPAIGN_COVER_INVALID.",
  },
  startsAt: { type: "string", description: "RFC 3339 date-time." },
  endsAt: {
    type: "string",
    description: "RFC 3339 date-time, after startsAt.",
  },
  ctaLabel: {
    type: "string",
    description: "1–8 characters after trim (default 查看).",
  },
  link: {
    type: "object",
    description: linkSchema.properties.value.description,
  },
  pinned: { type: "boolean" },
  sortOrder: {
    type: "integer",
    minimum: launch2CampaignLimits.sortOrderMin,
    maximum: launch2CampaignLimits.sortOrderMax,
  },
} as const;

const createBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "startsAt", "endsAt", "link"],
  properties: fieldProperties,
} as const;

const updateBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: fieldProperties,
} as const;

const campaignParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["campaignId"],
  properties: { campaignId: { type: "string", maxLength: 64 } },
} as const;

const validationNote = `422 VALIDATION_FAILED with detailsSafe.reasonCode + field: ${launch2CampaignReasonCodes.titleInvalid} (title 1–24 / subtitle 0–60 / ctaLabel 1–8 characters after trim, no control characters; field names which), ${launch2CampaignReasonCodes.windowInvalid} (unparseable date-time, or endsAt ≤ startsAt), ${launch2CampaignReasonCodes.linkInvalid} (route must start with one /, url must be https:// without credentials, no whitespace, ≤ 1024), ${launch2CampaignReasonCodes.coverInvalid} (coverMediaId not an uploaded campaign cover).`;

const writeErrors = adminErrors(
  ...guardedSessionErrors,
  "INVALID_REQUEST",
  "NOT_FOUND",
  "ADMIN_CONFLICT",
  "VALIDATION_FAILED",
  "CAPABILITY_UNAVAILABLE",
);

function idempotencyKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  return typeof raw === "string" ? raw : null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export function registerAdminLaunch2CampaignRoutes(
  app: FastifyInstance,
  dependencies: AdminLaunch2CampaignRouteDependencies,
): void {
  const { service, guard, context } = dependencies;

  app.get(
    base,
    {
      schema: {
        operationId: "listAdminLaunch2Campaigns",
        summary: "List launch desk campaigns",
        description:
          "Decision 0140: every campaign (draft, published, archived; or one `status`), newest created first, ≤ 200. coverUrl is the absolute cover URL. Without the database: 503 CAPABILITY_UNAVAILABLE (CAMPAIGN_REPOSITORY_UNAVAILABLE). console.read.",
        tags: ["admin-launch2-campaigns"],
        security: adminSecurity,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: [...launch2CampaignStatuses] },
          },
        },
        response: {
          200: listResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "INVALID_REQUEST",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const resource = await service.list(
        request.query as Record<string, unknown>,
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${base}/:campaignId`,
    {
      schema: {
        operationId: "getAdminLaunch2Campaign",
        summary: "Get one launch desk campaign",
        description:
          "Decision 0140: one campaign in any status. Unknown: 404 NOT_FOUND (CAMPAIGN_NOT_FOUND). console.read.",
        tags: ["admin-launch2-campaigns"],
        security: adminSecurity,
        params: campaignParamsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: readResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const { campaignId } = request.params as { readonly campaignId: string };
      const resource = await service.get(campaignId);
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    base,
    {
      schema: {
        operationId: "createAdminLaunch2Campaign",
        summary: "Create a launch desk campaign (draft)",
        description: `Decision 0140: creates a draft (status draft; ctaLabel defaults to 查看, pinned false, sortOrder 0). Writes admin_audit_log \`launch2.campaign.create\` (target launch2_campaign) in the same transaction. 201; an Idempotency-Key replay is 200 with \`replayed: true\` and the first create's audit reference. ${validationNote} console.write (platform_admin).`,
        tags: ["admin-launch2-campaigns"],
        security: adminSecurity,
        headers: optionalIdempotencyHeadersSchema,
        querystring: emptyQuerySchema,
        body: createBodySchema,
        response: {
          200: createResourceSchema,
          201: createResourceSchema,
          ...writeErrors,
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const resource = await service.create(
        context(request),
        request.body,
        idempotencyKeyOf(request),
      );
      reply.header("cache-control", "no-store");
      return reply.code(resource.replayed ? 200 : 201).send(resource);
    },
  );

  app.patch(
    `${base}/:campaignId`,
    {
      schema: {
        operationId: "updateAdminLaunch2Campaign",
        summary: "Update a launch desk campaign",
        description: `Decision 0140: replaces the given fields (any subset; the console sends all of them; coverMediaId / subtitle null clears) of a draft or published campaign — a published campaign changes on the App at its next read. Archived: 409 ADMIN_CONFLICT (CAMPAIGN_STATUS_CONFLICT, detailsSafe.status). Unknown: 404 NOT_FOUND (CAMPAIGN_NOT_FOUND). The window is checked on the merged values. Writes admin_audit_log \`launch2.campaign.update\` (before / after snapshots) in the same transaction. ${validationNote} console.write (platform_admin).`,
        tags: ["admin-launch2-campaigns"],
        security: adminSecurity,
        headers: optionalIdempotencyHeadersSchema,
        params: campaignParamsSchema,
        querystring: emptyQuerySchema,
        body: updateBodySchema,
        response: { 200: writeResourceSchema, ...writeErrors },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const { campaignId } = request.params as { readonly campaignId: string };
      const resource = await service.update(
        context(request),
        campaignId,
        request.body,
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  for (const [action, operationId, summary, description] of [
    [
      "publish",
      "publishAdminLaunch2Campaign",
      "Publish a launch desk campaign",
      "Decision 0140: draft → published; GET /v2/launch2/campaigns shows it from its next read while endsAt > now and startsAt ≤ now + 7 days. Already published or archived (archived is final): 409 ADMIN_CONFLICT (CAMPAIGN_STATUS_CONFLICT, detailsSafe.status), nothing written. Already ended (endsAt ≤ now): 422 VALIDATION_FAILED (CAMPAIGN_WINDOW_INVALID). Writes admin_audit_log `launch2.campaign.publish`.",
    ],
    [
      "archive",
      "archiveAdminLaunch2Campaign",
      "Archive a launch desk campaign",
      "Decision 0140: draft or published → archived (final; the App stops showing it at its next read). Already archived: 409 ADMIN_CONFLICT (CAMPAIGN_STATUS_CONFLICT). Writes admin_audit_log `launch2.campaign.archive`.",
    ],
  ] as const) {
    app.post(
      `${base}/:campaignId/${action}`,
      {
        schema: {
          operationId,
          summary,
          description: `${description} Unknown: 404 NOT_FOUND (CAMPAIGN_NOT_FOUND). Any request body is ignored. console.write (platform_admin).`,
          tags: ["admin-launch2-campaigns"],
          security: adminSecurity,
          headers: optionalIdempotencyHeadersSchema,
          params: campaignParamsSchema,
          querystring: emptyQuerySchema,
          response: { 200: writeResourceSchema, ...writeErrors },
        },
        ...guard("console.write"),
      },
      async (request, reply) => {
        const { campaignId } = request.params as {
          readonly campaignId: string;
        };
        const resource =
          action === "publish"
            ? await service.publish(context(request), campaignId)
            : await service.archive(context(request), campaignId);
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    );
  }

  // Multipart parsing only inside this scope (like /v2/media).
  void app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        fileSize: campaignCoverMaximumUploadBytes,
        files: 1,
        fields: 0,
        parts: 1,
      },
    });

    async function readCover(request: FastifyRequest): Promise<Buffer> {
      if (!request.isMultipart()) throw new AdminApiError("INVALID_REQUEST");
      try {
        const part = await request.file();
        if (part === undefined || part.fieldname !== "file") {
          throw new AdminApiError("INVALID_REQUEST");
        }
        return await part.toBuffer();
      } catch (error) {
        if (error instanceof AdminApiError) throw error;
        if (errorCode(error) === "FST_REQ_FILE_TOO_LARGE") {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: launch2CampaignReasonCodes.coverInvalid,
            field: "file",
            mediaReasonCode: mediaReasonCodes.tooLarge,
          });
        }
        throw new AdminApiError("INVALID_REQUEST");
      }
    }

    scope.post(
      `${base}/cover`,
      {
        schema: {
          operationId: "uploadAdminLaunch2CampaignCover",
          summary: "Upload a launch desk campaign cover",
          description:
            "Decision 0140: multipart/form-data with one part `file`. PNG / JPEG / WebP by content (HEIC refused), ≤ 2 MiB, at least 600 × 300 (1200 × 600 recommended); stored as a 1200 × 600 WebP (2:1 centre crop, metadata stripped) in media_objects (kind campaign_cover, no LOOP user owner). Refusal: 422 VALIDATION_FAILED CAMPAIGN_COVER_INVALID with detailsSafe.mediaReasonCode MEDIA_TYPE_UNSUPPORTED | MEDIA_TOO_LARGE | MEDIA_DIMENSIONS_TOO_SMALL | MEDIA_DECODE_FAILED. 201 {mediaId, coverUrl}; write mediaId into coverMediaId. Not audited by itself (the campaign create / update that references it is). console.write (platform_admin).",
          tags: ["admin-launch2-campaigns"],
          security: adminSecurity,
          consumes: ["multipart/form-data"],
          headers: optionalIdempotencyHeadersSchema,
          querystring: emptyQuerySchema,
          body: {
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    file: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
          response: {
            201: coverResourceSchema,
            ...adminErrors(
              ...guardedSessionErrors,
              "INVALID_REQUEST",
              "ADMIN_CONFLICT",
              "VALIDATION_FAILED",
              "CAPABILITY_UNAVAILABLE",
            ),
          },
        },
        ...guard("console.write"),
        preValidation: (request: FastifyRequest): Promise<void> => {
          if (request.isMultipart() && request.body === undefined) {
            request.body = {};
          }
          return Promise.resolve();
        },
      },
      async (request, reply) => {
        const bytes = await readCover(request);
        const resource = await service.uploadCover(
          context(request),
          bytes,
          idempotencyKeyOf(request),
        );
        reply.header("cache-control", "no-store");
        return reply.code(201).send(resource);
      },
    );
  });
}
