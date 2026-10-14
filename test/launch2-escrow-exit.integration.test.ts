import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresLaunch2PublicationRepository } from "../src/database/launch2-snapshot-publication-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import type { Launch2LaneEvent } from "../src/features/launch2/launch2-ports.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0137 (migration 000081) on a real PostgreSQL: the
 * `PublicRoundOpenedAfterTimeout` projection, typed `RefundClaimed` facts
 * (one per token, undone by a rewind), the viewer's held tokens from the NFT
 * transfers, the `nft_refund` intent and its append-only report, and the
 * publisher's `open_after_timeout` row / candidate fields.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const launch2 = createPostgresLaunch2Repository(pool);
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
async function instance(generation: "v2" | "v3" = "v3"): Promise<{
  readonly projectId: string;
  readonly instanceId: string;
  readonly snapshots: string;
  readonly graduationAdapter: string;
  readonly curve: string;
  readonly nft: string;
  readonly escrow: string;
  readonly owner: string;
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
  const graduationAdapter = hex(20);
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
      graduationAdapter,
      hex(20),
      hex(20),
      hex(20),
      draft.buybackRecipient,
      generation,
    ],
  );
  const row = (
    await pool.query<{
      curve_address: string;
      nft_address: string;
      escrow_address: string;
    }>(
      "select curve_address, nft_address, escrow_address from public.launch2_instances where instance_id = $1",
      [instanceId],
    )
  ).rows[0]!;
  return {
    projectId,
    instanceId,
    snapshots,
    graduationAdapter,
    curve: row.curve_address,
    nft: row.nft_address,
    escrow: row.escrow_address,
    owner,
  };
}

const holderA = `0x${"a1".repeat(20)}`;
const holderB = `0x${"b2".repeat(20)}`;
const zero = `0x${"00".repeat(32)}`;
const zeroAddress = `0x${"0".repeat(40)}`;
const publications = createPostgresLaunch2PublicationRepository(pool);
const base = 7_000_000;

function event(
  target: { readonly instanceId: string },
  contractAddress: string,
  eventName: Launch2LaneEvent["eventName"],
  args: Record<string, string>,
  blockNumber: number,
  logIndex = 0,
): Launch2LaneEvent {
  return {
    instanceId: target.instanceId,
    contractAddress,
    eventName,
    args,
    // Unique per instance: the typed fact tables key on (chain, tx, log)
    // and the suite must stay re-runnable on a persistent database.
    transactionHash: `0x${blockNumber.toString(16).padStart(8, "0")}${logIndex.toString(16).padStart(4, "0")}${target.instanceId.replaceAll("-", "")}${"0".repeat(20)}`,
    logIndex,
    blockNumber: String(blockNumber),
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    at: String(1_800_000_000 + blockNumber - base),
  };
}

async function commit(
  events: readonly Launch2LaneEvent[],
  last: number,
  rewindFrom?: number,
) {
  await launch2.commitSegment({
    chainId,
    events,
    checkpoint: {
      lastBlockNumber: String(last),
      lastBlockHash: `0x${last.toString(16).padStart(64, "0")}`,
      startedFromBlockNumber: "1",
    },
    ...(rewindFrom === undefined
      ? {}
      : { rewindFromBlockNumber: String(rewindFrom) }),
    activationGraceBlocks: 15,
  });
}

