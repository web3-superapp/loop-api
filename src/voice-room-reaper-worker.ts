import type {
  VoiceRoomReaperRunResult,
  VoiceRoomReaperService,
} from "./features/communication/voice-room-reaper-service.js";

export const VOICE_ROOM_REAPER_RETRY_BASE_DELAY_MS = 1_000;
export const VOICE_ROOM_REAPER_RETRY_MAX_DELAY_MS = 60_000;

export interface VoiceRoomReaperInfrastructureBackoff {
  readonly reasonCode: "voice_room_reaper_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface VoiceRoomReaperWorker {
  readonly runOnce: (signal: AbortSignal) => Promise<VoiceRoomReaperRunResult>;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface CreateVoiceRoomReaperWorkerOptions {
  readonly service: VoiceRoomReaperService;
  /** `VOICE_ROOM_REAPER_INTERVAL_MS`, default 60 000. */
  readonly intervalMs: number;
  readonly onInfrastructureBackoff?: (
    event: VoiceRoomReaperInfrastructureBackoff,
  ) => void;
}

/** A function, not a property read, so the check is not narrowed away. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (isAborted(signal)) {
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

function retryDelayMs(consecutiveFailureCount: number): number {
  return Math.min(
    VOICE_ROOM_REAPER_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    VOICE_ROOM_REAPER_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The `voice_room_reaper` lane loop (Decision 0094). A failed pass (the
 * listing read could not be made) backs off and retries; it never rejects
 * the loop, so it cannot stop the worker's other lanes.
 */
export function createVoiceRoomReaperWorker(
  options: CreateVoiceRoomReaperWorkerOptions,
): VoiceRoomReaperWorker {
  let loopRunning = false;

  return Object.freeze({
    runOnce: (signal: AbortSignal) => options.service.runOnce(signal),
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The voice room reaper loop is already running");
      }
      loopRunning = true;
      let consecutiveFailureCount = 0;
      try {
        while (!isAborted(signal)) {
          try {
            const result = await options.service.runOnce(signal);
            if (result.kind === "aborted") {
              break;
            }
            consecutiveFailureCount = 0;
            await waitFor(options.intervalMs, signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailureCount += 1;
            const delay = retryDelayMs(consecutiveFailureCount);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "voice_room_reaper_unavailable",
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
