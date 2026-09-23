import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  CommunityAiProviderError,
  type CommunityAiGateway,
} from "../../integrations/ai/anthropic-adapter.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  askDigest,
  buildCommunityAiBriefContent,
  buildCommunityAiUserContent,
  communityAiBriefRetrySeconds,
  communityAiBriefWindowHours,
  communityAiDefaultTimeoutMs,
  communityAiCapabilityDefinitions,
  communityAiChatWindowDays,
  communityAiDisclaimer,
  communityAiExampleQuestions,
  communityAiReasonCodes,
  communityAiSystemRules,
  InvalidCommunityAiRequestError,
  parseAskBody,
  parseReportBody,
  reportDigest,
  type CommunityAiBriefReasonCode,
  type CommunityAiCapabilityId,
  type CommunityAiOmittedSource,
  type CommunityAiReportReason,
  type CommunityAiSource,
  type CommunityAiSourceKind,
} from "./community-ai-contract.js";
import {
  assembleCommunityAiKnowledge,
  isActiveMember,
  isCommunityAdmin,
  type CommunityAiKnowledge,
  type CommunityAiKnowledgeReaders,
} from "./community-ai-knowledge.js";
import {
  CommunityAiAnswerNotFoundError,
  CommunityAiIdempotencyConflictError,
  CommunityAiQuotaExceededError,
  CommunityAiRepositoryUnavailableError,
  type CommunityAiRepository,
  type CommunityAiStoredCitation,
} from "./community-ai-repository.js";

/**
 * Community AI read/ask/report service (Decision 0066).
 *
 * The rule the whole module turns on: an answer exists only when a real model
 * produced it from sources this request assembled. There is no fallback text,
 * no cached other answer, and no "general knowledge" mode. A Provider that
 * cannot answer is `CAPABILITY_UNAVAILABLE` with the reason.
 */

export interface CommunityAiCitationProjection {
  readonly sourceId: string;
  readonly kind: CommunityAiSourceKind;
  readonly label: string;
  readonly observedAt: string;
}

export interface CommunityAiSourceProjection {
  readonly sourceId: string;
  readonly kind: CommunityAiSourceKind;
  readonly label: string;
  readonly observedAt: string;
}

