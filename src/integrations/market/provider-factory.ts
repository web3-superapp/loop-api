import type { MarketConfig } from "../../config.js";
import { createDexscreenerAdapter } from "./dexscreener-adapter.js";
import { createGeckoterminalAdapter } from "./geckoterminal-adapter.js";
import { createGoplusAdapter } from "./goplus-adapter.js";
import type {
  CandlesProvider,
  MarketPairsProvider,
  SecurityFactsProvider,
} from "./market-data-provider.js";
import type { ProviderFetch } from "./provider-http.js";

/**
 * Builds the configured market Providers (Decision 0034). A Provider that is
 * disabled or lacks its credential is `null`: the fact service publishes its
 * facts as `unavailable` and never substitutes another source.
 */
export interface MarketProviders {
  readonly pairs: MarketPairsProvider | null;
  readonly security: SecurityFactsProvider | null;
  readonly candles: CandlesProvider | null;
}

/**
 * `api` and `worker` are separate processes with separate DexScreener
 * budgets; their sum is capped at the documented 300/min by configuration.
 */
export type MarketProviderRole = "api" | "worker";

export function createMarketProviders(
  config: MarketConfig,
  role: MarketProviderRole,
  options: { readonly fetch?: ProviderFetch } = {},
): MarketProviders {
  const fetchOption =
    options.fetch === undefined ? {} : { fetch: options.fetch };
  return Object.freeze({
    pairs: config.dexscreener.enabled
      ? createDexscreenerAdapter({
          rateLimitPerMinute:
            role === "api"
              ? config.dexscreener.budgetApiPerMinute
              : config.dexscreener.budgetWorkerPerMinute,
          ...fetchOption,
        })
      : null,
    security:
      config.goplus === null
        ? null
        : createGoplusAdapter({
            appKey: config.goplus.appKey,
            appSecret: config.goplus.appSecret,
            rateLimitPerMinute: config.goplus.rateLimitPerMinute,
            ...fetchOption,
          }),
    candles: config.geckoterminal.enabled
      ? createGeckoterminalAdapter({
          rateLimitPerMinute: config.geckoterminal.rateLimitPerMinute,
          ...fetchOption,
        })
      : null,
  });
}
