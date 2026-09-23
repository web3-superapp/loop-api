import { describe, expect, it, vi } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import {
  communityAiCapabilityDefinitions,
  communityAiReasonCodes,
  parseAskBody,
  askDigest,
  InvalidCommunityAiRequestError,
} from "../src/features/community-ai/community-ai-contract.js";
import {
  assembleCommunityAiKnowledge,
  type CommunityAiKnowledgeReaders,
} from "../src/features/community-ai/community-ai-knowledge.js";
import {
  CommunityAiQuotaExceededError,
  type CommunityAiRepository,
} from "../src/features/community-ai/community-ai-repository.js";
import {
  createCommunityAiService,
  createUnavailableCommunityAiService,
  type CommunityAiServiceOptions,
} from "../src/features/community-ai/community-ai-service.js";
import type { CommunityResource } from "../src/features/community/community-service.js";
import type { CommunityService } from "../src/features/community/community-service.js";
import type { CommunicationRepository } from "../src/features/communication/communication-repository.js";
import {
  communityAiMessagesUrl,
  createAnthropicCommunityAiGateway,
  CommunityAiProviderError,
  parseCommunityAiCompletion,
  type AnthropicFetch,
  type CommunityAiGateway,
} from "../src/integrations/ai/anthropic-adapter.js";
import type { StreamCommunityChannelGateway } from "../src/integrations/stream/channel-gateway.js";

const communityId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const accountId = "7e23b97f-5245-48f7-a423-d6f086b41066";
const otherAccountId = "8f34ca80-6356-49a8-b534-e701a7c52177";
const channelId = `loop_community_${communityId.replaceAll("-", "")}`;
const idempotencyKey = "4f605172-8d9e-4fa0-8123-3d4e5f607182";
const requestId = "5a716283-9eaf-4ab1-9234-4e5f60718293";
const now = new Date("2026-09-22T03:00:00.000Z");

const principal = {
  userId: accountId,
  privyUserId: "did:privy:verified-user",
  streamUserId: `loop_${accountId.replaceAll("-", "")}`,
} as const;

function communityResource(
  membership: CommunityResource["viewer"]["membership"],
  overrides: Partial<CommunityResource["community"]> = {},
): CommunityResource {
  return Object.freeze({
    community: Object.freeze({
      communityId,
      name: "PEPE",
      slug: "pepe",
      description: "A community",
      logoRef: null,
      verificationStatus: "verified" as const,
      boundAssetKey: null,
      memberCount: 42,
      createdAt: "2026-09-01T00:00:00.000Z",
      configVersion:
        "community-config-v1" as CommunityResource["community"]["configVersion"],
      ...overrides,
    }),
    viewer: Object.freeze({
      membership,
      canInviteAdmin: false,
      canMute: false,
      canBan: false,
    }),
    chat: Object.freeze({
      status: "unavailable" as const,
      channelCid: null,
      memberState: null,
      reasonCode: "COMMUNITY_CHANNEL_NOT_PROVISIONED",
      viewerPersona: null,
    }),
    voice: Object.freeze({
      status: "unavailable" as const,
      currentRoomId: null,
      reasonCode: "COMMUNITY_VOICE_ROOM_NOT_LIVE",
    }),
    miningPower: Object.freeze({
      status: "unavailable" as const,
      reasonCode: "MINING_FORMULA_BASELINE_PENDING",
    }),
    onlineCount: Object.freeze({
      status: "unavailable" as const,
      reasonCode: "STREAM_PRESENCE_NOT_CONNECTED",
    }),
    announcements: Object.freeze({
      status: "unavailable" as const,
      reasonCode: "COMMUNITY_ANNOUNCEMENTS_DEFERRED",
    }),
    officialLinks: Object.freeze({
      status: "unavailable" as const,
      reasonCode: "COMMUNITY_OFFICIAL_LINKS_DEFERRED",
    }),
    contractVersion: "2.0",
  });
}

function communityServiceFake(resource: CommunityResource): CommunityService {
  return {
    getCommunity: () => Promise.resolve(resource),
  } as unknown as CommunityService;
}

