import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStreamCallGateway,
  createUnavailableStreamCallGateway,
  StreamCallGatewayUnavailableError,
} from "../src/integrations/stream/call-gateway.js";
import {
  createStreamCommunityChannelGateway,
  createUnavailableStreamCommunityChannelGateway,
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
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

  it("adds a member incrementally without comparing an exact member set", async () => {
    const fetchMock = vi
      .fn()
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl(fetchMock).pathname).toBe(
      `/api/v2/chat/channels/messaging/${communityChannelId}`,
    );
    expect(requestBody(fetchMock, 0)).toEqual({
      user_id: hostUserId,
      add_members: [{ user_id: memberUserId }],
    });
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
        members: [{ user_id: hostUserId, role: "host" }],
        custom: {
          loop_call_kind: "communityVoiceRoom",
          loop_call_schema_version: 1,
        },
        settings_override: { backstage: { enabled: true } },
      },
    });
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

    expect(observation.memberCount).toBe(2);
    expect(Date.parse(observation.observedAt)).not.toBeNaN();
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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
