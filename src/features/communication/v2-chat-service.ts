import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  StreamChannelProjectionMismatchError,
  type StreamCommunityChannelGateway,
} from "../../integrations/stream/channel-gateway.js";
import type { StreamTokenProduct } from "../../integrations/stream/token-issuer.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import type { ChatOperationResource } from "./chat-channel-contract.js";
import {
  ChatChannelIdempotencyConflictError,
  ChatChannelTargetUnavailableError,
  ChatChannelUnavailableError,
  ChatOperationNotFoundError,
  InvalidChatChannelServiceRequestError,
  type ChatChannelService,
} from "./chat-channel-service.js";
import {
  communicationCommandDigest,
  parseCommunicationOpaqueId,
} from "./communication-contract.js";
import {
  CommunicationDataStaleError,
  CommunicationIdempotencyConflictError,
  CommunicationNotFoundError,
  CommunicationPermissionDeniedError,
  CommunicationRepositoryUnavailableError,
  type CommunicationRepository,
} from "./communication-repository.js";
import {
  StreamTokenQuotaExceededError,
  StreamTokenUnavailableError,
  type StreamTokenService,
} from "./stream-token-service.js";

/**
 * V2 wrapper over the frozen V1 chat surface (Decision 0032). It changes the
 * projection only: camelCase fields, the seven-field V2 error envelope, and a
 * `/v2/chat/operations/{operationId}` polling locator. The durable operation
 * state machine, its idempotency binding, and the Stream write path stay
 * exactly as Decision 0025 delivered them; `/v1` is untouched.
 */

export const v2ChatOperationKinds = [
  "groupCreate",
  "directGetOrCreate",
] as const;
export type V2ChatOperationKind = (typeof v2ChatOperationKinds)[number];

export const v2ChatOperationStatuses = [
  "pending",
  "submitting",
  "reconciling",
  "succeeded",
  "failed",
  "operatorRequired",
] as const;
export type V2ChatOperationStatus = (typeof v2ChatOperationStatuses)[number];

export interface V2ChatGroupResult {
  readonly groupId: string;
  readonly name: string;
  readonly friendPublicProfileIds: readonly string[];
  readonly streamCid: string;
}

export interface V2ChatDirectResult {
  readonly targetPublicProfileId: string;
  readonly streamCid: string;
}