function communicationRepositoryFake(): CommunicationRepository {
  return {
    readCommunityChannel: () =>
      Promise.resolve({
        channel: {
          communityId,
          streamChannelId: channelId,
          state: "created" as const,
          memberCap: 100,
          provisioned: true,
        },
        viewerMemberState: "synced" as const,
        viewerIsCommunityMember: true,
        viewerPersona: null,
        currentVoiceRoomId: null,
        currentVoiceRoomProvisioned: false,
      }),
  } as unknown as CommunicationRepository;
}

function channelGatewayFake(
  messages: readonly {
    readonly authorUserId: string | null;
    readonly text: string;
    readonly createdAt: string;
  }[],
): StreamCommunityChannelGateway {
  return {
    readCommunityChannelMessages: vi.fn(() => Promise.resolve(messages)),
  } as unknown as StreamCommunityChannelGateway;
}

function repositoryFake(
  overrides: Partial<CommunityAiRepository> = {},
): CommunityAiRepository {
  const stored = new Map<string, unknown>();
  return {
    beginAsk: vi.fn(() =>
      Promise.resolve({
        kind: "reserved" as const,
        idempotencyRecordId: requestId,
        usageId: idempotencyKey,
      }),
    ),
    completeAsk: vi.fn<CommunityAiRepository["completeAsk"]>((input) => {
      const answer = {
        answerId: communityId,
        communityId: input.communityId,
        ownerUserId: input.ownerUserId,
        question: input.question,
        answer: input.answer,
        refusal: input.refusal,
        citations: input.citations,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        createdAt: now.toISOString(),
      };
      stored.set(answer.answerId, answer);
      return Promise.resolve(answer);
    }),
    reserveBrief: vi.fn(() => Promise.resolve({ usageId: idempotencyKey })),
    settleUsage: vi.fn(() => Promise.resolve()),
    reportAnswer: vi.fn(() =>
      Promise.resolve({
        created: true,
        report: {
          reportId: requestId,
          answerId: communityId,
          reason: "inaccurate" as const,
          note: null,
          createdAt: now.toISOString(),
        },
      }),
    ),
    readPersonaAliases: vi.fn(() =>
      Promise.resolve(new Map([[otherAccountId, "Otter-1234"]])),
    ),
    ...overrides,
  };
}

function gatewayFake(
  completion: Partial<{
    answer: string;
    citations: readonly { readonly sourceId: string }[];
    refusal: string | null;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }> = {},
): {
  readonly gateway: CommunityAiGateway;
  readonly complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(() =>
    Promise.resolve({
      answer: completion.answer ?? "社区现有 42 名成员 [s1]。",
      citations: completion.citations ?? [{ sourceId: "s1" }],
      refusal: completion.refusal ?? null,
      model: completion.model ?? "claude-sonnet-5",
      inputTokens: completion.inputTokens ?? 100,
      outputTokens: completion.outputTokens ?? 20,
    }),
  );
  const gateway: CommunityAiGateway = {
    model: "claude-sonnet-5",
    complete: complete,
  };
  return { gateway, complete };
}

function readersFor(
  resource: CommunityResource,
  overrides: Partial<CommunityAiKnowledgeReaders> = {},
): CommunityAiKnowledgeReaders {
  return {
    communityService: communityServiceFake(resource),
    marketReadService: null,
    miningService: null,
    voiceRoomService: null,
    communicationRepository: communicationRepositoryFake(),
    channelGateway: channelGatewayFake([
      {
        authorUserId: otherAccountId,
        text: "今天的进展如何",
        createdAt: "2026-09-22T02:00:00.000Z",
      },
    ]),
    repository: repositoryFake(),
    ...overrides,
  };
}

const activeMembership = {
  role: "member" as const,
  status: "active" as const,
  joinedAt: "2026-09-02T00:00:00.000Z",
};

const readContext = {
  principal,
  communityId,
  canonicalClientIp: "203.0.113.7",
  requestId,
  signal: new AbortController().signal,
};

