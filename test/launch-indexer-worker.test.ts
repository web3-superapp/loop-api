import { RpcRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  createLaunchIndexerWorker,
  launchEventPayload,
  type LaunchIndexerWarning,
} from "../src/bsc-launch-indexer-worker.js";
import {
  createUnavailableLaunchChainRepository,
  type CommitLaunchSegmentInput,
  type LaunchChainRepository,
  type LaunchCheckpointRecord,
} from "../src/features/launch/launch-chain-repository.js";
import {
  createUnavailableBscReadClient,
  type BscReadClient,
} from "../src/integrations/bsc/rpc-client.js";
import {
  LaunchContractUnavailableError,
  createLaunchContractAdapter,
  decodeLaunchpadLogs,
  type LaunchContractAdapter,
  type LaunchContractLog,
  type LaunchContractConfig,
} from "../src/integrations/launch/launch-contract-adapter.js";
import {
  fixtureBlockHash,
  fixtureLog,
  oneUsd1,
} from "./helpers/launch-lane-fixtures.js";
import {
  mockLaunchpadAddress,
  mockUsd1Address,
} from "./helpers/launchpad-mock-chain.js";

/**
 * Decision 0077 `launch_event` lane state machine with test-only fixture
 * logs (ABI v1 encoded) and in-memory fakes: seed from the start block,
 * registered sales only, getState projection at the segment end, reorg
 * rewind, and the idle/unavailable outcomes.
 */

const launchId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const contract: LaunchContractConfig = Object.freeze({
  address: mockLaunchpadAddress,
  version: "1.0.0",
  versionMajor: 1,
  startBlock: 100n,
  usd1Address: mockUsd1Address,
});
const buyer = "0x000000000000000000000000000000000000000a";
const digest = `0x${"cd".repeat(32)}`;
const configVersion = `0x${"ab".repeat(32)}`;

function readClient(head: { block: bigint; fork?: string }): BscReadClient {
  return Object.freeze({
    ...createUnavailableBscReadClient({
      chainId: "eip155:97",
      chainReference: 97,
      confirmations: 5,
      reorgDepthBlocks: 15,
    }),
    getHead: () =>
      Promise.resolve({
        blockNumber: head.block,
        blockHash: fixtureBlockHash(head.block),
        observedAt: new Date().toISOString(),
      }),
    getBlockHash: (block: bigint) =>
      Promise.resolve(
        head.fork !== undefined && block >= 110n
          ? `0x${block.toString(16).padStart(64, "f")}`
          : fixtureBlockHash(block),
      ),
  });
}

function adapter(
  logs: readonly LaunchContractLog[],
  options: {
    readonly contractConfig?: LaunchContractConfig | null;
    readonly stateFails?: boolean;
  } = {},
): LaunchContractAdapter & {
  readonly logRanges: { fromBlock: bigint; toBlock: bigint }[];
  readonly stateBlocks: bigint[];
} {
  const base = createLaunchContractAdapter({
    contract:
      options.contractConfig === undefined ? contract : options.contractConfig,
    chain: { chainId: "eip155:97", chainReference: 97, rpcUrls: [] },
    verifyChain: () => Promise.resolve("verified"),
  });
  const logRanges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const stateBlocks: bigint[] = [];
  return {
    ...base,
    logRanges,
    stateBlocks,
    availability: () =>
      Promise.resolve(
        base.contract === null
          ? {
              status: "unavailable" as const,
              reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING" as const,
            }
          : { status: "available" as const },
      ),
    readLogs: (range) => {
      logRanges.push({ ...range });
      return Promise.resolve(
        logs.filter(
          (log) =>
            log.blockNumber >= range.fromBlock &&
            log.blockNumber <= range.toBlock,
        ),
      );
    },
    decodeEvents: (items) => decodeLaunchpadLogs(items),
    getState: (saleId, snapshot) => {
      stateBlocks.push(snapshot?.blockNumber ?? -1n);
      if (options.stateFails === true) {
        return Promise.reject(
          new LaunchContractUnavailableError("LAUNCH_CONTRACT_READ_FAILED"),
        );
      }
      return Promise.resolve({
        value: {
          saleState: saleId === 7n ? "LIVE" : "SCHEDULED",
          entitlementState: "NONE",
          liquidityState: "NOT_STARTED",
          operationalState: "ACTIVE",
          configVersion,
          stateTupleDigest: digest,
        },
        snapshot: snapshot ?? {
          blockNumber: 0n,
          blockHash: fixtureBlockHash(0n),
        },
      });
    },
  };
}

