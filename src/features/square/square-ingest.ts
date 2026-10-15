import { randomUUID } from "node:crypto";

import {
  bscUsdcAddress,
  bscUsdtAddress,
} from "../chain/swap-classification.js";
import {
  squareBuyCandidates,
  squareLimits,
  type SquareEventCandidate,
  type SquareRepository,
} from "./square-contract.js";

/**
 * Decision 0143 §4: the `square_feed_ingest` lane. Each pass reads, from
 * the last seven days, the system events not yet in `square_posts`:
 *
 * - `buy`: a `community_member_buy_events` row the member buy lane accepted
 *   (a buy of the community's bound asset by a member who shows trades;
 *   outcome sent / truncated / rejected / skipped_no_channel) whose stable
 *   quote side (USD1 / USDT / USDC at par) paid ≥ 10.
 * - `claim`: a non-removed LoopDynamic `RewardClaimed`
 *   (`launch2_dynamic_claims`) whose wallet is an active LOOP wallet of a
 *   user who shows trades.
 * - `graduation`: `launch2_instances.graduated_at` (author = instance
 *   owner) and graduated MEME v1 tokens (author = creator).
 *
 * The author is the user behind the event; an event no user maps to is
 * never written. `source_event_id` (unique) makes every write idempotent.
 */

export const squareFeedIngestLane = "square_feed_ingest";

export interface SquareFeedIngestResult {
  readonly kind: "aborted" | "completed";
  readonly buyCount: number;
  readonly claimCount: number;
  readonly graduationCount: number;
  readonly insertedCount: number;
}

export interface SquareFeedIngest {
  runOnce(signal?: AbortSignal): Promise<SquareFeedIngestResult>;
}

export type SquareFeedIngestRepository = Pick<
  SquareRepository,
  | "listBuyCandidates"
  | "listClaimCandidates"
  | "listGraduationCandidates"
  | "insertEventPosts"
>;

/** A function, not a property read, so the check is not narrowed away. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function squareStableAddresses(
  usd1Address: string | null,
): readonly string[] {
  return [bscUsdtAddress, bscUsdcAddress, usd1Address]
    .filter((value): value is string => value !== null)
    .map((value) => value.toLowerCase());
}

export function createSquareFeedIngest(options: {
  readonly repository: SquareFeedIngestRepository;
  /** Verified USD1 address (joins USDT / USDC as a stable quote). */
  readonly usd1Address: string | null;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
  readonly batch?: number;
}): SquareFeedIngest {
  const now = options.now ?? ((): Date => new Date());
  const createUuid = options.createUuid ?? randomUUID;
  const batch = options.batch ?? squareLimits.ingestBatch;
  const stableAddresses = squareStableAddresses(options.usd1Address);

  async function write(
    candidates: readonly SquareEventCandidate[],
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    return options.repository.insertEventPosts({
      posts: candidates.map((candidate) => ({
        ...candidate,
        postId: createUuid(),
      })),
    });
  }

  return Object.freeze({
    async runOnce(signal?: AbortSignal): Promise<SquareFeedIngestResult> {
      const empty = {
        buyCount: 0,
        claimCount: 0,
        graduationCount: 0,
        insertedCount: 0,
      };
      if (isAborted(signal))
        return Object.freeze({ kind: "aborted", ...empty });
      const since = new Date(now().getTime() - squareLimits.ingestLookbackMs);
      const buys = squareBuyCandidates(
        await options.repository.listBuyCandidates({
          since,
          stableAddresses,
          limit: batch,
        }),
      );
      let inserted = await write(buys);
      if (isAborted(signal)) {
        return Object.freeze({
          kind: "aborted",
          ...empty,
          buyCount: buys.length,
          insertedCount: inserted,
        });
      }
      const claims = await options.repository.listClaimCandidates({
        since,
        limit: batch,
      });
      inserted += await write(claims);
      const graduations = await options.repository.listGraduationCandidates({
        since,
        limit: batch,
      });
      inserted += await write(graduations);
      return Object.freeze({
        kind: "completed",
        buyCount: buys.length,
        claimCount: claims.length,
        graduationCount: graduations.length,
        insertedCount: inserted,
      });
    },
  });
}
