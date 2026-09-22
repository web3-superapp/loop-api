import { custom, HttpRequestError, numberToHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBscIndexerWorker,
  type BscIndexerInfrastructureBackoff,
  type BscIndexerLaneAvailabilityEvent,
} from "../src/bsc-indexer-worker.js";
import type {
  BscIndexerRepository,
  CommitApprovalCoverageSegmentInput,
  CommitTransferSegmentInput,
  IndexerCheckpointRecord,
  IndexedTransferRecord,
} from "../src/database/bsc-indexer-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import {
  BscReadUnavailableError,
  createBscReadClient,
  type BscApprovalLog,
  type BscReadClient,
  type BscTransferLog,
  type BscTransferLogQuery,
} from "../src/integrations/bsc/rpc-client.js";

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const assetId = `eip155:56:${wbnb}`;
const owner = "0x00000000000000000000000000000000000000a1";

function blockHash(blockNumber: bigint, fork = "a"): string {
  return `0x${fork.repeat(2)}${blockNumber.toString(16).padStart(62, "0")}`;
}

const wbnbAsset: AssetRecord = Object.freeze({
  assetId,
  chainId: bscChainId,
  address: wbnb,
  symbol: "WBNB",
  name: "Wrapped BNB",
  decimals: 18,
  status: "pending",
  sourceKind: "chain_call",
  sourceBlockNumber: "1",
  sourceVerifiedAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
});

function registryFake(
  assets: readonly AssetRecord[] = [wbnbAsset],
): ChainRegistryRepository {
  return {
    getChain: vi.fn(() => Promise.resolve(null)),
    getAsset: vi.fn(() => Promise.resolve(null)),
    listAssets: vi.fn(() => Promise.resolve(assets)),
    listReadableAssets: vi.fn(() => Promise.resolve(assets)),
    upsertAsset: vi.fn(() => Promise.reject(new Error("not used"))),
    listPools: vi.fn(() => Promise.resolve([])),
    upsertPool: vi.fn(() => Promise.reject(new Error("not used"))),
  };
}

/**
 * In-memory stand-in for the lane storage. It keeps the real uniqueness rule
 * (chain + transaction hash + log index) so a replayed segment can be observed
 * as idempotent instead of duplicating rows.
 */
function repositoryFake() {
  const rows = new Map<string, IndexedTransferRecord>();
  let checkpoint: IndexerCheckpointRecord | null = null;
  const commits: CommitTransferSegmentInput[] = [];

  const coverageCommits: CommitApprovalCoverageSegmentInput[] = [];

  const repository: BscIndexerRepository = {
    getCheckpoint: () => Promise.resolve(checkpoint),
    commitApprovalCoverageSegment: (input) => {
      coverageCommits.push(input);
      if (
        checkpoint === null ||
        BigInt(checkpoint.lastBlockNumber) < BigInt(input.toBlockNumber)
      ) {
        return Promise.reject(new Error("range not indexed"));
      }
      const current = checkpoint.approvalCoverageFromBlockNumber;
      checkpoint = {
        ...checkpoint,
        approvalCoverageFromBlockNumber:
          current === null || BigInt(input.fromBlockNumber) < BigInt(current)
            ? input.fromBlockNumber
            : current,
      };
      return Promise.resolve(checkpoint);
    },
    earliestWalletActivityBlockNumber: () => Promise.resolve(null),
    commitTransferSegment: (input) => {
      commits.push(input);
      const rewind = input.rewindFromBlockNumber;
      if (rewind !== undefined) {
        for (const [key, row] of rows) {
          if (BigInt(row.blockNumber) >= BigInt(rewind)) {
            rows.set(key, { ...row, removed: true });
          }
        }
      }
      for (const transfer of input.transfers) {
        rows.set(`${transfer.transactionHash}:${String(transfer.logIndex)}`, {
          ...transfer,
          removed: false,
          observedAt: "2026-09-08T00:00:00.000Z",
        });
      }
      const previousCoverage =
        checkpoint?.approvalCoverageFromBlockNumber ?? null;
      const segmentCoverage = input.approvalCoverageFromBlockNumber ?? null;
      checkpoint = {
        lastBlockNumber: input.checkpoint.lastBlockNumber,
        lastBlockHash: input.checkpoint.lastBlockHash,
        startedFromBlockNumber: input.checkpoint.startedFromBlockNumber,
        approvalCoverageFromBlockNumber:
          previousCoverage === null
            ? segmentCoverage
            : segmentCoverage === null ||
                BigInt(previousCoverage) <= BigInt(segmentCoverage)
              ? previousCoverage
              : segmentCoverage,
        reorgCount:
          (checkpoint?.reorgCount ?? 0) + (rewind === undefined ? 0 : 1),
        updatedAt: "2026-09-08T00:00:00.000Z",
      };
      return Promise.resolve(checkpoint);
    },
    listWalletTransfers: () =>
      Promise.resolve({ items: [...rows.values()], hasMore: false }),
    sumPendingIncoming: () => Promise.resolve([]),
    listLatestApprovals: () => Promise.resolve([]),
    hasOutgoingTransferTo: () => Promise.resolve(false),
    commitPoolEventSegment: () => Promise.reject(new Error("not used")),
    listPoolSwaps: () => Promise.resolve({ items: [], hasMore: false }),
    aggregateSwapCandles: () => Promise.resolve([]),
  };

  return {
    repository,
    rows,
    commits,
    coverageCommits,
    current: () => checkpoint,
    seed: (record: IndexerCheckpointRecord) => {
      checkpoint = record;
    },
  };
}

