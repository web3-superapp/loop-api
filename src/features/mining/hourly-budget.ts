import { miningHourSeconds } from "./hourly-settlement-contract.js";

/**
 * Decision 0116 §3: the per-track budget of one UTC hour. The daily budget
 * is spread evenly over 24 hours in raw units; the floor remainder lands on
 * the day's last hour (UTC 23:00), so the 24 hours of a day always sum to
 * the daily budget exactly. Hours outside the release window have none.
 */

const daySeconds = 86_400n;

export interface MiningHourBudgetInput {
  /** Unix seconds of the hour start (must be a whole UTC hour). */
  readonly hourStart: bigint;
  readonly dailyBudgetRaw: bigint;
  /** Unix seconds of the release start (UTC midnight). */
  readonly releaseStart: bigint;
  readonly releaseDays: number;
}

export function isWithinMiningRelease(input: {
  readonly hourStart: bigint;
  readonly releaseStart: bigint;
  readonly releaseDays: number;
}): boolean {
  const end = input.releaseStart + BigInt(input.releaseDays) * daySeconds;
  return input.hourStart >= input.releaseStart && input.hourStart < end;
}

export function miningHourBudget(input: MiningHourBudgetInput): bigint {
  if (input.hourStart % miningHourSeconds !== 0n) {
    throw new Error("Hour start is not a whole UTC hour");
  }
  if (input.dailyBudgetRaw < 0n) throw new Error("Negative daily budget");
  if (!isWithinMiningRelease(input)) return 0n;
  const base = input.dailyBudgetRaw / 24n;
  const hourOfDay = (input.hourStart % daySeconds) / miningHourSeconds;
  return hourOfDay === 23n ? input.dailyBudgetRaw - base * 23n : base;
}
