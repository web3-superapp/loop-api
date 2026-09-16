import { resolveMiningBaseline } from "./mining-baseline.js";
import {
  projectCommunityWeight,
  projectParticipants,
  type MiningCommunityWeightProjection,
  type MiningParticipantsProjection,
} from "./mining-community-projection.js";
import {
  miningReasonCodes,
  unavailable,
  type MiningFormulaScope,
  type UnavailableProjection,
} from "./mining-contract.js";
import type { MiningRepository } from "./mining-repository.js";

/**
 * Mining Power as other modules project it (Decisions 0043 and 0045): the
 * community detail page's `miningPower`, a member row's, and a connection's.
 * Every value comes from the latest snapshot under the formula in force and
 * names that version's self-declared `scope`, so a client labels a
 * development baseline without parsing the version string. A community
 * subject also carries the two facts that explain its number — the reviewed
 * weight and the participant count — in exactly the shapes
 * `GET /v2/mining/communities/{id}` publishes, built by the same functions.
 * An account subject (a member row or a connection) is one person's total
 * power across assets; no single community weight explains it, so it
 * carries none. A subject that keeps `miningPowerVisibility: self` is
 * `MINING_POWER_PRIVATE` to everyone but themselves. Any repository failure
 * reads as unavailable; nothing is estimated in place of a stored number.
 */

export const miningPowerSubjects = ["community", "account"] as const;
export type MiningPowerSubject = (typeof miningPowerSubjects)[number];

interface AvailableMiningPowerBase {
  readonly status: "available";
  readonly power: string;
  readonly snapshotId: string;
  readonly formulaVersion: string;
  readonly computedAt: string;
  /** `formula.scope` of the version in force; null for a product version. */
  readonly scope: MiningFormulaScope | null;
}

export interface AvailableCommunityMiningPowerProjection extends AvailableMiningPowerBase {
  readonly subject: "community";
  readonly weight: MiningCommunityWeightProjection;
  readonly participants: MiningParticipantsProjection;
}

export interface AvailableAccountMiningPowerProjection extends AvailableMiningPowerBase {
  readonly subject: "account";
}

export type AvailableMiningPowerProjection =
  | AvailableCommunityMiningPowerProjection
  | AvailableAccountMiningPowerProjection;

export type MiningPowerProjection =
  AvailableMiningPowerProjection | UnavailableProjection;

export interface CommunityMiningPowerReader {
  readCommunityPower(communityId: string): Promise<MiningPowerProjection>;
  /**
   * Keyed by public profile ID. A profile absent from the result had no
   * `user_profiles` row; the caller projects it as not in the snapshot.
   */
  readMemberPowers(input: {
    readonly viewerUserId: string;
    readonly publicProfileIds: readonly string[];
  }): Promise<ReadonlyMap<string, MiningPowerProjection>>;
}

export function createMiningPowerReader(dependencies: {
  readonly repository: MiningRepository;
  readonly now?: () => Date;
}): CommunityMiningPowerReader {
  const { repository } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  const reader: CommunityMiningPowerReader = {
    async readCommunityPower(communityId) {
      try {
        const baseline = await resolveMiningBaseline(repository, now());
        if (baseline.status === "pending") {
          return unavailable(miningReasonCodes.formulaBaselinePending);
        }
        if (baseline.snapshot === null) {
          return unavailable(baseline.snapshotReasonCode);
        }
        const standing = await repository.getCommunityStanding({
          snapshotId: baseline.snapshot.snapshotId,
          configVersion: baseline.formula.configVersion,
          communityId,
        });
        // The weight record is read on both branches: it names the reason
        // when there is no standing, and it is the published weight when
        // there is one (the standing's own weight column is the same stored
        // number, but only the record carries configVersion and reviewedAt).
        const weight = await repository.getCommunityWeight(communityId);
        if (standing === null) {
          return unavailable(
            weight === null || weight.boundAssetId === null
              ? miningReasonCodes.communityAssetNotBound
              : miningReasonCodes.communityWeightPendingReview,
          );
        }
        if (weight === null) {
          // A standing exists only for a community with an approved weight;
          // losing the record between the two reads is a runtime fault.
          return unavailable(miningReasonCodes.runtimeUnavailable);
        }
        return Object.freeze({
          status: "available" as const,
          subject: "community" as const,
          power: standing.power,
          snapshotId: baseline.snapshot.snapshotId,
          formulaVersion: baseline.snapshot.formulaVersion,
          computedAt: baseline.snapshot.computedAt,
          scope: baseline.formula.formula.scope ?? null,
          weight: projectCommunityWeight(weight),
          participants: projectParticipants(standing),
        });
      } catch {
        return unavailable(miningReasonCodes.runtimeUnavailable);
      }
    },

    async readMemberPowers(input) {
      const result = new Map<string, MiningPowerProjection>();
      if (input.publicProfileIds.length === 0) {
        return result;
      }
      try {
        const baseline = await resolveMiningBaseline(repository, now());
        if (baseline.status === "pending") {
          for (const id of input.publicProfileIds) {
            result.set(
              id,
              unavailable(miningReasonCodes.formulaBaselinePending),
            );
          }
          return result;
        }
        if (baseline.snapshot === null) {
          const reason = unavailable(baseline.snapshotReasonCode);
          for (const id of input.publicProfileIds) {
            result.set(id, reason);
          }
          return result;
        }
        const snapshot = baseline.snapshot;
        const scope = baseline.formula.formula.scope ?? null;
        const rows = await repository.listMemberPowers({
          snapshotId: snapshot.snapshotId,
          publicProfileIds: input.publicProfileIds,
        });
        for (const row of rows) {
          const isSelf = row.ownerUserId === input.viewerUserId;
          if (!isSelf && !row.visibleToOthers) {
            result.set(
              row.publicProfileId,
              unavailable(miningReasonCodes.powerPrivate),
            );
          } else if (row.totalPower === null) {
            result.set(
              row.publicProfileId,
              unavailable(miningReasonCodes.accountNotInSnapshot),
            );
          } else {
            result.set(
              row.publicProfileId,
              Object.freeze({
                status: "available" as const,
                subject: "account" as const,
                power: row.totalPower,
                snapshotId: snapshot.snapshotId,
                formulaVersion: snapshot.formulaVersion,
                computedAt: snapshot.computedAt,
                scope,
              }),
            );
          }
        }
        return result;
      } catch {
        result.clear();
        for (const id of input.publicProfileIds) {
          result.set(id, unavailable(miningReasonCodes.runtimeUnavailable));
        }
        return result;
      }
    },
  };
  return Object.freeze(reader);
}

/** For processes without a mining repository: every subject is unavailable. */
export function createUnavailableMiningPowerReader(
  reasonCode: string = miningReasonCodes.runtimeUnavailable,
): CommunityMiningPowerReader {
  const reader: CommunityMiningPowerReader = {
    readCommunityPower: () => Promise.resolve(unavailable(reasonCode)),
    readMemberPowers: (input) =>
      Promise.resolve(
        new Map<string, MiningPowerProjection>(
          input.publicProfileIds.map((id) => [id, unavailable(reasonCode)]),
        ),
      ),
  };
  return Object.freeze(reader);
}
