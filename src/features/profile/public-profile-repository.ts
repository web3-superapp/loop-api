import type { PrivacyVisibility } from "./profile-v2-contract.js";

/**
 * Persistence boundary of the public profile reads, friend removal, and the
 * recommended communities list (Decision 0095). PostgreSQL is the truth for
 * every fact; nothing here is a fixture or a fallback.
 */

export const friendshipStates = Object.freeze([
  "none",
  "pending_out",
  "pending_in",
  "friends",
] as const);
export type FriendshipState = (typeof friendshipStates)[number];

export interface PublicProfileRecord {
  readonly targetUserId: string;
  readonly publicProfileId: string;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  readonly bio: string | null;
  readonly joinedAt: string | null;
  readonly counts: {
    readonly followers: number;
    readonly following: number;
    readonly communities: number;
  };
  readonly relationship: {
    readonly following: boolean;
    readonly followedBy: boolean;
    readonly friendship: FriendshipState;
    readonly blocked: boolean;
    readonly blockedBy: boolean;
  };
  readonly visibility: {
    readonly totalAssets: PrivacyVisibility;
    readonly tradeHistory: PrivacyVisibility;
    /** Decision 0169: the joined-communities list (missing row = everyone). */
    readonly communities: PrivacyVisibility;
  };
}

export type PublicProfileLookup =
  { readonly publicProfileId: string } | { readonly loopId: string };

export interface ProfileWalletRecord {
  readonly walletId: string;
  readonly address: string;
}

export interface TradeCursorPosition {
  readonly blockNumber: string;
  readonly logIndex: number;
}

export interface SwapTradeRow {
  readonly source: "swap";
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockTimestamp: string | null;
  readonly token0AssetId: string;
  readonly token1AssetId: string;
  /** Pool-perspective signed amounts (positive = paid into the pool). */
  readonly amount0: string;
  readonly amount1: string;
}

export interface TransferTradeRow {
  readonly source: "transfer";
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockTimestamp: string | null;
  readonly assetId: string;
  readonly direction: "in" | "out";
  readonly rawValue: string;
}

export type TradeRow = SwapTradeRow | TransferTradeRow;

export interface ListTradesInput {
  readonly chainId: string;
  readonly address: string;
  readonly limit: number;
  readonly before?: TradeCursorPosition | undefined;
}

/**
 * Decision 0169: a trade row with its merge time (microseconds since the
 * epoch): the block time, else the indexer's observation time.
 */
export type TimedTradeRow = TradeRow & { readonly atMicros: string };

/** Decision 0169: the merged (time-ordered) cursor position. */
export interface TradeTimeCursorPosition {
  readonly atMicros: string;
  readonly blockNumber: string;
  readonly logIndex: number;
  readonly source: "erc20" | "launch2";
  readonly transactionHash: string;
}

export interface ListTradesByTimeInput {
  readonly chainId: string;
  readonly address: string;
  readonly limit: number;
  readonly before?: TradeTimeCursorPosition | undefined;
}

/** Decision 0169: one community the profile owner belongs to. */
export interface ProfileCommunityRecord {
  readonly communityId: string;
  readonly name: string;
  readonly slug: string;
  readonly logoRef: string | null;
  readonly memberCount: number;
  readonly verificationStatus: "verified" | "unverified";
  /** Decision 0175: the operator-set custom label; null = none. */
  readonly label: string | null;
  readonly joinedAt: string;
  /** `joined_at` in microseconds (the cursor key; ISO keeps ms only). */
  readonly joinedAtMicros: string;
}

export interface ProfileCommunityCursorPosition {
  readonly joinedAtMicros: string;
  readonly communityId: string;
}

export interface RemoveFriendInput {
  readonly ownerUserId: string;
  readonly targetPublicProfileId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface RecommendedCommunityRecord {
  readonly communityId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoRef: string | null;
  readonly verificationStatus: "verified";
  /** Decision 0175: the operator-set custom label; null = none. */
  readonly label: string | null;
  readonly boundAssetKey: string | null;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly configVersion: string;
}

export interface PublicProfileRepository {
  /** Null when the profile does not exist or is not activated. */
  findProfile(input: {
    readonly viewerUserId: string;
    readonly lookup: PublicProfileLookup;
  }): Promise<PublicProfileRecord | null>;
  /** The owner's selected active wallet, or null. */
  getActiveWallet(ownerUserId: string): Promise<ProfileWalletRecord | null>;
  /** Whether the `erc20_transfer` lane has ever committed a checkpoint. */
  hasTransferCheckpoint(chainId: string): Promise<boolean>;
  listTrades(input: ListTradesInput): Promise<{
    readonly items: readonly TradeRow[];
    readonly hasMore: boolean;
  }>;
  /**
   * Decision 0169: the same rows as `listTrades`, newest first by
   * (time, block, log, hash) — the order merged with launch2 rows.
   */
  listTradesByTime(input: ListTradesByTimeInput): Promise<{
    readonly items: readonly TimedTradeRow[];
    readonly hasMore: boolean;
  }>;
  /**
   * Decision 0169: the owner's current (non-banned) memberships of verified
   * communities — the set `counts.communities` counts — newest join first.
   */
  listProfileCommunities(input: {
    readonly ownerUserId: string;
    readonly limit: number;
    readonly before?: ProfileCommunityCursorPosition | undefined;
  }): Promise<{
    readonly items: readonly ProfileCommunityRecord[];
    readonly hasMore: boolean;
  }>;
  removeFriend(input: RemoveFriendInput): Promise<{
    readonly publicProfileId: string;
    readonly removed: boolean;
  }>;
  /** Verified communities among `ids`, in the given order. */
  listVerifiedCommunitiesByIds(
    ids: readonly string[],
  ): Promise<readonly RecommendedCommunityRecord[]>;
}

export class PublicProfileRepositoryUnavailableError extends Error {
  readonly code = "public_profile_repository_unavailable";

  constructor() {
    super("The public profile repository is unavailable");
    this.name = "PublicProfileRepositoryUnavailableError";
  }
}

/** Nonexistent, inactive, or self target of a social command. */
export class PublicProfileTargetNotFoundError extends Error {
  readonly code = "public_profile_target_not_found";

  constructor() {
    super("The target profile is unavailable");
    this.name = "PublicProfileTargetNotFoundError";
  }
}

export class PublicProfileIdempotencyConflictError extends Error {
  readonly code = "public_profile_idempotency_conflict";

  constructor() {
    super("The idempotency key was used for another command");
    this.name = "PublicProfileIdempotencyConflictError";
  }
}

export function createUnavailablePublicProfileRepository(): PublicProfileRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new PublicProfileRepositoryUnavailableError());
  return Object.freeze({
    findProfile: unavailable,
    getActiveWallet: unavailable,
    hasTransferCheckpoint: unavailable,
    listTrades: unavailable,
    listTradesByTime: unavailable,
    listProfileCommunities: unavailable,
    removeFriend: unavailable,
    listVerifiedCommunitiesByIds: unavailable,
  });
}
