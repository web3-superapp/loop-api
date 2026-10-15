import {
  formatLaunch2Amount,
  launch2Template,
} from "../launch2/launch2-contract.js";
import { mediaAbsoluteUrl } from "../media/media-contract.js";
import {
  formatE18,
  memeE18,
  memeMarketCapRaw,
  memePriceE18,
  memeT0,
  memeV0,
} from "../meme/meme-curve-math.js";
import { percentChange } from "../meme/meme-projection.js";

/**
 * Decision 0143 (S187-api-b): the square「动态」timeline.
 *
 * `square_posts` holds four sources in one timeline: user opinions
 * (`opinion`, written by the App, published at once), console posts
 * (`system`, draft → published → archived, may be pinned), and three
 * system-event kinds the `square_feed_ingest` lane derives from existing
 * read models (`buy` = a public member buy ≥ 10 USD1, `claim` = a confirmed
 * LoopDynamic reward claim, `graduation` = a MEME v1 or launch2 graduation).
 * Event posts carry facts (`event`), never rendered text: the App renders
 * each kind.
 */

export const squarePostKinds = Object.freeze([
  "opinion",
  "buy",
  "claim",
  "graduation",
  "system",
] as const);
export type SquarePostKind = (typeof squarePostKinds)[number];

export const squareEventKinds = Object.freeze([
  "buy",
  "claim",
  "graduation",
] as const);
export type SquareEventKind = (typeof squareEventKinds)[number];

export const squarePostStatuses = Object.freeze([
  "draft",
  "published",
  "archived",
] as const);
export type SquarePostStatus = (typeof squarePostStatuses)[number];

export const squareTokenKinds = Object.freeze(["meme", "launch2"] as const);
export type SquareTokenKind = (typeof squareTokenKinds)[number];

export const squareFeedScopes = Object.freeze(["global", "following"] as const);
export type SquareFeedScope = (typeof squareFeedScopes)[number];

export const squareLimits = Object.freeze({
  textMax: 500,
  feedDefault: 20,
  feedMax: 30,
  /** Pinned posts shown on the first page of either scope. */
  pinnedMax: 3,
  /** Opinion posts per author per rolling minute. */
  postsPerMinute: 5,
  rateWindowMs: 60_000,
  adminListMax: 200,
  /** Ingest: a member buy enters the timeline from this USD amount. */
  buyMinimumUsd1: 10n,
  /** Ingest: events older than this are never written. */
  ingestLookbackMs: 7 * 24 * 60 * 60 * 1000,
  /** Ingest: rows written per source per pass. */
  ingestBatch: 200,
  ingestIntervalMs: 60_000,
});

/** `detailsSafe.reasonCode` values of the square routes. */
export const squareReasonCodes = Object.freeze({
  textEmpty: "SQUARE_POST_TEXT_EMPTY",
  textTooLong: "SQUARE_POST_TEXT_TOO_LONG",
  textInvalid: "SQUARE_POST_TEXT_INVALID",
  tokenRefInvalid: "SQUARE_TOKEN_REF_INVALID",
  rateLimited: "SQUARE_POST_RATE_LIMITED",
  statusConflict: "SQUARE_POST_STATUS_CONFLICT",
  kindConflict: "SQUARE_POST_KIND_CONFLICT",
  notFound: "SQUARE_POST_NOT_FOUND",
  repositoryUnavailable: "SQUARE_REPOSITORY_UNAVAILABLE",
  idempotencyConflict: "ADMIN_IDEMPOTENCY_CONFLICT",
} as const);

export interface SquareTokenRef {
  readonly kind: SquareTokenKind;
  readonly id: string;
}

/** What the read model knows about a referenced token (raw values). */
export type SquareTokenFacts =
  | {
      readonly kind: "meme";
      readonly id: string;
      readonly symbol: string;
      readonly imageMediaId: string | null;
      readonly status: string;
      readonly vUsd1: string;
      readonly vToken: string;
      /** Newest curve trade price at or before now − 1 h; null = none. */
      readonly price1hAgoE18: string | null;
    }
  | {
      readonly kind: "launch2";
      readonly id: string;
      readonly symbol: string;
      readonly logoUrl: string | null;
      readonly graduated: boolean;
      readonly curvePriceE18: string;
      readonly poolLastPriceE18: string | null;
      /** Newest pool swap price at or before now − 1 h; null = none. */
      readonly poolPrice1hAgoE18: string | null;
    };

export interface SquareAuthor {
  readonly publicProfileId: string;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
}

/** Facts of an event post (decimal strings), keyed by kind. */
export type SquareEventFacts = Readonly<Record<string, string | null>>;

