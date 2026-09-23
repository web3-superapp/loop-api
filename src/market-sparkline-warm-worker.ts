import { randomUUID } from "node:crypto";

import type {
  AssetRecord,
  ChainRegistryRepository,
} from "./database/chain-registry-repository.js";
import type { MarketFactCacheRepository } from "./database/market-fact-cache-repository.js";
import type { WatchlistV2Repository } from "./database/watchlist-v2-repository.js";
import {
  bscWrappedNativeAddress,
  marketReasonCodes,
  marketSparklinePolicy,
} from "./features/market/market-contract.js";
import type { MarketFactService } from "./features/market/market-fact-service.js";
import {
  parseSparklineRow,
  readSparklineRow,
  sparklineRowFromCandles,
  writeSparklineRow,
} from "./features/market/market-sparkline.js";

/**
 * The `market_sparkline_warm` lane (Decision 0074), default on behind
 * `MARKET_SPARKLINE_WARM_ENABLED` in the standalone worker process and
 * constructed only when the GeckoTerminal Provider is enabled.
 *
 * Each tick considers the registry's readable assets (watchlisted ones
 * first), skips every asset whose `sparkline_1h` row is inside its TTL
 * without touching the Provider, and refreshes exactly one stale asset: one
 * OHLCV read of its pool, written as one cache row keyed by token. The pool
 * is the asset's first registered pool, else the Provider top pool of
 * Decision 0064, which is looked up again only once per metadata TTL. A
 * Provider failure is reported with its reason code and the asset moves to
 * the back of the round-robin; nothing is retried inside a tick and no
 * marker row is ever written, because the cache holds Provider facts only.
 */

export const MARKET_SPARKLINE_WARM_LANE = "market_sparkline_warm" as const;
/** Pause when every target is fresh. */
export const MARKET_SPARKLINE_WARM_IDLE_DELAY_MS = 15_000;
/** Pause after the Provider (or the local throttle) refused for rate. */
export const MARKET_SPARKLINE_WARM_RATE_LIMITED_DELAY_MS = 20_000;
export const MARKET_SPARKLINE_WARM_RETRY_BASE_DELAY_MS = 1_000;
export const MARKET_SPARKLINE_WARM_RETRY_MAX_DELAY_MS = 60_000;

export type MarketSparklineWarmRunResult =
  | {
      readonly kind: "refreshed";
      readonly assetId: string;
      readonly tokenAddress: string;
      readonly poolAddress: string;
      readonly poolOrigin: "registry" | "provider";
      readonly candleCount: number;
      readonly skippedFreshCount: number;
    }
  | {
      readonly kind: "failed";
      readonly assetId: string;
      readonly tokenAddress: string;
      readonly reasonCode: string;
      readonly skippedFreshCount: number;
    }
  | { readonly kind: "idle"; readonly skippedFreshCount: number }
  | { readonly kind: "aborted"; readonly skippedFreshCount: number };

export interface MarketSparklineWarmInfrastructureBackoff {
  readonly reasonCode: "market_sparkline_warm_unavailable";
  readonly consecutiveFailureCount: number;
  readonly retryDelayMs: number;
}

export interface MarketSparklineWarmWorker {
  readonly workerId: string;
  readonly lane: typeof MARKET_SPARKLINE_WARM_LANE;
  runOnce(signal?: AbortSignal): Promise<MarketSparklineWarmRunResult>;
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateMarketSparklineWarmWorkerOptions {
  readonly registry: ChainRegistryRepository;
  readonly watchlist: WatchlistV2Repository | null;
  readonly cache: MarketFactCacheRepository;
  readonly facts: MarketFactService;
  readonly chainId: string;
  /** Milliseconds between ticks; at most one Provider-costing refresh per tick. */
  readonly intervalMs: number;
  readonly sparklineTtlSeconds: number;
  /** How long a Provider-chosen pool is reused before it is looked up again. */
  readonly poolRevalidationSeconds: number;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
  readonly onRunResult?: (result: MarketSparklineWarmRunResult) => void;
  readonly onInfrastructureBackoff?: (
    event: MarketSparklineWarmInfrastructureBackoff,
  ) => void;
}

interface Target {
  readonly assetId: string;
  /** The address whose pool is charted: WBNB for the native asset. */
  readonly tokenAddress: string;
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
    MARKET_SPARKLINE_WARM_RETRY_BASE_DELAY_MS *
      2 ** (consecutiveFailureCount - 1),
    MARKET_SPARKLINE_WARM_RETRY_MAX_DELAY_MS,
  );
}

