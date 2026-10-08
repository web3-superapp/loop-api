import { createHash } from "node:crypto";

import {
  absoluteAmount,
  classifySwap,
  swapQuoteSets,
} from "../chain/swap-classification.js";
import {
  StreamChannelRequestRejectedError,
  type SendStreamCommunityFeedMessageInput,
  type SendStreamCommunityFeedMessageResult,
} from "../../integrations/stream/channel-gateway.js";
import {
  feedCursorWholeBlockLogIndex,
  type FeedPosition,
  type MemberBuyEventOutcome,
  type MemberBuyFeedCandidate,
  type MemberBuyFeedMatch,
  type MemberBuyFeedRepository,
} from "./member-buy-feed-repository.js";

/**
 * The `community_member_buy_feed` lane (Decision 0097): a swap of a verified
 * community's bound asset whose wallet belongs to an active member who shows
 * trades publicly becomes one "群友买入" message from `loop_feed_bot` in
 * that community's official channel.
 */

/** Swaps read per pass. */
export const MEMBER_BUY_FEED_EVENT_BATCH = 200;
/** Messages sent per community per pass; the rest are recorded `truncated`. */
export const MEMBER_BUY_FEED_PER_COMMUNITY_LIMIT = 20;

export const memberBuyFeedReasonCodes = Object.freeze({
  indexerNotStarted: "MEMBER_BUY_FEED_INDEXER_NOT_STARTED",
  cursorInitialized: "MEMBER_BUY_FEED_CURSOR_INITIALIZED",
  waitingForIndexer: "MEMBER_BUY_FEED_WAITING_FOR_INDEXER",
  truncated: "MEMBER_BUY_FEED_TRUNCATED",
  rejected: "MEMBER_BUY_FEED_STREAM_REJECTED",
  streamUnavailable: "MEMBER_BUY_FEED_STREAM_UNAVAILABLE",
  streamNotConfigured: "MEMBER_BUY_FEED_STREAM_NOT_CONFIGURED",
  repositoryUnavailable: "member_buy_feed_unavailable",
} as const);

export const memberBuySchema = "member_buy.v1";

export interface MemberBuyFeedSender {
  sendCommunityFeedMessage(
    input: SendStreamCommunityFeedMessageInput,
  ): Promise<SendStreamCommunityFeedMessageResult>;
}

export type MemberBuyFeedEvent =
  | {
      readonly kind: "cursor_initialized";
      readonly reasonCode: typeof memberBuyFeedReasonCodes.cursorInitialized;
      readonly blockNumber: string;
    }
  | {
      readonly kind: "sent";
      readonly communityId: string;
      readonly messageId: string;
      readonly duplicate: boolean;
    }
  | {
      readonly kind: "truncated";
      readonly reasonCode: typeof memberBuyFeedReasonCodes.truncated;
      readonly communityId: string;
      readonly truncatedCount: number;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode: typeof memberBuyFeedReasonCodes.rejected;
      readonly communityId: string;
      readonly messageId: string;
    }
  | {
      readonly kind: "stream_unavailable";
      readonly reasonCode: typeof memberBuyFeedReasonCodes.streamUnavailable;
      readonly communityId: string;
      readonly errorClass: string;
    };

export type MemberBuyFeedRunResult = Readonly<{
  kind:
    | "aborted"
    | "indexer_not_started"
    | "cursor_initialized"
    | "waiting_for_indexer"
    | "completed"
    | "stalled";
  examinedSwapCount: number;
  sentCount: number;
  truncatedCount: number;
  skippedCount: number;
  rejectedCount: number;
  cursor: FeedPosition | null;
}>;

export interface MemberBuyFeedService {
  /**
   * One pass. Rejects only when a repository read or write fails (the
   * worker backs off); a Stream failure stalls the pass at the last fully
   * handled swap and resolves `stalled`, so the next pass retries it.
   */
  runOnce(signal: AbortSignal): Promise<MemberBuyFeedRunResult>;
}

export interface MemberBuyFeedServiceOptions {
  readonly repository: MemberBuyFeedRepository;
  readonly sender: MemberBuyFeedSender;
  readonly chainId: string;
  /** Verified USD1 address, joining the quote and stable sets. */
  readonly usd1Address: string | null;
  readonly onEvent?: (event: MemberBuyFeedEvent) => void;
  readonly eventBatch?: number;
  readonly perCommunityLimit?: number;
}

