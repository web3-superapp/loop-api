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
 * - Decision 0122 (v3 Factory): `PublicRoundOpenedWithoutHolders` seen →
 *   `public` (the sale ended with no mint; the contract opened the public
 *   round with no early round, `earlyRoundEndsAt = openedAt`);
 * - Decision 0137 (S175 Factory): `PublicRoundOpenedAfterTimeout` seen →
 *   `public` as well (anyone opened after the snapshot timeout; holders
 *   lose the early round, the contract sets `earlyRoundEndsAt = openedAt`);
 * - sale over, no `SnapshotPublished`, and the publisher recorded that the
 *   sale ended with no holder (Decision 0120: `ProjectNFT.totalMinted()` = 0
 *   at the confirmed cutoff) → `closed_no_holders` (terminal). Since
 *   Decision 0122 only v2-generation instances (no zero-holder opening in
 *   the contract) can reach it; the value is deprecated;
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
  /**
   * Decision 0122: Unix seconds of the indexed
   * `PublicRoundOpenedWithoutHolders` (v3); absent / null = not opened.
   */
  readonly openedWithoutHoldersAt?: bigint | null;
  /**
   * Decision 0137: Unix seconds of the indexed
   * `PublicRoundOpenedAfterTimeout`; absent / null = not opened that way.
   */
  readonly openedAfterTimeoutAt?: bigint | null;
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
  if (
    ((input.openedWithoutHoldersAt !== undefined &&
      input.openedWithoutHoldersAt !== null) ||
      (input.openedAfterTimeoutAt !== undefined &&
        input.openedAfterTimeoutAt !== null)) &&
    input.snapshotPublishedAt === null
  ) {
    // A chain fact: block.timestamp ≥ saleEnd when it was emitted.
    return { stage: "public", nextChangeAt: null };
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
