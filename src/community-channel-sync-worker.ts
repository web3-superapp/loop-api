import { randomUUID } from "node:crypto";

import {
  CommunicationRepositoryUnavailableError,
  type CommunityChannelSyncJobRecord,
  type CommunityChannelSyncRepository,
} from "./features/communication/communication-repository.js";
import type { CommunityPersonaService } from "./features/communication/community-persona-service.js";
import {
  communityActivityChannelBatch,
  StreamChannelProjectionMismatchError,
  StreamChannelRequestRejectedError,
  type StreamCommunityChannelGateway,
} from "./integrations/stream/channel-gateway.js";
import { communityActivityWindowDays } from "./features/community/community-contract.js";

export const COMMUNITY_CHANNEL_SYNC_BATCH_LIMIT = 20;
export const COMMUNITY_CHANNEL_SYNC_INTERVAL_MS = 5_000;
export const COMMUNITY_CHANNEL_SYNC_LEASE_SECONDS = 30;
export const COMMUNITY_CHANNEL_SYNC_MAX_ATTEMPTS = 10;
export const COMMUNITY_CHANNEL_SYNC_RETRY_BASE_SECONDS = 5;
export const COMMUNITY_CHANNEL_SYNC_RETRY_MAX_SECONDS = 300;
/**
 * Activity observation (Decision 0061). The sweep is not the membership
 * lane: it reads at most one `queryChannels` per tick, and a community is
 * re-observed only after its last observation is this old.
 */
export const COMMUNITY_ACTIVITY_OBSERVATION_INTERVAL_SECONDS = 900;
export const COMMUNITY_ACTIVITY_BATCH_LIMIT = communityActivityChannelBatch;
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
  /** Decision 0055 persona lane: pending personas claimed this tick. */
  personaClaimedCount: number;
  personaConfirmedCount: number;
  personaDeferredCount: number;
  /**
   * Decision 0061 activity sweep: channels observed and recorded this tick.
   * Zero when nothing was due, when no channel is provisioned, or when the
   * provider read failed — a failed read records nothing.
   */
  activityObservedCount: number;
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
  /** Decision 0055: generates and projects the member's community persona. */
  readonly personas: CommunityPersonaService;
  /** Sanitized warn lines for persona bookkeeping that could not be recorded. */
  readonly logger?: CommunityChannelSyncWorkerLogger;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: CommunityChannelSyncInfrastructureBackoff,
  ) => void;
}

export type CommunityChannelSyncWorkerLogMessage =
  | "Community persona bookkeeping failed after a completed sync job"
  | "Community channel activity could not be observed; no observation was recorded";

export interface CommunityChannelSyncWorkerLogContext {
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly write: "confirm" | "observe" | "request" | "reset";
  readonly errorName: string;
}

export interface CommunityChannelSyncWorkerLogger {
  warn(
    context: CommunityChannelSyncWorkerLogContext,
    message: CommunityChannelSyncWorkerLogMessage,
  ): void;
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
 *
 * Decision 0055: an `add` carries the member's community persona as channel
 * member custom data in that same single call. Whether Stream echoed it only
 * decides the persona's projection state; the membership fact is recorded
 * either way, and a separate persona lane re-projects pending personas of
 * `synced` members with `updateMemberPartial` under its own claim.
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

