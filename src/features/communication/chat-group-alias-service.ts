import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  AliasDirectoryRepositoryUnavailableError,
  GroupAliasImmutableRepositoryError,
  GroupAliasUnavailableRepositoryError,
  type AliasDirectoryRepository,
  type GroupAliasRecord,
} from "../../database/alias-directory-repository.js";
import {
  StreamGroupMemberGatewayUnavailableError,
  StreamGroupMemberNotFoundError,
  type StreamGroupMemberGateway,
} from "../../integrations/stream/group-member-gateway.js";
import {
  parseAliasSearchLimit,
  parseAliasSearchPrefix,
  parseCommunicationGroupId,
  parseGroupAlias,
  parseStreamChannelId,
  type CommunicationGroupResource,
  type GroupAliasResource,
  type GroupAliasSearchResource,
} from "../identity/alias-contract.js";
import { parseAliasPrincipal } from "../identity/alias-principal.js";
import {
  AliasSearchQuotaUnavailableError,
  type AliasSearchQuota,
} from "../identity/alias-search-quota.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";

const maximumGroupAliasCandidates = 99;

export interface ResolveCommunicationGroupInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly streamChannelId: unknown;
  readonly signal: AbortSignal;
}

export interface GetCurrentGroupAliasInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly groupId: unknown;
  readonly signal: AbortSignal;
}

export interface PutCurrentGroupAliasInput extends GetCurrentGroupAliasInput {
  readonly alias: unknown;
}

export interface SearchGroupAliasesInput extends GetCurrentGroupAliasInput {
  readonly aliasPrefix: unknown;
  readonly limit: unknown;
  readonly canonicalClientIp: string;
}

export interface ChatGroupAliasService {
  resolveGroup(
    input: ResolveCommunicationGroupInput,
  ): Promise<CommunicationGroupResource>;
  getCurrentAlias(
    input: GetCurrentGroupAliasInput,
  ): Promise<GroupAliasResource>;
  putCurrentAlias(
    input: PutCurrentGroupAliasInput,
  ): Promise<GroupAliasResource>;
  searchAliases(
    input: SearchGroupAliasesInput,
  ): Promise<GroupAliasSearchResource>;
}

export class InvalidChatGroupAliasRequestError extends Error {
  constructor() {
    super("The chat group alias request is invalid");
    this.name = "InvalidChatGroupAliasRequestError";
  }
}

export class ChatGroupNotFoundError extends Error {
  constructor() {
    super("The chat group does not exist for the current member");
    this.name = "ChatGroupNotFoundError";
  }
}

export class CurrentGroupAliasNotFoundError extends Error {
  constructor() {
    super("The current group alias does not exist");
    this.name = "CurrentGroupAliasNotFoundError";
  }
}

export class GroupAliasImmutableError extends Error {
  constructor() {
    super("The current group alias is immutable");
    this.name = "GroupAliasImmutableError";
  }
}

export class GroupAliasUnavailableError extends Error {
  constructor() {
    super("The requested group alias is unavailable");
    this.name = "GroupAliasUnavailableError";
  }
}

export class ChatGroupAliasUnavailableError extends Error {
  constructor() {
    super("Chat group aliases are unavailable");
    this.name = "ChatGroupAliasUnavailableError";
  }
}

function toAliasResource(record: GroupAliasRecord): GroupAliasResource {
  return Object.freeze({
    group_alias_id: record.groupAliasId,
    alias: record.alias,
    projection_state: record.projectionState,
  });
}

function parsePrincipalAndGroup(
  principal: AuthenticatedLoopPrincipal,
  groupId: unknown,
): Readonly<{ principal: AuthenticatedLoopPrincipal; groupId: string }> {
  try {
    return Object.freeze({
      principal: parseAliasPrincipal(principal),
      groupId: parseCommunicationGroupId(groupId),
    });
  } catch {
    throw new InvalidChatGroupAliasRequestError();
  }
}

