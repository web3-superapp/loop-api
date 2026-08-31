import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStreamChannelGateway,
  createUnavailableStreamChannelGateway,
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  type UpsertFixedStreamMessagingChannelInput,
} from "../src/integrations/stream/channel-gateway.js";

const apiKey = "stream_test_api_key";
const apiSecret = "stream_test_api_secret";
const groupChannelId = "loop_group_0123456789abcdef0123456789abcdef";
const directChannelId = "loop_direct_0123456789abcdef0123456789abcdef";
const firstUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const secondUserId = "loop_f7bf09f6017146b99acd5ad494f211bd";
const thirdUserId = "loop_00000000000040008000000000000000";
const fourthUserId = "loop_44444444444444448444444444444444";
const groupName = "松林交易室";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function groupInput(
  overrides: Partial<UpsertFixedStreamMessagingChannelInput> = {},
): UpsertFixedStreamMessagingChannelInput {
  return {
    channelId: groupChannelId,
    kind: "group",
    createdByStreamUserId: firstUserId,
    memberStreamUserIds: [firstUserId, secondUserId, thirdUserId],
    name: groupName,
    signal: signal(),
    ...overrides,
  };
}

function directInput(
  overrides: Partial<UpsertFixedStreamMessagingChannelInput> = {},
): UpsertFixedStreamMessagingChannelInput {
  return {
    channelId: directChannelId,
    kind: "direct",
    createdByStreamUserId: firstUserId,
    memberStreamUserIds: [firstUserId, secondUserId],
    signal: signal(),
    ...overrides,
  } as UpsertFixedStreamMessagingChannelInput;
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

function usersResponse(userIds: readonly string[]): Record<string, unknown> {
  return {
    duration: "1ms",
    users: Object.fromEntries(userIds.map((id) => [id, { id }])),
  };
}

function channelResponse(
  input: UpsertFixedStreamMessagingChannelInput,
  overrides: {
    readonly channel?: Record<string, unknown>;
    readonly members?: readonly unknown[];
  } = {},
): Record<string, unknown> {
  const custom =
    input.kind === "group"
      ? {
          loop_channel_kind: "group",
          loop_channel_schema_version: 1,
          name: input.name,
        }
      : {
          loop_channel_kind: "direct",
          loop_channel_schema_version: 1,
        };
  return {
    duration: "1ms",
    channel: {
      id: input.channelId,
      type: "messaging",
      cid: `messaging:${input.channelId}`,
      created_by: { id: input.createdByStreamUserId },
      custom,
      member_count: input.memberStreamUserIds.length,
      ...overrides.channel,
    },
    members:
      overrides.members ??
      input.memberStreamUserIds.map((id) => ({ user_id: id, user: { id } })),
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

function requestBody(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): unknown {
  const body = requestInit(fetchMock, index).body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as unknown;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stream fixed messaging channel gateway", () => {
  it("keeps write and reconciliation unavailable without credentials", async () => {
    const gateway = createUnavailableStreamChannelGateway();

    await expect(
      gateway.upsertFixedMessagingChannel(groupInput()),
    ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
    await expect(
      gateway.readFixedMessagingChannel(groupInput()),
    ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
  });

  it("upserts only server-derived user IDs before one fixed-ID group channel", async () => {
    const input = groupInput();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(usersResponse(input.memberStreamUserIds)),
      )
      .mockResolvedValueOnce(jsonResponse(channelResponse(input)));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.upsertFixedMessagingChannel(input)).resolves.toEqual({
      channelId: groupChannelId,
      streamCid: `messaging:${groupChannelId}`,
      kind: "group",
      name: groupName,
      memberStreamUserIds: [firstUserId, secondUserId, thirdUserId],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedUrl(fetchMock).pathname).toBe("/api/v2/users");
    expect(requestInit(fetchMock).method).toBe("POST");
    expect(requestBody(fetchMock, 0)).toEqual({
      users: {
        [firstUserId]: { id: firstUserId },
        [secondUserId]: { id: secondUserId },
        [thirdUserId]: { id: thirdUserId },
      },
    });

    const channelUrl = requestedUrl(fetchMock, 1);
    expect(channelUrl.pathname).toBe(
      `/api/v2/chat/channels/messaging/${groupChannelId}/query`,
    );
    expect(channelUrl.searchParams.get("api_key")).toBe(apiKey);
    expect(requestInit(fetchMock, 1).method).toBe("POST");
    expect(requestBody(fetchMock, 1)).toEqual({
      state: true,
      data: {
        created_by_id: firstUserId,
        members: [
          { user_id: firstUserId },
          { user_id: secondUserId },
          { user_id: thirdUserId },
        ],
        custom: {
          loop_channel_kind: "group",
          loop_channel_schema_version: 1,
          name: groupName,
        },
      },
      members: { limit: 4 },
      messages: { limit: 0 },
      watchers: { limit: 0 },
    });
  });

  it("creates a fixed-ID direct channel without a public name or profile fields", async () => {
    const input = directInput();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(usersResponse(input.memberStreamUserIds)),
      )
      .mockResolvedValueOnce(jsonResponse(channelResponse(input)));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.upsertFixedMessagingChannel(input)).resolves.toEqual({
      channelId: directChannelId,
      streamCid: `messaging:${directChannelId}`,
      kind: "direct",
      memberStreamUserIds: [firstUserId, secondUserId],
    });

    expect(requestBody(fetchMock, 0)).toEqual({
      users: {
        [firstUserId]: { id: firstUserId },
        [secondUserId]: { id: secondUserId },
      },
    });
    expect(requestBody(fetchMock, 1)).toEqual({
      state: true,
      data: {
        created_by_id: firstUserId,
        members: [{ user_id: firstUserId }, { user_id: secondUserId }],
        custom: {
          loop_channel_kind: "direct",
          loop_channel_schema_version: 1,
        },
      },
      members: { limit: 3 },
      messages: { limit: 0 },
      watchers: { limit: 0 },
    });
  });

  it("authoritatively reads a fixed channel and returns only the strict projection", async () => {
    const input = groupInput();
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(channelResponse(input))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.readFixedMessagingChannel(input)).resolves.toEqual({
      status: "found",
      channel: {
        channelId: groupChannelId,
        streamCid: `messaging:${groupChannelId}`,
        kind: "group",
        name: groupName,
        memberStreamUserIds: [firstUserId, secondUserId, thirdUserId],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe(
      `/api/v2/chat/channels/messaging/${groupChannelId}`,
    );
    expect(url.searchParams.get("state")).toBe("true");
    expect(url.searchParams.get("members_limit")).toBe("4");
    expect(url.searchParams.get("messages_limit")).toBe("0");
    expect(url.searchParams.get("watchers_limit")).toBe("0");
    expect(requestInit(fetchMock).method).toBe("GET");
  });

  it("distinguishes an authoritative fixed-ID not-found from provider unavailability", async () => {
    const input = directInput();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 4, message: "provider detail must not escape" },
          404,
          "Not Found",
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 99, message: "sensitive unavailable detail" },
          503,
          "Unavailable",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.readFixedMessagingChannel(input)).resolves.toEqual({
      status: "not_found",
    });
    let failure: unknown;
    try {
      await gateway.readFixedMessagingChannel(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new StreamChannelGatewayUnavailableError());
    if (!(failure instanceof Error)) {
      throw new Error("Expected a sanitized gateway error");
    }
    expect(failure.message).not.toContain("sensitive");
  });

  it.each([
    [
      "a mismatched custom kind",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          channel: {
            custom: {
              loop_channel_kind: "direct",
              loop_channel_schema_version: 1,
            },
          },
        }),
    ],
    [
      "a partial authoritative member set",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          members: [{ user_id: firstUserId }, { user_id: secondUserId }],
        }),
    ],
    [
      "an authoritative response without member_count",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, { channel: { member_count: undefined } }),
    ],
    [
      "an authoritative channel with an extra member",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          channel: { member_count: input.memberStreamUserIds.length + 1 },
          members: [
            ...input.memberStreamUserIds.map((user_id) => ({ user_id })),
            { user_id: fourthUserId },
          ],
        }),
    ],
  ])("fails closed when reconciliation reads %s", async (_name, response) => {
    const input = groupInput();
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(response(input))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.readFixedMessagingChannel(input)).rejects.toEqual(
      new StreamChannelProjectionMismatchError(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not turn a write-side 404 or timeout into a confirmed outcome", async () => {
    const input = directInput();
    const timeout = new Error("provider timeout detail");
    timeout.name = "TimeoutError";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(usersResponse(input.memberStreamUserIds)),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 4, message: "not found" }, 404, "Not Found"),
      )
      .mockResolvedValueOnce(
        jsonResponse(usersResponse(input.memberStreamUserIds)),
      )
      .mockRejectedValueOnce(timeout);
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.upsertFixedMessagingChannel(input)).rejects.toEqual(
      new StreamChannelGatewayUnavailableError(),
    );
    await expect(gateway.upsertFixedMessagingChannel(input)).rejects.toEqual(
      new StreamChannelGatewayUnavailableError(),
    );
  });

  it.each([
    [
      "a malformed user upsert",
      (input: UpsertFixedStreamMessagingChannelInput) => ({
        users: { [firstUserId]: { id: firstUserId } },
        input,
      }),
    ],
    ["a malformed channel success", () => ({ duration: "1ms" })],
    [
      "a mismatched channel kind",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          channel: {
            custom: {
              loop_channel_kind: "direct",
              loop_channel_schema_version: 1,
            },
          },
        }),
    ],
    [
      "an unsupported schema version",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          channel: {
            custom: {
              loop_channel_kind: "group",
              loop_channel_schema_version: 2,
              name: groupName,
            },
          },
        }),
    ],
    [
      "an unexpected custom field",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          channel: {
            custom: {
              loop_channel_kind: "group",
              loop_channel_schema_version: 1,
              name: groupName,
              public_profile_id: "must-not-exist",
            },
          },
        }),
    ],
    [
      "a different creator",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          channel: { created_by: { id: secondUserId } },
        }),
    ],
    [
      "a partial member list",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          members: [{ user_id: firstUserId }, { user_id: secondUserId }],
        }),
    ],
    [
      "a duplicate member",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          members: [
            { user_id: firstUserId },
            { user_id: secondUserId },
            { user_id: secondUserId },
          ],
        }),
    ],
    [
      "conflicting member identity shapes",
      (input: UpsertFixedStreamMessagingChannelInput) =>
        channelResponse(input, {
          members: [
            { user_id: firstUserId, user: { id: secondUserId } },
            { user_id: secondUserId },
            { user_id: thirdUserId },
          ],
        }),
    ],
  ])("fails closed on %s", async (name, responseFactory) => {
    const input = groupInput();
    const malformedUsers = name === "a malformed user upsert";
    const fetchMock = malformedUsers
      ? vi.fn(() => Promise.resolve(jsonResponse(responseFactory(input))))
      : vi
          .fn()
          .mockResolvedValueOnce(
            jsonResponse(usersResponse(input.memberStreamUserIds)),
          )
          .mockResolvedValueOnce(jsonResponse(responseFactory(input)));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.upsertFixedMessagingChannel(input)).rejects.toEqual(
      malformedUsers
        ? new StreamChannelGatewayUnavailableError()
        : new StreamChannelProjectionMismatchError(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(malformedUsers ? 1 : 2);
  });

  it.each([
    ["client-selected CID", groupInput({ channelId: "messaging:bad" })],
    ["wrong kind prefix", groupInput({ channelId: directChannelId })],
    [
      "duplicate members",
      groupInput({
        memberStreamUserIds: [firstUserId, secondUserId, secondUserId],
      }),
    ],
    [
      "creator outside members",
      groupInput({
        createdByStreamUserId: "loop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ],
    [
      "too few group members",
      groupInput({ memberStreamUserIds: [firstUserId, secondUserId] }),
    ],
    [
      "too many group members",
      groupInput({
        memberStreamUserIds: Array.from(
          { length: 31 },
          (_, index) => `loop_${String(index).padStart(32, "0")}`,
        ),
        createdByStreamUserId: "loop_00000000000000000000000000000000",
      }),
    ],
    [
      "wrong direct member count",
      directInput({ memberStreamUserIds: [firstUserId] }),
    ],
    ["noncanonical group name", groupInput({ name: ` ${groupName}` })],
    ["unsafe group name", groupInput({ name: "safe\u202ename" })],
    [
      "direct channel with a name",
      {
        ...directInput(),
        name: "must not exist",
      } as UpsertFixedStreamMessagingChannelInput,
    ],
  ])("rejects %s before any provider call", async (_name, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.upsertFixedMessagingChannel(input)).rejects.toEqual(
      new StreamChannelGatewayUnavailableError(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves caller aborts before and between provider calls", async () => {
    const beforeController = new AbortController();
    const beforeReason = new Error("before-provider");
    beforeController.abort(beforeReason);
    const betweenController = new AbortController();
    const betweenReason = new Error("between-provider-calls");
    const betweenInput = groupInput({ signal: betweenController.signal });
    const fetchMock = vi.fn(() => {
      betweenController.abort(betweenReason);
      return Promise.resolve(
        jsonResponse(usersResponse(betweenInput.memberStreamUserIds)),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(
      gateway.upsertFixedMessagingChannel(
        groupInput({ signal: beforeController.signal }),
      ),
    ).rejects.toBe(beforeReason);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      gateway.upsertFixedMessagingChannel(betweenInput),
    ).rejects.toBe(betweenReason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an abort observed immediately after the channel response", async () => {
    const inputController = new AbortController();
    const reason = new Error("after-channel-write");
    const input = directInput({ signal: inputController.signal });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(usersResponse(input.memberStreamUserIds)),
      )
      .mockImplementationOnce(() => {
        inputController.abort(reason);
        return Promise.resolve(jsonResponse(channelResponse(input)));
      });
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey, apiSecret });

    await expect(gateway.upsertFixedMessagingChannel(input)).rejects.toBe(
      reason,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("turns malformed Stream configuration into an unavailable adapter", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamChannelGateway({ apiKey: " ", apiSecret });

    await expect(
      gateway.upsertFixedMessagingChannel(groupInput()),
    ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
