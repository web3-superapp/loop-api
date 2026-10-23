import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchExecutorRepository } from "../src/database/hooks-launch-executor-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { recordLaunchDeployFailedNotification } from "../src/database/launch-review-inbox-repository.js";
import { createPostgresNotificationInboxRepository } from "../src/database/notification-inbox-repository.js";
import { createPostgresNotificationRepository } from "../src/database/notification-repository.js";
import { launchReviewInboxEventTypes } from "../src/features/alerts/notification-contract.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0178 on PostgreSQL: migration 000099, the four project-owner
 * launch progress rows (config approval, config / material rejection in the
 * review transaction; final executor failure in the executor's transition;
 * activation through the notification_inbox lane's marker), exactly-once
 * rows under replay / repeat, the LAUNCH_REVIEW_INBOX_EMIT-gated reads and
 * the push claim filter. The shared test database persists, so every
 * assertion is scoped to the rows this run creates.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const executor = createPostgresHooksLaunchExecutorRepository(pool, {
  leaseSeconds: 30,
});
const inbox = createPostgresNotificationInboxRepository(pool);
const notifications = createPostgresNotificationRepository(pool);
const chainId = "eip155:97";

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

function hex(bytes: number): string {
  let out = "";
  while (out.length < bytes * 2) out += randomUUID().replaceAll("-", "");
  return `0x${out.slice(0, bytes * 2)}`;
}

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:s291:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function reviewer(): Promise<string> {
  const id = await user();
  await pool.query(
    "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Reviewer', true)",
    [id],
  );
  await pool.query(
    "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*')",
    [id],
  );
  return id;
}

interface Project {
  readonly owner: string;
  readonly projectId: string;
  readonly name: string;
}

async function project(
  reviewStatus: "approved" | "submitted" = "approved",
): Promise<Project> {
  const owner = await user();
  const projectId = randomUUID();
  const name = `S291 ${projectId.slice(0, 8)}`;
  await pool.query(
    `insert into public.launch_projects (project_id, owner_user_id, name, ticker,
       review_status, submitted_at, reviewed_at)
     values ($1, $2, $3, 'MEME', $4, now(), case when $4 = 'approved' then now() end)`,
    [projectId, owner, name, reviewStatus],
  );
  if (reviewStatus === "approved") {
    await configs.saveOwnedDraft({
      projectId,
      ownerUserId: owner,
      expectedVersion: 0,
      templateVersion: draft.templateVersion,
      configHash: draft.configHash,
      config: draft,
      updatedByUserId: owner,
    });
  }
  return { owner, projectId, name };
}

function command(input: Record<string, unknown>) {
  return hooksLaunchReviewCommandSchema.parse({
    operationId: randomUUID(),
    reason: "Independent hash review",
    ...input,
  });
}

async function approve(target: Project, operator: string) {
  const approval = command({
    action: "launch.config.approve",
    target: target.projectId,
    payload: { configVersion: 1, configHash: draft.configHash },
  });
  await review.execute(operator, approval);
  return approval;
}

async function task(target: Project, factoryAddress: string) {
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
  const job = await submissions.accept({
    ownerUserId: target.owner,
    projectId: target.projectId,
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
    memeAddress: `${hex(18)}6666`,
    hookAddress: hex(20),
  });
  return job.jobId;
}

async function claimed(factoryAddress: string, executorId: string) {
  const leased = await executor.acquire({
    executorId,
    factoryAddress,
    maxAttempts: 3,
    retryDelaySeconds: 10,
    exclude: [],
  });
  expect(leased?.status).toBe("claimed");
  return leased!;
}

/** Drives one task claimed → … → activated through the executor port. */
async function activatedTask(target: Project): Promise<string> {
  const factory = hex(20);
  const jobId = await task(target, factory);
  const executorId = `s291-${randomUUID().slice(0, 8)}`;
  await claimed(factory, executorId);
  const executorAddress = hex(20);
  await executor.reserveAndRecord({
    jobId,
    executorId,
    executorAddress,
    purpose: "deploy",
    chainPendingNonce: 0n,
    sign: () => Promise.resolve({ txHash: hex(32), rawTx: "0x01" }),
  });
  const confirmed = await executor.transition({
    jobId,
    executorId,
    from: "broadcast",
    to: "confirmed",
    patch: { blockNumber: 10n, blockHash: hex(32), confirmations: 3 },
    event: { kind: "confirmed" },
  });
  expect(confirmed?.status).toBe("confirmed");
  const verified = await executor.transition({
    jobId,
    executorId,
    from: "confirmed",
    to: "verified",
    patch: {
      launchId: hex(32),
      deployedAddresses: { meme: `${hex(18)}6666` },
      verification: { ok: true },
    },
    event: { kind: "verified" },
  });
  expect(verified?.status).toBe("verified");
  await executor.reserveAndRecord({
    jobId,
    executorId,
    executorAddress,
    purpose: "activate",
    chainPendingNonce: 1n,
    sign: () => Promise.resolve({ txHash: hex(32), rawTx: "0x02" }),
  });
  const activated = await executor.transition({
    jobId,
    executorId,
    from: "verified",
    to: "activated",
    patch: {
      activationBlockNumber: 12n,
      activationBlockHash: hex(32),
      activatedAt: "now",
    },
    event: { kind: "activated" },
  });
  expect(activated?.status).toBe("activated");
  return jobId;
}

/** The launch2 lane's registry row of an activated task. */
async function instance(
  target: Project,
  jobId: string,
  input: { readonly saleStart: Date; readonly hidden?: boolean },
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number,
       deployed_event_seen, stage, factory_generation, price_e18
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, 'MEME', $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 1, true,
       'upcoming', 'v3', 1000000000000)`,
    [
      instanceId,
      jobId,
      target.projectId,
      target.owner,
      chainId,
      hex(20),
      hex(32),
      draft.configHash,
      hex(20),
      target.name,
      `${hex(18)}6666`,
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      draft.buybackRecipient,
      input.saleStart,
    ],
  );
  if (input.hidden === true) {
    await pool.query(
      `update public.launch2_instances set listing = 'hidden',
         listing_reason = 'test', listing_updated_at = now(),
         listing_updated_by = 'test'
       where instance_id = $1`,
      [instanceId],
    );
  }
  return instanceId;
}

async function drain(now = new Date()): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    const result = await inbox.produceLaunch2({
      now,
      freshnessSeconds: 86_400,
      graduationLimit: 20,
      mintLimit: 200,
    });
    if (!result.saturated) return;
  }
  throw new Error("notification inbox did not drain");
}

type Row = Record<string, unknown>;

async function rowsOf(ownerUserId: string): Promise<readonly Row[]> {
  const result = await pool.query<Row>(
    `select type, event_type, entity_ref, context_route, context_params,
       payload, dedupe_key, source, push_settled_at
     from public.notifications where owner_user_id = $1
     order by created_at, notification_id`,
    [ownerUserId],
  );
  return result.rows;
}

afterAll(async () => {
  await pool.end();
});

describe("Decision 0178 launch review inbox on PostgreSQL", () => {
  it("applies 000099: four more fine events, the activation marker and push types", async () => {
    const applied = await pool.query<Row>(
      "select name from public.pgmigrations where name = '000099_launch_review_inbox'",
    );
    expect(applied.rows).toHaveLength(1);
    const column = await pool.query<Row>(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'launch2_instances'
         and column_name = 'inbox_activation_settled_at'`,
    );
    expect(column.rows).toEqual([{ is_nullable: "YES" }]);
    const checks = await pool.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('notifications_event_type_check',
         'push_deliveries_event_type_check')
       order by conname`,
    );
    const [eventCheck, pushCheck] = [
      checks.rows.find((row) => row.conname.startsWith("notifications"))!,
      checks.rows.find((row) => row.conname.startsWith("push"))!,
    ];
    for (const eventType of [
      ...launchReviewInboxEventTypes,
      "launch.graduated",
      "social.friend_accepted",
    ]) {
      expect(eventCheck.def).toContain(`'${eventType}'`);
    }
    for (const pushType of [
      "launch_review_approved",
      "launch_review_rejected",
      "launch_activated",
      "launch_deploy_failed",
      "launch_graduated",
      "community_application_rejected",
    ]) {
      expect(pushCheck.def).toContain(`'${pushType}'`);
    }
    const index = await pool.query<Row>(
      "select indexname from pg_indexes where indexname = 'launch2_instances_inbox_activation_pending_idx'",
    );
    expect(index.rows).toHaveLength(1);
  });

  it("writes launch.review_approved in the approval transaction, once under replay", async () => {
    const target = await project();
    const operator = await reviewer();
    const approval = await approve(target, operator);
    const replay = await review.execute(operator, approval);
    expect(replay.replayed).toBe(true);
    const rows = await rowsOf(target.owner);
    expect(rows).toEqual([
      {
        type: "launch.round",
        event_type: "launch.review_approved",
        entity_ref: `launchProject:${target.projectId}`,
        context_route: "launch2-project-sign",
        context_params: { projectId: target.projectId },
        payload: {
          event: "launch.review_approved",
          title: `${target.name} 审核已通过`,
          body: "请完成签名，发射才会部署",
          projectName: target.name,
          symbol: "MEME",
          taskId: target.projectId,
          projectId: target.projectId,
          configVersion: "1",
        },
        dedupe_key: `launch.review_approved:${target.projectId}:v1`,
        source: "launch_review",
        push_settled_at: null,
      },
    ]);
    // The reviewer is not the recipient.
    expect(await rowsOf(operator)).toEqual([]);
  });

  it("writes launch.review_rejected for a config rejection with the reviewer's note", async () => {
    const target = await project();
    const operator = await reviewer();
    const rejection = command({
      action: "launch.config.reject",
      target: target.projectId,
      payload: {
        configVersion: 1,
        configHash: draft.configHash,
        reasonCode: "other",
        note: "回购地址需要换成多签",
      },
    });
    await review.execute(operator, rejection);
    await review.execute(operator, rejection);
    const rows = await rowsOf(target.owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "launch.round",
      event_type: "launch.review_rejected",
      context_route: "launch2-projects-mine",
      context_params: { projectId: target.projectId },
      payload: {
        title: `${target.name} 审核未通过`,
        body: "回购地址需要换成多签",
        reasonText: "回购地址需要换成多签",
        reasonCode: "other",
        taskId: target.projectId,
        configVersion: "1",
      },
      dedupe_key: `launch.review_rejected:${target.projectId}:config:v1`,
    });
  });

  it("writes launch.review_rejected for a material rejection with the reason text", async () => {
    const target = await project("submitted");
    const operator = await reviewer();
    const rejection = command({
      action: "launch.project.reject",
      target: target.projectId,
      payload: {
        materialVersion: 1,
        reasonCode: "name_or_ticker_conflict",
        note: null,
      },
    });
    await review.execute(operator, rejection);
    await review.execute(operator, rejection);
    const rows = await rowsOf(target.owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "launch.review_rejected",
      payload: {
        body: "项目名称或代币符号与已有项目冲突，修改后可以重新提交审核。",
        reasonText:
          "项目名称或代币符号与已有项目冲突，修改后可以重新提交审核。",
        reasonCode: "name_or_ticker_conflict",
      },
      dedupe_key: `launch.review_rejected:${target.projectId}:material:${rejection.operationId}`,
    });
    // A failed (rolled back) command writes nothing: the project is no
    // longer in review.
    await expect(
      review.execute(
        operator,
        command({
          action: "launch.project.reject",
          target: target.projectId,
          payload: {
            materialVersion: 1,
            reasonCode: "incomplete_materials",
            note: null,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "OPS_LAUNCH_NOT_IN_REVIEW" });
    expect(await rowsOf(target.owner)).toHaveLength(1);
  });

  it("writes launch.deploy_failed only for a final failure, once per task", async () => {
    const retryTarget = await project();
    const operator = await reviewer();
    await approve(retryTarget, operator);
    const retryFactory = hex(20);
    const retryJob = await task(retryTarget, retryFactory);
    await claimed(retryFactory, "s291-exec-retry");
    await executor.transition({
      jobId: retryJob,
      executorId: "s291-exec-retry",
      from: "claimed",
      to: "failed",
      patch: {
        failureCode: "HOOKS_EXECUTOR_FUNDS_INSUFFICIENT",
        failureRetryable: true,
      },
      event: { kind: "failed" },
    });
    // Retryable: still 重试中, only the approval row.
    expect(
      (await rowsOf(retryTarget.owner)).map((row) => row["event_type"]),
    ).toEqual(["launch.review_approved"]);

    const target = await project();
    await approve(target, operator);
    const factory = hex(20);
    const jobId = await task(target, factory);
    await claimed(factory, "s291-exec-final");
    const failed = await executor.transition({
      jobId,
      executorId: "s291-exec-final",
      from: "claimed",
      to: "failed",
      patch: {
        failureCode: "HOOKS_SIGNATURE_EXPIRED",
        failureRetryable: false,
      },
      event: { kind: "failed", errorCode: "HOOKS_SIGNATURE_EXPIRED" },
    });
    expect(failed?.status).toBe("failed");
    // A repeat of the writer (e.g. a re-run) is absorbed by the dedupe key.
    const client = await pool.connect();
    try {
      expect(
        await recordLaunchDeployFailedNotification(client, { jobId }),
      ).toBeNull();
    } finally {
      client.release();
    }
    const rows = await rowsOf(target.owner);
    expect(rows.map((row) => row["event_type"])).toEqual([
      "launch.review_approved",
      "launch.deploy_failed",
    ]);
    expect(rows[1]).toMatchObject({
      type: "launch.round",
      entity_ref: `launchProject:${target.projectId}`,
      context_route: "launch2-projects-mine",
      context_params: { projectId: target.projectId },
      payload: {
        title: "Project 部署失败",
        body: "签名已过期，请重新签名",
        taskId: target.projectId,
        jobId,
        failureCode: "HOOKS_SIGNATURE_EXPIRED",
      },
      dedupe_key: `launch.deploy_failed:${jobId}`,
      source: "hooks_launch_executor",
    });
  });

  it("writes launch.activated once per registered instance through the lane marker", async () => {
    const target = await project();
    const operator = await reviewer();
    await approve(target, operator);
    const jobId = await activatedTask(target);
    const saleStart = new Date(Date.now() + 2 * 86_400_000);
    const instanceId = await instance(target, jobId, { saleStart });
    await drain();
    await drain();
    const marker = await pool.query<Row>(
      "select inbox_activation_settled_at is not null as settled from public.launch2_instances where instance_id = $1",
      [instanceId],
    );
    expect(marker.rows).toEqual([{ settled: true }]);
    // Marker lost: the dedupe key still keeps one row.
    await pool.query(
      "update public.launch2_instances set inbox_activation_settled_at = null where instance_id = $1",
      [instanceId],
    );
    await drain();
    const rows = (await rowsOf(target.owner)).filter(
      (row) => row["event_type"] === "launch.activated",
    );
    expect(rows).toEqual([
      {
        type: "launch.round",
        event_type: "launch.activated",
        entity_ref: `launch2Instance:${instanceId}`,
        context_route: "launch2-instance",
        context_params: { instanceId },
        payload: expect.objectContaining({
          event: "launch.activated",
          title: `${target.name} 已上链`,
          body: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（北京时间）开售$/u,
          ) as unknown,
          projectName: target.name,
          symbol: "MEME",
          taskId: target.projectId,
          jobId,
          instanceId,
          saleStartAt: saleStart.toISOString(),
        }) as unknown,
        dedupe_key: `launch.activated:${instanceId}`,
        source: "launch2_indexer",
        push_settled_at: null,
      },
    ]);
  });

  it("only marks stale or hidden activations", async () => {
    const operator = await reviewer();
    const hiddenTarget = await project();
    await approve(hiddenTarget, operator);
    const hiddenJob = await activatedTask(hiddenTarget);
    const hiddenInstance = await instance(hiddenTarget, hiddenJob, {
      saleStart: new Date(Date.now() + 86_400_000),
      hidden: true,
    });
    await drain();

    const staleTarget = await project();
    await approve(staleTarget, operator);
    const staleJob = await activatedTask(staleTarget);
    const staleInstance = await instance(staleTarget, staleJob, {
      saleStart: new Date(Date.now() + 86_400_000),
    });
    // The lane first sees it two days after activation.
    await drain(new Date(Date.now() + 2 * 86_400_000));

    for (const [owner, id] of [
      [hiddenTarget.owner, hiddenInstance],
      [staleTarget.owner, staleInstance],
    ] as const) {
      expect(
        (await rowsOf(owner)).map((row) => row["event_type"]),
      ).not.toContain("launch.activated");
      const marker = await pool.query<Row>(
        "select inbox_activation_settled_at is not null as settled from public.launch2_instances where instance_id = $1",
        [id],
      );
      expect(marker.rows).toEqual([{ settled: true }]);
    }
  });

  it("gates every read by LAUNCH_REVIEW_INBOX_EMIT and claims pushes only for switched-on events", async () => {
    const target = await project();
    const operator = await reviewer();
    await approve(target, operator);
    const owner = target.owner;

    const hidden = await notifications.listFeed({
      ownerUserId: owner,
      limit: 25,
      includeInboxEvents: true,
    });
    expect(hidden.items).toEqual([]);
    expect(hidden.unreadCount).toBe(0);
    expect(
      await notifications.countUnread({
        ownerUserId: owner,
        includeInboxEvents: true,
      }),
    ).toBe(0);
    const [stored] = await pool
      .query<{ notification_id: string }>(
        "select notification_id::text from public.notifications where owner_user_id = $1",
        [owner],
      )
      .then((result) => result.rows);
    expect(
      await notifications.markRead(owner, stored!.notification_id, true),
    ).toBeNull();
    expect(
      await notifications.markAllRead({
        ownerUserId: owner,
        includeInboxEvents: true,
      }),
    ).toBe(0);

    const visible = await notifications.listFeed({
      ownerUserId: owner,
      limit: 25,
      includeLaunchReviewEvents: true,
    });
    expect(visible.items.map((item) => item.eventType)).toEqual([
      "launch.review_approved",
    ]);
    expect(visible.unreadCount).toBe(1);
    expect(
      await notifications.countUnread({
        ownerUserId: owner,
        includeInboxEvents: false,
        includeLaunchReviewEvents: true,
      }),
    ).toBe(1);

    // Push: the default (Decision 0177) claim leaves the row alone; a claim
    // naming the launch review events takes it, once.
    const now = new Date();
    await inbox.claimPushes({ now, freshnessSeconds: 1_800, limit: 100 });
    expect((await rowsOf(owner))[0]?.["push_settled_at"]).toBeNull();
    const claims = await inbox.claimPushes({
      now,
      freshnessSeconds: 1_800,
      limit: 100,
      eventTypes: launchReviewInboxEventTypes,
    });
    expect(claims.filter((claim) => claim.ownerUserId === owner)).toEqual([
      expect.objectContaining({
        eventType: "launch.review_approved",
        entityRef: `launchProject:${target.projectId}`,
        contextRoute: "launch2-project-sign",
        dedupeKey: `launch.review_approved:${target.projectId}:v1`,
      }),
    ]);
    const again = await inbox.claimPushes({
      now,
      freshnessSeconds: 1_800,
      limit: 100,
      eventTypes: launchReviewInboxEventTypes,
    });
    expect(again.filter((claim) => claim.ownerUserId === owner)).toEqual([]);

    expect(
      await notifications.markAllRead({
        ownerUserId: owner,
        includeInboxEvents: false,
        includeLaunchReviewEvents: true,
      }),
    ).toBe(1);
  });
});
