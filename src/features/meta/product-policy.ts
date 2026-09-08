import type { AppConfig, V2ModuleId } from "../../config.js";

export const v2ContractVersion = "2.0" as const;
export const v2ProductConfigVersion = "productPolicyV2.2026-09-01" as const;
export const v2ProductEffectiveAt = "2026-09-01T00:00:00.000Z" as const;

export type V2PrimaryTab =
  "community" | "launch" | "market" | "mining" | "wallet";

export type V2CapabilityAvailability = "available" | "deferred" | "unavailable";

export type V2CapabilityEvidenceStatus = "notApplicable" | "pending";

/**
 * A configured gate whose `V2_CLIENT_POLICY_EFFECTIVE_AT` is still in the
 * future stays unavailable with this reason until the clock passes it.
 */
export const v2PolicyNotYetEffectiveReasonCode =
  "POLICY_NOT_YET_EFFECTIVE" as const;

export interface V2VersionGateUnavailable {
  readonly status: "unavailable";
  readonly minimumSupportedVersions: {
    readonly ios: null;
    readonly android: null;
  };
  readonly storeUrls: {
    readonly ios: null;
    readonly android: null;
  };
  readonly reasonCode:
    | "CLIENT_VERSION_POLICY_UNAVAILABLE"
    | typeof v2PolicyNotYetEffectiveReasonCode;
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
  readonly reasonCode:
    "TERMS_POLICY_UNAVAILABLE" | typeof v2PolicyNotYetEffectiveReasonCode;
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

/**
 * Runtime facts that only `buildApp` can establish. They are separate from
 * configuration so the projection cannot claim a delivered module or a
 * reachable database it has not been handed.
 */
export interface V2ProductPolicyRuntime {
  readonly sessionRuntimeAvailable: boolean;
  /** `profile` module enabled, registrar delivered, and repository composed. */
  readonly profileRuntimeAvailable: boolean;
  /**
   * `community` module enabled with the PostgreSQL community repository and
   * the V2 cursor codec composed (Decision 0031). Without a cursor secret the
   * owner-bound list pagination cannot be signed, so the module fails closed.
   */
  readonly communityRuntimeAvailable: boolean;
  /** `search` module enabled with the repository, cursor codec, and quota. */
  readonly searchRuntimeAvailable: boolean;
}

export const v2ModuleRuntimeNotRegisteredReasonCode =
  "MODULE_RUNTIME_NOT_REGISTERED" as const;
export const v2ProfileModuleDeferredReasonCode =
  "PROFILE_MODULE_NOT_ENABLED" as const;
export const v2ProfileRuntimeUnavailableReasonCode =
  "PROFILE_RUNTIME_UNAVAILABLE" as const;
export const v2AvatarUploadUnavailableReasonCode =
  "AVATAR_STORAGE_NOT_SELECTED" as const;
export const v2CommunityModuleDeferredReasonCode =
  "V2_COMMUNITY_RUNTIME_DEFERRED" as const;
export const v2CommunityRuntimeUnavailableReasonCode =
  "COMMUNITY_RUNTIME_UNAVAILABLE" as const;
export const v2SearchModuleDeferredReasonCode =
  "V2_SEARCH_RUNTIME_DEFERRED" as const;
export const v2SearchRuntimeUnavailableReasonCode =
  "SEARCH_RUNTIME_UNAVAILABLE" as const;
export const v2CommunityMiningUnavailableReasonCode =
  "MINING_FORMULA_BASELINE_PENDING" as const;
export const v2CommunityPresenceUnavailableReasonCode =
  "STREAM_PRESENCE_NOT_CONNECTED" as const;

/**
 * Capability projected by each V2 module gate. A module without a capability
 * entry (market) is still gated for route registration; its capability is
 * introduced with consumer review when the module is delivered. `profile` was
 * delivered by Decision 0030, `community` and `search` by Decision 0031.
 */
export const v2ModuleCapabilityIds = Object.freeze({
  community: "community",
  search: "search",
  market: null,
  wallet: "walletRead",
  swap: "privySwap",
  sendApprovals: "sendApprovals",
  launch: "launch",
  mining: "mining",
  notifications: "pushNotifications",
  profile: "profile",
} as const satisfies Readonly<Record<V2ModuleId, string | null>>);

export const v2CapabilityIds = Object.freeze([
  "privyAuthentication",
  "accountSession",
  "streamChatToken",
  "streamVideoToken",
  "community",
  "communityMining",
  "communityPresence",
  "search",
  "bscRead",
  "walletRead",
  "privySwap",
  "sendApprovals",
  "launch",
  "mining",
  "pushNotifications",
  "profile",
  "avatarUpload",
  "pay",
  "bridge",
  "dappExecution",
  "communityAi",
] as const);

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

const notYetEffectiveVersionGate = Object.freeze({
  ...unavailableVersionGate,
  reasonCode: v2PolicyNotYetEffectiveReasonCode,
} as const satisfies V2VersionGateUnavailable);

const notYetEffectiveTermsGate = Object.freeze({
  ...unavailableTermsGate,
  reasonCode: v2PolicyNotYetEffectiveReasonCode,
} as const satisfies V2TermsGateUnavailable);

function policyNotYetEffective(config: AppConfig, now: Date): boolean {
  const effectiveAt = config.v2ClientPolicy.effectiveAt;
  if (effectiveAt === null) {
    return false;
  }
  const effectiveAtMs = Date.parse(effectiveAt);
  return Number.isFinite(effectiveAtMs) && effectiveAtMs > now.getTime();
}

function versionGate(config: AppConfig, now: Date): V2VersionGate {
  const policy = config.v2ClientPolicy.versionPolicy;
  if (policy === null) {
    return unavailableVersionGate;
  }
  if (policyNotYetEffective(config, now)) {
    return notYetEffectiveVersionGate;
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

function termsGate(config: AppConfig, now: Date): V2TermsGate {
  const requiredVersion = config.v2ClientPolicy.termsRequiredVersion;
  if (requiredVersion === null) {
    return unavailableTermsGate;
  }
  if (policyNotYetEffective(config, now)) {
    return notYetEffectiveTermsGate;
  }
  return Object.freeze({
    status: "available",
    requiredVersion,
    reasonCode: null,
  });
}

/**
 * The client policy is evaluated per request against the current clock so a
 * gate whose `effectiveAt` lies in the future switches on without a restart.
 */
export function createV2ClientPolicyProjection(
  config: AppConfig,
  now: Date = new Date(),
): V2ClientPolicyProjection {
  return Object.freeze({
    contractVersion: v2ContractVersion,
    configVersion:
      config.v2ClientPolicy.configVersion ?? v2ProductConfigVersion,
    effectiveAt: config.v2ClientPolicy.effectiveAt ?? v2ProductEffectiveAt,
    defaultRoute: "community",
    navigation: Object.freeze({ primaryTabs }),
    versionGate: versionGate(config, now),
    regionGate: unavailableRegionGate,
    termsGate: termsGate(config, now),
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

/**
 * A delivered module: its capability is `available` only when the module is
 * enabled and `buildApp` composed every dependency the routes need. A missing
 * dependency is `unavailable` with the module's own reason, never `available`.
 */
function deliveredModuleCapability(
  config: AppConfig,
  moduleId: V2ModuleId,
  capabilityId: string,
  runtimeAvailable: boolean,
  deferredReasonCode: string,
  unavailableReasonCode: string,
): V2CapabilityProjection {
  if (!config.v2ModulesEnabled.has(moduleId)) {
    return deferredCapability(capabilityId, deferredReasonCode);
  }
  return Object.freeze({
    capabilityId,
    availability: runtimeAvailable ? "available" : "unavailable",
    reasonCode: runtimeAvailable ? null : unavailableReasonCode,
    evidence: Object.freeze({
      status: "notApplicable",
      reasonCode: null,
    }),
  });
}

/**
 * The `profile` module is delivered (Decision 0030). Its capability is
 * `available` only when the module is enabled and `buildApp` composed the
 * PostgreSQL profile repository; otherwise it reports why.
 */
function profileCapability(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
): V2CapabilityProjection {
  if (!config.v2ModulesEnabled.has("profile")) {
    return deferredCapability(
      v2ModuleCapabilityIds.profile,
      v2ProfileModuleDeferredReasonCode,
    );
  }
  return Object.freeze({
    capabilityId: v2ModuleCapabilityIds.profile,
    availability: runtime.profileRuntimeAvailable ? "available" : "unavailable",
    reasonCode: runtime.profileRuntimeAvailable
      ? null
      : v2ProfileRuntimeUnavailableReasonCode,
    evidence: Object.freeze({
      status: "notApplicable",
      reasonCode: null,
    }),
  });
}

function unavailableCapability(
  capabilityId: string,
  reasonCode: string,
): V2CapabilityProjection {
  return Object.freeze({
    capabilityId,
    availability: "unavailable",
    reasonCode,
    evidence: Object.freeze({
      status: "notApplicable",
      reasonCode: null,
    }),
  });
}

export function createV2CapabilitiesProjection(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
): V2CapabilitiesProjection {
  const { sessionRuntimeAvailable } = runtime;
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
    deliveredModuleCapability(
      config,
      "community",
      v2ModuleCapabilityIds.community,
      runtime.communityRuntimeAvailable,
      v2CommunityModuleDeferredReasonCode,
      v2CommunityRuntimeUnavailableReasonCode,
    ),
    unavailableCapability(
      "communityMining",
      v2CommunityMiningUnavailableReasonCode,
    ),
    unavailableCapability(
      "communityPresence",
      v2CommunityPresenceUnavailableReasonCode,
    ),
    deliveredModuleCapability(
      config,
      "search",
      v2ModuleCapabilityIds.search,
      runtime.searchRuntimeAvailable,
      v2SearchModuleDeferredReasonCode,
      v2SearchRuntimeUnavailableReasonCode,
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
    profileCapability(config, runtime),
    unavailableCapability("avatarUpload", v2AvatarUploadUnavailableReasonCode),
    deferredCapability("pay", "PAY_RUNTIME_DEFERRED"),
    deferredCapability("bridge", "BRIDGE_RUNTIME_DEFERRED"),
    deferredCapability("dappExecution", "DAPP_EXECUTION_RUNTIME_DEFERRED"),
    deferredCapability("communityAi", "COMMUNITY_AI_RUNTIME_DEFERRED"),
  ] satisfies readonly V2CapabilityProjection[]);

  return Object.freeze({
    contractVersion: v2ContractVersion,
    configVersion: v2ProductConfigVersion,
    effectiveAt: v2ProductEffectiveAt,
    capabilities,
  });
}

export function createV2ProductPolicyProjection(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
  now: Date = new Date(),
): V2ProductPolicyProjection {
  return Object.freeze({
    clientPolicy: createV2ClientPolicyProjection(config, now),
    capabilities: createV2CapabilitiesProjection(config, runtime),
  });
}
