import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../config.js";
import { errorResponseSchema } from "../core/http/schemas.js";
import {
  InvalidInviteCodeError,
  parseInviteCode,
} from "../features/referral/invite-code.js";

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
 * Decision 0090 adds the `/u/*` link association, so both files are always
 * published. Decision 0106 removes the hard-coded iOS application identifier:
 * the Apple file claims `<PASSKEY_IOS_TEAM_ID>.<PASSKEY_IOS_BUNDLE_ID>` and,
 * without `PASSKEY_IOS_TEAM_ID`, claims no app at all (`applinks.details` is
 * empty, no `webcredentials`) and the process logs one
 * `APPLE_TEAM_ID_MISSING` warning at startup. The Android file is unaffected.
 * Without `PASSKEY_ANDROID_CERT_SHA256` the Android file carries no
 * `get_login_creds` statement (Decision 0063).
 */

/** Startup warning code when no iOS app identifier can be published. */
export const appleTeamIdMissingCode = "APPLE_TEAM_ID_MISSING";

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

/**
 * Universal Link paths the app claims: shared LOOP IDs (Decision 0090),
 * voice-room share links `/c/{communityId}/room` (Decision 0091), community
 * links `/c/{communityId}` (Decision 0095), and invite links `/i/{code}`
 * (Decision 0162).
 */
export const appleAppLinkComponents = Object.freeze([
  Object.freeze({ "/": "/u/*" }),
  Object.freeze({ "/": "/c/*" }),
  Object.freeze({ "/": "/i/*" }),
]);

