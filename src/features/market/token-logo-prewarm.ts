import type { AssetRecord } from "../../database/chain-registry-repository.js";
import type {
  TokenLogoCacheRecord,
  TokenLogoCacheRepository,
} from "../../database/token-logo-cache-repository.js";
import {
  MarketProviderError,
  type TopPoolsProvider,
} from "../../integrations/market/market-data-provider.js";
import { isNormalizedEvmAddress } from "../chain/chain-contract.js";
import type { MarketFactService } from "./market-fact-service.js";
import type { MainstreamTokenLogo } from "./token-logo-mainstream.js";
import { tokenLogoNormalizedContentType } from "./token-logo-normalize.js";
import {
  tokenLogoUpstreamConcurrency,
  tokenLogoWarmRefreshAheadMs,
  type TokenLogoProxyService,
  type TokenLogoWarmOutcome,
} from "./token-logo-proxy.js";

/**
 * Token logo pre-warm (Decision 0161 §2).
 *
 * One pass collects the tokens whose pictures should already be in
 * `token_logo_cache` when a mainland-China client asks for them, and lets
 * the logo proxy fetch every one that is absent or due within a day:
 *
 * 1. the native coin and the hand-kept mainstream list
 *    (`token-logo-mainstream.ts`);
 * 2. the Asset Registry's readable assets of the chain (every status but
 *    `blocked`; wallet holdings are registry assets, so this covers them);
 * 3. watchlisted assets of the chain (most-watched first);
 * 4. the base tokens of the chain's top pools by 24 h volume
 *    (GeckoTerminal, at most `hotLimit`).
 *
 * The list is de-duplicated by address in that order. For the due tokens
 * the DexScreener batch pair fact is read first (cache hit or one request
 * per 30 tokens), so the proxy sees the Provider image when one exists.
 * Every proxy rule applies unchanged: eight upstream fetches at most, a
 * failed refetch keeps the stored picture, a manual picture is never
 * touched.
 */

export const tokenLogoPrewarmMaximumTargets = 2_000;
/** GeckoTerminal answers 20 pools per page. */
export const tokenLogoPrewarmPoolsPerPage = 20;

export type TokenLogoPrewarmOrigin =
  "native" | "mainstream" | "registry" | "watchlist" | "hot";

export interface TokenLogoPrewarmTarget {
  readonly chainId: string;
  /** Lowercase `0x` address, or `null` for the native coin. */
  readonly address: string | null;
  readonly origin: TokenLogoPrewarmOrigin;
}

/**
 * The pass's targets in priority order, one per address. Addresses that
 * are not lowercase-normalisable `0x` + 40 hex and asset IDs of another
 * chain are dropped. Pure so the ordering and de-duplication are tested on
 * their own.
 */
export function collectTokenLogoPrewarmTargets(input: {
  readonly chainId: string;
  readonly mainstream: readonly MainstreamTokenLogo[];
  readonly registryAssets: readonly Pick<
    AssetRecord,
    "assetId" | "chainId" | "address" | "status"
  >[];
  readonly watchlistedAssetIds: readonly string[];
  readonly hotAddresses: readonly string[];
  readonly maximumTargets?: number;
}): readonly TokenLogoPrewarmTarget[] {
  const maximum = input.maximumTargets ?? tokenLogoPrewarmMaximumTargets;
  const seen = new Set<string>();
  const targets: TokenLogoPrewarmTarget[] = [];
  const push = (
    rawAddress: string | null,
    origin: TokenLogoPrewarmOrigin,
  ): void => {
    if (targets.length >= maximum) {
      return;
    }
    let address: string | null = null;
    if (rawAddress !== null) {
      const lower = rawAddress.trim().toLowerCase();
      if (!isNormalizedEvmAddress(lower)) {
        return;
      }
      address = lower;
    }
    const key = address ?? "native";
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push(Object.freeze({ chainId: input.chainId, address, origin }));
  };
  push(null, "native");
  for (const token of input.mainstream) {
    push(token.address, "mainstream");
  }
  for (const asset of input.registryAssets) {
    if (asset.chainId !== input.chainId || asset.status === "blocked") {
      continue;
    }
    push(asset.address, asset.address === null ? "native" : "registry");
  }
  const prefix = `${input.chainId}:`;
  for (const assetId of input.watchlistedAssetIds) {
    if (!assetId.startsWith(prefix)) {
      continue;
    }
    const tail = assetId.slice(prefix.length);
    push(tail === "native" ? null : tail, "watchlist");
  }
  for (const address of input.hotAddresses) {
    push(address, "hot");
  }
  return Object.freeze(targets);
}

