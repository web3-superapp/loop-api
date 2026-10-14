import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAdminAccountRepository } from "../src/database/admin-account-repository.js";
import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresAdminRepository } from "../src/database/admin-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { latestMigrationName } from "../src/database/schema.js";
import {
  createAdminAccountService,
  type AdminPrincipal,
  type AdminRequestContext,
} from "../src/features/admin/admin-accounts.js";
import { AdminApiError } from "../src/features/admin/admin-contract.js";
import { createAdminLaunchReviewConsoleService } from "../src/features/admin/admin-launch-review.js";
import {
  createAdminService,
  type AdminService,
} from "../src/features/admin/admin-service.js";
import type { AdminSettingsReader } from "../src/features/admin/admin-settings-reader.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import {
  createHooksLaunchReviewService,
  hooksLaunchReviewCommandSchema,
} from "../src/features/launch/hooks-launch-review.js";
import { runOperator } from "../scripts/hooks-launch-operator.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0109 on PostgreSQL (migration 000055): console accounts with
 * role-derived ops grants written through the Decision 0108 bootstrap,
 * idempotent account writes, sessions ended by disable / password change,
 * and the separation of duties end to end: platform_admin cannot approve,
 * a testnet acceptor cannot approve, a reviewer cannot accept, an editor
 * or project owner cannot approve their own version, and an acceptor who
 * edited the version cannot accept it.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const sessionSecret = "s128-integration-session-secret-0123456789";
const bootstrapPassword = "bootstrap-password-0123";
const initialPassword = "initial-password-0123";
const ownPassword = "my-own-password-4567";

const adminRepository = createPostgresAdminRepository(pool);
const accountRepository = createPostgresAdminAccountRepository(pool);
const hooksReview = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const logger = { warn: () => undefined };
const accounts = createAdminAccountService({
  repository: accountRepository,
  bootstrapUsername: "operator",
  sessionSecret,
});
const launch = createAdminLaunchReviewConsoleService({
  repository: createPostgresAdminLaunchReviewRepository(pool),
  deploymentChainId: 97,
  review: createHooksLaunchReviewService({ repository: hooksReview }),
  audit: adminRepository,
  sessionSecret,
  logger,
});
let service: AdminService;
let bootstrap: AdminRequestContext;

const draftInput = {
  name: "Project",
  ticker: "MEME",
  logoAssetUrl: "https://example.com/logo.png",
  description: "Test",
  links: [],
  nftSaleStartAt: "1900000000",
  buybackRecipient: "0x3333333333333333333333333333333333333333",
};
const draft = parseHooksLaunchDraft(draftInput, {
  nowUnixSeconds: "1800000000",
  minimumLeadSeconds: 86_400,
  nftSaleDurationSeconds: 604_800,
});

beforeAll(async () => {
  service = createAdminService({
    username: "operator",
    passwordHash: await hashAdminPassword(bootstrapPassword),
    sessionSecret,
    repository: adminRepository,
    settingsReader: {} as AdminSettingsReader,
    environmentRecommendedCommunityIds: [],
    communityReview: null,
    memePause: {
      status: "unavailable",
      reasonCode: "MEME_OPERATOR_KEY_MISSING",
    },
    production: false,
    logger,
    accounts: accountRepository,
  });
  const issued = await service.login({
    username: "operator",
    password: bootstrapPassword,
    requestId: randomUUID(),
  });
  bootstrap = { principal: issued.principal, requestId: randomUUID() };
});

afterAll(async () => {
  await pool.end();
});

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:admin-s128:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function ownerProject(): Promise<{ owner: string; projectId: string }> {
  const owner = await user();
  const projectId = randomUUID();
  await pool.query(
    "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project', 'MEME', 'approved', now(), now())",
    [projectId, owner],
  );
  await configs.saveOwnedDraft({
    projectId,
    ownerUserId: owner,
    expectedVersion: 0,
    templateVersion: draft.templateVersion,
    configHash: draft.configHash,
    config: draft,
    updatedByUserId: owner,
  });
  return { owner, projectId };
}

