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
    removeFriend: unavailable,
    listVerifiedCommunitiesByIds: unavailable,
  });
}
