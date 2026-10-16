import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresHooksLaunchExecutorRepository } from "../src/database/hooks-launch-executor-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0112 on PostgreSQL (migration 000059): leases (one executor per
 * task, takeover after expiry), the transition guard, append-only events,
 * nonce reservations (no double reservation, released gaps reused),
 * retryable failures, cancellation refused after a claim, and the console
 * projection. Each test uses its own Factory address so leftover tasks of
 * other suites are never leased.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const executorRepository = createPostgresHooksLaunchExecutorRepository(pool, {
  leaseSeconds: 30,
});

afterAll(async () => {
  await pool.end();
});

const draft = parseHooksLaunchDraft(
  {
    name: "Project",
    ticker: "MEME",
    logoAssetUrl: "https://example.com/logo.png",
    description: "Test",
    links: [],
    nftSaleStartAt: "1900000000",
    buybackRecipient: "0x3333333333333333333333333333333333333333",
  },
  {
    nowUnixSeconds: "1800000000",
    minimumLeadSeconds: 86_400,
    nftSaleDurationSeconds: 604_800,
  },
);

const hex = (bytes: number) =>
  `0x${randomUUID()
    .replaceAll("-", "")
    .repeat(4)
    .slice(0, bytes * 2)}`;

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:hooks-s132-repo:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function task(
  factoryAddress = hex(20),
  submissionRepository = submissions,
) {
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
  const approver = await user();
  await pool.query(
    "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Reviewer', true)",
    [approver],
  );
  await pool.query(
    "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*')",
    [approver],
  );
  await review.execute(
    approver,
    hooksLaunchReviewCommandSchema.parse({
      operationId: randomUUID(),
      action: "launch.config.approve",
      target: projectId,
      reason: "Independent hash review",
      payload: { configVersion: 1, configHash: draft.configHash },
    }),
  );
  const request = {
    configHash: draft.configHash,
    projectOwner: hex(20),
    configVersion: 1,
    name: draft.name,
    ticker: draft.ticker,
    nftSaleStart: draft.nftSaleStartAt,
    buybackRecipient: draft.buybackRecipient,
    deadline: "1800000900",
    memeSalt: `0x${"00".repeat(32)}`,
    nonce: "0",
  };
  const job = await submissionRepository.accept({
    ownerUserId: owner,
    projectId,
    idempotencyKey: randomUUID(),
    fingerprint: hex(32),
    factoryAddress,
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
  return { owner, projectId, jobId: job.jobId, factoryAddress };
}

const acquire = (executorId: string, factoryAddress: string) =>
  executorRepository.acquire({
    executorId,
    factoryAddress,
    maxAttempts: 3,
    retryDelaySeconds: 10,
    exclude: [],
  });

async function events(jobId: string): Promise<string[]> {
  const result = await pool.query<{ kind: string }>(
    "select kind from public.hooks_launch_deployment_events where job_id = $1 order by event_id",
    [jobId],
  );
  return result.rows.map((row) => row.kind);
}

describe("Hooks executor repository (000059)", () => {
  it("leases each task to exactly one executor under concurrency", async () => {
    const factory = hex(20);
    const seeded = await Promise.all([task(factory), task(factory)]);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        acquire(`exec-${index}`, factory),
      ),
    );
    const claimed = claims.filter((claim) => claim !== null);
    expect(new Set(claimed.map((claim) => claim.jobId)).size).toBe(2);
    expect(claimed).toHaveLength(2);
    for (const { jobId } of seeded) {
      expect(await events(jobId)).toEqual(["created", "claimed"]);
    }
    // A live lease is not taken over; other Factories are never leased.
    expect(await acquire("exec-other", factory)).toBeNull();
    expect(await acquire("exec-other", hex(20))).toBeNull();
  });

  it("lets a new executor take over an expired lease and records it", async () => {
    const seeded = await task();
    const first = await acquire("exec-a", seeded.factoryAddress);
    expect(first?.status).toBe("claimed");
    await pool.query(
      "update public.hooks_launch_deployment_tasks set lease_expires_at = now() - interval '1 second' where job_id = $1",
      [seeded.jobId],
    );
    const taken = await acquire("exec-b", seeded.factoryAddress);
    expect(taken?.claimedBy).toBe("exec-b");
    expect(await events(seeded.jobId)).toEqual([
      "created",
      "claimed",
      "lease_taken_over",
    ]);
    // The old holder can no longer write.
    expect(
      await executorRepository.transition({
        jobId: seeded.jobId,
        executorId: "exec-a",
        from: "claimed",
        to: "failed",
        patch: { failureCode: "HOOKS_TX_DROPPED", failureRetryable: true },
        event: { kind: "failed" },
      }),
    ).toBeNull();
  });

  it("persists the signed transaction with a unique pending nonce before any send", async () => {
    const factory = hex(20);
    const [one, two] = await Promise.all([task(factory), task(factory)]);
    const leased = await acquire("exec-n", factory);
    await executorRepository.acquire({
      executorId: "exec-n",
      factoryAddress: factory,
      maxAttempts: 3,
      retryDelaySeconds: 10,
      exclude: [leased!.jobId],
    });
    const executorAddress = hex(20);
    const recorded = await Promise.all(
      [one, two].map((seeded) =>
        executorRepository.reserveAndRecord({
          jobId: seeded.jobId,
          executorId: "exec-n",
          executorAddress,
          purpose: "deploy",
          chainPendingNonce: 5n,
          sign: () => Promise.resolve({ txHash: hex(32), rawTx: "0x01" }),
        }),
      ),
    );
    expect(recorded.map((row) => row?.status)).toEqual([
      "broadcast",
      "broadcast",
    ]);
    expect(
      recorded.map((row) => row!.txNonce).sort((a, b) => Number(a! - b!)),
    ).toEqual([5n, 6n]);
    // Releasing nonce 5 lets the next reservation reuse it (no gap).
    await executorRepository.releaseReservation(
      recorded.find((row) => row!.txNonce === 5n)!.txHash!,
    );
    const third = await task(factory);
    await executorRepository.acquire({
      executorId: "exec-n",
      factoryAddress: factory,
      maxAttempts: 3,
      retryDelaySeconds: 10,
      exclude: [one.jobId, two.jobId],
    });
    const reused = await executorRepository.reserveAndRecord({
      jobId: third.jobId,
      executorId: "exec-n",
      executorAddress,
      purpose: "deploy",
      chainPendingNonce: 5n,
      sign: () => Promise.resolve({ txHash: hex(32), rawTx: "0x07" }),
    });
    expect(reused?.txNonce).toBe(5n);
    await expect(
      pool.query(
        "update public.hooks_launch_executor_nonces set nonce = 9 where job_id = $1",
        [third.jobId],
      ),
    ).rejects.toThrow(/invalid executor nonce reservation mutation/u);
    await expect(
      pool.query(
        "delete from public.hooks_launch_executor_nonces where job_id = $1",
        [third.jobId],
      ),
    ).rejects.toThrow(/retain audit history/u);
  });

  it("guards transitions, the transaction hash, and append-only events", async () => {
    const seeded = await task();
    await acquire("exec-g", seeded.factoryAddress);
    await expect(
      pool.query(
        "update public.hooks_launch_deployment_tasks set status = 'activated' where job_id = $1",
        [seeded.jobId],
      ),
    ).rejects.toThrow(/invalid deployment task mutation/u);
    await expect(
      pool.query(
        "update public.hooks_launch_deployment_tasks set project_owner = $2 where job_id = $1",
        [seeded.jobId, hex(20)],
      ),
    ).rejects.toThrow(/invalid deployment task mutation/u);
    await executorRepository.reserveAndRecord({
      jobId: seeded.jobId,
      executorId: "exec-g",
      executorAddress: hex(20),
      purpose: "deploy",
      chainPendingNonce: 0n,
      sign: () => Promise.resolve({ txHash: hex(32), rawTx: "0x01" }),
    });
    await expect(
      pool.query(
        "update public.hooks_launch_deployment_tasks set tx_hash = $2 where job_id = $1",
        [seeded.jobId, hex(32)],
      ),
    ).rejects.toThrow(/hash changes only when broadcast/u);
    await expect(
      pool.query(
        "update public.hooks_launch_deployment_events set kind = 'x' where job_id = $1",
        [seeded.jobId],
      ),
    ).rejects.toThrow(/append-only/u);
    // Non-retryable failure is final; retryable comes back after the delay.
    const failed = await executorRepository.transition({
      jobId: seeded.jobId,
      executorId: "exec-g",
      from: "broadcast",
      to: "failed",
      patch: { failureCode: "HOOKS_DEPLOY_REVERTED", failureRetryable: false },
      event: { kind: "failed", errorCode: "HOOKS_DEPLOY_REVERTED" },
    });
    expect(failed?.status).toBe("failed");
    await expect(
      pool.query(
        "update public.hooks_launch_deployment_tasks set status = 'claimed', failure_code = null, failure_retryable = null where job_id = $1",
        [seeded.jobId],
      ),
    ).rejects.toThrow(/not retryable/u);
    expect(await acquire("exec-g", seeded.factoryAddress)).toBeNull();
  });

  it("re-claims a retryable failure only after the retry delay", async () => {
    const seeded = await task();
    await acquire("exec-r", seeded.factoryAddress);
    await executorRepository.transition({
      jobId: seeded.jobId,
      executorId: "exec-r",
      from: "claimed",
      to: "failed",
      patch: {
        failureCode: "HOOKS_EXECUTOR_FUNDS_INSUFFICIENT",
        failureRetryable: true,
      },
      event: { kind: "failed" },
    });
    expect(await acquire("exec-r", seeded.factoryAddress)).toBeNull();
    // The guard stamps updated_at on every write; wait out a 1 s delay.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const again = await executorRepository.acquire({
      executorId: "exec-r",
      factoryAddress: seeded.factoryAddress,
      maxAttempts: 3,
      retryDelaySeconds: 1,
      exclude: [],
    });
    expect(again).toMatchObject({ status: "claimed", attemptCount: 2 });
    expect(await events(seeded.jobId)).toEqual([
      "created",
      "claimed",
      "failed",
      "retry_claimed",
    ]);
  });

  it("refuses owner cancellation once claimed and projects progress for the console", async () => {
    const seeded = await task();
    await acquire("exec-c", seeded.factoryAddress);
    await expect(
      submissions.cancelOwned(seeded.owner, seeded.projectId, seeded.jobId),
    ).rejects.toMatchObject({ kind: "not_cancellable" });
    const owned = await submissions.getOwned(
      seeded.owner,
      seeded.projectId,
      seeded.jobId,
    );
    expect(owned).toMatchObject({
      status: "claimed",
      txHash: null,
      attemptCount: 1,
      addresses: { deployed: null },
    });
    expect(owned?.events.map((event) => event.kind)).toEqual([
      "created",
      "claimed",
    ]);
    const detail = await createPostgresAdminLaunchReviewRepository(
      pool,
    ).getProject({ projectId: seeded.projectId, scope: "*" });
    expect(detail?.project.stage).toBe("deploying");
    expect(detail?.project.activeDeploymentJobId).toBe(seeded.jobId);
    expect(detail?.deploymentTasks[0]).toMatchObject({
      status: "claimed",
      claimedBy: "exec-c",
      attemptCount: 1,
      events: [
        expect.objectContaining({ kind: "created", actor: null }),
        expect.objectContaining({ kind: "claimed", actor: "exec-c" }),
      ],
    });
  });
});

