/**
 * Decision 0137 (S179-api): the two escrow exit paths of loop-contracts
 * S175 (Decision 0011) as the launch2 read model sees them.
 *
 * 1. Snapshot timeout: from `SnapshotRegistry.snapshotTimeoutAt()` =
 *    `nftSaleEnd + LoopLaunchFactory.snapshotTimeout()` anyone may call
 *    `openPublicAfterTimeout()` while no snapshot was published; the curve
 *    then opens straight into the public round (no early round, like the
 *    Decision 0122 zero-holder opening) and the registry emits
 *    `PublicRoundOpenedAfterTimeout`.
 * 2. Refund: from `NftEscrow.refundOpensAt()` = `min(rootPublishedAt,
 *    snapshotTimeoutAt) + refundDelay` (rootPublishedAt counted only when
 *    non-zero) until graduation, the current owner of each NFT may call
 *    `claimRefund(tokenId)` once (`RefundClaimed`).
 *
 * Capability is per Factory and fail closed: `snapshotTimeout()` answers →
 * supported (its timings are immutables, cached for the process); a revert
 * or a missing selector → unsupported (every testnet Factory deployed before
 * S175); an RPC failure is not cached (asked again next time). Unsupported
 * instances show `exitPaths: null` / `viewerNftRefunds: null`, the refund
 * routes answer 503 LAUNCH2_EXIT_PATHS_UNSUPPORTED, the lanes do nothing.
 */

export const launch2ExitReasonCodes = Object.freeze({
  /** 503 CAPABILITY_UNAVAILABLE: the instance's Factory predates S175. */
  unsupported: "LAUNCH2_EXIT_PATHS_UNSUPPORTED",
  /** 409 DATA_STALE: block time < `refundOpensAt()` (detailsSafe.opensAt). */
  refundNotOpen: "LAUNCH2_REFUND_NOT_OPEN",
  /** 409 DATA_STALE: `refunded(tokenId)` is already true. */
  refundAlreadyClaimed: "LAUNCH2_REFUND_ALREADY_CLAIMED",
  /** 403 POLICY_BLOCKED: the wallet is not `ownerOf(tokenId)` (or no such token). */
  refundNotOwner: "LAUNCH2_REFUND_NOT_OWNER",
  /** 409 DATA_STALE: the curve graduated; refunds are closed for good. */
  refundGraduated: "LAUNCH2_REFUND_GRADUATED",
  /** 409 INSUFFICIENT_BALANCE: `refundQuote` amount 0 (escrow emptied by a seizure). */
  refundNothing: "LAUNCH2_REFUND_NOTHING_TO_REFUND",
  /** 404: the report names no `nft_refund` intent of the caller on this instance. */
  refundIntentNotFound: "LAUNCH2_REFUND_INTENT_NOT_FOUND",
  /** 409 RESOURCE_CONFLICT: another hash was already reported for the intent. */
  refundTransactionConflict: "LAUNCH2_REFUND_TRANSACTION_CONFLICT",
  /** Publisher lane: `openPublicAfterTimeout()` recorded and sent. */
  timeoutOpenSent: "LAUNCH2_TIMEOUT_OPEN_SENT",
  /** Publisher lane: a timeout opening was due but is not sent (see detail). */
  timeoutOpenSkipped: "LAUNCH2_TIMEOUT_OPEN_SKIPPED",
} as const);

export interface Launch2ExitTiming {
  /** `LoopLaunchFactory.snapshotTimeout()` (seconds, 3,600..604,800). */
  readonly snapshotTimeout: bigint;
  /** `LoopLaunchFactory.refundDelay()` (seconds, 3,600..2,592,000). */
  readonly refundDelay: bigint;
}

export const launch2TimeoutOpenStates = Object.freeze([
  "not_applicable",
  "waiting",
  "available",
  "opened_by_timeout",
] as const);
export type Launch2TimeoutOpenState = (typeof launch2TimeoutOpenStates)[number];

export const launch2RefundStates = Object.freeze([
  "not_applicable",
  "waiting",
  "open",
  "closed_graduated",
] as const);
export type Launch2RefundState = (typeof launch2RefundStates)[number];

