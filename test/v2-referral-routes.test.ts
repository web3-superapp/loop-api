import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { inviteCodeCheckSymbol } from "../src/features/referral/invite-code.js";
import {
  ReferralAlreadyBoundError,
  ReferralIdempotencyConflictError,
  createUnavailableReferralRepository,
  type ReferralBoostRecord,
  type ReferralEdgeRecord,
  type ReferralInviteeRecord,
  type ReferralRepository,
} from "../src/features/referral/referral-repository.js";
import {
  calls,
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

const inviterId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const grandInviterId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const issuedAt = "2026-09-08T01:00:00.000Z";
const activatedAt = new Date(Date.now() - 86_400_000).toISOString();
const code = `LOOP-7HJK${inviteCodeCheckSymbol("7HJK")}`;

const edge: ReferralEdgeRecord = Object.freeze({
  referralEdgeId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
  inviterUserId: inviterId,
  inviteeUserId: s7AccountId,
  depth: 1,
  validationStatus: "pending_wallet",
  lockedAt: issuedAt,
  effectiveFrom: issuedAt,
  effectiveTo: null,
  configVersion: "referralRulesV1",
});

function repositoryFake(overrides: Partial<ReferralRepository> = {}) {
  const repository: ReferralRepository = {
    ...createUnavailableReferralRepository(),
    getInviteCode: vi.fn(() => Promise.resolve(null)),
    issueInviteCode: vi.fn((input: { readonly code: string }) =>
      Promise.resolve({ code: input.code, issuedAt }),
    ),
    findInviterByCode: vi.fn((value: string) =>
      Promise.resolve(value === code ? inviterId : null),
    ),
    getAccountState: vi.fn(() =>
      Promise.resolve({ activatedAt, hasWallet: false }),
    ),
    getAncestorChain: vi.fn(() => Promise.resolve([grandInviterId])),
    getDirectEdge: vi.fn(() => Promise.resolve(null)),
    claim: vi.fn(() => Promise.resolve(edge)),
    countInvitees: vi.fn(() =>
      Promise.resolve([
        { depth: 1, validationStatus: "pending_wallet" as const, count: 2 },
        { depth: 1, validationStatus: "pending_mining" as const, count: 1 },
        { depth: 3, validationStatus: "pending_mining" as const, count: 4 },
      ]),
    ),
    recordRejectedClaim: vi.fn(() => Promise.resolve()),
    getInviteeStats: vi.fn(() =>
      Promise.resolve({
        directCount: 3,
        validCount: 1,
        level2to5Count: 4,
        validAsOf: "2026-09-08T02:00:00.000Z",
      }),
    ),
    getReferralBoost: vi.fn(() => Promise.resolve(null)),
    listDirectInvitees: vi.fn(() => Promise.resolve([])),
    ...overrides,
  };
  return repository;
}

describe("LOOP API V2 referral module", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    repository = repositoryFake(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: s7TestConfig(overrides),
      contractSurface: "v2",
      database: s7Database({ referral: repository }),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(app);
    return { app, repository };
  }

  function claim(
    app: FastifyInstance,
    inviteCode: string,
    headers = s7CommandHeaders(),
  ) {
    return app.inject({
      method: "POST",
      url: "/v2/referral/claim",
      headers,
      payload: { inviteCode },
    });
  }

  it("registers no referral route when the module is disabled", async () => {
    const { app } = await createApp(repositoryFake(), {
      V2_MODULES_ENABLED: "mining",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v2/referral",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(404);
  });

  it("issues the invite code on first read and publishes level counts with the boost unavailable", async () => {
    const { app, repository } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/referral",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{
      readonly inviteCode: { readonly code: string };
      readonly binding: Record<string, unknown>;
      readonly levels: readonly Record<string, unknown>[];
      readonly boost: unknown;
      readonly rules: unknown;
    }>();
    expect(body.inviteCode.code).toMatch(/^LOOP-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(response.json<{ inviteLink: string }>().inviteLink).toBe(
      `http://127.0.0.1:3000/i/${body.inviteCode.code}`,
    );
    expect(response.json<{ stats: unknown }>().stats).toEqual({
      directCount: 3,
      validCount: 1,
      level2to5Count: 4,
      validAsOf: "2026-09-08T02:00:00.000Z",
    });
    expect(calls(repository, "issueInviteCode")).toHaveBeenCalledOnce();
    expect(body.binding).toMatchObject({
      status: "unbound",
      inviter: null,
      claimWindow: { status: "open", activatedAt },
    });
    expect(body.levels).toHaveLength(5);
    expect(body.levels[0]).toEqual({
      level: 1,
      boostPercent: "10",
      counts: {
        pending_activation: 0,
        pending_wallet: 2,
        pending_mining: 1,
        valid: 0,
        invalidated: 0,
      },
      total: 3,
    });
    expect(body.levels[2]).toMatchObject({ level: 3, total: 4 });
    // The boost slot names itself; the page-level "no version in force"
    // code is never used for it (Decision 0046).
    expect(body.boost).toEqual({
      status: "unavailable",
      reasonCode: "MINING_REFERRAL_BOOST_PENDING",
    });
    expect(body.rules).toEqual({
      configVersion: "referralRulesV1",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      appliesTo: "miningPower",
      maximumDepth: 5,
      claimWindowDays: 7,
    });
  });

  it("claims a code inside the window and materialises edges from the inviter chain", async () => {
    const { app, repository } = await createApp();
    const response = await claim(app, code.toLowerCase());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      binding: {
        status: "bound",
        inviter: {
          depth: 1,
          validationStatus: "pending_wallet",
          lockedAt: issuedAt,
          effectiveFrom: issuedAt,
          configVersion: "referralRulesV1",
        },
        claimWindow: {
          status: "open",
          activatedAt,
          closesAt: new Date(
            Date.parse(activatedAt) + 7 * 86_400_000,
          ).toISOString(),
        },
      },
      contractVersion: "2.0",
    });
    // The cycle scan walks up to 64 ancestors; edges still stop at depth 5.
    expect(calls(repository, "getAncestorChain")).toHaveBeenCalledWith(
      inviterId,
      64,
    );
    expect(calls(repository, "claim")).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteeUserId: s7AccountId,
        validationStatus: "pending_wallet",
        edges: [
          { inviterUserId: inviterId, depth: 1 },
          { inviterUserId: grandInviterId, depth: 2 },
        ],
      }),
    );
  });

  it("marks a claimant with a bound wallet as pending_mining", async () => {
    const { app, repository } = await createApp(
      repositoryFake({
        getAccountState: vi.fn(() =>
          Promise.resolve({ activatedAt, hasWallet: true }),
        ),
      }),
    );
    await claim(app, code);
    expect(calls(repository, "claim")).toHaveBeenCalledWith(
      expect.objectContaining({ validationStatus: "pending_mining" }),
    );
  });

  it("rejects a self-invite with 422 and records the refusal", async () => {
    const { app, repository } = await createApp(
      repositoryFake({
        findInviterByCode: vi.fn(() => Promise.resolve(s7AccountId)),
      }),
    );
    const response = await claim(app, code);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls(repository, "recordRejectedClaim")).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "self_invite" }),
    );
    expect(calls(repository, "claim")).not.toHaveBeenCalled();
  });

  it("rejects a cycle with 422", async () => {
    const { app, repository } = await createApp(
      repositoryFake({
        getAncestorChain: vi.fn(() =>
          Promise.resolve([grandInviterId, s7AccountId]),
        ),
      }),
    );
    const response = await claim(app, code);
    expect(response.statusCode).toBe(422);
    expect(calls(repository, "recordRejectedClaim")).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "referral_cycle" }),
    );
  });

  it("answers a repeated binding with 409 DATA_STALE and a replayed key with the original result", async () => {
    const { app } = await createApp(
      repositoryFake({
        claim: vi.fn(() => Promise.reject(new ReferralAlreadyBoundError())),
      }),
    );
    const duplicate = await claim(app, code);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "DATA_STALE" });
    const conflictApp = await createApp(
      repositoryFake({
        claim: vi.fn(() =>
          Promise.reject(new ReferralIdempotencyConflictError()),
        ),
      }),
    );
    const conflict = await claim(conflictApp.app, code);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a claim outside the 7-day window with POLICY_BLOCKED and an unactivated profile with PROFILE_ACTIVATION_REQUIRED", async () => {
    const expired = await createApp(
      repositoryFake({
        getAccountState: vi.fn(() =>
          Promise.resolve({
            activatedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
            hasWallet: true,
          }),
        ),
      }),
    );
    const closed = await claim(expired.app, code);
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toMatchObject({ code: "POLICY_BLOCKED" });
    expect(
      calls(expired.repository, "recordRejectedClaim"),
    ).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "claim_window_closed" }),
    );
    const unactivated = await createApp(
      repositoryFake({
        getAccountState: vi.fn(() =>
          Promise.resolve({ activatedAt: null, hasWallet: false }),
        ),
      }),
    );
    const response = await claim(unactivated.app, code);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "PROFILE_ACTIVATION_REQUIRED",
    });
  });

  it("does not enumerate codes: unknown and malformed codes are 404 and 400", async () => {
    const { app } = await createApp();
    const unknown = await claim(
      app,
      `LOOP-7HJJ${inviteCodeCheckSymbol("7HJJ")}`,
    );
    expect(unknown.statusCode).toBe(404);
    const malformed = await claim(app, "LOOP-7HJKX");
    expect(malformed.statusCode).toBe(400);
    const missingKey = await claim(app, code, s7CommonHeaders());
    expect(missingKey.statusCode).toBe(400);
  });

  it("publishes the referral power of the newest settled hour as the boost (Decision 0162)", async () => {
    const boost: ReferralBoostRecord = {
      epochId: "0f1e2d3c-4b5a-4968-8776-655443322110",
      hourStart: "2026-09-08T01:00:00.000Z",
      hourEnd: "2026-09-08T02:00:00.000Z",
      referralPower: "12.5",
      nftReferralPower: "10",
      assetReferralPower: "2.5",
      levels: [1, 2, 3, 4, 5].map((level) => ({
        level,
        effectiveMembers: level === 1 ? 2 : 0,
        nftPower: level === 1 ? "10" : "0",
        assetPower: level === 1 ? "2.5" : "0",
      })),
    };
    const { app } = await createApp(
      repositoryFake({
        getReferralBoost: vi.fn(() => Promise.resolve(boost)),
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/v2/referral",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ boost: unknown }>().boost).toEqual({
      status: "available",
      ...boost,
    });
    // A failed boost read never fails the page.
    const failing = await createApp(
      repositoryFake({
        getReferralBoost: vi.fn(() => Promise.reject(new Error("down"))),
      }),
    );
    const degraded = await failing.app.inject({
      method: "GET",
      url: "/v2/referral",
      headers: s7CommonHeaders(),
    });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json<{ boost: unknown }>().boost).toEqual({
      status: "unavailable",
      reasonCode: "MINING_REFERRAL_BOOST_PENDING",
    });
  });

  function invitee(index: number): ReferralInviteeRecord {
    const second = String(59 - index).padStart(2, "0");
    return {
      referralEdgeId: `7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5${String(index).padStart(2, "0")}`,
      publicProfileId:
        index === 2
          ? null
          : `5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e${String(index).padStart(2, "0")}`,
      alias: index === 2 ? null : `friend ${String(index)}`,
      avatarRef: null,
      boundAt: `2026-09-08T01:00:${second}.123Z`,
      boundAtKey: `2026-09-08T01:00:${second}.123456Z`,
      validationStatus: index === 0 ? "valid" : "pending",
    };
  }

  it("lists direct invitees newest first with an owner-bound cursor (Decision 0162)", async () => {
    const rows = [0, 1, 2, 3].map(invitee);
    const listDirectInvitees = vi.fn(
      (input: {
        readonly after: { readonly boundAtKey: string } | null;
        readonly limit: number;
      }) => {
        const start =
          input.after === null
            ? 0
            : rows.findIndex(
                (row) => row.boundAtKey === input.after?.boundAtKey,
              ) + 1;
        return Promise.resolve(rows.slice(start, start + input.limit));
      },
    );
    const { app } = await createApp(repositoryFake({ listDirectInvitees }));
    const first = await app.inject({
      method: "GET",
      url: "/v2/referral/invitees?limit=2",
      headers: s7CommonHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const page = first.json<{
      items: Record<string, unknown>[];
      nextCursor: string | null;
      contractVersion: string;
    }>();
    expect(page.items).toEqual([
      {
        publicProfileId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e00",
        alias: "friend 0",
        avatarRef: null,
        boundAt: "2026-09-08T01:00:59.123Z",
        validationStatus: "valid",
      },
      {
        publicProfileId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e01",
        alias: "friend 1",
        avatarRef: null,
        boundAt: "2026-09-08T01:00:58.123Z",
        validationStatus: "pending",
      },
    ]);
    expect(page.contractVersion).toBe("2.0");
    expect(listDirectInvitees).toHaveBeenLastCalledWith({
      inviterUserId: s7AccountId,
      after: null,
      limit: 3,
    });
    expect(page.nextCursor).not.toBeNull();
    const second = await app.inject({
      method: "GET",
      url: `/v2/referral/invitees?cursor=${String(page.nextCursor)}`,
      headers: s7CommonHeaders(),
    });
    expect(second.statusCode).toBe(200);
    expect(listDirectInvitees).toHaveBeenLastCalledWith({
      inviterUserId: s7AccountId,
      after: {
        boundAtKey: "2026-09-08T01:00:58.123456Z",
        referralEdgeId: rows[1]?.referralEdgeId,
      },
      limit: 3,
    });
    const tail = second.json<{
      items: { publicProfileId: string | null }[];
      nextCursor: string | null;
    }>();
    expect(tail.items.map((row) => row.publicProfileId)).toEqual([
      null,
      "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e03",
    ]);
    expect(tail.nextCursor).toBeNull();
  });

  it("rejects cursor with limit, a forged cursor, and an out-of-range limit; 503 without the cursor secret", async () => {
    const { app } = await createApp();
    for (const url of [
      "/v2/referral/invitees?limit=0",
      "/v2/referral/invitees?limit=51",
      "/v2/referral/invitees?cursor=abc.def",
      "/v2/referral/invitees?cursor=abc.def&limit=2",
      "/v2/referral/invitees?other=1",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode, url).toBe(400);
    }
    const unconfigured = await createApp(repositoryFake(), {
      V2_CURSOR_HMAC_SECRET: "",
    });
    const response = await unconfigured.app.inject({
      method: "GET",
      url: "/v2/referral/invitees",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "V2_CURSOR_NOT_CONFIGURED" },
    });
  });
});
