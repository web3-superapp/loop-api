import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toMemeLaneEvent } from "../src/bsc-meme-indexer-worker.js";
import type { BscWriteConfig } from "../src/config.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { createPostgresLaunchChainRepository } from "../src/database/launch-chain-repository.js";
import { createPostgresMemeRepository } from "../src/database/meme-repository.js";
import { createPostgresWalletIntentRepository } from "../src/database/wallet-intent-repository.js";
import type { LaunchChainRepository } from "../src/features/launch/launch-chain-repository.js";
import { createLaunchService } from "../src/features/launch/launch-service.js";
import {
  memeMetadataHash,
  parseMemeTokenMetadata,
} from "../src/features/meme/meme-contract.js";
import { randomMemeSalt } from "../src/features/meme/meme-create2.js";
import {
  freshMemeCurve,
  memeE18,
  memePriceE18,
  memeT0,
  quoteMemeBuy,
  type MemeCurveState,
} from "../src/features/meme/meme-curve-math.js";
import { prepareMemeIntent } from "../src/features/meme/meme-intent-service.js";
import type {
  MemeLaneEventInput,
  MemeRepository,
  MemeSaltScope,
} from "../src/features/meme/meme-repository.js";
import { dailyCanaryAdmission } from "../src/features/wallet-intents/intent-preparation.js";
import { createSendService } from "../src/features/wallet-intents/send-service.js";
import { createSwapService } from "../src/features/wallet-intents/swap-service.js";
import { decodeMemeCurveLogs } from "../src/integrations/meme/meme-contract-adapter.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import {
  createFakeLaunchAdapter,
  createFakeLaunchChainState,
  createFakeLaunchSlotClient,
  fakeNowSeconds,
} from "./helpers/launch-fake-adapter.js";
import { oneUsd1 } from "./helpers/launch-lane-fixtures.js";
import {
  accountId,
  chainRepositoryFake,
  launchId,
  launchRepositoryFor,
  registeredDetail,
  roundOneId,
  walletId as launchWalletId,
  walletsFake,
  writesConfig,
} from "./helpers/launch-service-fakes.js";
import {
  fixtureBlockHash,
  fixtureTxHash,
  memeCurveAddress,
  memeLog,
  memeTokenImplementation,
} from "./helpers/meme-fixtures.js";
import {
  createFakeMemeAdapter,
  createFakeMemeSlotClient,
  defaultMemeFunds,
  memeContractConfig,
  memeUsd1,
  type FakeCurveChain,
} from "./helpers/meme-service-fakes.js";
import {
  principal as walletPrincipal,
  runtimeFake,
  usdtAssetId,
  wbnbAssetId,
  recipientAddress,
  walletId as sendWalletId,
} from "./wallet-intent-fakes.js";

