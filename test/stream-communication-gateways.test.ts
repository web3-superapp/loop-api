import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStreamCallGateway,
  createUnavailableStreamCallGateway,
  StreamCallGatewayUnavailableError,
  StreamCallProjectionMismatchError,
} from "../src/integrations/stream/call-gateway.js";
import {
  createStreamCommunityChannelGateway,
  createUnavailableStreamCommunityChannelGateway,
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  StreamChannelRequestRejectedError,
} from "../src/integrations/stream/channel-gateway.js";

const apiKey = "stream_test_api_key";
const apiSecret = "stream_test_api_secret";
const communityChannelId = "loop_community_0123456789abcdef0123456789abcdef";
const groupChannelId = "loop_group_0123456789abcdef0123456789abcdef";
const callId = "loop_voice_0123456789abcdef0123456789abcdef";
const hostUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const memberUserId = "loop_f7bf09f6017146b99acd5ad494f211bd";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
  });
}

function channelResponse(
  channelId: string,
  kind: "community" | "group",
  memberCount = 2,
): Record<string, unknown> {
  return {
    duration: "1ms",
    channel: {
      id: channelId,
      type: "messaging",
      cid: `messaging:${channelId}`,
      created_by: { id: hostUserId },
      custom: {
        loop_channel_kind: kind,
        loop_channel_schema_version: 1,
        name: "Frog Holders",
      },
      member_count: memberCount,
    },
    members: [],
  };
}

function callResponse(overrides: Record<string, unknown> = {}) {
  return {
    duration: "1ms",
    created: true,
    members: [],
    own_capabilities: [],
    call: {
      id: callId,
      type: "audio_room",
      cid: `audio_room:${callId}`,
      backstage: true,
      custom: {
        loop_call_kind: "communityVoiceRoom",
        loop_call_schema_version: 1,
      },
      ...overrides,
    },
  };
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): URL {
  const call: unknown = fetchMock.mock.calls[index];
  const value: unknown = Array.isArray(call) ? call[0] : undefined;
  if (typeof value !== "string") {
    throw new Error("Expected the Stream SDK to call fetch with a URL string");
  }
  return new URL(value);
}

