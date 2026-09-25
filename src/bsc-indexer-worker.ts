import { randomUUID } from "node:crypto";

import type {
  BscIndexerRepository,
  BscIndexerWalletSetRepository,
  IndexedApprovalInput,
  IndexedTransferInput,
} from "./database/bsc-indexer-repository.js";
import type { ChainRegistryRepository } from "./database/chain-registry-repository.js";
import { assetIdForAddress } from "./features/chain/chain-contract.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  bscLogQueryBudgetExhaustedReasonCode,
  bscLogQueryRejectedReasonCode,
  bscMaximumLogRange,
  defaultBscWalletTopicChunkSize,
  summarizeRpcError,
  type BscApprovalLog,
  type BscLogQueryLimits,
  type BscReadClient,
  type BscRpcErrorSummary,
  type BscTransferLog,
} from "./integrations/bsc/rpc-client.js";

/**
 * The `bsc-erc20-transfer` indexer lane (Decision 0033).
 *
 * Scope is deliberately narrow: only ERC-20 `Transfer` and `Approval` logs
 * emitted by addresses that are already readable Asset Registry rows, and
 * only those whose indexed wallet topic (`from`/`to`, `owner`) is an active
 * LOOP wallet (Decision 0075). It is not a general-purpose chain indexer and
 * it never discovers assets or wallets on its own. Both sets are re-read
 * every tick. With no active wallet the tick stores nothing, still advances
 * the checkpoint, and reports `INDEXER_WALLET_SET_EMPTY`.
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
/** Idle reason of a tick that advanced with an empty wallet set (Decision 0075). */
export const BSC_INDEXER_WALLET_SET_EMPTY = "INDEXER_WALLET_SET_EMPTY" as const;

export type BscIndexerRunKind =
  "aborted" | "advanced" | "idle" | "reorged" | "seeded" | "unavailable";

export interface BscIndexerRunResult {
  readonly kind: BscIndexerRunKind;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly transferCount: number;
  readonly reasonCode: string | null;
  /** Provider error classification behind an `unavailable` tick (Decision 0068). */
  readonly rpcError?: BscRpcErrorSummary;
}

export type BscIndexerLaneName = "erc20_transfer" | "pool_event";

/**
 * Loggable classification of the error that scheduled a retry (Decision
 * 0068). Only class names, numeric codes, a host name, and a method name:
 * never a URL, a request body, an address list, or a key.
 */
export interface BscIndexerInfrastructureBackoff {
  readonly reasonCode: "bsc_indexer_unavailable";
  readonly lane: BscIndexerLaneName;
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
  readonly errorClass: string;
  readonly rpcStatus: number | null;
  readonly rpcCode: number | null;
  readonly rpcUrlHost: string | null;
  readonly method: string | null;
  /**
   * The shared read client's learned `eth_getLogs` limits at the time of the
   * event (Decision 0079); absent when the client does not report them.
   */
  readonly learnedAddressLimit?: number;
  readonly learnedTopicGroupLimit?: number;
  readonly learnedRangeLimit?: number;
  readonly relaxAfterCleanReads?: number;
}

/**
 * Emitted once when a lane's tick becomes `unavailable` (or its reason code
 * changes), and once more when the lane recovers, so a lane that is idling
 * on a Provider refusal is visible without a log line per tick.
 */
export interface BscIndexerLaneAvailabilityEvent {
  readonly lane: BscIndexerLaneName;
  readonly state: "unavailable" | "recovered";
  readonly reasonCode: string | null;
  readonly errorClass: string | null;
  readonly rpcStatus: number | null;
  readonly rpcCode: number | null;
  readonly rpcUrlHost: string | null;
  readonly method: string | null;
  /** Learned log-query limits, as on the backoff event (Decision 0079). */
  readonly learnedAddressLimit?: number;
  readonly learnedTopicGroupLimit?: number;
  readonly learnedRangeLimit?: number;
  readonly relaxAfterCleanReads?: number;
}

/**
 * The read client's learned log-query limits (Decision 0079), or `null`
 * when it does not report them. Never throws: it runs inside a lane's catch.
 */
export function logQueryLimitsOf(
  client: BscReadClient,
): BscLogQueryLimits | null {
  try {
    return client.logQueryLimits?.() ?? null;
  } catch {
    return null;
  }
}

