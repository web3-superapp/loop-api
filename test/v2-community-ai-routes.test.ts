import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { communityAiReasonCodes } from "../src/features/community-ai/community-ai-contract.js";
import type {
  CommunityAiOverviewResource,
  CommunityAiService,
} from "../src/features/community-ai/community-ai-service.js";
import { createUnavailableCommunityRepository } from "../src/features/community/community-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const answerId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const reportId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const quotaSecret = "fedcba9876543210fedcba9876543210";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba";
const generatedAt = "2026-09-22T03:00:00.000Z";

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "community",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
    STREAM_TOKEN_QUOTA_HMAC_SECRET: quotaSecret,
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function commonHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${validToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

function commandHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return commonHeaders({ "idempotency-key": idempotencyKey, ...overrides });
}

function database(): Database {
  return {
    internalUsers: {
      findByPrivyUserId: vi.fn<InternalUserRepository["findByPrivyUserId"]>(
        () => Promise.resolve({ id: accountId }),
      ),
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    deviceSessions: createUnavailableDeviceSessionRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    alerts: createUnavailableAlertRepository(),
    community: createUnavailableCommunityRepository(),
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
}

function serviceFake(overrides: Partial<CommunityAiService> = {}) {
  const ask = vi.fn(() =>
    Promise.resolve({
      answerId,
      answer: "社区现有 42 名成员 [s1]。",
      refusal: null,
      citations: [
        {
          sourceId: "s1",
          kind: "communityProfile" as const,
          label: "社区档案：PEPE",
          observedAt: generatedAt,
        },
      ],
      sources: [
        {
          sourceId: "s1",
          kind: "communityProfile" as const,
          label: "社区档案：PEPE",
          observedAt: generatedAt,
        },
      ],
      omittedSources: [
        {
          kind: "announcements" as const,
          reasonCode: communityAiReasonCodes.announcementSource,
        },
      ],
      model: "claude-sonnet-5",
      generatedAt,
      disclaimer: "本回答由 AI 生成。",
      contractVersion: "2.0" as const,
    }),
  );
  const getOverview = vi.fn(() =>
    Promise.resolve({
      capabilities: [
        {
          capabilityId: "communitySupport" as const,
          title: "社区客服",
          summary: "CA 是什么、怎么买、怎么参与挖矿",
          availability: "available" as const,
          reasonCode: null,
          adminOnly: false,
        },
      ],
      knowledge: {
        sourceCount: 1,
        updatedAt: generatedAt,
        sources: [
          {
            sourceId: "s1",
            kind: "communityProfile" as const,
            label: "社区档案：PEPE",
            observedAt: generatedAt,
          },
        ],
        omittedSources: [],
        documents: {
          status: "unavailable" as const,
          reasonCode: communityAiReasonCodes.knowledgeDocuments,
        },
      },
      exampleQuestions: ["怎么参与挖矿"],
      brief: {
        status: "available" as const,
        messageCount: 42,
        bounded: false,
        windowHours: 24,
        summary: "今天社区在讨论挖矿权重。",
        model: "claude-sonnet-5",
        generatedAt,
      },
      disclaimer: "本回答由 AI 生成。",
      contractVersion: "2.0" as const,
    }),
  );
  const report = vi.fn(() =>
    Promise.resolve({
      answerId,
      reportId,
      reason: "inaccurate" as const,
      createdAt: generatedAt,
      contractVersion: "2.0" as const,
    }),
  );
  return {
    service: {
      ask,
      getOverview,
      report,
      ...overrides,
    },
    ask,
    getOverview,
    report,
  };
}

function expectEnvelope(
  response: LightMyRequestResponse,
  status: number,
  code: string,
): Record<string, unknown> {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = response.json<Record<string, unknown>>();
  expect(Object.keys(body).sort()).toEqual([
    "category",
    "code",
    "correlationId",
    "detailsSafe",
    "providerReferenceSafe",
    "retryable",
    "userMessageKey",
  ]);
  expect(body["code"]).toBe(code);
  return body;
}

describe("LOOP API V2 Community AI routes (Decision 0066)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    options: {
      readonly service?: CommunityAiService;
      readonly overrides?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const privyAccessTokenVerifier = {
      verifyAccessToken: vi.fn(() =>
        Promise.resolve({ privyUserId: "did:privy:verified-user" }),
      ),
    } satisfies PrivyAccessTokenVerifier;
    const app = await buildApp({
      config: testConfig(options.overrides ?? {}),
      contractSurface: "v2",
      database: database(),
      privyAccessTokenVerifier,
      ...(options.service === undefined
        ? {}
        : { communityAiService: options.service }),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  async function readCapability(
    app: FastifyInstance,
  ): Promise<{ availability: string; reasonCode: string | null }> {
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    expect(response.statusCode).toBe(200);
    const entry = response
      .json<{
        readonly capabilities: readonly {
          readonly capabilityId: string;
          readonly availability: string;
          readonly reasonCode: string | null;
        }[];
      }>()
      .capabilities.find((row) => row.capabilityId === "communityAi");
    expect(entry).toBeDefined();
    return {
      availability: String(entry?.availability),
      reasonCode: entry?.reasonCode ?? null,
    };
  }

  it("keeps communityAi deferred and every route closed without an API key", async () => {
    const app = await createApp();
    expect(await readCapability(app)).toEqual({
      availability: "deferred",
      reasonCode: "COMMUNITY_AI_RUNTIME_DEFERRED",
    });
    const overview = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/ai/overview`,
      headers: commonHeaders(),
    });
    const body = expectEnvelope(overview, 503, "CAPABILITY_UNAVAILABLE");
    expect(body["detailsSafe"]).toEqual({
      reasonCode: "COMMUNITY_AI_RUNTIME_DEFERRED",
    });
    const ask = await app.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/ai/ask`,
      headers: commandHeaders(),
      payload: { question: "怎么参与挖矿" },
    });
    expectEnvelope(ask, 503, "CAPABILITY_UNAVAILABLE");
  });

  it("reports communityAi as available once a service is composed", async () => {
    const app = await createApp({ service: serviceFake().service });
    expect(await readCapability(app)).toEqual({
      availability: "available",
      reasonCode: null,
    });
  });

  it("registers no AI route when the community module is disabled", async () => {
    const app = await createApp({
      service: serviceFake().service,
      overrides: { V2_MODULES_ENABLED: "" },
    });
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/ai/overview`,
      headers: commonHeaders(),
    });
    expectEnvelope(response, 404, "NOT_FOUND");
  });

  it("answers a question and publishes the AI label, citations, and disclaimer", async () => {
    const { service, ask } = serviceFake();
    const app = await createApp({ service });
    const response = await app.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/ai/ask`,
      headers: commandHeaders(),
      payload: { question: "社区有多少人" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(body["answerId"]).toBe(answerId);
    expect(body["model"]).toBe("claude-sonnet-5");
    expect(body["generatedAt"]).toBe(generatedAt);
    expect(body["disclaimer"]).toBe("本回答由 AI 生成。");
    expect(body["citations"]).toEqual([
      {
        sourceId: "s1",
        kind: "communityProfile",
        label: "社区档案：PEPE",
        observedAt: generatedAt,
      },
    ]);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId,
        idempotencyKey,
        body: { question: "社区有多少人" },
      }),
    );
  });

  it("requires a UUIDv4 idempotency key on ask and report", async () => {
    const app = await createApp({ service: serviceFake().service });
    for (const headers of [
      commandHeaders({ "idempotency-key": undefined }),
      commandHeaders({ "idempotency-key": "not-a-uuid" }),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v2/communities/${communityId}/ai/ask`,
        headers,
        payload: { question: "社区有多少人" },
      });
      expectEnvelope(response, 400, "INVALID_REQUEST");
    }
  });

  it("rejects an unknown body field and a missing question", async () => {
    const app = await createApp({ service: serviceFake().service });
    for (const payload of [{ question: "社区有多少人", tone: "bullish" }, {}]) {
      const response = await app.inject({
        method: "POST",
        url: `/v2/communities/${communityId}/ai/ask`,
        headers: commandHeaders(),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("forwards the permission, quota, and Provider failures as their own codes", async () => {
    const cases: readonly [V2ApiError, number, string][] = [
      [
        V2ApiError.fromCode("PERMISSION_DENIED", {
          reasonCode: communityAiReasonCodes.notAMember,
        }),
        403,
        "PERMISSION_DENIED",
      ],
      [
        V2ApiError.fromCode("RATE_LIMITED", { scope: "community" }),
        429,
        "RATE_LIMITED",
      ],
      [
        V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
          reasonCode: "COMMUNITY_AI_PROVIDER_MALFORMED",
        }),
        503,
        "CAPABILITY_UNAVAILABLE",
      ],
    ];
    for (const [error, status, code] of cases) {
      const app = await createApp({
        service: serviceFake({
          ask: vi.fn(() => Promise.reject(error)),
        }).service,
      });
      const response = await app.inject({
        method: "POST",
        url: `/v2/communities/${communityId}/ai/ask`,
        headers: commandHeaders(),
        payload: { question: "现在价格多少" },
      });
      expectEnvelope(response, status, code);
    }
  });

  it("publishes the ability list, the knowledge snapshot, and the brief", async () => {
    const app = await createApp({ service: serviceFake().service });
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/ai/overview`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["knowledge"]).toMatchObject({
      sourceCount: 1,
      documents: {
        status: "unavailable",
        reasonCode: communityAiReasonCodes.knowledgeDocuments,
      },
    });
    expect(body["brief"]).toMatchObject({
      status: "available",
      messageCount: 42,
      windowHours: 24,
    });
    expect(body).not.toHaveProperty("documentCount");
  });

  it("publishes a pending brief through the closed reason enum", async () => {
    const available = await serviceFake().getOverview();
    const pending: CommunityAiOverviewResource = {
      ...available,
      brief: {
        status: "unavailable",
        reasonCode: communityAiReasonCodes.briefPending,
      },
    };
    const { service } = serviceFake({
      getOverview: () => Promise.resolve(pending),
    });
    const app = await createApp({ service });
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/ai/overview`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()["brief"]).toEqual({
      status: "unavailable",
      reasonCode: "COMMUNITY_AI_BRIEF_PENDING",
    });
  });

  it("reports one answer and returns 404 for an answer of another account", async () => {
    const app = await createApp({ service: serviceFake().service });
    const created = await app.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/ai/answers/${answerId}/report`,
      headers: commandHeaders(),
      payload: { reason: "inaccurate" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<Record<string, unknown>>()["reportId"]).toBe(reportId);

    const missing = await createApp({
      service: serviceFake({
        report: vi.fn(() => Promise.reject(V2ApiError.fromCode("NOT_FOUND"))),
      }).service,
    });
    const response = await missing.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/ai/answers/${answerId}/report`,
      headers: commandHeaders(),
      payload: { reason: "harmful" },
    });
    expectEnvelope(response, 404, "NOT_FOUND");
  });

  it("rejects an unknown report reason", async () => {
    const app = await createApp({ service: serviceFake().service });
    const response = await app.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/ai/answers/${answerId}/report`,
      headers: commandHeaders(),
      payload: { reason: "spam" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires the Bearer token on every AI route", async () => {
    const app = await createApp({ service: serviceFake().service });
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/ai/overview`,
      headers: commonHeaders({ authorization: undefined }),
    });
    expectEnvelope(response, 401, "AUTH_REQUIRED");
  });
});
