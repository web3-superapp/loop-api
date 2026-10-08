import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMemeSaltPoolWorker,
  toMemeLaneEvent,
} from "../src/bsc-meme-indexer-worker.js";
import { loadConfig } from "../src/config.js";
import {
  createPostgresDatabase,
  type PostgresDatabase,
} from "../src/database/database.js";
import { createPostgresMemeRepository } from "../src/database/meme-repository.js";
import { createPostgresProfileV2Repository } from "../src/database/profile-v2-repository.js";
import { profileActivationDigest } from "../src/features/profile/profile-v2-contract.js";
import {
  memeMetadataHash,
  parseMemeTokenMetadata,
} from "../src/features/meme/meme-contract.js";
import {
  predictMemeTokenAddress,
  randomMemeSalt,
} from "../src/features/meme/meme-create2.js";
import {
  freshMemeCurve,
  memeE18,
  memePriceE18,
  memeT0,
  quoteMemeBuy,
  quoteMemeSell,
  type MemeCurveState,
} from "../src/features/meme/meme-curve-math.js";
import {
  MemeCreateRateLimitedError,
  MemeIdempotencyConflictError,
  type MemeLaneEventInput,
  type MemeRepository,
  type MemeSaltScope,
} from "../src/features/meme/meme-repository.js";
import { projectMemeGraduation } from "../src/features/meme/meme-projection.js";
import { decodeMemeCurveLogs } from "../src/integrations/meme/meme-contract-adapter.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import {
  fixtureBlockHash,
  fixtureTxHash,
  memeCurveAddress,
  memeLog,
  memeTokenImplementation,
} from "./helpers/meme-fixtures.js";