export interface SquarePostRecord {
  readonly postId: string;
  readonly kind: SquarePostKind;
  readonly status: SquarePostStatus;
  readonly text: string | null;
  readonly tokenRef: SquareTokenRef | null;
  readonly event: SquareEventFacts | null;
  readonly sourceEventId: string | null;
  readonly pinned: boolean;
  /** Null for `system` posts. */
  readonly author: SquareAuthor | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SquareFeedRecord extends SquarePostRecord {
  readonly likeCount: number;
  readonly likedByViewer: boolean;
  readonly token: SquareTokenFacts | null;
}

export interface SquareFeedCursor {
  readonly publishedAt: string;
  readonly postId: string;
}

export interface SquareCreateIdempotency {
  readonly key: string;
  readonly requestSha256: string;
}

export interface SquareAuditInput {
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly requestId: string;
}

export interface SquareAuditRef {
  readonly auditId: string;
  readonly seq: number;
  readonly at: string;
}

/** Editable fields of a console (`system`) post. */
export interface SquareSystemFields {
  readonly text: string;
  readonly tokenRef: SquareTokenRef | null;
  readonly pinned: boolean;
}

export type SquareAdminAction = "update" | "publish" | "archive";

export type SquareAdminDecision =
  | { readonly kind: "refuse"; readonly reasonCode: string }
  | {
      readonly kind: "write";
      readonly fields: SquareSystemFields | null;
      readonly status: SquarePostStatus;
    };

/** One system event the ingest lane turns into a post. */
export interface SquareEventCandidate {
  readonly kind: SquareEventKind;
  readonly sourceEventId: string;
  readonly authorUserId: string;
  readonly occurredAt: string;
  readonly tokenRef: SquareTokenRef | null;
  readonly event: SquareEventFacts;
}

/** Raw member buy the lane reads (amounts are integer strings). */
export interface SquareBuyRow {
  readonly sourceEventId: string;
  readonly authorUserId: string;
  readonly occurredAt: string;
  readonly tokenRef: SquareTokenRef | null;
  readonly quoteAmountRaw: string;
  readonly quoteDecimals: number;
  readonly baseAmountRaw: string;
  readonly baseDecimals: number;
  readonly transactionHash: string;
}

/**
 * Persistence port (PostgreSQL: `src/database/square-repository.ts`).
 * `viewerUserId` is the authenticated LOOP user; it never leaves this port.
 */
export interface SquareRepository {
  listPinned(input: {
    readonly viewerUserId: string;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly SquareFeedRecord[]>;
  /** Published, unpinned posts, newest first, strictly before `before`. */
  listTimeline(input: {
    readonly viewerUserId: string;
    readonly scope: SquareFeedScope;
    readonly before: SquareFeedCursor | null;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly SquareFeedRecord[]>;
  getFeedPost(input: {
    readonly viewerUserId: string;
    readonly postId: string;
    readonly now: Date;
  }): Promise<SquareFeedRecord | null>;
  /** True when the reference names a token the read model knows. */
  tokenRefExists(ref: SquareTokenRef): Promise<boolean>;
  /**
   * Writes an opinion (published at once) after locking the author. A key
   * seen before replays (same digest) or conflicts; more than
   * `postsPerMinute` opinions in the window refuses `rate_limited`.
   */
  createOpinion(input: {
    readonly postId: string;
    readonly authorUserId: string;
    readonly text: string;
    readonly tokenRef: SquareTokenRef | null;
    readonly idempotency: SquareCreateIdempotency;
    readonly now: Date;
    readonly postsPerMinute: number;
    readonly windowMs: number;
  }): Promise<
    | { readonly status: "created" | "replayed"; readonly postId: string }
    | { readonly status: "conflict" | "rate_limited" | "profile_required" }
  >;
  /** Archives the author's own opinion; false = not theirs / unknown. */
  archiveOwnPost(input: {
    readonly postId: string;
    readonly authorUserId: string;
    readonly now: Date;
  }): Promise<boolean>;
  /** Sets (true) or clears (false) the like; null = no published post. */
  setLike(input: {
    readonly postId: string;
    readonly userId: string;
    readonly liked: boolean;
  }): Promise<{ readonly likeCount: number } | null>;

  // Console (Decision 0140 discipline: one transaction with the audit row).
  adminList(input: {
    readonly status: SquarePostStatus | null;
    readonly kind: SquarePostKind | null;
    readonly limit: number;
  }): Promise<readonly (SquarePostRecord & { readonly likeCount: number })[]>;
  adminGet(
    postId: string,
  ): Promise<(SquarePostRecord & { readonly likeCount: number }) | null>;
  adminCreate(input: {
    readonly postId: string;
    readonly fields: SquareSystemFields;
    readonly now: Date;
    readonly audit: SquareAuditInput;
    readonly idempotency: SquareCreateIdempotency | null;
  }): Promise<
    | {
        readonly status: "created" | "replayed";
        readonly postId: string;
        readonly audit: SquareAuditRef;
      }
    | { readonly status: "conflict" }
  >;
  adminTransition(input: {
    readonly postId: string;
    readonly action: SquareAdminAction;
    readonly now: Date;
    readonly audit: SquareAuditInput;
    readonly decide: (current: SquarePostRecord) => SquareAdminDecision;
  }): Promise<
    | { readonly status: "not_found" }
    | {
        readonly status: "refused";
        readonly reasonCode: string;
        readonly current: SquarePostRecord;
      }
    | { readonly status: "written"; readonly audit: SquareAuditRef }
  >;

  // Ingest lane.
  listBuyCandidates(input: {
    readonly since: Date;
    /** Lower-case stable quote addresses (USD1 / USDT / USDC). */
    readonly stableAddresses: readonly string[];
    readonly limit: number;
  }): Promise<readonly SquareBuyRow[]>;
  listClaimCandidates(input: {
    readonly since: Date;
    readonly limit: number;
  }): Promise<readonly SquareEventCandidate[]>;
  listGraduationCandidates(input: {
    readonly since: Date;
    readonly limit: number;
  }): Promise<readonly SquareEventCandidate[]>;
  /** Inserts published event posts; an existing `sourceEventId` is skipped. */
  insertEventPosts(input: {
    readonly posts: readonly (SquareEventCandidate & {
      readonly postId: string;
    })[];
  }): Promise<number>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isSquareUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function isSquarePostStatus(value: unknown): value is SquarePostStatus {
  return (
    typeof value === "string" &&
    (squarePostStatuses as readonly string[]).includes(value)
  );
}

export function isSquarePostKind(value: unknown): value is SquarePostKind {
  return (
    typeof value === "string" &&
    (squarePostKinds as readonly string[]).includes(value)
  );
}

/**
 * Control (other than line feed), surrogate, line / paragraph separator,
 * and bidi override / isolate characters are refused. Other format
 * characters stay (emoji ZWJ sequences need U+200D).
 */
const forbiddenPostCharacters =
  /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;

export type SquareTextCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reasonCode: string };

/** Trim, then 1..500 code points of allowed characters (CRLF → LF). */
export function checkSquarePostText(raw: unknown): SquareTextCheck {
  if (typeof raw !== "string") {
    return { ok: false, reasonCode: squareReasonCodes.textEmpty };
  }
  const text = raw.replace(/\r\n?/gu, "\n").trim();
  if (text.length === 0) {
    return { ok: false, reasonCode: squareReasonCodes.textEmpty };
  }
  if (Array.from(text).length > squareLimits.textMax) {
    return { ok: false, reasonCode: squareReasonCodes.textTooLong };
  }
  // Line feeds are the one control character a post may hold.
  if (forbiddenPostCharacters.test(text.replaceAll("\n", ""))) {
    return { ok: false, reasonCode: squareReasonCodes.textInvalid };
  }
  return { ok: true, text };
}

/** `{kind, id}` with a known kind and a canonical UUID, else null. */
export function parseSquareTokenRef(raw: unknown): SquareTokenRef | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const kind = record["kind"];
  const id = record["id"];
  if (
    (kind !== "meme" && kind !== "launch2") ||
    !isSquareUuid(id) ||
    Object.keys(record).some((key) => key !== "kind" && key !== "id")
  ) {
    return null;
  }
  return Object.freeze({ kind, id });
}

/** Feed order: newest `publishedAt` first, then `postId` descending. */
export function compareSquareFeed(
  a: Pick<SquarePostRecord, "publishedAt" | "postId">,
  b: Pick<SquarePostRecord, "publishedAt" | "postId">,
): number {
  const left = Date.parse(a.publishedAt ?? "");
  const right = Date.parse(b.publishedAt ?? "");
  if (left !== right) return right - left;
  return a.postId < b.postId ? 1 : a.postId > b.postId ? -1 : 0;
}

/**
 * The first page: up to `pinnedMax` pinned posts (newest first), then the
 * timeline. Later pages never repeat pinned posts (the timeline excludes
 * them), so a cursor page is the timeline alone.
 */
export function mergeSquareFirstPage<T extends SquarePostRecord>(
  pinned: readonly T[],
  timeline: readonly T[],
): readonly T[] {
  const top = [...pinned]
    .filter((post) => post.pinned && post.status === "published")
    .sort(compareSquareFeed)
    .slice(0, squareLimits.pinnedMax);
  const ids = new Set(top.map((post) => post.postId));
  return [...top, ...timeline.filter((post) => !ids.has(post.postId))];
}

/** Decimal string of `raw / 10^decimals` (no trailing zeros). */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  const text =
    fraction === 0n || decimals === 0
      ? whole.toString(10)
      : `${whole.toString(10)}.${fraction
          .toString(10)
          .padStart(decimals, "0")
          .replace(/0+$/u, "")}`;
  return negative ? `-${text}` : text;
}

/**
 * Member buy rows that enter the timeline: the stable quote side paid is
 * at least `buyMinimumUsd1` (stables at par). Pool amounts are signed;
 * the absolute value is used.
 */
export function squareBuyCandidates(
  rows: readonly SquareBuyRow[],
): readonly SquareEventCandidate[] {
  const out: SquareEventCandidate[] = [];
  for (const row of rows) {
    const quote = BigInt(row.quoteAmountRaw);
    const paid = quote < 0n ? -quote : quote;
    const base = BigInt(row.baseAmountRaw);
    if (paid < squareLimits.buyMinimumUsd1 * 10n ** BigInt(row.quoteDecimals)) {
      continue;
    }
    out.push(
      Object.freeze({
        kind: "buy",
        sourceEventId: row.sourceEventId,
        authorUserId: row.authorUserId,
        occurredAt: row.occurredAt,
        tokenRef: row.tokenRef,
        event: Object.freeze({
          amountUsd1: formatUnits(paid, row.quoteDecimals),
          tokenAmount: formatUnits(base < 0n ? -base : base, row.baseDecimals),
          transactionHash: row.transactionHash,
        }),
      }),
    );
  }
  return out;
}

export interface SquareTokenQuote {
  readonly kind: SquareTokenKind;
  readonly memeTokenId: string | null;
  readonly instanceId: string | null;
  readonly symbol: string;
  readonly logoUrl: string | null;
  readonly priceUsd1: string | null;
  readonly change1hPct: string | null;
  readonly marketCapUsd1: string | null;
}

const memeInitialPriceE18 = (memeV0 * memeE18) / memeT0;
const memeCurveStatuses = new Set(["trading", "full", "paused"]);

/**
 * The quote line of a post, from the database read models only (no
 * provider call per feed read): a MEME v1 curve token's curve price, 1 h
 * change and cap (as `GET /v2/meme/tokens`); a graduated MEME v1 token has
 * no stored price (null). A launch2 instance: the curve price before
 * graduation, the newest official-pool price after it (1 h change against
 * the pool price an hour ago); cap = price × 1e9.
 */
export function projectSquareToken(
  facts: SquareTokenFacts,
  publicBaseUrl: string,
): SquareTokenQuote {
  if (facts.kind === "meme") {
    let price: string | null = null;
    let change: string | null = null;
    let cap: string | null = null;
    if (memeCurveStatuses.has(facts.status)) {
      const curve = {
        vUsd1: BigInt(facts.vUsd1),
        vToken: BigInt(facts.vToken),
      };
      if (curve.vToken > 0n) {
        const now = memePriceE18(curve);
        price = formatE18(now);
        cap = formatE18(memeMarketCapRaw(curve));
        change = percentChange(
          now,
          facts.price1hAgoE18 === null
            ? memeInitialPriceE18
            : BigInt(facts.price1hAgoE18),
        );
      }
    }
    return Object.freeze({
      kind: "meme",
      memeTokenId: facts.id,
      instanceId: null,
      symbol: facts.symbol,
      logoUrl:
        facts.imageMediaId === null
          ? null
          : mediaAbsoluteUrl(publicBaseUrl, facts.imageMediaId),
      priceUsd1: price,
      change1hPct: change,
      marketCapUsd1: cap,
    });
  }
  let priceE18: bigint | null = null;
  let change: string | null = null;
  if (facts.graduated) {
    if (facts.poolLastPriceE18 !== null) {
      priceE18 = BigInt(facts.poolLastPriceE18);
      change =
        facts.poolPrice1hAgoE18 === null
          ? null
          : percentChange(priceE18, BigInt(facts.poolPrice1hAgoE18));
    }
  } else if (BigInt(facts.curvePriceE18) > 0n) {
    priceE18 = BigInt(facts.curvePriceE18);
  }
  if (priceE18 !== null && priceE18 <= 0n) priceE18 = null;
  return Object.freeze({
    kind: "launch2",
    memeTokenId: null,
    instanceId: facts.id,
    symbol: facts.symbol,
    logoUrl: facts.logoUrl,
    priceUsd1: priceE18 === null ? null : formatLaunch2Amount(priceE18),
    change1hPct: priceE18 === null ? null : change,
    marketCapUsd1:
      priceE18 === null
        ? null
        : formatLaunch2Amount(
            (priceE18 * launch2Template.memeTotalSupply) / memeE18,
          ),
  });
}
