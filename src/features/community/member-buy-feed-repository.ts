/**
 * Persistence of the `community_member_buy_feed` worker lane (Decision 0097).
 * Internal user IDs and wallet addresses stay behind this boundary except
 * `buyerUserId`, which only travels back into the repository as a row key.
 */

export const memberBuyFeedLane = "community_member_buy_feed";
/** `last_log_index` meaning "every log of that block was consumed". */
export const feedCursorWholeBlockLogIndex = 2_147_483_647;

export interface FeedPosition {
  readonly blockNumber: string;
  readonly logIndex: number;
}

export type MemberBuyEventOutcome =
  | "pending"
  | "sent"
  | "rejected"
  | "truncated"
  | "skipped_not_buy"
  | "skipped_private"
  | "skipped_no_channel";

export interface MemberBuyFeedAsset {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** One (swap, community) pair whose swap wallet is an active member's. */
export interface MemberBuyFeedMatch {
  readonly communityId: string;
  readonly boundAssetId: string;
  /** Null while the official channel is not provisioned in Stream. */
  readonly streamChannelId: string | null;
  readonly buyerUserId: string;
  readonly publicProfileId: string;
  readonly tradeHistoryVisibility: "self" | "everyone";
  readonly anonymousMode: boolean;
  /** The stored outcome when this pair was handled before, else null. */
  readonly existingOutcome: MemberBuyEventOutcome | null;
}

export interface MemberBuyFeedCandidate {
  readonly chainId: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockTimestamp: string | null;
  readonly token0: MemberBuyFeedAsset;
  readonly token1: MemberBuyFeedAsset;
  /** Pool-perspective signed integer amounts. */
  readonly amount0: string;
  readonly amount1: string;
  /** Empty when no eligible community has a member on either side. */
  readonly matches: readonly MemberBuyFeedMatch[];
}

export interface MemberBuyEventKey {
  readonly chainId: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly communityId: string;
}

export interface RecordMemberBuyEventInput extends MemberBuyEventKey {
  readonly buyerUserId: string;
  readonly blockNumber: string;
  readonly outcome: MemberBuyEventOutcome;
  readonly streamMessageId: string | null;
}

export interface SettleMemberBuyEventInput extends MemberBuyEventKey {
  readonly outcome: Exclude<MemberBuyEventOutcome, "pending">;
}

export interface MemberBuyFeedRepository {
  /** `pool_event` indexer checkpoint block, or null before its first commit. */
  readPoolEventCheckpoint(chainId: string): Promise<string | null>;
  readCursor(chainId: string): Promise<FeedPosition | null>;
  /** Inserts the cursor unless one exists; returns the stored position. */
  initializeCursor(
    chainId: string,
    position: FeedPosition,
  ): Promise<FeedPosition>;
  /** Moves the cursor forward only; a position behind it is ignored. */
  advanceCursor(chainId: string, position: FeedPosition): Promise<void>;
  /**
   * Swaps strictly after `after` and at or below `throughBlockNumber`, of
   * registered pools that hold the bound asset of a verified community,
   * oldest first, at most `limit` swaps (with or without matches).
   */
  listCandidates(input: {
    readonly chainId: string;
    readonly after: FeedPosition;
    readonly throughBlockNumber: string;
    readonly limit: number;
  }): Promise<readonly MemberBuyFeedCandidate[]>;
  /** Inserts the row unless the key exists (then nothing changes). */
  recordEvent(input: RecordMemberBuyEventInput): Promise<void>;
  /** Moves a `pending` row to its final outcome; other rows are untouched. */
  settleEvent(input: SettleMemberBuyEventInput): Promise<void>;
}