/**
 * Decision 0104 against PostgreSQL: M1 (one canary window over wallet,
 * Launch, and MEME), M2 (the ceiling and the one-live-create rule are
 * re-checked under the owner lock at insert time; concurrent prepares),
 * M5 (a reorg refreshes every trade fact and reopens the Intents whose
 * evidence it removed), and m3 (TokenCreated must come from a create
 * Intent's wallet).
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
const buyerW = "0x4444444444444444444444444444444444444444";
const buyerY = "0x5555555555555555555555555555555555555555";
const front = "0x6666666666666666666666666666666666666666";
const t0 = 1_791_590_400n;
const signal = new AbortController().signal;

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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

function memeWrites(dailyMaxUsd: string): BscWriteConfig {
  return {
    configVersion: "bscWriteCanaryV1",
    canaryAssetIds: [`${chainId}:${memeUsd1}`],
    canaryMaxUsd: "5000",
    canaryDailyMaxUsd: dailyMaxUsd,
    canaryCounterpartyAddresses: [],
    swapFeeBps: null,
  };
}

function laneEvents(
  logs: Parameters<typeof decodeMemeCurveLogs>[0],
): MemeLaneEventInput[] {
  return decodeMemeCurveLogs(logs).events.map((event) =>
    toMemeLaneEvent(event),
  );
}

function tradeLog(input: {
  readonly token: string;
  readonly wallet: string;
  readonly before: MemeCurveState;
  readonly usd1In: bigint;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: string;
  readonly at: bigint;
}) {
  const quote = quoteMemeBuy(input.before, input.usd1In);
  const after = { vUsd1: quote.newVUsd1, vToken: quote.newVToken };
  return {
    after,
    tokensOut: quote.tokensOut,
    log: memeLog({
      name: "Trade",
      args: {
        token: input.token,
        wallet: input.wallet,
        isBuy: true,
        usd1Amount: quote.paid,
        tokenAmount: quote.tokensOut,
        feeUsd1: quote.fee,
        vUsd1After: after.vUsd1,
        vTokenAfter: after.vToken,
        soldAfter: memeT0 - after.vToken,
        at: input.at,
      },
      blockNumber: input.blockNumber,
      logIndex: input.logIndex,
      transactionHash: input.transactionHash,
    }),
  };
}

describe("Decision 0104 canary window and indexing fixes on PostgreSQL", () => {
  const databaseName = `loop_s116c_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let memes: MemeRepository;
  let launchChain: LaunchChainRepository;
  let walletIntents: ReturnType<typeof createPostgresWalletIntentRepository>;

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
    memes = createPostgresMemeRepository(pool);
    launchChain = createPostgresLaunchChainRepository(pool);
    walletIntents = createPostgresWalletIntentRepository(pool);
    // The wallet, Launch, and MEME fixtures share one account id.
    await pool.query({
      text: `insert into public.loop_users (id, privy_user_id) values ($1, $2)`,
      values: [accountId, `did:privy:${randomUUID()}`],
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await pool.query({
      text: `insert into public.loop_users (id, privy_user_id) values ($1, $2)`,
      values: [id, `did:privy:${randomUUID()}`],
    });
    return id;
  }

  async function draft(ownerUserId: string, name: string, symbol: string) {
    const memeTokenId = randomUUID();
    const metadata = parseMemeTokenMetadata({ name, symbol });
    const created = await memes.createDraft({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: createHash("sha256")
        .update(`${memeTokenId}\0${name}`)
        .digest("hex"),
      dailyLimit: 100,
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
      fallbackSalt: randomMemeSalt({
        deployer: memeCurveAddress,
        implementation: memeTokenImplementation,
      }),
    });
    return created.token;
  }

  /** A draft moved to `trading` at `tokenAddress` (the lane's work). */
  async function tradingToken(ownerUserId: string, chain: FakeCurveChain) {
    const token = await draft(ownerUserId, "Trade Frog", "TFROG");
    const tokenAddress = token.predictedAddress as string;
    await pool.query({
      text: `update public.meme_tokens set status = 'trading', token_address = $2 where meme_token_id = $1`,
      values: [token.memeTokenId, tokenAddress],
    });
    chain.curves.set(tokenAddress, {
      curve: freshMemeCurve,
      status: "TRADING",
    });
    return { ...token, tokenAddress, status: "trading" as const };
  }

  function memeDeps(options: {
    readonly repository?: MemeRepository;
    readonly chain: FakeCurveChain;
    readonly dailyMaxUsd: string;
  }) {
    const repository = options.repository ?? memes;
    const deps: Parameters<typeof prepareMemeIntent>[0] = {
      config: {
        contract: memeContractConfig,
        unconfiguredReason: null,
        saltPoolTarget: 0,
        vanitySuffix: "",
        createDailyLimit: 3,
        classicCreateEnabled: true,
      },
      repository,
      contract: createFakeMemeAdapter(options.chain),
      cursorCodec: null,
      wallets: walletsFake(),
      readClient: createFakeMemeSlotClient(
        defaultMemeFunds({ usd1Allowance: 10n ** 30n }),
      ),
      writes: memeWrites(options.dailyMaxUsd),
      publicBaseUrl: "https://api.invalid",
      contractConfig: memeContractConfig,
      now: () => new Date(),
      createUuid: () => randomUUID(),
      visibleToken: async (id) => {
        const found = await memes.getToken(id);
        if (found === null) {
          throw V2ApiError.notFound();
        }
        return found;
      },
    };
    return deps;
  }

  function principalOf(userId: string) {
    return Object.freeze({
      userId,
      privyUserId: "did:privy:verified-user",
    }) as never;
  }

  function prepare(
    deps: Parameters<typeof prepareMemeIntent>[0],
    userId: string,
    memeTokenId: string,
    body: Record<string, unknown>,
  ) {
    return prepareMemeIntent(deps, {
      principal: principalOf(userId),
      memeTokenId,
      body: { walletId: launchWalletId, ...body },
      idempotencyKey: randomUUID(),
    });
  }

  function expectDailyRefusal(error: unknown, spentUsd?: string): void {
    expect(error).toBeInstanceOf(V2ApiError);
    expect(error).toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: {
        reasonCode: "CANARY_DAILY_CEILING_EXCEEDED",
        ...(spentUsd === undefined ? {} : { spentUsd }),
      },
    });
  }

  it("M1: a MEME Intent that spends the day blocks Send, Swap, and Launch (and n3 counts the window start)", async () => {
    const chain: FakeCurveChain = { curves: new Map(), unavailable: false };
    const token = await tradingToken(accountId, chain);
    const bought = await prepare(
      memeDeps({ chain, dailyMaxUsd: "100" }),
      accountId,
      token.memeTokenId,
      { kind: "buy", usd1Amount: "100" },
    );
    expect(bought.memeIntent).toMatchObject({ kind: "buy", state: "prepared" });

    // The shared sum, read through each module's repository.
    const since = new Date(Date.now() - 86_400_000).toISOString();
    expect(
      await walletIntents.sumRecentExposureUsd({
        ownerUserId: accountId,
        since,
      }),
    ).toBe("100");
    expect(
      await memes.sumRecentExposureUsd({ ownerUserId: accountId, since }),
    ).toBe("100");
    // n3: `created_at >= since` in every table — a window that starts at
    // the Intent's own creation instant still counts it (`>` would not).
    const truncated = await pool.query<{ created_at: Date }>({
      text: `
        update public.meme_intents
        set created_at = date_trunc('milliseconds', created_at)
        where intent_id = $1
        returning created_at
      `,
      values: [bought.memeIntent["memeIntentId"]],
    });
    const exactStart = truncated.rows[0]!.created_at.toISOString();
    expect(
      await memes.sumRecentExposureUsd({
        ownerUserId: accountId,
        since: exactStart,
      }),
    ).toBe("100");
    expect(
      await memes.sumRecentExposureUsd({
        ownerUserId: accountId,
        since: new Date(Date.parse(exactStart) + 1).toISOString(),
      }),
    ).toBe("0");

    // Wallet Send: 1.5 USDT more crosses the 100 USD day.
    const walletFixture = runtimeFake({ canaryDailyMaxUsd: "100" });
    const walletRuntime = {
      ...walletFixture.runtime,
      repository: {
        ...walletFixture.repository,
        sumRecentExposureUsd: (input: {
          readonly ownerUserId: string;
          readonly since: string;
        }) => walletIntents.sumRecentExposureUsd(input),
      },
    };
    expect(walletPrincipal.userId).toBe(accountId);
    expectDailyRefusal(
      await rejectionOf(
        createSendService(walletRuntime).prepare({
          principal: walletPrincipal,
          idempotencyKey: randomUUID(),
          body: {
            walletId: sendWalletId,
            assetId: usdtAssetId,
            amount: "1.5",
            recipientAddress,
          },
          signal,
        }),
      ),
      "100",
    );
    // Wallet Swap: the quote already applies the daily ceiling.
    expectDailyRefusal(
      await rejectionOf(
        createSwapService({ runtime: walletRuntime }).quote({
          principal: walletPrincipal,
          body: {
            walletId: sendWalletId,
            sourceAssetId: usdtAssetId,
            destinationAssetId: wbnbAssetId,
            amount: "4",
          },
          signal,
        }),
      ),
      "100",
    );

    // Launch purchase: its pre-check reads the same window.
    const launch = (
      exposure: (input: {
        readonly ownerUserId: string;
        readonly since: string;
      }) => Promise<string>,
    ) =>
      createLaunchService({
        repository: launchRepositoryFor(registeredDetail()),
        cursorCodec: null,
        contract: createFakeLaunchAdapter(createFakeLaunchChainState({})),
        chain: {
          ...chainRepositoryFake(),
          createIntent: (input) => launchChain.createIntent(input),
        },
        wallets: walletsFake(),
        now: () => new Date(Number(fakeNowSeconds) * 1000),
        intentRuntime: {
          writes: writesConfig({}),
          readClient: createFakeLaunchSlotClient({
            usd1Balance: 1_000n * oneUsd1,
            allowance: 1_000n * oneUsd1,
            nativeBalance: 10n ** 17n,
            simulation: "passed",
          }),
          wallets: walletsFake(),
          walletIntentExposureUsd: exposure,
          now: () => new Date(Number(fakeNowSeconds) * 1000),
          createUuid: () => randomUUID(),
        },
      });
    const launchBody = {
      walletId: launchWalletId,
      roundId: roundOneId,
      payAmount: "10",
    };
    expectDailyRefusal(
      await rejectionOf(
        launch((input) =>
          walletIntents.sumRecentExposureUsd(input),
        ).prepareIntent({
          principal: principalOf(accountId),
          launchId,
          body: launchBody,
          idempotencyKey: randomUUID(),
          requestId: randomUUID(),
        }),
      ),
      "100",
    );
    // M2 for Launch: a stale pre-check ("0") is caught by the re-check
    // under the owner lock, and nothing is stored.
    expectDailyRefusal(
      await rejectionOf(
        launch(() => Promise.resolve("0")).prepareIntent({
          principal: principalOf(accountId),
          launchId,
          body: launchBody,
          idempotencyKey: randomUUID(),
          requestId: randomUUID(),
        }),
      ),
      "100",
    );
    const launchRows = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.launch_intents`,
    );
    expect(launchRows.rows[0]?.count).toBe("0");

    // M2 for wallet: the repository's own re-check refuses before writing.
    const admission = dailyCanaryAdmission(
      memeWrites("100"),
      "1.5",
      new Date(),
    );
    expect(admission).not.toBeNull();
    expectDailyRefusal(
      await rejectionOf(
        walletIntents.create({
          intentId: randomUUID(),
          ownerUserId: accountId,
          walletId: randomUUID(),
          providerOperationId: null,
          kind: "send",
          state: "awaiting_signature",
          chainId: "eip155:56",
          canonicalPayload: {} as never,
          publicReview: {} as never,
          reviewSha256: "0".repeat(64),
          policyConfigVersion: "bscWriteCanaryV1",
          factsObservedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          simulationStatus: "passed",
          requestId: randomUUID(),
          canaryAdmission: admission,
        }),
      ),
      "100",
    );
    const walletRows = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.wallet_intents`,
    );
    expect(walletRows.rows[0]?.count).toBe("0");

    // And MEME itself: one more buy is refused on the same window.
    expectDailyRefusal(
      await rejectionOf(
        prepare(
          memeDeps({ chain, dailyMaxUsd: "100" }),
          accountId,
          token.memeTokenId,
          { kind: "buy", usd1Amount: "1" },
        ),
      ),
      "100",
    );
  });

  it("M2: two concurrent prepares that each pass the pre-check cannot both spend the day", async () => {
    const owner = await newUser();
    const chain: FakeCurveChain = { curves: new Map(), unavailable: false };
    const token = await tradingToken(owner, chain);
    // Both pre-checks read the window before either Intent is stored.
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((done) => {
      release = done;
    });
    const gated: MemeRepository = {
      ...memes,
      sumRecentExposureUsd: async (input) => {
        const total = await memes.sumRecentExposureUsd(input);
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await bothRead;
        return total;
      },
    };
    const deps = memeDeps({ repository: gated, chain, dailyMaxUsd: "100" });
    const outcomes = await Promise.allSettled([
      prepare(deps, owner, token.memeTokenId, {
        kind: "buy",
        usd1Amount: "60",
      }),
      prepare(deps, owner, token.memeTokenId, {
        kind: "buy",
        usd1Amount: "60",
      }),
    ]);
    expect(arrived).toBe(2);
    const fulfilled = outcomes.filter((item) => item.status === "fulfilled");
    const rejected = outcomes.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectDailyRefusal((rejected[0] as PromiseRejectedResult).reason, "60");
    const stored = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.meme_intents where owner_user_id = $1`,
      values: [owner],
    });
    expect(stored.rows[0]?.count).toBe("1");
  });

  it("M2: a draft has at most one live create Intent; concurrent prepares get 409 MEME_INTENT_CREATE_IN_FLIGHT", async () => {
    const owner = await newUser();
    const chain: FakeCurveChain = { curves: new Map(), unavailable: false };
    const token = await draft(owner, "Create Frog", "CFROG");
    const deps = memeDeps({ chain, dailyMaxUsd: "100" });
    const outcomes = await Promise.allSettled(
      [0, 1, 2].map(() =>
        prepare(deps, owner, token.memeTokenId, { kind: "create" }),
      ),
    );
    const fulfilled = outcomes.filter(
      (
        item,
      ): item is PromiseFulfilledResult<
        Awaited<ReturnType<typeof prepareMemeIntent>>
      > => item.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const refusal of rejected) {
      expect(refusal.reason).toBeInstanceOf(V2ApiError);
      expect(refusal.reason).toMatchObject({
        code: "DATA_STALE",
        detailsSafe: { reasonCode: "MEME_INTENT_CREATE_IN_FLIGHT" },
      });
    }
    const winner = fulfilled[0]!.value.memeIntent["memeIntentId"] as string;
    // Once it is terminal (here: its signing window lapsed) another may
    // be prepared.
    await pool.query({
      text: `update public.meme_intents set expires_at = clock_timestamp() - interval '1 second' where intent_id = $1`,
      values: [winner],
    });
    const next = await prepare(deps, owner, token.memeTokenId, {
      kind: "create",
    });
    expect(next.memeIntent["memeIntentId"]).not.toBe(winner);
    // A reported create is in flight too.
    await pool.query({
      text: `update public.meme_intents set state = 'broadcast_reported', transaction_hash = $2, reported_at = clock_timestamp() where intent_id = $1`,
      values: [next.memeIntent["memeIntentId"], fixtureTxHash(0x7001)],
    });
    expect(
      await rejectionOf(
        prepare(deps, owner, token.memeTokenId, { kind: "create" }),
      ),
    ).toMatchObject({
      code: "DATA_STALE",
      detailsSafe: { reasonCode: "MEME_INTENT_CREATE_IN_FLIGHT" },
    });
  });

  async function insertIntent(input: {
    readonly ownerUserId: string;
    readonly memeTokenId: string;
    readonly kind: "create" | "buy";
    readonly walletAddress: string;
    readonly state: "prepared" | "broadcast_reported" | "confirmed";
    readonly transactionHash: string | null;
    readonly receiptBlock?: string;
  }): Promise<string> {
    const intentId = randomUUID();
    const recordId = (
      await pool.query<{ id: string }>({
        text: `insert into public.idempotency_records (owner_user_id, scope, idempotency_key, key_source, request_sha256, digest_version) values ($1, 'v2_meme_intent', $2, 'client', $3, 'meme_intent_v1') returning id`,
        values: [input.ownerUserId, randomUUID(), "a".repeat(64)],
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
          reported_at, receipt, expires_at, idempotency_record_id
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0, 0, 0,
          clock_timestamp() + interval '5 minutes', 1, $9, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, $10, $11, $12,
          case when $12::text is null then null else clock_timestamp() end,
          $13::jsonb, clock_timestamp() + interval '5 minutes', $14)
      `,
      values: [
        intentId,
        input.ownerUserId,
        randomUUID(),
        input.walletAddress,
        input.memeTokenId,
        input.kind,
        chainId,
        memeCurveAddress,
        fixtureBlockHash(1n),
        "b".repeat(64),
        input.state,
        input.transactionHash,
        input.receiptBlock === undefined
          ? null
          : JSON.stringify({
              status: "success",
              blockNumber: input.receiptBlock,
              blockHash: fixtureBlockHash(BigInt(input.receiptBlock)),
              gasUsed: "1",
              effectiveGasPrice: "1",
              confirmations: 5,
              observedAt: new Date().toISOString(),
            }),
        recordId,
      ],
    });
    return intentId;
  }

  async function intentState(intentId: string) {
    const result = await pool.query<{
      state: string;
      receipt: unknown;
      reconcile_after: Date | null;
    }>({
      text: `select state, receipt, reconcile_after from public.meme_intents where intent_id = $1`,
      values: [intentId],
    });
    return result.rows[0];
  }

  function checkpoint(block: bigint) {
    return {
      lastBlockNumber: block.toString(10),
      lastBlockHash: fixtureBlockHash(block + 9_000n),
      startedFromBlockNumber: "1000",
    };
  }

  it("M1: a failed MEME Intent with a broadcast hash counts; expired and lapsed prepared ones do not", async () => {
    const owner = await newUser();
    const token = await draft(owner, "Count Frog", "KFROG");
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const withValue = async (
      state: "prepared" | "failed" | "expired",
      transactionHash: string | null,
      lapsed: boolean,
    ) => {
      const intentId = await insertIntent({
        ownerUserId: owner,
        memeTokenId: token.memeTokenId,
        kind: "buy",
        walletAddress: buyerW,
        state: transactionHash === null ? "prepared" : "broadcast_reported",
        transactionHash,
      });
      await pool.query({
        text: `
          update public.meme_intents set state = $2,
            policy = '{"valueUsd": "7"}'::jsonb,
            expires_at = case when $3::boolean
              then clock_timestamp() - interval '1 second' else expires_at end
          where intent_id = $1
        `,
        values: [intentId, state, lapsed],
      });
    };
    await withValue("failed", fixtureTxHash(0xa001), true);
    expect(
      await memes.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("7");
    await withValue("expired", fixtureTxHash(0xa002), true);
    await withValue("prepared", null, true);
    expect(
      await memes.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("7");
    await withValue("prepared", null, false);
    expect(
      await walletIntents.sumRecentExposureUsd({ ownerUserId: owner, since }),
    ).toBe("14");
  });

  it("m3: a TokenCreated whose creator is not a create Intent's wallet is refused and counted", async () => {
    const owner = await newUser();
    const token = await draft(owner, "Snipe Frog", "SFROG");
    await insertIntent({
      ownerUserId: owner,
      memeTokenId: token.memeTokenId,
      kind: "create",
      walletAddress: buyerW,
      state: "prepared",
      transactionHash: null,
    });
    const created = (creator: string, tx: number) =>
      memeLog({
        name: "TokenCreated",
        args: {
          token: token.predictedAddress,
          creator,
          salt: token.salt,
          metadataHash: token.metadataHash,
          name: token.name,
          symbol: token.symbol,
          at: t0,
        },
        blockNumber: 900n,
        logIndex: 0,
        transactionHash: fixtureTxHash(tx),
      });
    const sniped = await memes.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: laneEvents([created(front, 0x8001)]),
      checkpoint: checkpoint(900n),
    });
    expect(sniped).toMatchObject({
      storedCount: 0,
      skippedCount: 1,
      metadataMismatchCount: 0,
      creatorMismatchCount: 1,
    });
    const untouched = await memes.getToken(token.memeTokenId);
    expect(untouched).toMatchObject({
      status: "draft",
      tokenAddress: null,
      assetId: null,
    });
    const asset = await pool.query({
      text: `select 1 from public.assets where asset_id = $1`,
      values: [`${chainId}:${token.predictedAddress}`],
    });
    expect(asset.rows).toHaveLength(0);
    // The creator's own wallet (even from a prepared, unreported Intent).
    const own = await memes.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: laneEvents([created(buyerW, 0x8002)]),
      checkpoint: checkpoint(901n),
    });
    expect(own).toMatchObject({ storedCount: 1, creatorMismatchCount: 0 });
    expect(await memes.getToken(token.memeTokenId)).toMatchObject({
      status: "trading",
      tokenAddress: token.predictedAddress,
      creatorWallet: buyerW,
    });
  });

  it("M5: a reorg refreshes every trade fact and reopens the Intents whose evidence it removed", async () => {
    const owner = await newUser();
    const token = await draft(owner, "Reorg Frog", "RFROG");
    const address = token.predictedAddress as string;
    const createTx = fixtureTxHash(0x9001);
    const buyTx = fixtureTxHash(0x9002);
    const otherTx = fixtureTxHash(0x9003);
    const createIntent = await insertIntent({
      ownerUserId: owner,
      memeTokenId: token.memeTokenId,
      kind: "create",
      walletAddress: buyerW,
      state: "broadcast_reported",
      transactionHash: createTx,
    });
    const buyIntent = await insertIntent({
      ownerUserId: owner,
      memeTokenId: token.memeTokenId,
      kind: "buy",
      walletAddress: buyerW,
      state: "broadcast_reported",
      transactionHash: buyTx,
    });
    await pool.query({
      text: `update public.meme_tokens set status = 'pending_chain' where meme_token_id = $1`,
      values: [token.memeTokenId],
    });
    const tokenCreated = (blockNumber: bigint) =>
      memeLog({
        name: "TokenCreated",
        args: {
          token: address,
          creator: buyerW,
          salt: token.salt,
          metadataHash: token.metadataHash,
          name: token.name,
          symbol: token.symbol,
          at: t0,
        },
        blockNumber,
        logIndex: 0,
        transactionHash: createTx,
      });
    // Original chain: TokenCreated @1000, our buy first @1001 (log 0).
    const original = tradeLog({
      token: address,
      wallet: buyerW,
      before: freshMemeCurve,
      usd1In: 100n * memeE18,
      blockNumber: 1_001n,
      logIndex: 0,
      transactionHash: buyTx,
      at: t0 + 10n,
    });
    await memes.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: laneEvents([tokenCreated(1_000n), original.log]),
      checkpoint: checkpoint(1_001n),
    });
    expect((await intentState(createIntent))?.state).toBe("confirmed");
    expect((await intentState(buyIntent))?.state).toBe("confirmed");
    expect((await memes.getToken(token.memeTokenId))?.status).toBe("trading");

    // A receipt-confirmed Intent inside the range, and one below it.
    const receiptInside = await insertIntent({
      ownerUserId: owner,
      memeTokenId: token.memeTokenId,
      kind: "buy",
      walletAddress: buyerY,
      state: "confirmed",
      transactionHash: fixtureTxHash(0x9004),
      receiptBlock: "1001",
    });
    const receiptBelow = await insertIntent({
      ownerUserId: owner,
      memeTokenId: token.memeTokenId,
      kind: "buy",
      walletAddress: buyerY,
      state: "confirmed",
      transactionHash: fixtureTxHash(0x9005),
      receiptBlock: "999",
    });

    // Rewind from 1000: every log of the token is gone.
    const rewound = await memes.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: [],
      checkpoint: checkpoint(999n),
      rewindFromBlockNumber: "1000",
    });
    expect(rewound.touchedTokenIds).toEqual([token.memeTokenId]);
    for (const intentId of [createIntent, buyIntent, receiptInside]) {
      expect(await intentState(intentId)).toEqual({
        state: "broadcast_reported",
        receipt: null,
        reconcile_after: null,
      });
    }
    expect((await intentState(receiptBelow))?.state).toBe("confirmed");
    expect(await memes.getToken(token.memeTokenId)).toMatchObject({
      status: "pending_chain",
      tradeCount: 0,
    });
    // The reconcile part leases the reopened Intents again.
    const leased = await memes.leaseReconcilableIntents({
      chainId,
      limit: 50,
      leaseMs: 1,
    });
    expect(leased.map((intent) => intent.intentId)).toEqual(
      expect.arrayContaining([createIntent, buyIntent, receiptInside]),
    );

    // New chain: someone else's buy lands first; our buy is re-included
    // later with the same (tx, logIndex) key but different facts.
    const competitor = tradeLog({
      token: address,
      wallet: buyerY,
      before: freshMemeCurve,
      usd1In: 500n * memeE18,
      blockNumber: 1_001n,
      logIndex: 0,
      transactionHash: otherTx,
      at: t0 + 10n,
    });
    const replayed = tradeLog({
      token: address,
      wallet: buyerW,
      before: competitor.after,
      usd1In: 100n * memeE18,
      blockNumber: 1_002n,
      logIndex: 0,
      transactionHash: buyTx,
      at: t0 + 20n,
    });
    expect(replayed.tokensOut).not.toBe(original.tokensOut);
    await memes.commitSegment({
      chainId,
      contractAddress: memeCurveAddress,
      events: laneEvents([tokenCreated(1_000n), competitor.log, replayed.log]),
      checkpoint: checkpoint(1_002n),
    });
    const row = await pool.query<Record<string, string | boolean | Date>>({
      text: `
        select block_number::text as block_number, wallet, is_buy,
          token_amount::text as token_amount, v_usd1_after::text as v_usd1_after,
          v_token_after::text as v_token_after, sold_after::text as sold_after,
          price_after_e18::text as price_after_e18, traded_at, removed
        from public.meme_trades
        where transaction_hash = $1 and log_index = 0
      `,
      values: [buyTx],
    });
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      block_number: "1002",
      wallet: buyerW,
      is_buy: true,
      token_amount: replayed.tokensOut.toString(),
      v_usd1_after: replayed.after.vUsd1.toString(),
      v_token_after: replayed.after.vToken.toString(),
      sold_after: (memeT0 - replayed.after.vToken).toString(),
      price_after_e18: memePriceE18(replayed.after).toString(),
      removed: false,
    });
    expect((row.rows[0]?.["traded_at"] as Date).toISOString()).toBe(
      new Date(Number(t0 + 20n) * 1000).toISOString(),
    );
    expect(await memes.getToken(token.memeTokenId)).toMatchObject({
      status: "trading",
      tradeCount: 2,
      vUsd1: replayed.after.vUsd1.toString(),
      vToken: replayed.after.vToken.toString(),
    });
    const holders = await memes.listHolders({
      memeTokenId: token.memeTokenId,
      limit: 10,
      after: null,
    });
    expect(holders.find((holder) => holder.wallet === buyerW)?.balance).toBe(
      replayed.tokensOut.toString(),
    );
    // The replay confirms the reopened Intents again.
    expect((await intentState(createIntent))?.state).toBe("confirmed");
    expect((await intentState(buyIntent))?.state).toBe("confirmed");
  });
});
