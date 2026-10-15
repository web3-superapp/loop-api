import type { LaunchChainId } from "../chain/chain-contract.js";
import type { CanaryExposureAdmission } from "../wallet-intents/intent-contract.js";
import type {
  MemeIntentKind,
  MemeIntentState,
  MemeLinkKey,
  MemeTokenStatus,
} from "./meme-contract.js";

/**
 * Persistence port of the MEME launchpad (Decision 0101). Amounts are raw
 * base-unit decimal strings; addresses, hashes, and salts lowercase 0x hex;
 * timestamps ISO 8601. `src/database/meme-repository.ts` implements it.
 */

export const memeEventLane = "meme_event" as const;
export const memeCreateIdempotencyScope = "v2_meme_token_create" as const;
export const memeCreateDigestVersion = "meme_token_create_v1" as const;
export const memeIntentIdempotencyScope = "v2_meme_intent" as const;
export const memeIntentDigestVersion = "meme_intent_v1" as const;

export interface MemeCreatorProjection {
  readonly publicProfileId: string | null;
  readonly displayName: string | null;
  readonly avatarRef: string | null;
}

export interface MemeTokenRecord {
  readonly memeTokenId: string;
  readonly chainId: LaunchChainId;
  readonly contractAddress: string;
  readonly contractVersion: string;
  readonly creatorUserId: string;
  readonly creatorWallet: string | null;
  readonly creator: MemeCreatorProjection;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly imageMediaId: string | null;
  readonly links: Readonly<Record<MemeLinkKey, string | null>>;
  readonly metadataHash: string;
  readonly salt: string | null;
  readonly predictedAddress: string | null;
  readonly vanity: boolean;
  readonly tokenAddress: string | null;
  readonly assetId: string | null;
  readonly status: MemeTokenStatus;
  readonly createdBlock: string | null;
  readonly createdTxHash: string | null;
  readonly chainCreatedAt: string | null;
  readonly vUsd1: string;
  readonly vToken: string;
  readonly realUsd1: string;
  readonly sold: string;
  readonly holderCount: number;
  readonly tradeCount: number;
  readonly lastTradeAt: string | null;
  readonly fullAt: string | null;
  readonly graduatedAt: string | null;
  readonly poolAddress: string | null;
  readonly graduationTxHash: string | null;
  readonly lpTokenId: string | null;
  readonly usd1ToPool: string | null;
  readonly tokensToPool: string | null;
  readonly graduationFeeUsd1: string | null;
  readonly residualUsd1: string | null;
  readonly residualTokens: string | null;
  readonly graduationAttempts: number;
  readonly graduationNeedsOperator: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Decision 0102: an operator-hidden token leaves the launchpad lists and
   * `category=meme`; its detail stays readable and carries the state.
   */
  readonly listing: "listed" | "hidden";
  readonly listingReasonCode: string | null;
  readonly listingReasonText: string | null;
}

/** A list row: the token plus the trade aggregates the list shows. */
export interface MemeTokenListRecord extends MemeTokenRecord {
  /** Wallet-side USD1 traded in the last 24 hours, raw. */
  readonly volume24hRaw: string;
  /** Price (1e18 fixed point) of the newest trade at or before now − 1h. */
  readonly price1hAgoE18: string | null;
}

export interface MemeListKey {
  /** The ordering value of the last row (timestamp, bps, or raw volume). */
  readonly value: string;
  readonly memeTokenId: string;
}

export interface MemeTradeRecord {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly wallet: string;
  readonly isBuy: boolean;
  readonly usd1Amount: string;
  readonly tokenAmount: string;
  readonly feeUsd1: string;
  readonly priceAfterE18: string;
  readonly tradedAt: string;
  readonly account: MemeCreatorProjection | null;
}

/**
 * Decision 0142: one (wallet, token) pair of the weekly best trades. The
 * wallet maps to an account with an active public profile whose trade
 * history is visible to everyone; anonymous wallets never appear.
 */
export interface MemeBestTradeRecord {
  readonly wallet: string;
  readonly memeTokenId: string;
  readonly symbol: string;
  readonly imageMediaId: string | null;
  readonly publicProfileId: string;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  /** Window sell proceeds minus the sold tokens at the average buy cost, raw. */
  readonly realizedRaw: string;
}

export interface MemeTradeKey {
  readonly blockNumber: string;
  readonly logIndex: number;
}

export interface MemeCandleRecord {
  /** Bucket start, ISO 8601. */
  readonly openTime: string;
  readonly openE18: string;
  readonly highE18: string;
  readonly lowE18: string;
  readonly closeE18: string;
  readonly volumeUsd1Raw: string;
  readonly tradeCount: number;
}

