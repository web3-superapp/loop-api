import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import {
  miningDefaultParameterDocument,
  type MiningParameterDocument,
} from "../src/features/mining/hourly-settlement-contract.js";
import type { MiningSettlementRepository } from "../src/features/mining/hourly-settlement-ports.js";
import { createMiningSettlementRunner } from "../src/features/mining/hourly-settlement-runner.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { loop } from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0189 on PostgreSQL, in a throwaway database: a BSC mainnet token
 * bound by a verified community and let in by `includedAssets` is settled
 * hourly from a pinned `wallet_balance_snapshots` reading + the
 * `erc20_transfer` lane's `indexed_transfers` (members only); a holder with
 * no opening reading counts 0 with a reason; replay reads the pinned rows; a
 * stale erc20 lane leaves the token out without holding back the platform
 * MEME; the snapshot balance read gates external holders by membership; an
 * hour settled before 0189 keeps its community rank projection.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const CHAIN = "eip155:97";
const MAINNET = "eip155:56";
const HOUR = "2026-10-26T10:00:00.000Z";
const HOUR_S = BigInt(Date.parse(HOUR) / 1000);
const NEXT_S = HOUR_S + 3600n;
const MEME_A = "0xaaaa333333333333333333333333333333336666";
const ASSET_A = `${CHAIN}:${MEME_A}`;
const CAKE_ADDRESS = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
const CAKE = `${MAINNET}:${CAKE_ADDRESS}`;
const ADA_ADDRESS = "0x3ee2200efb3400fabb9aacf31297cbdd1d435d47";
const ADA = `${MAINNET}:${ADA_ADDRESS}`;

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

