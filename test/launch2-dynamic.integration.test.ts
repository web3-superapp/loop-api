import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresLaunch2Repository } from "../src/database/launch2-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import type { Launch2LaneEvent } from "../src/features/launch2/launch2-ports.js";
import { testnetLoopDynamicParams } from "./helpers/hooks-launch-loop-dynamic-fixtures.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0131 (migration 000076): the LoopDynamic read model on a real
 * PostgreSQL — the registry-derived hook kind, the Hook binding, typed fee
 * / candle / claim facts, the round and buy-weight projections, a reorg
 * rewind that undoes them, the wallet reward rows, and the append-only
 * claim report.
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

const hook = `0x${"c".repeat(36)}10c4`;
/** 8 hex characters unique to this run (see `event`). */
const runTag = hex(4).slice(2);
const buyerA = `0x${"a1".repeat(20)}`;
const buyerB = `0x${"b2".repeat(20)}`;

function event(
  target: { readonly instanceId: string },
  contractAddress: string,
  eventName: Launch2LaneEvent["eventName"],
  args: Record<string, string>,
  blockNumber: number,
  logIndex: number,
): Launch2LaneEvent {
  return {
    instanceId: target.instanceId,
    contractAddress,
    eventName,
    args,
    // Unique per run: the facts are keyed (chain, tx, log) and the shared
    // test database persists, so a fixed hash would land on the previous
    // run's rows (another instance) and leave this one unprojected.
    transactionHash: `0x${runTag}${blockNumber.toString(16).padStart(8, "0")}${"0".repeat(48)}`,
    logIndex,
    blockNumber: String(blockNumber),
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    at: String(1_800_000_000 + blockNumber),
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

describe("Decision 0131: LoopDynamic read model (000076)", () => {
  it("derives the hook kind, projects rounds / weights / fees / claims, and undoes them on a rewind", async () => {
    const target = await instance();
    const kind = await pool.query<{ pool_hook_kind: string }>(
      "select pool_hook_kind from public.launch2_instances where instance_id = $1",
      [target.instanceId],
    );
    expect(kind.rows[0]?.pool_hook_kind).toBe("loopDynamic");
    const poolId = `0x${"42".repeat(32)}`;
    const e = (
      address: string,
      name: Launch2LaneEvent["eventName"],
      args: Record<string, string>,
      block: number,
      index = 0,
    ) => event(target, address, name, args, block, index);
    await commit(
      [
        e(target.graduationAdapter, "LoopHookBound", { hook, poolId }, 1000),
        e(
          hook,
          "CandleClosed",
          {
            candle: "500",
            openSqrtPriceX96: "1000",
            closeSqrtPriceX96: "800",
          },
          1001,
        ),
        e(
          hook,
          "RoundActivated",
          { round: "1", startCandle: "501", carriedQuote: "0" },
          1001,
          1,
        ),
        e(
          hook,
          "BuyCredited",
          { round: "1", buyer: buyerA, quoteSpent: (30n * wad).toString() },
          1002,
        ),
        e(
          hook,
          "BuyFeeCharged",
          {
            buyer: buyerA,
            grossMeme: (1_600n * wad).toString(),
            fee: (32n * wad).toString(),
          },
          1002,
          1,
        ),
        e(
          hook,
          "BuyCredited",
          { round: "1", buyer: buyerB, quoteSpent: (70n * wad).toString() },
          1003,
        ),
        e(
          hook,
          "SellFeeCharged",
          {
            round: "1",
            grossQuote: (100n * wad).toString(),
            baseFee: (2n * wad).toString(),
            extraFee: (29n * wad).toString(),
            dropWad: ((3n * wad) / 10n).toString(),
          },
          1004,
        ),
      ],
      1004,
    );
    const bound = await launch2.getInstance(target.instanceId);
    expect(bound?.poolHookKind).toBe("loopDynamic");
    expect(bound?.dynamicPool).toEqual({ hook, poolId, boundBlock: "1000" });
    const lane = (await launch2.listLaneInstances(chainId)).find(
      (row) => row.instanceId === target.instanceId,
    );
    expect(lane?.dynamicHook).toBe(hook);
    let rewardsA = await launch2.listDynamicRewards({
      instanceId: target.instanceId,
      walletAddress: buyerA,
      limit: 10,
    });
    expect(rewardsA).toEqual([
      expect.objectContaining({
        roundId: "1",
        closed: false,
        weightUsd1: (30n * wad).toString(),
        totalBuyWeightUsd1: (100n * wad).toString(),
        extraFeesUsd1: (29n * wad).toString(),
        allocationUsd1: null,
      }),
    ]);

    await commit(
      [
        e(
          hook,
          "RoundClosed",
          {
            round: "1",
            endCandle: "504",
            rewardAllocation: ((145n * wad) / 10n).toString(),
            nextCarry: ((145n * wad) / 10n).toString(),
          },
          1010,
        ),
        e(
          hook,
          "RewardClaimed",
          {
            round: "1",
            buyer: buyerA,
            amount: ((435n * wad) / 100n).toString(),
          },
          1011,
        ),
      ],
      1011,
    );
    rewardsA = await launch2.listDynamicRewards({
      instanceId: target.instanceId,
      walletAddress: buyerA,
      limit: 10,
    });
    expect(rewardsA[0]).toMatchObject({
      closed: true,
      endCandle: "504",
      allocationUsd1: ((145n * wad) / 10n).toString(),
      claimedAmountUsd1: ((435n * wad) / 100n).toString(),
    });
    const summary = await launch2.dynamicRoundSummary(target.instanceId);
    expect(summary).toMatchObject({
      roundCount: 1,
      closedRoundCount: 1,
      allocatedUsd1: ((145n * wad) / 10n).toString(),
      claimedUsd1: ((435n * wad) / 100n).toString(),
      extraFeesUsd1: (29n * wad).toString(),
      baseSellFeesUsd1: (2n * wad).toString(),
      buyFeesMeme: (32n * wad).toString(),
      lastRound: { roundId: "1", closed: true },
    });
    const claimTx = event(
      target,
      hook,
      "RewardClaimed",
      {},
      1011,
      0,
    ).transactionHash;
    expect(
      await launch2.findDynamicClaim({
        instanceId: target.instanceId,
        transactionHash: claimTx,
        roundId: "1",
        buyer: buyerA,
      }),
    ).toMatchObject({
      amountUsd1: ((435n * wad) / 100n).toString(),
      blockNumber: "1011",
    });
    const candles = await pool.query(
      "select candle_id::text from public.launch2_dynamic_candles where instance_id = $1 and not removed",
      [target.instanceId],
    );
    expect(candles.rows).toEqual([{ candle_id: "500" }]);

    // A reorg from block 1010: the close and the claim are gone again.
    await commit([], 1012, 1010);
    rewardsA = await launch2.listDynamicRewards({
      instanceId: target.instanceId,
      walletAddress: buyerA,
      limit: 10,
    });
    expect(rewardsA[0]).toMatchObject({
      closed: false,
      allocationUsd1: null,
      claimedAmountUsd1: null,
    });
    expect(
      await launch2.findDynamicClaim({
        instanceId: target.instanceId,
        transactionHash: claimTx,
        roundId: "1",
        buyer: buyerA,
      }),
    ).toBeNull();
    // A deeper reorg removes the binding itself.
    await commit([], 1013, 1000);
    const unbound = await launch2.getInstance(target.instanceId);
    expect(unbound?.dynamicPool).toBeNull();
    expect(
      await launch2.listDynamicRewards({
        instanceId: target.instanceId,
        walletAddress: buyerA,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("projects S193 closes: a round ended at a skipped empty candle and an activate-then-close in one roll (Decision 0144)", async () => {
    const target = await instance();
    const poolId = `0x${"43".repeat(32)}`;
    const e = (
      address: string,
      name: Launch2LaneEvent["eventName"],
      args: Record<string, string>,
      block: number,
      index = 0,
    ) => event(target, address, name, args, block, index);
    await commit(
      [
        e(target.graduationAdapter, "LoopHookBound", { hook, poolId }, 2000),
        // Candle 600 crashes: round 1 from 601.
        e(
          hook,
          "CandleClosed",
          { candle: "600", openSqrtPriceX96: "1000", closeSqrtPriceX96: "800" },
          2001,
        ),
        e(
          hook,
          "RoundActivated",
          { round: "1", startCandle: "601", carriedQuote: "0" },
          2001,
          1,
        ),
        e(
          hook,
          "BuyCredited",
          { round: "1", buyer: buyerA, quoteSpent: (10n * wad).toString() },
          2002,
        ),
        // One roll: 601 closes red (continues), 602–603 are empty; the
        // round ends at 602 — a candle with no CandleClosed of its own.
        e(
          hook,
          "CandleClosed",
          { candle: "601", openSqrtPriceX96: "800", closeSqrtPriceX96: "790" },
          2003,
        ),
        e(
          hook,
          "EmptyCandlesSkipped",
          { first: "602", count: "2", flatSqrtPriceX96: "790" },
          2003,
          1,
        ),
        e(
          hook,
          "RoundClosed",
          {
            round: "1",
            endCandle: "602",
            rewardAllocation: "0",
            nextCarry: "0",
          },
          2003,
          2,
        ),
        // Candle 604 crashes and 605 is empty: activated and closed in the
        // same roll (start = end, nothing to allocate, carry unchanged).
        e(
          hook,
          "CandleClosed",
          { candle: "604", openSqrtPriceX96: "790", closeSqrtPriceX96: "600" },
          2004,
        ),
        e(
          hook,
          "RoundActivated",
          { round: "2", startCandle: "605", carriedQuote: "0" },
          2004,
          1,
        ),
        e(
          hook,
          "EmptyCandlesSkipped",
          { first: "605", count: "1", flatSqrtPriceX96: "600" },
          2004,
          2,
        ),
        e(
          hook,
          "RoundClosed",
          {
            round: "2",
            endCandle: "605",
            rewardAllocation: "0",
            nextCarry: "0",
          },
          2004,
          3,
        ),
      ],
      2004,
    );
    const rounds = await pool.query<{
      round_id: string;
      start_candle: string;
      end_candle: string | null;
      closed: boolean;
      allocation_usd1: string | null;
      total_buy_weight_usd1: string;
    }>(
      `select round_id::text, start_candle::text, end_candle::text, closed,
         allocation_usd1::text, total_buy_weight_usd1::text
       from public.launch2_dynamic_rounds where instance_id = $1
       order by round_id`,
      [target.instanceId],
    );
    expect(rounds.rows).toEqual([
      {
        round_id: "1",
        start_candle: "601",
        end_candle: "602",
        closed: true,
        allocation_usd1: "0",
        total_buy_weight_usd1: (10n * wad).toString(),
      },
      {
        round_id: "2",
        start_candle: "605",
        end_candle: "605",
        closed: true,
        allocation_usd1: "0",
        total_buy_weight_usd1: "0",
      },
    ]);
    expect(await launch2.dynamicRoundSummary(target.instanceId)).toMatchObject({
      roundCount: 2,
      closedRoundCount: 2,
      lastRound: { roundId: "2" },
    });
  });

  it("keeps an OfficialTax instance's hook kind and refuses a Hook binding shape on it", async () => {
    const target = await instance();
    await pool.query(
      "update public.launch2_instances set hook_address = $2 where instance_id = $1",
      [target.instanceId, `0x${"bb".repeat(20)}`],
    );
    const row = await launch2.getInstance(target.instanceId);
    expect(row?.poolHookKind).toBe("officialTax");
    expect(row?.dynamicPool).toBeNull();
    await expect(
      pool.query(
        "update public.launch2_instances set dynamic_hook_address = $2, dynamic_pool_id = $3, dynamic_hook_bound_block = 1 where instance_id = $1",
        [target.instanceId, hook, `0x${"42".repeat(32)}`],
      ),
    ).rejects.toThrow(/launch2_instances_dynamic_hook_shape/u);
  });

  it("records a dynamic_claim report once (same / conflict) and keeps it append-only", async () => {
    const target = await instance();
    const owner = (
      await pool.query<{ owner_user_id: string }>(
        "select owner_user_id::text from public.launch2_instances where instance_id = $1",
        [target.instanceId],
      )
    ).rows[0]!.owner_user_id;
    const intentId = randomUUID();
    const walletId = randomUUID();
    const created = await launch2.createIntent({
      ownerUserId: owner,
      idempotencyKey: randomUUID(),
      requestSha256: "a".repeat(64),
      canaryAdmission: () => null,
      build: () =>
        Promise.resolve({
          intentId,
          ownerUserId: owner,
          instanceId: target.instanceId,
          walletId,
          walletAddress: buyerA,
          kind: "dynamic_claim",
          chainId,
          contractAddress: hook,
          amountIn: "0",
          expectedOut: (12n * wad).toString(),
          minOut: "0",
          taxUsd1: "0",
          refundUsd1: "0",
          deadline: new Date(1_900_000_000_000).toISOString(),
          snapshotBlockNumber: "1",
          snapshotBlockHash: `0x${"11".repeat(32)}`,
          calldata: { to: hook, data: "0x", value: "0" },
          unsignedTransaction: { chainId: 97 },
          approval: null,
          policy: { valueUsd: "12", dynamicClaim: { roundId: "1", hook } },
          payloadDigest: "b".repeat(64),
          expiresAt: new Date(1_900_000_000_000).toISOString(),
        }),
    });
    expect(created.intent.kind).toBe("dynamic_claim");
    expect(
      await launch2.getDynamicClaimIntent({ intentId, ownerUserId: owner }),
    ).toMatchObject({ intentId, kind: "dynamic_claim" });
    expect(
      await launch2.getDynamicClaimIntent({
        intentId,
        ownerUserId: randomUUID(),
      }),
    ).toBeNull();
    const report = {
      intentId,
      ownerUserId: owner,
      instanceId: target.instanceId,
      walletId,
      walletAddress: buyerA,
      roundId: "1",
      transactionHash: `0x${"cd".repeat(32)}`,
    };
    expect((await launch2.recordDynamicClaimReport(report)).outcome).toBe(
      "created",
    );
    expect((await launch2.recordDynamicClaimReport(report)).outcome).toBe(
      "same",
    );
    expect(
      (
        await launch2.recordDynamicClaimReport({
          ...report,
          transactionHash: `0x${"ef".repeat(32)}`,
        })
      ).outcome,
    ).toBe("conflict");
    await expect(
      pool.query(
        "delete from public.launch2_dynamic_claim_reports where intent_id = $1",
        [intentId],
      ),
    ).rejects.toThrow(/append-only/u);
  });
});

describe("Decision 0132: LoopDynamic wallet attribution and MEME coverage degradation (000077)", () => {
  it("stores a tx.from attribution without a router log and lists it as the wallet's pool trade", async () => {
    const target = await instance();
    const poolId = `0x${"43".repeat(32)}`;
    const swap = {
      ...event(
        target,
        `0x${"8".repeat(40)}`,
        "Swap",
        {
          id: poolId,
          sender: `0x${"7".repeat(40)}`,
          amount0: "-100",
          amount1: "160000",
          sqrtPriceX96: (2n ** 96n).toString(10),
          liquidity: "1",
          tick: "0",
          fee: "2500",
          memeIsCurrency0: "false",
          poolHookKind: "loopDynamic",
          dynamicFee: "3200",
          attributionSource: "transactionSender",
          routerPayer: buyerA,
          routerRecipient: buyerA,
          routerAmountIn: "100",
          routerAmountOut: "156800",
        },
        5_000,
        3,
      ),
      // Unique per run: the shared test database keeps earlier runs' facts.
      transactionHash: hex(32),
    };
    await commit([swap], 5_000);
    const row = await pool.query<{
      wallet_address: string;
      attribution_source: string;
      router_log_index: number | null;
      tax_amount: string;
    }>(
      `select wallet_address, attribution_source, router_log_index,
         tax_amount::text from public.launch2_pool_swaps
       where instance_id = $1`,
      [target.instanceId],
    );
    expect(row.rows).toEqual([
      {
        wallet_address: buyerA,
        attribution_source: "transaction_sender",
        router_log_index: null,
        tax_amount: "3200",
      },
    ]);
    const trades = await launch2.listPoolTrades({
      instanceId: target.instanceId,
      walletAddress: buyerA,
      limit: 10,
    });
    expect(trades).toEqual([
      expect.objectContaining({
        side: "buy",
        amountIn: "100",
        amountOut: "156800",
        recipientAddress: buyerA,
        taxAmount: "3200",
      }),
    ]);
    // Re-indexing the same swap keeps the attribution and its source.
    await commit(
      [{ ...swap, args: { ...swap.args, routerPayer: buyerB } }],
      5_000,
    );
    const again = await pool.query<{ wallet_address: string }>(
      "select wallet_address from public.launch2_pool_swaps where instance_id = $1",
      [target.instanceId],
    );
    expect(again.rows[0]?.wallet_address).toBe(buyerA);
    // The shape: a sender attribution never carries a router log index.
    await expect(
      pool.query(
        `update public.launch2_pool_swaps set router_log_index = 9
         where instance_id = $1`,
        [target.instanceId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // An anonymous LoopDynamic swap (no attribution) stays unattributed.
    await commit(
      [
        {
          ...event(
            target,
            `0x${"8".repeat(40)}`,
            "Swap",
            {
              id: poolId,
              sender: `0x${"6".repeat(40)}`,
              amount0: "-50",
              amount1: "80000",
              sqrtPriceX96: (2n ** 96n).toString(10),
              liquidity: "1",
              tick: "0",
              fee: "2500",
              memeIsCurrency0: "false",
              poolHookKind: "loopDynamic",
              dynamicFee: "0",
            },
            5_001,
            1,
          ),
          transactionHash: hex(32),
        },
      ],
      5_001,
    );
    const anonymous = await pool.query<{
      wallet_address: string | null;
      attribution_source: string | null;
    }>(
      `select wallet_address, attribution_source from public.launch2_pool_swaps
       where instance_id = $1 and block_number = 5001`,
      [target.instanceId],
    );
    expect(anonymous.rows).toEqual([
      { wallet_address: null, attribution_source: null },
    ]);
  });

  it("counts a LoopDynamic buyback routed through the LoopRouter as a buyback, not a user trade (Decision 0158, 000091)", async () => {
    const target = await instance();
    const poolId = `0x${"58".repeat(32)}`;
    const router = `0x${"7c".repeat(20)}`;
    const swapArgs = (amount0: string) => ({
      id: poolId,
      // Every LoopDynamic swap, the buyback's included, reaches the
      // PoolManager through the shared LoopRouter.
      sender: router,
      amount0,
      amount1: "160000",
      sqrtPriceX96: (2n ** 96n).toString(10),
      liquidity: "1",
      tick: "0",
      fee: "2500",
      memeIsCurrency0: "false",
      poolHookKind: "loopDynamic",
      dynamicFee: "0",
    });
    const graduated = {
      ...event(
        target,
        target.curve,
        "Graduated",
        { officialPoolId: poolId, soldSupply: "1", usd1Reserve: "1" },
        7_000,
        0,
      ),
      transactionHash: hex(32),
    };
    const buybackTx = hex(32);
    const buybackSwap = {
      ...event(
        target,
        `0x${"8".repeat(40)}`,
        "Swap",
        swapArgs("-100"),
        7_001,
        2,
      ),
      transactionHash: buybackTx,
    };
    const buyback = {
      ...event(
        target,
        `0x${"9".repeat(40)}`,
        "BuybackCompleted",
        {
          usd1Spent: "100",
          memeDelivered: "160000",
          successfulAt: "1800007001",
        },
        7_001,
        5,
      ),
      transactionHash: buybackTx,
    };
    const userSwaps = [7_002, 7_003].map((block) => ({
      ...event(
        target,
        `0x${"8".repeat(40)}`,
        "Swap",
        swapArgs("-50"),
        block,
        1,
      ),
      transactionHash: hex(32),
    }));
    await commit([graduated, buybackSwap, buyback, ...userSwaps], 7_003);
    const counts = async () =>
      (
        await pool.query<{
          trades: string;
          user: string;
          user_buy: string;
        }>(
          `select pool_trade_count::text as trades,
             pool_user_trade_count::text as "user",
             pool_user_buy_volume_usd1::text as user_buy
           from public.launch2_instances where instance_id = $1`,
          [target.instanceId],
        )
      ).rows[0];
    // tradeCount - userTradeCount = the executed buybacks.
    expect(await counts()).toEqual({ trades: "3", user: "2", user_buy: "100" });
    // The 000091 backfill applies the same rule to an existing row.
    await pool.query(
      `update public.launch2_instances
         set pool_user_trade_count = pool_trade_count
       where instance_id = $1`,
      [target.instanceId],
    );
    const { up } =
      await import("../migrations/000091_launch2_pool_user_trades_buyback_tx.js");
    const statements: string[] = [];
    up({ sql: (text: string) => statements.push(text) } as never);
    await pool.query(statements[0]!);
    expect((await counts())?.user).toBe("2");
  });

  it("stores an S209 Hook's USD1 buy fee next to a pre-S209 MEME one (Decision 0152, 000090)", async () => {
    const target = await instance();
    const s209Hook = `0x${"d".repeat(36)}10cc`;
    const poolId = `0x${"44".repeat(32)}`;
    const swapTx = hex(32);
    const swap = {
      ...event(
        target,
        `0x${"8".repeat(40)}`,
        "Swap",
        {
          id: poolId,
          sender: `0x${"7".repeat(40)}`,
          // The pool swapped 98 USD1 (100 paid − 2 USD1 fee).
          amount0: (-98n * wad).toString(),
          amount1: (97n * wad).toString(),
          sqrtPriceX96: (2n ** 96n).toString(10),
          liquidity: "1",
          tick: "0",
          fee: "2500",
          memeIsCurrency0: "false",
          poolHookKind: "loopDynamic",
          dynamicFee: (2n * wad).toString(),
          dynamicFeeToken: "usd1",
          attributionSource: "transactionSender",
          routerPayer: buyerA,
          routerRecipient: buyerA,
          routerAmountIn: (100n * wad).toString(),
          routerAmountOut: (97n * wad).toString(),
        },
        6_000,
        1,
      ),
      transactionHash: swapTx,
    };
    const fees = [
      // S209: (round, buyer, grossQuote, fee), USD1; round 0 = unarmed,
      // buyer 0 = an unattributed tier-3 buy.
      event(
        target,
        s209Hook,
        "BuyFeeCharged",
        {
          round: "0",
          buyer: buyerA,
          grossQuote: (100n * wad).toString(),
          fee: (2n * wad).toString(),
        },
        6_000,
        3,
      ),
      event(
        target,
        s209Hook,
        "BuyFeeCharged",
        {
          round: "4",
          buyer: zeroAddress,
          grossQuote: (50n * wad).toString(),
          fee: wad.toString(),
        },
        6_000,
        5,
      ),
      // Pre-S209: (buyer, grossMeme, fee), MEME.
      event(
        target,
        hook,
        "BuyFeeCharged",
        {
          buyer: buyerB,
          grossMeme: (1_000n * wad).toString(),
          fee: (20n * wad).toString(),
        },
        6_000,
        7,
      ),
    ];
    await commit([swap, ...fees], 6_000);
    const rows = await pool.query<{
      fee_token: string;
      round_id: string | null;
      buyer_address: string;
      gross_amount: string;
      base_fee: string;
    }>(
      `select fee_token, round_id::text, buyer_address, gross_amount::text,
         base_fee::text
       from public.launch2_dynamic_fees
       where instance_id = $1 and side = 'buy' order by log_index`,
      [target.instanceId],
    );
    expect(rows.rows).toEqual([
      {
        fee_token: "usd1",
        round_id: "0",
        buyer_address: buyerA,
        gross_amount: (100n * wad).toString(),
        base_fee: (2n * wad).toString(),
      },
      {
        fee_token: "usd1",
        round_id: "4",
        buyer_address: zeroAddress,
        gross_amount: (50n * wad).toString(),
        base_fee: wad.toString(),
      },
      {
        fee_token: "meme",
        round_id: null,
        buyer_address: buyerB,
        gross_amount: (1_000n * wad).toString(),
        base_fee: (20n * wad).toString(),
      },
    ]);
    expect(await launch2.dynamicRoundSummary(target.instanceId)).toMatchObject({
      buyFeesMeme: (20n * wad).toString(),
      buyFeesUsd1: (3n * wad).toString(),
    });
    const swapRow = await pool.query<{
      usd1_amount: string;
      tax_amount: string;
      tax_token: string;
    }>(
      `select usd1_amount::text, tax_amount::text, tax_token
       from public.launch2_pool_swaps where instance_id = $1`,
      [target.instanceId],
    );
    // The buyer paid pool input + fee; the fee is USD1.
    expect(swapRow.rows).toEqual([
      {
        usd1_amount: (100n * wad).toString(),
        tax_amount: (2n * wad).toString(),
        tax_token: "usd1",
      },
    ]);
    const facts = await launch2.getPublicMemeFacts?.({
      instanceIds: [target.instanceId],
      since: new Date(0).toISOString(),
    });
    expect(facts?.[0]).toMatchObject({
      poolTaxUsd1: (2n * wad).toString(),
      poolTaxMeme: "0",
    });
    // 000090: a USD1 buy row without a round, and a sell taxed in MEME,
    // are still refused.
    await expect(
      pool.query(
        `insert into public.launch2_dynamic_fees (
           chain_id, transaction_hash, log_index, block_number, block_hash,
           instance_id, hook_address, side, fee_token, round_id,
           buyer_address, gross_amount, base_fee, extra_fee, drop_wad,
           charged_at)
         values ($1, $2, 0, 1, $3, $4, $5, 'buy', 'usd1', null, $6, 1, 0, 0,
           0, now())`,
        [chainId, hex(32), hex(32), target.instanceId, s209Hook, buyerA],
      ),
    ).rejects.toThrow(/launch2_dynamic_fees_side_shape/u);
    await expect(
      pool.query(
        `insert into public.launch2_pool_swaps (
           chain_id, transaction_hash, log_index, block_number, block_hash,
           instance_id, pool_id, caller_address, side, usd1_amount,
           meme_amount, tax_amount, tax_token, sqrt_price_x96, price_e18,
           swapped_at)
         values ($1, $2, 0, 1, $3, $4, $5, $6, 'sell', 1, 1, 0, 'meme', 1, 1,
           now())`,
        [chainId, hex(32), hex(32), target.instanceId, poolId, buyerA],
      ),
    ).rejects.toThrow(/launch2_pool_swaps_tax_side/u);
  });

  it("stores a LoopDynamic config version (000078) and refuses any other poolHookKind", async () => {
    const owner = await user();
    const projectId = randomUUID();
    await pool.query(
      "insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at) values ($1, $2, 'Project', 'MEME', 'approved', now(), now())",
      [projectId, owner],
    );
    const dynamicDraft = parseHooksLaunchDraft(
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
        nftSaleDurationSeconds: 3_600,
        loopDynamic: testnetLoopDynamicParams,
      },
    );
    const saved = await configs.saveOwnedDraft({
      projectId,
      ownerUserId: owner,
      expectedVersion: 0,
      templateVersion: dynamicDraft.templateVersion,
      configHash: dynamicDraft.configHash,
      config: dynamicDraft,
      updatedByUserId: owner,
    });
    expect(saved.config.poolHookKind).toBe("loopDynamic");
    expect(saved.config.templateHash).toBe(dynamicDraft.templateHash);
    await expect(
      configs.saveOwnedDraft({
        projectId,
        ownerUserId: owner,
        expectedVersion: saved.version,
        templateVersion: dynamicDraft.templateVersion,
        configHash: dynamicDraft.configHash,
        config: {
          ...dynamicDraft,
          poolHookKind: "other",
        } as unknown as typeof dynamicDraft,
        updatedByUserId: owner,
      }),
    ).rejects.toThrow();
  });

  it("reads the ledger below a block and degrades one instance's coverage in the segment's transaction", async () => {
    const target = await instance();
    const other = await instance();
    const meme = (
      await pool.query<{ meme_address: string }>(
        "select meme_address from public.launch2_instances where instance_id = $1",
        [target.instanceId],
      )
    ).rows[0]!.meme_address;
    expect(meme).toMatch(/6666$/u);
    const transfer = (
      from: string,
      to: string,
      amount: string,
      block: number,
      logIndex: number,
    ) => ({
      instanceId: target.instanceId,
      from,
      to,
      amount,
      transactionHash: hex(32),
      logIndex,
      blockNumber: String(block),
      blockHash: `0x${block.toString(16).padStart(64, "0")}`,
      at: String(1_800_000_000 + block),
    });
    await launch2.commitSegment({
      chainId,
      events: [],
      checkpoint: {
        lastBlockNumber: "6010",
        lastBlockHash: `0x${(6010).toString(16).padStart(64, "0")}`,
        startedFromBlockNumber: "1",
      },
      activationGraceBlocks: 15,
      memeTransfers: [
        transfer(zeroAddress, target.curve, "1000", 6_000, 0),
        transfer(target.curve, buyerA, "300", 6_005, 1),
        transfer(buyerA, buyerB, "100", 6_010, 2),
      ],
    });
    const ledger = await launch2.memeLedgerBalances!({
      chainId,
      instanceId: target.instanceId,
      addresses: [
        target.curve.toUpperCase().replace("0X", "0x"),
        buyerA,
        buyerB,
      ],
      beforeBlockNumber: "6010",
    });
    expect(ledger).toEqual({
      balances: { [target.curve]: "700", [buyerA]: "300", [buyerB]: "0" },
      supply: "1000",
    });

    await pool.query(
      `update public.launch2_instances
       set meme_transfers_target_block = 6000,
         meme_transfers_complete_at = now(),
         meme_transfers_coverage_failures = 0
       where instance_id = any($1::uuid[])`,
      [[target.instanceId, other.instanceId]],
    );
    const coverage = async (instanceId: string) =>
      (
        await pool.query<{
          complete: boolean;
          failures: number;
          target: string | null;
        }>(
          `select meme_transfers_complete_at is not null as complete,
             meme_transfers_coverage_failures as failures,
             meme_transfers_target_block::text as target
           from public.launch2_instances where instance_id = $1`,
          [instanceId],
        )
      ).rows[0];
    const degrade = (
      kind: "retry" | "stalled" | "unverified",
      failedAttempts: number,
    ) =>
      launch2.commitSegment({
        chainId,
        events: [],
        checkpoint: {
          lastBlockNumber: "6020",
          lastBlockHash: `0x${(6020).toString(16).padStart(64, "0")}`,
          startedFromBlockNumber: "1",
        },
        activationGraceBlocks: 15,
        memeCoverageDegraded: [
          { instanceId: target.instanceId, kind, failedAttempts },
        ],
      });
    await degrade("unverified", 0);
    expect(await coverage(target.instanceId)).toEqual({
      complete: false,
      failures: 0,
      target: "6000",
    });
    // Nothing recorded for a pending verdict.
    await launch2.recordMemeCoverage({
      chainId,
      verdicts: [{ kind: "pending", instanceId: target.instanceId }],
    });
    expect((await coverage(target.instanceId))?.complete).toBe(false);
    await degrade("retry", 1);
    expect(await coverage(target.instanceId)).toEqual({
      complete: false,
      failures: 1,
      target: null,
    });
    await pool.query(
      "update public.launch2_instances set meme_transfers_target_block = 6000 where instance_id = $1",
      [target.instanceId],
    );
    await degrade("stalled", 3);
    expect(await coverage(target.instanceId)).toEqual({
      complete: false,
      failures: 3,
      target: "6000",
    });
    // The other instance is untouched.
    expect(await coverage(other.instanceId)).toEqual({
      complete: true,
      failures: 0,
      target: "6000",
    });
    // The lane reports the failure counter on its instance list.
    const lane = await launch2.listLaneInstances(chainId);
    expect(
      lane.find((entry) => entry.instanceId === target.instanceId)
        ?.memeTransfersCoverageFailures,
    ).toBe(3);
  });
});

describe("Decision 0146: delivery attribution read model (000086)", () => {
  const carol = `0x${"c3".repeat(20)}`;
  const alice = `0x${"a7".repeat(20)}`;
  const router = `0x${"e4".repeat(20)}`;
  const usd = (n: bigint) => (n * wad).toString();

  async function bound(offset: number) {
    const target = await instance();
    const poolId = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const e = (
      name: Launch2LaneEvent["eventName"],
      args: Record<string, string>,
      block: number,
      index = 0,
    ) =>
      event(
        target,
        name === "LoopHookBound" ? target.graduationAdapter : hook,
        name,
        args,
        block + offset,
        index,
      );
    await commit(
      [
        e("LoopHookBound", { hook, poolId }, 2000),
        e(
          "RoundActivated",
          { round: "1", startCandle: "10", carriedQuote: "0" },
          2001,
        ),
      ],
      2001 + offset,
    );
    return { target, e };
  }

  async function weights(instanceId: string) {
    const rows = await pool.query<{
      round_id: string;
      buyer_address: string;
      weight_usd1: string;
      credited_usd1: string;
      moved_in_usd1: string;
      moved_out_usd1: string;
    }>(
      `select round_id::text, buyer_address, weight_usd1::text,
         credited_usd1::text, moved_in_usd1::text, moved_out_usd1::text
       from public.launch2_dynamic_buy_weights where instance_id = $1
       order by round_id, buyer_address`,
      [instanceId],
    );
    return rows.rows;
  }

  async function conserved(instanceId: string) {
    const rows = await pool.query<{ round_id: string; ok: boolean }>(
      `select r.round_id::text,
         r.total_buy_weight_usd1 = coalesce((select sum(w.weight_usd1)
           from public.launch2_dynamic_buy_weights w
           where w.instance_id = r.instance_id and w.round_id = r.round_id), 0)
         and r.buyer_count = (select count(*) from public.launch2_dynamic_buy_weights w
           where w.instance_id = r.instance_id and w.round_id = r.round_id) as ok
       from public.launch2_dynamic_rounds r where r.instance_id = $1`,
      [instanceId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((row) => row.ok)).toBe(true);
  }

  it("moves weight in full, in part and several times within a round, never across rounds, and conserves the total", async () => {
    const offset = 100;
    const { target, e } = await bound(offset);
    await commit(
      [
        // Aggregator takes 100 and forwards all of it to carol.
        e(
          "BuyCredited",
          {
            round: "1",
            buyer: router,
            quoteSpent: usd(100n),
            attribution: "delivery",
          },
          2002,
          5,
        ),
        e(
          "CreditMoved",
          { round: "1", from: router, to: carol, quoteSpent: usd(100n) },
          2002,
          7,
        ),
        // Aggregator takes 50, keeps 10 %: 45 to alice.
        e(
          "BuyCredited",
          {
            round: "1",
            buyer: router,
            quoteSpent: usd(50n),
            attribution: "delivery",
          },
          2003,
          5,
        ),
        e(
          "CreditMoved",
          { round: "1", from: router, to: alice, quoteSpent: usd(45n) },
          2003,
          7,
        ),
        // A chain: alice gets 30 by LoopRouter, forwards 20 to carol, carol 5 back.
        e(
          "BuyCredited",
          {
            round: "1",
            buyer: alice,
            quoteSpent: usd(30n),
            attribution: "loopRouter",
          },
          2004,
          2,
        ),
        e(
          "CreditMoved",
          { round: "1", from: alice, to: carol, quoteSpent: usd(20n) },
          2005,
          3,
        ),
        e(
          "CreditMoved",
          { round: "1", from: carol, to: alice, quoteSpent: usd(5n) },
          2005,
          6,
        ),
      ],
      2005 + offset,
    );
    expect(await weights(target.instanceId)).toEqual([
      {
        round_id: "1",
        buyer_address: alice,
        weight_usd1: usd(60n),
        credited_usd1: usd(30n),
        moved_in_usd1: usd(50n),
        moved_out_usd1: usd(20n),
      },
      {
        round_id: "1",
        buyer_address: carol,
        weight_usd1: usd(115n),
        credited_usd1: "0",
        moved_in_usd1: usd(120n),
        moved_out_usd1: usd(5n),
      },
      {
        round_id: "1",
        buyer_address: router,
        weight_usd1: usd(5n),
        credited_usd1: usd(150n),
        moved_in_usd1: "0",
        moved_out_usd1: usd(145n),
      },
    ]);
    await conserved(target.instanceId);

    // Round 2: carol's round-2 move touches round 2 only.
    await commit(
      [
        e(
          "RoundClosed",
          {
            round: "1",
            endCandle: "12",
            rewardAllocation: usd(18n),
            nextCarry: "0",
          },
          2010,
        ),
        e(
          "RoundActivated",
          { round: "2", startCandle: "20", carriedQuote: "0" },
          2011,
        ),
        e(
          "BuyCredited",
          {
            round: "2",
            buyer: carol,
            quoteSpent: usd(40n),
            attribution: "registryRouter",
          },
          2012,
          2,
        ),
        e(
          "CreditMoved",
          { round: "2", from: carol, to: router, quoteSpent: usd(40n) },
          2012,
          4,
        ),
      ],
      2012 + offset,
    );
    const all = await weights(target.instanceId);
    expect(
      all.filter((row) => row.round_id === "1").map((row) => row.weight_usd1),
    ).toEqual([usd(60n), usd(115n), usd(5n)]);
    // Carol forwarded her whole round-2 weight: no row left for her.
    expect(all.filter((row) => row.round_id === "2")).toEqual([
      {
        round_id: "2",
        buyer_address: router,
        weight_usd1: usd(40n),
        credited_usd1: "0",
        moved_in_usd1: usd(40n),
        moved_out_usd1: "0",
      },
    ]);
    await conserved(target.instanceId);

    const rewards = await launch2.listDynamicRewards({
      instanceId: target.instanceId,
      walletAddress: carol,
      limit: 10,
    });
    expect(rewards.map((row) => [row.roundId, row.weightUsd1])).toEqual([
      ["1", usd(115n)],
    ]);
    expect(
      rewards[0]!.entries.map((entry) => [
        entry.direction,
        entry.attribution,
        entry.counterparty,
        entry.amountUsd1,
      ]),
    ).toEqual([
      ["out", "moved", alice, usd(5n)],
      ["in", "moved", alice, usd(20n)],
      ["in", "moved", router, usd(100n)],
    ]);
    const buyers = await launch2.listDynamicRoundBuyers({
      instanceId: target.instanceId,
      roundId: "1",
      limit: 2,
    });
    expect(buyers.buyerCount).toBe(3);
    expect(
      buyers.buyers.map((buyer) => [
        buyer.address,
        buyer.weightUsd1,
        buyer.attributions,
      ]),
    ).toEqual([
      [carol, usd(115n), ["moved"]],
      [alice, usd(60n), ["loopRouter", "moved"]],
    ]);
    expect(
      await launch2.getDynamicBuyWeight({
        instanceId: target.instanceId,
        roundId: "2",
        address: carol,
      }),
    ).toBe("0");

    // A reorg from block 2005 undoes alice's forwards: weight back to her.
    await commit([], 2013 + offset, 2005 + offset);
    expect(
      (await weights(target.instanceId))
        .filter((row) => row.round_id === "1")
        .map((row) => [row.buyer_address, row.weight_usd1]),
    ).toEqual([
      [alice, usd(75n)],
      [carol, usd(100n)],
      [router, usd(5n)],
    ]);
    await conserved(target.instanceId);
  });

  it("reproduces the chain's buyWeight of the S200 Universal Router fork case (loop-contracts 0014 §7.1)", async () => {
    const offset = 200;
    const { target, e } = await bound(offset);
    const bob = `0x${"b5".repeat(20)}`;
    await commit(
      [
        // Not listed: TAKE_ALL to bob → delivery.
        e(
          "BuyCredited",
          {
            round: "1",
            buyer: bob,
            quoteSpent: usd(200n),
            attribution: "delivery",
          },
          2002,
          4,
        ),
        // TAKE to the router itself + SWEEP to carol.
        e(
          "BuyCredited",
          {
            round: "1",
            buyer: router,
            quoteSpent: usd(100n),
            attribution: "delivery",
          },
          2003,
          4,
        ),
        e(
          "CreditMoved",
          { round: "1", from: router, to: carol, quoteSpent: usd(100n) },
          2003,
          6,
        ),
        // Listed: msgSender() → bob; the older listed router credits alice.
        e(
          "BuyCredited",
          {
            round: "1",
            buyer: bob,
            quoteSpent: usd(300n),
            attribution: "registryRouter",
          },
          2004,
          2,
        ),
        e(
          "BuyCredited",
          {
            round: "1",
            buyer: alice,
            quoteSpent: usd(50n),
            attribution: "registryRouter",
          },
          2005,
          2,
        ),
      ],
      2005 + offset,
    );
    // buyWeight(1, ·) on chain after the fork test: bob 500, carol 100,
    // router 0, alice 50; totalBuyWeight 650.
    const chain = new Map([
      [bob, usd(500n)],
      [carol, usd(100n)],
      [router, "0"],
      [alice, usd(50n)],
    ]);
    for (const [address, weight] of chain) {
      expect(
        await launch2.getDynamicBuyWeight({
          instanceId: target.instanceId,
          roundId: "1",
          address,
        }),
      ).toBe(weight);
    }
    const round = await pool.query<{ total: string; buyers: number }>(
      "select total_buy_weight_usd1::text as total, buyer_count as buyers from public.launch2_dynamic_rounds where instance_id = $1 and round_id = 1",
      [target.instanceId],
    );
    expect(round.rows[0]).toEqual({ total: usd(650n), buyers: 3 });
    await conserved(target.instanceId);
  });

  it("keeps a pre-S200 Hook's read model: BuyCredited only, attribution unknown when the lane did not derive one", async () => {
    const offset = 300;
    const { target, e } = await bound(offset);
    await commit(
      [
        e(
          "BuyCredited",
          { round: "1", buyer: alice, quoteSpent: usd(30n) },
          2002,
        ),
        e(
          "BuyCredited",
          { round: "1", buyer: alice, quoteSpent: usd(10n) },
          2003,
        ),
        e(
          "BuyCredited",
          { round: "1", buyer: carol, quoteSpent: usd(70n) },
          2004,
        ),
        e(
          "BuyNotCredited",
          { round: "1", buyer: zeroAddress, quoteSpent: usd(9n) },
          2005,
        ),
      ],
      2005 + offset,
    );
    expect(await weights(target.instanceId)).toEqual([
      {
        round_id: "1",
        buyer_address: alice,
        weight_usd1: usd(40n),
        credited_usd1: usd(40n),
        moved_in_usd1: "0",
        moved_out_usd1: "0",
      },
      {
        round_id: "1",
        buyer_address: carol,
        weight_usd1: usd(70n),
        credited_usd1: usd(70n),
        moved_in_usd1: "0",
        moved_out_usd1: "0",
      },
    ]);
    const rewards = await launch2.listDynamicRewards({
      instanceId: target.instanceId,
      walletAddress: alice,
      limit: 10,
    });
    expect(rewards[0]).toMatchObject({
      weightUsd1: usd(40n),
      totalBuyWeightUsd1: usd(110n),
    });
    expect(rewards[0]!.entries.map((entry) => entry.attribution)).toEqual([
      "unknown",
      "unknown",
    ]);
    await conserved(target.instanceId);
  });
});
