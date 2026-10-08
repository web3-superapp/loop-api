import { describe, expect, it, vi } from "vitest";

import {
  createMemberBuyFeedService,
  memberBuyMessageId,
  type MemberBuyFeedEvent,
  type MemberBuyFeedSender,
} from "../src/features/community/member-buy-feed-service.js";
import {
  feedCursorWholeBlockLogIndex,
  type FeedPosition,
  type MemberBuyEventOutcome,
  type MemberBuyFeedCandidate,
  type MemberBuyFeedMatch,
  type MemberBuyFeedRepository,
  type RecordMemberBuyEventInput,
} from "../src/features/community/member-buy-feed-repository.js";
import {
  StreamChannelGatewayUnavailableError,
  StreamChannelRequestRejectedError,
} from "../src/integrations/stream/channel-gateway.js";

const chainId = "eip155:56";
const frog = {
  assetId: `${chainId}:0x1111111111111111111111111111111111111111`,
  symbol: "FROG",
  decimals: 18,
};
const usdt = {
  assetId: `${chainId}:0x55d398326f99059ff775485246999027b3197955`,
  symbol: "USDT",
  decimals: 18,
};
const communityA = "0b6a3f0e-9f3c-4d7a-8c41-6a1e2b3c4d5e";
const communityB = "1c7b4f1f-0a4d-4e8b-9d52-7b2f3c4d5e6f";
const buyer = "2d8c5a2a-1b5e-4f9c-8e63-8c3a4d5e6f70";
const profile = "3e9d6b3b-2c6f-4a0d-9f74-9d4b5e6f7081";
const channelA = "loop_community_0123456789abcdef0123456789abcdef";
const channelB = "loop_community_fedcba9876543210fedcba9876543210";

function match(
  overrides: Partial<MemberBuyFeedMatch> = {},
): MemberBuyFeedMatch {
  return {
    communityId: communityA,
    boundAssetId: frog.assetId,
    streamChannelId: channelA,
    buyerUserId: buyer,
    publicProfileId: profile,
    tradeHistoryVisibility: "everyone",
    anonymousMode: false,
    existingOutcome: null,
    ...overrides,
  };
}

function swap(
  logIndex: number,
  options: {
    readonly block?: string;
    readonly buy?: boolean;
    readonly matches?: readonly MemberBuyFeedMatch[];
  } = {},
): MemberBuyFeedCandidate {
  const buy = options.buy ?? true;
  return {
    chainId,
    transactionHash: `0x${logIndex.toString(16).padStart(64, "a")}`,
    logIndex,
    blockNumber: options.block ?? "100",
    blockTimestamp: "2026-10-08T00:00:00.000Z",
    token0: frog,
    token1: usdt,
    amount0: buy ? "-5000000000000000000" : "5000000000000000000",
    amount1: buy ? "2000000000000000000" : "-2000000000000000000",
    matches: options.matches ?? [match()],
  };
}

interface Harness {
  readonly repository: MemberBuyFeedRepository;
  readonly rows: Map<string, RecordMemberBuyEventInput>;
  readonly cursor: () => FeedPosition | null;
  readonly listCalls: () => number;
}

