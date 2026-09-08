import { describe, expect, it, vi } from "vitest";

import {
  createBscPoolIndexerWorker,
  toIndexedPoolEvent,
} from "../src/bsc-pool-indexer-worker.js";
import type {
  BscIndexerRepository,
  CommitPoolEventSegmentInput,
  IndexedPoolEventRecord,
  IndexerCheckpointRecord,
} from "../src/database/bsc-indexer-repository.js";
import type {
  ChainRegistryRepository,
  PoolRecord,
} from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import {
  BscReadUnavailableError,
  type BscPoolEventLog,
  type BscReadClient,
  type BscTransferLogQuery,
} from "../src/integrations/bsc/rpc-client.js";

const poolAddress = "0x36696169c63e42cd08ce11f5deebbcebae652050";
const poolId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const wbnbAssetId = "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdtAssetId = "eip155:56:0x55d398326f99059ff775485246999027b3197955";

const pool: PoolRecord = Object.freeze({
  poolId,
  chainId: bscChainId,
  protocol: "pancakeswap_v3",
  address: poolAddress,
  token0AssetId: usdtAssetId,
  token1AssetId: wbnbAssetId,
  fee: 500,
  tickSpacing: 10,
  status: "registered",
});

function blockHash(blockNumber: bigint, fork = "a"): string {
  return `0x${fork.repeat(2)}${blockNumber.toString(16).padStart(62, "0")}`;
}

