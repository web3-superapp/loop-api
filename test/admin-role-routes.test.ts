import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import { adminErrorCodes } from "../src/features/admin/admin-contract.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import {
  adminFormulaFixture,
  createInMemoryAdminRepository,
  type InMemoryAdminRepository,
} from "./helpers/admin-fakes.js";
import {
  createFakeHooksReview,
  createInMemoryAdminAccounts,
  createInMemoryAdminLaunchReview,
  launchProjectFixture,
  type InMemoryAdminAccounts,
} from "./helpers/admin-role-fakes.js";
import { s7Database, s7PrivyVerifier, s7TestConfig } from "./s7-route-fakes.js";

/**
 * Decision 0109 route contract: role-derived permissions on every console
 * route (403 before any body detail), account sessions that end when the
 * account is disabled or its password changes, the forced first password
 * change, idempotent account writes, and the launch review writes running
 * as the bound LOOP user with separation of duties.
 */

const bootstrapPassword = "correct-horse-battery-staple";
const accountPassword = "account-password-0123";
const sessionSecret = "s128-admin-session-secret-0123456789abcdef";
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashAdminPassword(bootstrapPassword);
});

interface Harness {
  readonly app: FastifyInstance;
  readonly admin: InMemoryAdminRepository;
  readonly accounts: InMemoryAdminAccounts;
  readonly hooks: ReturnType<typeof createFakeHooksReview>;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly otherProjectId: string;
  readonly reviewerUserId: string;
  readonly acceptorUserId: string;
  readonly scopes: Map<string, readonly string[]>;
  readonly grants: Map<string, readonly string[]>;
}

