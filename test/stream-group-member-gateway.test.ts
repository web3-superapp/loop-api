import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStreamGroupMemberGateway,
  createUnavailableStreamGroupMemberGateway,
  StreamGroupMemberGatewayUnavailableError,
  StreamGroupMemberNotFoundError,
  type AssertCurrentStreamGroupMemberInput,
  type ProjectStreamGroupAliasInput,
} from "../src/integrations/stream/group-member-gateway.js";

const apiKey = "stream_test_api_key";
const apiSecret = "stream_test_api_secret";
const channelId = "loop_group_01";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const secondStreamUserId = "loop_f7bf09f6017146b99acd5ad494f211bd";
const absentStreamUserId = "loop_00000000000040008000000000000000";
const groupAliasId = "8f49d507-ae87-4f65-a0d4-6b59a4d81151";
const alias = "松林里的狐狸";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function member(
  userId: string,
  options: {
    readonly custom?: Record<string, unknown>;
    readonly cid?: string;
  } = {},
): Record<string, unknown> {
  return {
    cid: options.cid ?? `messaging:${channelId}`,
    custom: options.custom ?? {},
    user: { id: userId },
  };
}

function groupChannelState(
  custom: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    duration: "1ms",
    channel: {
      id: channelId,
      type: "messaging",
      cid: `messaging:${channelId}`,
      custom,
    },
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = "OK",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function assertInput(
  overrides: Partial<AssertCurrentStreamGroupMemberInput> = {},
): AssertCurrentStreamGroupMemberInput {
  return {
    channelId,
    streamUserId,
    signal: signal(),
    ...overrides,
  };
}

function projectionInput(
  overrides: Partial<ProjectStreamGroupAliasInput> = {},
): ProjectStreamGroupAliasInput {
  return {
    channelId,
    streamUserId,
    groupAliasId,
    alias,
    signal: signal(),
    ...overrides,
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

function requestInit(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): RequestInit {
  const call: unknown = fetchMock.mock.calls[index];
  const value: unknown = Array.isArray(call) ? call[1] : undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected the Stream SDK to call fetch with request init");
  }
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stream group member gateway", () => {
  it("keeps every operation fail-closed in the unavailable adapter", async () => {
    const gateway = createUnavailableStreamGroupMemberGateway();

    await expect(gateway.assertCurrentMember(assertInput())).rejects.toEqual(
      new StreamGroupMemberGatewayUnavailableError(),
    );
    await expect(
      gateway.filterCurrentMembers({
        channelId,
        streamUserIds: [streamUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    await expect(gateway.projectAlias(projectionInput())).rejects.toEqual(
      new StreamGroupMemberGatewayUnavailableError(),
    );
  });

  it("queries only the exact member in a fixed messaging channel", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(
        jsonResponse({ duration: "1ms", members: [member(streamUserId)] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.assertCurrentMember(assertInput())).resolves.toBe(
      undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stateUrl = requestedUrl(fetchMock);
    expect(stateUrl.pathname).toBe(
      `/api/v2/chat/channels/messaging/${channelId}`,
    );
    expect(stateUrl.searchParams.get("state")).toBe("false");
    expect(stateUrl.searchParams.get("members_limit")).toBe("0");
    expect(stateUrl.searchParams.get("messages_limit")).toBe("0");
    expect(stateUrl.searchParams.get("watchers_limit")).toBe("0");
    const url = requestedUrl(fetchMock, 1);
    expect(url.pathname).toBe("/api/v2/chat/members");
    expect(url.searchParams.get("api_key")).toBe(apiKey);
    expect(JSON.parse(url.searchParams.get("payload") ?? "null")).toEqual({
      id: channelId,
      type: "messaging",
      filter_conditions: { user_id: streamUserId, joined: true },
      limit: 1,
    });
    expect(requestInit(fetchMock, 1).method).toBe("GET");
  });

  it("maps a joined-only query with no result, including an unaccepted invite, and provider 404 to not-found", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(jsonResponse({ duration: "1ms", members: [] }))
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 4, message: "provider detail must not escape" },
          404,
          "Not Found",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.assertCurrentMember(assertInput())).rejects.toEqual(
      new StreamGroupMemberNotFoundError(),
    );
    await expect(gateway.assertCurrentMember(assertInput())).rejects.toEqual(
      new StreamGroupMemberNotFoundError(),
    );
  });

  it("accepts the SDK's direct user_id member shape without weakening identity checks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          members: [{ user_id: streamUserId, custom: {} }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.assertCurrentMember(assertInput())).resolves.toBe(
      undefined,
    );
  });

  it("accepts a versioned LOOP group channel before proving joined membership", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          groupChannelState({
            loop_channel_kind: "group",
            loop_channel_schema_version: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ duration: "1ms", members: [member(streamUserId)] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.assertCurrentMember(assertInput())).resolves.toBe(
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a LOOP direct channel from every group-only operation", async () => {
    const directState = groupChannelState({
      loop_channel_kind: "direct",
      loop_channel_schema_version: 1,
    });
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(directState)));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.assertCurrentMember(assertInput())).rejects.toEqual(
      new StreamGroupMemberNotFoundError(),
    );
    await expect(
      gateway.filterCurrentMembers({
        channelId,
        streamUserIds: [streamUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamGroupMemberNotFoundError());
    await expect(gateway.projectAlias(projectionInput())).rejects.toEqual(
      new StreamGroupMemberNotFoundError(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.every((_call, index) => {
        return (
          requestedUrl(fetchMock, index).pathname ===
          `/api/v2/chat/channels/messaging/${channelId}`
        );
      }),
    ).toBe(true);
  });

  it.each([
    ["a partially marked legacy channel", { loop_channel_schema_version: 1 }],
    [
      "an unsupported group schema",
      { loop_channel_kind: "group", loop_channel_schema_version: 2 },
    ],
    [
      "an unknown channel kind",
      { loop_channel_kind: "broadcast", loop_channel_schema_version: 1 },
    ],
  ])("fails closed on %s", async (_name, custom) => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(groupChannelState(custom))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.assertCurrentMember(assertInput())).rejects.toEqual(
      new StreamGroupMemberGatewayUnavailableError(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("filters a bounded deduplicated set through an exact user_id $in query", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          members: [member(secondStreamUserId), member(streamUserId)],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    const result = await gateway.filterCurrentMembers({
      channelId,
      streamUserIds: [streamUserId, secondStreamUserId, streamUserId],
      signal: signal(),
    });

    expect([...result]).toEqual([secondStreamUserId, streamUserId]);
    const url = requestedUrl(fetchMock, 1);
    expect(JSON.parse(url.searchParams.get("payload") ?? "null")).toEqual({
      id: channelId,
      type: "messaging",
      filter_conditions: {
        user_id: { $in: [streamUserId, secondStreamUserId] },
        joined: true,
      },
      limit: 2,
    });
  });

  it("returns an empty set without contacting Stream for an empty filter", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    const result = await gateway.filterCurrentMembers({
      channelId,
      streamUserIds: [],
      signal: signal(),
    });

    expect([...result]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a member outside the requested set", [member(absentStreamUserId)]],
    ["a duplicate member", [member(streamUserId), member(streamUserId)]],
    ["a member without a provider user", [{ custom: {} }]],
    [
      "conflicting direct and nested user IDs",
      [{ user_id: streamUserId, user: { id: secondStreamUserId }, custom: {} }],
    ],
    [
      "a member for another channel",
      [member(streamUserId, { cid: "messaging:another_group" })],
    ],
  ])("fails closed on %s", async (_name, members) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(jsonResponse({ duration: "1ms", members }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(
      gateway.filterCurrentMembers({
        channelId,
        streamUserIds: [streamUserId, secondStreamUserId],
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
  });

  it("projects only immutable LOOP alias fields onto the exact channel member", async () => {
    const projectedCustom = {
      loop_group_alias_id: groupAliasId,
      loop_group_alias: alias,
      loop_group_alias_version: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          channel_member: member(streamUserId, { custom: projectedCustom }),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.projectAlias(projectionInput())).resolves.toBe(
      undefined,
    );

    const url = requestedUrl(fetchMock, 1);
    expect(url.pathname).toBe(
      `/api/v2/chat/channels/messaging/${channelId}/member`,
    );
    expect(url.searchParams.get("user_id")).toBe(streamUserId);
    expect(url.searchParams.get("api_key")).toBe(apiKey);
    const init = requestInit(fetchMock, 1);
    expect(init.method).toBe("PATCH");
    if (typeof init.body !== "string") {
      throw new Error("Expected the Stream SDK to send a JSON request body");
    }
    expect(JSON.parse(init.body)).toEqual({
      set: projectedCustom,
    });
  });

  it("does not confirm an alias projection from a malformed provider response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockResolvedValueOnce(
        jsonResponse({
          duration: "1ms",
          channel_member: member(streamUserId, {
            custom: {
              loop_group_alias_id: groupAliasId,
              loop_group_alias: alias,
              loop_group_alias_version: 2,
            },
          }),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(gateway.projectAlias(projectionInput())).rejects.toEqual(
      new StreamGroupMemberGatewayUnavailableError(),
    );
  });

  it.each([
    [
      "malformed success",
      () => Promise.resolve(jsonResponse({ members: "invalid" })),
    ],
    [
      "provider failure",
      () =>
        Promise.resolve(
          jsonResponse(
            { code: 99, message: "sensitive provider response" },
            503,
            "Unavailable",
          ),
        ),
    ],
    [
      "provider timeout",
      () => {
        const error = new Error("provider timeout detail");
        error.name = "TimeoutError";
        return Promise.reject(error);
      },
    ],
  ])("sanitizes %s as gateway unavailable", async (_name, response) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groupChannelState()))
      .mockImplementationOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    let failure: unknown;
    try {
      await gateway.assertCurrentMember(assertInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new StreamGroupMemberGatewayUnavailableError());
    if (!(failure instanceof Error)) {
      throw new Error("Expected a sanitized gateway error");
    }
    expect(failure.message).toBe(
      "The Stream group member gateway is unavailable",
    );
    expect(failure.message).not.toContain("sensitive");
    expect(failure.message).not.toContain("provider timeout detail");
  });

  it("rejects invalid identifiers and aliases before any provider call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });

    await expect(
      gateway.assertCurrentMember(
        assertInput({ channelId: "messaging:client-selected" }),
      ),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    await expect(
      gateway.assertCurrentMember(
        assertInput({ streamUserId: "wallet_0x12345678" }),
      ),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    await expect(
      gateway.projectAlias(
        projectionInput({ groupAliasId: groupAliasId.toUpperCase() }),
      ),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    await expect(
      gateway.projectAlias(projectionInput({ alias: ` ${alias}` })),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    await expect(
      gateway.projectAlias(projectionInput({ alias: "safe\u202ename" })),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    await expect(
      gateway.projectAlias(projectionInput({ alias: "safe\u206aname" })),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    await expect(
      gateway.filterCurrentMembers({
        channelId,
        streamUserIds: Array.from({ length: 101 }, () => streamUserId),
        signal: signal(),
      }),
    ).rejects.toEqual(new StreamGroupMemberGatewayUnavailableError());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves an already-aborted caller signal without contacting Stream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({ apiKey, apiSecret });
    const controller = new AbortController();
    const reason = new Error("caller-aborted");
    controller.abort(reason);

    await expect(
      gateway.assertCurrentMember(assertInput({ signal: controller.signal })),
    ).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns malformed Stream configuration into an unavailable adapter", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamGroupMemberGateway({
      apiKey: " ",
      apiSecret,
    });

    await expect(gateway.assertCurrentMember(assertInput())).rejects.toEqual(
      new StreamGroupMemberGatewayUnavailableError(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