export interface TokenLogoPrewarmSummary {
  readonly targetCount: number;
  readonly byOrigin: Readonly<Record<TokenLogoPrewarmOrigin, number>>;
  readonly outcomes: Readonly<Record<TokenLogoWarmOutcome, number>>;
  /** Base tokens taken from the hot list (before de-duplication). */
  readonly hotListed: number;
  /** Why the hot list is short or empty, `null` when it was read in full. */
  readonly hotReasonCode: string | null;
  /** Why the DexScreener pair seeding was skipped or failed, else `null`. */
  readonly pairSeedReasonCode: string | null;
  readonly aborted: boolean;
}

export interface TokenLogoPrewarmDependencies {
  readonly chainId: string;
  readonly proxy: TokenLogoProxyService;
  /** Reads the rows' states in one query; `null` reads them per token. */
  readonly cache: Pick<TokenLogoCacheRepository, "listStates"> | null;
  readonly mainstream: readonly MainstreamTokenLogo[];
  readonly registry: {
    listReadableAssets(chainId: string): Promise<readonly AssetRecord[]>;
  } | null;
  readonly watchlist: {
    listDistinctAssetIds(limit: number): Promise<readonly string[]>;
  } | null;
  readonly topPools: TopPoolsProvider | null;
  readonly hotLimit: number;
  /** DexScreener pair facts; `null` when the Provider is not configured. */
  readonly pairs: Pick<MarketFactService, "readTokenPairsBatch"> | null;
  readonly now?: () => Date;
  readonly concurrency?: number;
  /** Test seam: pause after a rate-limited hot-list page (default 30 s). */
  readonly hotRetryDelayMs?: number;
  readonly signal?: AbortSignal;
}

const watchlistReadLimit = 1_000;

function emptyOutcomes(): Record<TokenLogoWarmOutcome, number> {
  return {
    fresh: 0,
    manual: 0,
    stored: 0,
    missing: 0,
    kept: 0,
    failed: 0,
    degraded: 0,
    unsupported: 0,
  };
}

/**
 * Whether a stored row is certainly not due (the proxy re-checks with the
 * current top origin). Used only to skip the pair seeding for it.
 */
function isSettled(
  row: TokenLogoCacheRecord | undefined,
  nowMs: number,
): boolean {
  if (row === undefined) {
    return false;
  }
  if (row.source === "manual") {
    return true;
  }
  if (
    row.status === "found" &&
    row.contentType !== tokenLogoNormalizedContentType
  ) {
    return false;
  }
  return Date.parse(row.expiresAt) - tokenLogoWarmRefreshAheadMs > nowMs;
}

/** Pause before asking the same hot-list page again after a rate refusal. */
export const tokenLogoPrewarmHotRetryDelayMs = 30_000;
/** Rate refusals tolerated in one pass before the hot list is cut short. */
export const tokenLogoPrewarmHotMaximumRetries = 10;

