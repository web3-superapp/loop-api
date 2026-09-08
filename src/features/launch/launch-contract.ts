import { createHash } from "node:crypto";

import { z } from "zod";

import { v2ContractVersion } from "../meta/product-policy.js";

/**
 * V2 Launch wire contract (Decision 0036). The 02 contract document has not
 * been provided, so every on-chain fact is published as `unavailable` with
 * `LAUNCH_CONTRACT_BASELINE_PENDING`; the only writable surface is the
 * off-chain project application. Public fields are camelCase; every amount
 * is a string; every mutable rule carries `configVersion` + `effectiveAt`.
 */

export const launchConfigVersion = "launchCatalogV1" as const;
export const launchCommandDigestVersion = "launch_command_v1" as const;
export const launchCommandIdempotencyScope = "v2_launch_command" as const;
export const launchChainId = "eip155:56" as const;
export const launchListLimits = Object.freeze({ default: 20, maximum: 50 });
export const launchCursorRoutes = Object.freeze({
  projects: "v2LaunchProjects",
} as const);

export const launchReasonCodes = Object.freeze({
  contractBaselinePending: "LAUNCH_CONTRACT_BASELINE_PENDING",
  tierModePending: "TIER_MODE_PENDING",
  stakingContractPending: "STAKING_CONTRACT_PENDING",
  configPendingConfirmation: "LAUNCH_CONFIG_PENDING_CONFIRMATION",
  kybProviderNotSelected: "KYB_PROVIDER_NOT_SELECTED",
  attachmentStorageNotSelected: "ATTACHMENT_STORAGE_NOT_SELECTED",
  poolEvidenceUnavailable: "LAUNCH_POOL_EVIDENCE_UNAVAILABLE",
  economyUnavailable: "LAUNCH_ECONOMY_CONTRACT_PENDING",
} as const);

export const launchReviewStatuses = [
  "draft",
  "submitted",
  "in_review",
  "returned",
  "approved",
  "rejected",
] as const;
export type LaunchReviewStatus = (typeof launchReviewStatuses)[number];

export const launchKybStatuses = ["pending", "unavailable"] as const;
export type LaunchKybStatus = (typeof launchKybStatuses)[number];

export const launchScheduleStatuses = [
  "unscheduled",
  "scheduled",
  "live",
  "ended",
] as const;
export type LaunchScheduleStatus = (typeof launchScheduleStatuses)[number];

export const launchSlotStatuses = [
  "pending_confirmation",
  "confirmed",
] as const;
export type LaunchSlotStatus = (typeof launchSlotStatuses)[number];

export const launchEligibilityTiers = [
  "priority",
  "community",
  "public",
] as const;
export type LaunchEligibilityTier = (typeof launchEligibilityTiers)[number];

export const launchEligibilityModes = [
  "whitelist",
  "community",
  "activity",
  "unavailable",
] as const;
export type LaunchEligibilityMode = (typeof launchEligibilityModes)[number];

export const launchReviewDecisions = [
  "review",
  "approve",
  "return",
  "reject",
] as const;
export type LaunchReviewDecision = (typeof launchReviewDecisions)[number];

export const launchProjectListFilters = [
  "all",
  ...launchReviewStatuses,
] as const;
export type LaunchProjectListFilter = (typeof launchProjectListFilters)[number];

export const venueMilestoneVenues = ["lbank", "binance", "bithumb"] as const;
export type VenueMilestoneVenue = (typeof venueMilestoneVenues)[number];
export const venueMilestoneMarketTypes = [
  "spot",
  "alpha",
  "perpetual",
] as const;
export type VenueMilestoneMarketType =
  (typeof venueMilestoneMarketTypes)[number];
export const venueMilestoneStates = [
  "PREPARING",
  "APPLIED",
  "EVIDENCE_PENDING",
  "LISTED",
  "FEATURED",
  "REJECTED",
  "DEFERRED",
  "EVIDENCE_INVALID",
  "DELISTED",
] as const;
export type VenueMilestoneState = (typeof venueMilestoneStates)[number];

