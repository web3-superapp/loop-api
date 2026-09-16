import {
  miningReasonCodes,
  type UnavailableProjection,
} from "./mining-contract.js";
import type {
  CommunityWeightRecord,
  MiningCommunityStandingRecord,
} from "./mining-repository.js";

/**
 * The two facts that explain a community's Mining Power (Decision 0045):
 * the reviewed weight under the version in force and the number of members
 * holding positive power on the bound asset. `GET /v2/mining/communities/{id}`
 * and the community-side `miningPower` projection (community detail, member
 * directory, connection list) build both through these functions, so a
 * community card and its mining page can never disagree about either.
 */

export type MiningCommunityWeightProjection =
  | {
      readonly status: "approved";
      readonly value: string;
      readonly configVersion: string;
      readonly reviewedAt: string;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: string;
      readonly reviewStatus: "pending_review";
    };

export type MiningParticipantsProjection =
  | { readonly status: "available"; readonly count: number }
  | UnavailableProjection;

/** The reviewed weight as stored, or `pending_review` without one. */
export function projectCommunityWeight(
  record: CommunityWeightRecord,
): MiningCommunityWeightProjection {
  return record.status === "approved" &&
    record.weight !== null &&
    record.configVersion !== null &&
    record.reviewedAt !== null
    ? Object.freeze({
        status: "approved" as const,
        value: record.weight,
        configVersion: record.configVersion,
        reviewedAt: record.reviewedAt,
      })
    : Object.freeze({
        status: "unavailable" as const,
        reasonCode: miningReasonCodes.communityWeightPendingReview,
        reviewStatus: "pending_review" as const,
      });
}

/** Members with positive power on the bound asset in the standing's snapshot. */
export function projectParticipants(
  standing: Pick<MiningCommunityStandingRecord, "participantCount">,
): MiningParticipantsProjection {
  return Object.freeze({
    status: "available" as const,
    count: standing.participantCount,
  });
}
