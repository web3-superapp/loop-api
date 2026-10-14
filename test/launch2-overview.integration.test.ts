import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import { projectLaunch2Overview } from "../src/features/launch2/launch2-overview.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0139: the overview reads on a real PostgreSQL — one fact row of
 * each table the activity feed unions, read back in order with the right
 * kind / actor / amount, and the scoreboard totals moving by exactly what
 * the new instance adds. The shared test database persists, so every hash
 * and timestamp is unique to the run and assertions are scoped to it.
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
    [`did:privy:s181:${randomUUID()}`],
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
      // Decision 0131: a LoopDynamic Factory deploys no Hook at deployLaunch.
      zeroAddress,
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
  const curve = (
    await pool.query<{ curve_address: string }>(
      "select curve_address from public.launch2_instances where instance_id = $1",
      [instanceId],
    )
  ).rows[0]!.curve_address;
  return { projectId, instanceId, snapshots, graduationAdapter, curve };
}

const buyer = `0x${"a1".repeat(20)}`;
const seller = `0x${"b2".repeat(20)}`;

describe("Decision 0139: launchpad overview reads", () => {
  it("unions the seven kinds newest first and totals the listed instances", async () => {
    const before = await launch2.listOverviewFacts({ chainId });
    const target = await instance();
    const { instanceId } = target;
    // Later than anything an earlier run (or another suite) wrote: wall
    // seconds × 100, so two runs a second apart are 100 s apart (> the 70 s
    // this run spans) and never interleave.
    const base =
      3_000_000_000 + (Math.floor(Date.now() / 1000) - 1_700_000_000) * 100;
    const at = (offset: number) => new Date((base - offset) * 1000);
    const block = (offset: number) => 9_000_000_000 - offset;
    const facts = (offset: number) => ({
      tx: hex(32),
      blockHash: hex(32),
      block: block(offset),
      at: at(offset),
    });
    const hook = hex(20);

    const buy = facts(10);
    await pool.query(
      `insert into public.launch2_trades (trade_id, chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, side, trader_address,
         meme_amount, usd1_gross, usd1_net, tax_usd1, refund_usd1,
         cumulative_bought, traded_at)
       values ($1, $2, $3, 0, $4, $5, $6, 'buy', $7, 1000, $8, $9, $10, 0, 1000, $11)`,
      [
        randomUUID(),
        chainId,
        buy.tx,
        buy.block,
        buy.blockHash,
        instanceId,
        buyer,
        (22n * wad).toString(),
        (20n * wad).toString(),
        (2n * wad).toString(),
        buy.at,
      ],
    );
    const sell = facts(20);
    await pool.query(
      `insert into public.launch2_trades (trade_id, chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, side, trader_address,
         meme_amount, usd1_gross, usd1_net, tax_usd1, refund_usd1, sold_after,
         traded_at)
       values ($1, $2, $3, 0, $4, $5, $6, 'sell', $7, 500, $8, $9, $10, 0, 500, $11)`,
      [
        randomUUID(),
        chainId,
        sell.tx,
        sell.block,
        sell.blockHash,
        instanceId,
        seller,
        (10n * wad).toString(),
        (9n * wad).toString(),
        wad.toString(),
        sell.at,
      ],
    );
    const mint = facts(30);
    await pool.query(
      `insert into public.launch2_nft_mints (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, payer_address,
         token_id, amount_usd1, minted_at)
       values ($1, $2, 0, $3, $4, $5, $6, 1, $7, $8)`,
      [
        chainId,
        mint.tx,
        mint.block,
        mint.blockHash,
        instanceId,
        buyer,
        (100n * wad).toString(),
        mint.at,
      ],
    );
    const graduation = facts(40);
    await pool.query(
      `update public.launch2_instances
         set graduated_at = $2, graduation_block = $3,
           graduation_transaction_hash = $4, official_pool_id = $5,
           nft_minted_count = 1, buyback_count = 1, buyback_usd1 = $6
       where instance_id = $1`,
      [
        instanceId,
        graduation.at,
        graduation.block,
        graduation.tx,
        hex(32),
        (125n * wad).toString(),
      ],
    );
    const buyback = facts(50);
    await pool.query(
      `insert into public.launch2_buybacks (buyback_id, chain_id,
         transaction_hash, log_index, block_number, block_hash, instance_id,
         outcome, usd1_spent, meme_delivered, executed_at)
       values ($1, $2, $3, 3, $4, $5, $6, 'executed', $7, 77, $8)`,
      [
        randomUUID(),
        chainId,
        buyback.tx,
        buyback.block,
        buyback.blockHash,
        instanceId,
        (125n * wad).toString(),
        buyback.at,
      ],
    );
    // The buyback's own PoolManager swap (same transaction): not a user trade.
    await pool.query(
      `insert into public.launch2_pool_swaps (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, pool_id,
         caller_address, side, usd1_amount, meme_amount, tax_amount, tax_token,
         sqrt_price_x96, price_e18, swapped_at)
       values ($1, $2, 2, $3, $4, $5, $6, $7, 'buy', $8, 77, 0, 'meme', 1, 1, $9)`,
      [
        chainId,
        buyback.tx,
        buyback.block,
        buyback.blockHash,
        instanceId,
        hex(32),
        hex(20),
        (125n * wad).toString(),
        buyback.at,
      ],
    );
    // An anonymous user pool sell (no attribution): actor null, USD1 − fee.
    const swap = facts(55);
    await pool.query(
      `insert into public.launch2_pool_swaps (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, pool_id,
         caller_address, side, usd1_amount, meme_amount, tax_amount, tax_token,
         sqrt_price_x96, price_e18, swapped_at)
       values ($1, $2, 1, $3, $4, $5, $6, $7, 'sell', $8, 500, $9, 'usd1', 1, 1, $10)`,
      [
        chainId,
        swap.tx,
        swap.block,
        swap.blockHash,
        instanceId,
        hex(32),
        hex(20),
        (50n * wad).toString(),
        (3n * wad).toString(),
        swap.at,
      ],
    );
    const round = facts(60);
    await pool.query(
      `insert into public.launch2_dynamic_rounds (instance_id, round_id,
         hook_address, start_candle, carried_in_usd1, extra_fees_usd1,
         total_buy_weight_usd1, claimed_usd1, buyer_count, closed,
         activated_at, activated_block, activated_transaction_hash)
       values ($1, 1, $2, 0, 0, 0, 0, 0, 0, false, $3, $4, $5)`,
      [instanceId, hook, round.at, round.block, round.tx],
    );
    const claim = facts(70);
    await pool.query(
      `insert into public.launch2_dynamic_claims (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, hook_address,
         round_id, buyer_address, amount_usd1, claimed_at)
       values ($1, $2, 0, $3, $4, $5, $6, 1, $7, $8, $9)`,
      [
        chainId,
        claim.tx,
        claim.block,
        claim.blockHash,
        instanceId,
        hook,
        buyer,
        ((5n * wad) / 4n).toString(),
        claim.at,
      ],
    );
    // A removed (reorged) mint never shows.
    const removed = facts(5);
    await pool.query(
      `insert into public.launch2_nft_mints (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, payer_address,
         token_id, amount_usd1, minted_at, removed)
       values ($1, $2, 0, $3, $4, $5, $6, 2, $7, $8, true)`,
      [
        chainId,
        removed.tx,
        removed.block,
        removed.blockHash,
        instanceId,
        buyer,
        (100n * wad).toString(),
        removed.at,
      ],
    );

    const started = performance.now();
    const [activity, after] = await Promise.all([
      launch2.listActivity({ chainId, limit: 30 }),
      launch2.listOverviewFacts({ chainId }),
    ]);
    const elapsedMs = performance.now() - started;
    expect(activity.length).toBeLessThanOrEqual(30);
    const mine = activity.filter((row) => row.instanceId === instanceId);
    expect(
      mine.map((row) => [
        row.kind,
        row.actor,
        row.amountUsd1,
        row.transactionHash,
      ]),
    ).toEqual([
      ["curve_buy", buyer, (22n * wad).toString(), buy.tx],
      ["curve_sell", seller, (9n * wad).toString(), sell.tx],
      ["nft_mint", buyer, (100n * wad).toString(), mint.tx],
      ["graduated", null, null, graduation.tx],
      ["buyback", null, (125n * wad).toString(), buyback.tx],
      ["curve_sell", null, (47n * wad).toString(), swap.tx],
      ["round_activated", null, null, round.tx],
      ["reward_claimed", buyer, ((5n * wad) / 4n).toString(), claim.tx],
    ]);
    // Newest of the whole chain: this run's rows lead the feed.
    expect(activity.slice(0, 8)).toEqual(mine);
    expect(mine[0]).toMatchObject({
      ticker: "MEME",
      name: "Project",
      at: buy.at.toISOString(),
      blockNumber: String(buy.block),
      logIndex: 0,
    });

    expect(after).toHaveLength(before.length + 1);
    const added = after.find((row) => row.instanceId === instanceId);
    expect(added).toMatchObject({
      nftMintedCount: "1",
      buybackUsd1: (125n * wad).toString(),
      graduation: { graduatedAt: graduation.at.toISOString() },
      snapshot: null,
      noHoldersClosure: null,
    });
    const now = new Date(base * 1000);
    const stats = (rows: typeof after) =>
      projectLaunch2Overview({ activity: [], facts: rows, now })[
        "stats"
      ] as Record<string, unknown>;
    const was = stats(before);
    const is = stats(after);
    expect(Number(is["graduatedTotal"])).toBe(
      Number(was["graduatedTotal"]) + 1,
    );
    expect(Number(is["graduatedThisWeek"])).toBe(
      Number(was["graduatedThisWeek"]) + 1,
    );
    expect(Number(is["nftMintedTotal"])).toBe(
      Number(was["nftMintedTotal"]) + 1,
    );
    expect(
      Number(is["buybackUsd1Total"]) - Number(was["buybackUsd1Total"]),
    ).toBeCloseTo(125, 6);
    // Informational: the local timing of both reads (p95 target < 100 ms).
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
