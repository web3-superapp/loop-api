/**
 * Decision 0112: the deployment task state machine (migration 000059).
 * `awaiting_executor → claimed → broadcast → confirmed → verified →
 * activated`; `failed` (optionally retryable → `claimed`), `reorged`
 * (→ `claimed`, same signed transaction re-sent), `cancelled` (owner,
 * before any claim).
 */
export const hooksLaunchDeploymentStatuses = Object.freeze([
  "awaiting_executor",
  "claimed",
  "broadcast",
  "confirmed",
  "verified",
  "activated",
  "failed",
  "reorged",
  "cancelled",
] as const);
export type HooksLaunchDeploymentStatus =
  (typeof hooksLaunchDeploymentStatuses)[number];

/** Statuses during which the executor still owns the task. */
export const hooksLaunchInFlightStatuses = Object.freeze([
  "claimed",
  "broadcast",
  "confirmed",
  "verified",
  "reorged",
] as const satisfies readonly HooksLaunchDeploymentStatus[]);
