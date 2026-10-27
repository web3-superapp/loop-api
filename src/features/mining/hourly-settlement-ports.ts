import type { MiningPoolCandidate } from "./mining-pool-roster.js";
import type {
  MiningClaimState,
  MiningEpochState,
  MiningParameterDocument,
  MiningParameterState,
} from "./hourly-settlement-contract.js";

/**
 * Decision 0116: storage and chain ports of the hourly settlement, the
 * reward routes, the claim flow, and the console. PostgreSQL implements the
 * repository (`src/database/mining-settlement-repository.ts`); the chain
 * port reads `LoopRewardClaim` on the launch slot.
 */

export class MiningSettlementUnavailableError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super("The mining settlement store is unavailable", options);
    this.name = "MiningSettlementUnavailableError";
  }
}

export class MiningSettlementConflictError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "MiningSettlementConflictError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Decision 0183: a parameter document names community ids that do not exist
 * or are not `verified` (draft save and approval refuse it, 422
 * `MINING_COMMUNITY_UNKNOWN`).
 */
export class MiningCommunityUnknownError extends Error {
  readonly communityIds: readonly string[];

  constructor(communityIds: readonly string[]) {
    super("MINING_COMMUNITY_UNKNOWN");
    this.name = "MiningCommunityUnknownError";
    this.communityIds = Object.freeze([...communityIds]);
  }
}

export class MiningClaimIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key reused with a different request");
    this.name = "MiningClaimIdempotencyConflictError";
  }
}

export interface MiningParameterAuthor {
  readonly actor: string;
  readonly accountId: string | null;
}

export interface MiningParameterVersionRecord {
  readonly versionId: string;
  readonly configVersion: string;
  readonly status: MiningParameterState;
  readonly document: MiningParameterDocument;
  readonly effectiveFrom: string;
  readonly draftAuthor: MiningParameterAuthor | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
}

