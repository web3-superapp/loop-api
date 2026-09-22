import { randomUUID } from "node:crypto";

import {
  availabilityKey,
  BSC_INDEXER_IDLE_DELAY_MS,
  infrastructureBackoffEvent,
  isRefusalReasonCode,
  laneAvailabilityEvent,
  retryDelayMs,
  unavailableDelayMs,
  unavailableReasonFor,
  type BscIndexerInfrastructureBackoff,
  type BscIndexerLaneAvailabilityEvent,
  type BscIndexerRunKind,
} from "./bsc-indexer-worker.js";
import type {
  BscIndexerRepository,
  IndexedPoolEventInput,
} from "./database/bsc-indexer-repository.js";
import type {
  ChainRegistryRepository,
  PoolRecord,
} from "./database/chain-registry-repository.js";
import {
  bscMaximumLogRange,
  type BscPoolEventLog,
  type BscReadClient,
  type BscRpcErrorSummary,
} from "./integrations/bsc/rpc-client.js";

/**
 * The `pool_event` indexer lane (Decision 0034).
 *
 * It indexes only Swap/Mint/Burn logs emitted by registered PancakeSwap V3
 * pools (`pools.status = 'registered'`). It runs the same state machine as
 * the `erc20_transfer` lane but owns its own checkpoint row and its own reorg
 * rewind over `indexed_pool_events`, so neither lane can rewind the other's
 * rows. Its rows feed the derived candles and the trades tape.
 */

export const BSC_POOL_INDEXER_LANE = "pool_event" as const;

export interface BscPoolIndexerRunResult {
  readonly kind: BscIndexerRunKind;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly eventCount: number;
  readonly reasonCode: string | null;
  /** Provider error classification behind an `unavailable` tick (Decision 0068). */
  readonly rpcError?: BscRpcErrorSummary;
}

export interface BscPoolIndexerWorker {
  readonly workerId: string;
  readonly lane: typeof BSC_POOL_INDEXER_LANE;
  runOnce(signal?: AbortSignal): Promise<BscPoolIndexerRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateBscPoolIndexerWorkerOptions {
  readonly repository: BscIndexerRepository;
  readonly registry: ChainRegistryRepository;
  readonly readClient: BscReadClient;
  readonly chainId: string;
  readonly startBlockNumber: number | null;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: BscIndexerInfrastructureBackoff,
  ) => void;
  readonly onLaneAvailability?: (
    event: BscIndexerLaneAvailabilityEvent,
  ) => void;
}