/**
 * Decision 0101 against PostgreSQL: migration 000049, draft creation with
 * the salt pool and the daily limit, the `meme_event` lane replaying a
 * TokenCreated + Trade sequence into the snapshot / trades / holders /
 * K-line, a reorg rewind, graduation with residual, Intent confirmation,
 * and the `category=meme` candidates.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const chainId = "eip155:97" as const;
const scope: MemeSaltScope = {
  chainId,
  contractAddress: memeCurveAddress,
  tokenImplementation: memeTokenImplementation,
  suffix: "6",
};
const buyerA = "0x4444444444444444444444444444444444444444";
const buyerB = "0x5555555555555555555555555555555555555555";
const t0 = 1_791_590_400n; // 2026-10-08T00:00:00Z

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

function fallbackSalt() {
  return randomMemeSalt({
    deployer: memeCurveAddress,
    implementation: memeTokenImplementation,
  });
}

describe("Decision 0101 MEME launchpad on PostgreSQL", () => {
  const databaseName = `loop_s116_${randomUUID().replaceAll("-", "")}`;
  let url: string;
  let pool: InstanceType<typeof Pool>;
  let database: PostgresDatabase;
  let repository: MemeRepository;
  let creatorId: string;
  let creatorProfileId: string;

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    database = createPostgresDatabase(
      loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        DATABASE_URL: url,
      }),
      { error: () => undefined },
    );
    repository = createPostgresMemeRepository(pool);
    const user = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s116:${randomUUID()}`,
    );
    creatorId = user.id;
    await createPostgresProfileV2Repository(pool).activateProfile({
      ownerUserId: user.id,
      idempotencyKey: randomUUID(),
      requestSha256: profileActivationDigest(
        { alias: "frogmaker", avatarRef: null, interests: [] },
        "2.0",
      ),
      requestId: randomUUID(),
      profile: { alias: "frogmaker", avatarRef: null, interests: [] },
    });
    const profile = await pool.query<{ public_profile_id: string }>({
      text: `select public_profile_id from public.user_profiles where owner_user_id = $1`,
      values: [user.id],
    });
    creatorProfileId = profile.rows[0]?.public_profile_id ?? "";
    await pool.query({
      text: `insert into public.account_wallets (owner_user_id, address, kind, is_active) values ($1, $2, 'external', true)`,
      values: [user.id, buyerA],
    });
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  async function draft(
    name: string,
    symbol: string,
    options: {
      readonly idempotencyKey?: string;
      readonly ownerUserId?: string;
    } = {},
  ) {
    const memeTokenId = randomUUID();
    const metadata = parseMemeTokenMetadata({ name, symbol });
    return repository.createDraft({
      ownerUserId: options.ownerUserId ?? creatorId,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      requestSha256: createHash("sha256")
        .update(`${name}\0${symbol}`)
        .digest("hex"),
      dailyLimit: 3,
      limitWindowStart: new Date(Date.now() - 86_400_000).toISOString(),
      draft: {
        memeTokenId,
        chainId,
        contractAddress: memeCurveAddress,
        contractVersion: "1.0.0",
        name: metadata.name,
        symbol: metadata.symbol,
        description: metadata.description,
        imageMediaId: null,
        links: metadata.links,
        metadataHash: memeMetadataHash({ metadata, memeTokenId }),
      },
      saltScope: scope,
      fallbackSalt: fallbackSalt(),
    });
  }

  it("refills the salt pool offline and reserves a vanity salt per draft", async () => {
    const lane = createMemeSaltPoolWorker({
      repository,
      scope,
      target: 3,
      attemptsPerSlice: 500,
    });
    const outcome = await lane.runOnce();
    expect(outcome).toMatchObject({ released: 0, free: 3 });
    expect(await repository.countFreeSalts(scope)).toBe(3);
    // A second tick has nothing to do.
    expect(await lane.runOnce()).toMatchObject({ inserted: 0, free: 3 });

    const created = await draft("Frog", "FROG");
    expect(created.created).toBe(true);
    expect(created.token.status).toBe("draft");
    expect(created.token.vanity).toBe(true);
    expect(created.token.predictedAddress?.endsWith("6")).toBe(true);
    expect(created.token.creator.publicProfileId).toBe(creatorProfileId);
    expect(
      predictMemeTokenAddress({
        deployer: memeCurveAddress,
        implementation: memeTokenImplementation,
        salt: created.token.salt ?? "",
      }),
    ).toBe(created.token.predictedAddress);
    expect(await repository.countFreeSalts(scope)).toBe(2);
  });

  it("replays an Idempotency-Key, refuses a different body, and enforces the daily limit", async () => {
    const key = randomUUID();
    const first = await draft("Toad", "TOAD", { idempotencyKey: key });
    const replay = await draft("Toad", "TOAD", { idempotencyKey: key });
    expect(replay.created).toBe(false);
    expect(replay.token.memeTokenId).toBe(first.token.memeTokenId);
    await expect(
      draft("Newt", "NEWT", { idempotencyKey: key }),
    ).rejects.toBeInstanceOf(MemeIdempotencyConflictError);
    // Frog + Toad exist; the third fits, the fourth is refused.
    await draft("Lizard", "LIZ");
    await expect(draft("Gecko", "GECKO")).rejects.toBeInstanceOf(
      MemeCreateRateLimitedError,
    );
    const other = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s116:${randomUUID()}`,
    );
    const otherDraft = await draft("Gecko", "GECKO", { ownerUserId: other.id });
    // The pool had 2 free salts left after Frog: Toad and Lizard took them.
    expect(otherDraft.token.vanity).toBe(false);
    expect(otherDraft.token.salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("returns a lapsed reservation to the pool and gives the draft another salt", async () => {
    const lane = createMemeSaltPoolWorker({
      repository,
      scope,
      target: 1,
      attemptsPerSlice: 500,
    });
    await lane.runOnce();
    const other = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s116:${randomUUID()}`,
    );
    const lapsed = await draft("Salamander", "SALA", { ownerUserId: other.id });
    expect(lapsed.token.vanity).toBe(true);
    await pool.query({
      text: `update public.meme_salts set reserved_at = clock_timestamp() - interval '2 hours' where reserved_by_token_id = $1`,
      values: [lapsed.token.memeTokenId],
    });
    expect(
      await repository.releaseStaleSaltReservations(
        new Date(Date.now() - 30 * 60_000).toISOString(),
      ),
    ).toBe(1);
    const released = await repository.getToken(lapsed.token.memeTokenId);
    expect(released?.salt).toBeNull();
    expect(released?.vanity).toBe(false);
    const replaced = await repository.replaceDraftSalt({
      memeTokenId: lapsed.token.memeTokenId,
      expectedSalt: null,
      saltScope: scope,
      fallbackSalt: fallbackSalt(),
    });
    expect(replaced?.vanity).toBe(true);
    expect(replaced?.salt).toBe(lapsed.token.salt);
  });

  it("replays TokenCreated and a trade sequence into snapshot, trades, holders, K-line, and Intents", async () => {
    const frog = (
      await draft("Ribbit", "RIB", {
        ownerUserId: (
          await database.internalUsers.getOrCreateByPrivyUserId(
            `did:privy:s116:${randomUUID()}`,
          )
        ).id,
      })
    ).token;
    const token = frog.predictedAddress ?? "";
    const createTx = fixtureTxHash(0x100);
    // A reported create Intent the lane will confirm.
    const intentId = randomUUID();
    const recordId = (
      await pool.query<{ id: string }>({
        text: `insert into public.idempotency_records (owner_user_id, scope, idempotency_key, key_source, request_sha256, digest_version) values ($1, 'v2_meme_intent', $2, 'client', $3, 'meme_intent_v1') returning id`,
        values: [frog.creatorUserId, randomUUID(), "a".repeat(64)],
      })
    ).rows[0]?.id;
    await pool.query({
      text: `
        insert into public.meme_intents (
          intent_id, owner_user_id, wallet_id, wallet_address, meme_token_id, kind,
          chain_id, contract_address, usd1_amount_raw, token_amount_raw,
          expected_out_raw, min_out_raw, fee_raw, refund_raw, deadline,
          snapshot_block_number, snapshot_block_hash, calldata,
          unsigned_transaction, policy, payload_digest, state, transaction_hash,
          reported_at, expires_at, idempotency_record_id
        ) values ($1, $2, $3, $4, $5, 'create', $6, $7, 0, 0, 0, 0, 0, 0,
          clock_timestamp() + interval '5 minutes', 1, $8, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, $9, 'broadcast_reported', $10,
          clock_timestamp(), clock_timestamp() + interval '5 minutes', $11)
      `,
      values: [
        intentId,
        frog.creatorUserId,
        randomUUID(),
        buyerB,
        frog.memeTokenId,
        chainId,
        memeCurveAddress,
        fixtureBlockHash(1n),
        "b".repeat(64),
        createTx,
        recordId,
      ],
    });
    await pool.query({
      text: `update public.meme_tokens set status = 'pending_chain' where meme_token_id = $1`,
      values: [frog.memeTokenId],
    });

    const logs = [
      memeLog({
        name: "TokenCreated",
        args: {
          token,
          creator: buyerB,
          salt: frog.salt,
          metadataHash: frog.metadataHash,
          name: frog.name,
          symbol: frog.symbol,
          at: t0,
        },
        blockNumber: 100n,
        logIndex: 0,
        transactionHash: createTx,
      }),
    ];
    let curve: MemeCurveState = freshMemeCurve;
    const trades: [string, boolean, bigint, bigint][] = [
      [buyerB, true, 100n * memeE18, t0],
      [buyerA, true, 500n * memeE18, t0 + 30n],
      [buyerA, false, 0n, t0 + 90n],
      [buyerB, true, 50n * memeE18, t0 + 400n],
    ];
    const held = new Map<string, bigint>();
    trades.forEach(([wallet, isBuy, amount, at], index) => {
      let usd1Amount: bigint;
      let tokenAmount: bigint;
      let fee: bigint;
      if (isBuy) {
        const quote = quoteMemeBuy(curve, amount);
        usd1Amount = quote.paid;
        tokenAmount = quote.tokensOut;
        fee = quote.fee;
        curve = { vUsd1: quote.newVUsd1, vToken: quote.newVToken };
        held.set(wallet, (held.get(wallet) ?? 0n) + tokenAmount);
      } else {
        tokenAmount = (held.get(wallet) ?? 0n) / 2n;
        const quote = quoteMemeSell(curve, tokenAmount);
        usd1Amount = quote.usd1Out;
        fee = quote.fee;
        curve = { vUsd1: quote.newVUsd1, vToken: quote.newVToken };
        held.set(wallet, (held.get(wallet) ?? 0n) - tokenAmount);
      }
      logs.push(
        memeLog({
          name: "Trade",
          args: {
            token,
            wallet,
            isBuy,
            usd1Amount,
            tokenAmount,
            feeUsd1: fee,
            vUsd1After: curve.vUsd1,
            vTokenAfter: curve.vToken,
            soldAfter: memeT0 - curve.vToken,
            at,
          },
          blockNumber: 100n + BigInt(index),
          logIndex: index === 0 ? 1 : 0,
          transactionHash:
            index === 0 ? createTx : fixtureTxHash(0x200 + index),
        }),
      );
    });
    // A token LOOP did not create is never stored.
    logs.push(
      memeLog({
        name: "Trade",
        args: {
          token: "0x9999999999999999999999999999999999999999",
          wallet: buyerA,
          isBuy: true,
          usd1Amount: memeE18,
          tokenAmount: 1n,
          feeUsd1: 1n,
          vUsd1After: freshMemeCurve.vUsd1,
          vTokenAfter: freshMemeCurve.vToken,
          soldAfter: 0n,
          at: t0,
        },
        blockNumber: 104n,
        logIndex: 5,
        transactionHash: fixtureTxHash(0x300),
      }),
    );
    const events: MemeLaneEventInput[] = decodeMemeCurveLogs(logs).events.map(
      (event) => toMemeLaneEvent(event),
    );
    const committed = await repository.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events,
      checkpoint: {
        lastBlockNumber: "104",
        lastBlockHash: fixtureBlockHash(104n),
        startedFromBlockNumber: "100",
      },
    });
    expect(committed).toMatchObject({
      storedCount: 5,
      skippedCount: 1,
      metadataMismatchCount: 0,
    });

    const indexed = await repository.getToken(frog.memeTokenId);
    expect(indexed).toMatchObject({
      status: "trading",
      tokenAddress: token,
      assetId: `${chainId}:${token}`,
      creatorWallet: buyerB,
      createdTxHash: createTx,
      vUsd1: curve.vUsd1.toString(),
      vToken: curve.vToken.toString(),
      sold: (memeT0 - curve.vToken).toString(),
      tradeCount: 4,
      holderCount: 2,
    });
    const asset = await pool.query<{ symbol: string; status: string }>({
      text: `select symbol, status from public.assets where asset_id = $1`,
      values: [`${chainId}:${token}`],
    });
    expect(asset.rows[0]).toEqual({ symbol: "RIB", status: "pending" });
    const intent = await repository.getIntent({
      ownerUserId: frog.creatorUserId,
      intentId,
    });
    expect(intent?.state).toBe("confirmed");
    const salt = await pool.query<{ status: string }>({
      text: `select status from public.meme_salts where salt = $1`,
      values: [frog.salt],
    });
    expect(salt.rows.map((row) => row.status)).toEqual(
      frog.vanity ? ["used"] : [],
    );

    const holders = await repository.listHolders({
      memeTokenId: frog.memeTokenId,
      limit: 10,
      after: null,
    });
    expect(holders.map((holder) => [holder.wallet, holder.balance])).toEqual(
      [...held.entries()]
        .sort((left, right) => (left[1] > right[1] ? -1 : 1))
        .map(([wallet, balance]) => [wallet, balance.toString()]),
    );
    expect(holders.find((holder) => holder.wallet === buyerA)?.account).toEqual(
      {
        publicProfileId: creatorProfileId,
        displayName: "frogmaker",
        avatarRef: null,
      },
    );
    const firstPage = await repository.listTrades({
      memeTokenId: frog.memeTokenId,
      limit: 3,
      after: null,
    });
    expect(firstPage.map((trade) => trade.blockNumber)).toEqual([
      "103",
      "102",
      "101",
    ]);
    const lastTrade = firstPage[2]!;
    const rest = await repository.listTrades({
      memeTokenId: frog.memeTokenId,
      limit: 3,
      after: {
        blockNumber: lastTrade.blockNumber,
        logIndex: lastTrade.logIndex,
      },
    });
    expect(rest.map((trade) => trade.blockNumber)).toEqual(["100"]);
    expect(firstPage[0]?.priceAfterE18).toBe(memePriceE18(curve).toString());

    const candles = await repository.listCandles({
      memeTokenId: frog.memeTokenId,
      intervalSeconds: 60,
      limit: 300,
      until: null,
    });
    // Trades at t0, t0+30 (one minute), t0+90, t0+400.
    expect(candles.map((candle) => candle.tradeCount)).toEqual([2, 1, 1]);
    expect(candles[0]?.openTime).toBe(
      new Date(Number(t0) * 1000).toISOString(),
    );
    const firstHigh = BigInt(candles[0]?.highE18 ?? "0");
    expect(firstHigh >= BigInt(candles[0]?.openE18 ?? "0")).toBe(true);
    const listed = await repository.listTokens({
      chainId,
      contractAddress: memeCurveAddress,
      tab: "new",
      limit: 10,
      after: null,
      now: new Date(Number(t0 + 500n) * 1000).toISOString(),
    });
    expect(listed.map((row) => row.memeTokenId)).toEqual([frog.memeTokenId]);
    expect(BigInt(listed[0]?.volume24hRaw ?? "0") > 0n).toBe(true);
    const hot = await repository.rankHotTokens({
      chainId,
      contractAddress: memeCurveAddress,
      since: new Date(Number(t0 - 10n) * 1000).toISOString(),
      limit: 10,
    });
    expect(hot[0]?.memeTokenId).toBe(frog.memeTokenId);

    // The market `meme` category prices it from the curve.
    const candidates = await database.marketCategories?.listMemeCandidates(50);
    expect(
      candidates?.find((row) => row.assetId === `${chainId}:${token}`)?.curve,
    ).toMatchObject({
      status: "trading",
      vUsd1: curve.vUsd1.toString(),
      vToken: curve.vToken.toString(),
    });

    // Reorg: blocks >= 103 are rewound and replayed without the last buy.
    const rewound = await repository.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: [],
      checkpoint: {
        lastBlockNumber: "103",
        lastBlockHash: fixtureBlockHash(1_103n),
        startedFromBlockNumber: "100",
      },
      rewindFromBlockNumber: "103",
    });
    expect(rewound.touchedTokenIds).toEqual([frog.memeTokenId]);
    const afterReorg = await repository.getToken(frog.memeTokenId);
    expect(afterReorg?.tradeCount).toBe(3);
    const third = events.filter((event) => event.kind === "trade")[2];
    expect(third?.kind === "trade" ? third.vUsd1After : "").toBe(
      afterReorg?.vUsd1,
    );
    const checkpoint = await repository.getCheckpoint(chainId);
    expect(checkpoint).toMatchObject({
      lastBlockNumber: "103",
      lastBlockHash: fixtureBlockHash(1_103n),
    });

    // Full → graduation candidate → Graduated with a residual.
    await repository.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: decodeMemeCurveLogs([
        memeLog({
          name: "CurveFull",
          args: { token, realUsd1: 1n, at: t0 + 600n },
          blockNumber: 110n,
          logIndex: 0,
          transactionHash: fixtureTxHash(0x400),
        }),
      ]).events.map((event) => toMemeLaneEvent(event)),
      checkpoint: {
        lastBlockNumber: "110",
        lastBlockHash: fixtureBlockHash(110n),
        startedFromBlockNumber: "100",
      },
    });
    expect((await repository.getToken(frog.memeTokenId))?.status).toBe("full");
    const due = await repository.listGraduationCandidates({
      chainId,
      fullBefore: new Date(Number(t0 + 660n) * 1000).toISOString(),
      now: new Date(Number(t0 + 660n) * 1000).toISOString(),
      limit: 5,
    });
    expect(due.map((row) => row.memeTokenId)).toEqual([frog.memeTokenId]);
    await repository.recordGraduationAttempt({
      memeTokenId: frog.memeTokenId,
      errorCode: "MEME_GRADUATE_REVERTED",
      nextAttemptAt: new Date(Number(t0 + 960n) * 1000).toISOString(),
      needsOperator: false,
    });
    expect(
      await repository.listGraduationCandidates({
        chainId,
        fullBefore: new Date(Number(t0 + 700n) * 1000).toISOString(),
        now: new Date(Number(t0 + 700n) * 1000).toISOString(),
        limit: 5,
      }),
    ).toEqual([]);
    const pool_ = "0x7777777777777777777777777777777777777777";
    await repository.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: decodeMemeCurveLogs([
        memeLog({
          name: "Graduated",
          args: {
            token,
            pool: pool_,
            usd1ToPool: 16_982n * memeE18,
            tokensToPool: 200_000_000n * memeE18,
            lpTokenId: 42n,
            feeUsd1: 600n * memeE18,
            at: t0 + 700n,
          },
          blockNumber: 111n,
          logIndex: 0,
          transactionHash: fixtureTxHash(0x500),
        }),
        memeLog({
          name: "GraduationResidual",
          args: { token, usd1Left: 5n, tokensLeft: 0n },
          blockNumber: 111n,
          logIndex: 1,
          transactionHash: fixtureTxHash(0x500),
        }),
      ]).events.map((event) => toMemeLaneEvent(event)),
      checkpoint: {
        lastBlockNumber: "111",
        lastBlockHash: fixtureBlockHash(111n),
        startedFromBlockNumber: "100",
      },
    });
    const graduated = await repository.getToken(frog.memeTokenId);
    expect(graduated).toMatchObject({
      status: "graduated",
      poolAddress: pool_,
      graduationTxHash: fixtureTxHash(0x500),
      lpTokenId: "42",
      residualUsd1: "5",
      residualTokens: "0",
      graduatedAt: new Date(Number(t0 + 700n) * 1000).toISOString(),
    });
    const frozen = await repository.listHolders({
      memeTokenId: frog.memeTokenId,
      limit: 10,
      after: null,
    });
    expect(
      frozen.every((holder) => holder.frozenAt === graduated?.graduatedAt),
    ).toBe(true);
    const graduatedTab = await repository.listTokens({
      chainId,
      contractAddress: memeCurveAddress,
      tab: "graduated",
      limit: 10,
      after: null,
      now: new Date().toISOString(),
    });
    expect(graduatedTab.map((row) => row.memeTokenId)).toEqual([
      frog.memeTokenId,
    ]);
    const graduatedCandidate = (
      await database.marketCategories?.listMemeCandidates(50)
    )?.find((row) => row.assetId === `${chainId}:${token}`);
    // Decision 0103: the graduated pool feeds the slot0 fallback.
    expect(graduatedCandidate).toEqual({
      assetId: `${chainId}:${token}`,
      graduatedPool: pool_,
      curve: null,
    });
    // Decision 0103: the lane keeps the 5-wei residual; the wire hides dust.
    expect(
      graduated === null ? undefined : projectMemeGraduation(graduated),
    ).toMatchObject({ pool: pool_, residual: null });
  });

  it("refuses a TokenCreated whose metadata does not match the draft", async () => {
    const other = await database.internalUsers.getOrCreateByPrivyUserId(
      `did:privy:s116:${randomUUID()}`,
    );
    const toad = (await draft("Croak", "CROAK", { ownerUserId: other.id }))
      .token;
    const committed = await repository.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: decodeMemeCurveLogs([
        memeLog({
          name: "TokenCreated",
          args: {
            token: toad.predictedAddress,
            creator: buyerA,
            salt: toad.salt,
            metadataHash: toad.metadataHash,
            name: "Imposter",
            symbol: toad.symbol,
            at: t0,
          },
          blockNumber: 200n,
          logIndex: 0,
          transactionHash: fixtureTxHash(0x600),
        }),
      ]).events.map((event) => toMemeLaneEvent(event)),
      checkpoint: {
        lastBlockNumber: "200",
        lastBlockHash: fixtureBlockHash(200n),
        startedFromBlockNumber: "100",
      },
    });
    expect(committed).toMatchObject({
      storedCount: 0,
      metadataMismatchCount: 1,
    });
    expect((await repository.getToken(toad.memeTokenId))?.status).toBe("draft");
  });
});
