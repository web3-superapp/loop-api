import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "../src/database/hooks-launch-submission-repository.js";
import { createPostgresWalletActivityMergeRepository } from "../src/database/wallet-activity-merge-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { hooksLaunchReviewCommandSchema } from "../src/features/launch/hooks-launch-review.js";
import {
  mergeActivityPages,
  sortKeyOfEntry,
  type MergedActivityEntry,
  type WalletActivitySortKey,
} from "../src/features/wallet/wallet-activity-launch2.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0167 (S251): the merged wallet activity reads on a real
 * PostgreSQL. One wallet (random per run, so the shared database needs no
 * cleanup) with a 晚风-style history on two MEME v2 instances — NFT mint,
 * curve buy / sell, router and LoopRouter pool trades, an S200 delivery buy
 * credited by the Hook, a reward claim, a buyback it received — plus two
 * ERC-20 transfers on the primary chain; every page size walks the same
 * ten rows in order, none twice.
 */

const pool = new pg.Pool({ connectionString: requireIntegrationDatabaseUrl() });
const configs = createPostgresHooksLaunchProjectConfigRepository(pool);
const review = createPostgresHooksLaunchReviewRepository(pool, {
  now: () => 1_800_000_000,
});
const submissions = createPostgresHooksLaunchSubmissionRepository(pool);
const merge = createPostgresWalletActivityMergeRepository(pool);
const chainId = "eip155:97";
const primaryChainId = "eip155:56";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const wad = 10n ** 18n;
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const wbnbAssetId = `eip155:56:${wbnb}`;

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

