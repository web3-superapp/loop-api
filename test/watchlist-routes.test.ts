import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { WatchlistRepository } from "../src/database/watchlist-repository.js";
import {
  WatchlistVersionConflictError,
  emptyWatchlistSnapshot,
  parseWatchlistSnapshot,
} from "../src/features/watchlist/watchlist-contract.js";
import { createWatchlistService } from "../src/features/watchlist/watchlist-service.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerWatchlistRoutes } from "../src/routes/watchlist.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:watchlist-route-user";
const validAccessToken = "header.payload.signature";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const committedSnapshot = parseWatchlistSnapshot({
  version: 1,
  groups: [
    {
      key: "favorites",
      name: "重点关注",
      items: [{ asset_key: "ETH" }, { asset_key: "BTC" }],
    },
  ],
  updated_at: "2026-08-25T01:02:03.000Z",
});

function validBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    expected_version: 0,
    groups: [
      {
        key: "favorites",
        name: "  重点关注  ",
        items: [{ asset_key: "ETH" }, { asset_key: "BTC" }],
      },
    ],
    ...overrides,
  };
}

function dependencies(bootstrapped = true) {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: ownerUserId } : null),
  );
  const get = vi.fn<WatchlistRepository["get"]>(() =>
    Promise.resolve(emptyWatchlistSnapshot()),
  );
  const replace = vi.fn<WatchlistRepository["replace"]>(() =>
    Promise.resolve(committedSnapshot),
  );
  const repository = { get, replace } satisfies WatchlistRepository;
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;

  return {
    findByPrivyUserId,
    get,
    internalUsers,
    replace,
    repository,
    service: createWatchlistService({ repository }),
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

type Dependencies = ReturnType<typeof dependencies>;

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
  });
  registerWatchlistRoutes(app, auth.authenticateLoopBearer, input.service);
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

function authHeaders() {
  return { authorization: `Bearer ${validAccessToken}` };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

function repositoryCallCount(input: Dependencies): number {
  return input.get.mock.calls.length + input.replace.mock.calls.length;
}

describe("Watchlist routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function trackedApp(input = dependencies()) {
    const built = await createApp(input);
    apps.push(built.app);
    return built;
  }

  it("returns the no-write default for the server-derived owner", async () => {
    const input = await trackedApp();
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/watchlist",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: 0,
      groups: [],
      updated_at: null,
    });
    expectOperationalHeaders(response);
    expect(input.verifyAccessToken).toHaveBeenCalledOnce();
    expect(input.verifyAccessToken).toHaveBeenCalledWith(validAccessToken);
    expect(input.findByPrivyUserId).toHaveBeenCalledWith(privyUserId);
    expect(input.get).toHaveBeenCalledOnce();
    expect(input.get).toHaveBeenCalledWith(ownerUserId);
    expect(input.replace).not.toHaveBeenCalled();
  });

  it("normalizes and forwards a complete ordered snapshot without client ownership", async () => {
    const input = await trackedApp();
    const response = await input.app.inject({
      method: "PUT",
      url: "/v1/watchlist",
      headers: authHeaders(),
      payload: validBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(committedSnapshot);
    expectOperationalHeaders(response);
    expect(input.replace).toHaveBeenCalledOnce();
    expect(input.replace).toHaveBeenCalledWith({
      ownerUserId,
      expectedVersion: 0,
      groups: [
        {
          key: "favorites",
          name: "重点关注",
          items: [{ asset_key: "ETH" }, { asset_key: "BTC" }],
        },
      ],
    });
  });

  it("rejects strict body, query, aggregate, and header failures before authentication", async () => {
    const input = await trackedApp();
    const tooManyItems = [
      {
        key: "one",
        name: "One",
        items: Array.from({ length: 51 }, (_, index) => ({
          asset_key: `A_${index}`,
        })),
      },
      {
        key: "two",
        name: "Two",
        items: Array.from({ length: 50 }, (_, index) => ({
          asset_key: `B_${index}`,
        })),
      },
    ];
    const requests = [
      {
        method: "PUT" as const,
        url: "/v1/watchlist",
        headers: { ...authHeaders(), "idempotency-key": randomUUID() },
        payload: validBody(),
      },
      {
        method: "PUT" as const,
        url: "/v1/watchlist?owner_user_id=hostile",
        headers: authHeaders(),
        payload: validBody(),
      },
      {
        method: "PUT" as const,
        url: "/v1/watchlist",
        headers: authHeaders(),
        payload: validBody({ owner_user_id: ownerUserId }),
      },
      {
        method: "PUT" as const,
        url: "/v1/watchlist",
        headers: authHeaders(),
        payload: validBody({ groups: tooManyItems }),
      },
      {
        method: "PUT" as const,
        url: "/v1/watchlist",
        headers: authHeaders(),
        payload: validBody({
          groups: [
            {
              key: "same",
              name: "A",
              items: [{ asset_key: "BTC" }, { asset_key: "BTC" }],
            },
          ],
        }),
      },
      {
        method: "PUT" as const,
        url: "/v1/watchlist",
        headers: authHeaders(),
        payload: validBody({
          groups: [{ key: "x", name: "safe\u202eevil", items: [] }],
        }),
      },
      {
        method: "GET" as const,
        url: "/v1/watchlist?provider=untrusted",
        headers: authHeaders(),
      },
      {
        method: "GET" as const,
        url: "/v1/watchlist",
        headers: { ...authHeaders(), "content-type": "application/json" },
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
    expect(repositoryCallCount(input)).toBe(0);
  });

  it("authenticates every valid request and requires an existing bootstrap", async () => {
    const missingAuth = await trackedApp();
    const unauthenticated = await missingAuth.app.inject({
      method: "PUT",
      url: "/v1/watchlist",
      payload: validBody(),
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: "authentication_required",
    });
    expect(unauthenticated.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expect(repositoryCallCount(missingAuth)).toBe(0);

    const unbootstrapped = await trackedApp(dependencies(false));
    const noMapping = await unbootstrapped.app.inject({
      method: "GET",
      url: "/v1/watchlist",
      headers: authHeaders(),
    });
    expect(noMapping.statusCode).toBe(409);
    expect(noMapping.json()).toMatchObject({ code: "bootstrap_required" });
    expect(unbootstrapped.verifyAccessToken).toHaveBeenCalledOnce();
    expect(repositoryCallCount(unbootstrapped)).toBe(0);
  });

  it("maps a stale different snapshot to the stable version conflict", async () => {
    const dependenciesWithConflict = dependencies();
    dependenciesWithConflict.replace.mockRejectedValueOnce(
      new WatchlistVersionConflictError(),
    );
    const input = await trackedApp(dependenciesWithConflict);
    const response = await input.app.inject({
      method: "PUT",
      url: "/v1/watchlist",
      headers: authHeaders(),
      payload: validBody({ expected_version: 3 }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "version_conflict",
      message: "The resource has changed. Refresh and try again.",
    });
    expectOperationalHeaders(response);
  });

  it("sanitizes unexpected repository failures", async () => {
    const failedDependencies = dependencies();
    failedDependencies.get.mockRejectedValueOnce(
      new Error("postgresql connection detail must stay private"),
    );
    const input = await trackedApp(failedDependencies);
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/watchlist",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "internal_error",
      message: "The request failed.",
    });
    expect(response.body).not.toContain("postgresql");
    expectOperationalHeaders(response);
  });
});
