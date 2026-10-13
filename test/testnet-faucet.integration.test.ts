import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import { V2ApiError } from "../src/core/http/v2-error.js";
import { parseTestnetFaucet } from "../src/config.js";
import { createPostgresAccountWalletRepository } from "../src/database/account-wallet-repository.js";
import { createPostgresTestnetFaucetRepository } from "../src/database/testnet-faucet-repository.js";
import {
  TestnetFaucetIdempotencyConflictError,
  type TestnetFaucetRepository,
  type TestnetFaucetReserveInput,
} from "../src/features/testnet-faucet/testnet-faucet-contract.js";
import { createTestnetFaucetService } from "../src/features/testnet-faucet/testnet-faucet-service.js";
import { createTestnetFaucetPendingSweep } from "../src/features/testnet-faucet/testnet-faucet-sweep.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import {
  bnbHash,
  createFakeFaucetChain,
  defaultFaucetChainState,
  faucetUsd1,
  hooksFactory,
  legacyLaunchUsd1,
  usd1Hash,
} from "./helpers/testnet-faucet-fakes.js";

/**
 * Decision 0128 on PostgreSQL (migration 000073), in a throwaway database:
 * the reservation transaction (idempotency claim, replay, address cooldown,
 * concurrent reservations of one address), hash recording, finalisation,
 * the shape constraints, and the service end to end on the real tables.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const NOW = new Date("2026-10-12T08:00:00.000Z");

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

const sha = (n: number) => n.toString(16).padStart(64, "0");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("Decision 0128 testnet faucet grants on PostgreSQL", () => {
  const databaseName = `loop_s156_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let repository: TestnetFaucetRepository;
  let counter = 0;

  async function userWithWallet(): Promise<{
    readonly userId: string;
    readonly walletId: string;
    readonly address: string;
  }> {
    counter += 1;
    const user = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s156:${randomUUID()}`],
    );
    const userId = user.rows[0]!.id;
    const walletAddress = address(0xa00 + counter);
    const wallet = await pool.query<{ wallet_id: string }>(
      `insert into public.account_wallets (owner_user_id, provider_wallet_id, address,
         kind, status, is_active, first_seen_at, last_seen_at)
       values ($1, $2, $3, 'embedded', 'active', true, '2026-01-01', '2026-01-01')
       returning wallet_id`,
      [userId, `privy-s156-${counter}`, walletAddress],
    );
    return {
      userId,
      walletId: wallet.rows[0]!.wallet_id,
      address: walletAddress,
    };
  }

  function reserveInput(
    owner: {
      readonly userId: string;
      readonly walletId: string;
      readonly address: string;
    },
    overrides: Partial<TestnetFaucetReserveInput> = {},
  ): TestnetFaucetReserveInput {
    return {
      ownerUserId: owner.userId,
      idempotencyKey: randomUUID(),
      requestSha256: sha(1),
      grantId: randomUUID(),
      walletId: owner.walletId,
      address: owner.address,
      chainId: "eip155:97",
      bnbAmount: "0.02",
      bnbAmountRaw: "20000000000000000",
      usd1Amount: "500",
      usd1AmountRaw: (500n * 10n ** 18n).toString(),
      usd1TokenAddress: faucetUsd1,
      operatorAddress: address(0xfe),
      now: NOW,
      policy: {
        cooldownSeconds: 86_400,
        failedCooldownSeconds: 300,
        failedDailyLimit: 5,
      },
      ...overrides,
    };
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
    repository = createPostgresTestnetFaucetRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("reserves, records hashes, finalises, and replays by idempotency key", async () => {
    const owner = await userWithWallet();
    const input = reserveInput(owner);
    const reserved = await repository.reserve(input);
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    expect(reserved.grant).toMatchObject({
      status: "pending",
      address: owner.address,
      bnbAmount: "0.02",
      usd1AmountRaw: (500n * 10n ** 18n).toString(),
      grantedAt: NOW.toISOString(),
      completedAt: null,
    });
    await repository.recordTransactionHash({
      grantId: input.grantId,
      leg: "bnb",
      transactionHash: bnbHash,
    });
    expect(await repository.findReplay(input)).toMatchObject({
      kind: "grant",
      grant: { status: "pending", bnbTransactionHash: bnbHash },
    });
    const done = await repository.finalize({
      grantId: input.grantId,
      status: "granted",
      bnbTransactionHash: bnbHash,
      usd1TransactionHash: usd1Hash,
      failureReasonCode: null,
      now: new Date(NOW.getTime() + 4_000),
    });
    expect(done).toMatchObject({
      status: "granted",
      usd1TransactionHash: usd1Hash,
      completedAt: "2026-10-12T08:00:04.000Z",
    });
    // Final rows are immutable through finalize.
    await expect(
      repository.finalize({
        grantId: input.grantId,
        status: "failed",
        bnbTransactionHash: null,
        usd1TransactionHash: null,
        failureReasonCode: "TESTNET_FAUCET_TRANSFER_FAILED",
        now: NOW,
      }),
    ).rejects.toThrow();
    expect(await repository.reserve(input)).toMatchObject({
      kind: "replay",
      grant: { grantId: input.grantId, status: "granted" },
    });
    expect(await repository.latestSentGrant(owner.address)).toMatchObject({
      grantId: input.grantId,
    });
  });

  it("refuses the same key with another digest or owner", async () => {
    const owner = await userWithWallet();
    const other = await userWithWallet();
    const input = reserveInput(owner);
    await repository.reserve(input);
    await expect(
      repository.reserve({
        ...input,
        requestSha256: sha(2),
        grantId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(TestnetFaucetIdempotencyConflictError);
    expect(
      await repository.findReplay({
        ownerUserId: other.userId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
      }),
    ).toEqual({ kind: "conflict" });
  });

  it("holds the cooldown per address, a failed grant only for the failed cooldown, and keeps no idempotency row for a refusal", async () => {
    const owner = await userWithWallet();
    const first = reserveInput(owner);
    await repository.reserve(first);
    await repository.finalize({
      grantId: first.grantId,
      status: "failed",
      bnbTransactionHash: null,
      usd1TransactionHash: null,
      failureReasonCode: "TESTNET_FAUCET_TRANSFER_FAILED",
      now: NOW,
    });
    const policy = reserveInput(owner).policy;
    // S169: a failed attempt holds the address for 300 s.
    expect(
      await repository.nextAvailableAt({
        address: owner.address,
        ownerUserId: owner.userId,
        now: new Date(NOW.getTime() + 1_000),
        policy,
      }),
    ).toBe("2026-10-12T08:05:00.000Z");
    expect(
      await repository.reserve(
        reserveInput(owner, { now: new Date(NOW.getTime() + 1_000) }),
      ),
    ).toEqual({
      kind: "cooldown",
      nextAvailableAt: "2026-10-12T08:05:00.000Z",
    });
    expect(
      await repository.nextAvailableAt({
        address: owner.address,
        ownerUserId: owner.userId,
        now: new Date(NOW.getTime() + 300_000),
        policy,
      }),
    ).toBeNull();
    const secondAt = NOW.getTime() + 300_000;
    const second = reserveInput(owner, { now: new Date(secondAt) });
    expect((await repository.reserve(second)).kind).toBe("reserved");
    const third = reserveInput(owner, {
      now: new Date(secondAt + 3_600_000),
    });
    const refused = await repository.reserve(third);
    expect(refused).toEqual({
      kind: "cooldown",
      nextAvailableAt: new Date(secondAt + 86_400_000).toISOString(),
    });
    const kept = await pool.query(
      "select 1 from public.idempotency_records where idempotency_key = $1",
      [third.idempotencyKey],
    );
    expect(kept.rowCount).toBe(0);
    const later = reserveInput(owner, {
      now: new Date(secondAt + 86_400_000 + 1),
    });
    expect((await repository.reserve(later)).kind).toBe("reserved");
  });

  it("lets exactly one of many concurrent reservations of one address through", async () => {
    const owner = await userWithWallet();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repository.reserve(reserveInput(owner))),
    );
    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.kind === "cooldown")).toHaveLength(
      5,
    );
    const rows = await pool.query(
      "select count(*)::int as n from public.testnet_faucet_grants where address = $1",
      [owner.address],
    );
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it("enforces the row shape in the database", async () => {
    const owner = await userWithWallet();
    const input = reserveInput(owner);
    await repository.reserve(input);
    await expect(
      pool.query(
        `update public.testnet_faucet_grants set status = 'granted', completed_at = granted_at
         where grant_id = $1`,
        [input.grantId],
      ),
    ).rejects.toThrow(/testnet_faucet_grants_granted_shape/);
    await expect(
      pool.query(
        `update public.testnet_faucet_grants set address = 'not-an-address' where grant_id = $1`,
        [input.grantId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `insert into public.idempotency_records (owner_user_id, scope, idempotency_key,
           key_source, request_sha256, digest_version)
         values ($1, 'testnet_faucet_grant', $2, 'client', $3, 'testnet_faucet_grant_v9')`,
        [owner.userId, randomUUID(), sha(3)],
      ),
    ).rejects.toThrow(/digest_version/);
  });

  it("runs the service end to end on the real tables", async () => {
    const owner = await userWithWallet();
    let clock = NOW;
    const chain = defaultFaucetChainState({ mint: "reverted" });
    const service = createTestnetFaucetService({
      config: parseTestnetFaucet({
        TESTNET_FAUCET_ENABLED: true,
        TESTNET_FAUCET_BNB_AMOUNT: "0.02",
        TESTNET_FAUCET_USD1_AMOUNT: "500",
        TESTNET_FAUCET_COOLDOWN_SECONDS: 86_400,
        TESTNET_FAUCET_OPERATOR_PRIVATE_KEY: "ab".repeat(32),
        LAUNCH_USD1_ADDRESS: legacyLaunchUsd1,
        HOOKS_LAUNCH_FACTORY_ADDRESS: hooksFactory,
      }),
      launchChainId: "eip155:97",
      rpcConfigured: true,
      repository,
      wallets: createPostgresAccountWalletRepository(pool),
      chain: createFakeFaucetChain(chain),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => clock,
    });
    const principal = { userId: owner.userId } as AuthenticatedLoopPrincipal;
    const key = randomUUID();
    const partial = await service
      .grant({
        principal,
        body: { walletId: owner.walletId },
        idempotencyKey: key,
      })
      .catch((error: unknown) => error);
    expect(partial).toBeInstanceOf(V2ApiError);
    expect(partial).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: {
        reasonCode: "TESTNET_FAUCET_PARTIAL",
        bnbTransactionHash: bnbHash,
      },
    });
    const stored = await pool.query<{
      status: string;
      bnb_tx: string;
      usd1_tx: string;
      usd1_token_address: string;
    }>(
      "select status, bnb_tx, usd1_tx, usd1_token_address from public.testnet_faucet_grants where wallet_id = $1",
      [owner.walletId],
    );
    // S156b: the row records the MEME v2 USD1 that was actually minted.
    expect(stored.rows).toEqual([
      {
        status: "partial",
        bnb_tx: bnbHash,
        usd1_tx: usd1Hash,
        usd1_token_address: faucetUsd1,
      },
    ]);
    const comment = await pool.query<{ comment: string | null }>(
      `select col_description('public.testnet_faucet_grants'::regclass,
         (select attnum from pg_attribute
          where attrelid = 'public.testnet_faucet_grants'::regclass
            and attname = 'usd1_token_address')::int) as comment`,
    );
    expect(comment.rows[0]?.comment).toMatch(/actually called mint/);
    expect(
      await service.status({ principal, query: { walletId: owner.walletId } }),
    ).toMatchObject({
      available: false,
      nextAvailableAt: "2026-10-13T08:00:00.000Z",
      lastGrant: { bnbTransactionHash: bnbHash, usd1TransactionHash: usd1Hash },
    });
    clock = new Date(NOW.getTime() + 86_400_000);
    chain.mint = "confirmed";
    expect(
      await service.grant({
        principal,
        body: { walletId: owner.walletId },
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({
      bnb: { amount: "0.02", transactionHash: bnbHash },
      usd1: { amount: "500", transactionHash: usd1Hash },
      grantedAt: "2026-10-13T08:00:00.000Z",
    });
  });

  it("S169: counts an owner's attempted failures per UTC day, never the sweep's PENDING_EXPIRED", async () => {
    const owner = await userWithWallet();
    const policy = reserveInput(owner).policy;
    // Four attempted failures and one expired pending on 2026-10-12.
    const day = Date.parse("2026-10-12T01:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      const input = reserveInput(owner, {
        now: new Date(day + index * 600_000),
      });
      expect((await repository.reserve(input)).kind).toBe("reserved");
      if (index === 4) {
        expect(
          await repository.resolveStalePending({
            grantId: input.grantId,
            status: "failed",
            failureReasonCode: "TESTNET_FAUCET_PENDING_EXPIRED",
            now: new Date(day + index * 600_000 + 1_000),
          }),
        ).toBe(true);
      } else {
        await repository.finalize({
          grantId: input.grantId,
          status: "failed",
          bnbTransactionHash: null,
          usd1TransactionHash: null,
          failureReasonCode: "TESTNET_FAUCET_TRANSFER_FAILED",
          now: new Date(day + index * 600_000 + 1_000),
        });
      }
    }
    const later = new Date(day + 3_600_000);
    expect(
      await repository.nextAvailableAt({
        address: owner.address,
        ownerUserId: owner.userId,
        now: later,
        policy,
      }),
    ).toBeNull();
    const fifth = reserveInput(owner, { now: later });
    expect((await repository.reserve(fifth)).kind).toBe("reserved");
    await repository.finalize({
      grantId: fifth.grantId,
      status: "failed",
      bnbTransactionHash: null,
      usd1TransactionHash: null,
      failureReasonCode: "TESTNET_FAUCET_TRANSFER_FAILED",
      now: later,
    });
    const blockedAt = new Date(later.getTime() + 600_000);
    expect(
      await repository.reserve(reserveInput(owner, { now: blockedAt })),
    ).toEqual({
      kind: "cooldown",
      nextAvailableAt: "2026-10-13T00:00:00.000Z",
    });
    expect(
      await repository.nextAvailableAt({
        address: owner.address,
        ownerUserId: owner.userId,
        now: new Date("2026-10-13T00:00:00.000Z"),
        policy,
      }),
    ).toBeNull();
  });

  it("S169: sums the UTC day's granted / partial / unknown grants for the daily caps", async () => {
    const dayStart = new Date("2030-01-02T00:00:00.000Z");
    expect(await repository.dailyTotals(dayStart)).toEqual({
      grants: 0,
      bnbRaw: "0",
    });
    const statuses = ["granted", "partial", "unknown", "failed"] as const;
    for (const [index, status] of statuses.entries()) {
      const owner = await userWithWallet();
      const input = reserveInput(owner, {
        now: new Date(dayStart.getTime() + index * 60_000),
      });
      await repository.reserve(input);
      await repository.finalize({
        grantId: input.grantId,
        status,
        bnbTransactionHash: status === "failed" ? null : bnbHash,
        usd1TransactionHash: status === "granted" ? usd1Hash : null,
        failureReasonCode:
          status === "granted" ? null : "TESTNET_FAUCET_TRANSFER_FAILED",
        now: new Date(dayStart.getTime() + index * 60_000 + 1_000),
      });
    }
    // A pending grant and one of the previous day are not counted.
    const pendingOwner = await userWithWallet();
    await repository.reserve(
      reserveInput(pendingOwner, {
        now: new Date(dayStart.getTime() + 600_000),
      }),
    );
    const yesterdayOwner = await userWithWallet();
    const yesterday = reserveInput(yesterdayOwner, {
      now: new Date(dayStart.getTime() - 1_000),
    });
    await repository.reserve(yesterday);
    await repository.finalize({
      grantId: yesterday.grantId,
      status: "granted",
      bnbTransactionHash: bnbHash,
      usd1TransactionHash: usd1Hash,
      failureReasonCode: null,
      now: dayStart,
    });
    expect(await repository.dailyTotals(dayStart)).toEqual({
      grants: 3,
      bnbRaw: "60000000000000000",
    });
  });

  it("S169: the pending sweep closes stale grants from the chain and leaves fresh ones", async () => {
    const sweepNow = new Date("2031-05-05T12:00:00.000Z");
    const stale = async (hash: string | null) => {
      const owner = await userWithWallet();
      const input = reserveInput(owner, {
        now: new Date(sweepNow.getTime() - 3_600_000),
      });
      await repository.reserve(input);
      if (hash !== null) {
        await repository.recordTransactionHash({
          grantId: input.grantId,
          leg: "bnb",
          transactionHash: hash,
        });
      }
      return input.grantId;
    };
    const landed = await stale(bnbHash);
    const dropped = await stale(usd1Hash);
    const unsigned = await stale(null);
    const flaky = await stale(`0x${"d4".repeat(32)}`);
    const freshOwner = await userWithWallet();
    const fresh = reserveInput(freshOwner, {
      now: new Date(sweepNow.getTime() - 60_000),
    });
    await repository.reserve(fresh);
    const sweep = createTestnetFaucetPendingSweep({
      repository,
      lookup: {
        lookup: (hash) =>
          hash === bnbHash
            ? Promise.resolve("found")
            : hash === usd1Hash
              ? Promise.resolve("not_found")
              : Promise.reject(new Error("rpc down")),
      },
      pendingTimeoutSeconds: 900,
      now: () => sweepNow,
    });
    const result = await sweep.runOnce();
    // Earlier tests in this database leave stale pending rows too; the
    // rows of this test are asserted one by one below.
    expect(result.unknown).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(2);
    expect(result.skipped).toBe(1);
    const rows = await pool.query<{
      grant_id: string;
      status: string;
      failure_reason_code: string | null;
    }>(
      `select grant_id, status, failure_reason_code from public.testnet_faucet_grants
       where grant_id = any($1::uuid[])`,
      [[landed, dropped, unsigned, flaky, fresh.grantId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.grant_id, row]));
    expect(byId.get(landed)).toMatchObject({
      status: "unknown",
      failure_reason_code: "TESTNET_FAUCET_SUBMISSION_UNKNOWN",
    });
    expect(byId.get(dropped)).toMatchObject({
      status: "failed",
      failure_reason_code: "TESTNET_FAUCET_PENDING_EXPIRED",
    });
    expect(byId.get(unsigned)).toMatchObject({
      status: "failed",
      failure_reason_code: "TESTNET_FAUCET_PENDING_EXPIRED",
    });
    expect(byId.get(flaky)?.status).toBe("pending");
    expect(byId.get(fresh.grantId)?.status).toBe("pending");
    // A grant finished meanwhile is not overwritten.
    expect(
      await repository.resolveStalePending({
        grantId: landed,
        status: "failed",
        failureReasonCode: "TESTNET_FAUCET_PENDING_EXPIRED",
        now: sweepNow,
      }),
    ).toBe(false);
  });
});
