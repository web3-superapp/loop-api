import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  referralRulesConfigVersion,
  referralRulesEffectiveAt,
  referralRulesV1,
} from "../community/referral-rules.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  generateInviteCode,
  maximumInviteCodeAllocationAttempts,
} from "./invite-code.js";
import {
  InvalidReferralRequestError,
  ReferralCycleError,
  ReferralSelfInviteError,
  claimWindow,
  initialValidationStatus,
  materializeReferralEdges,
  parseReferralClaimRequest,
  referralCommandDigest,
  referralCycleScanDepth,
  referralMaximumDepth,
  referralReasonCodes,
  referralValidationStatuses,
  unavailable,
  type ReferralValidationStatus,
  type UnavailableProjection,
} from "./referral-contract.js";
import {
  ReferralAlreadyBoundError,
  ReferralCodeTakenError,
  ReferralIdempotencyConflictError,
  ReferralRepositoryUnavailableError,
  type ReferralEdgeRecord,
  type ReferralRepository,
} from "./referral-repository.js";

/**
 * Referral service (Decision 0036). Claim admission, in order: request
 * shape → caller activated (409 PROFILE_ACTIVATION_REQUIRED) → inside the
 * 7-day window (403 POLICY_BLOCKED) → code resolves (404 NOT_FOUND, no
 * enumeration) → not self (422) → no cycle (422) → not already bound
 * (409 DATA_STALE) → edges written up to depth 5 in one transaction.
 */

export interface ReferralLevelProjection {
  readonly level: number;
  readonly boostPercent: string;
  readonly counts: Readonly<Record<ReferralValidationStatus, number>>;
  readonly total: number;
}

export interface ReferralBindingProjection {
  readonly status: "bound" | "unbound";
  readonly inviter: {
    readonly depth: 1;
    readonly validationStatus: ReferralValidationStatus;
    readonly lockedAt: string;
    readonly effectiveFrom: string;
    readonly configVersion: string;
  } | null;
  readonly claimWindow: ReturnType<typeof claimWindow>;
}

