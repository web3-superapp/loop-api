import { randomUUID } from "node:crypto";

import {
  BSC_INDEXER_IDLE_DELAY_MS,
  behindBlocksOf,
  retryDelayMs,
  unavailableReasonFor,
  type BscIndexerRunKind,
} from "./bsc-indexer-worker.js";
import type { LaunchChainId } from "./features/chain/chain-contract.js";
import {
  launchEventLane,
  type LaunchChainRepository,
  type LaunchIndexedEventInput,
  type LaunchRegisteredSale,
  type LaunchStateProjectionInput,
} from "./features/launch/launch-chain-repository.js";
import { launchContractReasonCodes } from "./features/launch/launch-contract.js";
import {
  bscLogArchiveRequiredReasonCode,
  classifyLogQueryError,
  summarizeRpcError,
  type BscReadClient,
  type BscRpcErrorSummary,
} from "./integrations/bsc/rpc-client.js";
import {
  LaunchContractUnavailableError,
  isZeroBytes32,
  launchContractMaximumLogRange,
  type LaunchContractAdapter,
  type LaunchContractEvent,
} from "./integrations/launch/launch-contract-adapter.js";

/**
 * The `launch_event` indexer lane (Decision 0077).
 *
 * It reads only the logs of `LAUNCH_CONTRACT_ADDRESS` on the launch chain
 * slot, from `LAUNCH_CONTRACT_START_BLOCK`, decodes them with the ABI v1
 * adapter, and keeps only events whose `saleId` is registered in
 * `launches.sale_id` for the configured contract and version. It owns its
 * checkpoint row `(launch_event, <launch chain>)` and runs the Decision 0034
 * state machine (seed → advance → reorg rewind by the slot's reorg depth).
 * At the end of every segment it calls `getState` once per registered sale
 * at the segment's last block: the four axes and `stateTupleDigest` come
 * from there, never from the events.
 */

export const LAUNCH_INDEXER_LANE = launchEventLane;
export const LAUNCH_SALE_UNREGISTERED = "LAUNCH_SALE_UNREGISTERED" as const;

export interface LaunchIndexerRunResult {
  readonly kind: BscIndexerRunKind;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly eventCount: number;
  readonly projectedSaleCount: number;
  readonly reasonCode: string | null;
  /** `BSC_LOG_ARCHIVE_REQUIRED` only: head − fromBlock (Decision 0079, S82d). */
  readonly behindBlocks?: number;
  /**
   * Decision 0085: the Provider error behind an `unavailable` outcome,
   * classified by `summarizeRpcError` (class, status, code, host, method;
   * never a URL, a body, or a key). Absent when no Provider error exists.
   */
  readonly rpcError?: BscRpcErrorSummary;
}

/** What `onUnavailable` receives besides the reason code. */
export interface LaunchIndexerUnavailableDetail {
  readonly behindBlocks?: number;
  readonly errorClass?: string;
  readonly rpcStatus?: number | null;
  readonly rpcCode?: number | null;
  readonly rpcUrlHost?: string | null;
  readonly method?: string | null;
}

export interface LaunchIndexerWarning {
  readonly reasonCode:
    | typeof LAUNCH_SALE_UNREGISTERED
    | "LAUNCH_EVENT_UNRECOGNIZED"
    | "LAUNCH_STATE_PROJECTION_SKIPPED";
  /** Decimal string, when the warning concerns one sale. */
  readonly saleId: string | null;
  readonly blockNumber: string;
  readonly detailReasonCode: string | null;
}

