import { describe, expect, it, vi } from "vitest";

import { createBscIndexerWorker } from "../src/bsc-indexer-worker.js";
import type {
  BscIndexerRepository,
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

  const repository: BscIndexerRepository = {
    getCheckpoint: () => Promise.resolve(checkpoint),
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
    listWalletTransfers: () =>
      Promise.resolve({ items: [...rows.values()], hasMore: false }),
    sumPendingIncoming: () => Promise.resolve([]),
  };

  return { repository, rows, commits, current: () => checkpoint };
}

interface ReadClientOptions {
  readonly head: bigint;
  readonly logsFor?: (query: BscTransferLogQuery) => readonly BscTransferLog[];
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
      Promise.resolve(options.logsFor?.(query) ?? []),
    probeEndpoints: () => Promise.resolve([]),
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
