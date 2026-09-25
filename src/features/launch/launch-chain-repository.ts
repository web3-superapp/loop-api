import type { LaunchChainId } from "../chain/chain-contract.js";
import type {
  LaunchEntitlementState,
  LaunchLiquidityState,
  LaunchOperationalState,
  LaunchSaleState,
} from "./launch-contract.js";

/**
 * Persistence boundary of the Launch chain facts (Decision 0077): the
 * `launch_event` lane, the projections it maintains, the allowlist roots,
 * and the Launch purchase Intent. Amounts are decimal strings, block numbers
 * decimal strings, digests 64 hex without `0x` in storage (Decision 0076
 * ruling 6) and `0x`-prefixed at this boundary.
 */

export const launchEventLane = "launch_event" as const;

export interface LaunchRegisteredSale {
  readonly launchId: string;
  /** Decimal string. */
  readonly saleId: string;
  readonly chainId: LaunchChainId;
  readonly contractAddress: string;
  readonly contractVersion: string;
}

export interface LaunchCheckpointRecord {
  readonly lastBlockNumber: string;
  readonly lastBlockHash: string;
  readonly startedFromBlockNumber: string;
  readonly updatedAt: string;
}

export interface LaunchIndexedEventInput {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly contractAddress: string;
  readonly saleId: string;
  readonly launchId: string;
  readonly eventName: string;
  /** Buyer / wallet argument, lowercase; null for sale-level events. */
  readonly walletAddress: string | null;
  /** Every value a decimal string, a lowercase hex string, or an axis name. */
  readonly payload: Readonly<Record<string, string>>;
  readonly removed: boolean;
}

export interface LaunchStateProjectionInput {
  readonly launchId: string;
  readonly saleState: LaunchSaleState;
  readonly entitlementState: LaunchEntitlementState;
  readonly liquidityState: LaunchLiquidityState;
  readonly operationalState: LaunchOperationalState;
  /** 0x + 64 hex (converted to the column format by the repository). */
  readonly configVersion: string;
  readonly stateTupleDigest: string;
  readonly snapshotBlockNumber: string;
  readonly snapshotBlockHash: string;
}

export interface CommitLaunchSegmentInput {
  readonly chainId: LaunchChainId;
  readonly events: readonly LaunchIndexedEventInput[];
  readonly projections: readonly LaunchStateProjectionInput[];
  readonly checkpoint: {
    readonly lastBlockNumber: string;
    readonly lastBlockHash: string;
    readonly startedFromBlockNumber: string;
  };
  /** Present when the segment replays a rewound range. */
  readonly rewindFromBlockNumber?: string;
  /** Purchases at or below this block are `confirmed`, above it `pending`. */
  readonly confirmedThroughBlockNumber: string;
}

export interface LaunchStateProjectionRecord {
  readonly launchId: string;
  readonly saleState: LaunchSaleState;
  readonly entitlementState: LaunchEntitlementState;
  readonly liquidityState: LaunchLiquidityState;
  readonly operationalState: LaunchOperationalState;
  /** 0x + 64 hex. */
  readonly configVersion: string;
  readonly stateTupleDigest: string;
  readonly snapshotBlockNumber: string;
  readonly snapshotBlockHash: string;
}

export interface LaunchPurchaseRecord {
  readonly purchaseRecordId: string;
  readonly walletId: string;
  readonly roundId: string | null;
  readonly roundIndex: number;
  readonly usd1Amount: string;
  readonly tokenAmount: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly confirmationState: "pending" | "confirmed" | "reorged";
  readonly observedAt: string;
}

export interface LaunchEntitlementRecord {
  readonly entitlementId: string;
  readonly walletId: string;
  readonly entitledTokens: string;
  readonly claimedTokens: string;
  readonly state: "frozen" | "partially_claimed" | "claimed";
  readonly frozenAtBlock: string | null;
}

export interface LaunchRefundRecord {
  readonly refundLiabilityId: string;
  readonly walletId: string;
  readonly refundableUsd1: string;
  readonly refundedUsd1: string;
  readonly state: "frozen" | "partially_refunded" | "refunded";
  readonly frozenAtBlock: string | null;
}

