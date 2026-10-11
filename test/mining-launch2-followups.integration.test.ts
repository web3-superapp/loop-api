import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import { createPostgresLaunch2MemeAssetRepository } from "../src/database/launch2-meme-asset-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import {
  HooksLaunchReviewError,
  hooksLaunchReviewCommandSchema,
} from "../src/features/launch/hooks-launch-review.js";
import { launchCommandDigest } from "../src/features/launch/launch-contract.js";
import { LaunchCommunityNotOwnedError } from "../src/features/launch/launch-repository.js";
import { registerPendingLaunch2MemeAssets } from "../src/features/launch2/launch2-meme-assets.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0125 (migration 000069) on PostgreSQL: the launch2 MEME enters
 * the Asset Registry with the project's community binding (S138 D1), MEME
 * ERC-20 transfers and their one-time coverage feed post-graduation
 * balances, catalog material approval from the console, and
 * launch_projects.community_id ownership.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
  launchChainId: "eip155:97",
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const launch = createPostgresLaunchRepository(pool);
const launch2 = createPostgresLaunch2Repository(pool);
const memeAssets = createPostgresLaunch2MemeAssetRepository(pool);
const settlement = createPostgresMiningSettlementRepository(pool);
const admin = createPostgresAdminLaunchReviewRepository(pool);
const chainId = "eip155:97";
const zero = "0x0000000000000000000000000000000000000000";

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
    [`did:privy:s148:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function operator(permission = "launch.approve"): Promise<string> {
  const id = await user();
  await pool.query(
    "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Reviewer', true)",
    [id],
  );
  await pool.query(
    "insert into public.ops_grants (user_id, permission, scope) values ($1, $2, '*')",
    [id, permission],
  );
  return id;
}

/** A community owned by `owner` (active owner membership). */
async function community(
  owner: string,
  boundAssetKey: string | null = null,
): Promise<string> {
  const slug = `s148-${randomUUID().slice(0, 8)}`;
  const created = await pool.query<{ community_id: string }>(
    `insert into public.communities (name, slug, bound_asset_key, created_by_user_id)
     values ($1, $2, $3, $4) returning community_id`,
    [`Frogs ${slug.slice(5)}`, slug, boundAssetKey, owner],
  );
  const communityId = created.rows[0]!.community_id;
  await pool.query(
    `insert into public.community_memberships (community_id, owner_user_id, role, status)
     values ($1, $2, 'owner', 'active')`,
    [communityId, owner],
  );
  return communityId;
}

const links = { website: null, x: null, telegram: null, discord: null };

/**
 * An activated MEME v2 instance (deployed event seen) whose project names
 * `communityId`.
 */
async function instance(
  options: {
    readonly owner?: string;
    readonly communityId?: string | null;
    readonly deployedEventSeen?: boolean;
  } = {},
): Promise<{
  readonly owner: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly meme: string;
  readonly assetId: string;
}> {
  const owner = options.owner ?? (await user());
  const projectId = randomUUID();
  await pool.query(
    `insert into public.launch_projects (project_id, owner_user_id, name, ticker,
       review_status, submitted_at, reviewed_at, kind, community_id)
     values ($1, $2, 'Project', 'MEME', 'approved', now(), now(), 'launch2', $3)`,
    [projectId, owner, options.communityId ?? null],
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
  await review.execute(
    await operator(),
    hooksLaunchReviewCommandSchema.parse({
      operationId: randomUUID(),
      action: "launch.config.approve",
      target: projectId,
      reason: "Independent hash review",
      payload: { configVersion: 1, configHash: draft.configHash },
    }),
  );
  const projectOwner = hex(20);
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
  const meme = `${hex(18)}6666`;
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
    memeAddress: meme,
    hookAddress: hex(20),
  });
  const instanceId = randomUUID();
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'Project', 'MEME', $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
       now() - interval '30 days', 100, now() - interval '31 days', $22,
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
      projectOwner,
      meme,
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
      options.deployedEventSeen ?? true,
    ],
  );
  return {
    owner,
    projectId,
    instanceId,
    meme,
    assetId: `${chainId}:${meme}`,
  };
}

const identity = {
  symbol: "FROG",
  name: "Frog Coin",
  decimals: 18,
  blockNumber: 136_000_123n,
};

async function pendingFor(instanceId: string) {
  return (await memeAssets.listPendingMemeAssets(chainId)).find(
    (entry) => entry.instanceId === instanceId,
  );
}

describe("Decision 0125: launch2 MEME → Asset Registry + community binding (S138 D1)", () => {
  it("registers the MEME like asset:register and binds the owner's unbound community once, audited", async () => {
    const owner = await user();
    const communityId = await community(owner);
    const target = await instance({ owner, communityId });
    const notDeployed = await instance({ deployedEventSeen: false });
    expect(await pendingFor(target.instanceId)).toEqual({
      instanceId: target.instanceId,
      chainId,
      memeAddress: target.meme,
      assetRegistered: false,
    });
    // LaunchDeployed not indexed yet: not pending.
    expect(await pendingFor(notDeployed.instanceId)).toBeUndefined();

    const outcome = await memeAssets.registerMemeAsset({
      instanceId: target.instanceId,
      identity,
    });
    expect(outcome).toEqual({
      assetId: target.assetId,
      inserted: true,
      communityBinding: "bound",
    });
    const asset = await pool.query(
      `select asset_id, chain_id, address, symbol, name, decimals, status,
         source_kind, source_block_number::text, source_verified_at is not null as verified
       from public.assets where asset_id = $1`,
      [target.assetId],
    );
    expect(asset.rows[0]).toEqual({
      asset_id: target.assetId,
      chain_id: chainId,
      address: target.meme,
      symbol: "FROG",
      name: "Frog Coin",
      decimals: 18,
      status: "pending",
      source_kind: "chain_call",
      source_block_number: "136000123",
      verified: true,
    });
    const bound = await pool.query(
      "select bound_asset_key, record_version from public.communities where community_id = $1",
      [communityId],
    );
    expect(bound.rows[0]).toEqual({
      bound_asset_key: target.assetId,
      record_version: 2,
    });
    const audit = await pool.query(
      `select actor_type, actor_user_id, target_user_id, event_type, reason_code
       from public.community_role_events where community_id = $1`,
      [communityId],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: "operator",
        actor_user_id: null,
        target_user_id: owner,
        event_type: "community_profile_updated",
        reason_code: "launch2_asset_auto_bound",
      },
    ]);
    // Done: no longer pending; a second call changes nothing.
    expect(await pendingFor(target.instanceId)).toBeUndefined();
    expect(
      await memeAssets.registerMemeAsset({
        instanceId: target.instanceId,
        identity,
      }),
    ).toEqual({
      assetId: target.assetId,
      inserted: false,
      communityBinding: null,
    });

    // The admin projection shows the community and the binding outcome.
    const detail = await admin.getProject({
      projectId: target.projectId,
      scope: "*",
    });
    expect(detail?.project.communityId).toBe(communityId);
    expect(detail?.project.community).toMatchObject({
      communityId,
      boundAssetKey: target.assetId,
      binding: "bound",
    });
  });

  it("never overwrites a community bound elsewhere, a fixture registry row, or binds for a non-owner", async () => {
    const owner = await user();
    const elsewhere = `${chainId}:${hex(20)}`;
    const taken = await community(owner, elsewhere);
    const conflict = await instance({ owner, communityId: taken });
    // A row written by hand before (S138 SQL fixture): kept as it is.
    await pool.query(
      `insert into public.assets (asset_id, chain_id, address, symbol, name,
         decimals, status, source_kind, source_block_number, source_verified_at)
       values ($1, $2, $3, 'FIX', 'Fixture', 18, 'pending', 'chain_call', 1, now())`,
      [conflict.assetId, chainId, conflict.meme],
    );
    expect(await pendingFor(conflict.instanceId)).toMatchObject({
      assetRegistered: true,
    });
    expect(
      await memeAssets.registerMemeAsset({
        instanceId: conflict.instanceId,
        identity: null,
      }),
    ).toMatchObject({ inserted: false, communityBinding: "conflict" });
    const kept = await pool.query(
      "select symbol from public.assets where asset_id = $1",
      [conflict.assetId],
    );
    expect(kept.rows[0]).toEqual({ symbol: "FIX" });
    const still = await pool.query(
      "select bound_asset_key from public.communities where community_id = $1",
      [taken],
    );
    expect(still.rows[0]).toEqual({ bound_asset_key: elsewhere });

    // The project owner lost the community: not bound.
    const otherOwner = await user();
    const foreign = await community(otherOwner);
    const notOwner = await instance({ communityId: foreign });
    expect(
      await memeAssets.registerMemeAsset({
        instanceId: notOwner.instanceId,
        identity,
      }),
    ).toMatchObject({ inserted: true, communityBinding: "not_owner" });

    // No community named.
    const none = await instance();
    expect(
      await memeAssets.registerMemeAsset({
        instanceId: none.instanceId,
        identity,
      }),
    ).toMatchObject({ communityBinding: "none" });

    // A blocked registry row is never bound.
    const blockedOwner = await user();
    const blockedCommunity = await community(blockedOwner);
    const blocked = await instance({
      owner: blockedOwner,
      communityId: blockedCommunity,
    });
    await pool.query(
      `insert into public.assets (asset_id, chain_id, address, symbol, name,
         decimals, status, source_kind, source_block_number, source_verified_at)
       values ($1, $2, $3, 'BAD', 'Blocked', 18, 'blocked', 'operator_block', null, null)`,
      [blocked.assetId, chainId, blocked.meme],
    );
    expect(
      await memeAssets.registerMemeAsset({
        instanceId: blocked.instanceId,
        identity: null,
      }),
    ).toMatchObject({ communityBinding: "asset_blocked" });

    await expect(
      pool.query(
        "update public.launch2_instances set community_binding = 'maybe' where instance_id = $1",
        [none.instanceId],
      ),
    ).rejects.toThrow(/launch2_instances_community_binding_check/u);
  });

  it("the lane helper catches up instances deployed before 0125 without manual SQL", async () => {
    const owner = await user();
    const communityId = await community(owner);
    const old = await instance({ owner, communityId });
    const result = await registerPendingLaunch2MemeAssets({
      repository: memeAssets,
      reader: {
        readTokenIdentity: () => Promise.resolve(identity),
      },
      chainId,
    });
    expect(result.registered).toBeGreaterThanOrEqual(1);
    expect(await pendingFor(old.instanceId)).toBeUndefined();
    const row = await pool.query(
      "select community_binding from public.launch2_instances where instance_id = $1",
      [old.instanceId],
    );
    expect(row.rows[0]).toEqual({ community_binding: "bound" });
  });
});

describe("Decision 0125: MEME ERC-20 transfers and post-graduation balances", () => {
  it("stores transfers, tracks the one-time coverage, rewinds them on a reorg, and feeds the asset track after graduation", async () => {
    const target = await instance();
    const holderA = hex(20);
    const holderB = hex(20);
    const lane = (await launch2.listLaneInstances(chainId)).find(
      (entry) => entry.instanceId === target.instanceId,
    );
    expect(lane?.memeTransfersTargetBlock).toBeNull();
    // Hour 10:00–11:00; graduation at 10:30; coverage target block 300.
    const hour = BigInt(Date.parse("2030-01-01T10:00:00.000Z") / 1000);
    const transfer = (
      from: string,
      to: string,
      amount: string,
      block: number,
      at: bigint,
    ) => ({
      instanceId: target.instanceId,
      from,
      to,
      amount,
      transactionHash: hex(32),
      logIndex: 0,
      blockNumber: String(block),
      blockHash: hex(32),
      at: at.toString(10),
    });
    const segment = (
      lastBlockNumber: string,
      memeTransfers: ReturnType<typeof transfer>[],
      extra: Record<string, unknown> = {},
    ) =>
      launch2.commitSegment({
        chainId,
        events: [],
        checkpoint: {
          lastBlockNumber,
          lastBlockHash: hex(32),
          startedFromBlockNumber: "1",
        },
        activationGraceBlocks: 15,
        memeTransfers,
        ...extra,
      });
    await segment(
      "200",
      [
        transfer(zero, holderA, "1000", 150, hour - 3_600n),
        transfer(holderA, holderB, "400", 190, hour + 2_700n),
      ],
      {
        memeTransferCoverage: {
          instanceIds: [target.instanceId],
          targetBlockNumber: "300",
        },
      },
    );
    const coverage = async () =>
      (
        await pool.query<{ target: string | null; complete: boolean }>(
          `select meme_transfers_target_block::text as target,
             meme_transfers_complete_at is not null as complete
           from public.launch2_instances where instance_id = $1`,
          [target.instanceId],
        )
      ).rows[0];
    expect(await coverage()).toEqual({ target: "300", complete: false });
    // Coverage is set once.
    await segment("250", [], {
      memeTransferCoverage: {
        instanceIds: [target.instanceId],
        targetBlockNumber: "999",
      },
    });
    expect(await coverage()).toEqual({ target: "300", complete: false });
    await segment("300", []);
    expect(await coverage()).toEqual({ target: "300", complete: true });

    // A reorg from block 190 marks the later transfer removed.
    const rewound = transfer(holderB, holderA, "1", 400, hour + 3_000n);
    await segment("400", [rewound]);
    await segment("405", [], { rewindFromBlockNumber: "400" });
    const removed = await pool.query(
      "select removed from public.launch2_meme_transfers where transaction_hash = $1",
      [rewound.transactionHash],
    );
    expect(removed.rows[0]).toEqual({ removed: true });

    // Graduate at 10:30 (coverage completed before the hour ended).
    await pool.query(
      `update public.launch2_instances set graduated_at = to_timestamp($2),
         official_pool_id = $3, meme_transfers_complete_at = to_timestamp($4)
       where instance_id = $1`,
      [target.instanceId, Number(hour + 1_800n), hex(32), Number(hour - 60n)],
    );
    const facts = await settlement.readSettlementFacts({
      chainId,
      hourStart: hour,
      hourEnd: hour + 3_600n,
      assetIds: [target.assetId],
    });
    const asset = facts.assets.find(
      (entry) => entry.assetId === target.assetId,
    );
    expect(asset?.postGraduation).toEqual({
      from: hour + 1_800n,
      openingBalances: [{ address: holderA, balanceRaw: 1_000n }],
      moves: [
        { address: holderA, deltaRaw: -400n, at: hour + 2_700n },
        { address: holderB, deltaRaw: 400n, at: hour + 2_700n },
      ],
    });
    // Coverage completed after the hour ended: the hour keeps its 0123 shape.
    await pool.query(
      "update public.launch2_instances set meme_transfers_complete_at = to_timestamp($2) where instance_id = $1",
      [target.instanceId, Number(hour + 3_600n)],
    );
    const before = await settlement.readSettlementFacts({
      chainId,
      hourStart: hour,
      hourEnd: hour + 3_600n,
      assetIds: [target.assetId],
    });
    expect(
      before.assets.find((entry) => entry.assetId === target.assetId)
        ?.postGraduation,
    ).toBeNull();
  });
});

describe("Decision 0125: catalog material approval and community ownership", () => {
  async function submitted(owner: string): Promise<string> {
    const created = await launch.createProject({
      ownerUserId: owner,
      kind: "launch2",
      idempotencyKey: randomUUID(),
      requestSha256: launchCommandDigest("createProject", [randomUUID()]),
      requestId: randomUUID(),
      values: {
        name: "Frog",
        ticker: "FROG",
        narrative: null,
        officialLinks: links,
      },
    });
    await pool.query(
      "update public.launch_projects set review_status = 'submitted', submitted_at = now() where project_id = $1",
      [created.projectId],
    );
    return created.projectId;
  }

  const approve = (
    actor: string,
    projectId: string,
    materialVersion: number,
    operationId = randomUUID(),
  ) =>
    review.execute(
      actor,
      hooksLaunchReviewCommandSchema.parse({
        operationId,
        action: "launch.project.approve",
        target: projectId,
        reason: "Material complete",
        payload: { materialVersion },
      }),
    );

  it("approves submitted material once at its version, creates the launch, and replays the key", async () => {
    const owner = await user();
    const projectId = await submitted(owner);
    const reviewer = await operator();
    const ownerOperator = owner;
    await pool.query(
      "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Owner', true)",
      [ownerOperator],
    );
    await pool.query(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*')",
      [ownerOperator],
    );
    await expect(approve(ownerOperator, projectId, 1)).rejects.toMatchObject({
      code: "OPS_SELF_APPROVAL",
    });
    await expect(approve(reviewer, projectId, 2)).rejects.toMatchObject({
      code: "OPS_VERSION_CONFLICT",
    });
    const editor = await operator("launch.edit");
    await expect(approve(editor, projectId, 1)).rejects.toMatchObject({
      code: "OPS_FORBIDDEN",
    });
    const key = randomUUID();
    const result = await approve(reviewer, projectId, 1, key);
    expect(result.replayed).toBe(false);
    expect(result.result).toMatchObject({
      approval_id: key,
      project_id: projectId,
      material_version: 1,
      reviewer_user_id: reviewer,
      reason: "Material complete",
    });
    const launchId = (result.result as { launch_id: string }).launch_id;
    expect(launchId).toMatch(/^[0-9a-f-]{36}$/u);
    const project = await launch.getProject(projectId);
    expect(project).toMatchObject({
      reviewStatus: "approved",
      reviewReasonCode: "operator_manual_review",
      launchId,
    });
    const launchRow = await pool.query(
      "select chain_id, schedule_status from public.launches where launch_id = $1",
      [launchId],
    );
    expect(launchRow.rows[0]).toEqual({
      chain_id: "eip155:97",
      schedule_status: "unscheduled",
    });
    const events = await pool.query(
      `select actor_type, event_type, from_status, to_status, reason_code
       from public.launch_review_events where project_id = $1
       order by occurred_at desc limit 1`,
      [projectId],
    );
    expect(events.rows[0]).toEqual({
      actor_type: "operator",
      event_type: "project_approved",
      from_status: "submitted",
      to_status: "approved",
      reason_code: "operator_manual_review",
    });
    expect((await approve(reviewer, projectId, 1, key)).replayed).toBe(true);
    await expect(approve(reviewer, projectId, 1)).rejects.toBeInstanceOf(
      HooksLaunchReviewError,
    );
    await expect(approve(reviewer, projectId, 1)).rejects.toMatchObject({
      code: "OPS_LAUNCH_NOT_IN_REVIEW",
    });
    const summary = (
      await admin.listProjects({
        stage: null,
        kind: "launch2",
        scope: "*",
        limit: 100,
        after: null,
      })
    ).find((row) => row.projectId === projectId);
    expect(summary?.materialApproval).toMatchObject({
      approverUserId: reviewer,
      materialVersion: 1,
    });
    // A material version is approved or rejected, never both.
    await expect(
      pool.query(
        `insert into public.launch_project_rejections (rejection_id, project_id,
           material_version, reason_code, note, reviewer_user_id)
         values ($1, $2, 1, 'other', 'late', $3)`,
        [randomUUID(), projectId, reviewer],
      ),
    ).rejects.toThrow(/already decided/u);
  });

  it("stores a community only for its active owner and keeps it on a replace that omits it", async () => {
    const owner = await user();
    const own = await community(owner);
    const foreign = await community(await user());
    const create = (communityId: string | null) =>
      launch.createProject({
        ownerUserId: owner,
        kind: "launch2",
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("createProject", [randomUUID()]),
        requestId: randomUUID(),
        values: {
          name: "Frog",
          ticker: "FROG",
          narrative: null,
          officialLinks: links,
          communityId,
        },
      });
    await expect(create(foreign)).rejects.toBeInstanceOf(
      LaunchCommunityNotOwnedError,
    );
    await expect(create(randomUUID())).rejects.toBeInstanceOf(
      LaunchCommunityNotOwnedError,
    );
    const created = await create(own);
    expect(created.communityId).toBe(own);
    const kept = await launch.replaceProject({
      ownerUserId: owner,
      projectId: created.projectId,
      expectedVersion: created.version,
      requestId: randomUUID(),
      values: {
        name: "Frog 2",
        ticker: "FROG",
        narrative: null,
        officialLinks: links,
      },
    });
    expect(kept.communityId).toBe(own);
    await expect(
      launch.replaceProject({
        ownerUserId: owner,
        projectId: created.projectId,
        expectedVersion: kept.version,
        requestId: randomUUID(),
        values: {
          name: "Frog 3",
          ticker: "FROG",
          narrative: null,
          officialLinks: links,
          communityId: foreign,
        },
      }),
    ).rejects.toBeInstanceOf(LaunchCommunityNotOwnedError);
    const cleared = await launch.replaceProject({
      ownerUserId: owner,
      projectId: created.projectId,
      expectedVersion: kept.version,
      requestId: randomUUID(),
      values: {
        name: "Frog 3",
        ticker: "FROG",
        narrative: null,
        officialLinks: links,
        communityId: null,
      },
    });
    expect(cleared.communityId).toBeNull();
  });
});
