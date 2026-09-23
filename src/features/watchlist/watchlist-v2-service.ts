import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type { ChainRegistryRepository } from "../../database/chain-registry-repository.js";
import {
  WatchlistV2UnavailableError,
  WatchlistV2VersionConflictError,
  watchlistV2GroupKeyPatternSource,
  watchlistV2MaximumGroups,
  watchlistV2MaximumItems,
  type WatchlistV2Group,
  type WatchlistV2Repository,
  type WatchlistV2Snapshot,
} from "../../database/watchlist-v2-repository.js";
import { isAssetId, type AssetStatus } from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  projectTokenLogoForAssetId,
  type TokenLogoProjection,
} from "../market/token-logo.js";

/**
 * V2 Watchlist policy (D13, Decision 0033).
 *
 * A watchlist entry is a user preference, never a market fact: it says nothing
 * about price, liquidity, or tradability. Every written `assetId` must already
 * be a readable Asset Registry row, so the list can never point at an asset
 * LOOP cannot describe.
 */

export const watchlistV2MaximumNameCodePoints = 40;
export const watchlistV2ReasonCodes = Object.freeze({
  assetNotReadable: "ASSET_NOT_READABLE",
} as const);

const groupKeyPattern = new RegExp(watchlistV2GroupKeyPatternSource);
const forbiddenNameCodePoints = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export interface WatchlistAssetProjection {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly status: AssetStatus;
}

export interface WatchlistItemProjection {
  readonly assetId: string;
  readonly asset: WatchlistAssetProjection | null;
  /** Display picture of the asset (Decision 0072); never an identifier. */
  readonly logo: TokenLogoProjection;
  readonly reasonCode: string | null;
}

export interface WatchlistGroupProjection {
  readonly key: string;
  readonly name: string;
  readonly items: readonly WatchlistItemProjection[];
}

export interface WatchlistResource {
  readonly version: number;
  readonly updatedAt: string | null;
  readonly groups: readonly WatchlistGroupProjection[];
  readonly contractVersion: typeof v2ContractVersion;
}

export interface WatchlistV2Service {
  get(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<WatchlistResource>;
  replace(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
  }): Promise<WatchlistResource>;
}

export interface CreateWatchlistV2ServiceInput {
  readonly repository: WatchlistV2Repository;
  readonly registry: ChainRegistryRepository;
  readonly chainId: string;
}

interface ParsedReplaceRequest {
  readonly expectedVersion: number;
  readonly groups: readonly WatchlistV2Group[];
}

function isValidName(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) {
    return false;
  }
  const length = Array.from(value).length;
  return (
    length >= 1 &&
    length <= watchlistV2MaximumNameCodePoints &&
    !forbiddenNameCodePoints.test(value)
  );
}

function parseReplaceRequest(body: unknown): ParsedReplaceRequest {
  if (typeof body !== "object" || body === null) {
    throw V2ApiError.invalidRequest();
  }
  const request = body as {
    readonly expectedVersion?: unknown;
    readonly groups?: unknown;
  };
  const expectedVersion = request.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    throw V2ApiError.invalidRequest();
  }
  if (
    !Array.isArray(request.groups) ||
    request.groups.length > watchlistV2MaximumGroups
  ) {
    throw V2ApiError.invalidRequest();
  }

  const groups: WatchlistV2Group[] = [];
  const groupKeys = new Set<string>();
  let itemCount = 0;
  for (const rawGroup of request.groups as readonly unknown[]) {
    if (typeof rawGroup !== "object" || rawGroup === null) {
      throw V2ApiError.invalidRequest();
    }
    const group = rawGroup as {
      readonly key?: unknown;
      readonly name?: unknown;
      readonly items?: unknown;
    };
    if (
      typeof group.key !== "string" ||
      !groupKeyPattern.test(group.key) ||
      groupKeys.has(group.key) ||
      !isValidName(group.name) ||
      !Array.isArray(group.items)
    ) {
      throw V2ApiError.invalidRequest();
    }
    groupKeys.add(group.key);

    const items: { readonly assetId: string }[] = [];
    const assetIds = new Set<string>();
    for (const rawItem of group.items as readonly unknown[]) {
      if (typeof rawItem !== "object" || rawItem === null) {
        throw V2ApiError.invalidRequest();
      }
      const assetId = (rawItem as { readonly assetId?: unknown }).assetId;
      if (!isAssetId(assetId) || assetIds.has(assetId)) {
        throw V2ApiError.invalidRequest();
      }
      assetIds.add(assetId);
      items.push(Object.freeze({ assetId }));
      itemCount += 1;
    }
    groups.push(
      Object.freeze({
        key: group.key,
        name: group.name,
        items: Object.freeze(items),
      }),
    );
  }
  if (itemCount > watchlistV2MaximumItems) {
    throw V2ApiError.invalidRequest();
  }
  return Object.freeze({ expectedVersion, groups: Object.freeze(groups) });
}