export interface Launch2ExitPathsInput {
  readonly nowSeconds: bigint;
  /** `ProjectNFT.saleEnd()` (= `SnapshotRegistry.nftSaleEnd()`). */
  readonly nftSaleEnd: bigint;
  readonly timing: Launch2ExitTiming;
  /**
   * Unix seconds the curve opened through a normal path (indexed
   * `SnapshotPublished.publishedAt` or `PublicRoundOpenedWithoutHolders`);
   * null while not opened that way.
   */
  readonly openedAt: bigint | null;
  /** Indexed `PublicRoundOpenedAfterTimeout.openedAt`; null otherwise. */
  readonly openedAfterTimeoutAt: bigint | null;
  readonly graduated: boolean;
  /** Indexed NFT mints (= `ProjectNFT.totalMinted()` once the lane caught up). */
  readonly totalMinted: bigint;
  /** Indexed `RefundClaimed` (distinct token ids). */
  readonly refundedCount: bigint;
}

export interface Launch2ExitPaths {
  readonly snapshotTimeoutAt: bigint;
  readonly timeoutOpenState: Launch2TimeoutOpenState;
  readonly refundOpensAt: bigint;
  readonly refundState: Launch2RefundState;
  readonly refundedCount: bigint;
  readonly totalMinted: bigint;
}

/**
 * The contract's own arithmetic over indexed facts: `snapshotTimeoutAt()`
 * and `refundOpensAt()` are pure functions of immutables and
 * `rootPublishedAt`, so they are recomputed rather than read per request.
 */
export function deriveLaunch2ExitPaths(
  input: Launch2ExitPathsInput,
): Launch2ExitPaths {
  const timeoutAt = input.nftSaleEnd + input.timing.snapshotTimeout;
  const rootPublishedAt = input.openedAfterTimeoutAt ?? input.openedAt;
  const start =
    rootPublishedAt !== null &&
    rootPublishedAt !== 0n &&
    rootPublishedAt < timeoutAt
      ? rootPublishedAt
      : timeoutAt;
  const refundOpensAt = start + input.timing.refundDelay;
  const now = input.nowSeconds;
  let timeoutOpenState: Launch2TimeoutOpenState;
  if (input.openedAfterTimeoutAt !== null) {
    timeoutOpenState = "opened_by_timeout";
  } else if (
    now < input.nftSaleEnd ||
    input.openedAt !== null ||
    input.graduated
  ) {
    timeoutOpenState = "not_applicable";
  } else if (now < timeoutAt) {
    timeoutOpenState = "waiting";
  } else {
    timeoutOpenState = "available";
  }
  let refundState: Launch2RefundState;
  if (input.totalMinted === 0n) {
    refundState = "not_applicable";
  } else if (input.graduated) {
    refundState = "closed_graduated";
  } else if (now < refundOpensAt) {
    refundState = "waiting";
  } else {
    refundState = "open";
  }
  return Object.freeze({
    snapshotTimeoutAt: timeoutAt,
    timeoutOpenState,
    refundOpensAt,
    refundState,
    refundedCount: input.refundedCount,
    totalMinted: input.totalMinted,
  });
}

/**
 * One Factory capability cache per process. `read` resolves the timings,
 * null for an unsupported Factory (revert / no selector), or throws on an
 * RPC failure — only settled answers are cached (Factory immutables).
 */
export interface Launch2ExitProbe {
  timingOf(factory: string): Promise<Launch2ExitTiming | null>;
}

export function createLaunch2ExitProbe(
  read: ((factory: string) => Promise<Launch2ExitTiming | null>) | undefined,
): Launch2ExitProbe {
  const settled = new Map<string, Launch2ExitTiming | null>();
  return Object.freeze({
    async timingOf(factory: string): Promise<Launch2ExitTiming | null> {
      if (read === undefined) return null;
      const key = factory.toLowerCase();
      if (settled.has(key)) return settled.get(key) ?? null;
      const timing = await read(key);
      if (settled.size > 256) settled.clear();
      settled.set(key, timing);
      return timing;
    },
  });
}

/** `^(0|[1-9][0-9]{0,77})$` and ≤ uint256 max. */
export function parseLaunch2TokenId(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/u.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  return parsed < 2n ** 256n ? parsed : null;
}
