import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
  type V2CursorContinuation,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { generateOpaqueId } from "../../core/ids/opaque-id.js";
import { parseAliasSearchPrefix } from "../identity/alias-contract.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  AliasSearchQuotaUnavailableError,
  AliasSearchRateLimitedError,
  type AliasSearchQuota,
} from "../identity/alias-search-quota.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import type { AliasPolicy } from "../profile/alias-policy.js";
import {
  blocksFilter,
  commandDigest,
  communityCursorRoutes,
  communityDiscoverFilter,
  communityHomeDiscoverLimit,
  communityHomeJoinedLimit,
  communityListLimits,
  communityMembersFilter,
  communityRecommendationRuleVersion,
  connectionsFilter,
  freezeIdentity,
  InvalidCommunityRequestError,
  messageRequestsFilter,
  parseBlockRequest,
  parseCreateCommunityRequest,
  parseEnumValue,
  parseListLimit,
  parseMessageRequestDecision,
  parseOpaqueUuid,
  parseRoleChangeRequest,
  parseUpdateCommunityRequest,
  searchFilter,
  updateCommunityDigestParts,
  searchResultLimits,
  unavailable,
  unavailableSearchDomains,
  communityUnavailableReasonCodes,
  type BlockKind,
  type CommunityMembershipFilter,
  type CommunitySort,
  type CommunitySummary,
  type CommunityVerificationFilter,
  type ConnectionDirection,
  type IdentityProjection,
  type MemberRoleFilter,
  type MessageRequestDecision,
  type SearchDomain,
  type SearchResultType,
  type UnavailableProjection,
} from "./community-contract.js";
import {
  communityRoleRank,
  viewerPermissions,
  type CommunityRole,
  type CommunityTargetAction,
  type CommunityViewerPermissions,
} from "./community-policy.js";
import {
  CommunityDataStaleError,
  CommunityIdempotencyConflictError,
  CommunityNotFoundError,
  CommunityPermissionDeniedError,
  CommunityProfileRequiredError,
  CommunityRepositoryUnavailableError,
  CommunitySlugTakenError,
  CommunityTargetUnavailableError,
  type CommunityDetailRecord,
  type CommunityMemberRecord,
  type CommunityRecord,
  type CommunityRepository,
  type MembershipRecord,
} from "./community-repository.js";
import {
  referralRulesV1,
  type ReferralRulesProjection,
} from "./referral-rules.js";

