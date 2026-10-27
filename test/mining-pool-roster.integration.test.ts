import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresMiningRepository } from "../src/database/mining-repository.js";
import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import {
  miningDefaultParameterDocument,
  type MiningParameterDocument,
} from "../src/features/mining/hourly-settlement-contract.js";
import {
  MiningCommunityUnknownError,
  type MiningSettlementRepository,
} from "../src/features/mining/hourly-settlement-ports.js";
import {
  admittedAssetIds,
  createMiningSettlementRunner,
} from "../src/features/mining/hourly-settlement-runner.js";
import { computeMiningPoolSnapshot } from "../src/features/mining/mining-pool-snapshot.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { loop } from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0187 on PostgreSQL, in a throwaway database: the pool roster
 * query (verified community × launch2 MEME, any chain; filters and keyset
 * paging), the launch2 checkpoint read, an hour settled with a roster MEME
 * that `assetWeights` does not list (weight 1, members only), the snapshot
 * pool part on the same facts at one instant, and approval refusing an
 * unverified `excludedCommunities` id.
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
const MEME_A = "0xaaaa111111111111111111111111111111116666";
const MEME_B = "0xbbbb111111111111111111111111111111116666";
const MEME_C = "0xcccc111111111111111111111111111111116666";
const NFT_A = "0xaaaa222222222222222222222222222222222222";
const ASSET_A = `${CHAIN}:${MEME_A}`;
const ASSET_B = `${CHAIN}:${MEME_B}`;
const ASSET_C = `eip155:56:${MEME_C}`;

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