export interface V2ChatOperationResource {
  readonly operationId: string;
  readonly kind: V2ChatOperationKind;
  readonly status: V2ChatOperationStatus;
  readonly terminal: boolean;
  readonly retryAfterMs: number | null;
  readonly result: V2ChatGroupResult | V2ChatDirectResult | null;
  readonly error: Readonly<{ code: string }> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface V2StreamTokenResource {
  readonly apiKey: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly user: Readonly<{ id: string }>;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface V2ChatGroupMembershipResource {
  readonly groupId: string;
  readonly membership: null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface V2ChatCommandInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface V2ChatOperationReadInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly operationId: unknown;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface V2StreamTokenInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly product: StreamTokenProduct;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

export interface V2ChatGroupLeaveInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly groupId: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface V2ChatService {
  issueToken(input: V2StreamTokenInput): Promise<V2StreamTokenResource>;
  createGroup(input: V2ChatCommandInput): Promise<V2ChatOperationResource>;
  getOrCreateDirect(
    input: V2ChatCommandInput,
  ): Promise<V2ChatOperationResource>;
  getOperation(
    input: V2ChatOperationReadInput,
  ): Promise<V2ChatOperationResource>;
  leaveGroup(
    input: V2ChatGroupLeaveInput,
  ): Promise<V2ChatGroupMembershipResource>;
}

function mapChatError(error: unknown): never {
  if (error instanceof InvalidChatChannelServiceRequestError) {
    throw V2ApiError.invalidRequest();
  }
  if (error instanceof ChatChannelIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (
    error instanceof ChatChannelTargetUnavailableError ||
    error instanceof ChatOperationNotFoundError
  ) {
    throw V2ApiError.notFound();
  }
  if (error instanceof ChatChannelUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  if (error instanceof CommunicationNotFoundError) {
    throw V2ApiError.notFound();
  }
  if (error instanceof CommunicationPermissionDeniedError) {
    throw V2ApiError.fromCode("PERMISSION_DENIED");
  }
  if (error instanceof CommunicationDataStaleError) {
    throw V2ApiError.fromCode("DATA_STALE");
  }
  if (error instanceof CommunicationIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof CommunicationRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

async function chatCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapChatError(error);
  }
}

const kindProjection: Readonly<Record<string, V2ChatOperationKind>> =
  Object.freeze({
    group_create: "groupCreate",
    direct_get_or_create: "directGetOrCreate",
  });

const statusProjection: Readonly<Record<string, V2ChatOperationStatus>> =
  Object.freeze({
    pending: "pending",
    submitting: "submitting",
    reconciling: "reconciling",
    succeeded: "succeeded",
    failed: "failed",
    operator_required: "operatorRequired",
  });

function projectOperation(
  resource: ChatOperationResource,
): V2ChatOperationResource {
  const kind = kindProjection[resource.kind];
  const status = statusProjection[resource.status];
  if (kind === undefined || status === undefined) {
    throw V2ApiError.capabilityUnavailable();
  }
  let result: V2ChatOperationResource["result"] = null;
  if (resource.result !== null) {
    if ("group_id" in resource.result) {
      result = Object.freeze({
        groupId: resource.result.group_id,
        name: resource.result.name,
        friendPublicProfileIds: Object.freeze([
          ...resource.result.friend_public_profile_ids,
        ]),
        streamCid: resource.result.stream_cid,
      });
    } else {
      result = Object.freeze({
        targetPublicProfileId: resource.result.target_public_profile_id,
        streamCid: resource.result.stream_cid,
      });
    }
  }
  return Object.freeze({
    operationId: resource.operation_id,
    kind,
    status,
    terminal: resource.terminal,
    retryAfterMs: resource.retry_after_ms,
    result,
    error:
      resource.error === null
        ? null
        : Object.freeze({ code: resource.error.code }),
    createdAt: resource.created_at,
    updatedAt: resource.updated_at,
    contractVersion: v2ContractVersion,
  });
}

function projectGroupBody(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw V2ApiError.invalidRequest();
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "friendPublicProfileIds" ||
    keys[1] !== "name"
  ) {
    throw V2ApiError.invalidRequest();
  }
  return {
    name: body["name"],
    friend_public_profile_ids: body["friendPublicProfileIds"],
  };
}

function projectDirectBody(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw V2ApiError.invalidRequest();
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "targetPublicProfileId") {
    throw V2ApiError.invalidRequest();
  }
  return { target_public_profile_id: body["targetPublicProfileId"] };
}

export interface V2ChatServiceOptions {
  readonly chatChannelService: ChatChannelService;
  readonly streamTokenService: StreamTokenService;
  readonly repository: CommunicationRepository;
  readonly channelGateway: StreamCommunityChannelGateway;
}

export function createUnavailableV2ChatService(): V2ChatService {
  const unavailable = (): Promise<never> =>
    Promise.reject(V2ApiError.capabilityUnavailable());
  return Object.freeze({
    issueToken: unavailable,
    createGroup: unavailable,
    getOrCreateDirect: unavailable,
    getOperation: unavailable,
    leaveGroup: unavailable,
  });
}

export function createV2ChatService(
  options: V2ChatServiceOptions,
): V2ChatService {
  return Object.freeze({
    async issueToken(
      input: V2StreamTokenInput,
    ): Promise<V2StreamTokenResource> {
      try {
        const result = await options.streamTokenService.issueToken({
          principal: input.principal,
          product: input.product,
          canonicalClientIp: input.canonicalClientIp,
          signal: input.signal,
        });
        return Object.freeze({
          apiKey: result.api_key,
          token: result.token,
          expiresAt: result.expires_at,
          user: Object.freeze({ id: result.user.id }),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        if (error instanceof StreamTokenQuotaExceededError) {
          throw V2ApiError.rateLimited();
        }
        if (error instanceof StreamTokenUnavailableError) {
          throw V2ApiError.capabilityUnavailable();
        }
        throw error;
      }
    },

    async createGroup(
      input: V2ChatCommandInput,
    ): Promise<V2ChatOperationResource> {
      const body = projectGroupBody(input.body);
      return projectOperation(
        await chatCall(() =>
          options.chatChannelService.createGroup({
            principal: input.principal,
            operationId: input.idempotencyKey,
            requestId: input.requestId,
            body,
            signal: input.signal,
          }),
        ),
      );
    },

    async getOrCreateDirect(
      input: V2ChatCommandInput,
    ): Promise<V2ChatOperationResource> {
      const body = projectDirectBody(input.body);
      return projectOperation(
        await chatCall(() =>
          options.chatChannelService.getOrCreateDirect({
            principal: input.principal,
            operationId: input.idempotencyKey,
            requestId: input.requestId,
            body,
            signal: input.signal,
          }),
        ),
      );
    },

    async getOperation(
      input: V2ChatOperationReadInput,
    ): Promise<V2ChatOperationResource> {
      return projectOperation(
        await chatCall(() =>
          options.chatChannelService.getOperation({
            principal: input.principal,
            operationId: input.operationId,
            requestId: input.requestId,
            signal: input.signal,
          }),
        ),
      );
    },

    /**
     * Leaving a small group removes the caller from the Stream channel first
     * and only then commits the LOOP membership removal. Stream treats
     * removing a non-member as a success, so retrying after an unknown
     * provider result is safe and can never leave the account inside a channel
     * it believes it left.
     */
    async leaveGroup(
      input: V2ChatGroupLeaveInput,
    ): Promise<V2ChatGroupMembershipResource> {
      const groupId = parseCommunicationOpaqueId(input.groupId);
      const preparation = await chatCall(() =>
        options.repository.prepareChatGroupLeave({
          actorUserId: input.principal.userId,
          groupId,
        }),
      );
      try {
        await options.channelGateway.removeMembers({
          channelId: preparation.streamChannelId,
          actingStreamUserId: preparation.channelCreatedByStreamUserId,
          memberStreamUserIds: [preparation.memberStreamUserId],
          signal: input.signal,
        });
        input.signal.throwIfAborted();
      } catch (error) {
        input.signal.throwIfAborted();
        if (error instanceof StreamChannelProjectionMismatchError) {
          throw V2ApiError.capabilityUnavailable();
        }
        throw V2ApiError.fromCode("PROVIDER_DISCONNECTED");
      }
      await chatCall(() =>
        options.repository.commitChatGroupLeave({
          actorUserId: input.principal.userId,
          groupId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("chatGroupLeave", [
            groupId,
          ]),
          requestId: input.requestId,
        }),
      );
      return Object.freeze({
        groupId,
        membership: null,
        contractVersion: v2ContractVersion,
      });
    },
  });
}
