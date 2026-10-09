import {
  miningReasonCodes,
  type MiningFormulaScope,
} from "./mining-contract.js";
import {
  MiningRepositoryUnavailableError,
  type MiningFormulaRecord,
  type MiningRepository,
  type MiningSnapshotAttemptRecord,
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
 * in the future. The latest *complete* snapshot belongs to it only when it
 * was computed under the same `configVersion`; otherwise the snapshot is
 * reported stale and no number derived from it is published.
 *
 * Decision 0057: the newest run under the version may be an `incomplete`
 * attempt (a held asset could not be valued) or an `invalidated` snapshot.
 * Neither carries numbers. When a complete snapshot exists under the
 * version the numbers come from it and the resolution is `stale`; when
 * none exists the numbers are `MINING_SNAPSHOT_INCOMPLETE` (attempt
 * incomplete) or `MINING_SNAPSHOT_NOT_AVAILABLE` (nothing usable).
 */

export type MiningBaselineResolution =
  | {
      readonly status: "approved";
      readonly formula: MiningFormulaRecord;
      /** The latest complete snapshot, computed under `formula.configVersion`. */
      readonly snapshot: MiningSnapshotRecord;
      readonly snapshotReasonCode: null;
      /** A newer attempt under the version did not complete. */
      readonly stale: boolean;
      /** The newest run under the version: this snapshot when not stale. */
      readonly latestAttempt: MiningSnapshotAttemptRecord;
    }
  | {
      readonly status: "approved";
      readonly formula: MiningFormulaRecord;
      readonly snapshot: null;
      /** Not computed yet, incomplete, or computed under another version (stale). */
      readonly snapshotReasonCode: string;
      readonly stale: false;
      /** The newest run under the version, if any (incomplete or invalidated). */
      readonly latestAttempt: MiningSnapshotAttemptRecord | null;
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

export type MiningBaselineRepository = Pick<
  MiningRepository,
  "getApprovedFormula" | "getLatestSnapshot" | "getLatestSnapshotAttempt"
>;

export async function resolveMiningBaseline(
  repository: MiningBaselineRepository,
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
  const [latest, latestAttempt] = await Promise.all([
    repository.getLatestSnapshot(),
    repository.getLatestSnapshotAttempt(formula.configVersion),
  ]);
  if (latest !== null && latest.formulaVersion === formula.configVersion) {
    // The newest run under the version is this snapshot unless a later
    // attempt did not complete; a repository that answers no attempt for a
    // snapshot it just returned is inconsistent, so the snapshot itself is
    // the attempt of record.
    const attempt: MiningSnapshotAttemptRecord =
      latestAttempt ?? attemptOf(latest);
    return Object.freeze({
      status: "approved",
      formula,
      snapshot: latest,
      snapshotReasonCode: null,
      stale: attempt.snapshotId !== latest.snapshotId,
      latestAttempt: attempt,
    });
  }
  if (latestAttempt !== null && latestAttempt.status === "incomplete") {
    return Object.freeze({
      status: "approved",
      formula,
      snapshot: null,
      snapshotReasonCode: miningReasonCodes.snapshotIncomplete,
      stale: false,
      latestAttempt,
    });
  }
  return Object.freeze({
    status: "approved",
    formula,
    snapshot: null,
    snapshotReasonCode:
      latest === null
        ? miningReasonCodes.snapshotNotAvailable
        : miningReasonCodes.snapshotStale,
    stale: false,
    latestAttempt,
  });
}

/** A complete snapshot viewed as the attempt it was. */
export function attemptOf(
  snapshot: MiningSnapshotRecord,
): MiningSnapshotAttemptRecord {
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    status: "complete",
    formulaVersion: snapshot.formulaVersion,
    blockNumber: snapshot.blockNumber,
    computedAt: snapshot.computedAt,
    unreadInputs: Object.freeze([]),
    invalidatedAt: null,
    invalidationReason: null,
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
  repository: MiningBaselineRepository,
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
