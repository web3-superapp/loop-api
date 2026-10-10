import type { MiningRewardsService } from "./features/mining/hourly-rewards-service.js";
import {
  miningSettlementLane,
  miningSettlementReasonCodes,
} from "./features/mining/hourly-settlement-contract.js";
import type { MiningSettlementRepository } from "./features/mining/hourly-settlement-ports.js";
import type {
  MiningSettleOutcome,
  MiningSettlementRunner,
} from "./features/mining/hourly-settlement-runner.js";

/**
 * Decision 0116: the `mining_hourly_settlement` lane, default off behind
 * `MINING_SETTLEMENT_ENABLED`. Each tick settles the unsettled completed
 * hours of the catch-up window (oldest first, a bounded number per tick)
 * and re-checks open claims against the chain. A hour that is not ready
 * (indexer behind, no parameters) is retried on a later tick; a failed
 * hour keeps its reason and is retried too. It never signs anything.
 */

export interface MiningSettlementLaneEvent {
  readonly hourStart: string;
  readonly outcome: MiningSettleOutcome["kind"];
  readonly reasonCode: string | null;
}

export interface MiningSettlementLane {
  readonly lane: typeof miningSettlementLane;
  runOnce(): Promise<{
    readonly outcomes: readonly MiningSettlementLaneEvent[];
    readonly claimsChecked: number;
  }>;
  run(signal: AbortSignal): Promise<void>;
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMiningSettlementLane(options: {
  readonly runner: MiningSettlementRunner;
  readonly repository: MiningSettlementRepository;
  /** Null keeps claim reconciliation off (no chain / contract). */
  readonly rewards: Pick<MiningRewardsService, "reconcileClaim"> | null;
  readonly pollIntervalMs: number;
  readonly catchupHours: number;
  readonly maxHoursPerTick: number;
  readonly onEvent?: (event: MiningSettlementLaneEvent) => void;
  readonly onError?: (error: unknown) => void;
}): MiningSettlementLane {
  async function runOnce() {
    const outcomes: MiningSettlementLaneEvent[] = [];
    const hours = await options.runner.candidateHours(options.catchupHours);
    let attempts = 0;
    for (const hourStart of hours) {
      if (attempts >= options.maxHoursPerTick) break;
      const outcome = await options.runner.settleHour({
        hourStart,
        trigger: "scheduled",
      });
      const event = Object.freeze({
        hourStart: new Date(Number(hourStart) * 1000).toISOString(),
        outcome: outcome.kind,
        reasonCode:
          outcome.kind === "skipped" || outcome.kind === "failed"
            ? outcome.reasonCode
            : null,
      });
      if (outcome.kind !== "skipped") attempts += 1;
      outcomes.push(event);
      if (outcome.kind !== "already_settled") options.onEvent?.(event);
      // Hours settle in order: a later hour never settles before an
      // earlier one that is waiting on its inputs.
      if (
        outcome.kind === "skipped" &&
        (outcome.reasonCode === miningSettlementReasonCodes.indexerBehind ||
          outcome.reasonCode === miningSettlementReasonCodes.hourNotComplete)
      ) {
        break;
      }
    }
    let claimsChecked = 0;
    if (options.rewards !== null) {
      for (const claim of await options.repository.listUnresolvedClaims(50)) {
        try {
          await options.rewards.reconcileClaim(claim);
          claimsChecked += 1;
        } catch (error) {
          options.onError?.(error);
        }
      }
    }
    return Object.freeze({ outcomes: Object.freeze(outcomes), claimsChecked });
  }

  return Object.freeze<MiningSettlementLane>({
    lane: miningSettlementLane,
    runOnce,
    async run(signal) {
      while (!signal.aborted) {
        try {
          await runOnce();
        } catch (error) {
          options.onError?.(error);
        }
        await wait(options.pollIntervalMs, signal);
      }
    },
  });
}