describe("Anthropic Community AI adapter (Decision 0066)", () => {
  const body = (input: unknown) => ({
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", name: "community_ai_answer", input }],
    usage: { input_tokens: 120, output_tokens: 40 },
  });

  it("accepts exactly one forced tool block and reports the model and tokens", () => {
    const parsed = parseCommunityAiCompletion(
      body({ answer: "  价格是 0.1 [s2]  ", citations: [{ sourceId: "s2" }] }),
      "fallback",
    );
    expect(parsed.answer).toBe("价格是 0.1 [s2]");
    expect(parsed.citations).toEqual([{ sourceId: "s2" }]);
    expect(parsed.refusal).toBeNull();
    expect(parsed.model).toBe("claude-sonnet-5");
    expect(parsed.inputTokens).toBe(120);
    expect(parsed.outputTokens).toBe(40);
  });

  it("rejects prose, a second tool block, a wrong tool, and an unexpected field", () => {
    const cases: unknown[] = [
      { model: "m", content: [{ type: "text", text: "answer: 42" }] },
      {
        model: "m",
        content: [
          {
            type: "tool_use",
            name: "community_ai_answer",
            input: { answer: "a", citations: [] },
          },
          {
            type: "tool_use",
            name: "community_ai_answer",
            input: { answer: "b", citations: [] },
          },
        ],
      },
      {
        model: "m",
        content: [
          {
            type: "tool_use",
            name: "other_tool",
            input: { answer: "a", citations: [] },
          },
        ],
      },
      body({ answer: "a", citations: [], sentiment: "bullish" }),
      body({ answer: 42, citations: [] }),
      body({ answer: "a", citations: [{ sourceId: "s1", weight: 2 }] }),
      body({ answer: "   ", citations: [] }),
    ];
    for (const value of cases) {
      expect(() => parseCommunityAiCompletion(value, "fallback")).toThrow(
        CommunityAiProviderError,
      );
    }
  });

  it("classifies a deterministic 4xx as rejected and a timeout or 5xx as unavailable", async () => {
    const rejecting: AnthropicFetch = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve(""),
      });
    const failing: AnthropicFetch = () =>
      Promise.resolve({
        ok: false,
        status: 529,
        text: () => Promise.resolve(""),
      });
    const hanging: AnthropicFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const make = (fetchImpl: AnthropicFetch) =>
      createAnthropicCommunityAiGateway({
        apiKey: "sk-ant-test",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-5",
        timeoutMs: 20,
        maximumOutputTokens: 800,
        fetch: fetchImpl,
      });
    await expect(
      make(rejecting).complete({ system: "s", userContent: "u" }),
    ).rejects.toMatchObject({ reason: "COMMUNITY_AI_PROVIDER_REJECTED" });
    await expect(
      make(failing).complete({ system: "s", userContent: "u" }),
    ).rejects.toMatchObject({ reason: "COMMUNITY_AI_PROVIDER_UNAVAILABLE" });
    await expect(
      make(hanging).complete({ system: "s", userContent: "u" }),
    ).rejects.toMatchObject({ reason: "COMMUNITY_AI_PROVIDER_UNAVAILABLE" });
  });

  it("sends the key only as a header and forces the answer tool", async () => {
    const seen: { headers?: Record<string, string>; body?: string } = {};
    const fetchImpl: AnthropicFetch = (_url, init) => {
      seen.headers = { ...init.headers };
      seen.body = init.body;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify(body({ answer: "ok", citations: [] })),
          ),
      });
    };
    const gateway = createAnthropicCommunityAiGateway({
      apiKey: "sk-ant-secret",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-5",
      timeoutMs: 1_000,
      maximumOutputTokens: 800,
      fetch: fetchImpl,
    });
    await gateway.complete({ system: "rules", userContent: "sources" });
    expect(seen.headers?.["x-api-key"]).toBe("sk-ant-secret");
    expect(seen.headers?.["anthropic-version"]).toBe("2023-06-01");
    const sent = JSON.parse(String(seen.body)) as Record<string, unknown>;
    expect(sent["max_tokens"]).toBe(800);
    expect(sent["tool_choice"]).toEqual({
      type: "tool",
      name: "community_ai_answer",
    });
    expect(JSON.stringify(sent)).not.toContain("sk-ant-secret");
  });

  it("derives the request URL from baseUrl and normalises a trailing slash", async () => {
    expect(communityAiMessagesUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(communityAiMessagesUrl("https://api.onlyrouter.ai/")).toBe(
      "https://api.onlyrouter.ai/v1/messages",
    );
    expect(communityAiMessagesUrl("https://api.onlyrouter.ai//")).toBe(
      "https://api.onlyrouter.ai/v1/messages",
    );

    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    const fetchImpl: AnthropicFetch = (url, init) => {
      urls.push(url);
      headers.push({ ...init.headers });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify(body({ answer: "ok", citations: [] })),
          ),
      });
    };
    for (const baseUrl of [
      "https://api.onlyrouter.ai",
      "https://api.onlyrouter.ai/",
    ]) {
      await createAnthropicCommunityAiGateway({
        apiKey: "sk-or-secret",
        baseUrl,
        model: "claude-sonnet-4-6",
        timeoutMs: 1_000,
        maximumOutputTokens: 800,
        fetch: fetchImpl,
      }).complete({ system: "rules", userContent: "sources" });
    }
    expect(urls).toEqual([
      "https://api.onlyrouter.ai/v1/messages",
      "https://api.onlyrouter.ai/v1/messages",
    ]);
    // The same Anthropic wire headers reach a compatible gateway unchanged.
    expect(headers[0]?.["x-api-key"]).toBe("sk-or-secret");
    expect(headers[0]?.["anthropic-version"]).toBe("2023-06-01");
    for (const url of urls) {
      expect(url).not.toContain("sk-or-secret");
    }
  });
});

