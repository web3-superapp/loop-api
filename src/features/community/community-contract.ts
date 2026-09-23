import { createHash } from "node:crypto";

import { z } from "zod";

import { V2ApiError } from "../../core/http/v2-error.js";
import { loopIdPatternSource } from "../identity/loop-id.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  v2CommonHeadersSchema,
  v2SessionHeaderNames,
  parseV2WriteRequestMetadata,
  type V2WriteRequestMetadata,
} from "../session/session-contract.js";
import {
  communityMembershipStatuses,
  communityRoles,
  type CommunityMembershipStatus,
  type CommunityRole,
} from "./community-policy.js";

/**
 * V2 community, social-graph, and search wire contract (Decision 0031).
 * Public fields are camelCase; every value is untrusted presentation data.
 * The identity projection is fixed to `{publicProfileId, loopId, alias,
 * avatarRef}`: no profile_code, wallet, Privy subject, or Stream ID is ever
 * projected.
 */

export const communityConfigVersion = "communityV1" as const;
export const communityRecommendationRuleVersion =
  "rule:verified-members-v1" as const;
export const communityCommandDigestVersion = "community_command_v1" as const;
export const socialGraphCommandDigestVersion =
  "social_graph_command_v1" as const;
export const communityCommandIdempotencyScope = "v2_community_command" as const;
export const socialGraphCommandIdempotencyScope =
  "v2_social_graph_command" as const;

export const maximumCommunityNameCodePoints = 40;
export const maximumCommunityDescriptionCodePoints = 280;
export const maximumRawTextLength = 1_024;
export const communitySlugPatternSource = "^[a-z0-9-]{3,32}$";
export const communityLogoRefPatternSource =
  "^avatar:preset/community-(0[1-9]|1[0-2])$";
export const boundAssetKeyPatternSource =
  "^eip155:[1-9][0-9]{0,9}:0x[0-9a-fA-F]{40}$";
export const canonicalBoundAssetKeyPatternSource =
  "^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$";
export const publicProfileIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const opaqueIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const storedAvatarRefPatternSource =
  "^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$";
export const safeTextPatternSource =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

export const communityListLimits = Object.freeze({ default: 20, maximum: 50 });
export const communityHomeDiscoverLimit = 5;
export const communityHomeJoinedLimit = 50;
export const communityHomeOwnedLimit = 50;
export const searchResultLimits = Object.freeze({ default: 20, maximum: 20 });

export const communityVerificationStatuses = [
  "pending",
  "verified",
  "rejected",
] as const;
export type CommunityVerificationStatus =
  (typeof communityVerificationStatuses)[number];

/**
 * Discover orderings (Decision 0061). `members` and `newest` order by a
 * stored community column. `miningPower` orders by the community's power
 * under the latest complete Mining snapshot, and `activity` by the messages
 * the community-channel lane observed in its official channel over the last
 * seven days. The last two depend on a fact that may not exist yet, so the
 * response says which ordering it actually applied and, when it could not,
 * why — it never falls back to another ordering silently.
 */
export const communitySortValues = [
  "members",
  "newest",
  "miningPower",
  "activity",
] as const;
export type CommunitySort = (typeof communitySortValues)[number];

/** The window `sort=activity` counts over; also published to the client. */
export const communityActivityWindowDays = 7;

/**
 * How old an activity observation may be and still order the discover list.
 * Past it the row is treated as not observed, so a lane that stopped
 * running degrades to `unavailable` instead of ordering by stale counts.
 */
export const communityActivityObservationMaxAgeSeconds = 6 * 60 * 60;
export const communityVerificationFilters = ["verified", "all"] as const;
export type CommunityVerificationFilter =
  (typeof communityVerificationFilters)[number];
/**
 * `joined` is the viewer's non-owner memberships; `owned` is the communities
 * the viewer currently owns (Decision 0073). A community is in exactly one.
 */
export const communityMembershipFilters = ["all", "joined", "owned"] as const;
export type CommunityMembershipFilter =
  (typeof communityMembershipFilters)[number];
/**
 * Member directory filters. `banned` is a governance view: it lists the
 * memberships a ban parked at `status = "banned"`, which the default views
 * exclude, and only an owner or admin may ask for it (S3 integration,
 * FINDING-1: without it an unban has no entry point).
 */
