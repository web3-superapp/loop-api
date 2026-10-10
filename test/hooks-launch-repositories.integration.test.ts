import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import {
  HooksLaunchProjectNotFoundError,
  HooksLaunchProjectVersionConflictError,
} from "../src/features/launch/hooks-launch-project-config.js";
import {
  hooksLaunchReviewCommandSchema,
  type HooksLaunchReviewCommand,
  type HooksLaunchOpsPermission,
} from "../src/features/launch/hooks-launch-review.js";
import type { AcceptHooksLaunchSubmission } from "../src/features/launch/hooks-launch-submission.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0108: PostgreSQL behaviour of the Hooks launch port (migrations
 * 000051–000054; requirer originals 000050/000047+49+51/000052/000053).
 * Covers owner draft CAS, operator separation of duties, approval-gated
 * signed tasks, idempotency, concurrency, and append-only guards.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);

afterAll(async () => {
  await pool.end();
});

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
});

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:hooks-s125:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function project(
  owner: string,
  reviewStatus: "draft" | "approved" = "approved",
): Promise<string> {
  const projectId = randomUUID();
  if (reviewStatus === "approved") {
    await pool.query(
      "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project', 'MEME', 'approved', now(), now())",
      [projectId, owner],
    );
  } else {
    await pool.query(
      "insert into public.launch_projects (project_id, owner_user_id, name, ticker) values ($1, $2, 'Project', 'MEME')",
      [projectId, owner],
    );
  }
  return projectId;
}

async function operator(
  permissions: readonly HooksLaunchOpsPermission[],
  scope = "*",
): Promise<string> {
  const id = await user();
  await pool.query(
    "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Reviewer', true)",
    [id],
  );
  for (const permission of permissions) {
    await pool.query(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, $2, $3)",
      [id, permission, scope],
    );
  }
  return id;
}

function command(input: unknown): HooksLaunchReviewCommand {
  return hooksLaunchReviewCommandSchema.parse(input);
}

function approve(
  projectId: string,
  configHash = draft.configHash,
  version = 1,
) {
  return command({
    operationId: randomUUID(),
    action: "launch.config.approve",
    target: projectId,
    reason: "Independent hash review",
    payload: { configVersion: version, configHash },
  });
}

