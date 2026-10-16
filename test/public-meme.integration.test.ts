import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { formatLaunch2Amount } from "../src/features/launch2/launch2-contract.js";
import { launch2PriceAt } from "../src/features/launch2/launch2-curve-math.js";
import { launch2PublicChangePct } from "../src/features/launch2/launch2-public.js";
import {
  createFakeLaunch2DynamicChain,
  defaultDynamicState,
  dynamicPoolIdFor,
  launch2DynamicHook,
} from "./helpers/launch2-dynamic-fakes.js";
import {
  createFakeLaunch2Chain,
  createFakeLaunch2PoolChain,
  defaultChainState,
  defaultPoolState,
  launch2Env,
  launch2PoolEnv,
} from "./helpers/launch2-fakes.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { walletsFake } from "./helpers/launch-service-fakes.js";
import { s7Database, s7PrivyVerifier, s7TestConfig } from "./s7-route-fakes.js";

/**
 * Decision 0147: the public MEME page read surface on a real PostgreSQL —
 * the facts SQL (bound community, curve tax, pool output tax, last closed
 * round, 24 h reference price and sold supply), the three candle sources
 * (curve trades at the marginal price, pool swaps, LoopDynamic Hook
 * candles priced with the lane's stored orientation), served through the
 * real routes. The Hook itself is the in-memory fake.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const launch2 = createPostgresLaunch2Repository(pool);
const chainId = "eip155:97";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const wad = 10n ** 18n;
/** The fake LoopDynamic chain's MEME (its Hook answers for this token). */
const fixtureMeme = `0x${"a".repeat(36)}6666`;
const q96 = 2n ** 96n;

const draft = parseHooksLaunchDraft(
  {
    name: "Project",
    ticker: "MEME",
    logoAssetUrl: "https://example.com/logo.png",
    description: "Test",
    links: ["https://x.com/project", "https://project.example"],
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
    [`did:privy:s203:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

interface Seeded {
  readonly instanceId: string;
  readonly meme: string;
  readonly poolId: string;
}

/** An activated instance (Hooks job + approved config + registry row). */
async function instance(input: {
  readonly meme: string;
  readonly hook: string;
  readonly graduatedHoursAgo: number | null;
  readonly dynamicHook?: string;
}): Promise<Seeded> {
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
  const poolId =
    input.dynamicHook === undefined ? hex(32) : dynamicPoolIdFor(input.meme);
  const graduated = input.graduatedHoursAgo !== null;
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation, graduated_at,
       official_pool_id, dynamic_hook_address, dynamic_pool_id,
       dynamic_hook_bound_block
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'Project', 'MEME', $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
       now() - interval '9 days', 1, now() - interval '2 seconds', true,
       $22, 'v3',
       case when $23::int is null then null
         else now() - make_interval(hours => $23::int) end,
       $24, $25, $26, $27)`,
    [
      instanceId,
      job.jobId,
      projectId,
      owner,
      chainId,
      "0x1111111111111111111111111111111111111111",
      hex(32),
      draft.configHash,
      hex(20),
      input.meme,
      input.hook,
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
      graduated ? "graduated" : "public",
      input.graduatedHoursAgo,
      graduated ? poolId : null,
      input.dynamicHook ?? null,
      input.dynamicHook === undefined ? null : poolId,
      input.dynamicHook === undefined ? null : "10",
    ],
  );
  return { instanceId, meme: input.meme, poolId };
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
    side: "buy" | "sell";
    meme: bigint;
    gross: bigint;
    tax: bigint;
    hoursAgo: number;
    block: number;
  },
) {
  await pool.query(
    `insert into public.launch2_trades (
       trade_id, chain_id, transaction_hash, log_index, block_number,
       block_hash, instance_id, side, trader_address, meme_amount,
       usd1_gross, usd1_net, tax_usd1, refund_usd1, cumulative_bought,
       sold_after, traded_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0,
       $14, $15, date_trunc('minute', now()) - make_interval(hours => $16::int))`,
    [
      randomUUID(),
      ...fact(input.block),
      target.instanceId,
      input.side,
      hex(20),
      input.meme.toString(),
      input.gross.toString(),
      (input.gross - input.tax).toString(),
      input.tax.toString(),
      input.side === "buy" ? input.meme.toString() : null,
      input.side === "sell" ? "0" : null,
      input.hoursAgo,
    ],
  );
}