function requestBody(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): unknown {
  const call: unknown = fetchMock.mock.calls[index];
  const init: unknown = Array.isArray(call) ? call[1] : undefined;
  if (typeof init !== "object" || init === null) {
    throw new Error("Expected request init");
  }
  const body = (init as RequestInit).body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as unknown;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stream community channel gateway", () => {
  it("fails closed without credentials", async () => {
    const gateway = createUnavailableStreamCommunityChannelGateway();
    const unavailable = new StreamChannelGatewayUnavailableError();

    await expect(
      gateway.upsertCommunityChannel({
        channelId: communityChannelId,
        createdByStreamUserId: hostUserId,
        name: "Frog Holders",
        signal: signal(),
      }),
    ).rejects.toEqual(unavailable);
    await expect(
      gateway.addMembers({
        channelId: communityChannelId,
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(unavailable);
    await expect(
      gateway.removeMembers({
        channelId: communityChannelId,
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(unavailable);
  });

  it("fails closed on partial credentials", async () => {
    const gateway = createStreamCommunityChannelGateway({
      apiKey: "",
      apiSecret,
    });
    await expect(
      gateway.addMembers({
        channelId: communityChannelId,
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
  });

  it("upserts the joining Stream user before adding it to the channel", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          users: { [memberUserId]: { id: memberUserId } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(channelResponse(communityChannelId, "community", 2_500)),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });

    await expect(
      gateway.addMembers({
        channelId: communityChannelId,
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).resolves.toEqual({
      channelId: communityChannelId,
      streamCid: `messaging:${communityChannelId}`,
      memberCount: 2_500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedUrl(fetchMock, 0).pathname).toBe("/api/v2/users");
    // The joiner is published with an ID and nothing else: LOOP never sends
    // profile facts to Stream.
    expect(requestBody(fetchMock, 0)).toEqual({
      users: { [memberUserId]: { id: memberUserId } },
    });
    expect(requestedUrl(fetchMock, 1).pathname).toBe(
      `/api/v2/chat/channels/messaging/${communityChannelId}`,
    );
    expect(requestBody(fetchMock, 1)).toEqual({
      user_id: hostUserId,
      add_members: [{ user_id: memberUserId }],
    });
  });

  it("reports a deterministic client rejection as terminal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          users: { [memberUserId]: { id: memberUserId } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 4, message: "UpdateChannel failed", StatusCode: 400 },
          400,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });

    await expect(
      gateway.addMembers({
        channelId: communityChannelId,
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamChannelRequestRejectedError());
  });

  it("keeps a quota answer and a provider fault retryable", async () => {
    for (const status of [429, 500]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            duration: "1ms",
            users: { [memberUserId]: { id: memberUserId } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ code: 9, message: "try later" }, status),
        );
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCommunityChannelGateway({
        apiKey,
        apiSecret,
      });

      await expect(
        gateway.addMembers({
          channelId: communityChannelId,
          actingStreamUserId: hostUserId,
          memberStreamUserIds: [memberUserId],
          signal: signal(),
        }),
      ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
    }
  });

  it("removes a member and accepts the group channel kind", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(channelResponse(groupChannelId, "group")),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });

    await expect(
      gateway.removeMembers({
        channelId: groupChannelId,
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).resolves.toMatchObject({ channelId: groupChannelId });
    expect(requestBody(fetchMock, 0)).toEqual({
      user_id: hostUserId,
      remove_members: [memberUserId],
    });
  });

  it("rejects a channel whose authoritative kind does not match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          users: { [memberUserId]: { id: memberUserId } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(channelResponse(communityChannelId, "group")),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });

    await expect(
      gateway.addMembers({
        channelId: communityChannelId,
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamChannelProjectionMismatchError());
  });

  it("refuses a channel ID that is not a LOOP community or group channel", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });

    await expect(
      gateway.addMembers({
        channelId: "loop_direct_0123456789abcdef0123456789abcdef",
        actingStreamUserId: hostUserId,
        memberStreamUserIds: [memberUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("community channel presence (Decision 0047)", () => {
    function memberPage(online: readonly boolean[]): Record<string, unknown> {
      return {
        duration: "1ms",
        members: online.map((flag, index) => ({
          user_id: `loop_${index.toString(16).padStart(32, "0")}`,
          user: {
            id: `loop_${index.toString(16).padStart(32, "0")}`,
            online: flag,
          },
        })),
      };
    }

    it("fails closed without credentials", async () => {
      await expect(
        createUnavailableStreamCommunityChannelGateway().readCommunityChannelPresence(
          { channelId: communityChannelId, signal: signal() },
        ),
      ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
    });

    it("counts the members whose Stream user is online across pages, read-only", async () => {
      const fullPage = memberPage(
        Array.from({ length: 100 }, (_, index) => index % 10 === 0),
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(fullPage))
        .mockResolvedValueOnce(jsonResponse(memberPage([true, false, true])));
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCommunityChannelGateway({
        apiKey,
        apiSecret,
      });

      await expect(
        gateway.readCommunityChannelPresence({
          channelId: communityChannelId,
          signal: signal(),
        }),
      ).resolves.toEqual({
        status: "observed",
        channelId: communityChannelId,
        onlineMemberCount: 12,
        memberCount: 103,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const index of [0, 1]) {
        const url = requestedUrl(fetchMock, index);
        expect(url.pathname).toBe("/api/v2/chat/members");
        expect(JSON.parse(url.searchParams.get("payload") ?? "null")).toEqual({
          type: "messaging",
          id: communityChannelId,
          filter_conditions: {},
          sort: [{ field: "created_at", direction: 1 }],
          limit: 100,
          offset: index * 100,
        });
      }
    });

    it("reports a channel with more members than the paging budget instead of a partial total", async () => {
      const fullPage = memberPage(Array.from({ length: 100 }, () => true));
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(fullPage)));
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCommunityChannelGateway({
        apiKey,
        apiSecret,
      });

      await expect(
        gateway.readCommunityChannelPresence({
          channelId: communityChannelId,
          signal: signal(),
        }),
      ).resolves.toEqual({
        status: "bound_exceeded",
        channelId: communityChannelId,
        memberBound: 500,
      });
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("treats a member without an online flag as a projection mismatch, never as offline", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            jsonResponse({
              duration: "1ms",
              members: [{ user_id: hostUserId, user: { id: hostUserId } }],
            }),
          ),
        ),
      );
      const gateway = createStreamCommunityChannelGateway({
        apiKey,
        apiSecret,
      });

      await expect(
        gateway.readCommunityChannelPresence({
          channelId: communityChannelId,
          signal: signal(),
        }),
      ).rejects.toEqual(new StreamChannelProjectionMismatchError());
    });

    it("keeps a provider fault unavailable and a deterministic rejection terminal", async () => {
      for (const [status, expected] of [
        [500, new StreamChannelGatewayUnavailableError()],
        [404, new StreamChannelRequestRejectedError()],
      ] as const) {
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve(
              jsonResponse({ code: 16, message: "not found" }, status),
            ),
          ),
        );
        const gateway = createStreamCommunityChannelGateway({
          apiKey,
          apiSecret,
        });
        await expect(
          gateway.readCommunityChannelPresence({
            channelId: communityChannelId,
            signal: signal(),
          }),
        ).rejects.toEqual(expected);
      }
    });

    it("rejects a non-community channel ID before touching the provider", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCommunityChannelGateway({
        apiKey,
        apiSecret,
      });
      await expect(
        gateway.readCommunityChannelPresence({
          channelId: groupChannelId,
          signal: signal(),
        }),
      ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("Stream audio_room call gateway", () => {
  it("fails closed without credentials", async () => {
    const gateway = createUnavailableStreamCallGateway();
    const unavailable = new StreamCallGatewayUnavailableError();

    await expect(
      gateway.createAudioRoom({
        callId,
        createdByStreamUserId: hostUserId,
        signal: signal(),
      }),
    ).rejects.toEqual(unavailable);
    await expect(gateway.endCall({ callId, signal: signal() })).rejects.toEqual(
      unavailable,
    );
    await expect(
      gateway.queryMembers({ callId, signal: signal() }),
    ).rejects.toEqual(unavailable);
    await expect(
      gateway.observeSession({ callId, signal: signal() }),
    ).rejects.toEqual(unavailable);
  });

  it("creates a backstage audio_room with the host as its only member", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          users: { [hostUserId]: { id: hostUserId } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(callResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await expect(
      gateway.createAudioRoom({
        callId,
        createdByStreamUserId: hostUserId,
        signal: signal(),
      }),
    ).resolves.toEqual({
      callId,
      callCid: `audio_room:${callId}`,
      backstage: true,
    });
    expect(requestBody(fetchMock, 1)).toMatchObject({
      data: {
        created_by_id: hostUserId,
        members: [{ user_id: hostUserId, role: "admin" }],
        custom: {
          loop_call_kind: "communityVoiceRoom",
          loop_call_schema_version: 1,
        },
        settings_override: { backstage: { enabled: true } },
      },
    });
  });

  it("carries the host on the user role with explicit permissions when the application has no admin role", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          users: { [hostUserId]: { id: hostUserId } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 4, message: 'role "admin" is invalid' }, 400),
      )
      .mockResolvedValueOnce(jsonResponse(callResponse()))
      .mockResolvedValueOnce(jsonResponse({ duration: "1ms" }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await expect(
      gateway.createAudioRoom({
        callId,
        createdByStreamUserId: hostUserId,
        signal: signal(),
      }),
    ).resolves.toMatchObject({ callId });
    expect(requestBody(fetchMock, 2)).toMatchObject({
      data: { members: [{ user_id: hostUserId, role: "user" }] },
    });
    expect(requestBody(fetchMock, 3)).toEqual({
      user_id: hostUserId,
      grant_permissions: ["send-audio", "mute-users", "end-call"],
      revoke_permissions: [],
    });
  });

  it("maps a LOOP listener to the Stream user role and a speaker to speaker", async () => {
    for (const [role, streamRole] of [
      ["listener", "user"],
      ["speaker", "speaker"],
    ] as const) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ duration: "1ms" }));
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      await gateway.updateCallMembers({
        callId,
        addStreamUserIds: [memberUserId],
        removeStreamUserIds: [],
        role,
        signal: signal(),
      });

      expect(requestBody(fetchMock, 0)).toEqual({
        update_members: [{ user_id: memberUserId, role: streamRole }],
        remove_members: [],
      });
    }
  });

  it("prefers the admin role for a host member and falls back once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 4, message: 'role "admin" is invalid' }, 400),
      )
      .mockResolvedValueOnce(jsonResponse({ duration: "1ms" }))
      .mockResolvedValueOnce(jsonResponse({ duration: "1ms" }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await gateway.updateCallMembers({
      callId,
      addStreamUserIds: [hostUserId],
      removeStreamUserIds: [],
      role: "host",
      signal: signal(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBody(fetchMock, 0)).toMatchObject({
      update_members: [{ user_id: hostUserId, role: "admin" }],
    });
    expect(requestBody(fetchMock, 1)).toMatchObject({
      update_members: [{ user_id: hostUserId, role: "user" }],
    });
    expect(requestBody(fetchMock, 2)).toEqual({
      user_id: hostUserId,
      grant_permissions: ["send-audio", "mute-users", "end-call"],
      revoke_permissions: [],
    });
  });

  it("never falls back for a non-host role or for a retryable answer", async () => {
    const listenerFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 4, message: 'role "user" is invalid' }, 400),
      );
    vi.stubGlobal("fetch", listenerFetch);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await expect(
      gateway.updateCallMembers({
        callId,
        addStreamUserIds: [memberUserId],
        removeStreamUserIds: [],
        role: "listener",
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamCallGatewayUnavailableError());
    expect(listenerFetch).toHaveBeenCalledTimes(1);

    const quotaFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 9, message: "slow down" }, 429),
      );
    vi.stubGlobal("fetch", quotaFetch);

    await expect(
      gateway.updateCallMembers({
        callId,
        addStreamUserIds: [hostUserId],
        removeStreamUserIds: [],
        role: "host",
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamCallGatewayUnavailableError());
    expect(quotaFetch).toHaveBeenCalledTimes(1);
  });

  it("grants only the reviewed send-audio permission", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ duration: "1ms" }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await gateway.updateUserPermissions({
      callId,
      streamUserId: memberUserId,
      grantPermissions: ["send-audio"],
      revokePermissions: [],
      signal: signal(),
    });

    expect(requestBody(fetchMock, 0)).toEqual({
      user_id: memberUserId,
      grant_permissions: ["send-audio"],
      revoke_permissions: [],
    });
  });

  it("mutes every participant's audio in one call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ duration: "1ms" }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await gateway.muteUsers({
      callId,
      mutedByStreamUserId: hostUserId,
      signal: signal(),
    });

    expect(requestBody(fetchMock, 0)).toEqual({
      audio: true,
      mute_all_users: true,
      muted_by_id: hostUserId,
    });
  });

  it("projects an observed member count with its own observedAt", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        duration: "1ms",
        members: [{ user_id: hostUserId }, { user_id: memberUserId }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    const observation = await gateway.queryMembers({
      callId,
      signal: signal(),
    });

    expect(observation).toMatchObject({ memberCount: 2, complete: true });
    expect(Date.parse(observation.observedAt)).not.toBeNaN();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accumulates member pages and stops when Stream reports no next page", async () => {
    const page = (next?: string) =>
      jsonResponse({
        duration: "1ms",
        members: Array.from({ length: 100 }, (_, index) => ({
          user_id: `loop_${index.toString(16).padStart(32, "0")}`,
        })),
        ...(next === undefined ? {} : { next }),
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page("cursor-1"))
      .mockResolvedValueOnce(page("cursor-2"))
      .mockResolvedValueOnce(page());
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await expect(
      gateway.queryMembers({ callId, signal: signal() }),
    ).resolves.toMatchObject({ memberCount: 300, complete: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports an incomplete observation beyond the bounded page budget", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          duration: "1ms",
          members: Array.from({ length: 100 }, (_, index) => ({
            user_id: `loop_${index.toString(16).padStart(32, "0")}`,
          })),
          next: "cursor-more",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await expect(
      gateway.queryMembers({ callId, signal: signal() }),
    ).resolves.toMatchObject({ memberCount: 1_000, complete: false });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("sanitizes a provider failure into the unavailable error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await expect(gateway.endCall({ callId, signal: signal() })).rejects.toEqual(
      new StreamCallGatewayUnavailableError(),
    );
  });

  it("refuses a call ID that is not a LOOP voice room", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCallGateway({ apiKey, apiSecret });

    await expect(
      gateway.endCall({ callId: "default", signal: signal() }),
    ).rejects.toEqual(new StreamCallGatewayUnavailableError());
    await expect(
      gateway.observeSession({ callId: "default", signal: signal() }),
    ).rejects.toEqual(new StreamCallGatewayUnavailableError());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("observeSession", () => {
    const callBody = (session?: Record<string, unknown>) => ({
      duration: "1ms",
      members: [{ user_id: hostUserId }, { user_id: memberUserId }],
      own_capabilities: [],
      call: {
        id: callId,
        type: "audio_room",
        cid: `audio_room:${callId}`,
        backstage: true,
        ...(session === undefined ? {} : { session }),
      },
    });

    it("reports zero participants and no session when Stream has no live session", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(callBody()));
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      const observation = await gateway.observeSession({
        callId,
        signal: signal(),
      });

      expect(observation).toMatchObject({
        participantCount: 0,
        sessionActive: false,
      });
      expect(Date.parse(observation.observedAt)).not.toBeNaN();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(request[1].method ?? "GET").toBe("GET");
      expect(request[0]).toContain(`/video/call/audio_room/${callId}`);
    });

    it("sums the per-role participant counts of the live session, not the member list", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          callBody({
            id: "session-1",
            started_at: "2026-09-17T09:00:00.000Z",
            participants: [{ user_session_id: "a" }],
            participants_count_by_role: { admin: 1, user: 2 },
            accepted_by: {},
            missed_by: {},
            rejected_by: {},
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      await expect(
        gateway.observeSession({ callId, signal: signal() }),
      ).resolves.toMatchObject({ participantCount: 3, sessionActive: true });
    });

    it("falls back to the participant list when the per-role map is absent", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          callBody({
            id: "session-1",
            participants: [{ user_session_id: "a" }, { user_session_id: "b" }],
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      await expect(
        gateway.observeSession({ callId, signal: signal() }),
      ).resolves.toMatchObject({ participantCount: 2, sessionActive: true });
    });

    it("reports zero participants once the session has ended", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          callBody({
            id: "session-1",
            ended_at: "2026-09-17T09:30:00.000Z",
            participants: [],
            participants_count_by_role: { user: 4 },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      await expect(
        gateway.observeSession({ callId, signal: signal() }),
      ).resolves.toMatchObject({ participantCount: 0, sessionActive: false });
    });

    it("rejects a session whose counts are not non-negative integers", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          callBody({
            id: "session-1",
            participants_count_by_role: { user: "many" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      await expect(
        gateway.observeSession({ callId, signal: signal() }),
      ).rejects.toBeInstanceOf(StreamCallProjectionMismatchError);
    });

    it("rejects a call projection for a different call", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          ...callBody(),
          call: { id: "other", type: "audio_room" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      await expect(
        gateway.observeSession({ callId, signal: signal() }),
      ).rejects.toBeInstanceOf(StreamCallProjectionMismatchError);
    });

    it("sanitizes a provider failure into the unavailable error", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createStreamCallGateway({ apiKey, apiSecret });

      await expect(
        gateway.observeSession({ callId, signal: signal() }),
      ).rejects.toEqual(new StreamCallGatewayUnavailableError());
    });
  });
});
