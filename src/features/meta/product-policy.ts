import type { AppConfig, V2ModuleId } from "../../config.js";
import type { ChainVerificationState } from "../../integrations/bsc/rpc-client.js";
import { bscChainId, type LaunchChainId } from "../chain/chain-contract.js";
import type {
  MiningFormulaBaselineProbe,
  MiningFormulaBaselineState,
} from "../mining/mining-baseline.js";

export const v2ContractVersion = "2.0" as const;
export const v2ProductConfigVersion = "productPolicyV2.2026-09-01" as const;
export const v2ProductEffectiveAt = "2026-09-01T00:00:00.000Z" as const;

export type V2PrimaryTab =
  "community" | "launch" | "market" | "mining" | "wallet";

export type V2CapabilityAvailability = "available" | "deferred" | "unavailable";

/**
 * `confirmed` (Decision 0039) is published only when an operator recorded the
 * external evidence in configuration; it never changes `availability`.
 */
export type V2CapabilityEvidenceStatus =
  "notApplicable" | "pending" | "confirmed";

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
    /**
     * `launch` only, and only while the launch slot differs from the primary
     * chain (Decision 0038): the chain the Launch module points at, so the
     * client can show the testnet badge before any launch exists. Absent on
     * a mainnet-only deployment, keeping that document byte-identical.
     */
    readonly launchChainId?: LaunchChainId;
    /**
     * `voiceRooms` only, and only while `status` is `confirmed` (Decision
     * 0039): the operator's archive reference for the Stream Dashboard
     * evidence. Absent on every other capability and while the evidence is
     * pending, keeping those documents byte-identical.
     */
    readonly reference?: string;
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
  /** At least one BSC RPC endpoint is configured for this process. */
  readonly bscRpcConfigured: boolean;
  /** `chain` module enabled with the RPC endpoint and the registry composed. */
  readonly chainRuntimeAvailable: boolean;
  /**
   * Live `eth_chainId` verification. It is a function because verification is
   * probed asynchronously after startup: the projection must report the
   * current state, never the state that happened to hold when the app was
   * composed.
   */
  readonly bscChainVerification: () => ChainVerificationState;
  /** `wallet` module enabled with Privy credentials and the wallet repository. */
  readonly walletRuntimeAvailable: boolean;
  /** `watchlist` module enabled with the V2 watchlist repository composed. */
  readonly watchlistRuntimeAvailable: boolean;
  /**
   * `market` module enabled with the registry, fact cache, indexer
   * repository, and cursor codec composed (Decision 0034). Provider
   * availability is reported per fact, not here.
   */
  readonly marketRuntimeAvailable: boolean;
  /** `notifications` module enabled with the V2 alert repository and cursor codec. */
  readonly priceAlertsRuntimeAvailable: boolean;
  /** `notifications` module enabled with the notification repository and cursor codec. */
  readonly notificationsFeedRuntimeAvailable: boolean;
  /**
   * Decision 0067: an FCM credential, the push repository and the
   * `notifications` module are all composed. Anything missing keeps
   * `pushNotifications` unavailable with `PUSH_RUNTIME_DEFERRED`.
   */
  readonly pushRuntimeAvailable: boolean;
  /**
   * `communication` module enabled with the PostgreSQL communication
   * repository, the delivered community runtime, and the complete Stream
   * credential pair (Decision 0032). Without Stream credentials the module
   * fails closed rather than publishing a channel or call it cannot reach.
   */
  readonly communicationRuntimeAvailable: boolean;
  /**
   * The community presence reader is composed (Decision 0047): Stream
   * credentials (or an injected community channel gateway) together with
   * the communication runtime that owns the channel records. Without both,
   * `onlineCount` cannot be observed and the capability fails closed.
   */
  readonly communityPresenceRuntimeAvailable: boolean;
  /**
   * `sendApprovals` / `swap` module enabled with the wallet-intent repository,
   * the control plane, the wallet inventory, an RPC endpoint, and
   * `BSC_WRITES_ENABLED` (Decision 0035). Evaluated per request together with
   * the live chain verification.
   */
  readonly walletIntentRuntimeAvailable: boolean;
  readonly bscWritesEnabled: boolean;
  /** Privy credentials composed; the Swap Provider boundary needs them. */
  readonly privySwapRuntimeAvailable: boolean;
  /** `launch` module enabled with the launch repository and cursor codec (Decision 0036). */
  readonly launchRuntimeAvailable: boolean;
  /** The configured `launch` chain slot (Decision 0038). */
  readonly launchChainId: LaunchChainId;
  /** `mining` module enabled with the mining repository composed (Decision 0036). */
  readonly miningRuntimeAvailable: boolean;
  /**
   * Whether a Mining formula version is approved and effective, read per
   * request (Decision 0043). `communityMining` opens on this fact alone; the
   * `mining` module gate stays a runtime question.
   */
  readonly miningFormulaBaseline: MiningFormulaBaselineProbe;
  /** `referral` module enabled with the referral repository composed (Decision 0036). */
  readonly referralRuntimeAvailable: boolean;
  /**
   * `security` module enabled with the device-session repository composed
   * (Decision 0037). Device listing and remote revocation read and write the
   * same `device_sessions` projection as the session module.
   */
  readonly securityRuntimeAvailable: boolean;
  /** `settings` module enabled with the account-settings repository composed. */
  readonly settingsRuntimeAvailable: boolean;
  /** `support` module enabled with the support-ticket repository and cursor codec composed. */
  readonly supportRuntimeAvailable: boolean;
  /**
   * Community AI (Decision 0066): the `community` module is registered, the
   * Community AI repository is composed, and `ANTHROPIC_API_KEY` is present.
   * Without the key the capability stays `deferred` — it is not "unavailable",
   * because no Provider was ever asked to answer.
   */
  readonly communityAiRuntimeAvailable: boolean;
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
export const v2ChainModuleDeferredReasonCode =
  "BSC_CHAIN_MODULE_NOT_ENABLED" as const;
