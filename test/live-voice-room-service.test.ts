import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import {
  CommunicationRepositoryUnavailableError,
  createUnavailableCommunicationRepository,
  type LiveVoiceRoomRecord,
} from "../src/features/communication/communication-repository.js";
import {
  createUnavailableVoiceRoomService,
  createVoiceRoomService,
} from "../src/features/communication/voice-room-service.js";
import { createUnavailableStreamCallGateway } from "../src/integrations/stream/call-gateway.js";

/** Decision 0093: the live voice-room list service. */

const viewerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const hostUserId = "7d23b97f-5245-48f7-a423-d6f086b41f66";
const now = new Date("2026-10-08T04:00:00.000Z");
const codec = createV2CursorCodec({
  secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
  now: () => now,
});

const principal = {
  userId: viewerUserId,
} as unknown as AuthenticatedLoopPrincipal;

function row(
  index: number,
  host: Partial<LiveVoiceRoomRecord["host"]> = {},
): LiveVoiceRoomRecord {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    voiceRoomId: `8c7b6a59-4d3e-4f21-8a0b-${suffix}`,
    communityId: `3fa85f64-5717-4562-b3fc-${suffix}`,
    communityName: `Community ${String(index)}`,
    communityLogoRef: null,
    startedAt: new Date(now.getTime() - index * 60_000).toISOString(),
    host: {
      ownerUserId: hostUserId,
      publicProfileId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
      alias: "frog_maxi",
      avatarRef: "avatar:preset/people-03",
      anonymousMode: false,
      ...host,
    },
    speakerCount: index,
    listenerCount: index * 2,
    viewerIsCommunityMember: index % 2 === 0,
  };
}

function service(rows: readonly LiveVoiceRoomRecord[] | Error) {
  const listLiveVoiceRooms = vi.fn(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  );
  return {
    listLiveVoiceRooms,
    service: createVoiceRoomService({
      repository: {
        ...createUnavailableCommunicationRepository(),
        listLiveVoiceRooms,
      },
      callGateway: createUnavailableStreamCallGateway(),
      cursorCodec: codec,
      now: () => now,
    }),
  };
}

const read = {
  principal,
  requestId: "req-1",
  signal: new AbortController().signal,
} as const;

describe("VoiceRoomService.listLiveRooms (Decision 0093)", () => {
  it("defaults to 20 rows, asks for one more, and stamps the read time", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => row(index));
    const { service: live, listLiveVoiceRooms } = service(rows);
    const page = await live.listLiveRooms({
      ...read,
      cursor: undefined,
      limit: undefined,
    });
    expect(listLiveVoiceRooms).toHaveBeenCalledWith({
      viewerUserId,
      limit: 21,
    });
    expect(page.items).toHaveLength(20);
    expect(page.observedAt).toBe(now.toISOString());
    expect(page.contractVersion).toBe("2.0");
    expect(typeof page.nextCursor).toBe("string");
    expect(
      codec.decode({
        ownerId: viewerUserId,
        route: "liveVoiceRooms",
        filter: "live",
        cursor: page.nextCursor ?? "",
      }),
    ).toEqual({
      startedAt: rows[19]?.startedAt,
      limit: 20,
      voiceRoomId: rows[19]?.voiceRoomId,
    });
    expect(page.items[0]).toEqual({
      voiceRoomId: rows[0]?.voiceRoomId,
      communityId: rows[0]?.communityId,
      communityName: "Community 0",
      communityLogoRef: null,
      title: null,
      host: {
        publicProfileId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
        displayName: "frog_maxi",
        avatarRef: "avatar:preset/people-03",
      },
      listenerCount: 0,
      speakerCount: 0,
      countsObservedAt: null,
      startedAt: rows[0]?.startedAt,
      joinable: true,
    });
    expect(page.items[1]?.joinable).toBe(false);
  });

  it("returns no cursor on the last page and an empty list when nothing is live", async () => {
    const { service: live } = service([]);
    const page = await live.listLiveRooms({
      ...read,
      cursor: undefined,
      limit: 5,
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("hides an anonymous host, a host without an alias, and a host without a profile", async () => {
    const { service: live } = service([
      row(0, { anonymousMode: true }),
      row(1, { alias: null }),
      row(2, { publicProfileId: null, alias: null, avatarRef: null }),
      row(3, { ownerUserId: viewerUserId, anonymousMode: true }),
    ]);
    const page = await live.listLiveRooms({
      ...read,
      cursor: undefined,
      limit: undefined,
    });
    const hidden = {
      publicProfileId: null,
      displayName: null,
      avatarRef: null,
    };
    expect(page.items.map((item) => item.host)).toEqual([
      hidden,
      hidden,
      hidden,
      // The viewer always sees its own alias.
      {
        publicProfileId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
        displayName: "frog_maxi",
        avatarRef: "avatar:preset/people-03",
      },
    ]);
  });

  it("refuses an out-of-range limit, limit with cursor, and a cursor without its keys", async () => {
    const { service: live, listLiveVoiceRooms } = service([]);
    const keyless = codec.encode({
      ownerId: viewerUserId,
      route: "liveVoiceRooms",
      filter: "live",
      continuation: { limit: 2 },
    });
    // An out-of-range limit is the shared community list-limit refusal,
    // which the V2 error handler answers as 400 INVALID_REQUEST (route test).
    for (const limit of [0, 51, 2.5]) {
      await expect(
        live.listLiveRooms({ ...read, cursor: undefined, limit }),
      ).rejects.toMatchObject({ code: "invalid_community_request" });
    }
    for (const input of [
      { cursor: keyless, limit: 2 },
      { cursor: keyless, limit: undefined },
      { cursor: 42, limit: undefined },
    ]) {
      await expect(
        live.listLiveRooms({ ...read, ...input }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", statusCode: 400 });
    }
    expect(listLiveVoiceRooms).not.toHaveBeenCalled();
  });

  it("fails closed when the repository or the service is unavailable", async () => {
    const { service: live } = service(
      new CommunicationRepositoryUnavailableError(),
    );
    await expect(
      live.listLiveRooms({ ...read, cursor: undefined, limit: undefined }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      statusCode: 503,
    });
    await expect(
      createUnavailableVoiceRoomService().listLiveRooms({
        ...read,
        cursor: undefined,
        limit: undefined,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
