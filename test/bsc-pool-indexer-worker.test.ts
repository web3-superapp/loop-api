import { custom, HttpRequestError, numberToHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import type {
  BscIndexerInfrastructureBackoff,
  BscIndexerLaneAvailabilityEvent,
} from "../src/bsc-indexer-worker.js";
import {
  BscReadUnavailableError,
  createBscReadClient,
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
    commitApprovalCoverageSegment: () =>
      Promise.reject(new Error("the pool lane never covers approvals")),
    earliestWalletActivityBlockNumber: () => Promise.resolve(null),
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
        approvalCoverageFromBlockNumber: null,
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

const keyedEndpointUrl =
  "https://user:secret@bsc-rpc.publicnode.com/v1/provider-key?token=xyz";

function requestBlocked(): HttpRequestError {
  return new HttpRequestError({
    body: { method: "eth_getLogs", params: [{ address: [poolAddress] }] },
    details: '{"code":-32602,"message":"Request blocked"}',
    status: 403,
    url: keyedEndpointUrl,
  });
}

const secondPoolAddress = "0x172fcd41e0913e95784454622d1c3724f546f849";
const secondPool: PoolRecord = Object.freeze({
  ...pool,
  poolId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  address: secondPoolAddress,
});

function rpcBlock(blockNumber: bigint): unknown {
  return {
    number: numberToHex(blockNumber),
    hash: blockHash(blockNumber),
    parentHash: blockHash(blockNumber - 1n),
    timestamp: numberToHex(1_760_000_000n + blockNumber),
    gasLimit: "0x1c9c380",
    gasUsed: "0x5208",
    baseFeePerGas: "0x3b9aca00",
    miner: "0x0000000000000000000000000000000000000001",
    extraData: "0x",
    size: "0x100",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    nonce: "0x0000000000000000",
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot: blockHash(0n, "b"),
    stateRoot: blockHash(0n, "c"),
    receiptsRoot: blockHash(0n, "d"),
    sha3Uncles: blockHash(0n, "e"),
    transactions: [],
    uncles: [],
  };
}

describe("BSC pool_event indexer lane — Provider refusals (Decision 0068)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries the error class, HTTP status, JSON-RPC code, host, and method into the backoff event", async () => {
    const storage = repositoryFake();
    const events: BscIndexerInfrastructureBackoff[] = [];
    const controller = new AbortController();
    const worker = createBscPoolIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: {
        ...readClientFake({ head: 100n }),
        readPoolEventLogs: () => Promise.reject(requestBlocked()),
      },
      chainId: bscChainId,
      startBlockNumber: 90,
      onInfrastructureBackoff: (event) => {
        events.push(event);
        controller.abort();
      },
    });

    await worker.run(controller.signal);

    expect(events).toEqual([
      {
        reasonCode: "bsc_indexer_unavailable",
        lane: "pool_event",
        consecutiveFailureCount: 1,
        retryDelayMs: 1_000,
        errorClass: "HttpRequestError",
        rpcStatus: 403,
        rpcCode: -32602,
        rpcUrlHost: "bsc-rpc.publicnode.com",
        method: "eth_getLogs",
      },
    ]);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("provider-key");
    expect(serialised).not.toContain(poolAddress);
    expect(storage.current()).toBeNull();
  });

  it("advances through a 403 on multi-address eth_getLogs by reading one pool at a time", async () => {
    const storage = repositoryFake();
    const accepted: string[][] = [];
    const readClient = createBscReadClient({
      config: {
        chainId: "eip155:56",
        chainReference: 56,
        rpcUrls: ["https://rpc-a.example/"],
        confirmations: 15,
        reorgDepthBlocks: 64,
      },
      transportFactory: () =>
        custom({
          request: (request: {
            readonly method: string;
            readonly params?: unknown;
          }): Promise<unknown> => {
            switch (request.method) {
              case "eth_chainId": {
                return Promise.resolve("0x38");
              }
              case "eth_getBlockByNumber": {
                const [tag] = request.params as readonly [string];
                return Promise.resolve(
                  rpcBlock(tag === "latest" ? 100n : BigInt(tag)),
                );
              }
              case "eth_getLogs": {
                const [filter] = request.params as readonly [
                  { readonly address: string | string[] },
                ];
                const addresses = Array.isArray(filter.address)
                  ? filter.address
                  : [filter.address];
                if (addresses.length > 1) {
                  return Promise.reject(
                    Object.assign(new Error("Request blocked"), {
                      code: -32602,
                    }),
                  );
                }
                accepted.push([...addresses]);
                return Promise.resolve([]);
              }
              default: {
                return Promise.reject(new Error(`unmocked ${request.method}`));
              }
            }
          },
        }),
    });
    const worker = createBscPoolIndexerWorker({
      repository: storage.repository,
      registry: registryFake([pool, secondPool]),
      readClient,
      chainId: bscChainId,
      startBlockNumber: 97,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "seeded",
      fromBlockNumber: "97",
      toBlockNumber: "100",
      eventCount: 0,
      reasonCode: null,
    });
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every((addresses) => addresses.length === 1)).toBe(true);
    expect(storage.current()).toMatchObject({ lastBlockNumber: "100" });
    expect(storage.transferCommits).toEqual([]);
  });

  it("idles as unavailable, commits nothing, and reports the transition once when every split is still refused", async () => {
    const storage = repositoryFake();
    const availability: BscIndexerLaneAvailabilityEvent[] = [];
    let refuse = true;
    const worker = createBscPoolIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: {
        ...readClientFake({ head: 100n }),
        readPoolEventLogs: () =>
          refuse
            ? Promise.reject(
                new BscReadUnavailableError("BSC_LOG_QUERY_REJECTED", {
                  cause: requestBlocked(),
                  rpcError: {
                    errorClass: "HttpRequestError",
                    rpcStatus: 403,
                    rpcCode: -32602,
                    rpcUrlHost: "bsc-rpc.publicnode.com",
                    method: "eth_getLogs",
                  },
                }),
              )
            : Promise.resolve([]),
      },
      chainId: bscChainId,
      startBlockNumber: 90,
      onInfrastructureBackoff: () => {
        throw new Error("a classified refusal must not reach the retry loop");
      },
      onLaneAvailability: (event) => {
        availability.push(event);
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "unavailable",
      reasonCode: "BSC_LOG_QUERY_REJECTED",
      rpcError: { rpcStatus: 403, rpcUrlHost: "bsc-rpc.publicnode.com" },
    });
    expect(storage.commits).toEqual([]);
    expect(storage.current()).toBeNull();

    vi.useFakeTimers();
    const controller = new AbortController();
    const running = worker.run(controller.signal);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    refuse = false;
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(3_000);
    await running;

    expect(availability.map((event) => [event.lane, event.state])).toEqual([
      ["pool_event", "unavailable"],
      ["pool_event", "recovered"],
    ]);
    expect(availability[0]).toMatchObject({
      reasonCode: "BSC_LOG_QUERY_REJECTED",
      errorClass: "HttpRequestError",
      rpcStatus: 403,
      rpcCode: -32602,
      rpcUrlHost: "bsc-rpc.publicnode.com",
      method: "eth_getLogs",
    });
    expect(storage.current()).toMatchObject({ lastBlockNumber: "100" });
  });
});
