import type { AppConfig } from "../../config.js";
import { deviceRiskPolicy } from "../security/security-contract.js";
import { settingsPolicy } from "../settings/settings-service.js";
import { supportResponsePolicy } from "../support/support-contract.js";
import {
  bscWriteCanaryPolicyVersion,
  swapPolicy,
} from "../wallet-intents/intent-contract.js";
import {
  openSourceAttributionEntries,
  openSourceAttributionSource,
  openSourceAttributionSummary,
  type OpenSourceAttributionEntry,
} from "./open-source-attribution.js";
import {
  createV2ClientPolicyProjection,
  v2ContractVersion,
  v2ProductConfigVersion,
  v2ProductEffectiveAt,
  type V2TermsGate,
} from "./product-policy.js";

/**
 * Public `GET /v2/meta/about` projection (Decision 0037). It names the
 * contract version and every mutable rule snapshot the backend publishes so
 * the `about` page can show them next to the locally known client build.
 * Nothing here is account state and nothing is a service build version.
 */

export interface ConfigVersionEntry {
  readonly module: string;
  readonly configVersion: string;
  readonly effectiveAt: string | null;
}

export interface AboutProjection {
  readonly contractVersion: typeof v2ContractVersion;
  readonly configVersions: readonly ConfigVersionEntry[];
  readonly termsGate: V2TermsGate;
  readonly openSource: {
    readonly source: typeof openSourceAttributionSource;
    readonly summary: typeof openSourceAttributionSummary;
    readonly entries: readonly OpenSourceAttributionEntry[];
  };
  readonly clientBuild: {
    readonly status: "local";
    readonly reasonCode: "CLIENT_BUILD_IS_DEVICE_LOCAL";
  };
}

export function createV2AboutProjection(
  config: AppConfig,
  now: Date = new Date(),
): AboutProjection {
  const clientPolicy = createV2ClientPolicyProjection(config, now);
  return Object.freeze({
    contractVersion: v2ContractVersion,
    configVersions: Object.freeze([
      Object.freeze({
        module: "productPolicy",
        configVersion: v2ProductConfigVersion,
        effectiveAt: v2ProductEffectiveAt,
      }),
      Object.freeze({
        module: "clientPolicy",
        configVersion: clientPolicy.configVersion,
        effectiveAt: clientPolicy.effectiveAt,
      }),
      Object.freeze({
        module: "sessionPolicy",
        configVersion: "sessionPolicyV1",
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
    ]),
    termsGate: clientPolicy.termsGate,
    openSource: Object.freeze({
      source: openSourceAttributionSource,
      summary: openSourceAttributionSummary,
      entries: openSourceAttributionEntries,
    }),
    clientBuild: Object.freeze({
      status: "local",
      reasonCode: "CLIENT_BUILD_IS_DEVICE_LOCAL",
    }),
  });
}
