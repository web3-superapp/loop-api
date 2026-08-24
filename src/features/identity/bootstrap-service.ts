import type {
  PrivyAccessTokenVerifier,
  VerifiedPrivyPrincipal,
} from "../../integrations/privy/access-token-verifier.js";
import type { InternalUserRepository } from "./internal-user-repository.js";

const internalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BootstrapResult {
  readonly user: {
    readonly id: string;
  };
  readonly stream_user_id: string;
}

function deriveStreamUserId(internalUserId: string): string {
  if (!internalUuidPattern.test(internalUserId)) {
    throw new Error("Internal user ID is not a UUID");
  }

  return `loop_${internalUserId.replaceAll("-", "").toLowerCase()}`;
}

export interface BootstrapService {
  bootstrap(accessToken: string): Promise<BootstrapResult>;
}

export function createBootstrapService(
  verifier: PrivyAccessTokenVerifier,
  internalUsers: InternalUserRepository,
): BootstrapService {
  return {
    async bootstrap(accessToken: string): Promise<BootstrapResult> {
      const principal: VerifiedPrivyPrincipal =
        await verifier.verifyAccessToken(accessToken);
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
