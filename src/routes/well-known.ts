import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../config.js";
import { errorResponseSchema } from "../core/http/schemas.js";

/**
 * Passkey relying-party discovery (Decision 0063) merged with Universal Links /
 * App Links for shared LOOP ID links (Decision 0090).
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
 * Decision 0090 adds the `/u/*` link association, whose identifiers are fixed
 * facts of the LOOP app build, so both files are now always published. The
 * passkey half stays fail-closed exactly as Decision 0063 ruled: without
 * `PASSKEY_IOS_TEAM_ID` the Apple file carries no `webcredentials`, and
 * without `PASSKEY_ANDROID_CERT_SHA256` the Android file carries no
 * `get_login_creds` statement.
 */

const handleAllUrlsRelation = "delegate_permission/common.handle_all_urls";
const getLoginCredsRelation = "delegate_permission/common.get_login_creds";
const assetLinksRelations = Object.freeze([
  handleAllUrlsRelation,
  getLoginCredsRelation,
]);

/**
 * One hour (Decision 0090, raised from Decision 0063's five minutes). Apple
 * fetches the association through its CDN anyway, and the documents only change
 * when a signing key or the app identity changes.
 */
export const wellKnownCacheControl = "public, max-age=3600";

/** `/u/{loopId}` accepts the same loose shape as the search box. */
const landingLoopIdPattern = /^LOOP-[0-9A-Z]{8}$/i;

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
        minItems: 1,
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
  required: ["applinks"],
  properties: {
    applinks: {
      type: "object",
      additionalProperties: false,
      required: ["details"],
      properties: {
        details: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["appIDs", "components"],
            properties: {
              appIDs: {
                type: "array",
                items: { type: "string", minLength: 3 },
                minItems: 1,
              },
              components: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["/"],
                  properties: { "/": { type: "string", minLength: 1 } },
                },
              },
            },
          },
        },
      },
    },
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
        summary:
          "Publish the Android app association for LOOP links and passkeys",
        response: {
          200: assetLinksResponseSchema,
          500: errorResponseSchema(["internal_error"]),
        },
      },
    },
    async (_request, reply) => {
      const links = config.appLinks;
      const statements: unknown[] = [
        {
          relation: [handleAllUrlsRelation],
          target: {
            namespace: "android_app",
            package_name: links.androidPackage,
            sha256_cert_fingerprints: [...links.androidCertificateFingerprints],
          },
        },
      ];
      const android = config.passkeyRelyingParty.android;
      if (android !== null) {
        statements.push({
          relation: [...assetLinksRelations],
          target: {
            namespace: "android_app",
            package_name: android.packageName,
            sha256_cert_fingerprints: [...android.certificateFingerprints],
          },
        });
      }
      sendDiscoveryDocument(reply, statements);
      return reply;
    },
  );

  app.get(
    "/.well-known/apple-app-site-association",
    {
      schema: {
        hide: true,
        operationId: "getAppleAppSiteAssociation",
        summary:
          "Publish the Apple app association for LOOP links and passkeys",
        response: {
          200: appleAppSiteAssociationResponseSchema,
          500: errorResponseSchema(["internal_error"]),
        },
      },
    },
    async (_request, reply) => {
      const ios = config.passkeyRelyingParty.ios;
      sendDiscoveryDocument(reply, {
        applinks: {
          details: [
            {
              appIDs: [...config.appLinks.iosAppIds],
              components: [{ "/": "/u/*" }],
            },
          ],
        },
        ...(ios === null ? {} : { webcredentials: { apps: [ios.appId] } }),
      });
      return reply;
    },
  );

  app.get<{ Params: { loopId: string } }>(
    "/u/:loopId",
    {
      schema: {
        hide: true,
        operationId: "getLoopIdLandingPage",
        summary: "Landing page for a shared LOOP ID link without the app",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["loopId"],
          properties: { loopId: { type: "string", maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const raw = request.params.loopId;
      reply.header("content-type", "text/html; charset=utf-8");
      reply.header("content-security-policy", landingContentSecurityPolicy);
      reply.header("referrer-policy", "no-referrer");
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-robots-tag", "noindex");
      if (!landingLoopIdPattern.test(raw)) {
        reply.header("cache-control", "no-store");
        return reply.code(404).send(renderLandingPage(null, null));
      }
      reply.header("cache-control", wellKnownCacheControl);
      return reply.send(
        renderLandingPage(raw.toUpperCase(), config.appLinks.downloadUrl),
      );
    },
  );
}

const landingContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Minimal static page for someone who opened a shared `/u/{loopId}` link
 * without LOOP installed (Decision 0090). It never reads the database: the
 * LOOP ID shown is the one in the URL, upper-cased, and nothing says whether
 * such an account exists or who owns it.
 */
export function renderLandingPage(
  loopId: string | null,
  downloadUrl: string | null,
): string {
  const body =
    loopId === null
      ? `<p class="label">LOOP</p><h1>链接无效</h1><p>这个链接里没有有效的 LOOP ID。</p>`
      : `<p class="label">LOOP ID</p><h1 class="id">${escapeHtml(loopId)}</h1><p>在 LOOP 里添加好友</p><p class="hint">安装 LOOP 后打开这个链接，或在 LOOP 的搜索里粘贴上面的 LOOP ID。</p>${
          downloadUrl === null
            ? ""
            : `<a class="cta" href="${escapeHtml(downloadUrl)}" rel="noopener noreferrer">下载 LOOP</a>`
        }`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>LOOP</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0b;color:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
main{max-width:360px;padding:32px 24px;text-align:center}
.label{margin:0;color:#9a9a92;font-size:13px;letter-spacing:.08em}
h1{margin:8px 0 16px;font-size:28px}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hint{color:#9a9a92;font-size:14px;line-height:1.5}
.cta{display:inline-block;margin-top:16px;min-height:44px;line-height:44px;padding:0 24px;border-radius:22px;background:#c6f432;color:#0b0b0b;font-weight:600;text-decoration:none}
</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}
