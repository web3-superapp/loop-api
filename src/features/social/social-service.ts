import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  SocialAlreadyFriendsError,
  SocialFriendRequestAlreadyDecidedError,
  SocialFriendRequestNotFoundError,
  SocialIdempotencyConflictError,
  SocialIncomingRequestPendingError,
  SocialOutgoingRequestPendingError,
  SocialPrivacyVersionConflictError,
  SocialProfileRequiredError,
  SocialRepositoryUnavailableError,
  SocialRequestCooldownError,
  SocialTargetUnavailableError,
  type FriendRecord,
  type FriendRequestDirection,
  type FriendRequestRecord,
  type FriendSearchRecord,
  type PreflightSocialCommandInput,
  type SocialOperationRecord,
  type SocialPrivacyRecord,
  type SocialRepository,
} from "../../database/social-repository.js";
import {
  aliasSearchLimits,
  parseAliasSearchLimit,
  parseAliasSearchPrefix,
} from "../identity/alias-contract.js";
import { parseAliasPrincipal } from "../identity/alias-principal.js";
import {
  AliasSearchQuotaUnavailableError,
  AliasSearchRateLimitedError,
  type AliasSearchQuota,
} from "../identity/alias-search-quota.js";
import {
  defaultSocialPrivacyValues,
  digestFriendRequestDecision,
  digestFriendRequestSend,
  isValidAvatarReference,
  isValidProfileCode,
  parseFriendRequestDecision,
  parseFriendRequestSend,
  parseSocialListLimit,
  parseSocialPrivacyReplacement,
  parseSocialUuid,
  type FriendListResource,
  type FriendRequestListResource,
  type FriendRequestResource,
  type FriendSearchResource,
  type FriendSearchResourceItem,
  type SocialOperationResource,
  type SocialPrivacyResource,
} from "./social-contract.js";
import {
  InvalidSocialCursorError,
  type SocialCursorCodec,
} from "./social-cursor.js";
import {
  SocialMutationQuotaUnavailableError,
  SocialMutationRateLimitedError,
  type SocialMutationQuota,
  type SocialMutationQuotaInput,
} from "./social-mutation-quota.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const forbiddenAliasCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const safeErrorCodes = new Set([
  "target_unavailable",
  "profile_required",
  "incoming_request_pending",
  "outgoing_request_pending",
  "already_friends",
  "friend_request_cooldown",
  "friend_request_not_found",
  "friend_request_already_decided",
]);

export type SocialDomainErrorCode =
  | "invalid_request"
  | "social_unavailable"
  | "search_rate_limited"
  | "social_rate_limited"
  | "version_conflict"
  | "idempotency_conflict"
  | "target_unavailable"
  | "profile_required"
  | "incoming_request_pending"
  | "outgoing_request_pending"
  | "already_friends"
  | "friend_request_cooldown"
  | "friend_request_not_found"
  | "friend_request_already_decided"
  | "social_operation_not_found";

export class SocialDomainError extends Error {
  readonly code: SocialDomainErrorCode;

  constructor(code: SocialDomainErrorCode) {
    super(`Social operation failed: ${code}`);
    this.name = "SocialDomainError";
    this.code = code;
  }
}

interface OwnerInput {
  readonly principal: AuthenticatedLoopPrincipal;
}

export interface ReplaceSocialPrivacyServiceInput extends OwnerInput {
  readonly body: unknown;
}

export interface ListFriendsServiceInput extends OwnerInput {
  readonly cursor: unknown;
  readonly limit: unknown;
}

