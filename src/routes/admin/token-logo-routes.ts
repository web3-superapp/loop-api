import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import {
  AdminApiError,
  adminApiPrefix,
} from "../../features/admin/admin-contract.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import type { AdminWriteContext } from "../../features/admin/admin-service.js";
import {
  adminTokenLogoReasonCodes,
  tokenLogoUploadMaximumBytes,
  type AdminTokenLogoService,
} from "../../features/admin/admin-token-logos.js";
import { tokenLogoProxyReadChainIds } from "../../features/market/token-logo.js";
import {
  tokenLogoCacheSources,
  tokenLogoCacheStatuses,
  tokenLogoContentTypes,
} from "../../database/token-logo-cache-repository.js";
import {
  adminErrors,
  adminSecurity,
  auditReferenceSchema,
  guardedSessionErrors,
} from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0161 §3 console routes: the manual token logo override under
 * `/admin/v1/market/logos/{chainId}/{address}` — read with console.read,
 * upload / clear with console.write (platform_admin), each write audited in
 * its own transaction (Decision 0140 discipline).
 */

export interface AdminTokenLogoRouteDependencies {
  readonly service: AdminTokenLogoService;
  readonly guard: (permission: AdminPermission) => AdminRouteGuard;
  readonly context: (request: FastifyRequest) => AdminWriteContext;
}

const path = `${adminApiPrefix}/market/logos/:chainId/:address`;
const uuidV4Source =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const paramsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chainId", "address"],
  properties: {
    chainId: { type: "string", enum: [...tokenLogoProxyReadChainIds] },
    address: {
      type: "string",
      pattern: "^(0x[0-9a-fA-F]{40}|native)$",
      description:
        "Token contract address (any case; stored lowercase) or `native` for the chain's native coin.",
    },
  },
} as const;

const optionalIdempotencyHeadersSchema = {
  type: "object",
  properties: {
    "idempotency-key": {
      type: "string",
      pattern: uuidV4Source,
      description:
        "Optional lower-case UUIDv4; accepted and not deduplicated (uploading the same picture again stores the same bytes and writes another audit row).",
    },
  },
} as const;

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

export const adminTokenLogoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "chainId",
    "address",
    "status",
    "source",
    "contentType",
    "etag",
    "byteLength",
    "fetchedAt",
    "expiresAt",
    "url",
  ],
  properties: {
    chainId: { type: "string", enum: [...tokenLogoProxyReadChainIds] },
    address: { type: "string", pattern: "^(0x[0-9a-f]{40}|native)$" },
    status: { type: "string", enum: [...tokenLogoCacheStatuses] },
    source: {
      anyOf: [
        { type: "string", enum: [...tokenLogoCacheSources] },
        { type: "null" },
      ],
    },
    contentType: {
      anyOf: [
        { type: "string", enum: [...tokenLogoContentTypes] },
        { type: "null" },
      ],
    },
    etag: nullableString,
    byteLength: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    fetchedAt: { type: "string", format: "date-time" },
    expiresAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      description: "null for a manual picture (never expires).",
    },
    url: {
      type: "string",
      description: "Public proxy URL (`GET /v2/market/logos/...png`).",
    },
  },
} as const;

const readResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["logo"],
  properties: { logo: adminTokenLogoSchema },
} as const;

const writeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["logo", "audit"],
  properties: { logo: adminTokenLogoSchema, audit: auditReferenceSchema },
} as const;

const clearResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["audit"],
  properties: { audit: auditReferenceSchema },
} as const;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export function registerAdminTokenLogoRoutes(
  app: FastifyInstance,
  dependencies: AdminTokenLogoRouteDependencies,
): void {
  const { service, guard, context } = dependencies;

  app.get(
    path,
    {
      schema: {
        operationId: "getAdminTokenLogo",
        summary: "Get the cached state of one token logo",
        description: `Decision 0161: the \`token_logo_cache\` row (status, source — dexscreener / trustwallet / manual —, ETag, size, times) and its public proxy URL; never the bytes. No row: 404 NOT_FOUND (${adminTokenLogoReasonCodes.notCached}). Without the database: 503 CAPABILITY_UNAVAILABLE (${adminTokenLogoReasonCodes.cacheUnavailable}). console.read.`,
        tags: ["admin-market"],
        security: adminSecurity,
        params: paramsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: readResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "INVALID_REQUEST",
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const params = request.params as {
        readonly chainId: string;
        readonly address: string;
      };
      const resource = await service.get(params.chainId, params.address);
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.delete(
    path,
    {
      schema: {
        operationId: "clearAdminTokenLogoOverride",
        summary: "Remove a manual token logo",
        description: `Decision 0161: deletes the manual picture; the next request or pre-warm pass fetches the upstream picture again. Writes admin_audit_log \`market.logo.override_clear\` (target token_logo, \`<chainId>/<address>\`) in the same transaction. No manual row: 404 NOT_FOUND (${adminTokenLogoReasonCodes.overrideNotFound}). Without the database: 503 CAPABILITY_UNAVAILABLE. console.write (platform_admin).`,
        tags: ["admin-market"],
        security: adminSecurity,
        headers: optionalIdempotencyHeadersSchema,
        params: paramsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: clearResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "INVALID_REQUEST",
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const params = request.params as {
        readonly chainId: string;
        readonly address: string;
      };
      const resource = await service.clear(
        context(request),
        params.chainId,
        params.address,
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  // Multipart parsing only inside this scope (like /v2/media).
  void app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        fileSize: tokenLogoUploadMaximumBytes,
        files: 1,
        fields: 0,
        parts: 1,
      },
    });

    async function readUpload(request: FastifyRequest): Promise<Buffer> {
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
            reasonCode: adminTokenLogoReasonCodes.uploadInvalid,
            field: "file",
            logoReasonCode: adminTokenLogoReasonCodes.tooLarge,
          });
        }
        throw new AdminApiError("INVALID_REQUEST");
      }
    }

    scope.post(
      path,
      {
        schema: {
          operationId: "overrideAdminTokenLogo",
          summary: "Upload a manual token logo",
          description: `Decision 0161: multipart/form-data with one part \`file\`. PNG / JPEG / WebP / GIF by content (SVG and anything else refused), ≤ 2 MiB; stored as the 128 × 128 WebP every proxied logo is (fitted, transparent padding, metadata stripped) with \`source = manual\`: \`GET /v2/market/logos/{chainId}/{address}.png\` serves it from then on, and neither on-demand refresh nor the pre-warm lane refetches or overwrites it until it is cleared (DELETE). Clients and CDNs holding the old picture see the new one after their cache lifetime (max-age 1 day) — the ETag changes. Refusal: 422 VALIDATION_FAILED ${adminTokenLogoReasonCodes.uploadInvalid} (field file) with detailsSafe.logoReasonCode ${adminTokenLogoReasonCodes.typeUnsupported} | ${adminTokenLogoReasonCodes.tooLarge} | ${adminTokenLogoReasonCodes.decodeFailed}. Writes admin_audit_log \`market.logo.override\` (target token_logo, before / after: status, source, ETag, size — never bytes) in the same transaction. Without the database: 503 CAPABILITY_UNAVAILABLE (${adminTokenLogoReasonCodes.cacheUnavailable}). console.write (platform_admin).`,
          tags: ["admin-market"],
          security: adminSecurity,
          consumes: ["multipart/form-data"],
          headers: optionalIdempotencyHeadersSchema,
          params: paramsSchema,
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
            200: writeResourceSchema,
            ...adminErrors(
              ...guardedSessionErrors,
              "INVALID_REQUEST",
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
        const params = request.params as {
          readonly chainId: string;
          readonly address: string;
        };
        const bytes = await readUpload(request);
        const resource = await service.override(
          context(request),
          params.chainId,
          params.address,
          bytes,
        );
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    );
  });
}