describe("Decision 0137: escrow exit read model (000081)", () => {
  it("projects the timeout opening, refunds and held tokens; a rewind undoes them", async () => {
    const target = await instance();
    const gate = (
      await pool.query<{ gate_address: string }>(
        "select gate_address from public.launch2_instances where instance_id = $1",
        [target.instanceId],
      )
    ).rows[0]!.gate_address;
    const e = (
      address: string,
      name: Launch2LaneEvent["eventName"],
      args: Record<string, string>,
      block: number,
      index = 0,
    ) => event(target, address, name, args, block, index);
    await commit(
      [
        e(gate, "LaunchActivated", { activatedAt: "1799990000" }, base + 1),
        e(
          target.nft,
          "Transfer",
          { from: zeroAddress, to: holderA, tokenId: "1" },
          base + 2,
        ),
        e(
          target.nft,
          "Transfer",
          { from: zeroAddress, to: holderA, tokenId: "2" },
          base + 3,
        ),
        e(
          target.nft,
          "Transfer",
          { from: zeroAddress, to: holderB, tokenId: "3" },
          base + 4,
        ),
        e(
          target.nft,
          "Transfer",
          { from: holderA, to: holderB, tokenId: "2" },
          base + 5,
        ),
      ],
      base + 5,
    );
    await commit(
      [
        e(
          target.snapshots,
          "PublicRoundOpenedAfterTimeout",
          {
            launchId: zero,
            openedAt: "1800000100",
            openedBlock: String(base + 10),
            totalMinted: "3",
          },
          base + 10,
        ),
        e(
          target.escrow,
          "RefundClaimed",
          {
            tokenId: "1",
            owner: holderA,
            amount: (100n * 10n ** 18n).toString(),
            remainingRecorded: (200n * 10n ** 18n).toString(),
          },
          base + 20,
        ),
      ],
      base + 20,
    );
    const opened = await launch2.getInstance(target.instanceId);
    expect(opened?.openedAfterTimeout).toEqual({
      openedAt: new Date(1_800_000_100_000).toISOString(),
      blockNumber: String(base + 10),
      transactionHash: event(target, "", "LaunchActivated", {}, base + 10)
        .transactionHash,
      totalMinted: "3",
    });
    expect(opened?.nftRefundedCount).toBe("1");
    expect(
      await launch2.listHeldNftTokens!({
        instanceId: target.instanceId,
        holderAddress: holderA,
        limit: 50,
      }),
    ).toEqual(["1"]);
    expect(
      await launch2.listHeldNftTokens!({
        instanceId: target.instanceId,
        holderAddress: holderB.toUpperCase().replace("0X", "0x"),
        limit: 50,
      }),
    ).toEqual(["2", "3"]);
    const refunds = await launch2.listNftRefunds!({
      instanceId: target.instanceId,
      tokenIds: [],
    });
    expect(refunds).toEqual([
      expect.objectContaining({
        tokenId: "1",
        ownerAddress: holderA,
        amountUsd1: (100n * 10n ** 18n).toString(),
        remainingRecordedUsd1: (200n * 10n ** 18n).toString(),
        blockNumber: String(base + 20),
      }),
    ]);
    const lane = (await launch2.listLaneInstances(chainId)).find(
      (entry) => entry.instanceId === target.instanceId,
    );
    expect(lane?.openedAfterTimeoutAt).toBe(
      new Date(1_800_000_100_000).toISOString(),
    );
    expect(lane?.factoryAddress).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    // A second refund of the same token is refused by the database too.
    await expect(
      pool.query(
        `insert into public.launch2_nft_refunds (chain_id, transaction_hash,
           log_index, block_number, block_hash, instance_id, escrow_address,
           token_id, owner_address, amount_usd1, remaining_recorded_usd1,
           refunded_at)
         values ($1, $2, 0, 1, $3, $4, $5, 1, $6, 1, 0, now())`,
        [
          chainId,
          `0x${"ef".repeat(32)}`,
          zero,
          target.instanceId,
          target.escrow,
          holderA,
        ],
      ),
    ).rejects.toThrow(/launch2_nft_refunds_token_once/u);
    // Reorg below the opening: both facts are removed and the projection cleared.
    await commit([], base + 9, base + 9);
    const rewound = await launch2.getInstance(target.instanceId);
    expect(rewound?.openedAfterTimeout).toBeNull();
    expect(rewound?.nftRefundedCount).toBe("0");
    expect(
      await launch2.listNftRefunds!({
        instanceId: target.instanceId,
        tokenIds: ["1"],
      }),
    ).toEqual([]);
  });

  it("refuses a timeout opening together with a snapshot root", async () => {
    const target = await instance();
    await expect(
      pool.query(
        `update public.launch2_instances set opened_after_timeout_at = now(),
           opened_after_timeout_block = 1, opened_after_timeout_tx = $2,
           opened_after_timeout_total_minted = 1, snapshot_root = $2
         where instance_id = $1`,
        [target.instanceId, `0x${"12".repeat(32)}`],
      ),
    ).rejects.toThrow(/launch2_instances_opened_after_timeout_shape/u);
  });

  it("records an nft_refund intent's report once (same / conflict), append-only", async () => {
    const target = await instance();
    const intentId = randomUUID();
    const walletId = randomUUID();
    await launch2.createIntent({
      ownerUserId: target.owner,
      idempotencyKey: randomUUID(),
      requestSha256: "c".repeat(64),
      canaryAdmission: () => null,
      build: () =>
        Promise.resolve({
          intentId,
          ownerUserId: target.owner,
          instanceId: target.instanceId,
          walletId,
          walletAddress: holderA,
          kind: "nft_refund",
          chainId,
          contractAddress: target.escrow,
          amountIn: "0",
          expectedOut: (100n * 10n ** 18n).toString(),
          minOut: "0",
          taxUsd1: "0",
          refundUsd1: "0",
          deadline: new Date(1_900_000_000_000).toISOString(),
          snapshotBlockNumber: "1",
          snapshotBlockHash: `0x${"11".repeat(32)}`,
          calldata: { to: target.escrow, data: "0x", value: "0" },
          unsignedTransaction: { chainId: 97 },
          approval: null,
          policy: { valueUsd: "100", nftRefund: { tokenId: "1" } },
          payloadDigest: "d".repeat(64),
          expiresAt: new Date(1_900_000_000_000).toISOString(),
        }),
    });
    expect(
      await launch2.getNftRefundIntent!({
        intentId,
        ownerUserId: target.owner,
      }),
    ).toMatchObject({ intentId, kind: "nft_refund" });
    expect(
      await launch2.getNftRefundIntent!({
        intentId,
        ownerUserId: randomUUID(),
      }),
    ).toBeNull();
    const report = {
      intentId,
      ownerUserId: target.owner,
      instanceId: target.instanceId,
      walletId,
      walletAddress: holderA,
      tokenId: "1",
      transactionHash: `0x${"cd".repeat(32)}`,
    };
    expect((await launch2.recordNftRefundReport!(report)).outcome).toBe(
      "created",
    );
    expect((await launch2.recordNftRefundReport!(report)).outcome).toBe("same");
    expect(
      (
        await launch2.recordNftRefundReport!({
          ...report,
          transactionHash: `0x${"ef".repeat(32)}`,
        })
      ).outcome,
    ).toBe("conflict");
    await expect(
      pool.query(
        "delete from public.launch2_nft_refund_reports where intent_id = $1",
        [intentId],
      ),
    ).rejects.toThrow(/append-only/u);
  });

  it("stores an open_after_timeout publication and reports its budget on the candidate", async () => {
    const target = await instance();
    const pending = await publications.insertPending({
      action: "open_after_timeout",
      instanceId: target.instanceId,
      chainId,
      attempt: 1,
      snapshots: target.snapshots,
      cutoffBlock: "400",
      cutoffBlockHash: `0x${"ee".repeat(32)}`,
      saleEndAt: new Date().toISOString(),
      members: [],
      root: zero,
      dataHash: zero,
      signerAddresses: [],
      signatures: [],
      submitterAddress: hex(20),
    });
    expect(pending?.action).toBe("open_after_timeout");
    await publications.transition({
      publicationId: pending!.publicationId,
      from: "pending",
      to: "failed",
      failure: {
        code: "LAUNCH2_SNAPSHOT_OPENED_BY_OTHER",
        detail: null,
        retryable: false,
      },
    });
    const candidate = (await publications.listCandidates(chainId)).find(
      (entry) => entry.instanceId === target.instanceId,
    );
    expect(candidate).toMatchObject({
      factoryAddress: "0x1111111111111111111111111111111111111111",
      openedAfterTimeout: false,
      timeoutOpen: { retryableFailures: 0, blocked: true },
    });
    // Members on a timeout opening are refused by the shape check.
    await expect(
      publications.insertPending({
        action: "open_after_timeout",
        instanceId: target.instanceId,
        chainId,
        attempt: 2,
        snapshots: target.snapshots,
        cutoffBlock: "400",
        cutoffBlockHash: `0x${"ee".repeat(32)}`,
        saleEndAt: new Date().toISOString(),
        members: [holderA],
        root: zero,
        dataHash: zero,
        signerAddresses: [],
        signatures: [],
        submitterAddress: hex(20),
      }),
    ).rejects.toThrow();
  });
});
