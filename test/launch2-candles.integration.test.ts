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
import {
  createFakeLaunch2Chain,
  defaultChainState,
  launch2Env,
} from "./helpers/launch2-fakes.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { walletsFake } from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
} from "./helpers/meme-service-fakes.js";
import {
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0171: the candles route on a real PostgreSQL — curve trades at
 * the marginal price after each trade (running sold supply), reorged rows
 * left out, empty buckets flat at the previous close up to now, `before`
 * paging, `limit`, every interval's alignment, and the graduation crossing
 * (curve, then official-pool swaps) as one `mixed` series. The server
 * clock is pinned (`walletIntentNow`), so every bucket is exact.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const launch2 = createPostgresLaunch2Repository(pool);
const chainId = "eip155:97";
const wad = 10n ** 18n;

/** A 5m-, 15m- and 1h-aligned instant (1_800_000_000 = 500,000 h). */
const t0 = 1_800_000_000;
/** The pinned server clock: 1,000 s after t0 (5m bucket t0 + 900). */
const nowSeconds = t0 + 1_000;
const activatedAt = t0 - 86_400;

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
      String(activatedAt),
      graduatedAt === null ? "public" : "graduated",
      graduatedAt === null ? null : String(graduatedAt),
      graduatedAt === null ? null : poolId,
    ],
  );
  return { instanceId, poolId };
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

const price = (sold: bigint) => formatLaunch2Amount(launch2PriceAt(sold));
const startPrice = price(0n);

interface Candle {
  readonly t: number;
  readonly o: string;
  readonly h: string;
  readonly l: string;
  readonly c: string;
  readonly v: string;
  readonly q: string;
  readonly n: number;
}

interface Resource {
  readonly instanceId: string;
  readonly interval: string;
  readonly quoteAsset: string;
  readonly source: string;
  readonly candles: readonly Candle[];
  readonly latest: { readonly price: string; readonly at: number } | null;
  readonly contractVersion: string;
}

const apps: FastifyInstance[] = [];
let app: FastifyInstance;
let empty: Seeded;
let curve: Seeded;
let mixed: Seeded;

beforeAll(async () => {
  empty = await instance(null);
  curve = await instance(null);
  mixed = await instance(t0 + 100);

  // Curve: two buys in bucket t0 (1,000,000 then 500,000 MEME), a sell of
  // 200,000 in bucket t0 + 600, and a reorged buy that must not count.
  await trade(curve, {
    side: "buy",
    meme: 1_000_000n * wad,
    net: 45n * wad,
    at: t0 + 10,
    block: 100,
  });
  await trade(curve, {
    side: "buy",
    meme: 500_000n * wad,
    net: 25n * wad,
    at: t0 + 200,
    block: 101,
  });
  await trade(curve, {
    side: "buy",
    meme: 50_000_000n * wad,
    net: 9_000n * wad,
    at: t0 + 650,
    block: 102,
    removed: true,
  });
  await trade(curve, {
    side: "sell",
    meme: 200_000n * wad,
    net: 9n * wad,
    at: t0 + 700,
    block: 103,
  });

  // Graduation crossing: a curve buy in bucket t0, then two pool swaps in
  // bucket t0 + 300 (the second the higher price).
  await trade(mixed, {
    side: "buy",
    meme: 2_000_000n * wad,
    net: 90n * wad,
    at: t0 + 50,
    block: 200,
  });
  await swap(mixed, {
    side: "buy",
    usd1: 10n * wad,
    meme: 200_000n * wad,
    priceE18: 60_000_000_000_000n,
    at: t0 + 400,
    block: 300,
  });
  await swap(mixed, {
    side: "sell",
    usd1: 3n * wad,
    meme: 50_000n * wad,
    priceE18: 55_000_000_000_000n,
    at: t0 + 450,
    block: 301,
  });
  // The lane's pool projection for those two swaps (the shape constraints
  // and later suites that recompute it over the shared database rely on it).
  await pool.query(
    `update public.launch2_instances set
       pool_trade_count = 2, pool_buy_count = 1, pool_sell_count = 1,
       pool_buy_volume_usd1 = $2, pool_sell_volume_usd1 = $3,
       pool_user_trade_count = 2, pool_user_buy_volume_usd1 = $2,
       pool_user_sell_volume_usd1 = $3, pool_last_price_e18 = $4,
       pool_last_trade_at = to_timestamp($5::bigint)
     where instance_id = $1`,
    [
      mixed.instanceId,
      (10n * wad).toString(),
      (3n * wad).toString(),
      "55000000000000",
      String(t0 + 450),
    ],
  );

  app = await buildApp({
    config: s7TestConfig(launch2Env),
    contractSurface: "v2",
    database: {
      ...s7Database({}),
      launch2,
      accountWallets: walletsFake(),
    },
    privyAccessTokenVerifier: s7PrivyVerifier(),
    launch2Chain: createFakeLaunch2Chain(defaultChainState()),
    launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds({})),
    walletIntentNow: () => new Date(nowSeconds * 1000),
    logger: false,
  });
  apps.push(app);
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((entry) => entry.close()));
  await pool.end();
});