function harness(input: {
  readonly checkpoint: string | null;
  readonly cursor?: FeedPosition | null;
  readonly candidates?: readonly MemberBuyFeedCandidate[];
}): Harness {
  let cursor = input.cursor ?? null;
  let listCalls = 0;
  const rows = new Map<string, RecordMemberBuyEventInput>();
  const key = (value: {
    transactionHash: string;
    logIndex: number;
    communityId: string;
  }) =>
    `${value.transactionHash}:${String(value.logIndex)}:${value.communityId}`;
  const repository: MemberBuyFeedRepository = {
    readPoolEventCheckpoint: () => Promise.resolve(input.checkpoint),
    readCursor: () => Promise.resolve(cursor),
    initializeCursor: (_chain, position) => {
      cursor ??= position;
      return Promise.resolve(cursor);
    },
    advanceCursor: (_chain, position) => {
      if (
        cursor === null ||
        BigInt(position.blockNumber) > BigInt(cursor.blockNumber) ||
        (position.blockNumber === cursor.blockNumber &&
          position.logIndex > cursor.logIndex)
      ) {
        cursor = position;
      }
      return Promise.resolve();
    },
    listCandidates: () => {
      listCalls += 1;
      return Promise.resolve(
        (input.candidates ?? []).map((candidate) => ({
          ...candidate,
          matches: candidate.matches.map((entry) => ({
            ...entry,
            existingOutcome:
              rows.get(
                key({
                  transactionHash: candidate.transactionHash,
                  logIndex: candidate.logIndex,
                  communityId: entry.communityId,
                }),
              )?.outcome ?? null,
          })),
        })),
      );
    },
    recordEvent: (row) => {
      if (!rows.has(key(row))) {
        rows.set(key(row), row);
      }
      return Promise.resolve();
    },
    settleEvent: (settle) => {
      const existing = rows.get(key(settle));
      if (existing?.outcome === "pending") {
        rows.set(key(settle), {
          ...existing,
          outcome: settle.outcome,
          streamMessageId:
            settle.outcome === "sent" || settle.outcome === "rejected"
              ? existing.streamMessageId
              : null,
        });
      }
      return Promise.resolve();
    },
  };
  return {
    repository,
    rows,
    cursor: () => cursor,
    listCalls: () => listCalls,
  };
}

function sender(
  implementation: MemberBuyFeedSender["sendCommunityFeedMessage"] = (input) =>
    Promise.resolve({ status: "sent", messageId: input.messageId }),
) {
  const send = vi.fn(implementation);
  return { send, sender: { sendCommunityFeedMessage: send } };
}

function outcomes(rows: Harness["rows"]): MemberBuyEventOutcome[] {
  return [...rows.values()].map((row) => row.outcome);
}

const signal = () => new AbortController().signal;

