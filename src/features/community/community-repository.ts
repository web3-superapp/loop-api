import type {
  BlockKind,
  CommunityMembershipFilter,
  CommunitySort,
  CommunityVerificationFilter,
  CommunityVerificationStatus,
  IdentityProjection,
  MemberRoleFilter,
  MessageRequestDecision,
  UpdateCommunityValues,
} from "./community-contract.js";
import type {
  CommunityMembershipStatus,
  CommunityRole,
  CommunityTargetAction,
} from "./community-policy.js";

/**
 * V2 community, follow-graph, block-list, message-request, and search
 * persistence boundary (Decision 0031). PostgreSQL is the truth for every
 * fact returned here; the service layer adds no fixture and no fallback.
 *
 * Every projection carries the fixed V2 identity shape
 * `{publicProfileId, loopId, alias, avatarRef}`. `profile_code`, wallet
 * addresses, Privy subjects, and Stream IDs never leave this boundary.
 */

export interface CommunityRecord {
  readonly communityId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoRef: string | null;
  readonly verificationStatus: CommunityVerificationStatus;
  readonly boundAssetKey: string | null;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly configVersion: string;
}

export interface MembershipRecord {
  readonly role: CommunityRole;
  readonly status: CommunityMembershipStatus;
  readonly joinedAt: string;
}

/**
 * A member row. `profile.publicProfileId` is null only for a membership whose
 * `user_profiles` row is missing: such a row is listed and counted so the
 * directory totals match the page, but it can never be a governance target.
 */
export interface CommunityMemberIdentity {
  readonly publicProfileId: string | null;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
}

export interface CommunityMemberRecord extends MembershipRecord {
  readonly membershipId: string;
  readonly profile: CommunityMemberIdentity;
}

export interface CommunityDetailRecord {
  readonly community: CommunityRecord;
  /** Null when the viewer has never joined. */
  readonly viewerMembership: MembershipRecord | null;
}

export interface CommunityListCursor {
  /** `memberCount` for `sort=members`, `createdAt` for `sort=newest`. */
  readonly lastSortValue: string;
  readonly lastCommunityId: string;
}

export interface ListCommunitiesInput {
  readonly viewerUserId: string;
  readonly sort: CommunitySort;
  readonly verification: CommunityVerificationFilter;
  readonly membership: CommunityMembershipFilter;
  readonly limit: number;
  readonly after?: CommunityListCursor | undefined;
}

export interface CommunityHomeRecord {
  readonly joined: readonly CommunityDetailRecord[];
  /** True when the account has joined more communities than `joinedLimit`. */
  readonly joinedTruncated: boolean;
  readonly discover: readonly CommunityRecord[];
  readonly observedAt: string;
}

export interface CreateCommunityInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoRef: string | null;
  readonly boundAssetKey: string | null;
}

export interface UpdateCommunityInput {
  readonly ownerUserId: string;
  readonly communityId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly values: UpdateCommunityValues;
}

