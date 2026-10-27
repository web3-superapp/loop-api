/**
 * Decision 0189: the pure roll-forward of one holder address of an `erc20`
 * external token for one hour — a balance reading at `readingBlock` plus the
 * indexed transfers after it. No clock, database, or network.
 */

/** Decision 0189 §5: an opening reading older than this is not used. */
export const miningErc20OpeningMaxAgeSeconds = 7n * 24n * 60n * 60n;

export interface MiningErc20TransferMove {
  readonly blockNumber: bigint;
  readonly logIndex: number;
  /** Signed: + into the holder, − out of it. */
  readonly deltaRaw: bigint;
  /** `observed_at` in unix seconds (the lane's clock; no block time). */
  readonly at: bigint;
}

export type MiningErc20Roll =
  | {
      readonly kind: "known";
      readonly openingRaw: bigint;
      /** In-hour moves, `at` non-decreasing. */
      readonly moves: readonly {
        readonly deltaRaw: bigint;
        readonly at: bigint;
      }[];
    }
  | { readonly kind: "inconsistent" };

/**
 * Transfers at or below the reading block are already in the reading and
 * are ignored. The rest are applied in **chain order** (block, log index);
 * a reorg replay only re-stamps `observed_at`, never the chain order, so the
 * balance check never depends on it. Each transfer's time is its
 * `observed_at`, but never earlier than the transfer before it in chain
 * order (a re-stamped earlier log moves later with its successors), so the
 * observed timeline agrees with the chain order. A transfer whose time is
 * before `hourStart` folds into the opening balance. A negative balance at
 * any step → inconsistent (the lane missed a transfer; counted 0).
 */
export function rollMiningErc20Holder(input: {
  readonly hourStart: bigint;
  readonly readingRaw: bigint;
  readonly readingBlock: bigint;
  readonly transfers: readonly MiningErc20TransferMove[];
}): MiningErc20Roll {
  const chainOrder = input.transfers
    .filter((move) => move.blockNumber > input.readingBlock)
    .sort((a, b) =>
      a.blockNumber !== b.blockNumber
        ? a.blockNumber < b.blockNumber
          ? -1
          : 1
        : a.logIndex - b.logIndex,
    );
  if (input.readingRaw < 0n) return { kind: "inconsistent" };
  let balance = input.readingRaw;
  let openingRaw = input.readingRaw;
  let previousAt: bigint | null = null;
  const moves: { deltaRaw: bigint; at: bigint }[] = [];
  for (const move of chainOrder) {
    balance += move.deltaRaw;
    if (balance < 0n) return { kind: "inconsistent" };
    const at: bigint =
      previousAt !== null && previousAt > move.at ? previousAt : move.at;
    previousAt = at;
    if (at < input.hourStart) openingRaw += move.deltaRaw;
    else moves.push(Object.freeze({ deltaRaw: move.deltaRaw, at }));
  }
  return Object.freeze({
    kind: "known" as const,
    openingRaw,
    moves: Object.freeze(moves),
  });
}
