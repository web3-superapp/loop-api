import { randomUUID } from "node:crypto";

import type {
  CommunityChannelSyncJobRecord,
  CommunityChannelSyncRepository,
} from "./features/communication/communication-repository.js";
import {
  StreamChannelProjectionMismatchError,
  StreamChannelRequestRejectedError,
  type StreamCommunityChannelGateway,
} from "./integrations/stream/channel-gateway.js";

export const COMMUNITY_CHANNEL_SYNC_BATCH_LIMIT = 20;
export const COMMUNITY_CHANNEL_SYNC_INTERVAL_MS = 5_000;
export const COMMUNITY_CHANNEL_SYNC_LEASE_SECONDS = 30;
export const COMMUNITY_CHANNEL_SYNC_MAX_ATTEMPTS = 10;
export const COMMUNITY_CHANNEL_SYNC_RETRY_BASE_SECONDS = 5;
export const COMMUNITY_CHANNEL_SYNC_RETRY_MAX_SECONDS = 300;
const COMMUNITY_CHANNEL_SYNC_RETRY_BASE_DELAY_MS = 1_000;
const COMMUNITY_CHANNEL_SYNC_RETRY_MAX_DELAY_MS = 30_000;

export interface CommunityChannelSyncInfrastructureBackoff {
  readonly reasonCode: "community_channel_sync_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export type CommunityChannelSyncRunResult = Readonly<{
  kind: "aborted" | "completed";
  claimedCount: number;
  succeededCount: number;
  retriedCount: number;
  failedCount: number;
}>;

export interface CommunityChannelSyncWorker {
  readonly workerId: string;
  readonly runOnce: (
    signal?: AbortSignal,
  ) => Promise<CommunityChannelSyncRunResult>;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface CreateCommunityChannelSyncWorkerOptions {
  readonly repository: CommunityChannelSyncRepository;
  readonly gateway: StreamCommunityChannelGateway;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: CommunityChannelSyncInfrastructureBackoff,
  ) => void;
}

class CommunityChannelSyncUnavailableError extends Error {
  readonly code = "community_channel_sync_unavailable";

