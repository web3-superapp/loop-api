import {
  InvalidAuthTokenError as PrivyInvalidAuthTokenError,
  type PrivyClient,
} from "@privy-io/node";

import type { PrivyConfig } from "../../config.js";
import { createPrivyServerClient } from "./client.js";

const privyIssuer = "privy.io";
const maximumPrivyUserIdLength = 255;

export interface VerifiedPrivyPrincipal {
  readonly privyUserId: string;
}

export interface PrivyAccessTokenVerifier {
  verifyAccessToken(accessToken: string): Promise<VerifiedPrivyPrincipal>;
}

export class InvalidAccessTokenError extends Error {
  constructor() {
    super("The Privy access token is invalid");
    this.name = "InvalidAccessTokenError";
  }
}

export class AuthenticationUnavailableError extends Error {
  constructor() {
    super("Privy access-token verification is unavailable");
    this.name = "AuthenticationUnavailableError";
  }
}

interface PrivyVerifierOptions extends PrivyConfig {
  readonly jwtVerificationKey?: string;
}

export function createPrivyAccessTokenVerifierWithClient(
  options: PrivyVerifierOptions,
  client: Pick<PrivyClient, "utils">,
): PrivyAccessTokenVerifier {
  return {
    async verifyAccessToken(
      accessToken: string,
    ): Promise<VerifiedPrivyPrincipal> {
      let claims;

      try {
        claims = await client.utils().auth().verifyAccessToken(accessToken);
      } catch (error) {
        if (error instanceof PrivyInvalidAuthTokenError) {
          throw new InvalidAccessTokenError();
        }

        throw error;
      }

      const privyUserId = claims.user_id;

      if (
        claims.app_id !== options.appId ||
        claims.issuer !== privyIssuer ||
        privyUserId.trim() !== privyUserId ||
        privyUserId.length === 0 ||
        privyUserId.length > maximumPrivyUserIdLength
      ) {
        throw new InvalidAccessTokenError();
      }

      return Object.freeze({ privyUserId });
    },
  };
}

export function createPrivyAccessTokenVerifier(
  options: PrivyVerifierOptions,
): PrivyAccessTokenVerifier {
  const client = createPrivyServerClient(options);
  return createPrivyAccessTokenVerifierWithClient(options, client);
}

export function createUnavailablePrivyAccessTokenVerifier(): PrivyAccessTokenVerifier {
  return {
    verifyAccessToken(): Promise<never> {
      return Promise.reject(new AuthenticationUnavailableError());
    },
  };
}
