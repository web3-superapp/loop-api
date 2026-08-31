import type {
  ChatOperationKind,
  ChatOperationStatus,
} from "./chat-channel-contract.js";

export interface ChatChannelExpectation {
  readonly operationId: string;
  readonly kind: "group" | "direct";
  readonly channelId: string;
  readonly createdByUserId: string;
  readonly memberUserIds: readonly string[];
  readonly name: string | null;
}

export interface ChatOperationRecord {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly kind: ChatOperationKind;
  readonly requestDigest: string;
  readonly status: ChatOperationStatus;
  readonly channelId: string;
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly friendPublicProfileIds: readonly string[];
  readonly targetPublicProfileId: string | null;
  readonly errorCode: string | null;
  readonly attemptStartedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PrepareGroupChatOperationInput {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly name: string;
  readonly friendPublicProfileIds: readonly string[];
}

export interface PrepareDirectChatOperationInput {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly targetPublicProfileId: string;
}

export interface LocateChatOperationInput {
  readonly operationId: string;
  readonly ownerUserId: string;
}

export interface TransitionChatOperationInput extends LocateChatOperationInput {
  readonly requestId: string;
}

export interface RefreshChatOperationInput extends TransitionChatOperationInput {
  readonly pendingBefore: string;
}

export interface ClaimChatReconciliationInput extends TransitionChatOperationInput {
  readonly submittingBefore: string;
}

export interface FailChatOperationInput extends TransitionChatOperationInput {
  readonly errorCode: string;
}

export interface ChatChannelRepository {
  prepareGroupOperation(
    input: PrepareGroupChatOperationInput,
  ): Promise<ChatOperationRecord>;
  prepareDirectOperation(
    input: PrepareDirectChatOperationInput,
  ): Promise<ChatOperationRecord>;
  refreshOperation(
    input: RefreshChatOperationInput,
  ): Promise<ChatOperationRecord>;
  claimSubmission(
    input: TransitionChatOperationInput,
  ): Promise<ChatChannelExpectation | null>;
  claimReconciliation(
    input: ClaimChatReconciliationInput,
  ): Promise<ChatChannelExpectation | null>;
  markReconciling(
    input: TransitionChatOperationInput,
  ): Promise<ChatOperationRecord>;
  markSucceeded(
    input: TransitionChatOperationInput,
  ): Promise<ChatOperationRecord>;
  markFailed(input: FailChatOperationInput): Promise<ChatOperationRecord>;
  markOperatorRequired(
    input: FailChatOperationInput,
  ): Promise<ChatOperationRecord>;
  findCanonicalDirectOperation(
    input: LocateChatOperationInput,
  ): Promise<ChatOperationRecord | null>;
  findOperation(
    input: LocateChatOperationInput,
  ): Promise<ChatOperationRecord | null>;
}

export class ChatChannelRepositoryUnavailableError extends Error {
  constructor() {
    super("The Chat channel repository is unavailable");
    this.name = "ChatChannelRepositoryUnavailableError";
  }
}

export class ChatChannelIdempotencyConflictRepositoryError extends Error {
  constructor() {
    super("The Chat channel idempotency key conflicts");
    this.name = "ChatChannelIdempotencyConflictRepositoryError";
  }
}

export class ChatChannelTargetUnavailableRepositoryError extends Error {
  constructor() {
    super("The Chat channel target is unavailable");
    this.name = "ChatChannelTargetUnavailableRepositoryError";
  }
}

export function createUnavailableChatChannelRepository(): ChatChannelRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ChatChannelRepositoryUnavailableError());
  return Object.freeze({
    prepareGroupOperation: unavailable,
    prepareDirectOperation: unavailable,
    refreshOperation: unavailable,
    claimSubmission: unavailable,
    claimReconciliation: unavailable,
    markReconciling: unavailable,
    markSucceeded: unavailable,
    markFailed: unavailable,
    markOperatorRequired: unavailable,
    findCanonicalDirectOperation: unavailable,
    findOperation: unavailable,
  });
}
