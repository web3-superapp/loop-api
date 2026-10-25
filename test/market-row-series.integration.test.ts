import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresMarketRowSeriesStore } from "../src/database/market-row-series-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { launch2PriceAt } from "../src/features/launch2/launch2-curve-math.js";
import {
  fillHourlySparkline24h,
  marketRowSparklineWindow,
} from "../src/features/market/market-row-sparkline24h.js";
import { formatE18 } from "../src/features/meme/meme-curve-math.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0186 on a real PostgreSQL: one read returns the hourly closes of
 * launch2 instances (curve trades at the marginal price after the running
 * sold supply, official-pool swaps at price_e18, reorged facts left out)
 * and MEME v1 tokens (meme_trades.price_after_e18) for many assets at once;
 * an asset without facts is absent.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const store = createPostgresMarketRowSeriesStore(pool);
const chainId = "eip155:97";
const wad = 10n ** 18n;
const h = 3_600;
/** An hour-aligned instant: the current hour of the read. */
const t0 = 1_800_000_000;
const activatedAt = t0 - 4 * 86_400;
const window = marketRowSparklineWindow(t0 + 1_000);

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
    [`did:privy:s267:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

interface Seeded {
  readonly instanceId: string;
  readonly poolId: string;
  readonly assetId: string;
}

/** An activated instance (Hooks job + approved config + registry row). */
async function instance(graduatedAt: number | null): Promise<Seeded> {
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
    memeAddress: `${hex(18)}6666`,
    hookAddress: hex(20),
  });
  const instanceId = randomUUID();
  const poolId = hex(32);
  const memeAddress = `${hex(18)}6666`;
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation, graduated_at,
       official_pool_id
     ) values ($1, $2, $3, 1, $4, $5,
       '0x1111111111111111111111111111111111111111', $6, $7, $8, 'Project',
       'MEME', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       to_timestamp($21::bigint - 864000), 1, to_timestamp($21::bigint), true,
       $22, 'v3', to_timestamp($23::bigint), $24)`,
    [
      instanceId,
      job.jobId,
      projectId,
      owner,
      chainId,
      hex(32),
      draft.configHash,
      hex(20),
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
      draft.buybackRecipient,
      String(activatedAt),
      graduatedAt === null ? "public" : "graduated",
      graduatedAt === null ? null : String(graduatedAt),
      graduatedAt === null ? null : poolId,
    ],
  );
  return { instanceId, poolId, assetId: `${chainId}:${memeAddress}` };
}

let log = 0;
function fact(blockNumber: number) {
  log += 1;
  return [
    chainId,
    hex(32),
    log,
    blockNumber,
    `0x${blockNumber.toString(16).padStart(64, "0")}`,
  ] as const;
}

async function trade(
  target: Seeded,
  input: {
    readonly side: "buy" | "sell";
    readonly meme: bigint;
    readonly net: bigint;
    readonly at: number;
    readonly block: number;
    readonly removed?: boolean;
  },
) {
  const tax = input.net / 9n;
  await pool.query(
    `insert into public.launch2_trades (
       trade_id, chain_id, transaction_hash, log_index, block_number,
       block_hash, instance_id, removed, side, trader_address, meme_amount,
       usd1_gross, usd1_net, tax_usd1, refund_usd1, cumulative_bought,
       sold_after, traded_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0,
       $15, $16, to_timestamp($17::bigint))`,
    [
      randomUUID(),
      ...fact(input.block),
      target.instanceId,
      input.removed === true,
      input.side,
      hex(20),
      input.meme.toString(),
      (input.net + tax).toString(),
      input.net.toString(),
      tax.toString(),
      input.side === "buy" ? input.meme.toString() : null,
      // As the lane writes them: CurveBought carries no sold_after.
      input.side === "sell" ? "0" : null,
      String(input.at),
    ],
  );
}

async function swap(
  target: Seeded,
  input: {
    readonly side: "buy" | "sell";
    readonly usd1: bigint;
    readonly meme: bigint;
    readonly priceE18: bigint;
    readonly at: number;
    readonly block: number;
  },
) {
  await pool.query(
    `insert into public.launch2_pool_swaps (
       chain_id, transaction_hash, log_index, block_number, block_hash,
       instance_id, pool_id, caller_address, side, usd1_amount, meme_amount,
       tax_amount, tax_token, sqrt_price_x96, price_e18, swapped_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, 1, $13,
       to_timestamp($14::bigint))`,
    [
      ...fact(input.block),
      target.instanceId,
      target.poolId,
      hex(20),
      input.side,
      input.usd1.toString(),
      input.meme.toString(),
      input.side === "buy" ? "meme" : "usd1",
      input.priceE18.toString(),
      String(input.at),
    ],
  );
}

