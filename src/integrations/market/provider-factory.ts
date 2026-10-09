import type { MarketConfig } from "../../config.js";
import { createDexscreenerAdapter } from "./dexscreener-adapter.js";
import { createGeckoterminalAdapter } from "./geckoterminal-adapter.js";
import { createGoplusAdapter } from "./goplus-adapter.js";
import type {
  CandlesProvider,
  MarketPairsProvider,
  SecurityFactsProvider,
  TokenLookupProvider,
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
  /**
   * Unregistered-address lookup (Decision 0058): the GeckoTerminal adapter,
   * sharing its throttle with the candles surface. `null` when GeckoTerminal
   * is disabled; the DexScreener pairs Provider is then the only lookup path.
   */
  readonly tokenLookup: TokenLookupProvider | null;
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
  // The worker's sparkline lane (Decision 0074) gets its own, smaller share
  // of the GeckoTerminal limit; the API keeps the configured throttle.
  const geckoterminal = config.geckoterminal.enabled
    ? createGeckoterminalAdapter({
        rateLimitPerMinute:
          role === "api"
            ? config.geckoterminal.rateLimitPerMinute
            : config.geckoterminal.budgetWorkerPerMinute,
        ...fetchOption,
      })
    : null;
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
    candles: geckoterminal,
    tokenLookup: geckoterminal,
  });
}