async function ownerDraft(): Promise<{ owner: string; projectId: string }> {
  const owner = await user();
  const projectId = await project(owner);
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

async function seed(approved = true): Promise<AcceptHooksLaunchSubmission> {
  const { owner, projectId } = await ownerDraft();
  if (approved) {
    const approver = await operator(["launch.approve"]);
    await review.execute(approver, approve(projectId));
  }
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
  return {
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
  };
}

describe("Hooks owner drafts (000051)", () => {
  it("appends versions under CAS and scopes reads to the owner", async () => {
    const { owner, projectId } = await ownerDraft();
    await expect(
      configs.saveOwnedDraft({
        projectId,
        ownerUserId: owner,
        expectedVersion: 0,
        templateVersion: draft.templateVersion,
        configHash: draft.configHash,
        config: draft,
        updatedByUserId: owner,
      }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectVersionConflictError);
    const second = await configs.saveOwnedDraft({
      projectId,
      ownerUserId: owner,
      expectedVersion: 1,
      templateVersion: draft.templateVersion,
      configHash: draft.configHash,
      config: draft,
      updatedByUserId: owner,
    });
    expect(second.version).toBe(2);
    expect(
      (await configs.getOwnedDraft({ projectId, ownerUserId: owner }))?.version,
    ).toBe(2);
    const stranger = await user();
    expect(
      await configs.getOwnedDraft({ projectId, ownerUserId: stranger }),
    ).toBeNull();
    await expect(
      configs.saveOwnedDraft({
        projectId,
        ownerUserId: stranger,
        expectedVersion: 2,
        templateVersion: draft.templateVersion,
        configHash: draft.configHash,
        config: draft,
        updatedByUserId: stranger,
      }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectNotFoundError);
    await expect(
      pool.query(
        "update public.hooks_launch_project_config_versions set config_hash = config_hash where project_id = $1",
        [projectId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses economic override keys in stored config", async () => {
    const owner = await user();
    const projectId = await project(owner);
    await expect(
      pool.query(
        "insert into public.hooks_launch_project_config_versions (project_id, config_version, owner_user_id, template_version, config_hash, config) values ($1, 1, $2, 'hooks_launch_v1', $3, $4::jsonb)",
        [
          projectId,
          owner,
          draft.configHash,
          JSON.stringify({ ...draft, curveBuyTaxBps: 0 }),
        ],
      ),
    ).rejects.toThrow(/hooks_launch_config_object/);
  });
});

describe("Hooks operator review (000052–000053)", () => {
  it("forbids a missing, disabled, or unscoped operator and audits the rejection", async () => {
    const { projectId } = await ownerDraft();
    const nobody = await user();
    const rejected = approve(projectId);
    await expect(review.execute(nobody, rejected)).rejects.toMatchObject({
      code: "OPS_FORBIDDEN",
    });
    const audit = await pool.query<{ outcome: string; code: string }>(
      "select outcome, code from public.ops_audit where operation_id = $1",
      [rejected.operationId],
    );
    expect(audit.rows).toEqual([
      { outcome: "rejected", code: "OPS_FORBIDDEN" },
    ]);

    const otherProject = randomUUID();
    const scoped = await operator(["launch.approve"], otherProject);
    await expect(
      review.execute(scoped, approve(projectId)),
    ).rejects.toMatchObject({ code: "OPS_FORBIDDEN" });

    const revoked = await operator(["launch.approve"]);
    await pool.query(
      "update public.ops_operators set enabled = false where user_id = $1",
      [revoked],
    );
    await expect(
      review.execute(revoked, approve(projectId)),
    ).rejects.toMatchObject({ code: "OPS_FORBIDDEN" });

    const editorOnly = await operator(["launch.edit"]);
    await expect(
      review.execute(editorOnly, approve(projectId)),
    ).rejects.toMatchObject({ code: "OPS_FORBIDDEN" });
  });

  it("separates editor from approver and owner from approver", async () => {
    const { owner, projectId } = await ownerDraft();
    const both = await operator(["launch.edit", "launch.approve"]);
    const edited = await review.execute(
      both,
      command({
        operationId: randomUUID(),
        action: "launch.config.save",
        target: projectId,
        reason: "Operator correction",
        payload: { expectedVersion: 1, config: draftInput },
      }),
    );
    expect(edited.result).toMatchObject({
      config_version: 2,
      edited_by_operator_id: both,
    });
    await expect(
      review.execute(both, approve(projectId, draft.configHash, 2)),
    ).rejects.toMatchObject({ code: "OPS_SELF_APPROVAL" });

    // The project owner holding approve rights still cannot approve.
    await pool.query(
      "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Owner', true)",
      [owner],
    );
    await pool.query(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*')",
      [owner],
    );
    await expect(
      review.execute(owner, approve(projectId, draft.configHash, 2)),
    ).rejects.toMatchObject({ code: "OPS_SELF_APPROVAL" });

    // Only the latest version is approvable.
    const independent = await operator(["launch.approve"]);
    await expect(
      review.execute(independent, approve(projectId, draft.configHash, 1)),
    ).rejects.toMatchObject({ code: "OPS_VERSION_CONFLICT" });
    await expect(
      review.execute(independent, approve(projectId, `0x${"0".repeat(64)}`, 2)),
    ).rejects.toMatchObject({ code: "OPS_VERSION_CONFLICT" });
    const approved = await review.execute(
      independent,
      approve(projectId, draft.configHash, 2),
    );
    expect(approved.replayed).toBe(false);
    await expect(
      pool.query(
        "delete from public.hooks_launch_config_approvals where project_id = $1",
        [projectId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses operator edits before the project itself is approved", async () => {
    const owner = await user();
    const projectId = await project(owner, "draft");
    const editor = await operator(["launch.edit"]);
    await expect(
      review.execute(
        editor,
        command({
          operationId: randomUUID(),
          action: "launch.config.save",
          target: projectId,
          reason: "Early edit",
          payload: { expectedVersion: 0, config: draftInput },
        }),
      ),
    ).rejects.toMatchObject({ code: "OPS_LAUNCH_NOT_APPROVED" });
  });

  it("applies the configured sale-start lead on the operator save path (Decision 0117)", async () => {
    const { projectId } = await ownerDraft();
    const editor = await operator(["launch.edit"]);
    const soon = {
      ...draftInput,
      nftSaleStartAt: String(1_800_000_000 + 5_000),
    };
    const save = (expectedVersion: number) =>
      command({
        operationId: randomUUID(),
        action: "launch.config.save",
        target: projectId,
        reason: "Testnet same-day sale",
        payload: { expectedVersion, config: soon },
      });
    // Default (86,400 s): a sale 5,000 s ahead is refused.
    await expect(review.execute(editor, save(1))).rejects.toMatchObject({
      code: "OPS_INVALID_LAUNCH_CONFIG",
    });
    const testnet = createPostgresHooksLaunchReviewRepository(pool, {
      now: () => 1_800_000_000,
      minimumLeadSeconds: 4_200,
    });
    const saved = await testnet.execute(editor, save(1));
    expect(saved.result).toMatchObject({ config_version: 2 });
    const tooSoon = {
      ...draftInput,
      nftSaleStartAt: String(1_800_000_000 + 4_199),
    };
    await expect(
      testnet.execute(
        editor,
        command({
          operationId: randomUUID(),
          action: "launch.config.save",
          target: projectId,
          reason: "Below the floor",
          payload: { expectedVersion: 2, config: tooSoon },
        }),
      ),
    ).rejects.toMatchObject({ code: "OPS_INVALID_LAUNCH_CONFIG" });
  });

  it("replays an identical operationId and rejects a changed one", async () => {
    const { projectId } = await ownerDraft();
    const approver = await operator(["launch.approve"]);
    const first = approve(projectId);
    const result = await review.execute(approver, first);
    const replay = await review.execute(approver, first);
    expect(replay).toMatchObject({
      operationId: result.operationId,
      replayed: true,
      result: { project_id: projectId, config_version: 1 },
    });
    expect(
      (
        await pool.query(
          "select 1 from public.hooks_launch_config_approvals where project_id = $1",
          [projectId],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      review.execute(approver, { ...first, reason: "Different reason" }),
    ).rejects.toMatchObject({ code: "OPS_IDEMPOTENCY_CONFLICT" });
  });

  it("records Testnet acceptance only for an approved config and not by its editor", async () => {
    const { owner, projectId } = await ownerDraft();
    const acceptor = await operator(["testnet.accept", "testnet.read"]);
    const acceptance = (operationId: string) =>
      command({
        operationId,
        action: "testnet.acceptance.record",
        target: projectId,
        reason: "Checklist run",
        payload: {
          configVersion: 1,
          configHash: draft.configHash,
          contractManifestHash: `0x${"44".repeat(32)}`,
          checklistVersion: "hooks-testnet-v1",
          outcome: "passed",
          evidence: [{ label: "deploy tx", uri: `0x${"55".repeat(32)}` }],
        },
      });
    await expect(
      review.execute(acceptor, acceptance(randomUUID())),
    ).rejects.toMatchObject({ code: "OPS_LAUNCH_CONFIG_NOT_APPROVED" });

    const approver = await operator(["launch.approve"]);
    await review.execute(approver, approve(projectId));

    await pool.query(
      "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Owner', true)",
      [owner],
    );
    await pool.query(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, 'testnet.accept', $2)",
      [owner, projectId],
    );
    await expect(
      review.execute(owner, acceptance(randomUUID())),
    ).rejects.toMatchObject({ code: "OPS_SELF_ACCEPTANCE" });

    const operationId = randomUUID();
    const recorded = await review.execute(acceptor, acceptance(operationId));
    expect(recorded.result).toMatchObject({
      acceptance_id: operationId,
      chain_id: 97,
      outcome: "passed",
    });
    const listed = await review.listTestnetAcceptances(acceptor);
    expect(
      listed.items.some((item) => item["acceptance_id"] === operationId),
    ).toBe(true);
  });

  it("lists projects with their latest config, approval, and task for launch.read", async () => {
    const input = await seed();
    await submissions.accept(input);
    const reader = await operator(["launch.read"], input.projectId);
    const page = await review.listProjects(reader);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      project_id: input.projectId,
      config_version: 1,
      deployment_status: "awaiting_executor",
    });
    expect(page.items[0]?.["config_approver_id"]).toEqual(expect.any(String));
    const session = await review.session(reader);
    expect(session.grants).toEqual([
      { permission: "launch.read", scope: input.projectId },
    ]);
  });
});

describe("Hooks signed deployment tasks (000054)", () => {
  it("reserves a wallet nonce across projects until cancellation", async () => {
    const first = await seed();
    const second = await seed();
    const shared = {
      ...second,
      request: { ...second.request, projectOwner: first.request.projectOwner },
    };
    const competing = {
      ...shared,
      signedPayload: { ...shared.signedPayload, request: shared.request },
    };
    const task = await submissions.accept(first);
    await expect(submissions.accept(competing)).rejects.toThrow();
    await submissions.cancelOwned(
      first.ownerUserId,
      first.projectId,
      task.jobId,
    );
    expect((await submissions.accept(competing)).status).toBe(
      "awaiting_executor",
    );
  });

  it("requires a current approved config and never saves unapproved work", async () => {
    const input = await seed(false);
    await expect(submissions.accept(input)).rejects.toMatchObject({
      kind: "not_approved",
    });
    expect(
      (
        await pool.query(
          "select job_id from public.hooks_launch_deployment_tasks where project_id = $1",
          [input.projectId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("invalidates an approval when the owner saves a newer draft", async () => {
    const input = await seed();
    await configs.saveOwnedDraft({
      projectId: input.projectId,
      ownerUserId: input.ownerUserId,
      expectedVersion: 1,
      templateVersion: draft.templateVersion,
      configHash: draft.configHash,
      config: draft,
      updatedByUserId: input.ownerUserId,
    });
    await expect(submissions.accept(input)).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("ten simultaneous identical submissions create one durable task and authorization", async () => {
    const input = await seed();
    const jobs = await Promise.all(
      Array.from({ length: 10 }, () => submissions.accept(input)),
    );
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
    expect(
      (
        await pool.query(
          "select job_id from public.hooks_launch_deployment_authorizations where job_id = $1",
          [jobs[0]!.jobId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      await submissions.getOwned(randomUUID(), input.projectId, jobs[0]!.jobId),
    ).toBeNull();
  });

  it("renews expired signing deadlines as new immutable authorizations on the same task", async () => {
    const input = await seed();
    const first = await submissions.accept(input);
    const request = { ...input.request, deadline: "1800001800" };
    const renewed = await submissions.accept({
      ...input,
      idempotencyKey: randomUUID(),
      fingerprint: `0x${"44".repeat(32)}`,
      request,
      signedPayload: { ...input.signedPayload, request },
    });
    expect(renewed.jobId).toBe(first.jobId);
    expect(
      (
        await pool.query(
          "select job_id from public.hooks_launch_deployment_authorizations where job_id = $1",
          [first.jobId],
        )
      ).rowCount,
    ).toBe(2);
    await expect(
      pool.query(
        "update public.hooks_launch_deployment_authorizations set fingerprint = $1 where job_id = $2",
        [`0x${"55".repeat(32)}`, first.jobId],
      ),
    ).rejects.toThrow();
  });

  it("rejects idempotency collisions, supports owner cancellation and releases the active reservation", async () => {
    const input = await seed();
    const first = await submissions.accept(input);
    await expect(
      submissions.accept({ ...input, fingerprint: `0x${"66".repeat(32)}` }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    expect(
      await submissions.cancelOwned(randomUUID(), input.projectId, first.jobId),
    ).toBeNull();
    expect(
      (
        await submissions.cancelOwned(
          input.ownerUserId,
          input.projectId,
          first.jobId,
        )
      )?.status,
    ).toBe("cancelled");
    expect(
      (
        await submissions.cancelOwned(
          input.ownerUserId,
          input.projectId,
          first.jobId,
        )
      )?.status,
    ).toBe("cancelled");
    await expect(
      pool.query(
        "update public.hooks_launch_deployment_tasks set status = 'awaiting_executor' where job_id = $1",
        [first.jobId],
      ),
    ).rejects.toThrow(/invalid deployment task mutation/);
    const next = await submissions.accept({
      ...input,
      idempotencyKey: randomUUID(),
    });
    expect(next.jobId).not.toBe(first.jobId);
  });
});
