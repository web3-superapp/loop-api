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
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";

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

  it("publishes the Apple association with applinks and the passkey webcredentials", async () => {
    const { app } = await buildTestApp({ PASSKEY_IOS_TEAM_ID: "867CN6U7W9" });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toBe(
      '{"applinks":{"details":[{"appIDs":["867CN6U7W9.com.cywd.loop"],"components":[{"/":"/u/*"}]}]},"webcredentials":{"apps":["867CN6U7W9.com.cywd.loop"]}}',
    );
  });

  it("publishes applinks alone while passkeys are not configured", async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["867CN6U7W9.com.cywd.loop"],
            components: [{ "/": "/u/*" }],
          },
        ],
      },
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
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("<script>");
    }
  });

  it("keeps the landing page and both association files out of OpenAPI", async () => {
    const { app } = await buildTestApp();
    await app.ready();

    const paths = Object.keys(
      (app.swagger() as { paths?: Record<string, unknown> }).paths ?? {},
    );

    expect(paths).not.toContain("/u/{loopId}");
    expect(paths).not.toContain("/.well-known/assetlinks.json");
    expect(paths).not.toContain("/.well-known/apple-app-site-association");
  });
});
