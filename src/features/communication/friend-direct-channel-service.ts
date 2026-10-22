import { randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import type { ChatOperationResource } from "./chat-channel-contract.js";
import {
  ChatChannelTargetUnavailableError,
  ChatOperationNotFoundError,
  type ChatChannelService,
} from "./chat-channel-service.js";

/**
 * Decision 0172: the `friend_direct_channel` lane. Each accepted friend pair
 * gets the same idempotent `direct_get_or_create` chat operation that
 * `POST /v2/chat/direct-channels` runs; `direct_channels` stays the
 * authority, so the app's own call and this lane converge on one channel.
 */

export const FRIEND_DIRECT_CHANNEL_CLAIM_LIMIT = 20;
export const FRIEND_DIRECT_CHANNEL_LEASE_SECONDS = 120;
export const FRIEND_DIRECT_CHANNEL_BACKFILL_LIMIT = 200;
export const FRIEND_DIRECT_CHANNEL_MAX_ATTEMPTS = 20;
export const FRIEND_DIRECT_CHANNEL_POLL_DELAY_SECONDS = 15;
const retryBaseSeconds = 5;
const retryMaxSeconds = 600;

export type FriendDirectChannelJobSource = "accept" | "backfill";
export type FriendDirectChannelTerminalState =
  "succeeded" | "skipped" | "failed";

export interface FriendDirectChannelJobRecord {
  readonly userIdLow: string;
  readonly userIdHigh: string;
  readonly ownerUserId: string;
  readonly source: FriendDirectChannelJobSource;
  readonly attempts: number;
  readonly operationId: string | null;
  readonly operationOwnerUserId: string | null;
}

export interface FriendDirectChannelParticipant {
  readonly userId: string;
  readonly privyUserId: string;
  /** Null when the account has no public profile (never a DM target). */
  readonly publicProfileId: string | null;
}

export interface FriendDirectChannelJobKey {
  readonly userIdLow: string;
  readonly userIdHigh: string;
  readonly workerId: string;
}

export interface FriendDirectChannelJobRepository {
  /** Enqueues up to `limit` friendship pairs with no live direct channel and no job. */
  enqueueBackfill(input: { readonly limit: number }): Promise<number>;
  claimDueJobs(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly limit: number;
  }): Promise<readonly FriendDirectChannelJobRecord[]>;
  readParticipants(
    userIds: readonly string[],
  ): Promise<readonly FriendDirectChannelParticipant[]>;
  hasActiveDirectChannel(input: {
    readonly userIdLow: string;
    readonly userIdHigh: string;
  }): Promise<boolean>;
  recordOperation(
    input: FriendDirectChannelJobKey & {
      readonly operationId: string | null;
      readonly operationOwnerUserId: string | null;
    },
  ): Promise<void>;
  completeJob(
    input: FriendDirectChannelJobKey & {
      readonly state: FriendDirectChannelTerminalState;
      readonly errorCode: string | null;
    },
  ): Promise<void>;
  retryJob(
    input: FriendDirectChannelJobKey & {
      readonly errorCode: string | null;
      readonly retryDelaySeconds: number;
    },
  ): Promise<void>;
}

export type FriendDirectChannelRunResult =
  | { readonly kind: "aborted" }
  | {
      readonly kind: "completed";
      /** Null when the backfill sweep is off. */
      readonly backfillEnqueued: number | null;
      readonly claimed: number;
      readonly succeeded: number;
      readonly skipped: number;
      readonly failed: number;
      readonly retried: number;
    };

export type FriendDirectChannelEvent =
  | {
      readonly kind: "job_failed";
      readonly errorCode: string;
      readonly attempts: number;
    }
  | {
      readonly kind: "job_retry";
      readonly errorCode: string;
      readonly errorClass: string;
      readonly attempts: number;
    };

export interface FriendDirectChannelService {
  runOnce(signal: AbortSignal): Promise<FriendDirectChannelRunResult>;
}

type Outcome = "succeeded" | "skipped" | "failed" | "retried";

