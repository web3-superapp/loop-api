import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresAdminRepository } from "../src/database/admin-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresSquareRepository } from "../src/database/square-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0163 on PostgreSQL (migration 000093): a new instance is
 * `visible`; the console hides it in one audited transaction; every list
 * read (instances, overview facts, activity, Square timeline / pinned)
 * drops it while the detail by id and the Square post by id still read it;
 * the indexer's re-registration and stage updates keep the operator's
 * choice; restoring brings it back. The shared test database persists, so
 * assertions are scoped to the rows this run creates.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const launch2 = createPostgresLaunch2Repository(pool);
const consoleRepository = createPostgresAdminRepository(pool);
const square = createPostgresSquareRepository(pool);
const chainId = "eip155:97";
const zeroAddress = "0x0000000000000000000000000000000000000000";

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

function hex(bytes: number): string {
  let out = "";
  while (out.length < bytes * 2) out += randomUUID().replaceAll("-", "");
  return `0x${out.slice(0, bytes * 2)}`;
}

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:s245:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

/** An activated MEME v2 instance, newest of the chain (activated "now"). */
async function instance(): Promise<{
  readonly instanceId: string;
  readonly jobId: string;
}> {
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
    "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Approver', true)",
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
    nonce: "7",
    memeSalt: `0x${"00".repeat(32)}`,
  };
  const memeAddress = `${hex(18)}6666`;
  const job = await submissions.accept({
    ownerUserId: owner,
    projectId,
    idempotencyKey: randomUUID(),
    fingerprint: hex(32),
    factoryAddress: "0x1111111111111111111111111111111111111111",
    request,
    signedPayload: {
      walletId: "test-wallet",
      request,
      hookSalt: `0x${"22".repeat(32)}`,
      signature: `0x${"33".repeat(65)}`,
    },
    memeAddress,
    hookAddress: hex(20),
  });
  const instanceId = randomUUID();
  // Activated far in the future so it sorts first among every run's rows.
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'S137 Testnet S13001',
       'S13001', $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
       now() - interval '30 days', 1, now() + interval '100 years', true,
       'public', 'v3')`,
    [
      instanceId,
      job.jobId,
      projectId,
      owner,
      chainId,
      "0x1111111111111111111111111111111111111111",
      hex(32),
      draft.configHash,
      request.projectOwner,
      memeAddress,
      zeroAddress,
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
    ],
  );
  return { instanceId, jobId: job.jobId };
}

const auditBase = {
  actor: "operator-s245",
  actorAccountId: null,
  action: "launch2.listing.update",
  targetType: "launch2_instance",
} as const;

async function listedIds(stage: "public" | null): Promise<string[]> {
  const rows = await launch2.listInstances({
    chainId,
    stage,
    after: null,
    limit: 50,
  });
  return rows.map((row) => row.instanceId);
}

async function systemPost(instanceId: string): Promise<string> {
  const postId = randomUUID();
  await pool.query(
    `insert into public.square_posts (post_id, kind, text, token_kind, token_id,
       status, published_at, created_by_actor)
     values ($1, 'system', 'Official note', 'launch2', $2, 'published',
       now() + interval '100 years', 'operator-s245')`,
    [postId, instanceId],
  );
  return postId;
}

async function pinnedPost(instanceId: string): Promise<string> {
  const postId = randomUUID();
  await pool.query(
    `insert into public.square_posts (post_id, kind, text, token_kind, token_id,
       status, published_at, created_by_actor, pinned)
     values ($1, 'system', 'Pinned note', 'launch2', $2, 'published',
       now() + interval '100 years', 'operator-s245', true)`,
    [postId, instanceId],
  );
  return postId;
}

/** A user opinion about the instance, by an active profile with a LOOP ID. */
async function opinionPost(instanceId: string): Promise<string> {
  const author = await user();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  await pool.query(
    "update public.loop_users set loop_id = coalesce(loop_id, $2) where id = $1",
    [author, `LOOP-${suffix}`],
  );
  await pool.query(
    `insert into public.user_profiles (owner_user_id, alias, profile_status,
       created_at, activated_at)
     values ($1, $2, 'active', clock_timestamp(), clock_timestamp())`,
    [author, `s245${suffix.toLowerCase()}`],
  );
  const postId = randomUUID();
  await pool.query(
    `insert into public.square_posts (post_id, kind, author_user_id, text,
       token_kind, token_id, status, published_at, create_idempotency_key,
       create_request_sha256)
     values ($1, 'opinion', $2, 'My take', 'launch2', $3, 'published',
       now() + interval '100 years', $4, $5)`,
    [postId, author, instanceId, randomUUID(), hex(32).slice(2)],
  );
  return postId;
}

/** A curve buy far in the future (tops the overview activity feed). */
async function curveBuy(instanceId: string, holder: string): Promise<void> {
  await pool.query(
    `insert into public.launch2_trades (trade_id, chain_id, transaction_hash,
       log_index, block_number, block_hash, instance_id, side, trader_address,
       meme_amount, usd1_gross, usd1_net, tax_usd1, refund_usd1,
       cumulative_bought, traded_at)
     values ($1, $2, $3, 0, 9999999999, $4, $5, 'buy', $6, 1000, 22, 20, 2, 0,
       1000, now() + interval '100 years')`,
    [randomUUID(), chainId, hex(32), hex(32), instanceId, holder],
  );
  await pool.query(
    `insert into public.launch2_positions (instance_id, holder_address,
       curve_bought, cumulative_bought, usd1_spent, buy_count, last_activity_at)
     values ($1, $2, 1000, 1000, 22, 1, now())`,
    [instanceId, holder],
  );
}

describe("Decision 0163: launch2 instance listing", () => {
  it("defaults to visible, hides from every list, keeps the detail, restores", async () => {
    const target = await instance();
    const { instanceId } = target;
    const viewer = randomUUID();
    const postId = await systemPost(instanceId);
    const pinnedId = await pinnedPost(instanceId);
    const opinionId = await opinionPost(instanceId);
    const holder = hex(20);
    await curveBuy(instanceId, holder);
    const pinned = async () =>
      (
        await square.listPinned({
          viewerUserId: viewer,
          limit: 50,
          now: new Date(),
        })
      ).map((row) => row.postId);
    const activity = async () =>
      (await launch2.listActivity({ chainId, limit: 30 })).map(
        (row) => row.instanceId,
      );
    const positions = async () =>
      (
        await launch2.listPositions({
          holderAddresses: [holder],
          instanceId: null,
        })
      ).map((row) => row.instanceId);
    const timeline = async () =>
      (
        await square.listTimeline({
          viewerUserId: viewer,
          scope: "global",
          before: null,
          limit: 50,
          now: new Date(),
        })
      ).map((row) => row.postId);

    expect((await launch2.getInstance(instanceId))?.listing).toBe("visible");
    expect(await listedIds(null)).toContain(instanceId);
    expect(await listedIds("public")).toContain(instanceId);
    expect(
      (await launch2.listOverviewFacts({ chainId })).map((f) => f.instanceId),
    ).toContain(instanceId);
    expect(await timeline()).toContain(postId);
    expect(await timeline()).toContain(opinionId);
    expect(await pinned()).toContain(pinnedId);
    expect(await activity()).toContain(instanceId);
    expect(await positions()).toEqual([instanceId]);

    const hidden = await consoleRepository.setLaunch2Listing({
      instanceId,
      listing: "hidden",
      reason: "Testnet acceptance project",
      audit: { ...auditBase, targetId: instanceId, requestId: randomUUID() },
    });
    expect(hidden.changed).toBe(true);
    expect(hidden.instance).toMatchObject({
      instanceId,
      listing: "hidden",
      listingReason: "Testnet acceptance project",
      listingUpdatedBy: "operator-s245",
      name: "S137 Testnet S13001",
    });
    expect(hidden.instance.listingUpdatedAt).not.toBeNull();
    const audit = await pool.query<{
      action: string;
      target_type: string;
      before: unknown;
      after: unknown;
    }>(
      "select action, target_type, before, after from public.admin_audit_log where audit_id = $1",
      [hidden.audit.auditId],
    );
    expect(audit.rows[0]).toEqual({
      action: "launch2.listing.update",
      target_type: "launch2_instance",
      before: { listing: "visible", reason: null },
      after: { listing: "hidden", reason: "Testnet acceptance project" },
    });

    expect(await listedIds(null)).not.toContain(instanceId);
    expect(await listedIds("public")).not.toContain(instanceId);
    expect(
      (await launch2.listOverviewFacts({ chainId })).map((f) => f.instanceId),
    ).not.toContain(instanceId);
    expect(await timeline()).not.toContain(postId);
    expect(await pinned()).not.toContain(pinnedId);
    expect(await activity()).not.toContain(instanceId);
    // The holder still sees the position; user opinions stay on the timeline.
    expect(await positions()).toEqual([instanceId]);
    expect(await timeline()).toContain(opinionId);
    // Direct reads stay.
    expect((await launch2.getInstance(instanceId))?.listing).toBe("hidden");
    expect(
      (
        await square.getFeedPost({
          viewerUserId: viewer,
          postId,
          now: new Date(),
        })
      )?.postId,
    ).toBe(postId);
    expect(
      (
        await consoleRepository.listLaunch2Instances({
          listing: "hidden",
          query: instanceId,
          limit: 10,
        })
      ).map((row) => row.instanceId),
    ).toEqual([instanceId]);

    // The indexer never overwrites the operator's choice.
    await launch2.registerActivatedInstances({
      chainId,
      factories: [
        {
          address: "0x1111111111111111111111111111111111111111",
          generation: "v3",
        },
      ],
    });
    await launch2.updateStages([
      { instanceId, stage: "graduated", nextChangeAt: null },
    ]);
    const after = await launch2.getInstance(instanceId);
    expect(after?.listing).toBe("hidden");
    expect(after?.stage).toBe("graduated");
    expect(
      (
        await launch2.listInstances({
          chainId,
          stage: "graduated",
          after: null,
          limit: 50,
        })
      ).map((row) => row.instanceId),
    ).not.toContain(instanceId);

    // Restore without a reason keeps the last one.
    const restored = await consoleRepository.setLaunch2Listing({
      instanceId,
      listing: "visible",
      reason: null,
      audit: { ...auditBase, targetId: instanceId, requestId: randomUUID() },
    });
    expect(restored).toMatchObject({
      changed: true,
      instance: {
        listing: "visible",
        listingReason: "Testnet acceptance project",
      },
    });
    expect(await listedIds(null)).toContain(instanceId);
    expect(await timeline()).toContain(postId);
    expect(await pinned()).toContain(pinnedId);
    expect(await activity()).toContain(instanceId);
  });

  it("refuses a hidden row without a reason and an unknown id", async () => {
    const { instanceId } = await instance();
    await expect(
      pool.query(
        "update public.launch2_instances set listing = 'hidden' where instance_id = $1",
        [instanceId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "update public.launch2_instances set listing = 'archived' where instance_id = $1",
        [instanceId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      consoleRepository.setLaunch2Listing({
        instanceId: randomUUID(),
        listing: "hidden",
        reason: "x",
        audit: { ...auditBase, targetId: null, requestId: randomUUID() },
      }),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_LAUNCH2_INSTANCE_NOT_FOUND" });
  });
});