export function createWatchlistV2Service(
  input: CreateWatchlistV2ServiceInput,
): WatchlistV2Service {
  async function project(
    snapshot: WatchlistV2Snapshot,
  ): Promise<WatchlistResource> {
    const assetIds = [
      ...new Set(
        snapshot.groups.flatMap((group) =>
          group.items.map((item) => item.assetId),
        ),
      ),
    ];
    const records = await input.registry.listAssets(assetIds);
    return Object.freeze({
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
      groups: Object.freeze(
        snapshot.groups.map((group) =>
          Object.freeze({
            key: group.key,
            name: group.name,
            items: Object.freeze(
              group.items.map((item) => {
                const record = records.find(
                  (candidate) => candidate.assetId === item.assetId,
                );
                if (record === undefined || record.status === "blocked") {
                  return Object.freeze({
                    assetId: item.assetId,
                    asset: null,
                    logo: projectTokenLogoForAssetId(item.assetId),
                    reasonCode: watchlistV2ReasonCodes.assetNotReadable,
                  });
                }
                return Object.freeze({
                  assetId: item.assetId,
                  logo: projectTokenLogoForAssetId(item.assetId),
                  asset: Object.freeze({
                    symbol: record.symbol,
                    name: record.name,
                    decimals: record.decimals,
                    status: record.status,
                  }),
                  reasonCode: null,
                });
              }),
            ),
          }),
        ),
      ),
      contractVersion: v2ContractVersion,
    });
  }

  return Object.freeze({
    async get({
      principal,
    }: {
      readonly principal: AuthenticatedLoopPrincipal;
    }): Promise<WatchlistResource> {
      try {
        return await project(await input.repository.get(principal.userId));
      } catch (error) {
        if (error instanceof WatchlistV2UnavailableError) {
          throw V2ApiError.capabilityUnavailable();
        }
        throw error;
      }
    },

    async replace({
      principal,
      body,
    }: {
      readonly principal: AuthenticatedLoopPrincipal;
      readonly body: unknown;
    }): Promise<WatchlistResource> {
      const request = parseReplaceRequest(body);
      const assetIds = [
        ...new Set(
          request.groups.flatMap((group) =>
            group.items.map((item) => item.assetId),
          ),
        ),
      ];
      if (assetIds.length > 0) {
        const records = await input.registry.listAssets(assetIds);
        const readable = new Set(
          records
            .filter(
              (record) =>
                record.status !== "blocked" && record.chainId === input.chainId,
            )
            .map((record) => record.assetId),
        );
        if (assetIds.some((assetId) => !readable.has(assetId))) {
          throw V2ApiError.fromCode("VALIDATION_FAILED");
        }
      }

      try {
        const snapshot = await input.repository.replace({
          ownerUserId: principal.userId,
          expectedVersion: request.expectedVersion,
          groups: request.groups,
        });
        return await project(snapshot);
      } catch (error) {
        if (error instanceof WatchlistV2VersionConflictError) {
          throw V2ApiError.versionConflict();
        }
        if (error instanceof WatchlistV2UnavailableError) {
          throw V2ApiError.capabilityUnavailable();
        }
        throw error;
      }
    },
  });
}
