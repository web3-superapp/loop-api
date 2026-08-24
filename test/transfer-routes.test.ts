import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import {
  TransferUnavailableError,
  type TransferService,
} from "../src/features/transfer/transfer-service.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerTransferRoutes } from "../src/routes/transfers.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:transfer-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const validAccessToken = "header.payload.signature";
const formatterDigest = "a".repeat(64);
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function dependencies(bootstrapped = true) {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve(bootstrapped ? { id: ownerUserId } : null),
  );
  const unavailable = (): Promise<never> =>
    Promise.reject(new TransferUnavailableError());
  const listAssets = vi.fn<TransferService["listAssets"]>(unavailable);
  const recipientPreflight =
    vi.fn<TransferService["recipientPreflight"]>(unavailable);
  const prepareReview = vi.fn<TransferService["prepareReview"]>(unavailable);
  const authorize = vi.fn<TransferService["authorize"]>(unavailable);
  const readCurrentResult =
    vi.fn<TransferService["readCurrentResult"]>(unavailable);
  const readReconciliation =
    vi.fn<TransferService["readReconciliation"]>(unavailable);
  const service = {
    listAssets,
    recipientPreflight,
    prepareReview,
    authorize,
    readCurrentResult,
    readReconciliation,
  } satisfies TransferService;
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;

  return {
    authorize,
    findByPrivyUserId,
    internalUsers,
    listAssets,
    prepareReview,
    readCurrentResult,
    readReconciliation,
    recipientPreflight,
    service,
    verifier: { verifyAccessToken } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

type Dependencies = ReturnType<typeof dependencies>;

function serviceCallCount(input: Dependencies): number {
  return (
    input.listAssets.mock.calls.length +
    input.recipientPreflight.mock.calls.length +
    input.prepareReview.mock.calls.length +
    input.authorize.mock.calls.length +
    input.readCurrentResult.mock.calls.length +
    input.readReconciliation.mock.calls.length
  );
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
  });
  registerTransferRoutes(app, auth.authenticateLoopBearer, input.service);
  app.setNotFoundHandler(async (request, reply) => {
    reply.header("cache-control", "no-store");
    return reply.code(404).send({
      code: "not_found",
      message: "The requested resource does not exist.",
      request_id: request.id,
    });
  });
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

const validRequests = [
  {
    label: "asset selections",
    method: "GET",
    url: "/v1/transfer/assets",
    serviceMethod: "listAssets",
  },
  {
    label: "recipient resolve",
    method: "POST",
    url: "/v1/transfer/recipient-preflight",
    payload: {
      command: "resolve",
      asset_selection_id: { unresolved: true },
      recipient_input: ["unresolved"],
    },
    serviceMethod: "recipientPreflight",
  },
  {
    label: "recipient acknowledgement",
    method: "POST",
    url: "/v1/transfer/recipient-preflight",
    payload: {
      command: "acknowledge",
      preflight_handle: null,
      acknowledgement_kind: "first_recipient",
    },
    serviceMethod: "recipientPreflight",
  },
  {
    label: "review preparation",
    method: "POST",
    url: "/v1/transfer/reviews",
    payload: {
      preflight_handle: 42,
      amount_decimal: "1.25",
    },
    serviceMethod: "prepareReview",
  },
  {
    label: "authorization issue",
    method: "POST",
    url: "/v1/transfer/authorize",
    payload: {
      command: "issue_payload",
      prepared_review_handle: { unresolved: true },
    },
    serviceMethod: "authorize",
  },
  {
    label: "authorization submission",
    method: "POST",
    url: "/v1/transfer/authorize",
    payload: {
      command: "submit_signature",
      prepared_review_handle: null,
      authorization_signature: "opaque-signature",
      official_formatter_envelope_sha256: formatterDigest,
    },
    serviceMethod: "authorize",
  },
  {
    label: "current result",
    method: "GET",
    url: "/v1/transfer/current-result",
    serviceMethod: "readCurrentResult",
  },
  {
    label: "reconciliation",
    method: "GET",
    url: "/v1/transfer/reconciliation",
    serviceMethod: "readReconciliation",
  },
] as const;

type TransferServiceMethod = (typeof validRequests)[number]["serviceMethod"];

