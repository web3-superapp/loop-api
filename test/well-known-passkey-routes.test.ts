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

function fakeDatabase(): Database {
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: vi.fn(() => Promise.resolve(null)),
      getOrCreateByPrivyUserId: vi.fn(() =>
        Promise.resolve({ id: "6d12a86e-4134-47e6-9312-c5ef75a30f55" }),
      ),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
}

describe("Passkey relying-party discovery files (Decision 0063)", () => {
  const apps: FastifyInstance[] = [];

  async function buildTestApp(overrides: Record<string, string> = {}) {
    const app = await buildApp({
      config: testConfig(overrides),
      database: fakeDatabase(),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("publishes both Android statements for the configured package", async () => {
    const app = await buildTestApp({
      PASSKEY_ANDROID_CERT_SHA256: `${debugKeystoreFingerprint},${releaseKeystoreFingerprint}`,
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
        target: {
          namespace: "android_app",
          package_name: "com.cywd.loop",
          sha256_cert_fingerprints: [
            debugKeystoreFingerprint,
            releaseKeystoreFingerprint,
          ],
        },
      },
    ]);
  });

  it("honours an operator-chosen Android package name", async () => {
    const app = await buildTestApp({
      PASSKEY_ANDROID_PACKAGE: "com.cywd.loop.dev",
      PASSKEY_ANDROID_CERT_SHA256: debugKeystoreFingerprint,
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<readonly { target: { package_name: string } }[]>()[0]
        ?.target.package_name,
    ).toBe("com.cywd.loop.dev");
  });

  it("serves the Android file as plain JSON, publicly cacheable, without a token", async () => {
    const app = await buildTestApp({
      PASSKEY_ANDROID_CERT_SHA256: debugKeystoreFingerprint,
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("answers the Android file identically with or without headers a client might send", async () => {
    const app = await buildTestApp({
      PASSKEY_ANDROID_CERT_SHA256: debugKeystoreFingerprint,
    });

    const anonymous = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });
    const decorated = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
      headers: {
        authorization: "Bearer not-a-real-token",
        "x-loop-contract-version": "2.0",
      },
    });

    expect(anonymous.statusCode).toBe(200);
    expect(decorated.statusCode).toBe(200);
    expect(decorated.body).toBe(anonymous.body);
  });

  it("does not publish an Android file when no signing fingerprint is configured", async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/assetlinks.json",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe("not_found");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("publishes the Apple application identifier from the Team ID and bundle ID", async () => {
    const app = await buildTestApp({
      PASSKEY_IOS_TEAM_ID: "ABCDE12345",
      PASSKEY_IOS_BUNDLE_ID: "com.cywd.loop",
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      webcredentials: { apps: ["ABCDE12345.com.cywd.loop"] },
    });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("defaults the Apple bundle ID and needs no token", async () => {
    const app = await buildTestApp({ PASSKEY_IOS_TEAM_ID: "ABCDE12345" });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ webcredentials: { apps: readonly string[] } }>()
        .webcredentials.apps,
    ).toEqual(["ABCDE12345.com.cywd.loop"]);
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("does not publish an Apple file without a Team ID", async () => {
    const app = await buildTestApp({
      PASSKEY_ANDROID_CERT_SHA256: debugKeystoreFingerprint,
    });

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe("not_found");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("keeps both files out of the generated OpenAPI documents", async () => {
    const app = await buildTestApp({
      PASSKEY_ANDROID_CERT_SHA256: debugKeystoreFingerprint,
      PASSKEY_IOS_TEAM_ID: "ABCDE12345",
    });
    await app.ready();

    const paths = Object.keys(
      (app.swagger() as { paths?: Record<string, unknown> }).paths ?? {},
    );

    expect(paths).not.toContain("/.well-known/assetlinks.json");
    expect(paths).not.toContain("/.well-known/apple-app-site-association");
  });
});

describe("Passkey relying-party configuration (Decision 0063)", () => {
  it("rejects a fingerprint that is not 32 colon-separated hex byte pairs", () => {
    expect(() =>
      testConfig({ PASSKEY_ANDROID_CERT_SHA256: "AE:60:82" }),
    ).toThrow(ConfigurationError);
  });

  it("rejects a repeated fingerprint", () => {
    expect(() =>
      testConfig({
        PASSKEY_ANDROID_CERT_SHA256: `${debugKeystoreFingerprint},${debugKeystoreFingerprint}`,
      }),
    ).toThrow(ConfigurationError);
  });

  it("accepts lowercase hex and publishes it uppercase", () => {
    const config = testConfig({
      PASSKEY_ANDROID_CERT_SHA256: debugKeystoreFingerprint.toLowerCase(),
    });

    expect(config.passkeyRelyingParty.android?.certificateFingerprints).toEqual(
      [debugKeystoreFingerprint],
    );
  });

  it("rejects a Team ID that is not ten characters", () => {
    expect(() => testConfig({ PASSKEY_IOS_TEAM_ID: "ABCDE" })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects a package name that is not dotted", () => {
    expect(() =>
      testConfig({
        PASSKEY_ANDROID_PACKAGE: "loop",
        PASSKEY_ANDROID_CERT_SHA256: debugKeystoreFingerprint,
      }),
    ).toThrow(ConfigurationError);
  });

  it("leaves both halves closed by default", () => {
    const config = testConfig();

    expect(config.passkeyRelyingParty.android).toBeNull();
    expect(config.passkeyRelyingParty.ios).toBeNull();
  });
});
