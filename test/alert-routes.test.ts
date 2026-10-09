import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "../src/core/http/authentication.js";
import {
  AlertIdempotencyConflictError,
  AlertIdempotencyResourceDeletedError,
  AlertVersionConflictError,
} from "../src/database/alert-repository.js";
import type { AlertService } from "../src/features/alerts/alert-service.js";
import { AlertNotFoundError } from "../src/features/alerts/alert-service.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import { registerAlertRoutes } from "../src/routes/alerts.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const privyUserId = "did:privy:alert-route-user";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const alertId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const eventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const idempotencyKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const validAccessToken = "header.payload.signature";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const definition = {
  asset_key: "BTC",
  condition: "above",
  threshold_decimal: "64000.00",
  expires_at: null,
} as const;

const resource = Object.freeze({
  alert_id: alertId,
  ...definition,
  state: "inactive" as const,
  evaluation: { state: "unavailable" as const },
  delivery: { state: "unavailable" as const },
  version: 1,
  created_at: "2026-08-25T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z",
});

const preferences = Object.freeze({
  version: 0,
  preferences: [
    { event_type: "price_alert_triggered" as const, enabled: false },
    { event_type: "provider_activity_projected" as const, enabled: false },
    { event_type: "security_notice" as const, enabled: false },
    { event_type: "support_update" as const, enabled: false },
  ],
  delivery: { state: "unavailable" as const },
});

const history = Object.freeze({
  items: [
    {
      event_id: eventId,
      alert_id: alertId,
      asset_key: "BTC",
      condition: "above" as const,
      threshold_decimal: "64000.00",
      value_decimal: "65000.00",
      source: "test_evaluator",
      source_fact_ref: "fact:test:1",
      observed_at: "2026-08-25T00:00:01.000Z",
      created_at: "2026-08-25T00:00:02.000Z",
    },
  ],
  next_offset: null,
});

