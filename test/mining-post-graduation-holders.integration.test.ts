import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import { miningDefaultParameterDocument } from "../src/features/mining/hourly-settlement-contract.js";
import type { MiningSettlementRepository } from "../src/features/mining/hourly-settlement-ports.js";
import {
  admittedAssetIds,
  createMiningSettlementRunner,
} from "../src/features/mining/hourly-settlement-runner.js";
import { computeMiningPoolSnapshot } from "../src/features/mining/mining-pool-snapshot.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { loop } from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0196 (S341) on PostgreSQL, in a throwaway database: a graduated
 * launch2 MEME whose holder only received it after graduation (an ERC-20
 * transfer or an outside-pool buy, never a curve trade) is attributed to
 * its owner, so the snapshot pool part and the hourly settlement both count
 * it. Curve holders, NFT holders, mixed holders, non-members and external
 * wallets (embedded-only) keep their previous results.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const CHAIN = "eip155:97";
const HOUR = "2026-10-26T10:00:00.000Z";
const HOUR_S = BigInt(Date.parse(HOUR) / 1000);
const MEME = "0xaaaa333333333333333333333333333333336666";
const NFT = "0xaaaa444444444444444444444444444444444444";
const ASSET = `${CHAIN}:${MEME}`;
const ZERO = "0x0000000000000000000000000000000000000000";

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: connectionUrl(databaseUrl, "postgres"),
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

const hex = (n: number, width = 64) =>
  `0x${n.toString(16).padStart(width, "0")}`;
const address = (n: number) => hex(n, 40);
const wallet = (index: number) => address(0xa0 + index);
const CURVE = address(0xc0);
const POOL = address(0xe2);
const OUTSIDE = address(0xe1);

