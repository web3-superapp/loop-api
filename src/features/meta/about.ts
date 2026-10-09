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

/**
 * Registry entries that describe a mechanism the deployment has not
 * enabled. They stay out of the public document (Decision 0049): an
 * unreleased mechanism must not be discoverable from the about page.
 */
function isPublished(entry: ConfigVersionEntry, config: AppConfig): boolean {
  if (entry.module === "bscWriteCanary") {
    return config.bscWrites !== null;
  }
  return true;
}

export function createV2AboutProjection(
  config: AppConfig,
  now: Date = new Date(),
): AboutProjection {
  const clientPolicy = createV2ClientPolicyProjection(config, now);
  const [productPolicy, ...rest] = v2ConfigVersionRegistry;
  // `clientPolicy` is listed only when an operator override
  // (`V2_CLIENT_POLICY_CONFIG_VERSION`) makes it differ from the product
  // policy it is projected from; otherwise it is the same snapshot and
  // listing one version twice is noise (Decision 0049).
  const clientPolicyEntry =
    productPolicy !== undefined &&
    productPolicy.configVersion === clientPolicy.configVersion
      ? []
      : [
          Object.freeze({
            module: "clientPolicy",
            configVersion: clientPolicy.configVersion,
            effectiveAt: clientPolicy.effectiveAt,
          }),
        ];
  return Object.freeze({
    contractVersion: v2ContractVersion,
    configVersions: Object.freeze([
      ...(productPolicy === undefined ? [] : [productPolicy]),
      ...clientPolicyEntry,
      ...rest.filter((entry) => isPublished(entry, config)),
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
