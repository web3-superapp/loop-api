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
  countInvitees(
    inviterUserId: string,
  ): Promise<readonly ReferralLevelCountRecord[]>;
  recordRejectedClaim(input: {
    readonly inviteeUserId: string;
    readonly inviterUserId: string | null;
    readonly reasonCode: string;
    readonly requestId: string;
  }): Promise<void>;
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
  });
}