async function candles(target: Seeded, query = ""): Promise<Resource> {
  const response = await app.inject({
    method: "GET",
    url: `/v2/launch2/instances/${target.instanceId}/candles${query}`,
    headers: s7CommonHeaders(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Resource>();
}

describe("launch2 candles on PostgreSQL (Decision 0171)", () => {
  it("answers no trade with no candles and the start price at activation", async () => {
    expect(await candles(empty)).toEqual({
      instanceId: empty.instanceId,
      interval: "5m",
      quoteAsset: "USD1",
      source: "curve",
      candles: [],
      latest: { price: startPrice, at: activatedAt },
      contractVersion: "2.0",
    });
  });

  it("prices curve trades after each trade and fills empty buckets flat", async () => {
    const body = await candles(curve, "?interval=5m");
    const p1 = price(1_000_000n * wad);
    const p2 = price(1_500_000n * wad);
    const p3 = price(1_300_000n * wad);
    expect(body.source).toBe("curve");
    expect(body.candles).toEqual([
      {
        t: t0,
        o: startPrice,
        h: p2,
        l: startPrice,
        c: p2,
        v: "1500000",
        q: "70",
        n: 2,
      },
      { t: t0 + 300, o: p2, h: p2, l: p2, c: p2, v: "0", q: "0", n: 0 },
      { t: t0 + 600, o: p2, h: p2, l: p3, c: p3, v: "200000", q: "9", n: 1 },
      { t: t0 + 900, o: p3, h: p3, l: p3, c: p3, v: "0", q: "0", n: 0 },
    ]);
    expect(p1 < p2).toBe(true);
    expect(body.latest).toEqual({ price: p3, at: t0 + 700 });
  });

  it("pages back with before and keeps the newest `limit` buckets", async () => {
    const before = await candles(curve, `?interval=5m&before=${t0 + 600}`);
    expect(before.candles.map((candle) => candle.t)).toEqual([t0, t0 + 300]);
    // latest is the newest fact regardless of before.
    expect(before.latest?.at).toBe(t0 + 700);
    const limited = await candles(curve, "?interval=5m&limit=2");
    expect(limited.candles.map((candle) => [candle.t, candle.o])).toEqual([
      [t0 + 600, price(1_500_000n * wad)],
      [t0 + 900, price(1_300_000n * wad)],
    ]);
    const nothing = await candles(curve, `?before=${t0}`);
    expect(nothing.candles).toEqual([]);
    // The maximum limit is accepted (the series is shorter).
    const most = await candles(curve, "?interval=1m&limit=500");
    expect(most.candles).toHaveLength(17);
  });

  it("aligns every interval to UTC from the epoch", async () => {
    const minute = await candles(curve, "?interval=1m");
    expect(minute.candles[0]).toMatchObject({ t: t0, n: 1 });
    expect(minute.candles[3]).toMatchObject({ t: t0 + 180, n: 1 });
    expect(minute.candles.at(-1)?.t).toBe(t0 + 960);
    expect(
      minute.candles.every((candle, index) => candle.t === t0 + index * 60),
    ).toBe(true);
    const quarter = await candles(curve, "?interval=15m");
    expect(quarter.candles.map((candle) => [candle.t, candle.n])).toEqual([
      [t0, 3],
      [t0 + 900, 0],
    ]);
    const hour = await candles(curve, "?interval=1h");
    expect(hour.candles).toEqual([
      expect.objectContaining({ t: t0, n: 3, v: "1700000", q: "79" }),
    ]);
    const fourHours = await candles(curve, "?interval=4h");
    expect(fourHours.candles.map((candle) => candle.t)).toEqual([
      Math.floor(t0 / 14_400) * 14_400,
    ]);
    const day = await candles(curve, "?interval=1d");
    expect(day.candles).toEqual([
      expect.objectContaining({
        t: Math.floor(t0 / 86_400) * 86_400,
        o: startPrice,
        c: price(1_300_000n * wad),
        n: 3,
      }),
    ]);
  });

  it("joins the curve and the pool into one mixed series at graduation", async () => {
    const body = await candles(mixed, "?interval=5m");
    const curveClose = price(2_000_000n * wad);
    expect(body.source).toBe("mixed");
    expect(body.candles).toEqual([
      {
        t: t0,
        o: startPrice,
        h: curveClose,
        l: startPrice,
        c: curveClose,
        v: "2000000",
        q: "90",
        n: 1,
      },
      {
        t: t0 + 300,
        o: curveClose,
        h: "0.00006",
        l: curveClose,
        c: "0.000055",
        v: "250000",
        q: "13",
        n: 2,
      },
      {
        t: t0 + 600,
        o: "0.000055",
        h: "0.000055",
        l: "0.000055",
        c: "0.000055",
        v: "0",
        q: "0",
        n: 0,
      },
      {
        t: t0 + 900,
        o: "0.000055",
        h: "0.000055",
        l: "0.000055",
        c: "0.000055",
        v: "0",
        q: "0",
        n: 0,
      },
    ]);
    expect(body.latest).toEqual({ price: "0.000055", at: t0 + 450 });
    // A page of the curve part only, and a page of pool-priced fillers.
    expect((await candles(mixed, `?before=${t0 + 300}`)).source).toBe("curve");
    expect((await candles(mixed, "?limit=2")).source).toBe("pool");
  });

  it("refuses an invalid interval and an unknown instance", async () => {
    const invalid = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${curve.instanceId}/candles?interval=2h`,
      headers: s7CommonHeaders(),
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ detailsSafe: unknown }>().detailsSafe).toEqual({
      reasonCode: "LAUNCH2_CANDLE_INTERVAL_INVALID",
    });
    const unknown = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${randomUUID()}/candles`,
      headers: s7CommonHeaders(),
    });
    expect(unknown.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${curve.instanceId}/candles`,
      headers: s7CommonHeaders({ authorization: undefined }),
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
