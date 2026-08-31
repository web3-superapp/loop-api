import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  type StreamChannelGateway,
  type UpsertFixedStreamMessagingChannelInput,
} from "../../integrations/stream/channel-gateway.js";
import { parseAliasPrincipal } from "../identity/alias-principal.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  digestCreateChatGroupRequest,
  digestCreateDirectChannelRequest,
  isTerminalChatOperationStatus,
  parseChatOperationId,
  parseCreateChatGroupRequest,
  parseCreateDirectChannelRequest,
  type ChatOperationResource,
} from "./chat-channel-contract.js";
import {
  ChatChannelIdempotencyConflictRepositoryError,
  ChatChannelRepositoryUnavailableError,
  ChatChannelTargetUnavailableRepositoryError,
  type ChatChannelExpectation,
  type ChatChannelRepository,
  type ChatOperationRecord,
} from "./chat-channel-repository.js";

const retryAfterMilliseconds = 2_000;
const pendingDispatchTimeoutMilliseconds = 20_000;
const staleSubmissionMilliseconds = 20_000;
const notFoundGraceMilliseconds = 60_000;
const reconciliationMaximumMilliseconds = 5 * 60_000;

export interface CreateChatGroupInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly operationId: unknown;
  readonly requestId: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export type GetOrCreateDirectChannelInput = CreateChatGroupInput;

export interface GetChatOperationInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly operationId: unknown;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface ChatChannelService {
  createGroup(input: CreateChatGroupInput): Promise<ChatOperationResource>;
  getOrCreateDirect(
    input: GetOrCreateDirectChannelInput,
  ): Promise<ChatOperationResource>;
  getOperation(input: GetChatOperationInput): Promise<ChatOperationResource>;
}

export class InvalidChatChannelServiceRequestError extends Error {
  constructor() {
    super("The Chat channel request is invalid");
    this.name = "InvalidChatChannelServiceRequestError";
  }
}

export class ChatChannelIdempotencyConflictError extends Error {
  constructor() {
    super("The Chat channel idempotency key conflicts");
    this.name = "ChatChannelIdempotencyConflictError";
  }
}

export class ChatChannelTargetUnavailableError extends Error {
  constructor() {
    super("The Chat channel target is unavailable");
    this.name = "ChatChannelTargetUnavailableError";
  }
}

export class ChatOperationNotFoundError extends Error {
  constructor() {
    super("The Chat operation does not exist");
    this.name = "ChatOperationNotFoundError";
  }
}

export class ChatChannelUnavailableError extends Error {
  constructor() {
    super("Chat channel coordination is unavailable");
    this.name = "ChatChannelUnavailableError";
  }
}

function toResource(record: ChatOperationRecord): ChatOperationResource {
  const terminal = isTerminalChatOperationStatus(record.status);
  let result: ChatOperationResource["result"] = null;
  if (record.status === "succeeded") {
    if (
      record.kind === "group_create" &&
      record.groupId !== null &&
      record.groupName !== null &&
      record.targetPublicProfileId === null
    ) {
      result = Object.freeze({
        group_id: record.groupId,
        name: record.groupName,
        friend_public_profile_ids: Object.freeze([
          ...record.friendPublicProfileIds,
        ]),
        stream_cid: `messaging:${record.channelId}`,
      });
    } else if (
      record.kind === "direct_get_or_create" &&
      record.groupId === null &&
      record.groupName === null &&
      record.friendPublicProfileIds.length === 0 &&
      record.targetPublicProfileId !== null
    ) {
      result = Object.freeze({
        target_public_profile_id: record.targetPublicProfileId,
        stream_cid: `messaging:${record.channelId}`,
      });
    } else {
      throw new ChatChannelUnavailableError();
    }
  }
  if (!terminal && record.errorCode !== null) {
    throw new ChatChannelUnavailableError();
  }
  const error =
    record.status === "failed" || record.status === "operator_required"
      ? Object.freeze({ code: record.errorCode ?? "result_unavailable" })
      : null;
  return Object.freeze({
    operation_id: record.operationId,
    kind: record.kind,
    status: record.status,
    terminal,
    retry_after_ms: terminal ? null : retryAfterMilliseconds,
    result,
    error,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  });
}