/**
 * V2 community, social-graph, and search application service
 * (Decision 0031). It owns request validation, the permission-matrix
 * lookups, cursor binding, and the fail-closed projection of every
 * `unavailable` fact. No number here is ever synthesized: a missing fact is
 * `unavailable`, never zero and never a fixture.
 */

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const principalSchema = z
  .object({
    userId: z.string().regex(canonicalUuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    streamUserId: z.string().min(1).max(63),
  })
  .strict();

export interface ViewerInput {
  readonly principal: AuthenticatedLoopPrincipal;
}

export interface ListInput extends ViewerInput {
  readonly cursor: unknown;
  readonly limit: unknown;
}

export interface CommandInput extends ViewerInput {
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface CreateCommunityInput extends CommandInput {
  readonly body: unknown;
}

export interface CommunityIdInput extends ViewerInput {
  readonly communityId: unknown;
}

export interface CommunityCommandInput extends CommandInput {
  readonly communityId: unknown;
}

export interface ListCommunitiesInput extends ListInput {
  readonly sort: unknown;
  readonly verification: unknown;
  readonly membership: unknown;
}

export interface UpdateCommunityInput extends CommunityCommandInput {
  readonly body: unknown;
}

export interface ListMembersInput extends ListInput {
  readonly communityId: unknown;
  readonly role: unknown;
}

export interface GovernMemberInput extends CommunityCommandInput {
  readonly targetPublicProfileId: unknown;
  readonly action: "role" | "mute" | "unmute" | "ban" | "unban";
  readonly body: unknown;
}

export interface FollowInput extends CommandInput {
  readonly targetPublicProfileId: unknown;
}

export interface ListConnectionsInput extends ListInput {
  readonly direction: unknown;
}

export interface ListBlocksInput extends ListInput {
  readonly kind: unknown;
}

export interface BlockCommandInput extends CommandInput {
  readonly body: unknown;
}

export interface DecideMessageRequestInput extends CommandInput {
  readonly messageRequestId: unknown;
  readonly body: unknown;
}

export interface SearchInput extends ListInput {
  readonly domain: unknown;
  readonly q: unknown;
  readonly verification: unknown;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

export interface ViewerProjection extends CommunityViewerPermissions {
  readonly membership: MembershipRecord | null;
}

export interface CommunityResource {
  readonly community: CommunitySummary;
  readonly viewer: ViewerProjection;
  readonly miningPower: UnavailableProjection;
  readonly onlineCount: UnavailableProjection;
  readonly announcements: UnavailableProjection;
  readonly officialLinks: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface CommunityRecommendationProjection {
  readonly recommendationId: string;
  readonly ruleVersion: typeof communityRecommendationRuleVersion;
}

export interface CommunityListResource {
  readonly items: readonly CommunitySummary[];
  readonly nextCursor: string | null;
  readonly recommendation: CommunityRecommendationProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface JoinedCommunityProjection {
  readonly community: CommunitySummary;
  readonly membership: MembershipRecord;
}

export interface JoinedCommunitiesProjection {
  readonly items: readonly JoinedCommunityProjection[];
  /**
   * True when the account has joined more communities than the home page
   * carries; the client continues with
   * `GET /v2/communities?membership=joined`.
   */
  readonly truncated: boolean;
}

export interface CommunityHomeResource {
  readonly joined: JoinedCommunitiesProjection;
  readonly discover: readonly CommunitySummary[];
  readonly unread: UnavailableProjection;
  readonly liveVoice: UnavailableProjection;
  readonly freshness: {
    readonly observedAt: string;
    readonly source: "database";
  };
  readonly recommendation: CommunityRecommendationProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface CommunityMemberIdentityProjection {
  /** Null only when the membership has no `user_profiles` row; not targetable. */
  readonly publicProfileId: string | null;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
}

export interface CommunityMemberProjection {
  readonly profile: CommunityMemberIdentityProjection;
  readonly role: CommunityRole;
  readonly status: MembershipRecord["status"];
  readonly joinedAt: string;
  readonly isSelf: boolean;
  readonly miningPower: UnavailableProjection;
}

export interface CommunityMemberListResource {
  readonly community: CommunitySummary;
  readonly viewer: ViewerProjection;
  readonly counts: {
    readonly all: number;
    readonly owner: number;
    readonly admin: number;
    readonly online: UnavailableProjection;
  };
  readonly items: readonly CommunityMemberProjection[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ConnectionProjection {
  readonly profile: IdentityProjection;
  readonly createdAt: string;
  readonly viewerFollows: boolean;
  readonly miningPower: UnavailableProjection;
}

export interface ConnectionListResource {
  readonly direction: ConnectionDirection;
  readonly items: readonly ConnectionProjection[];
  readonly counts: {
    readonly following: number;
    readonly followers: number;
  };
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface FollowResource {
  readonly profile: IdentityProjection;
  readonly viewerFollows: boolean;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface BlockProjection {
  readonly kind: BlockKind;
  readonly stableId: string;
  readonly profile: IdentityProjection | null;
  readonly reasonCode: string;
  readonly createdAt: string;
}

export interface BlockListResource {
  readonly kind: BlockKind;
  readonly items: readonly BlockProjection[];
  readonly counts: { readonly user: number };
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface BlockResource {
  readonly block: BlockProjection | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MessageRequestProjection {
  readonly messageRequestId: string;
  readonly profile: IdentityProjection;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly preview: UnavailableProjection;
  readonly aiModeration: UnavailableProjection;
}

export interface MessageRequestListResource {
  readonly items: readonly MessageRequestProjection[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MessageRequestDecisionResource {
  readonly messageRequestId: string;
  readonly decision: MessageRequestDecision;
  readonly blocked: boolean;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface SearchDisplaySnapshot {
  readonly title: string;
  readonly subtitle: string | null;
  readonly avatarRef: string | null;
  readonly memberCount: number | null;
  readonly verificationStatus: CommunitySummary["verificationStatus"] | null;
}

export interface SearchResultProjection {
  readonly resultType: SearchResultType;
  readonly stableId: string;
  readonly displaySnapshot: SearchDisplaySnapshot;
  readonly destination: {
    readonly kind: "publicProfile" | "communityProfile";
  };
}

export interface SearchResource {
  readonly domain: SearchDomain;
  readonly status: "available" | "unavailable";
  readonly reasonCode: string | null;
  readonly results: readonly SearchResultProjection[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface CommunityService {
  getHome(input: ViewerInput): Promise<CommunityHomeResource>;
  listCommunities(input: ListCommunitiesInput): Promise<CommunityListResource>;
  createCommunity(input: CreateCommunityInput): Promise<CommunityResource>;
  updateCommunity(input: UpdateCommunityInput): Promise<CommunityResource>;
  getCommunity(input: CommunityIdInput): Promise<CommunityResource>;
  joinCommunity(input: CommunityCommandInput): Promise<CommunityResource>;
  leaveCommunity(input: CommunityCommandInput): Promise<CommunityResource>;
  listMembers(input: ListMembersInput): Promise<CommunityMemberListResource>;
  governMember(input: GovernMemberInput): Promise<CommunityMemberListResource>;
  follow(input: FollowInput): Promise<FollowResource>;
  unfollow(input: FollowInput): Promise<FollowResource>;
  listConnections(input: ListConnectionsInput): Promise<ConnectionListResource>;
  listBlocks(input: ListBlocksInput): Promise<BlockListResource>;
  block(input: BlockCommandInput): Promise<BlockResource>;
  unblock(input: BlockCommandInput): Promise<BlockResource>;
  listMessageRequests(input: ListInput): Promise<MessageRequestListResource>;
  decideMessageRequest(
    input: DecideMessageRequestInput,
  ): Promise<MessageRequestDecisionResource>;
  search(input: SearchInput): Promise<SearchResource>;
  referralRules(): ReferralRulesProjection;
}

function assertPrincipal(
  principal: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(principal);
  if (!parsed.success) {
    throw V2ApiError.invalidRequest();
  }
  let expected: string;
  try {
    expected = deriveStreamUserId(parsed.data.userId);
  } catch {
    throw V2ApiError.invalidRequest();
  }
  if (parsed.data.streamUserId !== expected) {
    throw V2ApiError.invalidRequest();
  }
  return parsed.data;
}

function mapFailure(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof InvalidCommunityRequestError) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  if (error instanceof InvalidV2CursorError) {
    throw V2ApiError.invalidRequest();
  }
  if (error instanceof CommunityNotFoundError) {
    throw V2ApiError.notFound();
  }
  if (error instanceof CommunityTargetUnavailableError) {
    throw V2ApiError.notFound();
  }
  if (error instanceof CommunityPermissionDeniedError) {
    throw V2ApiError.fromCode("PERMISSION_DENIED");
  }
  if (error instanceof CommunityProfileRequiredError) {
    throw V2ApiError.fromCode("PROFILE_ACTIVATION_REQUIRED");
  }
  if (error instanceof CommunityDataStaleError) {
    throw V2ApiError.fromCode("DATA_STALE");
  }
  if (error instanceof CommunitySlugTakenError) {
    throw V2ApiError.fromCode("RESOURCE_CONFLICT");
  }
  if (error instanceof CommunityIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof CommunityRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  if (error instanceof AliasSearchRateLimitedError) {
    throw V2ApiError.rateLimited();
  }
  if (error instanceof AliasSearchQuotaUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

function summary(record: CommunityRecord): CommunitySummary {
  return Object.freeze({
    communityId: record.communityId,
    name: record.name,
    slug: record.slug,
    description: record.description,
    logoRef: record.logoRef,
    verificationStatus: record.verificationStatus,
    boundAssetKey: record.boundAssetKey,
    memberCount: record.memberCount,
    createdAt: record.createdAt,
    configVersion: "communityV1",
  });
}

/**
 * Member-directory identity. A membership without a profile row keeps its
 * LOOP ID (always present on the account) and reports a null public profile
 * ID, so the page and the server counts stay consistent.
 */
function memberIdentity(
  record: CommunityMemberRecord["profile"],
): CommunityMemberIdentityProjection {
  if (record.publicProfileId === null) {
    return Object.freeze({
      publicProfileId: null,
      loopId: record.loopId,
      alias: null,
      avatarRef: null,
    });
  }
  return freezeIdentity({
    publicProfileId: record.publicProfileId,
    loopId: record.loopId,
    alias: record.alias,
    avatarRef: record.avatarRef,
  });
}

function membership(record: MembershipRecord | null): MembershipRecord | null {
  return record === null
    ? null
    : Object.freeze({
        role: record.role,
        status: record.status,
        joinedAt: record.joinedAt,
      });
}

function viewerProjection(record: MembershipRecord | null): ViewerProjection {
  return Object.freeze({
    membership: membership(record),
    ...viewerPermissions(record),
  });
}

function recommendation(): CommunityRecommendationProjection {
  return Object.freeze({
    recommendationId: generateOpaqueId(),
    ruleVersion: communityRecommendationRuleVersion,
  });
}

function communityResource(record: CommunityDetailRecord): CommunityResource {
  return Object.freeze({
    community: summary(record.community),
    viewer: viewerProjection(record.viewerMembership),
    miningPower: unavailable(communityUnavailableReasonCodes.mining),
    onlineCount: unavailable(communityUnavailableReasonCodes.presence),
    announcements: unavailable(communityUnavailableReasonCodes.announcements),
    officialLinks: unavailable(communityUnavailableReasonCodes.officialLinks),
    contractVersion: v2ContractVersion,
  });
}

interface PageRequest {
  readonly limit: number;
  readonly continuation: V2CursorContinuation | null;
}

export interface CommunityServiceOptions {
  readonly repository: CommunityRepository;
  readonly cursorCodec: V2CursorCodec | null;
  readonly searchQuota: AliasSearchQuota;
  readonly aliasPolicy: AliasPolicy;
}

export function createCommunityService(
  options: CommunityServiceOptions,
): CommunityService {
  function codec(): V2CursorCodec {
    if (options.cursorCodec === null) {
      throw V2ApiError.capabilityUnavailable();
    }
    return options.cursorCodec;
  }

  /**
   * A cursor carries the page size, so `limit` and `cursor` are mutually
   * exclusive: passing both would let a caller widen a page bound into a
   * cursor that was signed for another size.
   */
  function page(
    ownerUserId: string,
    route: string,
    filter: string,
    cursor: unknown,
    limit: unknown,
    limits: { readonly default: number; readonly maximum: number },
  ): PageRequest {
    if (cursor === undefined) {
      return { limit: parseListLimit(limit, limits), continuation: null };
    }
    if (limit !== undefined || typeof cursor !== "string") {
      throw V2ApiError.invalidRequest();
    }
    const continuation = codec().decode({
      ownerId: ownerUserId,
      route,
      filter,
      cursor,
    });
    const decodedLimit = continuation["limit"];
    if (
      typeof decodedLimit !== "number" ||
      decodedLimit < 1 ||
      decodedLimit > limits.maximum
    ) {
      throw V2ApiError.invalidRequest();
    }
    return { limit: decodedLimit, continuation };
  }

  function nextCursor(
    hasMore: boolean,
    ownerUserId: string,
    route: string,
    filter: string,
    continuation: V2CursorContinuation,
  ): string | null {
    return hasMore
      ? codec().encode({ ownerId: ownerUserId, route, filter, continuation })
      : null;
  }

  function readString(
    continuation: V2CursorContinuation | null,
    key: string,
  ): string | undefined {
    const value = continuation?.[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw V2ApiError.invalidRequest();
    }
    return value;
  }

  function readNumber(
    continuation: V2CursorContinuation | null,
    key: string,
  ): number | undefined {
    const value = continuation?.[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "number") {
      throw V2ApiError.invalidRequest();
    }
    return value;
  }

  function assertCommunityNameAllowed(name: string): void {
    const verdict = options.aliasPolicy.evaluate(name);
    if (verdict.status === "reserved") {
      throw V2ApiError.fromCode("ALIAS_RESERVED");
    }
    if (verdict.status === "blocked") {
      throw V2ApiError.fromCode("ALIAS_BLOCKED");
    }
  }

  async function memberPage(
    ownerUserId: string,
    communityId: string,
    rawRole: unknown,
    cursor: unknown,
    limit: unknown,
  ): Promise<CommunityMemberListResource> {
    const role = parseEnumValue<MemberRoleFilter>(
      rawRole,
      ["all", "owner", "admin"],
      "all",
    );
    const filter = communityMembersFilter(communityId, role);
    const request = page(
      ownerUserId,
      communityCursorRoutes.members,
      filter,
      cursor,
      limit,
      communityListLimits,
    );
    const lastRoleRank = readNumber(request.continuation, "roleRank");
    const lastJoinedAt = readString(request.continuation, "joinedAt");
    const lastMembershipId = readString(request.continuation, "membershipId");
    const record = await options.repository.listMembers({
      viewerUserId: ownerUserId,
      communityId,
      role,
      limit: request.limit + 1,
      ...(lastRoleRank === undefined ||
      lastJoinedAt === undefined ||
      lastMembershipId === undefined
        ? {}
        : { after: { lastRoleRank, lastJoinedAt, lastMembershipId } }),
    });
    const hasMore = record.items.length > request.limit;
    const items = record.items.slice(0, request.limit);
    const last = items.at(-1);
    return Object.freeze({
      community: summary(record.community),
      viewer: viewerProjection(record.viewerMembership),
      counts: Object.freeze({
        all: record.counts.all,
        owner: record.counts.owner,
        admin: record.counts.admin,
        online: unavailable(communityUnavailableReasonCodes.presence),
      }),
      items: Object.freeze(
        items.map((item) =>
          Object.freeze({
            profile: memberIdentity(item.profile),
            role: item.role,
            status: item.status,
            joinedAt: item.joinedAt,
            isSelf:
              item.profile.publicProfileId !== null &&
              item.profile.publicProfileId === record.viewerPublicProfileId,
            miningPower: unavailable(
              communityUnavailableReasonCodes.miningPower,
            ),
          }),
        ),
      ),
      nextCursor:
        last === undefined
          ? null
          : nextCursor(
              hasMore,
              ownerUserId,
              communityCursorRoutes.members,
              filter,
              Object.freeze({
                joinedAt: last.joinedAt,
                limit: request.limit,
                membershipId: last.membershipId,
                roleRank: communityRoleRank[last.role],
              }),
            ),
      contractVersion: v2ContractVersion,
    });
  }

  const service: CommunityService = {
    async getHome(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const record = await options.repository.getCommunityHome({
          viewerUserId: owner.userId,
          joinedLimit: communityHomeJoinedLimit,
          discoverLimit: communityHomeDiscoverLimit,
        });
        return Object.freeze({
          joined: Object.freeze({
            items: Object.freeze(
              record.joined.flatMap((entry) => {
                const current = membership(entry.viewerMembership);
                return current === null
                  ? []
                  : [
                      Object.freeze({
                        community: summary(entry.community),
                        membership: current,
                      }),
                    ];
              }),
            ),
            truncated: record.joinedTruncated,
          }),
          discover: Object.freeze(record.discover.map(summary)),
          unread: unavailable(communityUnavailableReasonCodes.unread),
          liveVoice: unavailable(communityUnavailableReasonCodes.liveVoice),
          freshness: Object.freeze({
            observedAt: record.observedAt,
            source: "database" as const,
          }),
          recommendation: recommendation(),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async listCommunities(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const sort = parseEnumValue<CommunitySort>(
          input.sort,
          ["members", "newest"],
          "members",
        );
        const verification = parseEnumValue<CommunityVerificationFilter>(
          input.verification,
          ["verified", "all"],
          "verified",
        );
        const membershipFilter = parseEnumValue<CommunityMembershipFilter>(
          input.membership,
          ["all", "joined"],
          "all",
        );
        const filter = communityDiscoverFilter(
          sort,
          verification,
          membershipFilter,
        );
        const request = page(
          owner.userId,
          communityCursorRoutes.communities,
          filter,
          input.cursor,
          input.limit,
          communityListLimits,
        );
        const lastSortValue = readString(request.continuation, "sortValue");
        const lastCommunityId = readString(request.continuation, "communityId");
        const records = await options.repository.listCommunities({
          viewerUserId: owner.userId,
          sort,
          verification,
          membership: membershipFilter,
          limit: request.limit + 1,
          ...(lastSortValue === undefined || lastCommunityId === undefined
            ? {}
            : { after: { lastSortValue, lastCommunityId } }),
        });
        const hasMore = records.length > request.limit;
        const items = records.slice(0, request.limit);
        const last = items.at(-1);
        return Object.freeze({
          items: Object.freeze(items.map(summary)),
          nextCursor:
            last === undefined
              ? null
              : nextCursor(
                  hasMore,
                  owner.userId,
                  communityCursorRoutes.communities,
                  filter,
                  Object.freeze({
                    communityId: last.communityId,
                    limit: request.limit,
                    sortValue:
                      sort === "members"
                        ? String(last.memberCount)
                        : last.createdAt,
                  }),
                ),
          recommendation: recommendation(),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async createCommunity(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const values = parseCreateCommunityRequest(input.body);
        assertCommunityNameAllowed(values.name);
        const record = await options.repository.createCommunity({
          ownerUserId: owner.userId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: commandDigest("community", "createCommunity", [
            values.name,
            values.slug,
            values.description ?? "",
            values.logoRef ?? "",
            values.boundAssetKey ?? "",
          ]),
          requestId: input.requestId,
          name: values.name,
          slug: values.slug,
          description: values.description,
          logoRef: values.logoRef,
          boundAssetKey: values.boundAssetKey,
        });
        return communityResource(record);
      } catch (error) {
        return mapFailure(error);
      }
    },

    async updateCommunity(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const communityId = parseOpaqueUuid(input.communityId);
        const values = parseUpdateCommunityRequest(input.body);
        if (values.name !== undefined) {
          assertCommunityNameAllowed(values.name);
        }
        return communityResource(
          await options.repository.updateCommunity({
            ownerUserId: owner.userId,
            communityId,
            idempotencyKey: input.idempotencyKey,
            requestSha256: commandDigest("community", "updateCommunity", [
              communityId,
              ...updateCommunityDigestParts(values),
            ]),
            requestId: input.requestId,
            values,
          }),
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async getCommunity(input) {
      const owner = assertPrincipal(input.principal);
      try {
        return communityResource(
          await options.repository.getCommunity({
            viewerUserId: owner.userId,
            communityId: parseOpaqueUuid(input.communityId),
          }),
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async joinCommunity(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const communityId = parseOpaqueUuid(input.communityId);
        return communityResource(
          await options.repository.joinCommunity({
            ownerUserId: owner.userId,
            communityId,
            idempotencyKey: input.idempotencyKey,
            requestSha256: commandDigest("community", "joinCommunity", [
              communityId,
            ]),
            requestId: input.requestId,
          }),
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async leaveCommunity(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const communityId = parseOpaqueUuid(input.communityId);
        return communityResource(
          await options.repository.leaveCommunity({
            ownerUserId: owner.userId,
            communityId,
            idempotencyKey: input.idempotencyKey,
            requestSha256: commandDigest("community", "leaveCommunity", [
              communityId,
            ]),
            requestId: input.requestId,
          }),
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async listMembers(input) {
      const owner = assertPrincipal(input.principal);
      try {
        return await memberPage(
          owner.userId,
          parseOpaqueUuid(input.communityId),
          input.role,
          input.cursor,
          input.limit,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async governMember(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const communityId = parseOpaqueUuid(input.communityId);
        const targetPublicProfileId = parseOpaqueUuid(
          input.targetPublicProfileId,
        );
        let action: CommunityTargetAction;
        if (input.action === "role") {
          const role = parseRoleChangeRequest(input.body);
          action =
            role === "owner"
              ? "transferOwnership"
              : role === "admin"
                ? "assignAdmin"
                : "revokeAdmin";
        } else {
          action = input.action;
        }
        await options.repository.governMember({
          actorUserId: owner.userId,
          communityId,
          targetPublicProfileId,
          action,
          idempotencyKey: input.idempotencyKey,
          requestSha256: commandDigest("community", "governMember", [
            communityId,
            targetPublicProfileId,
            action,
          ]),
          requestId: input.requestId,
        });
        return await memberPage(
          owner.userId,
          communityId,
          "all",
          undefined,
          undefined,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async follow(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const targetPublicProfileId = parseOpaqueUuid(
          input.targetPublicProfileId,
        );
        const record = await options.repository.follow({
          ownerUserId: owner.userId,
          targetPublicProfileId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: commandDigest("socialGraph", "follow", [
            targetPublicProfileId,
          ]),
          requestId: input.requestId,
        });
        return Object.freeze({
          profile: freezeIdentity(record.profile),
          viewerFollows: true,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async unfollow(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const targetPublicProfileId = parseOpaqueUuid(
          input.targetPublicProfileId,
        );
        const profile = await options.repository.unfollow({
          ownerUserId: owner.userId,
          targetPublicProfileId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: commandDigest("socialGraph", "unfollow", [
            targetPublicProfileId,
          ]),
          requestId: input.requestId,
        });
        return Object.freeze({
          profile: freezeIdentity(profile),
          viewerFollows: false,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async listConnections(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const direction = parseEnumValue<ConnectionDirection>(
          input.direction,
          ["following", "followers"],
          "following",
        );
        const filter = connectionsFilter(direction);
        const request = page(
          owner.userId,
          communityCursorRoutes.connections,
          filter,
          input.cursor,
          input.limit,
          communityListLimits,
        );
        const lastCreatedAt = readString(request.continuation, "createdAt");
        const lastPublicProfileId = readString(
          request.continuation,
          "publicProfileId",
        );
        const [records, counts] = await Promise.all([
          options.repository.listConnections({
            ownerUserId: owner.userId,
            direction,
            limit: request.limit + 1,
            ...(lastCreatedAt === undefined || lastPublicProfileId === undefined
              ? {}
              : { after: { lastCreatedAt, lastPublicProfileId } }),
          }),
          options.repository.countConnections(owner.userId),
        ]);
        const hasMore = records.length > request.limit;
        const items = records.slice(0, request.limit);
        const last = items.at(-1);
        return Object.freeze({
          direction,
          items: Object.freeze(
            items.map((item) =>
              Object.freeze({
                profile: freezeIdentity(item.profile),
                createdAt: item.createdAt,
                viewerFollows: item.viewerFollows,
                miningPower: unavailable(
                  communityUnavailableReasonCodes.miningPower,
                ),
              }),
            ),
          ),
          counts: Object.freeze({
            following: counts.following,
            followers: counts.followers,
          }),
          nextCursor:
            last === undefined
              ? null
              : nextCursor(
                  hasMore,
                  owner.userId,
                  communityCursorRoutes.connections,
                  filter,
                  Object.freeze({
                    createdAt: last.createdAt,
                    limit: request.limit,
                    publicProfileId: last.profile.publicProfileId,
                  }),
                ),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async listBlocks(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const kind = parseEnumValue<BlockKind>(
          input.kind,
          ["user", "contract", "domain"],
          "user",
        );
        if (kind !== "user") {
          throw V2ApiError.capabilityUnavailable();
        }
        const filter = blocksFilter(kind);
        const request = page(
          owner.userId,
          communityCursorRoutes.blocks,
          filter,
          input.cursor,
          input.limit,
          communityListLimits,
        );
        const lastCreatedAt = readString(request.continuation, "createdAt");
        const lastPublicProfileId = readString(
          request.continuation,
          "publicProfileId",
        );
        const [records, counts] = await Promise.all([
          options.repository.listBlocks({
            ownerUserId: owner.userId,
            limit: request.limit + 1,
            ...(lastCreatedAt === undefined || lastPublicProfileId === undefined
              ? {}
              : { after: { lastCreatedAt, lastPublicProfileId } }),
          }),
          options.repository.countBlocks(owner.userId),
        ]);
        const hasMore = records.length > request.limit;
        const items = records.slice(0, request.limit);
        const last = items.at(-1);
        return Object.freeze({
          kind,
          items: Object.freeze(
            items.map((item) =>
              Object.freeze({
                kind: item.kind,
                stableId: item.stableId,
                profile:
                  item.profile === null ? null : freezeIdentity(item.profile),
                reasonCode: item.reasonCode,
                createdAt: item.createdAt,
              }),
            ),
          ),
          counts: Object.freeze({ user: counts.user }),
          nextCursor:
            last === undefined
              ? null
              : nextCursor(
                  hasMore,
                  owner.userId,
                  communityCursorRoutes.blocks,
                  filter,
                  Object.freeze({
                    createdAt: last.createdAt,
                    limit: request.limit,
                    publicProfileId: last.stableId,
                  }),
                ),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async block(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const request = parseBlockRequest(input.body);
        if (request.kind !== "user") {
          throw V2ApiError.capabilityUnavailable();
        }
        const stableId = parseOpaqueUuid(request.stableId);
        const record = await options.repository.blockUser({
          ownerUserId: owner.userId,
          stableId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: commandDigest("socialGraph", "block", [
            request.kind,
            stableId,
          ]),
          requestId: input.requestId,
        });
        return Object.freeze({
          block: Object.freeze({
            kind: record.kind,
            stableId: record.stableId,
            profile:
              record.profile === null ? null : freezeIdentity(record.profile),
            reasonCode: record.reasonCode,
            createdAt: record.createdAt,
          }),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async unblock(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const request = parseBlockRequest(input.body);
        if (request.kind !== "user") {
          throw V2ApiError.capabilityUnavailable();
        }
        const stableId = parseOpaqueUuid(request.stableId);
        await options.repository.unblockUser({
          ownerUserId: owner.userId,
          stableId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: commandDigest("socialGraph", "unblock", [
            request.kind,
            stableId,
          ]),
          requestId: input.requestId,
        });
        return Object.freeze({
          block: null,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async listMessageRequests(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const filter = messageRequestsFilter();
        const request = page(
          owner.userId,
          communityCursorRoutes.messageRequests,
          filter,
          input.cursor,
          input.limit,
          communityListLimits,
        );
        const lastCreatedAt = readString(request.continuation, "createdAt");
        const lastPublicProfileId = readString(
          request.continuation,
          "publicProfileId",
        );
        const records = await options.repository.listMessageRequests({
          ownerUserId: owner.userId,
          limit: request.limit + 1,
          ...(lastCreatedAt === undefined || lastPublicProfileId === undefined
            ? {}
            : { after: { lastCreatedAt, lastPublicProfileId } }),
        });
        const hasMore = records.length > request.limit;
        const items = records.slice(0, request.limit);
        const last = items.at(-1);
        return Object.freeze({
          items: Object.freeze(
            items.map((item) =>
              Object.freeze({
                messageRequestId: item.messageRequestId,
                profile: freezeIdentity(item.profile),
                createdAt: item.createdAt,
                expiresAt: item.expiresAt,
                preview: unavailable(
                  communityUnavailableReasonCodes.messagePreview,
                ),
                aiModeration: unavailable(
                  communityUnavailableReasonCodes.aiModeration,
                ),
              }),
            ),
          ),
          nextCursor:
            last === undefined
              ? null
              : nextCursor(
                  hasMore,
                  owner.userId,
                  communityCursorRoutes.messageRequests,
                  filter,
                  Object.freeze({
                    createdAt: last.createdAt,
                    limit: request.limit,
                    publicProfileId: last.messageRequestId,
                  }),
                ),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async decideMessageRequest(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const messageRequestId = parseOpaqueUuid(input.messageRequestId);
        const decision = parseMessageRequestDecision(input.body);
        const record = await options.repository.decideMessageRequest({
          ownerUserId: owner.userId,
          messageRequestId,
          decision,
          idempotencyKey: input.idempotencyKey,
          requestSha256: commandDigest("socialGraph", "decideMessageRequest", [
            messageRequestId,
            decision,
          ]),
          requestId: input.requestId,
        });
        return Object.freeze({
          messageRequestId: record.messageRequestId,
          decision: record.decision,
          blocked: record.blocked,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    async search(input) {
      const owner = assertPrincipal(input.principal);
      try {
        const domain = parseEnumValue<SearchDomain>(
          input.domain,
          ["users", "communities", "assets", "launch", "dapps"],
          "users",
        );
        if (domain !== "users" && domain !== "communities") {
          if (input.cursor !== undefined) {
            throw V2ApiError.invalidRequest();
          }
          return Object.freeze({
            domain,
            status: "unavailable" as const,
            reasonCode: unavailableSearchDomains[domain],
            results: Object.freeze([]),
            nextCursor: null,
            contractVersion: v2ContractVersion,
          });
        }

        let query: string;
        try {
          query = parseAliasSearchPrefix(input.q);
        } catch {
          throw V2ApiError.invalidRequest();
        }
        const verification = parseEnumValue<CommunityVerificationFilter>(
          input.verification,
          ["verified", "all"],
          "verified",
        );
        const filter = searchFilter(domain, query, verification);
        const route =
          domain === "users"
            ? communityCursorRoutes.searchUsers
            : communityCursorRoutes.searchCommunities;
        const request = page(
          owner.userId,
          route,
          filter,
          input.cursor,
          input.limit,
          searchResultLimits,
        );
        await options.searchQuota.consume({
          scope: "public",
          userId: owner.userId,
          canonicalClientIp: input.canonicalClientIp,
          signal: input.signal,
        });
        const lastSearchKey = readString(request.continuation, "searchKey");
        const lastStableId = readString(request.continuation, "stableId");

        if (domain === "users") {
          const records = await options.repository.searchUsers({
            viewerUserId: owner.userId,
            prefix: query,
            limit: request.limit + 1,
            ...(lastSearchKey === undefined || lastStableId === undefined
              ? {}
              : {
                  after: {
                    lastSearchKey,
                    lastPublicProfileId: lastStableId,
                  },
                }),
          });
          const hasMore = records.length > request.limit;
          const items = records.slice(0, request.limit);
          const last = items.at(-1);
          return Object.freeze({
            domain,
            status: "available" as const,
            reasonCode: null,
            results: Object.freeze(
              items.map((item) => {
                const profile = freezeIdentity(item.profile);
                return Object.freeze({
                  resultType: "user" as const,
                  stableId: profile.publicProfileId,
                  displaySnapshot: Object.freeze({
                    title: profile.alias ?? profile.loopId,
                    subtitle: profile.loopId,
                    avatarRef: profile.avatarRef,
                    memberCount: null,
                    verificationStatus: null,
                  }),
                  destination: Object.freeze({
                    kind: "publicProfile" as const,
                  }),
                });
              }),
            ),
            nextCursor:
              last === undefined
                ? null
                : nextCursor(
                    hasMore,
                    owner.userId,
                    route,
                    filter,
                    Object.freeze({
                      limit: request.limit,
                      searchKey: last.searchKey,
                      stableId: last.profile.publicProfileId,
                    }),
                  ),
            contractVersion: v2ContractVersion,
          });
        }

        const records = await options.repository.searchCommunities({
          viewerUserId: owner.userId,
          prefix: query,
          verification,
          limit: request.limit + 1,
          ...(lastSearchKey === undefined || lastStableId === undefined
            ? {}
            : { after: { lastSearchKey, lastCommunityId: lastStableId } }),
        });
        const hasMore = records.length > request.limit;
        const items = records.slice(0, request.limit);
        const last = items.at(-1);
        return Object.freeze({
          domain,
          status: "available" as const,
          reasonCode: null,
          results: Object.freeze(
            items.map((item) =>
              Object.freeze({
                resultType: "community" as const,
                stableId: item.community.communityId,
                displaySnapshot: Object.freeze({
                  title: item.community.name,
                  subtitle: item.community.slug,
                  avatarRef: item.community.logoRef,
                  memberCount: item.community.memberCount,
                  verificationStatus: item.community.verificationStatus,
                }),
                destination: Object.freeze({
                  kind: "communityProfile" as const,
                }),
              }),
            ),
          ),
          nextCursor:
            last === undefined
              ? null
              : nextCursor(
                  hasMore,
                  owner.userId,
                  route,
                  filter,
                  Object.freeze({
                    limit: request.limit,
                    searchKey: last.searchKey,
                    stableId: last.community.communityId,
                  }),
                ),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return mapFailure(error);
      }
    },

    referralRules() {
      return referralRulesV1;
    },
  };
  return Object.freeze(service);
}
