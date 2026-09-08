import { randomUUID } from "node:crypto";

import type {
  AlertV2Repository,
  PriceAlertV2Record,
  TriggerNotificationInput,
} from "./database/alert-v2-repository.js";
import type { ChainRegistryRepository } from "./database/chain-registry-repository.js";
import type { NotificationRepository } from "./database/notification-repository.js";
import { priceAlertContextRoute } from "./features/alerts/notification-contract.js";
import {
  bscWrappedNativeAddress,
  compareDecimalStrings,
} from "./features/market/market-contract.js";
import type { MarketFactService } from "./features/market/market-fact-service.js";

/**
 * The `alert_evaluator` lane (Decision 0034), default off behind
 * `ALERT_EVALUATOR_ENABLED` in the standalone worker process.
 *
 * Each tick reads every active V2 alert, groups them by asset, and reads one
 * price fact per asset with `requireFresh`. Only a `fresh` DexScreener price
 * can trigger an alert: a stale cache row, a throttled Provider, or a
 * missing pair skips the asset for this tick and records nothing. A trigger
 * writes the append-only event, flips the alert to `triggered`, and inserts
 * one context notification whose dedupe key collapses repeats inside the
 * configured window. Push delivery does not exist here or anywhere else.
 */

export const ALERT_EVALUATOR_LANE = "alert_evaluator" as const;
export const ALERT_EVALUATOR_IDLE_DELAY_MS = 30_000;
export const ALERT_EVALUATOR_RETRY_BASE_DELAY_MS = 1_000;
export const ALERT_EVALUATOR_RETRY_MAX_DELAY_MS = 60_000;
export const ALERT_EVALUATOR_BATCH_LIMIT = 500;

export type AlertEvaluatorRunKind = "aborted" | "evaluated" | "idle";

export interface AlertEvaluatorRunResult {
  readonly kind: AlertEvaluatorRunKind;
  readonly evaluatedCount: number;
  readonly triggeredCount: number;
  readonly skippedCount: number;
  /** Reason codes of skipped assets, one per asset, for the log line. */
  readonly skippedReasonCodes: readonly string[];
}

export interface AlertEvaluatorInfrastructureBackoff {
  readonly reasonCode: "alert_evaluator_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface AlertEvaluatorWorker {
  readonly workerId: string;
  readonly lane: typeof ALERT_EVALUATOR_LANE;
  runOnce(signal?: AbortSignal): Promise<AlertEvaluatorRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateAlertEvaluatorWorkerOptions {
  readonly alerts: AlertV2Repository;
  readonly notifications: NotificationRepository;
  readonly registry: ChainRegistryRepository;
  readonly facts: MarketFactService;
  readonly notificationDedupeSeconds: number;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
  readonly onInfrastructureBackoff?: (
    event: AlertEvaluatorInfrastructureBackoff,
  ) => void;
}

export function conditionSatisfied(
  condition: PriceAlertV2Record["condition"],
  observed: string,
  threshold: string,
): boolean {
  const comparison = compareDecimalStrings(observed, threshold);
  switch (condition) {
    case "above": {
      return comparison > 0;
    }
    case "at_or_above": {
      return comparison >= 0;
    }
    case "below": {
      return comparison < 0;
    }
    case "at_or_below": {
      return comparison <= 0;
    }
  }
}

export function priceAlertDedupeKey(
  alertId: string,
  observedAt: string,
  dedupeSeconds: number,
): string {
  const windowMs = dedupeSeconds * 1_000;
  const bucket = Math.floor(Date.parse(observedAt) / windowMs);
  return `trade.priceAlert:${alertId}:${String(bucket)}`;
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
    ALERT_EVALUATOR_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailureCount - 1),
    ALERT_EVALUATOR_RETRY_MAX_DELAY_MS,
  );
}

