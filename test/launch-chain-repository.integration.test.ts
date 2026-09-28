import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computeAllowlistRoot } from "../scripts/launch-allowlist.js";
import { createPostgresLaunchChainRepository } from "../src/database/launch-chain-repository.js";
import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import {
  LaunchIntentIdempotencyConflictError,
  LaunchIntentReportConflictError,
  LaunchSaleRegistrationError,
  type CreateLaunchIntentInput,
  type LaunchChainRepository,
  type LaunchIndexedEventInput,
} from "../src/features/launch/launch-chain-repository.js";
import {
  buildLaunchMerkleTree,
  verifyLaunchMerkleProof,
} from "../src/features/launch/launch-merkle.js";
import { createLaunchIntentReconciler } from "../src/features/launch/launch-intent-reconciliation.js";
import type { LaunchRepository } from "../src/features/launch/launch-repository.js";
import {
  createUnavailableBscReadClient,
  type BscChainCallClient,
  type BscTransactionReceiptObservation,
} from "../src/integrations/bsc/rpc-client.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import {
  fixtureBlockHash,
  fixtureEvent,
  fixtureTxHash,
  oneUsd1,
} from "./helpers/launch-lane-fixtures.js";
import { mockLaunchpadAddress } from "./helpers/launchpad-mock-chain.js";