function repository(initial: LaunchCheckpointRecord | null = null) {
  let checkpoint = initial;
  const commits: CommitLaunchSegmentInput[] = [];
  const fake: LaunchChainRepository = {
    ...createUnavailableLaunchChainRepository(),
    getCheckpoint: () => Promise.resolve(checkpoint),
    listRegisteredSales: vi.fn(() =>
      Promise.resolve([
        {
          launchId,
          saleId: "7",
          chainId: "eip155:97" as const,
          contractAddress: mockLaunchpadAddress,
          contractVersion: "1.0.0",
        },
      ]),
    ),
    commitSegment: (input) => {
      commits.push(input);
      checkpoint = {
        ...input.checkpoint,
        updatedAt: new Date().toISOString(),
      };
      return Promise.resolve();
    },
  };
  return { fake, commits };
}

const logs = [
  fixtureLog(
    "Purchased",
    {
      saleId: 7n,
      buyer,
      roundId: 1,
      usd1Amount: 10n * oneUsd1,
      tokenAmount: 1_000n * oneUsd1,
      walletCumulativeUsd1: 10n * oneUsd1,
      purchaseIndex: 1n,
    },
    { block: 105n, logIndex: 0 },
  ),
  fixtureLog(
    "Purchased",
    {
      saleId: 9n,
      buyer,
      roundId: 1,
      usd1Amount: 10n * oneUsd1,
      tokenAmount: 1_000n * oneUsd1,
      walletCumulativeUsd1: 10n * oneUsd1,
      purchaseIndex: 1n,
    },
    { block: 105n, logIndex: 1 },
  ),
  fixtureLog(
    "SaleFinalized",
    {
      saleId: 7n,
      outcome: 4,
      totalRaisedUsd1: 10n * oneUsd1,
      totalTokensSold: 1_000n * oneUsd1,
    },
    { block: 112n, logIndex: 0 },
  ),
];