function mapGatewayError(error: unknown): never {
  if (error instanceof StreamGroupMemberNotFoundError) {
    throw new ChatGroupNotFoundError();
  }
  if (error instanceof StreamGroupMemberGatewayUnavailableError) {
    throw new ChatGroupAliasUnavailableError();
  }
  throw error;
}

async function requireGroup(
  repository: AliasDirectoryRepository,
  gateway: StreamGroupMemberGateway,
  groupId: string,
  streamUserId: string,
  signal: AbortSignal,
) {
  let group;
  try {
    group = await repository.findCommunicationGroup(groupId);
  } catch (error) {
    if (error instanceof AliasDirectoryRepositoryUnavailableError) {
      throw new ChatGroupAliasUnavailableError();
    }
    throw error;
  }
  if (group === null) {
    throw new ChatGroupNotFoundError();
  }
  try {
    await gateway.assertCurrentMember({
      channelId: group.streamChannelId,
      streamUserId,
      signal,
    });
  } catch (error) {
    return mapGatewayError(error);
  }
  return group;
}

export function createUnavailableChatGroupAliasService(): ChatGroupAliasService {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ChatGroupAliasUnavailableError());
  return Object.freeze({
    resolveGroup: unavailable,
    getCurrentAlias: unavailable,
    putCurrentAlias: unavailable,
    searchAliases: unavailable,
  });
}

