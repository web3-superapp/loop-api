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
 * Decision 0176 on PostgreSQL: the moving-average cost / PnL of a wallet's
 * positions from its curve trades (`launch2_trades`) then its attributed
 * official-pool user swaps (`launch2_pool_swaps`, router amounts; buyback
 * and reorged rows left out), replayed in chain order from one read;
 * emitted only with LAUNCH2_PNL_EMIT=on, on the position rows and the
 * instance detail's viewer. The shared test database persists, so every
 * assertion is scoped to the rows this run creates (a fresh holder).
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
    [`did:privy:s284:${randomUUID()}`],
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
async function curveTrade(
  target: Seeded,
  input: {
    readonly side: "buy" | "sell";
    readonly block: number;
    readonly meme: bigint;
    readonly reserve: bigint;
    readonly tax: bigint;
    readonly removed?: boolean;
  },
) {
  log += 1;
  const buy = input.side === "buy";
  await pool.query(
    `insert into public.launch2_trades (
       trade_id, chain_id, transaction_hash, log_index, block_number,
       block_hash, instance_id, removed, side, trader_address, meme_amount,
       usd1_gross, usd1_net, tax_usd1, refund_usd1, cumulative_bought,
       sold_after, traded_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0,
       $15, $16, now())`,
    [
      randomUUID(),
      chainId,
      hex(32),
      log,
      input.block,
      `0x${input.block.toString(16).padStart(64, "0")}`,
      target.instanceId,
      input.removed === true,
      input.side,
      holder,
      input.meme.toString(),
      (input.reserve + input.tax).toString(),
      input.reserve.toString(),
      input.tax.toString(),
      buy ? input.meme.toString() : null,
      buy ? null : "0",
    ],
  );
}

async function poolSwap(
  target: Seeded,
  input: {
    readonly side: "buy" | "sell";
    readonly block: number;
    /** Router amounts: what the wallet paid / received. */
    readonly amountIn: bigint;
    readonly amountOut: bigint;
    readonly caller?: string;
    readonly removed?: boolean;
  },
) {
  log += 2;
  const buy = input.side === "buy";
  await pool.query(
    `insert into public.launch2_pool_swaps (
       chain_id, transaction_hash, log_index, block_number, block_hash,
       instance_id, removed, pool_id, caller_address, side, usd1_amount,
       meme_amount, tax_amount, tax_token, sqrt_price_x96, price_e18,
       swapped_at, wallet_address, recipient_address, router_amount_in,
       router_amount_out, router_log_index, attribution_source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, 1,
       625000000000000, now(), $14, $14, $15, $16, $17, 'router_swap')`,
    [
      chainId,
      hex(32),
      log,
      input.block,
      `0x${input.block.toString(16).padStart(64, "0")}`,
      target.instanceId,
      input.removed === true,
      target.poolId,
      input.caller ?? hex(20),
      input.side,
      (buy ? input.amountIn : input.amountOut + 1n).toString(),
      (buy ? input.amountOut + 1n : input.amountIn).toString(),
      buy ? "meme" : "usd1",
      holder,
      input.amountIn.toString(),
      input.amountOut.toString(),
      log + 1,
    ],
  );
}

