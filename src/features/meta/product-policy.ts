import type { AppConfig, V2ModuleId } from "../../config.js";

export const v2ContractVersion = "2.0" as const;
export const v2ProductConfigVersion = "productPolicyV2.2026-09-01" as const;
export const v2ProductEffectiveAt = "2026-09-01T00:00:00.000Z" as const;

export type V2PrimaryTab =
  "community" | "launch" | "market" | "mining" | "wallet";

export type V2CapabilityAvailability = "available" | "deferred" | "unavailable";

export type V2CapabilityEvidenceStatus = "notApplicable" | "pending";

export interface V2VersionGateUnavailable {
  readonly status: "unavailable";
  readonly minimumSupportedVersions: {
    readonly ios: null;
    readonly android: null;
  };
  readonly forceUpdate: null;
  readonly storeUrls: {
    readonly ios: null;
    readonly android: null;
  };
  readonly reasonCode: "CLIENT_VERSION_POLICY_UNAVAILABLE";
}

export interface V2VersionGateAvailable {
  readonly status: "available";
  readonly minimumSupportedVersions: {
    readonly ios: string;
    readonly android: string;
  };
  readonly forceUpdateBelow: {
    readonly ios: string;
    readonly android: string;
  };
  readonly storeUrls: {
    readonly ios: string;
    readonly android: string;
  };
  readonly reasonCode: null;
}

export type V2VersionGate = V2VersionGateAvailable | V2VersionGateUnavailable;

export interface V2RegionGateUnavailable {
  readonly status: "unavailable";
  readonly reasonCode: "REGION_POLICY_UNAVAILABLE";
  readonly supportUrl: null;
  readonly readOnlyAssetAccess: null;
}

export interface V2TermsGateUnavailable {
  readonly status: "unavailable";
  readonly requiredVersion: null;
  readonly reasonCode: "TERMS_POLICY_UNAVAILABLE";
}

export interface V2TermsGateAvailable {
  readonly status: "available";
  readonly requiredVersion: string;
  readonly reasonCode: null;
}

export type V2TermsGate = V2TermsGateAvailable | V2TermsGateUnavailable;

export interface V2ClientPolicyProjection {
  readonly contractVersion: typeof v2ContractVersion;
  readonly configVersion: string;
  readonly effectiveAt: string;
  readonly defaultRoute: "community";
  readonly navigation: {
    readonly primaryTabs: readonly V2PrimaryTab[];
  };
  readonly versionGate: V2VersionGate;
  readonly regionGate: V2RegionGateUnavailable;
  readonly termsGate: V2TermsGate;
}

export interface V2CapabilityProjection {
  readonly capabilityId: string;
  readonly availability: V2CapabilityAvailability;
  readonly reasonCode: string | null;
  readonly evidence: {
    readonly status: V2CapabilityEvidenceStatus;
    readonly reasonCode: string | null;
  };
}

export interface V2CapabilitiesProjection {
  readonly contractVersion: typeof v2ContractVersion;
  readonly configVersion: typeof v2ProductConfigVersion;
  readonly effectiveAt: typeof v2ProductEffectiveAt;
  readonly capabilities: readonly V2CapabilityProjection[];
}

export interface V2ProductPolicyProjection {
  readonly clientPolicy: V2ClientPolicyProjection;
  readonly capabilities: V2CapabilitiesProjection;
}

export const v2ModuleRuntimeNotRegisteredReasonCode =
  "MODULE_RUNTIME_NOT_REGISTERED" as const;

/**
 * Capability projected by each V2 module gate. A module without a capability
 * entry (search, market, profile) is still gated for route registration; its
 * capability is introduced with consumer review when the module is delivered.
 */
export const v2ModuleCapabilityIds = Object.freeze({
  community: "community",
  search: null,
  market: null,
  wallet: "walletRead",
  swap: "privySwap",
  sendApprovals: "sendApprovals",
  launch: "launch",
  mining: "mining",
  notifications: "pushNotifications",
  profile: null,
} as const satisfies Readonly<Record<V2ModuleId, string | null>>);