export interface MemeHolderRecord {
  readonly wallet: string;
  readonly balance: string;
  readonly frozenAt: string | null;
  readonly ownerUserId: string | null;
  readonly account: MemeCreatorProjection | null;
}

export interface MemeHolderKey {
  readonly balance: string;
  readonly wallet: string;
}

export interface MemeDraftInput {
  readonly memeTokenId: string;
  readonly chainId: LaunchChainId;
  readonly contractAddress: string;
  readonly contractVersion: string;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly imageMediaId: string | null;
  readonly links: Readonly<Record<MemeLinkKey, string | null>>;
  readonly metadataHash: string;
}

export interface MemeSaltScope {
  readonly chainId: LaunchChainId;
  readonly contractAddress: string;
  readonly tokenImplementation: string;
  readonly suffix: string;
}

export interface CreateMemeDraftInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly dailyLimit: number;
  /** Rolling window start of the daily limit (now − 24 h), ISO 8601. */
  readonly limitWindowStart: string;
  readonly draft: MemeDraftInput;
  readonly saltScope: MemeSaltScope;
  /** Used when the pool has no free vanity salt. */
  readonly fallbackSalt: {
    readonly salt: string;
    readonly predictedAddress: string;
  };
}

export class MemeRepositoryUnavailableError extends Error {
  readonly code = "meme_repository_unavailable";

  constructor(options: { readonly cause?: unknown } = {}) {
    super(
      "The MEME repository is unavailable",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MemeRepositoryUnavailableError";
  }
}

export class MemeIdempotencyConflictError extends Error {
  readonly code = "meme_idempotency_conflict";

  constructor() {
    super("The Idempotency-Key was used for a different request");
    this.name = "MemeIdempotencyConflictError";
  }
}

export class MemeCreateRateLimitedError extends Error {
  readonly code = "meme_create_rate_limited";

  constructor(readonly limit: number) {
    super("The daily MEME creation limit is reached");
    this.name = "MemeCreateRateLimitedError";
  }
}

export class MemeImageNotOwnedError extends Error {
  readonly code = "meme_image_not_owned";

  constructor() {
    super("The image media object does not belong to the caller");
    this.name = "MemeImageNotOwnedError";
  }
}

export class MemeIntentReportConflictError extends Error {
  readonly code = "meme_intent_report_conflict";

  constructor() {
    super("The MEME Intent was already reported with another hash");
    this.name = "MemeIntentReportConflictError";
  }
}

/**
 * Decision 0104 M2: a draft already has a create Intent that is still
 * signable (`prepared` inside its window) or reported; a second one would
 * race it for the same salt.
 */
export class MemeCreateIntentInFlightError extends Error {
  readonly code = "meme_create_intent_in_flight";

  constructor() {
    super("The MEME draft already has a create Intent in flight");
    this.name = "MemeCreateIntentInFlightError";
  }
}

/** The draft left `draft` between the service's read and the insert. */
export class MemeTokenNotDraftError extends Error {
  readonly code = "meme_token_not_draft";

  constructor(readonly status: string | null) {
    super("The MEME token is no longer a draft");
    this.name = "MemeTokenNotDraftError";
  }
}

export interface MemeIntentReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly confirmations: number;
  readonly observedAt: string;
}