/** A function, not a property read, so the check is not narrowed away. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function friendDirectChannelRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 16) - 1);
  return Math.min(retryBaseSeconds * 2 ** exponent, retryMaxSeconds);
}

export function createFriendDirectChannelService(input: {
  readonly repository: FriendDirectChannelJobRepository;
  readonly chat: Pick<ChatChannelService, "getOrCreateDirect" | "getOperation">;
  readonly backfillEnabled: boolean;
  readonly workerId?: string;
  readonly createUuid?: () => string;
  readonly onEvent?: (event: FriendDirectChannelEvent) => void;
}): FriendDirectChannelService {
  const workerId = input.workerId ?? randomUUID();
  const createUuid = input.createUuid ?? randomUUID;

  function principalOf(
    participant: FriendDirectChannelParticipant,
  ): AuthenticatedLoopPrincipal {
    return Object.freeze({
      userId: participant.userId,
      privyUserId: participant.privyUserId,
      streamUserId: deriveStreamUserId(participant.userId),
    });
  }

  async function settle(
    job: FriendDirectChannelJobRecord,
    resource: ChatOperationResource,
  ): Promise<Outcome> {
    const key = {
      userIdLow: job.userIdLow,
      userIdHigh: job.userIdHigh,
      workerId,
    };
    if (resource.status === "succeeded") {
      await input.repository.completeJob({
        ...key,
        state: "succeeded",
        errorCode: null,
      });
      return "succeeded";
    }
    if (resource.terminal) {
      const errorCode = resource.error?.code ?? "direct_channel_unavailable";
      await input.repository.completeJob({
        ...key,
        state: "failed",
        errorCode,
      });
      input.onEvent?.({
        kind: "job_failed",
        errorCode,
        attempts: job.attempts,
      });
      return "failed";
    }
    if (job.attempts >= FRIEND_DIRECT_CHANNEL_MAX_ATTEMPTS) {
      await input.repository.completeJob({
        ...key,
        state: "failed",
        errorCode: "direct_channel_not_settled",
      });
      input.onEvent?.({
        kind: "job_failed",
        errorCode: "direct_channel_not_settled",
        attempts: job.attempts,
      });
      return "failed";
    }
    await input.repository.retryJob({
      ...key,
      errorCode: null,
      retryDelaySeconds: FRIEND_DIRECT_CHANNEL_POLL_DELAY_SECONDS,
    });
    return "retried";
  }

  async function processJob(
    job: FriendDirectChannelJobRecord,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const key = {
      userIdLow: job.userIdLow,
      userIdHigh: job.userIdHigh,
      workerId,
    };
    const participants = new Map(
      (
        await input.repository.readParticipants([job.userIdLow, job.userIdHigh])
      ).map((participant) => [participant.userId, participant]),
    );

    if (job.operationId !== null && job.operationOwnerUserId !== null) {
      const owner = participants.get(job.operationOwnerUserId);
      if (owner !== undefined) {
        try {
          const resource = await input.chat.getOperation({
            principal: principalOf(owner),
            operationId: job.operationId,
            requestId: createUuid(),
            signal,
          });
          return await settle(job, resource);
        } catch (error) {
          if (!(error instanceof ChatOperationNotFoundError)) {
            throw error;
          }
          // The prepare never committed (refused or crashed): start over.
        }
      }
      await input.repository.recordOperation({
        ...key,
        operationId: null,
        operationOwnerUserId: null,
      });
    }

    if (
      await input.repository.hasActiveDirectChannel({
        userIdLow: job.userIdLow,
        userIdHigh: job.userIdHigh,
      })
    ) {
      await input.repository.completeJob({
        ...key,
        state: "succeeded",
        errorCode: null,
      });
      return "succeeded";
    }

    const peerOf = (userId: string): string =>
      userId === job.userIdLow ? job.userIdHigh : job.userIdLow;
    const owners = [job.ownerUserId, peerOf(job.ownerUserId)];
    for (const ownerUserId of owners) {
      const owner = participants.get(ownerUserId);
      const target = participants.get(peerOf(ownerUserId));
      if (
        owner === undefined ||
        target === undefined ||
        target.publicProfileId === null
      ) {
        continue;
      }
      const operationId = createUuid();
      await input.repository.recordOperation({
        ...key,
        operationId,
        operationOwnerUserId: ownerUserId,
      });
      try {
        const resource = await input.chat.getOrCreateDirect({
          principal: principalOf(owner),
          operationId,
          requestId: createUuid(),
          body: { target_public_profile_id: target.publicProfileId },
          signal,
        });
        return await settle(job, resource);
      } catch (error) {
        if (error instanceof ChatChannelTargetUnavailableError) {
          // The route's own refusal (no friendship any more, or the target
          // does not take direct messages): try the other direction.
          continue;
        }
        throw error;
      }
    }
    await input.repository.completeJob({
      ...key,
      state: "skipped",
      errorCode: "direct_target_unavailable",
    });
    return "skipped";
  }

  return Object.freeze({
    async runOnce(signal: AbortSignal): Promise<FriendDirectChannelRunResult> {
      if (signal.aborted) {
        return Object.freeze({ kind: "aborted" });
      }
      const backfillEnqueued = input.backfillEnabled
        ? await input.repository.enqueueBackfill({
            limit: FRIEND_DIRECT_CHANNEL_BACKFILL_LIMIT,
          })
        : null;
      const jobs = await input.repository.claimDueJobs({
        workerId,
        leaseSeconds: FRIEND_DIRECT_CHANNEL_LEASE_SECONDS,
        limit: FRIEND_DIRECT_CHANNEL_CLAIM_LIMIT,
      });
      const counts = { succeeded: 0, skipped: 0, failed: 0, retried: 0 };
      for (const job of jobs) {
        if (isAborted(signal)) {
          // Unprocessed leases simply expire.
          return Object.freeze({ kind: "aborted" });
        }
        try {
          counts[await processJob(job, signal)] += 1;
        } catch (error) {
          if (isAborted(signal)) {
            return Object.freeze({ kind: "aborted" });
          }
          const errorClass =
            error instanceof Error ? error.name : "UnknownError";
          if (job.attempts >= FRIEND_DIRECT_CHANNEL_MAX_ATTEMPTS) {
            await input.repository.completeJob({
              userIdLow: job.userIdLow,
              userIdHigh: job.userIdHigh,
              workerId,
              state: "failed",
              errorCode: "direct_channel_unavailable",
            });
            input.onEvent?.({
              kind: "job_failed",
              errorCode: "direct_channel_unavailable",
              attempts: job.attempts,
            });
            counts.failed += 1;
          } else {
            await input.repository.retryJob({
              userIdLow: job.userIdLow,
              userIdHigh: job.userIdHigh,
              workerId,
              errorCode: "direct_channel_unavailable",
              retryDelaySeconds: friendDirectChannelRetryDelaySeconds(
                job.attempts,
              ),
            });
            input.onEvent?.({
              kind: "job_retry",
              errorCode: "direct_channel_unavailable",
              errorClass,
              attempts: job.attempts,
            });
            counts.retried += 1;
          }
        }
      }
      return Object.freeze({
        kind: "completed",
        backfillEnqueued,
        claimed: jobs.length,
        ...counts,
      });
    },
  });
}
