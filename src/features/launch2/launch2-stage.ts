import { launch2Template, type Launch2Stage } from "./launch2-contract.js";

/**
 * Decision 0114 §2: the instance stage is derived, never stored as a
 * command. Inputs are chain facts the `launch2_event` lane indexed
 * (activation, the snapshot publication, graduation) plus the signed sale
 * start and the clock:
 *
 * - integrity hold → `paused` (no next change; an operator clears it);
 * - `Graduated` seen → `graduated` (the last buy graduates atomically, so a
 *   sold-out curve is always graduated — either round can jump here);
 * - before the NFT sale start → `upcoming` (next = sale start);
 * - sale start ≤ now < sale end → `nft_sale` (next = sale end). The end is
 *   the instance's verified `ProjectNFT.saleEnd()` (Decision 0119: 1 hour
 *   on the testnet Factory, 7 days on mainnet), never a template constant;
 * - sale over, no `SnapshotPublished` → `snapshot_pending` (no clock: the
 *   2-of-3 publication decides);
 * - sale over, no `SnapshotPublished`, and the publisher recorded that the
 *   sale ended with no holder (Decision 0120: `ProjectNFT.totalMinted()` = 0
 *   at the confirmed cutoff) → `closed_no_holders` (terminal);
 * - published ≤ now < published + 3,600 s → `priority` (next = round end);
 * - afterwards → `public` (ends only by selling out).
 *
 * Instances whose activation the lane has not seen are not listed at all.
 */

export interface Launch2StageInput {
  readonly nowSeconds: bigint;
  readonly nftSaleStart: bigint;
  /** The instance's `ProjectNFT.saleEnd()` (Unix seconds). */
  readonly nftSaleEnd: bigint;
  readonly snapshotPublishedAt: bigint | null;
  readonly graduated: boolean;
  readonly holdReason: string | null;
  /**
   * Decision 0120: a `launch2_snapshot_closures` row exists (the sale ended
   * with zero NFT holders). Absent = false.
   */
  readonly closedNoHolders?: boolean;
}

export interface Launch2StageProjection {
  readonly stage: Launch2Stage;
  /** Unix seconds of the next clock-driven change; null when none. */
  readonly nextChangeAt: bigint | null;
}

export function launch2EarlyRoundEnd(publishedAt: bigint): bigint {
  return publishedAt + BigInt(launch2Template.earlyRoundSeconds);
}

export function deriveLaunch2Stage(
  input: Launch2StageInput,
): Launch2StageProjection {
  if (input.holdReason !== null) {
    return { stage: "paused", nextChangeAt: null };
  }
  if (input.graduated) {
    return { stage: "graduated", nextChangeAt: null };
  }
  const now = input.nowSeconds;
  if (now < input.nftSaleStart) {
    return { stage: "upcoming", nextChangeAt: input.nftSaleStart };
  }
  const saleEnd = input.nftSaleEnd;
  if (now < saleEnd) {
    return { stage: "nft_sale", nextChangeAt: saleEnd };
  }
  if (input.snapshotPublishedAt === null) {
    if (input.closedNoHolders === true) {
      return { stage: "closed_no_holders", nextChangeAt: null };
    }
    return { stage: "snapshot_pending", nextChangeAt: null };
  }
  const roundEnd = launch2EarlyRoundEnd(input.snapshotPublishedAt);
  if (now < roundEnd) {
    return { stage: "priority", nextChangeAt: roundEnd };
  }
  return { stage: "public", nextChangeAt: null };
}