export const v2ChainRpcNotConfiguredReasonCode =
  "BSC_RPC_NOT_CONFIGURED" as const;
export const v2ChainRuntimeUnavailableReasonCode =
  "BSC_CHAIN_RUNTIME_UNAVAILABLE" as const;
export const v2ChainIdMismatchReasonCode = "BSC_CHAIN_ID_MISMATCH" as const;
export const v2ChainRpcUnreachableReasonCode = "BSC_RPC_UNREACHABLE" as const;
export const v2ChainVerificationPendingReasonCode =
  "BSC_CHAIN_VERIFICATION_PENDING" as const;
export const v2WalletModuleDeferredReasonCode =
  "WALLET_PROJECTION_DEFERRED" as const;
export const v2WalletRuntimeUnavailableReasonCode =
  "WALLET_RUNTIME_UNAVAILABLE" as const;
export const v2WatchlistModuleDeferredReasonCode =
  "V2_WATCHLIST_RUNTIME_DEFERRED" as const;
export const v2WatchlistRuntimeUnavailableReasonCode =
  "WATCHLIST_RUNTIME_UNAVAILABLE" as const;
export const v2MarketModuleDeferredReasonCode =
  "V2_MARKET_RUNTIME_DEFERRED" as const;
export const v2MarketRuntimeUnavailableReasonCode =
  "MARKET_RUNTIME_UNAVAILABLE" as const;
export const v2NotificationsModuleDeferredReasonCode =
  "V2_NOTIFICATIONS_RUNTIME_DEFERRED" as const;
export const v2PriceAlertsRuntimeUnavailableReasonCode =
  "PRICE_ALERTS_RUNTIME_UNAVAILABLE" as const;
export const v2NotificationsFeedRuntimeUnavailableReasonCode =
  "NOTIFICATIONS_RUNTIME_UNAVAILABLE" as const;
/** No Firebase credential, no push repository, or the module is off. */
export const v2PushNotificationsUnavailableReasonCode =
  "PUSH_RUNTIME_DEFERRED" as const;
