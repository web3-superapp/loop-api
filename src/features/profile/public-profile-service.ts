import { createHash } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type { AssetRecord } from "../../database/chain-registry-repository.js";
import { formatDecimalAmount } from "../chain/chain-contract.js";
import {
  absoluteAmount,
  classifySwap,
  swapQuoteSets,
} from "../chain/swap-classification.js";
import { commandDigest } from "../community/community-contract.js";
import { addDecimalStrings } from "../market/market-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  compareSortKeys,
  projectLaunch2ActivityItem,
  type WalletActivitySortKey,
  type WalletLaunch2ActivityRecord,
} from "../wallet/wallet-activity-launch2.js";
import type { WalletReadService } from "../wallet/wallet-read-service.js";
import {
  profileLaunch2ReasonCodes,
  projectLaunch2Holdings,
  type ProfileLaunch2Block,
  type ProfileLaunch2HoldingItem,
  type ProfileLaunch2Sources,
  type ProfileLaunch2TradeItem,
} from "./profile-launch2.js";
import {
  PublicProfileIdempotencyConflictError,
  PublicProfileRepositoryUnavailableError,
  PublicProfileTargetNotFoundError,
  type FriendshipState,
  type PublicProfileLookup,
  type PublicProfileRecord,
  type ProfileCommunityCursorPosition,
  type ProfileWalletRecord,
  type PublicProfileRepository,
  type RecommendedCommunityRecord,
  type TimedTradeRow,
  type TradeRow,
} from "./public-profile-repository.js";

/**
 * Public profile reads, friend removal, and recommended communities
 * (Decision 0095). Every read is bound to the authenticated viewer; a
 * profile whose owner blocked the viewer is indistinguishable from one that
 * does not exist.
 */

export const publicProfileReasonCodes = Object.freeze({
  walletNotBound: "WALLET_NOT_BOUND",
  chainUnavailable: "BSC_READ_UNAVAILABLE",
  walletRuntimeUnavailable: "WALLET_RUNTIME_UNAVAILABLE",
  indexerNotStarted: "BSC_INDEXER_NOT_STARTED",
  cursorNotConfigured: "V2_CURSOR_NOT_CONFIGURED",
} as const);

export const profileTradeLimits = Object.freeze({ default: 20, maximum: 50 });
/** Decision 0169: `GET /v2/profiles/{id}/communities` page size. */
export const profileCommunityLimits = Object.freeze({
  default: 20,
  maximum: 50,
});
export const profileCommunitiesHiddenReasonCode =
  "PROFILE_COMMUNITIES_HIDDEN" as const;