describe("Decision 0189 erc20 external tokens on PostgreSQL", () => {
  const databaseName = `loop_s317_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let repository: MiningSettlementRepository;
  const users: string[] = [];
  const wallets: string[] = [];
  const communities: Record<string, string> = {};
  let firstEpochId = "";
  let log = 0;

  async function user(index: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s317:${randomUUID()}`],
    );
    const id = result.rows[0]!.id;
    const wallet = await pool.query<{ wallet_id: string }>(
      `insert into public.account_wallets (owner_user_id, provider_wallet_id, address,
         kind, status, is_active, first_seen_at, last_seen_at)
       values ($1, $2, $3, 'embedded', 'active', true, '2026-01-01', '2026-01-01')
       returning wallet_id`,
      [
        id,
        `privy-s317-${index}-${randomUUID().slice(0, 8)}`,
        address(0xa0 + index),
      ],
    );
    wallets.push(wallet.rows[0]!.wallet_id);
    return id;
  }

  async function community(name: string, asset: string): Promise<string> {
    const result = await pool.query<{ community_id: string }>(
      `insert into public.communities (name, slug, bound_asset_key, created_by_user_id,
         verification_status, verified_at, reviewed_at, created_at)
       values ($1, $2, $3, $4, 'verified', '2026-10-01', '2026-10-01', '2026-10-01')
       returning community_id`,
      [name, name.toLowerCase().replaceAll(" ", "-"), asset, users[0]],
    );
    return result.rows[0]!.community_id;
  }

  async function member(communityId: string, index: number): Promise<void> {
    await pool.query(
      `insert into public.community_memberships (community_id, owner_user_id, role, status,
         joined_at, updated_at)
       values ($1, $2, 'member', 'active', '2026-10-01', '2026-10-01')`,
      [communityId, users[index]],
    );
  }

  async function asset(assetId: string, addr: string, symbol: string) {
    await pool.query(
      `insert into public.assets (asset_id, chain_id, address, symbol, name, decimals,
         status, source_kind, source_block_number, source_verified_at)
       values ($1, $2, $3, $4, $4, 18, 'pending', 'chain_call', 1, now())`,
      [assetId, assetId.split(":").slice(0, 2).join(":"), addr, symbol],
    );
  }

  async function snapshot(
    walletIndex: number,
    assetId: string,
    block: number,
    amount: bigint,
    observedAt: string,
  ) {
    await pool.query(
      `insert into public.wallet_balance_snapshots (wallet_id, asset_id, block_number,
         block_hash, raw_value, observed_at, source)
       values ($1, $2, $3, $4, $5, $6::timestamptz, 'chain')`,
      [
        wallets[walletIndex],
        assetId,
        block,
        hex(block),
        amount.toString(),
        observedAt,
      ],
    );
  }

  async function transfer(input: {
    from: string;
    to: string;
    amount: bigint;
    block: number;
    observedAt: string;
    removed?: boolean;
  }) {
    log += 1;
    await pool.query(
      `insert into public.indexed_transfers (chain_id, transaction_hash, log_index,
         block_number, block_hash, asset_id, from_address, to_address, raw_value,
         removed, observed_at)
       values ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
      [
        MAINNET,
        hex(0x7000 + log),
        input.block,
        hex(input.block),
        CAKE,
        input.from,
        input.to,
        input.amount.toString(),
        input.removed ?? false,
        input.observedAt,
      ],
    );
  }

  async function insertVersion(
    document: MiningParameterDocument,
    effectiveFrom = "2026-10-01T00:00:00Z",
  ) {
    await pool.query(
      `insert into public.mining_parameter_versions (version_id, config_version, status,
         document, effective_from, draft_author_actor, approved_by, approved_at)
       values ($1, $2, 'approved', $3::jsonb, $4::timestamptz, 'seed', 'seed-reviewer', clock_timestamp())`,
      [
        randomUUID(),
        `s317-${randomUUID().slice(0, 8)}`,
        JSON.stringify(document),
        effectiveFrom,
      ],
    );
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
    // users[0] creator; users[1] member (MEME_A 300, CAKE via snapshot +
    // transfers); users[2] member, CAKE wallet never read (opening missing);
    // users[3] not a member of BSC News, holds CAKE; users[4] member whose
    // only reading predates its coverage.
    for (let index = 0; index < 5; index += 1) users.push(await user(index));
    communities["alpha"] = await community("Alpha Frogs", ASSET_A);
    communities["news"] = await community("BSC News", CAKE);
    communities["owls"] = await community("Night Owls", ADA);
    await member(communities["alpha"], 1);
    for (const index of [1, 2, 4]) await member(communities["news"], index);
    await asset(ASSET_A, MEME_A, "ALPHA");
    await asset(CAKE, CAKE_ADDRESS, "CAKE");
    await asset(ADA, ADA_ADDRESS, "ADA");

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
           factory_generation)
         values ($1, $2, $3, 1, $4, $5, $6, $7, $7, $6, 'ALPHA', 'ALPHA', $8, $6, $9,
           $6, $6, $6, $6, $6, $6, $6, $6, $6, '2026-10-01', 1, 'v3')`,
        [
          instanceId,
          randomUUID(),
          randomUUID(),
          users[0],
          CHAIN,
          address(0xf),
          hex(1),
          MEME_A,
          address(0xe1),
        ],
      );
      await client.query(
        `insert into public.launch2_trades (trade_id, chain_id, transaction_hash, log_index,
           block_number, block_hash, instance_id, side, trader_address, meme_amount,
           cumulative_bought, traded_at)
         values ($1, $2, $3, 0, 1, $4, $5, 'buy', $6, $7, $7, '2026-10-20T00:00:00Z')`,
        [
          randomUUID(),
          CHAIN,
          hex(0xbeef),
          hex(0xfeed),
          instanceId,
          address(0xa1),
          (300n * loop).toString(),
        ],
      );
    } finally {
      await client.query("set session_replication_role = origin");
      client.release();
    }

    // Lanes: launch2 fresh for both hours; erc20 (mainnet) fresh for the
    // 10:00 hour (ready 11:02) and stale for the 11:00 hour (ready 12:02).
    await pool.query(
      `insert into public.indexer_checkpoints (lane, chain_id, last_block_number,
         last_block_hash, started_from_block_number, created_at, updated_at)
       values ('launch2_event', $1, 4321, $2, 1, '2026-10-26T13:00:00Z', '2026-10-26T13:00:00Z'),
         ('erc20_transfer', $3, 5000, $4, 1000, '2026-10-26T11:30:00Z', '2026-10-26T11:30:00Z')`,
      [CHAIN, hex(4321), MAINNET, hex(5000)],
    );
    await pool.query(
      `insert into public.indexer_wallet_coverage (chain_id, lane, address, from_block_number)
       values ($1, 'erc20_transfer', $2, 1000), ($1, 'erc20_transfer', $3, 1000),
         ($1, 'erc20_transfer', $4, 1000), ($1, 'erc20_transfer', $5, 2000)`,
      [MAINNET, address(0xa1), address(0xa2), address(0xa3), address(0xa4)],
    );
    // users[1]: 10 CAKE at block 1500 (read 09:00); +5 at block 1600
    // (observed 09:30, before the hour); −3 at block 1700 (observed 10:30).
    // A transfer at or below the reading block, and a removed one, are
    // ignored.
    await snapshot(1, CAKE, 1500, 10n * loop, "2026-10-26T09:00:00Z");
    await transfer({
      from: address(0x99),
      to: address(0xa1),
      amount: 7n * loop,
      block: 1400,
      observedAt: "2026-10-26T08:00:00Z",
    });
    await transfer({
      from: address(0x99),
      to: address(0xa1),
      amount: 5n * loop,
      block: 1600,
      observedAt: "2026-10-26T09:30:00Z",
    });
    await transfer({
      from: address(0xa1),
      to: address(0x99),
      amount: 3n * loop,
      block: 1700,
      observedAt: "2026-10-26T10:30:00Z",
    });
    await transfer({
      from: address(0xa1),
      to: address(0x99),
      amount: 9n * loop,
      block: 1650,
      observedAt: "2026-10-26T10:10:00Z",
      removed: true,
    });
    // users[3] (not a member) holds 50; users[4]'s reading predates its
    // coverage (from block 2000).
    await snapshot(3, CAKE, 1500, 50n * loop, "2026-10-26T09:00:00Z");
    await snapshot(4, CAKE, 1500, 70n * loop, "2026-10-26T09:00:00Z");

    await insertVersion({
      ...miningDefaultParameterDocument,
      releaseStartAt: "2026-10-01T00:00:00.000Z",
      assetWeights: [],
      communityCoefficients: [],
      includedAssets: [CAKE],
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  const settlement = (now: string) =>
    createMiningSettlementRunner({
      repository,
      chainId: CHAIN,
      indexerGraceSeconds: 120,
      embeddedWalletOnly: false,
      now: () => new Date(now),
    });

  it("lists the mainnet token as an erc20-sourced external candidate", async () => {
    const rows = await repository.listMiningPoolCandidates({
      kind: "external",
    });
    expect(
      rows.map((row) => [row.communityName, row.settlementSource]),
    ).toEqual([
      ["BSC News", "erc20"],
      ["Night Owls", "erc20"],
    ]);
  });

  it("settles the let-in token from the pinned reading + transfers, members only, unknown holders at 0", async () => {
    const runner = settlement("2026-10-26T12:10:00.000Z");
    const outcome = await runner.settleHour({
      hourStart: HOUR_S,
      trigger: "scheduled",
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe("settled");
    if (outcome.kind !== "settled") return;
    firstEpochId = outcome.epoch.epochId;
    const summary = outcome.epoch.inputSummary;
    expect(summary["poolExternalReadableAssetIds"]).toEqual([CAKE, ADA]);
    expect(summary["externalOpeningPins"]).toEqual([
      { assetId: CAKE, walletId: wallets[1], blockNumber: "1500" },
    ]);
    // users[0] (creator) has no coverage; users[2] was never read;
    // users[4]'s only reading predates its coverage.
    expect(summary["externalUnknownHolders"]).toEqual([
      {
        assetId: CAKE,
        reasonCode: "MINING_EXTERNAL_BALANCE_UNCOVERED",
        userCount: 1,
      },
      {
        assetId: CAKE,
        reasonCode: "MINING_EXTERNAL_OPENING_MISSING",
        userCount: 2,
      },
    ]);
    expect(summary["poolRosterRule"]).toBe("participating");
    const rows = await repository.listEpochRewards({ epochId: firstEpochId });
    const row = (index: number) =>
      rows.find((entry) => entry.userId === users[index]);
    // 300 ALPHA + CAKE 15 for half an hour then 12 → 13.5.
    expect(row(1)?.assetSelfPower).toBe("313.5");
    expect(
      row(1)?.assetHoldings.find((holding) => holding.assetId === CAKE),
    ).toMatchObject({ balanceAtEndRaw: (12n * loop).toString() });
    expect(row(2)?.assetSelfPower ?? "0").toBe("0");
    expect(row(3)?.assetSelfPower ?? "0").toBe("0");
    expect(row(4)?.assetSelfPower ?? "0").toBe("0");
    expect(BigInt(outcome.epoch.allocatedAssetRaw)).toBeGreaterThan(0n);

    // A later reading of the same wallet does not move the replay.
    await snapshot(1, CAKE, 4000, 999n * loop, "2026-10-26T12:30:00Z");
    const replay = await runner.replay(firstEpochId);
    expect(replay).toMatchObject({
      digestMatches: true,
      rewardsMatch: true,
      reasonCode: null,
    });
  });

  it("leaves the token out of an hour whose erc20 lane is stale, the platform MEME still settles", async () => {
    const runner = settlement("2026-10-26T13:10:00.000Z");
    const outcome = await runner.settleHour({
      hourStart: NEXT_S,
      trigger: "scheduled",
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe("settled");
    if (outcome.kind !== "settled") return;
    // Night Owls' ADA is not let in, so it is not read at all.
    expect(outcome.epoch.inputSummary["externalStaleAssetIds"]).toEqual([CAKE]);
    expect(outcome.epoch.inputSummary["excludedAssets"]).toEqual([
      {
        assetId: CAKE,
        reasonCode: "MINING_SETTLEMENT_SOURCE_STALE",
        from: "2026-10-26T11:00:00.000Z",
      },
    ]);
    const rows = await repository.listEpochRewards({
      epochId: outcome.epoch.epochId,
    });
    expect(
      rows.find((entry) => entry.userId === users[1])?.assetSelfPower,
    ).toBe("300");
    const replay = await runner.replay(outcome.epoch.epochId);
    expect(replay).toMatchObject({ digestMatches: true, rewardsMatch: true });
  });

  it("gates the snapshot's external balances by membership", async () => {
    const mining = createPostgresMiningRepository(pool);
    const balances = await mining.listBalanceInputs({
      includeMockSeedHoldings: false,
      embeddedWalletOnly: false,
    });
    const holders = balances
      .filter((balance) => balance.assetId === CAKE)
      .map((balance) => balance.ownerUserId)
      .sort();
    // users[3] holds CAKE but is not a member of BSC News.
    expect(holders).toEqual([users[1], users[4]].sort());
  });

  it("keeps the 0187 community rank projection for an hour settled before 0189", async () => {
    const mining = createPostgresMiningRepository(pool);
    const ranked = async () =>
      (await mining.listCommunityRanking({ epochId: firstEpochId, limit: 10 }))
        .map((row) => row.communityId)
        .sort();
    // Participating rule: Night Owls (ADA, not let in) is not ranked.
    expect(await ranked()).toEqual(
      [communities["alpha"], communities["news"]].sort(),
    );
    // The same epoch without the poolRosterRule / poolExternalAssetIds summary keys (a pre-0189
    // hour): every bound community except an unticked platform MEME.
    // (Settled epochs are immutable; the fixture edits it as superuser
    // with triggers off.)
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(
        `update public.mining_epochs
         set input_summary = input_summary - 'poolRosterRule' - 'poolExternalAssetIds'
         where epoch_id = $1`,
        [firstEpochId],
      );
    } finally {
      await client.query("set session_replication_role = origin");
      client.release();
    }
    expect(await ranked()).toEqual(
      [communities["alpha"], communities["news"], communities["owls"]].sort(),
    );
  });
});
