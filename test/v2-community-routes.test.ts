import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import {
  createUnavailableControlPlaneRepository,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import {
  CommunityDataStaleError,
  CommunityIdempotencyConflictError,
  CommunityNotFoundError,
  CommunityPermissionDeniedError,
  CommunityProfileRequiredError,
  CommunityRepositoryUnavailableError,
  CommunitySlugTakenError,
  CommunityTargetUnavailableError,
  type CommunityRecord,
  type CommunityRepository,
  type MembershipRecord,
} from "../src/features/community/community-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import {
  createUnavailableMiningRepository,
  type MiningRepository,
} from "../src/features/mining/mining-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherAccountId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const targetProfileId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const messageRequestId = "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const quotaSecret = "fedcba9876543210fedcba9876543210";
const createdAt = "2026-09-07T01:00:00.000Z";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function idempotencyKey(suffix = "a"): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${suffix}`;
}

const community: CommunityRecord = Object.freeze({
  communityId,
  name: "Frog Holders",
  slug: "frog-holders",
  description: null,
  logoRef: "avatar:preset/community-03",
  verificationStatus: "verified",
  boundAssetKey: null,
  memberCount: 2,
  createdAt,
  configVersion: "communityV1",
});

const ownerMembership: MembershipRecord = Object.freeze({
  role: "owner",
  status: "active",
  joinedAt: createdAt,
});

const profile = Object.freeze({
  publicProfileId: targetProfileId,
  loopId: "LOOP-7HJKMNPQ",
  alias: "frog_maxi",
  avatarRef: "avatar:preset/people-03",
});

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "community,search",
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
  return commonHeaders({ "idempotency-key": idempotencyKey(), ...overrides });
}

function communityRepositoryFake() {
  const createCommunityMock = vi.fn(() =>
    Promise.resolve({
      community: { ...community, verificationStatus: "pending" as const },
      viewerMembership: ownerMembership,
    }),
  );
  const updateCommunityMock = vi.fn(() =>
    Promise.resolve({ community, viewerMembership: ownerMembership }),
  );
  const governMemberMock = vi.fn(() =>
    Promise.resolve({
      community,
      actorMembership: ownerMembership,
      target: null,
    }),
  );
  const listCommunitiesMock = vi.fn(() => Promise.resolve([community]));
  const sendMessageRequestMock = vi.fn(() =>
    Promise.resolve({
      messageRequestId,
      profile,
      createdAt,
      expiresAt: "2026-09-14T01:00:00.000Z",
    }),
  );
  const listMembersMock = vi.fn<CommunityRepository["listMembers"]>(() =>
    Promise.resolve({
      community,
      viewerMembership: ownerMembership,
      viewerPublicProfileId: targetProfileId,
      items: [
        {
          membershipId: communityId,
          role: "owner" as const,
          status: "active" as const,
          joinedAt: createdAt,
          profile,
        },
      ],
      counts: { all: 2, owner: 1, admin: 0 },
    }),
  );
  const repository: CommunityRepository = {
    listCommunities: listCommunitiesMock,
    getCommunityHome: vi.fn(() =>
      Promise.resolve({
        joined: [{ community, viewerMembership: ownerMembership }],
        joinedTruncated: true,
        discover: [community],
        observedAt: createdAt,
      }),
    ),
    getCommunity: vi.fn(() =>
      Promise.resolve({ community, viewerMembership: ownerMembership }),
    ),
    createCommunity: createCommunityMock,
    updateCommunity: updateCommunityMock,
    joinCommunity: vi.fn(() =>
      Promise.resolve({ community, viewerMembership: ownerMembership }),
    ),
    leaveCommunity: vi.fn(() =>
      Promise.resolve({ community, viewerMembership: null }),
    ),
    listMembers: listMembersMock,
    governMember: governMemberMock,
    follow: vi.fn(() =>
      Promise.resolve({ profile, createdAt, viewerFollows: true }),
    ),
    unfollow: vi.fn(() => Promise.resolve(profile)),
    listConnections: vi.fn(() =>
      Promise.resolve([{ profile, createdAt, viewerFollows: true }]),
    ),
    countConnections: vi.fn(() =>
      Promise.resolve({ following: 1, followers: 4 }),
    ),
    blockUser: vi.fn(() =>
      Promise.resolve({
        kind: "user" as const,
        stableId: targetProfileId,
        profile,
        reasonCode: "user_request",
        createdAt,
      }),
    ),
    unblockUser: vi.fn(() => Promise.resolve()),
    listBlocks: vi.fn(() =>
      Promise.resolve([
        {
          kind: "user" as const,
          stableId: targetProfileId,
          profile,
          reasonCode: "user_request",
          createdAt,
        },
      ]),
    ),
    countBlocks: vi.fn(() => Promise.resolve({ user: 1 })),
    listMessageRequests: vi.fn(() =>
      Promise.resolve([
        {
          messageRequestId,
          profile,
          createdAt,
          expiresAt: "2026-09-14T01:00:00.000Z",
        },
      ]),
    ),
    sendMessageRequest: sendMessageRequestMock,
    decideMessageRequest: vi.fn(() =>
      Promise.resolve({
        messageRequestId,
        decision: "report" as const,
        blocked: true,
      }),
    ),
    searchUsers: vi.fn(() =>
      Promise.resolve([{ profile, searchKey: "frog_maxi" }]),
    ),
    searchCommunities: vi.fn(() =>
      Promise.resolve([
        { community, searchKey: "frog holders", viewerJoined: true },
      ]),
    ),
    verifyCommunity: vi.fn(() => Promise.resolve(community)),
  };
  return {
    repository,
    listCommunitiesMock,
    listMembersMock,
    sendMessageRequestMock,
    createCommunityMock,
    updateCommunityMock,
    governMemberMock,
  };
}

function fakes(options: { readonly quotaExceeded?: boolean } = {}) {
  const verifyAccessToken = vi.fn(() =>
    Promise.resolve({ privyUserId: "did:privy:verified-user" }),
  );
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve({ id: accountId }),
  );
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() =>
    options.quotaExceeded === true
      ? Promise.reject(new IssuanceQuotaExceededError())
      : Promise.resolve([]),
  );
  const {
    repository: communityRepository,
    listCommunitiesMock,
    listMembersMock,
    sendMessageRequestMock,
    createCommunityMock,
    updateCommunityMock,
    governMemberMock,
  } = communityRepositoryFake();
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: {
      ...createUnavailableControlPlaneRepository(),
      consumeIssuanceQuota,
    },
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    community: communityRepository,
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId,
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  const privyAccessTokenVerifier = {
    verifyAccessToken,
  } satisfies PrivyAccessTokenVerifier;

  return {
    communityRepository,
    listCommunitiesMock,
    listMembersMock,
    sendMessageRequestMock,
    createCommunityMock,
    updateCommunityMock,
    governMemberMock,
    consumeIssuanceQuota,
    database,
    privyAccessTokenVerifier,
    verifyAccessToken,
  };
}

function expectOperationalHeaders(response: {
  readonly headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toMatch(requestIdPattern);
}

describe("LOOP API V2 community, social, and search modules", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies: Omit<ReturnType<typeof fakes>, "database"> & {
      readonly database: Database;
    } = fakes(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("registers no community or search route when the modules are disabled", async () => {
    const { app, verifyAccessToken } = await createApp(fakes(), {
      V2_MODULES_ENABLED: "",
    });
    for (const [method, url] of [
      ["GET", "/v2/community/home"],
      ["GET", "/v2/communities"],
      ["POST", "/v2/communities"],
      ["GET", "/v2/communities/3fa85f64-5717-4562-b3fc-2c963f66afa6/members"],
      ["GET", "/v2/connections"],
      ["GET", "/v2/blocks"],
      ["GET", "/v2/message-requests"],
      ["GET", "/v2/mining/referral/rules"],
      ["GET", "/v2/search?domain=users&q=fr"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: commandHeaders(),
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({
        code: "NOT_FOUND",
        category: "validation",
      });
    }
    expect(verifyAccessToken).not.toHaveBeenCalled();

    const capabilities = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const entries = capabilities.json<{
      capabilities: {
        capabilityId: string;
        availability: string;
        reasonCode: string | null;
      }[];
    }>().capabilities;
    expect(
      entries.find((entry) => entry.capabilityId === "community"),
    ).toMatchObject({
      availability: "deferred",
      reasonCode: "V2_COMMUNITY_RUNTIME_DEFERRED",
    });
    expect(
      entries.find((entry) => entry.capabilityId === "search"),
    ).toMatchObject({
      availability: "deferred",
      reasonCode: "V2_SEARCH_RUNTIME_DEFERRED",
    });
  });

  it("publishes community and search as available and the two derived facts as unavailable", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const entries = response.json<{
      capabilities: {
        capabilityId: string;
        availability: string;
        reasonCode: string | null;
      }[];
    }>().capabilities;
    const byId = Object.fromEntries(
      entries.map((entry) => [entry.capabilityId, entry]),
    );
    expect(byId["community"]).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
    expect(byId["search"]).toMatchObject({
      availability: "available",
      reasonCode: null,
    });
    // Decision 0043: communityMining follows the mining module gate and the
    // formula fact; this app does not enable `mining`, so it is deferred.
    expect(byId["communityMining"]).toMatchObject({
      availability: "deferred",
      reasonCode: "V2_MINING_RUNTIME_DEFERRED",
      evidence: {
        status: "pending",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      },
    });
    expect(byId["communityPresence"]).toMatchObject({
      availability: "unavailable",
      reasonCode: "STREAM_PRESENCE_NOT_CONNECTED",
    });
  });

  it("fails the community capability closed without a cursor secret", async () => {
    const { app } = await createApp(fakes(), {
      V2_CURSOR_HMAC_SECRET: "",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const entries = response.json<{
      capabilities: { capabilityId: string; reasonCode: string | null }[];
    }>().capabilities;
    expect(
      entries.find((entry) => entry.capabilityId === "community"),
    ).toMatchObject({ reasonCode: "COMMUNITY_RUNTIME_UNAVAILABLE" });
  });

  it("projects the community home aggregate with unavailable Stream facts", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/community/home",
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectOperationalHeaders(response);
    const body = response.json<Record<string, unknown>>();
    expect(body["unread"]).toEqual({
      status: "unavailable",
      reasonCode: "STREAM_UNREAD_NOT_CONNECTED",
    });
    expect(body["liveVoice"]).toEqual({
      status: "unavailable",
      reasonCode: "STREAM_VOICE_NOT_CONNECTED",
    });
    expect(body["joined"]).toMatchObject({ truncated: true });
    expect(body["freshness"]).toEqual({
      observedAt: createdAt,
      source: "database",
    });
    expect(body["recommendation"]).toMatchObject({
      ruleVersion: "rule:verified-members-v1",
    });
    expect(JSON.stringify(body)).not.toContain("profile_code");
  });

  it("returns the fixed identity projection without profile_code or a wallet", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      viewer: Record<string, unknown>;
      counts: Record<string, unknown>;
      items: { profile: Record<string, unknown>; miningPower: unknown }[];
    }>();
    expect(Object.keys(body.items[0]?.profile ?? {}).sort()).toEqual([
      "alias",
      "avatarRef",
      "loopId",
      "publicProfileId",
    ]);
    expect(body.items[0]?.miningPower).toEqual({
      status: "unavailable",
      reasonCode: "MINING_FORMULA_BASELINE_PENDING",
    });
    expect(body.counts["online"]).toEqual({
      status: "unavailable",
      reasonCode: "STREAM_PRESENCE_NOT_CONNECTED",
    });
    expect(body.viewer).toEqual({
      membership: { role: "owner", status: "active", joinedAt: createdAt },
      canInviteAdmin: true,
      canMute: true,
      canBan: true,
    });
  });

  it("publishes each member row's own governance commands, not the viewer's flags", async () => {
    const adminMembership: MembershipRecord = {
      role: "admin",
      status: "active",
      joinedAt: createdAt,
    };
    const otherAdminId = "5f4e3d2c-1b0a-4987-8765-43210fedcba9";
    const memberId = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
    const ownerId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const dependencies = fakes();
    dependencies.listMembersMock.mockResolvedValue({
      community,
      viewerMembership: adminMembership,
      // The viewer is the admin whose own row carries `targetProfileId`.
      viewerPublicProfileId: targetProfileId,
      items: [
        {
          membershipId: "11111111-1111-4111-8111-111111111111",
          role: "owner" as const,
          status: "active" as const,
          joinedAt: createdAt,
          profile: { ...profile, publicProfileId: ownerId },
        },
        {
          membershipId: "22222222-2222-4222-8222-222222222222",
          role: "admin" as const,
          status: "active" as const,
          joinedAt: createdAt,
          profile: { ...profile, publicProfileId: otherAdminId },
        },
        {
          membershipId: "33333333-3333-4333-8333-333333333333",
          role: "admin" as const,
          status: "active" as const,
          joinedAt: createdAt,
          profile,
        },
        {
          membershipId: "44444444-4444-4444-8444-444444444444",
          role: "member" as const,
          status: "active" as const,
          joinedAt: createdAt,
          profile: { ...profile, publicProfileId: memberId },
        },
        {
          membershipId: "55555555-5555-4555-8555-555555555555",
          role: "member" as const,
          status: "muted" as const,
          joinedAt: createdAt,
          profile: { ...profile, publicProfileId: memberId },
        },
        {
          membershipId: "66666666-6666-4666-8666-666666666666",
          role: "member" as const,
          status: "active" as const,
          joinedAt: createdAt,
          profile: { ...profile, publicProfileId: null },
        },
      ],
      counts: { all: 6, owner: 1, admin: 2 },
    });
    const { app } = await createApp(dependencies);

    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      viewer: Record<string, unknown>;
      items: {
        role: string;
        status: string;
        isSelf: boolean;
        actions: string[];
      }[];
    }>();
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      "actions",
      "isSelf",
      "joinedAt",
      "miningPower",
      "profile",
      "role",
      "status",
    ]);
    // The viewer-level flags still say this admin may mute and ban somewhere
    // in the community...
    expect(body.viewer).toMatchObject({ canMute: true, canBan: true });
    // ...but no row the matrix denies carries the command.
    expect(body.items.map((item) => item.actions)).toEqual([
      // The owner is never a target.
      [],
      // Another admin: the cell that used to offer a doomed mute and ban.
      [],
      // The viewer's own row.
      [],
      ["mute", "ban"],
      ["unmute", "ban"],
      // No public profile ID, so no command can name the row.
      [],
    ]);
    expect(body.items[2]?.isSelf).toBe(true);
  });

  it("gives a banned row exactly one published command", async () => {
    const dependencies = fakes();
    dependencies.listMembersMock.mockResolvedValue({
      community,
      viewerMembership: ownerMembership,
      viewerPublicProfileId: null,
      items: [
        {
          membershipId: communityId,
          role: "member" as const,
          status: "banned" as const,
          joinedAt: createdAt,
          profile,
        },
      ],
      counts: { all: 2, owner: 1, admin: 0 },
    });
    const { app } = await createApp(dependencies);

    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?role=banned`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ items: { actions: string[] }[] }>().items[0]?.actions,
    ).toEqual(["unban"]);
  });

  it("passes the banned governance filter through and projects the banned status", async () => {
    const dependencies = fakes();
    dependencies.listMembersMock.mockResolvedValue({
      community,
      viewerMembership: ownerMembership,
      viewerPublicProfileId: targetProfileId,
      items: [
        {
          membershipId: communityId,
          role: "member" as const,
          status: "banned" as const,
          joinedAt: createdAt,
          profile,
        },
      ],
      counts: { all: 2, owner: 1, admin: 0 },
    });
    const { app, listMembersMock } = await createApp(dependencies);

    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?role=banned`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(listMembersMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "banned" }),
    );
    expect(
      response.json<{ items: { status: string }[] }>().items[0]?.status,
    ).toBe("banned");
  });

  it("denies the banned governance filter to a viewer who may not ban", async () => {
    const dependencies = fakes();
    dependencies.listMembersMock.mockRejectedValue(
      new CommunityPermissionDeniedError(),
    );
    const { app } = await createApp(dependencies);

    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?role=banned`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("requires exactly one canonical Idempotency-Key on every write", async () => {
    const { app } = await createApp();
    for (const headers of [
      commonHeaders(),
      commandHeaders({ "idempotency-key": "not-a-uuid" }),
      commandHeaders({
        "idempotency-key": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      }),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v2/communities/${communityId}/join`,
        headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("rejects an Idempotency-Key on a read", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/communities",
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("maps every repository failure onto its V2 catalog code", async () => {
    const cases = [
      [new CommunityPermissionDeniedError(), 403, "PERMISSION_DENIED"],
      [new CommunityProfileRequiredError(), 409, "PROFILE_ACTIVATION_REQUIRED"],
      [new CommunityNotFoundError(), 404, "NOT_FOUND"],
      [new CommunityTargetUnavailableError(), 404, "NOT_FOUND"],
      [new CommunityDataStaleError(), 409, "DATA_STALE"],
      [new CommunityIdempotencyConflictError(), 409, "IDEMPOTENCY_CONFLICT"],
      [new CommunitySlugTakenError(), 409, "RESOURCE_CONFLICT"],
      [
        new CommunityRepositoryUnavailableError(),
        503,
        "CAPABILITY_UNAVAILABLE",
      ],
    ] as const;
    for (const [error, statusCode, code] of cases) {
      const dependencies = fakes();
      dependencies.communityRepository.joinCommunity = vi.fn(() =>
        Promise.reject(error),
      );
      const { app } = await createApp(dependencies);
      const response = await app.inject({
        method: "POST",
        url: `/v2/communities/${communityId}/join`,
        headers: commandHeaders(),
      });
      expect(response.statusCode, code).toBe(statusCode);
      expect(response.json()).toMatchObject({ code });
    }
  });

  it("rejects a reserved community name before any write", async () => {
    const { app, createCommunityMock } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/communities",
      headers: commandHeaders(),
      payload: {
        name: "LOOP Official",
        slug: "loop-official",
        description: null,
        logoRef: null,
        boundAssetKey: null,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "ALIAS_RESERVED" });
    expect(createCommunityMock).not.toHaveBeenCalled();
  });

  it("normalizes the bound asset key and creates a pending community", async () => {
    const { app, createCommunityMock } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/communities",
      headers: commandHeaders(),
      payload: {
        name: "Frog Holders",
        slug: "frog-holders",
        description: "  Frogs only  ",
        logoRef: "avatar:preset/community-03",
        boundAssetKey: "eip155:56:0xAABBCCDDEEFF00112233445566778899AABBCCDD",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      community: { verificationStatus: "pending" },
    });
    expect(createCommunityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundAssetKey: "eip155:56:0xaabbccddeeff00112233445566778899aabbccdd",
        description: "Frogs only",
      }),
    );
  });

  it("keeps contract and domain blocks unavailable in every verb", async () => {
    const { app } = await createApp();
    for (const kind of ["contract", "domain"] as const) {
      const list = await app.inject({
        method: "GET",
        url: `/v2/blocks?kind=${kind}`,
        headers: commonHeaders(),
      });
      expect(list.statusCode).toBe(503);
      expect(list.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

      for (const method of ["POST", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url: "/v2/blocks",
          headers: commandHeaders(),
          payload: { kind, stableId: "0x1234" },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          code: "CAPABILITY_UNAVAILABLE",
        });
      }
    }
  });

  it("reports a message-request report as rejected plus blocked", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/v2/message-requests/${messageRequestId}/decision`,
      headers: commandHeaders(),
      payload: { decision: "report" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messageRequestId,
      decision: "report",
      blocked: true,
      contractVersion: "2.0",
    });
  });

  it("sends a message request and projects it like a directory item", async () => {
    const { app, sendMessageRequestMock } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/message-requests",
      headers: commandHeaders(),
      payload: { targetPublicProfileId: targetProfileId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messageRequestId,
      profile,
      createdAt,
      expiresAt: "2026-09-14T01:00:00.000Z",
      preview: {
        status: "unavailable",
        reasonCode: "MESSAGE_PREVIEW_DEFERRED",
      },
      aiModeration: {
        status: "unavailable",
        reasonCode: "AI_MODERATION_DEFERRED",
      },
      contractVersion: "2.0",
    });
    expect(sendMessageRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetPublicProfileId: targetProfileId }),
    );
  });

  it("rejects a malformed or unknown-property message-request body", async () => {
    const { app } = await createApp();
    for (const payload of [
      {},
      { targetPublicProfileId: "not-a-uuid" },
      { targetPublicProfileId: targetProfileId, note: "hi" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v2/message-requests",
        headers: commandHeaders(),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("maps an ineligible message-request target onto NOT_FOUND and a stale pair onto DATA_STALE", async () => {
    for (const [error, status, code] of [
      [new CommunityTargetUnavailableError(), 404, "NOT_FOUND"],
      [new CommunityDataStaleError(), 409, "DATA_STALE"],
    ] as const) {
      const dependencies = fakes();
      dependencies.sendMessageRequestMock.mockRejectedValue(error);
      const { app } = await createApp(dependencies);
      const response = await app.inject({
        method: "POST",
        url: "/v2/message-requests",
        headers: commandHeaders(),
        payload: { targetPublicProfileId: targetProfileId },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    }
  });

  it("hides message preview and AI moderation behind unavailable", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/message-requests",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: { preview: unknown; aiModeration: unknown }[];
    }>();
    expect(body.items[0]?.preview).toEqual({
      status: "unavailable",
      reasonCode: "MESSAGE_PREVIEW_DEFERRED",
    });
    expect(body.items[0]?.aiModeration).toEqual({
      status: "unavailable",
      reasonCode: "AI_MODERATION_DEFERRED",
    });
  });

  it("answers the three deferred search domains with 200 and status unavailable", async () => {
    const { app, consumeIssuanceQuota } = await createApp();
    for (const [domain, reasonCode] of [
      ["assets", "ASSET_REGISTRY_DEFERRED"],
      ["launch", "LAUNCH_MODULE_DEFERRED"],
      ["dapps", "DAPP_DIRECTORY_DEFERRED"],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/search?domain=${domain}&q=frog`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        domain,
        status: "unavailable",
        reasonCode,
        results: [],
        nextCursor: null,
        contractVersion: "2.0",
      });
    }
    expect(consumeIssuanceQuota).not.toHaveBeenCalled();
  });

  it("consumes the shared public search quota for users and communities", async () => {
    const { app, consumeIssuanceQuota } = await createApp();
    for (const domain of ["users", "communities"] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/search?domain=${domain}&q=frog`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "available" });
    }
    expect(consumeIssuanceQuota).toHaveBeenCalledTimes(2);
    expect(
      consumeIssuanceQuota.mock.calls.every(
        ([input]) => input.capability === "public_alias_search",
      ),
    ).toBe(true);
  });

  it("rate limits search from the same quota bucket", async () => {
    const { app } = await createApp(fakes({ quotaExceeded: true }));
    const response = await app.inject({
      method: "GET",
      url: "/v2/search?domain=users&q=frog",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "RATE_LIMITED",
      category: "rateLimit",
    });
  });

  it("returns a canonical destination and never a client-built route", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/search?domain=communities&q=frog",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      results: {
        resultType: string;
        stableId: string;
        destination: Record<string, unknown>;
      }[];
    }>();
    expect(body.results[0]).toMatchObject({
      resultType: "community",
      stableId: communityId,
      destination: { kind: "communityProfile" },
    });
  });

  it("rejects a short search prefix and an unknown domain", async () => {
    const { app } = await createApp();
    const short = await app.inject({
      method: "GET",
      url: "/v2/search?domain=users&q=f",
      headers: commonHeaders(),
    });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const unknown = await app.inject({
      method: "GET",
      url: "/v2/search?domain=chat&q=frog",
      headers: commonHeaders(),
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("binds a list cursor to the owner, route, and filter", async () => {
    const dependencies = fakes();
    dependencies.communityRepository.listCommunities = vi.fn(() =>
      Promise.resolve(
        Array.from({ length: 21 }, (_value, index) => ({
          ...community,
          communityId: `3fa85f64-5717-4562-b3fc-2c963f66af${String(index).padStart(2, "0")}`,
          memberCount: 100 - index,
        })),
      ),
    );
    const { app } = await createApp(dependencies);
    const first = await app.inject({
      method: "GET",
      url: "/v2/communities?sort=members&verification=verified",
      headers: commonHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;
    expect(cursor).not.toBeNull();

    const replayed = await app.inject({
      method: "GET",
      url: `/v2/communities?sort=members&verification=verified&cursor=${encodeURIComponent(cursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(replayed.statusCode).toBe(200);

    const wrongFilter = await app.inject({
      method: "GET",
      url: `/v2/communities?sort=newest&verification=verified&cursor=${encodeURIComponent(cursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(wrongFilter.statusCode).toBe(400);
    expect(wrongFilter.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const wrongRoute = await app.inject({
      method: "GET",
      url: `/v2/connections?direction=following&cursor=${encodeURIComponent(cursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(wrongRoute.statusCode).toBe(400);

    const withLimit = await app.inject({
      method: "GET",
      url: `/v2/communities?sort=members&verification=verified&limit=5&cursor=${encodeURIComponent(cursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(withLimit.statusCode).toBe(400);
  });

  it("invalidates a cursor issued for another account", async () => {
    const dependencies = fakes();
    dependencies.communityRepository.listCommunities = vi.fn(() =>
      Promise.resolve(
        Array.from({ length: 21 }, (_value, index) => ({
          ...community,
          communityId: `3fa85f64-5717-4562-b3fc-2c963f66af${String(index).padStart(2, "0")}`,
          memberCount: 100 - index,
        })),
      ),
    );
    const { app, database } = await createApp(dependencies);
    const first = await app.inject({
      method: "GET",
      url: "/v2/communities?sort=members&verification=verified",
      headers: commonHeaders(),
    });
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;

    database.internalUsers.findByPrivyUserId = vi.fn(() =>
      Promise.resolve({ id: otherAccountId }),
    );
    const replayed = await app.inject({
      method: "GET",
      url: `/v2/communities?sort=members&verification=verified&cursor=${encodeURIComponent(cursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("passes each governance verb to the repository as its matrix action", async () => {
    const { app, governMemberMock } = await createApp();
    const cases = [
      ["POST", "role", { role: "admin" }, "assignAdmin"],
      ["POST", "role", { role: "member" }, "revokeAdmin"],
      ["POST", "role", { role: "owner" }, "transferOwnership"],
      ["POST", "mute", undefined, "mute"],
      ["DELETE", "mute", undefined, "unmute"],
      ["POST", "ban", undefined, "ban"],
      ["DELETE", "ban", undefined, "unban"],
    ] as const;
    for (const [method, path, payload, action] of cases) {
      const response = await app.inject({
        method,
        url: `/v2/communities/${communityId}/members/${targetProfileId}/${path}`,
        headers: commandHeaders(),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, action).toBe(200);
      expect(governMemberMock).toHaveBeenCalledWith(
        expect.objectContaining({ action }),
      );
    }
  });

  it("edits the community profile through the owner-only PATCH route", async () => {
    const { app, updateCommunityMock } = await createApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/v2/communities/${communityId}`,
      headers: commandHeaders(),
      payload: { description: "  Frogs, updated  ", boundAssetKey: null },
    });
    expect(response.statusCode).toBe(200);
    expect(updateCommunityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        values: { description: "Frogs, updated", boundAssetKey: null },
      }),
    );

    for (const payload of [
      {},
      { slug: "renamed" },
      { verificationStatus: "verified" },
    ]) {
      const rejected = await app.inject({
        method: "PATCH",
        url: `/v2/communities/${communityId}`,
        headers: commandHeaders(),
        payload,
      });
      expect(rejected.statusCode).toBe(400);
    }

    const reserved = await app.inject({
      method: "PATCH",
      url: `/v2/communities/${communityId}`,
      headers: commandHeaders(),
      payload: { name: "LOOP Official" },
    });
    expect(reserved.statusCode).toBe(422);
    expect(reserved.json()).toMatchObject({ code: "ALIAS_RESERVED" });
  });

  it("pages the caller's own memberships with membership=joined", async () => {
    const { app, listCommunitiesMock } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/communities?membership=joined",
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(listCommunitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ membership: "joined" }),
    );
    const rejected = await app.inject({
      method: "GET",
      url: "/v2/communities?membership=mine",
      headers: commonHeaders(),
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("keeps a users search cursor valid when verification changes", async () => {
    const dependencies = fakes();
    dependencies.communityRepository.searchUsers = vi.fn(() =>
      Promise.resolve(
        Array.from({ length: 21 }, (_value, index) => ({
          profile: {
            ...profile,
            publicProfileId: `9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e${String(index).padStart(2, "0")}`,
          },
          searchKey: `frog_${String(index).padStart(2, "0")}`,
        })),
      ),
    );
    const { app } = await createApp(dependencies);
    const first = await app.inject({
      method: "GET",
      url: "/v2/search?domain=users&q=frog",
      headers: commonHeaders(),
    });
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;
    expect(cursor).not.toBeNull();

    // `verification` only narrows the communities domain, so it must not be
    // bound into a users cursor.
    const replayed = await app.inject({
      method: "GET",
      url: `/v2/search?domain=users&q=frog&verification=all&cursor=${encodeURIComponent(cursor ?? "")}`,
      headers: commonHeaders(),
    });
    expect(replayed.statusCode).toBe(200);
  });

  it("passes the member alias prefix through as the trimmed raw text", async () => {
    const { app, listMembersMock, consumeIssuanceQuota } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?q=${encodeURIComponent("  Frog  ")}`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(listMembersMock).toHaveBeenCalledWith(
      expect.objectContaining({ aliasPrefix: "Frog", role: "all" }),
    );
    expect(consumeIssuanceQuota).toHaveBeenCalledTimes(1);
    expect(consumeIssuanceQuota.mock.calls[0]?.[0].capability).toBe(
      "public_alias_search",
    );
  });

  it("never asks the repository for a prefix when q is absent", async () => {
    const { app, listMembersMock, consumeIssuanceQuota } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(listMembersMock).toHaveBeenCalledTimes(1);
    expect(
      Object.hasOwn(listMembersMock.mock.calls[0]?.[0] ?? {}, "aliasPrefix"),
    ).toBe(false);
    expect(consumeIssuanceQuota).not.toHaveBeenCalled();
  });

  it("returns an empty member page when the prefix matches nobody", async () => {
    const dependencies = fakes();
    dependencies.listMembersMock.mockResolvedValue({
      community,
      viewerMembership: ownerMembership,
      viewerPublicProfileId: targetProfileId,
      items: [],
      counts: { all: 2, owner: 1, admin: 0 },
    });
    const { app } = await createApp(dependencies);

    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?q=zzz`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: unknown[];
      counts: Record<string, unknown>;
      nextCursor: string | null;
    }>();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    // The segment counts describe the whole directory, so they do not shrink
    // with the query.
    expect(body.counts["all"]).toBe(2);
  });

  it("accepts a one code point prefix and normalizes it like the alias key", async () => {
    const { app, listMembersMock } = await createApp();
    for (const [raw, expected] of [
      ["f", "f"],
      ["\uFF26\uFF32\uFF2F", "\uFF26\uFF32\uFF2F"],
      ["  frog  maxi  ", "frog  maxi"],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}/members?q=${encodeURIComponent(raw)}`,
        headers: commonHeaders(),
      });
      expect(response.statusCode, raw).toBe(200);
      expect(listMembersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ aliasPrefix: expected }),
      );
    }
  });

  it("rejects an empty, over-long, or control-character member prefix", async () => {
    const { app, listMembersMock } = await createApp();
    for (const raw of [
      "",
      "   ",
      "a".repeat(41),
      "fr\u0000og",
      "fr\u200bog",
      "fr\u2028og",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}/members?q=${encodeURIComponent(raw)}`,
        headers: commonHeaders(),
      });
      expect(response.statusCode, JSON.stringify(raw)).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(listMembersMock).not.toHaveBeenCalled();
  });

  it("rate limits the member search from the shared alias quota", async () => {
    const { app } = await createApp(fakes({ quotaExceeded: true }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?q=frog`,
      headers: commonHeaders(),
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "RATE_LIMITED",
      category: "rateLimit",
    });
  });

  it("binds the member cursor to the alias prefix", async () => {
    const dependencies = fakes();
    dependencies.listMembersMock.mockResolvedValue({
      community,
      viewerMembership: ownerMembership,
      viewerPublicProfileId: targetProfileId,
      items: Array.from({ length: 21 }, (_value, index) => ({
        membershipId: `3fa85f64-5717-4562-b3fc-2c963f66af${String(index).padStart(2, "0")}`,
        role: "member" as const,
        status: "active" as const,
        joinedAt: createdAt,
        profile,
      })),
      counts: { all: 21, owner: 1, admin: 0 },
    });
    const { app } = await createApp(dependencies);

    const first = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?q=fr`,
      headers: commonHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;
    expect(cursor).not.toBeNull();
    const encoded = encodeURIComponent(cursor ?? "");

    const replayed = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?q=fr&cursor=${encoded}`,
      headers: commonHeaders(),
    });
    expect(replayed.statusCode).toBe(200);

    // The bound prefix is the normalized key, so case and outer whitespace
    // continue the same page.
    const equivalent = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/members?q=${encodeURIComponent(" FR ")}&cursor=${encoded}`,
      headers: commonHeaders(),
    });
    expect(equivalent.statusCode).toBe(200);

    for (const query of ["q=fro", "", "q=fr&role=admin"]) {
      const rejected = await app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}/members?${query}${query === "" ? "" : "&"}cursor=${encoded}`,
        headers: commonHeaders(),
      });
      expect(rejected.statusCode, query).toBe(400);
      expect(rejected.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("rejects unknown body and query fields", async () => {
    const { app } = await createApp();
    const body = await app.inject({
      method: "POST",
      url: "/v2/communities",
      headers: commandHeaders(),
      payload: {
        name: "Frog Holders",
        slug: "frog-holders",
        description: null,
        logoRef: null,
        boundAssetKey: null,
        verificationStatus: "verified",
      },
    });
    expect(body.statusCode).toBe(400);

    const query = await app.inject({
      method: "GET",
      url: "/v2/communities?unknown=1",
      headers: commonHeaders(),
    });
    expect(query.statusCode).toBe(400);
  });

  describe("Mining Power projections under the development baseline (Decision 0043)", () => {
    const documents = buildMiningDevBaselineDocuments(["eip155:56:native"]);
    const approvedAt = "2026-09-15T08:00:00.000Z";
    const snapshotId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
    const publicMemberId = "5f4e3d2c-1b0a-4987-8765-43210fedcba9";
    const privateMemberId = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
    const absentMemberId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

    function miningFake(overrides: Partial<MiningRepository> = {}) {
      return {
        ...createUnavailableMiningRepository(),
        getApprovedFormula: vi.fn(() =>
          Promise.resolve({
            configVersion: documents.configVersion,
            formula: documents.formula,
            weightRange: documents.weightRange,
            priceGuardRules: documents.priceGuardRules,
            status: "approved" as const,
            effectiveAt: approvedAt,
            approvedAt,
            createdAt: approvedAt,
          }),
        ),
        getLatestSnapshot: vi.fn(() =>
          Promise.resolve({
            snapshotId,
            blockNumber: "122037728",
            blockHash: `0x${"c".repeat(64)}`,
            formulaVersion: documents.configVersion,
            priceVersion: "dexscreener:2026-09-15T13:28:43.489Z",
            totalPower: "4000",
            accountCount: 3,
            computedAt: "2026-09-15T13:30:00.000Z",
          }),
        ),
        getCommunityStanding: vi.fn(() =>
          Promise.resolve({
            communityId,
            communityName: "Frog Holders",
            boundAssetId:
              "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
            weight: "1.5",
            power: "230.5",
            participantCount: 2,
            position: 1,
          }),
        ),
        listMemberPowers: vi.fn(() =>
          Promise.resolve([
            {
              publicProfileId: targetProfileId,
              ownerUserId: accountId,
              totalPower: "12.5",
              visibleToOthers: false,
            },
            {
              publicProfileId: publicMemberId,
              ownerUserId: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
              totalPower: "3000",
              visibleToOthers: true,
            },
            {
              publicProfileId: privateMemberId,
              ownerUserId: "d64786bb-408d-415d-8a69-6277d56c921b",
              totalPower: "999",
              visibleToOthers: false,
            },
            {
              publicProfileId: absentMemberId,
              ownerUserId: "3fa85f64-5717-4562-b3fc-2c963f66afa7",
              totalPower: null,
              visibleToOthers: true,
            },
          ]),
        ),
        ...overrides,
      };
    }

    function memberRows(dependencies: ReturnType<typeof fakes>) {
      dependencies.listMembersMock.mockResolvedValue({
        community,
        viewerMembership: {
          role: "member",
          status: "active",
          joinedAt: createdAt,
        },
        viewerPublicProfileId: targetProfileId,
        items: [
          {
            membershipId: "11111111-1111-4111-8111-111111111111",
            role: "owner" as const,
            status: "active" as const,
            joinedAt: createdAt,
            profile: { ...profile, publicProfileId: publicMemberId },
          },
          {
            membershipId: "22222222-2222-4222-8222-222222222222",
            role: "member" as const,
            status: "active" as const,
            joinedAt: createdAt,
            profile: { ...profile, publicProfileId: privateMemberId },
          },
          {
            membershipId: "33333333-3333-4333-8333-333333333333",
            role: "member" as const,
            status: "active" as const,
            joinedAt: createdAt,
            profile,
          },
          {
            membershipId: "44444444-4444-4444-8444-444444444444",
            role: "member" as const,
            status: "active" as const,
            joinedAt: createdAt,
            profile: { ...profile, publicProfileId: absentMemberId },
          },
          {
            membershipId: "55555555-5555-4555-8555-555555555555",
            role: "member" as const,
            status: "active" as const,
            joinedAt: createdAt,
            profile: { ...profile, publicProfileId: null },
          },
        ],
        counts: { all: 5, owner: 1, admin: 0 },
      });
    }

    it("publishes the community's power and each member's own power under the privacy rule", async () => {
      const dependencies = fakes();
      memberRows(dependencies);
      const { app } = await createApp(
        {
          ...dependencies,
          database: {
            ...dependencies.database,
            mining: miningFake(),
          },
        },
        { V2_MODULES_ENABLED: "community,search,mining" },
      );
      const detail = await app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}`,
        headers: commonHeaders(),
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ miningPower: unknown }>().miningPower).toEqual({
        status: "available",
        power: "230.5",
        snapshotId,
        formulaVersion: "miningFormula-devBaseline-2026-09-15",
        computedAt: "2026-09-15T13:30:00.000Z",
      });
      const members = await app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}/members`,
        headers: commonHeaders(),
      });
      expect(members.statusCode).toBe(200);
      const rows = members.json<{
        items: {
          profile: { publicProfileId: string | null };
          miningPower: unknown;
        }[];
      }>().items;
      expect(rows.map((row) => row.miningPower)).toEqual([
        {
          status: "available",
          power: "3000",
          snapshotId,
          formulaVersion: "miningFormula-devBaseline-2026-09-15",
          computedAt: "2026-09-15T13:30:00.000Z",
        },
        { status: "unavailable", reasonCode: "MINING_POWER_PRIVATE" },
        // The viewer's own row is visible to the viewer even while private.
        {
          status: "available",
          power: "12.5",
          snapshotId,
          formulaVersion: "miningFormula-devBaseline-2026-09-15",
          computedAt: "2026-09-15T13:30:00.000Z",
        },
        { status: "unavailable", reasonCode: "MINING_ACCOUNT_NOT_IN_SNAPSHOT" },
        {
          status: "unavailable",
          reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        },
      ]);
      expect(members.body).not.toContain('"999"');
    });

    it("stays unavailable without a formula in force, a bound asset, or the mining module", async () => {
      const pending = fakes();
      memberRows(pending);
      const pendingApp = await createApp(
        {
          ...pending,
          database: {
            ...pending.database,
            mining: miningFake({
              getApprovedFormula: vi.fn(() => Promise.resolve(null)),
            }),
          },
        },
        { V2_MODULES_ENABLED: "community,search,mining" },
      );
      const pendingDetail = await pendingApp.app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}`,
        headers: commonHeaders(),
      });
      expect(
        pendingDetail.json<{ miningPower: unknown }>().miningPower,
      ).toEqual({
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      });
      const pendingMembers = await pendingApp.app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}/members`,
        headers: commonHeaders(),
      });
      for (const row of pendingMembers.json<{
        items: { miningPower: unknown }[];
      }>().items) {
        expect(row.miningPower).toEqual({
          status: "unavailable",
          reasonCode: "MINING_FORMULA_BASELINE_PENDING",
        });
      }
      const unbound = fakes();
      const unboundApp = await createApp(
        {
          ...unbound,
          database: {
            ...unbound.database,
            mining: miningFake({
              getCommunityStanding: vi.fn(() => Promise.resolve(null)),
              getCommunityWeight: vi.fn(() =>
                Promise.resolve({
                  communityId,
                  communityName: "Frog Holders",
                  boundAssetId: null,
                  status: "pending_review" as const,
                  weight: null,
                  configVersion: null,
                  reviewedAt: null,
                }),
              ),
            }),
          },
        },
        { V2_MODULES_ENABLED: "community,search,mining" },
      );
      const unboundDetail = await unboundApp.app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}`,
        headers: commonHeaders(),
      });
      expect(
        unboundDetail.json<{ miningPower: unknown }>().miningPower,
      ).toEqual({
        status: "unavailable",
        reasonCode: "COMMUNITY_ASSET_NOT_BOUND",
      });
      // Without the mining module the community module composes no reader.
      const withoutModule = await createApp(fakes());
      const noModule = await withoutModule.app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}`,
        headers: commonHeaders(),
      });
      expect(noModule.json<{ miningPower: unknown }>().miningPower).toEqual({
        status: "unavailable",
        reasonCode: "MINING_FORMULA_BASELINE_PENDING",
      });
    });
  });
});