describe("member buy feed service (Decision 0097)", () => {
  it("idles until the pool_event indexer has a checkpoint", async () => {
    const state = harness({ checkpoint: null });
    const { sender: fake, send } = sender();
    const result = await createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
    }).runOnce(signal());
    expect(result.kind).toBe("indexer_not_started");
    expect(state.cursor()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("initializes the cursor at the checkpoint and replays no history", async () => {
    const state = harness({ checkpoint: "500", candidates: [swap(1)] });
    const events: MemberBuyFeedEvent[] = [];
    const { sender: fake, send } = sender();
    const result = await createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
      onEvent: (event) => events.push(event),
    }).runOnce(signal());
    expect(result.kind).toBe("cursor_initialized");
    expect(state.cursor()).toEqual({
      blockNumber: "500",
      logIndex: feedCursorWholeBlockLogIndex,
    });
    expect(state.listCalls()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        kind: "cursor_initialized",
        reasonCode: "MEMBER_BUY_FEED_CURSOR_INITIALIZED",
        blockNumber: "500",
      },
    ]);
  });

  it("never reads past the checkpoint: a caught-up or rewound indexer waits", async () => {
    for (const checkpoint of ["100", "90"]) {
      const state = harness({
        checkpoint,
        cursor: { blockNumber: "100", logIndex: feedCursorWholeBlockLogIndex },
        candidates: [swap(1)],
      });
      const result = await createMemberBuyFeedService({
        repository: state.repository,
        sender: sender().sender,
        chainId,
        usd1Address: null,
      }).runOnce(signal());
      expect(result.kind).toBe("waiting_for_indexer");
      expect(state.listCalls()).toBe(0);
      expect(state.cursor()?.blockNumber).toBe("100");
    }
  });

  it("sends a public buy, skips a sell and a private buyer, and advances to the checkpoint", async () => {
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: feedCursorWholeBlockLogIndex },
      candidates: [
        swap(1),
        swap(2, { buy: false }),
        swap(3, {
          matches: [match({ tradeHistoryVisibility: "self" })],
        }),
        swap(4, { matches: [match({ anonymousMode: true })] }),
        swap(5, { matches: [] }),
      ],
    });
    const { sender: fake, send } = sender();
    const result = await createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
    }).runOnce(signal());
    expect(result).toMatchObject({
      kind: "completed",
      examinedSwapCount: 5,
      sentCount: 1,
      skippedCount: 3,
    });
    expect(state.cursor()).toEqual({
      blockNumber: "120",
      logIndex: feedCursorWholeBlockLogIndex,
    });
    expect(outcomes(state.rows)).toEqual([
      "sent",
      "skipped_not_buy",
      "skipped_private",
      "skipped_private",
    ]);
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0]?.[0];
    const first = swap(1);
    expect(sent).toMatchObject({
      streamChannelId: channelA,
      messageId: memberBuyMessageId({
        chainId,
        transactionHash: first.transactionHash,
        logIndex: 1,
        communityId: communityA,
      }),
      text: "群友买入 · FROG",
      custom: {
        loop_schema: "member_buy.v1",
        loop_event_kind: "memberBuy",
        publicProfileId: profile,
        assetId: frog.assetId,
        symbol: "FROG",
        decimals: 18,
        amountRaw: "5000000000000000000",
        quoteAssetId: usdt.assetId,
        quoteSymbol: "USDT",
        quoteDecimals: 18,
        quoteAmountRaw: "2000000000000000000",
        quoteIsStable: true,
        txHash: first.transactionHash,
        logIndex: 1,
        chainId,
        blockNumber: "100",
        blockTimestamp: "2026-10-08T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(sent?.custom)).not.toContain(buyer);
    expect(sent?.messageId).toMatch(/^loop_buy_[0-9a-f]{32}$/);
  });

  it("does not post a swap whose base is not the community's bound asset", async () => {
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: 0 },
      candidates: [
        swap(1, {
          matches: [
            match({
              boundAssetId: usdt.assetId,
            }),
          ],
        }),
      ],
    });
    const { sender: fake, send } = sender();
    await createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
    }).runOnce(signal());
    expect(send).not.toHaveBeenCalled();
    expect(outcomes(state.rows)).toEqual(["skipped_not_buy"]);
  });

  it("skips a community whose channel is not provisioned", async () => {
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: 0 },
      candidates: [swap(1, { matches: [match({ streamChannelId: null })] })],
    });
    const { sender: fake, send } = sender();
    await createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
    }).runOnce(signal());
    expect(send).not.toHaveBeenCalled();
    expect(outcomes(state.rows)).toEqual(["skipped_no_channel"]);
  });

  it("sends at most the per-community limit and records the rest as truncated", async () => {
    const candidates = Array.from({ length: 23 }, (_unused, index) =>
      swap(index, {
        matches: [
          match(),
          match({ communityId: communityB, streamChannelId: channelB }),
        ],
      }),
    );
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: 0 },
      candidates,
    });
    const events: MemberBuyFeedEvent[] = [];
    const { sender: fake, send } = sender();
    const result = await createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
      onEvent: (event) => events.push(event),
    }).runOnce(signal());
    expect(send).toHaveBeenCalledTimes(40);
    expect(result).toMatchObject({ sentCount: 40, truncatedCount: 6 });
    expect(events.filter((event) => event.kind === "truncated")).toEqual([
      {
        kind: "truncated",
        reasonCode: "MEMBER_BUY_FEED_TRUNCATED",
        communityId: communityA,
        truncatedCount: 3,
      },
      {
        kind: "truncated",
        reasonCode: "MEMBER_BUY_FEED_TRUNCATED",
        communityId: communityB,
        truncatedCount: 3,
      },
    ]);
  });

  it("is idempotent: a second pass over the same swaps sends nothing", async () => {
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: 0 },
      candidates: [swap(1)],
    });
    const { sender: fake, send } = sender();
    const service = createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
    });
    await service.runOnce(signal());
    expect(state.rows.size).toBe(1);
    // Re-read the same window, as after a crash before the cursor moved.
    await createMemberBuyFeedService({
      repository: {
        ...state.repository,
        readCursor: () => Promise.resolve({ blockNumber: "99", logIndex: 0 }),
      },
      sender: fake,
      chainId,
      usd1Address: null,
    }).runOnce(signal());
    expect(send).toHaveBeenCalledOnce();
  });

  it("stalls on a Stream outage at the last handled swap and resends the pending one next pass", async () => {
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: 0 },
      candidates: [swap(1, { block: "100" }), swap(2, { block: "101" })],
    });
    let down = true;
    const events: MemberBuyFeedEvent[] = [];
    const { sender: fake, send } = sender((input) =>
      input.custom["logIndex"] === 2 && down
        ? Promise.reject(new StreamChannelGatewayUnavailableError())
        : Promise.resolve({ status: "sent", messageId: input.messageId }),
    );
    const service = createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
      onEvent: (event) => events.push(event),
    });
    const first = await service.runOnce(signal());
    expect(first.kind).toBe("stalled");
    expect(state.cursor()).toEqual({ blockNumber: "100", logIndex: 1 });
    expect(outcomes(state.rows)).toEqual(["sent", "pending"]);
    expect(events.at(-1)).toMatchObject({
      kind: "stream_unavailable",
      reasonCode: "MEMBER_BUY_FEED_STREAM_UNAVAILABLE",
      errorClass: "StreamChannelGatewayUnavailableError",
    });

    down = false;
    const second = await service.runOnce(signal());
    expect(second.kind).toBe("completed");
    expect(outcomes(state.rows)).toEqual(["sent", "sent"]);
    // swap 1 was not sent again; swap 2 was resent under the same ID.
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1]?.[0].messageId).toBe(
      send.mock.calls[2]?.[0].messageId,
    );
    expect(state.cursor()).toEqual({
      blockNumber: "120",
      logIndex: feedCursorWholeBlockLogIndex,
    });
  });

  it("records a deterministic Stream rejection and moves on", async () => {
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: 0 },
      candidates: [swap(1), swap(2)],
    });
    const { sender: fake } = sender((input) =>
      input.custom["logIndex"] === 1
        ? Promise.reject(new StreamChannelRequestRejectedError())
        : Promise.resolve({ status: "duplicate", messageId: input.messageId }),
    );
    const result = await createMemberBuyFeedService({
      repository: state.repository,
      sender: fake,
      chainId,
      usd1Address: null,
    }).runOnce(signal());
    expect(result).toMatchObject({
      kind: "completed",
      rejectedCount: 1,
      sentCount: 1,
    });
    expect(outcomes(state.rows)).toEqual(["rejected", "sent"]);
  });

  it("stops at the last handled swap when the page is full", async () => {
    const state = harness({
      checkpoint: "120",
      cursor: { blockNumber: "99", logIndex: 0 },
      candidates: [swap(1, { block: "100" }), swap(2, { block: "105" })],
    });
    await createMemberBuyFeedService({
      repository: state.repository,
      sender: sender().sender,
      chainId,
      usd1Address: null,
      eventBatch: 2,
    }).runOnce(signal());
    expect(state.cursor()).toEqual({ blockNumber: "105", logIndex: 2 });
  });

  it("propagates a repository failure so the worker backs off", async () => {
    const state = harness({ checkpoint: "120" });
    await expect(
      createMemberBuyFeedService({
        repository: {
          ...state.repository,
          readCursor: () => Promise.reject(new Error("db down")),
        },
        sender: sender().sender,
        chainId,
        usd1Address: null,
      }).runOnce(signal()),
    ).rejects.toThrow("db down");
  });

  it("returns aborted without reading when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const state = harness({ checkpoint: "120" });
    const result = await createMemberBuyFeedService({
      repository: state.repository,
      sender: sender().sender,
      chainId,
      usd1Address: null,
    }).runOnce(controller.signal);
    expect(result.kind).toBe("aborted");
  });
});