export interface CommunityMembershipCommandInput {
  readonly ownerUserId: string;
  readonly communityId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface MemberListCursor {
  readonly lastRoleRank: number;
  readonly lastJoinedAt: string;
  readonly lastMembershipId: string;
}

export interface ListMembersInput {
  readonly viewerUserId: string;
  readonly communityId: string;
  readonly role: MemberRoleFilter;
  readonly limit: number;
  readonly after?: MemberListCursor | undefined;
}

export interface CommunityMemberPageRecord {
  readonly community: CommunityRecord;
  readonly viewerMembership: MembershipRecord | null;
  /** Null when the viewer has no profile row, so no member row is "self". */
  readonly viewerPublicProfileId: string | null;
  readonly items: readonly CommunityMemberRecord[];
  readonly counts: {
    readonly all: number;
    readonly owner: number;
    readonly admin: number;
  };
}

export interface GovernMemberInput {
  readonly actorUserId: string;
  readonly communityId: string;
  readonly targetPublicProfileId: string;
  readonly action: CommunityTargetAction;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface GovernMemberRecord {
  readonly community: CommunityRecord;
  readonly actorMembership: MembershipRecord;
  readonly target: CommunityMemberRecord | null;
}

export interface FollowCommandInput {
  readonly ownerUserId: string;
  readonly targetPublicProfileId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface ConnectionRecord {
  readonly profile: IdentityProjection;
  readonly createdAt: string;
  readonly viewerFollows: boolean;
}

export interface ConnectionCursor {
  readonly lastCreatedAt: string;
  readonly lastPublicProfileId: string;
}

export interface ListConnectionsInput {
  readonly ownerUserId: string;
  readonly direction: "following" | "followers";
  readonly limit: number;
  readonly after?: ConnectionCursor | undefined;
}

export interface ConnectionCountsRecord {
  readonly following: number;
  readonly followers: number;
}

export interface BlockCommandInput {
  readonly ownerUserId: string;
  readonly stableId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface BlockRecord {
  readonly kind: BlockKind;
  readonly stableId: string;
  readonly profile: IdentityProjection | null;
  readonly reasonCode: string;
  readonly createdAt: string;
}

export interface ListBlocksInput {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly after?: ConnectionCursor | undefined;
}

export interface BlockCountsRecord {
  readonly user: number;
}

export interface MessageRequestRecord {
  readonly messageRequestId: string;
  readonly profile: IdentityProjection;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ListMessageRequestsInput {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly after?: ConnectionCursor | undefined;
}

export interface DecideMessageRequestInput {
  readonly ownerUserId: string;
  readonly messageRequestId: string;
  readonly decision: MessageRequestDecision;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface MessageRequestDecisionRecord {
  readonly messageRequestId: string;
  readonly decision: MessageRequestDecision;
  readonly blocked: boolean;
}

export interface SearchUsersInput {
  readonly viewerUserId: string;
  readonly prefix: string;
  readonly limit: number;
  readonly after?:
    | { readonly lastSearchKey: string; readonly lastPublicProfileId: string }
    | undefined;
}

export interface SearchUserRecord {
  readonly profile: IdentityProjection;
  readonly searchKey: string;
}

export interface SearchCommunitiesInput {
  readonly viewerUserId: string;
  readonly prefix: string;
  readonly verification: CommunityVerificationFilter;
  readonly limit: number;
  readonly after?:
    | { readonly lastSearchKey: string; readonly lastCommunityId: string }
    | undefined;
}

export interface SearchCommunityRecord {
  readonly community: CommunityRecord;
  readonly searchKey: string;
  readonly viewerJoined: boolean;
}

export interface CommunityRepository {
  listCommunities(
    input: ListCommunitiesInput,
  ): Promise<readonly CommunityRecord[]>;
  getCommunityHome(input: {
    readonly viewerUserId: string;
    readonly joinedLimit: number;
    readonly discoverLimit: number;
  }): Promise<CommunityHomeRecord>;
  getCommunity(input: {
    readonly viewerUserId: string;
    readonly communityId: string;
  }): Promise<CommunityDetailRecord>;
  createCommunity(input: CreateCommunityInput): Promise<CommunityDetailRecord>;
  updateCommunity(input: UpdateCommunityInput): Promise<CommunityDetailRecord>;
  joinCommunity(
    input: CommunityMembershipCommandInput,
  ): Promise<CommunityDetailRecord>;
  leaveCommunity(
    input: CommunityMembershipCommandInput,
  ): Promise<CommunityDetailRecord>;
  listMembers(input: ListMembersInput): Promise<CommunityMemberPageRecord>;
  governMember(input: GovernMemberInput): Promise<GovernMemberRecord>;
  follow(input: FollowCommandInput): Promise<ConnectionRecord>;
  unfollow(input: FollowCommandInput): Promise<IdentityProjection>;
  listConnections(
    input: ListConnectionsInput,
  ): Promise<readonly ConnectionRecord[]>;
  countConnections(ownerUserId: string): Promise<ConnectionCountsRecord>;
  blockUser(input: BlockCommandInput): Promise<BlockRecord>;
  unblockUser(input: BlockCommandInput): Promise<void>;
  listBlocks(input: ListBlocksInput): Promise<readonly BlockRecord[]>;
  countBlocks(ownerUserId: string): Promise<BlockCountsRecord>;
  listMessageRequests(
    input: ListMessageRequestsInput,
  ): Promise<readonly MessageRequestRecord[]>;
  decideMessageRequest(
    input: DecideMessageRequestInput,
  ): Promise<MessageRequestDecisionRecord>;
  searchUsers(input: SearchUsersInput): Promise<readonly SearchUserRecord[]>;
  searchCommunities(
    input: SearchCommunitiesInput,
  ): Promise<readonly SearchCommunityRecord[]>;
  /** Dev-only operator path used by `pnpm community:verify`; writes an audit row. */
  verifyCommunity(input: {
    readonly communityId: string;
    readonly requestId: string;
    readonly reasonCode: string;
  }): Promise<CommunityRecord>;
}

export class CommunityRepositoryUnavailableError extends Error {
  readonly code = "community_repository_unavailable";

