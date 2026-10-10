import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresLaunch2PublicationRepository } from "../src/database/launch2-snapshot-publication-repository.js";
import { type AdminLaunchSnapshotRetryError } from "../src/features/admin/admin-launch-review.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { launchCommandDigest } from "../src/features/launch/launch-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0120 (migration 000064): launch_projects.kind (create, back-fill
 * trigger, list filter), the no-holder closure (stage closed_no_holders,
 * publisher candidates, read model), and the platform administrator's
 * snapshot retry grant (append-only, budget release).
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const launch = createPostgresLaunchRepository(pool);
const launch2 = createPostgresLaunch2Repository(pool);
const publications = createPostgresLaunch2PublicationRepository(pool);
const admin = createPostgresAdminLaunchReviewRepository(pool);
const chainId = "eip155:97";

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
    [`did:privy:s142:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

/**
 * An activated MEME v2 instance on BSC Testnet with a sale already over.
 * Decision 0122: closures only happen on the v2 generation (default).
 */
async function instance(generation: "v2" | "v3" = "v2"): Promise<{
  readonly projectId: string;
  readonly instanceId: string;
  readonly snapshots: string;
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
  const snapshots = hex(20);
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
       now() - interval '30 days', 1, now() - interval '31 days', true,
       'snapshot_pending', $22)`,
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
      memeAddress,
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      snapshots,
      hex(20),
      hex(20),
      hex(20),
      hex(20),
      draft.buybackRecipient,
      generation,
    ],
  );
  return { projectId, instanceId, snapshots };
}

async function failedAttempt(
  target: { readonly instanceId: string; readonly snapshots: string },
  attempt: number,
  status: "failed" | "mismatch",
  retryable = false,
) {
  const pending = await publications.insertPending({
    instanceId: target.instanceId,
    chainId,
    attempt,
    snapshots: target.snapshots,
    cutoffBlock: "100",
    cutoffBlockHash: hex(32),
    saleEndAt: new Date().toISOString(),
    members: ["0x00"],
    root: hex(32),
    dataHash: hex(32),
    signerAddresses: [hex(20), hex(20)],
    signatures: [hex(65), hex(65)],
    submitterAddress: hex(20),
  });
  expect(pending).not.toBeNull();
  return publications.transition({
    publicationId: pending!.publicationId,
    from: "pending",
    to: status,
    failure: {
      code: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
      detail: null,
      retryable: status === "failed" ? retryable : null,
    },
  });
}

async function candidate(instanceId: string) {
  return (await publications.listCandidates(chainId)).find(
    (entry) => entry.instanceId === instanceId,
  );
}

function grant(projectId: string, releaseId = randomUUID()) {
  return {
    releaseId,
    projectId,
    actor: "operator",
    actorAccountId: null,
    reason: "Signer key rotated",
    requestId: randomUUID(),
  };
}

describe("Decision 0120: launch_projects.kind (000064)", () => {
  it("creates with a kind, filters the owner list, and refuses an unknown kind", async () => {
    const owner = await user();
    const create = (kind: "ido" | "launch2", ticker: string) =>
      launch.createProject({
        ownerUserId: owner,
        kind,
        idempotencyKey: randomUUID(),
        requestSha256: launchCommandDigest("createProject", [ticker]),
        requestId: randomUUID(),
        values: {
          name: `Project ${ticker}`,
          ticker,
          narrative: null,
          officialLinks: {
            website: null,
            x: null,
            telegram: null,
            discord: null,
          },
        },
      });
    const ido = await create("ido", "IDOK");
    const v2 = await create("launch2", "VTWO");
    expect(ido.kind).toBe("ido");
    expect(v2.kind).toBe("launch2");
    const list = (kind: "ido" | "launch2" | null) =>
      launch.listProjects({
        ownerUserId: owner,
        status: null,
        kind,
        limit: 10,
        after: null,
      });
    expect((await list("launch2")).map((row) => row.projectId)).toEqual([
      v2.projectId,
    ]);
    expect((await list("ido")).map((row) => row.projectId)).toEqual([
      ido.projectId,
    ]);
    expect(await list(null)).toHaveLength(2);
    await expect(
      pool.query(
        "update public.launch_projects set kind = 'perp' where project_id = $1",
        [ido.projectId],
      ),
    ).rejects.toThrow(/launch_projects_kind_check/u);
  });
});