function limitFields(limits: BscLogQueryLimits | null | undefined): {
  readonly learnedAddressLimit?: number;
  readonly learnedTopicGroupLimit?: number;
  readonly learnedRangeLimit?: number;
  readonly relaxAfterCleanReads?: number;
} {
  if (limits === null || limits === undefined) {
    return {};
  }
  return {
    learnedAddressLimit: limits.learnedAddressLimit,
    learnedTopicGroupLimit: limits.learnedTopicGroupLimit,
    learnedRangeLimit: limits.learnedRangeLimit,
    relaxAfterCleanReads: limits.relaxAfterCleanReads,
  };
}

const emptySummary: BscRpcErrorSummary = Object.freeze({
  errorClass: "Unknown",
  rpcStatus: null,
  rpcCode: null,
  rpcUrlHost: null,
  method: null,
});

export function infrastructureBackoffEvent(
  lane: BscIndexerLaneName,
  error: unknown,
  consecutiveFailureCount: number,
  retryDelayMs: number,
  limits?: BscLogQueryLimits | null,
): BscIndexerInfrastructureBackoff {
  // The classification runs inside the lane's catch: a hostile error object
  // must never turn the backoff itself into a thrown TypeError, which would
  // take every lane down with this one.
  let summary: BscRpcErrorSummary;
  try {
    summary = summarizeRpcError(error);
  } catch {
    summary = emptySummary;
  }
  return Object.freeze({
    reasonCode: "bsc_indexer_unavailable" as const,
    lane,
    consecutiveFailureCount,
    retryDelayMs,
    ...summary,
    ...limitFields(limits),
  });
}

/**
 * Reason codes for which an `unavailable` tick means the Provider refused
 * the read: the lane backs off exponentially (same schedule as the retry
 * loop) instead of re-issuing the whole narrowing walk every idle period.
 */
const refusalReasonCodes = new Set<string>([
  bscLogQueryRejectedReasonCode,
  bscLogQueryBudgetExhaustedReasonCode,
]);

export function unavailableDelayMs(
  reasonCode: string | null,
  consecutiveRefusals: number,
): number {
  return reasonCode !== null && refusalReasonCodes.has(reasonCode)
    ? retryDelayMs(consecutiveRefusals)
    : BSC_INDEXER_IDLE_DELAY_MS;
}

export function isRefusalReasonCode(reasonCode: string | null): boolean {
  return reasonCode !== null && refusalReasonCodes.has(reasonCode);
}

/** Dedupe key for the once-per-transition availability log line. */
export function availabilityKey(result: {
  readonly reasonCode: string | null;
  readonly rpcError?: BscRpcErrorSummary;
}): string {
  return [
    result.reasonCode ?? "",
    result.rpcError?.rpcUrlHost ?? "",
    result.rpcError?.rpcCode ?? "",
  ].join("|");
}

export function laneAvailabilityEvent(
  lane: BscIndexerLaneName,
  state: "unavailable" | "recovered",
  reasonCode: string | null,
  rpcError: BscRpcErrorSummary | undefined,
  limits?: BscLogQueryLimits | null,
): BscIndexerLaneAvailabilityEvent {
  return Object.freeze({
    lane,
    state,
    reasonCode,
    errorClass: rpcError?.errorClass ?? null,
    rpcStatus: rpcError?.rpcStatus ?? null,
    rpcCode: rpcError?.rpcCode ?? null,
    rpcUrlHost: rpcError?.rpcUrlHost ?? null,
    method: rpcError?.method ?? null,
    ...limitFields(limits),
  });
}

/**
 * Maps a read failure onto the lane's `unavailable` outcome, or `null` when
 * the error is not a classified read failure and must propagate to the retry
 * loop. Both lanes share it so neither can advance past a refused read.
 */
export function unavailableReasonFor(error: unknown): {
  readonly reasonCode: string;
  readonly rpcError?: BscRpcErrorSummary;
} | null {
  if (error instanceof BscChainMismatchError) {
    return { reasonCode: "BSC_CHAIN_ID_MISMATCH" };
  }
  if (error instanceof BscReadUnavailableError) {
    return error.rpcError === null
      ? { reasonCode: error.reasonCode }
      : { reasonCode: error.reasonCode, rpcError: error.rpcError };
  }
  return null;
}

export type BscApprovalCoverageRunKind =
  "aborted" | "covered" | "idle" | "unavailable";

export interface BscApprovalCoverageRunResult {
  readonly kind: BscApprovalCoverageRunKind;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly approvalCount: number;
  readonly reasonCode: string | null;
}

