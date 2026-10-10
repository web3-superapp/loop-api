import type { MiningDisplayState } from "./hourly-settlement-contract.js";

/**
 * Decision 0116: the minute display of the previous hour's reward. The
 * client derives exactly this from `serverTime`, `window`, and `totalRaw`;
 * the server computes it too so a refresh, a device switch, or a suspended
 * app always lands on the same number. The display never changes the
 * ledger: the claimable amount is a separate fact.
 */

export interface MiningMinuteDisplay {
  readonly displayState: MiningDisplayState;
  /** The hour whose reward is displayed; null before the first settlement. */
  readonly epochHourStart: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly totalRaw: string;
  /** totalRaw ÷ 60, floored (the remainder lands on minute 60). */
  readonly perMinuteRaw: string;
  /** 0..60 */
  readonly completedMinutes: number;
  readonly displayedRaw: string;
  /** Next instant the displayed number changes; null when it no longer does. */
  readonly nextUpdateAt: string | null;
}

export function displayedMinuteAmount(
  totalRaw: bigint,
  completedMinutes: number,
): bigint {
  if (completedMinutes <= 0) return 0n;
  if (completedMinutes >= 60) return totalRaw;
  return (totalRaw * BigInt(completedMinutes)) / 60n;
}

export function projectMiningMinuteDisplay(input: {
  readonly now: Date;
  /** Newest settled epoch, or null. */
  readonly lastEpoch: {
    readonly hourStart: string;
    readonly hourEnd: string;
    readonly totalRewardRaw: bigint;
  } | null;
}): MiningMinuteDisplay {
  if (input.lastEpoch === null) {
    return Object.freeze({
      displayState: "awaiting_first_settlement" as const,
      epochHourStart: null,
      windowStart: null,
      windowEnd: null,
      totalRaw: "0",
      perMinuteRaw: "0",
      completedMinutes: 0,
      displayedRaw: "0",
      nextUpdateAt: null,
    });
  }
  const windowStartMs = Date.parse(input.lastEpoch.hourEnd);
  const windowEndMs = windowStartMs + 3_600_000;
  const nowMs = input.now.getTime();
  const total = input.lastEpoch.totalRewardRaw;
  const elapsed = Math.max(0, nowMs - windowStartMs);
  const completedMinutes = Math.min(60, Math.floor(elapsed / 60_000));
  const inWindow = nowMs < windowEndMs;
  return Object.freeze({
    displayState: inWindow ? ("displaying" as const) : ("settling" as const),
    epochHourStart: input.lastEpoch.hourStart,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    totalRaw: total.toString(),
    perMinuteRaw: (total / 60n).toString(),
    completedMinutes,
    displayedRaw: displayedMinuteAmount(total, completedMinutes).toString(),
    nextUpdateAt:
      completedMinutes >= 60
        ? null
        : new Date(
            windowStartMs + (completedMinutes + 1) * 60_000,
          ).toISOString(),
  });
}
