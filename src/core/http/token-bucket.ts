/**
 * S346 (Decision 0197 amendment): an in-process token bucket — a budget
 * shared by every caller of one process. `perMinute` tokens refill evenly
 * over a minute and the bucket holds at most `perMinute`, so a quiet minute
 * allows one burst of that size and a sustained load is held to the rate.
 * Per process, like the fixed windows of Decision 0174; a multi-instance
 * deployment divides the budget by its instance count.
 */

export interface TokenBucket {
  /** Takes one token; false when the bucket is empty. */
  take(): boolean;
}

export function createTokenBucket(options: {
  readonly perMinute: number;
  readonly nowMs?: () => number;
}): TokenBucket {
  const nowMs = options.nowMs ?? Date.now;
  const capacity = options.perMinute;
  const refillPerMs = options.perMinute / 60_000;
  let tokens = capacity;
  let last = nowMs();
  return Object.freeze({
    take() {
      const at = nowMs();
      if (at > last) {
        tokens = Math.min(capacity, tokens + (at - last) * refillPerMs);
      }
      last = Math.max(last, at);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  });
}