function makeServiceResolve(
  input: Dependencies,
  serviceMethod: TransferServiceMethod,
): void {
  switch (serviceMethod) {
    case "listAssets":
      input.listAssets.mockImplementation(() =>
        Promise.resolve(undefined as never),
      );
      return;
    case "recipientPreflight":
      input.recipientPreflight.mockImplementation(() =>
        Promise.resolve(undefined as never),
      );
      return;
    case "prepareReview":
      input.prepareReview.mockImplementation(() =>
        Promise.resolve(undefined as never),
      );
      return;
    case "authorize":
      input.authorize.mockImplementation(() =>
        Promise.resolve(undefined as never),
      );
      return;
    case "readCurrentResult":
      input.readCurrentResult.mockImplementation(() =>
        Promise.resolve(undefined as never),
      );
      return;
    case "readReconciliation":
      input.readReconciliation.mockImplementation(() =>
        Promise.resolve(undefined as never),
      );
  }
}

describe("Transfer routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it.each(validRequests)(
    "authenticates $label and fails closed without a success projection",
    async (requestCase) => {
      const input = await harness();
      const response = await input.app.inject({
        method: requestCase.method,
        url: requestCase.url,
        headers: authHeaders(),
        ...(requestCase.method === "POST"
          ? { payload: requestCase.payload }
          : {}),
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "transfer_unavailable",
        message: "Transfer operations are unavailable.",
      });
      expectOperationalHeaders(response);
      expect(input.verifyAccessToken).toHaveBeenCalledOnce();
      expect(input.verifyAccessToken).toHaveBeenCalledWith(validAccessToken);
      expect(input.findByPrivyUserId).toHaveBeenCalledWith(privyUserId);
      expect(serviceCallCount(input)).toBe(1);

      const method = input[requestCase.serviceMethod];
      const serviceInput = method.mock.calls[0]?.[0];
      expect(serviceInput).toMatchObject({
        principal: { userId: ownerUserId, privyUserId, streamUserId },
      });
      expect(serviceInput?.requestId).toMatch(requestIdPattern);
      expect(serviceInput?.signal).toBeInstanceOf(AbortSignal);
      if (requestCase.method === "POST") {
        expect(serviceInput).toMatchObject({ body: requestCase.payload });
      }
    },
  );

  it.each(validRequests)(
    "rejects a client idempotency header for $label before authentication",
    async (requestCase) => {
      const input = await harness();
      const response = await input.app.inject({
        method: requestCase.method,
        url: requestCase.url,
        headers: {
          ...authHeaders(),
          "idempotency-key": randomUUID(),
        },
        ...(requestCase.method === "POST"
          ? { payload: requestCase.payload }
          : {}),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expectOperationalHeaders(response);
      expect(input.verifyAccessToken).not.toHaveBeenCalled();
      expect(input.findByPrivyUserId).not.toHaveBeenCalled();
      expect(serviceCallCount(input)).toBe(0);
    },
  );

  it.each(validRequests)(
    "stays unavailable for $label even if the internal service unexpectedly resolves",
    async (requestCase) => {
      const dependenciesWithResolution = dependencies();
      makeServiceResolve(dependenciesWithResolution, requestCase.serviceMethod);
      const input = await harness(dependenciesWithResolution);
      const response = await input.app.inject({
        method: requestCase.method,
        url: requestCase.url,
        headers: authHeaders(),
        ...(requestCase.method === "POST"
          ? { payload: requestCase.payload }
          : {}),
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "transfer_unavailable" });
      expectOperationalHeaders(response);
      expect(serviceCallCount(input)).toBe(1);
      expect(input[requestCase.serviceMethod]).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "privy-app-id",
    "privy-idempotency-key",
    "privy-request-expiry",
    "authorization-signature",
    "privy-authorization-signature",
  ])("rejects client-supplied provider authority header %s", async (header) => {
    const input = await harness();
    const response = await input.app.inject({
      method: "GET",
      url: "/v1/transfer/assets",
      headers: {
        ...authHeaders(),
        [header]: "forbidden",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expectOperationalHeaders(response);
    expect(input.verifyAccessToken).not.toHaveBeenCalled();
    expect(serviceCallCount(input)).toBe(0);
  });

  it.each([
    ["asset query", "GET", "/v1/transfer/assets?cursor=forbidden", undefined],
    [
      "result query",
      "GET",
      "/v1/transfer/current-result?action_id=forbidden",
      undefined,
    ],
    [
      "reconciliation query",
      "GET",
      "/v1/transfer/reconciliation?handle=forbidden",
      undefined,
    ],
    ["GET body", "GET", "/v1/transfer/assets", { forbidden: true }],
    [
      "recipient authority",
      "POST",
      "/v1/transfer/recipient-preflight",
      {
        command: "resolve",
        asset_selection_id: "asset",
        recipient_input: "recipient",
        owner_user_id: ownerUserId,
      },
    ],
    [
      "recipient command",
      "POST",
      "/v1/transfer/recipient-preflight",
      {
        command: "submit_signature",
        asset_selection_id: "asset",
        recipient_input: "recipient",
      },
    ],
    [
      "review authority",
      "POST",
      "/v1/transfer/reviews",
      {
        preflight_handle: "handle",
        amount_decimal: "1.0",
        wallet_id: "forbidden",
      },
    ],
    [
      "nested recipient authority",
      "POST",
      "/v1/transfer/recipient-preflight",
      {
        command: "resolve",
        asset_selection_id: "asset",
        recipient_input: { nested: { wallet_id: "forbidden" } },
      },
    ],
    [
      "review amount number",
      "POST",
      "/v1/transfer/reviews",
      {
        preflight_handle: "handle",
        amount_decimal: 1.25,
      },
    ],
    [
      "authorization digest",
      "POST",
      "/v1/transfer/authorize",
      {
        command: "submit_signature",
        prepared_review_handle: "handle",
        authorization_signature: "signature",
        official_formatter_envelope_sha256: "A".repeat(64),
      },
    ],
    [
      "authorization authority",
      "POST",
      "/v1/transfer/authorize",
      {
        command: "issue_payload",
        prepared_review_handle: "handle",
        url: "https://example.invalid",
      },
    ],
  ] as const)(
    "rejects invalid $0 input before authentication",
    async (_label, method, url, payload) => {
      const input = await harness();
      const response = await input.app.inject({
        method,
        url,
        headers: authHeaders(),
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expectOperationalHeaders(response);
      expect(input.verifyAccessToken).not.toHaveBeenCalled();
      expect(input.findByPrivyUserId).not.toHaveBeenCalled();
      expect(serviceCallCount(input)).toBe(0);
    },
  );

  it.each(validRequests)(
    "requires a Privy Bearer token for $label without calling the service",
    async (requestCase) => {
      const input = await harness();
      const response = await input.app.inject({
        method: requestCase.method,
        url: requestCase.url,
        ...(requestCase.method === "POST"
          ? { payload: requestCase.payload }
          : {}),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "authentication_required",
      });
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer realm="loop-api"',
      );
      expectOperationalHeaders(response);
      expect(input.verifyAccessToken).not.toHaveBeenCalled();
      expect(serviceCallCount(input)).toBe(0);
    },
  );

  it.each(validRequests)(
    "requires an existing bootstrap mapping before $label service work",
    async (requestCase) => {
      const input = await harness(dependencies(false));
      const response = await input.app.inject({
        method: requestCase.method,
        url: requestCase.url,
        headers: authHeaders(),
        ...(requestCase.method === "POST"
          ? { payload: requestCase.payload }
          : {}),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "bootstrap_required" });
      expectOperationalHeaders(response);
      expect(input.verifyAccessToken).toHaveBeenCalledOnce();
      expect(input.findByPrivyUserId).toHaveBeenCalledOnce();
      expect(serviceCallCount(input)).toBe(0);
    },
  );

  it.each([
    "/v1/transfer/assets",
    "/v1/transfer/recipient-preflight",
    "/v1/transfer/reviews",
    "/v1/transfer/authorize",
    "/v1/transfer/current-result",
    "/v1/transfer/reconciliation",
  ])("does not expose an implicit HEAD alias for %s", async (url) => {
    const input = await harness();
    const response = await input.app.inject({ method: "HEAD", url });

    expect(response.statusCode).toBe(404);
    expectOperationalHeaders(response);
    expect(input.verifyAccessToken).not.toHaveBeenCalled();
    expect(serviceCallCount(input)).toBe(0);
  });
});
