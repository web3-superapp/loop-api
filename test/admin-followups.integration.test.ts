import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runOperator } from "../scripts/hooks-launch-operator.js";
import { runMiningApproveFormula } from "../scripts/mining-approve-formula.js";
import { createPostgresAdminAccountRepository } from "../src/database/admin-account-repository.js";
import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresAdminLoginAttemptStore } from "../src/database/admin-login-attempt-repository.js";
import { createPostgresAdminRepository } from "../src/database/admin-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { latestMigrationName } from "../src/database/schema.js";
import {
  createAdminAccountService,
  type AdminAccountService,
  type AdminRequestContext,
} from "../src/features/admin/admin-accounts.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import { AdminApiError } from "../src/features/admin/admin-contract.js";
import {
  createAdminLaunchReviewConsoleService,
  type AdminLaunchReviewConsoleService,
} from "../src/features/admin/admin-launch-review.js";
import { defaultAdminLoginPolicy } from "../src/features/admin/admin-login-attempts.js";
import {
  createAdminService,
  type AdminService,
} from "../src/features/admin/admin-service.js";
import type { AdminSettingsReader } from "../src/features/admin/admin-settings-reader.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchReviewService } from "../src/features/launch/hooks-launch-review.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0111 on PostgreSQL (migration 000058), in a throwaway database
 * (formula approvals switch the version in force):
 * - the break-glass `pnpm mining:approve-formula` refuses to run without
 *   `--approved-by` / `--reason`, refuses the draft's own author, records
 *   `cli:<name>` and an audit row (actor `cli`), and marks the production
 *   bypass;
 * - `POST /accounts/{id}/unlock` clears the name bucket only (the address
 *   count stays), lets the account log in again, replays, and refuses the
 *   bootstrap administrator;
 * - disabling a reviewer disables its ops operator in the same transaction,
 *   and both the launch review and formula approval refuse it (also when
 *   the operator alone is revoked by the deployment CLI).
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const sessionSecret = "s130-integration-session-secret-0123456789";
const bootstrapPassword = "bootstrap-password-0123";
const initialPassword = "initial-password-0123";
const ownPassword = "my-own-password-4567";
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

function writer() {
  let contents = "";
  return {
    write: (chunk: string) => {
      contents += chunk;
      return true;
    },
    contents: () => contents,
  };
}

const draftInput = {
  name: "Project",
  ticker: "MEME",
  logoAssetUrl: "https://example.com/logo.png",
  description: "Test",
  links: [],
  nftSaleStartAt: "1900000000",
  buybackRecipient: "0x3333333333333333333333333333333333333333",
};
const launchDraft = parseHooksLaunchDraft(draftInput, {
  nowUnixSeconds: "1800000000",
  minimumLeadSeconds: 86_400,
  nftSaleDurationSeconds: 604_800,
});