describe("Decision 0167: merged wallet activity reads", () => {
  it("lists one wallet's launch2 facts and transfers in one order, every page size", async () => {
    const wallet = hex(20);
    const other = hex(20);
    const wind = await instance();
    const moon = await instance();
    await pool.query(
      "update public.launch2_instances set ticker = 'WIND', name = 'Evening Wind' where instance_id = $1",
      [wind.instanceId],
    );
    // The buyback MEME of MOON goes to the wallet.
    await pool.query(
      "update public.launch2_instances set ticker = 'MOON', name = 'Moon', logo_url = null, buyback_recipient = $2 where instance_id = $1",
      [moon.instanceId, wallet],
    );
    await pool.query(
      `insert into public.indexer_checkpoints (lane, chain_id, last_block_number,
         last_block_hash, started_from_block_number)
       values ('launch2_event', $1, 5000, $2, 1)
       on conflict (lane, chain_id) do nothing`,
      [chainId, hex(32)],
    );
    await pool.query(
      `insert into public.assets (asset_id, chain_id, address, symbol, name,
         decimals, status, source_kind, source_block_number, source_verified_at)
       values ($1, $2, $3, 'WBNB', 'Wrapped BNB', 18, 'pending', 'chain_call',
         1, clock_timestamp())
       on conflict (asset_id) do nothing`,
      [wbnbAssetId, primaryChainId, wbnb],
    );

    const base = Date.UTC(2026, 9, 19, 12, 0, 0);
    const at = (minutesAgo: number) => new Date(base - minutesAgo * 60_000);
    const tx: Record<string, string> = {};
    const fact = (name: string) => {
      tx[name] = hex(32);
      return tx[name];
    };

    // WIND: NFT mint, curve buy, curve sell (-100, -90, -80 min).
    await pool.query(
      `insert into public.launch2_nft_mints (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, payer_address,
         token_id, amount_usd1, minted_at)
       values ($1, $2, 0, 1000, $3, $4, $5, 1, $6, $7)`,
      [
        chainId,
        fact("mint"),
        hex(32),
        wind.instanceId,
        wallet,
        (100n * wad).toString(),
        at(100),
      ],
    );
    for (const [name, side, minutes, block] of [
      ["curveBuy", "buy", 90, 1010],
      ["curveSell", "sell", 80, 1020],
      ["otherBuy", "buy", 85, 1015],
      ["removedBuy", "buy", 70, 1030],
    ] as const) {
      await pool.query(
        `insert into public.launch2_trades (trade_id, chain_id, transaction_hash,
           log_index, block_number, block_hash, instance_id, side, trader_address,
           meme_amount, usd1_gross, usd1_net, tax_usd1, refund_usd1,
           cumulative_bought, sold_after, traded_at, removed)
         values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0,
           $13, $14, $15, $16)`,
        [
          randomUUID(),
          chainId,
          fact(name),
          block,
          hex(32),
          wind.instanceId,
          side,
          name === "otherBuy" ? other : wallet,
          (1000n * wad).toString(),
          (side === "buy" ? (102n * wad) / 10n : 5n * wad).toString(),
          (side === "buy" ? 10n * wad : (49n * wad) / 10n).toString(),
          (side === "buy" ? (2n * wad) / 10n : wad / 10n).toString(),
          side === "buy" ? (1000n * wad).toString() : null,
          side === "sell" ? "0" : null,
          at(minutes),
          name === "removedBuy",
        ],
      );
    }

    // MOON pool: LoopRouter buy (tx.from attribution, MEME tax), router sell
    // (USD1 tax), an anonymous S209 buy the Hook credited to the wallet by
    // delivery (USD1 tax), and a stranger's anonymous buy (not the wallet's).
    const poolId = hex(32);
    const swap = async (input: {
      readonly name: string;
      readonly side: "buy" | "sell";
      readonly minutes: number;
      readonly block: number;
      readonly log: number;
      readonly taxToken: "usd1" | "meme";
      readonly attribution: "transaction_sender" | "router_swap" | null;
      readonly payer?: string;
    }) => {
      const attributed = input.attribution !== null;
      await pool.query(
        `insert into public.launch2_pool_swaps (chain_id, transaction_hash,
           log_index, block_number, block_hash, instance_id, pool_id,
           caller_address, side, usd1_amount, meme_amount, tax_amount,
           tax_token, sqrt_price_x96, price_e18, swapped_at, wallet_address,
           recipient_address, router_amount_in, router_amount_out,
           router_log_index, attribution_source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, 1,
           $14, $15, $15, $16, $17, $18, $19)`,
        [
          chainId,
          fact(input.name),
          input.log,
          input.block,
          hex(32),
          moon.instanceId,
          poolId,
          hex(20),
          input.side,
          (20n * wad).toString(),
          (400n * wad).toString(),
          (input.taxToken === "usd1" ? (4n * wad) / 10n : 8n * wad).toString(),
          input.taxToken,
          at(input.minutes),
          attributed ? (input.payer ?? wallet) : null,
          attributed
            ? (input.side === "buy" ? 20n * wad : 400n * wad).toString()
            : null,
          attributed
            ? (input.side === "buy"
                ? 392n * wad
                : (196n * wad) / 10n
              ).toString()
            : null,
          input.attribution === "router_swap" ? input.log + 1 : null,
          input.attribution,
        ],
      );
    };
    await swap({
      name: "poolBuy",
      side: "buy",
      minutes: 70,
      block: 2000,
      log: 4,
      taxToken: "meme",
      attribution: "transaction_sender",
    });
    await swap({
      name: "poolSell",
      side: "sell",
      minutes: 60,
      block: 2010,
      log: 2,
      taxToken: "usd1",
      attribution: "router_swap",
    });
    await swap({
      name: "deliveryBuy",
      side: "buy",
      minutes: 50,
      block: 2020,
      log: 1,
      taxToken: "usd1",
      attribution: null,
    });
    await swap({
      name: "strangerBuy",
      side: "buy",
      minutes: 49,
      block: 2021,
      log: 1,
      taxToken: "usd1",
      attribution: null,
    });
    await pool.query(
      `insert into public.launch2_dynamic_credit_entries (instance_id, round_id,
         address, direction, attribution, amount_usd1, hook_address, chain_id,
         transaction_hash, log_index, block_number, credited_at)
       values ($1, 1, $2, 'in', 'delivery', $3, $4, $5, $6, 3, 2020, $7),
         ($1, 1, $8, 'in', 'delivery', $3, $4, $5, $9, 3, 2021, $10)`,
      [
        moon.instanceId,
        wallet,
        (20n * wad).toString(),
        hex(20),
        chainId,
        tx["deliveryBuy"],
        at(50),
        other,
        tx["strangerBuy"],
        at(49),
      ],
    );
    await pool.query(
      `insert into public.launch2_dynamic_claims (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, hook_address,
         round_id, buyer_address, amount_usd1, claimed_at)
       values ($1, $2, 0, 2030, $3, $4, $5, 1, $6, $7, $8)`,
      [
        chainId,
        fact("claim"),
        hex(32),
        moon.instanceId,
        hex(20),
        wallet,
        ((5n * wad) / 4n).toString(),
        at(40),
      ],
    );
    await pool.query(
      `insert into public.launch2_buybacks (buyback_id, chain_id,
         transaction_hash, log_index, block_number, block_hash, instance_id,
         outcome, usd1_spent, meme_delivered, executed_at)
       values ($1, $2, $3, 3, 2040, $4, $5, 'executed', $6, $7, $8)`,
      [
        randomUUID(),
        chainId,
        fact("buyback"),
        hex(32),
        moon.instanceId,
        (125n * wad).toString(),
        (77n * wad).toString(),
        at(30),
      ],
    );
    // The buyback's own swap (same transaction) is not a user trade.
    await pool.query(
      `insert into public.launch2_pool_swaps (chain_id, transaction_hash,
         log_index, block_number, block_hash, instance_id, pool_id,
         caller_address, side, usd1_amount, meme_amount, tax_amount, tax_token,
         sqrt_price_x96, price_e18, swapped_at, wallet_address,
         recipient_address, router_amount_in, router_amount_out,
         attribution_source)
       values ($1, $2, 2, 2040, $3, $4, $5, $6, 'buy', $7, 77, 0, 'meme', 1, 1,
         $8, $9, $9, 1, 1, 'transaction_sender')`,
      [
        chainId,
        tx["buyback"],
        hex(32),
        moon.instanceId,
        poolId,
        hex(20),
        (125n * wad).toString(),
        at(30),
        wallet,
      ],
    );

    // Primary chain transfers: -75 and -45 min; two more one microsecond
    // apart at -20 min (the cursor keeps microseconds).
    const transfer = async (
      name: string,
      observedAt: string,
      block: number,
      toWallet: boolean,
    ) => {
      await pool.query(
        `insert into public.indexed_transfers (chain_id, transaction_hash,
           log_index, block_number, block_hash, asset_id, from_address,
           to_address, raw_value, observed_at)
         values ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [
          primaryChainId,
          fact(name),
          block,
          hex(32),
          wbnbAssetId,
          toWallet ? other : wallet,
          toWallet ? wallet : other,
          wad.toString(),
          observedAt,
        ],
      );
    };
    await transfer("erc20Early", at(75).toISOString(), 44_000_000, true);
    await transfer("erc20Late", at(45).toISOString(), 44_000_100, false);
    const twenty = at(20).toISOString().replace("Z", "");
    await transfer("erc20MicroA", `${twenty}001+00`, 44_000_200, true);
    await transfer("erc20MicroB", `${twenty}002+00`, 44_000_199, true);

    expect(await merge.getLaunch2Checkpoint(chainId)).not.toBeNull();
    expect(await merge.getLaunch2Checkpoint("eip155:1")).toBeNull();

    const expected = [
      "erc20MicroB",
      "erc20MicroA",
      "buyback",
      "claim",
      "erc20Late",
      "deliveryBuy",
      "poolSell",
      "poolBuy",
      "erc20Early",
      "curveSell",
      "curveBuy",
      "mint",
    ];
    const nameOf = new Map(Object.entries(tx).map(([k, v]) => [v, k]));
    const walk = async (pageSize: number) => {
      const names: string[] = [];
      const entries: MergedActivityEntry[] = [];
      let before: WalletActivitySortKey | undefined;
      for (let guard = 0; guard < 30; guard += 1) {
        const [transfers, launch2] = await Promise.all([
          merge.listTransfersByTime({
            chainId: primaryChainId,
            address: wallet,
            assetIds: [wbnbAssetId],
            limit: pageSize,
            ...(before === undefined ? {} : { before }),
          }),
          merge.listLaunch2Activity({
            chainId,
            address: wallet,
            limit: pageSize,
            ...(before === undefined ? {} : { before }),
          }),
        ]);
        const page = mergeActivityPages({ transfers, launch2, pageSize });
        expect(page.entries.length).toBeLessThanOrEqual(pageSize);
        for (const entry of page.entries) {
          names.push(nameOf.get(entry.record.transactionHash) ?? "?");
          entries.push(entry);
        }
        const last = page.entries.at(-1);
        if (!page.hasMore || last === undefined) break;
        before = sortKeyOfEntry(last);
      }
      return { names, entries };
    };
    for (const pageSize of [1, 2, 3, 4, 12, 50]) {
      const { names } = await walk(pageSize);
      expect(names, `pageSize ${pageSize}`).toEqual(expected);
    }

    const { entries } = await walk(50);
    const byName = new Map(
      entries.map((entry) => [
        nameOf.get(entry.record.transactionHash) ?? "?",
        entry,
      ]),
    );
    const launch2Of = (name: string) => {
      const entry = byName.get(name);
      if (entry?.source !== "launch2") throw new Error(name);
      return entry.record;
    };
    expect(launch2Of("mint")).toMatchObject({
      kind: "launch2_nft_mint",
      chainId,
      instanceId: wind.instanceId,
      ticker: "WIND",
      name: "Evening Wind",
      amountMeme: null,
      amountUsd1: (100n * wad).toString(),
      taxUsd1: null,
      blockNumber: "1000",
      occurredAt: at(100).toISOString(),
    });
    expect(launch2Of("curveBuy")).toMatchObject({
      kind: "launch2_curve_buy",
      amountMeme: (1000n * wad).toString(),
      amountUsd1: ((102n * wad) / 10n).toString(),
      taxUsd1: ((2n * wad) / 10n).toString(),
    });
    expect(launch2Of("curveSell")).toMatchObject({
      kind: "launch2_curve_sell",
      amountUsd1: ((49n * wad) / 10n).toString(),
      taxUsd1: (wad / 10n).toString(),
    });
    expect(launch2Of("poolBuy")).toMatchObject({
      kind: "launch2_pool_buy",
      instanceId: moon.instanceId,
      ticker: "MOON",
      logoUrl: null,
      // The router's own amounts: USD1 paid in, MEME received out.
      amountUsd1: (20n * wad).toString(),
      amountMeme: (392n * wad).toString(),
      taxUsd1: null,
      logIndex: 4,
    });
    expect(launch2Of("poolSell")).toMatchObject({
      kind: "launch2_pool_sell",
      amountMeme: (400n * wad).toString(),
      amountUsd1: ((196n * wad) / 10n).toString(),
      taxUsd1: ((4n * wad) / 10n).toString(),
    });
    expect(launch2Of("deliveryBuy")).toMatchObject({
      kind: "launch2_pool_buy",
      // No router amounts: the pool's USD1 in and its MEME out.
      amountUsd1: (20n * wad).toString(),
      amountMeme: (400n * wad).toString(),
      taxUsd1: ((4n * wad) / 10n).toString(),
    });
    expect(launch2Of("claim")).toMatchObject({
      kind: "launch2_reward_claim",
      amountUsd1: ((5n * wad) / 4n).toString(),
      amountMeme: null,
    });
    expect(launch2Of("buyback")).toMatchObject({
      kind: "launch2_buyback",
      amountUsd1: (125n * wad).toString(),
      amountMeme: (77n * wad).toString(),
      logIndex: 3,
    });
    const micro = byName.get("erc20MicroB");
    expect(micro?.source).toBe("erc20");
    expect(micro?.record.atMicros.endsWith("002")).toBe(true);

    // Another wallet sees none of these rows but its own.
    const stranger = await merge.listLaunch2Activity({
      chainId,
      address: other,
      limit: 50,
    });
    expect(
      stranger.items.map((item) => nameOf.get(item.transactionHash)),
    ).toEqual(["strangerBuy", "otherBuy"]);
  });

  it("returns an empty transfer page without asking the database for no assets", async () => {
    const page = await merge.listTransfersByTime({
      chainId: primaryChainId,
      address: hex(20),
      assetIds: [],
      limit: 5,
    });
    expect(page).toEqual({ items: [], hasMore: false });
  });
});
