import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { PublicAliasSearchResource } from "../src/features/identity/alias-contract.js";
import { AliasSearchRateLimitedError } from "../src/features/identity/alias-search-quota.js";
import {
  InvalidPublicAliasSearchRequestError,
  PublicAliasSearchUnavailableError,
  type PublicAliasSearchService,
} from "../src/features/identity/public-alias-search-service.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerDiscoveryRoutes } from "../src/routes/discovery.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const resultProfileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const resultProfileCode = "0000000001";
const privyUserId = "did:privy:discovery-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const validAccessToken = "header.payload.signature";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const safeResource = Object.freeze({
  items: Object.freeze([
    Object.freeze({
      public_profile_id: resultProfileId,
      profile_code: resultProfileCode,
      alias: "小鹿",
      avatar_ref: "avatar:profiles/deer",
    }),
  ]),
  truncated: false,
}) satisfies PublicAliasSearchResource;

function dependencies(bootstrapped = true) {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: ownerUserId } : null),
  );
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;
  const search = vi.fn<PublicAliasSearchService["search"]>(() =>
    Promise.resolve(safeResource),
  );

  return {
    findByPrivyUserId,
    internalUsers,
    search,
    service: { search } satisfies PublicAliasSearchService,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

async function createDiscoveryHarness(input = dependencies()) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    exposeHeadRoutes: false,
    genReqId: () => randomUUID(),
    logger: false,
    requestIdHeader: false,
  });
  const authentication = registerAuthenticationHooks(
    app,
    createAuthenticationService(input.verifier, input.internalUsers),
  );
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (reply.statusCode >= 400) {
      reply.header("cache-control", "no-store");
    }
  });
  registerDiscoveryRoutes(
    app,
    authentication.authenticateLoopBearer,
    input.service,
  );
  app.setErrorHandler(async (error, request, reply) => {
    const validation =
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined;
    const mapped = validation ? ApiError.invalidRequest() : error;
    reply.header("cache-control", "no-store");
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

function authHeaders(extra: Record<string, string | string[]> = {}) {
  return { authorization: `Bearer ${validAccessToken}`, ...extra };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("Discovery routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createDiscoveryHarness(input);
    apps.push(created.app);
    return created;
  }

  it("searches with only the server-derived principal and returns the bounded public projection", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "GET",
      url: `/v1/discovery/users?alias_prefix=${encodeURIComponent("小鹿")}&limit=7`,
      headers: authHeaders(),
      remoteAddress: "198.51.100.24",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(safeResource);
    expect(Object.keys(response.json<object>()).sort()).toEqual([
      "items",
      "truncated",
    ]);
    expect(
      Object.keys(response.json<{ items: object[] }>().items[0]!).sort(),
    ).toEqual(["alias", "avatar_ref", "profile_code", "public_profile_id"]);
    expectOperationalHeaders(response);
    expect(input.verifyAccessToken).toHaveBeenCalledWith(validAccessToken);
    expect(input.findByPrivyUserId).toHaveBeenCalledWith(privyUserId);
    const searchInput = input.search.mock.calls[0]?.[0];
    expect(searchInput).toBeDefined();
    if (searchInput === undefined) {
      throw new Error("Expected the public alias search call");
    }
    expect(searchInput).toMatchObject({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      aliasPrefix: "小鹿",
      limit: 7,
      canonicalClientIp: "198.51.100.24",
    });
    expect(searchInput.signal).toBeInstanceOf(AbortSignal);
  });

  it("allows a one-code-point raw prefix when NFKC expands it to the required length", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "GET",
      url: `/v1/discovery/users?alias_prefix=${encodeURIComponent("ﬀ")}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(input.search).toHaveBeenCalledWith(
      expect.objectContaining({ aliasPrefix: "ﬀ" }),
    );
  });

  it("serializes only approved fields even if an adapter returns extra identity data", async () => {
    const input = dependencies();
    input.search.mockResolvedValueOnce({
      items: [
        {
          public_profile_id: resultProfileId,
          profile_code: resultProfileCode,
          alias: "Alias",
          avatar_ref: null,
          internal_user_id: ownerUserId,
          stream_user_id: streamUserId,
          wallet_address: "0x1111111111111111111111111111111111111111",
        },
      ],
      truncated: false,
      total: 1,
      next_cursor: "private-cursor",
    } as unknown as PublicAliasSearchResource);
    const created = await harness(input);
    const response = await created.app.inject({
      method: "GET",
      url: "/v1/discovery/users?alias_prefix=Al",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          public_profile_id: resultProfileId,
          profile_code: resultProfileCode,
          alias: "Alias",
          avatar_ref: null,
        },
      ],
      truncated: false,
    });
    expect(response.body).not.toContain(ownerUserId);
    expect(response.body).not.toContain(streamUserId);
    expect(response.body).not.toContain("wallet_address");
    expect(response.body).not.toContain("next_cursor");
    expectOperationalHeaders(response);
  });

  it("rejects strict query, body, and header failures before authentication or search", async () => {
    const input = await harness();
    const requests = [
      { method: "GET" as const, url: "/v1/discovery/users" },
      {
        method: "GET" as const,
        url: "/v1/discovery/users?alias_prefix=ab&owner_user_id=hostile",
      },
      {
        method: "GET" as const,
        url: "/v1/discovery/users?alias_prefix=ab&alias_prefix=cd",
      },
      {
        method: "GET" as const,
        url: "/v1/discovery/users?alias_prefix=ab&limit=21",
      },
      {
        method: "GET" as const,
        url: `/v1/discovery/users?alias_prefix=${encodeURIComponent("ab\u200b")}`,
      },
      {
        method: "GET" as const,
        url: `/v1/discovery/users?alias_prefix=${encodeURIComponent("ab\u206a")}`,
      },
      {
        method: "GET" as const,
        url: "/v1/discovery/users?alias_prefix=ab",
        headers: { "idempotency-key": randomUUID() },
      },
      {
        method: "GET" as const,
        url: "/v1/discovery/users?alias_prefix=ab",
        headers: { "content-type": "application/json" },
        payload: {},
      },
    ];

    for (const request of requests) {
      const response = await input.app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expectOperationalHeaders(response);
    }

    expect(input.verifyAccessToken).not.toHaveBeenCalled();
    expect(input.findByPrivyUserId).not.toHaveBeenCalled();
    expect(input.search).not.toHaveBeenCalled();
  });

  it("defers normalized minimum-length validation until after authentication", async () => {
    const invalid = dependencies();
    invalid.search.mockRejectedValueOnce(
      new InvalidPublicAliasSearchRequestError(),
    );
    const input = await harness(invalid);
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/discovery/users?alias_prefix=x",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(input.verifyAccessToken).toHaveBeenCalledWith(validAccessToken);
    expect(input.search).toHaveBeenCalledWith(
      expect.objectContaining({ aliasPrefix: "x" }),
    );
  });

  it("requires authentication and an existing bootstrap before discovery", async () => {
    const missingAuth = await harness();
    const unauthenticated = await missingAuth.app.inject({
      method: "GET",
      url: "/v1/discovery/users?alias_prefix=lo",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: "authentication_required",
    });
    expect(unauthenticated.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expect(missingAuth.search).not.toHaveBeenCalled();
    expectOperationalHeaders(unauthenticated);

    const noBootstrap = await harness(dependencies(false));
    const unbootstrapped = await noBootstrap.app.inject({
      method: "GET",
      url: "/v1/discovery/users?alias_prefix=lo",
      headers: authHeaders(),
    });
    expect(unbootstrapped.statusCode).toBe(409);
    expect(unbootstrapped.json()).toMatchObject({
      code: "bootstrap_required",
    });
    expect(noBootstrap.verifyAccessToken).toHaveBeenCalledWith(
      validAccessToken,
    );
    expect(noBootstrap.search).not.toHaveBeenCalled();
    expectOperationalHeaders(unbootstrapped);
  });

  it.each([
    [
      "invalid service input",
      new InvalidPublicAliasSearchRequestError(),
      400,
      "invalid_request",
      "The request is invalid.",
    ],
    [
      "exhausted search quota",
      new AliasSearchRateLimitedError(),
      429,
      "search_rate_limited",
      "Alias search is temporarily rate limited.",
    ],
    [
      "unavailable discovery",
      new PublicAliasSearchUnavailableError(),
      503,
      "discovery_unavailable",
      "Alias discovery is unavailable.",
    ],
  ])(
    "maps %s to a stable sanitized response",
    async (_name, error, statusCode, code, message) => {
      const failed = dependencies();
      failed.search.mockRejectedValueOnce(error);
      const input = await harness(failed);
      const response = await input.app.inject({
        method: "GET",
        url: "/v1/discovery/users?alias_prefix=lo",
        headers: authHeaders(),
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ code, message });
      expect(response.body).not.toContain(error.message);
      expectOperationalHeaders(response);
    },
  );

  it("sanitizes unexpected service failures", async () => {
    const failed = dependencies();
    failed.search.mockRejectedValueOnce(
      new Error("private database and wallet identity detail"),
    );
    const input = await harness(failed);
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/discovery/users?alias_prefix=lo",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "internal_error",
      message: "The request failed.",
    });
    expect(response.body).not.toContain("database");
    expect(response.body).not.toContain("wallet");
    expectOperationalHeaders(response);
  });
});
