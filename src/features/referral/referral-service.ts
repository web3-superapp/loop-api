import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
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
  referralLegacyClaimWindowDays,
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
  type ReferralBoostRecord,
  type ReferralEdgeRecord,
  type ReferralInviteeKey,
  type ReferralInviteeRecord,
  type ReferralInviteeStatsRecord,
  type ReferralInviteeStatus,
  type ReferralRepository,
} from "./referral-repository.js";

/**
 * Referral service (Decision 0036). Claim admission, in order: request
 * shape → caller activated (409 PROFILE_ACTIVATION_REQUIRED; Decision 0181:
 * no time limit after that) → code resolves (404 NOT_FOUND, no
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

/** Decision 0162: the caller's referral power of the newest settled hour. */
export interface ReferralBoostProjection {
  readonly status: "available";
  readonly referralPower: string;
  readonly nftReferralPower: string;
  readonly assetReferralPower: string;
  readonly levels: ReferralBoostRecord["levels"];
  readonly epochId: string;
  readonly hourStart: string;
  readonly hourEnd: string;
}

export interface ReferralResource {
  readonly inviteCode: { readonly code: string; readonly issuedAt: string };
  /**
   * Decision 0162: `{PUBLIC_BASE_URL}/i/{code}` (Universal Link / App Link).
   * Decision 0166: absent unless REFERRAL_CENTER_EMIT is on.
   */
  readonly inviteLink?: string;
  readonly binding: ReferralBindingProjection;
  readonly levels: readonly ReferralLevelProjection[];
  /** Decision 0166: absent unless REFERRAL_CENTER_EMIT is on. */
  readonly stats?: {
    readonly directCount: number;
    readonly validCount: number;
    readonly level2to5Count: number;
    readonly validAsOf: string | null;
  };
  readonly boost: ReferralBoostProjection | UnavailableProjection;
  readonly rules: {
    readonly configVersion: typeof referralRulesConfigVersion;
    readonly effectiveAt: typeof referralRulesEffectiveAt;
    readonly appliesTo: "miningPower";
    readonly maximumDepth: typeof referralMaximumDepth;
    /** Decision 0181: deprecated, no longer enforced; App codec compat only. */
    readonly claimWindowDays: typeof referralLegacyClaimWindowDays;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ReferralClaimResource {
  readonly binding: ReferralBindingProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ReferralInviteeProjection {
  readonly publicProfileId: string | null;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  readonly boundAt: string;
  readonly validationStatus: ReferralInviteeStatus;
}

export interface ReferralInviteeListResource {
  readonly items: readonly ReferralInviteeProjection[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export const referralInviteePaging = Object.freeze({
  defaultLimit: 20,
  maximumLimit: 50,
});

/** Decision 0180: the website's invite panel serves 100 invitees a page. */
export const referralDashboardPageSize = 100;

/**
 * Decision 0180: the website's "my invites" panel. The same reads as the
 * App's invite center (`GET /v2/referral` + `GET /v2/referral/invitees`):
 * the lazily issued invite code, the direct edge and claim window, the
 * Decision 0162 stats of the newest settled hour, and the direct invitees
 * newest first. Independent of REFERRAL_CENTER_EMIT (an App codec switch).
 */
export interface ReferralDashboardResource {
  readonly inviteCode: { readonly code: string; readonly issuedAt: string };
  readonly inviteLink: string;
  /** A depth-1 edge exists (bound once, ever; invalidated edges count). */
  readonly bound: boolean;
  readonly claimWindow: ReturnType<typeof claimWindow>;
  /**
   * Null before the first settled mining hour (validity is unknown) or
   * when the stats read failed; never zeros in place of unknown.
   */
  readonly stats: ReferralInviteeStatsRecord | null;
  readonly invitees: readonly ReferralInviteeRecord[];
  readonly nextCursor: string | null;
}

const inviteeCursorRoute = "referralInvitees";
const inviteeCursorFilter = "depth=1";
const dashboardCursorRoute = "webReferralDashboard";

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
  listInvitees(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<ReferralInviteeListResource>;
  /** Decision 0180: the website's invite panel. */
  getDashboard(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly requestId: string;
    readonly cursor?: unknown;
  }): Promise<ReferralDashboardResource>;
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
  /** `PUBLIC_BASE_URL`: the origin that serves `/i/{code}` and the AASA. */
  readonly publicBaseUrl: string;
  /** Null keeps `GET /v2/referral/invitees` 503 V2_CURSOR_NOT_CONFIGURED. */
  readonly cursorCodec?: V2CursorCodec | null;
  /**
   * Decision 0166 (REFERRAL_CENTER_EMIT): whether `GET /v2/referral` carries
   * the Decision 0162 `inviteLink`, `stats`, and available `boost`. False
   * (default) keeps the pre-0162 shape that builds <= 30 decode strictly
   * (boost always unavailable) and skips the stats / boost reads.
   */
  readonly centerEmit?: boolean;
}): ReferralService {
  const { repository } = dependencies;
  const linkBase = dependencies.publicBaseUrl.replace(/\/+$/, "");
  const codec = dependencies.cursorCodec ?? null;
  const centerEmit = dependencies.centerEmit === true;

  async function boostOf(
    userId: string,
    epochId: string | null,
  ): Promise<ReferralBoostProjection | UnavailableProjection> {
    let record: ReferralBoostRecord | null;
    try {
      record = await repository.getReferralBoost(userId, epochId);
    } catch {
      // The boost is a derived figure: a failed read never fails the page.
      return unavailable(referralReasonCodes.boostPending);
    }
    if (record === null) {
      return unavailable(referralReasonCodes.boostPending);
    }
    return Object.freeze({
      status: "available" as const,
      referralPower: record.referralPower,
      nftReferralPower: record.nftReferralPower,
      assetReferralPower: record.assetReferralPower,
      levels: record.levels,
      epochId: record.epochId,
      hourStart: record.hourStart,
      hourEnd: record.hourEnd,
    });
  }

  function parsePage(
    ownerId: string,
    input: { readonly cursor?: unknown; readonly limit?: unknown },
  ): { readonly limit: number; readonly after: ReferralInviteeKey | null } {
    if (codec === null) {
      throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
        reasonCode: "V2_CURSOR_NOT_CONFIGURED",
      });
    }
    if (input.cursor !== undefined && input.limit !== undefined) {
      throw V2ApiError.invalidRequest();
    }
    if (input.cursor === undefined) {
      const limit = input.limit ?? referralInviteePaging.defaultLimit;
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > referralInviteePaging.maximumLimit
      ) {
        throw V2ApiError.invalidRequest();
      }
      return { limit, after: null };
    }
    if (typeof input.cursor !== "string") {
      throw V2ApiError.invalidRequest();
    }
    let continuation;
    try {
      continuation = codec.decode({
        ownerId,
        route: inviteeCursorRoute,
        filter: inviteeCursorFilter,
        cursor: input.cursor,
      });
    } catch (error) {
      if (error instanceof InvalidV2CursorError) {
        throw V2ApiError.invalidRequest();
      }
      throw error;
    }
    const limit = continuation["limit"];
    const boundAtKey = continuation["boundAt"];
    const referralEdgeId = continuation["edge"];
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > referralInviteePaging.maximumLimit ||
      typeof boundAtKey !== "string" ||
      typeof referralEdgeId !== "string"
    ) {
      throw V2ApiError.invalidRequest();
    }
    return { limit, after: { boundAtKey, referralEdgeId } };
  }

  function requireCodec(): V2CursorCodec {
    if (codec === null) {
      throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
        reasonCode: "V2_CURSOR_NOT_CONFIGURED",
      });
    }
    return codec;
  }

  function parseDashboardCursor(
    activeCodec: V2CursorCodec,
    ownerId: string,
    cursor: unknown,
  ): ReferralInviteeKey | null {
    if (cursor === undefined) {
      return null;
    }
    if (typeof cursor !== "string") {
      throw V2ApiError.invalidRequest();
    }
    let continuation;
    try {
      continuation = activeCodec.decode({
        ownerId,
        route: dashboardCursorRoute,
        filter: inviteeCursorFilter,
        cursor,
      });
    } catch (error) {
      if (error instanceof InvalidV2CursorError) {
        throw V2ApiError.invalidRequest();
      }
      throw error;
    }
    const boundAtKey = continuation["boundAt"];
    const referralEdgeId = continuation["edge"];
    if (typeof boundAtKey !== "string" || typeof referralEdgeId !== "string") {
      throw V2ApiError.invalidRequest();
    }
    return { boundAtKey, referralEdgeId };
  }

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
        // Decision 0162: one settled hour for counts, stats, and boost.
        const epochId = await repository.getLatestSettledEpochId();
        const [inviteCode, state, direct, counts, stats, boost] =
          await Promise.all([
            ensureInviteCode(ownerUserId, input.requestId),
            repository.getAccountState(ownerUserId),
            repository.getDirectEdge(ownerUserId),
            repository.countInvitees(ownerUserId, epochId),
            centerEmit
              ? repository.getInviteeStats(ownerUserId, epochId)
              : null,
            centerEmit
              ? boostOf(ownerUserId, epochId)
              : unavailable(referralReasonCodes.boostPending),
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
          ...(centerEmit
            ? { inviteLink: `${linkBase}/i/${inviteCode.code}` }
            : {}),
          binding: bindingProjection(direct, claimWindow(state.activatedAt)),
          levels: Object.freeze(levels),
          ...(stats === null
            ? {}
            : {
                stats: Object.freeze({
                  directCount: stats.directCount,
                  validCount: stats.validCount,
                  level2to5Count: stats.level2to5Count,
                  validAsOf: stats.validAsOf,
                }),
              }),
          boost,
          rules: Object.freeze({
            configVersion: referralRulesConfigVersion,
            effectiveAt: referralRulesEffectiveAt,
            appliesTo: "miningPower" as const,
            maximumDepth: referralMaximumDepth,
            claimWindowDays: referralLegacyClaimWindowDays,
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
        const window = claimWindow(state.activatedAt);
        if (window.status === "unavailable") {
          throw V2ApiError.fromCode("PROFILE_ACTIVATION_REQUIRED");
        }
        const inviterUserId = await repository.findInviterByCode(code);
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

    async listInvitees(input: Parameters<ReferralService["listInvitees"]>[0]) {
      try {
        const ownerUserId = input.principal.userId;
        const page = parsePage(ownerUserId, input);
        const rows = await repository.listDirectInvitees({
          inviterUserId: ownerUserId,
          after: page.after,
          limit: page.limit + 1,
        });
        const served = rows.slice(0, page.limit);
        const last = served.at(-1);
        const nextCursor =
          rows.length > page.limit && last !== undefined && codec !== null
            ? codec.encode({
                ownerId: ownerUserId,
                route: inviteeCursorRoute,
                filter: inviteeCursorFilter,
                continuation: {
                  limit: page.limit,
                  boundAt: last.boundAtKey,
                  edge: last.referralEdgeId,
                },
              })
            : null;
        return Object.freeze({
          items: Object.freeze(
            served.map((row) =>
              Object.freeze({
                publicProfileId: row.publicProfileId,
                alias: row.alias,
                avatarRef: row.avatarRef,
                boundAt: row.boundAt,
                validationStatus: row.validationStatus,
              }),
            ),
          ),
          nextCursor,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getDashboard(input: Parameters<ReferralService["getDashboard"]>[0]) {
      try {
        const ownerUserId = input.principal.userId;
        const activeCodec = requireCodec();
        const after = parseDashboardCursor(
          activeCodec,
          ownerUserId,
          input.cursor,
        );
        const epochId = await repository.getLatestSettledEpochId();
        const [inviteCode, state, direct, rows, stats] = await Promise.all([
          ensureInviteCode(ownerUserId, input.requestId),
          repository.getAccountState(ownerUserId),
          repository.getDirectEdge(ownerUserId),
          repository.listDirectInvitees({
            inviterUserId: ownerUserId,
            after,
            limit: referralDashboardPageSize + 1,
          }),
          epochId === null
            ? Promise.resolve(null)
            : repository
                .getInviteeStats(ownerUserId, epochId)
                // A derived figure: a failed read is unknown, never zeros.
                .catch(() => null),
        ]);
        const served = rows.slice(0, referralDashboardPageSize);
        const last = served.at(-1);
        const nextCursor =
          rows.length > referralDashboardPageSize && last !== undefined
            ? activeCodec.encode({
                ownerId: ownerUserId,
                route: dashboardCursorRoute,
                filter: inviteeCursorFilter,
                continuation: {
                  boundAt: last.boundAtKey,
                  edge: last.referralEdgeId,
                },
              })
            : null;
        return Object.freeze({
          inviteCode: Object.freeze({
            code: inviteCode.code,
            issuedAt: inviteCode.issuedAt,
          }),
          inviteLink: `${linkBase}/i/${inviteCode.code}`,
          bound: direct !== null,
          claimWindow: claimWindow(state.activatedAt),
          stats: stats === null || stats.validAsOf === null ? null : stats,
          invitees: Object.freeze(served),
          nextCursor,
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
    listInvitees: unavailableService,
    getDashboard: unavailableService,
  });
}
