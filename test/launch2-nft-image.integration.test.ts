import { randomUUID } from "node:crypto";

import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPostgresAdminLaunchReviewRepository } from "../src/database/admin-launch-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { createPostgresMediaRepository } from "../src/database/media-repository.js";
import { createHooksLaunchProjectConfigService } from "../src/features/launch/hooks-launch-project-config.js";
import {
  createHooksLaunchReviewService,
  hooksLaunchReviewCommandSchema,
  type HooksLaunchOpsPermission,
} from "../src/features/launch/hooks-launch-review.js";
import type { IpfsPinner } from "../src/features/media/ipfs-pinner.js";
import { createMediaService } from "../src/features/media/media-service.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0173 on PostgreSQL (migration 000096): the `project_nft_image`
 * media kind and its IPFS CID, the owner and operator config saves that
 * resolve `nftImageAssetUrl` to the owner's own upload, the console
 * payload, and the launch2 read model columns. Assertions are scoped to
 * the rows this run creates.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const media = createPostgresMediaRepository(pool);
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const reviewRepository = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const admin = createPostgresAdminLaunchReviewRepository(pool);
const launch2 = createPostgresLaunch2Repository(pool);
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);

function hex(bytes: number): string {
  let out = "";
  while (out.length < bytes * 2) out += randomUUID().replaceAll("-", "");
  return `0x${out.slice(0, bytes * 2)}`;
}

const publicBaseUrl = "https://api-dev.example.test";
const gateway = "https://ipfs.filebase.io/ipfs";
const recipient = "0x3333333333333333333333333333333333333333";

let picture: Buffer;
let pinnedCid: string;

beforeAll(async () => {
  picture = await sharp({
    create: {
      width: 300,
      height: 300,
      channels: 3,
      background: { r: Math.floor(Math.random() * 255), g: 9, b: 9 },
    },
  })
    .png()
    .toBuffer();
  // A syntactically valid CIDv1 unique to this run.
  pinnedCid = `b${randomUUID()
    .replaceAll("-", "")
    .replace(/[^a-z2-7]/gu, "a")}${"a".repeat(30)}`;
});

afterAll(async () => {
  await pool.end();
});

const pinner: IpfsPinner = {
  gatewayBaseUrl: gateway,
  pin: vi.fn(() => Promise.resolve(pinnedCid)),
};

const service = createMediaService({
  storage: media,
  quota: { consume: () => Promise.resolve() },
  ipfsPinner: pinner,
  publicBaseUrl,
});

const draftBody = {
  name: "Project",
  ticker: "MEME",
  logoAssetUrl: "https://example.com/logo.png",
  description: "Test",
  links: [],
  nftSaleStartAt: "1900000000",
  buybackRecipient: recipient,
};

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:s274:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function approvedProject(owner: string): Promise<string> {
  const projectId = randomUUID();
  await pool.query(
    "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project', 'MEME', 'approved', now(), now())",
    [projectId, owner],
  );
  return projectId;
}

async function operator(
  permissions: readonly HooksLaunchOpsPermission[],
): Promise<string> {
  const id = await user();
  await pool.query(
    "insert into public.ops_operators (user_id, label, enabled) values ($1, 'S274', true)",
    [id],
  );
  for (const permission of permissions) {
    await pool.query(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, $2, '*')",
      [id, permission],
    );
  }
  return id;
}

async function uploadNft(owner: string) {
  return service.upload({
    principal: { userId: owner } as never,
    kind: "project_nft_image",
    idempotencyKey: randomUUID(),
    bytes: picture,
  });
}

const configService = createHooksLaunchProjectConfigService({
  repository: configs,
  factory: {
    nftSaleDuration: () => Promise.resolve({ seconds: 604_800, legacy: false }),
  },
  minimumLeadSeconds: 86_400,
  fixedBuybackRecipient: recipient,
  now: () => 1_800_000_000,
  nftImages: service,
});