function idleResult(
  kind: BscIndexerRunKind,
  reasonCode: string | null,
  rpcError?: BscRpcErrorSummary,
): BscPoolIndexerRunResult {
  return Object.freeze({
    kind,
    fromBlockNumber: null,
    toBlockNumber: null,
    eventCount: 0,
    reasonCode,
    ...(rpcError === undefined ? {} : { rpcError }),
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

function isSignedInteger(value: string | undefined): value is string {
  return value !== undefined && /^-?[0-9]+$/.test(value);
}

/**
 * Maps a decoded log onto a storage row. Swap rows carry the typed columns
 * the candle aggregation reads; every event keeps the full payload as strings.
 */
export function toIndexedPoolEvent(
  log: BscPoolEventLog,
  poolId: string,
): IndexedPoolEventInput | null {
  const base = {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber.toString(10),
    blockHash: log.blockHash,
    blockTimestamp: new Date(Number(log.blockTimestamp) * 1_000).toISOString(),
    poolId,
    eventKind: log.kind,
    payload: log.args,
  } as const;
  if (log.kind === "swap") {
    const amount0 = log.args["amount0"];
    const amount1 = log.args["amount1"];
    const sqrtPriceX96 = log.args["sqrtPriceX96"];
    if (
      !isSignedInteger(amount0) ||
      !isSignedInteger(amount1) ||
      sqrtPriceX96 === undefined ||
      !/^[0-9]+$/.test(sqrtPriceX96)
    ) {
      return null;
    }
    return Object.freeze({ ...base, amount0, amount1, sqrtPriceX96 });
  }
  const amount0 = log.args["amount0"];
  const amount1 = log.args["amount1"];
  return Object.freeze({
    ...base,
    amount0: isSignedInteger(amount0) ? amount0 : null,
    amount1: isSignedInteger(amount1) ? amount1 : null,
    sqrtPriceX96: null,
  });
}

export function createBscPoolIndexerWorker(
  options: CreateBscPoolIndexerWorkerOptions,
): BscPoolIndexerWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = createUuid();
  let inFlight: Promise<BscPoolIndexerRunResult> | null = null;
  let loopRunning = false;

  async function execute(
    signal?: AbortSignal,
  ): Promise<BscPoolIndexerRunResult> {
    const pools = await options.registry.listPools(options.chainId);
    if (pools.length === 0) {
      return idleResult("idle", "POOL_REGISTRY_EMPTY");
    }
    const poolsByAddress = new Map<string, PoolRecord>(
      pools.map((pool) => [pool.address, pool]),
    );

    let head;
    try {
      head = await options.readClient.getHead();
    } catch (error) {
      const unavailable = unavailableReasonFor(error);
      if (unavailable !== null) {
        return idleResult(
          "unavailable",
          unavailable.reasonCode,
          unavailable.rpcError,
        );
      }
      throw error;
    }
    if (signal !== undefined && signal.aborted) {
      return idleResult("aborted", null);
    }

    const checkpoint = await options.repository.getCheckpoint(
      BSC_POOL_INDEXER_LANE,
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

    // A refused or unreachable read is the lane's `unavailable` outcome, not
    // a retry-loop failure (Decision 0068); nothing is committed for it.
    let logs;
    try {
      logs = await options.readClient.readPoolEventLogs({
        addresses: pools.map((pool) => pool.address),
        fromBlock,
        toBlock,
      });
    } catch (error) {
      const unavailable = unavailableReasonFor(error);
      if (unavailable !== null) {
        return idleResult(
          "unavailable",
          unavailable.reasonCode,
          unavailable.rpcError,
        );
      }
      throw error;
    }
    if (signal !== undefined && signal.aborted) {
      return idleResult("aborted", null);
    }

    const events: IndexedPoolEventInput[] = [];
    for (const log of logs) {
      const pool = poolsByAddress.get(log.address);
      if (pool === undefined) {
        continue;
      }
      const event = toIndexedPoolEvent(log, pool.poolId);
      if (event !== null) {
        events.push(event);
      }
    }

    const toBlockHash =
      toBlock === head.blockNumber
        ? head.blockHash
        : await options.readClient.getBlockHash(toBlock);
    if (toBlockHash === null) {
      return idleResult("unavailable", "BSC_BLOCK_HASH_UNAVAILABLE");
    }

    await options.repository.commitPoolEventSegment({
      chainId: options.chainId,
      events,
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
      eventCount: events.length,
      reasonCode: null,
    });
  }

  function runOnce(signal?: AbortSignal): Promise<BscPoolIndexerRunResult> {
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
    lane: BSC_POOL_INDEXER_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The BSC pool indexer lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      let consecutiveRefusals = 0;
      let unavailableKey: string | null = null;
      try {
        while (!signal.aborted) {
          try {
            const result = await runOnce(signal);
            consecutiveFailures = 0;
            if (result.kind === "unavailable") {
              const key = availabilityKey(result);
              if (key !== unavailableKey) {
                unavailableKey = key;
                options.onLaneAvailability?.(
                  laneAvailabilityEvent(
                    BSC_POOL_INDEXER_LANE,
                    "unavailable",
                    result.reasonCode,
                    result.rpcError,
                  ),
                );
              }
              consecutiveRefusals = isRefusalReasonCode(result.reasonCode)
                ? consecutiveRefusals + 1
                : 0;
              await waitFor(
                unavailableDelayMs(result.reasonCode, consecutiveRefusals),
                signal,
              );
              continue;
            }
            consecutiveRefusals = 0;
            if (unavailableKey !== null) {
              unavailableKey = null;
              options.onLaneAvailability?.(
                laneAvailabilityEvent(
                  BSC_POOL_INDEXER_LANE,
                  "recovered",
                  null,
                  undefined,
                ),
              );
            }
            if (result.kind !== "advanced" && result.kind !== "reorged") {
              await waitFor(BSC_INDEXER_IDLE_DELAY_MS, signal);
            }
          } catch (error) {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailures += 1;
            const delay = retryDelayMs(consecutiveFailures);
            options.onInfrastructureBackoff?.(
              infrastructureBackoffEvent(
                BSC_POOL_INDEXER_LANE,
                error,
                consecutiveFailures,
                delay,
              ),
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
