import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../config.js";
import { errorResponseSchema } from "../core/http/schemas.js";

/**
 * Passkey relying-party discovery (Decision 0063).
 *
 * The API origin is the relying party for LOOP passkeys, so Google Play
 * Services and Apple's `authorization services` fetch these two files from it
 * before they bind a credential created under this origin to the installed
 * app. Both are unauthenticated public facts about which app builds LOOP
 * claims; neither carries a secret, a user, or a request-specific value, and
 * neither belongs to the `/v2` contract surface: the platform fetchers send no
 * Bearer token, no `X-Loop-Contract-Version`, and no `Idempotency-Key`, and
 * they refuse a body that is not plain JSON.
 *
 * A file whose configuration is absent is not published as an empty document:
 * an empty `statements` array or an app ID with a placeholder Team ID would
 * make a broken association look configured. The route answers 404 instead,
 * which is exactly what the platform treats as "this domain does not claim
 * that app".
 */

const assetLinksRelations = Object.freeze([
  "delegate_permission/common.handle_all_urls",
  "delegate_permission/common.get_login_creds",
]);

/**
 * Five minutes. Short enough that adding a signing fingerprint reaches the
 * platform fetchers during a Development session, long enough that a retrying
 * fetcher does not re-read the file on every attempt.
 */
export const wellKnownCacheControl = "public, max-age=300";

/**
 * Sent verbatim. Apple documents `application/json` for the
 * extension-less association file, so the reply is a pre-serialized buffer:
 * Fastify appends `; charset=utf-8` to any JSON content type it serializes
 * itself.
 */
const wellKnownContentType = "application/json";

const assetLinksResponseSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["relation", "target"],
    properties: {
      relation: {
        type: "array",
        items: { type: "string", enum: [...assetLinksRelations] },
        minItems: 2,
      },
      target: {
        type: "object",
        additionalProperties: false,
        required: ["namespace", "package_name", "sha256_cert_fingerprints"],
        properties: {
          namespace: { type: "string", const: "android_app" },
          package_name: { type: "string", minLength: 1 },
          sha256_cert_fingerprints: {
            type: "array",
            items: { type: "string", minLength: 95, maxLength: 95 },
            minItems: 1,
          },
        },
      },
    },
  },
} as const;

const appleAppSiteAssociationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["webcredentials"],
  properties: {
    webcredentials: {
      type: "object",
      additionalProperties: false,
      required: ["apps"],
      properties: {
        apps: {
          type: "array",
          items: { type: "string", minLength: 3 },
          minItems: 1,
        },
      },
    },
  },
} as const;

function sendDiscoveryDocument(reply: FastifyReply, document: unknown): void {
  reply.header("cache-control", wellKnownCacheControl);
  reply.header("content-type", wellKnownContentType);
  void reply.send(Buffer.from(JSON.stringify(document), "utf8"));
}

export function registerWellKnownRoutes(
  app: FastifyInstance,
  config: AppConfig,
): void {
  app.get(
    "/.well-known/assetlinks.json",
    {
      schema: {
        hide: true,
        operationId: "getAndroidAssetLinks",
        summary: "Publish the Android app association for LOOP passkeys",
        response: {
          200: assetLinksResponseSchema,
          404: errorResponseSchema(["not_found"]),
          500: errorResponseSchema(["internal_error"]),
        },
      },
    },
    async (request, reply) => {
      const android = config.passkeyRelyingParty.android;
      if (android === null) {
        reply.header("cache-control", "no-store");
        return reply.code(404).send({
          code: "not_found" as const,
          message: "The requested resource does not exist.",
          request_id: request.id,
        });
      }

      sendDiscoveryDocument(reply, [
        {
          relation: [...assetLinksRelations],
          target: {
            namespace: "android_app",
            package_name: android.packageName,
            sha256_cert_fingerprints: [...android.certificateFingerprints],
          },
        },
      ]);
      return reply;
    },
  );

  app.get(
    "/.well-known/apple-app-site-association",
    {
      schema: {
        hide: true,
        operationId: "getAppleAppSiteAssociation",
        summary: "Publish the Apple app association for LOOP passkeys",
        response: {
          200: appleAppSiteAssociationResponseSchema,
          404: errorResponseSchema(["not_found"]),
          500: errorResponseSchema(["internal_error"]),
        },
      },
    },
    async (request, reply) => {
      const ios = config.passkeyRelyingParty.ios;
      if (ios === null) {
        reply.header("cache-control", "no-store");
        return reply.code(404).send({
          code: "not_found" as const,
          message: "The requested resource does not exist.",
          request_id: request.id,
        });
      }

      sendDiscoveryDocument(reply, {
        webcredentials: { apps: [ios.appId] },
      });
      return reply;
    },
  );
}