describe("Decision 0173: project NFT pictures on PostgreSQL", () => {
  it("stores the CID with the picture and finds it only for its owner", async () => {
    const owner = await user();
    const uploaded = await uploadNft(owner);
    expect(uploaded).toMatchObject({
      url: `${gateway}/${pinnedCid}`,
      cid: pinnedCid,
      ipfsUri: `ipfs://${pinnedCid}`,
    });
    expect(await media.getMetadata(uploaded.mediaId)).toMatchObject({
      kind: "project_nft_image",
      ipfsCid: pinnedCid,
    });
    expect(
      (
        await media.findProjectNftImageByCid({
          ownerUserId: owner,
          cid: pinnedCid,
        })
      )?.mediaId,
    ).toBe(uploaded.mediaId);
    expect(
      await media.findProjectNftImageByCid({
        ownerUserId: await user(),
        cid: pinnedCid,
      }),
    ).toBeNull();
  });

  it("refuses a CID on another kind, a malformed CID, and keeps rows immutable", async () => {
    const owner = await user();
    const insert = (kind: string, cid: string) =>
      pool.query(
        `insert into public.media_objects (media_id, owner_user_id, kind,
           content_type, bytes, width, height, sha256, idempotency_key,
           request_sha256, ipfs_cid)
         values ($1, $2, $3, 'image/webp', '\\x00', 1, 1, $4, $5, $4, $6)`,
        [randomUUID(), owner, kind, "a".repeat(64), randomUUID(), cid],
      );
    await expect(insert("community_logo", pinnedCid)).rejects.toThrow(
      /media_objects_ipfs_cid_check/u,
    );
    await expect(insert("project_nft_image", "not-a-cid")).rejects.toThrow(
      /media_objects_ipfs_cid_check/u,
    );
    const uploaded = await uploadNft(owner);
    await expect(
      pool.query(
        "update public.media_objects set ipfs_cid = null where media_id = $1",
        [uploaded.mediaId],
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it("saves an owner draft with the canonical gateway URL and the CID, and shows both to the console", async () => {
    const owner = await user();
    const projectId = await approvedProject(owner);
    const uploaded = await uploadNft(owner);
    const saved = await configService.saveDraft({
      ownerUserId: owner,
      projectId,
      expectedVersion: 0,
      body: {
        ...draftBody,
        // The local copy's absolute URL resolves to the same pinned picture.
        nftImageAssetUrl: `${publicBaseUrl}/v2/media/${uploaded.mediaId}.webp`,
      },
    });
    expect(saved.config).toMatchObject({
      nftImageAssetUrl: `${gateway}/${pinnedCid}`,
      nftImageCid: pinnedCid,
    });
    const stored = await pool.query<{ config: Record<string, unknown> }>(
      "select config from public.hooks_launch_project_config_versions where project_id = $1",
      [projectId],
    );
    expect(stored.rows[0]?.config).toMatchObject({
      nftImageAssetUrl: `${gateway}/${pinnedCid}`,
      nftImageCid: pinnedCid,
    });
    const detail = await admin.getProject({ projectId, scope: "*" });
    expect(detail?.versions[0]?.config).toMatchObject({
      logoAssetUrl: "https://example.com/logo.png",
      nftImageAssetUrl: `${gateway}/${pinnedCid}`,
      nftImageCid: pinnedCid,
    });

    // Another user's picture is refused.
    const stranger = await user();
    const foreign = await uploadNft(stranger);
    await expect(
      configService.saveDraft({
        ownerUserId: owner,
        projectId,
        expectedVersion: 1,
        body: {
          ...draftBody,
          nftImageAssetUrl: `${publicBaseUrl}/v2/media/${foreign.mediaId}.webp`,
        },
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "MEDIA_NOT_OWNED" },
    });
  });

  it("shows null NFT fields to the console for a version without a picture", async () => {
    const owner = await user();
    const projectId = await approvedProject(owner);
    await configService.saveDraft({
      ownerUserId: owner,
      projectId,
      expectedVersion: 0,
      body: draftBody,
    });
    const detail = await admin.getProject({ projectId, scope: "*" });
    expect(detail?.versions[0]?.config).toMatchObject({
      nftImageAssetUrl: null,
      nftImageCid: null,
    });
  });

  it("lets an operator keep the owner's picture and refuses anyone else's", async () => {
    const owner = await user();
    const projectId = await approvedProject(owner);
    const uploaded = await uploadNft(owner);
    await configService.saveDraft({
      ownerUserId: owner,
      projectId,
      expectedVersion: 0,
      body: draftBody,
    });
    const editor = await operator(["launch.edit"]);
    const reviewService = createHooksLaunchReviewService({
      repository: reviewRepository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
        hookKind: "officialTax",
      } as never,
      fixedBuybackRecipient: recipient,
      nftImageBases: { publicBaseUrl, ipfsGatewayBaseUrl: gateway },
    });
    const save = (expectedVersion: number, nftImageAssetUrl: string) =>
      reviewService.execute(editor, {
        operationId: randomUUID(),
        action: "launch.config.save",
        target: projectId,
        reason: "Operator correction",
        payload: {
          expectedVersion,
          config: { ...draftBody, nftImageAssetUrl },
        },
      });
    await save(1, `${gateway}/${pinnedCid}`);
    const latest = await pool.query<{ config: Record<string, unknown> }>(
      "select config from public.hooks_launch_project_config_versions where project_id = $1 order by config_version desc limit 1",
      [projectId],
    );
    expect(latest.rows[0]?.config).toMatchObject({
      nftImageAssetUrl: `${gateway}/${pinnedCid}`,
      nftImageCid: pinnedCid,
    });
    const foreign = await uploadNft(await user());
    await expect(
      save(2, `${publicBaseUrl}/v2/media/${foreign.mediaId}.webp`),
    ).rejects.toMatchObject({ code: "OPS_INVALID_LAUNCH_CONFIG" });
    await expect(
      save(2, "https://cdn.example.com/nft.png"),
    ).rejects.toMatchObject({ code: "OPS_INVALID_LAUNCH_CONFIG" });
    expect(uploaded.mediaId).toBeTruthy();
  });

  it("reads nft_image_url / nft_image_cid on an instance, by launch id too", async () => {
    const owner = await user();
    const projectId = await approvedProject(owner);
    const uploaded = await uploadNft(owner);
    const saved = await configService.saveDraft({
      ownerUserId: owner,
      projectId,
      expectedVersion: 0,
      body: { ...draftBody, nftImageAssetUrl: uploaded.url },
    });
    const approver = await operator(["launch.approve"]);
    await reviewRepository.execute(
      approver,
      hooksLaunchReviewCommandSchema.parse({
        operationId: randomUUID(),
        action: "launch.config.approve",
        target: projectId,
        reason: "Independent hash review",
        payload: { configVersion: 1, configHash: saved.config.configHash },
      }),
    );
    const request = {
      configHash: saved.config.configHash,
      projectOwner: hex(20),
      configVersion: 1,
      name: saved.config.name,
      ticker: saved.config.ticker,
      nftSaleStart: saved.config.nftSaleStartAt,
      buybackRecipient: saved.config.buybackRecipient,
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
    const launchId = hex(32);
    await pool.query(
      `insert into public.launch2_instances (
         instance_id, job_id, project_id, config_version, owner_user_id,
         chain_id, factory_address, launch_id, config_hash, project_owner,
         name, ticker, logo_url, nft_image_url, nft_image_cid,
         meme_address, hook_address, nft_address, curve_address,
         gate_address, escrow_address, snapshots_address,
         graduation_adapter_address, buyback_adapter_address,
         price_recorder_address, buyback_executor_address,
         buyback_recipient, nft_sale_start, deploy_block_number,
         activated_at, deployed_event_seen, stage, factory_generation
       ) values ($1, $2, $3, 1, $4, 'eip155:97', $5, $6, $7, $8, 'S274',
         'S274', 'https://example.com/logo.png', $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22,
         now() + interval '1 day', 1, now(), true, 'nft_sale', 'v3')`,
      [
        randomUUID(),
        job.jobId,
        projectId,
        owner,
        "0x1111111111111111111111111111111111111111",
        launchId,
        saved.config.configHash,
        request.projectOwner,
        saved.config.nftImageAssetUrl,
        saved.config.nftImageCid,
        memeAddress,
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
        recipient,
      ],
    );
    const record = await launch2.getInstanceByLaunchId(
      launchId.toUpperCase().replace("0X", "0x"),
    );
    expect(record).toMatchObject({
      launchId,
      nftImageUrl: `${gateway}/${pinnedCid}`,
      nftImageCid: pinnedCid,
    });
    await expect(
      pool.query(
        "update public.launch2_instances set nft_image_cid = 'nope' where launch_id = $1",
        [launchId],
      ),
    ).rejects.toThrow(/launch2_instances_nft_image_cid_check/u);
    // The activation projection's SQL (new columns) still runs.
    await launch2.registerActivatedInstances({
      chainId: "eip155:97",
      factories: [
        {
          address: "0x1111111111111111111111111111111111111111",
          generation: "v3",
        },
      ],
    });
  });
});
