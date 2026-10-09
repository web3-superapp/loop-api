import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { AgentAuthorizationResource } from "../src/features/perp/agent-authorization-contract.js";
import {
  AgentAuthorizationExpiredError,
  AgentAuthorizationMutationDisabledError,
  AgentAuthorizationNotFoundError,
  AgentAuthorizationUnavailableError,
  type AgentAuthorizationService,
} from "../src/features/perp/agent-authorization-service.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerAgentAuthorizationRoutes } from "../src/routes/agent-authorizations.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:agent-authorization-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const authorizationId = "c1d69ec4-f905-4ed2-bf1a-35cd1a49c306";
const validAccessToken = "header.payload.signature";
const accountAddress = `0x${"11".repeat(20)}`;
const signerWalletAddress = `0x${"22".repeat(20)}`;
const agentAddress = `0x${"33".repeat(20)}`;
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const resource = Object.freeze({
  authorization_id: authorizationId,
  state: "prepared",
  review: {
    version: "perp_agent_authorization_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    action: "approve_agent",
    account: { address: accountAddress, kind: "master" },
    signer_wallet_address: signerWalletAddress,
    agent: {
      address: agentAddress,
      name: "loop-agent",
      valid_until: "2026-08-25T01:00:00.000Z",
    },
  },
  signature: { state: "required" },
  expires_at: "2026-08-25T00:10:00.000Z",
  result: null,
  created_at: "2026-08-25T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z",
} as const satisfies AgentAuthorizationResource);

function dependencies(bootstrapped = true) {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: ownerUserId } : null),
  );
  const issue = vi.fn<AgentAuthorizationService["issue"]>(() =>
    Promise.reject(new AgentAuthorizationMutationDisabledError()),
  );
  const get = vi.fn<AgentAuthorizationService["get"]>(() =>
    Promise.resolve(resource),
  );
  const submitSignature = vi.fn<AgentAuthorizationService["submitSignature"]>(
    () => Promise.reject(new AgentAuthorizationMutationDisabledError()),
  );
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
    issue,
    service: {
      issue,
      get,
      submitSignature,
    } satisfies AgentAuthorizationService,
    submitSignature,
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
    reply.header("cache-control", "no-store");
  });
  registerAgentAuthorizationRoutes(
    app,
    auth.authenticateLoopBearer,
    input.service,
  );
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