export interface SearchFriendsServiceInput extends OwnerInput {
  readonly aliasPrefix: unknown;
  readonly limit: unknown;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

interface SocialCommandServiceInput extends OwnerInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly body: unknown;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

export type SendFriendRequestServiceInput = SocialCommandServiceInput;

export interface ListFriendRequestsServiceInput extends OwnerInput {
  readonly direction: unknown;
  readonly status: unknown;
  readonly cursor: unknown;
  readonly limit: unknown;
}

export interface DecideFriendRequestServiceInput extends SocialCommandServiceInput {
  readonly friendRequestId: unknown;
}

export interface GetSocialOperationServiceInput extends OwnerInput {
  readonly operationId: unknown;
}

export interface SocialService {
  getSocialPrivacy(input: OwnerInput): Promise<SocialPrivacyResource>;
  replaceSocialPrivacy(
    input: ReplaceSocialPrivacyServiceInput,
  ): Promise<SocialPrivacyResource>;
  listFriends(input: ListFriendsServiceInput): Promise<FriendListResource>;
  searchFriends(
    input: SearchFriendsServiceInput,
  ): Promise<FriendSearchResource>;
  sendFriendRequest(
    input: SendFriendRequestServiceInput,
  ): Promise<SocialOperationResource>;
  listFriendRequests(
    input: ListFriendRequestsServiceInput,
  ): Promise<FriendRequestListResource>;
  decideFriendRequest(
    input: DecideFriendRequestServiceInput,
  ): Promise<SocialOperationResource>;
  getOperation(
    input: GetSocialOperationServiceInput,
  ): Promise<SocialOperationResource>;
}

function unavailable(): Promise<never> {
  return Promise.reject(new SocialDomainError("social_unavailable"));
}

export function createUnavailableSocialService(): SocialService {
  return Object.freeze({
    getSocialPrivacy: unavailable,
    replaceSocialPrivacy: unavailable,
    listFriends: unavailable,
    searchFriends: unavailable,
    sendFriendRequest: unavailable,
    listFriendRequests: unavailable,
    decideFriendRequest: unavailable,
    getOperation: unavailable,
  });
}

function principal(
  value: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  try {
    return parseAliasPrincipal(value);
  } catch {
    throw new SocialDomainError("invalid_request");
  }
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isAlias(value: string | null, nullable: boolean): boolean {
  if (value === null) {
    return nullable;
  }
  return (
    value === value.trim() &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= 40 &&
    !forbiddenAliasCharacters.test(value)
  );
}

function assertPresentation(
  value: {
    readonly publicProfileId: string;
    readonly profileCode: string;
    readonly alias: string | null;
    readonly avatarRef: string | null;
  },
  aliasNullable: boolean,
): void {
  if (
    !uuidPattern.test(value.publicProfileId) ||
    !isValidProfileCode(value.profileCode) ||
    !isAlias(value.alias, aliasNullable) ||
    (value.avatarRef !== null && !isValidAvatarReference(value.avatarRef))
  ) {
    throw new SocialDomainError("social_unavailable");
  }
}

function privacyResource(
  record: SocialPrivacyRecord | null,
  ownerUserId: string,
): SocialPrivacyResource {
  if (record === null) {
    return Object.freeze({
      version: 0,
      social_privacy: defaultSocialPrivacyValues,
      updated_at: null,
    });
  }
  if (
    record.ownerUserId !== ownerUserId ||
    !Number.isInteger(record.version) ||
    record.version < 1 ||
    record.version > 2_147_483_647 ||
    !["enabled", "disabled"].includes(record.friendRequests) ||
    !["friends", "disabled"].includes(record.groupInvites) ||
    !["friends", "disabled"].includes(record.directMessages) ||
    !isIsoTimestamp(record.updatedAt)
  ) {
    throw new SocialDomainError("social_unavailable");
  }
  return Object.freeze({
    version: record.version,
    social_privacy: Object.freeze({
      friend_requests: record.friendRequests,
      group_invites: record.groupInvites,
      direct_messages: record.directMessages,
    }),
    updated_at: record.updatedAt,
  });
}

function friendResource(record: FriendRecord) {
  assertPresentation(record, true);
  if (
    !uuidPattern.test(record.friendshipId) ||
    !isIsoTimestamp(record.acceptedAt)
  ) {
    throw new SocialDomainError("social_unavailable");
  }
  return Object.freeze({
    public_profile_id: record.publicProfileId,
    profile_code: record.profileCode,
    alias: record.alias,
    avatar_ref: record.avatarRef,
    accepted_at: record.acceptedAt,
  });
}

function searchResource(record: FriendSearchRecord): FriendSearchResourceItem {
  assertPresentation(record, false);
  const pending =
    record.relationship === "incoming_pending" ||
    record.relationship === "outgoing_pending";
  if (
    !["none", "incoming_pending", "outgoing_pending", "friend"].includes(
      record.relationship,
    ) ||
    pending !== (record.friendRequestId !== null) ||
    (record.friendRequestId !== null &&
      !uuidPattern.test(record.friendRequestId))
  ) {
    throw new SocialDomainError("social_unavailable");
  }
  return Object.freeze({
    public_profile_id: record.publicProfileId,
    profile_code: record.profileCode,
    alias: record.alias,
    avatar_ref: record.avatarRef,
    relationship: record.relationship,
    friend_request_id: record.friendRequestId,
  });
}

function friendRequestResource(
  record: FriendRequestRecord,
  expectedDirection: FriendRequestDirection,
): FriendRequestResource {
  assertPresentation(
    {
      publicProfileId: record.counterpartyPublicProfileId,
      profileCode: record.counterpartyProfileCode,
      alias: record.counterpartyAlias,
      avatarRef: record.counterpartyAvatarRef,
    },
    true,
  );
  if (
    !uuidPattern.test(record.friendRequestId) ||
    record.direction !== expectedDirection ||
    record.status !== "pending" ||
    !isIsoTimestamp(record.createdAt) ||
    !isIsoTimestamp(record.expiresAt)
  ) {
    throw new SocialDomainError("social_unavailable");
  }
  return Object.freeze({
    friend_request_id: record.friendRequestId,
    counterparty: Object.freeze({
      public_profile_id: record.counterpartyPublicProfileId,
      profile_code: record.counterpartyProfileCode,
      alias: record.counterpartyAlias,
      avatar_ref: record.counterpartyAvatarRef,
    }),
    direction: record.direction,
    status: record.status,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
  });
}

function operationResource(
  record: SocialOperationRecord,
): SocialOperationResource {
  const succeeded = record.status === "succeeded";
  if (
    !uuidV4Pattern.test(record.operationId) ||
    !["friend_request_send", "friend_request_decide"].includes(record.kind) ||
    !["succeeded", "failed"].includes(record.status) ||
    !isIsoTimestamp(record.createdAt) ||
    !isIsoTimestamp(record.updatedAt) ||
    (succeeded && (record.result === null || record.error !== null)) ||
    (!succeeded && (record.result !== null || record.error === null)) ||
    (record.result !== null &&
      (!uuidPattern.test(record.result.friendRequestId) ||
        !["pending", "accepted", "rejected", "expired"].includes(
          record.result.status,
        ))) ||
    (record.error !== null && !safeErrorCodes.has(record.error.code))
  ) {
    throw new SocialDomainError("social_unavailable");
  }
  return Object.freeze({
    operation_id: record.operationId,
    kind: record.kind,
    status: record.status,
    terminal: true,
    retry_after_ms: null,
    result:
      record.result === null
        ? null
        : Object.freeze({
            friend_request_id: record.result.friendRequestId,
            status: record.result.status,
          }),
    error:
      record.error === null ? null : Object.freeze({ code: record.error.code }),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  });
}

function translateRepositoryError(error: unknown): never {
  if (error instanceof SocialPrivacyVersionConflictError) {
    throw new SocialDomainError("version_conflict");
  }
  if (error instanceof SocialIdempotencyConflictError) {
    throw new SocialDomainError("idempotency_conflict");
  }
  if (error instanceof SocialTargetUnavailableError) {
    throw new SocialDomainError("target_unavailable");
  }
  if (error instanceof SocialProfileRequiredError) {
    throw new SocialDomainError("profile_required");
  }
  if (error instanceof SocialIncomingRequestPendingError) {
    throw new SocialDomainError("incoming_request_pending");
  }
  if (error instanceof SocialOutgoingRequestPendingError) {
    throw new SocialDomainError("outgoing_request_pending");
  }
  if (error instanceof SocialAlreadyFriendsError) {
    throw new SocialDomainError("already_friends");
  }
  if (error instanceof SocialRequestCooldownError) {
    throw new SocialDomainError("friend_request_cooldown");
  }
  if (error instanceof SocialFriendRequestNotFoundError) {
    throw new SocialDomainError("friend_request_not_found");
  }
  if (error instanceof SocialFriendRequestAlreadyDecidedError) {
    throw new SocialDomainError("friend_request_already_decided");
  }
  if (error instanceof SocialRepositoryUnavailableError) {
    throw new SocialDomainError("social_unavailable");
  }
  throw error;
}

function parseRequestId(value: string): string {
  if (!uuidV4Pattern.test(value)) {
    throw new SocialDomainError("invalid_request");
  }
  return value;
}

function parseIdempotencyKey(value: string): string {
  if (!uuidV4Pattern.test(value)) {
    throw new SocialDomainError("invalid_request");
  }
  return value;
}

async function consumeQuotaForNewSocialCommand(input: {
  readonly repository: SocialRepository;
  readonly mutationQuota: SocialMutationQuota;
  readonly command: PreflightSocialCommandInput;
  readonly quota: SocialMutationQuotaInput;
}): Promise<void> {
  const initial = await input.repository.preflightSocialCommand(input.command);
  if (initial.status === "replay") {
    return;
  }
  try {
    await input.mutationQuota.consume(input.quota);
  } catch (error) {
    if (
      error instanceof SocialMutationRateLimitedError ||
      error instanceof SocialMutationQuotaUnavailableError
    ) {
      const afterQuotaFailure = await input.repository.preflightSocialCommand(
        input.command,
      );
      if (afterQuotaFailure.status === "replay") {
        return;
      }
    }
    throw error;
  }
}

export function createSocialService(input: {
  readonly repository: SocialRepository;
  readonly searchQuota: AliasSearchQuota;
  readonly mutationQuota: SocialMutationQuota;
  readonly cursorCodec: SocialCursorCodec;
}): SocialService {
  return Object.freeze({
    async getSocialPrivacy(
      request: OwnerInput,
    ): Promise<SocialPrivacyResource> {
      const owner = principal(request.principal);
      try {
        return privacyResource(
          await input.repository.getSocialPrivacy(owner.userId),
          owner.userId,
        );
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async replaceSocialPrivacy(
      request: ReplaceSocialPrivacyServiceInput,
    ): Promise<SocialPrivacyResource> {
      const owner = principal(request.principal);
      let replacement;
      try {
        replacement = parseSocialPrivacyReplacement(request.body);
      } catch {
        throw new SocialDomainError("invalid_request");
      }
      try {
        const record = await input.repository.replaceSocialPrivacy({
          ownerUserId: owner.userId,
          expectedVersion: replacement.expected_version,
          privacy: replacement.social_privacy,
        });
        if (record === null) {
          throw new SocialRepositoryUnavailableError();
        }
        return privacyResource(record, owner.userId);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async listFriends(
      request: ListFriendsServiceInput,
    ): Promise<FriendListResource> {
      const owner = principal(request.principal);
      let limit: number;
      let beforeAcceptedAt: string | undefined;
      let beforeFriendshipId: string | undefined;
      try {
        if (request.cursor !== undefined) {
          if (
            request.limit !== undefined ||
            typeof request.cursor !== "string"
          ) {
            throw new Error("invalid cursor query");
          }
          const decoded = input.cursorCodec.decode({
            cursor: request.cursor,
            ownerUserId: owner.userId,
            route: "friends",
            filter: "accepted",
          });
          limit = decoded.limit;
          beforeAcceptedAt = decoded.lastAt;
          beforeFriendshipId = decoded.lastId;
        } else {
          limit = parseSocialListLimit(request.limit);
        }
      } catch {
        throw new SocialDomainError("invalid_request");
      }
      try {
        const records = await input.repository.listFriends({
          ownerUserId: owner.userId,
          limit: limit + 1,
          ...(beforeAcceptedAt === undefined || beforeFriendshipId === undefined
            ? {}
            : { beforeAcceptedAt, beforeFriendshipId }),
        });
        const hasMore = records.length > limit;
        const page = records.slice(0, limit);
        const items = Object.freeze(page.map(friendResource));
        const last = page.at(-1);
        return Object.freeze({
          items,
          next_cursor:
            hasMore && last !== undefined
              ? input.cursorCodec.encode({
                  ownerUserId: owner.userId,
                  route: "friends",
                  filter: "accepted",
                  limit,
                  lastAt: last.acceptedAt,
                  lastId: last.friendshipId,
                })
              : null,
        });
      } catch (error) {
        if (error instanceof InvalidSocialCursorError) {
          throw new SocialDomainError("invalid_request");
        }
        return translateRepositoryError(error);
      }
    },

    async searchFriends(
      request: SearchFriendsServiceInput,
    ): Promise<FriendSearchResource> {
      const owner = principal(request.principal);
      let aliasPrefix: string;
      let limit: number;
      try {
        aliasPrefix = parseAliasSearchPrefix(request.aliasPrefix);
        limit = parseAliasSearchLimit(request.limit);
      } catch {
        throw new SocialDomainError("invalid_request");
      }
      try {
        await input.searchQuota.consume({
          scope: "public",
          userId: owner.userId,
          canonicalClientIp: request.canonicalClientIp,
          signal: request.signal,
        });
        const records = await input.repository.searchFriends({
          ownerUserId: owner.userId,
          aliasPrefix,
          limit: Math.min(limit + 1, aliasSearchLimits.maximum + 1),
        });
        request.signal.throwIfAborted();
        return Object.freeze({
          items: Object.freeze(records.slice(0, limit).map(searchResource)),
          truncated: records.length > limit,
        });
      } catch (error) {
        if (error instanceof AliasSearchRateLimitedError) {
          throw new SocialDomainError("search_rate_limited");
        }
        if (error instanceof AliasSearchQuotaUnavailableError) {
          throw new SocialDomainError("social_unavailable");
        }
        return translateRepositoryError(error);
      }
    },

    async sendFriendRequest(
      request: SendFriendRequestServiceInput,
    ): Promise<SocialOperationResource> {
      const owner = principal(request.principal);
      let body;
      let idempotencyKey: string;
      try {
        body = parseFriendRequestSend(request.body);
        idempotencyKey = parseIdempotencyKey(request.idempotencyKey);
        parseRequestId(request.requestId);
      } catch {
        throw new SocialDomainError("invalid_request");
      }
      const requestSha256 = digestFriendRequestSend(body);
      try {
        await consumeQuotaForNewSocialCommand({
          repository: input.repository,
          mutationQuota: input.mutationQuota,
          command: {
            ownerUserId: owner.userId,
            idempotencyKey,
            requestSha256,
            kind: "friend_request_send",
          },
          quota: {
            capability: "friend_request_send",
            userId: owner.userId,
            canonicalClientIp: request.canonicalClientIp,
            targetRef: body.target_public_profile_id,
            signal: request.signal,
          },
        });
        const result = await input.repository.sendFriendRequest({
          ownerUserId: owner.userId,
          requestId: request.requestId,
          idempotencyKey,
          requestSha256,
          targetPublicProfileId: body.target_public_profile_id,
        });
        request.signal.throwIfAborted();
        if (
          result.operation.operationId !== idempotencyKey ||
          result.operation.kind !== "friend_request_send" ||
          result.operation.result?.status !== "pending"
        ) {
          throw new SocialRepositoryUnavailableError();
        }
        return operationResource(result.operation);
      } catch (error) {
        if (error instanceof SocialMutationRateLimitedError) {
          throw new SocialDomainError("social_rate_limited");
        }
        if (error instanceof SocialMutationQuotaUnavailableError) {
          throw new SocialDomainError("social_unavailable");
        }
        return translateRepositoryError(error);
      }
    },

    async listFriendRequests(
      request: ListFriendRequestsServiceInput,
    ): Promise<FriendRequestListResource> {
      const owner = principal(request.principal);
      if (
        (request.direction !== "incoming" &&
          request.direction !== "outgoing") ||
        request.status !== "pending"
      ) {
        throw new SocialDomainError("invalid_request");
      }
      const direction = request.direction;
      const filter = `direction=${direction}&status=pending`;
      let limit: number;
      let beforeCreatedAt: string | undefined;
      let beforeFriendRequestId: string | undefined;
      try {
        if (request.cursor !== undefined) {
          if (
            request.limit !== undefined ||
            typeof request.cursor !== "string"
          ) {
            throw new Error("invalid cursor query");
          }
          const decoded = input.cursorCodec.decode({
            cursor: request.cursor,
            ownerUserId: owner.userId,
            route: "friend_requests",
            filter,
          });
          limit = decoded.limit;
          beforeCreatedAt = decoded.lastAt;
          beforeFriendRequestId = decoded.lastId;
        } else {
          limit = parseSocialListLimit(request.limit);
        }
      } catch {
        throw new SocialDomainError("invalid_request");
      }
      try {
        const records = await input.repository.listFriendRequests({
          ownerUserId: owner.userId,
          direction,
          status: "pending",
          limit: limit + 1,
          ...(beforeCreatedAt === undefined ||
          beforeFriendRequestId === undefined
            ? {}
            : { beforeCreatedAt, beforeFriendRequestId }),
        });
        const hasMore = records.length > limit;
        const page = records.slice(0, limit);
        const items = Object.freeze(
          page.map((record) => friendRequestResource(record, direction)),
        );
        const last = page.at(-1);
        return Object.freeze({
          items,
          next_cursor:
            hasMore && last !== undefined
              ? input.cursorCodec.encode({
                  ownerUserId: owner.userId,
                  route: "friend_requests",
                  filter,
                  limit,
                  lastAt: last.createdAt,
                  lastId: last.friendRequestId,
                })
              : null,
        });
      } catch (error) {
        if (error instanceof InvalidSocialCursorError) {
          throw new SocialDomainError("invalid_request");
        }
        return translateRepositoryError(error);
      }
    },

    async decideFriendRequest(
      request: DecideFriendRequestServiceInput,
    ): Promise<SocialOperationResource> {
      const owner = principal(request.principal);
      let body;
      let friendRequestId: string;
      let idempotencyKey: string;
      try {
        body = parseFriendRequestDecision(request.body);
        friendRequestId = parseSocialUuid(request.friendRequestId);
        idempotencyKey = parseIdempotencyKey(request.idempotencyKey);
        parseRequestId(request.requestId);
      } catch {
        throw new SocialDomainError("invalid_request");
      }
      const requestSha256 = digestFriendRequestDecision(friendRequestId, body);
      try {
        await consumeQuotaForNewSocialCommand({
          repository: input.repository,
          mutationQuota: input.mutationQuota,
          command: {
            ownerUserId: owner.userId,
            idempotencyKey,
            requestSha256,
            kind: "friend_request_decide",
          },
          quota: {
            capability: "friend_request_decide",
            userId: owner.userId,
            canonicalClientIp: request.canonicalClientIp,
            targetRef: friendRequestId,
            signal: request.signal,
          },
        });
        const result = await input.repository.decideFriendRequest({
          ownerUserId: owner.userId,
          requestId: request.requestId,
          idempotencyKey,
          requestSha256,
          friendRequestId,
          decision: body.decision,
        });
        request.signal.throwIfAborted();
        const expectedStatus =
          body.decision === "accept" ? "accepted" : "rejected";
        if (
          result.operation.operationId !== idempotencyKey ||
          result.operation.kind !== "friend_request_decide" ||
          result.operation.result?.friendRequestId !== friendRequestId ||
          result.operation.result.status !== expectedStatus
        ) {
          throw new SocialRepositoryUnavailableError();
        }
        return operationResource(result.operation);
      } catch (error) {
        if (error instanceof SocialMutationRateLimitedError) {
          throw new SocialDomainError("social_rate_limited");
        }
        if (error instanceof SocialMutationQuotaUnavailableError) {
          throw new SocialDomainError("social_unavailable");
        }
        return translateRepositoryError(error);
      }
    },

    async getOperation(
      request: GetSocialOperationServiceInput,
    ): Promise<SocialOperationResource> {
      const owner = principal(request.principal);
      let operationId: string;
      try {
        operationId = parseIdempotencyKey(String(request.operationId));
      } catch {
        throw new SocialDomainError("invalid_request");
      }
      try {
        const operation = await input.repository.getSocialOperation(
          owner.userId,
          operationId,
        );
        if (operation === null) {
          throw new SocialDomainError("social_operation_not_found");
        }
        return operationResource(operation);
      } catch (error) {
        if (error instanceof SocialDomainError) {
          throw error;
        }
        return translateRepositoryError(error);
      }
    },
  });
}
