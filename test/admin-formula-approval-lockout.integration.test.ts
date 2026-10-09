import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAdminAccountRepository } from "../src/database/admin-account-repository.js";
import { createPostgresAdminLoginAttemptStore } from "../src/database/admin-login-attempt-repository.js";
import { createPostgresAdminRepository } from "../src/database/admin-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { latestMigrationName } from "../src/database/schema.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import { defaultAdminLoginPolicy } from "../src/features/admin/admin-login-attempts.js";
import type { AdminRole } from "../src/features/admin/admin-roles.js";
import {
  createAdminService,
  type AdminService,
  type AdminWriteContext,
} from "../src/features/admin/admin-service.js";
import type { AdminSettingsReader } from "../src/features/admin/admin-settings-reader.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0110 on PostgreSQL (migrations 000056 / 000057), in a throwaway
 * database so approving formula versions never disturbs another suite:
 * - mining formula approval belongs to a reviewer who did not save the
 *   draft; platform_admin (table account and bootstrap) is refused, a
 *   draft without a recorded author is refused, and the database refuses
 *   approver = author on its own;
 * - login locks per username (A failing never locks B), per client address
 *   (50 failures by default), shared by two service instances, cleared by
 *   a successful login, and audited.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const sessionSecret = "s129-integration-session-secret-0123456789";
const bootstrapPassword = "bootstrap-password-0123";
const accountPassword = "account-password-0123";
const wrongPassword = "wrong-password-0123";

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: connectionUrl(databaseUrl, "postgres"),
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