  /**
   * Persona bookkeeping after the membership fact is already recorded. A
   * failure here must not turn a completed job into a retry: the persona
   * simply keeps (or regains) its `pending` state and the persona lane
   * repairs it. It is logged, never swallowed silently.
   */
  async function recordPersonaOutcome(
    job: CommunityChannelSyncJobRecord,
    write: "confirm" | "request" | "reset",
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      options.logger?.warn(
        {
          communityId: job.communityId,
          ownerUserId: job.ownerUserId,
          write,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Community persona bookkeeping failed after a completed sync job",
      );
    }
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
        // Stream drops member custom data with the membership; the persona
        // row stays and is re-projected on the next add.
        await recordPersonaOutcome(job, "reset", () =>
          options.personas.resetProjectionForMember({
            communityId: job.communityId,
            ownerUserId: job.ownerUserId,
          }),
        );
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

      // The persona is generated (or resumed) before the single provider
      // call so the add carries it; a generation failure retries the job
      // without having touched Stream.
      const lease = await options.personas.ensurePersona({
        communityId: job.communityId,
        ownerUserId: job.ownerUserId,
      });
      const projection = await options.gateway.addMembers({
        channelId: job.streamChannelId,
        actingStreamUserId: job.channelCreatedByStreamUserId,
        memberStreamUserIds: [job.memberStreamUserId],
        memberPersonas: [
          {
            streamUserId: job.memberStreamUserId,
            personaId: lease.persona.personaId,
            alias: lease.persona.alias,
          },
        ],
        signal,
      });
      await options.repository.completeJob({
        communityId: job.communityId,
        ownerUserId: job.ownerUserId,
        workerId,
        memberState: "synced",
        channelState: "created",
      });
      const echoed = projection.confirmedPersonaStreamUserIds.includes(
        job.memberStreamUserId,
      );
      await recordPersonaOutcome(job, echoed ? "confirm" : "request", () =>
        echoed
          ? options.personas.confirmProjection({
              personaId: lease.persona.personaId,
              leaseToken: lease.leaseToken,
            })
          : options.personas.requestProjection(lease),
      );
      return "succeeded";
    } catch (error) {
      if (isAborted(signal)) {
        throw error;
      }
      // Persona generation failed before the provider was touched (M1): the
      // job is retried under its own code, does not spend the Stream attempt
      // budget, and never marks the channel `failed`.
      if (error instanceof CommunicationRepositoryUnavailableError) {
        await options.repository.retryJob({
          communityId: job.communityId,
          ownerUserId: job.ownerUserId,
          workerId,
          errorCode: "community_persona_unavailable",
          retryDelaySeconds: jobRetryDelaySeconds(job.attempts),
        });
        return "retried";
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

  /**
   * One activity sweep (Decision 0061): the channels whose observation is
   * missing or older than the interval, read in a single `queryChannels`
   * call and written back with the time they were observed. A channel
   * Stream did not answer for is left as it was — an unobserved channel is
   * not an inactive one.
   */
  async function observeActivity(signal: AbortSignal): Promise<number> {
    if (isAborted(signal)) {
      return 0;
    }
    let due: readonly { communityId: string; streamChannelId: string }[];
    try {
      due = await options.repository.listChannelsDueForActivity({
        staleAfterSeconds: COMMUNITY_ACTIVITY_OBSERVATION_INTERVAL_SECONDS,
        limit: COMMUNITY_ACTIVITY_BATCH_LIMIT,
      });
    } catch {
      return 0;
    }
    if (due.length === 0) {
      return 0;
    }
    const observedAt = new Date();
    const since = new Date(
      observedAt.getTime() - communityActivityWindowDays * 86_400_000,
    );
    let observations: readonly {
      channelId: string;
      messageCount: number;
      bounded: boolean;
      totalMessageCount: number | null;
      lastMessageAt: string | null;
    }[];
    try {
      observations = await options.gateway.readCommunityChannelActivity({
        channelIds: due.map((target) => target.streamChannelId),
        since,
        signal,
      });
    } catch {
      options.logger?.warn(
        {
          communityId: due[0]?.communityId ?? "",
          ownerUserId: "",
          write: "observe",
          errorName: "activity_read_failed",
        },
        "Community channel activity could not be observed; no observation was recorded",
      );
      return 0;
    }
    let recorded = 0;
    for (const target of due) {
      const observation = observations.find(
        (candidate) => candidate.channelId === target.streamChannelId,
      );
      if (observation === undefined) {
        continue;
      }
      try {
        await options.repository.recordChannelActivity({
          communityId: target.communityId,
          streamChannelId: target.streamChannelId,
          windowDays: communityActivityWindowDays,
          messageCount: observation.messageCount,
          bounded: observation.bounded,
          totalMessageCount: observation.totalMessageCount,
          lastMessageAt: observation.lastMessageAt,
          observedAt: observedAt.toISOString(),
        });
        recorded += 1;
      } catch {
        // The next sweep tries again; nothing else depends on this write.
      }
    }
    return recorded;
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
        personaClaimedCount: 0,
        personaConfirmedCount: 0,
        personaDeferredCount: 0,
        activityObservedCount: 0,
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
          personaClaimedCount: 0,
          personaConfirmedCount: 0,
          personaDeferredCount: 0,
          activityObservedCount: 0,
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
    if (isAborted(abortSignal)) {
      return Object.freeze({
        kind: "aborted" as const,
        claimedCount: jobs.length,
        succeededCount,
        retriedCount,
        failedCount,
        personaClaimedCount: 0,
        personaConfirmedCount: 0,
        personaDeferredCount: 0,
        activityObservedCount: 0,
      });
    }
    // Persona lane (Decision 0055): re-project pending personas of members
    // that are already `synced`. Its claim is fenced in the database, and a
    // claim failure is infrastructure, like a job claim failure.
    let personaResult: {
      readonly claimedCount: number;
      readonly confirmedCount: number;
      readonly deferredCount: number;
    };
    try {
      personaResult = await options.personas.syncPendingProjections({
        signal: abortSignal,
      });
    } catch {
      if (isAborted(abortSignal)) {
        return Object.freeze({
          kind: "aborted" as const,
          claimedCount: jobs.length,
          succeededCount,
          retriedCount,
          failedCount,
          personaClaimedCount: 0,
          personaConfirmedCount: 0,
          personaDeferredCount: 0,
          activityObservedCount: 0,
        });
      }
      throw new CommunityChannelSyncUnavailableError();
    }
    // Activity sweep (Decision 0061). It is deliberately last and
    // deliberately soft: nothing about the membership projection depends on
    // it, and a provider or database failure here records no observation
    // and fails no job. An observation that was not made stays absent, and
    // the discover sort that reads it says so.
    const activityObservedCount = await observeActivity(abortSignal);
    return Object.freeze({
      kind: "completed" as const,
      claimedCount: jobs.length,
      succeededCount,
      retriedCount,
      failedCount,
      personaClaimedCount: personaResult.claimedCount,
      personaConfirmedCount: personaResult.confirmedCount,
      personaDeferredCount: personaResult.deferredCount,
      activityObservedCount,
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