/**
 * Decision 0077 persistence: the `launch_event` lane projections, reorg
 * handling, the allowlist roots with all three evaluators, the sale
 * registry, and the Launch Intent idempotency. Every event is an ABI v1
 * fixture log decoded by the real decoder (test only).
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

const chainId = "eip155:97" as const;
const usd1 = "0x2222222222222222222222222222222222222222";
const projectToken = "0x3333333333333333333333333333333333333333";
const poolAddress = "0x4444444444444444444444444444444444444444";
const outsider = "0x5555555555555555555555555555555555555555";
const configVersion = `0x${"ab".repeat(32)}`;
const digest = `0x${"cd".repeat(32)}`;

describe("PostgreSQL Launch chain repository (Decision 0077)", () => {
  const databaseName = `loop_s83b_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let chain: LaunchChainRepository;
  let launches: LaunchRepository;
  const users: Record<
    string,
    { userId: string; walletId: string; address: string }
  > = {};

  async function createUser(
    label: string,
    address: string,
    firstSeenDaysAgo = 60,
  ) {
    const user = await pool.query<{ id: string }>({
      text: `insert into public.loop_users (privy_user_id) values ($1) returning id`,
      values: [`did:privy:${randomUUID()}`],
    });
    const userId = user.rows[0]!.id;
    const wallet = await pool.query<{ wallet_id: string }>({
      text: `
        insert into public.account_wallets (
          owner_user_id, address, kind, is_active, provider_wallet_id,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        values ($1, $2, 'embedded', true, $3,
          now() - make_interval(days => $4), now(), now() - make_interval(days => $4), now())
        returning wallet_id
      `,
      values: [userId, address, `privy-${randomUUID()}`, firstSeenDaysAgo],
    });
    users[label] = { userId, walletId: wallet.rows[0]!.wallet_id, address };
    return users[label];
  }

  async function createLaunch(parameters: Record<string, string>): Promise<{
    launchId: string;
    projectId: string;
    roundIds: string[];
  }> {
    const owner = users["a"]!.userId;
    const projectId = randomUUID();
    const launchId = randomUUID();
    await pool.query({
      text: `
        insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at)
        values ($1, $2, 'MoonCat', 'MCAT', 'approved', now(), now())
      `,
      values: [projectId, owner],
    });
    await pool.query({
      text: `insert into public.launches (launch_id, project_id, chain_id) values ($1, $2, $3)`,
      values: [launchId, projectId, chainId],
    });
    await pool.query({
      text: `
        insert into public.launch_configs (launch_id, config_version, parameters, status, effective_at)
        values ($1, 'launchTestV1', $2::jsonb, 'confirmed', now())
      `,
      values: [launchId, JSON.stringify(parameters)],
    });
    const roundIds: string[] = [];
    for (const index of [1, 2]) {
      const round = await pool.query<{ round_id: string }>({
        text: `
          insert into public.launch_rounds (launch_id, round_index, config_version, status)
          values ($1, $2, 'launchTestV1', 'confirmed') returning round_id
        `,
        values: [launchId, index],
      });
      roundIds.push(round.rows[0]!.round_id);
    }
    return { launchId, projectId, roundIds };
  }

  beforeAll(async () => {
    const admin = new Client({
      connectionString: connectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    const url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    chain = createPostgresLaunchChainRepository(pool);
    launches = createPostgresLaunchRepository(pool, { launchChainId: chainId });
    for (const [asset, symbol] of [
      [usd1, "USD1"],
      [projectToken, "MCAT"],
    ] as const) {
      await pool.query({
        text: `
          insert into public.assets (asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at)
          values ($1, $2, $3, $4, $4, 18, 'pending', 'chain_call', 1, now())
        `,
        values: [`${chainId}:${asset}`, chainId, asset, symbol],
      });
    }
    await createUser("a", "0x000000000000000000000000000000000000000a");
    await createUser("b", "0x000000000000000000000000000000000000000b");
    await createUser("c", "0x000000000000000000000000000000000000000c", 1);
  });

  afterAll(async () => {
    await pool.end();
    const admin = new Client({
      connectionString: connectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
  });

  async function register(launchId: string, saleId: string): Promise<void> {
    await chain.registerSale({
      launchId,
      saleId,
      contractAddress: mockLaunchpadAddress,
      contractVersion: "1.0.0",
      configVersionOnchain: configVersion,
      quoteTokenAddress: usd1,
      projectTokenAddress: projectToken,
      requestId: randomUUID(),
    });
  }

  function commit(
    events: readonly LaunchIndexedEventInput[],
    lastBlock: bigint,
    extra: {
      readonly rewindFromBlockNumber?: string;
      readonly projections?: Parameters<
        LaunchChainRepository["commitSegment"]
      >[0]["projections"];
    } = {},
  ) {
    return chain.commitSegment({
      chainId,
      events,
      projections: extra.projections ?? [],
      checkpoint: {
        lastBlockNumber: lastBlock.toString(),
        lastBlockHash: fixtureBlockHash(lastBlock),
        startedFromBlockNumber: "100",
      },
      ...(extra.rewindFromBlockNumber === undefined
        ? {}
        : { rewindFromBlockNumber: extra.rewindFromBlockNumber }),
      confirmedThroughBlockNumber: "105",
    });
  }

  it("registers a sale once, audits it, and refuses a taken or repeated saleId", async () => {
    const { launchId, projectId } = await createLaunch({
      projectTokenAddress: projectToken,
    });
    await register(launchId, "90");
    const audit = await pool.query({
      text: `select event_type, actor_type from public.launch_review_events where project_id = $1 and event_type = 'sale_registered'`,
      values: [projectId],
    });
    expect(audit.rows).toEqual([
      { event_type: "sale_registered", actor_type: "operator" },
    ]);
    const detail = await launches.getLaunch(launchId);
    expect(detail?.launch).toMatchObject({
      saleId: "90",
      contractAddress: mockLaunchpadAddress,
      contractVersion: "1.0.0",
      configVersionOnchain: configVersion,
      quoteAssetId: `${chainId}:${usd1}`,
      projectAssetId: `${chainId}:${projectToken}`,
    });
    await expect(register(launchId, "90")).rejects.toMatchObject({
      reasonCode: "LAUNCH_SALE_ALREADY_REGISTERED",
    });
    const other = await createLaunch({ projectTokenAddress: projectToken });
    await expect(register(other.launchId, "90")).rejects.toBeInstanceOf(
      LaunchSaleRegistrationError,
    );
    await expect(register(other.launchId, "90")).rejects.toMatchObject({
      reasonCode: "LAUNCH_SALE_ID_TAKEN",
    });
  });

  it("projects the 14 events into purchases, entitlements, refunds, pool facts, and getState axes; a reorg rewinds them", async () => {
    const success = await createLaunch({ projectTokenAddress: projectToken });
    const failed = await createLaunch({ projectTokenAddress: projectToken });
    await register(success.launchId, "7");
    await register(failed.launchId, "8");
    const a = users["a"]!;
    const b = users["b"]!;
    const s = success.launchId;
    const f = failed.launchId;
    const events = [
      fixtureEvent(
        s,
        "SaleStateChanged",
        { saleId: 7n, fromState: 0, toState: 1, at: 1_790_000_000n },
        { block: 101n, logIndex: 0 },
      ),
      fixtureEvent(
        s,
        "Purchased",
        {
          saleId: 7n,
          buyer: a.address,
          roundId: 1,
          usd1Amount: 100n * oneUsd1,
          tokenAmount: 10_000n * oneUsd1,
          walletCumulativeUsd1: 100n * oneUsd1,
          purchaseIndex: 1n,
        },
        { block: 102n, logIndex: 0 },
      ),
      fixtureEvent(
        s,
        "Purchased",
        {
          saleId: 7n,
          buyer: outsider,
          roundId: 1,
          usd1Amount: 50n * oneUsd1,
          tokenAmount: 5_000n * oneUsd1,
          walletCumulativeUsd1: 50n * oneUsd1,
          purchaseIndex: 2n,
        },
        { block: 102n, logIndex: 1 },
      ),
      fixtureEvent(
        s,
        "Purchased",
        {
          saleId: 7n,
          buyer: b.address,
          roundId: 2,
          usd1Amount: 20n * oneUsd1,
          tokenAmount: 2_000n * oneUsd1,
          walletCumulativeUsd1: 20n * oneUsd1,
          purchaseIndex: 3n,
        },
        { block: 110n, logIndex: 0 },
      ),
      fixtureEvent(
        s,
        "SaleFinalized",
        {
          saleId: 7n,
          outcome: 3,
          totalRaisedUsd1: 170n * oneUsd1,
          totalTokensSold: 17_000n * oneUsd1,
        },
        { block: 111n, logIndex: 0 },
      ),
      fixtureEvent(
        s,
        "BudgetsFrozen",
        {
          saleId: 7n,
          usd1ToLiquidity: 85n * oneUsd1,
          tokenToLiquidity: 8_500n * oneUsd1,
          usd1ToProject: 80n * oneUsd1,
          protocolFeeUsd1: 5n * oneUsd1,
        },
        { block: 111n, logIndex: 1 },
      ),
      fixtureEvent(
        s,
        "VestingScheduleCreated",
        {
          saleId: 7n,
          tgeBps: 2_500,
          cliffSeconds: 0,
          durationSeconds: 7_776_000,
          tgeAt: 1_790_500_000n,
        },
        { block: 111n, logIndex: 2 },
      ),
      fixtureEvent(
        s,
        "PoolPrepared",
        {
          saleId: 7n,
          pool: poolAddress,
          feeTier: 2_500,
          initialSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n,
          tickLower: -887_250,
          tickUpper: 887_250,
        },
        { block: 112n, logIndex: 0 },
      ),
      fixtureEvent(
        s,
        "LiquidityAdded",
        {
          saleId: 7n,
          pool: poolAddress,
          lpTokenId: 42n,
          usd1Amount: 85n * oneUsd1,
          tokenAmount: 8_500n * oneUsd1,
        },
        { block: 112n, logIndex: 1 },
      ),
      fixtureEvent(
        s,
        "LPNFTLocked",
        {
          saleId: 7n,
          locker: mockLaunchpadAddress,
          lpTokenId: 42n,
          unlockAt: 1_822_000_000n,
        },
        { block: 112n, logIndex: 2 },
      ),
      fixtureEvent(
        s,
        "LiquidityRetryScheduled",
        {
          saleId: 7n,
          reasonCode: `0x${"0a".repeat(32)}`,
          retryAfter: 1_790_600_000n,
        },
        { block: 112n, logIndex: 3 },
      ),
      fixtureEvent(
        s,
        "Paused",
        { saleId: 7n, by: mockLaunchpadAddress },
        { block: 113n, logIndex: 0 },
      ),
      fixtureEvent(
        s,
        "Unpaused",
        { saleId: 7n, by: mockLaunchpadAddress },
        { block: 113n, logIndex: 1 },
      ),
      fixtureEvent(
        s,
        "Claimed",
        {
          saleId: 7n,
          wallet: a.address,
          tokenAmount: 2_500n * oneUsd1,
          cumulativeClaimed: 2_500n * oneUsd1,
        },
        { block: 120n, logIndex: 0 },
      ),
      fixtureEvent(
        f,
        "Purchased",
        {
          saleId: 8n,
          buyer: a.address,
          roundId: 1,
          usd1Amount: 30n * oneUsd1,
          tokenAmount: 3_000n * oneUsd1,
          walletCumulativeUsd1: 30n * oneUsd1,
          purchaseIndex: 1n,
        },
        { block: 103n, logIndex: 0 },
      ),
      fixtureEvent(
        f,
        "SaleFinalized",
        {
          saleId: 8n,
          outcome: 4,
          totalRaisedUsd1: 30n * oneUsd1,
          totalTokensSold: 3_000n * oneUsd1,
        },
        { block: 114n, logIndex: 0 },
      ),
      fixtureEvent(
        f,
        "RefundLiabilityFrozen",
        { saleId: 8n, wallet: a.address, usd1Amount: 30n * oneUsd1 },
        { block: 114n, logIndex: 1 },
      ),
      fixtureEvent(
        f,
        "Refunded",
        {
          saleId: 8n,
          wallet: a.address,
          usd1Amount: 30n * oneUsd1,
          cumulativeRefunded: 30n * oneUsd1,
        },
        { block: 121n, logIndex: 0 },
      ),
    ];
    expect(new Set(events.map((event) => event.eventName)).size).toBe(14);
    await commit(events, 125n, {
      projections: [
        {
          launchId: s,
          saleState: "SUCCEEDED",
          entitlementState: "VESTING",
          liquidityState: "LP_LOCKED",
          operationalState: "ACTIVE",
          configVersion,
          stateTupleDigest: digest,
          snapshotBlockNumber: "125",
          snapshotBlockHash: fixtureBlockHash(125n),
        },
      ],
    });

    // getState axes and digest: stored without 0x, published with it.
    const stored = await pool.query({
      text: `select sale_state, state_tuple_digest, state_config_version, snapshot_block_number::text as block,
               pool_address, lp_token_id::text as lp_token_id, lp_unlock_at
             from public.launches where launch_id = $1`,
      values: [s],
    });
    expect(stored.rows[0]).toMatchObject({
      sale_state: "SUCCEEDED",
      state_tuple_digest: "cd".repeat(32),
      state_config_version: "ab".repeat(32),
      block: "125",
      pool_address: poolAddress,
      lp_token_id: "42",
    });
    expect(
      (stored.rows[0] as { lp_unlock_at: Date }).lp_unlock_at.toISOString(),
    ).toBe(new Date(1_822_000_000_000).toISOString());
    const projections = await chain.listStateProjections([s, f]);
    expect(projections.get(s)).toMatchObject({
      stateTupleDigest: digest,
      configVersion,
      liquidityState: "LP_LOCKED",
      // S83b7b: the graduation block is the surviving LPNFTLocked log's.
      lpLockedBlockNumber: "112",
    });
    expect(projections.has(f)).toBe(false);

    // Purchases: only LOOP wallets become records; holders count every buyer.
    expect(await chain.countHolders(s)).toBe(3);
    const history = await chain.listHistory({
      launchId: s,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(history.purchaseRecords).toEqual([
      expect.objectContaining({
        walletId: a.walletId,
        roundId: success.roundIds[0],
        roundIndex: 1,
        usd1Amount: (100n * oneUsd1).toString(),
        tokenAmount: (10_000n * oneUsd1).toString(),
        confirmationState: "confirmed",
      }),
    ]);
    expect(history.entitlements).toEqual([
      expect.objectContaining({
        walletId: a.walletId,
        entitledTokens: (10_000n * oneUsd1).toString(),
        claimedTokens: (2_500n * oneUsd1).toString(),
        state: "partially_claimed",
        frozenAtBlock: "111",
      }),
    ]);
    const bHistory = await chain.listHistory({
      launchId: s,
      ownerUserId: b.userId,
      limit: 500,
    });
    expect(bHistory.purchaseRecords[0]).toMatchObject({
      roundIndex: 2,
      confirmationState: "pending",
    });
    expect(bHistory.entitlements[0]).toMatchObject({ state: "frozen" });

    // The failed sale: one wallet-level liability, one refund claim, no entitlement.
    const refunds = await chain.listHistory({
      launchId: f,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(refunds.entitlements).toEqual([]);
    expect(refunds.refunds).toEqual([
      expect.objectContaining({
        refundableUsd1: (30n * oneUsd1).toString(),
        refundedUsd1: (30n * oneUsd1).toString(),
        state: "refunded",
        frozenAtBlock: "114",
      }),
    ]);
    const claims = await pool.query({
      text: `select state, removed from public.refund_claims`,
    });
    expect(claims.rows).toEqual([{ state: "confirmed", removed: false }]);

    const economy = await chain.getEconomyChain({
      chainId,
      contractAddress: mockLaunchpadAddress,
      contractVersion: "1.0.0",
    });
    expect(economy.totalRaisedUsd1).toBe((170n * oneUsd1).toString());
    expect(economy.lockedLpCount).toBe(1);
    expect(economy.registeredSaleCount).toBeGreaterThanOrEqual(2);

    // Replaying the same segment converges to the same rows and IDs.
    const before = await chain.listHistory({
      launchId: s,
      ownerUserId: a.userId,
      limit: 500,
    });
    await commit(events, 125n);
    const after = await chain.listHistory({
      launchId: s,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(after.entitlements[0]?.entitlementId).toBe(
      before.entitlements[0]?.entitlementId,
    );
    expect(after.purchaseRecords[0]?.purchaseRecordId).toBe(
      before.purchaseRecords[0]?.purchaseRecordId,
    );

    // Reorg from block 110: the Claimed, b's purchase, and everything after
    // it are removed; replay brings back only the finalization block.
    await commit(
      events.filter((event) => ["111", "114"].includes(event.blockNumber)),
      125n,
      {
        rewindFromBlockNumber: "110",
      },
    );
    const reorged = await chain.listHistory({
      launchId: s,
      ownerUserId: b.userId,
      limit: 500,
    });
    expect(reorged.purchaseRecords[0]).toMatchObject({
      confirmationState: "reorged",
    });
    expect(reorged.entitlements).toEqual([]);
    const aAfter = await chain.listHistory({
      launchId: s,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(aAfter.entitlements[0]).toMatchObject({
      claimedTokens: "0",
      state: "frozen",
    });
    expect(await chain.countHolders(s)).toBe(2);
    const claimsAfter = await pool.query({
      text: `select removed from public.refund_claims`,
    });
    expect(claimsAfter.rows).toEqual([{ removed: true }]);
    const refundAfter = await chain.listHistory({
      launchId: f,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(refundAfter.refunds[0]).toMatchObject({
      refundedUsd1: "0",
      state: "frozen",
    });
    const pool2 = await pool.query({
      text: `select pool_address, lp_token_id from public.launches where launch_id = $1`,
      values: [s],
    });
    expect(pool2.rows[0]).toEqual({ pool_address: null, lp_token_id: null });
    // The reorged-out LPNFTLocked log no longer dates the graduation.
    expect(
      (await chain.listStateProjections([s])).get(s)?.lpLockedBlockNumber,
    ).toBeNull();
    const checkpoint = await chain.getCheckpoint(chainId);
    expect(checkpoint).toMatchObject({
      lastBlockNumber: "125",
      startedFromBlockNumber: "100",
    });
    const reorgCount = await pool.query({
      text: `select reorg_count from public.indexer_checkpoints where lane = 'launch_event'`,
    });
    expect(reorgCount.rows[0]).toEqual({ reorg_count: 1 });
  });

  it("computes, stores, and proves allowlist roots for whitelist, community, and activity", async () => {
    const a = users["a"]!;
    const b = users["b"]!;
    const c = users["c"]!;
    const snapshotSeconds = BigInt(Math.floor(Date.now() / 1000));
    const readBlock = () =>
      Promise.resolve({
        blockHash: fixtureBlockHash(500n),
        timestamp: snapshotSeconds,
      });

    // whitelist: the operator list, de-duplicated.
    const whitelist = await createLaunch({
      projectTokenAddress: projectToken,
      tierModeV1: "whitelist",
    });
    expect(
      await chain.importAllowlist({
        launchId: whitelist.launchId,
        roundIndex: 1,
        addresses: [a.address, b.address, a.address],
        source: "operator_csv",
      }),
    ).toEqual({ inserted: 2, existing: 0 });
    const computed = await computeAllowlistRoot(
      {
        kind: "compute",
        launchId: whitelist.launchId,
        roundIndex: 1,
        snapshotBlock: 500n,
        confirm: true,
      },
      { launches, chain, readBlock },
    );
    expect(computed).toMatchObject({
      leafCount: 2,
      mode: "whitelist",
      written: true,
    });
    const roots = await chain.listAllowlistRoots(whitelist.launchId, 1);
    expect(roots[0]).toMatchObject({
      root: computed.root,
      members: [a.address, b.address],
      snapshotBlock: "500",
    });
    const stored = await pool.query({
      text: `select root from public.launch_round_allowlist_roots where launch_id = $1`,
      values: [whitelist.launchId],
    });
    expect(stored.rows[0]).toEqual({ root: computed.root.slice(2) });
    const proof = buildLaunchMerkleTree(roots[0]!.members).proofFor(a.address);
    expect(verifyLaunchMerkleProof(computed.root, a.address, proof ?? [])).toBe(
      true,
    );
    await expect(
      pool.query({
        text: `delete from public.launch_round_allowlist_roots where launch_id = $1`,
        values: [whitelist.launchId],
      }),
    ).rejects.toMatchObject({ code: "55000" });

    // community: active members joined at the snapshot time.
    const community = await pool.query<{ community_id: string }>({
      text: `insert into public.communities (name, slug, created_by_user_id) values ('Eligible', $1, $2) returning community_id`,
      values: [`eligible-${randomUUID().slice(0, 8)}`, a.userId],
    });
    const communityId = community.rows[0]!.community_id;
    await pool.query({
      text: `
        insert into public.community_memberships (community_id, owner_user_id, role, status, joined_at, updated_at)
        values ($1, $2, 'owner', 'active', now() - interval '10 days', now()),
               ($1, $3, 'member', 'banned', now() - interval '10 days', now()),
               ($1, $4, 'member', 'active', now() + interval '1 day', now() + interval '1 day')
      `,
      values: [communityId, a.userId, b.userId, c.userId],
    });
    const communityLaunch = await createLaunch({
      tierModeV1: "community",
      eligibilityCommunityId: communityId,
    });
    const communityRoot = await computeAllowlistRoot(
      {
        kind: "compute",
        launchId: communityLaunch.launchId,
        roundIndex: 1,
        snapshotBlock: 500n,
        confirm: false,
      },
      { launches, chain, readBlock },
    );
    expect(communityRoot).toMatchObject({
      leafCount: 1,
      mode: "community",
      written: false,
    });
    expect(communityRoot.root).toBe(buildLaunchMerkleTree([a.address]).root);
    expect(await chain.listAllowlistRoots(communityLaunch.launchId, 1)).toEqual(
      [],
    );

    // activity: a positive power in a complete snapshot of the last 30 days.
    const snapshot = async (power: string, daysAgo: number, owner: string) => {
      const id = randomUUID();
      await pool.query({
        text: `
          insert into public.mining_snapshots (snapshot_id, block_number, block_hash, formula_version,
            price_version, total_power, account_count, computed_at)
          values ($1, 1, $2, 'miningFormulaV1-draft', 'test:price', $3, 1, now() - make_interval(days => $4))
        `,
        values: [id, fixtureBlockHash(1n), power, daysAgo],
      });
      await pool.query({
        text: `
          insert into public.mining_snapshot_powers (snapshot_id, owner_user_id, asset_id, holding,
            reference_price_usd, weight, power, block_number)
          values ($1, $2, $3, '1', '1', '1', $4, 1)
        `,
        values: [id, owner, `${chainId}:${usd1}`, power],
      });
    };
    await snapshot("5", 3, b.userId);
    await snapshot("0", 3, a.userId);
    await snapshot("7", 45, c.userId);
    const activityLaunch = await createLaunch({ tierModeV1: "activity" });
    const activityRoot = await computeAllowlistRoot(
      {
        kind: "compute",
        launchId: activityLaunch.launchId,
        roundIndex: 2,
        snapshotBlock: 500n,
        confirm: true,
      },
      { launches, chain, readBlock },
    );
    expect(activityRoot).toMatchObject({ leafCount: 1, mode: "activity" });
    expect(
      (await chain.listAllowlistRoots(activityLaunch.launchId, 2))[0]?.members,
    ).toEqual([b.address]);
  });

  it("claims the Idempotency-Key once per Launch Intent and refuses another digest", async () => {
    const { launchId, projectId, roundIds } = await createLaunch({
      projectTokenAddress: projectToken,
    });
    await register(launchId, "11");
    const a = users["a"]!;
    let builds = 0;
    const build = (): Promise<CreateLaunchIntentInput> => {
      builds += 1;
      return Promise.resolve({
        intentId: randomUUID(),
        kind: "buy",
        ownerUserId: a.userId,
        walletId: a.walletId,
        launchId,
        projectId,
        roundId: roundIds[0]!,
        roundIndex: 1,
        saleId: "11",
        chainId,
        quoteAssetId: `${chainId}:${usd1}`,
        projectAssetId: `${chainId}:${projectToken}`,
        payAmountRaw: (10n * oneUsd1).toString(),
        expectedReceiveRaw: (1_000n * oneUsd1).toString(),
        minTokenAmountRaw: (1_000n * oneUsd1).toString(),
        configVersion,
        walletCumulativeRaw: "0",
        contractAddress: mockLaunchpadAddress,
        stateTupleDigest: digest,
        snapshotBlockNumber: "900",
        snapshotBlockHash: fixtureBlockHash(900n),
        payloadDigest: "e".repeat(64),
        state: "awaiting_signature",
        deadline: new Date(Date.now() + 120_000).toISOString(),
        eligibilityProof: [],
        unsignedTransaction: {
          chainId: 97,
          to: mockLaunchpadAddress,
          data: "0x",
          value: "0x0",
        },
        policy: {
          configVersion: "bscWriteCanaryV1",
          valueUsd: "10",
          canaryMaxUsd: "25",
          priceSource: "usd1_par",
        },
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    };
    const key = randomUUID();
    const first = await chain.createIntent({
      ownerUserId: a.userId,
      idempotencyKey: key,
      requestSha256: "1".repeat(64),
      build,
    });
    const replay = await chain.createIntent({
      ownerUserId: a.userId,
      idempotencyKey: key,
      requestSha256: "1".repeat(64),
      build,
    });
    expect(first.created).toBe(true);
    expect(replay).toMatchObject({
      created: false,
      intent: { intentId: first.intent.intentId },
    });
    expect(builds).toBe(1);
    expect(first.intent.stateTupleDigest).toBe(digest);
    await expect(
      chain.createIntent({
        ownerUserId: a.userId,
        idempotencyKey: key,
        requestSha256: "2".repeat(64),
        build,
      }),
    ).rejects.toBeInstanceOf(LaunchIntentIdempotencyConflictError);
    const record = await pool.query({
      text: `select digest_version from public.idempotency_records where idempotency_key = $1`,
      values: [key],
    });
    expect(record.rows[0]).toEqual({ digest_version: "launch_intent_v1" });
    // Broadcast report: pending evidence until the lane indexes the purchase.
    const tx = fixtureTxHash(700n, 0);
    const reported = await chain.reportIntentBroadcast({
      ownerUserId: a.userId,
      intentId: first.intent.intentId,
      transactionHash: tx,
      payloadVerified: false,
    });
    expect(reported).toMatchObject({ state: "submitted", transactionHash: tx });
    expect(
      await chain.reportIntentBroadcast({
        ownerUserId: a.userId,
        intentId: first.intent.intentId,
        transactionHash: tx,
        payloadVerified: true,
      }),
    ).toMatchObject({ transactionHash: tx, payloadVerified: false });
    await expect(
      chain.reportIntentBroadcast({
        ownerUserId: a.userId,
        intentId: first.intent.intentId,
        transactionHash: fixtureTxHash(701n, 0),
        payloadVerified: false,
      }),
    ).rejects.toBeInstanceOf(LaunchIntentReportConflictError);
    await commit(
      [
        fixtureEvent(
          launchId,
          "Purchased",
          {
            saleId: 11n,
            buyer: a.address,
            roundId: 1,
            usd1Amount: 10n * oneUsd1,
            tokenAmount: 1_000n * oneUsd1,
            walletCumulativeUsd1: 10n * oneUsd1,
            purchaseIndex: 1n,
          },
          { block: 700n, logIndex: 0 },
        ),
      ],
      800n,
    );
    expect(
      await chain.getIntent({
        ownerUserId: a.userId,
        launchId,
        intentId: first.intent.intentId,
      }),
    ).toMatchObject({ state: "confirmed" });
    const linked = await pool.query({
      text: `select intent_id from public.purchase_records where transaction_hash = $1`,
      values: [tx],
    });
    expect(linked.rows).toEqual([{ intent_id: first.intent.intentId }]);
    // A reorg of that block sends the Intent back to submitted.
    await commit([], 800n, { rewindFromBlockNumber: "700" });
    expect(
      await chain.getIntent({
        ownerUserId: a.userId,
        launchId,
        intentId: first.intent.intentId,
      }),
    ).toMatchObject({ state: "submitted" });
  });

  it("reconciles reported Intents from receipts: reverted, receipt-confirmed kept by the lane, lane-first no-op, expired then confirmed by a log (Decision 0080)", async () => {
    const { launchId, projectId, roundIds } = await createLaunch({
      projectTokenAddress: projectToken,
    });
    await register(launchId, "12");
    const b = users["b"]!;
    // expires_at must follow created_at; the reconciler runs two hours
    // later instead, past the deadline and both graces.
    const deadline = new Date(Date.now() + 120_000).toISOString();
    const later = (): Date => new Date(Date.now() + 2 * 3_600_000);
    async function reported(block: bigint): Promise<{
      readonly intentId: string;
      readonly tx: string;
    }> {
      const created = await chain.createIntent({
        ownerUserId: b.userId,
        idempotencyKey: randomUUID(),
        requestSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        build: () =>
          Promise.resolve({
            intentId: randomUUID(),
            kind: "buy",
            ownerUserId: b.userId,
            walletId: b.walletId,
            launchId,
            projectId,
            roundId: roundIds[0]!,
            roundIndex: 1,
            saleId: "12",
            chainId,
            quoteAssetId: `${chainId}:${usd1}`,
            projectAssetId: `${chainId}:${projectToken}`,
            payAmountRaw: oneUsd1.toString(),
            expectedReceiveRaw: (100n * oneUsd1).toString(),
            minTokenAmountRaw: (100n * oneUsd1).toString(),
            configVersion,
            walletCumulativeRaw: "0",
            contractAddress: mockLaunchpadAddress,
            stateTupleDigest: digest,
            snapshotBlockNumber: "900",
            snapshotBlockHash: fixtureBlockHash(900n),
            payloadDigest: "f".repeat(64),
            state: "awaiting_signature",
            deadline,
            eligibilityProof: [],
            unsignedTransaction: {
              chainId: 97,
              from: b.address,
              to: mockLaunchpadAddress,
              data: "0x",
              value: "0x0",
            },
            policy: { configVersion: "bscWriteCanaryV1", valueUsd: "1" },
            expiresAt: deadline,
          }),
      });
      const tx = fixtureTxHash(block, 0);
      await chain.reportIntentBroadcast({
        ownerUserId: b.userId,
        intentId: created.intent.intentId,
        transactionHash: tx,
        payloadVerified: true,
      });
      return { intentId: created.intent.intentId, tx };
    }
    const revertedIntent = await reported(1_201n);
    const receiptIntent = await reported(1_202n);
    const laneIntent = await reported(1_203n);
    const missingIntent = await reported(1_204n);

    const receipts = new Map<string, Partial<BscTransactionReceiptObservation>>(
      [
        [revertedIntent.tx, { status: "reverted" }],
        [receiptIntent.tx, { status: "success" }],
        [laneIntent.tx, { status: "success" }],
      ],
    );
    const client: BscChainCallClient = {
      ...createUnavailableBscReadClient({
        chainId,
        chainReference: 97,
        confirmations: 5,
        reorgDepthBlocks: 15,
      }),
      getHead: () =>
        Promise.resolve({
          blockNumber: 1_300n,
          blockHash: fixtureBlockHash(1_300n),
          observedAt: new Date().toISOString(),
        }),
      getTransaction: () => Promise.resolve(null),
      getTransactionReceipt: (hash: string) => {
        const receipt = receipts.get(hash);
        return Promise.resolve(
          receipt === undefined
            ? null
            : {
                hash,
                status: "success" as const,
                blockNumber: 1_200n,
                blockHash: fixtureBlockHash(1_200n),
                gasUsed: 100_000n,
                effectiveGasPrice: 1_000_000_000n,
                ...receipt,
              },
        );
      },
    };

    // Lane first for laneIntent: its Purchased log is indexed before any
    // receipt read.
    await commit(
      [
        fixtureEvent(
          launchId,
          "Purchased",
          {
            saleId: 12n,
            buyer: b.address,
            roundId: 1,
            usd1Amount: oneUsd1,
            tokenAmount: 100n * oneUsd1,
            walletCumulativeUsd1: oneUsd1,
            purchaseIndex: 1n,
          },
          { block: 1_203n, logIndex: 0 },
        ),
      ],
      1_210n,
    );
    const intentState = async (intentId: string) =>
      chain.getIntent({ ownerUserId: b.userId, launchId, intentId });
    expect(await intentState(laneIntent.intentId)).toMatchObject({
      state: "confirmed",
      receipt: null,
    });

    const reconciler = createLaunchIntentReconciler({
      repository: chain,
      readClient: client,
      chainId,
      now: later,
    });
    const tick = await reconciler.reconcileOnce();
    expect(tick.status).toBe("available");
    // Only the three still-submitted Intents of this launch are leased.
    const settled = new Map(
      (tick.status === "available" ? tick.transitions : []).map((item) => [
        item.intentId,
        item,
      ]),
    );
    expect(settled.get(revertedIntent.intentId)).toEqual({
      intentId: revertedIntent.intentId,
      toState: "reverted",
      reasonCode: "LAUNCH_TX_REVERTED",
    });
    expect(settled.get(receiptIntent.intentId)?.toState).toBe("confirmed");
    expect(settled.get(missingIntent.intentId)).toEqual({
      intentId: missingIntent.intentId,
      toState: "expired",
      reasonCode: "LAUNCH_TX_NOT_OBSERVED",
    });
    expect(settled.has(laneIntent.intentId)).toBe(false);
    expect(await intentState(revertedIntent.intentId)).toMatchObject({
      state: "reverted",
      reasonCode: "LAUNCH_TX_REVERTED",
      revertReason: null,
      receipt: {
        status: "reverted",
        blockNumber: "1200",
        confirmations: 101,
      },
    });

    // A later lane segment without a Purchased log for the receipt-confirmed
    // Intent keeps it confirmed; the reverted one is untouched; a Purchased
    // log for the expired one confirms it (evidence wins).
    await commit(
      [
        fixtureEvent(
          launchId,
          "Purchased",
          {
            saleId: 12n,
            buyer: b.address,
            roundId: 1,
            usd1Amount: oneUsd1,
            tokenAmount: 100n * oneUsd1,
            walletCumulativeUsd1: 2n * oneUsd1,
            purchaseIndex: 2n,
          },
          { block: 1_204n, logIndex: 0 },
        ),
      ],
      1_220n,
    );
    expect(await intentState(receiptIntent.intentId)).toMatchObject({
      state: "confirmed",
      receipt: { status: "success" },
    });
    expect((await intentState(revertedIntent.intentId))?.state).toBe(
      "reverted",
    );
    expect((await intentState(missingIntent.intentId))?.state).toBe(
      "confirmed",
    );
    // Nothing left to lease; a stale settle is a no-op.
    const second = await reconciler.reconcileOnce();
    expect(second).toMatchObject({ leasedCount: 0, transitions: [] });
    await expect(
      chain.settleIntent({
        intentId: laneIntent.intentId,
        transactionHash: laneIntent.tx,
        toState: "reverted",
        reasonCode: "LAUNCH_TX_REVERTED",
        revertReason: null,
        receipt: null,
      }),
    ).resolves.toBeNull();
    // The schema keeps revert_reason to reverted rows.
    await expect(
      pool.query({
        text: `update public.launch_intents set revert_reason = 'x' where intent_id = $1`,
        values: [receiptIntent.intentId],
      }),
    ).rejects.toThrow(/launch_intents_revert_reason_check/);
  });

  it("claim / claimRefund Intents: kind round-trips, Claimed / Refunded logs of the Intent's wallet confirm them, receipts settle reverted / expired, settlements list both kinds (Decision 0087)", async () => {
    const claimSale = await createLaunch({ projectTokenAddress: projectToken });
    const refundSale = await createLaunch({
      projectTokenAddress: projectToken,
    });
    await register(claimSale.launchId, "21");
    await register(refundSale.launchId, "22");
    const a = users["a"]!;
    const b = users["b"]!;
    const deadline = new Date(Date.now() + 120_000).toISOString();
    const later = (): Date => new Date(Date.now() + 2 * 3_600_000);

    function settlementInput(
      kind: "claim" | "claimRefund",
      launch: { launchId: string; projectId: string },
      saleId: string,
      overrides: Partial<CreateLaunchIntentInput> = {},
    ): CreateLaunchIntentInput {
      return {
        intentId: randomUUID(),
        kind,
        ownerUserId: a.userId,
        walletId: a.walletId,
        launchId: launch.launchId,
        projectId: launch.projectId,
        roundId: null,
        roundIndex: null,
        saleId,
        chainId,
        quoteAssetId: `${chainId}:${usd1}`,
        projectAssetId: `${chainId}:${projectToken}`,
        payAmountRaw: "0",
        expectedReceiveRaw: (2_500n * oneUsd1).toString(),
        minTokenAmountRaw: "0",
        configVersion,
        walletCumulativeRaw: (100n * oneUsd1).toString(),
        contractAddress: mockLaunchpadAddress,
        stateTupleDigest: digest,
        snapshotBlockNumber: "900",
        snapshotBlockHash: fixtureBlockHash(900n),
        payloadDigest: "a".repeat(64),
        state: "awaiting_signature",
        deadline,
        eligibilityProof: [],
        unsignedTransaction: {
          chainId: 97,
          from: a.address,
          to: mockLaunchpadAddress,
          data: "0x",
          value: "0x0",
        },
        policy: { configVersion: "bscWriteCanaryV1", valueUsd: "0" },
        expiresAt: deadline,
        ...overrides,
      };
    }

    async function reported(
      kind: "claim" | "claimRefund",
      launch: { launchId: string; projectId: string },
      saleId: string,
      block: bigint,
    ): Promise<{ readonly intentId: string; readonly tx: string }> {
      const created = await chain.createIntent({
        ownerUserId: a.userId,
        idempotencyKey: randomUUID(),
        requestSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        build: () => Promise.resolve(settlementInput(kind, launch, saleId)),
      });
      expect(created.intent).toMatchObject({
        kind,
        roundId: null,
        roundIndex: null,
        payAmountRaw: "0",
      });
      const tx = fixtureTxHash(block, 0);
      await chain.reportIntentBroadcast({
        ownerUserId: a.userId,
        intentId: created.intent.intentId,
        transactionHash: tx,
        payloadVerified: true,
      });
      return { intentId: created.intent.intentId, tx };
    }

    // The schema keeps a claim round-less and unpaid, and a buy with a round.
    for (const overrides of [
      { roundId: claimSale.roundIds[0]! },
      { payAmountRaw: "1" },
    ]) {
      await expect(
        chain.createIntent({
          ownerUserId: a.userId,
          idempotencyKey: randomUUID(),
          requestSha256: "3".repeat(64),
          build: () =>
            Promise.resolve(
              settlementInput("claim", claimSale, "21", overrides),
            ),
        }),
      ).rejects.toThrow();
    }
    await expect(
      pool.query({
        text: `update public.launch_intents set round_id = null where direction = 'buy'`,
      }),
    ).rejects.toThrow(/launch_intents_kind_round_check/);

    const claimed = await reported("claim", claimSale, "21", 1_401n);
    const wrongWallet = await reported("claim", claimSale, "21", 1_402n);
    const claimReverted = await reported("claim", claimSale, "21", 1_403n);
    const claimMissing = await reported("claim", claimSale, "21", 1_404n);
    const refunded = await reported("claimRefund", refundSale, "22", 1_405n);
    const refundReverted = await reported(
      "claimRefund",
      refundSale,
      "22",
      1_406n,
    );

    const intentState = async (launchId: string, intentId: string) =>
      chain.getIntent({ ownerUserId: a.userId, launchId, intentId });

    // Lane: a Claimed log of a's claim tx confirms it; a Claimed log in the
    // other tx names wallet b, so a's Intent stays submitted; a Refunded
    // log of a's refund tx confirms the refund.
    await commit(
      [
        fixtureEvent(
          claimSale.launchId,
          "Claimed",
          {
            saleId: 21n,
            wallet: a.address,
            tokenAmount: 2_500n * oneUsd1,
            cumulativeClaimed: 2_500n * oneUsd1,
          },
          { block: 1_401n, logIndex: 0 },
        ),
        fixtureEvent(
          claimSale.launchId,
          "Claimed",
          {
            saleId: 21n,
            wallet: b.address,
            tokenAmount: 500n * oneUsd1,
            cumulativeClaimed: 500n * oneUsd1,
          },
          { block: 1_402n, logIndex: 0 },
        ),
        fixtureEvent(
          refundSale.launchId,
          "Refunded",
          {
            saleId: 22n,
            wallet: a.address,
            usd1Amount: 30n * oneUsd1,
            cumulativeRefunded: 30n * oneUsd1,
          },
          { block: 1_405n, logIndex: 0 },
        ),
      ],
      1_410n,
    );
    expect(
      await intentState(claimSale.launchId, claimed.intentId),
    ).toMatchObject({ kind: "claim", state: "confirmed" });
    expect(
      (await intentState(claimSale.launchId, wrongWallet.intentId))?.state,
    ).toBe("submitted");
    expect(
      await intentState(refundSale.launchId, refunded.intentId),
    ).toMatchObject({ kind: "claimRefund", state: "confirmed" });

    // History: each log is a settlement with its own kind and asset.
    const claimHistory = await chain.listHistory({
      launchId: claimSale.launchId,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(claimHistory.settlements).toEqual([
      expect.objectContaining({
        kind: "claimed",
        walletId: a.walletId,
        assetId: `${chainId}:${projectToken}`,
        amount: (2_500n * oneUsd1).toString(),
        cumulativeAmount: (2_500n * oneUsd1).toString(),
        transactionHash: claimed.tx,
        logIndex: 0,
        blockNumber: "1401",
        // The helper confirms through block 105 only: still pending.
        confirmationState: "pending",
      }),
    ]);
    const bClaims = await chain.listHistory({
      launchId: claimSale.launchId,
      ownerUserId: b.userId,
      limit: 500,
    });
    expect(bClaims.settlements).toEqual([
      expect.objectContaining({ kind: "claimed", walletId: b.walletId }),
    ]);
    const refundHistory = await chain.listHistory({
      launchId: refundSale.launchId,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(refundHistory.settlements).toEqual([
      expect.objectContaining({
        kind: "refunded",
        assetId: `${chainId}:${usd1}`,
        amount: (30n * oneUsd1).toString(),
        transactionHash: refunded.tx,
      }),
    ]);
    // Replaying the segment keeps the same opaque settlement ID.
    const settlementId = claimHistory.settlements[0]?.settlementRecordId;
    await commit(
      [
        fixtureEvent(
          claimSale.launchId,
          "Claimed",
          {
            saleId: 21n,
            wallet: a.address,
            tokenAmount: 2_500n * oneUsd1,
            cumulativeClaimed: 2_500n * oneUsd1,
          },
          { block: 1_401n, logIndex: 0 },
        ),
      ],
      1_410n,
    );
    expect(
      (
        await chain.listHistory({
          launchId: claimSale.launchId,
          ownerUserId: a.userId,
          limit: 500,
        })
      ).settlements[0]?.settlementRecordId,
    ).toBe(settlementId);

    // Receipts: reverted claim / refund, a claim with no trace expires.
    const receipts = new Map<string, Partial<BscTransactionReceiptObservation>>(
      [
        [claimReverted.tx, { status: "reverted" }],
        [refundReverted.tx, { status: "reverted" }],
      ],
    );
    const client: BscChainCallClient = {
      ...createUnavailableBscReadClient({
        chainId,
        chainReference: 97,
        confirmations: 5,
        reorgDepthBlocks: 15,
      }),
      getHead: () =>
        Promise.resolve({
          blockNumber: 1_500n,
          blockHash: fixtureBlockHash(1_500n),
          observedAt: new Date().toISOString(),
        }),
      getTransaction: () => Promise.resolve(null),
      getTransactionReceipt: (hash: string) => {
        const receipt = receipts.get(hash);
        return Promise.resolve(
          receipt === undefined
            ? null
            : {
                hash,
                status: "success" as const,
                blockNumber: 1_450n,
                blockHash: fixtureBlockHash(1_450n),
                gasUsed: 60_000n,
                effectiveGasPrice: 1_000_000_000n,
                ...receipt,
              },
        );
      },
    };
    const reconciler = createLaunchIntentReconciler({
      repository: chain,
      readClient: client,
      chainId,
      now: later,
    });
    const tick = await reconciler.reconcileOnce();
    const settled = new Map(
      (tick.status === "available" ? tick.transitions : []).map((item) => [
        item.intentId,
        item,
      ]),
    );
    expect(settled.get(claimReverted.intentId)).toEqual({
      intentId: claimReverted.intentId,
      toState: "reverted",
      reasonCode: "LAUNCH_TX_REVERTED",
    });
    expect(settled.get(refundReverted.intentId)?.toState).toBe("reverted");
    expect(settled.get(claimMissing.intentId)).toEqual({
      intentId: claimMissing.intentId,
      toState: "expired",
      reasonCode: "LAUNCH_TX_NOT_OBSERVED",
    });
    expect(
      await intentState(claimSale.launchId, claimReverted.intentId),
    ).toMatchObject({
      kind: "claim",
      state: "reverted",
      reasonCode: "LAUNCH_TX_REVERTED",
      revertReason: null,
    });

    // claim() has no on-chain deadline: a late Claimed log of the expired
    // Intent's transaction confirms it (evidence wins, as for 0080 buys).
    await commit(
      [
        fixtureEvent(
          claimSale.launchId,
          "Claimed",
          {
            saleId: 21n,
            wallet: a.address,
            tokenAmount: 100n * oneUsd1,
            cumulativeClaimed: 2_600n * oneUsd1,
          },
          { block: 1_404n, logIndex: 0 },
        ),
      ],
      1_420n,
    );
    expect(
      (await intentState(claimSale.launchId, claimMissing.intentId))?.state,
    ).toBe("confirmed");
    expect(
      (await intentState(claimSale.launchId, claimReverted.intentId))?.state,
    ).toBe("reverted");

    // Once the confirmation depth passes, pending settlements confirm.
    await chain.commitSegment({
      chainId,
      events: [],
      projections: [],
      checkpoint: {
        lastBlockNumber: "1430",
        lastBlockHash: fixtureBlockHash(1_430n),
        startedFromBlockNumber: "100",
      },
      confirmedThroughBlockNumber: "1425",
    });
    expect(
      (
        await chain.listHistory({
          launchId: refundSale.launchId,
          ownerUserId: a.userId,
          limit: 500,
        })
      ).settlements[0]?.confirmationState,
    ).toBe("confirmed");

    // A reorg removes the first Claimed: its settlement is kept as reorged
    // and its Intent returns to submitted.
    await commit([], 1_430n, { rewindFromBlockNumber: "1401" });
    expect(
      (await intentState(claimSale.launchId, claimed.intentId))?.state,
    ).toBe("submitted");
    const afterReorg = await chain.listHistory({
      launchId: claimSale.launchId,
      ownerUserId: a.userId,
      limit: 500,
    });
    expect(
      afterReorg.settlements.map((item) => [
        item.transactionHash,
        item.confirmationState,
      ]),
    ).toEqual([
      [claimMissing.tx, "reorged"],
      [claimed.tx, "reorged"],
    ]);
  });
});