export interface MiningAuditInput {
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly requestId: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface MiningAuditRecord {
  readonly auditId: string;
  readonly seq: number;
  readonly at: string;
  readonly action: string;
}

// ---------------------------------------------------------------- inputs

export interface MiningNftInstanceFact {
  readonly instanceId: string;
  /** The MEME asset id the instance's community is bound by. */
  readonly memeAssetId: string;
  /**
   * Every community bound to that asset (0 or 1 is well-formed). Decision
   * 0183: only `verified` communities (pending / rejected never count).
   */
  readonly communityIds: readonly string[];
}

export interface MiningNftOpeningFact {
  readonly instanceId: string;
  readonly address: string;
  readonly count: bigint;
}

export interface MiningNftMoveFact {
  readonly instanceId: string;
  /** null for a mint. */
  readonly from: string | null;
  /** null for a burn. */
  readonly to: string | null;
  /** Unix seconds (block time). */
  readonly at: bigint;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export type MiningAssetSource = "launch2" | "meme_v1";

export interface MiningAssetFact {
  readonly assetId: string;
  readonly source: MiningAssetSource;
  /** Unix seconds; null while not graduated. */
  readonly graduatedAt: bigint | null;
  /** Curve price at the hour start (after the last earlier trade), 1e18. */
  readonly openingPriceE18: bigint;
  readonly openingBalances: readonly {
    readonly address: string;
    readonly balanceRaw: bigint;
  }[];
  /** In-hour trades in chain order. */
  readonly moves: readonly {
    readonly address: string;
    readonly deltaRaw: bigint;
    readonly at: bigint;
    readonly priceAfterE18: bigint;
  }[];
  /**
   * Decision 0125: ERC-20 balances after graduation, from the indexed MEME
   * `Transfer` logs — opening balances at `from` (= max(graduation, hour
   * start)) and the transfers in `[from, hourEnd)` in chain order. Null /
   * absent when the asset has not graduated in or before the hour, or its
   * transfer coverage was not complete before the hour ended (the asset
   * then leaves the pool at graduation, as before).
   */
  readonly postGraduation?: {
    readonly from: bigint;
    readonly openingBalances: readonly {
      readonly address: string;
      readonly balanceRaw: bigint;
    }[];
    readonly moves: readonly {
      readonly address: string;
      readonly deltaRaw: bigint;
      readonly at: bigint;
    }[];
  } | null;
}

export interface MiningWalletOwnerFact {
  readonly address: string;
  readonly userIds: readonly string[];
}

export interface MiningReferralEdgeFact {
  readonly inviterUserId: string;
  readonly inviteeUserId: string;
  readonly depth: number;
  readonly from: bigint;
  readonly to: bigint | null;
}

/**
 * Decision 0183: a membership interval `[from, to)` (unix seconds, `to` null
 * = still a member) of a user in a verified community that binds a MEME the
 * hour reads. A community's creator is reported as one open interval from
 * the community's creation.
 */
export interface MiningMembershipFact {
  readonly userId: string;
  readonly communityId: string;
  readonly from: bigint;
  readonly to: bigint | null;
}

/** Decision 0183: the verified communities bound to an admitted asset. */
export interface MiningAssetCommunityFact {
  readonly assetId: string;
  readonly communityIds: readonly string[];
}

/**
 * Decision 0183 membership gate. Present on every fact set the repository
 * reads from S300 on: an NFT segment counts only while its holder is a
 * member of the instance's verified community, a MEME balance segment only
 * while its holder is a member of a verified community bound to that MEME
 * (a MEME no verified community binds is not gated). Fact sets without it
 * (fixtures written before S300) are prepared under the pre-0183 rule.
 */
export interface MiningMembershipGateFacts {
  readonly assetCommunities: readonly MiningAssetCommunityFact[];
  readonly memberships: readonly MiningMembershipFact[];
}

export interface MiningSettlementFacts {
  readonly nftInstances: readonly MiningNftInstanceFact[];
  readonly nftOpenings: readonly MiningNftOpeningFact[];
  readonly nftMoves: readonly MiningNftMoveFact[];
  readonly assets: readonly MiningAssetFact[];
  /** Admitted asset ids with no launch2 / MEME v1 source. */
  readonly unknownAssetIds: readonly string[];
  readonly walletOwners: readonly MiningWalletOwnerFact[];
  readonly referralEdges: readonly MiningReferralEdgeFact[];
  readonly membershipGate?: MiningMembershipGateFacts;
  /**
   * Decision 0184: the wallet scope the attribution query applied
   * (`MINING_EMBEDDED_WALLET_ONLY`). Absent on pre-S304 fixtures.
   */
  readonly walletKinds?: "embedded" | "all";
}

export interface MiningIndexerFreshness {
  /** Lane → last checkpoint update (null = never), only for lanes with sources. */
  readonly lanes: readonly {
    readonly lane: string;
    readonly hasSources: boolean;
    readonly updatedAt: string | null;
  }[];
}

// ---------------------------------------------------------------- epochs

export interface MiningEpochRecord {
  readonly epochId: string;
  readonly hourStart: string;
  readonly hourEnd: string;
  readonly status: MiningEpochState;
  readonly versionId: string | null;
  readonly budgetNftRaw: string;
  readonly budgetAssetRaw: string;
  readonly denominatorNftPower: string;
  readonly denominatorAssetPower: string;
  readonly allocatedNftRaw: string;
  readonly allocatedAssetRaw: string;
  readonly unallocatedNftRaw: string;
  readonly unallocatedAssetRaw: string;
  readonly userCount: number;
  readonly inputDigest: string | null;
  readonly inputSummary: Readonly<Record<string, unknown>>;
  readonly failureReasonCode: string | null;
  readonly attemptCount: number;
  readonly trigger: "scheduled" | "test_trigger";
  readonly settledAt: string | null;
  readonly updatedAt: string;
}

export interface MiningEpochRewardLevel {
  readonly level: number;
  readonly ratioBps: number;
  readonly effectiveMembers: number;
  readonly nftPower: string;
  readonly assetPower: string;
  readonly nftUnitsByCommunity: readonly {
    readonly communityId: string | null;
    readonly units: string;
  }[];
}

export interface MiningEpochRewardRecord {
  readonly epochId: string;
  readonly hourStart: string;
  readonly hourEnd: string;
  readonly userId: string;
  readonly nftSelfPower: string;
  readonly assetSelfPower: string;
  readonly nftReferralPower: string;
  readonly assetReferralPower: string;
  readonly nftTotalPower: string;
  readonly assetTotalPower: string;
  readonly levels: readonly MiningEpochRewardLevel[];
  readonly nftHoldings: readonly {
    readonly instanceId: string;
    readonly communityId: string | null;
    readonly countAtEnd: string;
    readonly power: string;
  }[];
  readonly assetHoldings: readonly {
    readonly assetId: string;
    readonly balanceAtEndRaw: string;
    readonly power: string;
  }[];
  readonly nftRewardRaw: string;
  readonly assetRewardRaw: string;
  readonly totalRewardRaw: string;
}

export interface CommitMiningEpochInput {
  readonly hourStart: string;
  readonly hourEnd: string;
  readonly versionId: string;
  readonly trigger: "scheduled" | "test_trigger";
  readonly budgetNftRaw: string;
  readonly budgetAssetRaw: string;
  readonly denominatorNftPower: string;
  readonly denominatorAssetPower: string;
  readonly allocatedNftRaw: string;
  readonly allocatedAssetRaw: string;
  readonly unallocatedNftRaw: string;
  readonly unallocatedAssetRaw: string;
  readonly inputDigest: string;
  readonly inputSummary: Readonly<Record<string, unknown>>;
  readonly rewards: readonly Omit<
    MiningEpochRewardRecord,
    "epochId" | "hourStart" | "hourEnd"
  >[];
}

export interface MiningBalanceRecord {
  readonly settledTotalRaw: string;
  readonly claimedTotalRaw: string;
  readonly unclaimedRaw: string;
}

// ---------------------------------------------------------------- claims

export interface MiningClaimRecord {
  readonly claimId: string;
  readonly userId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly chainId: string;
  readonly contractAddress: string;
  readonly cumulativeAmountRaw: string;
  readonly expectedDeltaRaw: string;
  readonly nonce: string;
  readonly deadline: string;
  readonly signature: string;
  readonly signerAddress: string;
  readonly preparedBlockNumber: string;
  readonly unsignedTransaction: Readonly<Record<string, unknown>>;
  readonly status: MiningClaimState;
  readonly transactionHash: string | null;
  readonly blockNumber: string | null;
  readonly confirmedDeltaRaw: string | null;
  readonly failureReasonCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateMiningClaimRecord = Omit<
  MiningClaimRecord,
  | "status"
  | "transactionHash"
  | "blockNumber"
  | "confirmedDeltaRaw"
  | "failureReasonCode"
  | "createdAt"
  | "updatedAt"
>;

export type MiningClaimTransition =
  | {
      readonly kind: "submitted";
      readonly transactionHash: string;
    }
  | {
      readonly kind: "confirming";
      readonly transactionHash: string;
      readonly blockNumber: string;
    }
  | {
      readonly kind: "succeeded";
      readonly transactionHash: string;
      readonly blockNumber: string;
      readonly deltaRaw: string;
    }
  | {
      readonly kind: "failed";
      readonly transactionHash: string | null;
      readonly blockNumber: string | null;
      readonly reasonCode: string;
    }
  | { readonly kind: "expired" };

export interface MiningSettlementRepository {
  // Parameters.
  listApprovedParameterVersions(): Promise<
    readonly MiningParameterVersionRecord[]
  >;
  listParameterVersions(): Promise<readonly MiningParameterVersionRecord[]>;
  getParameterVersion(
    versionId: string,
  ): Promise<MiningParameterVersionRecord | null>;
  /** Approved community weights (Decision 0046) for a draft's default copy. */
  listApprovedCommunityWeights(): Promise<
    readonly { readonly communityId: string; readonly weight: string }[]
  >;
  /** Admitted asset ids without a launch2 / MEME v1 source. */
  findUnknownAssetIds(assetIds: readonly string[]): Promise<readonly string[]>;
  /**
   * Decision 0183: the given community ids that do not exist or are not
   * `verified`, in input order.
   */
  findUnverifiedCommunityIds(
    communityIds: readonly string[],
  ): Promise<readonly string[]>;
  /**
   * Decision 0187: the mining pool roster candidates — every verified
   * community × the launch2 MEME it binds, ordered by community name then
   * id. `chainId` / `address` (MEME, lower-case, exact) / `query` (community
   * name or ticker, case-insensitive substring) filter; `after` + `limit`
   * page (absent limit: every row).
   */
  listMiningPoolCandidates(input: {
    readonly chainId?: string | null;
    readonly address?: string | null;
    readonly query?: string | null;
    readonly after?: {
      readonly communityName: string;
      readonly communityId: string;
    } | null;
    readonly limit?: number | null;
  }): Promise<readonly MiningPoolCandidate[]>;
  /**
   * Decision 0187: the launch2 event lane checkpoint of `chainId` (the block
   * the snapshot's pool rows are as of); null before the lane's first tick.
   */
  readLaunch2Checkpoint(chainId: string): Promise<{
    readonly blockNumber: string;
    readonly blockHash: string;
  } | null>;
  createParameterDraft(input: {
    readonly configVersion: string;
    readonly document: MiningParameterDocument;
    readonly effectiveFrom: string;
    readonly author: MiningParameterAuthor;
    readonly audit: MiningAuditInput;
  }): Promise<{
    readonly version: MiningParameterVersionRecord;
    readonly audit: MiningAuditRecord;
  }>;
  approveParameterVersion(input: {
    readonly versionId: string;
    readonly approver: { readonly actor: string; readonly accountId: string };
    readonly requestedAuditId: string;
    readonly audit: MiningAuditInput;
  }): Promise<{
    readonly version: MiningParameterVersionRecord;
    readonly audit: MiningAuditRecord;
  }>;
  withdrawParameterVersion(input: {
    readonly versionId: string;
    readonly audit: MiningAuditInput;
  }): Promise<{
    readonly version: MiningParameterVersionRecord;
    readonly audit: MiningAuditRecord;
  }>;
  /** A stand-alone audit row (intent / failure of a console action). */
  recordAudit(input: MiningAuditInput): Promise<MiningAuditRecord>;