describe("Decision 0111 console follow-ups on PostgreSQL", () => {
  const databaseName = `loop_s130_${randomUUID().replaceAll("-", "")}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;
  let service: AdminService;
  let accounts: AdminAccountService;
  let launch: AdminLaunchReviewConsoleService;
  let bootstrap: AdminRequestContext;

  async function user(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:admin-s130:${randomUUID()}`],
    );
    return result.rows[0]!.id;
  }

  function name(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  /** Creates an account through the console, changes the first password, logs in. */
  async function activate(input: {
    readonly role:
      "platform_admin" | "reviewer" | "testnet_acceptor" | "auditor";
    readonly operatorUserId?: string;
  }) {
    const username = name(input.role.replaceAll("_", "-"));
    const created = await accounts.create(bootstrap, randomUUID(), {
      username,
      password: initialPassword,
      role: input.role,
      ...(input.operatorUserId === undefined
        ? {}
        : { operatorUserId: input.operatorUserId }),
    });
    expect(created.status).toBe(201);
    const first = await service.login({
      username,
      password: initialPassword,
      requestId: randomUUID(),
      sourceIp: "198.51.100.1",
    });
    const changed = await accounts.changeOwnPassword(
      { principal: first.principal, requestId: randomUUID() },
      { currentPassword: initialPassword, newPassword: ownPassword },
    );
    const second = await service.login({
      username,
      password: ownPassword,
      requestId: randomUUID(),
      sourceIp: "198.51.100.1",
    });
    const principal = await service.resolvePrincipal(second.token);
    expect(principal?.passwordChangeRequired).toBe(false);
    return {
      username,
      accountId: changed.accountId,
      context: { principal: principal!, requestId: randomUUID() },
      write: { session: second.session, requestId: randomUUID() },
    };
  }

  async function refusal(
    promise: Promise<unknown>,
  ): Promise<{ code: string; statusCode: number; reasonCode: unknown }> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(AdminApiError);
      const apiError = error as AdminApiError;
      return {
        code: apiError.code,
        statusCode: apiError.statusCode,
        reasonCode: apiError.detailsSafe?.["reasonCode"],
      };
    }
    throw new Error("expected a refusal");
  }

  async function formula(configVersion: string) {
    const result = await pool.query<{
      status: string;
      approved_by: string | null;
      approved_by_account_id: string | null;
    }>(
      "select status, approved_by, approved_by_account_id from public.mining_formula_versions where config_version = $1",
      [configVersion],
    );
    return result.rows[0];
  }

  async function cli(argv: readonly string[], nodeEnv = "development") {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runMiningApproveFormula({
      argv: ["node", "mining-approve-formula", ...argv],
      environment: { NODE_ENV: nodeEnv, DATABASE_URL: url },
      stdout,
      stderr,
    });
    return { exitCode, stdout: stdout.contents(), stderr: stderr.contents() };
  }

  async function bucket(scope: "username" | "ip", subject: string) {
    const result = await pool.query<{ failure_count: number; locked: boolean }>(
      `select failure_count, coalesce(locked_until > clock_timestamp(), false) as locked
       from public.admin_login_attempts where scope = $1 and subject_key = $2`,
      [scope, subject],
    );
    return result.rows[0] ?? null;
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    const adminRepository = createPostgresAdminRepository(pool);
    const accountRepository = createPostgresAdminAccountRepository(pool);
    service = createAdminService({
      username: "operator",
      passwordHash: await hashAdminPassword(bootstrapPassword),
      sessionSecret,
      repository: adminRepository,
      accounts: accountRepository,
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
    accounts = createAdminAccountService({
      repository: accountRepository,
      bootstrapUsername: "operator",
      sessionSecret,
    });
    launch = createAdminLaunchReviewConsoleService({
      repository: createPostgresAdminLaunchReviewRepository(pool),
      deploymentChainId: 97,
      review: createHooksLaunchReviewService({
        repository: createPostgresHooksLaunchReviewRepository(pool, {
          now: () => 1_800_000_000,
        }),
      }),
      audit: adminRepository,
      sessionSecret,
      logger: { warn: () => undefined },
    });
    const issued = await service.login({
      username: "operator",
      password: bootstrapPassword,
      requestId: randomUUID(),
      sourceIp: "198.51.100.1",
    });
    bootstrap = { principal: issued.principal, requestId: randomUUID() };
    const mining = createPostgresMiningRepository(pool);
    const documents = buildMiningDevBaselineDocuments([
      "eip155:97:0x00000000000000000000000000000000000000b1",
    ]);
    await mining.createFormulaVersion({
      configVersion: "s130Base",
      formula: documents.formula,
      weightRange: documents.weightRange,
      priceGuardRules: documents.priceGuardRules,
      requestId: randomUUID(),
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("migrates to the head migration", async () => {
    expect(latestMigrationName).toBe("000100_community_bound_asset_unique");
    const head = await pool.query<{ name: string }>(
      "select name from public.pgmigrations order by run_on desc, id desc limit 1",
    );
    expect(head.rows[0]?.name).toBe(latestMigrationName);
  });

  it("refuses the CLI without --approved-by or --reason and touches nothing", async () => {
    for (const [argv, code] of [
      [
        ["s130Base", "--confirm", "--reason", "x"],
        "mining_approve_approver_required",
      ],
      [
        ["s130Base", "--confirm", "--approved-by", "oncall-07"],
        "mining_approve_reason_required",
      ],
      [
        [
          "s130Base",
          "--confirm",
          "--approved-by",
          "oncall-07",
          "--reason",
          "x",
        ],
        "mining_approve_forbidden_in_production",
      ],
    ] as const) {
      const run = await cli(
        argv,
        code === "mining_approve_forbidden_in_production"
          ? "production"
          : "development",
      );
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(code);
    }
    expect(await formula("s130Base")).toEqual({
      status: "pending_approval",
      approved_by: null,
      approved_by_account_id: null,
    });
    const audit = await pool.query(
      "select 1 from public.admin_audit_log where action like 'mining.formula.approve%'",
    );
    expect(audit.rowCount).toBe(0);
  });

  it("approves through the CLI with cli:<name>, an audit row, and no account ID", async () => {
    const run = await cli([
      "s130Base",
      "--confirm",
      "--approved-by",
      "oncall-07",
      "--reason",
      "Snapshot lane blocked; reviewer unreachable",
    ]);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain("approved by cli:oncall-07");
    expect(await formula("s130Base")).toEqual({
      status: "approved",
      approved_by: "cli:oncall-07",
      approved_by_account_id: null,
    });
    const audit = await pool.query<{
      actor: string;
      actor_account_id: string | null;
      target_type: string;
      target_id: string;
      after: Record<string, unknown>;
    }>(
      "select actor, actor_account_id, target_type, target_id, after from public.admin_audit_log where action = 'mining.formula.approve'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor: "cli",
      actor_account_id: null,
      target_type: "mining_formula_version",
      target_id: "s130Base",
      after: {
        channel: "cli",
        approvedBy: "cli:oncall-07",
        reason: "Snapshot lane blocked; reviewer unreachable",
        bypass: false,
        draftAuthor: null,
        status: "approved",
      },
    });
    // The console shows no reviewer for a CLI approval.
    const list = await service.listFormulaVersions();
    const versions = list["items"] as {
      configVersion: string;
      approvedBy: unknown;
    }[];
    expect(
      versions.find((entry) => entry.configVersion === "s130Base")?.approvedBy,
    ).toBeNull();
  });

  it("refuses the CLI for the draft's own author (console or cli: name), in the script and in the database", async () => {
    const platform = await activate({ role: "platform_admin" });
    await service.createFormulaDraft(platform.write, {
      configVersion: "s130Own",
      baseVersion: "s130Base",
      parameters: { dailyOutputBudget: "4321" },
    });
    const run = await cli([
      "s130Own",
      "--confirm",
      "--approved-by",
      platform.username.toUpperCase(),
      "--reason",
      "Trying to approve my own draft",
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("mining_approve_self_approval");
    expect((await formula("s130Own"))?.status).toBe("pending_approval");
    const failed = await pool.query<{
      actor: string;
      after: Record<string, unknown>;
    }>(
      "select actor, after from public.admin_audit_log where action = 'mining.formula.approve.failed' and target_id = 's130Own'",
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]).toMatchObject({
      actor: "cli",
      after: {
        reasonCode: "mining_approve_self_approval",
        approvedBy: `cli:${platform.username.toUpperCase()}`,
      },
    });
    // The database refuses it on its own, too.
    await expect(
      pool.query(
        `update public.mining_formula_versions
         set status = 'approved', approved_at = now(), effective_at = now(),
           approved_by = $1
         where config_version = 's130Own'`,
        [`cli:${platform.username}`],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "mining_formula_versions_approved_by_check",
    });
    // A CLI name may not borrow the console shape either.
    await expect(
      pool.query(
        `update public.mining_formula_versions
         set status = 'approved', approved_at = now(), effective_at = now(),
           approved_by = 'oncall-07'
         where config_version = 's130Own'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("needs --i-know-this-bypasses-review in production and marks bypass: true", async () => {
    const refused = await cli(
      [
        "s130Own",
        "--confirm",
        "--approved-by",
        "oncall-08",
        "--reason",
        "Production incident",
      ],
      "production",
    );
    expect(refused.stderr).toContain("mining_approve_forbidden_in_production");
    expect((await formula("s130Own"))?.status).toBe("pending_approval");
    const run = await cli(
      [
        "s130Own",
        "--confirm",
        "--i-know-this-bypasses-review",
        "--approved-by",
        "oncall-08",
        "--reason",
        "Production incident",
      ],
      "production",
    );
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain("review bypassed");
    expect(await formula("s130Own")).toMatchObject({
      status: "approved",
      approved_by: "cli:oncall-08",
    });
    const audit = await pool.query<{ after: Record<string, unknown> }>(
      "select after from public.admin_audit_log where action = 'mining.formula.approve' and target_id = 's130Own'",
    );
    expect(audit.rows[0]?.after).toMatchObject({
      bypass: true,
      approvedBy: "cli:oncall-08",
      retiredVersion: "s130Base",
    });
  });

  it("unlocks a locked account name, keeps the address count, and lets it log in", async () => {
    const auditor = await activate({ role: "auditor" });
    const key = auditor.username.toLowerCase();
    const address = "203.0.113.77";
    for (let index = 0; index < 5; index += 1) {
      await expect(
        service.login({
          username: auditor.username,
          password: wrongPassword,
          requestId: randomUUID(),
          sourceIp: address,
        }),
      ).rejects.toBeInstanceOf(AdminApiError);
    }
    expect(await bucket("username", key)).toEqual({
      failure_count: 5,
      locked: true,
    });
    const ipBefore = await bucket("ip", address);
    expect(ipBefore?.failure_count).toBe(5);
    expect(
      await refusal(
        service.login({
          username: auditor.username,
          password: ownPassword,
          requestId: randomUUID(),
          sourceIp: address,
        }),
      ),
    ).toMatchObject({ code: "ADMIN_LOGIN_LOCKED", statusCode: 423 });

    const listed = (await accounts.list(bootstrap)) as {
      items: {
        accountId: string;
        locked: boolean;
        lockedUntil: string | null;
      }[];
    };
    const row = listed.items.find(
      (item) => item.accountId === auditor.accountId,
    );
    expect(row?.locked).toBe(true);
    expect(Date.parse(row?.lockedUntil ?? "")).toBeGreaterThan(Date.now());

    // Not for other roles; never the bootstrap administrator.
    expect(
      await refusal(
        accounts.unlock(auditor.context, randomUUID(), auditor.accountId, {
          reasonCode: "identity_verified",
        }),
      ),
    ).toMatchObject({ statusCode: 403, reasonCode: "ADMIN_ROLE_FORBIDDEN" });
    for (const id of ["bootstrap", "operator"]) {
      expect(
        await refusal(
          accounts.unlock(bootstrap, randomUUID(), id, {
            reasonCode: "identity_verified",
          }),
        ),
      ).toMatchObject({
        statusCode: 409,
        reasonCode: "ADMIN_ACCOUNT_ENVIRONMENT",
      });
    }

    const idempotencyKey = randomUUID();
    const unlocked = await accounts.unlock(
      bootstrap,
      idempotencyKey,
      auditor.accountId,
      { reasonCode: "identity_verified" },
    );
    expect(unlocked).toMatchObject({
      changed: true,
      replayed: false,
      account: { locked: false, lockedUntil: null },
    });
    expect(unlocked["audit"]).not.toBeNull();
    expect(await bucket("username", key)).toBeNull();
    // The address bucket is not the account's: unchanged.
    expect(await bucket("ip", address)).toEqual(ipBefore);

    const replay = await accounts.unlock(
      bootstrap,
      idempotencyKey,
      auditor.accountId,
      { reasonCode: "identity_verified" },
    );
    expect(replay).toMatchObject({
      changed: false,
      replayed: true,
      audit: null,
      account: { accountId: auditor.accountId, locked: false },
    });
    expect(
      await refusal(
        accounts.unlock(bootstrap, idempotencyKey, auditor.accountId, {
          reasonCode: "other_reason",
        }),
      ),
    ).toMatchObject({
      statusCode: 409,
      reasonCode: "ADMIN_IDEMPOTENCY_CONFLICT",
    });

    // The holder logs in again; the address keeps its count.
    const issued = await service.login({
      username: auditor.username,
      password: ownPassword,
      requestId: randomUUID(),
      sourceIp: address,
    });
    expect(issued.session.accountId).toBe(auditor.accountId);
    expect((await bucket("ip", address))?.failure_count).toBe(5);

    const audit = await pool.query<{
      actor: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(
      "select actor, before, after from public.admin_audit_log where action = 'account.unlock' and target_id = $1",
      [auditor.accountId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor: "operator",
      before: { scope: "username", failureCount: 5, locked: true },
      after: {
        locked: false,
        reasonCode: "identity_verified",
        idempotencyKey,
      },
    });
    const commands = await pool.query(
      "select 1 from public.admin_account_commands where action = 'account.unlock' and target_account_id = $1",
      [auditor.accountId],
    );
    expect(commands.rowCount).toBe(1);
    // Nothing left to clear: unchanged, no audit row.
    const again = await accounts.unlock(
      bootstrap,
      randomUUID(),
      auditor.accountId,
      { reasonCode: "identity_verified" },
    );
    expect(again).toMatchObject({ changed: false, audit: null });
  });

  it("disables the reviewer's ops operator with the account; launch review and formula approval refuse it", async () => {
    // A launch project with an owner-saved config version 1.
    const owner = await user();
    const projectId = randomUUID();
    await pool.query(
      "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project', 'MEME', 'approved', now(), now())",
      [projectId, owner],
    );
    await createPostgresHooksLaunchProjectConfigRepository(pool).saveOwnedDraft(
      {
        projectId,
        ownerUserId: owner,
        expectedVersion: 0,
        templateVersion: launchDraft.templateVersion,
        configHash: launchDraft.configHash,
        config: launchDraft,
        updatedByUserId: owner,
      },
    );
    const platform = await activate({ role: "platform_admin" });
    await service.createFormulaDraft(platform.write, {
      configVersion: "s130Next",
      baseVersion: "s130Own",
      parameters: { dailyOutputBudget: "5555" },
    });

    const reviewerUser = await user();
    const reviewer = await activate({
      role: "reviewer",
      operatorUserId: reviewerUser,
    });
    const disabled = await accounts.disable(
      bootstrap,
      randomUUID(),
      reviewer.accountId,
      { reasonCode: "left_team" },
    );
    expect(disabled).toMatchObject({
      changed: true,
      account: { status: "disabled", operator: { enabled: false } },
    });
    const operator = await pool.query<{ enabled: boolean }>(
      "select enabled from public.ops_operators where user_id = $1",
      [reviewerUser],
    );
    expect(operator.rows[0]?.enabled).toBe(false);
    const audit = await pool.query<{ after: Record<string, unknown> }>(
      "select after from public.admin_audit_log where action = 'account.disable' and target_id = $1",
      [reviewer.accountId],
    );
    expect(audit.rows[0]?.after).toMatchObject({
      reasonCode: "left_team",
      operatorEnabledBefore: true,
      operatorEnabled: false,
    });
    const opsAudit = await pool.query(
      "select 1 from public.ops_audit where target = $1 and action = 'operator.revoke' and source = 'admin_console'",
      [reviewerUser],
    );
    expect(opsAudit.rowCount).toBe(1);
    // Its sessions are gone; a request already past the session check is
    // refused by the operator / account state.
    expect(
      await refusal(
        launch.approve(reviewer.context, randomUUID(), projectId, "1", {
          configHash: launchDraft.configHash,
          reason: "Independent hash review",
        }),
      ),
    ).toMatchObject({ statusCode: 403, reasonCode: "OPS_FORBIDDEN" });
    expect(
      await refusal(service.approveFormula(reviewer.write, "s130Next")),
    ).toMatchObject({
      statusCode: 403,
      reasonCode: "ADMIN_ACCOUNT_DISABLED",
    });
    // Still disabled: no way back.
    expect(
      await refusal(
        accounts.resetPassword(bootstrap, randomUUID(), reviewer.accountId, {
          password: initialPassword,
        }),
      ),
    ).toMatchObject({ statusCode: 409, reasonCode: "ADMIN_ACCOUNT_DISABLED" });
    expect((await formula("s130Next"))?.status).toBe("pending_approval");
    const approvals = await pool.query(
      "select 1 from public.hooks_launch_config_approvals where project_id = $1",
      [projectId],
    );
    expect(approvals.rowCount).toBe(0);

    // The operator revoked by the deployment CLI alone (account still
    // active) stops formula approval too.
    const otherUser = await user();
    const other = await activate({
      role: "reviewer",
      operatorUserId: otherUser,
    });
    await runOperator(["--user", otherUser, "--revoke", "--confirm"], {
      DATABASE_URL: url,
    });
    expect(
      await refusal(service.approveFormula(other.write, "s130Next")),
    ).toMatchObject({
      statusCode: 403,
      reasonCode: "ADMIN_OPERATOR_DISABLED",
    });
    const failed = await pool.query<{ after: Record<string, unknown> }>(
      "select after from public.admin_audit_log where action = 'mining.formula.approve.failed' and target_id = 's130Next' order by seq",
    );
    expect(failed.rows.map((entry) => entry.after["reasonCode"])).toEqual([
      "ADMIN_ACCOUNT_DISABLED",
      "ADMIN_OPERATOR_DISABLED",
    ]);

    // An active reviewer with an enabled operator still approves.
    const third = await activate({
      role: "reviewer",
      operatorUserId: await user(),
    });
    const approved = await service.approveFormula(third.write, "s130Next");
    expect(approved).toMatchObject({
      version: { configVersion: "s130Next", status: "approved" },
    });
  });
});
