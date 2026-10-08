import { afterEach, describe, expect, it, vi } from "vitest";

import {
  communityFeedBotStreamUserId,
  createStreamCommunityChannelGateway,
  createUnavailableStreamCommunityChannelGateway,
  StreamChannelGatewayUnavailableError,
  StreamChannelRequestRejectedError,
} from "../src/integrations/stream/channel-gateway.js";

const apiKey = "stream_test_api_key";
const apiSecret = "stream_test_api_secret";
const streamChannelId = "loop_community_0123456789abcdef0123456789abcdef";
const messageId = "loop_buy_0123456789abcdef0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    streamChannelId,
    messageId,
    text: "群友买入 · FROG",
    custom: {
      loop_schema: "member_buy.v1",
      loop_event_kind: "memberBuy",
      amountRaw: "5000000000000000000",
      quoteIsStable: true,
      blockTimestamp: null,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

const upsertBot = () =>
  jsonResponse({
    duration: "1ms",
    users: {
      [communityFeedBotStreamUserId]: { id: communityFeedBotStreamUserId },
    },
  });

function call(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const entry = fetchMock.mock.calls[index] as unknown[];
  const url = new URL(String(entry[0]));
  const init = entry[1] as RequestInit;
  return {
    path: url.pathname,
    method: init.method,
    body:
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stream community feed message (Decision 0097)", () => {
  it("fails closed without Stream", async () => {
    await expect(
      createUnavailableStreamCommunityChannelGateway().sendCommunityFeedMessage(
        input(),
      ),
    ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
  });

  it("upserts the bot once, then posts a regular message without push", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upsertBot())
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ duration: "1ms", message: { id: messageId } }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });

    await expect(gateway.sendCommunityFeedMessage(input())).resolves.toEqual({
      status: "sent",
      messageId,
    });
    await gateway.sendCommunityFeedMessage(input());
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const upsert = call(fetchMock, 0);
    expect(upsert.path).toBe("/api/v2/users");
    expect(upsert.body).toEqual({
      users: {
        loop_feed_bot: {
          id: "loop_feed_bot",
          name: "LOOP",
          custom: { loop_bot: true },
        },
      },
    });
    const send = call(fetchMock, 1);
    expect(send.path).toBe(
      `/api/v2/chat/channels/messaging/${streamChannelId}/message`,
    );
    expect(send.body).toEqual({
      message: {
        id: messageId,
        type: "regular",
        text: "群友买入 · FROG",
        user_id: "loop_feed_bot",
        custom: input().custom,
      },
      skip_push: true,
    });
    expect(call(fetchMock, 2).path).toBe(send.path);
  });

  it("treats a message ID Stream already holds as a duplicate success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upsertBot())
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 4,
            message: "a message with ID already exists",
            StatusCode: 400,
          },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ duration: "1ms", message: { id: messageId } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });
    await expect(gateway.sendCommunityFeedMessage(input())).resolves.toEqual({
      status: "duplicate",
      messageId,
    });
    expect(call(fetchMock, 2).path).toBe(`/api/v2/chat/messages/${messageId}`);
  });

  it("is a deterministic rejection when the 4xx was not a duplicate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upsertBot())
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 16, message: "channel not found", StatusCode: 404 },
          404,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 4, message: "message not found", StatusCode: 404 },
          404,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });
    await expect(gateway.sendCommunityFeedMessage(input())).rejects.toEqual(
      new StreamChannelRequestRejectedError(),
    );
  });

  it("is unavailable on a server error or a failed bot upsert", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ users: {} }))
      .mockResolvedValueOnce(upsertBot())
      .mockResolvedValueOnce(
        jsonResponse({ code: -1, message: "boom", StatusCode: 500 }, 500),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });
    await expect(gateway.sendCommunityFeedMessage(input())).rejects.toEqual(
      new StreamChannelGatewayUnavailableError(),
    );
    await expect(gateway.sendCommunityFeedMessage(input())).rejects.toEqual(
      new StreamChannelGatewayUnavailableError(),
    );
  });

  it("refuses malformed input before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStreamCommunityChannelGateway({ apiKey, apiSecret });
    for (const overrides of [
      { messageId: "loop_buy_short" },
      { streamChannelId: "loop_group_0123456789abcdef0123456789abcdef" },
      { text: "" },
      { custom: { amountRaw: 1.5 } },
      { custom: { amountRaw: -1 } },
      { custom: {} },
    ]) {
      await expect(
        gateway.sendCommunityFeedMessage(input(overrides)),
      ).rejects.toEqual(new StreamChannelGatewayUnavailableError());
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
