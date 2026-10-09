import type {
  MiningFormulaDocument,
  MiningFormulaStatus,
  MiningPriceGuardRule,
  MiningWeightRangeDocument,
} from "../mining/mining-contract.js";

/**
 * Persistence port of the operator console (Decision 0102). Every write
 * method appends its `admin_audit_log` row in the same transaction as the
 * change it records; `src/database/admin-repository.ts` implements it.
 */

export const adminSettingKeys = [
  "recommended_community_ids",
  "intel_promotions",
  "meme_listing_policy",
] as const;
export type AdminSettingKey = (typeof adminSettingKeys)[number];

export interface AdminSettingRecord {
  readonly key: AdminSettingKey;
  readonly value: unknown;
  /** Millisecond precision; the optimistic concurrency token. */
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface AdminAuditInput {
  readonly actor: string;
  /**
   * Decision 0109: the acting `admin_accounts.id`; null (or absent) for the
   * ADMIN_USERNAME bootstrap administrator and anonymous rows.
   */
  readonly actorAccountId?: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string;
}

export interface AdminAuditRecord {
  readonly auditId: string;
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string;
}

export type AdminCommunityStatus = "pending" | "verified" | "rejected";

export interface AdminCommunityRecord {
  readonly communityId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoRef: string | null;
  readonly verificationStatus: AdminCommunityStatus;
  readonly boundAssetId: string | null;
  readonly memberCount: number;
  readonly ownerUserId: string;
  readonly ownerLoopId: string | null;
  readonly applicationSubmittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly verifiedAt: string | null;
  readonly rejectedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommunityReviewNoteRecord {
  readonly noteId: string;
  readonly communityId: string;
  readonly at: string;
  readonly actor: string;
  readonly decision: "verify" | "reject";
  readonly reasonCode: string;
  readonly reasonText: string | null;
  readonly auditId: string;
}

export type AdminMemeListing = "listed" | "hidden";

export interface AdminMemeTokenRecord {
  readonly memeTokenId: string;
  readonly chainId: string;
  readonly contractAddress: string;
  readonly tokenAddress: string | null;
  readonly name: string;
  readonly symbol: string;
  readonly status: string;
  readonly listing: AdminMemeListing;
  readonly listingReasonCode: string | null;
  readonly listingReasonText: string | null;
  readonly listingChangedAt: string | null;
  readonly creatorUserId: string;
  readonly creatorLoopId: string | null;
  readonly holderCount: number;
  readonly tradeCount: number;
  readonly sold: string;
  readonly graduationNeedsOperator: boolean;
  readonly chainCreatedAt: string | null;
  readonly graduatedAt: string | null;
  readonly createdAt: string;
}

export interface AdminCommunityWeightEntry {
  readonly communityId: string;
  readonly weight: string;
}

/** Placeholder parameters a version carries for the product; never computed. */
export interface AdminFormulaPlaceholders {
  readonly status: "placeholder";
  readonly nftWeight: string | null;
  readonly inviteInitialPower: string | null;
}

/**
 * Decision 0110: who saved a console draft. `admin_account` = a console
 * account; `admin_bootstrap` = the ADMIN_USERNAME administrator (no
 * account ID).
 */
export interface AdminFormulaDraftAuthor {
  readonly kind: "admin_account" | "admin_bootstrap";
  readonly actor: string;
  readonly accountId: string | null;
}

/** Decision 0110: the console account that approved a version. */
export interface AdminFormulaApprover {
  readonly actor: string;
  readonly accountId: string;
}

export interface AdminFormulaVersionRecord {
  readonly configVersion: string;
  readonly formula: MiningFormulaDocument;
  readonly weightRange: MiningWeightRangeDocument;
  readonly priceGuardRules: readonly MiningPriceGuardRule[];
  readonly status: MiningFormulaStatus;
  readonly effectiveAt: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Null for versions not created by the console. */
  readonly communityWeights: readonly AdminCommunityWeightEntry[] | null;
  /**
   * Decision 0110: null for versions saved before migration 000056 or by a
   * script; such a draft cannot be approved from the console.
   */
  readonly draftAuthor: AdminFormulaDraftAuthor | null;
  /** Decision 0110: null for script approvals and older versions. */
  readonly approvedBy: AdminFormulaApprover | null;
}

export interface AdminOverviewRecord {
  readonly accounts: number;
  readonly communities: Readonly<Record<AdminCommunityStatus, number>>;
  readonly pendingReviews: number;
  readonly voiceRooms: { readonly live: number; readonly participants: number };
  readonly memeTokens: {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly hidden: number;
  };
  readonly indexerLanes: readonly {
    readonly lane: string;
    readonly chainId: string;
    readonly lastBlockNumber: string;
    readonly updatedAt: string;
  }[];
}

export interface AdminRepository {
  getSetting(key: AdminSettingKey): Promise<AdminSettingRecord | null>;
  /**
   * Compare-and-set one setting. `expectedUpdatedAt` null means "no row
   * yet"; `value` null deletes the row (the constant is in force again).
   */
  writeSetting(input: {
    readonly key: AdminSettingKey;
    readonly value: unknown;
    readonly expectedUpdatedAt: string | null;
    readonly audit: Omit<AdminAuditInput, "before" | "after">;
  }): Promise<{
    readonly setting: AdminSettingRecord | null;
    readonly audit: AdminAuditRecord;
  }>;
  appendAudit(input: AdminAuditInput): Promise<AdminAuditRecord>;
  listAudit(input: {
    readonly limit: number;
    readonly beforeSeq: number | null;
    readonly actor: string | null;
    readonly action: string | null;
  }): Promise<readonly AdminAuditRecord[]>;
  overview(): Promise<AdminOverviewRecord>;