export const memberRoleFilters = ["all", "owner", "admin", "banned"] as const;
export type MemberRoleFilter = (typeof memberRoleFilters)[number];

export const connectionDirections = ["following", "followers"] as const;
export type ConnectionDirection = (typeof connectionDirections)[number];
export const blockKinds = ["user", "contract", "domain"] as const;
export type BlockKind = (typeof blockKinds)[number];
export const messageRequestDecisions = ["accept", "ignore", "report"] as const;
export type MessageRequestDecision = (typeof messageRequestDecisions)[number];
export const searchDomains = [
  "users",
  "communities",
  "assets",
  "launch",
  "dapps",
] as const;
export type SearchDomain = (typeof searchDomains)[number];

const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const canonicalUuidPattern = new RegExp(publicProfileIdPatternSource);
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const slugPattern = new RegExp(communitySlugPatternSource);
const logoRefPattern = new RegExp(communityLogoRefPatternSource);
const boundAssetKeyPattern = new RegExp(boundAssetKeyPatternSource);
const loopIdPattern = new RegExp(loopIdPatternSource);
const storedAvatarRefPattern = new RegExp(storedAvatarRefPatternSource);

export class InvalidCommunityRequestError extends Error {
  readonly code = "invalid_community_request";

  constructor() {
    super("The V2 community request is invalid");
    this.name = "InvalidCommunityRequestError";
  }
}

function invalid(): never {
  throw new InvalidCommunityRequestError();
}

function boundedText(maximumCodePoints: number) {
  return z
    .string()
    .max(maximumRawTextLength)
    .superRefine((value, context) => {
      const trimmed = value.trim();
      const codePoints = Array.from(trimmed).length;
      if (
        codePoints < 1 ||
        codePoints > maximumCodePoints ||
        forbiddenTextCharacters.test(value)
      ) {
        context.addIssue({ code: "custom" });
      }
    })
    .transform((value) => value.trim());
}

const communityNameSchema = boundedText(maximumCommunityNameCodePoints);
const communityDescriptionSchema = boundedText(
  maximumCommunityDescriptionCodePoints,
);
const slugSchema = z.string().regex(slugPattern);
const logoRefSchema = z.string().regex(logoRefPattern);
const boundAssetKeySchema = z
  .string()
  .regex(boundAssetKeyPattern)
  .transform((value) => value.toLowerCase());
const uuidSchema = z.string().regex(canonicalUuidPattern);

const createCommunityRequestSchema = z
  .object({
    name: communityNameSchema,
    slug: slugSchema,
    description: communityDescriptionSchema.nullable(),
    logoRef: logoRefSchema.nullable(),
    boundAssetKey: boundAssetKeySchema.nullable(),
  })
  .strict();