function parsePrincipalAndOperation(
  principal: AuthenticatedLoopPrincipal,
  operationId: unknown,
): Readonly<{ principal: AuthenticatedLoopPrincipal; operationId: string }> {
  try {
    return Object.freeze({
      principal: parseAliasPrincipal(principal),
      operationId: parseChatOperationId(operationId),
    });
  } catch {
    throw new InvalidChatChannelServiceRequestError();
  }
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof ChatChannelIdempotencyConflictRepositoryError) {
    throw new ChatChannelIdempotencyConflictError();
  }
  if (error instanceof ChatChannelTargetUnavailableRepositoryError) {
    throw new ChatChannelTargetUnavailableError();
  }
  if (error instanceof ChatChannelRepositoryUnavailableError) {
    throw new ChatChannelUnavailableError();
  }
  throw error;
}

async function repositoryCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapRepositoryError(error);
  }
}

function providerInput(
  expectation: ChatChannelExpectation,
  signal: AbortSignal,
): UpsertFixedStreamMessagingChannelInput {
  try {
    if (
      expectation.memberUserIds.length < 2 ||
      new Set(expectation.memberUserIds).size !==
        expectation.memberUserIds.length ||
      !expectation.memberUserIds.includes(expectation.createdByUserId)
    ) {
      throw new Error("Invalid persisted member set");
    }
    const base = {
      channelId: expectation.channelId,
      createdByStreamUserId: deriveStreamUserId(expectation.createdByUserId),
      memberStreamUserIds: Object.freeze(
        expectation.memberUserIds.map(deriveStreamUserId).sort(),
      ),
      signal,
    };
    if (expectation.kind === "group" && expectation.name !== null) {
      return Object.freeze({ ...base, kind: "group", name: expectation.name });
    }
    if (expectation.kind === "direct" && expectation.name === null) {
      return Object.freeze({ ...base, kind: "direct" });
    }
  } catch {
    throw new ChatChannelUnavailableError();
  }
  throw new ChatChannelUnavailableError();
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ChatChannelUnavailableError();
  }
  return parsed;
}

function cutoffTimestamp(
  now: () => Date,
  durationMilliseconds: number,
): string {
  const milliseconds = now().getTime() - durationMilliseconds;
  if (!Number.isFinite(milliseconds)) {
    throw new ChatChannelUnavailableError();
  }
  return new Date(milliseconds).toISOString();
}

export function createUnavailableChatChannelService(): ChatChannelService {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ChatChannelUnavailableError());
  return Object.freeze({
    createGroup: unavailable,
    getOrCreateDirect: unavailable,
    getOperation: unavailable,
  });
}