async function swap(
  target: Seeded,
  input: {
    side: "buy" | "sell";
    usd1: bigint;
    meme: bigint;
    tax: bigint;
    priceE18: bigint;
    at: string;
    block: number;
  },
) {
  await pool.query(
    `insert into public.launch2_pool_swaps (
       chain_id, transaction_hash, log_index, block_number, block_hash,
       instance_id, pool_id, caller_address, side, usd1_amount, meme_amount,
       tax_amount, tax_token, sqrt_price_x96, price_e18, swapped_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14,
       $15::timestamptz)`,
    [
      ...fact(input.block),
      target.instanceId,
      target.poolId,
      hex(20),
      input.side,
      input.usd1.toString(),
      input.meme.toString(),
      input.tax.toString(),
      input.side === "buy" ? "meme" : "usd1",
      input.priceE18.toString(),
      input.at,
    ],
  );
}

const apps: FastifyInstance[] = [];
let app: FastifyInstance;
let curve: Seeded;
let official: Seeded;
let dynamic: Seeded;
let communityId: string;
/** The LoopDynamic Hook candle (5-minute id) two hours ago. */
let candleId: bigint;

beforeAll(async () => {
  curve = await instance({
    meme: `${hex(18)}6666`,
    hook: hex(20),
    graduatedHoursAgo: null,
  });
  official = await instance({
    meme: `${hex(18)}6666`,
    hook: hex(20),
    graduatedHoursAgo: 30,
  });
  dynamic = await instance({
    meme: fixtureMeme,
    hook: zeroAddress,
    graduatedHoursAgo: 3,
    dynamicHook: launch2DynamicHook,
  });

  // Curve: 1,000 MEME bought 30 h ago (before the 24 h cutoff), then 2,000
  // bought and 500 sold an hour ago.
  await trade(curve, {
    side: "buy",
    meme: 1_000n * wad,
    gross: 11n * wad,
    tax: wad,
    hoursAgo: 30,
    block: 100,
  });
  await trade(curve, {
    side: "buy",
    meme: 2_000n * wad,
    gross: 22n * wad,
    tax: 2n * wad,
    hoursAgo: 1,
    block: 200,
  });
  await trade(curve, {
    side: "sell",
    meme: 500n * wad,
    gross: 5n * wad,
    tax: wad / 2n,
    hoursAgo: 1,
    block: 201,
  });
  await pool.query(
    "update public.launch2_instances set sold_supply = $2, price_e18 = $3 where instance_id = $1",
    [
      curve.instanceId,
      (2_500n * wad).toString(),
      launch2PriceAt(2_500n * wad).toString(),
    ],
  );

  // OfficialTax pool: a swap 26 h ago (the 24 h reference) and one now.
  const ago = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  await swap(official, {
    side: "buy",
    usd1: 10n * wad,
    meme: 20_000n * wad,
    tax: 400n * wad,
    priceE18: 500n * 10n ** 12n,
    at: ago(26),
    block: 300,
  });
  await swap(official, {
    side: "sell",
    usd1: 4n * wad,
    meme: 5_000n * wad,
    tax: wad / 10n,
    priceE18: 600n * 10n ** 12n,
    at: ago(1),
    block: 301,
  });
  await pool.query(
    "update public.launch2_instances set pool_last_price_e18 = $2, pool_last_trade_at = now() - interval '1 hour', pool_trade_count = 2, pool_buy_count = 1, pool_sell_count = 1 where instance_id = $1",
    [official.instanceId, (600n * 10n ** 12n).toString()],
  );

  // LoopDynamic: the lane's Swap event carries the orientation (USD1 0x22…
  // sorts first: MEME is currency1), one Hook candle with two swaps inside.
  candleId = BigInt(Math.floor(Date.now() / 1000 / 300)) - 24n;
  const candleStart = new Date(Number(candleId * 300n) * 1000);
  const inCandle = (seconds: number) =>
    new Date(candleStart.getTime() + seconds * 1000).toISOString();
  await pool.query(
    `insert into public.launch2_events (chain_id, transaction_hash, log_index,
       block_number, block_hash, instance_id, contract_address, event_name,
       payload, event_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'Swap', $8::jsonb, now())`,
    [
      ...fact(400),
      dynamic.instanceId,
      hex(20),
      JSON.stringify({ memeIsCurrency0: "false", id: dynamic.poolId }),
    ],
  );
  await swap(dynamic, {
    side: "buy",
    usd1: 3n * wad,
    meme: 5_000n * wad,
    tax: 100n * wad,
    priceE18: 700n * 10n ** 12n,
    at: inCandle(10),
    block: 401,
  });
  await swap(dynamic, {
    side: "sell",
    usd1: 2n * wad,
    meme: 4_000n * wad,
    tax: wad / 25n,
    priceE18: 450n * 10n ** 12n,
    at: inCandle(200),
    block: 402,
  });
  await pool.query(
    `insert into public.launch2_dynamic_candles (chain_id, transaction_hash,
       log_index, block_number, block_hash, instance_id, hook_address,
       candle_id, open_sqrt_price_x96, close_sqrt_price_x96, closed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      ...fact(403),
      dynamic.instanceId,
      launch2DynamicHook,
      candleId.toString(),
      (40n * q96).toString(),
      (50n * q96).toString(),
    ],
  );
  await pool.query(
    `insert into public.launch2_dynamic_rounds (instance_id, round_id,
       hook_address, start_candle, end_candle, carried_in_usd1,
       extra_fees_usd1, total_buy_weight_usd1, allocation_usd1,
       next_carry_usd1, claimed_usd1, buyer_count, closed, activated_at,
       activated_block, activated_transaction_hash, closed_at, closed_block,
       closed_transaction_hash)
     values ($1, 1, $2, 10, 12, 0, $3, $4, $5, $5, $6, 2, true,
       now() - interval '2 hours', 410, $7, '2027-01-15T06:00:00Z', 420, $8),
       ($1, 2, $2, 20, null, $5, 0, 0, null, null, 0, 0, false,
       now() - interval '1 hour', 430, $9, null, null, null)`,
    [
      dynamic.instanceId,
      launch2DynamicHook,
      (8n * wad).toString(),
      (100n * wad).toString(),
      (4n * wad).toString(),
      wad.toString(),
      hex(32),
      hex(32),
      hex(32),
    ],
  );
  await pool.query(
    `insert into public.launch2_dynamic_fees (chain_id, transaction_hash,
       log_index, block_number, block_hash, instance_id, hook_address, side,
       fee_token, round_id, buyer_address, gross_amount, base_fee, extra_fee,
       drop_wad, charged_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'sell', 'usd1', 1, null, $8, $9, $10,
       $11, now())`,
    [
      ...fact(402),
      dynamic.instanceId,
      launch2DynamicHook,
      (100n * wad).toString(),
      (2n * wad).toString(),
      (8n * wad).toString(),
      (wad / 10n).toString(),
    ],
  );
  await pool.query(
    `insert into public.launch2_dynamic_fees (chain_id, transaction_hash,
       log_index, block_number, block_hash, instance_id, hook_address, side,
       fee_token, round_id, buyer_address, gross_amount, base_fee, extra_fee,
       drop_wad, charged_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'buy', 'meme', null, $8, $9, $10, 0, 0,
       now())`,
    [
      ...fact(401),
      dynamic.instanceId,
      launch2DynamicHook,
      hex(20),
      (5_000n * wad).toString(),
      (100n * wad).toString(),
    ],
  );

  // The community bound to the LoopDynamic MEME, plus a rejected one that
  // claims the same asset (never shown).
  const creator = await user();
  // The fake Hook fixes the MEME address, so a previous run's communities
  // would claim the same asset key.
  await pool.query(
    "delete from public.communities where bound_asset_key = $1 and slug like 's203-%'",
    [`${chainId}:${fixtureMeme}`],
  );
  communityId = randomUUID();
  for (const [id, status] of [
    [randomUUID(), "rejected"],
    [communityId, "verified"],
  ] as const) {
    await pool.query(
      `insert into public.communities (community_id, name,
         slug, description, verification_status, bound_asset_key,
         member_count, config_version, created_by_user_id, verified_at,
         reviewed_at)
       values ($1, $2, $3, $4, $5, $6, 42, 'communityV1', $7,
         case when $5 = 'verified' then now() end,
         now())`,
      [
        id,
        status === "verified" ? "Frog Club" : "Fake Club",
        `s203-${id.slice(0, 8)}`,
        "Hop together. We like frogs.",
        status,
        `${chainId}:${fixtureMeme}`,
        creator,
      ],
    );
  }

  app = await buildApp({
    config: s7TestConfig({ ...launch2Env, ...launch2PoolEnv }),
    contractSurface: "runtime",
    database: {
      ...s7Database({}),
      launch2,
      accountWallets: walletsFake(),
    },
    privyAccessTokenVerifier: s7PrivyVerifier(),
    launch2Chain: createFakeLaunch2Chain(defaultChainState()),
    launch2PoolChain: createFakeLaunch2PoolChain(defaultPoolState()),
    launch2DynamicChain: createFakeLaunch2DynamicChain(defaultDynamicState()),
    logger: false,
  });
  apps.push(app);
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((entry) => entry.close()));
  await pool.end();
});

const get = (url: string) => app.inject({ method: "GET", url });

describe("Decision 0147: public MEME read surface on PostgreSQL", () => {
  it("lists the instances with the bound community and the live Hook state", async () => {
    const response = await get("/public/v1/meme?limit=50");
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    const items = response.json<{ items: Record<string, unknown>[] }>().items;
    const byId = new Map(items.map((item) => [item["instanceId"], item]));
    expect(byId.get(dynamic.instanceId)).toMatchObject({
      stage: "graduated",
      memeTokenAddress: fixtureMeme,
      communityName: "Frog Club",
      dynamic: { armed: true, currentDynamicTaxBps: 3000 },
      dynamicReasonCode: null,
    });
    expect(byId.get(official.instanceId)).toMatchObject({
      communityName: null,
      dynamic: null,
      lastPriceUsd1: "0.0006",
    });
    expect(byId.get(curve.instanceId)).toMatchObject({
      stage: "snapshot_pending",
    });
    const curveOnly = (await get("/public/v1/meme?stage=curve")).json<{
      items: Record<string, unknown>[];
    }>().items;
    expect(curveOnly.map((item) => item["instanceId"])).toContain(
      curve.instanceId,
    );
    expect(curveOnly.every((item) => item["stage"] !== "graduated")).toBe(true);
  });

  it("aggregates the LoopDynamic MEME's facts with one SQL", async () => {
    const response = await get(`/public/v1/meme/${dynamic.instanceId}`);
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, Record<string, unknown>>>();
    expect(body["instance"]).toMatchObject({
      hookAddress: launch2DynamicHook,
      poolId: dynamic.poolId,
      description: "Test",
      socials: {
        website: "https://project.example/",
        x: "https://x.com/project",
        telegram: null,
      },
    });
    expect(body["community"]).toEqual({
      communityId,
      name: "Frog Club",
      slogan: "Hop together. We like frogs.",
      description: "Hop together. We like frogs.",
      memberCount: 42,
      verified: true,
      avatarUrl: null,
    });
    expect(body["dynamic"]).toMatchObject({
      armed: true,
      pendingPotUsd1: "45",
      lastClosedRound: {
        roundId: "1",
        closedAt: "2027-01-15T06:00:00.000Z",
        allocationUsd1: "4",
        buyerCount: 2,
      },
    });
    expect(body["totals"]).toMatchObject({
      curveTaxUsd1: "0",
      poolBaseBuyFeeMeme: "100",
      poolBaseSellFeeUsd1: "2",
      dynamicFeesUsd1: "8",
      rewardsAllocatedUsd1: "4",
      rewardsClaimedUsd1: "1",
    });
  });

  it("aggregates the curve and OfficialTax pool facts", async () => {
    const curveBody = (await get(`/public/v1/meme/${curve.instanceId}`)).json<
      Record<string, Record<string, unknown>>
    >();
    expect(curveBody["totals"]).toMatchObject({
      curveTaxUsd1: "3.5",
      poolBaseBuyFeeMeme: "0",
      totalTaxUsd1Equivalent: "3.5",
    });
    expect(curveBody["dynamic"]).toBeNull();
    // Last = the projection's p(2,500 sold); reference = p(1,000 sold), the
    // sold supply of the trades at or before the 24 h cutoff.
    expect(curveBody["price"]).toMatchObject({
      lastPriceUsd1: formatLaunch2Amount(launch2PriceAt(2_500n * wad)),
      change24hPct: launch2PublicChangePct(
        launch2PriceAt(2_500n * wad),
        launch2PriceAt(1_000n * wad),
      ),
    });

    const officialBody = (
      await get(`/public/v1/meme/${official.instanceId}`)
    ).json<Record<string, Record<string, unknown>>>();
    expect(officialBody["price"]).toMatchObject({
      lastPriceUsd1: "0.0006",
      change24hPct: "20.00",
    });
    expect(officialBody["totals"]).toMatchObject({
      poolBaseBuyFeeMeme: "400",
      poolBaseSellFeeUsd1: "0.1",
      dynamicFeesUsd1: "0",
      // 0.1 + 400 MEME × 0.0006.
      totalTaxUsd1Equivalent: "0.34",
    });
  });

  it("prices the curve candles at the marginal price after each trade", async () => {
    const response = await get(`/public/v1/meme/${curve.instanceId}/candles`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      source: string;
      candles: Record<string, string | null>[];
    }>();
    expect(body.source).toBe("curve");
    expect(body.candles).toHaveLength(2);
    const p = (sold: bigint) => formatLaunch2Amount(launch2PriceAt(sold));
    expect(body.candles[0]).toMatchObject({
      o: p(1_000n * wad),
      c: p(1_000n * wad),
      v: "11",
    });
    expect(body.candles[1]).toMatchObject({
      o: p(3_000n * wad),
      h: p(3_000n * wad),
      l: p(2_500n * wad),
      c: p(2_500n * wad),
      v: "27",
    });
    const limited = await get(
      `/public/v1/meme/${curve.instanceId}/candles?interval=5m&limit=1`,
    );
    expect(
      limited.json<{ candles: Record<string, string>[] }>().candles,
    ).toEqual([body.candles[1]]);
  });

  it("serves the pool swaps and the Hook's own candles", async () => {
    const officialBody = (
      await get(`/public/v1/meme/${official.instanceId}/candles`)
    ).json<{ source: string; candles: Record<string, string | null>[] }>();
    expect(officialBody.source).toBe("pool");
    expect(officialBody.candles.map((candle) => candle["c"])).toEqual([
      "0.0005",
      "0.0006",
    ]);
    expect(officialBody.candles[1]).toMatchObject({ v: "4" });

    const dynamicBody = (
      await get(`/public/v1/meme/${dynamic.instanceId}/candles`)
    ).json<{ source: string; candles: Record<string, string | null>[] }>();
    expect(dynamicBody.source).toBe("pool");
    expect(dynamicBody.candles).toEqual([
      {
        t: new Date(Number(candleId * 300n) * 1000).toISOString(),
        // sqrtP 40·2^96 / 50·2^96, MEME = currency1: 1 / 40² and 1 / 50².
        o: "0.000625",
        h: "0.0007",
        l: "0.0004",
        c: "0.0004",
        v: "5",
      },
    ]);
    const refused = await get(
      `/public/v1/meme/${dynamic.instanceId}/candles?interval=15m`,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({
      code: "INVALID_REQUEST",
      reasonCode: "PUBLIC_CANDLE_INTERVAL_UNSUPPORTED",
    });
  });
});