export interface LaunchIndexerWorker {
  readonly workerId: string;
  readonly lane: typeof LAUNCH_INDEXER_LANE;
  runOnce(signal?: AbortSignal): Promise<LaunchIndexerRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateLaunchIndexerWorkerOptions {
  readonly repository: LaunchChainRepository;
  /** The launch chain slot's read client (head, block hashes, confirmations). */
  readonly readClient: BscReadClient;
  readonly adapter: LaunchContractAdapter;
  readonly chainId: LaunchChainId;
  readonly createUuid?: () => string;
  readonly onWarning?: (warning: LaunchIndexerWarning) => void;
  readonly onUnavailable?: (
    reasonCode: string,
    detail?: LaunchIndexerUnavailableDetail,
  ) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: typeof LAUNCH_INDEXER_LANE;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}

function result(
  kind: BscIndexerRunKind,
  reasonCode: string | null,
  extra: Partial<LaunchIndexerRunResult> = {},
): LaunchIndexerRunResult {
  return Object.freeze({
    kind,
    fromBlockNumber: null,
    toBlockNumber: null,
    eventCount: 0,
    projectedSaleCount: 0,
    reasonCode,
    ...extra,
  });
}

function rpcErrorOf(refused: {
  readonly rpcError?: BscRpcErrorSummary;
}): Partial<LaunchIndexerRunResult> {
  return refused.rpcError === undefined ? {} : { rpcError: refused.rpcError };
}

/**
 * The fields logged with an `unavailable` outcome (Decision 0085): the same
 * names as the BSC lane's "LOOP BSC indexer lane is unavailable" line.
 */
function unavailableDetailOf(
  outcome: LaunchIndexerRunResult,
): LaunchIndexerUnavailableDetail | null {
  if (outcome.behindBlocks === undefined && outcome.rpcError === undefined) {
    return null;
  }
  return Object.freeze({
    ...(outcome.behindBlocks === undefined
      ? {}
      : { behindBlocks: outcome.behindBlocks }),
    ...(outcome.rpcError === undefined
      ? {}
      : {
          errorClass: outcome.rpcError.errorClass,
          rpcStatus: outcome.rpcError.rpcStatus,
          rpcCode: outcome.rpcError.rpcCode,
          rpcUrlHost: outcome.rpcError.rpcUrlHost,
          method: outcome.rpcError.method,
        }),
  });
}

function walletOf(event: LaunchContractEvent): string | null {
  switch (event.eventName) {
    case "Purchased": {
      return event.buyer;
    }
    case "RefundLiabilityFrozen":
    case "Refunded":
    case "Claimed": {
      return event.wallet;
    }
    default: {
      return null;
    }
  }
}

/**
 * The storage payload of one event: the 06 §3 argument names, bigints as
 * decimal strings, addresses and bytes32 lowercase, enums by 06 §2 name.
 */
export function launchEventPayload(
  event: LaunchContractEvent,
): Readonly<Record<string, string>> {
  const omitted = new Set([
    "eventName",
    "saleId",
    "address",
    "blockNumber",
    "blockHash",
    "transactionHash",
    "logIndex",
    "removed",
  ]);
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(event)) {
    if (omitted.has(key)) {
      continue;
    }
    payload[key] =
      typeof value === "bigint" || typeof value === "number"
        ? value.toString(10)
        : String(value);
  }
  return Object.freeze(payload);
}