  constructor() {
    super("The V2 community repository is unavailable");
    this.name = "CommunityRepositoryUnavailableError";
  }
}

/** The community, member, or message request does not exist for this viewer. */
export class CommunityNotFoundError extends Error {
  readonly code = "community_not_found";

  constructor() {
    super("The V2 community resource was not found");
    this.name = "CommunityNotFoundError";
  }
}

/**
 * A target account is nonexistent, not discoverable, blocked, or otherwise
 * unavailable. Every one of those states returns the same non-enumerating
 * error so membership of the set cannot be probed.
 */
export class CommunityTargetUnavailableError extends Error {
  readonly code = "community_target_unavailable";

  constructor() {
    super("The V2 community target is unavailable");
    this.name = "CommunityTargetUnavailableError";
  }
}

export class CommunityPermissionDeniedError extends Error {
  readonly code = "community_permission_denied";

  constructor() {
    super("The actor may not perform this community action");
    this.name = "CommunityPermissionDeniedError";
  }
}

/** The stored state no longer allows the requested transition. */
export class CommunityDataStaleError extends Error {
  readonly code = "community_data_stale";

  constructor() {
    super("The V2 community state changed before the command was applied");
    this.name = "CommunityDataStaleError";
  }
}

export class CommunitySlugTakenError extends Error {
  readonly code = "community_slug_taken";

  constructor() {
    super("The community slug is already used");
    this.name = "CommunitySlugTakenError";
  }
}

export class CommunityIdempotencyConflictError extends Error {
  readonly code = "community_idempotency_conflict";

  constructor() {
    super("The community idempotency key conflicts");
    this.name = "CommunityIdempotencyConflictError";
  }
}

/** The account has no activated V2 profile, so it has no public identity. */
export class CommunityProfileRequiredError extends Error {
  readonly code = "community_profile_required";

  constructor() {
    super("An activated LOOP profile is required for community participation");
    this.name = "CommunityProfileRequiredError";
  }
}

export function createUnavailableCommunityRepository(): CommunityRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new CommunityRepositoryUnavailableError());
  return Object.freeze({
    listCommunities: unavailable,
    getCommunityHome: unavailable,
    getCommunity: unavailable,
    createCommunity: unavailable,
    updateCommunity: unavailable,
    joinCommunity: unavailable,
    leaveCommunity: unavailable,
    listMembers: unavailable,
    governMember: unavailable,
    follow: unavailable,
    unfollow: unavailable,
    listConnections: unavailable,
    countConnections: unavailable,
    blockUser: unavailable,
    unblockUser: unavailable,
    listBlocks: unavailable,
    countBlocks: unavailable,
    listMessageRequests: unavailable,
    decideMessageRequest: unavailable,
    searchUsers: unavailable,
    searchCommunities: unavailable,
    verifyCommunity: unavailable,
  });
}
