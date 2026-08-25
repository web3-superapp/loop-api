import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import { ProfileRepositoryUnavailableError } from "../src/database/profile-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type {
  PrivacyResource,
  ProfileResource,
} from "../src/features/profile/profile-contract.js";
import {
  ProfileVersionConflictError,
  type ProfileService,
} from "../src/features/profile/profile-service.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerProfileRoutes } from "../src/routes/profile.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:profile-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const validAccessToken = "header.payload.signature";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const profileResource = Object.freeze({
  version: 0,
  profile: Object.freeze({ alias: null, avatar_ref: null }),
  updated_at: null,
} as const satisfies ProfileResource);

const privacyResource = Object.freeze({
  version: 0,
  privacy: Object.freeze({
    discoverable: false,
    copy_trade_visibility: "private",
  }),
  updated_at: null,
} as const satisfies PrivacyResource);

function dependencies(bootstrapped = true) {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: ownerUserId } : null),
  );
  const getProfile = vi.fn<ProfileService["getProfile"]>(() =>
    Promise.resolve(profileResource),
  );
  const replaceProfile = vi.fn<ProfileService["replaceProfile"]>(() =>
    Promise.resolve({
      version: 1,
      profile: { alias: "Alice", avatar_ref: "avatar:alice/main" },
      updated_at: "2026-08-25T00:00:00.000Z",
    }),
  );
  const getPrivacy = vi.fn<ProfileService["getPrivacy"]>(() =>
    Promise.resolve(privacyResource),
  );
  const replacePrivacy = vi.fn<ProfileService["replacePrivacy"]>(() =>
    Promise.resolve({
      version: 1,
      privacy: {
        discoverable: true,
        copy_trade_visibility: "followers",
      },
      updated_at: "2026-08-25T00:00:00.000Z",
    }),
  );
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;

  return {
    findByPrivyUserId,
    getPrivacy,
    getProfile,
    internalUsers,
    replacePrivacy,
    replaceProfile,
    service: {
      getProfile,
      replaceProfile,
      getPrivacy,
      replacePrivacy,
    } satisfies ProfileService,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

async function createApp(input = dependencies()) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    exposeHeadRoutes: false,
    genReqId: () => randomUUID(),
    logger: false,
    requestIdHeader: false,
  });
  const auth = registerAuthenticationHooks(
    app,
    createAuthenticationService(input.verifier, input.internalUsers),
  );
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (reply.statusCode >= 400) {
      reply.header("cache-control", "no-store");
    }
  });
  registerProfileRoutes(app, auth.authenticateLoopBearer, input.service);
  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({
      code: "not_found",
      message: "The requested resource does not exist.",
      request_id: request.id,
    }),
  );
  app.setErrorHandler(async (error, request, reply) => {
    const validation =
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined;
    const mapped = validation ? ApiError.invalidRequest() : error;
    if (mapped instanceof ApiError) {
      if (mapped.includeBearerChallenge) {
        reply.header("www-authenticate", 'Bearer realm="loop-api"');
      }
      return reply.code(mapped.statusCode).send({
        code: mapped.code,
        message: mapped.safeMessage,
        request_id: request.id,
      });
    }
    return reply.code(500).send({
      code: "internal_error",
      message: "The request failed.",
      request_id: request.id,
    });
  });
  await app.ready();
  return { app, ...input };
}

