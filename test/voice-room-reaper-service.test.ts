import { describe, expect, it, vi } from "vitest";

import type {
  VoiceRoomReapCandidate,
  VoiceRoomReaperRepository,
} from "../src/features/communication/communication-repository.js";
import {
  classifyVoiceRoomForReap,
  createVoiceRoomReaperService,
  isIdleByPresence,
  VOICE_ROOM_REAPER_BATCH_LIMIT,
  type VoiceRoomReaperEvent,
} from "../src/features/communication/voice-room-reaper-service.js";
import {
  createUnavailableStreamCallGateway,
  StreamCallGatewayUnavailableError,
  type StreamCallGateway,
} from "../src/integrations/stream/call-gateway.js";
import {
  createVoiceRoomReaperWorker,
  type VoiceRoomReaperInfrastructureBackoff,
} from "../src/voice-room-reaper-worker.js";

const thresholds = Object.freeze({ idleEndMinutes: 10, maxLiveHours: 12 });
const now = "2026-10-08T12:00:00.000Z";
const requestId = "8f9a0c1e-2b3d-4e5f-8a6b-7c8d9e0f1a2b";

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(now) - minutes * 60_000).toISOString();
}

let roomSequence = 0;
function candidate(
  overrides: Partial<VoiceRoomReapCandidate> = {},
): VoiceRoomReapCandidate {
  roomSequence += 1;
  const suffix = roomSequence.toString(16).padStart(12, "0");
  return {
    voiceRoomId: `0f0e0d0c-0b0a-4908-8706-${suffix}`,
    callId: `loop_voice_${"a".repeat(20)}${suffix}`,
    provisionState: "provisioned",
    createdAt: minutesAgo(60),
    lastActivityAt: minutesAgo(30),
    nonHostJoinedCount: 0,
    databaseNow: now,
    ...overrides,
  };
}

function fakeRepository(
  candidates: readonly VoiceRoomReapCandidate[],
  end: VoiceRoomReaperRepository["endVoiceRoomByReaper"] = (input) =>
    Promise.resolve({
      outcome: "ended",
      callId:
        candidates.find((room) => room.voiceRoomId === input.voiceRoomId)
          ?.callId ?? "loop_voice_" + "0".repeat(32),
    }),
) {
  return {
    listLiveVoiceRoomsForReaper: vi.fn(() => Promise.resolve(candidates)),
    endVoiceRoomByReaper: vi.fn(end),
  } satisfies VoiceRoomReaperRepository;
}

