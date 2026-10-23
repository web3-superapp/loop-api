import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type { VerifiedPrivyPrincipal } from "../../integrations/privy/access-token-verifier.js";
import type { InternalUserRepository } from "../identity/internal-user-repository.js";
import { LoopIdAllocationExhaustedError } from "../identity/loop-id.js";
import type { ProfileV2Resource } from "../profile/profile-v2-contract.js";
import type { ProfileV2Service } from "../profile/profile-v2-service.js";
import {
  InvalidInviteCodeError,
  parseInviteCode,
} from "../referral/invite-code.js";
import { claimWindow } from "../referral/referral-contract.js";
import type { ReferralService } from "../referral/referral-service.js";
import {
  webReasonCodes,
  type WebClaimResource,
  type WebInvitePreviewResource,
  type WebMetaResource,
  type WebSessionResource,
  type WebUsernameResource,
  type WebWriteMetadata,
} from "./web-registration-contract.js";
import {
  WebRegistrationRepositoryUnavailableError,
  type WebRegistrationRepository,
} from "./web-registration-repository.js";

/**
 * Decision 0179: the website's registration flow on the same Privy App.
 *
 * - session: the verified Privy subject gets (or keeps) its LOOP account —
 *   the same `getOrCreateByPrivyUserId` the App's bootstrap uses, so the App
 *   later signing in with the same Privy login lands on the same account.
 *   No device session is created (a browser is not an App install).
 * - username: the V2 profile alias. A pending profile is activated through
 *   the App's activation command (same rules, same Idempotency-Key replay);
 *   an active profile has its alias replaced through the App's CAS write.
 * - claim: the App's referral claim service, unchanged; the web answer adds
 *   `already_bound` and a `reasonCode` on refusals.
 * - preview: the code owner's LOOP ID and active alias only.
 */

export interface WebRegistrationService {
  session(input: {
    readonly principal: VerifiedPrivyPrincipal;
  }): Promise<WebSessionResource>;
  setUsername(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly username: string;
    readonly metadata: WebWriteMetadata;
    readonly requestId: string;
  }): Promise<WebUsernameResource>;
  claim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly code: string;
    readonly metadata: WebWriteMetadata;
    readonly requestId: string;
  }): Promise<WebClaimResource>;
  preview(input: { readonly code: unknown }): Promise<WebInvitePreviewResource>;
  meta(): WebMetaResource;
}

export interface WebRegistrationServiceOptions {
  /** `V2_SESSION_ENABLED`: off answers the session 503 like the App's. */
  readonly sessionEnabled: boolean;
  readonly internalUsers: InternalUserRepository;
  readonly repository: WebRegistrationRepository;
  readonly profileService: ProfileV2Service;
  /** The `profile` V2 module is enabled and its repository composed. */
  readonly profileAvailable: boolean;
  readonly referralService: ReferralService;
  /** The `referral` V2 module is enabled and its repository composed. */
  readonly referralAvailable: boolean;
  readonly appLinks: WebMetaResource["appStore"];
  readonly now?: () => Date;
}

