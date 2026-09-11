import { createHash } from "node:crypto";

import { z } from "zod";

import type { LaunchChainId } from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";

/**
 * V2 Launch wire contract (Decision 0036). The 02 contract document has not
 * been provided, so every on-chain fact is published as `unavailable` with
 * `LAUNCH_CONTRACT_BASELINE_PENDING`; the only writable surface is the
 * off-chain project application. Public fields are camelCase; every amount
 * is a string; every mutable rule carries `configVersion` + `effectiveAt`.
 * The chain a launch belongs to is the `launch` slot configured at creation
 * time (Decision 0038), never a constant of this module.
 */

export const launchConfigVersion = "launchCatalogV1" as const;
export const launchCommandDigestVersion = "launch_command_v1" as const;
export const launchCommandIdempotencyScope = "v2_launch_command" as const;
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
/**
 * The five venue tracks of 03 §8.4, each with its own state machine. A track
 * without a stored row is implicitly `PREPARING`; the milestones read
 * publishes that row so a client never has to infer it from an empty list.
 */
export const venueMilestoneTracks: readonly {
  readonly venue: VenueMilestoneVenue;
  readonly marketType: VenueMilestoneMarketType;
}[] = Object.freeze([
  Object.freeze({ venue: "lbank", marketType: "spot" }),
  Object.freeze({ venue: "binance", marketType: "alpha" }),
  Object.freeze({ venue: "binance", marketType: "perpetual" }),
  Object.freeze({ venue: "binance", marketType: "spot" }),
  Object.freeze({ venue: "bithumb", marketType: "spot" }),
] as const);

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
    // Omitting the object is the same as omitting every key (all null).
    officialLinks: officialLinksSchema.optional(),
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
  value: z.infer<typeof officialLinksSchema> | undefined,
): LaunchOfficialLinks {
  return Object.freeze({
    website: value?.website ?? null,
    x: value?.x ?? null,
    telegram: value?.telegram ?? null,
    discord: value?.discord ?? null,
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

/**
 * Applicant-facing review copy (Decision 0041). `reviewReasonCode` stays the
 * machine-readable contract; `reviewReasonText` is its display projection and
 * the only string a client may render. The catalog below is the operator
 * vocabulary: each entry owns the single status it explains, so a code used
 * against another status falls back to the status sentence instead of telling
 * the applicant to do something the state machine forbids. A generic code
 * (`operator_manual_review`) and any code outside the catalog resolve to the
 * status sentence too, so an internal identifier can never reach a screen.
 */
const launchReviewReasonCatalog: Readonly<
  Record<string, { readonly status: LaunchReviewStatus; readonly text: string }>
> = Object.freeze({
  needs_more_material: Object.freeze({
    status: "returned",
    text: "材料还不完整，补齐后可以重新提交审核。",
  }),
  official_links_unreachable: Object.freeze({
    status: "returned",
    text: "官方链接无法访问或核对，换成可访问的链接后可以重新提交。",
  }),
  material_mismatch: Object.freeze({
    status: "returned",
    text: "名称、代币符号与简介之间对不上，改一致后可以重新提交。",
  }),
  ticker_conflict: Object.freeze({
    status: "returned",
    text: "这个代币符号已被占用，换一个后可以重新提交。",
  }),
  duplicate_submission: Object.freeze({
    status: "rejected",
    text: "同一个项目已经有一份申请在审核，这份重复申请不再处理。",
  }),
  policy_violation: Object.freeze({
    status: "rejected",
    text: "材料不符合上线规则，这份申请不会继续；调整后可以新建项目再提交。",
  }),
});

/** One sentence per status: what is blocked now, and what changes it. */
const launchReviewStatusTexts: Readonly<Record<LaunchReviewStatus, string>> =
  Object.freeze({
    draft: "项目还是草稿，材料填完就可以提交审核。",
    submitted: "材料已提交，审核期间不能修改，有结果后状态会更新。",
    in_review: "材料正在审核，这期间不能修改，有结果后状态会更新。",
    returned: "材料被退回，修改后可以重新提交审核。",
    approved: "审核已通过，材料不再可改，可以继续后面的发行安排。",
    rejected: "审核未通过，这份申请不能再提交，需要的话可以新建项目。",
  });

/**
 * The display projection of `reviewReasonCode`. Null code means no review
 * trail to show, so there is nothing to render either. A client renders this
 * string as-is and never parses it back into a code.
 */
export function launchReviewReasonText(
  status: LaunchReviewStatus,
  reasonCode: string | null,
): string | null {
  if (reasonCode === null) {
    return null;
  }
  const entry = launchReviewReasonCatalog[reasonCode];
  return entry !== undefined && entry.status === status
    ? entry.text
    : launchReviewStatusTexts[status];
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
  /** Display projection of `reviewReasonCode`; never parsed back into a code. */
  readonly reviewReasonText: string | null;
  readonly kyb: UnavailableProjection & { readonly state: LaunchKybStatus };
  readonly attachments: UnavailableProjection;
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly launchId: string | null;
  /** Compare-and-swap version; null in the non-owner projection. */
  readonly version: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly configVersion: typeof launchConfigVersion;
}

export interface LaunchSummaryProjection {
  readonly launchId: string;
  readonly projectId: string;
  readonly name: string;
  readonly ticker: string;
  readonly chainId: LaunchChainId;
  readonly contractAddress: null;
  readonly configDigest: string | null;
  readonly scheduleStatus: LaunchScheduleStatus;
  readonly onChainState: LaunchOnChainStateProjection;
  readonly configVersion: string | null;
  readonly createdAt: string;
}
