import { randomUUID } from "node:crypto";

import type {
  BscIndexerRepository,
  IndexedApprovalInput,
  IndexedTransferInput,
} from "./database/bsc-indexer-repository.js";
import type { ChainRegistryRepository } from "./database/chain-registry-repository.js";
import { assetIdForAddress } from "./features/chain/chain-contract.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  bscMaximumLogRange,
  type BscReadClient,
} from "./integrations/bsc/rpc-client.js";

/**
 * The `bsc-erc20-transfer` indexer lane (Decision 0033).
 *
 * Scope is deliberately narrow: only ERC-20 `Transfer` logs emitted by
 * addresses that are already readable Asset Registry rows. It is not a
 * general-purpose chain indexer and it never discovers assets on its own.
 *
 * State machine per tick:
 *
 *   idle ──head unreachable──▶ unavailable ──backoff──▶ idle
 *     │
 *     ├─ no checkpoint ─▶ seed(from = configured start or head − reorgDepth)
 *     ├─ checkpoint hash matches chain ─▶ advance(fromBlock … min(+2000, head))
 *     └─ checkpoint hash differs ─▶ reorg(rewind reorgDepth, mark removed,
 *                                        replay the rewound range)
 *
 * Event rows and the checkpoint advance commit in the same transaction, so a
 * checkpoint can never claim a block whose logs were not stored.
 */

export const BSC_INDEXER_LANE = "erc20_transfer" as const;
export const BSC_INDEXER_IDLE_DELAY_MS = 3_000;
export const BSC_INDEXER_RETRY_BASE_DELAY_MS = 1_000;
export const BSC_INDEXER_RETRY_MAX_DELAY_MS = 30_000;

export type BscIndexerRunKind =
  "aborted" | "advanced" | "idle" | "reorged" | "seeded" | "unavailable";

export interface BscIndexerRunResult {
  readonly kind: BscIndexerRunKind;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly transferCount: number;
  readonly reasonCode: string | null;
}

export interface BscIndexerInfrastructureBackoff {
  readonly reasonCode: "bsc_indexer_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface BscIndexerWorker {
  readonly workerId: string;
  readonly lane: typeof BSC_INDEXER_LANE;
  runOnce(signal?: AbortSignal): Promise<BscIndexerRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateBscIndexerWorkerOptions {
  readonly repository: BscIndexerRepository;
  readonly registry: ChainRegistryRepository;
  readonly readClient: BscReadClient;
  readonly chainId: string;
  /** Block to seed a brand-new lane from; `null` starts near the head. */
  readonly startBlockNumber: number | null;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: BscIndexerInfrastructureBackoff,
  ) => void;
}

function idleResult(
  kind: BscIndexerRunKind,
  reasonCode: string | null,
): BscIndexerRunResult {
  return Object.freeze({
    kind,
    fromBlockNumber: null,
    toBlockNumber: null,
    transferCount: 0,
    reasonCode,
  });
}

async function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function retryDelayMs(consecutiveFailureCount: number): number {
  return Math.min(
    BSC_INDEXER_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    BSC_INDEXER_RETRY_MAX_DELAY_MS,
  );
}