/** Curve: buy 1 200 MEME for 1.2 USD1 (1.188 + 0.012 tax), sell 200 for 0.25 net. */
async function curveHistory(target: Seeded) {
  await curveTrade(target, {
    side: "buy",
    block: 100,
    meme: 1_200n * wad,
    reserve: 1_188n * milli,
    tax: 12n * milli,
  });
  await curveTrade(target, {
    side: "sell",
    block: 101,
    meme: 200n * wad,
    reserve: 250n * milli,
    tax: 3n * milli,
  });
  // A reorged buy never counts.
  await curveTrade(target, {
    side: "buy",
    block: 102,
    meme: 999n * wad,
    reserve: 999n * wad,
    tax: 0n,
    removed: true,
  });
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

const milli = 10n ** 15n;
const curvePrice = launch2PriceAt(1_000_000n * wad);
const poolPrice = 625_000_000_000_000n;
let curve: Seeded;
let graduated: Seeded;
let unpriced: Seeded;
let quiet: Seeded;

beforeAll(async () => {
  curve = await instance({ graduated: false, priceE18: curvePrice });
  graduated = await instance({ graduated: true, priceE18: curvePrice });
  await setPoolPrice(graduated, poolPrice);
  unpriced = await instance({ graduated: true, priceE18: curvePrice });
  quiet = await instance({ graduated: false, priceE18: curvePrice });
  for (const target of [curve, graduated, unpriced, quiet]) {
    await position(target, 1_200n * wad, 200n * wad);
  }
  // The pool swap is inserted first: chain order, not insertion order.
  await poolSwap(graduated, {
    side: "buy",
    block: 300,
    amountIn: 9n * wad,
    amountOut: 14_680n * wad,
  });
  // Buyback adapter swap and a reorged swap of the wallet: left out.
  await poolSwap(graduated, {
    side: "sell",
    block: 301,
    amountIn: 5_000n * wad,
    amountOut: 1n * wad,
    caller: graduated.buybackAdapter,
  });
  await poolSwap(graduated, {
    side: "sell",
    block: 302,
    amountIn: 5_000n * wad,
    amountOut: 1n * wad,
    removed: true,
  });
  await curveHistory(curve);
  await curveHistory(graduated);
  await curveHistory(unpriced);
  // Keep the instance's pool projection consistent with the facts above
  // (one user buy of 9 USD1, one buyback sell; the reorged swap does not
  // count) so suites that recompute it (000091) never trip its checks.
  await pool.query(
    `update public.launch2_instances set pool_trade_count = 2,
       pool_buy_count = 1, pool_sell_count = 1, pool_buy_volume_usd1 = $2,
       pool_sell_volume_usd1 = $3, pool_user_trade_count = 1,
       pool_user_buy_volume_usd1 = $2, pool_user_sell_volume_usd1 = 0
     where instance_id = $1`,
    [graduated.instanceId, (9n * wad).toString(), (1n * wad + 1n).toString()],
  );
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await pool.end();
});

type Row = Record<string, unknown>;
const pnlKeys = [
  "avgCostUsd1",
  "costBasisUsd1",
  "costCoverage",
  "realizedPnlUsd1",
  "unrealizedPnlUsd1",
];

async function positions(app: FastifyInstance): Promise<Map<unknown, Row>> {
  const response = await app.inject({
    method: "GET",
    url: "/v2/launch2/me/positions",
    headers: s7CommonHeaders(),
  });
  expect(response.statusCode).toBe(200);
  return new Map(
    response
      .json<{ positions: Row[] }>()
      .positions.map((row) => [row["instanceId"], row]),
  );
}

describe("Decision 0176 on PostgreSQL", () => {
  it("reads the wallet's curve trades and user pool swaps in chain order, router amounts", async () => {
    const rows = await launch2.listCostTrades({
      holderAddresses: [holder.toUpperCase().replace("0X", "0x")],
      instanceId: graduated.instanceId,
    });
    expect(
      rows.map((row) => [
        row.source,
        row.side,
        row.memeAmount,
        row.usd1Amount,
        row.blockNumber,
      ]),
    ).toEqual([
      [
        "curve",
        "buy",
        (1_200n * wad).toString(),
        (1_200n * milli).toString(),
        "100",
      ],
      [
        "curve",
        "sell",
        (200n * wad).toString(),
        (250n * milli).toString(),
        "101",
      ],
      ["pool", "buy", (14_680n * wad).toString(), (9n * wad).toString(), "300"],
    ]);
    const all = await launch2.listCostTrades({
      holderAddresses: [holder],
      instanceId: null,
    });
    expect(new Set(all.map((row) => row.instanceId))).toEqual(
      new Set([curve.instanceId, graduated.instanceId, unpriced.instanceId]),
    );
    expect(all).toHaveLength(7);
    expect(
      await launch2.listCostTrades({ holderAddresses: [], instanceId: null }),
    ).toEqual([]);
  });

  it("omits the keys with LAUNCH2_PNL_EMIT off", async () => {
    const byId = await positions(await createApp());
    expect(byId.size).toBe(4);
    for (const row of byId.values()) {
      for (const key of pnlKeys) expect(row).not.toHaveProperty(key);
    }
  });

  it("emits cost and PnL on the curve, after graduation, partial and empty rows", async () => {
    const app = await createApp({
      LAUNCH2_PNL_EMIT: "on",
      LAUNCH2_POSITION_VALUE_EMIT: "on",
    });
    const byId = await positions(app);
    // Curve: avg 0.001 (tax included), 0.05 realized on 200 sold for 0.25,
    // 1 000 held (curve.net) at the S280 curve price.
    const curveRow = byId.get(curve.instanceId)!;
    expect(curveRow).toMatchObject({
      priceUsd1: formatLaunch2Amount(curvePrice),
      avgCostUsd1: "0.001",
      costBasisUsd1: "1",
      realizedPnlUsd1: "0.05",
      unrealizedPnlUsd1: formatLaunch2Amount(
        ((curvePrice - milli) * 1_000n * wad) / wad,
      ),
      costCoverage: "full",
    });
    // Graduated: + 14 680 for 9 USD1 → 15 680 for 10 (= memeBalance).
    const avg = (10n * wad * wad) / (15_680n * wad);
    expect(byId.get(graduated.instanceId)).toMatchObject({
      memeBalance: "15680",
      priceUsd1: "0.000625",
      avgCostUsd1: formatLaunch2Amount(avg),
      costBasisUsd1: "10",
      realizedPnlUsd1: "0.05",
      unrealizedPnlUsd1: formatLaunch2Amount(
        ((poolPrice - avg) * 15_680n * wad) / wad,
      ),
      costCoverage: "full",
    });
    // 1 000 traded, 15 680 held: partial; no pool price → no unrealized.
    expect(byId.get(unpriced.instanceId)).toMatchObject({
      priceUsd1: null,
      avgCostUsd1: "0.001",
      costBasisUsd1: "1",
      unrealizedPnlUsd1: null,
      costCoverage: "partial",
    });
    const quietRow = byId.get(quiet.instanceId)!;
    for (const key of pnlKeys) expect(quietRow[key]).toBeNull();

    // The detail's viewer carries the same values, priced at the same
    // curve.priceUsd1 the row's priceUsd1 (S280) shows.
    const detail = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${curve.instanceId}`,
      headers: s7CommonHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    const instance = detail.json<{
      instance: { curve: { priceUsd1: string }; viewer: Row };
    }>().instance;
    expect(instance.curve.priceUsd1).toBe(curveRow["priceUsd1"]);
    for (const key of pnlKeys) {
      expect(instance.viewer[key]).toEqual(curveRow[key]);
    }
    const graduatedDetail = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${graduated.instanceId}`,
      headers: s7CommonHeaders(),
    });
    const graduatedViewer = graduatedDetail.json<{
      instance: { viewer: Row };
    }>().instance.viewer;
    const graduatedRow = byId.get(graduated.instanceId)!;
    for (const key of pnlKeys) {
      expect(graduatedViewer[key]).toEqual(graduatedRow[key]);
    }
  });
});
