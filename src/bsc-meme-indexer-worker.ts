import { randomUUID } from "node:crypto";

import {
  BSC_INDEXER_IDLE_DELAY_MS,
  behindBlocksOf,
  retryDelayMs,
  unavailableReasonFor,
  type BscIndexerRunKind,
} from "./bsc-indexer-worker.js";
import type { LaunchChainId } from "./features/chain/chain-contract.js";
import { memeReasonCodes, memeRules } from "./features/meme/meme-contract.js";
import { mineMemeSalts } from "./features/meme/meme-create2.js";
import { memePriceE18 } from "./features/meme/meme-curve-math.js";
import { memeTransactionMatches } from "./features/meme/meme-intent-service.js";
import {
  memeEventLane,
  type MemeIntentReceipt,
  type MemeIntentRecord,
  type MemeLaneEventInput,
  type MemeRepository,
  type MemeSaltScope,
} from "./features/meme/meme-repository.js";
import {
  bscLogArchiveRequiredReasonCode,
  classifyLogQueryError,
  isRpcForbiddenError,
  summarizeRpcError,
  type BscChainCallClient,
  type BscReadClient,
  type BscRpcErrorSummary,
} from "./integrations/bsc/rpc-client.js";
import {
  MemeContractUnavailableError,
  memeContractMaximumLogRange,
  memeContractReasonCodes,
  type MemeContractAdapter,
  type MemeContractEvent,
} from "./integrations/meme/meme-contract-adapter.js";
import type { MemeGraduationSender } from "./integrations/meme/meme-graduation-sender.js";

/**
 * The MEME launchpad worker lanes (Decision 0101), all default-off:
 *
 * - `meme_event`: logs of `MEME_CONTRACT_ADDRESS` on the launch slot from
 *   `MEME_CONTRACT_START_BLOCK`, decoded with the v1 ABI, kept only for
 *   tokens LOOP created (TokenCreated matched by salt + metadata). The
 *   Decision 0034 state machine (seed → advance → reorg rewind by the
 *   slot's reorg depth) over ≤ 2,000-block segments, one checkpoint row
 *   `(meme_event, <launch chain>)`.
 * - salt pool: every 5 minutes, frees reservations of drafts older than
 *   30 minutes and mines CREATE2 salts offline until `MEME_SALT_POOL_TARGET`
 *   free salts end in `MEME_VANITY_SUFFIX`.
 * - receipt reconcile of reported `meme_intents` (the Decision 0080 rules).
 * - graduation fallback executor: a token `full` for 60 s without
 *   `Graduated` gets `graduate(token)` from the deployer key; a failure is
 *   retried every 5 minutes, 10 times at most, then `needs_operator`.
 */

export const MEME_INDEXER_LANE = memeEventLane;

export interface MemeIndexerRunResult {
  readonly kind: BscIndexerRunKind;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly eventCount: number;
  readonly storedCount: number;
  readonly reasonCode: string | null;
  readonly behindBlocks?: number;
  readonly rpcError?: BscRpcErrorSummary;
}

export interface MemeLaneWarning {
  readonly reasonCode:
    | "MEME_EVENTS_IGNORED"
    | "MEME_TOKEN_METADATA_MISMATCH"
    | "MEME_TOKENS_NOT_CREATED_BY_LOOP";
  readonly blockNumber: string;
  readonly count: number;
}

function result(
  kind: BscIndexerRunKind,
  reasonCode: string | null,
  extra: Partial<MemeIndexerRunResult> = {},
): MemeIndexerRunResult {
  return Object.freeze({
    kind,
    fromBlockNumber: null,
    toBlockNumber: null,
    eventCount: 0,
    storedCount: 0,
    reasonCode,
    ...extra,
  });
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

export async function waitFor(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
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

/** Storage form of one decoded event (bigints as decimal strings). */
export function toMemeLaneEvent(event: MemeContractEvent): MemeLaneEventInput {
  const base = {
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber.toString(10),
    blockHash: event.blockHash,
    tokenAddress: event.token,
    removed: event.removed,
  };
  if (event.eventName === "Trade") {
    return Object.freeze({
      ...base,
      kind: "trade" as const,
      wallet: event.wallet,
      isBuy: event.isBuy,
      usd1Amount: event.usd1Amount.toString(10),
      tokenAmount: event.tokenAmount.toString(10),
      feeUsd1: event.feeUsd1.toString(10),
      vUsd1After: event.vUsd1After.toString(10),
      vTokenAfter: event.vTokenAfter.toString(10),
      soldAfter: event.soldAfter.toString(10),
      priceAfterE18: memePriceE18({
        vUsd1: event.vUsd1After,
        vToken: event.vTokenAfter,
      }).toString(10),
      at: event.at.toString(10),
    });
  }
  const omitted = new Set([
    "eventName",
    "address",
    "blockNumber",
    "blockHash",
    "transactionHash",
    "logIndex",
    "removed",
    "token",
  ]);
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!omitted.has(key)) {
      payload[key] =
        typeof value === "bigint" ? value.toString(10) : String(value);
    }
  }
  return Object.freeze({
    ...base,
    kind: "event" as const,
    eventName: event.eventName,
    payload: Object.freeze(payload),
    at: "at" in event ? event.at.toString(10) : null,
  });
}