  listCommunities(input: {
    readonly status: AdminCommunityStatus | null;
    readonly query: string | null;
    readonly limit: number;
    readonly after: {
      readonly createdAt: string;
      readonly communityId: string;
    } | null;
  }): Promise<readonly AdminCommunityRecord[]>;
  getCommunity(communityId: string): Promise<AdminCommunityRecord | null>;
  getCommunitiesByIds(
    ids: readonly string[],
  ): Promise<readonly AdminCommunityRecord[]>;
  listCommunityReviewNotes(
    communityId: string,
  ): Promise<readonly CommunityReviewNoteRecord[]>;
  recordCommunityReview(input: {
    readonly communityId: string;
    readonly decision: "verify" | "reject";
    readonly reasonCode: string;
    readonly reasonText: string | null;
    readonly audit: AdminAuditInput;
  }): Promise<{
    readonly note: CommunityReviewNoteRecord;
    readonly audit: AdminAuditRecord;
  }>;

  listMemeTokens(input: {
    readonly status: string | null;
    readonly listing: AdminMemeListing | null;
    readonly query: string | null;
    readonly limit: number;
    readonly after: {
      readonly createdAt: string;
      readonly memeTokenId: string;
    } | null;
  }): Promise<readonly AdminMemeTokenRecord[]>;
  getMemeToken(memeTokenId: string): Promise<AdminMemeTokenRecord | null>;
  setMemeListing(input: {
    readonly memeTokenId: string;
    readonly listing: AdminMemeListing;
    readonly reasonCode: string;
    readonly reasonText: string | null;
    readonly audit: Omit<AdminAuditInput, "before" | "after">;
  }): Promise<{
    readonly token: AdminMemeTokenRecord;
    readonly changed: boolean;
    readonly audit: AdminAuditRecord;
  }>;

  listFormulaVersions(): Promise<readonly AdminFormulaVersionRecord[]>;
  getFormulaVersion(
    configVersion: string,
  ): Promise<AdminFormulaVersionRecord | null>;
  /** Community weights approved under the version in force. */
  listApprovedCommunityWeights(): Promise<readonly AdminCommunityWeightEntry[]>;
  createFormulaDraft(input: {
    readonly configVersion: string;
    readonly formula: MiningFormulaDocument;
    readonly weightRange: MiningWeightRangeDocument;
    readonly priceGuardRules: readonly MiningPriceGuardRule[];
    readonly communityWeights: readonly AdminCommunityWeightEntry[];
    /** Decision 0110: stored with the draft, immutable. */
    readonly author: AdminFormulaDraftAuthor;
    readonly audit: Omit<AdminAuditInput, "before" | "after">;
  }): Promise<{
    readonly version: AdminFormulaVersionRecord;
    readonly audit: AdminAuditRecord;
  }>;
  /**
   * Approves a `pending_approval` version: retires the approved one, makes
   * this one approved and effective now, and applies its community
   * weights — one transaction (Decision 0046 semantics).
   *
   * Decision 0110: refused (on the locked row) when the draft has no known
   * author (`AdminStateConflictError` ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN) or
   * when the approver is the author (`AdminSeparationOfDutiesError`
   * ADMIN_FORMULA_SELF_APPROVAL).
   */
  approveFormula(input: {
    readonly configVersion: string;
    readonly approver: AdminFormulaApprover;
    /** The `.requested` intent row this decision answers. */
    readonly requestedAuditId: string;
    readonly audit: Omit<AdminAuditInput, "before" | "after">;
  }): Promise<{
    readonly version: AdminFormulaVersionRecord;
    readonly retiredVersion: string | null;
    readonly audit: AdminAuditRecord;
  }>;
  /** `pending_approval → retired`; an approved version is never withdrawn here. */
  withdrawFormula(input: {
    readonly configVersion: string;
    readonly audit: Omit<AdminAuditInput, "before" | "after">;
  }): Promise<{
    readonly version: AdminFormulaVersionRecord;
    readonly audit: AdminAuditRecord;
  }>;
}

export class AdminRepositoryUnavailableError extends Error {
  readonly code = "admin_repository_unavailable";

  constructor(options: { readonly cause?: unknown } = {}) {
    super("The admin repository is unavailable", options);
    this.name = "AdminRepositoryUnavailableError";
  }
}

/** A refused state transition or a stale `updatedAt`. */
export class AdminStateConflictError extends Error {
  readonly code = "admin_state_conflict";

  constructor(
    readonly reasonCode: string,
    readonly details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super("The admin write conflicts with the current state");
    this.name = "AdminStateConflictError";
  }
}

/**
 * Decision 0110: a separation-of-duties rule refused the actor (403
 * PERMISSION_DENIED with `reasonCode`).
 */
export class AdminSeparationOfDutiesError extends Error {
  readonly code = "admin_separation_of_duties";

  constructor(readonly reasonCode: string) {
    super("The actor may not perform this step of the change");
    this.name = "AdminSeparationOfDutiesError";
  }
}

export class AdminTargetNotFoundError extends Error {
  readonly code = "admin_target_not_found";

  constructor(readonly reasonCode: string) {
    super("The admin target does not exist");
    this.name = "AdminTargetNotFoundError";
  }
}

export class AdminValidationError extends Error {
  readonly code = "admin_validation_failed";

  constructor(
    readonly reasonCode: string,
    readonly details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super("The admin input is not admissible");
    this.name = "AdminValidationError";
  }
}