export interface BscIndexerWorker {
  readonly workerId: string;
  readonly lane: typeof BSC_INDEXER_LANE;
  runOnce(signal?: AbortSignal): Promise<BscIndexerRunResult>;
  /**
   * Approval-coverage backfill (S6 finding 4): reads `Approval` logs for one
   * segment *below* the lane's current coverage start, ending at the block
   * just under it, and lowers the coverage start to the segment start. It
   * walks downward so an interrupted backfill leaves coverage contiguous with
   * `lastBlockNumber`. `idle` once coverage already reaches `targetFromBlock`
   * (or the lane has no checkpoint yet: seed it with `runOnce` first).
   */
  backfillApprovalCoverageOnce(
    targetFromBlock: bigint,
    signal?: AbortSignal,
  ): Promise<BscApprovalCoverageRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateBscIndexerWorkerOptions {
  readonly repository: BscIndexerRepository;
  readonly registry: ChainRegistryRepository;
  /** Active LOOP wallets the lane filters on (Decision 0075). */
  readonly walletSet: BscIndexerWalletSetRepository;
  /** Wallets per topic OR array; defaults to `defaultBscWalletTopicChunkSize`. */
  readonly walletTopicChunkSize?: number;
  readonly readClient: BscReadClient;
  readonly chainId: string;
  /** Block to seed a brand-new lane from; `null` starts near the head. */
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
): BscIndexerRunResult {
  return Object.freeze({
    kind,
    fromBlockNumber: null,
    toBlockNumber: null,
    transferCount: 0,
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

export function retryDelayMs(consecutiveFailureCount: number): number {
  return Math.min(
    BSC_INDEXER_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    BSC_INDEXER_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The wallet filter of one tick: distinct lowercase addresses, sorted so the
 * topic chunks are stable between ticks.
 */
export function normalizeWalletSet(
  addresses: readonly string[],
): readonly string[] {
  return Object.freeze(
    [...new Set(addresses.map((address) => address.toLowerCase()))].sort(),
  );
}

export function createBscIndexerWorker(
  options: CreateBscIndexerWorkerOptions,
): BscIndexerWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = createUuid();
  const topicChunkSize =
    options.walletTopicChunkSize ?? defaultBscWalletTopicChunkSize;
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
    const wallets = normalizeWalletSet(
      await options.walletSet.listActiveWalletAddresses(),
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

    // A refused or unreachable read is the lane's `unavailable` outcome, not
    // a retry-loop failure (Decision 0068); nothing is committed for it.
    // With no active wallet there is nothing to read or store: the segment
    // is committed empty so the checkpoint keeps pace with the chain, and a
    // wallet that appears later is covered from its first tick on.
    let logs: readonly BscTransferLog[] = [];
    let approvalLogs: readonly BscApprovalLog[] = [];
    try {
      if (wallets.length > 0) {
        const walletFilter = {
          walletAddresses: wallets,
          topicChunkSize,
        };
        logs = await options.readClient.readTransferLogs({
          addresses: tokens.map((token) => token.address),
          fromBlock,
          toBlock,
          walletFilter,
        });
        // Approval logs are read for the same addresses, wallets, and range
        // and committed under the same checkpoint (Decision 0035), so the
        // approvals inventory can never be ahead of or behind the transfer
        // history.
        approvalLogs = await options.readClient.readApprovalLogs({
          addresses: tokens.map((token) => token.address),
          fromBlock,
          toBlock,
          walletFilter,
        });
      }
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

    const approvals = approvalInputs(approvalLogs);

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
      // Approval logs for [fromBlock, toBlock] are in this commit, so
      // coverage extends down to fromBlock (or stays lower).
      approvalCoverageFromBlockNumber: fromBlock.toString(10),
      ...(rewindFrom === null
        ? {}
        : { rewindFromBlockNumber: rewindFrom.toString(10) }),
      // A wallet new to the filter is covered from this segment's first block
      // (Decision 0075); the row commits with the checkpoint or not at all.
      walletCoverage: {
        addresses: wallets,
        fromBlockNumber: fromBlock.toString(10),
      },
    });

    return Object.freeze({
      kind: wallets.length === 0 ? "idle" : kind,
      fromBlockNumber: fromBlock.toString(10),
      toBlockNumber: toBlock.toString(10),
      transferCount: transfers.length,
      reasonCode: wallets.length === 0 ? BSC_INDEXER_WALLET_SET_EMPTY : null,
    });
  }

  function approvalInputs(
    approvalLogs: readonly BscApprovalLog[],
  ): IndexedApprovalInput[] {
    return approvalLogs.map((log) => ({
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber.toString(10),
      blockHash: log.blockHash,
      assetId: assetIdForAddress(options.chainId, log.address),
      ownerAddress: log.owner,
      spenderAddress: log.spender,
      rawValue: log.value.toString(10),
    }));
  }

  async function backfillApprovalCoverageOnce(
    targetFromBlock: bigint,
    signal?: AbortSignal,
  ): Promise<BscApprovalCoverageRunResult> {
    const coverageIdle = (
      kind: BscApprovalCoverageRunKind,
      reasonCode: string | null,
    ): BscApprovalCoverageRunResult =>
      Object.freeze({
        kind,
        fromBlockNumber: null,
        toBlockNumber: null,
        approvalCount: 0,
        reasonCode,
      });
    if (targetFromBlock < 0n) {
      return coverageIdle("idle", "APPROVAL_COVERAGE_TARGET_INVALID");
    }
    const assets = await options.registry.listReadableAssets(options.chainId);
    const tokens = assets.filter(
      (asset): asset is typeof asset & { address: string } =>
        asset.address !== null,
    );
    if (tokens.length === 0) {
      return coverageIdle("idle", "ASSET_REGISTRY_EMPTY");
    }
    // The backfill is wallet-scoped like the lane (Decision 0075): it reads
    // `owner ∈ W` for today's wallet set and never the whole token history.
    const wallets = normalizeWalletSet(
      await options.walletSet.listActiveWalletAddresses(),
    );
    if (wallets.length === 0) {
      return coverageIdle("idle", BSC_INDEXER_WALLET_SET_EMPTY);
    }
    const checkpoint = await options.repository.getCheckpoint(
      BSC_INDEXER_LANE,
      options.chainId,
    );
    if (checkpoint === null) {
      return coverageIdle("idle", "APPROVAL_COVERAGE_LANE_NOT_SEEDED");
    }
    // Coverage is contiguous up to lastBlockNumber; with no coverage at all
    // the first block still uncovered is lastBlockNumber itself.
    const uncoveredEnd =
      checkpoint.approvalCoverageFromBlockNumber === null
        ? BigInt(checkpoint.lastBlockNumber)
        : BigInt(checkpoint.approvalCoverageFromBlockNumber) - 1n;
    if (uncoveredEnd < targetFromBlock) {
      return coverageIdle("idle", "APPROVAL_COVERAGE_SATISFIED");
    }
    const toBlock = uncoveredEnd;
    const lowest = toBlock - bscMaximumLogRange + 1n;
    const fromBlock = lowest > targetFromBlock ? lowest : targetFromBlock;
    let approvalLogs;
    try {
      approvalLogs = await options.readClient.readApprovalLogs({
        addresses: tokens.map((token) => token.address),
        fromBlock,
        toBlock,
        walletFilter: { walletAddresses: wallets, topicChunkSize },
      });
    } catch (error) {
      const unavailable = unavailableReasonFor(error);
      if (unavailable !== null) {
        return coverageIdle("unavailable", unavailable.reasonCode);
      }
      throw error;
    }
    if (isAborted(signal)) {
      return coverageIdle("aborted", null);
    }
    const approvals = approvalInputs(approvalLogs);
    await options.repository.commitApprovalCoverageSegment({
      chainId: options.chainId,
      approvals,
      fromBlockNumber: fromBlock.toString(10),
      toBlockNumber: toBlock.toString(10),
    });
    return Object.freeze({
      kind: "covered",
      fromBlockNumber: fromBlock.toString(10),
      toBlockNumber: toBlock.toString(10),
      approvalCount: approvals.length,
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
    backfillApprovalCoverageOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The BSC indexer lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      let consecutiveRefusals = 0;
      let unavailableKey: string | null = null;
      try {
        while (!isAborted(signal)) {
          try {
            const result = await runOnce(signal);
            consecutiveFailures = 0;
            if (result.kind === "unavailable") {
              const key = availabilityKey(result);
              if (key !== unavailableKey) {
                unavailableKey = key;
                options.onLaneAvailability?.(
                  laneAvailabilityEvent(
                    BSC_INDEXER_LANE,
                    "unavailable",
                    result.reasonCode,
                    result.rpcError,
                    logQueryLimitsOf(options.readClient),
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
                  BSC_INDEXER_LANE,
                  "recovered",
                  null,
                  undefined,
                  logQueryLimitsOf(options.readClient),
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
                BSC_INDEXER_LANE,
                error,
                consecutiveFailures,
                delay,
                logQueryLimitsOf(options.readClient),
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