async function memeV1(): Promise<{
  readonly assetId: string;
  readonly trade: (input: {
    readonly priceE18: bigint;
    readonly at: number;
    readonly block: number;
    readonly removed?: boolean;
  }) => Promise<void>;
}> {
  const address = hex(20);
  const assetId = `${chainId}:${address}`;
  await pool.query(
    `insert into public.assets (
       asset_id, chain_id, address, symbol, name, decimals, status,
       source_kind, source_block_number, source_verified_at
     ) values ($1, $2, $3, 'MV1', 'Meme V1', 18, 'pending', 'chain_call', 1,
       clock_timestamp())`,
    [assetId, chainId, address],
  );
  const memeTokenId = randomUUID();
  await pool.query(
    `insert into public.meme_tokens (
       meme_token_id, chain_id, contract_address, contract_version,
       creator_user_id, name, symbol, metadata_hash, token_address, asset_id,
       status, chain_created_at, v_usd1, v_token, listing
     ) values ($1, $2, $3, '1.0.0', $4, 'Meme V1', 'MV1', $5, $6, $7,
       'trading', clock_timestamp(), $8, $9, 'listed')`,
    [
      memeTokenId,
      chainId,
      hex(20),
      await user(),
      `0x${"1".repeat(64)}`,
      address,
      assetId,
      (6_000n * wad).toString(),
      (1_073_000_000n * wad).toString(),
    ],
  );
  return {
    assetId,
    trade: async (input) => {
      await pool.query(
        `insert into public.meme_trades (
           chain_id, transaction_hash, log_index, block_number, block_hash,
           token_address, meme_token_id, wallet, is_buy, usd1_amount,
           token_amount, fee_usd1, v_usd1_after, v_token_after, sold_after,
           price_after_e18, traded_at, removed
         ) values ($1, $2, 0, $3, $2, $4, $5, $6, true, 1, 1, 0, 1, 1, 0,
           $7, to_timestamp($8::bigint), $9)`,
        [
          chainId,
          hex(32),
          input.block,
          address,
          memeTokenId,
          hex(20),
          input.priceE18.toString(),
          String(input.at),
          input.removed === true,
        ],
      );
    },
  };
}

let curve: Seeded;
let mixed: Seeded;
let quiet: Seeded;
let early: Seeded;
let v1: Awaited<ReturnType<typeof memeV1>>;

