import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresMiningSettlementRepository } from "../src/database/mining-settlement-repository.js";
import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import { createMiningClaimSigner } from "../src/features/mining/claim-voucher.js";
import { createMiningRewardsService } from "../src/features/mining/hourly-rewards-service.js";
import {
  miningDefaultParameterDocument,
  type MiningParameterDocument,
} from "../src/features/mining/hourly-settlement-contract.js";
import {
  MiningSettlementConflictError,
  type MiningSettlementRepository,
} from "../src/features/mining/hourly-settlement-ports.js";
import { createMiningSettlementRunner } from "../src/features/mining/hourly-settlement-runner.js";
import { launch2PriceAt } from "../src/features/launch2/launch2-curve-math.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { walletsFake } from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
  memeUsd1,
} from "./helpers/meme-service-fakes.js";
import {
  claimContract,
  createFakeClaimChain,
  defaultClaimChainState,
  landClaim,
  loop,
  signerKey,
} from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0116 on PostgreSQL (migration 000062), in a throwaway database:
 * one hour settled from launch2 facts (NFT Transfer timeline, curve trades),
 * the five-level graph (a sixth ancestor and a zero-power invitee get
 * nothing), the UTC 23:00 budget remainder, idempotent re-runs (ledger
 * once), immutable history, replay, parameter approval rules, and the claim
 * prepare / report flow on the real ledger (gas branch, nonce invalidation,
 * report idempotency).
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const CHAIN = "eip155:97";
const HOUR = "2026-10-09T23:00:00.000Z";
const HOUR_S = BigInt(Date.parse(HOUR) / 1000);
const MEME = "0x1111111111111111111111111111111111116666";
const NFT = "0x2222222222222222222222222222222222222222";
const ASSET = `${CHAIN}:${MEME}`;
const DAILY = 500_000n * loop;

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

