/**
 * Decision 0179: the per-visitor fixed one-minute window of the
 * unauthenticated web reads, the same algorithm and bounds as the Decision
 * 0147 public MEME surface (in process memory, per replica; 10 000 keys at
 * most — expired windows are dropped first, then the table is cleared).
 */

export const webRateLimitWindowMs = 60_000;
const webRateLimitMaximumKeys = 10_000;

export interface WebRateLimiter {
  /** Null when admitted; otherwise the Retry-After seconds (≥ 1). */
  admit(key: string): number | null;
  readonly perWindow: number;
}

export function createWebRateLimiter(options: {
  readonly perWindow: number;
  readonly nowMs?: () => number;
}): WebRateLimiter {
  const nowMs = options.nowMs ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return Object.freeze({
    perWindow: options.perWindow,
    admit(key: string): number | null {
      const at = nowMs();
      let window = windows.get(key);
      if (window === undefined || at - window.start >= webRateLimitWindowMs) {
        if (windows.size >= webRateLimitMaximumKeys) {
          for (const [entry, value] of windows) {
            if (at - value.start >= webRateLimitWindowMs) windows.delete(entry);
          }
          if (windows.size >= webRateLimitMaximumKeys) windows.clear();
        }
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      window.count += 1;
      if (window.count <= options.perWindow) return null;
      return Math.max(
        1,
        Math.ceil((window.start + webRateLimitWindowMs - at) / 1000),
      );
    },
  });
}