/** Community IDs are canonical lower-case UUIDv4 (Decision 0032). */
const landingCommunityIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  if (config.appLinks.iosAppIds.length === 0) {
    app.log.warn(
      { reasonCode: appleTeamIdMissingCode },
      "PASSKEY_IOS_TEAM_ID is not configured; apple-app-site-association claims no iOS app",
    );
  }

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
      const appIds = config.appLinks.iosAppIds;
      sendDiscoveryDocument(reply, {
        applinks: {
          details:
            appIds.length === 0
              ? []
              : [
                  {
                    appIDs: [...appIds],
                    components: [...appleAppLinkComponents],
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
          // Decision 0162: no maxLength — an overlong value gets the 404 page
          // from the pattern check below, never a JSON 400.
          properties: { loopId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const raw = request.params.loopId;
      setLandingHeaders(reply);
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

  app.get<{ Params: { code: string } }>(
    "/i/:code",
    {
      schema: {
        hide: true,
        operationId: "getInviteLandingPage",
        summary: "Landing page for a shared invite link without the app",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          // Decision 0162: no maxLength — an overlong value gets the 404 page
          // from the pattern check below, never a JSON 400.
          properties: { code: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      // Decision 0179: with WEB_BASE_URL set the website owns the invite
      // page; the code travels as given (percent-encoded as one path
      // segment, so it can never leave `${WEB_BASE_URL}/i/`). The Universal
      // Link / App Link host is still this API, so with the app installed
      // the OS opens the app before this route is reached.
      const webBaseUrl = config.web.baseUrl;
      if (webBaseUrl !== null) {
        reply.header("cache-control", "no-store");
        reply.header("referrer-policy", "no-referrer");
        return reply.redirect(
          `${webBaseUrl}/i/${encodeURIComponent(request.params.code)}`,
          302,
        );
      }
      setLandingHeaders(reply, inviteLandingContentSecurityPolicy);
      let code: string;
      try {
        code = parseInviteCode(request.params.code);
      } catch (error) {
        if (!(error instanceof InvalidInviteCodeError)) throw error;
        reply.header("cache-control", "no-store");
        return reply.code(404).send(renderInviteLandingPage(null, null));
      }
      reply.header("cache-control", wellKnownCacheControl);
      return reply.send(
        renderInviteLandingPage(code, {
          ios: config.appLinks.iosStoreUrl,
          android: config.appLinks.androidStoreUrl,
          fallback: config.appLinks.downloadUrl,
        }),
      );
    },
  );

  app.get<{ Params: { communityId: string } }>(
    "/c/:communityId",
    {
      schema: {
        hide: true,
        operationId: "getCommunityLandingPage",
        summary: "Landing page for a shared community link without the app",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["communityId"],
          // Decision 0162: no maxLength — an overlong value gets the 404 page
          // from the pattern check below, never a JSON 400.
          properties: { communityId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      setLandingHeaders(reply);
      if (!landingCommunityIdPattern.test(request.params.communityId)) {
        reply.header("cache-control", "no-store");
        return reply.code(404).send(renderCommunityLandingPage(false, null));
      }
      reply.header("cache-control", wellKnownCacheControl);
      return reply.send(
        renderCommunityLandingPage(true, config.appLinks.downloadUrl),
      );
    },
  );

  app.get<{ Params: { communityId: string } }>(
    "/c/:communityId/room",
    {
      schema: {
        hide: true,
        operationId: "getVoiceRoomLandingPage",
        summary: "Landing page for a shared voice-room link without the app",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["communityId"],
          // Decision 0162: no maxLength — an overlong value gets the 404 page
          // from the pattern check below, never a JSON 400.
          properties: { communityId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      setLandingHeaders(reply);
      if (!landingCommunityIdPattern.test(request.params.communityId)) {
        reply.header("cache-control", "no-store");
        return reply.code(404).send(renderVoiceRoomLandingPage(false, null));
      }
      reply.header("cache-control", wellKnownCacheControl);
      return reply.send(
        renderVoiceRoomLandingPage(true, config.appLinks.downloadUrl),
      );
    },
  );
}

function setLandingHeaders(
  reply: FastifyReply,
  contentSecurityPolicy: string = landingContentSecurityPolicy,
): void {
  reply.header("content-type", "text/html; charset=utf-8");
  reply.header("content-security-policy", contentSecurityPolicy);
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-robots-tag", "noindex");
}

const landingContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Decision 0162: the one script of the invite page — copy the code, then
 * open the store for the platform (or the generic download link). Static
 * text, allowed by its hash; the code and links travel in data attributes.
 */
export const inviteLandingScript = `(function(){var b=document.getElementById("copy");if(!b)return;var s=document.getElementById("status");function copyFallback(c){var t=document.createElement("textarea");t.value=c;t.setAttribute("readonly","");t.style.position="absolute";t.style.left="-9999px";document.body.appendChild(t);t.select();try{document.execCommand("copy")}catch(e){}document.body.removeChild(t)}b.addEventListener("click",function(){var c=b.getAttribute("data-code")||"";var u=navigator.userAgent||"";var target=/iPhone|iPad|iPod/.test(u)?b.getAttribute("data-ios"):(/Android/.test(u)?b.getAttribute("data-android"):null);target=target||b.getAttribute("data-fallback");function go(){if(s)s.textContent="\u9080\u8bf7\u7801\u5df2\u590d\u5236";if(target)window.location.href=target}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(c).then(go,function(){copyFallback(c);go()})}else{copyFallback(c);go()}})})();`;

const inviteLandingScriptHash = createHash("sha256")
  .update(inviteLandingScript, "utf8")
  .digest("base64");

export const inviteLandingContentSecurityPolicy = `default-src 'none'; script-src 'sha256-${inviteLandingScriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

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
      : `<p class="label">LOOP ID</p><h1 class="id">${escapeHtml(loopId)}</h1><p>在 LOOP 里添加好友</p><p class="hint">安装 LOOP 后打开这个链接，或在 LOOP 的搜索里粘贴上面的 LOOP ID。</p>${downloadLink(downloadUrl)}`;
  return renderLandingDocument(body);
}

/**
 * Minimal static page for a shared voice-room link `/c/{communityId}/room`
 * opened without LOOP installed (Decision 0091). Like `/u/`, it never reads
 * the database and never echoes the community ID: nothing says whether the
 * community or a live room exists.
 */
export function renderVoiceRoomLandingPage(
  valid: boolean,
  downloadUrl: string | null,
): string {
  const body = valid
    ? `<p class="label">LOOP</p><h1>语音房邀请</h1><p>在 LOOP 里加入这个社区的语音房</p><p class="hint">安装 LOOP 后再次打开这个链接即可进入。</p>${downloadLink(downloadUrl)}`
    : `<p class="label">LOOP</p><h1>链接无效</h1><p>这个语音房链接无效。</p>`;
  return renderLandingDocument(body);
}

/**
 * Minimal static page for a shared community link `/c/{communityId}` opened
 * without LOOP installed (Decision 0095). Like `/u/` and `/c/{id}/room`, it
 * never reads the database and never echoes the community ID.
 */
export function renderCommunityLandingPage(
  valid: boolean,
  downloadUrl: string | null,
): string {
  const body = valid
    ? `<p class="label">LOOP</p><h1>社区邀请</h1><p>在 LOOP 里查看并加入这个社区</p><p class="hint">安装 LOOP 后再次打开这个链接即可进入。</p>${downloadLink(downloadUrl)}`
    : `<p class="label">LOOP</p><h1>链接无效</h1><p>这个社区链接无效。</p>`;
  return renderLandingDocument(body);
}

/**
 * Minimal page for a shared invite link `/i/{code}` opened without LOOP
 * installed (Decision 0162). With the app installed the system opens it
 * directly (`/i/*` is claimed in both association files) and the app reads
 * the code from the path. Like `/u/`, it never reads the database: the code
 * shown is the canonical form of the one in the URL (check symbol verified),
 * and nothing says whether it was ever issued.
 */
export function renderInviteLandingPage(
  code: string | null,
  stores: {
    readonly ios: string | null;
    readonly android: string | null;
    readonly fallback: string | null;
  } | null,
): string {
  if (code === null || stores === null) {
    return renderLandingDocument(
      `<p class="label">LOOP</p><h1>链接无效</h1><p>这个邀请链接里没有有效的邀请码。</p>`,
    );
  }
  const safeCode = escapeHtml(code);
  const attribute = (name: string, value: string | null): string =>
    value === null ? "" : ` data-${name}="${escapeHtml(value)}"`;
  const storeLinks = [
    stores.ios === null
      ? ""
      : `<a class="store" href="${escapeHtml(stores.ios)}" rel="noopener noreferrer">App Store</a>`,
    stores.android === null
      ? ""
      : `<a class="store" href="${escapeHtml(stores.android)}" rel="noopener noreferrer">Google Play</a>`,
  ].join("");
  const body = `<p class="label">LOOP</p><h1>邀请码</h1><p class="id code">${safeCode}</p><p>好友邀请你加入 LOOP</p><button id="copy" class="cta" type="button" data-code="${safeCode}"${attribute("ios", stores.ios)}${attribute("android", stores.android)}${attribute("fallback", stores.fallback)}>复制邀请码并下载 LOOP</button><p id="status" class="hint" aria-live="polite"></p>${storeLinks === "" ? "" : `<p class="stores">${storeLinks}</p>`}<p class="hint">注册后在「填写邀请码」粘贴即可绑定（注册后 7 天内有效）。已安装 LOOP 时打开这个链接会直接进入 App。</p>`;
  return renderLandingDocument(body, {
    title: `LOOP 邀请码 ${safeCode}`,
    head: `<meta property="og:title" content="LOOP 邀请码 ${safeCode}">
<meta property="og:description" content="好友邀请你加入 LOOP，注册时填写邀请码 ${safeCode}">
<meta name="loop-invite-code" content="${safeCode}">
`,
    script: inviteLandingScript,
  });
}

function downloadLink(downloadUrl: string | null): string {
  return downloadUrl === null
    ? ""
    : `<a class="cta" href="${escapeHtml(downloadUrl)}" rel="noopener noreferrer">下载 LOOP</a>`;
}

function renderLandingDocument(
  body: string,
  extra: {
    readonly title: string;
    readonly head: string;
    readonly script: string;
  } | null = null,
): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${extra === null ? "" : extra.head}<title>${extra === null ? "LOOP" : extra.title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0b;color:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
main{max-width:360px;padding:32px 24px;text-align:center}
.label{margin:0;color:#9a9a92;font-size:13px;letter-spacing:.08em}
h1{margin:8px 0 16px;font-size:28px}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hint{color:#9a9a92;font-size:14px;line-height:1.5}
.cta{display:inline-block;margin-top:16px;min-height:44px;line-height:44px;padding:0 24px;border:0;border-radius:22px;background:#c6f432;color:#0b0b0b;font-weight:600;font-size:16px;text-decoration:none;cursor:pointer}
.code{margin:0 0 8px;font-size:24px;letter-spacing:.06em}
.stores{display:flex;gap:12px;justify-content:center}
.store{color:#f5f5f0;font-size:14px}
</style>
</head>
<body><main>${body}</main>${extra === null ? "" : `<script>${extra.script}</script>`}</body>
</html>
`;
}