export function toLaunchIndexedEvent(
  event: LaunchContractEvent,
  launchId: string,
): LaunchIndexedEventInput {
  return Object.freeze({
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber.toString(10),
    blockHash: event.blockHash,
    contractAddress: event.address,
    saleId: event.saleId.toString(10),
    launchId,
    eventName: event.eventName,
    walletAddress: walletOf(event),
    payload: launchEventPayload(event),
    removed: event.removed,
  });
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
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

export function createLaunchIndexerWorker(
  options: CreateLaunchIndexerWorkerOptions,
): LaunchIndexerWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = createUuid();
  let inFlight: Promise<LaunchIndexerRunResult> | null = null;
  let loopRunning = false;

  async function projectSales(
    sales: readonly LaunchRegisteredSale[],
    snapshot: { readonly blockNumber: bigint; readonly blockHash: string },
  ): Promise<readonly LaunchStateProjectionInput[]> {
    const projections: LaunchStateProjectionInput[] = [];
    for (const sale of sales) {
      try {
        const read = await options.adapter.getState(
          BigInt(sale.saleId),
          snapshot,
        );
        if (isZeroBytes32(read.value.configVersion)) {
          throw new LaunchContractUnavailableError(
            launchContractReasonCodes.saleNotFound,
          );
        }
        projections.push(
          Object.freeze({
            launchId: sale.launchId,
            saleState: read.value.saleState,
            entitlementState: read.value.entitlementState,
            liquidityState: read.value.liquidityState,
            operationalState: read.value.operationalState,
            configVersion: read.value.configVersion,
            stateTupleDigest: read.value.stateTupleDigest,
            snapshotBlockNumber: snapshot.blockNumber.toString(10),
            snapshotBlockHash: snapshot.blockHash,
          }),
        );
      } catch (error) {
        // A sale whose state cannot be read at this block keeps its previous
        // projection (and its older snapshot block); events still commit so
        // a catch-up on a non-archive endpoint is never blocked.
        options.onWarning?.(
          Object.freeze({
            reasonCode: "LAUNCH_STATE_PROJECTION_SKIPPED" as const,
            saleId: sale.saleId,
            blockNumber: snapshot.blockNumber.toString(10),
            detailReasonCode:
              error instanceof LaunchContractUnavailableError
                ? error.reasonCode
                : launchContractReasonCodes.readFailed,
          }),
        );
      }
    }
    return Object.freeze(projections);
  }

  async function execute(
    signal?: AbortSignal,
  ): Promise<LaunchIndexerRunResult> {
    const contract = options.adapter.contract;
    if (contract === null) {
      return result("idle", launchContractReasonCodes.baselinePending);
    }
    const availability = await options.adapter.availability();
    if (availability.status === "unavailable") {
      return result("unavailable", availability.reasonCode);
    }
    let head;
    try {
      head = await options.readClient.getHead();
    } catch (error) {
      const refused = unavailableReasonFor(error);
      if (refused !== null) {
        return result("unavailable", refused.reasonCode, rpcErrorOf(refused));
      }
      throw error;
    }
    if (isAborted(signal)) {
      return result("aborted", null);
    }
    const checkpoint = await options.repository.getCheckpoint(options.chainId);
    const reorgDepth = BigInt(options.readClient.reorgDepthBlocks);
    let fromBlock: bigint;
    let startedFrom: bigint;
    let rewindFrom: bigint | null = null;
    let kind: BscIndexerRunKind = "advanced";
    if (checkpoint === null) {
      fromBlock = contract.startBlock;
      startedFrom = contract.startBlock;
      kind = "seeded";
    } else {
      startedFrom = BigInt(checkpoint.startedFromBlockNumber);
      const lastBlock = BigInt(checkpoint.lastBlockNumber);
      let observedHash: string | null;
      try {
        observedHash = await options.readClient.getBlockHash(lastBlock);
      } catch (error) {
        const refused = unavailableReasonFor(error);
        if (refused !== null) {
          return result("unavailable", refused.reasonCode, rpcErrorOf(refused));
        }
        throw error;
      }
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
      return result("idle", null);
    }
    const maximumTo = fromBlock + launchContractMaximumLogRange - 1n;
    const toBlock = maximumTo < head.blockNumber ? maximumTo : head.blockNumber;

    let decoded;
    try {
      const logs = await options.adapter.readLogs({ fromBlock, toBlock });
      decoded = options.adapter.decodeEvents(logs);
    } catch (error) {
      if (error instanceof LaunchContractUnavailableError) {
        // The adapter keeps the Provider error as the cause: an endpoint
        // that refuses the range as an archive read is reported as such
        // (S82d) instead of a generic read failure.
        const rpcError =
          error.cause === undefined
            ? {}
            : { rpcError: summarizeRpcError(error.cause) };
        if (classifyLogQueryError(error.cause) === "archive") {
          return result("unavailable", bscLogArchiveRequiredReasonCode, {
            behindBlocks: behindBlocksOf(head.blockNumber, fromBlock),
            ...rpcError,
          });
        }
        return result("unavailable", error.reasonCode, rpcError);
      }
      throw error;
    }
    if (isAborted(signal)) {
      return result("aborted", null);
    }
    if (decoded.unrecognized.length > 0) {
      // Reported once per segment; the logs are never guessed at.
      options.onWarning?.(
        Object.freeze({
          reasonCode: "LAUNCH_EVENT_UNRECOGNIZED" as const,
          saleId: null,
          blockNumber: toBlock.toString(10),
          detailReasonCode: null,
        }),
      );
    }

    const sales = await options.repository.listRegisteredSales({
      chainId: options.chainId,
      contractAddress: contract.address,
      contractVersion: contract.version,
    });
    const launchBySale = new Map(
      sales.map((sale) => [sale.saleId, sale.launchId]),
    );
    const events: LaunchIndexedEventInput[] = [];
    const warnedSales = new Set<string>();
    for (const event of decoded.events) {
      const saleId = event.saleId.toString(10);
      const launchId = launchBySale.get(saleId);
      if (launchId === undefined) {
        if (!warnedSales.has(saleId)) {
          warnedSales.add(saleId);
          options.onWarning?.(
            Object.freeze({
              reasonCode: LAUNCH_SALE_UNREGISTERED,
              saleId,
              blockNumber: event.blockNumber.toString(10),
              detailReasonCode: null,
            }),
          );
        }
        continue;
      }
      events.push(toLaunchIndexedEvent(event, launchId));
    }

    let toBlockHash: string | null;
    try {
      toBlockHash =
        toBlock === head.blockNumber
          ? head.blockHash
          : await options.readClient.getBlockHash(toBlock);
    } catch (error) {
      const refused = unavailableReasonFor(error);
      if (refused !== null) {
        return result("unavailable", refused.reasonCode, rpcErrorOf(refused));
      }
      throw error;
    }
    if (toBlockHash === null) {
      return result("unavailable", "BSC_BLOCK_HASH_UNAVAILABLE");
    }
    const projections = await projectSales(sales, {
      blockNumber: toBlock,
      blockHash: toBlockHash,
    });
    const confirmations = BigInt(options.readClient.confirmations);
    const confirmedThrough =
      head.blockNumber >= confirmations ? head.blockNumber - confirmations : 0n;
    await options.repository.commitSegment({
      chainId: options.chainId,
      events,
      projections,
      checkpoint: {
        lastBlockNumber: toBlock.toString(10),
        lastBlockHash: toBlockHash,
        startedFromBlockNumber: startedFrom.toString(10),
      },
      ...(rewindFrom === null
        ? {}
        : { rewindFromBlockNumber: rewindFrom.toString(10) }),
      confirmedThroughBlockNumber: confirmedThrough.toString(10),
    });
    return result(kind, null, {
      fromBlockNumber: fromBlock.toString(10),
      toBlockNumber: toBlock.toString(10),
      eventCount: events.length,
      projectedSaleCount: projections.length,
    });
  }

  function runOnce(signal?: AbortSignal): Promise<LaunchIndexerRunResult> {
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
    lane: LAUNCH_INDEXER_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The Launch indexer lane is already running");
      }
      loopRunning = true;
      let failures = 0;
      let lastUnavailable: string | null = null;
      try {
        while (!signal.aborted) {
          try {
            const outcome = await runOnce(signal);
            failures = 0;
            const idleReason =
              outcome.kind === "unavailable" || outcome.kind === "idle"
                ? outcome.reasonCode
                : null;
            if (idleReason !== null && idleReason !== lastUnavailable) {
              const detail = unavailableDetailOf(outcome);
              if (detail === null) {
                options.onUnavailable?.(idleReason);
              } else {
                options.onUnavailable?.(idleReason, detail);
              }
            }
            lastUnavailable = idleReason;
            if (outcome.kind !== "advanced" && outcome.kind !== "reorged") {
              await waitFor(BSC_INDEXER_IDLE_DELAY_MS, signal);
            }
          } catch (error) {
            if (isAborted(signal)) {
              break;
            }
            failures += 1;
            const delay = retryDelayMs(failures);
            options.onInfrastructureBackoff?.({
              lane: LAUNCH_INDEXER_LANE,
              consecutiveFailureCount: failures,
              retryDelayMs: delay,
              errorClass: error instanceof Error ? error.name : "UnknownError",
            });
            await waitFor(delay, signal);
          }
        }
      } finally {
        loopRunning = false;
      }
    },
  });
}
