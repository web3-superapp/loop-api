import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { mediaAbsoluteUrl } from "../media/media-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import { launch2ReasonCodes } from "./launch2-contract.js";

/**
 * Decision 0140: operator campaign cards of the launch desk.
 *
 * The console (console.write, audited) writes `launch2_campaigns`; the App
 * reads `GET /v2/launch2/campaigns` — published, not ended, starting within
 * seven days, at most ten, pinned first then `sortOrder` then `startsAt`.
 * Nothing here reads the chain.
 */

export const launch2CampaignStatuses = Object.freeze([
  "draft",
  "published",
  "archived",
] as const);
export type Launch2CampaignStatus = (typeof launch2CampaignStatuses)[number];

export const launch2CampaignLinkKinds = Object.freeze([
  "route",
  "url",
] as const);
export type Launch2CampaignLinkKind = (typeof launch2CampaignLinkKinds)[number];

export const launch2CampaignStates = Object.freeze([
  "live",
  "upcoming",
] as const);
export type Launch2CampaignState = (typeof launch2CampaignStates)[number];

export const launch2CampaignLimits = Object.freeze({
  titleMax: 24,
  subtitleMax: 60,
  ctaLabelMax: 8,
  linkMax: 1024,
  /** `sortOrder` is a 32-bit signed integer column. */
  sortOrderMin: -2_147_483_648,
  sortOrderMax: 2_147_483_647,
  /** Public read: campaigns starting within this horizon are shown. */
  upcomingHorizonMs: 7 * 24 * 60 * 60 * 1000,
  publicMax: 10,
  adminListMax: 200,
});

export const launch2CampaignDefaultCtaLabel = "查看";

/** `detailsSafe.reasonCode` values of the console campaign routes. */
export const launch2CampaignReasonCodes = Object.freeze({
  titleInvalid: "CAMPAIGN_TITLE_INVALID",
  windowInvalid: "CAMPAIGN_WINDOW_INVALID",
  linkInvalid: "CAMPAIGN_LINK_INVALID",
  coverInvalid: "CAMPAIGN_COVER_INVALID",
  statusConflict: "CAMPAIGN_STATUS_CONFLICT",
  notFound: "CAMPAIGN_NOT_FOUND",
  repositoryUnavailable: "CAMPAIGN_REPOSITORY_UNAVAILABLE",
  idempotencyConflict: "ADMIN_IDEMPOTENCY_CONFLICT",
} as const);

export interface Launch2CampaignLink {
  readonly kind: Launch2CampaignLinkKind;
  readonly value: string;
}

/** The editable fields of a campaign (what create / update write). */
export interface Launch2CampaignFields {
  readonly title: string;
  readonly subtitle: string | null;
  readonly coverMediaId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly ctaLabel: string;
  readonly link: Launch2CampaignLink;
  readonly pinned: boolean;
  readonly sortOrder: number;
}