describe("launch_event lane (Decision 0077)", () => {
  it("idles with LAUNCH_CONTRACT_BASELINE_PENDING while the four keys are blank", async () => {
    const { fake, commits } = repository();
    const worker = createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 200n }),
      adapter: adapter([], { contractConfig: null }),
      chainId: "eip155:97",
    });
    expect(await worker.runOnce()).toMatchObject({
      kind: "idle",
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
    });
    expect(commits).toEqual([]);
  });

  it("seeds from LAUNCH_CONTRACT_START_BLOCK, keeps registered sales only, and projects getState at the segment's last block", async () => {
    const { fake, commits } = repository();
    const warnings: LaunchIndexerWarning[] = [];
    const chain = adapter(logs);
    const worker = createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 120n }),
      adapter: chain,
      chainId: "eip155:97",
      onWarning: (warning) => warnings.push(warning),
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({
      kind: "seeded",
      fromBlockNumber: "100",
      toBlockNumber: "120",
      eventCount: 2,
      projectedSaleCount: 1,
    });
    expect(chain.logRanges).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
    const commit = commits[0]!;
    expect(
      commit.events.map((event) => [
        event.eventName,
        event.saleId,
        event.launchId,
      ]),
    ).toEqual([
      ["Purchased", "7", launchId],
      ["SaleFinalized", "7", launchId],
    ]);
    expect(commit.events[0]).toMatchObject({
      walletAddress: buyer,
      payload: {
        buyer,
        roundId: "1",
        usd1Amount: (10n * oneUsd1).toString(),
        tokenAmount: (1_000n * oneUsd1).toString(),
      },
    });
    expect(commit.events[1]?.payload).toMatchObject({ outcome: "FAILED" });
    // The four axes and the digest come from getState at block 120, not from events.
    expect(chain.stateBlocks).toEqual([120n]);
    expect(commit.projections).toEqual([
      {
        launchId,
        saleState: "LIVE",
        entitlementState: "NONE",
        liquidityState: "NOT_STARTED",
        operationalState: "ACTIVE",
        configVersion,
        stateTupleDigest: digest,
        snapshotBlockNumber: "120",
        snapshotBlockHash: fixtureBlockHash(120n),
      },
    ]);
    expect(commit.checkpoint).toEqual({
      lastBlockNumber: "120",
      lastBlockHash: fixtureBlockHash(120n),
      startedFromBlockNumber: "100",
    });
    expect(commit.confirmedThroughBlockNumber).toBe("115");
    expect(warnings).toEqual([
      {
        reasonCode: "LAUNCH_SALE_UNREGISTERED",
        saleId: "9",
        blockNumber: "105",
        detailReasonCode: null,
      },
    ]);
  });

  it("rewinds by the reorg depth when the checkpoint hash no longer matches", async () => {
    const { fake, commits } = repository({
      lastBlockNumber: "130",
      lastBlockHash: fixtureBlockHash(130n),
      startedFromBlockNumber: "100",
      updatedAt: new Date().toISOString(),
    });
    const worker = createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 140n, fork: "f" }),
      adapter: adapter(logs),
      chainId: "eip155:97",
    });
    expect(await worker.runOnce()).toMatchObject({
      kind: "reorged",
      fromBlockNumber: "115",
      toBlockNumber: "140",
    });
    expect(commits[0]?.rewindFromBlockNumber).toBe("115");
  });

  it("advances from the checkpoint and still commits events when getState cannot be read at that block", async () => {
    const { fake, commits } = repository({
      lastBlockNumber: "104",
      lastBlockHash: fixtureBlockHash(104n),
      startedFromBlockNumber: "100",
      updatedAt: new Date().toISOString(),
    });
    const warnings: LaunchIndexerWarning[] = [];
    const worker = createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 106n }),
      adapter: adapter(logs, { stateFails: true }),
      chainId: "eip155:97",
      onWarning: (warning) => warnings.push(warning),
    });
    expect(await worker.runOnce()).toMatchObject({
      kind: "advanced",
      fromBlockNumber: "105",
      eventCount: 1,
      projectedSaleCount: 0,
    });
    expect(commits[0]?.projections).toEqual([]);
    expect(warnings).toContainEqual({
      reasonCode: "LAUNCH_STATE_PROJECTION_SKIPPED",
      saleId: "7",
      blockNumber: "106",
      detailReasonCode: "LAUNCH_CONTRACT_READ_FAILED",
    });
  });

  it("is idle at head and unavailable when the adapter is", async () => {
    const { fake } = repository({
      lastBlockNumber: "120",
      lastBlockHash: fixtureBlockHash(120n),
      startedFromBlockNumber: "100",
      updatedAt: new Date().toISOString(),
    });
    const idle = createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 120n }),
      adapter: adapter(logs),
      chainId: "eip155:97",
    });
    expect(await idle.runOnce()).toMatchObject({
      kind: "idle",
      reasonCode: null,
    });
    const broken = {
      ...adapter(logs),
      availability: () =>
        Promise.resolve({
          status: "unavailable" as const,
          reasonCode: "LAUNCH_CONTRACT_CODE_MISSING" as const,
        }),
    };
    const unavailable = createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 130n }),
      adapter: broken,
      chainId: "eip155:97",
    });
    expect(await unavailable.runOnce()).toMatchObject({
      kind: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_CODE_MISSING",
    });
  });

  it("reports an archive refusal of the adapter's getLogs as BSC_LOG_ARCHIVE_REQUIRED with behindBlocks (S82d)", async () => {
    const { fake, commits } = repository();
    const onUnavailable = vi.fn();
    const pruned = {
      ...adapter(logs),
      readLogs: () =>
        Promise.reject(
          new LaunchContractUnavailableError("LAUNCH_CONTRACT_READ_FAILED", {
            cause: new RpcRequestError({
              body: { method: "eth_getLogs" },
              url: "https://bsc-testnet-rpc.publicnode.com/",
              error: {
                code: -32701,
                message: "History has been pruned for this block.",
              },
            }),
          }),
        ),
    };
    const worker = createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 3_000_100n }),
      adapter: pruned,
      chainId: "eip155:97",
      onUnavailable,
    });
    expect(await worker.runOnce()).toMatchObject({
      kind: "unavailable",
      reasonCode: "BSC_LOG_ARCHIVE_REQUIRED",
      behindBlocks: 3_000_000,
    });
    expect(commits).toEqual([]);
    // Any other read failure keeps the adapter's reason and no behindBlocks.
    const failing = {
      ...adapter(logs),
      readLogs: () =>
        Promise.reject(
          new LaunchContractUnavailableError("LAUNCH_CONTRACT_READ_FAILED", {
            cause: new Error("socket hang up"),
          }),
        ),
    };
    const other = await createLaunchIndexerWorker({
      repository: fake,
      readClient: readClient({ block: 3_000_100n }),
      adapter: failing,
      chainId: "eip155:97",
    }).runOnce();
    expect(other.reasonCode).toBe("LAUNCH_CONTRACT_READ_FAILED");
    expect(other).not.toHaveProperty("behindBlocks");
  });

  it("stores every argument of the 14 events as strings under its 06 name", () => {
    const decoded = decodeLaunchpadLogs([
      fixtureLog(
        "PoolPrepared",
        {
          saleId: 1n,
          pool: buyer,
          feeTier: 2_500,
          initialSqrtPriceX96: 2n ** 96n,
          tickLower: -887_250,
          tickUpper: 887_250,
        },
        { block: 1n, logIndex: 0 },
      ),
    ]).events[0]!;
    expect(launchEventPayload(decoded)).toEqual({
      pool: buyer,
      feeTier: "2500",
      initialSqrtPriceX96: (2n ** 96n).toString(),
      tickLower: "-887250",
      tickUpper: "887250",
    });
  });
});
