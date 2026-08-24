import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createAuthenticationService,
  registerAuthenticationHooks,
  requireAuthenticatedLoopPrincipal,
} from "../src/core/http/authentication.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import {
  AuthenticationUnavailableError,
  InvalidAccessTokenError,
  type PrivyAccessTokenVerifier,
} from "../src/integrations/privy/access-token-verifier.js";

const loopUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const validRawHeaders = [
  "host",
  "loop.test",
  "authorization",
  "Bearer header.payload.signature",
] as const;

function dependencies() {
  const verifyAccessToken = vi.fn(() =>
    Promise.resolve({ privyUserId: "did:privy:verified-user" }),
  );
  const findByPrivyUserId = vi.fn(
    (privyUserId: string): Promise<{ readonly id: string } | null> => {
      void privyUserId;
      return Promise.resolve({ id: loopUserId });
    },
  );
  const getOrCreateByPrivyUserId = vi.fn(() =>
    Promise.resolve({ id: loopUserId }),
  );
  const verifier = { verifyAccessToken } satisfies PrivyAccessTokenVerifier;
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId,
  } satisfies InternalUserRepository;

  return {
    findByPrivyUserId,
    getOrCreateByPrivyUserId,
    internalUsers,
    verifier,
    verifyAccessToken,
  };
}

describe("Native Privy Bearer authentication", () => {
  it("rejects a missing Bearer header before verifier and repository calls", async () => {
    const inputs = dependencies();
    const service = createAuthenticationService(
      inputs.verifier,
      inputs.internalUsers,
    );

    await expect(service.authenticateLoopBearer([])).rejects.toMatchObject({
      statusCode: 401,
      code: "authentication_required",
      includeBearerChallenge: true,
    });
    expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
    expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", ["authorization", "Bearer token"]],
    [
      "duplicate",
      [
        "authorization",
        "Bearer header.payload.signature",
        "Authorization",
        "Bearer header.payload.signature",
      ],
    ],
    ["oversized", ["authorization", `Bearer ${"x".repeat(8_193)}`]],
  ])(
    "rejects a %s Authorization value before side effects",
    async (_name, rawHeaders) => {
      const inputs = dependencies();
      const service = createAuthenticationService(
        inputs.verifier,
        inputs.internalUsers,
      );

      await expect(
        service.authenticateLoopBearer(rawHeaders),
      ).rejects.toMatchObject({
        statusCode: 401,
        code: "invalid_access_token",
      });
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
    },
  );

  it("requires bootstrap for a verified identity without an internal user", async () => {
    const inputs = dependencies();
    inputs.findByPrivyUserId.mockResolvedValueOnce(null);
    const service = createAuthenticationService(
      inputs.verifier,
      inputs.internalUsers,
    );

    await expect(
      service.authenticateLoopBearer(validRawHeaders),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "bootstrap_required",
    });
    expect(inputs.verifyAccessToken).toHaveBeenCalledOnce();
    expect(inputs.findByPrivyUserId).toHaveBeenCalledWith(
      "did:privy:verified-user",
    );
    expect(inputs.getOrCreateByPrivyUserId).not.toHaveBeenCalled();
  });

  it("derives an opaque LOOP principal and verifies every request", async () => {
    const inputs = dependencies();
    const service = createAuthenticationService(
      inputs.verifier,
      inputs.internalUsers,
    );

    const first = await service.authenticateLoopBearer(validRawHeaders);
    const second = await service.authenticateLoopBearer(validRawHeaders);

    expect(first).toEqual({
      userId: loopUserId,
      privyUserId: "did:privy:verified-user",
      streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
    });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toHaveProperty("accessToken");
    expect(inputs.verifyAccessToken).toHaveBeenCalledTimes(2);
    expect(inputs.findByPrivyUserId).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new InvalidAccessTokenError(), 401, "invalid_access_token"],
    [new AuthenticationUnavailableError(), 503, "authentication_unavailable"],
  ])(
    "maps a known verifier failure to a sanitized API error",
    async (providerError, statusCode, code) => {
      const inputs = dependencies();
      inputs.verifyAccessToken.mockRejectedValueOnce(providerError);
      const service = createAuthenticationService(
        inputs.verifier,
        inputs.internalUsers,
      );

      await expect(
        service.authenticateLoopBearer(validRawHeaders),
      ).rejects.toMatchObject({ statusCode, code });
      expect(inputs.findByPrivyUserId).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid internal UUID instead of deriving a provider subject", async () => {
    const inputs = dependencies();
    inputs.findByPrivyUserId.mockResolvedValueOnce({ id: "not-a-uuid" });
    const service = createAuthenticationService(
      inputs.verifier,
      inputs.internalUsers,
    );

    await expect(
      service.authenticateLoopBearer(validRawHeaders),
    ).rejects.toThrow("Internal user ID is not a UUID");
  });

  it("keeps the route-level LOOP principal isolated to one authenticated request", async () => {
    const inputs = dependencies();
    const service = createAuthenticationService(
      inputs.verifier,
      inputs.internalUsers,
    );
    const app = Fastify({ logger: false });
    const hooks = registerAuthenticationHooks(app, service);
    const handler = vi.fn((request: FastifyRequest) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      return {
        userId: principal.userId,
        streamUserId: principal.streamUserId,
      };
    });
    app.get(
      "/protected",
      { preHandler: hooks.authenticateLoopBearer },
      handler,
    );
    app.get("/misconfigured", (request) =>
      requireAuthenticatedLoopPrincipal(request),
    );

    try {
      const authenticated = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer header.payload.signature" },
      });
      const missingAuthentication = await app.inject({
        method: "GET",
        url: "/protected",
      });
      const missingHook = await app.inject({
        method: "GET",
        url: "/misconfigured",
      });

      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toEqual({
        userId: loopUserId,
        streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
      });
      expect(authenticated.body).not.toContain("did:privy");
      expect(missingAuthentication.statusCode).toBe(401);
      expect(missingHook.statusCode).toBe(500);
      expect(handler).toHaveBeenCalledOnce();
      expect(inputs.verifyAccessToken).toHaveBeenCalledOnce();
      expect(inputs.findByPrivyUserId).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