describe("Operator console role separation (Decision 0109)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createHarness(
    env: Readonly<Record<string, string>> = {},
  ): Promise<Harness> {
    const admin = createInMemoryAdminRepository();
    const accounts = createInMemoryAdminAccounts(admin);
    const ownerUserId = randomUUID();
    const project = launchProjectFixture({ ownerUserId });
    const other = launchProjectFixture();
    const reviewerUserId = randomUUID();
    const acceptorUserId = randomUUID();
    const scopes = new Map<string, readonly string[]>([
      [reviewerUserId, ["*"]],
      [acceptorUserId, [project.projectId]],
      [ownerUserId, ["*"]],
    ]);
    const grants = new Map<string, readonly string[]>([
      [reviewerUserId, ["launch.read", "launch.approve", "audit.read"]],
      [
        acceptorUserId,
        ["launch.read", "testnet.read", "testnet.accept", "audit.read"],
      ],
      [ownerUserId, ["launch.read", "launch.approve", "audit.read"]],
    ]);
    const hooks = createFakeHooksReview({
      grants,
      owners: new Map([
        [project.projectId, ownerUserId],
        [other.projectId, randomUUID()],
      ]),
    });
    const app = await buildApp({
      config: s7TestConfig({
        V2_MODULES_ENABLED: "launch,mining,referral",
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: passwordHash,
        ADMIN_SESSION_SECRET: sessionSecret,
        ...env,
      }),
      database: {
        ...s7Database({}),
        admin,
        adminAccounts: accounts,
        adminLaunchReview: createInMemoryAdminLaunchReview(
          [project, other],
          scopes,
        ),
        hooksLaunchReview: hooks,
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      logger: false,
    });
    apps.push(app);
    return {
      app,
      admin,
      accounts,
      hooks,
      ownerUserId,
      projectId: project.projectId,
      otherProjectId: other.projectId,
      reviewerUserId,
      acceptorUserId,
      scopes,
      grants,
    };
  }

  async function login(
    app: FastifyInstance,
    username: string,
    password: string,
  ): Promise<{ cookie: string; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username, password },
    });
    expect(response.statusCode, response.body).toBe(200);
    const cookie = (response.headers["set-cookie"] as string).split(";")[0]!;
    return { cookie, body: response.json() };
  }

  async function seedAndLogin(
    harness: Harness,
    role: AdminRole,
    operatorUserId: string | null = null,
  ): Promise<string> {
    const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
    await harness.accounts.seed({
      username,
      password: accountPassword,
      role,
      operatorUserId,
    });
    return (await login(harness.app, username, accountPassword)).cookie;
  }

  function expectError(
    response: { statusCode: number; json: () => unknown },
    status: number,
    code: string,
    reasonCode?: string,
  ): void {
    expect(response.statusCode).toBe(status);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(errorKeys);
    expect(body["code"]).toBe(code);
    expect(adminErrorCodes).toContain(body["code"]);
    if (reasonCode !== undefined) {
      expect(body["detailsSafe"]).toMatchObject({ reasonCode });
    }
  }

  it("publishes the role and its permissions on login and GET /session", async () => {
    const harness = await createHarness();
    const bootstrap = await login(harness.app, "operator", bootstrapPassword);
    expect(bootstrap.body).toMatchObject({
      actor: "operator",
      accountId: null,
      role: "platform_admin",
      passwordChangeRequired: false,
      operatorUserId: null,
    });
    expect(bootstrap.body["permissions"]).not.toContain("launch.approve");
    expect(bootstrap.body["permissions"]).not.toContain("testnet.accept");
    const reviewer = await seedAndLogin(
      harness,
      "reviewer",
      harness.reviewerUserId,
    );
    const session = await harness.app.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { cookie: reviewer },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      role: "reviewer",
      permissions: [
        "audit.read",
        "formula.approve",
        "launch.approve",
        "launch.read",
      ],
      operatorUserId: harness.reviewerUserId,
    });
    // The login audit row names the account.
    const loginRow = harness.admin.audit.find(
      (row) =>
        row.action === "session.login" && row.actor.startsWith("reviewer-"),
    );
    expect(loginRow?.actorAccountId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("enforces the role table on every console route (403 before the body)", async () => {
    const harness = await createHarness();
    const cookies: Record<AdminRole, string> = {
      platform_admin: (await login(harness.app, "operator", bootstrapPassword))
        .cookie,
      reviewer: await seedAndLogin(harness, "reviewer", harness.reviewerUserId),
      testnet_acceptor: await seedAndLogin(
        harness,
        "testnet_acceptor",
        harness.acceptorUserId,
      ),
      auditor: await seedAndLogin(harness, "auditor"),
    };
    const cases: readonly {
      readonly method: "GET" | "POST" | "PUT";
      readonly url: string;
      readonly allowed: readonly AdminRole[];
    }[] = [
      {
        method: "GET",
        url: "/admin/v1/overview",
        allowed: ["platform_admin", "auditor"],
      },
      {
        method: "PUT",
        url: "/admin/v1/settings/recommended-communities",
        allowed: ["platform_admin"],
      },
      {
        method: "POST",
        url: "/admin/v1/mining/formula-versions/v9/approve",
        allowed: ["reviewer"],
      },
      {
        method: "POST",
        url: "/admin/v1/mining/formula-versions",
        allowed: ["platform_admin"],
      },
      {
        method: "POST",
        url: "/admin/v1/mining/formula-versions/v9/withdraw",
        allowed: ["platform_admin"],
      },
      {
        method: "GET",
        url: "/admin/v1/mining/formula-versions",
        allowed: ["platform_admin", "reviewer", "auditor"],
      },
      {
        method: "GET",
        url: "/admin/v1/audit",
        allowed: ["platform_admin", "reviewer", "testnet_acceptor", "auditor"],
      },
      {
        method: "GET",
        url: "/admin/v1/accounts",
        allowed: ["platform_admin", "auditor"],
      },
      {
        method: "POST",
        url: "/admin/v1/accounts",
        allowed: ["platform_admin"],
      },
      {
        method: "GET",
        url: "/admin/v1/launch/projects",
        allowed: ["platform_admin", "reviewer", "testnet_acceptor", "auditor"],
      },
      {
        method: "POST",
        url: `/admin/v1/launch/projects/${harness.projectId}/versions/1/approve`,
        allowed: ["reviewer"],
      },
      {
        method: "POST",
        url: `/admin/v1/launch/projects/${harness.projectId}/testnet-acceptance`,
        allowed: ["testnet_acceptor"],
      },
    ];
    for (const entry of cases) {
      for (const [role, cookie] of Object.entries(cookies) as [
        AdminRole,
        string,
      ][]) {
        const response = await harness.app.inject({
          method: entry.method,
          url: entry.url,
          headers: { cookie },
          // An invalid body: an allowed role reaches validation (never 403),
          // a refused role is 403 before the body is looked at.
          payload: { invalid: true },
        });
        const label = `${role} ${entry.method} ${entry.url}`;
        if (entry.allowed.includes(role)) {
          expect(response.statusCode, label).not.toBe(403);
        } else {
          expectError(
            response,
            403,
            "PERMISSION_DENIED",
            "ADMIN_ROLE_FORBIDDEN",
          );
        }
      }
    }
    expect(harness.hooks.executed).toHaveLength(0);
  });

  it("keeps platform_admin, reviewer, and acceptor out of each other's writes", async () => {
    const harness = await createHarness();
    const admin = (await login(harness.app, "operator", bootstrapPassword))
      .cookie;
    const reviewer = await seedAndLogin(
      harness,
      "reviewer",
      harness.reviewerUserId,
    );
    const acceptor = await seedAndLogin(
      harness,
      "testnet_acceptor",
      harness.acceptorUserId,
    );
    const approve = (cookie: string) =>
      harness.app.inject({
        method: "POST",
        url: `/admin/v1/launch/projects/${harness.projectId}/versions/1/approve`,
        headers: { cookie, "idempotency-key": randomUUID() },
        payload: { configHash: `0x${"ab".repeat(32)}`, reason: "Hash checked" },
      });
    const accept = (cookie: string) =>
      harness.app.inject({
        method: "POST",
        url: `/admin/v1/launch/projects/${harness.projectId}/testnet-acceptance`,
        headers: { cookie, "idempotency-key": randomUUID() },
        payload: {
          configVersion: 1,
          configHash: `0x${"ab".repeat(32)}`,
          contractManifestHash: `0x${"cd".repeat(32)}`,
          checklistVersion: "hooks-testnet-v1",
          outcome: "passed",
          evidence: [{ label: "deploy", uri: `0x${"ef".repeat(32)}` }],
          reason: "All checks passed",
        },
      });
    expectError(await approve(admin), 403, "PERMISSION_DENIED");
    expectError(await approve(acceptor), 403, "PERMISSION_DENIED");
    expectError(await accept(admin), 403, "PERMISSION_DENIED");
    expectError(await accept(reviewer), 403, "PERMISSION_DENIED");
    expect(harness.hooks.executed).toHaveLength(0);

    const approved = await approve(reviewer);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      replayed: false,
      approval: {
        projectId: harness.projectId,
        configVersion: 1,
        approverUserId: harness.reviewerUserId,
      },
    });
    const accepted = await accept(acceptor);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      acceptance: { chainId: 97, acceptorUserId: harness.acceptorUserId },
    });
    const actions = harness.admin.audit.map((row) => row.action);
    expect(actions).toContain("launch.config.approve.requested");
    expect(actions).toContain("launch.config.approve.decided");
    expect(actions).toContain("testnet.acceptance.record.decided");
  });

  it("passes the service's separation-of-duties refusals through as 403", async () => {
    const harness = await createHarness();
    // A reviewer account bound to the project owner (the editor).
    const owner = await seedAndLogin(harness, "reviewer", harness.ownerUserId);
    const response = await harness.app.inject({
      method: "POST",
      url: `/admin/v1/launch/projects/${harness.projectId}/versions/1/approve`,
      headers: { cookie: owner, "idempotency-key": randomUUID() },
      payload: { configHash: `0x${"ab".repeat(32)}`, reason: "Self" },
    });
    expectError(response, 403, "PERMISSION_DENIED", "OPS_SELF_APPROVAL");
    const failed = harness.admin.audit.find(
      (row) => row.action === "launch.config.approve.failed",
    );
    expect(failed?.after).toMatchObject({ errorCode: "OPS_SELF_APPROVAL" });
    // A reused key with another body is a conflict.
    const reviewer = await seedAndLogin(
      harness,
      "reviewer",
      harness.reviewerUserId,
    );
    const key = randomUUID();
    const first = await harness.app.inject({
      method: "POST",
      url: `/admin/v1/launch/projects/${harness.projectId}/versions/1/approve`,
      headers: { cookie: reviewer, "idempotency-key": key },
      payload: { configHash: `0x${"ab".repeat(32)}`, reason: "One" },
    });
    expect(first.statusCode).toBe(200);
    const replay = await harness.app.inject({
      method: "POST",
      url: `/admin/v1/launch/projects/${harness.projectId}/versions/1/approve`,
      headers: { cookie: reviewer, "idempotency-key": key },
      payload: { configHash: `0x${"ab".repeat(32)}`, reason: "One" },
    });
    expect(replay.json()).toMatchObject({ replayed: true });
    const conflict = await harness.app.inject({
      method: "POST",
      url: `/admin/v1/launch/projects/${harness.projectId}/versions/1/approve`,
      headers: { cookie: reviewer, "idempotency-key": key },
      payload: { configHash: `0x${"ab".repeat(32)}`, reason: "Two" },
    });
    expectError(conflict, 409, "ADMIN_CONFLICT", "OPS_IDEMPOTENCY_CONFLICT");
  });

  it("requires a UUIDv4 Idempotency-Key on every new write", async () => {
    const harness = await createHarness();
    const admin = (await login(harness.app, "operator", bootstrapPassword))
      .cookie;
    for (const key of [undefined, "not-a-uuid", randomUUID().toUpperCase()]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/admin/v1/accounts",
        headers: {
          cookie: admin,
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        payload: {
          username: "auditor-one",
          password: accountPassword,
          role: "auditor",
        },
      });
      expectError(response, 400, "INVALID_REQUEST");
    }
    expect(harness.accounts.accounts.size).toBe(0);
  });

  it("creates accounts idempotently and derives reviewer grants", async () => {
    const harness = await createHarness();
    const admin = (await login(harness.app, "operator", bootstrapPassword))
      .cookie;
    const key = randomUUID();
    const body = {
      username: "reviewer-alice",
      password: accountPassword,
      role: "reviewer",
      operatorUserId: harness.reviewerUserId,
      projectIds: [harness.projectId],
    };
    const created = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/accounts",
      headers: { cookie: admin, "idempotency-key": key },
      payload: body,
    });
    expect(created.statusCode, created.body).toBe(201);
    const resource = created.json<{
      account: Record<string, unknown>;
      replayed: boolean;
    }>();
    expect(resource.account).toMatchObject({
      username: "reviewer-alice",
      role: "reviewer",
      status: "active",
      passwordChangeRequired: true,
      operator: {
        enabled: true,
        grants: [
          { permission: "audit.read", scope: "*" },
          { permission: "launch.approve", scope: harness.projectId },
          { permission: "launch.read", scope: harness.projectId },
        ],
      },
    });
    expect(JSON.stringify(resource)).not.toContain("argon2");
    const replay = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/accounts",
      headers: { cookie: admin, "idempotency-key": key },
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });
    const conflict = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/accounts",
      headers: { cookie: admin, "idempotency-key": key },
      payload: { ...body, password: "another-password-123" },
    });
    expectError(conflict, 409, "ADMIN_CONFLICT", "ADMIN_IDEMPOTENCY_CONFLICT");
    // Rules: operator binding required / refused by role; bootstrap name.
    const cases: readonly [Record<string, unknown>, number, string][] = [
      [
        { username: "rev-two", password: accountPassword, role: "reviewer" },
        422,
        "ADMIN_ACCOUNT_OPERATOR_REQUIRED",
      ],
      [
        {
          username: "aud-two",
          password: accountPassword,
          role: "auditor",
          operatorUserId: harness.acceptorUserId,
        },
        422,
        "ADMIN_ACCOUNT_OPERATOR_NOT_ALLOWED",
      ],
      [
        { username: "OPERATOR", password: accountPassword, role: "auditor" },
        409,
        "ADMIN_ACCOUNT_USERNAME_TAKEN",
      ],
      [
        {
          username: "rev-three",
          password: accountPassword,
          role: "testnet_acceptor",
          operatorUserId: harness.reviewerUserId,
        },
        409,
        "ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND",
      ],
    ];
    for (const [payload, status, reasonCode] of cases) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/admin/v1/accounts",
        headers: { cookie: admin, "idempotency-key": randomUUID() },
        payload,
      });
      expectError(
        response,
        status,
        status === 422 ? "VALIDATION_FAILED" : "ADMIN_CONFLICT",
        reasonCode,
      );
    }
  });

  it("forces a first password change, then ends the old session", async () => {
    const harness = await createHarness();
    await harness.accounts.seed({
      username: "new-auditor",
      password: accountPassword,
      role: "auditor",
      passwordMustChange: true,
    });
    const first = await login(harness.app, "new-auditor", accountPassword);
    expect(first.body).toMatchObject({
      passwordChangeRequired: true,
      permissions: [],
    });
    const blocked = await harness.app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie: first.cookie },
    });
    expectError(
      blocked,
      403,
      "PERMISSION_DENIED",
      "ADMIN_PASSWORD_CHANGE_REQUIRED",
    );
    const wrong = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/session/password",
      headers: { cookie: first.cookie },
      payload: {
        currentPassword: "wrong-password-000",
        newPassword: "brand-new-password-1",
      },
    });
    expectError(wrong, 401, "ADMIN_LOGIN_INVALID");
    const changed = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/session/password",
      headers: { cookie: first.cookie },
      payload: {
        currentPassword: accountPassword,
        newPassword: "brand-new-password-1",
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      role: "auditor",
      passwordChangeRequired: false,
    });
    const fresh = (changed.headers["set-cookie"] as string).split(";")[0]!;
    const stale = await harness.app.inject({
      method: "GET",
      url: "/admin/v1/session",
      headers: { cookie: first.cookie },
    });
    expectError(stale, 401, "ADMIN_SESSION_REQUIRED");
    const overview = await harness.app.inject({
      method: "GET",
      url: "/admin/v1/overview",
      headers: { cookie: fresh },
    });
    expect(overview.statusCode).toBe(200);
    // The bootstrap administrator has no stored password to change.
    const bootstrap = (await login(harness.app, "operator", bootstrapPassword))
      .cookie;
    const refused = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/session/password",
      headers: { cookie: bootstrap },
      payload: {
        currentPassword: bootstrapPassword,
        newPassword: "brand-new-password-1",
      },
    });
    expectError(refused, 409, "ADMIN_CONFLICT", "ADMIN_ACCOUNT_ENVIRONMENT");
  });

  it("ends a disabled or reset account's sessions at once", async () => {
    const harness = await createHarness();
    const admin = (await login(harness.app, "operator", bootstrapPassword))
      .cookie;
    const reviewerAccount = await harness.accounts.seed({
      username: "rev-disable",
      password: accountPassword,
      role: "reviewer",
      operatorUserId: harness.reviewerUserId,
    });
    const auditorAccount = await harness.accounts.seed({
      username: "aud-reset",
      password: accountPassword,
      role: "auditor",
    });
    const reviewer = (await login(harness.app, "rev-disable", accountPassword))
      .cookie;
    const auditor = (await login(harness.app, "aud-reset", accountPassword))
      .cookie;
    const disabled = await harness.app.inject({
      method: "POST",
      url: `/admin/v1/accounts/${reviewerAccount.accountId}/disable`,
      headers: { cookie: admin, "idempotency-key": randomUUID() },
      payload: { reasonCode: "left_team" },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({
      changed: true,
      account: { status: "disabled", operator: { enabled: false } },
    });
    expectError(
      await harness.app.inject({
        method: "GET",
        url: "/admin/v1/launch/projects",
        headers: { cookie: reviewer },
      }),
      401,
      "ADMIN_SESSION_REQUIRED",
    );
    const relogin = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/session",
      payload: { username: "rev-disable", password: accountPassword },
    });
    expectError(relogin, 401, "ADMIN_LOGIN_INVALID");
    const reset = await harness.app.inject({
      method: "POST",
      url: `/admin/v1/accounts/${auditorAccount.accountId}/reset-password`,
      headers: { cookie: admin, "idempotency-key": randomUUID() },
      payload: { password: "temporary-password-9" },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({
      account: { passwordChangeRequired: true },
    });
    expectError(
      await harness.app.inject({
        method: "GET",
        url: "/admin/v1/overview",
        headers: { cookie: auditor },
      }),
      401,
      "ADMIN_SESSION_REQUIRED",
    );
    const resetDisabled = await harness.app.inject({
      method: "POST",
      url: `/admin/v1/accounts/${reviewerAccount.accountId}/reset-password`,
      headers: { cookie: admin, "idempotency-key": randomUUID() },
      payload: { password: "temporary-password-9" },
    });
    expectError(resetDisabled, 409, "ADMIN_CONFLICT", "ADMIN_ACCOUNT_DISABLED");
  });

  it("scopes the launch list and detail to the operator's grants", async () => {
    const harness = await createHarness();
    const acceptor = await seedAndLogin(
      harness,
      "testnet_acceptor",
      harness.acceptorUserId,
    );
    const list = await harness.app.inject({
      method: "GET",
      url: "/admin/v1/launch/projects",
      headers: { cookie: acceptor },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      items: { projectId: string }[];
      scope: string;
    }>();
    expect(body.scope).toBe("projects");
    expect(body.items.map((item) => item.projectId)).toEqual([
      harness.projectId,
    ]);
    expect(JSON.stringify(body)).not.toContain("cursorKey");
    const foreign = await harness.app.inject({
      method: "GET",
      url: `/admin/v1/launch/projects/${harness.otherProjectId}`,
      headers: { cookie: acceptor },
    });
    expectError(foreign, 404, "NOT_FOUND");
    const own = await harness.app.inject({
      method: "GET",
      url: `/admin/v1/launch/projects/${harness.projectId}`,
      headers: { cookie: acceptor },
    });
    expect(own.statusCode).toBe(200);
    // Grants revoked behind the console's back: fail closed.
    harness.scopes.set(harness.acceptorUserId, []);
    expectError(
      await harness.app.inject({
        method: "GET",
        url: "/admin/v1/launch/projects",
        headers: { cookie: acceptor },
      }),
      403,
      "PERMISSION_DENIED",
      "OPS_FORBIDDEN",
    );
    const admin = (await login(harness.app, "operator", bootstrapPassword))
      .cookie;
    const all = await harness.app.inject({
      method: "GET",
      url: "/admin/v1/launch/projects?status=awaiting_approval&limit=1",
      headers: { cookie: admin },
    });
    const page = all.json<{ items: unknown[]; nextCursor: string }>();
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await harness.app.inject({
      method: "GET",
      url: `/admin/v1/launch/projects?status=awaiting_approval&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      headers: { cookie: admin },
    });
    expect(next.json<{ items: unknown[] }>().items).toHaveLength(1);
    const mismatched = await harness.app.inject({
      method: "GET",
      url: `/admin/v1/launch/projects?status=approved&cursor=${encodeURIComponent(page.nextCursor)}`,
      headers: { cookie: admin },
    });
    expectError(mismatched, 400, "INVALID_REQUEST");
  });

  async function sessionOf(
    app: FastifyInstance,
    username: string,
    password: string,
  ): Promise<{ cookie: string; accountId: string | null }> {
    const { cookie, body } = await login(app, username, password);
    return { cookie, accountId: body["accountId"] as string | null };
  }

  async function seedAccount(
    harness: Harness,
    role: AdminRole,
    operatorUserId: string | null = null,
  ): Promise<{ username: string; cookie: string; accountId: string }> {
    const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
    await harness.accounts.seed({
      username,
      password: accountPassword,
      role,
      operatorUserId,
    });
    const session = await sessionOf(harness.app, username, accountPassword);
    return {
      username,
      cookie: session.cookie,
      accountId: session.accountId as string,
    };
  }

  it("lets only a reviewer approve a formula draft someone else saved (Decision 0110)", async () => {
    const harness = await createHarness();
    const base = adminFormulaFixture();
    harness.admin.formulas.set(base.configVersion, base);
    const admin = await seedAccount(harness, "platform_admin");
    const bootstrap = (await login(harness.app, "operator", bootstrapPassword))
      .cookie;
    const reviewer = await seedAccount(
      harness,
      "reviewer",
      harness.reviewerUserId,
    );
    const draft = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/mining/formula-versions",
      headers: { cookie: admin.cookie },
      payload: { configVersion: "s129Next", baseVersion: base.configVersion },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    expect(draft.json()).toMatchObject({
      version: {
        draftAuthor: {
          kind: "admin_account",
          username: admin.username,
          accountId: admin.accountId,
        },
        approvedBy: null,
      },
    });
    const approve = (cookie: string, version = "s129Next") =>
      harness.app.inject({
        method: "POST",
        url: `/admin/v1/mining/formula-versions/${version}/approve`,
        headers: { cookie },
      });
    // The platform administrator (table account and bootstrap) cannot.
    for (const cookie of [admin.cookie, bootstrap]) {
      expectError(
        await approve(cookie),
        403,
        "PERMISSION_DENIED",
        "ADMIN_ROLE_FORBIDDEN",
      );
    }
    // The reviewer reads the list (formula.approve) and approves.
    const list = await harness.app.inject({
      method: "GET",
      url: "/admin/v1/mining/formula-versions",
      headers: { cookie: reviewer.cookie },
    });
    expect(list.statusCode).toBe(200);
    const approved = await approve(reviewer.cookie);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      version: {
        status: "approved",
        approvedBy: {
          username: reviewer.username,
          accountId: reviewer.accountId,
        },
      },
      retiredVersion: base.configVersion,
    });
    const rows = harness.admin.audit.filter((row) =>
      row.action.startsWith("mining.formula.approve"),
    );
    expect(rows.map((row) => row.action)).toEqual([
      "mining.formula.approve.requested",
      "mining.formula.approve",
    ]);
    expect(rows.every((row) => row.actorAccountId === reviewer.accountId)).toBe(
      true,
    );
  });

  it("refuses a reviewer's own draft and a draft without a known author (Decision 0110)", async () => {
    const harness = await createHarness();
    const reviewer = await seedAccount(
      harness,
      "reviewer",
      harness.reviewerUserId,
    );
    harness.admin.formulas.set(
      "ownDraft",
      adminFormulaFixture({
        configVersion: "ownDraft",
        status: "pending_approval",
        effectiveAt: null,
        approvedAt: null,
        draftAuthor: {
          kind: "admin_account",
          actor: reviewer.username,
          accountId: reviewer.accountId,
        },
      }),
    );
    harness.admin.formulas.set(
      "legacyDraft",
      adminFormulaFixture({
        configVersion: "legacyDraft",
        status: "pending_approval",
        effectiveAt: null,
        approvedAt: null,
        draftAuthor: null,
      }),
    );
    const approve = (version: string) =>
      harness.app.inject({
        method: "POST",
        url: `/admin/v1/mining/formula-versions/${version}/approve`,
        headers: { cookie: reviewer.cookie },
      });
    expectError(
      await approve("ownDraft"),
      403,
      "PERMISSION_DENIED",
      "ADMIN_FORMULA_SELF_APPROVAL",
    );
    expectError(
      await approve("legacyDraft"),
      409,
      "ADMIN_CONFLICT",
      "ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN",
    );
    expect(harness.admin.formulas.get("ownDraft")?.status).toBe(
      "pending_approval",
    );
    expect(harness.admin.formulas.get("legacyDraft")?.status).toBe(
      "pending_approval",
    );
    const rows = harness.admin.audit
      .filter((row) => row.action.startsWith("mining.formula.approve"))
      .map((row) => [
        row.action,
        (row.after as { reasonCode?: string } | null)?.reasonCode ?? null,
      ]);
    expect(rows).toEqual([
      ["mining.formula.approve.requested", null],
      ["mining.formula.approve.failed", "ADMIN_FORMULA_SELF_APPROVAL"],
      ["mining.formula.approve.requested", null],
      ["mining.formula.approve.failed", "ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN"],
    ]);
  });

  it("refuses formula approval under NODE_ENV=production like the script", async () => {
    const harness = await createHarness({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://api.example.com",
      V2_CURSOR_HMAC_SECRET: "c".repeat(64),
    });
    harness.admin.formulas.set(
      "draftV9",
      adminFormulaFixture({
        configVersion: "draftV9",
        status: "pending_approval",
        draftAuthor: {
          kind: "admin_bootstrap",
          actor: "operator",
          accountId: null,
        },
      }),
    );
    const reviewer = await seedAccount(
      harness,
      "reviewer",
      harness.reviewerUserId,
    );
    const response = await harness.app.inject({
      method: "POST",
      url: "/admin/v1/mining/formula-versions/draftV9/approve",
      headers: { cookie: reviewer.cookie },
    });
    expectError(
      response,
      503,
      "CAPABILITY_UNAVAILABLE",
      "MINING_APPROVE_FORBIDDEN_IN_PRODUCTION",
    );
    expect(harness.admin.formulas.get("draftV9")?.status).toBe(
      "pending_approval",
    );
  });

  it("locks one account name without locking another, and an address after its limit (Decision 0110)", async () => {
    const harness = await createHarness({ ADMIN_LOGIN_IP_MAX_FAILURES: "8" });
    const alice = await seedAccount(harness, "auditor");
    const bob = await seedAccount(harness, "auditor");
    const attempt = (username: string, password: string, ip: string) =>
      harness.app.inject({
        method: "POST",
        url: "/admin/v1/session",
        payload: { username, password },
        remoteAddress: ip,
      });
    for (let index = 0; index < 4; index += 1) {
      expectError(
        await attempt(alice.username, "wrong-password-0", `192.0.2.${index}`),
        401,
        "ADMIN_LOGIN_INVALID",
      );
    }
    const locked = await attempt(
      alice.username,
      "wrong-password-0",
      "192.0.2.9",
    );
    expectError(locked, 423, "ADMIN_LOGIN_LOCKED");
    expect(locked.json()).toMatchObject({
      detailsSafe: { scope: "username", retryAfterSeconds: 900 },
    });
    expect(locked.headers["retry-after"]).toBe("900");
    // Alice stays locked from any address, Bob logs in.
    expectError(
      await attempt(alice.username, accountPassword, "192.0.2.50"),
      423,
      "ADMIN_LOGIN_LOCKED",
    );
    expect(
      (await attempt(bob.username, accountPassword, "192.0.2.50")).statusCode,
    ).toBe(200);
    // One address spraying names: the 8th failure locks the address.
    for (let index = 0; index < 7; index += 1) {
      expectError(
        await attempt(`ghost-${index}`, "wrong-password-0", "198.51.100.1"),
        401,
        "ADMIN_LOGIN_INVALID",
      );
    }
    const ipLocked = await attempt(
      "ghost-7",
      "wrong-password-0",
      "198.51.100.1",
    );
    expect(ipLocked.json()).toMatchObject({
      code: "ADMIN_LOGIN_LOCKED",
      detailsSafe: { scope: "ip", retryAfterSeconds: 900 },
    });
    // The right password of an unlocked account is refused from that
    // address, accepted from another.
    expectError(
      await attempt(bob.username, accountPassword, "198.51.100.1"),
      423,
      "ADMIN_LOGIN_LOCKED",
    );
    expect(
      (await attempt(bob.username, accountPassword, "198.51.100.2")).statusCode,
    ).toBe(200);
    const locks = harness.admin.audit
      .filter((row) => row.action === "session.login_locked")
      .map((row) => row.after);
    expect(locks).toEqual([
      expect.objectContaining({
        scope: "username",
        username: alice.username,
        accountId: alice.accountId,
      }),
      expect.objectContaining({ scope: "ip", sourceIp: "198.51.100.1" }),
    ]);
  });

  it("answers 503 for account and launch routes without a database", async () => {
    const admin = createInMemoryAdminRepository();
    const app = await buildApp({
      config: s7TestConfig({
        V2_MODULES_ENABLED: "launch,mining,referral",
        ADMIN_USERNAME: "operator",
        ADMIN_PASSWORD_HASH: passwordHash,
        ADMIN_SESSION_SECRET: sessionSecret,
      }),
      database: { ...s7Database({}), admin },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      memePauseSender: null,
      logger: false,
    });
    apps.push(app);
    const cookie = (await login(app, "operator", bootstrapPassword)).cookie;
    for (const url of ["/admin/v1/accounts", "/admin/v1/launch/projects"]) {
      expectError(
        await app.inject({ method: "GET", url, headers: { cookie } }),
        503,
        "CAPABILITY_UNAVAILABLE",
        "ADMIN_DATABASE_UNAVAILABLE",
      );
    }
  });
});
