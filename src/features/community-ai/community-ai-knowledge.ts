import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import type { CommunicationRepository } from "../communication/communication-repository.js";
import type { CommunityResource } from "../community/community-service.js";
import type { CommunityService } from "../community/community-service.js";
import type { MarketReadService } from "../market/market-read-service.js";
import type { MiningService } from "../mining/mining-service.js";
import type { VoiceRoomService } from "../communication/voice-room-service.js";
import type { StreamCommunityChannelGateway } from "../../integrations/stream/channel-gateway.js";
import type { CommunityAiRepository } from "./community-ai-repository.js";
import {
  communityAiChatMessageLimit,
  communityAiReasonCodes,
  communityAiSourceId,
  type CommunityAiOmittedSource,
  type CommunityAiSource,
  type CommunityAiSourceFact,
} from "./community-ai-contract.js";

/**
 * Knowledge assembly for Community AI (Decision 0066).
 *
 * Each source is an independently attempted read of a fact the calling
 * account could already obtain through an existing `/v2` route. A source that
 * fails, is unconfigured, or is not permitted is omitted **with a reason**;
 * the remaining sources still answer. Nothing here fabricates a value, and no
 * source is read with authority the caller does not have.
 */

export interface CommunityAiKnowledgeReaders {
  readonly communityService: CommunityService;
  readonly marketReadService: MarketReadService | null;
  readonly miningService: MiningService | null;
  readonly voiceRoomService: VoiceRoomService | null;
  readonly communicationRepository: CommunicationRepository | null;
  readonly channelGateway: StreamCommunityChannelGateway | null;
  readonly repository: CommunityAiRepository;
}

export interface AssembleCommunityAiKnowledgeInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly communityId: string;
  readonly canonicalClientIp: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  /** How far back the chat source looks. */
  readonly chatWindowHours: number;
  readonly now: Date;
}

export interface CommunityAiChatObservation {
  readonly messageCount: number;
  /** A full page still inside the window: the count is a floor. */
  readonly bounded: boolean;
  readonly windowHours: number;
  readonly observedAt: string;
}

export interface CommunityAiKnowledge {
  readonly community: CommunityResource;
  readonly sources: readonly CommunityAiSource[];
  readonly omitted: readonly CommunityAiOmittedSource[];
  /** Null when the chat source was not assembled at all. */
  readonly chat: CommunityAiChatObservation | null;
}

const unknownAuthorLabel = "社区成员";

function fact(label: string, value: string): CommunityAiSourceFact {
  return Object.freeze({ label, value });
}

function factValue(
  projection: { readonly value: string | null } | undefined,
): string | null {
  return projection?.value ?? null;
}

/** The viewer is an active member: only then may chat messages be read. */
export function isActiveMember(resource: CommunityResource): boolean {
  return resource.viewer.membership?.status === "active";
}

export function isCommunityAdmin(resource: CommunityResource): boolean {
  const role = resource.viewer.membership?.role;
  return (
    resource.viewer.membership?.status === "active" &&
    (role === "owner" || role === "admin")
  );
}

