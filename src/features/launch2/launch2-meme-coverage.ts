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
 *
 * Decision 0132 (review follow-ups of 0129 §2):
 *
 * - per instance, never per lane: a segment whose answer misses one
 *   instance's mint anchor (no endpoint has it) is committed for every
 *   other instance; that instance alone is degraded (coverage not
 *   complete, settlement of its post-graduation balances excluded,
 *   failure counted, re-scan — the same three-strike rule);
 * - a second layer for segments the anchors cannot vouch for (any segment
 *   without a deploy block, including an empty answer): `balanceOf` of a
 *   few addresses of the instance at the segment's last block (the
 *   instance's hot contract — the curve before graduation, the PoolManager
 *   after — plus the addresses the segment moved most) and the MEME
 *   `totalSupply()` are compared with the indexed ledger through that
 *   block. Both directions count: a ledger above the chain is the
 *   one-directional gap the non-negative rule cannot see (missing
 *   outflows), a ledger below it a missing inflow; a supply difference a
 *   missing mint / burn. A mismatch re-reads the segment's MEME logs from
 *   every endpoint (the union of answers is kept when it reconciles);
 *   otherwise the instance is degraded and re-scanned. When no endpoint
 *   can serve the state at that block the segment is unverified: the
 *   coverage is un-marked (no failure counted, no re-scan) until a later
 *   check at a readable block proves it again.
 */

export const launch2MemeCoverageReasonCode = "LAUNCH2_MEME_COVERAGE_INCOMPLETE";

/** Consecutive failed checks before the lane stops re-scanning. */
export const launch2MemeCoverageMaxAttempts = 3;

export type Launch2MemeCoverageGap =
  | "DEPLOY_MINT_MISSING"
  | "NEGATIVE_BALANCE"
  /** Decision 0132: no endpoint returned the deploy-block mint. */
  | "DEPLOY_MINT_UNTRUSTED"
  /** Decision 0132: indexed balance above `balanceOf` (outflow missing). */
  | "LEDGER_ABOVE_CHAIN"
  /** Decision 0132: indexed balance below `balanceOf` (inflow missing). */
  | "LEDGER_BELOW_CHAIN"
  /** Decision 0132: indexed mints − burns ≠ `totalSupply()`. */
  | "SUPPLY_MISMATCH"
  /** Decision 0132: no endpoint served `balanceOf` at the segment end. */
  | "BALANCE_UNVERIFIABLE";

/** Decision 0132: addresses sampled per instance and segment (+ supply). */
export const launch2MemeBalanceSampleSize = 4;

/** Decision 0132: this tick's `balanceOf` verdict of an instance. */
export type Launch2MemeBalanceVerdict =
  | { readonly kind: "verified" }
  | { readonly kind: "unverified" }
  | {
      readonly kind: "mismatch";
      readonly gaps: readonly Launch2MemeCoverageGap[];
      /** Sampled addresses whose ledger differs from `balanceOf`. */
      readonly mismatchedCount: number;
    };

/** What the repository reads for one instance whose re-scan reached its target. */
export interface Launch2MemeCoverageFacts {
  readonly instanceId: string;
  readonly deployMintPresent: boolean;
  /** Addresses (other than the zero address) with Σ(in) − Σ(out) < 0. */
  readonly negativeBalanceCount: number;
  /** Consecutive failed checks recorded before this one. */
  readonly failedAttempts: number;
  /**
   * Decision 0132: the `balanceOf` verdict of this tick's segment check
   * (absent: the lane does not run it — a repository without a ledger).
   * `unverified` keeps the coverage pending (no verdict recorded).
   */
  readonly balance?: Launch2MemeBalanceVerdict;
}

export type Launch2MemeCoverageVerdict =
  | { readonly kind: "complete"; readonly instanceId: string }
  /**
   * Decision 0132: the state at the segment end was unreadable; nothing is
   * recorded, the next tick checks again.
   */
  | { readonly kind: "pending"; readonly instanceId: string }
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
  if (facts.balance?.kind === "mismatch") gaps.push(...facts.balance.gaps);
  if (gaps.length === 0 && facts.balance?.kind === "unverified") {
    return Object.freeze({ kind: "pending", instanceId: facts.instanceId });
  }
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

/**
 * Decision 0132: the addresses whose `balanceOf` vouches for a segment of
 * one instance — its hot contracts first (the curve before graduation,
 * the PoolManager after: every trade moves them), then the addresses the
 * segment's transfers moved most (gross, ties by address), up to `max`.
 * The zero address is never sampled (supply covers it).
 */
export function selectLaunch2MemeBalanceSample(input: {
  readonly hot: readonly string[];
  readonly transfers: readonly {
    readonly from: string;
    readonly to: string;
    readonly amount: string;
  }[];
  readonly max?: number;
}): readonly string[] {
  const max = input.max ?? launch2MemeBalanceSampleSize;
  const zero = `0x${"0".repeat(40)}`;
  const picked: string[] = [];
  const add = (address: string): void => {
    const value = address.toLowerCase();
    if (
      picked.length < max &&
      /^0x[0-9a-f]{40}$/u.test(value) &&
      value !== zero &&
      !picked.includes(value)
    ) {
      picked.push(value);
    }
  };
  for (const address of input.hot) add(address);
  const gross = new Map<string, bigint>();
  for (const transfer of input.transfers) {
    let amount: bigint;
    try {
      amount = BigInt(transfer.amount);
    } catch {
      continue;
    }
    for (const side of [transfer.from, transfer.to]) {
      const key = side.toLowerCase();
      gross.set(key, (gross.get(key) ?? 0n) + amount);
    }
  }
  const ranked = [...gross.entries()].sort((a, b) =>
    a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1,
  );
  for (const [address] of ranked) add(address);
  return Object.freeze(picked);
}

/**
 * Decision 0132: the ledger (indexed transfers through the segment's last
 * block) against the chain at that block, both directions, plus supply.
 */
export function compareLaunch2MemeBalances(input: {
  readonly ledger: ReadonlyMap<string, bigint>;
  readonly ledgerSupply: bigint;
  readonly chain: ReadonlyMap<string, bigint>;
  readonly chainSupply: bigint;
}): Launch2MemeBalanceVerdict {
  let above = 0;
  let below = 0;
  for (const [address, onChain] of input.chain) {
    const indexed = input.ledger.get(address) ?? 0n;
    if (indexed > onChain) above += 1;
    else if (indexed < onChain) below += 1;
  }
  const gaps: Launch2MemeCoverageGap[] = [];
  if (above > 0) gaps.push("LEDGER_ABOVE_CHAIN");
  if (below > 0) gaps.push("LEDGER_BELOW_CHAIN");
  if (input.ledgerSupply !== input.chainSupply) gaps.push("SUPPLY_MISMATCH");
  if (gaps.length === 0) return Object.freeze({ kind: "verified" });
  return Object.freeze({
    kind: "mismatch",
    gaps: Object.freeze(gaps),
    mismatchedCount: above + below,
  });
}