export interface MemeIndexerWorker {
  readonly workerId: string;
  readonly lane: typeof MEME_INDEXER_LANE;
  runOnce(signal?: AbortSignal): Promise<MemeIndexerRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface InfrastructureBackoffEvent {
  readonly lane: string;
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
  readonly errorClass: string;
}

export interface CreateMemeIndexerWorkerOptions {
  readonly repository: MemeRepository;
  readonly readClient: BscReadClient;
  readonly adapter: MemeContractAdapter;
  readonly chainId: LaunchChainId;
  readonly createUuid?: () => string;
  readonly onWarning?: (warning: MemeLaneWarning) => void;
  readonly onUnavailable?: (
    reasonCode: string,
    detail?: Record<string, unknown>,
  ) => void;
  readonly onInfrastructureBackoff?: (
    event: InfrastructureBackoffEvent,
  ) => void;
}

export function createMemeIndexerWorker(
  options: CreateMemeIndexerWorkerOptions,
): MemeIndexerWorker {
  const workerId = (options.createUuid ?? randomUUID)();
  let inFlight: Promise<MemeIndexerRunResult> | null = null;
  let loopRunning = false;

  async function execute(signal?: AbortSignal): Promise<MemeIndexerRunResult> {
    const contract = options.adapter.contract;
    if (contract === null) {
      return result("idle", memeContractReasonCodes.notConfigured);
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
        return result(
          "unavailable",
          refused.reasonCode,
          refused.rpcError === undefined ? {} : { rpcError: refused.rpcError },
        );
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
          return result("unavailable", refused.reasonCode);
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
    const maximumTo = fromBlock + memeContractMaximumLogRange - 1n;
    const toBlock = maximumTo < head.blockNumber ? maximumTo : head.blockNumber;
    let decoded;
    try {
      const logs = await options.adapter.readLogs({ fromBlock, toBlock });
      decoded = options.adapter.decodeEvents(logs);
    } catch (error) {
      if (error instanceof MemeContractUnavailableError) {
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
    if (decoded.ignored > 0) {
      options.onWarning?.({
        reasonCode: "MEME_EVENTS_IGNORED",
        blockNumber: toBlock.toString(10),
        count: decoded.ignored,
      });
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
        return result("unavailable", refused.reasonCode);
      }
      throw error;
    }
    if (toBlockHash === null) {
      return result("unavailable", "BSC_BLOCK_HASH_UNAVAILABLE");
    }
    const events = decoded.events.map((event) => toMemeLaneEvent(event));
    const committed = await options.repository.commitSegment({
      chainId: options.chainId,
      contractAddress: contract.address,
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
    if (committed.metadataMismatchCount > 0) {
      options.onWarning?.({
        reasonCode: "MEME_TOKEN_METADATA_MISMATCH",
        blockNumber: toBlock.toString(10),
        count: committed.metadataMismatchCount,
      });
    }
    const foreign = committed.skippedCount - committed.metadataMismatchCount;
    if (foreign > 0) {
      options.onWarning?.({
        reasonCode: "MEME_TOKENS_NOT_CREATED_BY_LOOP",
        blockNumber: toBlock.toString(10),
        count: foreign,
      });
    }
    return result(kind, null, {
      fromBlockNumber: fromBlock.toString(10),
      toBlockNumber: toBlock.toString(10),
      eventCount: events.length,
      storedCount: committed.storedCount,
    });
  }

  function runOnce(signal?: AbortSignal): Promise<MemeIndexerRunResult> {
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
    lane: MEME_INDEXER_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The MEME indexer lane is already running");
      }
      loopRunning = true;
      let failures = 0;
      let lastIdle: string | null = null;
      try {
        while (!signal.aborted) {
          try {
            const outcome = await runOnce(signal);
            failures = 0;
            const idleReason =
              outcome.kind === "unavailable" || outcome.kind === "idle"
                ? outcome.reasonCode
                : null;
            if (idleReason !== null && idleReason !== lastIdle) {
              options.onUnavailable?.(idleReason, {
                ...(outcome.behindBlocks === undefined
                  ? {}
                  : { behindBlocks: outcome.behindBlocks }),
                ...(outcome.rpcError === undefined ? {} : outcome.rpcError),
              });
            }
            lastIdle = idleReason;
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
              lane: MEME_INDEXER_LANE,
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

// ---------------------------------------------------------------------------
// Periodic lanes (salt pool, receipt reconcile, graduation executor)
// ---------------------------------------------------------------------------

export interface PeriodicLane {
  readonly lane: string;
  runOnce(signal?: AbortSignal): Promise<Record<string, unknown>>;
  run(signal: AbortSignal): Promise<void>;
}

function periodicLane(
  lane: string,
  intervalMs: number,
  tick: (signal?: AbortSignal) => Promise<Record<string, unknown>>,
  onInfrastructureBackoff?: (event: InfrastructureBackoffEvent) => void,
): PeriodicLane {
  return Object.freeze({
    lane,
    runOnce: tick,
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!signal.aborted) {
        try {
          await tick(signal);
          failures = 0;
          await waitFor(intervalMs, signal);
        } catch (error) {
          if (isAborted(signal)) {
            break;
          }
          failures += 1;
          const delay = Math.max(retryDelayMs(failures), 1_000);
          onInfrastructureBackoff?.({
            lane,
            consecutiveFailureCount: failures,
            retryDelayMs: delay,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
          await waitFor(delay, signal);
        }
      }
    },
  });
}

export const MEME_SALT_POOL_INTERVAL_MS = 5 * 60_000;
/** Draws per slice before the miner yields the event loop (~1–2 s). */
export const MEME_SALT_MINING_SLICE = 20_000;

export function createMemeSaltPoolWorker(options: {
  readonly repository: MemeRepository;
  readonly scope: MemeSaltScope;
  readonly target: number;
  readonly intervalMs?: number;
  /** Slice budget; tests lower it. */
  readonly attemptsPerSlice?: number;
  /** Upper bound of slices per tick, so one tick always ends. */
  readonly maximumSlicesPerTick?: number;
  readonly now?: () => Date;
  readonly onRefilled?: (event: {
    readonly released: number;
    readonly inserted: number;
    readonly free: number;
  }) => void;
  readonly onInfrastructureBackoff?: (
    event: InfrastructureBackoffEvent,
  ) => void;
}): PeriodicLane {
  const now = options.now ?? ((): Date => new Date());
  const attemptsPerSlice = options.attemptsPerSlice ?? MEME_SALT_MINING_SLICE;
  const maximumSlices = options.maximumSlicesPerTick ?? 2_000;
  return periodicLane(
    "meme_salt_pool",
    options.intervalMs ?? MEME_SALT_POOL_INTERVAL_MS,
    async (signal) => {
      const released = await options.repository.releaseStaleSaltReservations(
        new Date(
          now().getTime() - memeRules.saltReservationMinutes * 60_000,
        ).toISOString(),
      );
      let free = await options.repository.countFreeSalts(options.scope);
      let inserted = 0;
      for (
        let slice = 0;
        free < options.target && slice < maximumSlices && !isAborted(signal);
        slice += 1
      ) {
        const mined = mineMemeSalts({
          deployer: options.scope.contractAddress,
          implementation: options.scope.tokenImplementation,
          suffix: options.scope.suffix,
          count: options.target - free,
          maximumAttempts: attemptsPerSlice,
        });
        if (mined.length > 0) {
          const added = await options.repository.insertSalts({
            scope: options.scope,
            salts: mined,
          });
          inserted += added;
          free += added;
        }
        // Yield so the other lanes of this process keep running.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      const event = { released, inserted, free };
      if (released > 0 || inserted > 0) {
        options.onRefilled?.(event);
      }
      return event;
    },
    options.onInfrastructureBackoff,
  );
}

export const MEME_INTENT_RECONCILE_BATCH = 10;
export const MEME_INTENT_RECONCILE_LEASE_MS = 15_000;
export const MEME_INTENT_RECEIPT_GRACE_MS = 5 * 60_000;
export const MEME_INTENT_PENDING_GRACE_MS = 60 * 60_000;
export const MEME_INTENT_RECONCILE_INTERVAL_MS = 5_000;

export interface MemeIntentTransition {
  readonly intentId: string;
  readonly toState: "confirmed" | "failed" | "expired";
  readonly reasonCode: string | null;
}

/**
 * Receipt reconcile of reported MEME Intents (the Decision 0080 rules):
 * an unverified report is checked against the sealed payload; a receipt at
 * the slot's confirmation depth settles it (`0x1` confirmed, `0x0` failed
 * / MEME_TX_REVERTED); no receipt past the deadline plus grace is expired
 * / MEME_TX_NOT_OBSERVED. A failed create returns its token to `draft`;
 * when the salt was taken on chain by someone else (SaltUsed), the next
 * create prepare sees code at the predicted address, marks the salt used,
 * and reserves another. Read-only: never signs.
 */
export function createMemeIntentReconciler(options: {
  readonly repository: MemeRepository;
  readonly readClient: BscChainCallClient;
  readonly chainId: LaunchChainId;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onTransition?: (transition: MemeIntentTransition) => void;
  readonly onReadFailure?: (input: {
    readonly intentId: string;
    readonly reasonCode: string;
  }) => void;
  readonly onInfrastructureBackoff?: (
    event: InfrastructureBackoffEvent,
  ) => void;
}): PeriodicLane {
  const now = options.now ?? ((): Date => new Date());
  const client = options.readClient;

  function past(record: MemeIntentRecord, graceMs: number): boolean {
    return now().getTime() > Date.parse(record.deadline) + graceMs;
  }

  async function decide(
    record: MemeIntentRecord,
    hash: string,
  ): Promise<{
    readonly toState: "confirmed" | "failed" | "expired";
    readonly reasonCode: string | null;
    readonly receipt: MemeIntentReceipt | null;
  } | null> {
    let pending = false;
    if (!record.payloadVerified) {
      const observed = await client.getTransaction(hash);
      if (observed === null) {
        return past(record, MEME_INTENT_RECEIPT_GRACE_MS)
          ? {
              toState: "expired",
              reasonCode: memeReasonCodes.txNotObserved,
              receipt: null,
            }
          : null;
      }
      if (!memeTransactionMatches(observed, record.unsignedTransaction)) {
        return {
          toState: "failed",
          reasonCode: memeReasonCodes.txPayloadMismatch,
          receipt: null,
        };
      }
      await options.repository.markIntentPayloadVerified({
        intentId: record.intentId,
        transactionHash: hash,
      });
      pending = observed.blockNumber === null;
    }
    const receipt = await client.getTransactionReceipt(hash);
    if (receipt === null) {
      if (!past(record, MEME_INTENT_RECEIPT_GRACE_MS)) {
        return null;
      }
      if (!pending && record.payloadVerified) {
        const observed = await client.getTransaction(hash);
        pending = observed !== null && observed.blockNumber === null;
      }
      if (pending && !past(record, MEME_INTENT_PENDING_GRACE_MS)) {
        return null;
      }
      return {
        toState: "expired",
        reasonCode: memeReasonCodes.txNotObserved,
        receipt: null,
      };
    }
    const head = await client.getHead();
    const depth = head.blockNumber - receipt.blockNumber + 1n;
    if (depth < BigInt(client.confirmations)) {
      return null;
    }
    const fact: MemeIntentReceipt = Object.freeze({
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(10),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(10),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(10),
      confirmations: Number(depth),
      observedAt: now().toISOString(),
    });
    return receipt.status === "success"
      ? { toState: "confirmed", reasonCode: null, receipt: fact }
      : {
          toState: "failed",
          reasonCode: memeReasonCodes.txReverted,
          receipt: fact,
        };
  }

  return periodicLane(
    "meme_intent_reconcile",
    options.intervalMs ?? MEME_INTENT_RECONCILE_INTERVAL_MS,
    async (signal) => {
      const leased = await options.repository.leaseReconcilableIntents({
        chainId: options.chainId,
        limit: MEME_INTENT_RECONCILE_BATCH,
        leaseMs: MEME_INTENT_RECONCILE_LEASE_MS,
      });
      const transitions: MemeIntentTransition[] = [];
      for (const record of leased) {
        if (isAborted(signal)) {
          break;
        }
        const hash = record.transactionHash;
        if (hash === null) {
          continue;
        }
        let outcome;
        try {
          outcome = await decide(record, hash);
        } catch (error) {
          options.onReadFailure?.({
            intentId: record.intentId,
            reasonCode: isRpcForbiddenError(error)
              ? "MEME_RPC_RECEIPT_UNAVAILABLE"
              : "MEME_INTENT_RECONCILE_READ_FAILED",
          });
          continue;
        }
        if (outcome === null) {
          continue;
        }
        const settled = await options.repository.settleIntent({
          intentId: record.intentId,
          transactionHash: hash,
          ...outcome,
        });
        if (settled === null) {
          continue;
        }
        const transition = {
          intentId: settled.intentId,
          toState: outcome.toState,
          reasonCode: outcome.reasonCode,
        };
        transitions.push(transition);
        options.onTransition?.(transition);
      }
      return { leased: leased.length, transitions: transitions.length };
    },
    options.onInfrastructureBackoff,
  );
}

export const MEME_GRADUATION_INTERVAL_MS = 15_000;
export const MEME_GRADUATION_FULL_GRACE_MS = 60_000;
export const MEME_GRADUATION_RETRY_MS = 5 * 60_000;
export const MEME_GRADUATION_MAXIMUM_ATTEMPTS = 10;

export interface MemeGraduationEvent {
  readonly memeTokenId: string;
  readonly outcome: "confirmed" | "reverted" | "not_full" | "failed";
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly needsOperator: boolean;
  readonly transactionHash: string | null;
}

/**
 * Graduation fallback (docs/10 §1): tokens `full` for at least 60 s with no
 * `Graduated` log get `graduate(token)`. The `Graduated` log, read by the
 * `meme_event` lane, is the only evidence of graduation; a confirmed
 * transaction here only stops retries.
 */
export function createMemeGraduationExecutor(options: {
  readonly repository: MemeRepository;
  readonly sender: MemeGraduationSender;
  readonly chainId: LaunchChainId;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onAttempt?: (event: MemeGraduationEvent) => void;
  readonly onInfrastructureBackoff?: (
    event: InfrastructureBackoffEvent,
  ) => void;
}): PeriodicLane {
  const now = options.now ?? ((): Date => new Date());
  return periodicLane(
    "meme_graduation_executor",
    options.intervalMs ?? MEME_GRADUATION_INTERVAL_MS,
    async (signal) => {
      const at = now();
      const candidates = await options.repository.listGraduationCandidates({
        chainId: options.chainId,
        fullBefore: new Date(
          at.getTime() - MEME_GRADUATION_FULL_GRACE_MS,
        ).toISOString(),
        now: at.toISOString(),
        limit: 5,
      });
      let attempted = 0;
      for (const candidate of candidates) {
        if (isAborted(signal)) {
          break;
        }
        attempted += 1;
        const outcome = await options.sender.graduate(candidate.tokenAddress);
        const attempts = candidate.graduationAttempts + 1;
        const success =
          outcome.status === "confirmed" || outcome.status === "not_full";
        const errorCode =
          outcome.status === "failed"
            ? outcome.errorCode
            : outcome.status === "reverted"
              ? "MEME_GRADUATE_REVERTED"
              : null;
        const needsOperator =
          !success && attempts >= MEME_GRADUATION_MAXIMUM_ATTEMPTS;
        await options.repository.recordGraduationAttempt({
          memeTokenId: candidate.memeTokenId,
          errorCode,
          // A success waits for the lane's Graduated log; retry later only
          // if that log never comes.
          nextAttemptAt: needsOperator
            ? null
            : new Date(at.getTime() + MEME_GRADUATION_RETRY_MS).toISOString(),
          needsOperator,
        });
        options.onAttempt?.({
          memeTokenId: candidate.memeTokenId,
          outcome: outcome.status,
          attempts,
          errorCode,
          needsOperator,
          transactionHash:
            outcome.status === "confirmed" || outcome.status === "reverted"
              ? outcome.transactionHash
              : null,
        });
      }
      return { candidates: candidates.length, attempted };
    },
    options.onInfrastructureBackoff,
  );
}