function registryFake(
  pools: readonly PoolRecord[] = [pool],
): ChainRegistryRepository {
  return {
    getChain: vi.fn(() => Promise.resolve(null)),
    getAsset: vi.fn(() => Promise.resolve(null)),
    listAssets: vi.fn(() => Promise.resolve([])),
    listReadableAssets: vi.fn(() => Promise.resolve([])),
    upsertAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listPools: vi.fn(() => Promise.resolve(pools)),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

function repositoryFake() {
  const rows = new Map<string, IndexedPoolEventRecord>();
  let checkpoint: IndexerCheckpointRecord | null = null;
  const commits: CommitPoolEventSegmentInput[] = [];
  const transferCommits: unknown[] = [];
  const repository: BscIndexerRepository = {
    getCheckpoint: (lane) =>
      Promise.resolve(lane === "pool_event" ? checkpoint : null),
    commitTransferSegment: (input) => {
      transferCommits.push(input);
      return Promise.reject(
        new Error("the pool lane must never touch the transfer lane"),
      );
    },
    listWalletTransfers: () => Promise.resolve({ items: [], hasMore: false }),
    sumPendingIncoming: () => Promise.resolve([]),
    listLatestApprovals: () => Promise.resolve([]),
    hasOutgoingTransferTo: () => Promise.resolve(false),
    commitPoolEventSegment: (input) => {
      commits.push(input);
      const rewind = input.rewindFromBlockNumber;
      if (rewind !== undefined) {
        for (const [key, row] of rows) {
          if (BigInt(row.blockNumber) >= BigInt(rewind)) {
            rows.set(key, { ...row, removed: true });
          }
        }
      }
      for (const event of input.events) {
        rows.set(`${event.transactionHash}:${String(event.logIndex)}`, {
          ...event,
          removed: false,
          observedAt: "2026-09-08T00:00:00.000Z",
        });
      }
      checkpoint = {
        lastBlockNumber: input.checkpoint.lastBlockNumber,
        lastBlockHash: input.checkpoint.lastBlockHash,
        startedFromBlockNumber: input.checkpoint.startedFromBlockNumber,
        reorgCount:
          (checkpoint?.reorgCount ?? 0) + (rewind === undefined ? 0 : 1),
        updatedAt: "2026-09-08T00:00:00.000Z",
      };
      return Promise.resolve(checkpoint);
    },
    listPoolSwaps: () =>
      Promise.resolve({ items: [...rows.values()], hasMore: false }),
    aggregateSwapCandles: () => Promise.resolve([]),
  };
  return {
    repository,
    rows,
    commits,
    transferCommits,
    current: () => checkpoint,
  };
}

function swapLog(
  blockNumber: bigint,
  logIndex: number,
  fork = "a",
): BscPoolEventLog {
  return {
    transactionHash: `0x${blockNumber.toString(16).padStart(63, "0")}${String(logIndex)}`,
    logIndex,
    blockNumber,
    blockHash: blockHash(blockNumber, fork),
    blockTimestamp: 1_788_000_000n + blockNumber,
    address: poolAddress,
    kind: "swap",
    args: {
      sender: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
      amount0: "-1000",
      amount1: "2000",
      sqrtPriceX96: "79228162514264337593543950336",
      liquidity: "5",
      tick: "-3",
      protocolFeesToken0: "0",
      protocolFeesToken1: "0",
    },
    removed: false,
  };
}

function readClientFake(options: {
  readonly head: bigint;
  readonly logsFor?: (query: BscTransferLogQuery) => readonly BscPoolEventLog[];
  readonly blockHashFor?: (blockNumber: bigint) => string | null;
  readonly headUnavailable?: boolean;
}): BscReadClient {
  return {
    chainId: "eip155:56",
    chainReference: 56,
    confirmations: 15,
    reorgDepthBlocks: 64,
    endpointRefs: ["rpc-000000000000"],
    verifyChain: () => Promise.resolve("verified"),
    currentVerification: () => "verified",
    getHead: () =>
      options.headUnavailable === true
        ? Promise.reject(new BscReadUnavailableError("BSC_RPC_UNREACHABLE"))
        : Promise.resolve({
            blockNumber: options.head,
            blockHash:
              options.blockHashFor?.(options.head) ?? blockHash(options.head),
            observedAt: "2026-09-08T00:00:00.000Z",
          }),
    getBlockHash: (blockNumber) =>
      Promise.resolve(
        options.blockHashFor?.(blockNumber) ?? blockHash(blockNumber),
      ),
    readTokenIdentity: () => Promise.reject(new Error("not used")),
    readPoolIdentity: () => Promise.reject(new Error("not used")),
    readBalances: () => Promise.reject(new Error("not used")),
    readTransferLogs: () =>
      Promise.reject(new Error("the pool lane must not read transfers")),
    readPoolEventLogs: (query) =>
      Promise.resolve(options.logsFor?.(query) ?? []),
    readApprovalLogs: () =>
      Promise.reject(new Error("the pool lane must not read approvals")),
    probeEndpoints: () => Promise.resolve([]),
  };
}

describe("BSC pool_event indexer lane", () => {
  it("maps a decoded Swap log onto typed candle columns", () => {
    const event = toIndexedPoolEvent(swapLog(100n, 3), poolId);
    expect(event).toMatchObject({
      poolId,
      eventKind: "swap",
      blockNumber: "100",
      blockTimestamp: new Date((1_788_000_000 + 100) * 1_000).toISOString(),
      amount0: "-1000",
      amount1: "2000",
      sqrtPriceX96: "79228162514264337593543950336",
    });
    expect(
      toIndexedPoolEvent(
        {
          ...swapLog(100n, 3),
          args: { amount0: "x", amount1: "1", sqrtPriceX96: "1" },
        },
        poolId,
      ),
    ).toBeNull();
  });

  it("stays idle without a registered pool", async () => {
    const storage = repositoryFake();
    const worker = createBscPoolIndexerWorker({
      repository: storage.repository,
      registry: registryFake([]),
      readClient: readClientFake({ head: 100n }),
      chainId: bscChainId,
      startBlockNumber: null,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "idle",
      reasonCode: "POOL_REGISTRY_EMPTY",
    });
    expect(storage.current()).toBeNull();
  });

  it("seeds, advances in 2000-block segments, and stores only registered pools' logs", async () => {
    const storage = repositoryFake();
    const ranges: BscTransferLogQuery[] = [];
    const worker = createBscPoolIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({
        head: 5_000n,
        logsFor: (query) => {
          ranges.push(query);
          return [
            swapLog(query.fromBlock, 0),
            {
              ...swapLog(query.fromBlock, 1),
              address: "0x00000000000000000000000000000000000000ee",
            },
          ];
        },
      }),
      chainId: bscChainId,
      startBlockNumber: 1_000,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "seeded",
      fromBlockNumber: "1000",
      toBlockNumber: "2999",
      eventCount: 1,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "advanced",
      fromBlockNumber: "3000",
      toBlockNumber: "4999",
    });
    expect(
      ranges.every((range) => range.toBlock - range.fromBlock + 1n <= 2_000n),
    ).toBe(true);
    expect(ranges[0]?.addresses).toEqual([poolAddress]);
    expect(storage.rows.size).toBe(2);
    expect(storage.transferCommits).toEqual([]);
  });

  it("rewinds its own rows on a reorg and never touches the transfer lane", async () => {
    const storage = repositoryFake();
    let fork = "a";
    const worker = createBscPoolIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({
        head: 1_200n,
        logsFor: (query) => [swapLog(query.fromBlock + 5n, 0, fork)],
        blockHashFor: (blockNumber) => blockHash(blockNumber, fork),
      }),
      chainId: bscChainId,
      startBlockNumber: 1_000,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ kind: "seeded" });
    fork = "b";
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "reorged",
      fromBlockNumber: "1136",
    });
    const rewind = storage.commits[1];
    expect(rewind?.rewindFromBlockNumber).toBe("1136");
    expect(storage.current()?.reorgCount).toBe(1);
    expect(storage.current()?.lastBlockHash).toBe(blockHash(1_200n, "b"));
    expect(storage.transferCommits).toEqual([]);
    const replayed = [...storage.rows.values()].find(
      (row) => row.blockNumber === "1141",
    );
    expect(replayed?.removed).toBe(false);
  });

  it("reports an unreachable chain without advancing", async () => {
    const storage = repositoryFake();
    const worker = createBscPoolIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({ head: 100n, headUnavailable: true }),
      chainId: bscChainId,
      startBlockNumber: null,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "unavailable",
      reasonCode: "BSC_RPC_UNREACHABLE",
    });
    expect(storage.current()).toBeNull();
  });
});