export interface LaunchHistoryRecord {
  readonly purchaseRecords: readonly LaunchPurchaseRecord[];
  readonly entitlements: readonly LaunchEntitlementRecord[];
  readonly refunds: readonly LaunchRefundRecord[];
}

export interface LaunchEconomyChainRecord {
  readonly registeredSaleCount: number;
  /** Sum of SaleFinalized.totalRaisedUsd1 with outcome SUCCEEDED. */
  readonly totalRaisedUsd1: string;
  readonly lockedLpCount: number;
}

export const launchAllowlistModes = [
  "whitelist",
  "community",
  "activity",
] as const;
export type LaunchAllowlistMode = (typeof launchAllowlistModes)[number];

export interface LaunchAllowlistRootRecord {
  readonly allowlistRootId: string;
  readonly launchId: string;
  readonly roundIndex: number;
  readonly snapshotBlock: string;
  readonly snapshotBlockHash: string;
  /** 0x + 64 hex. */
  readonly root: string;
  readonly leafCount: number;
  readonly mode: LaunchAllowlistMode;
  readonly members: readonly string[];
  readonly computedAt: string;
}

export interface CreateLaunchIntentInput {
  readonly intentId: string;
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly launchId: string;
  readonly projectId: string;
  readonly roundId: string;
  readonly roundIndex: number;
  readonly saleId: string;
  readonly chainId: LaunchChainId;
  readonly quoteAssetId: string;
  readonly projectAssetId: string;
  readonly payAmountRaw: string;
  readonly expectedReceiveRaw: string;
  readonly minTokenAmountRaw: string;
  readonly configVersion: string;
  readonly walletCumulativeRaw: string;
  readonly contractAddress: string;
  /** 0x + 64 hex. */
  readonly stateTupleDigest: string;
  readonly snapshotBlockNumber: string;
  readonly snapshotBlockHash: string;
  readonly payloadDigest: string;
  readonly state: "prepared" | "awaiting_signature";
  readonly deadline: string;
  readonly eligibilityProof: readonly string[];
  readonly unsignedTransaction: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
}

export const launchIntentStates = [
  "prepared",
  "awaiting_signature",
  "submitted",
  "confirmed",
] as const;
export type LaunchIntentState = (typeof launchIntentStates)[number];

export interface LaunchIntentRecord extends Omit<
  CreateLaunchIntentInput,
  "state"
> {
  readonly state: LaunchIntentState;
  /** Device broadcast report (pending evidence); null until reported. */
  readonly transactionHash: string | null;
  /** The observed transaction matched the payload at report time. */
  readonly payloadVerified: boolean;
  readonly reportedAt: string | null;
  readonly createdAt: string;
}

export class LaunchIntentReportConflictError extends Error {
  readonly code = "launch_intent_report_conflict";

  constructor() {
    super("The Launch Intent was already reported with another transaction");
    this.name = "LaunchIntentReportConflictError";
  }
}

export interface RegisterLaunchSaleInput {
  readonly launchId: string;
  readonly saleId: string;
  readonly contractAddress: string;
  readonly contractVersion: string;
  /** 0x + 64 hex. */
  readonly configVersionOnchain: string;
  /** Lowercase; `getSaleConfig.usd1`, already equal to LAUNCH_USD1_ADDRESS. */
  readonly quoteTokenAddress: string;
  /** Lowercase; `getSaleConfig.projectToken`, already equal to LOOP's record. */
  readonly projectTokenAddress: string;
  readonly requestId: string;
}