describe("Decision 0196 post-graduation MEME holders on PostgreSQL", () => {
  const databaseName = `loop_s341_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let repository: MiningSettlementRepository;
  const users: string[] = [];
  let log = 0;

  async function user(
    index: number,
    kind: "embedded" | "external" = "embedded",
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s341:${randomUUID()}`],
    );
    const id = result.rows[0]!.id;
    await pool.query(
      `insert into public.account_wallets (owner_user_id, provider_wallet_id, address,
         kind, status, is_active, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, 'active', true, '2026-01-01', '2026-01-01')`,
      [
        id,
        kind === "embedded"
          ? `privy-s341-${index}-${randomUUID().slice(0, 8)}`
          : null,
        wallet(index),
        kind,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    const url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    repository = createPostgresMiningSettlementRepository(pool);
    // users[0] creator; [1] member, curve buyer plus a post-graduation
    // transfer (mixed); [2] member, post-graduation only (the S338 case);
    // [3] member holding 3 NFTs; [4] non-member, post-graduation only;
    // [5] member, external wallet, post-graduation only.
    for (let index = 0; index < 5; index += 1) users.push(await user(index));
    users.push(await user(5, "external"));
    const created = await pool.query<{ community_id: string }>(
      `insert into public.communities (name, slug, bound_asset_key, created_by_user_id,
         verification_status, verified_at, reviewed_at, created_at)
       values ('Dad', 'dad-s341', $1, $2, 'verified', '2026-10-01', '2026-10-01', '2026-10-01')
       returning community_id`,
      [ASSET, users[0]],
    );
    const communityId = created.rows[0]!.community_id;
    for (const index of [1, 2, 3, 5]) {
      await pool.query(
        `insert into public.community_memberships (community_id, owner_user_id, role, status,
           joined_at, updated_at)
         values ($1, $2, 'member', 'active', '2026-10-01', '2026-10-01')`,
        [communityId, users[index]],
      );
    }
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      const instanceId = randomUUID();
      await client.query(
        `insert into public.launch2_instances (instance_id, job_id, project_id,
           config_version, owner_user_id, chain_id, factory_address, launch_id, config_hash,
           project_owner, name, ticker, meme_address, hook_address, nft_address,
           curve_address, gate_address, escrow_address, snapshots_address,
           graduation_adapter_address, buyback_adapter_address, price_recorder_address,
           buyback_executor_address, buyback_recipient, nft_sale_start, deploy_block_number,
           factory_generation, graduated_at, official_pool_id, meme_transfers_complete_at,
           meme_transfers_target_block)
         values ($1, $2, $3, 1, $4, $5, $6, $7, $7, $6, 'MAOMAO', 'MAOMAO', $8, $6, $9,
           $6, $6, $6, $6, $6, $6, $6, $6, $6, '2026-10-01', 1, 'v3',
           '2026-10-20T00:00:00Z', $10, '2026-10-21T00:00:00Z', 300)`,
        [
          instanceId,
          randomUUID(),
          randomUUID(),
          users[0],
          CHAIN,
          address(0xf),
          hex(1),
          MEME,
          NFT,
          hex(0x9001),
        ],
      );
      // users[1] bought 300 on the curve before graduation.
      log += 1;
      await client.query(
        `insert into public.launch2_trades (trade_id, chain_id, transaction_hash, log_index,
           block_number, block_hash, instance_id, side, trader_address, meme_amount,
           cumulative_bought, traded_at)
         values ($1, $2, $3, 0, $4, $5, $6, 'buy', $7, $8, $8, '2026-10-15T00:00:00Z')`,
        [
          randomUUID(),
          CHAIN,
          hex(0xbeef + log),
          log,
          hex(0xfeed + log),
          instanceId,
          wallet(1),
          (300n * loop).toString(),
        ],
      );
      const transfer = async (
        from: string,
        to: string,
        amount: bigint,
        at: string,
      ) => {
        log += 1;
        await client.query(
          `insert into public.launch2_meme_transfers (chain_id, transaction_hash, log_index,
             block_number, block_hash, instance_id, from_address, to_address, amount,
             transferred_at)
           values ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
          [
            CHAIN,
            hex(0xa000 + log),
            log,
            hex(0xb000 + log),
            instanceId,
            from,
            to,
            (amount * loop).toString(),
            at,
          ],
        );
      };
      for (const holder of [CURVE, POOL, OUTSIDE]) {
        await transfer(ZERO, holder, 10_000n, "2026-10-10T00:00:00Z");
      }
      // The curve's ERC-20 leg of users[1]'s buy.
      await transfer(CURVE, wallet(1), 300n, "2026-10-15T00:00:00Z");
      // After graduation (2026-10-20): transfers and outside-pool buys.
      await transfer(OUTSIDE, wallet(1), 100n, "2026-10-22T00:00:00Z");
      await transfer(OUTSIDE, wallet(2), 1_000n, "2026-10-22T00:00:00Z");
      await transfer(POOL, wallet(2), 500n, "2026-10-26T10:15:00Z");
      await transfer(OUTSIDE, wallet(4), 700n, "2026-10-22T00:00:00Z");
      await transfer(OUTSIDE, wallet(5), 200n, "2026-10-22T00:00:00Z");
      for (let token = 1; token <= 3; token += 1) {
        log += 1;
        await client.query(
          `insert into public.launch2_events (chain_id, transaction_hash, log_index,
             block_number, block_hash, instance_id, contract_address, event_name, payload, event_at)
           values ($1, $2, 0, $3, $4, $5, $6, 'Transfer', $7::jsonb, '2026-10-15T00:00:00Z')`,
          [
            CHAIN,
            hex(log),
            log,
            hex(log + 1_000_000),
            instanceId,
            NFT,
            JSON.stringify({
              from: ZERO,
              to: wallet(3),
              tokenId: String(token),
            }),
          ],
        );
      }
      await client.query(
        `insert into public.indexer_checkpoints (lane, chain_id, last_block_number,
           last_block_hash, started_from_block_number, created_at, updated_at)
         values ('launch2_event', $1, 4321, $2, 1, '2026-10-26T11:05:00Z', '2026-10-26T11:05:00Z')`,
        [CHAIN, hex(4321)],
      );
    } finally {
      await client.query("set session_replication_role = origin");
      client.release();
    }
    await pool.query(
      `insert into public.mining_parameter_versions (version_id, config_version, status,
         document, effective_from, draft_author_actor, approved_by, approved_at)
       values ($1, 's341', 'approved', $2::jsonb, '2026-10-01T00:00:00Z', 'seed',
         'seed-reviewer', clock_timestamp())`,
      [
        randomUUID(),
        JSON.stringify({
          ...miningDefaultParameterDocument,
          releaseStartAt: "2026-10-01T00:00:00.000Z",
          assetWeights: [],
          communityCoefficients: [],
        }),
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  async function snapshotAt(at: bigint, embeddedWalletOnly: boolean) {
    const versions = await repository.listApprovedParameterVersions();
    const facts = await repository.readSettlementFacts({
      chainId: CHAIN,
      hourStart: at,
      hourEnd: at + 1n,
      assetIds: admittedAssetIds(versions, at, at + 1n, [ASSET]),
      embeddedWalletOnly,
    });
    const part = computeMiningPoolSnapshot({
      at,
      versions,
      poolAssetIds: [ASSET],
      facts,
      block: await repository.readLaunch2Checkpoint(CHAIN),
      registeredAssetIds: new Set([ASSET]),
    });
    expect(part.kind).toBe("computed");
    if (part.kind !== "computed") return { facts, powers: [] };
    return {
      facts,
      powers: part.powers.map((entry) => [
        entry.ownerUserId,
        entry.holding,
        entry.power,
      ]),
    };
  }

  const byUser = (rows: string[][]) =>
    [...rows].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));

  it("attributes post-graduation-only holders in the facts", async () => {
    const { facts } = await snapshotAt(HOUR_S + 1_800n, true);
    expect(facts.walletOwners.map((owner) => owner.address).sort()).toEqual(
      [wallet(1), wallet(2), wallet(3), wallet(4)].sort(),
    );
  });

  it("the snapshot counts the post-graduation holder; non-members and external wallets stay out", async () => {
    const embedded = await snapshotAt(HOUR_S + 1_800n, true);
    expect(embedded.powers).toEqual(
      byUser([
        [users[1]!, "400", "400"],
        [users[2]!, "1500", "1500"],
        [users[3]!, "0", "3"],
      ]),
    );
    // MINING_EMBEDDED_WALLET_ONLY off: the member's external wallet counts.
    const all = await snapshotAt(HOUR_S + 1_800n, false);
    expect(all.powers).toEqual(
      byUser([
        [users[1]!, "400", "400"],
        [users[2]!, "1500", "1500"],
        [users[3]!, "0", "3"],
        [users[5]!, "200", "200"],
      ]),
    );
  });

  it("the hourly settlement counts the post-graduation holder, time-weighted", async () => {
    const settlement = createMiningSettlementRunner({
      repository,
      chainId: CHAIN,
      indexerGraceSeconds: 120,
      embeddedWalletOnly: true,
      now: () => new Date("2026-10-26T11:10:00.000Z"),
    });
    const outcome = await settlement.settleHour({
      hourStart: HOUR_S,
      trigger: "scheduled",
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe("settled");
    if (outcome.kind !== "settled") return;
    const rows = await repository.listEpochRewards({
      epochId: outcome.epoch.epochId,
    });
    const row = (index: number) =>
      rows.find((entry) => entry.userId === users[index]);
    expect(row(1)?.assetSelfPower).toBe("400");
    // 1000 for 15 minutes, 1500 for 45 minutes.
    expect(row(2)?.assetSelfPower).toBe("1375");
    expect(row(3)?.nftSelfPower).toBe("3");
    expect(row(4)?.assetSelfPower ?? "0").toBe("0");
    expect(row(5)?.assetSelfPower ?? "0").toBe("0");
    expect(outcome.epoch.inputSummary["unattributedHoldingCount"]).toBe(4);
    const replay = await settlement.replay(outcome.epoch.epochId);
    expect(replay).toMatchObject({ digestMatches: true, rewardsMatch: true });
  });
});