/** No physical device has acknowledged a LOOP push yet (Decision 0067). */
export const v2PushDeliveryEvidencePendingReasonCode =
  "PUSH_DEVICE_DELIVERY_EVIDENCE_PENDING" as const;
export const v2CommunicationModuleDeferredReasonCode =
  "V2_COMMUNICATION_RUNTIME_DEFERRED" as const;
export const v2CommunicationRuntimeUnavailableReasonCode =
  "COMMUNICATION_RUNTIME_UNAVAILABLE" as const;
/**
 * Decision 0005 pre-condition: Stream Dashboard evidence that the `audio_room`
 * `user` role does not carry `create-call`. `user` is the role a LOOP listener
 * is given (S4 integration, BUG-03: the application defines no `listener`
 * role), so it is that role's permission set the evidence must cover. Until an
 * operator records the exported evidence in
 * `STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF` (Decision 0039) the capability
 * stays evidence-pending even when the backend is available.
 */
export const v2VoiceRoomEvidencePendingReasonCode =
  "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING" as const;
export const v2SendApprovalsModuleDeferredReasonCode =
  "SEND_APPROVALS_RUNTIME_DEFERRED" as const;
export const v2PrivySwapModuleDeferredReasonCode =
  "PRIVY_SWAP_GO_NO_GO_PENDING" as const;
export const v2WalletIntentRuntimeUnavailableReasonCode =
  "WALLET_INTENT_RUNTIME_UNAVAILABLE" as const;
export const v2BscWritesDisabledReasonCode = "BSC_WRITES_DISABLED" as const;
/**
 * Privy BSC Swap has no physical-device evidence yet: quote availability,
 * execute with a user authorization signature, and the Flutter
 * `generateAuthorizationSignature` handoff are all unverified.
 */
export const v2PrivySwapEvidencePendingReasonCode =
  "PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING" as const;
export const v2LaunchModuleDeferredReasonCode =
  "V2_LAUNCH_RUNTIME_DEFERRED" as const;
export const v2LaunchRuntimeUnavailableReasonCode =
  "LAUNCH_RUNTIME_UNAVAILABLE" as const;
/** No 02 contract baseline: every on-chain Launch fact stays unavailable. */
export const v2LaunchEvidencePendingReasonCode =
  "LAUNCH_CONTRACT_BASELINE_PENDING" as const;
export const v2MiningModuleDeferredReasonCode =
  "V2_MINING_RUNTIME_DEFERRED" as const;
export const v2MiningRuntimeUnavailableReasonCode =
  "MINING_RUNTIME_UNAVAILABLE" as const;
export const v2ReferralModuleDeferredReasonCode =
  "V2_REFERRAL_RUNTIME_DEFERRED" as const;
export const v2ReferralRuntimeUnavailableReasonCode =
  "REFERRAL_RUNTIME_UNAVAILABLE" as const;
export const v2SecurityModuleDeferredReasonCode =
  "V2_SECURITY_RUNTIME_DEFERRED" as const;
export const v2SecurityRuntimeUnavailableReasonCode =
  "SECURITY_RUNTIME_UNAVAILABLE" as const;
export const v2SettingsModuleDeferredReasonCode =
  "V2_SETTINGS_RUNTIME_DEFERRED" as const;
export const v2SettingsRuntimeUnavailableReasonCode =
  "SETTINGS_RUNTIME_UNAVAILABLE" as const;
export const v2SupportModuleDeferredReasonCode =
  "V2_SUPPORT_RUNTIME_DEFERRED" as const;
export const v2SupportRuntimeUnavailableReasonCode =
  "SUPPORT_RUNTIME_UNAVAILABLE" as const;

/**
 * Capability projected by each V2 module gate. `profile` was delivered by
 * Decision 0030, `community` and `search` by Decision 0031, `market` and
 * `notifications` by Decision 0034 (`notifications` additionally projects
 * `priceAlerts` and `notificationsFeed`; `pushNotifications` stays closed),
 * `security`, `settings`, and `support` by Decision 0037.
 */
