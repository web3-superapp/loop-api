/**
 * D20 security contract (Decision 0037).
 *
 * Every Privy-side security method is reported as `unavailable` with a
 * pending-evidence reason: MFA, passkey, recovery password, automatic
 * recovery, social recovery, and private-key export all need Privy plan,
 * platform, SDK, and physical-device evidence before the backend may say
 * anything else (03 §5.2, §19). Nothing here simulates them locally.
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
  notificationsUnavailable: "NOTIFICATIONS_RUNTIME_UNAVAILABLE",
  deviceSessionsUnavailable: "ACCOUNT_SESSION_RUNTIME_UNAVAILABLE",
} as const);

export const deviceSessionRevokeDigestDomain =
  "loop:v2:device-session-command:v1";
