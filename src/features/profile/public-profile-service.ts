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
import type { WalletReadService } from "../wallet/wallet-read-service.js";
import {
  PublicProfileIdempotencyConflictError,
  PublicProfileRepositoryUnavailableError,
  PublicProfileTargetNotFoundError,
  type FriendshipState,
  type PublicProfileLookup,
  type PublicProfileRecord,
  type PublicProfileRepository,
  type RecommendedCommunityRecord,
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
  readonly items: readonly HoldingItem[];
  readonly observedAt: string | null;
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
  readonly items: readonly TradeItem[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

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

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return profileTradeLimits.default;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]{1,3}$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > profileTradeLimits.maximum
  ) {
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
      let balances;
      try {
        balances = await input.walletReadService.getBalances({
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
        if (
          row.balance.status !== "available" ||
          row.balance.rawValue === "0"
        ) {
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
        const assetCache = new Map<string, AssetRecord | null>();
        const lookupAsset = async (id: string): Promise<AssetRecord | null> => {
          if (!assetCache.has(id)) {
            assetCache.set(id, await input.assets.getAsset(id));
          }
          return assetCache.get(id) ?? null;
        };
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
