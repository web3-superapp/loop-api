import type {
  LaunchEligibilityTier,
  LaunchKybStatus,
  LaunchOfficialLinks,
  LaunchProjectValues,
  LaunchReviewDecision,
  LaunchReviewStatus,
  LaunchScheduleStatus,
  LaunchSlotStatus,
  VenueMilestoneMarketType,
  VenueMilestoneState,
  VenueMilestoneVenue,
} from "./launch-contract.js";

/**
 * Launch persistence boundary (Decision 0036). Records use camelCase and
 * string amounts; the repository maps every snake_case column before a
 * record leaves it. No method here builds, signs, or observes a transaction.
 */

export interface LaunchProjectRecord {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly ticker: string;
  readonly narrative: string | null;
  readonly officialLinks: LaunchOfficialLinks;
  readonly materialVersion: number;
  readonly reviewStatus: LaunchReviewStatus;
  readonly kybStatus: LaunchKybStatus;
  readonly reviewReasonCode: string | null;
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly launchId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LaunchRecord {
  readonly launchId: string;
  readonly projectId: string;
  readonly chainId: string;
  readonly contractAddress: string | null;
  readonly configDigest: string | null;
  readonly scheduleStatus: LaunchScheduleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LaunchCatalogRecord {
  readonly launch: LaunchRecord;
  readonly projectName: string;
  readonly projectTicker: string;
  readonly confirmedConfigVersion: string | null;
}

export interface LaunchConfigRecord {
  readonly configId: string;
  readonly launchId: string;
  readonly configVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly status: LaunchSlotStatus;
  readonly effectiveAt: string | null;
}

export interface LaunchRoundRecord {
  readonly roundId: string;
  readonly launchId: string;
  readonly roundIndex: number;
  readonly configVersion: string;
  readonly status: LaunchSlotStatus;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly priceUsd1: string | null;
  readonly eligibilityTier: LaunchEligibilityTier | null;
  readonly walletRoundCapRaw: string | null;
}

export interface LaunchDetailRecord {
  readonly launch: LaunchRecord;
  readonly project: LaunchProjectRecord;
  readonly configs: readonly LaunchConfigRecord[];
  readonly rounds: readonly LaunchRoundRecord[];
}

export interface VenueMilestoneRecord {
  readonly venueMilestoneId: string;
  readonly projectId: string;
  readonly venue: VenueMilestoneVenue;
  readonly marketType: VenueMilestoneMarketType;
  readonly state: VenueMilestoneState;
  readonly evidenceDigest: string | null;
  readonly evidenceRecordedAt: string | null;
  readonly reviewer: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface LaunchEconomyCountsRecord {
  readonly projectsByStatus: Readonly<Record<LaunchReviewStatus, number>>;
  readonly launchesByScheduleStatus: Readonly<
    Record<LaunchScheduleStatus, number>
  >;
  readonly confirmedRoundCount: number;
  readonly observedAt: string;
}

export interface LaunchProjectPageInput {
  readonly ownerUserId: string;
  readonly status: LaunchReviewStatus | null;
  readonly limit: number;
  readonly after: {
    readonly createdAt: string;
    readonly projectId: string;
  } | null;
}

export interface CreateLaunchProjectInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly values: LaunchProjectValues;
}

export interface ReplaceLaunchProjectInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly values: LaunchProjectValues;
}

export interface SubmitLaunchProjectInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface ReviewLaunchProjectInput {
  readonly projectId: string;
  readonly decision: LaunchReviewDecision;
  readonly reasonCode: string;
  readonly requestId: string;
}

export interface RecordVenueMilestoneInput {
  readonly projectId: string;
  readonly venue: VenueMilestoneVenue;
  readonly marketType: VenueMilestoneMarketType;
  readonly state: VenueMilestoneState;
  readonly evidenceDigest: string | null;
  readonly reviewer: string | null;
  readonly requestId: string;
}

export interface LaunchRepository {
  createProject(input: CreateLaunchProjectInput): Promise<LaunchProjectRecord>;
  getProject(projectId: string): Promise<LaunchProjectRecord | null>;
  listProjects(
    input: LaunchProjectPageInput,
  ): Promise<readonly LaunchProjectRecord[]>;
  replaceProject(
    input: ReplaceLaunchProjectInput,
  ): Promise<LaunchProjectRecord>;
  submitProject(input: SubmitLaunchProjectInput): Promise<LaunchProjectRecord>;
  /** Operator path (Dev script). Approval creates the catalog launch row. */
  reviewProject(input: ReviewLaunchProjectInput): Promise<{
    readonly project: LaunchProjectRecord;
    readonly launch: LaunchRecord | null;
  }>;
  listLaunches(): Promise<readonly LaunchCatalogRecord[]>;
  getLaunch(launchId: string): Promise<LaunchDetailRecord | null>;
  listMilestones(projectId: string): Promise<readonly VenueMilestoneRecord[]>;
  recordMilestone(
    input: RecordVenueMilestoneInput,
  ): Promise<VenueMilestoneRecord>;
  getEconomyCounts(): Promise<LaunchEconomyCountsRecord>;
}

export class LaunchRepositoryUnavailableError extends Error {
  readonly code = "launch_repository_unavailable";

  constructor() {
    super("The launch repository is unavailable");
    this.name = "LaunchRepositoryUnavailableError";
  }
}

export class LaunchNotFoundError extends Error {
  readonly code = "launch_not_found";

  constructor() {
    super("The launch resource does not exist or is not visible");
    this.name = "LaunchNotFoundError";
  }
}

export class LaunchVersionConflictError extends Error {
  readonly code = "launch_version_conflict";

  constructor() {
    super("The stored launch project version conflicts");
    this.name = "LaunchVersionConflictError";
  }
}

export class LaunchDataStaleError extends Error {
  readonly code = "launch_data_stale";

  constructor() {
    super("The stored launch state does not allow this transition");
    this.name = "LaunchDataStaleError";
  }
}

export class LaunchIdempotencyConflictError extends Error {
  readonly code = "launch_idempotency_conflict";

  constructor() {
    super("The idempotency key is bound to a different launch command");
    this.name = "LaunchIdempotencyConflictError";
  }
}

export class LaunchMilestoneTransitionError extends Error {
  readonly code = "launch_milestone_transition_invalid";

  constructor() {
    super("The venue milestone transition is not allowed");
    this.name = "LaunchMilestoneTransitionError";
  }
}

export function createUnavailableLaunchRepository(): LaunchRepository {
  const unavailable = () =>
    Promise.reject(new LaunchRepositoryUnavailableError());
  return Object.freeze({
    createProject: unavailable,
    getProject: unavailable,
    listProjects: unavailable,
    replaceProject: unavailable,
    submitProject: unavailable,
    reviewProject: unavailable,
    listLaunches: unavailable,
    getLaunch: unavailable,
    listMilestones: unavailable,
    recordMilestone: unavailable,
    getEconomyCounts: unavailable,
  });
}