/** `loop_buy_` + the first 32 hex of sha256(chainId|txHash|logIndex|communityId). */
export function memberBuyMessageId(input: {
  readonly chainId: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly communityId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.chainId}|${input.transactionHash}|${String(input.logIndex)}|${input.communityId}`,
    )
    .digest("hex");
  return `loop_buy_${digest.slice(0, 32)}`;
}

function comparePositions(left: FeedPosition, right: FeedPosition): number {
  const leftBlock = BigInt(left.blockNumber);
  const rightBlock = BigInt(right.blockNumber);
  if (leftBlock !== rightBlock) {
    return leftBlock < rightBlock ? -1 : 1;
  }
  return left.logIndex === right.logIndex
    ? 0
    : left.logIndex < right.logIndex
      ? -1
      : 1;
}

function errorClassOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name)
    ? error.name
    : "unknown";
}

/** A function, not a property read, so the check is not narrowed away. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

class StreamStall extends Error {}

export function createMemberBuyFeedService(
  options: MemberBuyFeedServiceOptions,
): MemberBuyFeedService {
  const eventBatch = options.eventBatch ?? MEMBER_BUY_FEED_EVENT_BATCH;
  const perCommunityLimit =
    options.perCommunityLimit ?? MEMBER_BUY_FEED_PER_COMMUNITY_LIMIT;
  const { quoteAssetIds, stableAssetIds } = swapQuoteSets(
    options.chainId,
    options.usd1Address,
  );
  const emit = (event: MemberBuyFeedEvent): void => {
    options.onEvent?.(Object.freeze(event));
  };

  function result(
    kind: MemberBuyFeedRunResult["kind"],
    counts: Partial<Omit<MemberBuyFeedRunResult, "kind">> = {},
  ): MemberBuyFeedRunResult {
    return Object.freeze({
      kind,
      examinedSwapCount: counts.examinedSwapCount ?? 0,
      sentCount: counts.sentCount ?? 0,
      truncatedCount: counts.truncatedCount ?? 0,
      skippedCount: counts.skippedCount ?? 0,
      rejectedCount: counts.rejectedCount ?? 0,
      cursor: counts.cursor ?? null,
    });
  }

  /** The message body of one decided buy; amounts stay decimal strings. */
  function messageFor(
    candidate: MemberBuyFeedCandidate,
    match: MemberBuyFeedMatch,
    swap: ReturnType<typeof classifySwap>,
  ) {
    const base =
      candidate.token0.assetId === swap.baseAssetId
        ? candidate.token0
        : candidate.token1;
    const quote =
      candidate.token0.assetId === swap.quoteAssetId
        ? candidate.token0
        : candidate.token1;
    return {
      text: `群友买入 · ${base.symbol}`,
      custom: {
        loop_schema: memberBuySchema,
        loop_event_kind: "memberBuy",
        publicProfileId: match.publicProfileId,
        assetId: base.assetId,
        symbol: base.symbol,
        decimals: base.decimals,
        amountRaw: absoluteAmount(swap.baseAmountRaw).toString(),
        quoteAssetId: quote.assetId,
        quoteSymbol: quote.symbol,
        quoteDecimals: quote.decimals,
        quoteAmountRaw: absoluteAmount(swap.quoteAmountRaw).toString(),
        quoteIsStable: stableAssetIds.has(quote.assetId),
        txHash: candidate.transactionHash,
        logIndex: candidate.logIndex,
        chainId: candidate.chainId,
        blockNumber: candidate.blockNumber,
        blockTimestamp: candidate.blockTimestamp,
      },
    };
  }

  return Object.freeze({
    async runOnce(signal: AbortSignal): Promise<MemberBuyFeedRunResult> {
      if (isAborted(signal)) {
        return result("aborted");
      }
      const chainId = options.chainId;
      const checkpoint =
        await options.repository.readPoolEventCheckpoint(chainId);
      if (checkpoint === null) {
        return result("indexer_not_started");
      }
      const stored = await options.repository.readCursor(chainId);
      if (stored === null) {
        // First run: start at the indexer's current position. History is
        // never replayed into a channel.
        const cursor = await options.repository.initializeCursor(chainId, {
          blockNumber: checkpoint,
          logIndex: feedCursorWholeBlockLogIndex,
        });
        emit({
          kind: "cursor_initialized",
          reasonCode: memberBuyFeedReasonCodes.cursorInitialized,
          blockNumber: cursor.blockNumber,
        });
        return result("cursor_initialized", { cursor });
      }
      const ceiling: FeedPosition = {
        blockNumber: checkpoint,
        logIndex: feedCursorWholeBlockLogIndex,
      };
      if (comparePositions(stored, ceiling) >= 0) {
        // Caught up, or the indexer rewound below the cursor: wait for it.
        return result("waiting_for_indexer", { cursor: stored });
      }

      const candidates = await options.repository.listCandidates({
        chainId,
        after: stored,
        throughBlockNumber: checkpoint,
        limit: eventBatch,
      });
      const sentPerCommunity = new Map<string, number>();
      const truncatedPerCommunity = new Map<string, number>();
      const counts = {
        examinedSwapCount: 0,
        sentCount: 0,
        truncatedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
      };
      let consumed: FeedPosition = stored;
      let stalled = false;

      const decide = async (
        candidate: MemberBuyFeedCandidate,
        match: MemberBuyFeedMatch,
      ): Promise<void> => {
        if (
          match.existingOutcome !== null &&
          match.existingOutcome !== "pending"
        ) {
          return;
        }
        const key = {
          chainId: candidate.chainId,
          transactionHash: candidate.transactionHash,
          logIndex: candidate.logIndex,
          communityId: match.communityId,
        };
        const finish = async (
          outcome: Exclude<MemberBuyEventOutcome, "pending">,
        ): Promise<void> => {
          if (match.existingOutcome === "pending") {
            await options.repository.settleEvent({ ...key, outcome });
          } else {
            await options.repository.recordEvent({
              ...key,
              buyerUserId: match.buyerUserId,
              blockNumber: candidate.blockNumber,
              outcome,
              streamMessageId: null,
            });
          }
        };
        const swap = classifySwap(
          {
            token0AssetId: candidate.token0.assetId,
            token1AssetId: candidate.token1.assetId,
            amount0: candidate.amount0,
            amount1: candidate.amount1,
          },
          quoteAssetIds,
        );
        if (swap.kind !== "buy" || swap.baseAssetId !== match.boundAssetId) {
          counts.skippedCount += 1;
          return finish("skipped_not_buy");
        }
        if (
          match.tradeHistoryVisibility !== "everyone" ||
          match.anonymousMode
        ) {
          counts.skippedCount += 1;
          return finish("skipped_private");
        }
        if (match.streamChannelId === null) {
          counts.skippedCount += 1;
          return finish("skipped_no_channel");
        }
        const sent = sentPerCommunity.get(match.communityId) ?? 0;
        if (sent >= perCommunityLimit) {
          counts.truncatedCount += 1;
          truncatedPerCommunity.set(
            match.communityId,
            (truncatedPerCommunity.get(match.communityId) ?? 0) + 1,
          );
          return finish("truncated");
        }
        sentPerCommunity.set(match.communityId, sent + 1);
        const messageId = memberBuyMessageId(key);
        if (match.existingOutcome === null) {
          // Recorded before the send: a crash between the two leaves a
          // `pending` row that the next pass resends under the same ID.
          await options.repository.recordEvent({
            ...key,
            buyerUserId: match.buyerUserId,
            blockNumber: candidate.blockNumber,
            outcome: "pending",
            streamMessageId: messageId,
          });
        }
        const message = messageFor(candidate, match, swap);
        try {
          const delivered = await options.sender.sendCommunityFeedMessage({
            streamChannelId: match.streamChannelId,
            messageId,
            text: message.text,
            custom: message.custom,
            signal,
          });
          await options.repository.settleEvent({ ...key, outcome: "sent" });
          counts.sentCount += 1;
          emit({
            kind: "sent",
            communityId: match.communityId,
            messageId,
            duplicate: delivered.status === "duplicate",
          });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof StreamChannelRequestRejectedError) {
            await options.repository.settleEvent({
              ...key,
              outcome: "rejected",
            });
            counts.rejectedCount += 1;
            emit({
              kind: "rejected",
              reasonCode: memberBuyFeedReasonCodes.rejected,
              communityId: match.communityId,
              messageId,
            });
            return;
          }
          emit({
            kind: "stream_unavailable",
            reasonCode: memberBuyFeedReasonCodes.streamUnavailable,
            communityId: match.communityId,
            errorClass: errorClassOf(error),
          });
          throw new StreamStall();
        }
      };

      try {
        for (const candidate of candidates) {
          if (isAborted(signal)) {
            break;
          }
          for (const match of candidate.matches) {
            await decide(candidate, match);
          }
          counts.examinedSwapCount += 1;
          consumed = {
            blockNumber: candidate.blockNumber,
            logIndex: candidate.logIndex,
          };
        }
      } catch (error) {
        if (!(error instanceof StreamStall)) {
          if (isAborted(signal)) {
            await options.repository.advanceCursor(chainId, consumed);
            return result("aborted", { ...counts, cursor: consumed });
          }
          throw error;
        }
        stalled = true;
      }

      for (const [communityId, truncatedCount] of truncatedPerCommunity) {
        emit({
          kind: "truncated",
          reasonCode: memberBuyFeedReasonCodes.truncated,
          communityId,
          truncatedCount,
        });
      }
      const finished =
        !stalled &&
        !isAborted(signal) &&
        candidates.length < eventBatch &&
        counts.examinedSwapCount === candidates.length;
      // Everything through the checkpoint block was read when the page was
      // short; otherwise only through the last fully handled swap.
      const next = finished ? ceiling : consumed;
      await options.repository.advanceCursor(chainId, next);
      return result(
        stalled ? "stalled" : isAborted(signal) ? "aborted" : "completed",
        { ...counts, cursor: next },
      );
    },
  });
}
