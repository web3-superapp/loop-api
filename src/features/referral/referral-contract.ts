import { createHash } from "node:crypto";

import { z } from "zod";

import { v2ContractVersion } from "../meta/product-policy.js";
import { parseInviteCode, InvalidInviteCodeError } from "./invite-code.js";

/**
 * V2 referral wire contract (Decision 0036, 03 §7.2). Relationships are
 * Mining Power boosts, never revenue, commission, or rebates. A relationship
 * becomes `valid` only when an approved Mining formula exists (D19), so in
 * this step every edge stops at `pending_mining` and the boost stays
 * unavailable.
 */

export const referralCommandDigestVersion = "referral_command_v1" as const;
export const referralCommandIdempotencyScope = "v2_referral_command" as const;
export const referralMaximumDepth = 5;
/** Ancestor-chain scan bound for cycle detection; edges are still capped at 5. */
export const referralCycleScanDepth = 64;
/** Days after profile activation during which an invite code may be claimed. */
export const referralClaimWindowDays = 7;

export const referralValidationStatuses = [
  "pending_activation",
  "pending_wallet",
  "pending_mining",
  "valid",
  "invalidated",
] as const;
export type ReferralValidationStatus =
  (typeof referralValidationStatuses)[number];

export const referralReasonCodes = Object.freeze({
  boostPending: "MINING_FORMULA_BASELINE_PENDING",
  claimWindowClosed: "REFERRAL_CLAIM_WINDOW_CLOSED",
  claimWindowNotActivated: "PROFILE_ACTIVATION_REQUIRED",
  alreadyBound: "REFERRAL_ALREADY_BOUND",
  selfInvite: "REFERRAL_SELF_INVITE",
  cycle: "REFERRAL_CYCLE",
  codeUnknown: "REFERRAL_CODE_UNKNOWN",
} as const);

export const referralEventTypes = Object.freeze({
  codeIssued: "invite_code_issued",
  claimed: "referral_claimed",
  claimRejected: "referral_claim_rejected",
  statusChanged: "edge_status_changed",
} as const);

export class InvalidReferralRequestError extends Error {
  readonly code = "invalid_referral_request";

  constructor() {
    super("The V2 referral request is invalid");
    this.name = "InvalidReferralRequestError";
  }
}

const claimRequestSchema = z
  .object({ inviteCode: z.string().max(32) })
  .strict();

export function parseReferralClaimRequest(value: unknown): string {
  const parsed = claimRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidReferralRequestError();
  }
  try {
    return parseInviteCode(parsed.data.inviteCode);
  } catch (error) {
    if (error instanceof InvalidInviteCodeError) {
      throw new InvalidReferralRequestError();
    }
    throw error;
  }
}

export function referralCommandDigest(
  operation: string,
  parts: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(`loop:v2:referral:${referralCommandDigestVersion}`);
  for (const part of [operation, v2ContractVersion, ...parts]) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

/**
 * Claim window: `[activatedAt, activatedAt + 7 days)`. An unactivated
 * account has no window; the boundary is evaluated with the server clock.
 */
export function claimWindow(
  activatedAt: string | null,
  now: Date,
):
  | {
      readonly status: "open";
      readonly activatedAt: string;
      readonly closesAt: string;
    }
  | {
      readonly status: "closed";
      readonly activatedAt: string;
      readonly closesAt: string;
    }
  | { readonly status: "unavailable"; readonly reasonCode: string } {
  if (activatedAt === null) {
    return Object.freeze({
      status: "unavailable" as const,
      reasonCode: referralReasonCodes.claimWindowNotActivated,
    });
  }
  const activatedMs = Date.parse(activatedAt);
  if (!Number.isFinite(activatedMs)) {
    throw new InvalidReferralRequestError();
  }
  const closesAtMs = activatedMs + referralClaimWindowDays * 86_400_000;
  const closesAt = new Date(closesAtMs).toISOString();
  return now.getTime() < closesAtMs
    ? Object.freeze({ status: "open" as const, activatedAt, closesAt })
    : Object.freeze({ status: "closed" as const, activatedAt, closesAt });
}

/**
 * Validation status at claim time. Activation is a precondition of the
 * claim, so the lowest state a fresh edge can have is `pending_wallet`;
 * `valid` needs the D19 formula and is never produced here.
 */
export function initialValidationStatus(input: {
  readonly activated: boolean;
  readonly hasWallet: boolean;
}): ReferralValidationStatus {
  if (!input.activated) {
    return "pending_activation";
  }
  return input.hasWallet ? "pending_mining" : "pending_wallet";
}

/**
 * Materialised edges for a claim: the direct inviter at depth 1 and each
 * ancestor of the inviter at depth + 1, capped at `referralMaximumDepth`.
 * A cycle (the invitee already appears in the chain) is rejected.
 */
export function materializeReferralEdges(input: {
  readonly inviteeUserId: string;
  readonly inviterUserId: string;
  /** Inviter's ancestor chain: parent first, then grandparent, and so on. */
  readonly inviterAncestors: readonly string[];
}): readonly { readonly inviterUserId: string; readonly depth: number }[] {
  if (input.inviteeUserId === input.inviterUserId) {
    throw new ReferralSelfInviteError();
  }
  const chain = [input.inviterUserId, ...input.inviterAncestors];
  if (chain.includes(input.inviteeUserId)) {
    throw new ReferralCycleError();
  }
  return Object.freeze(
    chain
      .slice(0, referralMaximumDepth)
      .map((inviterUserId, index) =>
        Object.freeze({ inviterUserId, depth: index + 1 }),
      ),
  );
}

export class ReferralSelfInviteError extends Error {
  readonly code = "referral_self_invite";

  constructor() {
    super("An account cannot claim its own invite code");
    this.name = "ReferralSelfInviteError";
  }
}

export class ReferralCycleError extends Error {
  readonly code = "referral_cycle";

  constructor() {
    super("The claim would create a referral cycle");
    this.name = "ReferralCycleError";
  }
}

export interface UnavailableProjection {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export function unavailable(reasonCode: string): UnavailableProjection {
  return Object.freeze({ status: "unavailable", reasonCode });
}