function name(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Creates an account, logs in, changes the initial password, logs in again. */
async function activate(input: {
  readonly role: "platform_admin" | "reviewer" | "testnet_acceptor" | "auditor";
  readonly operatorUserId?: string;
  readonly projectIds?: readonly string[];
}): Promise<{
  context: AdminRequestContext;
  accountId: string;
  token: string;
  username: string;
}> {
  const username = name(input.role.replaceAll("_", "-"));
  const created = await accounts.create(bootstrap, randomUUID(), {
    username,
    password: initialPassword,
    role: input.role,
    ...(input.operatorUserId === undefined
      ? {}
      : { operatorUserId: input.operatorUserId }),
    ...(input.projectIds === undefined ? {} : { projectIds: input.projectIds }),
  });
  expect(created.status).toBe(201);
  const first = await service.login({
    username,
    password: initialPassword,
    requestId: randomUUID(),
  });
  expect(first.principal.passwordChangeRequired).toBe(true);
  const changed = await accounts.changeOwnPassword(
    { principal: first.principal, requestId: randomUUID() },
    { currentPassword: initialPassword, newPassword: ownPassword },
  );
  expect(changed.passwordMustChange).toBe(false);
  // The pre-change cookie is dead.
  expect(await service.resolvePrincipal(first.token)).toBeNull();
  const second = await service.login({
    username,
    password: ownPassword,
    requestId: randomUUID(),
  });
  const principal = (await service.resolvePrincipal(
    second.token,
  )) as AdminPrincipal;
  expect(principal.passwordChangeRequired).toBe(false);
  return {
    context: { principal, requestId: randomUUID() },
    accountId: changed.accountId,
    token: second.token,
    username,
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

function approveBody(hash = draft.configHash) {
  return { configHash: hash, reason: "Independent hash review" };
}

function acceptanceBody(version = 1) {
  return {
    configVersion: version,
    configHash: draft.configHash,
    contractManifestHash: `0x${"cd".repeat(32)}`,
    checklistVersion: "hooks-testnet-v1",
    outcome: "passed",
    evidence: [{ label: "deploy tx", uri: `0x${"ef".repeat(32)}` }],
    reason: "Testnet checklist passed",
  };
}

async function approvalCount(projectId: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    "select count(*)::text as n from public.hooks_launch_config_approvals where project_id = $1",
    [projectId],
  );
  return Number(result.rows[0]!.n);
}

describe("Decision 0109 console accounts (000055)", () => {
  it("is the migration head and guards account identity", async () => {
    const head = await pool.query<{ name: string }>(
      "select name from public.pgmigrations order by run_on desc, id desc limit 1",
    );
    expect(head.rows[0]?.name).toBe(latestMigrationName);
    const { accountId } = await activate({ role: "auditor" });
    await expect(
      pool.query(
        "update public.admin_accounts set role = 'platform_admin' where id = $1",
        [accountId],
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      pool.query("delete from public.admin_accounts where id = $1", [
        accountId,
      ]),
    ).rejects.toThrow(/never deleted/u);
    await expect(
      pool.query(
        "insert into public.admin_accounts (id, username, password_hash, role, created_by, created_at, credentials_changed_at) values ($1, 'bad-reviewer', $2, 'reviewer', 'operator', now(), now())",
        [
          randomUUID(),
          (
            await pool.query<{ password_hash: string }>(
              "select password_hash from public.admin_accounts where id = $1",
              [accountId],
            )
          ).rows[0]!.password_hash,
        ],
      ),
    ).rejects.toThrow(/admin_accounts_operator_binding_check/u);
  });

  it("creates a reviewer with derived grants through the ops bootstrap, idempotently", async () => {
    const reviewerUser = await user();
    const { projectId } = await ownerProject();
    const key = randomUUID();
    const body = {
      username: name("reviewer"),
      password: initialPassword,
      role: "reviewer",
      operatorUserId: reviewerUser,
      projectIds: [projectId],
    };
    const created = await accounts.create(bootstrap, key, body);
    expect(created.status).toBe(201);
    const grants = await pool.query<{ permission: string; scope: string }>(
      "select permission, scope from public.ops_grants where user_id = $1 order by permission, scope",
      [reviewerUser],
    );
    expect(grants.rows).toEqual([
      { permission: "audit.read", scope: "*" },
      { permission: "launch.approve", scope: projectId },
      { permission: "launch.read", scope: projectId },
    ]);
    const opsAudit = await pool.query(
      "select actor_kind, source, action, admin_actor, admin_account_id, actor_id, after_state from public.ops_audit where target = $1",
      [reviewerUser],
    );
    expect(opsAudit.rows).toHaveLength(1);
    expect(opsAudit.rows[0]).toMatchObject({
      actor_kind: "admin_account",
      source: "admin_console",
      action: "operator.provision",
      admin_actor: "operator",
      admin_account_id: null,
      actor_id: null,
    });
    const consoleAudit = await pool.query(
      "select actor, action, after from public.admin_audit_log where action = 'account.create' and target_id = $1",
      [(created.body as { account: { accountId: string } }).account.accountId],
    );
    expect(consoleAudit.rows).toHaveLength(1);
    expect(JSON.stringify(consoleAudit.rows[0])).not.toContain("argon2");
    const replay = await accounts.create(bootstrap, key, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, audit: null });
    expect(
      await refusal(
        accounts.create(bootstrap, key, {
          ...body,
          password: "different-password-1",
        }),
      ),
    ).toMatchObject({
      statusCode: 409,
      reasonCode: "ADMIN_IDEMPOTENCY_CONFLICT",
    });
    // One active account per LOOP user.
    expect(
      await refusal(
        accounts.create(bootstrap, randomUUID(), {
          ...body,
          username: name("acceptor"),
          role: "testnet_acceptor",
        }),
      ),
    ).toMatchObject({
      statusCode: 409,
      reasonCode: "ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND",
    });
    // Unknown LOOP user / unknown project.
    expect(
      await refusal(
        accounts.create(bootstrap, randomUUID(), {
          ...body,
          username: name("ghost"),
          operatorUserId: randomUUID(),
        }),
      ),
    ).toMatchObject({ statusCode: 422 });
    expect(
      await refusal(
        accounts.create(bootstrap, randomUUID(), {
          ...body,
          username: name("ghost"),
          operatorUserId: await user(),
          projectIds: [randomUUID()],
        }),
      ),
    ).toMatchObject({
      statusCode: 422,
      reasonCode: "ADMIN_ACCOUNT_PROJECT_NOT_FOUND",
    });
    const listed = await accounts.list(bootstrap);
    expect(JSON.stringify(listed)).not.toContain("argon2");
  });

  it("resolves an App-visible LOOP ID to the bound user (Decision 0130)", async () => {
    const reviewerUser = await user();
    const otherUser = await user();
    const loopIdOf = async (id: string) =>
      (
        await pool.query<{ loop_id: string }>(
          "select loop_id from public.loop_users where id = $1",
          [id],
        )
      ).rows[0]!.loop_id;
    const loopId = await loopIdOf(reviewerUser);
    expect(loopId).toMatch(/^LOOP-[0-9A-Z]{8}$/u);
    const base = { password: initialPassword, role: "reviewer" };
    // Unknown LOOP ID: nothing is written.
    const before = await pool.query(
      "select count(*)::int as n from public.admin_accounts",
    );
    expect(
      await refusal(
        accounts.create(bootstrap, randomUUID(), {
          ...base,
          username: name("ghost"),
          operatorLoopId: "LOOP-00000000",
        }),
      ),
    ).toMatchObject({
      statusCode: 422,
      reasonCode: "ADMIN_ACCOUNT_OPERATOR_LOOP_ID_NOT_FOUND",
    });
    // Both identities given but naming different users.
    expect(
      await refusal(
        accounts.create(bootstrap, randomUUID(), {
          ...base,
          username: name("mismatch"),
          operatorLoopId: loopId,
          operatorUserId: otherUser,
        }),
      ),
    ).toMatchObject({
      statusCode: 422,
      reasonCode: "ADMIN_ACCOUNT_OPERATOR_IDENTITY_MISMATCH",
    });
    const after = await pool.query(
      "select count(*)::int as n from public.admin_accounts",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    // Lower-case LOOP ID resolves to the user ID on the real table.
    const created = await accounts.create(bootstrap, randomUUID(), {
      ...base,
      username: name("by-loop-id"),
      operatorLoopId: loopId.toLowerCase(),
    });
    expect(created.status).toBe(201);
    const account = (
      created.body as {
        account: {
          accountId: string;
          operatorUserId: string;
          operator: { loopId: string; enabled: boolean };
        };
      }
    ).account;
    expect(account.operatorUserId).toBe(reviewerUser);
    expect(account.operator).toMatchObject({ loopId, enabled: true });
    const stored = await pool.query(
      "select operator_user_id from public.admin_accounts where id = $1",
      [account.accountId],
    );
    expect(stored.rows).toEqual([{ operator_user_id: reviewerUser }]);
    const grants = await pool.query(
      "select permission from public.ops_grants where user_id = $1 order by permission",
      [reviewerUser],
    );
    expect(
      grants.rows.map((row: { permission: string }) => row.permission),
    ).toEqual(["audit.read", "launch.approve", "launch.read"]);
    // Both identities naming the same user are accepted.
    const acceptor = await user();
    const both = await accounts.create(bootstrap, randomUUID(), {
      ...base,
      role: "testnet_acceptor",
      username: name("both"),
      operatorLoopId: await loopIdOf(acceptor),
      operatorUserId: acceptor,
    });
    expect(both.status).toBe(201);
    // The list projects the LOOP ID next to the user ID.
    const listed = (await accounts.list(bootstrap)) as {
      items: { accountId: string; operator: { loopId: string } | null }[];
    };
    expect(
      listed.items.find((entry) => entry.accountId === account.accountId)
        ?.operator?.loopId,
    ).toBe(loopId);
  });

  it("ends sessions on disable and reset, and revokes the operator", async () => {
    const reviewerUser = await user();
    const reviewer = await activate({
      role: "reviewer",
      operatorUserId: reviewerUser,
    });
    const disabled = await accounts.disable(
      bootstrap,
      randomUUID(),
      reviewer.accountId,
      {
        reasonCode: "left_team",
      },
    );
    expect(disabled).toMatchObject({
      changed: true,
      account: { status: "disabled" },
    });
    expect(await service.resolvePrincipal(reviewer.token)).toBeNull();
    const operator = await pool.query<{ enabled: boolean }>(
      "select enabled from public.ops_operators where user_id = $1",
      [reviewerUser],
    );
    expect(operator.rows[0]?.enabled).toBe(false);
    expect(
      await refusal(
        service.login({
          username: reviewer.username,
          password: ownPassword,
          requestId: randomUUID(),
        }),
      ),
    ).toMatchObject({ code: "ADMIN_LOGIN_INVALID" });
    // Disabled is terminal; the user can be bound again by a new account.
    expect(
      await refusal(
        accounts.resetPassword(bootstrap, randomUUID(), reviewer.accountId, {
          password: initialPassword,
        }),
      ),
    ).toMatchObject({ statusCode: 409, reasonCode: "ADMIN_ACCOUNT_DISABLED" });
    const rebound = await activate({
      role: "testnet_acceptor",
      operatorUserId: reviewerUser,
    });
    const auditor = await activate({ role: "auditor" });
    await accounts.resetPassword(bootstrap, randomUUID(), auditor.accountId, {
      password: "temporary-password-9",
    });
    expect(await service.resolvePrincipal(auditor.token)).toBeNull();
    expect(await service.resolvePrincipal(rebound.token)).not.toBeNull();
    // Self-disable is refused.
    expect(
      await refusal(
        accounts.disable(auditor.context, randomUUID(), auditor.accountId, {
          reasonCode: "x",
        }),
      ),
    ).toMatchObject({ statusCode: 403 });
  });
});

describe("Decision 0108 deployment CLI on the shared bootstrap", () => {
  it("still provisions and revokes with deployment_cli audit rows", async () => {
    const target = await user();
    const env = { DATABASE_URL: requireIntegrationDatabaseUrl() };
    await runOperator(
      [
        "--user",
        target,
        "--label",
        "CLI operator",
        "--permissions",
        "launch.read,launch.edit",
        "--confirm",
      ],
      env,
    );
    await runOperator(["--user", target, "--revoke", "--confirm"], env);
    const rows = await pool.query<{
      actor_kind: string;
      source: string;
      action: string;
      admin_actor: string | null;
      after_state: { enabled: boolean | null; grants: unknown[] };
    }>(
      "select actor_kind, source, action, admin_actor, after_state from public.ops_audit where target = $1 order by id",
      [target],
    );
    expect(
      rows.rows.map((row) => [row.actor_kind, row.source, row.action]),
    ).toEqual([
      ["deployment_admin", "deployment_cli", "operator.bootstrap"],
      ["deployment_admin", "deployment_cli", "operator.bootstrap"],
    ]);
    expect(rows.rows[0]?.after_state).toMatchObject({ enabled: true });
    expect(rows.rows[0]?.after_state.grants).toHaveLength(2);
    expect(rows.rows[1]?.after_state).toMatchObject({ enabled: false });
    expect(rows.rows.every((row) => row.admin_actor === null)).toBe(true);
  });
});

describe("Decision 0109 separation of duties (Hooks review)", () => {
  it("refuses platform_admin, acceptor approval, and reviewer acceptance; editor and owner self-approval", async () => {
    const { owner, projectId } = await ownerProject();
    const reviewer = await activate({
      role: "reviewer",
      operatorUserId: await user(),
    });
    const acceptor = await activate({
      role: "testnet_acceptor",
      operatorUserId: await user(),
    });
    const platform = await activate({ role: "platform_admin" });

    // platform_admin (table account and bootstrap) cannot approve or accept.
    for (const context of [platform.context, bootstrap]) {
      expect(
        await refusal(
          launch.approve(context, randomUUID(), projectId, "1", approveBody()),
        ),
      ).toMatchObject({ statusCode: 403, reasonCode: "ADMIN_ROLE_FORBIDDEN" });
      expect(
        await refusal(
          launch.recordTestnetAcceptance(
            context,
            randomUUID(),
            projectId,
            acceptanceBody(),
          ),
        ),
      ).toMatchObject({ statusCode: 403, reasonCode: "ADMIN_ROLE_FORBIDDEN" });
    }
    // The acceptor cannot approve; the reviewer cannot accept.
    expect(
      await refusal(
        launch.approve(
          acceptor.context,
          randomUUID(),
          projectId,
          "1",
          approveBody(),
        ),
      ),
    ).toMatchObject({ statusCode: 403, reasonCode: "ADMIN_ROLE_FORBIDDEN" });
    expect(
      await refusal(
        launch.recordTestnetAcceptance(
          reviewer.context,
          randomUUID(),
          projectId,
          acceptanceBody(),
        ),
      ),
    ).toMatchObject({ statusCode: 403, reasonCode: "ADMIN_ROLE_FORBIDDEN" });
    expect(await approvalCount(projectId)).toBe(0);

    // The project owner (editor of the owner-saved version 1) as a reviewer.
    const ownerReviewer = await activate({
      role: "reviewer",
      operatorUserId: owner,
    });
    expect(
      await refusal(
        launch.approve(
          ownerReviewer.context,
          randomUUID(),
          projectId,
          "1",
          approveBody(),
        ),
      ),
    ).toMatchObject({ statusCode: 403, reasonCode: "OPS_SELF_APPROVAL" });

    // An operator edits version 2, then holds a reviewer account: refused.
    const editorUser = await user();
    await pool.query(
      "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Editor', true)",
      [editorUser],
    );
    await pool.query(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.edit', '*')",
      [editorUser],
    );
    await hooksReview.execute(
      editorUser,
      hooksLaunchReviewCommandSchema.parse({
        operationId: randomUUID(),
        action: "launch.config.save",
        target: projectId,
        reason: "Operator correction",
        payload: { expectedVersion: 1, config: draftInput },
      }),
      { nftSaleDurationSeconds: 604_800 },
    );
    const editorReviewer = await activate({
      role: "reviewer",
      operatorUserId: editorUser,
    });
    expect(
      await refusal(
        launch.approve(
          editorReviewer.context,
          randomUUID(),
          projectId,
          "2",
          approveBody(),
        ),
      ),
    ).toMatchObject({ statusCode: 403, reasonCode: "OPS_SELF_APPROVAL" });
    // A stale version is a conflict, not an approval.
    expect(
      await refusal(
        launch.approve(
          reviewer.context,
          randomUUID(),
          projectId,
          "1",
          approveBody(),
        ),
      ),
    ).toMatchObject({ statusCode: 409, reasonCode: "OPS_VERSION_CONFLICT" });
    expect(await approvalCount(projectId)).toBe(0);

    const failedRows = await pool.query<{ n: string }>(
      "select count(*)::text as n from public.admin_audit_log where action = 'launch.config.approve.failed' and target_id = $1",
      [projectId],
    );
    expect(Number(failedRows.rows[0]!.n)).toBe(3);
    const rejectedOps = await pool.query<{ n: string }>(
      "select count(*)::text as n from public.ops_audit where action = 'launch.config.approve' and target = $1 and outcome = 'rejected'",
      [projectId],
    );
    expect(Number(rejectedOps.rows[0]!.n)).toBe(3);

    // An independent reviewer approves the latest version.
    const key = randomUUID();
    const approved = await launch.approve(
      reviewer.context,
      key,
      projectId,
      "2",
      approveBody(),
    );
    expect(approved).toMatchObject({
      operationId: key,
      replayed: false,
      approval: {
        projectId,
        configVersion: 2,
        approverUserId: reviewer.context.principal.operatorUserId,
      },
    });
    const replayed = await launch.approve(
      reviewer.context,
      key,
      projectId,
      "2",
      approveBody(),
    );
    expect(replayed).toMatchObject({
      replayed: true,
      approval: { configVersion: 2 },
    });
    expect(await approvalCount(projectId)).toBe(1);

    // The editor of version 2 cannot accept it either.
    await accounts.disable(bootstrap, randomUUID(), editorReviewer.accountId, {
      reasonCode: "role_change",
    });
    const editorAcceptor = await activate({
      role: "testnet_acceptor",
      operatorUserId: editorUser,
    });
    expect(
      await refusal(
        launch.recordTestnetAcceptance(
          editorAcceptor.context,
          randomUUID(),
          projectId,
          acceptanceBody(2),
        ),
      ),
    ).toMatchObject({ statusCode: 403, reasonCode: "OPS_SELF_ACCEPTANCE" });

    // An independent acceptor records the testnet acceptance.
    const acceptanceKey = randomUUID();
    const accepted = await launch.recordTestnetAcceptance(
      acceptor.context,
      acceptanceKey,
      projectId,
      acceptanceBody(2),
    );
    expect(accepted).toMatchObject({
      acceptance: {
        acceptanceId: acceptanceKey,
        chainId: 97,
        outcome: "passed",
      },
    });

    // Reads: stage filter and detail.
    const auditor = await activate({ role: "auditor" });
    const acceptedPage = (await launch.listProjects(auditor.context, {
      status: "accepted",
      limit: 100,
    })) as {
      items: { projectId: string; stage: string }[];
    };
    expect(
      acceptedPage.items.some((item) => item.projectId === projectId),
    ).toBe(true);
    const detail = (await launch.getProject(auditor.context, projectId)) as {
      project: { stage: string; latestApproval: unknown };
      versions: {
        version: number;
        editedBy: { kind: string };
        approval: unknown;
      }[];
      testnetAcceptances: unknown[];
    };
    expect(detail.project.stage).toBe("accepted");
    expect(
      detail.versions.map((entry) => [entry.version, entry.editedBy.kind]),
    ).toEqual([
      [2, "operator"],
      [1, "owner"],
    ]);
    expect(detail.versions[0]?.approval).not.toBeNull();
    expect(detail.versions[1]?.approval).toBeNull();
    expect(detail.testnetAcceptances).toHaveLength(1);
  });

  it("projects a deployment task with predicted addresses and no signature", async () => {
    const { owner, projectId } = await ownerProject();
    const reviewer = await activate({
      role: "reviewer",
      operatorUserId: await user(),
    });
    await launch.approve(
      reviewer.context,
      randomUUID(),
      projectId,
      "1",
      approveBody(),
    );
    const projectOwner = `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
    const request = {
      configHash: draft.configHash,
      projectOwner,
      configVersion: 1,
      name: draft.name,
      ticker: draft.ticker,
      nftSaleStart: draft.nftSaleStartAt,
      buybackRecipient: draft.buybackRecipient,
      deadline: "1800000900",
      nonce: "7",
      memeSalt: `0x${"00".repeat(32)}`,
    };
    await submissions.accept({
      ownerUserId: owner,
      projectId,
      idempotencyKey: randomUUID(),
      fingerprint: `0x${"11".repeat(32)}`,
      factoryAddress: "0x1111111111111111111111111111111111111111",
      request,
      signedPayload: {
        walletId: "test-wallet",
        request,
        hookSalt: `0x${"22".repeat(32)}`,
        signature: `0x${"33".repeat(65)}`,
      },
      memeAddress: `0x${"ab".repeat(18)}6666`,
      hookAddress: `0x${"ab".repeat(18)}20cc`,
    });
    const detail = await launch.getProject(bootstrap, projectId);
    expect(detail).toMatchObject({
      project: { stage: "deploying" },
      deploymentTasks: [
        {
          status: "awaiting_executor",
          chainId: 97,
          predictedMemeAddress: `0x${"ab".repeat(18)}6666`,
          predictedHookAddress: `0x${"ab".repeat(18)}20cc`,
          authorizationCount: 1,
        },
      ],
    });
    expect(JSON.stringify(detail)).not.toContain("3".repeat(130));
    expect(JSON.stringify(detail)).not.toContain('"signature"');
    const deploying = (await launch.listProjects(bootstrap, {
      status: "deploying",
      limit: 100,
    })) as {
      items: { projectId: string }[];
    };
    expect(deploying.items.some((item) => item.projectId === projectId)).toBe(
      true,
    );
  });

  it("scopes a project-bound acceptor's reads to their projects", async () => {
    const first = await ownerProject();
    const second = await ownerProject();
    const acceptor = await activate({
      role: "testnet_acceptor",
      operatorUserId: await user(),
      projectIds: [first.projectId],
    });
    const page = (await launch.listProjects(acceptor.context, {
      limit: 100,
    })) as {
      items: { projectId: string }[];
      scope: string;
    };
    expect(page.scope).toBe("projects");
    expect(page.items.map((item) => item.projectId)).toEqual([first.projectId]);
    expect(
      await refusal(launch.getProject(acceptor.context, second.projectId)),
    ).toMatchObject({ statusCode: 404 });
  });
});
