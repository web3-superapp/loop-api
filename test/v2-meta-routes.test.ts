import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, v2ModuleIds } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import {
  createV2ProductPolicyProjection,
  v2ModuleCapabilityIds,
} from "../src/features/meta/product-policy.js";
import { createUnavailablePrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import {
  registeredV2ModuleIds,
  v2ModuleRegistrars,
} from "../src/routes/v2/index.js";

const baselineClientPolicy = {
  contractVersion: "2.0",
  configVersion: "productPolicyV2.2026-09-01",
  effectiveAt: "2026-09-01T00:00:00.000Z",
  defaultRoute: "community",
  navigation: {
    primaryTabs: ["community", "mining", "launch", "market", "wallet"],
  },
  versionGate: {
    status: "unavailable",
    minimumSupportedVersions: { ios: null, android: null },
    storeUrls: { ios: null, android: null },
    reasonCode: "CLIENT_VERSION_POLICY_UNAVAILABLE",
  },
  regionGate: {
    status: "unavailable",
    reasonCode: "REGION_POLICY_UNAVAILABLE",
    supportUrl: null,
    readOnlyAssetAccess: null,
  },
  termsGate: {
    status: "unavailable",
    requiredVersion: null,
    reasonCode: "TERMS_POLICY_UNAVAILABLE",
  },
} as const;

const fullVersionPolicyEnvironment = {
  V2_CLIENT_POLICY_MIN_VERSION_IOS: "1.4.0",
  V2_CLIENT_POLICY_MIN_VERSION_ANDROID: "1.3.2",
  V2_CLIENT_POLICY_STORE_URL_IOS: "https://apps.apple.com/app/id0000000000",
  V2_CLIENT_POLICY_STORE_URL_ANDROID:
    "https://play.google.com/store/apps/details?id=app.loop",
} as const;

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

describe("LOOP API V2 meta policy gates", () => {
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

  it("keeps every gate unavailable with exact key sets when no policy is configured", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe(JSON.stringify(baselineClientPolicy));
  });

  it("publishes the version gate only from a complete https/semver policy", async () => {
    const app = await createApp({
      ...fullVersionPolicyEnvironment,
      V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS: "1.2.0",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...baselineClientPolicy,
      versionGate: {
        status: "available",
        minimumSupportedVersions: { ios: "1.4.0", android: "1.3.2" },
        forceUpdateBelow: { ios: "1.2.0", android: "1.3.2" },
        storeUrls: {
          ios: "https://apps.apple.com/app/id0000000000",
          android: "https://play.google.com/store/apps/details?id=app.loop",
        },
        reasonCode: null,
      },
    });
  });

  it("publishes the terms gate and configured policy snapshot metadata", async () => {
    const app = await createApp({
      V2_TERMS_REQUIRED_VERSION: "terms-2026-09",
      V2_CLIENT_POLICY_CONFIG_VERSION: "productPolicyV2.2026-09-07",
      V2_CLIENT_POLICY_EFFECTIVE_AT: "2026-09-07T08:00:00+08:00",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...baselineClientPolicy,
      configVersion: "productPolicyV2.2026-09-07",
      effectiveAt: "2026-09-07T00:00:00.000Z",
      termsGate: {
        status: "available",
        requiredVersion: "terms-2026-09",
        reasonCode: null,
      },
    });
  });

  it("keeps the region gate unavailable even when every other policy is configured", async () => {
    const app = await createApp({
      ...fullVersionPolicyEnvironment,
      V2_TERMS_REQUIRED_VERSION: "terms-2026-09",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy",
    });

    expect(response.json()).toMatchObject({
      regionGate: baselineClientPolicy.regionGate,
    });
  });

  it("fails startup on a partial version policy instead of guessing", () => {
    expect(() =>
      testConfig({ V2_CLIENT_POLICY_MIN_VERSION_IOS: "1.4.0" }),
    ).toThrow(/must be configured together/);
  });

  it("moves enabled module capabilities from deferred to not-registered", async () => {
    const app = await createApp({
      V2_MODULES_ENABLED: "wallet,mining, notifications",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const capabilities = Object.fromEntries(
      response
        .json<{
          readonly capabilities: readonly {
            readonly capabilityId: string;
            readonly availability: string;
            readonly reasonCode: string | null;
            readonly evidence: {
              readonly status: string;
              readonly reasonCode: string | null;
            };
          }[];
        }>()
        .capabilities.map((capability) => [
          capability.capabilityId,
          capability,
        ]),
    );

    expect(response.statusCode).toBe(200);
    for (const capabilityId of ["walletRead", "mining", "pushNotifications"]) {
      expect(capabilities[capabilityId]).toEqual({
        capabilityId,
        availability: "unavailable",
        reasonCode: "MODULE_RUNTIME_NOT_REGISTERED",
        evidence: { status: "notApplicable", reasonCode: null },
      });
    }
    for (const capabilityId of [
      "community",
      "privySwap",
      "sendApprovals",
      "launch",
      "bscRead",
      "pay",
      "bridge",
      "dappExecution",
      "communityAi",
    ]) {
      expect(capabilities[capabilityId]?.availability).toBe("deferred");
    }
    expect(Object.keys(capabilities)).toHaveLength(16);
  });

  it("keeps the module gate set and the capability projection consistent", () => {
    for (const moduleId of v2ModuleIds) {
      const capabilityId = v2ModuleCapabilityIds[moduleId];
      const projection = createV2ProductPolicyProjection(
        testConfig({ V2_MODULES_ENABLED: moduleId }),
        false,
      );
      const gated = projection.capabilities.capabilities.filter(
        (capability) =>
          capability.reasonCode === "MODULE_RUNTIME_NOT_REGISTERED",
      );

      if (capabilityId === null) {
        expect(gated).toEqual([]);
      } else {
        expect(gated.map((capability) => capability.capabilityId)).toEqual([
          capabilityId,
        ]);
      }
    }
  });

  it("registers no module route until a module delivers its registrar", async () => {
    const config = testConfig({ V2_MODULES_ENABLED: v2ModuleIds.join(",") });
    const app = await createApp({ V2_MODULES_ENABLED: v2ModuleIds.join(",") });

    expect(Object.values(v2ModuleRegistrars).every((r) => r === null)).toBe(
      true,
    );
    expect(registeredV2ModuleIds(config)).toEqual([]);
    for (const path of [
      "/v2/wallet",
      "/v2/community/home",
      "/v2/profile",
      "/v2/search",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: "NOT_FOUND",
        category: "validation",
      });
    }
    const policy = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy",
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.body).toBe(JSON.stringify(baselineClientPolicy));
  });

  it("rejects unknown and duplicate module IDs at startup", () => {
    expect(() =>
      testConfig({ V2_MODULES_ENABLED: "wallet,hyperliquid" }),
    ).toThrow(/unknown module ID/);
    expect(() => testConfig({ V2_MODULES_ENABLED: "wallet,wallet" })).toThrow(
      /duplicate module ID/,
    );
  });
});