const updateCommunityRequestSchema = z
  .object({
    name: communityNameSchema.optional(),
    description: communityDescriptionSchema.nullable().optional(),
    logoRef: logoRefSchema.nullable().optional(),
    boundAssetKey: boundAssetKeySchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

const roleChangeRequestSchema = z
  .object({ role: z.enum(communityRoles) })
  .strict();

const blockRequestSchema = z
  .object({
    kind: z.enum(blockKinds),
    stableId: z.string().min(1).max(256),
  })
  .strict();

const messageRequestDecisionSchema = z
  .object({ decision: z.enum(messageRequestDecisions) })
  .strict();

const sendMessageRequestSchema = z
  .object({ targetPublicProfileId: uuidSchema })
  .strict();

export interface CreateCommunityValues {
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoRef: string | null;
  /** Canonical `eip155:<chainId>:<0x lowercase address>` or null. */
  readonly boundAssetKey: string | null;
}

/**
 * Owner-only community profile edit. Only the keys actually present are
 * changed; `slug` and `verificationStatus` are immutable through this path.
 */
export interface UpdateCommunityValues {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly logoRef?: string | null | undefined;
  readonly boundAssetKey?: string | null | undefined;
}

export interface IdentityProjection {
  readonly publicProfileId: string;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
}

export interface CommunitySummary {
  readonly communityId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoRef: string | null;
  readonly verificationStatus: CommunityVerificationStatus;
  readonly boundAssetKey: string | null;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly configVersion: typeof communityConfigVersion;
}

/**
 * The owner-only view of an application's review state (Decision 0073).
 * `submittedAt` is the last (re)submission; `reviewedAt` and
 * `rejectedReason` are null while pending; a verified application has a
 * `reviewedAt` and no reason.
 */
export interface CommunityApplicationProjection {
  readonly status: CommunityVerificationStatus;
  readonly submittedAt: string;
  readonly reviewedAt: string | null;
  readonly rejectedReason: string | null;
}

export const maximumRejectedReasonCodePoints = 280;

export interface MembershipProjection {
  readonly role: CommunityRole;
  readonly status: CommunityMembershipStatus;
  readonly joinedAt: string;
}

export interface MemberProjection extends MembershipProjection {
  readonly profile: IdentityProjection;
}

export interface UnavailableProjection {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export function unavailable(reasonCode: string): UnavailableProjection {
  return Object.freeze({ status: "unavailable", reasonCode });
}

export const communityUnavailableReasonCodes = Object.freeze({
  /** No Stream credentials: the presence reader is not composed. */
  presence: "STREAM_PRESENCE_NOT_CONNECTED",
  /** The response was produced by a write; only the detail read observes. */
  presenceNotObserved: "STREAM_PRESENCE_NOT_OBSERVED",
  /** Stream answered with a fault, a rejection, or an unexpected shape. */
  presenceReadFailed: "STREAM_PRESENCE_READ_FAILED",
  /** The presence read did not finish inside its budget. */
  presenceReadTimeout: "STREAM_PRESENCE_READ_TIMEOUT",
  /** More channel members than the paging budget covers (Decision 0047). */
  presenceMemberBound: "STREAM_PRESENCE_MEMBER_BOUND_EXCEEDED",
  unread: "STREAM_UNREAD_NOT_CONNECTED",
  liveVoice: "STREAM_VOICE_NOT_CONNECTED",
  mining: "MINING_FORMULA_BASELINE_PENDING",
  miningPower: "MINING_FORMULA_BASELINE_PENDING",
  asset: "ASSET_RESOLUTION_DEFERRED",
  announcements: "COMMUNITY_ANNOUNCEMENTS_DEFERRED",
  officialLinks: "COMMUNITY_LINKS_DEFERRED",
  messagePreview: "MESSAGE_PREVIEW_DEFERRED",
  aiModeration: "AI_MODERATION_DEFERRED",
  blockKind: "BLOCK_KIND_DEFERRED",
  /**
   * The `assets` search domain reads the Asset Registry (Decision 0071); it
   * is unavailable only when no registry repository is composed.
   */
  searchAssets: "ASSET_REGISTRY_NOT_COMPOSED",
  /**
   * The Launch module is shipped but has no project directory to search until
   * the contract product document (02) provides projects (Decision 0071).
   */
  searchLaunch: "LAUNCH_PROJECT_DIRECTORY_PENDING",
  /** No DApp directory Provider is integrated (Decision 0071). */
  searchDapps: "DAPP_DIRECTORY_NOT_INTEGRATED",
  referralEdges: "REFERRAL_GRAPH_DEFERRED",
  inviteCode: "INVITE_CODE_DEFERRED",
  /**
   * No community has a fresh `community_channel_activity` observation, so
   * there is nothing to order `sort=activity` by (Decision 0061). The lane
   * has not run, has no provisioned channel to read, or Stream refused the
   * read; in every case the list is empty rather than ordered by a number
   * nobody measured.
   */
  activityNotObserved: "COMMUNITY_ACTIVITY_NOT_OBSERVED",
  /** One community's channel has no fresh observation while others do. */
  activityChannelNotObserved: "COMMUNITY_ACTIVITY_CHANNEL_NOT_OBSERVED",
} as const);

export function parseCreateCommunityRequest(
  value: unknown,
): CreateCommunityValues {
  const parsed = createCommunityRequestSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : invalid();
}

export function parseUpdateCommunityRequest(
  value: unknown,
): UpdateCommunityValues {
  const parsed = updateCommunityRequestSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : invalid();
}

/**
 * Canonical digest input for a partial edit: every field appears in a fixed
 * order with an explicit present/absent marker, so omitting a field and
 * setting it to null are different commands under the same key.
 */
export function updateCommunityDigestParts(
  values: UpdateCommunityValues,
): readonly string[] {
  return Object.freeze(
    (["name", "description", "logoRef", "boundAssetKey"] as const).flatMap(
      (key) => {
        const value = values[key];
        if (value === undefined) {
          return [key, "absent", ""];
        }
        return [key, value === null ? "null" : "set", value ?? ""];
      },
    ),
  );
}

export function parseRoleChangeRequest(value: unknown): CommunityRole {
  const parsed = roleChangeRequestSchema.safeParse(value);
  return parsed.success ? parsed.data.role : invalid();
}

export function parseBlockRequest(value: unknown): {
  readonly kind: BlockKind;
  readonly stableId: string;
} {
  const parsed = blockRequestSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : invalid();
}

export function parseSendMessageRequest(value: unknown): string {
  const parsed = sendMessageRequestSchema.safeParse(value);
  return parsed.success ? parsed.data.targetPublicProfileId : invalid();
}

export function parseMessageRequestDecision(
  value: unknown,
): MessageRequestDecision {
  const parsed = messageRequestDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data.decision : invalid();
}

export function parseOpaqueUuid(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}

export function parseListLimit(
  value: unknown,
  limits: { readonly default: number; readonly maximum: number },
): number {
  if (value === undefined) {
    return limits.default;
  }
  const parsed = z.number().int().min(1).max(limits.maximum).safeParse(value);
  return parsed.success ? parsed.data : invalid();
}

export function parseEnumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  return values.includes(value as T) ? (value as T) : invalid();
}

export function isIdentityProjection(
  value: IdentityProjection,
): value is IdentityProjection {
  return (
    canonicalUuidPattern.test(value.publicProfileId) &&
    loopIdPattern.test(value.loopId) &&
    (value.alias === null ||
      (value.alias === value.alias.trim() &&
        Array.from(value.alias).length >= 1 &&
        Array.from(value.alias).length <= 40 &&
        !forbiddenTextCharacters.test(value.alias))) &&
    (value.avatarRef === null || storedAvatarRefPattern.test(value.avatarRef))
  );
}

export function freezeIdentity(value: IdentityProjection): IdentityProjection {
  if (!isIdentityProjection(value)) {
    throw V2ApiError.capabilityUnavailable();
  }
  return Object.freeze({
    publicProfileId: value.publicProfileId,
    loopId: value.loopId,
    alias: value.alias,
    avatarRef: value.avatarRef,
  });
}

export function isCommunityRole(value: unknown): value is CommunityRole {
  return communityRoles.includes(value as CommunityRole);
}

export function isMembershipStatus(
  value: unknown,
): value is CommunityMembershipStatus {
  return communityMembershipStatuses.includes(
    value as CommunityMembershipStatus,
  );
}

/**
 * Write headers: the common V2 headers plus exactly one canonical UUIDv4
 * `Idempotency-Key`. Device ID and platform are not part of a community or
 * social-graph command because the logical operation is account-level.
 */
export const v2CommandHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    ...v2CommonHeadersSchema.required,
    v2SessionHeaderNames.idempotencyKey,
  ],
  properties: {
    ...v2CommonHeadersSchema.properties,
    [v2SessionHeaderNames.idempotencyKey]: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
  },
} as const;

