import { randomUUID } from "node:crypto";

import type { StreamCallGateway } from "../../integrations/stream/call-gateway.js";
import { voiceRoomProviderSyncReasonCodes } from "./communication-contract.js";
import type {
  VoiceRoomReapCandidate,
  VoiceRoomReaperRepository,
  VoiceRoomReapReason,
} from "./communication-repository.js";

/** Rooms examined per tick (Decision 0094). */
export const VOICE_ROOM_REAPER_BATCH_LIMIT = 50;

/** The reason codes the lane logs for a room it ended (Decision 0094). */
export const voiceRoomReaperReasonCodes = Object.freeze({
  idle: "VOICE_ROOM_IDLE_ENDED",
  max_age: "VOICE_ROOM_MAX_AGE_ENDED",
} as const satisfies Record<VoiceRoomReapReason, string>);

export interface VoiceRoomReaperThresholds {
  /** `VOICE_ROOM_IDLE_END_MINUTES`, default 10. */
  readonly idleEndMinutes: number;
  /** `VOICE_ROOM_MAX_LIVE_HOURS`, default 12. */
  readonly maxLiveHours: number;
}

/**
 * The database half of the rule, decided from one listing row:
 *
 * - `end_max_age`: live for `maxLiveHours` or more. Ended without looking at
 *   anyone, the hard cap.
 * - `occupied`: a joined speaker or listener exists. Kept.
 * - `recent_activity`: the room or a member row changed within
 *   `idleEndMinutes`. Kept.
 * - `needs_presence`: LOOP has seen nobody but the host for `idleEndMinutes`.
 *   The host row is always `joined` (it cannot leave, only end), so whether
 *   the host is still there is a Stream fact; the lane asks Stream.
 */
export type VoiceRoomReapVerdict =
  "end_max_age" | "occupied" | "recent_activity" | "needs_presence";

export function classifyVoiceRoomForReap(
  candidate: Pick<
    VoiceRoomReapCandidate,
    "createdAt" | "lastActivityAt" | "nonHostJoinedCount" | "databaseNow"
  >,
  thresholds: VoiceRoomReaperThresholds,
): VoiceRoomReapVerdict {
  const now = Date.parse(candidate.databaseNow);
  const createdAt = Date.parse(candidate.createdAt);
  const lastActivityAt = Date.parse(candidate.lastActivityAt);
  if (now - createdAt >= thresholds.maxLiveHours * 3_600_000) {
    return "end_max_age";
  }
  if (candidate.nonHostJoinedCount > 0) {
    return "occupied";
  }
  if (now - lastActivityAt < thresholds.idleEndMinutes * 60_000) {
    return "recent_activity";
  }
  return "needs_presence";
}

/**
 * Stream presence for a `needs_presence` room. Only a confirmed read of zero
 * connected devices ends it; a failed, aborted or unparseable read keeps the
 * room (an unknown presence is not an empty room).
 */
export type VoiceRoomPresence =
  | { readonly status: "observed"; readonly participantCount: number }
  | { readonly status: "unavailable" };

export function isIdleByPresence(presence: VoiceRoomPresence): boolean {
  return presence.status === "observed" && presence.participantCount === 0;
}

export type VoiceRoomReaperEvent =
  | {
      readonly kind: "ended";
      readonly voiceRoomId: string;
      readonly reasonCode: (typeof voiceRoomReaperReasonCodes)[VoiceRoomReapReason];
      readonly providerSync: "confirmed" | "unconfirmed";
      readonly requestId: string;
    }
  | {
      readonly kind: "end_unconfirmed";
      readonly voiceRoomId: string;
      readonly reasonCode: typeof voiceRoomProviderSyncReasonCodes.end;
      readonly detailReasonCode: (typeof voiceRoomReaperReasonCodes)[VoiceRoomReapReason];
      readonly errorClass: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "presence_unavailable";
      readonly voiceRoomId: string;
      readonly errorClass: string;
    }
  | {
      readonly kind: "room_failed";
      readonly voiceRoomId: string;
      readonly errorClass: string;
    };

export type VoiceRoomReaperRunResult = Readonly<{
  kind: "aborted" | "completed";
  examinedCount: number;
  endedIdleCount: number;
  endedMaxAgeCount: number;
  keptCount: number;
  skippedCount: number;
  presenceUnavailableCount: number;
  providerUnconfirmedCount: number;
  failedCount: number;
}>;

export interface VoiceRoomReaperService {
  /**
   * One pass over at most 50 live rooms. Rejects only when the listing read
   * itself fails; a failure on one room is counted and reported, and the
   * pass moves on to the next room.
   */
  runOnce(signal: AbortSignal): Promise<VoiceRoomReaperRunResult>;
}

export interface VoiceRoomReaperServiceOptions {
  readonly repository: VoiceRoomReaperRepository;
  readonly callGateway: StreamCallGateway;
  readonly thresholds: VoiceRoomReaperThresholds;
  readonly onEvent?: (event: VoiceRoomReaperEvent) => void;
  readonly createUuid?: () => string;
}

function errorClassOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name)
    ? error.name
    : "unknown";
}

