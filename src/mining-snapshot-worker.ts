import { randomUUID } from "node:crypto";

import type {
  AssetRecord,
  ChainRegistryRepository,
} from "./database/chain-registry-repository.js";
import type { AssetPriceFact } from "./features/market/market-fact-service.js";
import { miningReasonCodes } from "./features/mining/mining-contract.js";
import type { MiningRepository } from "./features/mining/mining-repository.js";
import {
  computeMiningSnapshot,
  type MiningPriceInput,
  type MiningSnapshotSkip,
} from "./features/mining/mining-snapshot.js";

/**
 * The `mining-snapshot` lane (Decisions 0036 and 0043), default off behind
 * `MINING_SNAPSHOT_ENABLED` in the standalone worker process; the same
 * `runOnce` is what `pnpm mining:snapshot --confirm` executes once.
 *
 * Each tick reads the approved formula version. Without one the lane is
 * idle (`MINING_FORMULA_BASELINE_PENDING`) and touches nothing else. With
 * one it gathers the latest observed balances, reads a *fresh* reference
 * price per formula-weighted asset, the community weight state of every
 * bound community under that version, computes the snapshot through the
 * pure `computeMiningSnapshot`, and writes it. It never settles a reward,
 * never claims, and never estimates a price.
 */

export const MINING_SNAPSHOT_LANE = "mining-snapshot" as const;
export const MINING_SNAPSHOT_IDLE_DELAY_MS = 300_000;
export const MINING_SNAPSHOT_RETRY_BASE_DELAY_MS = 1_000;
export const MINING_SNAPSHOT_RETRY_MAX_DELAY_MS = 300_000;

export type MiningSnapshotRunKind = "aborted" | "idle" | "snapshotted";

export interface MiningSnapshotRunResult {
  readonly kind: MiningSnapshotRunKind;
  readonly reasonCode: string | null;
  readonly snapshotId: string | null;
  readonly powerRowCount: number;
  readonly skipped: readonly MiningSnapshotSkip[];
}

export interface MiningSnapshotInfrastructureBackoff {
  readonly reasonCode: "mining_snapshot_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface MiningSnapshotWorker {
  readonly workerId: string;
  readonly lane: typeof MINING_SNAPSHOT_LANE;
  runOnce(signal?: AbortSignal): Promise<MiningSnapshotRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

/** The only price read the lane performs: a fresh reference price per asset. */
export interface MiningPriceReader {
  readAssetPrice(
    asset: Pick<AssetRecord, "address" | "status">,
    options: { readonly requireFresh: true },
  ): Promise<AssetPriceFact>;
}

export interface CreateMiningSnapshotWorkerOptions {
  readonly repository: MiningRepository;
  readonly registry: Pick<ChainRegistryRepository, "listAssets">;
  readonly prices: MiningPriceReader;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: MiningSnapshotInfrastructureBackoff,
  ) => void;
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
    MINING_SNAPSHOT_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    MINING_SNAPSHOT_RETRY_MAX_DELAY_MS,
  );
}

function idle(reasonCode: string, skipped: readonly MiningSnapshotSkip[] = []) {
  return Object.freeze({
    kind: "idle" as const,
    reasonCode,
    snapshotId: null,
    powerRowCount: 0,
    skipped: Object.freeze([...skipped]),
  });
}

export function createMiningSnapshotWorker(
  options: CreateMiningSnapshotWorkerOptions,
): MiningSnapshotWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const workerId = createUuid();
  let inFlight: Promise<MiningSnapshotRunResult> | null = null;
  let loopRunning = false;

  async function execute(
    signal?: AbortSignal,
  ): Promise<MiningSnapshotRunResult> {
    const formula = await options.repository.getApprovedFormula();
    if (formula === null) {
      return idle(miningReasonCodes.formulaBaselinePending);
    }
    if (isAborted(signal)) {
      return Object.freeze({
        kind: "aborted" as const,
        reasonCode: null,
        snapshotId: null,
        powerRowCount: 0,
        skipped: Object.freeze([]),
      });
    }
    const [balances, communityWeights] = await Promise.all([
      options.repository.listBalanceInputs(),
      options.repository.listCommunityWeightInputs(formula.configVersion),
    ]);
    if (balances.length === 0) {
      return idle(miningReasonCodes.noBalanceInputs);
    }
    // Only assets the formula weights can enter a snapshot (a community
    // weight is a second factor, never a weight of its own), so only those
    // need a price read.
    const weightedAssetIds = new Set<string>(
      Object.keys(formula.formula.assetWeights),
    );
    const candidateAssetIds = [
      ...new Set(balances.map((balance) => balance.assetId)),
    ].filter((assetId) => weightedAssetIds.has(assetId));
    const assets = await options.registry.listAssets(candidateAssetIds);
    const prices: MiningPriceInput[] = [];
    for (const asset of assets) {
      if (isAborted(signal)) {
        break;
      }
      const { fact, pair, proxyAsset } = await options.prices.readAssetPrice(
        asset,
        { requireFresh: true },
      );
      // A proxied (native) price is refused: the lane never substitutes an
      // asset. The reference price is the deepest base pair's USD price.
      const usable = fact.quality === "fresh" && proxyAsset === null;
      prices.push({
        assetId: asset.assetId,
        priceUsd: usable ? (pair?.priceUsd ?? null) : null,
        quality: usable
          ? "fresh"
          : fact.quality === "fresh"
            ? "proxied"
            : fact.quality,
        fetchedAt: fact.fetchedAt,
        source: fact.source,
      });
    }
    const computation = computeMiningSnapshot(
      { balances, prices, communityWeights },
      { configVersion: formula.configVersion, document: formula.formula },
    );
    if (computation.kind === "unavailable") {
      return idle(computation.reasonCode, computation.skipped);
    }
    const snapshot = await options.repository.writeSnapshot({
      snapshotId: createUuid(),
      blockNumber: computation.blockNumber,
      blockHash: computation.blockHash,
      formulaVersion: computation.formulaVersion,
      priceVersion: computation.priceVersion,
      totalPower: computation.totalPower,
      powers: computation.powers,
    });
    return Object.freeze({
      kind: "snapshotted" as const,
      reasonCode: null,
      snapshotId: snapshot.snapshotId,
      powerRowCount: computation.powers.length,
      skipped: computation.skipped,
    });
  }

  function runOnce(signal?: AbortSignal): Promise<MiningSnapshotRunResult> {
    if (inFlight !== null) {
      return inFlight;
    }
    const promise = execute(signal).finally(() => {
      inFlight = null;
    });
    inFlight = promise;
    return promise;
  }

  async function run(signal: AbortSignal): Promise<void> {
    if (loopRunning) {
      throw new Error("Mining snapshot worker loop is already running");
    }
    loopRunning = true;
    let consecutiveFailureCount = 0;
    try {
      while (!signal.aborted) {
        try {
          await runOnce(signal);
          consecutiveFailureCount = 0;
          await waitFor(MINING_SNAPSHOT_IDLE_DELAY_MS, signal);
        } catch {
          consecutiveFailureCount += 1;
          const delay = retryDelayMs(consecutiveFailureCount);
          options.onInfrastructureBackoff?.({
            reasonCode: "mining_snapshot_unavailable",
            consecutiveFailureCount,
            retryDelayMs: delay,
          });
          await waitFor(delay, signal);
        }
      }
    } finally {
      loopRunning = false;
    }
  }

  return Object.freeze({ workerId, lane: MINING_SNAPSHOT_LANE, runOnce, run });
}