export interface ReferralResource {
  readonly inviteCode: { readonly code: string; readonly issuedAt: string };
  readonly binding: ReferralBindingProjection;
  readonly levels: readonly ReferralLevelProjection[];
  readonly boost: UnavailableProjection;
  readonly rules: {
    readonly configVersion: typeof referralRulesConfigVersion;
    readonly effectiveAt: typeof referralRulesEffectiveAt;
    readonly appliesTo: "miningPower";
    readonly maximumDepth: typeof referralMaximumDepth;
    readonly claimWindowDays: 7;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ReferralClaimResource {
  readonly binding: ReferralBindingProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ReferralService {
  getReferral(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly requestId: string;
  }): Promise<ReferralResource>;
  claim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly body: unknown;
  }): Promise<ReferralClaimResource>;
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof InvalidReferralRequestError) {
    throw V2ApiError.invalidRequest();
  }
  if (
    error instanceof ReferralSelfInviteError ||
    error instanceof ReferralCycleError
  ) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  if (error instanceof ReferralAlreadyBoundError) {
    throw V2ApiError.fromCode("DATA_STALE");
  }
  if (error instanceof ReferralIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (
    error instanceof ReferralRepositoryUnavailableError ||
    error instanceof ReferralCodeTakenError
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

function bindingProjection(
  edge: ReferralEdgeRecord | null,
  window: ReturnType<typeof claimWindow>,
): ReferralBindingProjection {
  return Object.freeze({
    status: edge === null ? ("unbound" as const) : ("bound" as const),
    inviter:
      edge === null
        ? null
        : Object.freeze({
            depth: 1 as const,
            validationStatus: edge.validationStatus,
            lockedAt: edge.lockedAt,
            effectiveFrom: edge.effectiveFrom,
            configVersion: edge.configVersion,
          }),
    claimWindow: window,
  });
}

export function createReferralService(dependencies: {
  readonly repository: ReferralRepository;
  readonly now?: () => Date;
}): ReferralService {
  const { repository } = dependencies;
  const now = dependencies.now ?? ((): Date => new Date());

  async function ensureInviteCode(
    ownerUserId: string,
    requestId: string,
  ): Promise<{ readonly code: string; readonly issuedAt: string }> {
    const existing = await repository.getInviteCode(ownerUserId);
    if (existing !== null) {
      return existing;
    }
    for (
      let attempt = 0;
      attempt < maximumInviteCodeAllocationAttempts;
      attempt += 1
    ) {
      try {
        return await repository.issueInviteCode({
          ownerUserId,
          code: generateInviteCode(),
          requestId,
        });
      } catch (error) {
        if (!(error instanceof ReferralCodeTakenError)) {
          throw error;
        }
      }
    }
    throw new ReferralCodeTakenError();
  }

  return Object.freeze({
    async getReferral(input: Parameters<ReferralService["getReferral"]>[0]) {
      try {
        const ownerUserId = input.principal.userId;
        const [inviteCode, state, direct, counts] = await Promise.all([
          ensureInviteCode(ownerUserId, input.requestId),
          repository.getAccountState(ownerUserId),
          repository.getDirectEdge(ownerUserId),
          repository.countInvitees(ownerUserId),
        ]);
        const levels = referralRulesV1.levels.map((rule) => {
          const perStatus = Object.fromEntries(
            referralValidationStatuses.map((status) => [status, 0]),
          ) as Record<ReferralValidationStatus, number>;
          let total = 0;
          for (const row of counts) {
            if (row.depth === rule.level) {
              perStatus[row.validationStatus] = row.count;
              total += row.count;
            }
          }
          return Object.freeze({
            level: rule.level,
            boostPercent: rule.boostPercent,
            counts: Object.freeze(perStatus),
            total,
          });
        });
        return Object.freeze({
          inviteCode: Object.freeze({
            code: inviteCode.code,
            issuedAt: inviteCode.issuedAt,
          }),
          binding: bindingProjection(
            direct,
            claimWindow(state.activatedAt, now()),
          ),
          levels: Object.freeze(levels),
          boost: unavailable(referralReasonCodes.boostPending),
          rules: Object.freeze({
            configVersion: referralRulesConfigVersion,
            effectiveAt: referralRulesEffectiveAt,
            appliesTo: "miningPower" as const,
            maximumDepth: referralMaximumDepth,
            claimWindowDays: 7 as const,
          }),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async claim(input: Parameters<ReferralService["claim"]>[0]) {
      try {
        const inviteeUserId = input.principal.userId;
        const code = parseReferralClaimRequest(input.body);
        const state = await repository.getAccountState(inviteeUserId);
        const window = claimWindow(state.activatedAt, now());
        if (window.status === "unavailable") {
          throw V2ApiError.fromCode("PROFILE_ACTIVATION_REQUIRED");
        }
        const inviterUserId = await repository.findInviterByCode(code);
        if (window.status === "closed") {
          await repository.recordRejectedClaim({
            inviteeUserId,
            inviterUserId,
            reasonCode: "claim_window_closed",
            requestId: input.requestId,
          });
          throw V2ApiError.fromCode("POLICY_BLOCKED");
        }
        if (inviterUserId === null) {
          // Unknown codes are not enumerable: same answer as any missing resource.
          throw V2ApiError.notFound();
        }
        let edges: ReturnType<typeof materializeReferralEdges>;
        try {
          edges = materializeReferralEdges({
            inviteeUserId,
            inviterUserId,
            inviterAncestors: await repository.getAncestorChain(
              inviterUserId,
              referralCycleScanDepth,
            ),
          });
        } catch (error) {
          if (
            error instanceof ReferralSelfInviteError ||
            error instanceof ReferralCycleError
          ) {
            await repository.recordRejectedClaim({
              inviteeUserId,
              inviterUserId,
              reasonCode:
                error instanceof ReferralSelfInviteError
                  ? "self_invite"
                  : "referral_cycle",
              requestId: input.requestId,
            });
          }
          throw error;
        }
        const edge = await repository.claim({
          inviteeUserId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: referralCommandDigest("claim", [code]),
          requestId: input.requestId,
          edges,
          validationStatus: initialValidationStatus({
            activated: true,
            hasWallet: state.hasWallet,
          }),
        });
        return Object.freeze({
          binding: bindingProjection(edge, window),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },
  });
}

export function createUnavailableReferralService(): ReferralService {
  const unavailableService = () =>
    Promise.reject(V2ApiError.capabilityUnavailable());
  return Object.freeze({
    getReferral: unavailableService,
    claim: unavailableService,
  });
}
