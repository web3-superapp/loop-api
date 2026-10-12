/**
 * D20 security contract (Decision 0037, revised by Decision 0129 §4).
 *
 * The default projection (`pendingOnly`, the frozen 0037 bytes) reports every
 * Privy-side security method as `unavailable` with a pending-evidence reason.
 * Decision 0129 §4: the `current` projection (opt-in, `?projection=current`)
 * reports what the client has actually wired through privy_flutter — MFA
 * (TOTP, S60a), passkey (S64; only while the API publishes a relying-party
 * association, Decision 0063), and automatic recovery (Privy's embedded
 * wallet default, user ruling 2026-09-21) — as `available` with `confirmed`
 * evidence. Recovery password, social recovery, and key export stay
 * `unavailable` with their pending reason. Nothing here simulates them.
 */

export const securityCapabilityIds = Object.freeze([
  "mfa",
  "passkey",
  "recoveryPassword",
  "autoRecovery",
  "socialRecovery",
  "keyExport",
] as const);
export type SecurityCapabilityId = (typeof securityCapabilityIds)[number];

export const securityCapabilityEvidenceReasonCodes = Object.freeze({
  mfa: "PRIVY_MFA_EVIDENCE_PENDING",
  passkey: "PRIVY_PASSKEY_EVIDENCE_PENDING",
  recoveryPassword: "PRIVY_RECOVERY_PASSWORD_EVIDENCE_PENDING",
  autoRecovery: "PRIVY_AUTO_RECOVERY_EVIDENCE_PENDING",
  socialRecovery: "PRIVY_SOCIAL_RECOVERY_EVIDENCE_PENDING",
  keyExport: "PRIVY_KEY_EXPORT_EVIDENCE_PENDING",
} as const satisfies Readonly<Record<SecurityCapabilityId, string>>);

/** Localization keys for the "how to enable" explanation shown per item. */
export const securityCapabilityGuideKeys = Object.freeze({
  mfa: "security.capability.mfa.howToEnable",
  passkey: "security.capability.passkey.howToEnable",
  recoveryPassword: "security.capability.recoveryPassword.howToEnable",
  autoRecovery: "security.capability.autoRecovery.howToEnable",
  socialRecovery: "security.capability.socialRecovery.howToEnable",
  keyExport: "security.capability.keyExport.howToEnable",
} as const satisfies Readonly<Record<SecurityCapabilityId, string>>);

/**
 * High-risk new-device signal (main-agent ruling, 2026-09-08): two or more
 * sessions created for the account inside the last 24 hours. The policy is
 * published with the signal so the client never hard-codes the threshold.
 */
export const deviceRiskPolicy = Object.freeze({
  configVersion: "deviceRiskV1",
  windowHours: 24,
  newSessionThreshold: 2,
} as const);

/** Upper bound on sessions projected by `GET /v2/devices`; no cursor exists. */
export const deviceListLimit = 100;

/** Upper bound on `security.event` notifications in the security summary. */
export const recentSecurityEventLimit = 10;

export const securityReasonCodes = Object.freeze({
  revokeAllStepUp: "AUTH_STEP_UP_REQUIRED",
  walletNotSelected: "WALLET_NOT_SELECTED",
  walletRuntimeUnavailable: "WALLET_RUNTIME_UNAVAILABLE",
  approvalsDeferred: "SEND_APPROVALS_RUNTIME_DEFERRED",
  approvalsRuntimeUnavailable: "WALLET_INTENT_RUNTIME_UNAVAILABLE",
  notificationsUnavailable: "NOTIFICATIONS_RUNTIME_UNAVAILABLE",
  deviceSessionsUnavailable: "ACCOUNT_SESSION_RUNTIME_UNAVAILABLE",
} as const);

export const deviceSessionRevokeDigestDomain =
  "loop:v2:device-session-command:v1";

/**
 * Decision 0129 §4: `pendingOnly` (default) keeps the Decision 0037 bytes the
 * App at loop-mobile 2825f1d parses (its codec refuses any other status);
 * `current` is the projection a client opts into once it reads `available`.
 */
export const securityCapabilityProjections = Object.freeze([
  "pendingOnly",
  "current",
] as const);
export type SecurityCapabilityProjectionMode =
  (typeof securityCapabilityProjections)[number];

/** Decision 0129 §4: passkey without a published relying-party association. */
export const securityPasskeyRelyingPartyNotConfiguredReasonCode =
  "PASSKEY_RELYING_PARTY_NOT_CONFIGURED" as const;

/**
 * Decision 0129 §4: the evidence of the three methods the client wired. The
 * reference is an operational pointer (1–120 characters), never a secret.
 */
export const securityCapabilityConfirmedEvidence = Object.freeze({
  mfa: Object.freeze({
    reasonCode: "PRIVY_MFA_CLIENT_TOTP",
    reference:
      "S60a: privy_flutter TOTP enrolment in 安全设置 (docs/modules/S2-identity-account.md)",
  }),
  passkey: Object.freeze({
    reasonCode: "PRIVY_PASSKEY_CLIENT_ENROLLMENT",
    reference:
      "S64: privy_flutter passkey link/enroll; RP = the API domain (loop-api Decision 0063)",
  }),
  autoRecovery: Object.freeze({
    reasonCode: "PRIVY_EMBEDDED_WALLET_DEFAULT_RECOVERY",
    reference:
      "S60a: Privy 内置钱包默认由登录方式恢复；换设备后用同一邮箱登录即可（来源：Privy）",
  }),
} as const);