function fakeGateway(
  participants: number | Error = 0,
  endError: Error | null = null,
) {
  const base = createUnavailableStreamCallGateway();
  const observeSession = vi.fn(() =>
    participants instanceof Error
      ? Promise.reject(participants)
      : Promise.resolve({
          participantCount: participants,
          sessionActive: participants > 0,
          observedAt: now,
        }),
  );
  const endCall = vi.fn(() =>
    endError === null ? Promise.resolve() : Promise.reject(endError),
  );
  const gateway: StreamCallGateway = { ...base, observeSession, endCall };
  return { gateway, observeSession, endCall };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("classifyVoiceRoomForReap (Decision 0094)", () => {
  it("ends a room live for the hard cap regardless of who is in it", () => {
    expect(
      classifyVoiceRoomForReap(
        candidate({
          createdAt: minutesAgo(12 * 60),
          nonHostJoinedCount: 40,
          lastActivityAt: now,
        }),
        thresholds,
      ),
    ).toBe("end_max_age");
  });

  it("keeps a room just under the hard cap that has a joined listener", () => {
    expect(
      classifyVoiceRoomForReap(
        candidate({
          createdAt: minutesAgo(12 * 60 - 1),
          nonHostJoinedCount: 1,
        }),
        thresholds,
      ),
    ).toBe("occupied");
  });

  it("keeps a room whose last LOOP change is within the idle window", () => {
    expect(
      classifyVoiceRoomForReap(
        candidate({ lastActivityAt: minutesAgo(9) }),
        thresholds,
      ),
    ).toBe("recent_activity");
  });

  it("asks Stream once nobody but the host has been seen for the idle window", () => {
    expect(
      classifyVoiceRoomForReap(
        candidate({ lastActivityAt: minutesAgo(10) }),
        thresholds,
      ),
    ).toBe("needs_presence");
  });

  it("honours configured thresholds", () => {
    const room = candidate({
      createdAt: minutesAgo(90),
      lastActivityAt: minutesAgo(3),
    });
    expect(
      classifyVoiceRoomForReap(room, { idleEndMinutes: 2, maxLiveHours: 12 }),
    ).toBe("needs_presence");
    expect(
      classifyVoiceRoomForReap(room, { idleEndMinutes: 10, maxLiveHours: 1 }),
    ).toBe("end_max_age");
  });

  it("treats only an observed zero as idle", () => {
    expect(isIdleByPresence({ status: "observed", participantCount: 0 })).toBe(
      true,
    );
    expect(isIdleByPresence({ status: "observed", participantCount: 1 })).toBe(
      false,
    );
    expect(isIdleByPresence({ status: "unavailable" })).toBe(false);
  });
});

describe("createVoiceRoomReaperService (Decision 0094)", () => {
  it("ends an idle room with nobody connected: LOOP first, then one Stream end", async () => {
    const room = candidate();
    const repository = fakeRepository([room]);
    const { gateway, observeSession, endCall } = fakeGateway(0);
    const events: VoiceRoomReaperEvent[] = [];
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
      onEvent: (event) => events.push(event),
      createUuid: () => requestId,
    });

    const result = await service.runOnce(signal());

    expect(result).toMatchObject({
      kind: "completed",
      examinedCount: 1,
      endedIdleCount: 1,
      endedMaxAgeCount: 0,
      providerUnconfirmedCount: 0,
    });
    expect(repository.listLiveVoiceRoomsForReaper).toHaveBeenCalledWith({
      limit: 50,
    });
    expect(observeSession).toHaveBeenCalledTimes(1);
    expect(repository.endVoiceRoomByReaper).toHaveBeenCalledWith({
      voiceRoomId: room.voiceRoomId,
      reason: "idle",
      idleEndMinutes: 10,
      maxLiveHours: 12,
      requestId,
    });
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(
      repository.endVoiceRoomByReaper.mock.invocationCallOrder[0],
    ).toBeLessThan(endCall.mock.invocationCallOrder[0] ?? 0);
    expect(events).toEqual([
      {
        kind: "ended",
        voiceRoomId: room.voiceRoomId,
        reasonCode: "VOICE_ROOM_IDLE_ENDED",
        providerSync: "confirmed",
        requestId,
      },
    ]);
  });

  it("keeps an idle-looking room while Stream reports a connected device", async () => {
    const repository = fakeRepository([candidate()]);
    const { gateway, endCall } = fakeGateway(1);
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
    });

    expect(await service.runOnce(signal())).toMatchObject({
      keptCount: 1,
      endedIdleCount: 0,
    });
    expect(repository.endVoiceRoomByReaper).not.toHaveBeenCalled();
    expect(endCall).not.toHaveBeenCalled();
  });

  it("keeps the room when Stream presence cannot be read (unknown is not empty)", async () => {
    const room = candidate();
    const repository = fakeRepository([room]);
    const { gateway } = fakeGateway(
      new StreamCallGatewayUnavailableError("timeout"),
    );
    const events: VoiceRoomReaperEvent[] = [];
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
      onEvent: (event) => events.push(event),
    });

    expect(await service.runOnce(signal())).toMatchObject({
      keptCount: 1,
      presenceUnavailableCount: 1,
    });
    expect(repository.endVoiceRoomByReaper).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        kind: "presence_unavailable",
        voiceRoomId: room.voiceRoomId,
        errorClass: "StreamCallGatewayUnavailableError",
      },
    ]);
  });

  it("does not observe an unprovisioned room and keeps it until the hard cap", async () => {
    const repository = fakeRepository([
      candidate({ provisionState: "reconciling" }),
    ]);
    const { gateway, observeSession } = fakeGateway(0);
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
    });

    expect(await service.runOnce(signal())).toMatchObject({
      keptCount: 1,
      presenceUnavailableCount: 1,
    });
    expect(observeSession).not.toHaveBeenCalled();
    expect(repository.endVoiceRoomByReaper).not.toHaveBeenCalled();
  });

  it("never reads Stream for an occupied or recently active room", async () => {
    const repository = fakeRepository([
      candidate({ nonHostJoinedCount: 2 }),
      candidate({ lastActivityAt: minutesAgo(1) }),
    ]);
    const { gateway, observeSession } = fakeGateway(0);
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
    });

    expect(await service.runOnce(signal())).toMatchObject({
      examinedCount: 2,
      keptCount: 2,
    });
    expect(observeSession).not.toHaveBeenCalled();
    expect(repository.endVoiceRoomByReaper).not.toHaveBeenCalled();
  });

  it("ends an over-age room without reading presence", async () => {
    const room = candidate({
      createdAt: minutesAgo(13 * 60),
      nonHostJoinedCount: 5,
      lastActivityAt: now,
    });
    const repository = fakeRepository([room]);
    const { gateway, observeSession, endCall } = fakeGateway(3);
    const events: VoiceRoomReaperEvent[] = [];
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
      onEvent: (event) => events.push(event),
      createUuid: () => requestId,
    });

    expect(await service.runOnce(signal())).toMatchObject({
      endedMaxAgeCount: 1,
      endedIdleCount: 0,
    });
    expect(observeSession).not.toHaveBeenCalled();
    expect(repository.endVoiceRoomByReaper).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "max_age" }),
    );
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "ended",
        reasonCode: "VOICE_ROOM_MAX_AGE_ENDED",
        providerSync: "confirmed",
      }),
    ]);
  });

  it("reports an unconfirmed Stream end without retrying and keeps the LOOP end", async () => {
    const room = candidate();
    const repository = fakeRepository([room]);
    const { gateway, endCall } = fakeGateway(
      0,
      new StreamCallGatewayUnavailableError("timeout"),
    );
    const events: VoiceRoomReaperEvent[] = [];
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
      onEvent: (event) => events.push(event),
      createUuid: () => requestId,
    });

    expect(await service.runOnce(signal())).toMatchObject({
      endedIdleCount: 1,
      providerUnconfirmedCount: 1,
    });
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        kind: "end_unconfirmed",
        voiceRoomId: room.voiceRoomId,
        reasonCode: "STREAM_CALL_END_UNCONFIRMED",
        detailReasonCode: "VOICE_ROOM_IDLE_ENDED",
        errorClass: "StreamCallGatewayUnavailableError",
        requestId,
      },
      {
        kind: "ended",
        voiceRoomId: room.voiceRoomId,
        reasonCode: "VOICE_ROOM_IDLE_ENDED",
        providerSync: "unconfirmed",
        requestId,
      },
    ]);
  });

  it("makes no Stream end when the row-locked re-check skips the room", async () => {
    const repository = fakeRepository([candidate()], () =>
      Promise.resolve({ outcome: "skipped" }),
    );
    const { gateway, endCall } = fakeGateway(0);
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
    });

    expect(await service.runOnce(signal())).toMatchObject({
      skippedCount: 1,
      endedIdleCount: 0,
    });
    expect(endCall).not.toHaveBeenCalled();
  });

  it("isolates a failing room and continues with the next", async () => {
    const failing = candidate({ createdAt: minutesAgo(13 * 60) });
    const healthy = candidate({ createdAt: minutesAgo(13 * 60) });
    const repository = fakeRepository([failing, healthy], (input) =>
      input.voiceRoomId === failing.voiceRoomId
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ outcome: "ended", callId: healthy.callId }),
    );
    const { gateway } = fakeGateway(0);
    const events: VoiceRoomReaperEvent[] = [];
    const service = createVoiceRoomReaperService({
      repository,
      callGateway: gateway,
      thresholds,
      onEvent: (event) => events.push(event),
    });

    expect(await service.runOnce(signal())).toMatchObject({
      examinedCount: 2,
      failedCount: 1,
      endedMaxAgeCount: 1,
    });
    expect(events[0]).toEqual({
      kind: "room_failed",
      voiceRoomId: failing.voiceRoomId,
      errorClass: "Error",
    });
  });

  it("examines at most 50 rooms per pass", async () => {
    const rooms = Array.from({ length: 60 }, () =>
      candidate({ nonHostJoinedCount: 1 }),
    );
    const service = createVoiceRoomReaperService({
      repository: fakeRepository(rooms),
      callGateway: fakeGateway(0).gateway,
      thresholds,
    });

    expect(VOICE_ROOM_REAPER_BATCH_LIMIT).toBe(50);
    expect(await service.runOnce(signal())).toMatchObject({
      examinedCount: 50,
    });
  });

  it("rejects when the listing read fails, and stops on abort", async () => {
    const failing = createVoiceRoomReaperService({
      repository: {
        listLiveVoiceRoomsForReaper: () => Promise.reject(new Error("down")),
        endVoiceRoomByReaper: vi.fn(),
      },
      callGateway: fakeGateway(0).gateway,
      thresholds,
    });
    await expect(failing.runOnce(signal())).rejects.toThrow("down");

    const repository = fakeRepository([candidate()]);
    const controller = new AbortController();
    controller.abort();
    const aborted = createVoiceRoomReaperService({
      repository,
      callGateway: fakeGateway(0).gateway,
      thresholds,
    });
    expect(await aborted.runOnce(controller.signal)).toMatchObject({
      kind: "aborted",
      examinedCount: 0,
    });
    expect(repository.listLiveVoiceRoomsForReaper).not.toHaveBeenCalled();
  });
});