  constructor() {
    super("Community channel synchronization is unavailable");
    this.name = "CommunityChannelSyncUnavailableError";
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

async function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function loopRetryDelayMs(consecutiveFailureCount: number): number {
  return Math.min(
    COMMUNITY_CHANNEL_SYNC_RETRY_BASE_DELAY_MS *
      2 ** (consecutiveFailureCount - 1),
    COMMUNITY_CHANNEL_SYNC_RETRY_MAX_DELAY_MS,
  );
}

function jobRetryDelaySeconds(attempts: number): number {
  return Math.min(
    COMMUNITY_CHANNEL_SYNC_RETRY_BASE_SECONDS * 2 ** Math.max(attempts - 1, 0),
    COMMUNITY_CHANNEL_SYNC_RETRY_MAX_SECONDS,
  );
}

/**
 * The `community-channel-sync` lane (Decision 0032). It performs the Stream
 * membership writes that community join/leave/ban transactions recorded in
 * `community_channel_sync_jobs` after those transactions committed.
 *
 * Every provider call is attempted at most once per lease. An unknown result
 * leaves the job in `reconciling` with a bounded backoff; it is never replayed
 * inside the same attempt and never reported as success. `addMembers` and
 * `removeMembers` are idempotent by contract, so a member that is already in
 * (or already out of) the channel completes the job.
 */
export function createCommunityChannelSyncWorker(
  options: CreateCommunityChannelSyncWorkerOptions,
): CommunityChannelSyncWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = createUuid();
  let inFlight: Promise<CommunityChannelSyncRunResult> | null = null;
  let loopRunning = false;

  async function provisionChannel(
    job: CommunityChannelSyncJobRecord,
    signal: AbortSignal,
  ): Promise<void> {
    await options.gateway.upsertCommunityChannel({
      channelId: job.streamChannelId,
      createdByStreamUserId: job.channelCreatedByStreamUserId,
      name: job.channelName,
      signal,
    });
    await options.repository.markChannelProvisioned({
      communityId: job.communityId,
      workerId,
    });
  }

  async function applyJob(
    job: CommunityChannelSyncJobRecord,
    signal: AbortSignal,
  ): Promise<"succeeded" | "retried" | "failed"> {
    try {
      if (job.kind === "remove") {
        if (job.channelProvisioned) {
          await options.gateway.removeMembers({
            channelId: job.streamChannelId,
            actingStreamUserId: job.channelCreatedByStreamUserId,
            memberStreamUserIds: [job.memberStreamUserId],
            signal,
          });
        }
        await options.repository.completeJob({
          communityId: job.communityId,
          ownerUserId: job.ownerUserId,
          workerId,
          memberState: "removed",
          channelState: "created",
        });
        return "succeeded";
      }

      if (!job.channelProvisioned) {
        await provisionChannel(job, signal);
      }

      // The LOOP membership always stands. When the channel is at its Stream
      // member ceiling the member is parked as capacityPending instead of
      // retrying a call the provider will reject.
      if (job.syncedMemberCount >= job.memberCap) {
        await options.repository.completeJob({
          communityId: job.communityId,
          ownerUserId: job.ownerUserId,
          workerId,
          memberState: "capacityPending",
          channelState: "capacityPending",
        });
        return "succeeded";
      }

      await options.gateway.addMembers({
        channelId: job.streamChannelId,
        actingStreamUserId: job.channelCreatedByStreamUserId,
        memberStreamUserIds: [job.memberStreamUserId],
        signal,
      });
      await options.repository.completeJob({
        communityId: job.communityId,
        ownerUserId: job.ownerUserId,
        workerId,
        memberState: "synced",
        channelState: "created",
      });
      return "succeeded";
    } catch (error) {
      if (isAborted(signal)) {
        throw error;
      }
      if (error instanceof StreamChannelProjectionMismatchError) {
        await options.repository.failJob({
          communityId: job.communityId,
          ownerUserId: job.ownerUserId,
          workerId,
          errorCode: "stream_channel_projection_mismatch",
        });
        return "failed";
      }
      // A deterministic provider rejection is terminal: the identical request
      // would be rejected again, so the job records the reason instead of
      // spending its ten attempts and the provider quota behind them.
      if (error instanceof StreamChannelRequestRejectedError) {
        await options.repository.failJob({
          communityId: job.communityId,
          ownerUserId: job.ownerUserId,
          workerId,
          errorCode: "stream_channel_request_rejected",
        });
        return "failed";
      }
      if (job.attempts >= COMMUNITY_CHANNEL_SYNC_MAX_ATTEMPTS) {
        await options.repository.failJob({
          communityId: job.communityId,
          ownerUserId: job.ownerUserId,
          workerId,
          errorCode: "stream_channel_sync_exhausted",
        });
        return "failed";
      }
      await options.repository.retryJob({
        communityId: job.communityId,
        ownerUserId: job.ownerUserId,
        workerId,
        errorCode: "stream_channel_sync_unavailable",
        retryDelaySeconds: jobRetryDelaySeconds(job.attempts),
      });
      return "retried";
    }
  }

  async function performRunOnce(
    signal?: AbortSignal,
  ): Promise<CommunityChannelSyncRunResult> {
    if (isAborted(signal)) {
      return Object.freeze({
        kind: "aborted" as const,
        claimedCount: 0,
        succeededCount: 0,
        retriedCount: 0,
        failedCount: 0,
      });
    }
    const abortSignal = signal ?? new AbortController().signal;
    let jobs: readonly CommunityChannelSyncJobRecord[];
    try {
      jobs = await options.repository.claimDueJobs({
        workerId,
        leaseSeconds: COMMUNITY_CHANNEL_SYNC_LEASE_SECONDS,
        limit: COMMUNITY_CHANNEL_SYNC_BATCH_LIMIT,
      });
    } catch {
      throw new CommunityChannelSyncUnavailableError();
    }

    let succeededCount = 0;
    let retriedCount = 0;
    let failedCount = 0;
    for (const job of jobs) {
      if (isAborted(abortSignal)) {
        return Object.freeze({
          kind: "aborted" as const,
          claimedCount: jobs.length,
          succeededCount,
          retriedCount,
          failedCount,
        });
      }
      let outcome: "succeeded" | "retried" | "failed";
      try {
        outcome = await applyJob(job, abortSignal);
      } catch {
        throw new CommunityChannelSyncUnavailableError();
      }
      if (outcome === "succeeded") {
        succeededCount += 1;
      } else if (outcome === "retried") {
        retriedCount += 1;
      } else {
        failedCount += 1;
      }
    }
    return Object.freeze({
      kind: "completed" as const,
      claimedCount: jobs.length,
      succeededCount,
      retriedCount,
      failedCount,
    });
  }

  function runOnce(
    signal?: AbortSignal,
  ): Promise<CommunityChannelSyncRunResult> {
    if (inFlight !== null) {
      return inFlight;
    }
    const current = performRunOnce(signal);
    const tracked = current.finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
      }
    });
    inFlight = tracked;
    return tracked;
  }

  return Object.freeze({
    workerId,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error(
          "The community channel sync worker loop is already running",
        );
      }
      loopRunning = true;
      let consecutiveFailureCount = 0;
      try {
        while (!signal.aborted) {
          try {
            const result = await runOnce(signal);
            if (result.kind === "aborted") {
              break;
            }
            consecutiveFailureCount = 0;
            await waitFor(COMMUNITY_CHANNEL_SYNC_INTERVAL_MS, signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailureCount += 1;
            const delay = loopRetryDelayMs(consecutiveFailureCount);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "community_channel_sync_unavailable",
                consecutiveFailureCount,
                retryDelayMs: delay,
              }),
            );
            await waitFor(delay, signal);
          }
        }
      } finally {
        loopRunning = false;
      }
    },
  });
}
