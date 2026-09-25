import type {
  LaunchAllowlistMode,
  LaunchAllowlistRootRecord,
  LaunchChainRepository,
} from "./launch-chain-repository.js";
import type { LaunchEligibilityTier } from "./launch-contract.js";
import { buildLaunchMerkleTree } from "./launch-merkle.js";

/**
 * Eligibility evaluators (tierModeV1, Decision 0077). A mode decides WHO is
 * in a round's allowlist at one snapshot block; the Merkle tree of that set
 * is computed once, stored append-only, and its root is what the operator
 * writes into the round on chain. At read time the chain root selects the
 * stored set; LOOP never recomputes membership against a moving present.
 */

export const launchEligibilityReasonCodes = Object.freeze({
  rootMismatch: "LAUNCH_ALLOWLIST_ROOT_MISMATCH",
  rootNotComputed: "LAUNCH_ALLOWLIST_NOT_COMPUTED",
  modeMismatch: "LAUNCH_ALLOWLIST_MODE_MISMATCH",
  walletNotEligible: "LAUNCH_WALLET_NOT_ELIGIBLE",
  walletNotFound: "LAUNCH_WALLET_NOT_FOUND",
  roundNotFound: "LAUNCH_ROUND_NOT_FOUND",
  communityNotConfigured: "LAUNCH_ELIGIBILITY_COMMUNITY_NOT_CONFIGURED",
  allowlistEmpty: "LAUNCH_ALLOWLIST_EMPTY",
} as const);

/** Activity window of `tierModeV1 = activity`: 30 days before the snapshot. */
export const launchActivityWindowMs = 30 * 24 * 60 * 60 * 1000;

const zeroRoot = `0x${"0".repeat(64)}`;

export function isOpenRoot(root: string): boolean {
  return root.toLowerCase() === zeroRoot;
}

/**
 * The tier a member is published with: the round's own configured tier when
 * LOOP has one, otherwise the mode's default (whitelist → priority,
 * community and activity → community). A non-member has no tier.
 */
export function tierForMember(
  mode: LaunchAllowlistMode,
  roundTier: LaunchEligibilityTier | null,
): LaunchEligibilityTier {
  if (roundTier !== null) {
    return roundTier;
  }
  return mode === "whitelist" ? "priority" : "community";
}

export class LaunchEligibilityInputError extends Error {
  readonly code = "launch_eligibility_input_invalid";

  constructor(readonly reasonCode: string) {
    super("The eligibility evaluation cannot run");
    this.name = "LaunchEligibilityInputError";
  }
}

/** Who is in the allowlist of one round at one snapshot, per mode. */
export async function evaluateAllowlistMembers(input: {
  readonly repository: LaunchChainRepository;
  readonly mode: LaunchAllowlistMode;
  readonly launchId: string;
  readonly roundIndex: number;
  /** ISO time of the snapshot block. */
  readonly snapshotTime: string;
  readonly communityId: string | null;
}): Promise<readonly string[]> {
  switch (input.mode) {
    case "whitelist": {
      return input.repository.listAllowlist(input.launchId, input.roundIndex);
    }
    case "community": {
      if (input.communityId === null) {
        throw new LaunchEligibilityInputError(
          launchEligibilityReasonCodes.communityNotConfigured,
        );
      }
      return input.repository.listCommunityMemberWallets({
        communityId: input.communityId,
        at: input.snapshotTime,
      });
    }
    case "activity": {
      const until = new Date(input.snapshotTime);
      return input.repository.listActiveMinerWallets({
        since: new Date(until.getTime() - launchActivityWindowMs).toISOString(),
        until: until.toISOString(),
      });
    }
  }
}

export type LaunchEligibilityDecision =
  | {
      readonly status: "open";
    }
  | {
      readonly status: "member";
      readonly root: LaunchAllowlistRootRecord;
      readonly proof: readonly string[];
    }
  | {
      readonly status: "not_member";
      readonly root: LaunchAllowlistRootRecord;
    }
  | {
      readonly status: "refused";
      readonly reasonCode: string;
    };

/**
 * Selects the stored set whose root equals the chain's `allowlistRoot` and
 * answers for one wallet. The stored members are rebuilt into a tree and the
 * rebuilt root must equal the stored one, so a tampered row cannot produce
 * a proof.
 */
export function decideEligibility(input: {
  readonly chainRoot: string;
  readonly roots: readonly LaunchAllowlistRootRecord[];
  readonly mode: LaunchAllowlistMode | null;
  readonly walletAddress: string;
}): LaunchEligibilityDecision {
  if (isOpenRoot(input.chainRoot)) {
    return Object.freeze({ status: "open" as const });
  }
  if (input.roots.length === 0) {
    return Object.freeze({
      status: "refused" as const,
      reasonCode: launchEligibilityReasonCodes.rootNotComputed,
    });
  }
  const match = input.roots.find(
    (root) => root.root === input.chainRoot.toLowerCase(),
  );
  if (match === undefined) {
    return Object.freeze({
      status: "refused" as const,
      reasonCode: launchEligibilityReasonCodes.rootMismatch,
    });
  }
  if (input.mode !== null && match.mode !== input.mode) {
    return Object.freeze({
      status: "refused" as const,
      reasonCode: launchEligibilityReasonCodes.modeMismatch,
    });
  }
  const tree = buildLaunchMerkleTree(match.members);
  if (tree.root !== match.root) {
    return Object.freeze({
      status: "refused" as const,
      reasonCode: launchEligibilityReasonCodes.rootMismatch,
    });
  }
  const proof = tree.proofFor(input.walletAddress);
  return proof === null
    ? Object.freeze({ status: "not_member" as const, root: match })
    : Object.freeze({ status: "member" as const, root: match, proof });
}