describe("Decision 0150 chain-56 launch slot (000089)", () => {
  const mainnetSubmissions = createPostgresHooksLaunchSubmissionRepository(
    pool,
    { chainReference: 56 },
  );
  const mainnetExecutor = createPostgresHooksLaunchExecutorRepository(pool, {
    leaseSeconds: 30,
    chainReference: 56,
  });

  it("records chain-56 tasks and nonces, and never mixes them with chain 97", async () => {
    const factory = hex(20);
    const mainnet = await task(factory, mainnetSubmissions);
    const testnet = await task(factory);
    const rows = await pool.query<{ job_id: string; chain_id: number }>(
      "select job_id, chain_id from public.hooks_launch_deployment_tasks where job_id = any($1::uuid[])",
      [[mainnet.jobId, testnet.jobId]],
    );
    expect(
      Object.fromEntries(rows.rows.map((row) => [row.job_id, row.chain_id])),
    ).toEqual({ [mainnet.jobId]: 56, [testnet.jobId]: 97 });
    expect(
      (
        await mainnetSubmissions.getOwned(
          mainnet.owner,
          mainnet.projectId,
          mainnet.jobId,
        )
      )?.chainId,
    ).toBe(56);
    // Each slot leases only its own chain's task.
    const leased56 = await mainnetExecutor.acquire({
      executorId: "exec-56",
      factoryAddress: factory,
      maxAttempts: 3,
      retryDelaySeconds: 10,
      exclude: [],
    });
    expect(leased56?.jobId).toBe(mainnet.jobId);
    expect(leased56?.chainId).toBe(56);
    expect(
      await mainnetExecutor.acquire({
        executorId: "exec-56",
        factoryAddress: factory,
        maxAttempts: 3,
        retryDelaySeconds: 10,
        exclude: [mainnet.jobId],
      }),
    ).toBeNull();
    expect((await acquire("exec-97", factory))?.jobId).toBe(testnet.jobId);
    // Nonces are reserved per chain: the same account starts at 0 on both.
    const executorAddress = hex(20);
    const sent56 = await mainnetExecutor.reserveAndRecord({
      jobId: mainnet.jobId,
      executorId: "exec-56",
      executorAddress,
      purpose: "deploy",
      chainPendingNonce: 0n,
      sign: () => Promise.resolve({ txHash: hex(32), rawTx: "0x56" }),
    });
    const sent97 = await executorRepository.reserveAndRecord({
      jobId: testnet.jobId,
      executorId: "exec-97",
      executorAddress,
      purpose: "deploy",
      chainPendingNonce: 0n,
      sign: () => Promise.resolve({ txHash: hex(32), rawTx: "0x97" }),
    });
    expect([sent56?.txNonce, sent97?.txNonce]).toEqual([0n, 0n]);
    const nonces = await pool.query<{ chain_id: number }>(
      "select chain_id from public.hooks_launch_executor_nonces where job_id = $1",
      [mainnet.jobId],
    );
    expect(nonces.rows).toEqual([{ chain_id: 56 }]);
  });

  it("still refuses any chain other than 56 and 97", async () => {
    // The update guard trigger fires first on an existing row, so read the
    // constraint definitions themselves.
    const checks = await pool.query<{ table: string; definition: string }>(
      `select conrelid::regclass::text as table, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname in ('hooks_launch_deployment_tasks_chain_id_check',
                          'hooks_launch_executor_nonces_chain_id_check')
        order by 1`,
    );
    expect(checks.rows).toEqual([
      {
        table: "hooks_launch_deployment_tasks",
        definition: "CHECK ((chain_id = ANY (ARRAY[56, 97])))",
      },
      {
        table: "hooks_launch_executor_nonces",
        definition: "CHECK ((chain_id = ANY (ARRAY[56, 97])))",
      },
    ]);
  });
});