export function createAlertEvaluatorWorker(
  options: CreateAlertEvaluatorWorkerOptions,
): AlertEvaluatorWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const now = options.now ?? ((): Date => new Date());
  const workerId = createUuid();
  let inFlight: Promise<AlertEvaluatorRunResult> | null = null;
  let loopRunning = false;

  async function execute(
    signal?: AbortSignal,
  ): Promise<AlertEvaluatorRunResult> {
    let evaluatedCount = 0;
    let triggeredCount = 0;
    let skippedCount = 0;
    const skippedReasonCodes: string[] = [];
    const evaluatedIds: string[] = [];
    /** Every alert this tick already handled, so paging reaches exhaustion. */
    const handledIds: string[] = [];
    let batches = 0;

    for (;;) {
      const alerts = await options.alerts.listEvaluable({
        limit: ALERT_EVALUATOR_BATCH_LIMIT,
        excludeIds: handledIds,
      });
      if (alerts.length === 0) {
        break;
      }
      batches += 1;
      const byAsset = new Map<string, PriceAlertV2Record[]>();
      for (const alert of alerts) {
        handledIds.push(alert.alertId);
        const list = byAsset.get(alert.assetId) ?? [];
        list.push(alert);
        byAsset.set(alert.assetId, list);
      }

      for (const [assetId, group] of byAsset) {
        if (isAborted(signal)) {
          return Object.freeze({
            kind: "aborted",
            evaluatedCount,
            triggeredCount,
            skippedCount,
            skippedReasonCodes: Object.freeze(skippedReasonCodes),
          });
        }
        const asset = await options.registry.getAsset(assetId);
        if (asset === null || asset.status === "blocked") {
          skippedCount += group.length;
          skippedReasonCodes.push("ASSET_NOT_READABLE");
          continue;
        }
        // The native asset is evaluated through its proxy price (WBNB).
        const { fact, pair, proxyAsset } = await options.facts.readAssetPrice(
          asset,
          { requireFresh: true },
        );
        if (
          fact.quality !== "fresh" ||
          fact.value === null ||
          fact.fetchedAt === null
        ) {
          skippedCount += group.length;
          skippedReasonCodes.push(fact.reasonCode ?? "MARKET_FACT_NOT_FRESH");
          continue;
        }
        if (pair === null || pair.priceUsd === null) {
          skippedCount += group.length;
          skippedReasonCodes.push("MARKET_PAIR_NOT_FOUND");
          continue;
        }
        const observed = pair.priceUsd;
        const observedAt = fact.fetchedAt;
        const sourceFactRef =
          proxyAsset === null
            ? `dexscreener:${pair.pairAddress}`
            : `dexscreener:${pair.pairAddress}:proxy:${bscWrappedNativeAddress}`;

        for (const alert of group) {
          evaluatedCount += 1;
          if (!conditionSatisfied(alert.condition, observed, alert.threshold)) {
            evaluatedIds.push(alert.alertId);
            continue;
          }
          const enabled = await options.notifications.isCategoryEnabled(
            alert.ownerUserId,
            "trade.priceAlert",
          );
          const notification: TriggerNotificationInput | null = enabled
            ? Object.freeze({
                type: "trade.priceAlert" as const,
                entityRef: `priceAlert:${alert.alertId}`,
                contextRoute: priceAlertContextRoute,
                contextParams: Object.freeze({ assetId: alert.assetId }),
                payload: Object.freeze({
                  assetId: alert.assetId,
                  symbol: asset.symbol,
                  condition: alert.condition,
                  threshold: alert.threshold,
                  observedValue: observed,
                  source: fact.source,
                  observedAt,
                  proxyAsset,
                }),
                dedupeKey: priceAlertDedupeKey(
                  alert.alertId,
                  observedAt,
                  options.notificationDedupeSeconds,
                ),
              })
            : null;
          const result = await options.alerts.recordTrigger({
            alertId: alert.alertId,
            ownerUserId: alert.ownerUserId,
            valueDecimal: observed,
            source: fact.source,
            sourceFactRef,
            observedAt,
            notification,
          });
          if (result.outcome === "triggered") {
            triggeredCount += 1;
          }
        }
      }
    }

    if (batches === 0) {
      return Object.freeze({
        kind: "idle",
        evaluatedCount: 0,
        triggeredCount: 0,
        skippedCount: 0,
        skippedReasonCodes: Object.freeze([]),
      });
    }
    await options.alerts.markEvaluated(evaluatedIds, now().toISOString());
    return Object.freeze({
      kind: "evaluated",
      evaluatedCount,
      triggeredCount,
      skippedCount,
      skippedReasonCodes: Object.freeze(skippedReasonCodes),
    });
  }

  function runOnce(signal?: AbortSignal): Promise<AlertEvaluatorRunResult> {
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
    lane: ALERT_EVALUATOR_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The alert evaluator lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      try {
        while (!signal.aborted) {
          try {
            await runOnce(signal);
            consecutiveFailures = 0;
            await waitFor(ALERT_EVALUATOR_IDLE_DELAY_MS, signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailures += 1;
            const delay = retryDelayMs(consecutiveFailures);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "alert_evaluator_unavailable",
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