describe("Community AI knowledge assembly (Decision 0066)", () => {
  it("never reads the official channel for a non-member", async () => {
    const gateway = channelGatewayFake([]);
    const knowledge = await assembleCommunityAiKnowledge(
      readersFor(communityResource(null), { channelGateway: gateway }),
      {
        principal,
        communityId,
        canonicalClientIp: "203.0.113.7",
        requestId,
        signal: new AbortController().signal,
        chatWindowHours: 168,
        now,
      },
    );
    expect(knowledge.chat).toBeNull();
    expect(
      knowledge.sources.some((source) => source.kind === "communityChat"),
    ).toBe(false);
    expect(knowledge.omitted).toContainEqual({
      kind: "communityChat",
      reasonCode: communityAiReasonCodes.notAMember,
    });
    expect(
      (
        gateway as unknown as {
          readCommunityChannelMessages: ReturnType<typeof vi.fn>;
        }
      ).readCommunityChannelMessages,
    ).not.toHaveBeenCalled();
  });

  it("names message authors by community persona and never by an identifier", async () => {
    const knowledge = await assembleCommunityAiKnowledge(
      readersFor(communityResource(activeMembership)),
      {
        principal,
        communityId,
        canonicalClientIp: "203.0.113.7",
        requestId,
        signal: new AbortController().signal,
        chatWindowHours: 168,
        now,
      },
    );
    const chat = knowledge.sources.find(
      (source) => source.kind === "communityChat",
    );
    expect(chat?.untrustedLines).toEqual([
      "2026-09-22T02:00:00.000Z Otter-1234: 今天的进展如何",
    ]);
    const serialized = JSON.stringify(knowledge.sources);
    expect(serialized).not.toContain(otherAccountId);
    expect(serialized).not.toContain(principal.streamUserId);
  });

  it("records announcements as an omitted source rather than a silent absence", async () => {
    const knowledge = await assembleCommunityAiKnowledge(
      readersFor(communityResource(activeMembership)),
      {
        principal,
        communityId,
        canonicalClientIp: "203.0.113.7",
        requestId,
        signal: new AbortController().signal,
        chatWindowHours: 24,
        now,
      },
    );
    expect(knowledge.omitted).toContainEqual({
      kind: "announcements",
      reasonCode: communityAiReasonCodes.announcementSource,
    });
    expect(knowledge.omitted).toContainEqual({
      kind: "assetFacts",
      reasonCode: communityAiReasonCodes.assetNotBound,
    });
    expect(knowledge.chat).toEqual({
      messageCount: 1,
      bounded: false,
      windowHours: 24,
      observedAt: "2026-09-22T02:00:00.000Z",
    });
  });
});