export interface V2CommandMetadata extends V2WriteRequestMetadata {
  readonly idempotencyKey: string;
}

export function parseV2CommandMetadata(
  rawHeaders: readonly string[],
): V2CommandMetadata {
  const common = parseV2WriteRequestMetadata(rawHeaders);
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (
      rawHeaders[index]?.toLowerCase() === v2SessionHeaderNames.idempotencyKey
    ) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  const idempotencyKey = values[0];
  if (
    values.length !== 1 ||
    idempotencyKey === undefined ||
    !canonicalUuidV4Pattern.test(idempotencyKey)
  ) {
    throw V2ApiError.invalidRequest();
  }
  return Object.freeze({ ...common, idempotencyKey });
}

export function hasIdempotencyKeyHeader(
  rawHeaders: readonly string[],
): boolean {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (
      rawHeaders[index]?.toLowerCase() === v2SessionHeaderNames.idempotencyKey
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Canonical SHA-256 command digest. The route name, contract version, and
 * every normalized input are bound so the same `Idempotency-Key` with a
 * different intent is `IDEMPOTENCY_CONFLICT`.
 */
export function commandDigest(
  domain: "community" | "socialGraph",
  operation: string,
  parts: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(
    `loop:v2:${domain}:${
      domain === "community"
        ? communityCommandDigestVersion
        : socialGraphCommandDigestVersion
    }`,
  );
  for (const part of [operation, v2ContractVersion, ...parts]) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

/** ASCII-only canonical cursor filter component for arbitrary text. */
export function filterDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

export function canonicalFilter(
  entries: Readonly<Record<string, string>>,
): string {
  return Object.keys(entries)
    .sort()
    .map((key) => `${key}=${entries[key] ?? ""}`)
    .join("&");
}

/**
 * Cursor route names (`^[a-z][A-Za-z0-9]{0,63}$`). Every list binds its
 * cursor to the authenticated owner, this route name, and its canonical
 * filter string, so a cursor cannot cross accounts, routes, or filters.
 */
export const communityCursorRoutes = Object.freeze({
  communities: "v2Communities",
  members: "v2CommunityMembers",
  connections: "v2Connections",
  blocks: "v2Blocks",
  messageRequests: "v2MessageRequests",
  searchUsers: "v2SearchUsers",
  searchCommunities: "v2SearchCommunities",
  searchAssets: "v2SearchAssets",
} as const);

/**
 * Search domains that have no selected backend. Each carries its own reason
 * so the client can say why: Launch has no project directory yet, and no
 * DApp directory is integrated (Decision 0071).
 */
export const unavailableSearchDomains = Object.freeze({
  launch: communityUnavailableReasonCodes.searchLaunch,
  dapps: communityUnavailableReasonCodes.searchDapps,
} as const);

export const searchResultTypes = ["user", "community", "asset"] as const;
export type SearchResultType = (typeof searchResultTypes)[number];

/**
 * `assetDetail` is the only destination that needs a parameter: the row's
 * `stableId` is the canonical CAIP-19 `assetId` (Decision 0033), which is
 * also repeated as `destination.assetId` so the client never derives a route
 * from the symbol or the address text.
 */
export const searchDestinationKinds = [
  "publicProfile",
  "communityProfile",
  "assetDetail",
] as const;
export type SearchDestinationKind = (typeof searchDestinationKinds)[number];

/**
 * Recommendation rule identity for the discover list. The ordering only uses
 * verifiable facts (verification status, member count, creation time); no
 * engagement, growth, or "hot" signal exists yet.
 */
export interface CommunityRecommendation {
  readonly recommendationId: string;
  readonly ruleVersion: typeof communityRecommendationRuleVersion;
}

export function communityDiscoverFilter(
  sort: CommunitySort,
  verification: CommunityVerificationFilter,
  membership: CommunityMembershipFilter,
): string {
  return canonicalFilter({ membership, sort, verification });
}

/**
 * The member-directory cursor binds the alias prefix as well, so continuing a
 * page after the query changed (or after it was added or removed) fails with
 * INVALID_REQUEST instead of interleaving two different result sets. A page
 * without `q` keeps the original two-component filter.
 */
export function communityMembersFilter(
  communityId: string,
  role: MemberRoleFilter,
  aliasPrefix: string | null,
): string {
  return canonicalFilter(
    aliasPrefix === null
      ? { community: communityId, role }
      : { community: communityId, q: filterDigest(aliasPrefix), role },
  );
}

export function connectionsFilter(direction: ConnectionDirection): string {
  return canonicalFilter({ direction });
}

export function blocksFilter(kind: BlockKind): string {
  return canonicalFilter({ kind });
}

export function messageRequestsFilter(): string {
  return canonicalFilter({ status: "pending" });
}

/**
 * `verification` only narrows the `communities` domain, so it is excluded
 * from the `users` filter. Including it there would let an unrelated query
 * parameter invalidate a cursor mid-pagination.
 */
export function searchFilter(
  domain: SearchDomain,
  query: string,
  verification: CommunityVerificationFilter,
): string {
  return canonicalFilter(
    domain === "communities"
      ? { domain, q: filterDigest(query), verification }
      : { domain, q: filterDigest(query) },
  );
}