export interface LaunchChainRepository {
  getCheckpoint(chainId: LaunchChainId): Promise<LaunchCheckpointRecord | null>;
  /** Drops the lane checkpoint so the next tick re-seeds from the start block. */
  resetCheckpoint(chainId: LaunchChainId): Promise<boolean>;
  listRegisteredSales(input: {
    readonly chainId: LaunchChainId;
    readonly contractAddress: string;
    readonly contractVersion: string;
  }): Promise<readonly LaunchRegisteredSale[]>;
  commitSegment(input: CommitLaunchSegmentInput): Promise<void>;
  listStateProjections(
    launchIds: readonly string[],
  ): Promise<ReadonlyMap<string, LaunchStateProjectionRecord>>;
  countHolders(launchId: string): Promise<number>;
  listHistory(input: {
    readonly launchId: string;
    readonly ownerUserId: string;
    readonly limit: number;
  }): Promise<LaunchHistoryRecord>;
  getEconomyChain(input: {
    readonly chainId: LaunchChainId;
    readonly contractAddress: string;
    readonly contractVersion: string;
  }): Promise<LaunchEconomyChainRecord>;
  importAllowlist(input: {
    readonly launchId: string;
    readonly roundIndex: number;
    readonly addresses: readonly string[];
    readonly source: string;
  }): Promise<{ readonly inserted: number; readonly existing: number }>;
  listAllowlist(
    launchId: string,
    roundIndex: number,
  ): Promise<readonly string[]>;
  /** Accounts' active wallets whose membership was active and joined at `at`. */
  listCommunityMemberWallets(input: {
    readonly communityId: string;
    readonly at: string;
  }): Promise<readonly string[]>;
  /** Active wallets of accounts with a positive Mining power in the window. */
  listActiveMinerWallets(input: {
    readonly since: string;
    readonly until: string;
  }): Promise<readonly string[]>;
  insertAllowlistRoot(input: {
    readonly launchId: string;
    readonly roundIndex: number;
    readonly snapshotBlock: string;
    readonly snapshotBlockHash: string;
    readonly root: string;
    readonly mode: LaunchAllowlistMode;
    readonly members: readonly string[];
  }): Promise<LaunchAllowlistRootRecord>;
  listAllowlistRoots(
    launchId: string,
    roundIndex: number,
  ): Promise<readonly LaunchAllowlistRootRecord[]>;
  /**
   * Claims the Idempotency-Key (`launch_intent_v1`) and inserts the Intent in
   * one transaction. A replay with the same digest returns the stored Intent.
   */
  createIntent(input: {
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly build: () => Promise<CreateLaunchIntentInput>;
    readonly ownerUserId: string;
  }): Promise<{
    readonly created: boolean;
    readonly intent: LaunchIntentRecord;
  }>;
  registerSale(input: RegisterLaunchSaleInput): Promise<void>;
  getIntent(input: {
    readonly ownerUserId: string;
    readonly launchId: string;
    readonly intentId: string;
  }): Promise<LaunchIntentRecord | null>;
  /**
   * `awaiting_signature` → `submitted` (or `confirmed` when the lane already
   * indexed a Purchased log of that transaction). The same hash again is a
   * no-op; another hash is LaunchIntentReportConflictError.
   */
  reportIntentBroadcast(input: {
    readonly ownerUserId: string;
    readonly intentId: string;
    readonly transactionHash: string;
    readonly payloadVerified: boolean;
  }): Promise<LaunchIntentRecord>;
}

export class LaunchChainRepositoryUnavailableError extends Error {
  readonly code = "launch_chain_repository_unavailable";

  constructor() {
    super("The Launch chain repository is unavailable");
    this.name = "LaunchChainRepositoryUnavailableError";
  }
}

export class LaunchIntentIdempotencyConflictError extends Error {
  readonly code = "launch_intent_idempotency_conflict";

  constructor() {
    super("The idempotency key is bound to a different Launch Intent");
    this.name = "LaunchIntentIdempotencyConflictError";
  }
}

export class LaunchSaleRegistrationError extends Error {
  readonly code = "launch_sale_registration_refused";

  constructor(readonly reasonCode: string) {
    super("The sale registration was refused");
    this.name = "LaunchSaleRegistrationError";
  }
}

export function createUnavailableLaunchChainRepository(): LaunchChainRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new LaunchChainRepositoryUnavailableError());
  return Object.freeze({
    getCheckpoint: unavailable,
    resetCheckpoint: unavailable,
    listRegisteredSales: unavailable,
    commitSegment: unavailable,
    listStateProjections: unavailable,
    countHolders: unavailable,
    listHistory: unavailable,
    getEconomyChain: unavailable,
    importAllowlist: unavailable,
    listAllowlist: unavailable,
    listCommunityMemberWallets: unavailable,
    listActiveMinerWallets: unavailable,
    insertAllowlistRoot: unavailable,
    listAllowlistRoots: unavailable,
    createIntent: unavailable,
    registerSale: unavailable,
    getIntent: unavailable,
    reportIntentBroadcast: unavailable,
  });
}
