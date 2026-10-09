import type {
  CommunityAiReportReason,
  CommunityAiSourceKind,
} from "./community-ai-contract.js";

/**
 * Community AI persistence boundary (Decision 0066).
 *
 * Three responsibilities, and nothing else: the durable quota ledger that is
 * reserved before a model call, the stored answers the report path needs, and
 * the community persona lookup that turns message authors into names. No
 * message text is ever written here.
 */

export interface CommunityAiStoredCitation {
  readonly sourceId: string;
  readonly kind: CommunityAiSourceKind;
  readonly label: string;
  readonly observedAt: string;
}

export interface CommunityAiAnswerRecord {
  readonly answerId: string;
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly question: string;
  readonly answer: string;
  readonly refusal: string | null;
  readonly citations: readonly CommunityAiStoredCitation[];
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly createdAt: string;
}

export interface CommunityAiReportRecord {
  readonly reportId: string;
  readonly answerId: string;
  readonly reason: CommunityAiReportReason;
  readonly note: string | null;
  readonly createdAt: string;
}

export type CommunityAiQuotaScope = "user" | "community";

export class CommunityAiRepositoryUnavailableError extends Error {
  readonly code = "community_ai_repository_unavailable";

  constructor() {
    super("The Community AI repository is unavailable");
    this.name = "CommunityAiRepositoryUnavailableError";
  }
}

export class CommunityAiIdempotencyConflictError extends Error {
  readonly code = "community_ai_idempotency_conflict";

  constructor() {
    super("The Community AI idempotency key is bound to another request");
    this.name = "CommunityAiIdempotencyConflictError";
  }
}

export class CommunityAiQuotaExceededError extends Error {
  readonly code = "community_ai_quota_exceeded";
  readonly scope: CommunityAiQuotaScope;

  constructor(scope: CommunityAiQuotaScope) {
    super("The Community AI quota is exhausted");
    this.name = "CommunityAiQuotaExceededError";
    this.scope = scope;
  }
}

export class CommunityAiAnswerNotFoundError extends Error {
  readonly code = "community_ai_answer_not_found";

  constructor() {
    super("No Community AI answer of this caller has that ID");
    this.name = "CommunityAiAnswerNotFoundError";
  }
}

export interface BeginCommunityAiAskInput {
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly userLimitPerMinute: number;
  readonly communityDailyLimit: number;
}

/**
 * Either the stored answer of an identical earlier request (no model call is
 * made) or a reservation: the idempotency record to attach the answer to and
 * the quota row that was already spent.
 */
export type BeginCommunityAiAskResult =
  | Readonly<{ kind: "replay"; answer: CommunityAiAnswerRecord }>
  | Readonly<{
      kind: "reserved";
      idempotencyRecordId: string;
      usageId: string;
    }>;

export interface CompleteCommunityAiAskInput {
  readonly idempotencyRecordId: string;
  readonly usageId: string;
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly requestSha256: string;
  readonly question: string;
  readonly answer: string;
  readonly refusal: string | null;
  readonly citations: readonly CommunityAiStoredCitation[];
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ReserveCommunityAiBriefInput {
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly userLimitPerMinute: number;
  readonly communityDailyLimit: number;
}

export interface SettleCommunityAiUsageInput {
  readonly usageId: string;
  readonly status: "completed" | "failed";
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ReportCommunityAiAnswerInput {
  readonly answerId: string;
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly reason: CommunityAiReportReason;
  readonly note: string | null;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface CommunityAiRepository {
  /**
   * Binds the idempotency key, replays a stored answer, or spends one unit of
   * both quotas under a per-community advisory lock. The reservation is made
   * before the Provider call so a burst cannot outrun the budget.
   */
  beginAsk(input: BeginCommunityAiAskInput): Promise<BeginCommunityAiAskResult>;
  /** Stores the answer and marks the reserved quota row `completed`. */
  completeAsk(
    input: CompleteCommunityAiAskInput,
  ): Promise<CommunityAiAnswerRecord>;
  reserveBrief(
    input: ReserveCommunityAiBriefInput,
  ): Promise<Readonly<{ usageId: string }>>;
  settleUsage(input: SettleCommunityAiUsageInput): Promise<void>;
  /**
   * One report per (answer, reporter); a repeat returns the stored row. An
   * answer belonging to another account is not found rather than forbidden,
   * so answer IDs cannot be enumerated.
   */
  reportAnswer(
    input: ReportCommunityAiAnswerInput,
  ): Promise<Readonly<{ created: boolean; report: CommunityAiReportRecord }>>;
  /**
   * The Decision 0055 personas of the given accounts in one community. An
   * account without a persona is simply absent from the map.
   */
  readPersonaAliases(input: {
    readonly communityId: string;
    readonly ownerUserIds: readonly string[];
  }): Promise<ReadonlyMap<string, string>>;
}

/** Composed when no PostgreSQL pool exists: every call fails closed. */
export function createUnavailableCommunityAiRepository(): CommunityAiRepository {
  return Object.freeze({
    beginAsk: () => Promise.reject(new CommunityAiRepositoryUnavailableError()),
    completeAsk: () =>
      Promise.reject(new CommunityAiRepositoryUnavailableError()),
    reserveBrief: () =>
      Promise.reject(new CommunityAiRepositoryUnavailableError()),
    settleUsage: () =>
      Promise.reject(new CommunityAiRepositoryUnavailableError()),
    reportAnswer: () =>
      Promise.reject(new CommunityAiRepositoryUnavailableError()),
    readPersonaAliases: () =>
      Promise.reject(new CommunityAiRepositoryUnavailableError()),
  } satisfies CommunityAiRepository);
}