const communitiesCursorRoute = "v2ProfileCommunities";
/** The community logo references the App renders (preset or uploaded). */
const communityLogoRefPattern =
  /^(avatar:preset\/community-(0[1-9]|1[0-2])|logo:media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
export const recommendedDefaultSelectedCount = 5;
const tradesCursorRoute = "v2ProfileTrades";

export type PublicDataStatus = "available" | "hidden" | "unavailable";

export interface PublicProfileResource {
  readonly publicProfileId: string;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  readonly bio: string | null;
  readonly joinedAt: string | null;
  readonly counts: PublicProfileRecord["counts"];
  readonly relationship: {
    readonly following: boolean;
    readonly followedBy: boolean;
    readonly friendship: FriendshipState;
    readonly blocked: boolean;
    readonly blockedBy: boolean;
  };
  readonly visibility: { readonly holdings: boolean; readonly trades: boolean };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface HoldingItem {
  readonly assetId: string;
  readonly symbol: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly balance: string;
  readonly usdValue: string | null;
}

export interface HoldingsResource {
  readonly status: PublicDataStatus;
  readonly reasonCode: string | null;
  readonly totalUsd: string | null;
  /** Decision 0169: launch2 rows only while PROFILE_LAUNCH2_EMIT is on. */
  readonly items: readonly (HoldingItem | ProfileLaunch2HoldingItem)[];
  readonly observedAt: string | null;
  /** Decision 0169: present only while PROFILE_LAUNCH2_EMIT is on. */
  readonly launch2?: ProfileLaunch2Block;
  readonly contractVersion: typeof v2ContractVersion;
}

export type TradeKind = "buy" | "sell" | "transfer_in" | "transfer_out";

export interface TradeItem {
  readonly eventId: string;
  readonly kind: TradeKind;
  readonly assetId: string;
  readonly symbol: string;
  readonly amount: string;
  readonly usdValue: string | null;
  readonly blockTimestamp: string | null;
  readonly blockNumber: string;
  readonly txHash: string;
}

export interface TradesResource {
  readonly status: PublicDataStatus;
  readonly reasonCode: string | null;
  /** Decision 0169: launch2 rows only while PROFILE_LAUNCH2_EMIT is on. */
  readonly items: readonly (TradeItem | ProfileLaunch2TradeItem)[];
  readonly nextCursor: string | null;
  /** Decision 0169: present only while PROFILE_LAUNCH2_EMIT is on. */
  readonly launch2?: ProfileLaunch2Block;
  readonly contractVersion: typeof v2ContractVersion;
}

/** Decision 0169: one community of `GET /v2/profiles/{id}/communities`. */
export interface ProfileCommunityItem {
  readonly communityId: string;
  readonly name: string;
  readonly slug: string;
  readonly logoRef: string | null;
  readonly memberCount: number;
  readonly verificationStatus: "verified" | "unverified";
  readonly joinedAt: string;
}

export type ProfileCommunitiesResource =
  | {
      readonly status: "available";
      readonly items: readonly ProfileCommunityItem[];
      readonly nextCursor: string | null;
      readonly contractVersion: typeof v2ContractVersion;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: typeof profileCommunitiesHiddenReasonCode;
      readonly contractVersion: typeof v2ContractVersion;
    };

export interface RemoveFriendResource {
  readonly publicProfileId: string;
  readonly friendship: "none";
  readonly removed: boolean;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface RecommendedCommunitiesResource {
  readonly items: readonly RecommendedCommunityRecord[];
  readonly defaultSelectedIds: readonly string[];
  readonly contractVersion: typeof v2ContractVersion;
}

export interface PublicProfileService {
  getProfile(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly lookup: PublicProfileLookup;
  }): Promise<PublicProfileResource>;
  getHoldings(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly publicProfileId: string;
    readonly signal: AbortSignal;
  }): Promise<HoldingsResource>;
  getTrades(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly publicProfileId: string;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<TradesResource>;
  /** Decision 0169: the communities the profile owner joined. */
  getCommunities(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly publicProfileId: string;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<ProfileCommunitiesResource>;
  removeFriend(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly publicProfileId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<RemoveFriendResource>;
  listRecommendedCommunities(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<RecommendedCommunitiesResource>;
}

export interface CreatePublicProfileServiceInput {
  readonly repository: PublicProfileRepository;
  /** Null when the wallet runtime (Privy + inventory) is not composed. */
  readonly walletReadService: Pick<WalletReadService, "getBalances"> | null;
  readonly assets: { getAsset(assetId: string): Promise<AssetRecord | null> };
  readonly cursorCodec: V2CursorCodec | null;
  readonly chainId: string;
  /** Configured BSC USD1 token address, lowercase, or null. */
  readonly usd1Address: string | null;
  readonly recommendedCommunityIds: readonly string[];
  /**
   * Decision 0102: the operator console's list. A non-null answer replaces
   * `recommendedCommunityIds`; null keeps the environment list in force.
   */
  readonly recommendedCommunityIdsOverride?: () => Promise<
    readonly string[] | null
  >;
  /**
   * Decision 0169: PROFILE_LAUNCH2_EMIT on composes the Launch-chain reads
   * merged into holdings and trades; null / absent (off, the default) keeps
   * both routes byte-identical and reads nothing new.
   */
  readonly launch2?: ProfileLaunch2Sources | null;
  readonly logger?: {
    warn(object: Record<string, unknown>, message: string): void;
  };
}

/** Deterministic, UUID-shaped, opaque event ID of one chain log. */
export function tradeEventId(
  chainId: string,
  transactionHash: string,
  logIndex: number,
): string {
  const hex = createHash("sha256")
    .update(`loop:v2:profile-trade:${chainId}:${transactionHash}:${logIndex}`)
    .digest("hex");
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mapFailure(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof PublicProfileTargetNotFoundError) {
    throw V2ApiError.notFound();
  }
  if (error instanceof PublicProfileIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof PublicProfileRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  if (error instanceof InvalidV2CursorError) {
    throw V2ApiError.invalidRequest();
  }
  throw error;
}

function parseLimit(
  value: unknown,
  limits: {
    readonly default: number;
    readonly maximum: number;
  } = profileTradeLimits,
): number {
  if (value === undefined) {
    return limits.default;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]{1,3}$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > limits.maximum) {
    throw V2ApiError.invalidRequest();
  }
  return parsed;
}

export function createPublicProfileService(
  input: CreatePublicProfileServiceInput,
): PublicProfileService {
  const { quoteAssetIds, stableAssetIds } = swapQuoteSets(
    input.chainId,
    input.usd1Address,
  );

  /** The visible target, or 404 PROFILE_NOT_FOUND. */
  async function requireProfile(
    principal: AuthenticatedLoopPrincipal,
    lookup: PublicProfileLookup,
  ): Promise<PublicProfileRecord> {
    let record: PublicProfileRecord | null;
    try {
      record = await input.repository.findProfile({
        viewerUserId: principal.userId,
        lookup,
      });
    } catch (error) {
      return mapFailure(error);
    }
    if (record === null || record.relationship.blockedBy) {
      throw V2ApiError.fromCode("PROFILE_NOT_FOUND");
    }
    return record;
  }

  function isSelf(
    principal: AuthenticatedLoopPrincipal,
    record: PublicProfileRecord,
  ): boolean {
    return record.targetUserId === principal.userId;
  }

  function data<T extends object>(
    status: PublicDataStatus,
    reasonCode: string | null,
    rest: T,
  ): T & {
    readonly status: PublicDataStatus;
    readonly reasonCode: string | null;
    readonly contractVersion: typeof v2ContractVersion;
  } {
    return Object.freeze({
      status,
      reasonCode,
      ...rest,
      contractVersion: v2ContractVersion,
    });
  }

  function emptyHoldings(
    status: "hidden" | "unavailable",
    reasonCode: string | null,
  ): HoldingsResource {
    return data(status, reasonCode, {
      totalUsd: null,
      items: Object.freeze([]),
      observedAt: null,
    });
  }

  function emptyTrades(
    status: "hidden" | "unavailable",
    reasonCode: string | null,
  ): TradesResource {
    return data(status, reasonCode, {
      items: Object.freeze([]),
      nextCursor: null,
    });
  }

  const service: PublicProfileService = {
    async getProfile({ principal, lookup }) {
      const record = await requireProfile(principal, lookup);
      return Object.freeze({
        publicProfileId: record.publicProfileId,
        loopId: record.loopId,
        alias: record.alias,
        avatarRef: record.avatarRef,
        bio: record.bio,
        joinedAt: record.joinedAt,
        counts: record.counts,
        relationship: Object.freeze({
          following: record.relationship.following,
          followedBy: record.relationship.followedBy,
          friendship: record.relationship.friendship,
          blocked: record.relationship.blocked,
          blockedBy: false,
        }),
        visibility: Object.freeze({
          holdings: record.visibility.totalAssets === "everyone",
          trades: record.visibility.tradeHistory === "everyone",
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async getHoldings({ principal, publicProfileId, signal }) {
      const record = await requireProfile(principal, { publicProfileId });
      if (
        !isSelf(principal, record) &&
        record.visibility.totalAssets !== "everyone"
      ) {
        return emptyHoldings("hidden", null);
      }
      const launch2 = input.launch2 ?? null;
      if (launch2 !== null) {
        return mergedHoldings(record, launch2, signal);
      }
      if (input.walletReadService === null) {
        return emptyHoldings(
          "unavailable",
          publicProfileReasonCodes.walletRuntimeUnavailable,
        );
      }
      let wallet;
      try {
        wallet = await input.repository.getActiveWallet(record.targetUserId);
      } catch (error) {
        return mapFailure(error);
      }
      if (wallet === null) {
        return emptyHoldings(
          "unavailable",
          publicProfileReasonCodes.walletNotBound,
        );
      }
      return primaryHoldings(record, wallet, input.walletReadService, signal);
    },

    async getTrades({ principal, publicProfileId, cursor, limit }) {
      const pageLimit = parseLimit(limit);
      if (cursor !== undefined && typeof cursor !== "string") {
        throw V2ApiError.invalidRequest();
      }
      const record = await requireProfile(principal, { publicProfileId });
      if (
        !isSelf(principal, record) &&
        record.visibility.tradeHistory !== "everyone"
      ) {
        return emptyTrades("hidden", null);
      }
      const codec = input.cursorCodec;
      if (codec === null) {
        return emptyTrades(
          "unavailable",
          publicProfileReasonCodes.cursorNotConfigured,
        );
      }
      const launch2 = input.launch2 ?? null;
      if (launch2 !== null) {
        return mergedTrades({
          principal,
          record,
          codec,
          cursor,
          pageLimit,
          sources: launch2,
        });
      }
      return primaryTrades({ principal, record, codec, cursor, pageLimit });
    },

    async getCommunities({ principal, publicProfileId, cursor, limit }) {
      // Without `limit`, a cursor keeps the page size of its first page.
      let pageLimit = parseLimit(limit, profileCommunityLimits);
      if (cursor !== undefined && typeof cursor !== "string") {
        throw V2ApiError.invalidRequest();
      }
      const record = await requireProfile(principal, { publicProfileId });
      if (
        !isSelf(principal, record) &&
        record.visibility.communities !== "everyone"
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reasonCode: profileCommunitiesHiddenReasonCode,
          contractVersion: v2ContractVersion,
        });
      }
      const codec = input.cursorCodec;
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      const cursorContext = {
        ownerId: principal.userId,
        route: communitiesCursorRoute,
        filter: `profile=${record.publicProfileId}`,
      };
      try {
        let before: ProfileCommunityCursorPosition | undefined;
        if (cursor !== undefined) {
          const continuation = codec.decode({ ...cursorContext, cursor });
          const joined = continuation["j"];
          const communityId = continuation["c"];
          const size = continuation["n"];
          if (
            typeof joined !== "string" ||
            !/^[0-9]{1,20}$/u.test(joined) ||
            typeof communityId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
              communityId,
            ) ||
            typeof size !== "number" ||
            !Number.isSafeInteger(size) ||
            size < 1 ||
            size > profileCommunityLimits.maximum
          ) {
            throw V2ApiError.invalidRequest();
          }
          before = { joinedAtMicros: joined, communityId };
          if (limit === undefined) {
            pageLimit = size;
          }
        }
        const page = await input.repository.listProfileCommunities({
          ownerUserId: record.targetUserId,
          limit: pageLimit,
          before,
        });
        const last = page.items.at(-1);
        return Object.freeze({
          status: "available" as const,
          items: Object.freeze(
            page.items.map((item) =>
              Object.freeze({
                communityId: item.communityId,
                name: item.name,
                slug: item.slug,
                logoRef:
                  item.logoRef !== null &&
                  communityLogoRefPattern.test(item.logoRef)
                    ? item.logoRef
                    : null,
                memberCount: item.memberCount,
                verificationStatus: item.verificationStatus,
                joinedAt: item.joinedAt,
              }),
            ),
          ),
          nextCursor:
            page.hasMore && last !== undefined
              ? codec.encode({
                  ...cursorContext,
                  continuation: {
                    j: last.joinedAtMicros,
                    c: last.communityId,
                    n: pageLimit,
                  },
                })
              : null,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async removeFriend({
      principal,
      publicProfileId,
      idempotencyKey,
      requestId,
    }) {
      try {
        const result = await input.repository.removeFriend({
          ownerUserId: principal.userId,
          targetPublicProfileId: publicProfileId,
          idempotencyKey,
          requestSha256: commandDigest("socialGraph", "removeFriend", [
            publicProfileId,
          ]),
          requestId,
        });
        return Object.freeze({
          publicProfileId: result.publicProfileId,
          friendship: "none" as const,
          removed: result.removed,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async listRecommendedCommunities() {
      try {
        const override =
          input.recommendedCommunityIdsOverride === undefined
            ? null
            : await input.recommendedCommunityIdsOverride();
        const items = await input.repository.listVerifiedCommunitiesByIds(
          override ?? input.recommendedCommunityIds,
        );
        return Object.freeze({
          items,
          defaultSelectedIds: Object.freeze(
            items
              .slice(0, recommendedDefaultSelectedCount)
              .map((item) => item.communityId),
          ),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },
  };
  return Object.freeze(service);

  async function primaryHoldings(
    record: PublicProfileRecord,
    wallet: ProfileWalletRecord,
    walletReadService: Pick<WalletReadService, "getBalances">,
    signal: AbortSignal,
  ): Promise<HoldingsResource> {
    let balances;
    try {
      balances = await walletReadService.getBalances({
        principal: { userId: record.targetUserId },
        walletId: wallet.walletId,
        signal,
      });
    } catch (error) {
      if (error instanceof V2ApiError && error.code === "NOT_FOUND") {
        return emptyHoldings(
          "unavailable",
          publicProfileReasonCodes.walletNotBound,
        );
      }
      if (
        error instanceof V2ApiError &&
        (error.code === "CAPABILITY_UNAVAILABLE" ||
          error.code === "PROVIDER_DISCONNECTED")
      ) {
        return emptyHoldings(
          "unavailable",
          publicProfileReasonCodes.chainUnavailable,
        );
      }
      throw error;
    }
    const items: HoldingItem[] = [];
    let total: string | null = "0";
    for (const row of balances.balances) {
      if (row.balance.status !== "available" || row.balance.rawValue === "0") {
        continue;
      }
      const usdValue =
        row.valuation.status === "available" ? row.valuation.valueUsd : null;
      total =
        total === null || usdValue === null
          ? null
          : addDecimalStrings(total, usdValue);
      items.push(
        Object.freeze({
          assetId: row.assetId,
          symbol: row.symbol,
          name: row.name,
          logoUrl: row.logo.status === "available" ? row.logo.url : null,
          balance: row.balance.displayBalance,
          usdValue,
        }),
      );
    }
    return data("available", null, {
      totalUsd: total,
      items: Object.freeze(items),
      observedAt: balances.snapshot.observedAt,
    });
  }

  function noteLaunch2Leg(leg: string, error: unknown): void {
    input.logger?.warn(
      {
        leg,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      "Public profile launch2 leg unavailable",
    );
  }

  function launch2Unavailable(reasonCode: string): ProfileLaunch2Block {
    return Object.freeze({ status: "unavailable" as const, reasonCode });
  }

  function launch2Available(
    sources: ProfileLaunch2Sources,
    checkpoint: string,
    head: bigint | null,
  ): ProfileLaunch2Block {
    return Object.freeze({
      status: "available" as const,
      chainId: sources.chainId,
      indexerBlockNumber: checkpoint,
      headBlockNumber: head === null ? null : head.toString(10),
    });
  }

  function readLaunch2Head(
    sources: ProfileLaunch2Sources,
  ): Promise<bigint | null> {
    try {
      return sources.readHead().catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  /** The launch2 checkpoint, null when never run; throws when unreadable. */
  async function launch2Checkpoint(
    sources: ProfileLaunch2Sources,
  ): Promise<string | null> {
    if (sources.activity === null) {
      return null;
    }
    return sources.activity.getLaunch2Checkpoint(sources.chainId);
  }

  /**
   * Decision 0169: the Launch-chain holdings of `address`. Never throws:
   * every failure is the `launch2` block's reason, the primary leg stands.
   */
  async function launch2Holdings(
    sources: ProfileLaunch2Sources,
    address: string,
  ): Promise<{
    readonly block: ProfileLaunch2Block;
    readonly items: readonly ProfileLaunch2HoldingItem[];
  }> {
    const none = Object.freeze([]) as readonly ProfileLaunch2HoldingItem[];
    if (sources.activity === null || sources.holdings === null) {
      return {
        block: launch2Unavailable(
          profileLaunch2ReasonCodes.repositoryUnavailable,
        ),
        items: none,
      };
    }
    const headPending = readLaunch2Head(sources);
    let checkpoint: string | null;
    try {
      checkpoint = await launch2Checkpoint(sources);
    } catch (error) {
      noteLaunch2Leg("launch2Holdings", error);
      return {
        block: launch2Unavailable(profileLaunch2ReasonCodes.holdingsReadFailed),
        items: none,
      };
    }
    if (checkpoint === null) {
      return {
        block: launch2Unavailable(profileLaunch2ReasonCodes.indexerNotStarted),
        items: none,
      };
    }
    try {
      const holdings = await sources.holdings.listAddressHoldings({ address });
      return {
        block: launch2Available(sources, checkpoint, await headPending),
        items: projectLaunch2Holdings(holdings),
      };
    } catch (error) {
      noteLaunch2Leg("launch2Holdings", error);
      return {
        block: launch2Unavailable(profileLaunch2ReasonCodes.holdingsReadFailed),
        items: none,
      };
    }
  }

  /**
   * Decision 0169 (PROFILE_LAUNCH2_EMIT on): the primary-chain holdings as
   * before, followed by the Launch-chain rows, and the `launch2` block.
   * `status` / `reasonCode` / `totalUsd` / `observedAt` keep describing the
   * primary chain only.
   */
  async function mergedHoldings(
    record: PublicProfileRecord,
    sources: ProfileLaunch2Sources,
    signal: AbortSignal,
  ): Promise<HoldingsResource> {
    let wallet;
    try {
      wallet = await input.repository.getActiveWallet(record.targetUserId);
    } catch (error) {
      return mapFailure(error);
    }
    if (wallet === null) {
      return emptyHoldings(
        "unavailable",
        publicProfileReasonCodes.walletNotBound,
      );
    }
    const launch2Pending = launch2Holdings(sources, wallet.address);
    const primary =
      input.walletReadService === null
        ? emptyHoldings(
            "unavailable",
            publicProfileReasonCodes.walletRuntimeUnavailable,
          )
        : await primaryHoldings(
            record,
            wallet,
            input.walletReadService,
            signal,
          );
    const launch2 = await launch2Pending;
    return Object.freeze({
      ...primary,
      items: Object.freeze([...primary.items, ...launch2.items]),
      launch2: launch2.block,
    });
  }

  function assetLookup(): (id: string) => Promise<AssetRecord | null> {
    const assetCache = new Map<string, AssetRecord | null>();
    return async (id: string): Promise<AssetRecord | null> => {
      if (!assetCache.has(id)) {
        assetCache.set(id, await input.assets.getAsset(id));
      }
      return assetCache.get(id) ?? null;
    };
  }

  async function primaryTrades({
    principal,
    record,
    codec,
    cursor,
    pageLimit,
  }: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly record: PublicProfileRecord;
    readonly codec: V2CursorCodec;
    readonly cursor: string | undefined;
    readonly pageLimit: number;
  }): Promise<TradesResource> {
    const cursorContext = {
      ownerId: principal.userId,
      route: tradesCursorRoute,
      filter: `profile=${record.publicProfileId}`,
    };
    try {
      let before: { blockNumber: string; logIndex: number } | undefined;
      if (cursor !== undefined) {
        const continuation = codec.decode({ ...cursorContext, cursor });
        const blockNumber = continuation["b"];
        const logIndex = continuation["l"];
        if (
          typeof blockNumber !== "string" ||
          !/^[0-9]{1,20}$/.test(blockNumber) ||
          typeof logIndex !== "number" ||
          !Number.isInteger(logIndex) ||
          logIndex < 0
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = { blockNumber, logIndex };
      }
      const wallet = await input.repository.getActiveWallet(
        record.targetUserId,
      );
      if (wallet === null) {
        return emptyTrades(
          "unavailable",
          publicProfileReasonCodes.walletNotBound,
        );
      }
      if (!(await input.repository.hasTransferCheckpoint(input.chainId))) {
        return emptyTrades(
          "unavailable",
          publicProfileReasonCodes.indexerNotStarted,
        );
      }
      const page = await input.repository.listTrades({
        chainId: input.chainId,
        address: wallet.address,
        limit: pageLimit,
        before,
      });
      const lookupAsset = assetLookup();
      const items: TradeItem[] = [];
      for (const row of page.items) {
        const item = await projectTrade(row, lookupAsset);
        if (item !== null) {
          items.push(item);
        }
      }
      const last = page.items.at(-1);
      return data("available", null, {
        items: Object.freeze(items),
        nextCursor:
          page.hasMore && last !== undefined
            ? codec.encode({
                ...cursorContext,
                continuation: { b: last.blockNumber, l: last.logIndex },
              })
            : null,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }

  /**
   * Decision 0169 (PROFILE_LAUNCH2_EMIT on): the primary-chain trades and
   * the owner's launch2 activity on the Launch chain under one Decision 0167
   * cursor, newest first by (time µs, block, log, source, hash). A primary
   * row's time is its block time, else its observation time. `status` /
   * `reasonCode` keep describing the primary chain; the launch2 leg settles
   * on its own in the `launch2` block.
   */
  async function mergedTrades({
    principal,
    record,
    codec,
    cursor,
    pageLimit,
    sources,
  }: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly record: PublicProfileRecord;
    readonly codec: V2CursorCodec;
    readonly cursor: string | undefined;
    readonly pageLimit: number;
    readonly sources: ProfileLaunch2Sources;
  }): Promise<TradesResource> {
    const cursorContext = {
      ownerId: principal.userId,
      route: tradesCursorRoute,
      filter: `profile=${record.publicProfileId};launch2=${sources.chainId}`,
    };
    try {
      let before: WalletActivitySortKey | undefined;
      if (cursor !== undefined) {
        const continuation = codec.decode({ ...cursorContext, cursor });
        const at = continuation["at"];
        const block = continuation["block"];
        const log = continuation["log"];
        const source = continuation["src"];
        const hash = continuation["tx"];
        if (
          typeof at !== "string" ||
          !/^[0-9]{1,20}$/u.test(at) ||
          typeof block !== "string" ||
          !/^[0-9]{1,20}$/u.test(block) ||
          typeof log !== "number" ||
          !Number.isSafeInteger(log) ||
          log < 0 ||
          (source !== "erc20" && source !== "launch2") ||
          typeof hash !== "string" ||
          !/^0x[0-9a-f]{64}$/u.test(hash)
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = {
          atMicros: at,
          blockNumber: block,
          logIndex: log,
          source,
          transactionHash: hash,
        };
      }
      const wallet = await input.repository.getActiveWallet(
        record.targetUserId,
      );
      if (wallet === null) {
        return emptyTrades(
          "unavailable",
          publicProfileReasonCodes.walletNotBound,
        );
      }
      const primaryReady = await input.repository.hasTransferCheckpoint(
        input.chainId,
      );
      const primaryPending = primaryReady
        ? input.repository.listTradesByTime({
            chainId: input.chainId,
            address: wallet.address,
            limit: pageLimit,
            before,
          })
        : Promise.resolve({
            items: Object.freeze<TimedTradeRow[]>([]),
            hasMore: false,
          });
      primaryPending.catch(() => undefined);

      let block: ProfileLaunch2Block;
      let launch2Page: {
        readonly items: readonly WalletLaunch2ActivityRecord[];
        readonly hasMore: boolean;
      } = { items: Object.freeze([]), hasMore: false };
      let launchHead: bigint | null = null;
      const activity = sources.activity;
      if (activity === null) {
        block = launch2Unavailable(
          profileLaunch2ReasonCodes.repositoryUnavailable,
        );
      } else {
        const headPending = readLaunch2Head(sources);
        try {
          const checkpoint = await activity.getLaunch2Checkpoint(
            sources.chainId,
          );
          if (checkpoint === null) {
            block = launch2Unavailable(
              profileLaunch2ReasonCodes.indexerNotStarted,
            );
          } else {
            launch2Page = await activity.listLaunch2Activity({
              chainId: sources.chainId,
              address: wallet.address,
              limit: pageLimit,
              ...(before === undefined ? {} : { before }),
            });
            launchHead = await headPending;
            block = launch2Available(sources, checkpoint, launchHead);
          }
        } catch (error) {
          noteLaunch2Leg("launch2Activity", error);
          launch2Page = { items: Object.freeze([]), hasMore: false };
          block = launch2Unavailable(
            profileLaunch2ReasonCodes.activityReadFailed,
          );
        }
      }
      const primary = await primaryPending;

      type Entry =
        | {
            readonly key: WalletActivitySortKey;
            readonly primary: TimedTradeRow;
          }
        | {
            readonly key: WalletActivitySortKey;
            readonly launch2: WalletLaunch2ActivityRecord;
          };
      const all: Entry[] = [
        ...primary.items.map((row): Entry => ({
          key: {
            atMicros: row.atMicros,
            blockNumber: row.blockNumber,
            logIndex: row.logIndex,
            source: "erc20",
            transactionHash: row.transactionHash,
          },
          primary: row,
        })),
        ...launch2Page.items.map((row): Entry => ({
          key: {
            atMicros: row.atMicros,
            blockNumber: row.blockNumber,
            logIndex: row.logIndex,
            source: "launch2",
            transactionHash: row.transactionHash,
          },
          launch2: row,
        })),
      ];
      all.sort((a, b) => compareSortKeys(b.key, a.key));
      const entries = all.slice(0, pageLimit);
      const hasMore =
        all.length > pageLimit || primary.hasMore || launch2Page.hasMore;
      // The page is strictly older than its cursor (a defensive check: the
      // repositories already filter; this keeps a merge bug from looping).
      if (
        before !== undefined &&
        entries.some((entry) => compareSortKeys(entry.key, before) >= 0)
      ) {
        throw V2ApiError.capabilityUnavailable();
      }

      const lookupAsset = assetLookup();
      const items: (TradeItem | ProfileLaunch2TradeItem)[] = [];
      for (const entry of entries) {
        if ("primary" in entry) {
          const item = await projectTrade(entry.primary, lookupAsset);
          if (item !== null) {
            items.push(item);
          }
        } else {
          items.push(projectLaunch2ActivityItem(entry.launch2, launchHead));
        }
      }
      const last = entries.at(-1)?.key;
      return data(
        primaryReady ? "available" : "unavailable",
        primaryReady ? null : publicProfileReasonCodes.indexerNotStarted,
        {
          items: Object.freeze(items),
          nextCursor:
            hasMore && last !== undefined
              ? codec.encode({
                  ...cursorContext,
                  continuation: {
                    at: last.atMicros,
                    block: last.blockNumber,
                    log: last.logIndex,
                    src: last.source,
                    tx: last.transactionHash,
                  },
                })
              : null,
          launch2: block,
        },
      );
    } catch (error) {
      return mapFailure(error);
    }
  }

  async function projectTrade(
    row: TradeRow,
    lookupAsset: (id: string) => Promise<AssetRecord | null>,
  ): Promise<TradeItem | null> {
    const common = {
      eventId: tradeEventId(input.chainId, row.transactionHash, row.logIndex),
      blockTimestamp: row.blockTimestamp,
      blockNumber: row.blockNumber,
      txHash: row.transactionHash,
    };
    if (row.source === "transfer") {
      const asset = await lookupAsset(row.assetId);
      if (asset === null) {
        return null;
      }
      const amount = formatDecimalAmount(BigInt(row.rawValue), asset.decimals);
      return Object.freeze({
        ...common,
        kind: row.direction === "in" ? "transfer_in" : "transfer_out",
        assetId: asset.assetId,
        symbol: asset.symbol,
        amount,
        usdValue: stableAssetIds.has(asset.assetId) ? amount : null,
      });
    }
    const swap = classifySwap(row, quoteAssetIds);
    const [base, quote] = await Promise.all([
      lookupAsset(swap.baseAssetId),
      lookupAsset(swap.quoteAssetId),
    ]);
    if (base === null) {
      return null;
    }
    return Object.freeze({
      ...common,
      kind: swap.kind,
      assetId: base.assetId,
      symbol: base.symbol,
      amount: formatDecimalAmount(
        absoluteAmount(swap.baseAmountRaw),
        base.decimals,
      ),
      usdValue:
        quote !== null && stableAssetIds.has(quote.assetId)
          ? formatDecimalAmount(
              absoluteAmount(swap.quoteAmountRaw),
              quote.decimals,
            )
          : null,
    });
  }
}
