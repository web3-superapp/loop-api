/**
 * Decision 0129 §2 (patch to Decision 0125): the MEME `Transfer` coverage
 * of a launch2 instance is only marked complete once the indexed facts
 * prove it. A public endpoint that silently answers `[]` to `eth_getLogs`
 * for old blocks must never leave a coverage marked complete with the
 * history missing (2026-10-12: the settlement then saw the PoolManager
 * with a negative balance).
 *
 * Two invariants, read from `launch2_meme_transfers` (not removed):
 *
 * - the deploy-block mint: a `Transfer` from the zero address at the
 *   instance's `deploy_block_number` exists (every MEME mints its supply
 *   in the deploy transaction);
 * - no negative balance: Σ(in) − Σ(out) ≥ 0 for every address other than
 *   the zero address.
 *
 * A failed check does not mark the coverage: the target block is cleared
 * so the lane re-scans from the deploy block once more. After
 * `launch2MemeCoverageMaxAttempts` consecutive failures the lane stops
 * re-scanning that instance (error log) until an operator resets
 * `meme_transfers_coverage_failures` to 0 and the target block to null.
 */

export const launch2MemeCoverageReasonCode = "LAUNCH2_MEME_COVERAGE_INCOMPLETE";

/** Consecutive failed checks before the lane stops re-scanning. */
export const launch2MemeCoverageMaxAttempts = 3;

export type Launch2MemeCoverageGap = "DEPLOY_MINT_MISSING" | "NEGATIVE_BALANCE";

/** What the repository reads for one instance whose re-scan reached its target. */
export interface Launch2MemeCoverageFacts {
  readonly instanceId: string;
  readonly deployMintPresent: boolean;
  /** Addresses (other than the zero address) with Σ(in) − Σ(out) < 0. */
  readonly negativeBalanceCount: number;
  /** Consecutive failed checks recorded before this one. */
  readonly failedAttempts: number;
}

export type Launch2MemeCoverageVerdict =
  | { readonly kind: "complete"; readonly instanceId: string }
  | {
      /** Not complete: clear the target so the lane re-scans once more. */
      readonly kind: "retry" | "stalled";
      readonly instanceId: string;
      readonly gaps: readonly Launch2MemeCoverageGap[];
      readonly failedAttempts: number;
      readonly negativeBalanceCount: number;
    };

export function assessLaunch2MemeCoverage(
  facts: Launch2MemeCoverageFacts,
  maxAttempts: number = launch2MemeCoverageMaxAttempts,
): Launch2MemeCoverageVerdict {
  const gaps: Launch2MemeCoverageGap[] = [];
  if (!facts.deployMintPresent) gaps.push("DEPLOY_MINT_MISSING");
  if (facts.negativeBalanceCount > 0) gaps.push("NEGATIVE_BALANCE");
  if (gaps.length === 0) {
    return Object.freeze({ kind: "complete", instanceId: facts.instanceId });
  }
  const failedAttempts = facts.failedAttempts + 1;
  return Object.freeze({
    kind: failedAttempts >= maxAttempts ? "stalled" : "retry",
    instanceId: facts.instanceId,
    gaps: Object.freeze(gaps),
    failedAttempts,
    negativeBalanceCount: facts.negativeBalanceCount,
  });
}