function unavailable(reasonCode: string): V2ApiError {
  return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function translateRepository(error: unknown): never {
  if (error instanceof WebRegistrationRepositoryUnavailableError) {
    throw unavailable(webReasonCodes.repositoryUnavailable);
  }
  throw error;
}

function withReason(error: V2ApiError, reasonCode: string): V2ApiError {
  if (error.detailsSafe?.["reasonCode"] !== undefined) return error;
  return V2ApiError.fromCode(error.code, {
    ...error.detailsSafe,
    reasonCode,
  });
}

export function createWebRegistrationService(
  options: WebRegistrationServiceOptions,
): WebRegistrationService {
  const now = options.now ?? ((): Date => new Date());
  const { repository } = options;

  function assertProfile(): void {
    if (!options.profileAvailable) {
      throw unavailable(webReasonCodes.profileModuleDeferred);
    }
  }

  function assertReferral(): void {
    if (!options.referralAvailable) {
      throw unavailable(webReasonCodes.referralModuleDeferred);
    }
  }

  async function replaceAlias(
    principal: AuthenticatedLoopPrincipal,
    current: ProfileV2Resource,
    username: string,
  ): Promise<ProfileV2Resource> {
    let resource = current;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await options.profileService.replaceProfile({
          principal,
          body: {
            expectedVersion: resource.version,
            profile: {
              alias: username,
              avatarRef: resource.profile.avatarRef,
              bio: resource.profile.bio,
              interests: [...resource.profile.interests],
            },
          },
        });
      } catch (error) {
        // One retry on a concurrent edit (e.g. the App saved the profile
        // between our read and write); a second conflict is reported.
        if (
          attempt === 0 &&
          error instanceof V2ApiError &&
          error.code === "VERSION_CONFLICT"
        ) {
          resource = await options.profileService.getProfile({ principal });
          continue;
        }
        throw error;
      }
    }
  }

  const service: WebRegistrationService = {
    async session(input) {
      if (!options.sessionEnabled) {
        throw unavailable(webReasonCodes.sessionDisabled);
      }
      let userId: string;
      try {
        userId = (
          await options.internalUsers.getOrCreateByPrivyUserId(
            input.principal.privyUserId,
          )
        ).id;
      } catch (error) {
        if (error instanceof LoopIdAllocationExhaustedError) {
          throw V2ApiError.fromCode("INTERNAL_ERROR");
        }
        throw error;
      }
      const summary = await repository
        .getAccountSummary(userId)
        .catch(translateRepository);
      if (summary === null) {
        throw unavailable(webReasonCodes.repositoryUnavailable);
      }
      const at = now();
      const window = claimWindow(summary.activatedAt, at);
      return Object.freeze({
        loopId: summary.loopId,
        username: summary.username,
        usernameRequired: summary.username === null,
        walletAddress: summary.walletAddress,
        invite: Object.freeze({
          bound: summary.inviteBound,
          windowEndsAt:
            window.status === "unavailable" ? null : window.closesAt,
          canClaim:
            options.referralAvailable &&
            !summary.inviteBound &&
            window.status !== "closed",
        }),
        observedAt: at.toISOString(),
      });
    },

    async setUsername(input) {
      assertProfile();
      const { principal } = input;
      const current = await options.profileService.getProfile({ principal });
      let resource: ProfileV2Resource;
      if (current.profile.profileStatus !== "active") {
        resource = await options.profileService.activateProfile({
          principal,
          body: {
            alias: input.username,
            avatarRef: current.profile.avatarRef,
            interests: [...current.profile.interests],
          },
          metadata: input.metadata,
          requestId: input.requestId,
        });
        // A concurrent activation (e.g. from the App) won the race and the
        // command answered `already_active` with its alias: apply ours.
        if (resource.profile.alias !== input.username.trim()) {
          resource = await replaceAlias(principal, resource, input.username);
        }
      } else {
        resource = await replaceAlias(principal, current, input.username);
      }
      const alias = resource.profile.alias;
      if (alias === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      return Object.freeze({ username: alias });
    },

    async claim(input) {
      assertReferral();
      const userId = input.principal.userId;
      let code: string;
      try {
        code = parseInviteCode(input.code);
      } catch (error) {
        if (error instanceof InvalidInviteCodeError) {
          throw V2ApiError.fromCode("INVALID_REQUEST", {
            reasonCode: webReasonCodes.codeInvalid,
          });
        }
        throw error;
      }
      try {
        await options.referralService.claim({
          principal: input.principal,
          idempotencyKey: input.metadata.idempotencyKey,
          requestId: input.requestId,
          body: { inviteCode: code },
        });
      } catch (error) {
        if (!(error instanceof V2ApiError)) throw error;
        if (error.code === "DATA_STALE" || error.code === "POLICY_BLOCKED") {
          const direct = await repository
            .getDirectInviter(userId)
            .catch(translateRepository);
          if (direct !== null) {
            const owner = await repository
              .findInviterByCode(code)
              .catch(translateRepository);
            return Object.freeze({
              status: "already_bound" as const,
              // Only the inviter the caller just named is echoed back; a
              // different existing inviter is never identified.
              ...(owner !== null && owner.userId === direct.userId
                ? { inviterLoopId: direct.loopId }
                : {}),
            });
          }
        }
        switch (error.code) {
          case "PROFILE_ACTIVATION_REQUIRED":
            throw withReason(error, webReasonCodes.activationRequired);
          case "POLICY_BLOCKED":
            throw withReason(error, webReasonCodes.claimWindowClosed);
          case "NOT_FOUND":
            throw withReason(error, webReasonCodes.codeUnknown);
          case "DATA_STALE":
            throw withReason(error, webReasonCodes.alreadyBound);
          case "VALIDATION_FAILED": {
            const owner = await repository
              .findInviterByCode(code)
              .catch(translateRepository);
            throw withReason(
              error,
              owner !== null && owner.userId === userId
                ? webReasonCodes.selfInvite
                : webReasonCodes.cycle,
            );
          }
          default:
            throw error;
        }
      }
      const direct = await repository
        .getDirectInviter(userId)
        .catch(translateRepository);
      return Object.freeze({
        status: "bound" as const,
        ...(direct === null ? {} : { inviterLoopId: direct.loopId }),
      });
    },

    async preview(input) {
      assertReferral();
      let code: string;
      try {
        code = parseInviteCode(input.code);
      } catch (error) {
        if (error instanceof InvalidInviteCodeError) {
          return Object.freeze({ valid: false, inviter: null });
        }
        throw error;
      }
      const owner = await repository
        .findInviterByCode(code)
        .catch(translateRepository);
      if (owner === null) {
        return Object.freeze({ valid: false, inviter: null });
      }
      return Object.freeze({
        valid: true,
        inviter: Object.freeze({
          username: owner.username,
          loopId: owner.loopId,
        }),
      });
    },

    meta() {
      return Object.freeze({
        appStore: Object.freeze({ ...options.appLinks }),
        observedAt: now().toISOString(),
      });
    },
  };
  return Object.freeze(service);
}