describe("Decision 0187 mining pool roster on PostgreSQL", () => {
  const databaseName = `loop_s313_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let repository: MiningSettlementRepository;
  const users: string[] = [];
  const communities: Record<string, string> = {};
  let instanceA = "";
  let settledEpochId = "";
  let log = 0;

  async function user(index: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s313:${randomUUID()}`],
    );
    const id = result.rows[0]!.id;
    await pool.query(
      `insert into public.account_wallets (owner_user_id, provider_wallet_id, address,
         kind, status, is_active, first_seen_at, last_seen_at)
       values ($1, $2, $3, 'embedded', 'active', true, '2026-01-01', '2026-01-01')`,
      [
        id,
        `privy-s313-${index}-${randomUUID().slice(0, 8)}`,
        address(0xa0 + index),
      ],
    );
    return id;
  }

  async function community(
    name: string,
    asset: string,
    status: "verified" | "pending",
  ): Promise<string> {
    const result = await pool.query<{ community_id: string }>(
      status === "verified"
        ? `insert into public.communities (name, slug, bound_asset_key, created_by_user_id,
             verification_status, verified_at, reviewed_at, created_at)
           values ($1, $2, $3, $4, 'verified', '2026-10-01', '2026-10-01', '2026-10-01')
           returning community_id`
        : `insert into public.communities (name, slug, bound_asset_key, created_by_user_id, created_at)
           values ($1, $2, $3, $4, '2026-10-01') returning community_id`,
      [name, name.toLowerCase().replaceAll(" ", "-"), asset, users[0]],
    );
    return result.rows[0]!.community_id;
  }

  async function instance(
    client: pg.PoolClient,
    chain: string,
    meme: string,
    ticker: string,
    nft: string,
    launch: number,
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `insert into public.launch2_instances (instance_id, job_id, project_id,
         config_version, owner_user_id, chain_id, factory_address, launch_id, config_hash,
         project_owner, name, ticker, meme_address, hook_address, nft_address,
         curve_address, gate_address, escrow_address, snapshots_address,
         graduation_adapter_address, buyback_adapter_address, price_recorder_address,
         buyback_executor_address, buyback_recipient, nft_sale_start, deploy_block_number,
         factory_generation)
       values ($1, $2, $3, 1, $4, $5, $6, $7, $7, $6, $8, $8, $9, $6, $10,
         $6, $6, $6, $6, $6, $6, $6, $6, $6, '2026-10-01', 1, 'v3')`,
      [
        id,
        randomUUID(),
        randomUUID(),
        users[0],
        chain,
        address(0xf),
        hex(launch),
        ticker,
        meme,
        nft,
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
    // users[0] creator, users[1] member holding MEME_A, users[2] non-member
    // holding MEME_A, users[3] member holding 3 NFTs of A.
    for (let index = 0; index < 4; index += 1) users.push(await user(index));
    communities["alpha"] = await community("Alpha Frogs", ASSET_A, "verified");
    communities["beta"] = await community("Beta Pending", ASSET_B, "pending");
    communities["gamma"] = await community("Gamma Main", ASSET_C, "verified");
    for (const index of [1, 3]) {
      await pool.query(
        `insert into public.community_memberships (community_id, owner_user_id, role, status,
           joined_at, updated_at)
         values ($1, $2, 'member', 'active', '2026-10-01', '2026-10-01')`,
        [communities["alpha"], users[index]],
      );
    }
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      instanceA = await instance(client, CHAIN, MEME_A, "ALPHA", NFT_A, 1);
      await instance(client, CHAIN, MEME_B, "BETA", address(0xb2), 2);
      await instance(client, "eip155:56", MEME_C, "GAMMA", address(0xc2), 3);
      for (const [index, amount] of [
        [1, 300n],
        [2, 700n],
      ] as const) {
        log += 1;
        await client.query(
          `insert into public.launch2_trades (trade_id, chain_id, transaction_hash, log_index,
             block_number, block_hash, instance_id, side, trader_address, meme_amount,
             cumulative_bought, traded_at)
           values ($1, $2, $3, 0, $4, $5, $6, 'buy', $7, $8, $8, '2026-10-20T00:00:00Z')`,
          [
            randomUUID(),
            CHAIN,
            hex(0xbeef + log),
            log,
            hex(0xfeed + log),
            instanceA,
            address(0xa0 + index),
            (amount * loop).toString(),
          ],
        );
      }
      for (let token = 1; token <= 3; token += 1) {
        log += 1;
        await client.query(
          `insert into public.launch2_events (chain_id, transaction_hash, log_index,
             block_number, block_hash, instance_id, contract_address, event_name, payload, event_at)
           values ($1, $2, 0, $3, $4, $5, $6, 'Transfer', $7::jsonb, '2026-10-20T00:00:00Z')`,
          [
            CHAIN,
            hex(log),
            log,
            hex(log + 1_000_000),
            instanceA,
            NFT_A,
            JSON.stringify({
              from: "0x0000000000000000000000000000000000000000",
              to: address(0xa3),
              tokenId: String(token),
            }),
          ],
        );
      }
    } finally {
      await client.query("set session_replication_role = origin");
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

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
        `s313-${randomUUID().slice(0, 8)}`,
        JSON.stringify(document),
        effectiveFrom,
      ],
    );
  }

  it("lists verified community × launch2 MEME (any chain), filters and pages", async () => {
    const all = await repository.listMiningPoolCandidates({});
    expect(
      all.map((row) => [row.communityName, row.assetId, row.symbol]),
    ).toEqual([
      ["Alpha Frogs", ASSET_A, "ALPHA"],
      ["Gamma Main", ASSET_C, "GAMMA"],
    ]);
    expect(all[0]).toMatchObject({
      communityId: communities["alpha"],
      chainId: CHAIN,
      memeAddress: MEME_A,
      instanceId: instanceA,
      launchId: hex(1),
    });
    expect(
      (await repository.listMiningPoolCandidates({ chainId: CHAIN })).map(
        (row) => row.assetId,
      ),
    ).toEqual([ASSET_A]);
    expect(
      (
        await repository.listMiningPoolCandidates({
          address: MEME_C.toUpperCase().replace("0X", "0x"),
        })
      ).map((row) => row.assetId),
    ).toEqual([ASSET_C]);
    expect(
      (await repository.listMiningPoolCandidates({ query: "gam" })).map(
        (row) => row.communityName,
      ),
    ).toEqual(["Gamma Main"]);
    expect(
      (await repository.listMiningPoolCandidates({ query: "alpha" })).map(
        (row) => row.communityName,
      ),
    ).toEqual(["Alpha Frogs"]);
    expect(await repository.listMiningPoolCandidates({ query: "%" })).toEqual(
      [],
    );
    const first = await repository.listMiningPoolCandidates({ limit: 1 });
    expect(first.map((row) => row.communityName)).toEqual(["Alpha Frogs"]);
    const next = await repository.listMiningPoolCandidates({
      limit: 1,
      after: {
        communityName: first[0]!.communityName,
        communityId: first[0]!.communityId,
      },
    });
    expect(next.map((row) => row.communityName)).toEqual(["Gamma Main"]);
  });

  it("reads the launch2 checkpoint (null before the lane's first tick)", async () => {
    expect(await repository.readLaunch2Checkpoint(CHAIN)).toBeNull();
    await pool.query(
      `insert into public.indexer_checkpoints (lane, chain_id, last_block_number,
         last_block_hash, started_from_block_number, created_at, updated_at)
       values ('launch2_event', $1, 4321, $2, 1, '2026-10-26T11:05:00Z', '2026-10-26T11:05:00Z')`,
      [CHAIN, hex(4321)],
    );
    expect(await repository.readLaunch2Checkpoint(CHAIN)).toEqual({
      blockNumber: "4321",
      blockHash: hex(4321),
    });
  });

  it("settles a roster MEME at weight 1 without assetWeights, members only, and the snapshot agrees", async () => {
    await insertVersion({
      ...miningDefaultParameterDocument,
      releaseStartAt: "2026-10-01T00:00:00.000Z",
      assetWeights: [],
      communityCoefficients: [],
    });
    const settlement = createMiningSettlementRunner({
      repository,
      chainId: CHAIN,
      indexerGraceSeconds: 120,
      embeddedWalletOnly: false,
      now: () => new Date("2026-10-26T11:10:00.000Z"),
    });
    const outcome = await settlement.settleHour({
      hourStart: HOUR_S,
      trigger: "scheduled",
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe("settled");
    if (outcome.kind !== "settled") return;
    settledEpochId = outcome.epoch.epochId;
    expect(outcome.epoch.inputSummary["poolRosterAssetIds"]).toEqual([ASSET_A]);
    const rows = await repository.listEpochRewards({
      epochId: outcome.epoch.epochId,
    });
    const row = (index: number) =>
      rows.find((entry) => entry.userId === users[index]);
    expect(row(1)?.assetSelfPower).toBe("300");
    // users[2] holds 700 but is not a member of the verified community.
    expect(row(2)?.assetSelfPower ?? "0").toBe("0");
    expect(row(3)?.nftSelfPower).toBe("3");
    expect(BigInt(outcome.epoch.allocatedAssetRaw)).toBe(
      BigInt(outcome.epoch.budgetAssetRaw),
    );
    const replay = await settlement.replay(outcome.epoch.epochId);
    expect(replay).toMatchObject({ digestMatches: true, rewardsMatch: true });

    // The snapshot pool part on the same facts at one instant.
    const at = HOUR_S + 1_800n;
    const versions = await repository.listApprovedParameterVersions();
    const facts = await repository.readSettlementFacts({
      chainId: CHAIN,
      hourStart: at,
      hourEnd: at + 1n,
      assetIds: admittedAssetIds(versions, at, at + 1n, [ASSET_A]),
      embeddedWalletOnly: false,
    });
    const part = computeMiningPoolSnapshot({
      at,
      versions,
      poolAssetIds: [ASSET_A],
      facts,
      block: await repository.readLaunch2Checkpoint(CHAIN),
      registeredAssetIds: new Set([ASSET_A]),
    });
    expect(part.kind).toBe("computed");
    if (part.kind !== "computed") return;
    expect(
      part.powers.map((entry) => [
        entry.ownerUserId,
        entry.holding,
        entry.power,
      ]),
    ).toEqual(
      [
        [users[1], "300", "300"],
        [users[3], "0", "3"],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
  });

  it("appendix A: community weight / standing / rank read the roster (token weight, unticked not ranked)", async () => {
    const mining = createPostgresMiningRepository(pool);
    const formulaVersion = "s313-formula";
    const snapshotId = randomUUID();
    await pool.query(
      `insert into public.mining_formula_versions (config_version, formula, weight_range,
         price_guard_rules, status, effective_at, approved_at)
       values ($1, $2::jsonb, '{}'::jsonb, '[]'::jsonb, 'approved', now(), now())`,
      [
        formulaVersion,
        JSON.stringify({
          kind: "holding_times_reference_price_times_weight",
          expressionKey: "k",
          dailyOutputKey: "k",
          assetWeights: {},
          referralBoost: { status: "pending_approval" },
        }),
      ],
    );
    await pool.query(
      `insert into public.assets (asset_id, chain_id, address, symbol, name, decimals,
         status, source_kind, source_block_number, source_verified_at)
       values ($1, $2, $3, 'ALPHA', 'Alpha', 18, 'pending', 'chain_call', 1, now())`,
      [ASSET_A, CHAIN, MEME_A],
    );
    await pool.query(
      `insert into public.mining_snapshots (snapshot_id, block_number, block_hash,
         formula_version, price_version, total_power, account_count, status, holdings_source)
       values ($1, 4321, $2, $3, 'launch2_curve:2026-10-26T10:30:00.000Z', '1003', 3,
         'complete', 'chain')`,
      [snapshotId, hex(4321), formulaVersion],
    );
    for (const [index, power] of [
      [1, "300"],
      [2, "700"],
      [3, "3"],
    ] as const) {
      await pool.query(
        `insert into public.mining_snapshot_powers (snapshot_id, owner_user_id, asset_id,
           holding, reference_price_usd, reference_price_quality, weight, power, block_number)
         values ($1, $2, $3, '0', '0', 'fresh', '1', $4, 4321)`,
        [snapshotId, users[index], ASSET_A, power],
      );
    }
    const inForce = (await repository.listApprovedParameterVersions())[0]!;
    const alphaWeight = await mining.getCommunityWeight(communities["alpha"]!);
    expect(alphaWeight).toMatchObject({
      status: "approved",
      weight: "1",
      configVersion: inForce.configVersion,
      source: "roster",
      rosterExcluded: false,
    });
    expect(alphaWeight?.reviewedAt).not.toBeNull();
    expect(await mining.getCommunityWeight(communities["beta"]!)).toMatchObject(
      { status: "pending_review", source: "review" },
    );
    // Members only (users[2] is not one): 300 + 3.
    expect(
      await mining.getCommunityStanding({
        snapshotId,
        configVersion: formulaVersion,
        communityId: communities["alpha"]!,
      }),
    ).toMatchObject({
      weight: "1",
      power: "303",
      participantCount: 2,
      position: 1,
    });
    // A roster community on another chain is listed with zero power.
    expect(
      await mining.getCommunityStanding({
        snapshotId,
        configVersion: formulaVersion,
        communityId: communities["gamma"]!,
      }),
    ).toMatchObject({ weight: "1", power: "0", position: null });
    expect(
      await mining.getCommunityStanding({
        snapshotId,
        configVersion: formulaVersion,
        communityId: communities["beta"]!,
      }),
    ).toBeNull();
    // The settled hour's community rank shows the roster token weight.
    const ranking = await mining.listCommunityRanking({
      epochId: settledEpochId,
      limit: 10,
    });
    expect(
      ranking.find((row) => row.communityId === communities["alpha"]),
    ).toMatchObject({ weight: "1", position: 1 });

    // Unticked in a newer version: no weight, not ranked.
    await insertVersion(
      {
        ...miningDefaultParameterDocument,
        releaseStartAt: "2026-10-01T00:00:00.000Z",
        assetWeights: [],
        communityCoefficients: [],
        excludedAssets: [ASSET_A],
        excludedCommunities: [communities["alpha"]!],
      },
      "2026-10-02T00:00:00Z",
    );
    expect(
      await mining.getCommunityWeight(communities["alpha"]!),
    ).toMatchObject({
      status: "pending_review",
      weight: null,
      source: "roster",
      rosterExcluded: true,
    });
    expect(
      await mining.getCommunityStanding({
        snapshotId,
        configVersion: formulaVersion,
        communityId: communities["alpha"]!,
      }),
    ).toBeNull();
  });

  it("refuses to approve a draft excluding a community that is not verified", async () => {
    const hash = await hashAdminPassword("s313-password-0123");
    const reviewerUser = await user(9);
    await pool.query(
      `insert into public.ops_operators (user_id, label, enabled) values ($1, 's313-reviewer', true)`,
      [reviewerUser],
    );
    const reviewerId = randomUUID();
    await pool.query(
      `insert into public.admin_accounts (id, username, password_hash, role, operator_user_id, created_by, created_at, credentials_changed_at)
       values ($1, 's313-reviewer', $2, 'reviewer', $3, 'operator', now(), now())`,
      [reviewerId, hash, reviewerUser],
    );
    const audit = (action: string) => ({
      actor: "s313-reviewer",
      actorAccountId: reviewerId,
      action,
      targetType: "mining_parameter_version",
      targetId: null,
      requestId: randomUUID(),
    });
    const draft = await repository.createParameterDraft({
      configVersion: "s313-excluded-pending",
      document: {
        ...miningDefaultParameterDocument,
        releaseStartAt: "2026-10-01T00:00:00.000Z",
        assetWeights: [],
        communityCoefficients: [],
        excludedAssets: [ASSET_A],
        excludedCommunities: [communities["alpha"]!, communities["beta"]!],
      },
      effectiveFrom: "2099-03-01T00:00:00.000Z",
      author: { actor: "operator", accountId: null },
      audit: audit("mining.parameters.draft"),
    });
    expect(draft.version.document.excludedCommunities).toEqual(
      [communities["alpha"], communities["beta"]].sort(),
    );
    const requested = await repository.recordAudit(
      audit("mining.parameters.approve.requested"),
    );
    const refusal = repository.approveParameterVersion({
      versionId: draft.version.versionId,
      approver: { actor: "s313-reviewer", accountId: reviewerId },
      requestedAuditId: requested.auditId,
      audit: audit("mining.parameters.approve"),
    });
    await expect(refusal).rejects.toBeInstanceOf(MiningCommunityUnknownError);
    await expect(refusal).rejects.toMatchObject({
      communityIds: [communities["beta"]],
    });
  });
});