  // Settlement.
  /** launch2_event always (NFT track); meme_event when an admitted asset is MEME v1. */
  readIndexerFreshness(input: {
    readonly chainId: string;
    readonly assetIds: readonly string[];
  }): Promise<MiningIndexerFreshness>;
  readSettlementFacts(input: {
    readonly chainId: string;
    readonly hourStart: bigint;
    readonly hourEnd: bigint;
    readonly assetIds: readonly string[];
    /** Decision 0184: attribute only `kind = 'embedded'` wallets when true. */
    readonly embeddedWalletOnly: boolean;
  }): Promise<MiningSettlementFacts>;
  getEpochByHour(hourStart: string): Promise<MiningEpochRecord | null>;
  getEpoch(epochId: string): Promise<MiningEpochRecord | null>;
  recordEpochFailure(input: {
    readonly hourStart: string;
    readonly hourEnd: string;
    readonly versionId: string;
    readonly trigger: "scheduled" | "test_trigger";
    readonly reasonCode: string;
    readonly inputSummary: Readonly<Record<string, unknown>>;
  }): Promise<MiningEpochRecord>;
  /** One transaction; a settled epoch is never rewritten (created false). */
  commitEpoch(input: CommitMiningEpochInput): Promise<{
    readonly created: boolean;
    readonly epoch: MiningEpochRecord;
  }>;
  listEpochs(input: {
    readonly beforeHourStart: string | null;
    readonly limit: number;
  }): Promise<readonly MiningEpochRecord[]>;
  listEpochRewards(input: {
    readonly epochId: string;
  }): Promise<readonly MiningEpochRewardRecord[]>;
  latestSettledEpoch(): Promise<MiningEpochRecord | null>;
  totalUnclaimedRaw(): Promise<string>;

