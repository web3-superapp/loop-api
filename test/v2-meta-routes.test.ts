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
  createV2ClientPolicyProjection,
  createV2ProductPolicyProjection,
  v2CapabilityIds,
  v2ModuleCapabilityIds,
} from "../src/features/meta/product-policy.js";
import { createUnavailableProfileV2Repository } from "../src/features/profile/profile-v2-repository.js";
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

const policySnapshotEnvironment = {
  V2_CLIENT_POLICY_CONFIG_VERSION: "productPolicyV2.2026-09-07",
  V2_CLIENT_POLICY_EFFECTIVE_AT: "2026-09-06T08:00:00+08:00",
} as const;

const fullVersionPolicyEnvironment = {
  ...policySnapshotEnvironment,
  V2_CLIENT_POLICY_MIN_VERSION_IOS: "1.4.0",
  V2_CLIENT_POLICY_MIN_VERSION_ANDROID: "1.3.2",
  V2_CLIENT_POLICY_STORE_URL_IOS: "https://apps.apple.com/app/id0000000000",
  V2_CLIENT_POLICY_STORE_URL_ANDROID:
    "https://play.google.com/store/apps/details?id=app.loop",
} as const;

const configuredSnapshot = {
  configVersion: "productPolicyV2.2026-09-07",
  effectiveAt: "2026-09-06T00:00:00.000Z",
} as const;

