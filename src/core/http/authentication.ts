import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import type {
  InternalUser,
  InternalUserRepository,
} from "../../features/identity/internal-user-repository.js";
import { deriveStreamUserId } from "../../features/identity/loop-identifiers.js";
import {
  AuthenticationUnavailableError,
  InvalidAccessTokenError,
  type PrivyAccessTokenVerifier,
  type VerifiedPrivyPrincipal,
} from "../../integrations/privy/access-token-verifier.js";
import { ApiError } from "./api-error.js";

const maximumAuthorizationHeaderLength = 8_192;
const bearerPattern =
  /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

export interface AuthenticatedLoopPrincipal {
  readonly userId: string;
  readonly privyUserId: string;
  readonly streamUserId: string;
}

export interface AuthenticationHooks {
  readonly authenticatePrivyBearer: preHandlerAsyncHookHandler;
  readonly authenticateLoopBearer: preHandlerAsyncHookHandler;
}

declare module "fastify" {
  interface FastifyRequest {
    authenticatedPrivyPrincipal: VerifiedPrivyPrincipal | null | undefined;
    authenticatedLoopPrincipal: AuthenticatedLoopPrincipal | null | undefined;
  }
}

export interface AuthenticationService {
  authenticatePrivyBearer(
    rawHeaders: readonly string[],
  ): Promise<VerifiedPrivyPrincipal>;
  authenticateLoopBearer(
    rawHeaders: readonly string[],
  ): Promise<AuthenticatedLoopPrincipal>;
}

function readBearerToken(rawHeaders: readonly string[]): string {
  const authorizationValues: string[] = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];

    if (name?.toLowerCase() === "authorization") {
      authorizationValues.push(rawHeaders[index + 1] ?? "");
    }
  }

  if (authorizationValues.length === 0) {
    throw ApiError.authenticationRequired();
  }

  if (authorizationValues.length !== 1) {
    throw ApiError.invalidAccessToken();
  }

  const authorization = authorizationValues[0];

  if (
    authorization === undefined ||
    authorization.length > maximumAuthorizationHeaderLength
  ) {
    throw ApiError.invalidAccessToken();
  }

  const match = bearerPattern.exec(authorization);

  if (match?.[1] === undefined) {
    throw ApiError.invalidAccessToken();
  }

  return match[1];
}

function toLoopPrincipal(
  privyPrincipal: VerifiedPrivyPrincipal,
  internalUser: InternalUser,
): AuthenticatedLoopPrincipal {
  return Object.freeze({
    userId: internalUser.id,
    privyUserId: privyPrincipal.privyUserId,
    streamUserId: deriveStreamUserId(internalUser.id),
  });
}

export function createAuthenticationService(
  verifier: PrivyAccessTokenVerifier,
  internalUsers: InternalUserRepository,
): AuthenticationService {
  async function authenticatePrivyBearer(
    rawHeaders: readonly string[],
  ): Promise<VerifiedPrivyPrincipal> {
    const accessToken = readBearerToken(rawHeaders);

    try {
      return await verifier.verifyAccessToken(accessToken);
    } catch (error) {
      if (error instanceof AuthenticationUnavailableError) {
        throw ApiError.authenticationUnavailable();
      }

      if (error instanceof InvalidAccessTokenError) {
        throw ApiError.invalidAccessToken();
      }

      throw error;
    }
  }

  return {
    authenticatePrivyBearer,
    async authenticateLoopBearer(
      rawHeaders: readonly string[],
    ): Promise<AuthenticatedLoopPrincipal> {
      const privyPrincipal = await authenticatePrivyBearer(rawHeaders);
      const internalUser = await internalUsers.findByPrivyUserId(
        privyPrincipal.privyUserId,
      );

      if (internalUser === null) {
        throw ApiError.bootstrapRequired();
      }

      return toLoopPrincipal(privyPrincipal, internalUser);
    },
  };
}

export function registerAuthenticationHooks(
  app: FastifyInstance,
  service: AuthenticationService,
): AuthenticationHooks {
  app.decorateRequest("authenticatedPrivyPrincipal", null);
  app.decorateRequest("authenticatedLoopPrincipal", null);

  return Object.freeze({
    async authenticatePrivyBearer(request: FastifyRequest): Promise<void> {
      const principal = await service.authenticatePrivyBearer(
        request.raw.rawHeaders,
      );
      request.setDecorator("authenticatedPrivyPrincipal", principal);
    },
    async authenticateLoopBearer(request: FastifyRequest): Promise<void> {
      const principal = await service.authenticateLoopBearer(
        request.raw.rawHeaders,
      );
      request.setDecorator("authenticatedLoopPrincipal", principal);
    },
  });
}

export function requireAuthenticatedPrivyPrincipal(
  request: FastifyRequest,
): VerifiedPrivyPrincipal {
  if (
    request.authenticatedPrivyPrincipal === null ||
    request.authenticatedPrivyPrincipal === undefined
  ) {
    throw new Error("Authenticated Privy principal is missing");
  }

  return request.authenticatedPrivyPrincipal;
}

export function requireAuthenticatedLoopPrincipal(
  request: FastifyRequest,
): AuthenticatedLoopPrincipal {
  if (
    request.authenticatedLoopPrincipal === null ||
    request.authenticatedLoopPrincipal === undefined
  ) {
    throw new Error("Authenticated LOOP principal is missing");
  }

  return request.authenticatedLoopPrincipal;
}
