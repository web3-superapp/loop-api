import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { inviteCodeCheckSymbol } from "../src/features/referral/invite-code.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import {
  inviteLandingContentSecurityPolicy,
  inviteLandingScript,
} from "../src/routes/well-known.js";

const debugKeystoreFingerprint =
  "AE:60:82:E6:21:F5:9D:3E:63:96:F8:CB:4B:8D:86:28:7C:F6:2B:29:06:D5:2C:2E:5D:8E:A7:D4:DB:5E:3E:FA";
const releaseKeystoreFingerprint =
  "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    API_DOCS_ENABLED: "false",
    TRUST_PROXY: "false",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function fakeDatabase(): Database & {
  readonly lookups: ReturnType<typeof vi.fn>;
} {
  const lookups = vi.fn(() => Promise.resolve(null));
  return {
    lookups,
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: lookups,
      getOrCreateByPrivyUserId: vi.fn(() =>
        Promise.resolve({ id: "6d12a86e-4134-47e6-9312-c5ef75a30f55" }),
      ),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

describe("Universal Links / App Links for LOOP ID links (Decision 0090)", () => {
  const apps: FastifyInstance[] = [];

  async function buildTestApp(overrides: Record<string, string> = {}) {
    const database = fakeDatabase();
    const app = await buildApp({
      config: testConfig(overrides),
      database,
      logger: false,
    });
    apps.push(app);
    return { app, database };
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function captureStartupLogs(overrides: Record<string, string>) {
    const lines: string[] = [];
    const app = await buildApp({
      config: testConfig(overrides),
      database: fakeDatabase(),
      logger: {
        level: "warn",
        stream: {
          write: (line: string) => {
            lines.push(line);
          },
        },
      },
    });
    apps.push(app);
    await app.ready();
    return {
      app,
      reasonCodes: lines.map(
        (line) => (JSON.parse(line) as { reasonCode?: string }).reasonCode,
      ),
    };
  }

  it("publishes the Apple association from the Team ID and bundle ID (Decision 0106)", async () => {
    const { app } = await buildTestApp({
      PASSKEY_IOS_TEAM_ID: "ABCDE12345",
      PASSKEY_IOS_BUNDLE_ID: "com.example.loopnext",
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toBe(
      '{"applinks":{"details":[{"appIDs":["ABCDE12345.com.example.loopnext"],"components":[{"/":"/u/*"},{"/":"/c/*"},{"/":"/i/*"}]}]},"webcredentials":{"apps":["ABCDE12345.com.example.loopnext"]}}',
    );
  });

  it("defaults the bundle ID to com.cywd.loopapp when only the Team ID is set", async () => {
    const { app } = await buildTestApp({ PASSKEY_IOS_TEAM_ID: "abcde12345" });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["ABCDE12345.com.cywd.loopapp"],
            components: [{ "/": "/u/*" }, { "/": "/c/*" }, { "/": "/i/*" }],
          },
        ],
      },
      webcredentials: { apps: ["ABCDE12345.com.cywd.loopapp"] },
    });
  });

  it("claims no iOS app with a bundle ID but no Team ID, and warns once", async () => {
    const { app, reasonCodes } = await captureStartupLogs({
      PASSKEY_IOS_BUNDLE_ID: "com.example.loopnext",
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toBe('{"applinks":{"details":[]}}');
    expect(reasonCodes).toEqual(["APPLE_TEAM_ID_MISSING"]);
  });

  it("claims no iOS app with neither Team ID nor bundle ID, Android unaffected", async () => {
    const { app, reasonCodes } = await captureStartupLogs({});

    const apple = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });
    const android = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });

    expect(apple.statusCode).toBe(200);
    expect(apple.json()).toEqual({ applinks: { details: [] } });
    expect(apple.body).not.toContain("webcredentials");
    expect(reasonCodes).toEqual(["APPLE_TEAM_ID_MISSING"]);
    expect(android.statusCode).toBe(200);
    expect(android.body).toBe(
      `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.cywd.loop","sha256_cert_fingerprints":["${debugKeystoreFingerprint}"]}}]`,
    );
  });

  it("logs no Team ID warning once a Team ID is configured", async () => {
    const { reasonCodes } = await captureStartupLogs({
      PASSKEY_IOS_TEAM_ID: "ABCDE12345",
    });

    expect(reasonCodes).toEqual([]);
  });

  it("derives appLinks.iosAppIds from the passkey iOS configuration", () => {
    expect(testConfig().appLinks.iosAppIds).toEqual([]);
    expect(testConfig().passkeyRelyingParty.ios).toBeNull();
    const configured = testConfig({
      PASSKEY_IOS_TEAM_ID: "ABCDE12345",
      PASSKEY_IOS_BUNDLE_ID: "com.cywd.loopapp",
    });
    expect(configured.appLinks.iosAppIds).toEqual([
      "ABCDE12345.com.cywd.loopapp",
    ]);
    expect(configured.passkeyRelyingParty.ios).toEqual({
      appId: "ABCDE12345.com.cywd.loopapp",
    });
  });

  it("publishes the Android App Links statement for the debug keystore by default", async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.body).toBe(
      `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.cywd.loop","sha256_cert_fingerprints":["${debugKeystoreFingerprint}"]}}]`,
    );
  });

  it("appends the release signing fingerprint from ANDROID_RELEASE_CERT_SHA256", async () => {
    const { app } = await buildTestApp({
      ANDROID_RELEASE_CERT_SHA256: releaseKeystoreFingerprint.toLowerCase(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });

    expect(
      response.json<
        readonly { target: { sha256_cert_fingerprints: string[] } }[]
      >()[0]?.target.sha256_cert_fingerprints,
    ).toEqual([debugKeystoreFingerprint, releaseKeystoreFingerprint]);
  });

  it("rejects a malformed or repeated release fingerprint at startup", () => {
    expect(() =>
      testConfig({ ANDROID_RELEASE_CERT_SHA256: "AE:60:82" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      testConfig({ ANDROID_RELEASE_CERT_SHA256: debugKeystoreFingerprint }),
    ).toThrow(ConfigurationError);
  });

  it("rejects an APP_DOWNLOAD_URL that is not https", () => {
    expect(() =>
      testConfig({ APP_DOWNLOAD_URL: "http://example.com/loop" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      testConfig({ APP_DOWNLOAD_URL: "javascript:alert(1)" }),
    ).toThrow(ConfigurationError);
  });

  it("serves a static landing page for a shared LOOP ID without touching the database", async () => {
    const { app, database } = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/u/loop-fe3emcpe",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.body).toContain("LOOP-FE3EMCPE");
    expect(response.body).toContain("在 LOOP 里添加好友");
    expect(response.body).not.toContain("<a ");
    expect(response.body).not.toContain("<script");
    expect(database.lookups).not.toHaveBeenCalled();
  });

  it("shows the download link only when APP_DOWNLOAD_URL is configured", async () => {
    const { app } = await buildTestApp({
      APP_DOWNLOAD_URL: "https://testflight.apple.com/join/example",
    });

    const response = await app.inject({
      method: "GET",
      url: "/u/LOOP-FE3EMCPE",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'href="https://testflight.apple.com/join/example"',
    );
  });

  it("answers a malformed LOOP ID link with an uncached 404 page", async () => {
    const { app } = await buildTestApp();

    for (const url of [
      "/u/LOOP-FE3E",
      "/u/%3Cscript%3E",
      "/u/LOOP-FE3EMCPE1",
      "/u/LOOP-ABCDE",
      `/u/${"A".repeat(90)}`,
      `/c/${"a".repeat(90)}`,
      `/c/${"a".repeat(90)}/room`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("<script>");
    }
  });

  it("serves a static voice-room landing page that neither reads the database nor echoes the community (Decision 0091)", async () => {
    const { app, database } = await buildTestApp({
      APP_DOWNLOAD_URL: "https://testflight.apple.com/join/example",
    });
    const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

    const response = await app.inject({
      method: "GET",
      url: `/c/${communityId}/room`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    expect(response.body).toContain("语音房邀请");
    expect(response.body).toContain(
      'href="https://testflight.apple.com/join/example"',
    );
    expect(response.body).not.toContain(communityId);
    expect(response.body).not.toContain("<script");
    expect(database.lookups).not.toHaveBeenCalled();
  });

  it("omits the download link on the voice-room page without APP_DOWNLOAD_URL", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/c/3fa85f64-5717-4562-b3fc-2c963f66afa6/room",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("<a ");
  });

  it("answers a malformed voice-room link with an uncached 404 page", async () => {
    const { app } = await buildTestApp();

    for (const url of [
      "/c/not-a-community/room",
      "/c/3FA85F64-5717-4562-B3FC-2C963F66AFA6/room",
      "/c/3fa85f64-5717-1562-b3fc-2c963f66afa6/room",
      "/c/%3Cscript%3E/room",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toContain("链接无效");
      expect(response.body).not.toContain("<script>");
    }
  });

  it("serves a static community landing page that neither reads the database nor echoes the community (Decision 0095)", async () => {
    const { app, database } = await buildTestApp({
      APP_DOWNLOAD_URL: "https://testflight.apple.com/join/example",
    });
    const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const response = await app.inject({
      method: "GET",
      url: `/c/${communityId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    expect(response.body).toContain("社区邀请");
    expect(response.body).toContain(
      'href="https://testflight.apple.com/join/example"',
    );
    expect(response.body).not.toContain(communityId);
    expect(database.lookups).not.toHaveBeenCalled();

    for (const url of [
      "/c/not-a-community",
      "/c/3FA85F64-5717-4562-B3FC-2C963F66AFA6",
      "/c/%3Cscript%3E",
    ]) {
      const invalid = await app.inject({ method: "GET", url });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.headers["cache-control"]).toBe("no-store");
      expect(invalid.body).toContain("链接无效");
      expect(invalid.body).not.toContain("<script>");
    }
    // The voice-room page keeps its own route.
    const room = await app.inject({
      method: "GET",
      url: `/c/${communityId}/room`,
    });
    expect(room.body).toContain("语音房邀请");
  });

  it("keeps the landing page and both association files out of OpenAPI", async () => {
    const { app } = await buildTestApp();
    await app.ready();

    const paths = Object.keys(
      (app.swagger() as { paths?: Record<string, unknown> }).paths ?? {},
    );

    expect(paths).not.toContain("/u/{loopId}");
    expect(paths).not.toContain("/i/{code}");
    expect(paths).not.toContain("/c/{communityId}/room");
    expect(paths).not.toContain("/c/{communityId}");
    expect(paths).not.toContain("/.well-known/assetlinks.json");
    expect(paths).not.toContain("/.well-known/apple-app-site-association");
  });

  const inviteCode = `LOOP-7HJK${inviteCodeCheckSymbol("7HJK")}`;

  it("serves the invite landing page with the canonical code, the copy button and only its own script (Decision 0162)", async () => {
    const { app, database } = await buildTestApp({
      APP_STORE_URL_IOS: "https://apps.apple.com/app/id000000",
      APP_STORE_URL_ANDROID:
        "https://play.google.com/store/apps/details?id=com.cywd.loop",
      APP_DOWNLOAD_URL: "https://example.com/loop",
    });
    const response = await app.inject({
      method: "GET",
      url: `/i/${inviteCode.toLowerCase().replace("loop-", "")}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    const policy = response.headers["content-security-policy"];
    expect(policy).toBe(inviteLandingContentSecurityPolicy);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(response.body).toContain(`<script>${inviteLandingScript}</script>`);
    expect(response.body.match(/<script/g)).toHaveLength(1);
    expect(response.body).toContain(`邀请码`);
    expect(response.body).toContain(`data-code="${inviteCode}"`);
    expect(response.body).toContain("复制邀请码并下载 LOOP");
    expect(response.body).toContain(
      'data-ios="https://apps.apple.com/app/id000000"',
    );
    expect(response.body).toContain(
      'href="https://apps.apple.com/app/id000000"',
    );
    expect(response.body).toContain(
      'data-android="https://play.google.com/store/apps/details?id=com.cywd.loop"',
    );
    expect(response.body).toContain('data-fallback="https://example.com/loop"');
    expect(response.body).toContain(
      `<meta property="og:title" content="LOOP 邀请码 ${inviteCode}">`,
    );
    expect(response.body).toContain("background:#0b0b0b");
    expect(database.lookups).not.toHaveBeenCalled();
  });

  it("shows no store link without the store env, and answers a bad code with an uncached 404", async () => {
    const { app } = await buildTestApp();
    const page = await app.inject({ method: "GET", url: `/i/${inviteCode}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("<a ");
    expect(page.body).not.toContain('data-ios="');
    expect(page.body).toContain(`data-code="${inviteCode}"`);
    for (const url of [
      "/i/LOOP-7HJKX",
      "/i/%3Cscript%3E",
      "/i/LOOP-7HJ",
      `/i/${inviteCode}1`,
      `/i/${"A".repeat(90)}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("<script");
      expect(response.body).toContain("链接无效");
    }
  });

  it("rejects store URLs that are not https", () => {
    expect(() =>
      testConfig({ APP_STORE_URL_IOS: "http://apps.apple.com/app/id1" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      testConfig({ APP_STORE_URL_ANDROID: "javascript:alert(1)" }),
    ).toThrow(ConfigurationError);
  });
});
