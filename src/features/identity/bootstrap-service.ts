import type { VerifiedPrivyPrincipal } from "../../integrations/privy/access-token-verifier.js";
import type { InternalUserRepository } from "./internal-user-repository.js";
import { deriveStreamUserId } from "./loop-identifiers.js";

export interface BootstrapResult {
  readonly user: {
    readonly id: string;
  };
  readonly stream_user_id: string;
}

export interface BootstrapService {
  bootstrap(principal: VerifiedPrivyPrincipal): Promise<BootstrapResult>;
}

export function createBootstrapService(
  internalUsers: InternalUserRepository,
): BootstrapService {
  return {
    async bootstrap(
      principal: VerifiedPrivyPrincipal,
    ): Promise<BootstrapResult> {
      const internalUser = await internalUsers.getOrCreateByPrivyUserId(
        principal.privyUserId,
      );

      return Object.freeze({
        user: Object.freeze({ id: internalUser.id }),
        stream_user_id: deriveStreamUserId(internalUser.id),
      });
    },
  };
}