function dependencies() {
  const verifyAccessToken = vi.fn<
    PrivyAccessTokenVerifier["verifyAccessToken"]
  >(() => Promise.resolve({ privyUserId }));
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve({ id: ownerUserId }),
  );
  const internalUsers = {
    findByPrivyUserId,
    getOrCreateByPrivyUserId: vi.fn<
      InternalUserRepository["getOrCreateByPrivyUserId"]
    >(() => Promise.resolve({ id: ownerUserId })),
  } satisfies InternalUserRepository;
  const list = vi.fn<AlertService["list"]>(() =>
    Promise.resolve({ items: [resource], next_offset: null }),
  );
  const create = vi.fn<AlertService["create"]>(() => Promise.resolve(resource));
  const get = vi.fn<AlertService["get"]>(() => Promise.resolve(resource));
  const replace = vi.fn<AlertService["replace"]>(() =>
    Promise.resolve(resource),
  );
  const remove = vi.fn<AlertService["delete"]>(() => Promise.resolve());
  const listHistory = vi.fn<AlertService["history"]>(() =>
    Promise.resolve(history),
  );
  const getNotificationPreferences = vi.fn<
    AlertService["getNotificationPreferences"]
  >(() => Promise.resolve(preferences));
  const replaceNotificationPreferences = vi.fn<
    AlertService["replaceNotificationPreferences"]
  >(() => Promise.resolve(preferences));

  return {
    create,
    findByPrivyUserId,
    get,
    getNotificationPreferences,
    internalUsers,
    list,
    listHistory,
    remove,
    replace,
    replaceNotificationPreferences,
    service: {
      list,
      create,
      get,
      replace,
      delete: remove,
      history: listHistory,
      getNotificationPreferences,
      replaceNotificationPreferences,
    } satisfies AlertService,
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
  registerAlertRoutes(app, auth.authenticateLoopBearer, input.service);
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

function authHeaders(extra: Record<string, string | string[]> = {}) {
  return { authorization: `Bearer ${validAccessToken}`, ...extra };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("Alert routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function harness(input = dependencies()) {
    const created = await createApp(input);
    apps.push(created.app);
    return created;
  }

  it("passes the authenticated owner and canonical idempotency key to create", async () => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "POST",
      url: "/v1/alerts",
      headers: authHeaders({ "idempotency-key": idempotencyKey }),
      payload: definition,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(resource);
    expectOperationalHeaders(response);
    expect(inputs.create).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      idempotencyKey,
      body: definition,
    });
  });

  it.each([
    ["missing", {}],
    ["uppercase", { "idempotency-key": idempotencyKey.toUpperCase() }],
    ["duplicate", { "idempotency-key": [idempotencyKey, idempotencyKey] }],
  ])(
    "rejects a %s Idempotency-Key before authentication",
    async (_name, headers) => {
      const inputs = await harness();
      const response = await inputs.app.inject({
        method: "POST",
        url: "/v1/alerts",
        headers: authHeaders(headers),
        payload: definition,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["numeric threshold", { ...definition, threshold_decimal: 64_000 }],
    ["exponent", { ...definition, threshold_decimal: "6.4e4" }],
    ["provider", { ...definition, source: "hyperliquid" }],
    ["owner", { ...definition, owner_user_id: ownerUserId }],
    ["Firebase", { ...definition, firebase_token: "token" }],
  ])(
    "rejects strict create body with %s before authentication",
    async (_name, payload) => {
      const inputs = await harness();
      const response = await inputs.app.inject({
        method: "POST",
        url: "/v1/alerts",
        headers: authHeaders({ "idempotency-key": idempotencyKey }),
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.create).not.toHaveBeenCalled();
    },
  );

  it("lists definitions with bounded pagination under the derived owner", async () => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/alerts?limit=25&offset=50",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [resource], next_offset: null });
    expectOperationalHeaders(response);
    expect(inputs.list).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      limit: 25,
      offset: 50,
    });
  });

  it.each(["limit=0", "limit=101", "offset=-1", "offset=10001", "x=1"])(
    "rejects invalid pagination %s before authentication",
    async (query) => {
      const inputs = await harness();
      const response = await inputs.app.inject({
        method: "GET",
        url: `/v1/alerts?${query}`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(400);
      expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
      expect(inputs.list).not.toHaveBeenCalled();
    },
  );

  it("keeps the static history route owner-bound and newest-page aware", async () => {
    const inputs = await harness();
    const response = await inputs.app.inject({
      method: "GET",
      url: "/v1/alerts/history?limit=10&offset=5",
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(history);
    expectOperationalHeaders(response);
    expect(inputs.listHistory).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      limit: 10,
      offset: 5,
    });
    expect(inputs.get).not.toHaveBeenCalled();
  });

  it("gets, replaces, and non-enumeratingly deletes one owner alert", async () => {
    const inputs = await harness();
    const getResponse = await inputs.app.inject({
      method: "GET",
      url: `/v1/alerts/${alertId}`,
      headers: authHeaders(),
    });
    const putResponse = await inputs.app.inject({
      method: "PUT",
      url: `/v1/alerts/${alertId}`,
      headers: authHeaders(),
      payload: { ...definition, expected_version: 1 },
    });
    const deleteResponse = await inputs.app.inject({
      method: "DELETE",
      url: `/v1/alerts/${alertId}?expected_version=1`,
      headers: authHeaders(),
    });

    expect(getResponse.statusCode).toBe(200);
    expect(putResponse.statusCode).toBe(200);
    expect(deleteResponse.statusCode).toBe(204);
    expect(deleteResponse.body).toBe("");
    expectOperationalHeaders(getResponse);
    expectOperationalHeaders(putResponse);
    expectOperationalHeaders(deleteResponse);
    expect(inputs.replace).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      alertId,
      body: { ...definition, expected_version: 1 },
    });
    expect(inputs.remove).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      alertId,
      expectedVersion: 1,
    });
  });

  it("returns fixed preferences while keeping delivery unavailable", async () => {
    const inputs = await harness();
    const getResponse = await inputs.app.inject({
      method: "GET",
      url: "/v1/notification-preferences",
      headers: authHeaders(),
    });
    const desired = preferences.preferences.map((preference, index) => ({
      ...preference,
      enabled: index === 0,
    }));
    const putResponse = await inputs.app.inject({
      method: "PUT",
      url: "/v1/notification-preferences",
      headers: authHeaders(),
      payload: { expected_version: 0, preferences: desired },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(preferences);
    expect(putResponse.statusCode).toBe(200);
    expect(
      putResponse.json<{ delivery: { state: string } }>().delivery,
    ).toEqual({ state: "unavailable" });
    expectOperationalHeaders(getResponse);
    expectOperationalHeaders(putResponse);
    expect(inputs.replaceNotificationPreferences).toHaveBeenCalledWith({
      principal: { userId: ownerUserId, privyUserId, streamUserId },
      body: { expected_version: 0, preferences: desired },
    });
  });

  it("rejects incomplete preferences and forbidden idempotency before auth", async () => {
    const inputs = await harness();
    const incomplete = await inputs.app.inject({
      method: "PUT",
      url: "/v1/notification-preferences",
      headers: authHeaders(),
      payload: {
        expected_version: 0,
        preferences: preferences.preferences.slice(0, 3),
      },
    });
    const forbiddenHeader = await inputs.app.inject({
      method: "PUT",
      url: "/v1/notification-preferences",
      headers: authHeaders({ "idempotency-key": idempotencyKey }),
      payload: { expected_version: 0, preferences: preferences.preferences },
    });

    expect(incomplete.statusCode).toBe(400);
    expect(forbiddenHeader.statusCode).toBe(400);
    expect(inputs.verifyAccessToken).not.toHaveBeenCalled();
    expect(inputs.replaceNotificationPreferences).not.toHaveBeenCalled();
  });

  it.each([
    [new AlertIdempotencyConflictError(), "idempotency_conflict", 409],
    [
      new AlertIdempotencyResourceDeletedError(),
      "idempotency_resource_deleted",
      409,
    ],
    [new AlertVersionConflictError(), "version_conflict", 409],
    [new AlertNotFoundError(), "alert_not_found", 404],
  ] as const)("maps %s to %s", async (error, code, statusCode) => {
    const inputs = dependencies();
    inputs.create.mockRejectedValueOnce(error);
    inputs.replace.mockRejectedValueOnce(error);
    inputs.get.mockRejectedValueOnce(error);
    const app = await harness(inputs);
    const request =
      error instanceof AlertIdempotencyConflictError ||
      error instanceof AlertIdempotencyResourceDeletedError
        ? {
            method: "POST" as const,
            url: "/v1/alerts",
            headers: authHeaders({ "idempotency-key": idempotencyKey }),
            payload: definition,
          }
        : error instanceof AlertVersionConflictError
          ? {
              method: "PUT" as const,
              url: `/v1/alerts/${alertId}`,
              headers: authHeaders(),
              payload: { ...definition, expected_version: 1 },
            }
          : {
              method: "GET" as const,
              url: `/v1/alerts/${alertId}`,
              headers: authHeaders(),
            };
    const response = await app.app.inject(request);
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ code });
    expectOperationalHeaders(response);
  });
});