async function pause(delayMs: number, signal: AbortSignal | undefined) {
  if (signal?.aborted === true || delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readHotAddresses(
  provider: TopPoolsProvider | null,
  limit: number,
  signal: AbortSignal | undefined,
  retryDelayMs: number,
): Promise<{
  readonly addresses: readonly string[];
  readonly reasonCode: string | null;
}> {
  if (limit === 0) {
    return { addresses: [], reasonCode: null };
  }
  if (provider === null) {
    return { addresses: [], reasonCode: "TOKEN_LOGO_HOT_LIST_UNAVAILABLE" };
  }
  const addresses: string[] = [];
  const seen = new Set<string>();
  const pages = Math.ceil(limit / tokenLogoPrewarmPoolsPerPage);
  let retries = 0;
  let page = 1;
  while (page <= pages && addresses.length < limit) {
    if (signal?.aborted === true) {
      break;
    }
    try {
      const observation = await provider.readTopPools(
        page,
        signal === undefined ? {} : { signal },
      );
      for (const pool of observation.value.pools) {
        const base = pool.baseTokenAddress;
        if (base !== null && !seen.has(base) && addresses.length < limit) {
          seen.add(base);
          addresses.push(base);
        }
      }
      if (observation.value.pools.length < tokenLogoPrewarmPoolsPerPage) {
        break;
      }
      page += 1;
    } catch (error) {
      // The local throttle (worker share) and the Provider's 429 both answer
      // "rate limited": wait and ask the same page again, a few times.
      if (
        error instanceof MarketProviderError &&
        error.code === "market_provider_rate_limited" &&
        retries < tokenLogoPrewarmHotMaximumRetries
      ) {
        retries += 1;
        await pause(retryDelayMs, signal);
        continue;
      }
      // What was read so far is used; the next pass asks again.
      return { addresses, reasonCode: "TOKEN_LOGO_HOT_LIST_FAILED" };
    }
  }
  return { addresses, reasonCode: null };
}

/** One pre-warm pass (worker lane tick, or `pnpm token-logo:prewarm`). */
export async function runTokenLogoPrewarmPass(
  dependencies: TokenLogoPrewarmDependencies,
): Promise<TokenLogoPrewarmSummary> {
  const now = dependencies.now ?? ((): Date => new Date());
  const signal = dependencies.signal;
  const concurrency = Math.max(
    1,
    Math.min(
      dependencies.concurrency ?? tokenLogoUpstreamConcurrency,
      tokenLogoUpstreamConcurrency,
    ),
  );

  const registryAssets =
    dependencies.registry === null
      ? []
      : await dependencies.registry.listReadableAssets(dependencies.chainId);
  const watchlisted =
    dependencies.watchlist === null
      ? []
      : await dependencies.watchlist.listDistinctAssetIds(watchlistReadLimit);
  const hot = await readHotAddresses(
    dependencies.topPools,
    dependencies.hotLimit,
    signal,
    dependencies.hotRetryDelayMs ?? tokenLogoPrewarmHotRetryDelayMs,
  );
  const targets = collectTokenLogoPrewarmTargets({
    chainId: dependencies.chainId,
    mainstream: dependencies.mainstream,
    registryAssets,
    watchlistedAssetIds: watchlisted,
    hotAddresses: hot.addresses,
  });

  const byOrigin: Record<TokenLogoPrewarmOrigin, number> = {
    native: 0,
    mainstream: 0,
    registry: 0,
    watchlist: 0,
    hot: 0,
  };
  for (const target of targets) {
    byOrigin[target.origin] += 1;
  }

  let states: ReadonlyMap<string, TokenLogoCacheRecord> | null = null;
  if (dependencies.cache?.listStates !== undefined) {
    try {
      states = await dependencies.cache.listStates(
        dependencies.chainId,
        targets.map((target) => target.address ?? "native"),
      );
    } catch {
      states = null;
    }
  }

  // Seed the DexScreener image of every due token (one cache query, then
  // one Provider request per 30 misses) so the proxy can prefer it.
  let pairSeedReasonCode: string | null = null;
  const nowMs = now().getTime();
  const due = targets
    .filter(
      (target) =>
        target.address !== null &&
        (states === null || !isSettled(states.get(target.address), nowMs)),
    )
    .map((target) => target.address as string);
  if (dependencies.pairs === null) {
    pairSeedReasonCode = "TOKEN_LOGO_PAIR_SEED_UNAVAILABLE";
  } else if (due.length > 0 && signal?.aborted !== true) {
    try {
      await dependencies.pairs.readTokenPairsBatch(
        due,
        signal === undefined ? {} : { signal },
      );
    } catch {
      pairSeedReasonCode = "TOKEN_LOGO_PAIR_SEED_FAILED";
    }
  }

  const outcomes = emptyOutcomes();
  let next = 0;
  let aborted = false;
  async function drain(): Promise<void> {
    while (next < targets.length) {
      if (signal?.aborted === true) {
        aborted = true;
        return;
      }
      const target = targets[next];
      next += 1;
      if (target === undefined) {
        continue;
      }
      const key = target.address ?? "native";
      const outcome = await dependencies.proxy.warm({
        chainId: target.chainId,
        address: target.address,
        ...(states === null ? {} : { state: states.get(key) ?? null }),
      });
      outcomes[outcome] += 1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => drain()));

  return Object.freeze({
    targetCount: targets.length,
    byOrigin: Object.freeze(byOrigin),
    outcomes: Object.freeze(outcomes),
    hotListed: hot.addresses.length,
    hotReasonCode: hot.reasonCode,
    pairSeedReasonCode,
    aborted,
  });
}
