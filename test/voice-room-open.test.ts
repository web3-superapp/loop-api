import { describe, expect, it, vi } from "vitest";

import {
  parseVoiceRoomOpenRequest,
  runVoiceRoomOpen,
  VoiceRoomOpenError,
  type CreateVoiceRoomOpenDependencies,
  type VoiceRoomOwnerPrincipal,
} from "../scripts/voice-room-open.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import {
  createUnavailableVoiceRoomService,
  type VoiceRoomResource,
  type VoiceRoomService,
} from "../src/features/communication/voice-room-service.js";

const communityId = "439cabe6-4c98-4f99-860f-192ad52403a1";
const voiceRoomId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const databaseUrl = "postgres://loop_api:local@127.0.0.1:5433/loop_api_s30";
const development = { NODE_ENV: "development", DATABASE_URL: databaseUrl };
const owner: VoiceRoomOwnerPrincipal = Object.freeze({
  userId: "7e25420e-d7ca-4645-b486-0b1f9e734dad",
  privyUserId: "did:privy:owner",
  streamUserId: "loop_7e25420ed7ca4645b4860b1f9e734dad",
});

function resource(
  provisionState: "provisioned" | "reconciling",
): VoiceRoomResource {
  return Object.freeze({
    room: Object.freeze({
      voiceRoomId,
      communityId,
      callCid: "audio_room:loop_voice_3fa85f6457174562b3fc2c963f66afa6",
      state: "live",
      provisionState,
      backstage: true,
      createdAt: "2026-09-17T07:00:00.000Z",
      endedAt: null,
    }),
    viewer: Object.freeze({
      role: "host",
      canInviteSpeakers: true,
      canMuteAll: true,
      canEndRoom: true,
      handRaise: null,
      expiresAt: "2026-09-17T08:00:00.000Z",
    }),
    participants: Object.freeze({
      speakerCount: 1,
      listenerCount: 0,
      observed: Object.freeze({
        status: "unavailable",
        reasonCode: "STREAM_PARTICIPANT_COUNT_NOT_OBSERVED",
      }),
    }),
    providerSync:
      provisionState === "provisioned"
        ? Object.freeze({ status: "confirmed", reasonCode: null })
        : Object.freeze({
            status: "unconfirmed",
            reasonCode: "STREAM_CALL_CREATE_UNCONFIRMED",
          }),
    contractVersion: "2.0",
  });
}

function outputWriter() {
  let output = "";
  return {
    contents: () => output,
    write(value: string): boolean {
      output += value;
      return true;
    },
  };
}

function dependenciesFake(options: {
  readonly createRoom?: VoiceRoomService["createRoom"];
  readonly owner?: VoiceRoomOwnerPrincipal | null;
}) {
  const createRoom = vi.fn<VoiceRoomService["createRoom"]>(
    options.createRoom ?? (() => Promise.resolve(resource("provisioned"))),
  );
  const close = vi.fn(() => Promise.resolve());
  const findOwner = vi.fn(() =>
    Promise.resolve("owner" in options ? options.owner : owner),
  );
  const create: CreateVoiceRoomOpenDependencies = () => ({
    service: { ...createUnavailableVoiceRoomService(), createRoom },
    findOwner,
    close,
  });
  return { create, createRoom, findOwner, close };
}

describe("pnpm voice-room:open operator script", () => {
  it("refuses production before opening a connection", () => {
    expect(() =>
      parseVoiceRoomOpenRequest(["node", "s", communityId, "--confirm"], {
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "voice_room_open_forbidden_in_production",
      }),
    );
  });

  it("requires one opaque community id, --confirm, and DATABASE_URL", () => {
    for (const argv of [
      ["node", "s", "--confirm"],
      ["node", "s", "not-a-uuid", "--confirm"],
      ["node", "s", communityId, communityId, "--confirm"],
    ]) {
      expect(() => parseVoiceRoomOpenRequest(argv, development)).toThrow(
        expect.objectContaining({ code: "voice_room_open_arguments_invalid" }),
      );
    }
    expect(() =>
      parseVoiceRoomOpenRequest(["node", "s", communityId], development),
    ).toThrow(
      expect.objectContaining({
        code: "voice_room_open_confirmation_required",
      }),
    );
    expect(() =>
      parseVoiceRoomOpenRequest(["node", "s", communityId, "--confirm"], {
        NODE_ENV: "development",
      }),
    ).toThrow(VoiceRoomOpenError);
  });

  it("opens the room as the community owner through the product service", async () => {
    const fake = dependenciesFake({});
    const stdout = outputWriter();
    const stderr = outputWriter();
    const code = await runVoiceRoomOpen({
      argv: ["node", "s", communityId, "--confirm"],
      environment: development,
      stdout,
      stderr,
      createDependencies: fake.create,
    });
    expect(code).toBe(0);
    expect(fake.findOwner).toHaveBeenCalledWith(communityId);
    expect(fake.createRoom).toHaveBeenCalledTimes(1);
    const input = fake.createRoom.mock.calls[0]?.[0];
    expect(input).toMatchObject({ principal: owner, communityId });
    expect(input?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(input?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(input?.signal).toBeInstanceOf(AbortSignal);
    expect(stdout.contents()).toBe(
      `Voice room ${voiceRoomId} is live in community ${communityId} (call audio_room:loop_voice_3fa85f6457174562b3fc2c963f66afa6, provisionState provisioned, providerSync confirmed)\n`,
    );
    expect(stderr.contents()).toBe("");
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfirmed Stream call honestly and exits 1", async () => {
    const fake = dependenciesFake({
      createRoom: () => Promise.resolve(resource("reconciling")),
    });
    const stdout = outputWriter();
    const code = await runVoiceRoomOpen({
      argv: ["node", "s", communityId, "--confirm"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createDependencies: fake.create,
    });
    expect(code).toBe(1);
    expect(stdout.contents()).toContain(
      "provisionState reconciling, providerSync unconfirmed STREAM_CALL_CREATE_UNCONFIRMED",
    );
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces the route's own error code when a live room already exists", async () => {
    const fake = dependenciesFake({
      createRoom: () =>
        Promise.reject(V2ApiError.fromCode("RESOURCE_CONFLICT")),
    });
    const stderr = outputWriter();
    const code = await runVoiceRoomOpen({
      argv: ["node", "s", communityId, "--confirm"],
      environment: development,
      stdout: outputWriter(),
      stderr,
      createDependencies: fake.create,
    });
    expect(code).toBe(1);
    expect(stderr.contents()).toBe(
      "Voice room open failed (RESOURCE_CONFLICT)\n",
    );
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a community without an owner and still closes the pool", async () => {
    const fake = dependenciesFake({ owner: null });
    const stderr = outputWriter();
    const code = await runVoiceRoomOpen({
      argv: ["node", "s", communityId, "--confirm"],
      environment: development,
      stdout: outputWriter(),
      stderr,
      createDependencies: fake.create,
    });
    expect(code).toBe(1);
    expect(fake.createRoom).not.toHaveBeenCalled();
    expect(stderr.contents()).toContain("voice_room_open_owner_not_found");
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