/** A function, not a property read, so the check is not narrowed away. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * The `voice_room_reaper` lane (Decision 0094). It ends a live room the
 * same way the host's `POST …/end` does: LOOP first (the room row, the
 * pending hand raises, a `room_ended` audit row), then exactly one Stream
 * `end` call. A Stream end that is not confirmed leaves the LOOP room ended
 * and is reported as `STREAM_CALL_END_UNCONFIRMED`, exactly like the
 * command's `providerSync: unconfirmed`; it is never retried or replayed.
 */
export function createVoiceRoomReaperService(
  options: VoiceRoomReaperServiceOptions,
): VoiceRoomReaperService {
  const createUuid = options.createUuid ?? randomUUID;
  const emit = (event: VoiceRoomReaperEvent): void => {
    options.onEvent?.(Object.freeze(event));
  };

  async function observePresence(
    candidate: VoiceRoomReapCandidate,
    signal: AbortSignal,
  ): Promise<VoiceRoomPresence> {
    if (candidate.provisionState !== "provisioned") {
      // No confirmed Stream call to observe: presence is unknown.
      emit({
        kind: "presence_unavailable",
        voiceRoomId: candidate.voiceRoomId,
        errorClass: "VoiceRoomNotProvisioned",
      });
      return { status: "unavailable" };
    }
    try {
      const session = await options.callGateway.observeSession({
        callId: candidate.callId,
        signal,
      });
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(session.participantCount) ||
        session.participantCount < 0
      ) {
        throw new Error("Unexpected participant count");
      }
      return { status: "observed", participantCount: session.participantCount };
    } catch (error) {
      signal.throwIfAborted();
      emit({
        kind: "presence_unavailable",
        voiceRoomId: candidate.voiceRoomId,
        errorClass: errorClassOf(error),
      });
      return { status: "unavailable" };
    }
  }

  async function endRoom(
    candidate: VoiceRoomReapCandidate,
    reason: VoiceRoomReapReason,
    signal: AbortSignal,
  ): Promise<"ended_confirmed" | "ended_unconfirmed" | "skipped"> {
    const requestId = createUuid();
    const outcome = await options.repository.endVoiceRoomByReaper({
      voiceRoomId: candidate.voiceRoomId,
      reason,
      idleEndMinutes: options.thresholds.idleEndMinutes,
      maxLiveHours: options.thresholds.maxLiveHours,
      requestId,
    });
    if (outcome.outcome === "skipped") {
      return "skipped";
    }
    const reasonCode = voiceRoomReaperReasonCodes[reason];
    let providerSync: "confirmed" | "unconfirmed" = "confirmed";
    try {
      await options.callGateway.endCall({ callId: outcome.callId, signal });
    } catch (error) {
      providerSync = "unconfirmed";
      emit({
        kind: "end_unconfirmed",
        voiceRoomId: candidate.voiceRoomId,
        reasonCode: voiceRoomProviderSyncReasonCodes.end,
        detailReasonCode: reasonCode,
        errorClass: errorClassOf(error),
        requestId,
      });
    }
    emit({
      kind: "ended",
      voiceRoomId: candidate.voiceRoomId,
      reasonCode,
      providerSync,
      requestId,
    });
    return providerSync === "confirmed"
      ? "ended_confirmed"
      : "ended_unconfirmed";
  }

  return Object.freeze({
    async runOnce(signal: AbortSignal): Promise<VoiceRoomReaperRunResult> {
      const counts = {
        examinedCount: 0,
        endedIdleCount: 0,
        endedMaxAgeCount: 0,
        keptCount: 0,
        skippedCount: 0,
        presenceUnavailableCount: 0,
        providerUnconfirmedCount: 0,
        failedCount: 0,
      };
      const result = (
        kind: VoiceRoomReaperRunResult["kind"],
      ): VoiceRoomReaperRunResult => Object.freeze({ kind, ...counts });
      if (isAborted(signal)) {
        return result("aborted");
      }
      const candidates = await options.repository.listLiveVoiceRoomsForReaper({
        limit: VOICE_ROOM_REAPER_BATCH_LIMIT,
      });
      for (const candidate of candidates.slice(
        0,
        VOICE_ROOM_REAPER_BATCH_LIMIT,
      )) {
        if (isAborted(signal)) {
          return result("aborted");
        }
        counts.examinedCount += 1;
        try {
          const verdict = classifyVoiceRoomForReap(
            candidate,
            options.thresholds,
          );
          let reason: VoiceRoomReapReason | null = null;
          if (verdict === "end_max_age") {
            reason = "max_age";
          } else if (verdict === "needs_presence") {
            const presence = await observePresence(candidate, signal);
            if (presence.status === "unavailable") {
              counts.presenceUnavailableCount += 1;
            }
            if (isIdleByPresence(presence)) {
              reason = "idle";
            }
          }
          if (reason === null) {
            counts.keptCount += 1;
            continue;
          }
          const ended = await endRoom(candidate, reason, signal);
          if (ended === "skipped") {
            counts.skippedCount += 1;
            continue;
          }
          if (reason === "idle") {
            counts.endedIdleCount += 1;
          } else {
            counts.endedMaxAgeCount += 1;
          }
          if (ended === "ended_unconfirmed") {
            counts.providerUnconfirmedCount += 1;
          }
        } catch (error) {
          if (isAborted(signal)) {
            return result("aborted");
          }
          counts.failedCount += 1;
          emit({
            kind: "room_failed",
            voiceRoomId: candidate.voiceRoomId,
            errorClass: errorClassOf(error),
          });
        }
      }
      return result("completed");
    },
  });
}