const primaryTabs = Object.freeze([
  "community",
  "mining",
  "launch",
  "market",
  "wallet",
] as const satisfies readonly V2PrimaryTab[]);

const unavailableVersionGate = Object.freeze({
  status: "unavailable",
  minimumSupportedVersions: Object.freeze({ ios: null, android: null }),
  forceUpdate: null,
  storeUrls: Object.freeze({ ios: null, android: null }),
  reasonCode: "CLIENT_VERSION_POLICY_UNAVAILABLE",
} as const satisfies V2VersionGateUnavailable);

const unavailableRegionGate = Object.freeze({
  status: "unavailable",
  reasonCode: "REGION_POLICY_UNAVAILABLE",
  supportUrl: null,
  readOnlyAssetAccess: null,
} as const satisfies V2RegionGateUnavailable);

const unavailableTermsGate = Object.freeze({
  status: "unavailable",
  requiredVersion: null,
  reasonCode: "TERMS_POLICY_UNAVAILABLE",
} as const satisfies V2TermsGateUnavailable);

function versionGate(config: AppConfig): V2VersionGate {
  const policy = config.v2ClientPolicy.versionPolicy;
  if (policy === null) {
    return unavailableVersionGate;
  }
  return Object.freeze({
    status: "available",
    minimumSupportedVersions: Object.freeze({
      ios: policy.minimumSupportedVersions.ios,
      android: policy.minimumSupportedVersions.android,
    }),
    forceUpdateBelow: Object.freeze({
      ios: policy.forceUpdateBelow.ios,
      android: policy.forceUpdateBelow.android,
    }),
    storeUrls: Object.freeze({
      ios: policy.storeUrls.ios,
      android: policy.storeUrls.android,
    }),
    reasonCode: null,
  });
}

function termsGate(config: AppConfig): V2TermsGate {
  const requiredVersion = config.v2ClientPolicy.termsRequiredVersion;
  if (requiredVersion === null) {
    return unavailableTermsGate;
  }
  return Object.freeze({
    status: "available",
    requiredVersion,
    reasonCode: null,
  });
}

function createClientPolicy(config: AppConfig): V2ClientPolicyProjection {
  return Object.freeze({
    contractVersion: v2ContractVersion,
    configVersion:
      config.v2ClientPolicy.configVersion ?? v2ProductConfigVersion,
    effectiveAt: config.v2ClientPolicy.effectiveAt ?? v2ProductEffectiveAt,
    defaultRoute: "community",
    navigation: Object.freeze({ primaryTabs }),
    versionGate: versionGate(config),
    regionGate: unavailableRegionGate,
    termsGate: termsGate(config),
  });
}

function runtimeCapability(
  capabilityId: string,
  available: boolean,
  unavailableReasonCode: string,
  pendingEvidenceReasonCode: string,
): V2CapabilityProjection {
  return Object.freeze({
    capabilityId,
    availability: available ? "available" : "unavailable",
    reasonCode: available ? null : unavailableReasonCode,
    evidence: Object.freeze({
      status: "pending",
      reasonCode: pendingEvidenceReasonCode,
    }),
  });
}

function deferredCapability(
  capabilityId: string,
  reasonCode: string,
): V2CapabilityProjection {
  return Object.freeze({
    capabilityId,
    availability: "deferred",
    reasonCode,
    evidence: Object.freeze({
      status: "notApplicable",
      reasonCode: null,
    }),
  });
}

/**
 * A module listed in V2_MODULES_ENABLED moves its capability from `deferred`
 * to `unavailable` with MODULE_RUNTIME_NOT_REGISTERED. Only the module's own
 * delivered route registration may later report `available`.
 */
function moduleGatedCapability(
  config: AppConfig,
  moduleId: V2ModuleId,
  capabilityId: string,
  deferredReasonCode: string,
): V2CapabilityProjection {
  if (!config.v2ModulesEnabled.has(moduleId)) {
    return deferredCapability(capabilityId, deferredReasonCode);
  }
  return Object.freeze({
    capabilityId,
    availability: "unavailable",
    reasonCode: v2ModuleRuntimeNotRegisteredReasonCode,
    evidence: Object.freeze({
      status: "notApplicable",
      reasonCode: null,
    }),
  });
}