describe("createVoiceRoomReaperWorker (Decision 0094)", () => {
  it("backs off on a failed pass and never rejects the loop", async () => {
    const controller = new AbortController();
    const backoffs: VoiceRoomReaperInfrastructureBackoff[] = [];
    let calls = 0;
    const worker = createVoiceRoomReaperWorker({
      intervalMs: 5_000,
      service: {
        runOnce: () => {
          calls += 1;
          if (calls === 2) {
            controller.abort();
          }
          return Promise.reject(new Error("listing failed"));
        },
      },
      onInfrastructureBackoff: (event) => backoffs.push(event),
    });

    vi.useFakeTimers();
    try {
      const loop = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(loop).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(2);
    expect(backoffs).toEqual([
      {
        reasonCode: "voice_room_reaper_unavailable",
        consecutiveFailureCount: 1,
        retryDelayMs: 1_000,
      },
    ]);
  });

  it("waits the configured interval between completed passes", async () => {
    const controller = new AbortController();
    const runOnce = vi.fn(() =>
      Promise.resolve({
        kind: "completed" as const,
        examinedCount: 0,
        endedIdleCount: 0,
        endedMaxAgeCount: 0,
        keptCount: 0,
        skippedCount: 0,
        presenceUnavailableCount: 0,
        providerUnconfirmedCount: 0,
        failedCount: 0,
      }),
    );
    const worker = createVoiceRoomReaperWorker({
      intervalMs: 60_000,
      service: { runOnce },
    });

    vi.useFakeTimers();
    try {
      const loop = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runOnce).toHaveBeenCalledTimes(2);
      controller.abort();
      await loop;
    } finally {
      vi.useRealTimers();
    }
  });
});