export interface Launch2CampaignRecord extends Launch2CampaignFields {
  readonly campaignId: string;
  readonly status: Launch2CampaignStatus;
  /** The acting `admin_accounts.id`; null for the bootstrap administrator. */
  readonly createdBy: string | null;
  readonly createdByActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Launch2CampaignAuditRef {
  readonly auditId: string;
  readonly seq: number;
  readonly at: string;
}

export interface Launch2CampaignAuditInput {
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly requestId: string;
}

export type Launch2CampaignAction = "update" | "publish" | "archive";

/** What a transition decides about the locked current row. */
export type Launch2CampaignDecision =
  | { readonly kind: "refuse"; readonly reasonCode: string }
  | {
      readonly kind: "write";
      readonly fields: Launch2CampaignFields;
      readonly status: Launch2CampaignStatus;
    };

export type Launch2CampaignTransitionResult =
  | { readonly status: "not_found" }
  | {
      readonly status: "refused";
      readonly reasonCode: string;
      readonly campaign: Launch2CampaignRecord;
    }
  | {
      readonly status: "written";
      readonly campaign: Launch2CampaignRecord;
      readonly audit: Launch2CampaignAuditRef;
    };

export interface Launch2CampaignIdempotency {
  readonly key: string;
  /** SHA-256 (hex) of the normalized request. */
  readonly requestSha256: string;
}

export interface Launch2CampaignCoverInput {
  readonly mediaId: string;
  readonly idempotencyKey: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly requestSha256: string;
}

/**
 * Persistence port (PostgreSQL: `src/database/launch2-campaign-repository.ts`).
 * Every write and its `admin_audit_log` row share one transaction.
 */
export interface Launch2CampaignRepository {
  /**
   * Published rows with `ends_at > now` and `starts_at <= horizon`, in the
   * public order, at most `limit`.
   */
  listPublic(input: {
    readonly now: Date;
    readonly horizon: Date;
    readonly limit: number;
  }): Promise<readonly Launch2CampaignRecord[]>;
  /** Every row (or one status), newest first, at most `limit`. */
  listAll(input: {
    readonly status: Launch2CampaignStatus | null;
    readonly limit: number;
  }): Promise<readonly Launch2CampaignRecord[]>;
  get(campaignId: string): Promise<Launch2CampaignRecord | null>;
  /**
   * Inserts a draft. With `idempotency`, a second create under the same key
   * replays the first (same `requestSha256`, its create audit row) or
   * conflicts (another body); nothing new is written either way.
   */
  create(input: {
    readonly campaignId: string;
    readonly fields: Launch2CampaignFields;
    readonly now: Date;
    readonly audit: Launch2CampaignAuditInput;
    readonly idempotency: Launch2CampaignIdempotency | null;
  }): Promise<
    | {
        readonly status: "created" | "replayed";
        readonly campaign: Launch2CampaignRecord;
        readonly audit: Launch2CampaignAuditRef;
      }
    | { readonly status: "conflict" }
  >;
  /**
   * Locks the row, asks `decide`, and (on `write`) updates it and writes
   * the `launch2.campaign.<action>` audit row in the same transaction.
   */
  transition(input: {
    readonly campaignId: string;
    readonly action: Launch2CampaignAction;
    readonly now: Date;
    readonly audit: Launch2CampaignAuditInput;
    readonly decide: (
      current: Launch2CampaignRecord,
    ) => Launch2CampaignDecision;
  }): Promise<Launch2CampaignTransitionResult>;
  /** True when `mediaId` is a stored `campaign_cover`. */
  coverExists(mediaId: string): Promise<boolean>;
  /**
   * Stores one processed cover (`media_objects`, kind campaign_cover). The
   * key is the object's idempotency key: an earlier cover under it with the
   * same upload bytes is replayed (its mediaId), other bytes conflict.
   */
  insertCover(
    input: Launch2CampaignCoverInput,
  ): Promise<
    | { readonly status: "stored" | "replayed"; readonly mediaId: string }
    | { readonly status: "conflict" }
  >;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isLaunch2CampaignId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function isLaunch2CampaignStatus(
  value: unknown,
): value is Launch2CampaignStatus {
  return (
    typeof value === "string" &&
    (launch2CampaignStatuses as readonly string[]).includes(value)
  );
}

/** The public order: pinned first, then sortOrder, startsAt, campaignId. */
export function compareLaunch2Campaigns(
  a: Launch2CampaignRecord,
  b: Launch2CampaignRecord,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const start = Date.parse(a.startsAt) - Date.parse(b.startsAt);
  if (start !== 0) return start;
  return a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0;
}

/**
 * The public selection, applied again to what the repository read (the SQL
 * does the same filter; this keeps the rule in one testable place).
 */
export function selectPublicLaunch2Campaigns(
  records: readonly Launch2CampaignRecord[],
  now: Date,
): readonly Launch2CampaignRecord[] {
  const nowMs = now.getTime();
  const horizon = nowMs + launch2CampaignLimits.upcomingHorizonMs;
  return records
    .filter(
      (record) =>
        record.status === "published" &&
        Date.parse(record.endsAt) > nowMs &&
        Date.parse(record.startsAt) <= horizon,
    )
    .sort(compareLaunch2Campaigns)
    .slice(0, launch2CampaignLimits.publicMax);
}

export function launch2CampaignStateOf(
  record: Pick<Launch2CampaignRecord, "startsAt">,
  now: Date,
): Launch2CampaignState {
  return Date.parse(record.startsAt) <= now.getTime() ? "live" : "upcoming";
}

export function launch2CampaignCoverUrl(
  publicBaseUrl: string,
  coverMediaId: string | null,
): string | null {
  return coverMediaId === null
    ? null
    : mediaAbsoluteUrl(publicBaseUrl, coverMediaId);
}

export function projectPublicLaunch2Campaigns(input: {
  readonly records: readonly Launch2CampaignRecord[];
  readonly now: Date;
  readonly publicBaseUrl: string;
}): Record<string, unknown> {
  return Object.freeze({
    items: selectPublicLaunch2Campaigns(input.records, input.now).map(
      (record) =>
        Object.freeze({
          campaignId: record.campaignId,
          title: record.title,
          subtitle: record.subtitle,
          coverUrl: launch2CampaignCoverUrl(
            input.publicBaseUrl,
            record.coverMediaId,
          ),
          startsAt: record.startsAt,
          endsAt: record.endsAt,
          ctaLabel: record.ctaLabel,
          link: Object.freeze({ ...record.link }),
          pinned: record.pinned,
          sortOrder: record.sortOrder,
          state: launch2CampaignStateOf(record, input.now),
        }),
    ),
    observedAt: input.now.toISOString(),
    contractVersion: v2ContractVersion,
  });
}

export interface Launch2CampaignPublicService {
  listCampaigns(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<Record<string, unknown>>;
}

/**
 * Decision 0140: `GET /v2/launch2/campaigns`. Without the repository (or
 * when it fails): 503 CAPABILITY_UNAVAILABLE / LAUNCH2_REPOSITORY_UNAVAILABLE,
 * never an empty list.
 */
export function createLaunch2CampaignPublicService(input: {
  readonly repository: Launch2CampaignRepository | null;
  readonly publicBaseUrl: string;
  readonly now?: () => Date;
}): Launch2CampaignPublicService {
  const now = input.now ?? ((): Date => new Date());
  const unavailable = (): V2ApiError =>
    V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: launch2ReasonCodes.repositoryUnavailable,
    });
  return Object.freeze({
    async listCampaigns(): Promise<Record<string, unknown>> {
      if (input.repository === null) throw unavailable();
      const at = now();
      let records: readonly Launch2CampaignRecord[];
      try {
        records = await input.repository.listPublic({
          now: at,
          horizon: new Date(
            at.getTime() + launch2CampaignLimits.upcomingHorizonMs,
          ),
          limit: launch2CampaignLimits.publicMax,
        });
      } catch {
        throw unavailable();
      }
      return projectPublicLaunch2Campaigns({
        records,
        now: at,
        publicBaseUrl: input.publicBaseUrl,
      });
    },
  });
}
