import type { AppConfig } from "../../config.js";
import {
  v2ConfigVersionRegistry,
  type ConfigVersionEntry,
} from "./config-version-registry.js";
import {
  openSourceAttributionEntries,
  openSourceAttributionSource,
  openSourceAttributionSummary,
  type OpenSourceAttributionEntry,
} from "./open-source-attribution.js";
import {
  createV2ClientPolicyProjection,
  v2ContractVersion,
  type V2TermsGate,
} from "./product-policy.js";

/**
 * Public `GET /v2/meta/about` projection (Decision 0037). It names the
 * contract version and every mutable rule snapshot the backend publishes so
 * the `about` page can show them next to the locally known client build.
 * Nothing here is account state and nothing is a service build version.
 */

export type { ConfigVersionEntry } from "./config-version-registry.js";

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
  const [productPolicy, ...rest] = v2ConfigVersionRegistry;
  return Object.freeze({
    contractVersion: v2ContractVersion,
    configVersions: Object.freeze([
      ...(productPolicy === undefined ? [] : [productPolicy]),
      Object.freeze({
        module: "clientPolicy",
        configVersion: clientPolicy.configVersion,
        effectiveAt: clientPolicy.effectiveAt,
      }),
      ...rest,
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
