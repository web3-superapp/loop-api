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
 * Decision 0174 on PostgreSQL: the position rows' price / value from the
 * instance read model in one batched instance read (curve `price_e18`
 * before graduation, `pool_last_price_e18` after; null without a pool
 * price), emitted only with LAUNCH2_POSITION_VALUE_EMIT=on; and the public
 * pool trades — user swaps of every wallet (buyback adapter swaps and
 * reorged rows left out), newest first, masked wallets, limit 1–50. The
 * shared test database persists, so every assertion is scoped to the rows
 * this run creates (a fresh holder address per run).
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
const walletId = randomUUID();

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

const holder = hex(20);

async function user(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into public.loop_users (privy_user_id) values ($1) returning id",
    [`did:privy:s280:${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

interface Seeded {
  readonly instanceId: string;
  readonly poolId: string;
  readonly buybackAdapter: string;
}

/** An activated instance (Hooks job + approved config + registry row). */
async function instance(input: {
  readonly graduated: boolean;
  readonly priceE18: bigint;
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
  const poolId = hex(32);
  const buybackAdapter = hex(20);
  await pool.query(
    `insert into public.launch2_instances (
       instance_id, job_id, project_id, config_version, owner_user_id, chain_id,
       factory_address, launch_id, config_hash, project_owner, name, ticker,
       meme_address, hook_address, nft_address, curve_address, gate_address,
       escrow_address, snapshots_address, graduation_adapter_address,
       buyback_adapter_address, price_recorder_address, buyback_executor_address,
       buyback_recipient, nft_sale_start, deploy_block_number, activated_at,
       deployed_event_seen, stage, factory_generation, graduated_at,
       official_pool_id, price_e18, sold_supply
     ) values ($1, $2, $3, 1, $4, $5,
       '0x1111111111111111111111111111111111111111', $6, $7, $8, 'Project',
       'MEME', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       now() - interval '30 days', 1, now() - interval '20 days', true,
       $21, 'v3', $22, $23, $24, $25)`,
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
      buybackAdapter,
      hex(20),
      hex(20),
      draft.buybackRecipient,
      input.graduated ? "graduated" : "public",
      input.graduated ? new Date(Date.now() - 86_400_000) : null,
      input.graduated ? poolId : null,
      input.priceE18.toString(),
      (1_000_000n * wad).toString(),
    ],
  );
  return { instanceId, poolId, buybackAdapter };
}

async function setPoolPrice(target: Seeded, priceE18: bigint) {
  await pool.query(
    `update public.launch2_instances set pool_trade_count = 1,
       pool_buy_count = 1, pool_last_price_e18 = $2, pool_last_trade_at = now()
     where instance_id = $1`,
    [target.instanceId, priceE18.toString()],
  );
}

async function position(target: Seeded, bought: bigint, sold: bigint) {
  await pool.query(
    `insert into public.launch2_positions (instance_id, holder_address,
       curve_bought, curve_sold, cumulative_bought, usd1_spent, usd1_received,
       tax_usd1, buy_count, sell_count, last_activity_at)
     values ($1, $2, $3, $4, $3, 0, 0, 0, 1, 0, now())`,
    [target.instanceId, holder, bought.toString(), sold.toString()],
  );
}

let log = 0;
async function swap(
  target: Seeded,
  input: {
    readonly side: "buy" | "sell";
    readonly block: number;
    readonly wallet: string | null;
    readonly caller?: string;
    readonly removed?: boolean;
    readonly usd1Tax?: bigint;
  },
): Promise<string> {
  log += 2;
  const transactionHash = hex(32);
  const attributed = input.wallet !== null;
  await pool.query(
    `insert into public.launch2_pool_swaps (
       chain_id, transaction_hash, log_index, block_number, block_hash,
       instance_id, removed, pool_id, caller_address, side, usd1_amount,
       meme_amount, tax_amount, tax_token, sqrt_price_x96, price_e18,
       swapped_at, wallet_address, recipient_address, router_amount_in,
       router_amount_out, router_log_index, attribution_source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1,
       $15, now() - make_interval(secs => $16::int), $17, $17, $18, $18, $19,
       $20)`,
    [
      chainId,
      transactionHash,
      log,
      input.block,
      `0x${input.block.toString(16).padStart(64, "0")}`,
      target.instanceId,
      input.removed === true,
      target.poolId,
      input.caller ?? hex(20),
      input.side,
      (10n * wad).toString(),
      (16_000n * wad).toString(),
      (input.usd1Tax ?? 0n).toString(),
      input.side === "buy" ? "meme" : "usd1",
      "625000000000000",
      1_000_000 - input.block,
      input.wallet,
      attributed ? (10n * wad).toString() : null,
      attributed ? log + 1 : null,
      attributed ? "router_swap" : null,
    ],
  );
  return transactionHash;
}

const apps: FastifyInstance[] = [];

async function createApp(env: Readonly<Record<string, string>> = {}) {
  const app = await buildApp({
    config: s7TestConfig({ ...launch2Env, ...env }),
    contractSurface: "v2",
    database: {
      ...s7Database({}),
      launch2,
      accountWallets: walletsFake({ walletId, address: holder }),
    },
    privyAccessTokenVerifier: s7PrivyVerifier(),
    launch2Chain: createFakeLaunch2Chain(
      defaultChainState({ memeBalance: 15_680n * wad, usd1Balance: 0n }),
    ),
    launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds()),
    logger: false,
  });
  apps.push(app);
  return app;
}

const curvePrice = launch2PriceAt(1_000_000n * wad);
let curve: Seeded;
let priced: Seeded;
let unpriced: Seeded;
let traded: Seeded;
let newestHash: string;

beforeAll(async () => {
  curve = await instance({ graduated: false, priceE18: curvePrice });
  priced = await instance({ graduated: true, priceE18: curvePrice });
  await setPoolPrice(priced, 625_000_000_000_000n);
  unpriced = await instance({ graduated: true, priceE18: curvePrice });
  await position(curve, 1_200n * wad, 200n * wad);
  await position(priced, 1_200n * wad, 0n);
  await position(unpriced, 1_200n * wad, 0n);

  traded = await instance({ graduated: true, priceE18: curvePrice });
  // 55 user swaps (blocks 100..154, newest = 154), one anonymous, one
  // sell with a USD1 fee, plus a buyback adapter swap and a reorged swap
  // at newer blocks that must never be listed.
  for (let block = 100; block < 155; block += 1) {
    const hash = await swap(traded, {
      side: block % 2 === 0 ? "buy" : "sell",
      block,
      wallet:
        block === 153 ? null : "0x1234567890abcdef1234567890abcdef1234abcd",
      ...(block === 151 ? { usd1Tax: 2n * wad } : {}),
    });
    if (block === 154) newestHash = hash;
  }
  await swap(traded, {
    side: "buy",
    block: 200,
    wallet: null,
    caller: traded.buybackAdapter,
  });
  await swap(traded, {
    side: "buy",
    block: 201,
    wallet: "0x9999999999999999999999999999999999999999",
    removed: true,
  });
  // S284: keep the pool projection consistent with these facts so suites
  // that recompute it over every graduated instance (000091 in
  // launch2-dynamic) never trip launch2_instances_pool_user_shape.
  await pool.query(
    `update public.launch2_instances i set
       pool_trade_count = f.n, pool_buy_count = f.buys,
       pool_sell_count = f.n - f.buys, pool_buy_volume_usd1 = f.buy_usd1,
       pool_sell_volume_usd1 = f.sell_usd1, pool_last_price_e18 = f.price,
       pool_last_trade_at = f.last, pool_user_trade_count = f.user_n,
       pool_user_buy_volume_usd1 = f.user_buy, pool_user_sell_volume_usd1 = f.user_sell
     from (
       select count(*) as n,
         count(*) filter (where s.side = 'buy') as buys,
         coalesce(sum(s.usd1_amount) filter (where s.side = 'buy'), 0) as buy_usd1,
         coalesce(sum(s.usd1_amount) filter (where s.side = 'sell'), 0) as sell_usd1,
         max(s.price_e18) as price, max(s.swapped_at) as last,
         count(*) filter (where s.caller_address <> $2) as user_n,
         coalesce(sum(s.usd1_amount) filter (where s.side = 'buy' and s.caller_address <> $2), 0) as user_buy,
         coalesce(sum(s.usd1_amount) filter (where s.side = 'sell' and s.caller_address <> $2), 0) as user_sell
       from public.launch2_pool_swaps s
       where s.instance_id = $1 and not s.removed
     ) f
     where i.instance_id = $1`,
    [traded.instanceId, traded.buybackAdapter],
  );
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await pool.end();
});

type Row = Record<string, unknown>;

describe("Decision 0174 on PostgreSQL", () => {
  it("reads several instances in one query", async () => {
    const rows = await launch2.getInstances([
      curve.instanceId,
      priced.instanceId,
      priced.instanceId,
      randomUUID(),
    ]);
    expect(rows.map((row) => row.instanceId).sort()).toEqual(
      [curve.instanceId, priced.instanceId].sort(),
    );
    const byId = new Map(rows.map((row) => [row.instanceId, row]));
    expect(byId.get(curve.instanceId)?.priceE18).toBe(curvePrice.toString());
    expect(byId.get(priced.instanceId)?.pool.lastPriceE18).toBe(
      "625000000000000",
    );
    expect(await launch2.getInstances([])).toEqual([]);
  });

  it("omits price and value keys with the emit switch off", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/launch2/me/positions",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ positions: Row[] }>().positions;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).not.toHaveProperty("priceUsd1");
      expect(row).not.toHaveProperty("valueUsd1");
      expect(row).not.toHaveProperty("priceSource");
    }
  });

  it("prices each row from the read model with the emit switch on", async () => {
    const app = await createApp({ LAUNCH2_POSITION_VALUE_EMIT: "on" });
    const response = await app.inject({
      method: "GET",
      url: "/v2/launch2/me/positions",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const byId = new Map(
      response
        .json<{ positions: Row[] }>()
        .positions.map((row) => [row["instanceId"], row]),
    );
    expect(byId.get(curve.instanceId)).toMatchObject({
      priceUsd1: formatLaunch2Amount(curvePrice),
      valueUsd1: formatLaunch2Amount((1_000n * wad * curvePrice) / wad),
      priceSource: "curve",
    });
    // The same price string as the detail's curve.priceUsd1.
    const detail = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${curve.instanceId}`,
      headers: s7CommonHeaders(),
    });
    expect(
      detail.json<{ instance: { curve: { priceUsd1: string } } }>().instance
        .curve.priceUsd1,
    ).toBe(byId.get(curve.instanceId)?.["priceUsd1"]);
    expect(byId.get(priced.instanceId)).toMatchObject({
      memeBalance: "15680",
      priceUsd1: "0.000625",
      valueUsd1: "9.8",
      priceSource: "pool",
    });
    expect(byId.get(unpriced.instanceId)).toMatchObject({
      memeBalance: "15680",
      priceUsd1: null,
      valueUsd1: null,
      priceSource: null,
    });
  });

  it("lists the public pool trades newest first, user swaps only, masked, capped at 50", async () => {
    const app = await createApp();
    const url = `/v2/launch2/instances/${traded.instanceId}/pool/recent-trades`;
    const headers = s7CommonHeaders({ authorization: undefined });
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: Row[] }>().items;
    expect(items).toHaveLength(20);
    expect(items.map((item) => item["blockNumber"])).toEqual(
      Array.from({ length: 20 }, (_, index) => String(154 - index)),
    );
    expect(items[0]).toMatchObject({
      txHash: newestHash,
      side: "buy",
      memeAmount: "16000",
      usd1Amount: "10",
      priceUsd1: "0.000625",
      wallet: "0x1234…abcd",
    });
    expect(items[1]).toMatchObject({ blockNumber: "153", wallet: null });
    // A sell with a USD1 fee shows what the trader received.
    expect(items[3]).toMatchObject({
      blockNumber: "151",
      side: "sell",
      usd1Amount: "8",
    });
    expect(response.body).not.toContain("1234567890abcdef");

    const all = await app.inject({
      method: "GET",
      url: `${url}?limit=50`,
      headers,
    });
    const fifty = all.json<{ items: Row[] }>().items;
    expect(fifty).toHaveLength(50);
    expect(fifty.at(-1)?.["blockNumber"]).toBe("105");
    expect(
      (await app.inject({ method: "GET", url: `${url}?limit=51`, headers }))
        .statusCode,
    ).toBe(400);

    // Before graduation: no trades, never a query of another instance's.
    const before = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${curve.instanceId}/pool/recent-trades`,
      headers,
    });
    expect(before.json<{ items: Row[] }>().items).toEqual([]);
  });
});