/** Graduation rail steps (prototype `launch-graduation`), every one pending. */
export const launchGraduationSteps = [
  "stop_internal_trading",
  "prepare_pool",
  "add_and_lock_liquidity",
  "open_external_trading",
] as const;
export type LaunchGraduationStep = (typeof launchGraduationSteps)[number];

export const launchOfficialLinkKeys = [
  "website",
  "x",
  "telegram",
  "discord",
] as const;
export type LaunchOfficialLinkKey = (typeof launchOfficialLinkKeys)[number];

export const maximumLaunchNameCodePoints = 80;
export const maximumLaunchNarrativeCodePoints = 2_000;
export const maximumLaunchLinkLength = 512;
export const maximumLaunchRawTextLength = 4_096;
export const launchTickerPatternSource = "^[A-Z0-9]{2,12}$";
export const opaqueIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const launchConfigVersionPatternSource =
  "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const sha256PatternSource = "^[0-9a-f]{64}$";

const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const tickerPattern = new RegExp(launchTickerPatternSource);
const opaqueIdPattern = new RegExp(opaqueIdPatternSource);

export class InvalidLaunchRequestError extends Error {
  readonly code = "invalid_launch_request";

  constructor() {
    super("The V2 launch request is invalid");
    this.name = "InvalidLaunchRequestError";
  }
}

function invalid(): never {
  throw new InvalidLaunchRequestError();
}

function boundedText(maximumCodePoints: number) {
  return z
    .string()
    .max(maximumLaunchRawTextLength)
    .superRefine((value, context) => {
      const trimmed = value.trim();
      const codePoints = Array.from(trimmed).length;
      if (
        codePoints < 1 ||
        codePoints > maximumCodePoints ||
        forbiddenTextCharacters.test(value)
      ) {
        context.addIssue({ code: "custom" });
      }
    })
    .transform((value) => value.trim());
}

const httpsLinkSchema = z
  .string()
  .max(maximumLaunchLinkLength)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom" });
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      forbiddenTextCharacters.test(value)
    ) {
      context.addIssue({ code: "custom" });
    }
  });

const officialLinksSchema = z
  .object({
    website: httpsLinkSchema.nullable().optional(),
    x: httpsLinkSchema.nullable().optional(),
    telegram: httpsLinkSchema.nullable().optional(),
    discord: httpsLinkSchema.nullable().optional(),
  })
  .strict();

const projectValuesSchema = z
  .object({
    name: boundedText(maximumLaunchNameCodePoints),
    ticker: z.string().regex(tickerPattern),
    narrative: boundedText(maximumLaunchNarrativeCodePoints).nullable(),
    officialLinks: officialLinksSchema,
  })
  .strict();

const replaceProjectRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    project: projectValuesSchema,
  })
  .strict();

export type LaunchOfficialLinks = Readonly<
  Record<LaunchOfficialLinkKey, string | null>
>;

export interface LaunchProjectValues {
  readonly name: string;
  readonly ticker: string;
  readonly narrative: string | null;
  readonly officialLinks: LaunchOfficialLinks;
}

export interface ReplaceLaunchProjectRequest {
  readonly expectedVersion: number;
  readonly project: LaunchProjectValues;
}

function normalizeLinks(
  value: z.infer<typeof officialLinksSchema>,
): LaunchOfficialLinks {
  return Object.freeze({
    website: value.website ?? null,
    x: value.x ?? null,
    telegram: value.telegram ?? null,
    discord: value.discord ?? null,
  });
}

export function parseLaunchProjectValues(value: unknown): LaunchProjectValues {
  const parsed = projectValuesSchema.safeParse(value);
  if (!parsed.success) {
    return invalid();
  }
  return Object.freeze({
    name: parsed.data.name,
    ticker: parsed.data.ticker,
    narrative: parsed.data.narrative,
    officialLinks: normalizeLinks(parsed.data.officialLinks),
  });
}