describe("Decision 0110 formula approval and login lockout on PostgreSQL", () => {
  const databaseName = `loop_s129_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let accountHash = "";
  let serviceA: AdminService;
  let serviceB: AdminService;

  function newService(): AdminService {
    return createAdminService({
      username: "operator",
      passwordHash: bootstrapHash,
      sessionSecret,
      repository: createPostgresAdminRepository(pool),
      accounts: createPostgresAdminAccountRepository(pool),
      loginAttempts: createPostgresAdminLoginAttemptStore(pool),
      loginPolicy: defaultAdminLoginPolicy,
      settingsReader: {} as AdminSettingsReader,
      environmentRecommendedCommunityIds: [],
      communityReview: null,
      memePause: {
        status: "unavailable",
        reasonCode: "MEME_OPERATOR_KEY_MISSING",
      },
      production: false,
      logger: { warn: () => undefined },
    });
  }
  let bootstrapHash = "";

  async function loopUser(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:admin-s129:${randomUUID()}`],
    );
    return result.rows[0]!.id;
  }

  async function account(
    role: AdminRole,
  ): Promise<{ accountId: string; username: string }> {
    const accountId = randomUUID();
    const username = `${role.replaceAll("_", "-")}-${randomUUID().slice(0, 8)}`;
    const operator =
      role === "reviewer" || role === "testnet_acceptor"
        ? await loopUser()
        : null;
    await pool.query(
      `insert into public.admin_accounts (
         id, username, password_hash, role, operator_user_id,
         password_must_change, created_by, created_at, credentials_changed_at
       ) values ($1, $2, $3, $4, $5, false, 'operator', now(), now())`,
      [accountId, username, accountHash, role, operator],
    );
    if (operator !== null) {
      // Decision 0111: formula approval needs the bound operator enabled.
      await pool.query(
        "insert into public.ops_operators (user_id, label, enabled) values ($1, $2, true)",
        [operator, username],
      );
    }
    return { accountId, username };
  }

  async function login(
    service: AdminService,
    username: string,
    password: string,
    sourceIp = "203.0.113.10",
  ): Promise<AdminWriteContext> {
    const issued = await service.login({
      username,
      password,
      requestId: randomUUID(),
      sourceIp,
    });
    return { session: issued.session, requestId: randomUUID() };
  }

  async function failLogin(
    service: AdminService,
    username: string,
    sourceIp: string,
  ): Promise<{ code: string; detailsSafe: unknown }> {
    try {
      await service.login({
        username,
        password: wrongPassword,
        requestId: randomUUID(),
        sourceIp,
      });
    } catch (error) {
      return error as { code: string; detailsSafe: unknown };
    }
    throw new Error("login unexpectedly succeeded");
  }

  async function bucket(
    scope: "username" | "ip",
    subject: string,
  ): Promise<{ failure_count: number; locked: boolean } | null> {
    const result = await pool.query<{
      failure_count: number;
      locked: boolean;
    }>(
      `select failure_count, coalesce(locked_until > clock_timestamp(), false) as locked
       from public.admin_login_attempts where scope = $1 and subject_key = $2`,
      [scope, subject],
    );
    return result.rows[0] ?? null;
  }

  async function auditAfter(action: string): Promise<unknown[]> {
    const result = await pool.query<{ after: unknown }>(
      "select after from public.admin_audit_log where action = $1 order by seq",
      [action],
    );
    return result.rows.map((row) => row.after);
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    const url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    bootstrapHash = await hashAdminPassword(bootstrapPassword);
    accountHash = await hashAdminPassword(accountPassword);
    serviceA = newService();
    serviceB = newService();
    const mining = createPostgresMiningRepository(pool);
    const documents = buildMiningDevBaselineDocuments([
      "eip155:97:0x00000000000000000000000000000000000000b1",
    ]);
    await mining.createFormulaVersion({
      configVersion: "s129Base",
      formula: documents.formula,
      weightRange: documents.weightRange,
      priceGuardRules: documents.priceGuardRules,
      requestId: randomUUID(),
    });
    await mining.approveFormula({
      configVersion: "s129Base",
      requestId: randomUUID(),
      approval: {
        approvedBy: "integration-cli",
        reason: "Integration fixture",
        bypass: false,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("migrates to the head (000057 and later) with the author columns and the attempts table", async () => {
    expect(latestMigrationName).toBe("000058_admin_followups");
    const head = await pool.query<{ name: string }>(
      "select name from public.pgmigrations order by run_on desc, id desc limit 1",
    );
    expect(head.rows[0]?.name).toBe(latestMigrationName);
    const columns = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'mining_formula_versions'
         and column_name in ('draft_author_kind', 'draft_author',
           'draft_author_account_id', 'approved_by', 'approved_by_account_id')`,
    );
    expect(columns.rows).toHaveLength(5);
    // The script-made base version has no recorded author.
    const base = await pool.query<{ draft_author_kind: string | null }>(
      "select draft_author_kind from public.mining_formula_versions where config_version = 's129Base'",
    );
    expect(base.rows[0]?.draft_author_kind).toBeNull();
  });

  it("refuses platform_admin and lets a reviewer approve someone else's draft, never their own", async () => {
    const platform = await account("platform_admin");
    const reviewer = await account("reviewer");
    const otherReviewer = await account("reviewer");
    const adminContext = await login(
      serviceA,
      platform.username,
      accountPassword,
    );
    const bootstrapContext = await login(
      serviceA,
      "operator",
      bootstrapPassword,
    );
    const reviewerContext = await login(
      serviceA,
      reviewer.username,
      accountPassword,
    );
    const otherContext = await login(
      serviceA,
      otherReviewer.username,
      accountPassword,
    );

    const draft = await serviceA.createFormulaDraft(adminContext, {
      configVersion: "s129Next",
      baseVersion: "s129Base",
      parameters: { dailyOutputBudget: "4321" },
    });
    expect(draft["version"]).toMatchObject({
      draftAuthor: {
        kind: "admin_account",
        username: platform.username,
        accountId: platform.accountId,
      },
    });

    // platform_admin, table account and bootstrap: no formula.approve.
    for (const context of [adminContext, bootstrapContext]) {
      await expect(
        serviceA.approveFormula(context, "s129Next"),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        detailsSafe: {
          reasonCode: "ADMIN_ROLE_FORBIDDEN",
          permission: "formula.approve",
        },
      });
    }

    // A draft the reviewer saved (only possible outside the console role
    // table; inserted here) is refused to that reviewer.
    await pool.query(
      `insert into public.mining_formula_versions (
         config_version, formula, weight_range, price_guard_rules, status,
         community_weights, draft_author_kind, draft_author, draft_author_account_id
       )
       select 's129Own', formula, weight_range, price_guard_rules,
         'pending_approval', '[]'::jsonb, 'admin_account', $1, $2
       from public.mining_formula_versions where config_version = 's129Base'`,
      [reviewer.username, reviewer.accountId],
    );
    await expect(
      serviceA.approveFormula(reviewerContext, "s129Own"),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      detailsSafe: { reasonCode: "ADMIN_FORMULA_SELF_APPROVAL" },
    });

    // The reviewer approves the platform administrator's draft.
    const approved = await serviceA.approveFormula(reviewerContext, "s129Next");
    expect(approved).toMatchObject({
      version: {
        configVersion: "s129Next",
        status: "approved",
        approvedBy: {
          username: reviewer.username,
          accountId: reviewer.accountId,
        },
      },
      retiredVersion: "s129Base",
    });
    const stored = await pool.query<{
      approved_by_account_id: string;
      draft_author_account_id: string;
    }>(
      "select approved_by_account_id, draft_author_account_id from public.mining_formula_versions where config_version = 's129Next'",
    );
    expect(stored.rows[0]).toEqual({
      approved_by_account_id: reviewer.accountId,
      draft_author_account_id: platform.accountId,
    });

    // Another reviewer may approve the first reviewer's draft.
    const own = await serviceA.approveFormula(otherContext, "s129Own");
    expect(own).toMatchObject({
      version: { status: "approved" },
      retiredVersion: "s129Next",
    });

    // Both audit lines: intent, decision, and the refusals.
    const actions = await pool.query<{
      action: string;
      actor_account_id: string | null;
    }>(
      `select action, actor_account_id from public.admin_audit_log
       where action like 'mining.formula.approve%' order by seq`,
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      // Decision 0111: the CLI approval of the base version (actor cli).
      "mining.formula.approve",
      "mining.formula.approve.requested",
      "mining.formula.approve.failed",
      "mining.formula.approve.requested",
      "mining.formula.approve",
      "mining.formula.approve.requested",
      "mining.formula.approve",
    ]);
    expect(actions.rows[0]?.actor_account_id).toBeNull();
    expect(actions.rows[4]?.actor_account_id).toBe(reviewer.accountId);
  });

  it("refuses a draft without a recorded author, and the database refuses approver = author", async () => {
    const reviewer = await account("reviewer");
    const reviewerContext = await login(
      serviceA,
      reviewer.username,
      accountPassword,
    );
    await pool.query(
      `insert into public.mining_formula_versions (
         config_version, formula, weight_range, price_guard_rules, status
       )
       select 's129Legacy', formula, weight_range, price_guard_rules, 'pending_approval'
       from public.mining_formula_versions where config_version = 's129Base'`,
    );
    await expect(
      serviceA.approveFormula(reviewerContext, "s129Legacy"),
    ).rejects.toMatchObject({
      code: "ADMIN_CONFLICT",
      detailsSafe: { reasonCode: "ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN" },
    });
    const legacy = await pool.query<{ status: string }>(
      "select status from public.mining_formula_versions where config_version = 's129Legacy'",
    );
    expect(legacy.rows[0]?.status).toBe("pending_approval");
    // The author cannot be filled in later.
    await expect(
      pool.query(
        `update public.mining_formula_versions
         set draft_author_kind = 'admin_bootstrap', draft_author = 'operator'
         where config_version = 's129Legacy'`,
      ),
    ).rejects.toThrow(/set once, on insert/u);
    // A row whose approver is its author violates the check.
    await expect(
      pool.query(
        `insert into public.mining_formula_versions (
           config_version, formula, weight_range, price_guard_rules, status,
           effective_at, approved_at, draft_author_kind, draft_author,
           draft_author_account_id, approved_by, approved_by_account_id
         )
         select 's129Self', formula, weight_range, price_guard_rules, 'retired',
           now(), now(), 'admin_account', $1, $2, $1, $2
         from public.mining_formula_versions where config_version = 's129Base'`,
        [reviewer.username, reviewer.accountId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "mining_formula_versions_separation_check",
    });
  });

  it("locks account A after five failures without locking account B, on every instance", async () => {
    const alice = await account("auditor");
    const bob = await account("auditor");
    // Failures alternate between two service instances (two API processes).
    for (let index = 0; index < 4; index += 1) {
      const service = index % 2 === 0 ? serviceA : serviceB;
      expect(
        await failLogin(service, alice.username, `198.51.100.${index}`),
      ).toMatchObject({ code: "ADMIN_LOGIN_INVALID" });
    }
    expect(
      await failLogin(serviceB, alice.username, "198.51.100.9"),
    ).toMatchObject({
      code: "ADMIN_LOGIN_LOCKED",
      detailsSafe: { scope: "username", retryAfterSeconds: 900 },
    });
    // The name is locked case-insensitively.
    expect(
      await failLogin(serviceA, alice.username.toUpperCase(), "198.51.100.9"),
    ).toMatchObject({
      code: "ADMIN_LOGIN_LOCKED",
      detailsSafe: { scope: "username" },
    });
    expect(await bucket("username", alice.username)).toEqual({
      failure_count: 5,
      locked: true,
    });
    // The right password is refused on the other instance too.
    await expect(
      login(serviceA, alice.username, accountPassword, "198.51.100.20"),
    ).rejects.toMatchObject({
      code: "ADMIN_LOGIN_LOCKED",
      detailsSafe: { scope: "username" },
    });
    // Bob is not affected, from the same address.
    const bobContext = await login(
      serviceA,
      bob.username,
      accountPassword,
      "198.51.100.9",
    );
    expect(bobContext.session.accountId).toBe(bob.accountId);
    const locks = await auditAfter("session.login_locked");
    expect(locks).toContainEqual(
      expect.objectContaining({
        scope: "username",
        username: alice.username,
        accountId: alice.accountId,
        failures: 5,
      }),
    );
  });

  it("clears the username count on a successful login", async () => {
    const carol = await account("auditor");
    for (let index = 0; index < 4; index += 1) {
      await failLogin(serviceA, carol.username, "192.0.2.77");
    }
    expect(await bucket("username", carol.username)).toEqual({
      failure_count: 4,
      locked: false,
    });
    await login(serviceB, carol.username, accountPassword, "192.0.2.77");
    expect(await bucket("username", carol.username)).toBeNull();
    // Four more failures still do not lock: the count started over.
    for (let index = 0; index < 4; index += 1) {
      expect(
        await failLogin(serviceA, carol.username, "192.0.2.78"),
      ).toMatchObject({ code: "ADMIN_LOGIN_INVALID" });
    }
    await login(serviceA, carol.username, accountPassword, "192.0.2.79");
  });

  it("locks an address after 50 failures across names and audits it", async () => {
    const dave = await account("auditor");
    const ip = "203.0.113.200";
    const codes: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const service = index % 2 === 0 ? serviceA : serviceB;
      codes.push((await failLogin(service, `spray-${index}`, ip)).code);
    }
    expect(
      codes.slice(0, 49).every((code) => code === "ADMIN_LOGIN_INVALID"),
    ).toBe(true);
    expect(codes[49]).toBe("ADMIN_LOGIN_LOCKED");
    expect(await bucket("ip", ip)).toEqual({ failure_count: 50, locked: true });
    // Locked: even a right password from that address, any instance.
    await expect(
      login(serviceB, dave.username, accountPassword, ip),
    ).rejects.toMatchObject({
      code: "ADMIN_LOGIN_LOCKED",
      detailsSafe: { scope: "ip", retryAfterSeconds: 900 },
    });
    // Another address is fine.
    await login(serviceA, dave.username, accountPassword, "203.0.113.201");
    const locks = await auditAfter("session.login_locked");
    expect(locks).toContainEqual(
      expect.objectContaining({ scope: "ip", sourceIp: ip, failures: 50 }),
    );
    // Sprayed unknown names are never written into the audit log.
    const failed = (await auditAfter("session.login_failed")) as {
      username: string | null;
      sourceIp: string;
    }[];
    expect(
      failed
        .filter((row) => row.sourceIp === ip)
        .every((row) => row.username === null),
    ).toBe(true);
  });
});
