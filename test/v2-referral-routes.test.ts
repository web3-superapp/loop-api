import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { inviteCodeCheckSymbol } from "../src/features/referral/invite-code.js";
import {
  ReferralAlreadyBoundError,
  ReferralIdempotencyConflictError,
  createUnavailableReferralRepository,
  type ReferralEdgeRecord,
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
    expect(body.boost).toEqual({
      status: "unavailable",
      reasonCode: "MINING_FORMULA_BASELINE_PENDING",
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
});
