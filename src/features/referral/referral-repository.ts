import type { ReferralValidationStatus } from "./referral-contract.js";

/**
 * Referral persistence boundary (Decision 0036). Edges are append-only:
 * a relationship is invalidated by setting `effective_to`, never deleted.
 */

export interface InviteCodeRecord {
  readonly code: string;
  readonly issuedAt: string;
}

export interface ReferralAccountState {
  /** V2 profile activation time; null while the profile is pending. */
  readonly activatedAt: string | null;
  readonly hasWallet: boolean;
}

export interface ReferralEdgeRecord {
  readonly referralEdgeId: string;
  readonly inviterUserId: string;
  readonly inviteeUserId: string;
  readonly depth: number;
  readonly validationStatus: ReferralValidationStatus;
  readonly lockedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly configVersion: string;
}

export interface ReferralLevelCountRecord {
  readonly depth: number;
  readonly validationStatus: ReferralValidationStatus;
  readonly count: number;
}

/** Decision 0162: the invitee-facing validity, derived from settled facts. */
export const referralInviteeStatuses = ["pending", "valid", "invalid"] as const;
export type ReferralInviteeStatus = (typeof referralInviteeStatuses)[number];

/** Decision 0162: one direct invitee of the caller. */
export interface ReferralInviteeRecord {
  readonly referralEdgeId: string;
  /** Null when the invitee has no active profile or blocked the inviter. */
  readonly publicProfileId: string | null;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  readonly boundAt: string;
  /** Microsecond-exact `locked_at` (keyset key), never sent to clients. */
  readonly boundAtKey: string;
  readonly validationStatus: ReferralInviteeStatus;
}

export interface ReferralInviteeKey {
  readonly boundAtKey: string;
  readonly referralEdgeId: string;
}

export interface ReferralInviteeStatsRecord {
  /** Direct invitees in force (depth 1, `effective_to` null). */
  readonly directCount: number;
  /** In-force direct invitees with self power > 0 in the newest settled hour. */
  readonly validCount: number;
  /** In-force edges of depth 2..5. */
  readonly level2to5Count: number;
  /** `hourEnd` of the newest settled hour; null before the first one. */
  readonly validAsOf: string | null;
}

/** Decision 0162: the caller's referral power of the newest settled hour. */
export interface ReferralBoostRecord {
  readonly epochId: string;
  readonly hourStart: string;
  readonly hourEnd: string;
  /** `nft_referral_power + asset_referral_power` (decimal string). */
  readonly referralPower: string;
  readonly nftReferralPower: string;
  readonly assetReferralPower: string;
  readonly levels: readonly {
    readonly level: number;
    readonly effectiveMembers: number;
    readonly nftPower: string;
    readonly assetPower: string;
  }[];
}

export interface ClaimReferralInput {
  readonly inviteeUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly edges: readonly {
    readonly inviterUserId: string;
    readonly depth: number;
  }[];
  readonly validationStatus: ReferralValidationStatus;
}

export interface ReferralRepository {
  getInviteCode(ownerUserId: string): Promise<InviteCodeRecord | null>;
  /** Issues the code, or returns the existing one on a concurrent race. */
  issueInviteCode(input: {
    readonly ownerUserId: string;
    readonly code: string;
    readonly requestId: string;
  }): Promise<InviteCodeRecord>;
  findInviterByCode(code: string): Promise<string | null>;
  getAccountState(userId: string): Promise<ReferralAccountState>;
  /** Direct inviter chain of `userId`: parent, grandparent, ... up to `limit`. */
  getAncestorChain(userId: string, limit: number): Promise<readonly string[]>;
  getDirectEdge(inviteeUserId: string): Promise<ReferralEdgeRecord | null>;
  /** Writes the edges and audit atomically; a replay returns the direct edge. */
  claim(input: ClaimReferralInput): Promise<ReferralEdgeRecord>;
  /**
   * Decision 0162: `epochId` is the settled hour `valid` is read from (the
   * one `getLatestSettledEpochId` returned for this response); null = none.
   */
  countInvitees(
    inviterUserId: string,
    epochId: string | null,
  ): Promise<readonly ReferralLevelCountRecord[]>;
  recordRejectedClaim(input: {
    readonly inviteeUserId: string;
    readonly inviterUserId: string | null;
    readonly reasonCode: string;
    readonly requestId: string;
  }): Promise<void>;
  /** Decision 0162: newest binding first, keyset after `after`. */
  listDirectInvitees(input: {
    readonly inviterUserId: string;
    readonly after: ReferralInviteeKey | null;
    readonly limit: number;
  }): Promise<readonly ReferralInviteeRecord[]>;
  /** Decision 0162: the newest settled mining hour, read once per response. */
  getLatestSettledEpochId(): Promise<string | null>;
  getInviteeStats(
    inviterUserId: string,
    epochId: string | null,
  ): Promise<ReferralInviteeStatsRecord>;
  /** Null when `epochId` is null (before the first settled hour). */
  getReferralBoost(
    userId: string,
    epochId: string | null,
  ): Promise<ReferralBoostRecord | null>;
}

export class ReferralRepositoryUnavailableError extends Error {
  readonly code = "referral_repository_unavailable";

  constructor() {
    super("The referral repository is unavailable");
    this.name = "ReferralRepositoryUnavailableError";
  }
}

export class ReferralCodeTakenError extends Error {
  readonly code = "referral_code_taken";

  constructor() {
    super("The invite code is already taken");
    this.name = "ReferralCodeTakenError";
  }
}

export class ReferralAlreadyBoundError extends Error {
  readonly code = "referral_already_bound";

  constructor() {
    super("The account already has a referral binding");
    this.name = "ReferralAlreadyBoundError";
  }
}

export class ReferralIdempotencyConflictError extends Error {
  readonly code = "referral_idempotency_conflict";

  constructor() {
    super("The idempotency key is bound to a different referral command");
    this.name = "ReferralIdempotencyConflictError";
  }
}

export function createUnavailableReferralRepository(): ReferralRepository {
  const unavailable = () =>
    Promise.reject(new ReferralRepositoryUnavailableError());
  return Object.freeze({
    getInviteCode: unavailable,
    issueInviteCode: unavailable,
    findInviterByCode: unavailable,
    getAccountState: unavailable,
    getAncestorChain: unavailable,
    getDirectEdge: unavailable,
    claim: unavailable,
    countInvitees: unavailable,
    recordRejectedClaim: unavailable,
    listDirectInvitees: unavailable,
    getLatestSettledEpochId: unavailable,
    getInviteeStats: unavailable,
    getReferralBoost: unavailable,
  });
}
