import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000049_v2_meme_launchpad.js";
import {
  MEME_GRADUATION_MAXIMUM_ATTEMPTS,
  createMemeGraduationExecutor,
  createMemeIndexerWorker,
  createMemeIntentReconciler,
  createMemeSaltPoolWorker,
} from "../src/bsc-meme-indexer-worker.js";
import {
  loadReconciliationWorkerConfig,
  parseMemeGraduationExecutor,
} from "../src/config.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";
import type {
  CommitMemeSegmentInput,
  MemeIntentRecord,
  MemeRepository,
} from "../src/features/meme/meme-repository.js";
import type { BscChainCallClient } from "../src/integrations/bsc/rpc-client.js";
import { createMemeGraduationSender } from "../src/integrations/meme/meme-graduation-sender.js";
import {
  fixtureBlockHash,
  fixtureTxHash,
  memeLog,
} from "./helpers/meme-fixtures.js";
import {
  createFakeMemeAdapter,
  createFakeMemeSlotClient,
  defaultMemeFunds,
  memeImplementation,
} from "./helpers/meme-service-fakes.js";
import { memeCurveAddress } from "./helpers/meme-fixtures.js";

/** Decision 0101: the MEME worker lanes and migration 000049. */

const chainId = "eip155:97" as const;
const token = "0x1111111111111111111111111111111111111111";