export async function assembleCommunityAiKnowledge(
  readers: CommunityAiKnowledgeReaders,
  input: AssembleCommunityAiKnowledgeInput,
): Promise<CommunityAiKnowledge> {
  // The community read is the only mandatory one: it also decides, through
  // the viewer's membership, whether the chat source may be assembled.
  const community = await readers.communityService.getCommunity({
    principal: input.principal,
    communityId: input.communityId,
  });
  const sources: CommunityAiSource[] = [];
  const omitted: CommunityAiOmittedSource[] = [];
  const nowIso = input.now.toISOString();

  const push = (
    source: Omit<CommunityAiSource, "sourceId">,
  ): CommunityAiSource => {
    const built = Object.freeze({
      ...source,
      sourceId: communityAiSourceId(sources.length),
    });
    sources.push(built);
    return built;
  };

  push({
    kind: "communityProfile",
    label: `社区档案：${community.community.name}`,
    observedAt: nowIso,
    facts: Object.freeze([
      fact("社区名称", community.community.name),
      fact("社区简介", community.community.description ?? "（未填写）"),
      fact("验证状态", community.community.verificationStatus),
      fact("成员数", String(community.community.memberCount)),
      fact("绑定资产", community.community.boundAssetKey ?? "（未绑定）"),
      fact("创建时间", community.community.createdAt),
    ]),
    untrustedLines: Object.freeze([]),
  });

  // Announcements have no backend at all (the community read publishes them
  // as unavailable), so they are recorded as an omitted source rather than
  // silently absent.
  omitted.push(
    Object.freeze({
      kind: "announcements" as const,
      reasonCode: communityAiReasonCodes.announcementSource,
    }),
  );

  const boundAssetKey = community.community.boundAssetKey;
  if (boundAssetKey === null) {
    omitted.push(
      Object.freeze({
        kind: "assetFacts" as const,
        reasonCode: communityAiReasonCodes.assetNotBound,
      }),
    );
  } else if (readers.marketReadService === null) {
    omitted.push(
      Object.freeze({
        kind: "assetFacts" as const,
        reasonCode: communityAiReasonCodes.assetFactsUnavailable,
      }),
    );
  } else {
    try {
      const asset = await readers.marketReadService.getAsset({
        assetId: boundAssetKey,
        caller: {
          principal: input.principal,
          canonicalClientIp: input.canonicalClientIp,
        },
        signal: input.signal,
      });
      const facts: CommunityAiSourceFact[] = [];
      const symbol =
        "symbol" in asset.asset && typeof asset.asset.symbol === "string"
          ? asset.asset.symbol
          : null;
      facts.push(fact("资产标识", boundAssetKey));
      if (symbol !== null) {
        facts.push(fact("代币符号", symbol));
      }
      const rows: readonly [string, string | null, string | null][] = [
        ["价格（USD）", factValue(asset.price), asset.price.fetchedAt],
        [
          "24 小时涨跌幅",
          factValue(asset.priceChange24h),
          asset.priceChange24h.fetchedAt,
        ],
        ["市值（USD）", factValue(asset.marketCap), asset.marketCap.fetchedAt],
        [
          "流动性（USD）",
          factValue(asset.liquidityUsd),
          asset.liquidityUsd.fetchedAt,
        ],
        ["持有人数", factValue(asset.holderCount), asset.holderCount.fetchedAt],
      ];
      let newestObservation: string | null = null;
      for (const [label, value, fetchedAt] of rows) {
        if (value === null) {
          continue;
        }
        facts.push(
          fact(label, fetchedAt === null ? value : `${value}（${fetchedAt}）`),
        );
        if (
          fetchedAt !== null &&
          (newestObservation === null || fetchedAt > newestObservation)
        ) {
          newestObservation = fetchedAt;
        }
      }
      if (facts.length <= 2) {
        omitted.push(
          Object.freeze({
            kind: "assetFacts" as const,
            reasonCode: communityAiReasonCodes.assetFactsUnavailable,
          }),
        );
      } else {
        push({
          kind: "assetFacts",
          label: `绑定资产行情${symbol === null ? "" : `：${symbol}`}`,
          observedAt: newestObservation ?? nowIso,
          facts: Object.freeze(facts),
          untrustedLines: Object.freeze([]),
        });
      }
    } catch {
      omitted.push(
        Object.freeze({
          kind: "assetFacts" as const,
          reasonCode: communityAiReasonCodes.assetFactsUnavailable,
        }),
      );
    }
  }

  if (readers.miningService === null) {
    omitted.push(
      Object.freeze({
        kind: "communityMining" as const,
        reasonCode: communityAiReasonCodes.miningUnavailable,
      }),
    );
  } else {
    try {
      const mining = await readers.miningService.getCommunity({
        principal: input.principal,
        communityId: input.communityId,
      });
      const facts: CommunityAiSourceFact[] = [];
      if (mining.weight.status === "approved") {
        facts.push(fact("社区权重", mining.weight.value));
        facts.push(fact("权重版本", mining.weight.configVersion));
      }
      if (mining.communityPower.status === "available") {
        facts.push(fact("社区总算力", mining.communityPower.value));
      }
      if (mining.participants.status === "available") {
        facts.push(fact("参与挖矿人数", String(mining.participants.count)));
      }
      if (mining.myContribution.status === "available") {
        facts.push(fact("提问者的贡献算力", mining.myContribution.value));
      }
      const observedAt =
        "computedAt" in mining.snapshot ? mining.snapshot.computedAt : nowIso;
      if (facts.length === 0) {
        omitted.push(
          Object.freeze({
            kind: "communityMining" as const,
            reasonCode: communityAiReasonCodes.miningUnavailable,
          }),
        );
      } else {
        push({
          kind: "communityMining",
          label: "社区挖矿",
          observedAt,
          facts: Object.freeze(facts),
          untrustedLines: Object.freeze([]),
        });
      }
    } catch {
      omitted.push(
        Object.freeze({
          kind: "communityMining" as const,
          reasonCode: communityAiReasonCodes.miningUnavailable,
        }),
      );
    }
  }

  if (readers.voiceRoomService === null) {
    omitted.push(
      Object.freeze({
        kind: "voiceRoom" as const,
        reasonCode: communityAiReasonCodes.voiceUnavailable,
      }),
    );
  } else {
    try {
      const voice = await readers.voiceRoomService.getCurrentRoom({
        principal: input.principal,
        communityId: input.communityId,
        requestId: input.requestId,
        signal: input.signal,
      });
      const current = voice.current;
      push({
        kind: "voiceRoom",
        label: "语音房状态",
        observedAt: nowIso,
        facts: Object.freeze(
          current === null
            ? [fact("当前是否有语音房", "否")]
            : [
                fact("当前是否有语音房", "是"),
                fact("房间状态", current.room.state),
                fact("已加入人数", String(current.participants.joinedCount)),
                fact("发言人数", String(current.participants.speakerCount)),
                fact("开始时间", current.room.createdAt),
              ],
        ),
        untrustedLines: Object.freeze([]),
      });
    } catch {
      omitted.push(
        Object.freeze({
          kind: "voiceRoom" as const,
          reasonCode: communityAiReasonCodes.voiceUnavailable,
        }),
      );
    }
  }

  let chat: CommunityAiChatObservation | null = null;
  if (!isActiveMember(community)) {
    // A non-member never sees a community's messages, not even aggregated.
    omitted.push(
      Object.freeze({
        kind: "communityChat" as const,
        reasonCode: communityAiReasonCodes.notAMember,
      }),
    );
  } else if (
    readers.communicationRepository === null ||
    readers.channelGateway === null
  ) {
    omitted.push(
      Object.freeze({
        kind: "communityChat" as const,
        reasonCode: communityAiReasonCodes.chatNotConnected,
      }),
    );
  } else {
    try {
      const channel =
        await readers.communicationRepository.readCommunityChannel({
          communityId: input.communityId,
          viewerUserId: input.principal.userId,
        });
      const record = channel.channel;
      if (
        record === null ||
        !record.provisioned ||
        !channel.viewerIsCommunityMember
      ) {
        omitted.push(
          Object.freeze({
            kind: "communityChat" as const,
            reasonCode: communityAiReasonCodes.chatNotConnected,
          }),
        );
      } else {
        const since = new Date(
          input.now.getTime() - input.chatWindowHours * 3_600_000,
        );
        const messages =
          await readers.channelGateway.readCommunityChannelMessages({
            channelId: record.streamChannelId,
            since,
            limit: communityAiChatMessageLimit,
            signal: input.signal,
          });
        const authorIds = [
          ...new Set(
            messages.flatMap((message) =>
              message.authorUserId === null ? [] : [message.authorUserId],
            ),
          ),
        ];
        const personas = await readers.repository.readPersonaAliases({
          communityId: input.communityId,
          ownerUserIds: authorIds,
        });
        const lines = messages.map((message) => {
          const persona =
            message.authorUserId === null
              ? null
              : (personas.get(message.authorUserId) ?? null);
          return `${message.createdAt} ${persona ?? unknownAuthorLabel}: ${message.text}`;
        });
        const newest = messages.reduce<string | null>(
          (latest, message) =>
            latest === null || message.createdAt > latest
              ? message.createdAt
              : latest,
          null,
        );
        chat = Object.freeze({
          messageCount: messages.length,
          bounded: messages.length >= communityAiChatMessageLimit,
          windowHours: input.chatWindowHours,
          observedAt: newest ?? nowIso,
        });
        push({
          kind: "communityChat",
          label: `官方群最近 ${String(input.chatWindowHours)} 小时的讨论（最多 ${String(communityAiChatMessageLimit)} 条）`,
          observedAt: newest ?? nowIso,
          facts: Object.freeze([
            fact("观察到的消息数", String(messages.length)),
            fact(
              "是否为下限",
              messages.length >= communityAiChatMessageLimit ? "是" : "否",
            ),
          ]),
          untrustedLines: Object.freeze(lines),
        });
      }
    } catch {
      omitted.push(
        Object.freeze({
          kind: "communityChat" as const,
          reasonCode: communityAiReasonCodes.chatNotObserved,
        }),
      );
    }
  }

  return Object.freeze({
    community,
    sources: Object.freeze([...sources]),
    omitted: Object.freeze([...omitted]),
    chat,
  });
}
