import {
  addDecimalStrings,
  compareDecimalStrings,
  subtractDecimalStrings,
} from "../market/market-contract.js";
import type { MiningSnapshotPower } from "./mining-snapshot.js";

/**
 * Decision 0192: an account's snapshot self power split into the asset pool
 * (token holdings × weight) and the NFT pool (NFT units × coefficient).
 *
 * The pool part folds each NFT's power into its MEME row (Decision 0187)
 * and stores that share as the row's `nftPower`; every other row stores
 * `0`. The split is read back from the same rows that make the total:
 *
 *   nftPower   = Σ row.nftPower
 *   assetPower = power − nftPower
 *
 * exact decimal-string arithmetic, so `assetPower + nftPower = power`.
 * `null` (publish no split) when any row predates 0192 (no `nftPower`), or
 * the rows do not add up to `power` (never a guessed split).
 */
export interface MiningPoolSplit {
  readonly assetPower: string;
  readonly nftPower: string;
}

export function splitMiningSnapshotPower(
  power: string,
  rows: readonly Pick<MiningSnapshotPower, "power" | "nftPower">[],
): MiningPoolSplit | null {
  let rowPower = "0";
  let nftPower = "0";
  for (const row of rows) {
    if (row.nftPower === undefined || row.nftPower === null) {
      return null;
    }
    if (compareDecimalStrings(row.nftPower, row.power) > 0) {
      return null;
    }
    rowPower = addDecimalStrings(rowPower, row.power);
    nftPower = addDecimalStrings(nftPower, row.nftPower);
  }
  if (compareDecimalStrings(rowPower, power) !== 0) {
    return null;
  }
  return Object.freeze({
    assetPower: subtractDecimalStrings(power, nftPower),
    nftPower,
  });
}