export function parseReplaceLaunchProjectRequest(
  value: unknown,
): ReplaceLaunchProjectRequest {
  const parsed = replaceProjectRequestSchema.safeParse(value);
  if (!parsed.success) {
    return invalid();
  }
  return Object.freeze({
    expectedVersion: parsed.data.expectedVersion,
    project: Object.freeze({
      name: parsed.data.project.name,
      ticker: parsed.data.project.ticker,
      narrative: parsed.data.project.narrative,
      officialLinks: normalizeLinks(parsed.data.project.officialLinks),
    }),
  });
}

export function parseLaunchOpaqueId(value: unknown): string {
  return typeof value === "string" && opaqueIdPattern.test(value)
    ? value
    : invalid();
}

export function parseLaunchListLimit(value: unknown): number {
  if (value === undefined) {
    return launchListLimits.default;
  }
  const parsed = z
    .number()
    .int()
    .min(1)
    .max(launchListLimits.maximum)
    .safeParse(value);
  return parsed.success ? parsed.data : invalid();
}

export function parseLaunchEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  return values.includes(value as T) ? (value as T) : invalid();
}

/** Canonical digest parts for a project payload (fixed key order). */
export function launchProjectDigestParts(
  values: LaunchProjectValues,
): readonly string[] {
  return Object.freeze([
    values.name,
    values.ticker,
    values.narrative === null ? "null" : "set",
    values.narrative ?? "",
    ...launchOfficialLinkKeys.flatMap((key) => {
      const link = values.officialLinks[key];
      return [key, link === null ? "null" : "set", link ?? ""];
    }),
  ]);
}

