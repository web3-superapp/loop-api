/**
 * Decision 0174: an in-memory fixed one-minute window per key (per
 * process), the same rule as the Decision 0147 public MEME surface. Used
 * by unauthenticated `/v2` reads to keep a per-visitor ceiling.
 */

export const fixedWindowRateLimitWindowMs = 60_000;
const maximumKeys = 10_000;

export interface FixedWindowRateLimiter {
  /** null = admitted; else the seconds until the window resets (≥ 1). */
  admit(key: string): number | null;
}

export function createFixedWindowRateLimiter(options: {
  readonly perWindow: number;
  readonly nowMs?: () => number;
}): FixedWindowRateLimiter {
  const nowMs = options.nowMs ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    admit(key) {
      const at = nowMs();
      let window = windows.get(key);
      if (
        window === undefined ||
        at - window.start >= fixedWindowRateLimitWindowMs
      ) {
        if (windows.size >= maximumKeys) {
          for (const [entry, value] of windows) {
            if (at - value.start >= fixedWindowRateLimitWindowMs) {
              windows.delete(entry);
            }
          }
          if (windows.size >= maximumKeys) windows.clear();
        }
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      window.count += 1;
      if (window.count <= options.perWindow) return null;
      return Math.max(
        1,
        Math.ceil((window.start + fixedWindowRateLimitWindowMs - at) / 1000),
      );
    },
  };
}