export function createChatChannelService(input: {
  readonly repository: ChatChannelRepository;
  readonly gateway: StreamChannelGateway;
  readonly now?: () => Date;
}): ChatChannelService {
  const now = input.now ?? (() => new Date());

  async function findRequiredOperation(
    ownerUserId: string,
    operationId: string,
  ): Promise<ChatOperationRecord> {
    const record = await repositoryCall(() =>
      input.repository.findOperation({ ownerUserId, operationId }),
    );
    if (record === null) {
      throw new ChatOperationNotFoundError();
    }
    return record;
  }

  async function reconcile(
    operation: ChatOperationRecord,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ChatOperationRecord> {
    const submittingBefore = cutoffTimestamp(now, staleSubmissionMilliseconds);
    const expectation = await repositoryCall(() =>
      input.repository.claimReconciliation({
        ownerUserId: operation.ownerUserId,
        operationId: operation.operationId,
        requestId,
        submittingBefore,
      }),
    );
    if (expectation === null) {
      return await findRequiredOperation(
        operation.ownerUserId,
        operation.operationId,
      );
    }
    const expectedProviderInput = providerInput(expectation, signal);
    try {
      const response = await input.gateway.readFixedMessagingChannel(
        expectedProviderInput,
      );
      signal.throwIfAborted();
      if (response.status === "found") {
        return await repositoryCall(() =>
          input.repository.markSucceeded({
            ownerUserId: operation.ownerUserId,
            operationId: operation.operationId,
            requestId,
          }),
        );
      }
      const latest = await findRequiredOperation(
        operation.ownerUserId,
        operation.operationId,
      );
      const attemptStartedAt = latest.attemptStartedAt;
      if (
        attemptStartedAt !== null &&
        now().getTime() - parseTimestamp(attemptStartedAt) >=
          notFoundGraceMilliseconds
      ) {
        return await repositoryCall(() =>
          input.repository.markOperatorRequired({
            ownerUserId: operation.ownerUserId,
            operationId: operation.operationId,
            requestId,
            errorCode: "stream_channel_not_created",
          }),
        );
      }
      return latest;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof StreamChannelProjectionMismatchError) {
        return await repositoryCall(() =>
          input.repository.markOperatorRequired({
            ownerUserId: operation.ownerUserId,
            operationId: operation.operationId,
            requestId,
            errorCode: "stream_channel_projection_mismatch",
          }),
        );
      }
      if (error instanceof StreamChannelGatewayUnavailableError) {
        const latest = await findRequiredOperation(
          operation.ownerUserId,
          operation.operationId,
        );
        if (
          latest.attemptStartedAt !== null &&
          now().getTime() - parseTimestamp(latest.attemptStartedAt) >=
            reconciliationMaximumMilliseconds
        ) {
          return await repositoryCall(() =>
            input.repository.markOperatorRequired({
              ownerUserId: operation.ownerUserId,
              operationId: operation.operationId,
              requestId,
              errorCode: "stream_reconciliation_unavailable",
            }),
          );
        }
        return latest;
      }
      throw error;
    }
  }

  async function refreshCallerOperation(
    operation: ChatOperationRecord,
    requestId: string,
  ): Promise<ChatOperationRecord> {
    return await repositoryCall(() =>
      input.repository.refreshOperation({
        ownerUserId: operation.ownerUserId,
        operationId: operation.operationId,
        requestId,
        pendingBefore: cutoffTimestamp(now, pendingDispatchTimeoutMilliseconds),
      }),
    );
  }

  async function settleCallerOperation(
    caller: ChatOperationRecord,
    canonical: ChatOperationRecord,
    requestId: string,
  ): Promise<ChatOperationRecord> {
    return caller.operationId === canonical.operationId
      ? canonical
      : await refreshCallerOperation(caller, requestId);
  }

  async function reconcileCanonicalDirectForCaller(
    caller: ChatOperationRecord,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ChatOperationRecord> {
    const canonical = await repositoryCall(() =>
      input.repository.findCanonicalDirectOperation({
        ownerUserId: caller.ownerUserId,
        operationId: caller.operationId,
      }),
    );
    if (canonical === null) {
      return caller;
    }
    const reconciled = await reconcile(canonical, requestId, signal);
    return await settleCallerOperation(caller, reconciled, requestId);
  }

  async function advance(
    principal: AuthenticatedLoopPrincipal,
    operation: ChatOperationRecord,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ChatOperationRecord> {
    let current = operation;
    if (isTerminalChatOperationStatus(current.status)) {
      return current;
    }
    if (current.status === "pending") {
      current = await repositoryCall(() =>
        input.repository.refreshOperation({
          ownerUserId: principal.userId,
          operationId: current.operationId,
          requestId,
          pendingBefore: cutoffTimestamp(
            now,
            pendingDispatchTimeoutMilliseconds,
          ),
        }),
      );
      if (isTerminalChatOperationStatus(current.status)) {
        return current;
      }
    }
    if (current.status === "submitting" || current.status === "reconciling") {
      return await reconcile(current, requestId, signal);
    }
    const expectation = await repositoryCall(() =>
      input.repository.claimSubmission({
        ownerUserId: principal.userId,
        operationId: current.operationId,
        requestId,
      }),
    );
    if (expectation === null) {
      const latest = await repositoryCall(() =>
        input.repository.refreshOperation({
          ownerUserId: principal.userId,
          operationId: current.operationId,
          requestId,
          pendingBefore: cutoffTimestamp(
            now,
            pendingDispatchTimeoutMilliseconds,
          ),
        }),
      );
      if (latest.status === "submitting" || latest.status === "reconciling") {
        return await reconcile(latest, requestId, signal);
      }
      return latest.status === "pending"
        ? await reconcileCanonicalDirectForCaller(latest, requestId, signal)
        : latest;
    }
    const expectedProviderInput = providerInput(expectation, signal);
    try {
      await input.gateway.upsertFixedMessagingChannel(expectedProviderInput);
      signal.throwIfAborted();
      const succeeded = await repositoryCall(() =>
        input.repository.markSucceeded({
          ownerUserId: expectation.createdByUserId,
          operationId: expectation.operationId,
          requestId,
        }),
      );
      return await settleCallerOperation(current, succeeded, requestId);
    } catch (error) {
      if (error instanceof StreamChannelProjectionMismatchError) {
        const held = await repositoryCall(() =>
          input.repository.markOperatorRequired({
            ownerUserId: expectation.createdByUserId,
            operationId: expectation.operationId,
            requestId,
            errorCode: "stream_channel_projection_mismatch",
          }),
        );
        return await settleCallerOperation(current, held, requestId);
      }
      const reconciling = await repositoryCall(() =>
        input.repository.markReconciling({
          ownerUserId: expectation.createdByUserId,
          operationId: expectation.operationId,
          requestId,
        }),
      );
      signal.throwIfAborted();
      if (error instanceof StreamChannelGatewayUnavailableError) {
        const reconciled = await reconcile(reconciling, requestId, signal);
        return await settleCallerOperation(current, reconciled, requestId);
      }
      throw error;
    }
  }

  return Object.freeze({
    async createGroup(
      request: CreateChatGroupInput,
    ): Promise<ChatOperationResource> {
      let parsed;
      let body;
      try {
        parsed = parsePrincipalAndOperation(
          request.principal,
          request.operationId,
        );
        body = parseCreateChatGroupRequest(request.body);
      } catch (error) {
        if (error instanceof InvalidChatChannelServiceRequestError) {
          throw error;
        }
        throw new InvalidChatChannelServiceRequestError();
      }
      const operation = await repositoryCall(() =>
        input.repository.prepareGroupOperation({
          operationId: parsed.operationId,
          ownerUserId: parsed.principal.userId,
          requestId: request.requestId,
          requestDigest: digestCreateChatGroupRequest(body),
          name: body.name,
          friendPublicProfileIds: body.friend_public_profile_ids,
        }),
      );
      return toResource(
        await advance(
          parsed.principal,
          operation,
          request.requestId,
          request.signal,
        ),
      );
    },

    async getOrCreateDirect(
      request: GetOrCreateDirectChannelInput,
    ): Promise<ChatOperationResource> {
      let parsed;
      let body;
      try {
        parsed = parsePrincipalAndOperation(
          request.principal,
          request.operationId,
        );
        body = parseCreateDirectChannelRequest(request.body);
      } catch (error) {
        if (error instanceof InvalidChatChannelServiceRequestError) {
          throw error;
        }
        throw new InvalidChatChannelServiceRequestError();
      }
      const operation = await repositoryCall(() =>
        input.repository.prepareDirectOperation({
          operationId: parsed.operationId,
          ownerUserId: parsed.principal.userId,
          requestId: request.requestId,
          requestDigest: digestCreateDirectChannelRequest(body),
          targetPublicProfileId: body.target_public_profile_id,
        }),
      );
      return toResource(
        await advance(
          parsed.principal,
          operation,
          request.requestId,
          request.signal,
        ),
      );
    },

    async getOperation(
      request: GetChatOperationInput,
    ): Promise<ChatOperationResource> {
      const parsed = parsePrincipalAndOperation(
        request.principal,
        request.operationId,
      );
      let operation = await findRequiredOperation(
        parsed.principal.userId,
        parsed.operationId,
      );
      if (operation.status === "pending") {
        operation = await repositoryCall(() =>
          input.repository.refreshOperation({
            ownerUserId: parsed.principal.userId,
            operationId: parsed.operationId,
            requestId: request.requestId,
            pendingBefore: cutoffTimestamp(
              now,
              pendingDispatchTimeoutMilliseconds,
            ),
          }),
        );
      }
      if (
        operation.status !== "submitting" &&
        operation.status !== "reconciling"
      ) {
        return toResource(
          operation.status === "pending"
            ? await reconcileCanonicalDirectForCaller(
                operation,
                request.requestId,
                request.signal,
              )
            : operation,
        );
      }
      return toResource(
        await reconcile(operation, request.requestId, request.signal),
      );
    },
  });
}