function laneRepository(
  overrides: Partial<MemeRepository> = {},
): MemeRepository & { commits: CommitMemeSegmentInput[] } {
  const commits: CommitMemeSegmentInput[] = [];
  const reject = () => Promise.reject(new Error("not used"));
  return {
    commits,
    getCheckpoint: vi.fn(() => Promise.resolve(null)),
    commitSegment: vi.fn((input: CommitMemeSegmentInput) => {
      commits.push(input);
      return Promise.resolve({
        storedCount: input.events.length,
        skippedCount: 1,
        metadataMismatchCount: 0,
        creatorMismatchCount: 0,
        touchedTokenIds: [],
      });
    }),
    getToken: reject,
    listTokens: reject,
    rankHotTokens: reject,
    listTokensByIds: reject,
    tokenStats: reject,
    listTrades: reject,
    listCandles: reject,
    listHolders: reject,
    createDraft: reject,
    replaceDraftSalt: reject,
    touchDraftSalt: reject,
    createIntent: reject,
    getIntent: reject,
    reportIntentBroadcast: reject,
    sumRecentExposureUsd: reject,
    leaseReconcilableIntents: vi.fn(() => Promise.resolve([])),
    markIntentPayloadVerified: vi.fn(() => Promise.resolve()),
    settleIntent: vi.fn(() => Promise.resolve(null)),
    countFreeSalts: vi.fn(() => Promise.resolve(0)),
    insertSalts: vi.fn((input: { salts: readonly unknown[] }) =>
      Promise.resolve(input.salts.length),
    ),
    releaseStaleSaltReservations: vi.fn(() => Promise.resolve(2)),
    listGraduationCandidates: vi.fn(() => Promise.resolve([])),
    recordGraduationAttempt: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function laneClient(
  headBlock: bigint,
  hashes: Map<bigint, string> = new Map(),
) {
  const client = createFakeMemeSlotClient(defaultMemeFunds());
  return {
    ...client,
    getHead: () =>
      Promise.resolve({
        blockNumber: headBlock,
        blockHash: fixtureBlockHash(headBlock),
        observedAt: "2026-10-08T00:00:00.000Z",
      }),
    getBlockHash: (block: bigint) =>
      Promise.resolve(hashes.get(block) ?? fixtureBlockHash(block)),
  } satisfies BscChainCallClient;
}

describe("meme_event lane (Decision 0101)", () => {
  it("seeds at the start block, decodes the segment, and checkpoints its last block", async () => {
    const repository = laneRepository();
    const adapter = {
      ...createFakeMemeAdapter({ curves: new Map(), unavailable: false }),
      readLogs: vi.fn(() =>
        Promise.resolve([
          memeLog({
            name: "Trade",
            args: {
              token,
              wallet: token,
              isBuy: true,
              usd1Amount: 10n,
              tokenAmount: 20n,
              feeUsd1: 1n,
              vUsd1After: 6_000n * 10n ** 18n,
              vTokenAfter: 1_073_000_000n * 10n ** 18n,
              soldAfter: 0n,
              at: 1_791_590_400n,
            },
            blockNumber: 150n,
            logIndex: 2,
            transactionHash: fixtureTxHash(9),
          }),
        ]),
      ),
    };
    const worker = createMemeIndexerWorker({
      repository,
      readClient: laneClient(300n),
      adapter,
      chainId,
      createUuid: () => "6d12a86e-4134-47e6-9312-c5ef75a30f55",
    });
    const outcome = await worker.runOnce();
    expect(outcome).toMatchObject({
      kind: "seeded",
      fromBlockNumber: "100",
      toBlockNumber: "300",
      eventCount: 1,
    });
    expect(adapter.readLogs).toHaveBeenCalledWith({
      fromBlock: 100n,
      toBlock: 300n,
    });
    const commit = repository.commits[0];
    expect(commit?.checkpoint).toEqual({
      lastBlockNumber: "300",
      lastBlockHash: fixtureBlockHash(300n),
      startedFromBlockNumber: "100",
    });
    expect(commit?.events[0]).toMatchObject({
      kind: "trade",
      tokenAddress: token,
      usd1Amount: "10",
      at: "1791590400",
      priceAfterE18: "5591798695246",
    });
  });

  it("rewinds by the reorg depth when the checkpoint hash changed", async () => {
    const repository = laneRepository({
      getCheckpoint: vi.fn(() =>
        Promise.resolve({
          lastBlockNumber: "500",
          lastBlockHash: fixtureBlockHash(500n),
          startedFromBlockNumber: "100",
          updatedAt: "2026-10-08T00:00:00.000Z",
        }),
      ),
    });
    const adapter = {
      ...createFakeMemeAdapter({ curves: new Map(), unavailable: false }),
      readLogs: vi.fn(() => Promise.resolve([])),
    };
    const worker = createMemeIndexerWorker({
      repository,
      readClient: laneClient(520n, new Map([[500n, `0x${"ee".repeat(32)}`]])),
      adapter,
      chainId,
    });
    const outcome = await worker.runOnce();
    expect(outcome.kind).toBe("reorged");
    expect(repository.commits[0]?.rewindFromBlockNumber).toBe("485");
    expect(adapter.readLogs).toHaveBeenCalledWith({
      fromBlock: 485n,
      toBlock: 520n,
    });
  });

  it("idles without a contract and stays unavailable with the adapter's reason", async () => {
    const idle = createMemeIndexerWorker({
      repository: laneRepository(),
      readClient: laneClient(10n),
      adapter: createFakeMemeAdapter(
        { curves: new Map(), unavailable: false },
        null,
      ),
      chainId,
    });
    expect(await idle.runOnce()).toMatchObject({
      kind: "idle",
      reasonCode: "MEME_CONTRACT_NOT_CONFIGURED",
    });
  });
});

describe("MEME salt pool, receipt reconcile, and graduation executor (Decision 0101)", () => {
  it("frees lapsed reservations and mines until the target", async () => {
    let free = 0;
    const repository = laneRepository({
      countFreeSalts: vi.fn(() => Promise.resolve(free)),
      insertSalts: vi.fn((input: { salts: readonly unknown[] }) => {
        free += input.salts.length;
        return Promise.resolve(input.salts.length);
      }),
    });
    const refilled = vi.fn();
    const lane = createMemeSaltPoolWorker({
      repository,
      scope: {
        chainId,
        contractAddress: memeCurveAddress,
        tokenImplementation: memeImplementation,
        suffix: "6",
      },
      target: 4,
      attemptsPerSlice: 200,
      onRefilled: refilled,
    });
    const outcome = await lane.runOnce();
    expect(outcome).toEqual({ released: 2, inserted: 4, free: 4 });
    expect(refilled).toHaveBeenCalledWith({
      released: 2,
      inserted: 4,
      free: 4,
    });
  });

  function reported(
    overrides: Partial<MemeIntentRecord> = {},
  ): MemeIntentRecord {
    return {
      intentId: "aaaaaaaa-1111-4111-8111-111111111111",
      ownerUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
      walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
      walletAddress: "0x000000000000000000000000000000000000000a",
      memeTokenId: "bbbbbbbb-1111-4111-8111-111111111111",
      kind: "buy",
      chainId,
      contractAddress: memeCurveAddress,
      tokenAddress: token,
      usd1AmountRaw: "1",
      tokenAmountRaw: "0",
      expectedOutRaw: "1",
      minOutRaw: "1",
      feeRaw: "0",
      refundRaw: "0",
      deadline: "2026-10-08T00:05:00.000Z",
      snapshotBlockNumber: "1",
      snapshotBlockHash: fixtureBlockHash(1n),
      calldata: {},
      unsignedTransaction: {
        chainId: 97,
        from: "0x000000000000000000000000000000000000000a",
        to: memeCurveAddress,
        data: "0x1234",
      },
      approval: null,
      policy: {},
      payloadDigest: "a".repeat(64),
      state: "broadcast_reported",
      reasonCode: null,
      transactionHash: fixtureTxHash(7),
      payloadVerified: true,
      receipt: null,
      expiresAt: "2026-10-08T00:05:00.000Z",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      ...overrides,
    };
  }

  it("settles reported Intents from receipts at the confirmation depth", async () => {
    const settle = vi.fn(() => Promise.resolve(reported()));
    const repository = laneRepository({
      leaseReconcilableIntents: vi.fn(() =>
        Promise.resolve([
          reported(),
          reported({
            intentId: "cccccccc-1111-4111-8111-111111111111",
            transactionHash: fixtureTxHash(8),
          }),
        ]),
      ),
      settleIntent: settle,
    });
    const client = {
      ...laneClient(110n),
      getTransactionReceipt: (hash: string) =>
        Promise.resolve({
          hash,
          status:
            hash === fixtureTxHash(7)
              ? ("success" as const)
              : ("reverted" as const),
          blockNumber: 100n,
          blockHash: fixtureBlockHash(100n),
          gasUsed: 1n,
          effectiveGasPrice: 1n,
        }),
    } satisfies BscChainCallClient;
    const lane = createMemeIntentReconciler({
      repository,
      readClient: client,
      chainId,
      now: () => new Date("2026-10-08T00:01:00.000Z"),
    });
    expect(await lane.runOnce()).toEqual({ leased: 2, transitions: 2 });
    expect(settle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toState: "confirmed", reasonCode: null }),
    );
    expect(settle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toState: "failed",
        reasonCode: "MEME_TX_REVERTED",
      }),
    );
  });

  it("expires a report never observed after the deadline plus grace", async () => {
    const settle = vi.fn(() => Promise.resolve(reported()));
    const lane = createMemeIntentReconciler({
      repository: laneRepository({
        leaseReconcilableIntents: vi.fn(() =>
          Promise.resolve([reported({ payloadVerified: false })]),
        ),
        settleIntent: settle,
      }),
      readClient: laneClient(110n),
      chainId,
      now: () => new Date("2026-10-08T01:00:00.000Z"),
    });
    await lane.runOnce();
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        toState: "expired",
        reasonCode: "MEME_TX_NOT_OBSERVED",
      }),
    );
  });

  it("graduates full tokens after the default 15 s and hands over to an operator after 10 failures", async () => {
    const record = vi.fn(() => Promise.resolve());
    const graduate = vi
      .fn()
      .mockResolvedValueOnce({
        status: "confirmed",
        transactionHash: fixtureTxHash(3),
      })
      .mockResolvedValueOnce({
        status: "failed",
        errorCode: "MEME_GRADUATE_X",
      });
    const listGraduationCandidates = vi.fn(() =>
      Promise.resolve([
        {
          memeTokenId: "aaaaaaaa-1111-4111-8111-111111111111",
          tokenAddress: token,
          fullAt: "2026-10-08T00:00:00.000Z",
          graduationAttempts: 0,
        },
        {
          memeTokenId: "bbbbbbbb-1111-4111-8111-111111111111",
          tokenAddress: token,
          fullAt: "2026-10-08T00:00:00.000Z",
          graduationAttempts: MEME_GRADUATION_MAXIMUM_ATTEMPTS - 1,
        },
      ]),
    );
    const events = vi.fn();
    const lane = createMemeGraduationExecutor({
      repository: laneRepository({
        listGraduationCandidates,
        recordGraduationAttempt: record,
      }),
      sender: { address: token, graduate },
      chainId,
      now: () => new Date("2026-10-08T00:02:00.000Z"),
      onAttempt: events,
    });
    expect(await lane.runOnce()).toEqual({ candidates: 2, attempted: 2 });
    expect(listGraduationCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ fullBefore: "2026-10-08T00:01:45.000Z" }),
    );
    expect(record).toHaveBeenNthCalledWith(1, {
      memeTokenId: "aaaaaaaa-1111-4111-8111-111111111111",
      errorCode: null,
      nextAttemptAt: "2026-10-08T00:07:00.000Z",
      needsOperator: false,
    });
    expect(record).toHaveBeenNthCalledWith(2, {
      memeTokenId: "bbbbbbbb-1111-4111-8111-111111111111",
      errorCode: "MEME_GRADUATE_X",
      nextAttemptAt: null,
      needsOperator: true,
    });
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "confirmed",
        transactionHash: fixtureTxHash(3),
      }),
    );
  });

  it("waits MEME_GRADUATION_DELAY_SECONDS before graduating (Decision 0103)", async () => {
    const listGraduationCandidates = vi.fn(() => Promise.resolve([]));
    const lane = createMemeGraduationExecutor({
      repository: laneRepository({ listGraduationCandidates }),
      sender: { address: token, graduate: vi.fn() },
      chainId,
      fullGraceMs: 0,
      now: () => new Date("2026-10-08T00:02:00.000Z"),
    });
    expect(await lane.runOnce()).toEqual({ candidates: 0, attempted: 0 });
    expect(listGraduationCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ fullBefore: "2026-10-08T00:02:00.000Z" }),
    );
  });

  it("parses MEME_GRADUATION_DELAY_SECONDS within 0-600, default 15", () => {
    const base = {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgres://loop_api:pw@127.0.0.1:5432/loop_api_test",
      MEME_GRADUATION_EXECUTOR_ENABLED: "true",
      LAUNCH_DEPLOYER_PRIVATE_KEY: "11".repeat(32),
    };
    expect(
      loadReconciliationWorkerConfig(base).memeGraduationExecutor?.delaySeconds,
    ).toBe(15);
    expect(
      loadReconciliationWorkerConfig({
        ...base,
        MEME_GRADUATION_DELAY_SECONDS: "600",
      }).memeGraduationExecutor?.delaySeconds,
    ).toBe(600);
    expect(() =>
      loadReconciliationWorkerConfig({
        ...base,
        MEME_GRADUATION_DELAY_SECONDS: "601",
      }),
    ).toThrow(/MEME_GRADUATION_DELAY_SECONDS/);
    expect(() =>
      loadReconciliationWorkerConfig({
        ...base,
        MEME_GRADUATION_DELAY_SECONDS: "-1",
      }),
    ).toThrow(/MEME_GRADUATION_DELAY_SECONDS/);
  });

  it("refuses to sign graduation on mainnet and requires a key when enabled", () => {
    expect(() =>
      createMemeGraduationSender({
        privateKey: `0x${"11".repeat(32)}`,
        curveAddress: memeCurveAddress,
        chainReference: 56,
        rpcUrls: ["https://rpc.invalid/"],
      }),
    ).toThrow(/cannot be created/);
    expect(
      parseMemeGraduationExecutor({ MEME_GRADUATION_EXECUTOR_ENABLED: false }),
    ).toBeNull();
    expect(() =>
      parseMemeGraduationExecutor({ MEME_GRADUATION_EXECUTOR_ENABLED: true }),
    ).toThrow(/LAUNCH_DEPLOYER_PRIVATE_KEY/);
    expect(
      parseMemeGraduationExecutor({
        MEME_GRADUATION_EXECUTOR_ENABLED: true,
        LAUNCH_DEPLOYER_PRIVATE_KEY: "11".repeat(32),
      }),
    ).toEqual({ privateKey: `0x${"11".repeat(32)}`, delaySeconds: 15 });
    expect(
      parseMemeGraduationExecutor({
        MEME_GRADUATION_EXECUTOR_ENABLED: true,
        MEME_GRADUATION_DELAY_SECONDS: 0,
        LAUNCH_DEPLOYER_PRIVATE_KEY: "11".repeat(32),
      }),
    ).toEqual({ privateKey: `0x${"11".repeat(32)}`, delaySeconds: 0 });
    const sender = createMemeGraduationSender({
      privateKey: `0x${"11".repeat(32)}`,
      curveAddress: memeCurveAddress,
      chainReference: 97,
      rpcUrls: ["https://rpc.invalid/"],
    });
    expect(sender.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(JSON.stringify(sender)).not.toContain("11".repeat(32));
  });
});

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000049 MEME launchpad migration contract (Decision 0101)", () => {
  it("creates the five tables, the lane, and the digest versions", () => {
    const statement = captureSql(up);
    for (const table of [
      "meme_tokens",
      "meme_indexed_events",
      "meme_trades",
      "meme_holders",
      "meme_salts",
      "meme_intents",
    ]) {
      expect(statement).toContain(`create table public.${table}`);
    }
    expect(statement).toContain(
      "check (lane in ('erc20_transfer', 'pool_event', 'launch_event', 'meme_event'))",
    );
    expect(statement).toContain("'meme_token_create_v1', 'meme_intent_v1'");
    expect(statement).toContain(
      "check (status in ('draft', 'pending_chain', 'trading', 'full', 'graduated', 'paused'))",
    );
    expect(statement).toContain("numeric(78, 0)");
    expect(statement).toContain(
      "on public.meme_tokens (chain_id, token_address)",
    );
  });

  it("refuses to roll back over recorded facts and restores the previous checks", () => {
    const statement = captureSql(down);
    expect(statement).toContain("refusing to roll back 000049");
    expect(statement).toContain(
      "check (lane in ('erc20_transfer', 'pool_event', 'launch_event'))",
    );
    expect(statement).not.toContain("'meme_intent_v1'\n");
    expect(statement).toContain("drop table public.meme_tokens");
  });

  it("is applied before the head and its tables are required relations", () => {
    expect(Number(latestMigrationName.slice(0, 6)) >= 49).toBe(true);
    expect(requiredDatabaseRelations).toContain("public.meme_intents");
  });
});