export function createV2ProductPolicyProjection(
  config: AppConfig,
  sessionRuntimeAvailable: boolean,
): V2ProductPolicyProjection {
  const privyConfigured = config.privy !== null;
  const streamCredentialsConfigured = config.stream !== null;
  const streamQuotaConfigured = config.streamTokenQuota !== null;
  const streamTokenRuntimeAvailable =
    streamCredentialsConfigured && streamQuotaConfigured;

  const capabilities = Object.freeze([
    runtimeCapability(
      "privyAuthentication",
      privyConfigured,
      "PRIVY_NOT_CONFIGURED",
      "PHYSICAL_DEVICE_AUTH_EVIDENCE_PENDING",
    ),
    runtimeCapability(
      "accountSession",
      privyConfigured && sessionRuntimeAvailable,
      privyConfigured
        ? "ACCOUNT_SESSION_RUNTIME_UNAVAILABLE"
        : "PRIVY_NOT_CONFIGURED",
      "PHYSICAL_DEVICE_SESSION_EVIDENCE_PENDING",
    ),
    runtimeCapability(
      "streamChatToken",
      streamTokenRuntimeAvailable,
      streamCredentialsConfigured
        ? "STREAM_TOKEN_QUOTA_NOT_CONFIGURED"
        : "STREAM_NOT_CONFIGURED",
      "PHYSICAL_DEVICE_STREAM_CONNECTION_EVIDENCE_PENDING",
    ),
    runtimeCapability(
      "streamVideoToken",
      streamTokenRuntimeAvailable,
      streamCredentialsConfigured
        ? "STREAM_TOKEN_QUOTA_NOT_CONFIGURED"
        : "STREAM_NOT_CONFIGURED",
      "PHYSICAL_DEVICE_STREAM_CONNECTION_EVIDENCE_PENDING",
    ),
    moduleGatedCapability(
      config,
      "community",
      v2ModuleCapabilityIds.community,
      "V2_COMMUNITY_RUNTIME_DEFERRED",
    ),
    deferredCapability("bscRead", "BSC_PROVIDER_SELECTION_DEFERRED"),
    moduleGatedCapability(
      config,
      "wallet",
      v2ModuleCapabilityIds.wallet,
      "WALLET_PROJECTION_DEFERRED",
    ),
    moduleGatedCapability(
      config,
      "swap",
      v2ModuleCapabilityIds.swap,
      "PRIVY_SWAP_GO_NO_GO_PENDING",
    ),
    moduleGatedCapability(
      config,
      "sendApprovals",
      v2ModuleCapabilityIds.sendApprovals,
      "SEND_APPROVALS_RUNTIME_DEFERRED",
    ),
    moduleGatedCapability(
      config,
      "launch",
      v2ModuleCapabilityIds.launch,
      "LAUNCH_CONTRACT_BASELINE_PENDING",
    ),
    moduleGatedCapability(
      config,
      "mining",
      v2ModuleCapabilityIds.mining,
      "MINING_FORMULA_BASELINE_PENDING",
    ),
    moduleGatedCapability(
      config,
      "notifications",
      v2ModuleCapabilityIds.notifications,
      "PUSH_RUNTIME_DEFERRED",
    ),
    deferredCapability("pay", "PAY_RUNTIME_DEFERRED"),
    deferredCapability("bridge", "BRIDGE_RUNTIME_DEFERRED"),
    deferredCapability("dappExecution", "DAPP_EXECUTION_RUNTIME_DEFERRED"),
    deferredCapability("communityAi", "COMMUNITY_AI_RUNTIME_DEFERRED"),
  ] satisfies readonly V2CapabilityProjection[]);

  return Object.freeze({
    clientPolicy: createClientPolicy(config),
    capabilities: Object.freeze({
      contractVersion: v2ContractVersion,
      configVersion: v2ProductConfigVersion,
      effectiveAt: v2ProductEffectiveAt,
      capabilities,
    }),
  });
}