function authHeaders(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${validAccessToken}`, ...extra };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("Profile routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it.each([
    ["/v1/profile", "profile", profileResource],
    ["/v1/profile/privacy", "privacy", privacyResource],
  ] as const)(
    "returns the authenticated owner's version-0 %s projection",
    async (url, kind, expected) => {
      const input = await harness();
      const response = await input.app.inject({
        method: "GET",
        url,
        headers: authHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      expectOperationalHeaders(response);
      const call =
        kind === "profile"
          ? input.getProfile.mock.calls[0]?.[0]
          : input.getPrivacy.mock.calls[0]?.[0];
      expect(call).toEqual({
        principal: { userId: ownerUserId, privyUserId, streamUserId },
      });
    },
  );

  it("forwards an exact Profile replacement under the server-derived owner", async () => {
    const input = await harness();
    const body = {
      expected_version: 0,
      profile: { alias: " Alice ", avatar_ref: "avatar:alice/main" },
    };
    const response = await input.app.inject({
      method: "PUT",
      url: "/v1/profile",
      headers: authHeaders(),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      profile: { alias: "Alice", avatar_ref: "avatar:alice/main" },
    });
    expectOperationalHeaders(response);
    expect(input.replaceProfile).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      body,
    });
  });

  it("forwards a privacy preference without treating it as authorization", async () => {
    const input = await harness();
    const body = {
      expected_version: 0,
      privacy: {
        discoverable: true,
        copy_trade_visibility: "followers",
      },
    };
    const response = await input.app.inject({
      method: "PUT",
      url: "/v1/profile/privacy",
      headers: authHeaders(),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      privacy: body.privacy,
    });
    expectOperationalHeaders(response);
    expect(input.replacePrivacy).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      body,
    });
  });

  it.each([
    [
      "Profile authority field",
      "PUT",
      "/v1/profile",
      {
        expected_version: 0,
        profile: { alias: null, avatar_ref: null, owner_user_id: ownerUserId },
      },
      {},
    ],
    [
      "arbitrary avatar URL",
      "PUT",
      "/v1/profile",
      {
        expected_version: 0,
        profile: { alias: null, avatar_ref: "https://example.test/a.png" },
      },
      {},
    ],
    [
      "bidirectional alias control",
      "PUT",
      "/v1/profile",
      {
        expected_version: 0,
        profile: { alias: "safe\u202eunsafe", avatar_ref: null },
      },
      {},
    ],
    [
      "blank alias",
      "PUT",
      "/v1/profile",
      {
        expected_version: 0,
        profile: { alias: "   ", avatar_ref: null },
      },
      {},
    ],
    [
      "privacy authorization field",
      "PUT",
      "/v1/profile/privacy",
      {
        expected_version: 0,
        privacy: {
          discoverable: true,
          copy_trade_visibility: "public",
          authorized: true,
        },
      },
      {},
    ],
    [
      "PUT query",
      "PUT",
      "/v1/profile?owner=forbidden",
      {
        expected_version: 0,
        profile: { alias: null, avatar_ref: null },
      },
      {},
    ],
    [
      "client idempotency key",
      "PUT",
      "/v1/profile",
      {
        expected_version: 0,
        profile: { alias: null, avatar_ref: null },
      },
      { "idempotency-key": randomUUID() },
    ],
    [
      "privacy PUT query",
      "PUT",
      "/v1/profile/privacy?owner=forbidden",
      {
        expected_version: 0,
        privacy: {
          discoverable: false,
          copy_trade_visibility: "private",
        },
      },
      {},
    ],
    [
      "privacy client idempotency key",
      "PUT",
      "/v1/profile/privacy",
      {
        expected_version: 0,
        privacy: {
          discoverable: false,
          copy_trade_visibility: "private",
        },
      },
      { "idempotency-key": randomUUID() },
    ],
    ["GET query", "GET", "/v1/profile?owner=forbidden", undefined, {}],
    ["GET body", "GET", "/v1/profile", { owner: ownerUserId }, {}],
    [
      "privacy GET query",
      "GET",
      "/v1/profile/privacy?owner=forbidden",
      undefined,
      {},
    ],
    [
      "privacy GET body",
      "GET",
      "/v1/profile/privacy",
      { owner: ownerUserId },
      {},
    ],
  ] as const)(
    "rejects %s before authentication",
    async (_label, method, url, payload, extraHeaders) => {
      const input = await harness();
      const response = await input.app.inject({
        method,
        url,
        headers: authHeaders(extraHeaders),
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(input.verifyAccessToken).not.toHaveBeenCalled();
      expect(input.getProfile).not.toHaveBeenCalled();
      expect(input.getPrivacy).not.toHaveBeenCalled();
      expect(input.replaceProfile).not.toHaveBeenCalled();
      expect(input.replacePrivacy).not.toHaveBeenCalled();
    },
  );

  it("requires a current Bearer token and an existing bootstrap mapping", async () => {
    const missingBearer = await harness();
    const unauthenticated = await missingBearer.app.inject({
      method: "GET",
      url: "/v1/profile",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expect(missingBearer.getProfile).not.toHaveBeenCalled();

    const missingBootstrap = await harness(dependencies(false));
    const unbootstrapped = await missingBootstrap.app.inject({
      method: "GET",
      url: "/v1/profile/privacy",
      headers: authHeaders(),
    });
    expect(unbootstrapped.statusCode).toBe(409);
    expect(unbootstrapped.json()).toMatchObject({ code: "bootstrap_required" });
    expect(missingBootstrap.getPrivacy).not.toHaveBeenCalled();
  });

  it("maps a version conflict to the stable 409 response", async () => {
    const input = dependencies();
    input.replaceProfile.mockRejectedValueOnce(
      new ProfileVersionConflictError(),
    );
    const created = await harness(input);
    const response = await created.app.inject({
      method: "PUT",
      url: "/v1/profile",
      headers: authHeaders(),
      payload: {
        expected_version: 1,
        profile: { alias: "Changed", avatar_ref: null },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "version_conflict" });
    expectOperationalHeaders(response);
  });

  it("sanitizes repository and unexpected failures", async () => {
    const input = dependencies();
    input.getProfile.mockRejectedValueOnce(
      new ProfileRepositoryUnavailableError(),
    );
    const created = await harness(input);
    const response = await created.app.inject({
      method: "GET",
      url: "/v1/profile",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "internal_error" });
    expect(response.body).not.toContain("repository");
    expectOperationalHeaders(response);
  });

  it.each(["/v1/profile", "/v1/profile/privacy"])(
    "does not expose an implicit HEAD alias for %s",
    async (url) => {
      const input = await harness();
      const response = await input.app.inject({ method: "HEAD", url });

      expect(response.statusCode).toBe(404);
      expect(input.verifyAccessToken).not.toHaveBeenCalled();
      expect(input.getProfile).not.toHaveBeenCalled();
      expect(input.getPrivacy).not.toHaveBeenCalled();
    },
  );
});
