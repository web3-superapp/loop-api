import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  AliasDirectoryRepositoryUnavailableError,
  type AliasDirectoryRepository,
} from "../../database/alias-directory-repository.js";
import {
  aliasSearchLimits,
  parseAliasSearchLimit,
  parseAliasSearchPrefix,
  type PublicAliasSearchResource,
} from "./alias-contract.js";
import { parseAliasPrincipal } from "./alias-principal.js";
import {
  AliasSearchQuotaUnavailableError,
  type AliasSearchQuota,
} from "./alias-search-quota.js";

export interface PublicAliasSearchInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly aliasPrefix: unknown;
  readonly limit: unknown;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

export interface PublicAliasSearchService {
  search(input: PublicAliasSearchInput): Promise<PublicAliasSearchResource>;
}

export class InvalidPublicAliasSearchRequestError extends Error {
  constructor() {
    super("The public alias search request is invalid");
    this.name = "InvalidPublicAliasSearchRequestError";
  }
}

export class PublicAliasSearchUnavailableError extends Error {
  constructor() {
    super("Public alias search is unavailable");
    this.name = "PublicAliasSearchUnavailableError";
  }
}

export function createUnavailablePublicAliasSearchService(): PublicAliasSearchService {
  return Object.freeze({
    search: () => Promise.reject(new PublicAliasSearchUnavailableError()),
  });
}

export function createPublicAliasSearchService(input: {
  readonly repository: AliasDirectoryRepository;
  readonly quota: AliasSearchQuota;
}): PublicAliasSearchService {
  return Object.freeze({
    async search(
      request: PublicAliasSearchInput,
    ): Promise<PublicAliasSearchResource> {
      let principal: AuthenticatedLoopPrincipal;
      let aliasPrefix: string;
      let limit: number;
      try {
        principal = parseAliasPrincipal(request.principal);
        aliasPrefix = parseAliasSearchPrefix(request.aliasPrefix);
        limit = parseAliasSearchLimit(request.limit);
      } catch {
        throw new InvalidPublicAliasSearchRequestError();
      }

      try {
        await input.quota.consume({
          scope: "public",
          userId: principal.userId,
          canonicalClientIp: request.canonicalClientIp,
          signal: request.signal,
        });
        const records = await input.repository.searchPublicAliases({
          requesterUserId: principal.userId,
          aliasPrefix,
          limit: Math.min(limit + 1, aliasSearchLimits.maximum + 1),
        });
        request.signal.throwIfAborted();
        const truncated = records.length > limit;
        const items = records.slice(0, limit).map((record) =>
          Object.freeze({
            public_profile_id: record.publicProfileId,
            profile_code: record.profileCode,
            alias: record.alias,
            avatar_ref: record.avatarRef,
          }),
        );
        return Object.freeze({ items: Object.freeze(items), truncated });
      } catch (error) {
        if (error instanceof AliasSearchQuotaUnavailableError) {
          throw new PublicAliasSearchUnavailableError();
        }
        if (error instanceof AliasDirectoryRepositoryUnavailableError) {
          throw new PublicAliasSearchUnavailableError();
        }
        throw error;
      }
    },
  });
}