export function launchCommandDigest(
  operation: string,
  parts: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(`loop:v2:launch:${launchCommandDigestVersion}`);
  for (const part of [operation, v2ContractVersion, ...parts]) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

export function canonicalLaunchFilter(
  entries: Readonly<Record<string, string>>,
): string {
  return Object.keys(entries)
    .sort()
    .map((key) => `${key}=${entries[key] ?? ""}`)
    .join("&");
}

// ---------------------------------------------------------------------------
// Review state machine (applicant + operator)
// ---------------------------------------------------------------------------

export const launchApplicantEditableStatuses: readonly LaunchReviewStatus[] =
  Object.freeze(["draft", "returned"]);

export function canApplicantEdit(status: LaunchReviewStatus): boolean {
  return launchApplicantEditableStatuses.includes(status);
}

/** Applicant submit: `draft | returned → submitted`; anything else is stale. */
export function submitTransition(
  current: LaunchReviewStatus,
): LaunchReviewStatus | null {
  return canApplicantEdit(current) ? "submitted" : null;
}

/**
 * Operator decisions (Dev script only in this step). Returns the next status
 * or null when the stored status does not allow the decision.
 */
export function reviewTransition(
  current: LaunchReviewStatus,
  decision: LaunchReviewDecision,
): LaunchReviewStatus | null {
  switch (decision) {
    case "review": {
      return current === "submitted" ? "in_review" : null;
    }
    case "approve": {
      return current === "submitted" || current === "in_review"
        ? "approved"
        : null;
    }
    case "return": {
      return current === "submitted" || current === "in_review"
        ? "returned"
        : null;
    }
    case "reject": {
      return current === "submitted" || current === "in_review"
        ? "rejected"
        : null;
    }
  }
}

export const launchReviewEventTypes = Object.freeze({
  created: "project_created",
  updated: "project_updated",
  submitted: "project_submitted",
  reviewStarted: "review_started",
  approved: "project_approved",
  returned: "project_returned",
  rejected: "project_rejected",
} as const);

export function reviewEventType(
  next: LaunchReviewStatus,
): (typeof launchReviewEventTypes)[keyof typeof launchReviewEventTypes] {
  switch (next) {
    case "draft": {
      return launchReviewEventTypes.created;
    }
    case "submitted": {
      return launchReviewEventTypes.submitted;
    }
    case "in_review": {
      return launchReviewEventTypes.reviewStarted;
    }
    case "approved": {
      return launchReviewEventTypes.approved;
    }
    case "returned": {
      return launchReviewEventTypes.returned;
    }
    case "rejected": {
      return launchReviewEventTypes.rejected;
    }
  }
}

// ---------------------------------------------------------------------------
// Venue milestone state machine (03 §8.4)
// ---------------------------------------------------------------------------

const venueMilestoneTransitions: Readonly<
  Record<VenueMilestoneState, readonly VenueMilestoneState[]>
> = Object.freeze({
  PREPARING: ["APPLIED", "DEFERRED"],
  APPLIED: ["EVIDENCE_PENDING", "REJECTED", "DEFERRED"],
  EVIDENCE_PENDING: ["LISTED", "FEATURED", "EVIDENCE_INVALID", "REJECTED"],
  EVIDENCE_INVALID: ["EVIDENCE_PENDING", "REJECTED"],
  LISTED: ["FEATURED", "DELISTED"],
  FEATURED: ["LISTED", "DELISTED"],
  REJECTED: ["APPLIED"],
  DEFERRED: ["PREPARING", "APPLIED"],
  DELISTED: [],
});

/** States that assert a platform fact and therefore require evidence. */
export const venueMilestoneEvidenceStates: readonly VenueMilestoneState[] =
  Object.freeze(["LISTED", "FEATURED"]);

export function isVenueMilestoneTransitionAllowed(
  from: VenueMilestoneState,
  to: VenueMilestoneState,
): boolean {
  return venueMilestoneTransitions[from].includes(to);
}

export function venueMilestoneRequiresEvidence(
  state: VenueMilestoneState,
): boolean {
  return venueMilestoneEvidenceStates.includes(state);
}

/** SHA-256 over the operator-supplied evidence reference; the text itself is never stored. */
export function venueEvidenceDigest(evidence: string): string {
  return createHash("sha256").update(evidence, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export interface UnavailableProjection {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export function unavailable(reasonCode: string): UnavailableProjection {
  return Object.freeze({ status: "unavailable", reasonCode });
}

/**
 * Four-axis on-chain projection (03 §8.3). The axis names are fixed; each
 * value is the literal `unavailable` until the 02 baseline defines the enums,
 * and the tuple digest / snapshot block are null for the same reason.
 */
export interface LaunchOnChainStateProjection {
  readonly saleState: "unavailable";
  readonly entitlementState: "unavailable";
  readonly liquidityState: "unavailable";
  readonly operationalState: "unavailable";
  readonly stateTupleDigest: null;
  readonly snapshotBlockNumber: null;
  readonly snapshotBlockHash: null;
  readonly source: "unavailable";
  readonly reasonCode: typeof launchReasonCodes.contractBaselinePending;
}

export const unavailableOnChainState: LaunchOnChainStateProjection =
  Object.freeze({
    saleState: "unavailable",
    entitlementState: "unavailable",
    liquidityState: "unavailable",
    operationalState: "unavailable",
    stateTupleDigest: null,
    snapshotBlockNumber: null,
    snapshotBlockHash: null,
    source: "unavailable",
    reasonCode: launchReasonCodes.contractBaselinePending,
  });

export interface LaunchProjectProjection {
  readonly projectId: string;
  readonly name: string;
  readonly ticker: string;
  readonly narrative: string | null;
  readonly officialLinks: LaunchOfficialLinks;
  readonly materialVersion: number;
  readonly reviewStatus: LaunchReviewStatus;
  readonly reviewReasonCode: string | null;
  readonly kyb: UnavailableProjection & { readonly state: LaunchKybStatus };
  readonly attachments: UnavailableProjection;
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly launchId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly configVersion: typeof launchConfigVersion;
}

export interface LaunchSummaryProjection {
  readonly launchId: string;
  readonly projectId: string;
  readonly name: string;
  readonly ticker: string;
  readonly chainId: typeof launchChainId;
  readonly contractAddress: null;
  readonly configDigest: string | null;
  readonly scheduleStatus: LaunchScheduleStatus;
  readonly onChainState: LaunchOnChainStateProjection;
  readonly configVersion: string | null;
  readonly createdAt: string;
}
