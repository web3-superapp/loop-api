import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PerpWalletBindingResource } from "../src/features/perp/wallet-binding-contract.js";
import {
  PerpWalletBindingSelectionRequiredError,
  PerpWalletBindingUnavailableError,
  PerpWalletBindingVersionConflictError,
  type PerpWalletBindingService,
} from "../src/features/perp/wallet-binding-service.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerPerpWalletBindingRoutes } from "../src/routes/perp-wallet-binding.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:wallet-binding-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const validAccessToken = "header.payload.signature";

const unboundResource = Object.freeze({
  state: "unbound",
  binding_version: "0",
  account_kind: null,
  last_verified_at: null,
} as const satisfies PerpWalletBindingResource);

const boundResource = Object.freeze({
  state: "bound",
  binding_version: "9223372036854775807",
  account_kind: "master",
  last_verified_at: "2026-08-25T04:00:00.000Z",
} as const satisfies PerpWalletBindingResource);

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
  const get = vi.fn<PerpWalletBindingService["get"]>(() =>
    Promise.resolve(unboundResource),
  );
  const put = vi.fn<PerpWalletBindingService["put"]>(() =>
    Promise.resolve(boundResource),
  );
  const remove = vi.fn<PerpWalletBindingService["delete"]>(() =>
    Promise.resolve({
      ...unboundResource,
      binding_version: "9223372036854775807",
    }),
  );
  return {
    findByPrivyUserId,
    get,
    internalUsers,
    put,
    remove,
    service: { get, put, delete: remove } satisfies PerpWalletBindingService,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
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
  registerPerpWalletBindingRoutes(
    app,
    auth.authenticateLoopBearer,
    input.service,
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

describe("Perp wallet-binding routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it("returns only the current owner's safe lifecycle projection", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/perp/wallet-binding",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(unboundResource);
    expect(response.body).not.toMatch(/address|wallet[_-]?id/i);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(input.get).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
    });
  });

  it("forwards an exact PUT without accepting wallet authority", async () => {
    const input = await harness();
    const body = { expected_binding_version: "0" };
    const response = await input.app.inject({
      method: "PUT",
      url: "/v1/perp/wallet-binding",
      headers: authHeaders(),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(boundResource);
    const call = input.put.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      body,
    });
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it("takes DELETE CAS only from a strict query string and rejects a body", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "DELETE",
      url: "/v1/perp/wallet-binding?expected_binding_version=9223372036854775807",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(input.remove).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      expectedBindingVersion: "9223372036854775807",
    });

    const bodyResponse = await input.app.inject({
      method: "DELETE",
      url: "/v1/perp/wallet-binding?expected_binding_version=0",
      headers: authHeaders(),
      payload: { expected_binding_version: "0" },
    });
    expect(bodyResponse.statusCode).toBe(400);
    expect(input.remove).toHaveBeenCalledTimes(1);
  });

  it.each([
    "/v1/perp/wallet-binding",
    "/v1/perp/wallet-binding?other=0",
    "/v1/perp/wallet-binding?expected_binding_version=0&other=0",
    "/v1/perp/wallet-binding?expected_binding_version=0&expected_binding_version=0",
    "/v1/perp/wallet-binding?expected_binding_version=01",
    "/v1/perp/wallet-binding?expected_binding_version=9223372036854775808",
  ])("rejects invalid DELETE query %s", async (url) => {
    const input = await harness();
    const response = await input.app.inject({
      method: "DELETE",
      url,
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(input.remove).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { expected_binding_version: 0 },
    { expected_binding_version: "01" },
    { expected_binding_version: "9223372036854775808" },
    { expected_binding_version: "0", address: "0x1111" },
  ])("rejects invalid/client-authority PUT body %#", async (payload) => {
    const input = await harness();
    const response = await input.app.inject({
      method: "PUT",
      url: "/v1/perp/wallet-binding",
      headers: authHeaders(),
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(input.put).not.toHaveBeenCalled();
  });

  it.each(["PUT", "DELETE"] as const)(
    "rejects client idempotency on %s",
    async (method) => {
      const input = await harness();
      const response = await input.app.inject({
        method,
        url:
          method === "PUT"
            ? "/v1/perp/wallet-binding"
            : "/v1/perp/wallet-binding?expected_binding_version=0",
        headers: authHeaders({ "idempotency-key": randomUUID() }),
        ...(method === "PUT"
          ? { payload: { expected_binding_version: "0" } }
          : {}),
      });
      expect(response.statusCode).toBe(400);
    },
  );

  it("requires authentication and an existing bootstrap mapping", async () => {
    const input = await harness();
    const missingAuth = await input.app.inject({
      method: "GET",
      url: "/v1/perp/wallet-binding",
    });
    expect(missingAuth.statusCode).toBe(401);

    const unbootstrapped = await harness(dependencies(false));
    const bootstrap = await unbootstrapped.app.inject({
      method: "GET",
      url: "/v1/perp/wallet-binding",
      headers: authHeaders(),
    });
    expect(bootstrap.statusCode).toBe(409);
    expect(bootstrap.json()).toMatchObject({ code: "bootstrap_required" });
  });

  it.each([
    [
      new PerpWalletBindingSelectionRequiredError(),
      409,
      "wallet_binding_required",
    ],
    [new PerpWalletBindingVersionConflictError(), 409, "version_conflict"],
    [new PerpWalletBindingUnavailableError(), 503, "perp_unavailable"],
  ] as const)(
    "maps lifecycle failures without authority",
    async (error, status, code) => {
      const dependenciesWithError = dependencies();
      dependenciesWithError.put.mockRejectedValueOnce(error);
      const input = await harness(dependenciesWithError);
      const response = await input.app.inject({
        method: "PUT",
        url: "/v1/perp/wallet-binding",
        headers: authHeaders(),
        payload: { expected_binding_version: "0" },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toMatch(/0x[0-9a-f]{40}|wallet-a|did:privy/i);
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );
});