  // User reads.
  getBalance(userId: string): Promise<MiningBalanceRecord>;
  getUserEpochReward(
    userId: string,
    epochId: string,
  ): Promise<MiningEpochRewardRecord | null>;
  /**
   * Settled hours of one user, newest first. Decision 0125: rows with zero
   * power on both tracks and no reward are not listed.
   */
  listUserEpochRewards(input: {
    readonly userId: string;
    readonly beforeHourStart: string | null;
    readonly limit: number;
  }): Promise<readonly MiningEpochRewardRecord[]>;

  // Claims.
  listUserClaimWallets(userId: string): Promise<readonly string[]>;
  listOpenClaims(userId: string): Promise<readonly MiningClaimRecord[]>;
  createClaim(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly build: () => Promise<CreateMiningClaimRecord>;
  }): Promise<{ readonly created: boolean; readonly claim: MiningClaimRecord }>;
  getClaim(userId: string, claimId: string): Promise<MiningClaimRecord | null>;
  /** Report idempotency: replays return the stored claim id. */
  claimReportCommand(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  }): Promise<void>;
  transitionClaim(input: {
    readonly claimId: string;
    readonly transition: MiningClaimTransition;
  }): Promise<MiningClaimRecord>;
  listClaims(input: {
    readonly userId: string;
    readonly beforeCreatedAt: string | null;
    readonly beforeClaimId: string | null;
    readonly limit: number;
  }): Promise<readonly MiningClaimRecord[]>;
  listUnresolvedClaims(limit: number): Promise<readonly MiningClaimRecord[]>;
}

export interface MiningClaimChainState {
  readonly blockNumber: bigint;
  readonly nonce: bigint;
  readonly paused: boolean;
  readonly contractBalanceRaw: bigint;
  /** address (lowercase) → claimed(address). */
  readonly claimedByWallet: ReadonlyMap<string, bigint>;
}

export interface MiningClaimedLog {
  readonly transactionHash: string;
  readonly blockNumber: bigint;
  readonly wallet: string;
  readonly amountRaw: bigint;
  readonly cumulativeAmountRaw: bigint;
  readonly nonce: bigint;
}

export type MiningClaimReceipt =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "reverted";
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: "mined";
      readonly blockNumber: bigint;
      readonly confirmations: bigint;
      /** `Claimed` logs the contract emitted in this transaction. */
      readonly logs: readonly MiningClaimedLog[];
    };

export interface MiningClaimChain {
  readonly chainReference: number;
  readClaimState(input: {
    readonly contract: string;
    readonly wallet: string;
    readonly otherWallets: readonly string[];
  }): Promise<MiningClaimChainState>;
  readFunding(contract: string): Promise<{
    readonly blockNumber: bigint;
    readonly balanceRaw: bigint;
    readonly liabilityHintRaw: bigint | null;
    readonly paused: boolean;
  }>;
  readReceipt(input: {
    readonly contract: string;
    readonly transactionHash: string;
  }): Promise<MiningClaimReceipt>;
  findClaimedLog(input: {
    readonly contract: string;
    readonly wallet: string;
    readonly nonce: bigint;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<MiningClaimedLog | null>;
  readNonce(input: {
    readonly contract: string;
    readonly wallet: string;
  }): Promise<{ readonly nonce: bigint; readonly blockNumber: bigint }>;
}