describe("Decision 0116 hourly settlement on PostgreSQL", () => {
  const databaseName = `loop_s138_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let repository: MiningSettlementRepository;
  const users: string[] = [];
  const wallets: string[] = [];
  let communityId = "";
  let versionId = "";
  let log = 0;

  async function user(index: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s138:${randomUUID()}`],
    );
    const id = result.rows[0]!.id;
    await pool.query(
      `insert into public.account_wallets (owner_user_id, provider_wallet_id, address,
         kind, status, is_active, first_seen_at, last_seen_at)
       values ($1, $2, $3, 'embedded', 'active', true, '2026-01-01', '2026-01-01')`,
      [
        id,
        `privy-s138-${index}-${randomUUID().slice(0, 8)}`,
        address(0xa0 + index),
      ],
    );
    return id;
  }

  async function event(input: {
    readonly name: string;
    readonly payload: Record<string, unknown>;
    readonly at: string;
    readonly instanceId: string;
  }) {
    log += 1;
    await pool.query(
      `insert into public.launch2_events (chain_id, transaction_hash, log_index,
         block_number, block_hash, instance_id, contract_address, event_name, payload, event_at)
       values ($1, $2, 0, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
      [
        CHAIN,
        hex(log),
        log,
        hex(log + 1_000_000),
        input.instanceId,
        NFT,
        input.name,
        JSON.stringify(input.payload),
        input.at,
      ],
    );
  }

  async function insertVersion(
    document: MiningParameterDocument,
    effectiveFrom: string,
  ) {
    const id = randomUUID();
    await pool.query(
      `insert into public.mining_parameter_versions (version_id, config_version, status,
         document, effective_from, draft_author_actor, approved_by, approved_at)
       values ($1, $2, 'approved', $3::jsonb, $4::timestamptz, 'seed', 'seed-reviewer', clock_timestamp())`,
      [id, `seed-${id.slice(0, 8)}`, JSON.stringify(document), effectiveFrom],
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
    // users[0] is the sixth ancestor of users[6]; users[7] has no power.
    for (let index = 0; index < 8; index += 1) users.push(await user(index));
    for (let index = 0; index < 8; index += 1)
      wallets.push(address(0xa0 + index));
    const edges: Array<[number, number, number]> = [];
    for (let invitee = 1; invitee <= 6; invitee += 1) {
      for (let depth = 1; depth <= 5 && invitee - depth >= 0; depth += 1) {
        edges.push([invitee - depth, invitee, depth]);
      }
    }
    edges.push([0, 7, 1]);
    for (const [inviter, invitee, depth] of edges) {
      await pool.query(
        `insert into public.referral_edges (inviter_user_id, invitee_user_id, depth,
           validation_status, effective_from)
         values ($1, $2, $3, 'valid', '2026-10-01')`,
        [users[inviter], users[invitee], depth],
      );
    }
    const community = await pool.query<{ community_id: string }>(
      `insert into public.communities (name, slug, bound_asset_key, created_by_user_id)
       values ('S138 Frogs', 's138-frogs', $1, $2) returning community_id`,
      [ASSET, users[0]],
    );
    communityId = community.rows[0]!.community_id;
    // Launch2 facts. FK chains to the S132 task tables are not under test.
    const instanceId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(
        `insert into public.launch2_instances (instance_id, job_id, project_id,
           config_version, owner_user_id, chain_id, factory_address, launch_id, config_hash,
           project_owner, name, ticker, meme_address, hook_address, nft_address,
           curve_address, gate_address, escrow_address, snapshots_address,
           graduation_adapter_address, buyback_adapter_address, price_recorder_address,
           buyback_executor_address, buyback_recipient, nft_sale_start, deploy_block_number)
         values ($1, $2, $3, 1, $4, $5, $6, $7, $7, $6, 'S138', 'FROG', $8, $6, $9,
           $6, $6, $6, $6, $6, $6, $6, $6, $6, '2026-10-01', 1)`,
        [
          instanceId,
          randomUUID(),
          randomUUID(),
          users[0],
          CHAIN,
          address(0xf),
          hex(7),
          MEME,
          NFT,
        ],
      );
      await client.query(
        `insert into public.launch2_trades (trade_id, chain_id, transaction_hash, log_index,
           block_number, block_hash, instance_id, side, trader_address, meme_amount,
           cumulative_bought, traded_at)
         values ($1, $2, $3, 0, 5, $4, $5, 'buy', $6, $7, $7, '2026-10-09T20:00:00Z')`,
        [
          randomUUID(),
          CHAIN,
          hex(0xbeef),
          hex(0xbeef + 1),
          instanceId,
          wallets[5],
          (1_000n * loop).toString(),
        ],
      );
    } finally {
      await client.query("set session_replication_role = origin");
      client.release();
    }
    // users[6] minted 5 NFTs before the hour.
    for (let token = 1; token <= 5; token += 1) {
      await event({
        name: "Transfer",
        instanceId,
        at: "2026-10-09T12:00:00Z",
        payload: {
          from: "0x0000000000000000000000000000000000000000",
          to: wallets[6],
          tokenId: String(token),
        },
      });
    }
    await pool.query(
      `insert into public.indexer_checkpoints (lane, chain_id, last_block_number,
         last_block_hash, started_from_block_number, created_at, updated_at)
       values ('launch2_event', $1, 100, $2, 1, '2026-10-10T00:05:00Z', '2026-10-10T00:05:00Z')`,
      [CHAIN, hex(100)],
    );
    versionId = await insertVersion(
      {
        ...miningDefaultParameterDocument,
        referralRatiosBps: [1000, 500, 300, 200, 100],
        releaseStartAt: "2026-10-09T00:00:00.000Z",
        assetWeights: [{ assetId: ASSET, weight: "1" }],
        communityCoefficients: [{ communityId, coefficient: "2" }],
      },
      "2026-10-09T00:00:00.000Z",
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  const settleRunner = () =>
    createMiningSettlementRunner({
      repository,
      chainId: CHAIN,
      indexerGraceSeconds: 120,
      now: () => new Date("2026-10-10T00:10:00.000Z"),
    });

  it("settles the hour: five levels, sixth ancestor and zero-power invitee excluded, 23:00 remainder", async () => {
    const outcome = await settleRunner().settleHour({
      hourStart: HOUR_S,
      trigger: "scheduled",
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe("settled");
    if (outcome.kind !== "settled") return;
    const remainderBudget = DAILY - 23n * (DAILY / 24n);
    expect(outcome.epoch.budgetNftRaw).toBe(remainderBudget.toString());
    expect(outcome.epoch.versionId).toBe(versionId);
    const rows = await repository.listEpochRewards({
      epochId: outcome.epoch.epochId,
    });
    const row = (index: number) =>
      rows.find((entry) => entry.userId === users[index]);
    expect(row(6)?.nftSelfPower).toBe("10");
    expect(row(6)?.nftHoldings[0]?.countAtEnd).toBe("5");
    expect(row(5)?.levels[0]).toMatchObject({
      nftPower: "1",
      effectiveMembers: 1,
      nftUnitsByCommunity: [{ communityId, units: "0.5" }],
    });
    expect(row(4)?.levels[1]?.nftPower).toBe("0.5");
    expect(row(3)?.levels[2]?.nftPower).toBe("0.3");
    expect(row(2)?.levels[3]?.nftPower).toBe("0.2");
    expect(row(1)?.levels[4]).toMatchObject({
      nftPower: "0.1",
      nftUnitsByCommunity: [{ communityId, units: "0.05" }],
    });
    // users[0] is the sixth NFT ancestor: no NFT boost. Its L1 invitee
    // users[7] has no power and is not counted.
    expect(row(0)?.nftReferralPower ?? "0").toBe("0");
    expect(row(0)?.levels[0]?.effectiveMembers ?? 0).toBe(0);
    // Asset: users[5] holds 1000 MEME at the curve price; users[0] is its
    // fifth ancestor (1%).
    const price = launch2PriceAt(1_000n * loop);
    const assetPower = (1_000n * price) / 1n;
    const fixed = (value: string) => {
      const [whole, fraction = ""] = value.split(".");
      return BigInt(whole!) * loop + BigInt(fraction.padEnd(18, "0"));
    };
    expect(fixed(row(5)!.assetSelfPower)).toBe(assetPower);
    expect(fixed(row(0)!.levels[4]!.assetPower)).toBe(assetPower / 100n);
    // Σ rewards = allocated ≤ budget, per track.
    const nftSum = rows.reduce(
      (sum, entry) => sum + BigInt(entry.nftRewardRaw),
      0n,
    );
    expect(nftSum.toString()).toBe(outcome.epoch.allocatedNftRaw);
    expect(
      BigInt(outcome.epoch.allocatedNftRaw) +
        BigInt(outcome.epoch.unallocatedNftRaw),
    ).toBe(remainderBudget);
    const balance = await repository.getBalance(users[6]!);
    expect(balance.settledTotalRaw).toBe(row(6)!.totalRewardRaw);
  });

  it("§9-10 re-running the hour records it once (runner and repository both)", async () => {
    const events = async () =>
      (
        await pool.query<{ n: string }>(
          "select count(*)::text as n from public.mining_reward_ledger_events where kind = 'settled'",
        )
      ).rows[0]!.n;
    const before = await events();
    const balance = await repository.getBalance(users[6]!);
    expect(
      (
        await settleRunner().settleHour({
          hourStart: HOUR_S,
          trigger: "scheduled",
        })
      ).kind,
    ).toBe("already_settled");
    const epoch = (await repository.getEpochByHour(HOUR))!;
    const again = await repository.commitEpoch({
      hourStart: HOUR,
      hourEnd: "2026-10-10T00:00:00.000Z",
      versionId,
      trigger: "test_trigger",
      budgetNftRaw: "1",
      budgetAssetRaw: "1",
      denominatorNftPower: "1",
      denominatorAssetPower: "1",
      allocatedNftRaw: "1",
      allocatedAssetRaw: "0",
      unallocatedNftRaw: "0",
      unallocatedAssetRaw: "1",
      inputDigest: "b".repeat(64),
      inputSummary: {},
      rewards: [],
    });
    expect(again.created).toBe(false);
    expect(again.epoch.inputDigest).toBe(epoch.inputDigest);
    expect(await events()).toBe(before);
    expect(await repository.getBalance(users[6]!)).toEqual(balance);
  });

  it("§9-13 keeps settled history immutable and replays to the same digest", async () => {
    const epoch = (await repository.getEpochByHour(HOUR))!;
    await expect(
      pool.query(
        "update public.mining_epochs set user_count = 0 where epoch_id = $1",
        [epoch.epochId],
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      pool.query("delete from public.mining_reward_ledger_events"),
    ).rejects.toThrow(/append-only/u);
    await expect(
      pool.query(
        "update public.mining_parameter_versions set document = '{}'::jsonb where version_id = $1",
        [versionId],
      ),
    ).rejects.toThrow(/immutable/u);
    const replay = await settleRunner().replay(epoch.epochId);
    expect(replay).toMatchObject({
      digestMatches: true,
      rewardsMatch: true,
      mismatchedUserCount: 0,
    });
  });

  it("enforces reviewer approval rules on parameter versions", async () => {
    const hash = await hashAdminPassword("s138-password-0123");
    const reviewerUser = await user(20);
    await pool.query(
      `insert into public.ops_operators (user_id, label, enabled) values ($1, 'reviewer', true)`,
      [reviewerUser],
    );
    const reviewerId = randomUUID();
    await pool.query(
      `insert into public.admin_accounts (id, username, password_hash, role, operator_user_id, created_by)
       values ($1, 's138-reviewer', $2, 'reviewer', $3, 'operator')`,
      [reviewerId, hash, reviewerUser],
    );
    const audit = (action: string) => ({
      actor: "s138-reviewer",
      actorAccountId: reviewerId,
      action,
      targetType: "mining_parameter_version",
      targetId: null,
      requestId: randomUUID(),
    });
    const document = {
      ...miningDefaultParameterDocument,
      releaseStartAt: "2026-10-09T00:00:00.000Z",
      assetWeights: [],
      communityCoefficients: [],
    };
    const own = await repository.createParameterDraft({
      configVersion: "s138-own",
      document,
      effectiveFrom: "2099-01-01T00:00:00.000Z",
      author: { actor: "s138-reviewer", accountId: reviewerId },
      audit: audit("mining.parameters.draft"),
    });
    const requested = await repository.recordAudit(
      audit("mining.parameters.approve.requested"),
    );
    await expect(
      repository.approveParameterVersion({
        versionId: own.version.versionId,
        approver: { actor: "s138-reviewer", accountId: reviewerId },
        requestedAuditId: requested.auditId,
        audit: audit("mining.parameters.approve"),
      }),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_FORMULA_SELF_APPROVAL" });
    const other = await repository.createParameterDraft({
      configVersion: "s138-other",
      document,
      effectiveFrom: "2099-01-01T00:00:00.000Z",
      author: { actor: "operator", accountId: null },
      audit: audit("mining.parameters.draft"),
    });
    const approved = await repository.approveParameterVersion({
      versionId: other.version.versionId,
      approver: { actor: "s138-reviewer", accountId: reviewerId },
      requestedAuditId: requested.auditId,
      audit: audit("mining.parameters.approve"),
    });
    expect(approved.version.status).toBe("approved");
    // A version whose effective time has passed cannot be approved.
    const late = await repository.createParameterDraft({
      configVersion: "s138-late",
      document,
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      author: { actor: "operator", accountId: null },
      audit: audit("mining.parameters.draft"),
    });
    await expect(
      repository.approveParameterVersion({
        versionId: late.version.versionId,
        approver: { actor: "s138-reviewer", accountId: reviewerId },
        requestedAuditId: requested.auditId,
        audit: audit("mining.parameters.approve"),
      }),
    ).rejects.toBeInstanceOf(MiningSettlementConflictError);
  });

  describe("claims on the real ledger", () => {
    const principal = () =>
      ({ userId: users[6]! }) as unknown as AuthenticatedLoopPrincipal;
    const walletId = randomUUID();

    function service(
      chain: ReturnType<typeof defaultClaimChainState>,
      funds = defaultMemeFunds(),
      now = new Date("2026-10-10T00:20:00.000Z"),
    ) {
      return createMiningRewardsService({
        repository,
        chain: createFakeClaimChain(chain),
        callClient: createFakeMemeSlotClient(funds),
        wallets: walletsFake({ walletId, address: wallets[6]! }),
        signer: createMiningClaimSigner(signerKey),
        contractAddress: claimContract,
        chainId: CHAIN,
        writesEnabled: true,
        usdtAddress: memeUsd1,
        confirmations: 3,
        cursorCodec: null,
        now: () => now,
      });
    }

    it("gas branch writes nothing; prepare → land → report succeeds once; the other voucher dies by nonce", async () => {
      const chain = defaultClaimChainState();
      const settled = BigInt(
        (await repository.getBalance(users[6]!)).settledTotalRaw,
      );
      await expect(
        service(
          chain,
          defaultMemeFunds({ nativeBalance: 0n, usd1Balance: 0n }),
        ).prepareClaim({
          principal: principal(),
          body: { walletId },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_BALANCE",
        detailsSafe: { reasonCode: "CLAIM_NO_GAS_SOURCE" },
      });
      expect(
        (await pool.query("select 1 from public.mining_claims")).rowCount,
      ).toBe(0);

      const rewards = service(chain);
      const key = randomUUID();
      const first = (await rewards.prepareClaim({
        principal: principal(),
        body: { walletId },
        idempotencyKey: key,
      })) as {
        claim: { claimId: string; cumulativeAmountRaw: string; nonce: string };
      };
      expect(first.claim.cumulativeAmountRaw).toBe(settled.toString());
      const replay = (await rewards.prepareClaim({
        principal: principal(),
        body: { walletId },
        idempotencyKey: key,
      })) as { claim: { claimId: string } };
      expect(replay.claim.claimId).toBe(first.claim.claimId);
      const second = (await rewards.prepareClaim({
        principal: principal(),
        body: { walletId },
        idempotencyKey: randomUUID(),
      })) as { claim: { claimId: string } };

      const hash = landClaim(chain, {
        wallet: wallets[6]!,
        cumulativeAmountRaw: settled,
        transactionHash: hex(0xc1a1),
      });
      const reportKey = randomUUID();
      const reported = (await rewards.reportClaim({
        principal: principal(),
        body: { claimId: first.claim.claimId, transactionHash: hash },
        idempotencyKey: reportKey,
      })) as { claim: { status: string } };
      expect(reported.claim.status).toBe("succeeded");
      for (const again of [reportKey, randomUUID()]) {
        await rewards.reportClaim({
          principal: principal(),
          body: { claimId: first.claim.claimId, transactionHash: hash },
          idempotencyKey: again,
        });
      }
      const claimedEvents = await pool.query(
        "select amount_raw::text from public.mining_reward_ledger_events where kind = 'claimed'",
      );
      expect(claimedEvents.rows).toEqual([{ amount_raw: settled.toString() }]);
      expect(await repository.getBalance(users[6]!)).toMatchObject({
        claimedTotalRaw: settled.toString(),
        unclaimedRaw: "0",
      });
      // The second voucher (same nonce) is dead once the first landed.
      const later = service(
        chain,
        defaultMemeFunds(),
        new Date("2026-10-10T00:40:00.000Z"),
      );
      for (const claim of await repository.listUnresolvedClaims(10)) {
        await later.reconcileClaim(claim);
      }
      const states = await pool.query<{ claim_id: string; status: string }>(
        "select claim_id, status from public.mining_claims order by created_at",
      );
      expect(
        Object.fromEntries(
          states.rows.map((row) => [row.claim_id, row.status]),
        ),
      ).toEqual({
        [first.claim.claimId]: "succeeded",
        [second.claim.claimId]: "expired",
      });
      // Nothing left to claim.
      await expect(
        later.prepareClaim({
          principal: principal(),
          body: { walletId },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(V2ApiError);
      // A claimed event can never exceed the settled total (check constraint).
      await expect(
        pool.query(
          "update public.mining_reward_balances set claimed_total_raw = settled_total_raw + 1 where owner_user_id = $1",
          [users[6]],
        ),
      ).rejects.toThrow(/mining_reward_balances_claimed_check/u);
    });
  });
});