/** How long the loop waits after a tick, by what the tick did. */
export function delayAfter(
  result: MarketSparklineWarmRunResult,
  intervalMs: number,
): number {
  switch (result.kind) {
    case "refreshed":
      return intervalMs;
    case "failed":
      return result.reasonCode === marketReasonCodes.providerRateLimited
        ? MARKET_SPARKLINE_WARM_RATE_LIMITED_DELAY_MS
        : intervalMs;
    case "idle":
      return MARKET_SPARKLINE_WARM_IDLE_DELAY_MS;
    case "aborted":
      return 0;
  }
}

/**
 * Readable registry assets with an address, watchlisted ones first, native
 * charted as WBNB, bounded. Pure so the ordering can be tested on its own.
 */
export function selectTargets(input: {
  readonly readable: readonly AssetRecord[];
  readonly watchlisted: readonly string[];
}): readonly Target[] {
  const byId = new Map(input.readable.map((asset) => [asset.assetId, asset]));
  const ordered: AssetRecord[] = [];
  const seen = new Set<string>();
  const push = (asset: AssetRecord | undefined): void => {
    if (asset === undefined || seen.has(asset.assetId)) {
      return;
    }
    if (asset.status === "blocked") {
      return;
    }
    seen.add(asset.assetId);
    ordered.push(asset);
  };
  for (const assetId of input.watchlisted) {
    push(byId.get(assetId));
  }
  for (const asset of input.readable) {
    push(asset);
  }
  return Object.freeze(
    ordered.slice(0, marketSparklinePolicy.maximumTargets).map((asset) =>
      Object.freeze({
        assetId: asset.assetId,
        tokenAddress: asset.address ?? bscWrappedNativeAddress,
      }),
    ),
  );
}