export interface MemeIntentRecord {
  readonly intentId: string;
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly memeTokenId: string;
  readonly kind: MemeIntentKind;
  readonly chainId: LaunchChainId;
  readonly contractAddress: string;
  readonly tokenAddress: string | null;
  readonly usd1AmountRaw: string;
  readonly tokenAmountRaw: string;
  readonly expectedOutRaw: string;
  readonly minOutRaw: string;
  readonly feeRaw: string;
  readonly refundRaw: string;
  readonly deadline: string;
  readonly snapshotBlockNumber: string;
  readonly snapshotBlockHash: string;
  readonly calldata: Readonly<Record<string, unknown>>;
  readonly unsignedTransaction: Readonly<Record<string, unknown>>;
  readonly approval: Readonly<Record<string, unknown>> | null;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly payloadDigest: string;
  readonly state: MemeIntentState;
  readonly reasonCode: string | null;
  readonly transactionHash: string | null;
  readonly payloadVerified: boolean;
  readonly receipt: MemeIntentReceipt | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateMemeIntentRecord = Omit<
  MemeIntentRecord,
  | "reasonCode"
  | "transactionHash"
  | "payloadVerified"
  | "receipt"
  | "createdAt"
  | "updatedAt"
>;

export interface MemeCheckpointRecord {
  readonly lastBlockNumber: string;
  readonly lastBlockHash: string;
  readonly startedFromBlockNumber: string;
  readonly updatedAt: string;
}

/** One decoded lane event, storage-ready (bigints as decimal strings). */
export type MemeLaneEventInput =
  | {
      readonly kind: "trade";
      readonly transactionHash: string;
      readonly logIndex: number;
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly tokenAddress: string;
      readonly wallet: string;
      readonly isBuy: boolean;
      readonly usd1Amount: string;
      readonly tokenAmount: string;
      readonly feeUsd1: string;
      readonly vUsd1After: string;
      readonly vTokenAfter: string;
      readonly soldAfter: string;
      readonly priceAfterE18: string;
      /** Unix seconds from the event. */
      readonly at: string;
      readonly removed: boolean;
    }
  | {
      readonly kind: "event";
      readonly eventName:
        | "TokenCreated"
        | "CurveFull"
        | "Graduated"
        | "GraduationResidual"
        | "ResidualInjected"
        | "Paused"
        | "Unpaused";
      readonly transactionHash: string;
      readonly logIndex: number;
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly tokenAddress: string;
      readonly payload: Readonly<Record<string, string>>;
      /** Unix seconds from the event, when it carries one. */
      readonly at: string | null;
      readonly removed: boolean;
    };

export interface CommitMemeSegmentInput {
  readonly chainId: LaunchChainId;
  readonly contractAddress: string;
  readonly events: readonly MemeLaneEventInput[];
  readonly checkpoint: {
    readonly lastBlockNumber: string;
    readonly lastBlockHash: string;
    readonly startedFromBlockNumber: string;
  };
  readonly rewindFromBlockNumber?: string;
}

export interface CommitMemeSegmentResult {
  /** Events stored for a LOOP token. */
  readonly storedCount: number;
  /** Events of tokens LOOP did not create (never stored). */
  readonly skippedCount: number;
  /** TokenCreated logs whose salt matched a draft but not its metadata. */
  readonly metadataMismatchCount: number;
  /**
   * TokenCreated logs that matched a draft's salt and metadata but whose
   * `creator` is not the wallet of any create Intent of that draft
   * (Decision 0104 m3, `MEME_CREATED_CREATOR_MISMATCH`); never stored.
   */
  readonly creatorMismatchCount: number;
  readonly touchedTokenIds: readonly string[];
}

export interface MemeGraduationCandidate {
  readonly memeTokenId: string;
  readonly tokenAddress: string;
  readonly fullAt: string;
  readonly graduationAttempts: number;
}

export interface MemeRepository {
  // --- API reads -------------------------------------------------------
  getToken(memeTokenId: string): Promise<MemeTokenRecord | null>;
  listTokens(input: {
    readonly chainId: LaunchChainId;
    readonly contractAddress: string;
    readonly tab: "new" | "graduating" | "graduated";
    readonly limit: number;
    readonly after: MemeListKey | null;
    readonly now: string;
  }): Promise<readonly MemeTokenListRecord[]>;
  /** `hot`: on-chain tokens by last-hour wallet-side USD1 volume desc. */
  rankHotTokens(input: {
    readonly chainId: LaunchChainId;
    readonly contractAddress: string;
    readonly since: string;
    readonly limit: number;
  }): Promise<
    readonly { readonly memeTokenId: string; readonly volumeRaw: string }[]
  >;
  listTokensByIds(input: {
    readonly memeTokenIds: readonly string[];
    readonly now: string;
  }): Promise<readonly MemeTokenListRecord[]>;
  /**
   * Decision 0142: (wallet, token) pairs with sells in `(since, until]`,
   * realized = sells − sold tokens × the pair's average buy price (all
   * non-removed buys at or before `until`, cost rounded up); positive only,
   * mapped wallets only, realized desc, at most `limit`.
   */
  rankBestTrades(input: {
    readonly chainId: LaunchChainId;
    readonly contractAddress: string;
    readonly since: string;
    readonly until: string;
    readonly limit: number;
  }): Promise<readonly MemeBestTradeRecord[]>;
  /** Trade aggregates of one token for the detail row. */
  tokenStats(input: {
    readonly memeTokenId: string;
    readonly now: string;
  }): Promise<{
    readonly volume24hRaw: string;
    readonly price1hAgoE18: string | null;
  }>;
  listTrades(input: {
    readonly memeTokenId: string;
    readonly limit: number;
    readonly after: MemeTradeKey | null;
  }): Promise<readonly MemeTradeRecord[]>;
  listCandles(input: {
    readonly memeTokenId: string;
    readonly intervalSeconds: number;
    readonly limit: number;
    /** Exclusive upper bound of `traded_at` (graduation freezes it). */
    readonly until: string | null;
  }): Promise<readonly MemeCandleRecord[]>;
  listHolders(input: {
    readonly memeTokenId: string;
    readonly limit: number;
    readonly after: MemeHolderKey | null;
  }): Promise<readonly MemeHolderRecord[]>;

