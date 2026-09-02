import type { AppConfig } from "../../config.js";

export const v2ContractVersion = "2.0" as const;
export const v2ProductConfigVersion = "productPolicyV2.2026-09-01" as const;
export const v2ProductEffectiveAt = "2026-09-01T00:00:00.000Z" as const;

export type V2PrimaryTab =
  "community" | "launch" | "market" | "mining" | "wallet";

export type V2CapabilityAvailability = "available" | "deferred" | "unavailable";

export type V2CapabilityEvidenceStatus = "notApplicable" | "pending";

export interface V2ClientPolicyProjection {
  readonly contractVersion: typeof v2ContractVersion;
  readonly configVersion: typeof v2ProductConfigVersion;
  readonly effectiveAt: typeof v2ProductEffectiveAt;
  readonly defaultRoute: "community";
  readonly navigation: {
    readonly primaryTabs: readonly V2PrimaryTab[];
  };
  readonly versionGate: {
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
  };
  readonly regionGate: {
    readonly status: "unavailable";
    readonly reasonCode: "REGION_POLICY_UNAVAILABLE";
    readonly supportUrl: null;
    readonly readOnlyAssetAccess: null;
  };
  readonly termsGate: {
    readonly status: "unavailable";
    readonly requiredVersion: null;
    readonly reasonCode: "TERMS_POLICY_UNAVAILABLE";
  };
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

const primaryTabs = Object.freeze([
  "community",
  "mining",
  "launch",
  "market",
  "wallet",
] as const satisfies readonly V2PrimaryTab[]);

const clientPolicy = Object.freeze({
  contractVersion: v2ContractVersion,
  configVersion: v2ProductConfigVersion,
  effectiveAt: v2ProductEffectiveAt,
  defaultRoute: "community",
  navigation: Object.freeze({ primaryTabs }),
  versionGate: Object.freeze({
    status: "unavailable",
    minimumSupportedVersions: Object.freeze({ ios: null, android: null }),
    forceUpdate: null,
    storeUrls: Object.freeze({ ios: null, android: null }),
    reasonCode: "CLIENT_VERSION_POLICY_UNAVAILABLE",
  }),
  regionGate: Object.freeze({
    status: "unavailable",
    reasonCode: "REGION_POLICY_UNAVAILABLE",
    supportUrl: null,
    readOnlyAssetAccess: null,
  }),
  termsGate: Object.freeze({
    status: "unavailable",
    requiredVersion: null,
    reasonCode: "TERMS_POLICY_UNAVAILABLE",
  }),
} as const satisfies V2ClientPolicyProjection);

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
    deferredCapability("community", "V2_COMMUNITY_RUNTIME_DEFERRED"),
    deferredCapability("bscRead", "BSC_PROVIDER_SELECTION_DEFERRED"),
    deferredCapability("walletRead", "WALLET_PROJECTION_DEFERRED"),
    deferredCapability("privySwap", "PRIVY_SWAP_GO_NO_GO_PENDING"),
    deferredCapability("sendApprovals", "SEND_APPROVALS_RUNTIME_DEFERRED"),
    deferredCapability("launch", "LAUNCH_CONTRACT_BASELINE_PENDING"),
    deferredCapability("mining", "MINING_FORMULA_BASELINE_PENDING"),
    deferredCapability("pushNotifications", "PUSH_RUNTIME_DEFERRED"),
    deferredCapability("pay", "PAY_RUNTIME_DEFERRED"),
    deferredCapability("bridge", "BRIDGE_RUNTIME_DEFERRED"),
    deferredCapability("dappExecution", "DAPP_EXECUTION_RUNTIME_DEFERRED"),
    deferredCapability("communityAi", "COMMUNITY_AI_RUNTIME_DEFERRED"),
  ] satisfies readonly V2CapabilityProjection[]);

  return Object.freeze({
    clientPolicy,
    capabilities: Object.freeze({
      contractVersion: v2ContractVersion,
      configVersion: v2ProductConfigVersion,
      effectiveAt: v2ProductEffectiveAt,
      capabilities,
    }),
  });
}