export function createMarketSparklineWarmWorker(
  options: CreateMarketSparklineWarmWorkerOptions,
): MarketSparklineWarmWorker {
  const createUuid = options.createUuid ?? randomUUID;
  const now = options.now ?? ((): Date => new Date());
  const workerId = createUuid();
  let inFlight: Promise<MarketSparklineWarmRunResult> | null = null;
  let loopRunning = false;
  /** Round-robin position; the next tick starts after the last asset handled. */
  let cursor = 0;

  async function loadTargets(): Promise<readonly Target[]> {
    const readable = await options.registry.listReadableAssets(options.chainId);
    let watchlisted: readonly string[] = [];
    if (options.watchlist !== null) {
      watchlisted = await options.watchlist.listDistinctAssetIds(
        marketSparklinePolicy.maximumTargets,
      );
    }
    return selectTargets({ readable, watchlisted });
  }

  /**
   * The pool to chart, without spending a Provider request when the
   * previous row already names one that is inside its re-validation window.
   */
  async function choosePool(
    target: Target,
    previous: ReturnType<typeof parseSparklineRow>,
    nowMs: number,
  ): Promise<
    | {
        readonly poolAddress: string;
        readonly poolOrigin: "registry" | "provider";
        readonly poolChosenAt: string;
      }
    | { readonly reasonCode: string }
  > {
    const pools = await options.registry.listPools(options.chainId);
    const registered = pools.find(
      (pool) =>
        pool.token0AssetId === target.assetId ||
        pool.token1AssetId === target.assetId ||
        // The native asset is charted through WBNB's registered pool.
        (target.tokenAddress === bscWrappedNativeAddress &&
          (pool.token0AssetId === `eip155:56:${bscWrappedNativeAddress}` ||
            pool.token1AssetId === `eip155:56:${bscWrappedNativeAddress}`)),
    );
    if (registered !== undefined) {
      return {
        poolAddress: registered.address,
        poolOrigin: "registry",
        poolChosenAt: new Date(nowMs).toISOString(),
      };
    }
    if (
      previous !== null &&
      previous.poolOrigin === "provider" &&
      (nowMs - Date.parse(previous.poolChosenAt)) / 1_000 <
        options.poolRevalidationSeconds
    ) {
      return {
        poolAddress: previous.poolAddress,
        poolOrigin: "provider",
        poolChosenAt: previous.poolChosenAt,
      };
    }
    const lookup = await options.facts.readUnlistedToken(target.tokenAddress);
    const pair = lookup.market.value?.primaryPair ?? null;
    if (pair === null) {
      const reasonCode = lookup.market.reasonCode;
      return {
        reasonCode:
          lookup.market.value === null &&
          reasonCode !== null &&
          reasonCode !== marketReasonCodes.tokenNotFound
            ? reasonCode
            : marketReasonCodes.poolNotRegistered,
      };
    }
    return {
      poolAddress: pair.pairAddress,
      poolOrigin: "provider",
      poolChosenAt: new Date(nowMs).toISOString(),
    };
  }

  async function execute(
    signal?: AbortSignal,
  ): Promise<MarketSparklineWarmRunResult> {
    let skippedFreshCount = 0;
    if (isAborted(signal)) {
      return Object.freeze({ kind: "aborted", skippedFreshCount });
    }
    const targets = await loadTargets();
    if (targets.length === 0) {
      return Object.freeze({ kind: "idle", skippedFreshCount });
    }
    for (let step = 0; step < targets.length; step += 1) {
      if (isAborted(signal)) {
        return Object.freeze({ kind: "aborted", skippedFreshCount });
      }
      const index = (cursor + step) % targets.length;
      const target = targets[index];
      if (target === undefined) {
        continue;
      }
      const nowMs = now().getTime();
      const existing = await readSparklineRow(
        options.cache,
        target.tokenAddress,
      );
      if (existing !== null) {
        const ageSeconds = (nowMs - Date.parse(existing.fetchedAt)) / 1_000;
        if (ageSeconds >= 0 && ageSeconds < existing.ttlSeconds) {
          skippedFreshCount += 1;
          continue;
        }
      }
      // This asset is the tick's one refresh; the next tick starts after it
      // whether or not it succeeds.
      cursor = (index + 1) % targets.length;
      const previous = existing === null ? null : parseSparklineRow(existing);
      const pool = await choosePool(target, previous, nowMs);
      if ("reasonCode" in pool) {
        return Object.freeze({
          kind: "failed",
          assetId: target.assetId,
          tokenAddress: target.tokenAddress,
          reasonCode: pool.reasonCode,
          skippedFreshCount,
        });
      }
      const fact = await options.facts.readPoolOhlcv({
        poolAddress: pool.poolAddress,
        timeframe: marketSparklinePolicy.interval,
        limit: marketSparklinePolicy.pointLimit,
        tokenAddress: target.tokenAddress,
      });
      if (
        fact.value === null ||
        fact.fetchedAt === null ||
        fact.rawDigest === null
      ) {
        return Object.freeze({
          kind: "failed",
          assetId: target.assetId,
          tokenAddress: target.tokenAddress,
          reasonCode: fact.reasonCode ?? marketReasonCodes.providerUnreachable,
          skippedFreshCount,
        });
      }
      const value = sparklineRowFromCandles({
        poolAddress: pool.poolAddress,
        poolOrigin: pool.poolOrigin,
        poolChosenAt: pool.poolChosenAt,
        snapshot: fact.value,
      });
      await writeSparklineRow(options.cache, {
        tokenAddress: target.tokenAddress,
        value,
        rawDigest: fact.rawDigest,
        fetchedAt: fact.fetchedAt,
        ttlSeconds: options.sparklineTtlSeconds,
      });
      return Object.freeze({
        kind: "refreshed",
        assetId: target.assetId,
        tokenAddress: target.tokenAddress,
        poolAddress: pool.poolAddress,
        poolOrigin: pool.poolOrigin,
        candleCount: value.candleCount,
        skippedFreshCount,
      });
    }
    return Object.freeze({ kind: "idle", skippedFreshCount });
  }

  function runOnce(
    signal?: AbortSignal,
  ): Promise<MarketSparklineWarmRunResult> {
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
    lane: MARKET_SPARKLINE_WARM_LANE,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      if (loopRunning) {
        throw new Error("The market sparkline warm lane is already running");
      }
      loopRunning = true;
      let consecutiveFailures = 0;
      try {
        while (!signal.aborted) {
          try {
            const result = await runOnce(signal);
            consecutiveFailures = 0;
            options.onRunResult?.(result);
            await waitFor(delayAfter(result, options.intervalMs), signal);
          } catch {
            if (isAborted(signal)) {
              break;
            }
            consecutiveFailures += 1;
            const delay = retryDelayMs(consecutiveFailures);
            options.onInfrastructureBackoff?.(
              Object.freeze({
                reasonCode: "market_sparkline_warm_unavailable",
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