export const v2ModuleCapabilityIds = Object.freeze({
  community: "community",
  communication: "communityChat",
  search: "search",
  market: "marketRead",
  chain: "bscRead",
  wallet: "walletRead",
  swap: "privySwap",
  sendApprovals: "sendApprovals",
  launch: "launch",
  mining: "mining",
  referral: "referral",
  notifications: "pushNotifications",
  profile: "profile",
  watchlist: "watchlist",
  security: "security",
  settings: "settings",
  support: "support",
} as const satisfies Readonly<Record<V2ModuleId, string | null>>);

export const v2CapabilityIds = Object.freeze([
  "privyAuthentication",
  "accountSession",
  "streamChatToken",
  "streamVideoToken",
  "community",
  "communityChat",
  "voiceRooms",
  "communityMining",
  "communityPresence",
  "search",
  "bscRead",
  "walletRead",
  "watchlist",
  "marketRead",
  "privySwap",
  "sendApprovals",
  "launch",
  "mining",
  "referral",
  "priceAlerts",
  "notificationsFeed",
  "pushNotifications",
  "profile",
  "avatarUpload",
  "security",
  "settings",
  "support",
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
 * A delivered module whose external baseline is still pending (Decision
 * 0036): `available` describes the PostgreSQL-backed catalog, application,
 * or relationship runtime; `evidence` records the missing contract or
 * formula baseline so the client keeps every derived number unavailable.
 */
function evidencePendingModuleCapability(
  config: AppConfig,
  moduleId: V2ModuleId,
  capabilityId: string,
  runtimeAvailable: boolean,
  deferredReasonCode: string,
  unavailableReasonCode: string,
  evidencePendingReasonCode: string,
  launchChainId?: LaunchChainId,
): V2CapabilityProjection {
  const evidence = Object.freeze({
    status: "pending" as const,
    reasonCode: evidencePendingReasonCode,
    ...(launchChainId === undefined ? {} : { launchChainId }),
  });
  if (!config.v2ModulesEnabled.has(moduleId)) {
    return Object.freeze({
      capabilityId,
      availability: "deferred",
      reasonCode: deferredReasonCode,
      evidence,
    });
  }
  return Object.freeze({
    capabilityId,
    availability: runtimeAvailable ? "available" : "unavailable",
    reasonCode: runtimeAvailable ? null : unavailableReasonCode,
    evidence,
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

/**
 * `bscRead` is available only when the chain module is registered, at least
 * one RPC endpoint is configured, and `eth_chainId` was actually observed to
 * equal 56. An unprobed, unreachable, or mismatched chain is never `available`:
 * a wrong-chain endpoint would otherwise publish another chain's facts as BSC
 * facts.
 */
function bscReadCapability(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
): V2CapabilityProjection {
  const capabilityId = v2ModuleCapabilityIds.chain;
  if (!config.v2ModulesEnabled.has("chain")) {
    return deferredCapability(capabilityId, v2ChainModuleDeferredReasonCode);
  }
  const reasonCode = !runtime.bscRpcConfigured
    ? v2ChainRpcNotConfiguredReasonCode
    : !runtime.chainRuntimeAvailable
      ? v2ChainRuntimeUnavailableReasonCode
      : chainVerificationReasonCode(runtime.bscChainVerification());
  return Object.freeze({
    capabilityId,
    availability: reasonCode === null ? "available" : "unavailable",
    reasonCode,
    evidence: Object.freeze({
      status: "pending",
      reasonCode: "BSC_RPC_PROVIDER_EVIDENCE_PENDING",
    }),
  });
}

function chainVerificationReasonCode(
  state: ChainVerificationState,
): string | null {
  switch (state) {
    case "verified": {
      return null;
    }
    case "mismatched": {
      return v2ChainIdMismatchReasonCode;
    }
    case "unreachable": {
      return v2ChainRpcUnreachableReasonCode;
    }
    case "unknown": {
      return v2ChainVerificationPendingReasonCode;
    }
  }
}

/**
 * Voice rooms share the `communication` module gate, but they additionally
 * carry the Decision 0005 Dashboard evidence: the backend can be available
 * while the client locator must still stay unavailable. The evidence is
 * decided by configuration alone (Decision 0039) and is reported the same way
 * whether the module is deferred, unavailable, or available; `reference` is
 * present only once the operator confirmed it.
 */
function voiceRoomsCapability(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
): V2CapabilityProjection {
  const reference = config.streamAudioRoomUserRoleEvidenceRef;
  const evidence =
    reference === null
      ? Object.freeze({
          status: "pending" as const,
          reasonCode: v2VoiceRoomEvidencePendingReasonCode,
        })
      : Object.freeze({
          status: "confirmed" as const,
          reasonCode: null,
          reference,
        });
  if (!config.v2ModulesEnabled.has("communication")) {
    return Object.freeze({
      capabilityId: "voiceRooms",
      availability: "deferred",
      reasonCode: v2CommunicationModuleDeferredReasonCode,
      evidence,
    });
  }
  return Object.freeze({
    capabilityId: "voiceRooms",
    availability: runtime.communicationRuntimeAvailable
      ? "available"
      : "unavailable",
    reasonCode: runtime.communicationRuntimeAvailable
      ? null
      : v2CommunicationRuntimeUnavailableReasonCode,
    evidence,
  });
}

/**
 * Funds-moving capabilities (Decision 0035): the module must be enabled, the
 * intent runtime composed, `BSC_WRITES_ENABLED` on, and the chain verified
 * live. `privySwap` additionally needs Privy credentials and always carries
 * the pending device evidence.
 */
function walletIntentCapability(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
  moduleId: "sendApprovals" | "swap",
): V2CapabilityProjection {
  const capabilityId = v2ModuleCapabilityIds[moduleId];
  const evidence =
    moduleId === "swap"
      ? Object.freeze({
          status: "pending" as const,
          reasonCode: v2PrivySwapEvidencePendingReasonCode,
        })
      : Object.freeze({ status: "notApplicable" as const, reasonCode: null });
  if (!config.v2ModulesEnabled.has(moduleId)) {
    return Object.freeze({
      capabilityId,
      availability: "deferred",
      reasonCode:
        moduleId === "swap"
          ? v2PrivySwapModuleDeferredReasonCode
          : v2SendApprovalsModuleDeferredReasonCode,
      evidence,
    });
  }
  const reasonCode = !runtime.walletIntentRuntimeAvailable
    ? v2WalletIntentRuntimeUnavailableReasonCode
    : !runtime.bscRpcConfigured
      ? v2ChainRpcNotConfiguredReasonCode
      : !runtime.bscWritesEnabled
        ? v2BscWritesDisabledReasonCode
        : moduleId === "swap" && !runtime.privySwapRuntimeAvailable
          ? "PRIVY_NOT_CONFIGURED"
          : chainVerificationReasonCode(runtime.bscChainVerification());
  return Object.freeze({
    capabilityId,
    availability: reasonCode === null ? "available" : "unavailable",
    reasonCode,
    evidence,
  });
}

/**
 * `communityMining` (Decision 0043) is decided by the formula fact, never by
 * a constant, and it is never `deferred`: nobody chose not to build it, it
 * is blocked — by the `mining` module, by its runtime, or by the missing
 * approved version — until a version is in force. Its evidence is not
 * applicable: the product freeze is reported on the `mining` capability.
 */
function communityMiningCapability(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
  baseline: MiningFormulaBaselineState,
): V2CapabilityProjection {
  const reasonCode = !config.v2ModulesEnabled.has("mining")
    ? v2CommunityMiningUnavailableReasonCode
    : !runtime.miningRuntimeAvailable
      ? v2MiningRuntimeUnavailableReasonCode
      : baseline.status === "unavailable"
        ? v2MiningRuntimeUnavailableReasonCode
        : baseline.status === "pending"
          ? v2CommunityMiningUnavailableReasonCode
          : null;
  return Object.freeze({
    capabilityId: "communityMining",
    availability: reasonCode === null ? "available" : "unavailable",
    reasonCode,
    evidence: Object.freeze({
      status: "notApplicable",
      reasonCode: null,
    }),
  });
}

/**
 * `communityPresence` (Decision 0047) is a runtime question, never a
 * constant: it opens when the presence reader is composed. Without Stream
 * credentials the reason is the same `STREAM_PRESENCE_NOT_CONNECTED` the
 * field itself reports; with credentials but no communication runtime there
 * are no channel records to read presence for.
 */
function communityPresenceCapability(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
): V2CapabilityProjection {
  const reasonCode = runtime.communityPresenceRuntimeAvailable
    ? null
    : config.stream === null
      ? v2CommunityPresenceUnavailableReasonCode
      : v2CommunicationRuntimeUnavailableReasonCode;
  return Object.freeze({
    capabilityId: "communityPresence",
    availability: reasonCode === null ? "available" : "unavailable",
    reasonCode,
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

export async function createV2CapabilitiesProjection(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
): Promise<V2CapabilitiesProjection> {
  const { sessionRuntimeAvailable } = runtime;
  // The formula fact is read per request so an approval made after startup
  // (the operator script) opens the capability without a restart.
  const miningBaseline = await runtime.miningFormulaBaseline();
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
    deliveredModuleCapability(
      config,
      "communication",
      v2ModuleCapabilityIds.communication,
      runtime.communicationRuntimeAvailable,
      v2CommunicationModuleDeferredReasonCode,
      v2CommunicationRuntimeUnavailableReasonCode,
    ),
    voiceRoomsCapability(config, runtime),
    communityMiningCapability(config, runtime, miningBaseline),
    communityPresenceCapability(config, runtime),
    deliveredModuleCapability(
      config,
      "search",
      v2ModuleCapabilityIds.search,
      runtime.searchRuntimeAvailable,
      v2SearchModuleDeferredReasonCode,
      v2SearchRuntimeUnavailableReasonCode,
    ),
    bscReadCapability(config, runtime),
    deliveredModuleCapability(
      config,
      "wallet",
      v2ModuleCapabilityIds.wallet,
      runtime.walletRuntimeAvailable,
      v2WalletModuleDeferredReasonCode,
      v2WalletRuntimeUnavailableReasonCode,
    ),
    deliveredModuleCapability(
      config,
      "market",
      v2ModuleCapabilityIds.market,
      runtime.marketRuntimeAvailable,
      v2MarketModuleDeferredReasonCode,
      v2MarketRuntimeUnavailableReasonCode,
    ),
    walletIntentCapability(config, runtime, "swap"),
    walletIntentCapability(config, runtime, "sendApprovals"),
    // Decision 0036: the catalog / application / referral runtimes can be
    // available while the contract and formula baselines stay pending; the
    // evidence field carries that separately from the module gate.
    evidencePendingModuleCapability(
      config,
      "launch",
      v2ModuleCapabilityIds.launch,
      runtime.launchRuntimeAvailable,
      v2LaunchModuleDeferredReasonCode,
      v2LaunchRuntimeUnavailableReasonCode,
      v2LaunchEvidencePendingReasonCode,
      runtime.launchChainId === bscChainId ? undefined : runtime.launchChainId,
    ),
    evidencePendingModuleCapability(
      config,
      "mining",
      v2ModuleCapabilityIds.mining,
      runtime.miningRuntimeAvailable,
      v2MiningModuleDeferredReasonCode,
      v2MiningRuntimeUnavailableReasonCode,
      v2CommunityMiningUnavailableReasonCode,
    ),
    evidencePendingModuleCapability(
      config,
      "referral",
      v2ModuleCapabilityIds.referral,
      runtime.referralRuntimeAvailable,
      v2ReferralModuleDeferredReasonCode,
      v2ReferralRuntimeUnavailableReasonCode,
      v2CommunityMiningUnavailableReasonCode,
    ),
    deliveredModuleCapability(
      config,
      "notifications",
      "priceAlerts",
      runtime.priceAlertsRuntimeAvailable,
      v2NotificationsModuleDeferredReasonCode,
      v2PriceAlertsRuntimeUnavailableReasonCode,
    ),
    deliveredModuleCapability(
      config,
      "notifications",
      "notificationsFeed",
      runtime.notificationsFeedRuntimeAvailable,
      v2NotificationsModuleDeferredReasonCode,
      v2NotificationsFeedRuntimeUnavailableReasonCode,
    ),
    // Decision 0067: push delivery is available only with a Firebase
    // credential, the push repository and the notifications module. Its
    // evidence stays pending until a physical handset acknowledges a LOOP
    // push, so an available capability still does not claim a proven
    // delivery path.
    runtime.pushRuntimeAvailable
      ? Object.freeze({
          capabilityId: v2ModuleCapabilityIds.notifications,
          availability: "available" as const,
          reasonCode: null,
          evidence: Object.freeze({
            status: "pending" as const,
            reasonCode: v2PushDeliveryEvidencePendingReasonCode,
          }),
        })
      : unavailableCapability(
          v2ModuleCapabilityIds.notifications,
          v2PushNotificationsUnavailableReasonCode,
        ),
    profileCapability(config, runtime),
    deliveredModuleCapability(
      config,
      "watchlist",
      "watchlist",
      runtime.watchlistRuntimeAvailable,
      v2WatchlistModuleDeferredReasonCode,
      v2WatchlistRuntimeUnavailableReasonCode,
    ),
    unavailableCapability("avatarUpload", v2AvatarUploadUnavailableReasonCode),
    // D20 (Decision 0037): security, settings, and support are local-only
    // modules. MFA, passkey, recovery, and key export are not capabilities
    // here; `GET /v2/security/capabilities` reports each one as unavailable
    // with its pending Privy evidence.
    deliveredModuleCapability(
      config,
      "security",
      v2ModuleCapabilityIds.security,
      runtime.securityRuntimeAvailable,
      v2SecurityModuleDeferredReasonCode,
      v2SecurityRuntimeUnavailableReasonCode,
    ),
    deliveredModuleCapability(
      config,
      "settings",
      v2ModuleCapabilityIds.settings,
      runtime.settingsRuntimeAvailable,
      v2SettingsModuleDeferredReasonCode,
      v2SettingsRuntimeUnavailableReasonCode,
    ),
    deliveredModuleCapability(
      config,
      "support",
      v2ModuleCapabilityIds.support,
      runtime.supportRuntimeAvailable,
      v2SupportModuleDeferredReasonCode,
      v2SupportRuntimeUnavailableReasonCode,
    ),
    deferredCapability("pay", "PAY_RUNTIME_DEFERRED"),
    deferredCapability("bridge", "BRIDGE_RUNTIME_DEFERRED"),
    deferredCapability("dappExecution", "DAPP_EXECUTION_RUNTIME_DEFERRED"),
    runtime.communityAiRuntimeAvailable
      ? Object.freeze({
          capabilityId: "communityAi",
          availability: "available" as const,
          reasonCode: null,
          evidence: Object.freeze({
            status: "notApplicable" as const,
            reasonCode: null,
          }),
        })
      : deferredCapability("communityAi", "COMMUNITY_AI_RUNTIME_DEFERRED"),
  ] satisfies readonly V2CapabilityProjection[]);

  return Object.freeze({
    contractVersion: v2ContractVersion,
    configVersion: v2ProductConfigVersion,
    effectiveAt: v2ProductEffectiveAt,
    capabilities,
  });
}

export async function createV2ProductPolicyProjection(
  config: AppConfig,
  runtime: V2ProductPolicyRuntime,
  now: Date = new Date(),
): Promise<V2ProductPolicyProjection> {
  return Object.freeze({
    clientPolicy: createV2ClientPolicyProjection(config, now),
    capabilities: await createV2CapabilitiesProjection(config, runtime),
  });
}