export interface CommunityAiAnswerResource {
  readonly answerId: string;
  readonly answer: string;
  /** The model's own refusal, when it declined; the answer is then empty. */
  readonly refusal: string | null;
  readonly citations: readonly CommunityAiCitationProjection[];
  readonly sources: readonly CommunityAiSourceProjection[];
  readonly omittedSources: readonly CommunityAiOmittedSource[];
  readonly model: string;
  readonly generatedAt: string;
  readonly disclaimer: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface CommunityAiCapabilityProjection {
  readonly capabilityId: CommunityAiCapabilityId;
  readonly title: string;
  readonly summary: string;
  readonly availability: "available" | "unavailable";
  readonly reasonCode: string | null;
  readonly adminOnly: boolean;
}

export type CommunityAiBriefProjection =
  | Readonly<{
      status: "available";
      messageCount: number;
      /** True when the count is a floor: a full page still inside the window. */
      bounded: boolean;
      windowHours: number;
      summary: string;
      model: string;
      generatedAt: string;
    }>
  | Readonly<{ status: "unavailable"; reasonCode: CommunityAiBriefReasonCode }>;

export interface CommunityAiOverviewResource {
  readonly capabilities: readonly CommunityAiCapabilityProjection[];
  readonly knowledge: {
    readonly sourceCount: number;
    readonly updatedAt: string | null;
    readonly sources: readonly CommunityAiSourceProjection[];
    readonly omittedSources: readonly CommunityAiOmittedSource[];
    /** LOOP has live sources, not a document corpus; the page must say so. */
    readonly documents: Readonly<{
      status: "unavailable";
      reasonCode: string;
    }>;
  };
  readonly exampleQuestions: readonly string[];
  readonly brief: CommunityAiBriefProjection;
  readonly disclaimer: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface CommunityAiReportResource {
  readonly answerId: string;
  readonly reportId: string;
  readonly reason: CommunityAiReportReason;
  readonly createdAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface CommunityAiReadInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly communityId: string;
  readonly canonicalClientIp: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface CommunityAiAskInput extends CommunityAiReadInput {
  readonly idempotencyKey: string;
  readonly body: unknown;
}

export interface CommunityAiReportInput extends CommunityAiReadInput {
  readonly answerId: string;
  readonly idempotencyKey: string;
  readonly body: unknown;
}

export interface CommunityAiService {
  ask(input: CommunityAiAskInput): Promise<CommunityAiAnswerResource>;
  getOverview(
    input: CommunityAiReadInput,
  ): Promise<CommunityAiOverviewResource>;
  report(input: CommunityAiReportInput): Promise<CommunityAiReportResource>;
}

export interface CommunityAiServiceLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface CommunityAiServiceOptions {
  readonly gateway: CommunityAiGateway;
  readonly repository: CommunityAiRepository;
  readonly readers: CommunityAiKnowledgeReaders;
  readonly userRateLimitPerMinute: number;
  readonly communityDailyLimit: number;
  readonly briefCacheSeconds: number;
  /**
   * Ceiling for one background brief generation. It is an own
   * `AbortSignal.timeout`, never the triggering request's signal: that
   * request has already answered by the time the model is called.
   */
  readonly briefTimeoutMs?: number | undefined;
  /** Absent means a failed background generation is not logged (tests). */
  readonly logger?: CommunityAiServiceLogger | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Test hook: called once the background generation started by a
   * `getOverview` has settled. Production never waits on it.
   */
  readonly onBriefSettled?: ((communityId: string) => void) | undefined;
}

interface CachedBrief {
  readonly kind: "available";
  readonly summary: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly messageCount: number;
  readonly bounded: boolean;
  readonly expiresAtMs: number;
}

/**
 * The last background generation failed. `reasonCode` is the Provider
 * classification or the quota refusal; `null` is an unexpected failure that
 * was logged and will be retried, so the client keeps seeing "pending".
 */
interface FailedBrief {
  readonly kind: "failed";
  readonly reasonCode: CommunityAiBriefReasonCode | null;
  readonly expiresAtMs: number;
}

type BriefCacheEntry = CachedBrief | FailedBrief;

function projectSource(source: CommunityAiSource): CommunityAiSourceProjection {
  return Object.freeze({
    sourceId: source.sourceId,
    kind: source.kind,
    label: source.label,
    observedAt: source.observedAt,
  });
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof InvalidCommunityAiRequestError) {
    throw V2ApiError.invalidRequest();
  }
  if (error instanceof CommunityAiIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof CommunityAiQuotaExceededError) {
    throw V2ApiError.fromCode("RATE_LIMITED", { scope: error.scope });
  }
  if (error instanceof CommunityAiAnswerNotFoundError) {
    throw V2ApiError.fromCode("NOT_FOUND");
  }
  if (error instanceof CommunityAiProviderError) {
    throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: error.reason,
    });
  }
  if (error instanceof CommunityAiRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

export function createCommunityAiService(
  options: CommunityAiServiceOptions,
): CommunityAiService {
  const now = options.now ?? ((): Date => new Date());
  const briefTimeoutMs = options.briefTimeoutMs ?? communityAiDefaultTimeoutMs;
  const briefCache = new Map<string, BriefCacheEntry>();
  /** One generation per community at a time; concurrent reads share it. */
  const briefInFlight = new Set<string>();

  /**
   * Citations are intersected with the sources this request assembled, so a
   * `sourceId` the model invented can never reach the client, and the label
   * and observation time always come from LOOP, not from the model.
   */
  function resolveCitations(
    drafts: readonly { readonly sourceId: string }[],
    sources: readonly CommunityAiSource[],
  ): readonly CommunityAiStoredCitation[] {
    const byId = new Map(sources.map((source) => [source.sourceId, source]));
    const seen = new Set<string>();
    const resolved: CommunityAiStoredCitation[] = [];
    for (const draft of drafts) {
      const source = byId.get(draft.sourceId);
      if (source === undefined || seen.has(draft.sourceId)) {
        continue;
      }
      seen.add(draft.sourceId);
      resolved.push(
        Object.freeze({
          sourceId: source.sourceId,
          kind: source.kind,
          label: source.label,
          observedAt: source.observedAt,
        }),
      );
    }
    return Object.freeze(resolved);
  }

  async function knowledgeFor(
    input: CommunityAiReadInput,
    chatWindowHours: number,
  ): Promise<CommunityAiKnowledge> {
    return assembleCommunityAiKnowledge(options.readers, {
      principal: input.principal,
      communityId: input.communityId,
      canonicalClientIp: input.canonicalClientIp,
      requestId: input.requestId,
      signal: input.signal,
      chatWindowHours,
      now: now(),
    });
  }

  const service: CommunityAiService = {
    async ask(input: CommunityAiAskInput) {
      try {
        const parsed = parseAskBody(input.body);
        const knowledge = await knowledgeFor(
          input,
          communityAiChatWindowDays * 24,
        );
        if (!isActiveMember(knowledge.community)) {
          throw V2ApiError.fromCode("PERMISSION_DENIED", {
            reasonCode: communityAiReasonCodes.notAMember,
          });
        }
        if (knowledge.sources.length === 0) {
          throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
            reasonCode: communityAiReasonCodes.noSources,
          });
        }
        const requestSha256 = askDigest({
          communityId: input.communityId,
          question: parsed.question,
        });
        const begun = await options.repository.beginAsk({
          communityId: input.communityId,
          ownerUserId: input.principal.userId,
          idempotencyKey: input.idempotencyKey,
          requestSha256,
          requestId: input.requestId,
          userLimitPerMinute: options.userRateLimitPerMinute,
          communityDailyLimit: options.communityDailyLimit,
        });
        if (begun.kind === "replay") {
          return Object.freeze({
            answerId: begun.answer.answerId,
            answer: begun.answer.answer,
            refusal: begun.answer.refusal,
            citations: begun.answer.citations,
            sources: Object.freeze(knowledge.sources.map(projectSource)),
            omittedSources: knowledge.omitted,
            model: begun.answer.model,
            generatedAt: begun.answer.createdAt,
            disclaimer: communityAiDisclaimer,
            contractVersion: v2ContractVersion,
          });
        }
        let completion;
        try {
          completion = await options.gateway.complete({
            system: communityAiSystemRules,
            userContent: buildCommunityAiUserContent({
              sources: knowledge.sources,
              question: parsed.question,
            }),
            signal: input.signal,
          });
        } catch (error) {
          await options.repository.settleUsage({
            usageId: begun.usageId,
            status: "failed",
            model: options.gateway.model,
            inputTokens: null,
            outputTokens: null,
          });
          throw error;
        }
        const stored = await options.repository.completeAsk({
          idempotencyRecordId: begun.idempotencyRecordId,
          usageId: begun.usageId,
          communityId: input.communityId,
          ownerUserId: input.principal.userId,
          requestSha256,
          question: parsed.question,
          answer: completion.answer,
          refusal: completion.refusal,
          citations: resolveCitations(completion.citations, knowledge.sources),
          model: completion.model,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
        });
        return Object.freeze({
          answerId: stored.answerId,
          answer: stored.answer,
          refusal: stored.refusal,
          citations: stored.citations,
          sources: Object.freeze(knowledge.sources.map(projectSource)),
          omittedSources: knowledge.omitted,
          model: stored.model,
          generatedAt: stored.createdAt,
          disclaimer: communityAiDisclaimer,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getOverview(input: CommunityAiReadInput) {
      try {
        const knowledge = await knowledgeFor(
          input,
          communityAiBriefWindowHours,
        );
        const admin = isCommunityAdmin(knowledge.community);
        const capabilities = communityAiCapabilityDefinitions
          .filter((definition) => !definition.adminOnly || admin)
          .map((definition) =>
            Object.freeze({
              capabilityId: definition.capabilityId,
              title: definition.title,
              summary: definition.summary,
              availability:
                definition.reasonCode === null
                  ? ("available" as const)
                  : ("unavailable" as const),
              reasonCode: definition.reasonCode,
              adminOnly: definition.adminOnly,
            }),
          );
        const updatedAt = knowledge.sources.reduce<string | null>(
          (latest, source) =>
            latest === null || source.observedAt > latest
              ? source.observedAt
              : latest,
          null,
        );
        const brief = readBrief(input, knowledge);
        return Object.freeze({
          capabilities: Object.freeze(capabilities),
          knowledge: Object.freeze({
            sourceCount: knowledge.sources.length,
            updatedAt,
            sources: Object.freeze(knowledge.sources.map(projectSource)),
            omittedSources: knowledge.omitted,
            documents: Object.freeze({
              status: "unavailable" as const,
              reasonCode: communityAiReasonCodes.knowledgeDocuments,
            }),
          }),
          exampleQuestions: communityAiExampleQuestions,
          brief,
          disclaimer: communityAiDisclaimer,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async report(input: CommunityAiReportInput) {
      try {
        const parsed = parseReportBody(input.body);
        const result = await options.repository.reportAnswer({
          answerId: input.answerId,
          communityId: input.communityId,
          ownerUserId: input.principal.userId,
          reason: parsed.reason,
          note: parsed.note,
          idempotencyKey: input.idempotencyKey,
          requestSha256: reportDigest({
            answerId: input.answerId,
            reason: parsed.reason,
            note: parsed.note,
          }),
          requestId: input.requestId,
        });
        return Object.freeze({
          answerId: result.report.answerId,
          reportId: result.report.reportId,
          reason: result.report.reason,
          createdAt: result.report.createdAt,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },
  };

  /**
   * The daily brief. It is a model call, so it is quota-counted like any other
   * and cached per community for the configured window: every member of a
   * community may read the same channel, so they may share one summary.
   *
   * The read never waits for the model (Decision 0066, amended 2026-09-23
   * (2)): knowledge assembly plus a summary takes longer than the 15 s HTTP
   * deadlines, so a cache miss answers `COMMUNITY_AI_BRIEF_PENDING` at once
   * and starts one background generation for the community. The request that
   * triggered it pays the quota, exactly as before.
   */
  function readBrief(
    input: CommunityAiReadInput,
    knowledge: CommunityAiKnowledge,
  ): CommunityAiBriefProjection {
    if (!isActiveMember(knowledge.community)) {
      return Object.freeze({
        status: "unavailable" as const,
        reasonCode: communityAiReasonCodes.notAMember,
      });
    }
    const chat = knowledge.chat;
    if (chat === null) {
      const omitted = knowledge.omitted.find(
        (entry) => entry.kind === "communityChat",
      )?.reasonCode;
      return Object.freeze({
        status: "unavailable" as const,
        reasonCode:
          omitted === communityAiReasonCodes.chatNotConnected
            ? communityAiReasonCodes.chatNotConnected
            : communityAiReasonCodes.chatNotObserved,
      });
    }
    const currentMs = now().getTime();
    const cached = briefCache.get(input.communityId);
    if (cached !== undefined && cached.expiresAtMs > currentMs) {
      if (cached.kind === "available") {
        return Object.freeze({
          status: "available" as const,
          messageCount: cached.messageCount,
          bounded: cached.bounded,
          windowHours: chat.windowHours,
          summary: cached.summary,
          model: cached.model,
          generatedAt: cached.generatedAt,
        });
      }
      return Object.freeze({
        status: "unavailable" as const,
        reasonCode: cached.reasonCode ?? communityAiReasonCodes.briefPending,
      });
    }
    if (!briefInFlight.has(input.communityId)) {
      briefInFlight.add(input.communityId);
      // Detached on purpose. The request has its answer; nothing awaits this,
      // and shutdown does not wait for it either.
      void generateBrief(input, knowledge, chat)
        .catch((error: unknown) => {
          recordBriefFailure(input.communityId, error, input.requestId);
        })
        .finally(() => {
          briefInFlight.delete(input.communityId);
          options.onBriefSettled?.(input.communityId);
        });
    }
    return Object.freeze({
      status: "unavailable" as const,
      reasonCode: communityAiReasonCodes.briefPending,
    });
  }

  /** The background half: reserve quota, call the model, settle, cache. */
  async function generateBrief(
    input: CommunityAiReadInput,
    knowledge: CommunityAiKnowledge,
    chat: NonNullable<CommunityAiKnowledge["chat"]>,
  ): Promise<void> {
    const reserved = await options.repository.reserveBrief({
      communityId: input.communityId,
      ownerUserId: input.principal.userId,
      requestId: input.requestId,
      userLimitPerMinute: options.userRateLimitPerMinute,
      communityDailyLimit: options.communityDailyLimit,
    });
    let completion;
    try {
      completion = await options.gateway.complete({
        system: communityAiSystemRules,
        userContent: buildCommunityAiBriefContent({
          sources: knowledge.sources,
          messageCount: chat.messageCount,
          bounded: chat.bounded,
        }),
        // `AbortSignal.timeout` uses an unref'd timer: it never keeps the
        // process alive on shutdown.
        signal: AbortSignal.timeout(briefTimeoutMs),
      });
    } catch (error) {
      await options.repository.settleUsage({
        usageId: reserved.usageId,
        status: "failed",
        model: options.gateway.model,
        inputTokens: null,
        outputTokens: null,
      });
      throw error;
    }
    await options.repository.settleUsage({
      usageId: reserved.usageId,
      status: "completed",
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    });
    const summary =
      completion.answer === "" ? (completion.refusal ?? "") : completion.answer;
    if (summary === "") {
      throw new CommunityAiProviderError("COMMUNITY_AI_PROVIDER_MALFORMED");
    }
    const generatedMs = now().getTime();
    briefCache.set(input.communityId, {
      kind: "available",
      summary,
      model: completion.model,
      generatedAt: new Date(generatedMs).toISOString(),
      messageCount: chat.messageCount,
      bounded: chat.bounded,
      expiresAtMs: generatedMs + options.briefCacheSeconds * 1_000,
    });
  }

  /**
   * A failed generation is published under its classification until the
   * retry window elapses; nothing is thrown, because no request is waiting.
   * The log line carries identifiers and the error class only: never the
   * Provider body, the transcript, or the summary.
   */
  function recordBriefFailure(
    communityId: string,
    error: unknown,
    requestId: string,
  ): void {
    let reasonCode: CommunityAiBriefReasonCode | null;
    if (error instanceof CommunityAiProviderError) {
      reasonCode = error.reason;
    } else if (error instanceof CommunityAiQuotaExceededError) {
      reasonCode = communityAiReasonCodes.quotaExhausted;
    } else {
      reasonCode = null;
    }
    briefCache.set(communityId, {
      kind: "failed",
      reasonCode,
      expiresAtMs: now().getTime() + communityAiBriefRetrySeconds * 1_000,
    });
    options.logger?.warn(
      {
        communityId,
        requestId,
        reasonCode,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "Community AI brief generation failed",
    );
  }

  return Object.freeze(service);
}

/** Composed without an API key: the module answers nothing at all. */
export function createUnavailableCommunityAiService(): CommunityAiService {
  const closed = (): Promise<never> =>
    Promise.reject(
      V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
        reasonCode: communityAiReasonCodes.runtimeDeferred,
      }),
    );
  return Object.freeze({
    ask: closed,
    getOverview: closed,
    report: closed,
  });
}
