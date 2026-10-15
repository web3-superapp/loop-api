import { waitFor, type PeriodicLane } from "./bsc-meme-indexer-worker.js";
import type { AssetRecord } from "./database/chain-registry-repository.js";
import type {
  WalletNetWorthSnapshotRecord,
  WalletNetWorthSnapshotRepository,
} from "./database/wallet-networth-snapshot-repository.js";
import type { AssetPriceFact } from "./features/market/market-fact-service.js";
import {
  measureWalletNetWorth,
  priceReadFailure,
} from "./features/wallet/wallet-read-service.js";
import type { BscReadClient } from "./integrations/bsc/rpc-client.js";

export const walletNetWorthSnapshotLane = "wallet_networth_snapshot";

/** "Recently active" window of the candidate selection (Decision 0145 §2). */
export const walletNetWorthActiveWindowMs = 30 * 24 * 3_600_000;
/** Wallets measured at the same time inside one batch. */
export const walletNetWorthMeasureConcurrency = 4;
/** A pass starts this long after the slot boundary (at most a tenth of the slot). */
export const walletNetWorthSlotOffsetMs = 30_000;

const retryBaseDelayMs = 1_000;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
const retryMaxDelayMs = 60_000;

export interface WalletNetWorthSnapshotPassResult {
  readonly at: string;
  readonly candidateCount: number;
  readonly writtenCount: number;
  /** Nothing could be valued (no row recorded, never a zero). */
  readonly unvaluedCount: number;
  /** The chain read for the wallet failed. */
  readonly failedCount: number;
  readonly priceReadFailed: boolean;
}

/** Start of the snapshot slot containing `nowMs`. */
export function walletNetWorthSlotStart(
  nowMs: number,
  intervalMs: number,
): number {
  return Math.floor(nowMs / intervalMs) * intervalMs;
}

/**
 * Decision 0145 §2: the `wallet_networth_snapshot` lane (default on,
 * `WALLET_NETWORTH_SNAPSHOT_ENABLED`). Once per slot (`intervalMs`,
 * default one hour, aligned to the epoch so the hourly slot starts on the
 * hour) every active wallet whose owner had a device session, or whose
 * balances were read, in the last 30 days and that has no snapshot for the
 * slot yet is measured with the balances valuation and written with its
 * quality. Prices are read once per pass. A wallet nothing could be valued
 * for, or whose chain read failed, gets no row. A database error backs off
 * 1 s → 60 s and never stops the other lanes.
 */
export function createWalletNetWorthSnapshotLane(options: {
  readonly repository: WalletNetWorthSnapshotRepository;
  readonly listAssets: () => Promise<readonly AssetRecord[]>;
  readonly readPrices: (
    assets: readonly AssetRecord[],
    signal?: AbortSignal,
  ) => Promise<readonly AssetPriceFact[]>;
  readonly readClient: Pick<BscReadClient, "readBalances">;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly now?: () => Date;
  readonly onPass?: (result: WalletNetWorthSnapshotPassResult) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}): PeriodicLane {
  const now = options.now ?? ((): Date => new Date());

  async function pass(
    signal?: AbortSignal,
  ): Promise<WalletNetWorthSnapshotPassResult> {
    const startedMs = now().getTime();
    const at = new Date(
      walletNetWorthSlotStart(startedMs, options.intervalMs),
    ).toISOString();
    const activeSince = new Date(
      startedMs - walletNetWorthActiveWindowMs,
    ).toISOString();
    const assets = await options.listAssets();
    let priceReadFailed = false;
    const prices: readonly AssetPriceFact[] | typeof priceReadFailure =
      await options.readPrices(assets, signal).catch(() => {
        priceReadFailed = true;
        return priceReadFailure;
      });
    let afterWalletId: string | null = null;
    let candidateCount = 0;
    let writtenCount = 0;
    let unvaluedCount = 0;
    let failedCount = 0;
    for (;;) {
      if (signal?.aborted === true) {
        break;
      }
      const candidates = await options.repository.listSnapshotCandidates({
        at,
        activeSince,
        afterWalletId,
        limit: options.batchSize,
      });
      if (candidates.length === 0) {
        break;
      }
      candidateCount += candidates.length;
      const rows: (WalletNetWorthSnapshotRecord & {
        readonly walletId: string;
      })[] = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const candidate = candidates[next];
          next += 1;
          if (candidate === undefined || signal?.aborted === true) {
            return;
          }
          try {
            const measured = await measureWalletNetWorth({
              readClient: options.readClient,
              address: candidate.address,
              assets,
              prices,
            });
            if (measured === null) {
              unvaluedCount += 1;
              continue;
            }
            rows.push({
              walletId: candidate.walletId,
              at,
              netWorthUsd: measured.netWorthUsd,
              quality: measured.quality,
            });
          } catch {
            failedCount += 1;
          }
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              walletNetWorthMeasureConcurrency,
              candidates.length,
            ),
          },
          () => worker(),
        ),
      );
      writtenCount += await options.repository.recordSnapshots(rows);
      afterWalletId = candidates.at(-1)?.walletId ?? null;
      if (candidates.length < options.batchSize) {
        break;
      }
    }
    return Object.freeze({
      at,
      candidateCount,
      writtenCount,
      unvaluedCount,
      failedCount,
      priceReadFailed,
    });
  }

  const tick = async (
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const result = await pass(signal);
    options.onPass?.(result);
    return { ...result };
  };

  /** Until the next slot boundary plus the offset. */
  function delayToNextSlot(): number {
    const nowMs = now().getTime();
    const offset = Math.min(
      walletNetWorthSlotOffsetMs,
      Math.floor(options.intervalMs / 10),
    );
    const nextSlot =
      walletNetWorthSlotStart(nowMs, options.intervalMs) + options.intervalMs;
    return Math.max(nextSlot + offset - nowMs, 1_000);
  }

  return Object.freeze({
    lane: walletNetWorthSnapshotLane,
    runOnce: tick,
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!signal.aborted) {
        try {
          await tick(signal);
          failures = 0;
          await waitFor(delayToNextSlot(), signal);
        } catch (error) {
          if (isAborted(signal)) break;
          failures += 1;
          const delay = Math.min(
            retryBaseDelayMs * 2 ** (failures - 1),
            retryMaxDelayMs,
          );
          options.onInfrastructureBackoff?.({
            lane: walletNetWorthSnapshotLane,
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