const availableVersionGate = {
  status: "available",
  minimumSupportedVersions: { ios: "1.4.0", android: "1.3.2" },
  forceUpdateBelow: { ios: "1.4.0", android: "1.3.2" },
  storeUrls: {
    ios: "https://apps.apple.com/app/id0000000000",
    android: "https://play.google.com/store/apps/details?id=app.loop",
  },
  reasonCode: null,
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

function unavailableDatabase(includeProfileV2 = false): Database {
  const rejected = () => Promise.reject(new Error("database unavailable"));
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    ...(includeProfileV2
      ? { profilesV2: createUnavailableProfileV2Repository() }
      : {}),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: rejected,
      getOrCreateByPrivyUserId: rejected,
    },
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

interface CapabilityView {
  readonly capabilityId: string;
  readonly availability: string;
  readonly reasonCode: string | null;
  readonly evidence: {
    readonly status: string;
    readonly reasonCode: string | null;
  };
}

async function readCapabilities(
  app: FastifyInstance,
): Promise<Record<string, CapabilityView>> {
  const response = await app.inject({
    method: "GET",
    url: "/v2/meta/capabilities",
  });
  expect(response.statusCode).toBe(200);
  return Object.fromEntries(
    response
      .json<{ readonly capabilities: readonly CapabilityView[] }>()
      .capabilities.map((capability) => [capability.capabilityId, capability]),
  );
}

describe("LOOP API V2 meta policy gates", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    overrides: Readonly<Record<string, string>> = {},
    includeProfileV2 = false,
  ) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: unavailableDatabase(includeProfileV2),
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
      ...configuredSnapshot,
      versionGate: {
        ...availableVersionGate,
        forceUpdateBelow: { ios: "1.2.0", android: "1.3.2" },
      },
    });
  });

  it("publishes the terms gate and configured policy snapshot metadata", async () => {
    const app = await createApp({
      ...policySnapshotEnvironment,
      V2_TERMS_REQUIRED_VERSION: "terms-2026-09",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...baselineClientPolicy,
      ...configuredSnapshot,
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

  it("keeps configured gates unavailable with POLICY_NOT_YET_EFFECTIVE until effectiveAt passes", async () => {
    const futureEffectiveAt = "2099-01-01T00:00:00Z";
    const app = await createApp({
      ...fullVersionPolicyEnvironment,
      V2_TERMS_REQUIRED_VERSION: "terms-2099-01",
      V2_CLIENT_POLICY_EFFECTIVE_AT: futureEffectiveAt,
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/client-policy",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...baselineClientPolicy,
      configVersion: "productPolicyV2.2026-09-07",
      effectiveAt: "2099-01-01T00:00:00.000Z",
      versionGate: {
        ...baselineClientPolicy.versionGate,
        reasonCode: "POLICY_NOT_YET_EFFECTIVE",
      },
      termsGate: {
        ...baselineClientPolicy.termsGate,
        reasonCode: "POLICY_NOT_YET_EFFECTIVE",
      },
    });

    const config = testConfig({
      ...fullVersionPolicyEnvironment,
      V2_TERMS_REQUIRED_VERSION: "terms-2099-01",
      V2_CLIENT_POLICY_EFFECTIVE_AT: futureEffectiveAt,
    });
    const afterEffective = createV2ClientPolicyProjection(
      config,
      new Date("2099-01-01T00:00:00.001Z"),
    );
    expect(afterEffective.versionGate).toEqual(availableVersionGate);
    expect(afterEffective.termsGate).toEqual({
      status: "available",
      requiredVersion: "terms-2099-01",
      reasonCode: null,
    });
  });

  it("fails startup on a partial version policy instead of guessing", () => {
    expect(() =>
      testConfig({
        ...policySnapshotEnvironment,
        V2_CLIENT_POLICY_MIN_VERSION_IOS: "1.4.0",
      }),
    ).toThrow(/must be configured together/);
  });

  it("fails startup when a gate is configured without the policy snapshot identity", () => {
    const withoutVersion: Record<string, string> = {
      ...fullVersionPolicyEnvironment,
    };
    delete withoutVersion["V2_CLIENT_POLICY_CONFIG_VERSION"];
    const withoutEffectiveAt: Record<string, string> = {
      ...fullVersionPolicyEnvironment,
    };
    delete withoutEffectiveAt["V2_CLIENT_POLICY_EFFECTIVE_AT"];

    expect(() => testConfig(withoutVersion)).toThrow(
      /V2_CLIENT_POLICY_CONFIG_VERSION and V2_CLIENT_POLICY_EFFECTIVE_AT are required/,
    );
    expect(() => testConfig(withoutEffectiveAt)).toThrow(
      /V2_CLIENT_POLICY_CONFIG_VERSION and V2_CLIENT_POLICY_EFFECTIVE_AT are required/,
    );
    expect(() =>
      testConfig({ V2_TERMS_REQUIRED_VERSION: "terms-2026-09" }),
    ).toThrow(
      /V2_CLIENT_POLICY_CONFIG_VERSION and V2_CLIENT_POLICY_EFFECTIVE_AT are required/,
    );
  });

  it("moves enabled module capabilities from deferred to not-registered", async () => {
    const app = await createApp({
      V2_MODULES_ENABLED: "mining, notifications",
    });
    const capabilities = await readCapabilities(app);

    // Decision 0036: mining is delivered; without a composed repository it
    // is unavailable, and the formula baseline stays pending as evidence.
    expect(capabilities["mining"]).toEqual({
      capabilityId: "mining",
      availability: "unavailable",
      reasonCode: "MINING_RUNTIME_UNAVAILABLE",
      evidence: {
        status: "pending",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
    });
    // Push delivery never opens with the module gate: no FCM/APNs runtime.
    expect(capabilities["pushNotifications"]).toEqual({
      capabilityId: "pushNotifications",
      availability: "unavailable",
      reasonCode: "PUSH_RUNTIME_DEFERRED",
      evidence: { status: "notApplicable", reasonCode: null },
    });
    for (const capabilityId of ["priceAlerts", "notificationsFeed"]) {
      expect(capabilities[capabilityId]?.availability).toBe("unavailable");
    }
    for (const capabilityId of [
      "community",
      "search",
      "privySwap",
      "sendApprovals",
      "launch",
      "referral",
      "bscRead",
      "walletRead",
      "watchlist",
      "marketRead",
      "pay",
      "bridge",
      "dappExecution",
      "communityAi",
      "profile",
    ]) {
      expect(capabilities[capabilityId]?.availability).toBe("deferred");
    }
    expect(capabilities["profile"]?.reasonCode).toBe(
      "PROFILE_MODULE_NOT_ENABLED",
    );
    expect(capabilities["avatarUpload"]).toEqual({
      capabilityId: "avatarUpload",
      availability: "unavailable",
      reasonCode: "AVATAR_STORAGE_NOT_SELECTED",
      evidence: { status: "notApplicable", reasonCode: null },
    });
    for (const capabilityId of ["communityMining", "communityPresence"]) {
      expect(capabilities[capabilityId]?.availability).toBe("unavailable");
    }
    expect(Object.keys(capabilities)).toHaveLength(v2CapabilityIds.length);
    expect(Object.keys(capabilities)).toHaveLength(31);
  });

  it("names the launch chain slot in the launch capability's evidence only while it is the testnet (Decision 0038)", async () => {
    for (const overrides of [{}, { LAUNCH_CHAIN_ID: "56" }]) {
      const shared = await readCapabilities(
        await createApp({ V2_MODULES_ENABLED: "launch", ...overrides }),
      );
      // Shared slot: the pre-S9 document, key for key.
      expect(shared["launch"]).toEqual({
        capabilityId: "launch",
        availability: "unavailable",
        reasonCode: "LAUNCH_RUNTIME_UNAVAILABLE",
        evidence: {
          status: "pending",
          reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
        },
      });
      for (const [capabilityId, capability] of Object.entries(shared)) {
        expect(Object.keys(capability.evidence), capabilityId).toEqual([
          "status",
          "reasonCode",
        ]);
      }
      expect(Object.keys(shared)).toHaveLength(31);
    }

    const testnet = await readCapabilities(
      await createApp({ V2_MODULES_ENABLED: "launch", LAUNCH_CHAIN_ID: "97" }),
    );
    expect(testnet["launch"]?.evidence).toEqual({
      status: "pending",
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
      launchChainId: "eip155:97",
    });
    for (const [capabilityId, capability] of Object.entries(testnet)) {
      if (capabilityId !== "launch") {
        expect(Object.keys(capability.evidence), capabilityId).toEqual([
          "status",
          "reasonCode",
        ]);
      }
    }
    // bscRead keeps describing only the primary chain: identical with or
    // without the testnet slot.
    const shared = await readCapabilities(
      await createApp({ V2_MODULES_ENABLED: "launch" }),
    );
    expect(testnet["bscRead"]).toEqual(shared["bscRead"]);
  });

  it("reports the delivered profile module as available only with a composed repository", async () => {
    const withoutRepository = await readCapabilities(
      await createApp({ V2_MODULES_ENABLED: "profile" }),
    );
    expect(withoutRepository["profile"]).toEqual({
      capabilityId: "profile",
      availability: "unavailable",
      reasonCode: "PROFILE_RUNTIME_UNAVAILABLE",
      evidence: { status: "notApplicable", reasonCode: null },
    });

    const withRepository = await readCapabilities(
      await createApp({ V2_MODULES_ENABLED: "profile" }, true),
    );
    expect(withRepository["profile"]).toEqual({
      capabilityId: "profile",
      availability: "available",
      reasonCode: null,
      evidence: { status: "notApplicable", reasonCode: null },
    });
    expect(withRepository["avatarUpload"]?.availability).toBe("unavailable");
  });

  it("keeps the module gate set and the capability projection consistent", () => {
    const runtime = {
      sessionRuntimeAvailable: false,
      profileRuntimeAvailable: false,
      communityRuntimeAvailable: false,
      searchRuntimeAvailable: false,
      bscRpcConfigured: false,
      chainRuntimeAvailable: false,
      bscChainVerification: () => "unknown" as const,
      walletRuntimeAvailable: false,
      watchlistRuntimeAvailable: false,
      marketRuntimeAvailable: false,
      priceAlertsRuntimeAvailable: false,
      notificationsFeedRuntimeAvailable: false,
      communicationRuntimeAvailable: false,
      walletIntentRuntimeAvailable: false,
      bscWritesEnabled: false,
      privySwapRuntimeAvailable: false,
      launchRuntimeAvailable: false,
      miningRuntimeAvailable: false,
      referralRuntimeAvailable: false,
      securityRuntimeAvailable: false,
      settingsRuntimeAvailable: false,
      supportRuntimeAvailable: false,
      launchChainId: "eip155:56",
    } as const;
    for (const moduleId of v2ModuleIds) {
      const capabilityId = v2ModuleCapabilityIds[moduleId];
      const projection = createV2ProductPolicyProjection(
        testConfig({ V2_MODULES_ENABLED: moduleId }),
        runtime,
      );
      const gated = projection.capabilities.capabilities.filter(
        (capability) =>
          capability.reasonCode === "MODULE_RUNTIME_NOT_REGISTERED",
      );

      if (v2ModuleRegistrars[moduleId] !== null) {
        expect(gated).toEqual([]);
      } else {
        expect(gated.map((capability) => capability.capabilityId)).toEqual([
          capabilityId,
        ]);
      }
    }
    expect(v2ModuleRegistrars.profile).not.toBeNull();
  });

  it("registers only delivered module routes and keeps undelivered modules at 404", async () => {
    const config = testConfig({ V2_MODULES_ENABLED: v2ModuleIds.join(",") });
    expect(registeredV2ModuleIds(config)).toEqual([
      "community",
      "communication",
      "search",
      "market",
      "chain",
      "wallet",
      "swap",
      "sendApprovals",
      "launch",
      "mining",
      "referral",
      "notifications",
      "profile",
      "watchlist",
      "security",
      "settings",
      "support",
    ]);

    const deliveredModuleIds = new Set<string>([
      "community",
      "communication",
      "search",
      "market",
      "chain",
      "wallet",
      "swap",
      "sendApprovals",
      "launch",
      "mining",
      "referral",
      "notifications",
      "profile",
      "watchlist",
      "security",
      "settings",
      "support",
    ]);
    const undelivered = v2ModuleIds.filter((id) => !deliveredModuleIds.has(id));
    const app = await createApp({
      V2_MODULES_ENABLED: undelivered.join(","),
    });
    expect(
      registeredV2ModuleIds(
        testConfig({ V2_MODULES_ENABLED: undelivered.join(",") }),
      ),
    ).toEqual([]);
    for (const path of [
      "/v2/wallets",
      "/v2/chain/status",
      "/v2/watchlist",
      "/v2/market/overview",
      "/v2/alerts",
      "/v2/notifications/feed",
      "/v2/community/home",
      "/v2/profile",
      "/v2/profile/avatars",
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