describe("Agent authorization routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it("authenticates issue and maps the production mutation gate to 403", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "POST",
      url: "/v1/perp/agent-authorizations",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "perp_mutation_disabled" });
    expectOperationalHeaders(response);
    expect(input.issue).toHaveBeenCalledOnce();
    expect(input.issue.mock.calls[0]?.[0]).toMatchObject({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
    });
    expect(input.issue.mock.calls[0]?.[0].requestId).toMatch(requestIdPattern);
  });

  it("never turns an unexpected issue return into a signable success", async () => {
    const input = dependencies();
    input.issue.mockResolvedValueOnce(resource);
    const app = await harness(input);
    const response = await app.app.inject({
      method: "POST",
      url: "/v1/perp/agent-authorizations",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "agent_authorization_unavailable",
    });
  });

  it("returns an owner-scoped persisted resource from GET", async () => {
    const input = await harness();
    const response = await input.app.inject({
      method: "GET",
      url: `/v1/perp/agent-authorizations/${authorizationId}`,
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(resource);
    expectOperationalHeaders(response);
    expect(input.get).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      authorizationId,
    });
  });

  it("accepts only an opaque signature and maps the current relay gate to 403", async () => {
    const input = await harness();
    const body = { signature: "opaque-privy-signing-result" };
    const response = await input.app.inject({
      method: "POST",
      url: `/v1/perp/agent-authorizations/${authorizationId}/signatures`,
      headers: authHeaders(),
      payload: body,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "perp_mutation_disabled" });
    expect(input.submitSignature).toHaveBeenCalledOnce();
    expect(input.submitSignature.mock.calls[0]?.[0]).toMatchObject({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      authorizationId,
      body,
    });
  });

  it("returns an already durable post-prepare state without requiring another relay", async () => {
    const input = dependencies();
    const accepted = {
      ...resource,
      state: "accepted",
      signature: { state: "consumed" },
    } as const satisfies AgentAuthorizationResource;
    input.submitSignature.mockResolvedValueOnce(accepted);
    const app = await harness(input);
    const response = await app.app.inject({
      method: "POST",
      url: `/v1/perp/agent-authorizations/${authorizationId}/signatures`,
      headers: authHeaders(),
      payload: { signature: "opaque-result" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(accepted);
  });

  it.each([
    ["issue body", "POST", "/v1/perp/agent-authorizations", { x: 1 }, {}],
    [
      "issue query",
      "POST",
      "/v1/perp/agent-authorizations?network=testnet",
      undefined,
      {},
    ],
    [
      "client idempotency",
      "POST",
      "/v1/perp/agent-authorizations",
      undefined,
      { "idempotency-key": randomUUID() },
    ],
    [
      "signature authority",
      "POST",
      `/v1/perp/agent-authorizations/${authorizationId}/signatures`,
      { signature: "opaque", digest: "forbidden" },
      {},
    ],
    [
      "signature whitespace",
      "POST",
      `/v1/perp/agent-authorizations/${authorizationId}/signatures`,
      { signature: "contains space" },
      {},
    ],
    [
      "GET query",
      "GET",
      `/v1/perp/agent-authorizations/${authorizationId}?owner=forbidden`,
      undefined,
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
      expect(input.issue).not.toHaveBeenCalled();
      expect(input.get).not.toHaveBeenCalled();
      expect(input.submitSignature).not.toHaveBeenCalled();
    },
  );

  it("requires a current Bearer token and an existing bootstrap mapping", async () => {
    const missingBearer = await harness();
    const unauthenticated = await missingBearer.app.inject({
      method: "GET",
      url: `/v1/perp/agent-authorizations/${authorizationId}`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["www-authenticate"]).toBe(
      'Bearer realm="loop-api"',
    );
    expect(missingBearer.get).not.toHaveBeenCalled();

    const missingBootstrap = await harness(dependencies(false));
    const unbootstrapped = await missingBootstrap.app.inject({
      method: "GET",
      url: `/v1/perp/agent-authorizations/${authorizationId}`,
      headers: authHeaders(),
    });
    expect(unbootstrapped.statusCode).toBe(409);
    expect(unbootstrapped.json()).toMatchObject({ code: "bootstrap_required" });
    expect(missingBootstrap.get).not.toHaveBeenCalled();
  });

  it.each([
    [
      new AgentAuthorizationNotFoundError(),
      404,
      "agent_authorization_not_found",
    ],
    [new AgentAuthorizationExpiredError(), 409, "agent_authorization_expired"],
    [
      new AgentAuthorizationUnavailableError(),
      503,
      "agent_authorization_unavailable",
    ],
  ] as const)("maps sanitized domain errors", async (error, status, code) => {
    const input = dependencies();
    input.submitSignature.mockRejectedValueOnce(error);
    const app = await harness(input);
    const response = await app.app.inject({
      method: "POST",
      url: `/v1/perp/agent-authorizations/${authorizationId}/signatures`,
      headers: authHeaders(),
      payload: { signature: "opaque-result" },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expectOperationalHeaders(response);
  });

  it.each([
    "/v1/perp/agent-authorizations",
    `/v1/perp/agent-authorizations/${authorizationId}`,
    `/v1/perp/agent-authorizations/${authorizationId}/signatures`,
  ])("does not expose an implicit HEAD alias for %s", async (url) => {
    const input = await harness();
    const response = await input.app.inject({ method: "HEAD", url });

    expect(response.statusCode).toBe(404);
    expect(input.verifyAccessToken).not.toHaveBeenCalled();
    expect(input.issue).not.toHaveBeenCalled();
    expect(input.get).not.toHaveBeenCalled();
    expect(input.submitSignature).not.toHaveBeenCalled();
  });
});