export function createChatGroupAliasService(input: {
  readonly repository: AliasDirectoryRepository;
  readonly gateway: StreamGroupMemberGateway;
  readonly quota: AliasSearchQuota;
}): ChatGroupAliasService {
  return Object.freeze({
    async resolveGroup(
      request: ResolveCommunicationGroupInput,
    ): Promise<CommunicationGroupResource> {
      let principal: AuthenticatedLoopPrincipal;
      let streamChannelId: string;
      try {
        principal = parseAliasPrincipal(request.principal);
        streamChannelId = parseStreamChannelId(request.streamChannelId);
      } catch {
        throw new InvalidChatGroupAliasRequestError();
      }
      try {
        await input.gateway.assertCurrentMember({
          channelId: streamChannelId,
          streamUserId: principal.streamUserId,
          signal: request.signal,
        });
      } catch (error) {
        return mapGatewayError(error);
      }
      try {
        const group =
          await input.repository.resolveCommunicationGroup(streamChannelId);
        return Object.freeze({ group_id: group.groupId });
      } catch (error) {
        if (error instanceof AliasDirectoryRepositoryUnavailableError) {
          throw new ChatGroupAliasUnavailableError();
        }
        throw error;
      }
    },

    async getCurrentAlias(
      request: GetCurrentGroupAliasInput,
    ): Promise<GroupAliasResource> {
      const parsed = parsePrincipalAndGroup(request.principal, request.groupId);
      await requireGroup(
        input.repository,
        input.gateway,
        parsed.groupId,
        parsed.principal.streamUserId,
        request.signal,
      );
      try {
        const alias = await input.repository.findGroupAlias(
          parsed.groupId,
          parsed.principal.userId,
        );
        if (alias === null) {
          throw new CurrentGroupAliasNotFoundError();
        }
        return toAliasResource(alias);
      } catch (error) {
        if (error instanceof AliasDirectoryRepositoryUnavailableError) {
          throw new ChatGroupAliasUnavailableError();
        }
        throw error;
      }
    },

    async putCurrentAlias(
      request: PutCurrentGroupAliasInput,
    ): Promise<GroupAliasResource> {
      const parsed = parsePrincipalAndGroup(request.principal, request.groupId);
      let alias: string;
      try {
        alias = parseGroupAlias(request.alias);
      } catch {
        throw new InvalidChatGroupAliasRequestError();
      }
      const group = await requireGroup(
        input.repository,
        input.gateway,
        parsed.groupId,
        parsed.principal.streamUserId,
        request.signal,
      );
      let reservation: GroupAliasRecord;
      try {
        reservation = await input.repository.reserveGroupAlias({
          groupId: parsed.groupId,
          ownerUserId: parsed.principal.userId,
          alias,
        });
      } catch (error) {
        if (error instanceof GroupAliasImmutableRepositoryError) {
          throw new GroupAliasImmutableError();
        }
        if (error instanceof GroupAliasUnavailableRepositoryError) {
          throw new GroupAliasUnavailableError();
        }
        if (error instanceof AliasDirectoryRepositoryUnavailableError) {
          throw new ChatGroupAliasUnavailableError();
        }
        throw error;
      }

      try {
        await input.gateway.projectAlias({
          channelId: group.streamChannelId,
          streamUserId: parsed.principal.streamUserId,
          groupAliasId: reservation.groupAliasId,
          alias: reservation.alias,
          signal: request.signal,
        });
      } catch (error) {
        return mapGatewayError(error);
      }

      try {
        return toAliasResource(
          await input.repository.confirmGroupAliasProjection({
            groupAliasId: reservation.groupAliasId,
            groupId: parsed.groupId,
            ownerUserId: parsed.principal.userId,
          }),
        );
      } catch (error) {
        if (error instanceof AliasDirectoryRepositoryUnavailableError) {
          throw new ChatGroupAliasUnavailableError();
        }
        throw error;
      }
    },

    async searchAliases(
      request: SearchGroupAliasesInput,
    ): Promise<GroupAliasSearchResource> {
      const parsed = parsePrincipalAndGroup(request.principal, request.groupId);
      let aliasPrefix: string;
      let limit: number;
      try {
        aliasPrefix = parseAliasSearchPrefix(request.aliasPrefix);
        limit = parseAliasSearchLimit(request.limit);
      } catch {
        throw new InvalidChatGroupAliasRequestError();
      }

      try {
        await input.quota.consume({
          scope: "group",
          userId: parsed.principal.userId,
          canonicalClientIp: request.canonicalClientIp,
          signal: request.signal,
        });
      } catch (error) {
        if (error instanceof AliasSearchQuotaUnavailableError) {
          throw new ChatGroupAliasUnavailableError();
        }
        throw error;
      }

      let group;
      let candidates: readonly GroupAliasRecord[];
      try {
        group = await input.repository.findCommunicationGroup(parsed.groupId);
        if (group === null) {
          throw new ChatGroupNotFoundError();
        }
        candidates = await input.repository.searchGroupAliases({
          groupId: parsed.groupId,
          requesterUserId: parsed.principal.userId,
          aliasPrefix,
          limit: maximumGroupAliasCandidates,
        });
      } catch (error) {
        if (error instanceof AliasDirectoryRepositoryUnavailableError) {
          throw new ChatGroupAliasUnavailableError();
        }
        throw error;
      }

      const candidateStreamIds = candidates.map((candidate) =>
        deriveStreamUserId(candidate.ownerUserId),
      );
      let currentMembers: ReadonlySet<string>;
      try {
        currentMembers = await input.gateway.filterCurrentMembers({
          channelId: group.streamChannelId,
          streamUserIds: [parsed.principal.streamUserId, ...candidateStreamIds],
          signal: request.signal,
        });
      } catch (error) {
        return mapGatewayError(error);
      }
      if (!currentMembers.has(parsed.principal.streamUserId)) {
        throw new ChatGroupNotFoundError();
      }

      const visible = candidates.filter(
        (candidate, index) =>
          candidate.projectionState === "confirmed" &&
          currentMembers.has(candidateStreamIds[index] ?? ""),
      );
      const truncated =
        candidates.length === maximumGroupAliasCandidates ||
        visible.length > limit;
      const items = visible.slice(0, limit).map((candidate) =>
        Object.freeze({
          group_alias_id: candidate.groupAliasId,
          alias: candidate.alias,
        }),
      );
      return Object.freeze({ items: Object.freeze(items), truncated });
    },
  });
}
