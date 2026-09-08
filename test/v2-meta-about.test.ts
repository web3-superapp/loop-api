import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import {
  openSourceAttributionEntries,
  openSourceAttributionSource,
  openSourceAttributionSummary,
} from "../src/features/meta/open-source-attribution.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import { createUnavailablePrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function unavailableDatabase(): Database {
  const rejected = () => Promise.reject(new Error("database unavailable"));
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: rejected,
      getOrCreateByPrivyUserId: rejected,
    },
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

interface AboutView {
  readonly contractVersion: string;
  readonly configVersions: readonly {
    readonly module: string;
    readonly configVersion: string;
    readonly effectiveAt: string | null;
  }[];
  readonly termsGate: Record<string, unknown>;
  readonly openSource: {
    readonly source: string;
    readonly summary: string;
    readonly entries: readonly Record<string, string>[];
  };
  readonly clientBuild: Record<string, unknown>;
}

describe("GET /v2/meta/about", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(overrides: Readonly<Record<string, string>> = {}) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: unavailableDatabase(),
      privyAccessTokenVerifier: createUnavailablePrivyAccessTokenVerifier(),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  it("is public and names the contract, every configVersion, the terms slot, and the attribution summary", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: "/v2/meta/about" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<AboutView>();
    expect(Object.keys(body).sort()).toEqual([
      "clientBuild",
      "configVersions",
      "contractVersion",
      "openSource",
      "termsGate",
    ]);
    expect(body.contractVersion).toBe("2.0");
    expect(body.configVersions.map((entry) => entry.module)).toEqual([
      "productPolicy",
      "clientPolicy",
      "sessionPolicy",
      "deviceRisk",
      "accountSettings",
      "support",
      "swapPolicy",
      "bscWriteCanary",
    ]);
    expect(body.configVersions[0]).toEqual({
      module: "productPolicy",
      configVersion: "productPolicyV2.2026-09-01",
      effectiveAt: "2026-09-01T00:00:00.000Z",
    });
    expect(body.termsGate).toEqual({
      status: "unavailable",
      requiredVersion: null,
      reasonCode: "TERMS_POLICY_UNAVAILABLE",
    });
    expect(body.openSource.source).toBe(openSourceAttributionSource);
    expect(body.openSource.summary).toBe(openSourceAttributionSummary);
    expect(body.openSource.entries).toHaveLength(
      openSourceAttributionEntries.length,
    );
    expect(body.clientBuild).toEqual({
      status: "local",
      reasonCode: "CLIENT_BUILD_IS_DEVICE_LOCAL",
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|password|api[_-]?key/i);
  });

  it("publishes the configured terms version through the same gate as the client policy", async () => {
    const app = await createApp({
      V2_TERMS_REQUIRED_VERSION: "terms-2026-09",
      V2_CLIENT_POLICY_CONFIG_VERSION: "productPolicyV2.2026-09-07",
      V2_CLIENT_POLICY_EFFECTIVE_AT: "2026-09-07T00:00:00Z",
    });
    const response = await app.inject({ method: "GET", url: "/v2/meta/about" });
    const body = response.json<AboutView>();
    expect(body.termsGate).toEqual({
      status: "available",
      requiredVersion: "terms-2026-09",
      reasonCode: null,
    });
    expect(
      body.configVersions.find((entry) => entry.module === "clientPolicy")
        ?.configVersion,
    ).toBe("productPolicyV2.2026-09-07");
  });

  it("rejects query input", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/about?verbose=true",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("keeps the compiled attribution constant in sync with docs/open-source-attribution.md", async () => {
    const markdown = await readFile(
      resolve(repositoryRoot, openSourceAttributionSource),
      "utf8",
    );
    const rows = markdown
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Package"))
      .filter((line) => !/^\|\s*-+/.test(line))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim().replace(/^`|`$/g, "")),
      )
      .map(([name, version, purpose, license]) => ({
        name,
        version,
        purpose,
        license,
      }));
    expect(rows).toEqual(openSourceAttributionEntries);
    expect(markdown.replace(/\n/g, " ")).toContain(
      openSourceAttributionSummary,
    );
  });
});