  // --- Creation --------------------------------------------------------
  createDraft(input: CreateMemeDraftInput): Promise<{
    readonly created: boolean;
    readonly token: MemeTokenRecord;
  }>;
  /**
   * Gives a draft a fresh salt: the current one is marked `used` (it was
   * taken on chain by someone else, or its reservation lapsed), and a free
   * vanity salt — or `fallbackSalt` — takes its place.
   */
  replaceDraftSalt(input: {
    readonly memeTokenId: string;
    readonly expectedSalt: string | null;
    readonly saltScope: MemeSaltScope;
    readonly fallbackSalt: {
      readonly salt: string;
      readonly predictedAddress: string;
    };
  }): Promise<MemeTokenRecord | null>;
  /** Re-reserves the draft's own salt (refreshing `reserved_at`). */
  touchDraftSalt(memeTokenId: string): Promise<void>;

  // --- Intents ---------------------------------------------------------
  /**
   * Claims the Idempotency-Key, runs `build` (chain reads) outside any
   * transaction, then inserts under the owner lock (Decision 0104 M2):
   * `canaryAdmission` re-checks the daily ceiling on the stored totals, and
   * `exclusiveCreate` refuses a second live create Intent of the draft
   * (`MemeCreateIntentInFlightError`) or a draft that left `draft`
   * (`MemeTokenNotDraftError`); both are checked before `build` too.
   */
  createIntent(input: {
    readonly ownerUserId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly build: () => Promise<CreateMemeIntentRecord>;
    readonly canaryAdmission?: (
      built: CreateMemeIntentRecord,
    ) => CanaryExposureAdmission | null;
    readonly exclusiveCreate?: { readonly memeTokenId: string } | null;
  }): Promise<{ readonly created: boolean; readonly intent: MemeIntentRecord }>;
  getIntent(input: {
    readonly ownerUserId: string;
    readonly intentId: string;
  }): Promise<MemeIntentRecord | null>;
  reportIntentBroadcast(input: {
    readonly ownerUserId: string;
    readonly intentId: string;
    readonly transactionHash: string;
    readonly payloadVerified: boolean;
  }): Promise<MemeIntentRecord>;
  /**
   * The account's whole canary exposure since `since` (inclusive): wallet,
   * Launch, and MEME Intents that may still move funds (Decision 0104 M1).
   */
  sumRecentExposureUsd(input: {
    readonly ownerUserId: string;
    readonly since: string;
  }): Promise<string>;
  leaseReconcilableIntents(input: {
    readonly chainId: LaunchChainId;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly MemeIntentRecord[]>;
  markIntentPayloadVerified(input: {
    readonly intentId: string;
    readonly transactionHash: string;
  }): Promise<void>;
  /**
   * Settles a `broadcast_reported` Intent; a failed `create` returns its
   * token to `draft`. Null when the row was no longer in that state.
   */
  settleIntent(input: {
    readonly intentId: string;
    readonly transactionHash: string;
    readonly toState: "confirmed" | "failed" | "expired";
    readonly reasonCode: string | null;
    readonly receipt: MemeIntentReceipt | null;
  }): Promise<MemeIntentRecord | null>;

  // --- Lane ------------------------------------------------------------
  getCheckpoint(chainId: LaunchChainId): Promise<MemeCheckpointRecord | null>;
  commitSegment(
    input: CommitMemeSegmentInput,
  ): Promise<CommitMemeSegmentResult>;

  // --- Salt pool -------------------------------------------------------
  countFreeSalts(scope: MemeSaltScope): Promise<number>;
  insertSalts(input: {
    readonly scope: MemeSaltScope;
    readonly salts: readonly {
      readonly salt: string;
      readonly predictedAddress: string;
    }[];
  }): Promise<number>;
  /** Frees reservations of drafts still in `draft` older than `before`. */
  releaseStaleSaltReservations(before: string): Promise<number>;

  // --- Graduation executor --------------------------------------------
  listGraduationCandidates(input: {
    readonly chainId: LaunchChainId;
    readonly fullBefore: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly MemeGraduationCandidate[]>;
  recordGraduationAttempt(input: {
    readonly memeTokenId: string;
    readonly errorCode: string | null;
    readonly nextAttemptAt: string | null;
    readonly needsOperator: boolean;
  }): Promise<void>;
}
