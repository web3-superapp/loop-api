import { communityConfigVersion } from "../community/community-contract.js";
import { marketTrendingRules } from "../market/market-contract.js";
import { deviceRiskPolicy } from "../security/security-contract.js";
import { settingsPolicy } from "../settings/settings-service.js";
import { supportResponsePolicy } from "../support/support-contract.js";
import {
  bscWriteCanaryPolicyVersion,
  swapPolicy,
} from "../wallet-intents/intent-contract.js";
import {
  v2ProductConfigVersion,
  v2ProductEffectiveAt,
} from "./product-policy.js";

/**
 * Central registry of every mutable rule snapshot the backend publishes
 * (Decision 0037 review). Each entry references the module's own constant so
 * `GET /v2/meta/about` cannot drift from what the module actually stamps on
 * its responses. `clientPolicy` is appended per request from configuration.
 */

export interface ConfigVersionEntry {
  readonly module: string;
  readonly configVersion: string;
  readonly effectiveAt: string | null;
}

export const v2ConfigVersionRegistry: readonly ConfigVersionEntry[] =
  Object.freeze([
    Object.freeze({
      module: "productPolicy",
      configVersion: v2ProductConfigVersion,
      effectiveAt: v2ProductEffectiveAt,
    }),
    Object.freeze({
      module: "sessionPolicy",
      configVersion: "sessionPolicyV1",
      effectiveAt: null,
    }),
    Object.freeze({
      module: "community",
      configVersion: communityConfigVersion,
      effectiveAt: null,
    }),
    Object.freeze({
      module: "marketTrending",
      configVersion: marketTrendingRules.configVersion,
      effectiveAt: null,
    }),
    Object.freeze({
      module: "deviceRisk",
      configVersion: deviceRiskPolicy.configVersion,
      effectiveAt: null,
    }),
    Object.freeze({
      module: "accountSettings",
      configVersion: settingsPolicy.configVersion,
      effectiveAt: null,
    }),
    Object.freeze({
      module: "support",
      configVersion: supportResponsePolicy.configVersion,
      effectiveAt: null,
    }),
    Object.freeze({
      module: "swapPolicy",
      configVersion: swapPolicy.configVersion,
      effectiveAt: null,
    }),
    Object.freeze({
      module: "bscWriteCanary",
      configVersion: bscWriteCanaryPolicyVersion,
      effectiveAt: null,
    }),
  ]);