export function createBscIndexerWorker(
  options: CreateBscIndexerWorkerOptions,
): BscIndexerWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = createUuid();
  let inFlight: Promise<BscIndexerRunResult> | null = null;
  let loopRunning = false;

  async function execute(signal?: AbortSignal): Promise<BscIndexerRunResult> {
    const assets = await options.registry.listReadableAssets(options.chainId);
    const tokens = assets.filter(
      (asset): asset is typeof asset & { address: string } =>
        asset.address !== null,
    );
    if (tokens.length === 0) {
      return idleResult("idle", "ASSET_REGISTRY_EMPTY");
    }

    let head;
    try {
      head = await options.readClient.getHead();
    } catch (error) {
      if (
        error instanceof BscReadUnavailableError ||
        error instanceof BscChainMismatchError
      ) {
        return idleResult(
          "unavailable",
          error instanceof BscChainMismatchError
            ? "BSC_CHAIN_ID_MISMATCH"
            : error.reasonCode,
        );
      }
      throw error;
    }
    if (isAborted(signal)) {
      return idleResult("aborted", null);
    }

    const checkpoint = await options.repository.getCheckpoint(
      BSC_INDEXER_LANE,
      options.chainId,
    );
    const reorgDepth = BigInt(options.readClient.reorgDepthBlocks);

    let fromBlock: bigint;
    let startedFrom: bigint;
    let rewindFrom: bigint | null = null;
    let kind: BscIndexerRunKind = "advanced";

    if (checkpoint === null) {
      const configuredStart =
        options.startBlockNumber === null
          ? null
          : BigInt(options.startBlockNumber);
      const seed =
        configuredStart ??
        (head.blockNumber > reorgDepth ? head.blockNumber - reorgDepth : 0n);
      fromBlock = seed;
      startedFrom = seed;
      kind = "seeded";
    } else {
      startedFrom = BigInt(checkpoint.startedFromBlockNumber);
      const lastBlock = BigInt(checkpoint.lastBlockNumber);
      const observedHash = await options.readClient.getBlockHash(lastBlock);
      if (observedHash === null || observedHash !== checkpoint.lastBlockHash) {
        // Reorg: rewind a bounded depth, mark every stored log at or above the
        // rewind point removed, and replay. The rewind never goes below the
        // block the lane originally started from.
        const rewound = lastBlock > reorgDepth ? lastBlock - reorgDepth : 0n;
        fromBlock = rewound > startedFrom ? rewound : startedFrom;
        rewindFrom = fromBlock;
        kind = "reorged";
      } else {
        fromBlock = lastBlock + 1n;
      }
    }

    if (fromBlock > head.blockNumber) {
      return idleResult("idle", null);
    }

    const maximumToBlock = fromBlock + bscMaximumLogRange - 1n;
    const toBlock =
      maximumToBlock < head.blockNumber ? maximumToBlock : head.blockNumber;

    const logs = await options.readClient.readTransferLogs({
      addresses: tokens.map((token) => token.address),
      fromBlock,
      toBlock,
    });
    // Approval logs are read for the same addresses and range and committed
    // under the same checkpoint (Decision 0035), so the approvals inventory
    // can never be ahead of or behind the transfer history.
    const approvalLogs = await options.readClient.readApprovalLogs({
      addresses: tokens.map((token) => token.address),
      fromBlock,
      toBlock,
    });
    if (isAborted(signal)) {
      return idleResult("aborted", null);
    }

    const transfers: IndexedTransferInput[] = logs.map((log) => ({
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber.toString(10),
      blockHash: log.blockHash,
      assetId: assetIdForAddress(options.chainId, log.address),
      fromAddress: log.from,
      toAddress: log.to,
      rawValue: log.value.toString(10),
    }));

    const approvals: IndexedApprovalInput[] = approvalLogs.map((log) => ({
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber.toString(10),
      blockHash: log.blockHash,
      assetId: assetIdForAddress(options.chainId, log.address),
      ownerAddress: log.owner,
      spenderAddress: log.spender,
      rawValue: log.value.toString(10),
    }));

    const toBlockHash =
      toBlock === head.blockNumber
        ? head.blockHash
        : await options.readClient.getBlockHash(toBlock);
    if (toBlockHash === null) {
      return idleResult("unavailable", "BSC_BLOCK_HASH_UNAVAILABLE");
    }

    await options.repository.commitTransferSegment({
      chainId: options.chainId,
      transfers,
      approvals,
      checkpoint: {
        lastBlockNumber: toBlock.toString(10),
        lastBlockHash: toBlockHash,
        startedFromBlockNumber: startedFrom.toString(10),
      },
      ...(rewindFrom === null
        ? {}
        : { rewindFromBlockNumber: rewindFrom.toString(10) }),
    });

    return Object.freeze({
      kind,
      fromBlockNumber: fromBlock.toString(10),
      toBlockNumber: toBlock.toString(10),
      transferCount: transfers.length,
      reasonCode: null,
    });
  }

  function runOnce(signal?: AbortSignal): Promise<BscIndexerRunResult> {
    if (inFlight !== null) {
      return inFlight;
    }
    const tracked = execute(signal).finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
      }
    });
    inFlight = tracked;
    return tracked;
  }

  return Object.freeze({
    workerId,
    lane: BSC_INDEXER_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The BSC indexer lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      try {
        while (!isAborted(signal)) {
          try {
            const result = await runOnce(signal);
            consecutiveFailures = 0;
            if (result.kind !== "advanced" && result.kind !== "reorged") {
              await waitFor(BSC_INDEXER_IDLE_DELAY_MS, signal);
            }
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailures += 1;
            const delay = retryDelayMs(consecutiveFailures);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "bsc_indexer_unavailable",
                consecutiveFailureCount: consecutiveFailures,
                retryDelayMs: delay,
              }),
            );
            await waitFor(delay, signal);
          }
        }
      } finally {
        loopRunning = false;
      }
    },
  });
}