interface ReadClientOptions {
  readonly head: bigint;
  readonly logsFor?: (query: BscTransferLogQuery) => readonly BscTransferLog[];
  /** Rejects every transfer-log read with this error. */
  readonly transferLogsError?: () => Error;
  readonly approvalLogsFor?: (
    query: BscTransferLogQuery,
  ) => readonly BscApprovalLog[];
  readonly blockHashFor?: (blockNumber: bigint) => string | null;
  readonly headUnavailable?: boolean;
}

function readClientFake(options: ReadClientOptions): BscReadClient {
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
    readTransferLogs: (query) =>
      options.transferLogsError === undefined
        ? Promise.resolve(options.logsFor?.(query) ?? [])
        : Promise.reject(options.transferLogsError()),
    readPoolEventLogs: () => Promise.resolve([]),
    readApprovalLogs: (query) =>
      Promise.resolve(options.approvalLogsFor?.(query) ?? []),
    probeEndpoints: () => Promise.resolve([]),
  };
}

function approvalLog(blockNumber: bigint, logIndex: number): BscApprovalLog {
  return {
    transactionHash: `0x${blockNumber.toString(16).padStart(62, "0")}a${String(logIndex)}`,
    logIndex,
    blockNumber,
    blockHash: blockHash(blockNumber),
    address: wbnb,
    owner,
    spender: wbnb,
    value: 7n,
    removed: false,
  };
}

function transferLog(blockNumber: bigint, logIndex: number): BscTransferLog {
  return {
    transactionHash: `0x${blockNumber.toString(16).padStart(63, "0")}${String(logIndex)}`,
    logIndex,
    blockNumber,
    blockHash: blockHash(blockNumber),
    address: wbnb,
    from: owner,
    to: wbnb,
    value: 5n,
    removed: false,
  };
}

