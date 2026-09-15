import {
  miningReasonCodes,
  type MiningFormulaScope,
} from "./mining-contract.js";
import {
  MiningRepositoryUnavailableError,
  type MiningFormulaRecord,
  type MiningRepository,
  type MiningSnapshotRecord,
} from "./mining-repository.js";

/**
 * The single answer to "is there a Mining formula in force, and which
 * snapshot belongs to it" (Decision 0043). Every read path — the mining
 * routes, the community projections, and the `communityMining` capability —
 * resolves through this function so they can never disagree about the
 * baseline.
 *
 * A version is in force when it is `approved` and its `effectiveAt` is not
 * in the future. The latest snapshot belongs to it only when the snapshot
 * was computed under the same `configVersion`; otherwise the snapshot is
 * reported stale and no number derived from it is published.
 */

export type MiningBaselineResolution =
  | {
      readonly status: "approved";
      readonly formula: MiningFormulaRecord;
      /** The latest snapshot, computed under `formula.configVersion`. */
      readonly snapshot: MiningSnapshotRecord;
      readonly snapshotReasonCode: null;
    }
  | {
      readonly status: "approved";
      readonly formula: MiningFormulaRecord;
      readonly snapshot: null;
      /** Not computed yet, or computed under another version (stale). */
      readonly snapshotReasonCode: string;
    }
  | { readonly status: "pending" };

/** A resolution that carries no usable snapshot. */
export type MiningBaselineWithoutSnapshot = Exclude<
  MiningBaselineResolution,
  { readonly snapshot: MiningSnapshotRecord }
>;

export function hasNoMiningSnapshot(
  resolution: MiningBaselineResolution,
): resolution is MiningBaselineWithoutSnapshot {
  return resolution.status === "pending" || resolution.snapshot === null;
}

export async function resolveMiningBaseline(
  repository: Pick<
    MiningRepository,
    "getApprovedFormula" | "getLatestSnapshot"
  >,
  now: Date = new Date(),
): Promise<MiningBaselineResolution> {
  const formula = await repository.getApprovedFormula();
  if (
    formula === null ||
    formula.status !== "approved" ||
    formula.effectiveAt === null ||
    Date.parse(formula.effectiveAt) > now.getTime()
  ) {
    return Object.freeze({ status: "pending" });
  }
  const latest = await repository.getLatestSnapshot();
  if (latest === null) {
    return Object.freeze({
      status: "approved",
      formula,
      snapshot: null,
      snapshotReasonCode: miningReasonCodes.snapshotNotAvailable,
    });
  }
  if (latest.formulaVersion !== formula.configVersion) {
    return Object.freeze({
      status: "approved",
      formula,
      snapshot: null,
      snapshotReasonCode: miningReasonCodes.snapshotStale,
    });
  }
  return Object.freeze({
    status: "approved",
    formula,
    snapshot: latest,
    snapshotReasonCode: null,
  });
}

/**
 * What the capability projection needs: whether a version is in force, and
 * its self-declared scope so the client can label a development baseline.
 */
export type MiningFormulaBaselineState =
  | {
      readonly status: "approved";
      readonly configVersion: string;
      readonly effectiveAt: string;
      readonly scope: MiningFormulaScope | null;
    }
  | { readonly status: "pending" }
  | { readonly status: "unavailable" };

export type MiningFormulaBaselineProbe =
  () => Promise<MiningFormulaBaselineState>;

/**
 * Per-request probe over the repository. A repository failure is reported as
 * `unavailable`, never as pending: the two mean different things to an
 * operator, and neither opens the capability.
 */
export function createMiningFormulaBaselineProbe(
  repository: Pick<
    MiningRepository,
    "getApprovedFormula" | "getLatestSnapshot"
  >,
  now: () => Date = () => new Date(),
): MiningFormulaBaselineProbe {
  return async () => {
    let resolution: MiningBaselineResolution;
    try {
      resolution = await resolveMiningBaseline(repository, now());
    } catch (error) {
      if (error instanceof MiningRepositoryUnavailableError) {
        return Object.freeze({ status: "unavailable" });
      }
      throw error;
    }
    if (resolution.status === "pending") {
      return Object.freeze({ status: "pending" });
    }
    return Object.freeze({
      status: "approved",
      configVersion: resolution.formula.configVersion,
      effectiveAt: resolution.formula.effectiveAt ?? "",
      scope: resolution.formula.formula.scope ?? null,
    });
  };
}

/** A probe for processes with no mining repository at all. */
export function createUnavailableMiningFormulaBaselineProbe(): MiningFormulaBaselineProbe {
  return () => Promise.resolve(Object.freeze({ status: "unavailable" }));
}