describe("Community AI service (Decision 0066)", () => {
  function service(
    options: {
      readonly resource?: CommunityResource;
      readonly gateway?: ReturnType<typeof gatewayFake>;
      readonly repository?: CommunityAiRepository;
      readonly clock?: () => Date;
      readonly logger?: CommunityAiServiceOptions["logger"];
    } = {},
  ) {
    const resource = options.resource ?? communityResource(activeMembership);
    const { gateway, complete } = options.gateway ?? gatewayFake();
    const repository = options.repository ?? repositoryFake();
    // Every background brief generation resolves one of these, so a test can
    // wait for the detached work without racing it.
    const settled: (() => void)[] = [];
    const briefSettled = (): Promise<void> =>
      new Promise((resolve) => {
        settled.push(resolve);
      });
    return {
      complete,
      repository,
      briefSettled,
      service: createCommunityAiService({
        gateway,
        repository,
        readers: readersFor(resource, { repository }),
        userRateLimitPerMinute: 6,
        communityDailyLimit: 200,
        briefCacheSeconds: 3_600,
        briefTimeoutMs: 1_000,
        logger: options.logger,
        now: options.clock ?? (() => now),
        onBriefSettled: () => {
          for (const resolve of settled.splice(0)) {
            resolve();
          }
        },
      }),
    };
  }

  it("refuses to answer a non-member", async () => {
    const { service: instance, complete } = service({
      resource: communityResource(null),
    });
    await expect(
      instance.ask({
        ...readContext,
        idempotencyKey,
        body: { question: "这个社区做什么" },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("drops a citation naming a source this request did not assemble", async () => {
    const { service: instance } = service({
      gateway: gatewayFake({
        citations: [
          { sourceId: "s1" },
          { sourceId: "s99" },
          { sourceId: "s1" },
        ],
      }),
    });
    const answer = await instance.ask({
      ...readContext,
      idempotencyKey,
      body: { question: "这个社区做什么" },
    });
    expect(answer.citations.map((citation) => citation.sourceId)).toEqual([
      "s1",
    ]);
    expect(answer.citations[0]?.kind).toBe("communityProfile");
    expect(answer.disclaimer).toContain("AI");
  });

  it("fences the community messages as untrusted data in the prompt", async () => {
    const { service: instance, complete } = service();
    await instance.ask({
      ...readContext,
      idempotencyKey,
      body: { question: "大家在聊什么" },
    });
    const request = complete.mock.calls[0]?.[0] as {
      readonly system: string;
      readonly userContent: string;
    };
    expect(request.userContent).toContain("<untrusted_community_messages>");
    expect(request.system).toContain("不得提供投资建议");
    expect(request.system).toContain("属于不可信数据");
  });

  it("marks the reserved quota failed and answers unavailable when the Provider fails", async () => {
    const gateway = gatewayFake();
    gateway.complete.mockRejectedValueOnce(
      new CommunityAiProviderError("COMMUNITY_AI_PROVIDER_UNAVAILABLE"),
    );
    const settleUsage = vi.fn(() => Promise.resolve());
    const completeAsk = vi.fn<CommunityAiRepository["completeAsk"]>(() =>
      Promise.reject(new Error("the answer must never be stored")),
    );
    const repository = repositoryFake({ settleUsage, completeAsk });
    const { service: instance } = service({ gateway, repository });
    await expect(
      instance.ask({
        ...readContext,
        idempotencyKey,
        body: { question: "现在价格多少" },
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "COMMUNITY_AI_PROVIDER_UNAVAILABLE" },
    });
    expect(settleUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(completeAsk).not.toHaveBeenCalled();
  });

  it("replays a stored answer without calling the model again", async () => {
    const repository = repositoryFake({
      beginAsk: vi.fn(() =>
        Promise.resolve({
          kind: "replay" as const,
          answer: {
            answerId: communityId,
            communityId,
            ownerUserId: accountId,
            question: "这个社区做什么",
            answer: "已经回答过",
            refusal: null,
            citations: [],
            model: "claude-sonnet-5",
            inputTokens: 10,
            outputTokens: 5,
            createdAt: now.toISOString(),
          },
        }),
      ),
    });
    const { service: instance, complete } = service({ repository });
    const answer = await instance.ask({
      ...readContext,
      idempotencyKey,
      body: { question: "这个社区做什么" },
    });
    expect(answer.answer).toBe("已经回答过");
    expect(complete).not.toHaveBeenCalled();
  });

  it("turns an exhausted quota into RATE_LIMITED naming the scope", async () => {
    const repository = repositoryFake({
      beginAsk: vi.fn(() =>
        Promise.reject(new CommunityAiQuotaExceededError("community")),
      ),
    });
    const { service: instance } = service({ repository });
    await expect(
      instance.ask({
        ...readContext,
        idempotencyKey,
        body: { question: "这个社区做什么" },
      }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      detailsSafe: { scope: "community" },
    });
  });

  it("publishes eight abilities to an admin and seven to a member, with no document count", async () => {
    const memberView = await service().service.getOverview(readContext);
    expect(memberView.capabilities).toHaveLength(7);
    expect(
      memberView.capabilities.some(
        (capability) => capability.capabilityId === "communityAnalytics",
      ),
    ).toBe(false);
    expect(memberView.knowledge.documents).toEqual({
      status: "unavailable",
      reasonCode: communityAiReasonCodes.knowledgeDocuments,
    });
    expect(memberView.knowledge.sourceCount).toBeGreaterThan(0);
    expect(memberView.exampleQuestions).toHaveLength(3);

    const adminView = await service({
      resource: communityResource({
        role: "admin",
        status: "active",
        joinedAt: "2026-09-02T00:00:00.000Z",
      }),
    }).service.getOverview(readContext);
    expect(adminView.capabilities).toHaveLength(
      communityAiCapabilityDefinitions.length,
    );
    const analytics = adminView.capabilities.find(
      (capability) => capability.capabilityId === "communityAnalytics",
    );
    expect(analytics).toMatchObject({
      availability: "unavailable",
      reasonCode: communityAiReasonCodes.analytics,
    });
  });

  it("answers a cache miss as pending at once and generates the brief in the background", async () => {
    const reserveBrief = vi.fn(() =>
      Promise.resolve({ usageId: idempotencyKey }),
    );
    const settleUsage = vi.fn(() => Promise.resolve());
    const {
      service: instance,
      complete,
      briefSettled,
    } = service({ repository: repositoryFake({ reserveBrief, settleUsage }) });
    const pending = briefSettled();
    const first = await instance.getOverview(readContext);
    expect(first.brief).toEqual({
      status: "unavailable",
      reasonCode: communityAiReasonCodes.briefPending,
    });
    // The read itself never called the model; the generation was started.
    await pending;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(reserveBrief).toHaveBeenCalledTimes(1);
    expect(settleUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", inputTokens: 100 }),
    );
    const second = await instance.getOverview(readContext);
    expect(second.brief).toEqual({
      status: "available",
      messageCount: 1,
      bounded: false,
      windowHours: 24,
      summary: "社区现有 42 名成员 [s1]。",
      model: "claude-sonnet-5",
      generatedAt: now.toISOString(),
    });
    const third = await instance.getOverview(readContext);
    expect(third).toEqual(second);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("never hands the request signal to the background generation", async () => {
    const { service: instance, complete, briefSettled } = service();
    const pending = briefSettled();
    const controller = new AbortController();
    await instance.getOverview({ ...readContext, signal: controller.signal });
    controller.abort();
    await pending;
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal).not.toBe(controller.signal);
    expect(request.signal?.aborted).toBe(false);
  });

  it("runs one generation for concurrent reads of the same community", async () => {
    let release: (() => void) | null = null;
    const complete = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<CommunityAiGateway["complete"]>>>(
          (resolve) => {
            release = (): void => {
              resolve({
                answer: "摘要",
                citations: [],
                refusal: null,
                model: "claude-sonnet-5",
                inputTokens: 1,
                outputTokens: 1,
              });
            };
          },
        ),
    );
    const reserveBrief = vi.fn(() =>
      Promise.resolve({ usageId: idempotencyKey }),
    );
    const { service: instance, briefSettled } = service({
      gateway: { gateway: { model: "claude-sonnet-5", complete }, complete },
      repository: repositoryFake({ reserveBrief }),
    });
    const pending = briefSettled();
    const [first, second] = await Promise.all([
      instance.getOverview(readContext),
      instance.getOverview(readContext),
    ]);
    expect(first.brief).toEqual({
      status: "unavailable",
      reasonCode: communityAiReasonCodes.briefPending,
    });
    expect(second.brief).toEqual(first.brief);
    const third = await instance.getOverview(readContext);
    expect(third.brief).toEqual(first.brief);
    await Promise.resolve();
    expect(reserveBrief).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    (release as (() => void) | null)?.();
    await pending;
    const fourth = await instance.getOverview(readContext);
    expect(fourth.brief).toMatchObject({
      status: "available",
      summary: "摘要",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("publishes a failed generation under its Provider classification and retries only after the window", async () => {
    let currentMs = now.getTime();
    const complete = vi.fn(() =>
      Promise.reject(
        new CommunityAiProviderError("COMMUNITY_AI_PROVIDER_REJECTED"),
      ),
    );
    const warn = vi.fn();
    const settleUsage = vi.fn(() => Promise.resolve());
    const { service: instance, briefSettled } = service({
      gateway: { gateway: { model: "claude-sonnet-5", complete }, complete },
      repository: repositoryFake({ settleUsage }),
      clock: () => new Date(currentMs),
      logger: { warn },
    });
    const pending = briefSettled();
    const first = await instance.getOverview(readContext);
    expect(first.brief).toEqual({
      status: "unavailable",
      reasonCode: communityAiReasonCodes.briefPending,
    });
    await pending;
    expect(settleUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      communityId,
      requestId,
      reasonCode: "COMMUNITY_AI_PROVIDER_REJECTED",
      errorName: "CommunityAiProviderError",
    });
    const second = await instance.getOverview(readContext);
    expect(second.brief).toEqual({
      status: "unavailable",
      reasonCode: "COMMUNITY_AI_PROVIDER_REJECTED",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    // Inside the retry window nothing is generated again.
    currentMs += 299_000;
    await instance.getOverview(readContext);
    expect(complete).toHaveBeenCalledTimes(1);
    // Past it, one more attempt is made and the read is pending again.
    currentMs += 2_000;
    const later = briefSettled();
    const fourth = await instance.getOverview(readContext);
    expect(fourth.brief).toEqual({
      status: "unavailable",
      reasonCode: communityAiReasonCodes.briefPending,
    });
    await later;
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("publishes an exhausted quota as its own reason and never throws from the read", async () => {
    const repository = repositoryFake({
      reserveBrief: vi.fn(() =>
        Promise.reject(new CommunityAiQuotaExceededError("community")),
      ),
    });
    const {
      service: instance,
      complete,
      briefSettled,
    } = service({ repository });
    const pending = briefSettled();
    const first = await instance.getOverview(readContext);
    expect(first.brief.status).toBe("unavailable");
    await pending;
    const second = await instance.getOverview(readContext);
    expect(second.brief).toEqual({
      status: "unavailable",
      reasonCode: communityAiReasonCodes.quotaExhausted,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps the brief closed for a non-member", async () => {
    const { service: instance, complete } = service({
      resource: communityResource(null),
    });
    const overview = await instance.getOverview(readContext);
    expect(overview.brief).toEqual({
      status: "unavailable",
      reasonCode: communityAiReasonCodes.notAMember,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("is completely closed without an API key", async () => {
    const closed = createUnavailableCommunityAiService();
    for (const call of [
      closed.getOverview(readContext),
      closed.ask({ ...readContext, idempotencyKey, body: { question: "x?" } }),
      closed.report({
        ...readContext,
        answerId: communityId,
        idempotencyKey,
        body: { reason: "inaccurate" },
      }),
    ]) {
      await expect(call).rejects.toBeInstanceOf(V2ApiError);
      await expect(call).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "COMMUNITY_AI_RUNTIME_DEFERRED" },
      });
    }
  });
});

describe("Community AI request parsing (Decision 0066)", () => {
  it("bounds the question and binds the digest to the community", () => {
    expect(parseAskBody({ question: "  怎么参与挖矿  " })).toEqual({
      question: "怎么参与挖矿",
    });
    expect(() => parseAskBody({ question: "x" })).toThrow(
      InvalidCommunityAiRequestError,
    );
    expect(() => parseAskBody({ question: "x".repeat(501) })).toThrow(
      InvalidCommunityAiRequestError,
    );
    expect(() => parseAskBody({ question: "ok?", extra: 1 })).toThrow(
      InvalidCommunityAiRequestError,
    );
    expect(askDigest({ communityId, question: "怎么参与挖矿" })).not.toBe(
      askDigest({ communityId: accountId, question: "怎么参与挖矿" }),
    );
  });
});
