import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import type { AcceptHooksLaunchSubmission } from "../src/features/launch/hooks-launch-submission.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const repo = createPostgresHooksLaunchSubmissionRepository(pool);
afterAll(async () => pool.end());
async function seed(approved = true): Promise<AcceptHooksLaunchSubmission> {
  const owner = (
    await pool.query<{ id: string }>(
      "insert into loop_users(privy_user_id) values($1) returning id",
      [`did:privy:signed-task-test:${randomUUID()}`],
    )
  ).rows[0]!.id;
  const projectId = randomUUID();
  await pool.query(
    "insert into launch_projects(project_id,owner_user_id,name,ticker) values($1,$2,'Project','MEME')",
    [projectId, owner],
  );
  const config = parseHooksLaunchDraft(
    {
      name: "Project",
      ticker: "MEME",
      logoAssetUrl: "https://example.com/logo.png",
      description: "Test",
      links: [],
      nftSaleStartAt: "1900000000",
      buybackRecipient: "0x3333333333333333333333333333333333333333",
    },
    { nowUnixSeconds: "1800000000", minimumLeadSeconds: 86400 },
  );
  await pool.query(
    "insert into hooks_launch_project_config_versions(project_id,config_version,owner_user_id,template_version,config_hash,config) values($1,1,$2,$3,$4,$5::jsonb)",
    [
      projectId,
      owner,
      config.templateVersion,
      config.configHash,
      JSON.stringify(config),
    ],
  );
  if (approved) {
    await pool.query(
      "insert into ops_operators(user_id,label,enabled) values($1,'Test reviewer',true)",
      [owner],
    );
    await pool.query(
      "insert into hooks_launch_config_approvals(project_id,config_version,config_hash,approver_id,reason) values($1,1,$2,$3,'Repository test fixture')",
      [projectId, config.configHash, owner],
    );
  }
  const projectOwner = `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
  const request = {
    configHash: config.configHash,
    projectOwner,
    configVersion: 1,
    name: config.name,
    ticker: config.ticker,
    nftSaleStart: config.nftSaleStartAt,
    buybackRecipient: config.buybackRecipient,
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
describe("signed task durability and concurrency", () => {
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
    const task = await repo.accept(first);
    await expect(repo.accept(competing)).rejects.toThrow();
    await repo.cancelOwned(first.ownerUserId, first.projectId, task.jobId);
    expect((await repo.accept(competing)).status).toBe("awaiting_executor");
  });

  it("requires current approved config and never saves unapproved work", async () => {
    const input = await seed(false);
    await expect(repo.accept(input)).rejects.toMatchObject({
      kind: "not_approved",
    });
    expect(
      (
        await pool.query(
          "select job_id from hooks_launch_deployment_tasks where project_id=$1",
          [input.projectId],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("ten simultaneous identical submissions create one durable task and authorization", async () => {
    const input = await seed();
    const jobs = await Promise.all(
      Array.from({ length: 10 }, () => repo.accept(input)),
    );
    expect(new Set(jobs.map((x) => x.jobId)).size).toBe(1);
    expect(
      (
        await pool.query(
          "select job_id from hooks_launch_deployment_authorizations where job_id=$1",
          [jobs[0]!.jobId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      await repo.getOwned(randomUUID(), input.projectId, jobs[0]!.jobId),
    ).toBeNull();
  });
  it("renews expired signing deadlines as new immutable authorizations on the same task", async () => {
    const input = await seed();
    const first = await repo.accept(input);
    const request = { ...input.request, deadline: "1800001800" };
    const renewed = await repo.accept({
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
          "select job_id from hooks_launch_deployment_authorizations where job_id=$1",
          [first.jobId],
        )
      ).rowCount,
    ).toBe(2);
    await expect(
      pool.query(
        "update hooks_launch_deployment_authorizations set fingerprint=$1 where job_id=$2",
        [`0x${"55".repeat(32)}`, first.jobId],
      ),
    ).rejects.toThrow();
  });
  it("rejects idempotency collisions, supports owner cancellation and releases the active reservation", async () => {
    const input = await seed();
    const first = await repo.accept(input);
    await expect(
      repo.accept({ ...input, fingerprint: `0x${"66".repeat(32)}` }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(
      await repo.cancelOwned(randomUUID(), input.projectId, first.jobId),
    ).toBeNull();
    expect(
      (await repo.cancelOwned(input.ownerUserId, input.projectId, first.jobId))
        ?.status,
    ).toBe("cancelled");
    expect(
      (await repo.cancelOwned(input.ownerUserId, input.projectId, first.jobId))
        ?.status,
    ).toBe("cancelled");
    const next = await repo.accept({ ...input, idempotencyKey: randomUUID() });
    expect(next.jobId).not.toBe(first.jobId);
  });
});
