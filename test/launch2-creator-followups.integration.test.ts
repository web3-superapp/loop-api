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

/** An activated MEME v2 instance on BSC Testnet with a sale already over. */
async function instance(): Promise<{
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
       deployed_event_seen, stage
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'Project', 'MEME', $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
       now() - interval '30 days', 1, now() - interval '31 days', true,
       'snapshot_pending')`,
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