describe("Decision 0120: no-holder closure (000064)", () => {
  it("records one immutable closure; the instance leaves the publisher and reads closed_no_holders", async () => {
    const target = await instance();
    expect(await candidate(target.instanceId)).toBeDefined();
    const input = {
      instanceId: target.instanceId,
      chainId,
      snapshots: target.snapshots.toUpperCase().replace("0X", "0x"),
      saleEndAt: new Date().toISOString(),
      cutoffBlock: "123",
      cutoffBlockHash: hex(32),
    };
    expect(await publications.recordNoHoldersClosure(input)).toBe(true);
    expect(await publications.recordNoHoldersClosure(input)).toBe(false);
    expect(await candidate(target.instanceId)).toBeUndefined();

    const record = await launch2.getInstance(target.instanceId);
    expect(record?.noHoldersClosure).toMatchObject({ cutoffBlock: "123" });
    const lane = (await launch2.listLaneInstances(chainId)).find(
      (entry) => entry.instanceId === target.instanceId,
    );
    expect(lane?.closedNoHolders).toBe(true);
    expect(
      await launch2.updateStages([
        {
          instanceId: target.instanceId,
          stage: "closed_no_holders",
          nextChangeAt: null,
        },
      ]),
    ).toBe(1);

    await expect(
      pool.query(
        "update public.launch2_snapshot_closures set cutoff_block = 1 where instance_id = $1",
        [target.instanceId],
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(
      pool.query(
        "delete from public.launch2_snapshot_closures where instance_id = $1",
        [target.instanceId],
      ),
    ).rejects.toThrow(/append-only/u);

    // A closed instance cannot be released for another attempt.
    await expect(
      admin.releaseSnapshotPublication(grant(target.projectId)),
    ).rejects.toMatchObject({
      reasonCode: "LAUNCH2_SNAPSHOT_CLOSED_NO_HOLDERS",
    });
    const detail = await admin.getProject({
      projectId: target.projectId,
      scope: "*",
    });
    expect(detail?.snapshotClosure).toMatchObject({
      instanceId: target.instanceId,
      reason: "no_holders",
      cutoffBlock: "123",
    });
  });
});

describe("Decision 0120: snapshot retry grant (000064)", () => {
  it("refuses with nothing to retry, releases a blocked attempt once, and replays the key", async () => {
    const target = await instance();
    await expect(
      admin.releaseSnapshotPublication(grant(target.projectId)),
    ).rejects.toMatchObject({
      kind: "conflict",
      reasonCode: "LAUNCH2_SNAPSHOT_NOTHING_TO_RETRY",
    });
    await expect(
      admin.releaseSnapshotPublication(grant(randomUUID())),
    ).rejects.toMatchObject({
      kind: "not_found",
      reasonCode: "ADMIN_LAUNCH_PROJECT_NOT_FOUND",
    });

    await failedAttempt(target, 1, "mismatch");
    expect(await candidate(target.instanceId)).toMatchObject({
      lastAttempt: 1,
      blockingCode: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
    });

    const key = randomUUID();
    const released = await admin.releaseSnapshotPublication(
      grant(target.projectId, key),
    );
    expect(released).toMatchObject({
      replayed: false,
      release: {
        releaseId: key,
        instanceId: target.instanceId,
        releasedAttempt: 1,
        releasedStatus: "mismatch",
        releasedFailureCode: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
      },
    });
    // The publisher no longer sees the block; its next attempt is 2.
    expect(await candidate(target.instanceId)).toMatchObject({
      lastAttempt: 1,
      blockingCode: null,
      retryableFailures: 0,
      lastFailedAt: null,
    });
    expect(
      await admin.releaseSnapshotPublication(grant(target.projectId, key)),
    ).toMatchObject({ replayed: true, release: { releaseId: key } });
    await expect(
      admin.releaseSnapshotPublication({
        ...grant(target.projectId, key),
        reason: "Other reason",
      }),
    ).rejects.toMatchObject({ kind: "idempotency" });
    await expect(
      admin.releaseSnapshotPublication(grant(target.projectId)),
    ).rejects.toMatchObject({
      reasonCode: "LAUNCH2_SNAPSHOT_ALREADY_RELEASED",
    });

    // Retryable failures after the grant count again; three exhaust the
    // budget, and one grant clears all of them.
    for (const attempt of [2, 3, 4]) {
      await failedAttempt(target, attempt, "failed", true);
    }
    expect(await candidate(target.instanceId)).toMatchObject({
      lastAttempt: 4,
      retryableFailures: 3,
      blockingCode: null,
    });
    const second = await admin.releaseSnapshotPublication(
      grant(target.projectId),
    );
    expect(second.release).toMatchObject({
      releasedAttempt: 4,
      releasedStatus: "failed",
    });
    expect(await candidate(target.instanceId)).toMatchObject({
      lastAttempt: 4,
      retryableFailures: 0,
    });

    // An in-flight attempt is not retryable.
    const pending = await publications.insertPending({
      instanceId: target.instanceId,
      chainId,
      attempt: 5,
      snapshots: target.snapshots,
      cutoffBlock: "100",
      cutoffBlockHash: hex(32),
      saleEndAt: new Date().toISOString(),
      members: ["0x00"],
      root: hex(32),
      dataHash: hex(32),
      signerAddresses: [hex(20), hex(20)],
      signatures: [hex(65), hex(65)],
      submitterAddress: hex(20),
    });
    expect(pending).not.toBeNull();
    await expect(
      admin.releaseSnapshotPublication(grant(target.projectId)),
    ).rejects.toMatchObject({
      reasonCode: "LAUNCH2_SNAPSHOT_NOT_RETRYABLE",
      details: { status: "pending" },
    });

    const detail = await admin.getProject({
      projectId: target.projectId,
      scope: "*",
    });
    expect(detail?.snapshotReleases.map((row) => row.releasedAttempt)).toEqual([
      4, 1,
    ]);
    expect(detail?.snapshotClosure).toBeNull();

    await expect(
      pool.query(
        "delete from public.launch2_snapshot_publication_releases where release_id = $1",
        [key],
      ),
    ).rejects.toThrow(/append-only/u);
  });

  it("lets exactly one of two concurrent grants for the same attempt win", async () => {
    const target = await instance();
    await failedAttempt(target, 1, "failed", false);
    const results = await Promise.allSettled([
      admin.releaseSnapshotPublication(grant(target.projectId)),
      admin.releaseSnapshotPublication(grant(target.projectId)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(
      (rejected as PromiseRejectedResult)
        .reason as AdminLaunchSnapshotRetryError,
    ).toMatchObject({ reasonCode: "LAUNCH2_SNAPSHOT_ALREADY_RELEASED" });
  });
});

// ---------------------------------------------------------------------------
// Decision 0122 (migration 000066)
// ---------------------------------------------------------------------------

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

function laneEvent(
  instanceId: string,
  eventName: "PublicRoundOpenedWithoutHolders" | "BuybackCompleted",
  contractAddress: string,
  args: Record<string, string>,
  blockNumber: string,
) {
  return {
    instanceId,
    contractAddress,
    eventName,
    args,
    transactionHash: hex(32),
    logIndex: 0,
    blockNumber,
    blockHash: hex(32),
    at: "1800000000",
  } as const;
}

async function commit(events: readonly ReturnType<typeof laneEvent>[]) {
  const checkpoint = await launch2.getCheckpoint(chainId);
  const last = BigInt(checkpoint?.lastBlockNumber ?? "0") + 10n;
  return launch2.commitSegment({
    chainId,
    events,
    checkpoint: {
      lastBlockNumber: last.toString(10),
      lastBlockHash: hex(32),
      startedFromBlockNumber: "1",
    },
    activationGraceBlocks: 15,
  });
}

describe("Decision 0122: v3 generation facts (000066)", () => {
  it("indexes a zero-holder opening as public, never with a snapshot, and only on v3", async () => {
    const target = await instance("v3");
    await commit([
      laneEvent(
        target.instanceId,
        "PublicRoundOpenedWithoutHolders",
        target.snapshots,
        { launchId: hex(32), openedAt: "1800000000", openedBlock: "500" },
        "500",
      ),
    ]);
    const record = await launch2.getInstance(target.instanceId);
    expect(record?.generation).toBe("v3");
    expect(record?.snapshot).toBeNull();
    expect(record?.openedWithoutHolders).toMatchObject({
      openedAt: new Date(1_800_000_000_000).toISOString(),
      blockNumber: "500",
    });
    const lane = (await launch2.listLaneInstances(chainId)).find(
      (entry) => entry.instanceId === target.instanceId,
    );
    expect(lane).toMatchObject({
      generation: "v3",
      openedWithoutHoldersAt: new Date(1_800_000_000_000).toISOString(),
    });
    // The publisher leaves an opened instance alone.
    expect(await candidate(target.instanceId)).toBeUndefined();
    // …and a retry grant is refused like for a published root.
    await expect(
      admin.releaseSnapshotPublication(grant(target.projectId)),
    ).rejects.toMatchObject({
      reasonCode: "LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN",
    });

    // The same fact on a v2 instance is never projected (its registry has
    // no such function), and the shape constraint backs that up.
    const legacy = await instance("v2");
    await commit([
      laneEvent(
        legacy.instanceId,
        "PublicRoundOpenedWithoutHolders",
        legacy.snapshots,
        { launchId: hex(32), openedAt: "1800000000", openedBlock: "501" },
        "501",
      ),
    ]);
    expect(
      (await launch2.getInstance(legacy.instanceId))?.openedWithoutHolders,
    ).toBeNull();
    await expect(
      pool.query(
        `update public.launch2_instances set opened_without_holders_at = now(),
           opened_without_holders_block = 1, opened_without_holders_tx = $2
         where instance_id = $1`,
        [legacy.instanceId, hex(32)],
      ),
    ).rejects.toThrow(/launch2_instances_opened_without_holders_shape/u);
    await expect(
      pool.query(
        "update public.launch2_instances set factory_generation = 'v9' where instance_id = $1",
        [legacy.instanceId],
      ),
    ).rejects.toThrow(/launch2_instances_factory_generation_check/u);
  });

  it("stores a v3 BuybackCompleted without protection fields and a v2 one with all three", async () => {
    const v3 = await instance("v3");
    const v2 = await instance("v2");
    const executor = hex(20);
    await commit([
      laneEvent(
        v3.instanceId,
        "BuybackCompleted",
        executor,
        {
          usd1Spent: (100n * 10n ** 18n).toString(),
          memeDelivered: "5",
          successfulAt: "1800000000",
        },
        "600",
      ),
      laneEvent(
        v2.instanceId,
        "BuybackCompleted",
        executor,
        {
          usd1Spent: (100n * 10n ** 18n).toString(),
          memeDelivered: "5",
          minMemeOut: "4",
          referencePrice: "7",
          spotPrice: "8",
          successfulAt: "1800000000",
        },
        "601",
      ),
    ]);
    const [fresh] = await launch2.listBuybacks({
      instanceId: v3.instanceId,
      after: null,
      limit: 5,
    });
    expect(fresh).toMatchObject({
      minMemeOut: null,
      referencePriceE18: null,
      spotPriceE18: null,
    });
    const [old] = await launch2.listBuybacks({
      instanceId: v2.instanceId,
      after: null,
      limit: 5,
    });
    expect(old).toMatchObject({
      minMemeOut: "4",
      referencePriceE18: "7",
      spotPriceE18: "8",
    });
    expect((await launch2.getInstance(v3.instanceId))?.buyback.count).toBe("1");
    await expect(
      pool.query(
        "update public.launch2_buybacks set min_meme_out = 1 where instance_id = $1",
        [v3.instanceId],
      ),
    ).rejects.toThrow(/launch2_buybacks_protection_shape/u);
  });

  it("records an open_without_holders attempt with no members or signatures, and refuses mixed shapes", async () => {
    const target = await instance("v3");
    const zero = `0x${"00".repeat(32)}`;
    const opening = await publications.insertPending({
      action: "open_without_holders",
      instanceId: target.instanceId,
      chainId,
      attempt: 1,
      snapshots: target.snapshots,
      cutoffBlock: "100",
      cutoffBlockHash: hex(32),
      saleEndAt: new Date().toISOString(),
      members: [],
      root: zero,
      dataHash: zero,
      signerAddresses: [],
      signatures: [],
      submitterAddress: hex(20),
    });
    expect(opening).toMatchObject({
      action: "open_without_holders",
      status: "pending",
      memberCount: 0,
    });
    expect((await candidate(target.instanceId))?.active).toMatchObject({
      action: "open_without_holders",
    });
    // The App's publication field stays the snapshot publication only.
    expect(
      (await launch2.getInstance(target.instanceId))?.snapshotPublication,
    ).toBeNull();
    const detail = await admin.getProject({
      projectId: target.projectId,
      scope: "*",
    });
    expect(detail?.snapshotPublications[0]).toMatchObject({
      action: "open_without_holders",
      memberCount: 0,
      signerAddresses: [],
    });
    const other = await instance("v3");
    for (const bad of [
      // An opening may not carry members or a root.
      `insert into public.launch2_snapshot_publications (publication_id,
         instance_id, chain_id, attempt, snapshots_address, cutoff_block,
         cutoff_block_hash, sale_end_at, members, member_count, root, data_hash,
         signer_addresses, signatures, submitter_address, action)
       values (gen_random_uuid(), $1, '${chainId}', 1, $2, 1, '${hex(32)}', now(),
         '["0x01"]', 1, '${zero}', '${zero}', '[]', '[]', '${hex(20)}',
         'open_without_holders')`,
      // A publication still needs members and two signatures.
      `insert into public.launch2_snapshot_publications (publication_id,
         instance_id, chain_id, attempt, snapshots_address, cutoff_block,
         cutoff_block_hash, sale_end_at, members, member_count, root, data_hash,
         signer_addresses, signatures, submitter_address)
       values (gen_random_uuid(), $1, '${chainId}', 1, $2, 1, '${hex(32)}', now(),
         '[]', 0, '${zero}', '${zero}', '[]', '[]', '${hex(20)}')`,
    ]) {
      await expect(
        pool.query(bad, [other.instanceId, other.snapshots]),
      ).rejects.toThrow(/launch2_snapshot_publication_action_shape/u);
    }
  });
});

describe("Decision 0122: review rejections (000066)", () => {
  it("rejects a config version once with a reason the owner reads; the owner resubmits with a new version", async () => {
    const owner = await user();
    const projectId = randomUUID();
    await pool.query(
      "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project', 'REJC', 'approved', now(), now())",
      [projectId, owner],
    );
    const save = (expectedVersion: number) =>
      configs.saveOwnedDraft({
        projectId,
        ownerUserId: owner,
        expectedVersion,
        templateVersion: draft.templateVersion,
        configHash: draft.configHash,
        config: draft,
        updatedByUserId: owner,
      });
    await save(0);
    const reviewerId = await reviewer();
    const reject = (
      payload: Record<string, unknown>,
      actor = reviewerId,
      operationId = randomUUID(),
    ) =>
      review.execute(
        actor,
        hooksLaunchReviewCommandSchema.parse({
          operationId,
          action: "launch.config.reject",
          target: projectId,
          reason: "buyback_recipient_invalid",
          payload: {
            configVersion: 1,
            configHash: draft.configHash,
            reasonCode: "buyback_recipient_invalid",
            note: "Use the platform recipient",
            ...payload,
          },
        }),
      );
    // The owner (also an operator with the grant) can never reject.
    await pool.query(
      "insert into public.ops_operators (user_id, label, enabled) values ($1, 'Owner', true)",
      [owner],
    );
    await pool.query(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*')",
      [owner],
    );
    await expect(reject({}, owner)).rejects.toMatchObject({
      code: "OPS_SELF_APPROVAL",
    });
    await expect(
      reject({ configHash: `0x${"ee".repeat(32)}` }),
    ).rejects.toMatchObject({ code: "OPS_VERSION_CONFLICT" });
    const rejected = await reject({});
    expect(rejected.result).toMatchObject({
      config_version: 1,
      reviewer_id: reviewerId,
      reason_code: "buyback_recipient_invalid",
      note: "Use the platform recipient",
    });
    // Decided once: neither approve nor reject again.
    await expect(reject({})).rejects.toMatchObject({
      code: "OPS_LAUNCH_CONFIG_DECIDED",
    });
    await expect(
      review.execute(
        reviewerId,
        hooksLaunchReviewCommandSchema.parse({
          operationId: randomUUID(),
          action: "launch.config.approve",
          target: projectId,
          reason: "Looks fine now",
          payload: { configVersion: 1, configHash: draft.configHash },
        }),
      ),
    ).rejects.toMatchObject({ code: "OPS_LAUNCH_CONFIG_DECIDED" });
    // Trigger backstop: a direct approval insert is refused too.
    await expect(
      pool.query(
        "insert into public.hooks_launch_config_approvals (project_id, config_version, config_hash, approver_id, reason) values ($1, 1, $2, $3, 'direct')",
        [projectId, draft.configHash, reviewerId],
      ),
    ).rejects.toThrow(/already rejected/u);
    await expect(
      pool.query(
        "delete from public.hooks_launch_config_rejections where project_id = $1",
        [projectId],
      ),
    ).rejects.toThrow(/append-only/u);

    // The owner reads the rejection…
    const progress = await configs.getOwnedProgress({
      projectId,
      ownerUserId: owner,
      configVersion: 1,
    });
    expect(progress).toMatchObject({
      approvedAt: null,
      rejection: {
        reasonCode: "buyback_recipient_invalid",
        note: "Use the platform recipient",
      },
    });
    // …and the console shows the stage and the version's rejection.
    const summary = (
      await admin.listProjects({
        stage: "rejected",
        kind: "launch2",
        scope: "*",
        limit: 100,
        after: null,
      })
    ).find((row) => row.projectId === projectId);
    expect(summary).toMatchObject({
      kind: "launch2",
      stage: "rejected",
      latestRejection: { reviewerUserId: reviewerId },
    });
    expect(
      (
        await admin.listProjects({
          stage: "rejected",
          kind: "ido",
          scope: "*",
          limit: 100,
          after: null,
        })
      ).some((row) => row.projectId === projectId),
    ).toBe(false);
    const detail = await admin.getProject({ projectId, scope: "*" });
    expect(detail?.versions[0]?.rejection).toMatchObject({
      reviewerUserId: reviewerId,
      reasonCode: "buyback_recipient_invalid",
    });

    // Resubmission = a new version, awaiting approval again.
    await save(1);
    expect(
      await configs.getOwnedProgress({
        projectId,
        ownerUserId: owner,
        configVersion: 2,
      }),
    ).toMatchObject({ approvedAt: null, rejection: null });
    expect(
      (await admin.getProject({ projectId, scope: "*" }))?.project.stage,
    ).toBe("awaiting_approval");
  });

  it("rejects submitted catalog material; the applicant reads it, edits (version + 1) and resubmits", async () => {
    const owner = await user();
    const created = await launch.createProject({
      ownerUserId: owner,
      kind: "launch2",
      idempotencyKey: randomUUID(),
      requestSha256: launchCommandDigest("createProject", ["RJCT"]),
      requestId: randomUUID(),
      values: {
        name: "Reject Me",
        ticker: "RJCT",
        narrative: null,
        officialLinks: {
          website: null,
          x: null,
          telegram: null,
          discord: null,
        },
      },
    });
    const projectId = created.projectId;
    const reviewerId = await reviewer();
    const rejectProject = (payload: Record<string, unknown>) =>
      review.execute(
        reviewerId,
        hooksLaunchReviewCommandSchema.parse({
          operationId: randomUUID(),
          action: "launch.project.reject",
          target: projectId,
          reason: "other",
          payload: {
            materialVersion: 1,
            reasonCode: "other",
            note: "The logo is someone else's",
            ...payload,
          },
        }),
      );
    // A draft is not in review.
    await expect(rejectProject({})).rejects.toMatchObject({
      code: "OPS_LAUNCH_NOT_IN_REVIEW",
    });
    await launch.submitProject({
      ownerUserId: owner,
      projectId,
      idempotencyKey: randomUUID(),
      requestSha256: launchCommandDigest("submitProject", [projectId]),
      requestId: randomUUID(),
    });
    await expect(rejectProject({ materialVersion: 2 })).rejects.toMatchObject({
      code: "OPS_VERSION_CONFLICT",
    });
    await rejectProject({});
    const rejected = await launch.getProject(projectId);
    expect(rejected).toMatchObject({
      reviewStatus: "rejected",
      reviewReasonCode: "other",
      rejection: { reasonCode: "other", note: "The logo is someone else's" },
    });
    const events = await pool.query<{
      event_type: string;
      reason_code: string;
    }>(
      "select event_type, reason_code from public.launch_review_events where project_id = $1 order by occurred_at desc limit 1",
      [projectId],
    );
    expect(events.rows[0]).toEqual({
      event_type: "project_rejected",
      reason_code: "other",
    });
    const detail = await admin.getProject({ projectId, scope: "*" });
    expect(detail?.project.rejection).toMatchObject({
      reasonCode: "other",
      reviewerUserId: reviewerId,
      materialVersion: 1,
    });
    expect(detail?.projectRejections).toHaveLength(1);

    // The applicant may now edit and resubmit.
    const edited = await launch.replaceProject({
      ownerUserId: owner,
      projectId,
      expectedVersion: rejected!.version,
      requestId: randomUUID(),
      values: {
        name: "Reject Me Not",
        ticker: "RJCT",
        narrative: null,
        officialLinks: {
          website: null,
          x: null,
          telegram: null,
          discord: null,
        },
      },
    });
    expect(edited.materialVersion).toBe(2);
    const resubmitted = await launch.submitProject({
      ownerUserId: owner,
      projectId,
      idempotencyKey: randomUUID(),
      requestSha256: launchCommandDigest("submitProject", [projectId, "2"]),
      requestId: randomUUID(),
    });
    expect(resubmitted).toMatchObject({
      reviewStatus: "submitted",
      rejection: null,
    });
    await expect(
      pool.query(
        "update public.launch_project_rejections set note = 'x' where project_id = $1",
        [projectId],
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(
      pool.query(
        `insert into public.launch_project_rejections (rejection_id, project_id,
           material_version, reason_code, note, reviewer_user_id)
         values (gen_random_uuid(), $1, 2, 'other', null, $2)`,
        [projectId, reviewerId],
      ),
    ).rejects.toThrow(/launch_project_rejections_other_note/u);
  });
});
