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
  /**
   * Block of the latest surviving `LPNFTLocked` event of this sale, or null
   * when none is indexed (Decision 0077, S83b7b): the graduation block that
   * orders the overview's `graduated` list. Never a state source.
   */
  readonly lpLockedBlockNumber: string | null;
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

/**
 * One `Claimed` or `Refunded` log of the caller's wallet (Decision 0087).
 * `amount` is in the base units of `assetId`: the project token for
 * `claimed`, USD1 for `refunded`.
 */
export interface LaunchSettlementRecord {
  readonly settlementRecordId: string;
  readonly kind: "claimed" | "refunded";
  readonly walletId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly cumulativeAmount: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly confirmationState: "pending" | "confirmed" | "reorged";
  readonly observedAt: string;
}

export interface LaunchHistoryRecord {
  readonly purchaseRecords: readonly LaunchPurchaseRecord[];
  readonly entitlements: readonly LaunchEntitlementRecord[];
  readonly refunds: readonly LaunchRefundRecord[];
  readonly settlements: readonly LaunchSettlementRecord[];
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

/**
 * Decision 0087: the contract call an Intent seals. `buy` is 06 §4.1
 * `buy(...)`; `claim` and `claimRefund` are `claim(saleId)` and
 * `claimRefund(saleId)` and name no round.
 */
export const launchIntentKinds = ["buy", "claim", "claimRefund"] as const;
export type LaunchIntentKind = (typeof launchIntentKinds)[number];

export interface CreateLaunchIntentInput {
  readonly intentId: string;
  readonly kind: LaunchIntentKind;
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly launchId: string;
  readonly projectId: string;
  /** Null for `claim` / `claimRefund`. */
  readonly roundId: string | null;
  readonly roundIndex: number | null;
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
  // Decision 0080: written only by the receipt reconciler, from `submitted`.
  "reverted",
  "failed",
  "expired",
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
  /** Finalized receipt fact (Decision 0080); null until reconciled. */
  readonly receipt: LaunchIntentReceipt | null;
  /** Why a reconciled Intent left `submitted` without success (0080). */
  readonly reasonCode: string | null;
  /** Decoded revert reason of a `reverted` Intent, when one was readable. */
  readonly revertReason: string | null;
}

/** The receipt fact the reconcile lane stores (Decision 0080). */
export interface LaunchIntentReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly confirmations: number;
  readonly observedAt: string;
}

/** Terminal states the reconcile lane may write (Decision 0080). */
export type LaunchIntentSettlement =
  "confirmed" | "reverted" | "failed" | "expired";

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
  /**
   * Decision 0080: leases up to `limit` reported `submitted` Intents of the
   * chain whose `reconcile_after` has passed, moving it `leaseMs` ahead.
   */
  leaseReconcilableIntents(input: {
    readonly chainId: LaunchChainId;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly LaunchIntentRecord[]>;
  /** The observed transaction matched the sealed payload (0080). */
  markIntentPayloadVerified(input: {
    readonly intentId: string;
    readonly transactionHash: string;
  }): Promise<void>;
  /**
   * `submitted` → a terminal state, only while the row is still `submitted`
   * with that hash. `null` when another writer (the `launch_event` lane)
   * settled it first: first evidence wins, the loser is a no-op.
   */
  settleIntent(input: {
    readonly intentId: string;
    readonly transactionHash: string;
    readonly toState: LaunchIntentSettlement;
    readonly reasonCode: string | null;
    readonly revertReason: string | null;
    readonly receipt: LaunchIntentReceipt | null;
  }): Promise<LaunchIntentRecord | null>;
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
    leaseReconcilableIntents: unavailable,
    markIntentPayloadVerified: unavailable,
    settleIntent: unavailable,
  });
}