beforeAll(async () => {
  curve = await instance(null);
  mixed = await instance(t0 - 2 * h + 50);
  quiet = await instance(null);
  early = await instance(t0 - 35 * h);
  v1 = await memeV1();

  // Curve: 1,000,000 MEME bought 30 h ago (before the window), then a buy
  // of 500,000 and a sell of 200,000 in the hour t0 − 5 h, and a reorged buy
  // at t0 − 3 h that must not count.
  await trade(curve, {
    side: "buy",
    meme: 1_000_000n * wad,
    net: 45n * wad,
    at: t0 - 30 * h,
    block: 100,
  });
  await trade(curve, {
    side: "buy",
    meme: 500_000n * wad,
    net: 30n * wad,
    at: t0 - 5 * h + 60,
    block: 200,
  });
  await trade(curve, {
    side: "sell",
    meme: 200_000n * wad,
    net: 10n * wad,
    at: t0 - 5 * h + 600,
    block: 201,
  });
  await trade(curve, {
    side: "buy",
    meme: 9_000_000n * wad,
    net: 900n * wad,
    at: t0 - 3 * h,
    block: 300,
    removed: true,
  });

  // Graduation crossing: a curve buy, then two pool swaps in the same hour
  // (the later block closes it), and one swap in the current hour.
  await trade(mixed, {
    side: "buy",
    meme: 2_000_000n * wad,
    net: 90n * wad,
    at: t0 - 2 * h + 10,
    block: 400,
  });
  await swap(mixed, {
    side: "buy",
    usd1: 5n * wad,
    meme: 1n * wad,
    priceE18: 70_000_000_000_000n,
    at: t0 - 2 * h + 100,
    block: 401,
  });
  await swap(mixed, {
    side: "sell",
    usd1: 5n * wad,
    meme: 1n * wad,
    priceE18: 71_000_000_000_000n,
    at: t0 - 2 * h + 200,
    block: 402,
  });
  await swap(mixed, {
    side: "buy",
    usd1: 5n * wad,
    meme: 1n * wad,
    priceE18: 72_000_000_000_000n,
    at: t0 + 30,
    block: 500,
  });

  // Graduated before the window: the last fact before it is a pool swap
  // (later than the last curve trade), so the prior close is the pool's.
  await trade(early, {
    side: "buy",
    meme: 3_000_000n * wad,
    net: 140n * wad,
    at: t0 - 40 * h,
    block: 600,
  });
  await swap(early, {
    side: "buy",
    usd1: 5n * wad,
    meme: 1n * wad,
    priceE18: 80_000_000_000_000n,
    at: t0 - 30 * h,
    block: 700,
  });

  await v1.trade({ priceE18: 5_000_000_000_000n, at: t0 - h + 5, block: 10 });
  await v1.trade({ priceE18: 5_500_000_000_000n, at: t0 - h + 10, block: 11 });
  await v1.trade({
    priceE18: 9n * wad,
    at: t0 - h + 20,
    block: 12,
    removed: true,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe("market row series store (Decision 0186)", () => {
  it("reads launch2 and MEME v1 hourly closes for many assets in one query", async () => {
    const unknown = `${chainId}:${hex(20)}`;
    const records = await store.readHourlyCloses({
      assetIds: [
        curve.assetId,
        mixed.assetId,
        quiet.assetId,
        v1.assetId,
        unknown,
      ],
      fromSeconds: window.fromSeconds,
      toSeconds: window.toSeconds,
    });
    expect([...records.keys()].sort()).toEqual(
      [curve.assetId, mixed.assetId, v1.assetId].sort(),
    );

    expect(records.get(curve.assetId)).toEqual({
      firstAt: t0 - 30 * h,
      priorCloseE18: launch2PriceAt(1_000_000n * wad).toString(),
      buckets: [
        {
          t: t0 - 5 * h,
          closeE18: launch2PriceAt(1_300_000n * wad).toString(),
        },
      ],
    });
    expect(records.get(mixed.assetId)).toEqual({
      firstAt: t0 - 2 * h + 10,
      priorCloseE18: null,
      buckets: [
        { t: t0 - 2 * h, closeE18: "71000000000000" },
        { t: t0, closeE18: "72000000000000" },
      ],
    });
    expect(records.get(v1.assetId)).toEqual({
      firstAt: t0 - h + 5,
      priorCloseE18: null,
      buckets: [{ t: t0 - h, closeE18: "5500000000000" }],
    });
  });

  it("fills the curve token's day from the prior close and keeps the graduation crossing as one line", async () => {
    const records = await store.readHourlyCloses({
      assetIds: [curve.assetId, mixed.assetId, v1.assetId],
      fromSeconds: window.fromSeconds,
      toSeconds: window.toSeconds,
    });
    const curveLine = fillHourlySparkline24h({
      record: records.get(curve.assetId)!,
      fromSeconds: window.fromSeconds,
      endBucket: window.endBucket,
    });
    expect(curveLine).toHaveLength(24);
    expect(curveLine?.[0]).toBe(formatE18(launch2PriceAt(1_000_000n * wad)));
    expect(curveLine?.at(-1)).toBe(formatE18(launch2PriceAt(1_300_000n * wad)));
    expect(
      fillHourlySparkline24h({
        record: records.get(mixed.assetId)!,
        fromSeconds: window.fromSeconds,
        endBucket: window.endBucket,
      }),
    ).toEqual(["0.000071", "0.000071", "0.000072"]);
    expect(
      fillHourlySparkline24h({
        record: records.get(v1.assetId)!,
        fromSeconds: window.fromSeconds,
        endBucket: window.endBucket,
      }),
    ).toEqual(["0.0000055", "0.0000055"]);
  });

  it("takes the prior close from the latest fact before the window across curve and pool", async () => {
    const records = await store.readHourlyCloses({
      assetIds: [early.assetId],
      fromSeconds: window.fromSeconds,
      toSeconds: window.toSeconds,
    });
    expect(records.get(early.assetId)).toEqual({
      firstAt: t0 - 40 * h,
      priorCloseE18: "80000000000000",
      buckets: [],
    });
    expect(
      fillHourlySparkline24h({
        record: records.get(early.assetId)!,
        fromSeconds: window.fromSeconds,
        endBucket: window.endBucket,
      }),
    ).toEqual(Array.from({ length: 24 }, () => "0.00008"));
  });

  it("answers an empty map for no assets without a query", async () => {
    const records = await store.readHourlyCloses({
      assetIds: [],
      fromSeconds: window.fromSeconds,
      toSeconds: window.toSeconds,
    });
    expect(records.size).toBe(0);
  });
});