describe("BSC ERC-20 indexer lane", () => {
  it("stays idle while the Asset Registry has no token to index", async () => {
    const storage = repositoryFake();
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake([]),
      readClient: readClientFake({ head: 100n }),
      chainId: bscChainId,
      startBlockNumber: null,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "idle",
      reasonCode: "ASSET_REGISTRY_EMPTY",
    });
    expect(storage.current()).toBeNull();
  });

  it("reports an unreachable chain without advancing the checkpoint", async () => {
    const storage = repositoryFake();
    const worker = createBscIndexerWorker({
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

  it("seeds from the configured block and never reads more than 2000 blocks", async () => {
    const storage = repositoryFake();
    const ranges: BscTransferLogQuery[] = [];
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({
        head: 10_000n,
        logsFor: (query) => {
          ranges.push(query);
          return [];
        },
      }),
      chainId: bscChainId,
      startBlockNumber: 1_000,
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({
      kind: "seeded",
      fromBlockNumber: "1000",
      toBlockNumber: "2999",
    });
    const second = await worker.runOnce();
    expect(second).toMatchObject({
      kind: "advanced",
      fromBlockNumber: "3000",
      toBlockNumber: "4999",
    });

    for (const range of ranges) {
      expect(range.toBlock - range.fromBlock + 1n).toBeLessThanOrEqual(2_000n);
    }
    expect(storage.current()?.lastBlockNumber).toBe("4999");
    expect(storage.current()?.startedFromBlockNumber).toBe("1000");
    // Approval logs were decoded for every committed segment, so coverage
    // starts where the lane started and does not move on the next segment.
    expect(
      storage.commits.map((c) => c.approvalCoverageFromBlockNumber),
    ).toEqual(["1000", "3000"]);
    expect(storage.current()?.approvalCoverageFromBlockNumber).toBe("1000");
  });

  it("backfills approval coverage downward from the coverage start without moving the checkpoint", async () => {
    const storage = repositoryFake();
    // A lane indexed before Approval decoding existed: checkpoint, no coverage.
    storage.seed({
      lastBlockNumber: "9999",
      lastBlockHash: blockHash(9_999n),
      startedFromBlockNumber: "1000",
      approvalCoverageFromBlockNumber: null,
      reorgCount: 0,
      updatedAt: "2026-09-08T00:00:00.000Z",
    });
    const ranges: BscTransferLogQuery[] = [];
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({
        head: 9_999n,
        approvalLogsFor: (query) => {
          ranges.push(query);
          return [approvalLog(query.fromBlock, 0)];
        },
      }),
      chainId: bscChainId,
      startBlockNumber: null,
    });

    const first = await worker.backfillApprovalCoverageOnce(5_000n);
    expect(first).toMatchObject({
      kind: "covered",
      fromBlockNumber: "8000",
      toBlockNumber: "9999",
      approvalCount: 1,
    });
    expect(storage.current()?.approvalCoverageFromBlockNumber).toBe("8000");
    expect(storage.current()?.lastBlockNumber).toBe("9999");

    const second = await worker.backfillApprovalCoverageOnce(5_000n);
    expect(second).toMatchObject({
      kind: "covered",
      fromBlockNumber: "6000",
      toBlockNumber: "7999",
    });
    const third = await worker.backfillApprovalCoverageOnce(5_000n);
    expect(third).toMatchObject({
      kind: "covered",
      fromBlockNumber: "5000",
      toBlockNumber: "5999",
    });
    expect(storage.current()?.approvalCoverageFromBlockNumber).toBe("5000");
    await expect(worker.backfillApprovalCoverageOnce(5_000n)).resolves.toEqual({
      kind: "idle",
      fromBlockNumber: null,
      toBlockNumber: null,
      approvalCount: 0,
      reasonCode: "APPROVAL_COVERAGE_SATISFIED",
    });
    // A higher target than the current coverage is already satisfied.
    await expect(
      worker.backfillApprovalCoverageOnce(7_000n),
    ).resolves.toMatchObject({
      kind: "idle",
      reasonCode: "APPROVAL_COVERAGE_SATISFIED",
    });
    for (const range of ranges) {
      expect(range.toBlock - range.fromBlock + 1n).toBeLessThanOrEqual(2_000n);
    }
    expect(storage.coverageCommits.map((c) => c.toBlockNumber)).toEqual([
      "9999",
      "7999",
      "5999",
    ]);
    expect(storage.commits).toHaveLength(0);
  });

  it("does not backfill approval coverage for a lane that has no checkpoint", async () => {
    const storage = repositoryFake();
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({ head: 9_999n }),
      chainId: bscChainId,
      startBlockNumber: 1_000,
    });
    await expect(
      worker.backfillApprovalCoverageOnce(100n),
    ).resolves.toMatchObject({
      kind: "idle",
      reasonCode: "APPROVAL_COVERAGE_LANE_NOT_SEEDED",
    });
    expect(storage.coverageCommits).toHaveLength(0);
  });

  it("stores a replayed segment idempotently", async () => {
    const storage = repositoryFake();
    const logs = [transferLog(500n, 0), transferLog(500n, 1)];
    const readClient = readClientFake({ head: 500n, logsFor: () => logs });
    const options = {
      repository: storage.repository,
      registry: registryFake(),
      readClient,
      chainId: bscChainId,
      startBlockNumber: 500,
    };

    await createBscIndexerWorker(options).runOnce();
    expect(storage.rows.size).toBe(2);

    // A second lane instance replays the same range from scratch.
    const replayStorage = {
      ...storage,
      repository: {
        ...storage.repository,
        getCheckpoint: () => Promise.resolve(null),
      },
    };
    await createBscIndexerWorker({
      ...options,
      repository: replayStorage.repository,
    }).runOnce();

    expect(storage.rows.size).toBe(2);
    for (const row of storage.rows.values()) {
      expect(row.removed).toBe(false);
      expect(row.assetId).toBe(assetId);
    }
  });

  it("rewinds the reorg depth and marks the replaced logs removed", async () => {
    const storage = repositoryFake();
    let fork = "a";
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({
        head: 1_000n,
        blockHashFor: (blockNumber) => blockHash(blockNumber, fork),
        logsFor: (query) =>
          query.fromBlock <= 1_000n && query.toBlock >= 1_000n
            ? [transferLog(1_000n, 0)]
            : [],
      }),
      chainId: bscChainId,
      startBlockNumber: 900,
    });

    await worker.runOnce();
    expect(storage.rows.size).toBe(1);
    expect(storage.current()?.lastBlockNumber).toBe("1000");

    // The chain reorganises: the stored block hash no longer matches.
    fork = "b";
    const reorged = await worker.runOnce();
    expect(reorged).toMatchObject({ kind: "reorged", fromBlockNumber: "936" });
    expect(storage.commits.at(-1)?.rewindFromBlockNumber).toBe("936");
    expect(storage.current()?.reorgCount).toBe(1);
    expect(storage.current()?.lastBlockHash).toBe(blockHash(1_000n, "b"));
  });

  it("never rewinds below the block the lane started from", async () => {
    const storage = repositoryFake();
    let fork = "a";
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({
        head: 950n,
        blockHashFor: (blockNumber) => blockHash(blockNumber, fork),
      }),
      chainId: bscChainId,
      startBlockNumber: 940,
    });

    await worker.runOnce();
    fork = "b";
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "reorged",
      fromBlockNumber: "940",
    });
  });

  it("goes idle once the lane has caught up with the head", async () => {
    const storage = repositoryFake();
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({ head: 300n }),
      chainId: bscChainId,
      startBlockNumber: 300,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ kind: "seeded" });
    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "idle",
      reasonCode: null,
    });
  });
});

/**
 * The refusal seen on the Development stack on 2026-09-22 (Decision 0068):
 * HTTP 403 with a JSON-RPC-shaped body from a keyed endpoint URL.
 */
const keyedEndpointUrl =
  "https://user:secret@bsc-rpc.publicnode.com/v1/provider-key?token=xyz";

function requestBlocked(): HttpRequestError {
  return new HttpRequestError({
    body: { method: "eth_getLogs", params: [{ address: [wbnb] }] },
    details: '{"code":-32602,"message":"Request blocked"}',
    status: 403,
    url: keyedEndpointUrl,
  });
}

const cake = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
const cakeAsset: AssetRecord = Object.freeze({
  ...wbnbAsset,
  assetId: `eip155:56:${cake}`,
  address: cake,
  symbol: "CAKE",
  name: "PancakeSwap Token",
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

describe("BSC ERC-20 indexer lane — Provider refusals (Decision 0068)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries the error class, HTTP status, JSON-RPC code, host, and method into the backoff event, and nothing else", async () => {
    const storage = repositoryFake();
    const events: BscIndexerInfrastructureBackoff[] = [];
    const controller = new AbortController();
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: readClientFake({
        head: 100n,
        transferLogsError: requestBlocked,
      }),
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
        lane: "erc20_transfer",
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
    expect(serialised).not.toContain(wbnb);
    expect(storage.current()).toBeNull();
  });

  it("advances through a 403 on multi-address eth_getLogs by reading one address at a time", async () => {
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
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake([wbnbAsset, cakeAsset]),
      readClient,
      chainId: bscChainId,
      startBlockNumber: 97,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "seeded",
      fromBlockNumber: "97",
      toBlockNumber: "100",
      transferCount: 0,
      reasonCode: null,
    });
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every((addresses) => addresses.length === 1)).toBe(true);
    expect(storage.current()).toMatchObject({
      lastBlockNumber: "100",
      lastBlockHash: blockHash(100n),
    });
  });

  it("idles as unavailable, commits nothing, and reports the transition once when every split is still refused", async () => {
    const storage = repositoryFake();
    const availability: BscIndexerLaneAvailabilityEvent[] = [];
    let refuse = true;
    const worker = createBscIndexerWorker({
      repository: storage.repository,
      registry: registryFake(),
      readClient: {
        ...readClientFake({ head: 100n }),
        readTransferLogs: () =>
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
    // Two unavailable ticks produce one transition; recovery produces one more.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    refuse = false;
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(3_000);
    await running;

    expect(availability).toEqual([
      {
        lane: "erc20_transfer",
        state: "unavailable",
        reasonCode: "BSC_LOG_QUERY_REJECTED",
        errorClass: "HttpRequestError",
        rpcStatus: 403,
        rpcCode: -32602,
        rpcUrlHost: "bsc-rpc.publicnode.com",
        method: "eth_getLogs",
      },
      {
        lane: "erc20_transfer",
        state: "recovered",
        reasonCode: null,
        errorClass: null,
        rpcStatus: null,
        rpcCode: null,
        rpcUrlHost: null,
        method: null,
      },
    ]);
    expect(storage.current()).toMatchObject({ lastBlockNumber: "100" });
  });
});
