# Decision 0074: The market row draws its 1H sparkline from a server-warmed cache row, and a 24h change the Provider skipped is served stale, never blank-by-throttle

- Status: Accepted (S81b; user report from the iPhone 2026-09-23 — 4 of 11 trending rows had a sparkline, BTCB's 24h change "读不到")
- Date: 2026-09-23
- Scope: `GET /v2/market/overview` (`watchlist.items[]`, `trending.items[]`) gains `sparkline`; one new reconciliation-worker lane (`market_sparkline_warm`); two new `market_fact_cache` fact kinds (no migration, no new table); one new repository read on `market_fact_cache` and one on `watchlist_items`; the DexScreener adapter reports one more count; the GeckoTerminal adapter gets a worker-process budget. `GET /v2/watchlist`, the asset page's candles, `/v1`: unchanged.
- Baseline: `integration/v2` = `df4f64e`

## Context

### Sparkline: the client fanned out one candles read per row

`MarketRowSparkline(assetId)` (loop-mobile `market_widgets.dart`) called `GET /v2/market/assets/{id}/candles?interval=1h` once per visible row. Every one of those reads goes to GeckoTerminal (Decision 0064: the Development registry has one registered pool, so 10 of 11 rows chart through the Provider top-pool path — a token lookup plus an OHLCV read each). GeckoTerminal's public limit is 30 requests per minute and the adapter's throttle refuses above it, so one screen of 11 rows spent ~22 requests, and a second scroll or a reopen inside the same minute answered `MARKET_PROVIDER_RATE_LIMITED` for the rest. Which rows had a line was decided by request order, not by anything about the asset.

### BTCB's 24h change: DexScreener omits `priceChange.h24` per pool, transiently

Measured on 2026-09-23 against the exact endpoint the overview reads (`GET /tokens/v1/bsc/{11 registry addresses}`, one "main" pair per token), one sample every 25 s:

| time (UTC+8)      | LINK main pair `0x0E18…` `priceChange`  |
| ----------------- | --------------------------------------- |
| 19:09:24–19:10:40 | `h24: 0.06`                             |
| 19:11:05–19:12:21 | **no `h24` key** (four samples, ~100 s) |
| 19:12:47 →        | `h24: -0.31`                            |

The single-token endpoint showed the same on BTCB pools within five minutes: `0x28df…` had `h24: 0.02` in the 11:00:38 cache row and no `h24` live at 11:05; `0x62ed…` the reverse. The dev cache row for BTCB (`token_pairs`, 30 pairs) had every pair representable (`unrepresentablePairCount: 0`) — this is **not** the S61 exponent case (Decision 0062), which would have dropped the pair and taken the price with it. The client string "24 小时涨跌读不到" is rendered for any `unavailable` fact; the fact was `MARKET_FACT_NOT_REPORTED`, which was the truthful code for "the Provider answered the pair without this field".

So BTCB was not treated differently from other coins; any coin's cell goes blank for the ~1–2 minutes in which DexScreener's aggregate for that pool has no `h24`. What was wrong is that a number DexScreener had reported for the _same pair_ 25 seconds earlier was thrown away.

## Decision

### 1. `sparkline` on every overview row

```json
{ "status": "available", "interval": "1h", "closes": ["747.12", "…"], "observedAt": "2026-09-23T11:00:00.000Z", "source": "geckoterminal", "quality": "fresh" | "stale" | "proxied" }
{ "status": "unavailable", "reasonCode": "MARKET_SPARKLINE_NOT_CACHED" }
```

- `closes`: 1 to 24 canonical decimal strings, oldest first, the close of each of the last 24 hourly candles of one pool (the last one is the open hour). Never a JS number, never padded, never interpolated.
- `observedAt`: when the OHLCV fact was fetched from GeckoTerminal (the cache row's `fetchedAt`).
- `quality`: `fresh` inside `MARKET_SPARKLINE_TTL_SECONDS`; `stale` past it but inside `MARKET_STALE_GRACE_SECONDS`; `proxied` for the native asset, which reads WBNB's row exactly as its price does (Decision 0050; a proxied row is never also called stale).
- The request path **reads the cache only**. The overview never calls GeckoTerminal for a sparkline: a row that is not there is `unavailable`, not fetched.

Reason codes of the unavailable variant:

| reasonCode                               | meaning                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` | the API process has the OHLCV Provider off; a disabled Provider keeps publishing nothing (0034) |
| `MARKET_SPARKLINE_NOT_CACHED`            | the warm lane has not written a row for this asset yet                                          |
| `MARKET_SPARKLINE_EXPIRED`               | the row is older than TTL + grace: the lane has stopped, or the asset keeps failing             |
| `MARKET_SPARKLINE_EMPTY`                 | the Provider answered the pool with no candles                                                  |
| `MARKET_FACT_CACHE_UNAVAILABLE`          | the cache could not be read                                                                     |
| `ASSET_NOT_READABLE` / `ASSET_BLOCKED`   | as for the row's price                                                                          |

### 1b. `range24h` on `GET /v2/market/assets/{assetId}` (coordinator addition, same sheet)

The token page's first screen shows "24h 高 / 24h 低" and the client does not compute them from candles. The asset read publishes, at the top level:

```json
{ "status": "available", "high": "748.9", "low": "746.5", "bars": 24, "observedAt": "2026-09-23T11:00:00.000Z", "source": "geckoterminal", "quality": "fresh" | "stale" | "proxied" }
{ "status": "unavailable", "reasonCode": "MARKET_SPARKLINE_NOT_CACHED" }
```

- `high` / `low`: the highest `high` and the lowest `low` of the **same cached hourly candles** the overview row's sparkline is drawn from (§2), compared as exact decimals at write time — never a Provider read on the request path, never a value from a different pool than the sparkline.
- `bars`: how many candles the range covers (1–24). A token with less than a day of history at its pool is published with what exists, `bars` saying how much; it is not withheld.
- `quality` and the unavailable reason codes are those of §1, because it is the same row: `MARKET_SPARKLINE_NOT_CACHED` until the lane has warmed the asset, `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` without the Provider, `ASSET_BLOCKED`, `MARKET_FACT_CACHE_UNAVAILABLE`. The native asset reads WBNB's row as `proxied`. An unregistered address (Decision 0058) is not warmed by the lane and answers `MARKET_SPARKLINE_NOT_CACHED`.
- Not added to the overview rows (the request named the asset page); one line if product asks.

### 2. The cache row: fact kind `sparkline_1h`

`market_fact_cache` (`subject_key = token:<address>`, `fact_kind = sparkline_1h`, `source = geckoterminal`), value:

```json
{ "interval": "1h", "poolAddress": "0x…", "poolOrigin": "registry" | "provider", "poolChosenAt": "…", "closes": ["…"], "candleCount": 24, "high": "…", "low": "…" }
```

`fetched_at` is the OHLCV fact's `fetchedAt`; `ttl_seconds` is `MARKET_SPARKLINE_TTL_SECONDS`; `raw_digest` is the OHLCV response digest. It is a projection of one `pool_ohlcv` observation keyed by token rather than by `(pool, timeframe, token, limit)`, because the row's reader knows the token and must not have to resolve the pool (which would be a Provider read) to find the candles. The pool it came from is named in the row. The `pool_ohlcv` row the same read produced (limit 24) is kept as before, so the asset page's `?interval=1h&limit=24` shares it.

### 3. The `market_sparkline_warm` lane

Standalone reconciliation worker, same shape as `alert_evaluator` (Decision 0034):

- **Targets**: every readable registry asset with an address (the native asset is warmed as WBNB), assets referenced by any user's watchlist first (`WatchlistV2Repository.listDistinctAssetIds`), then registry order; blocked assets skipped; bounded at 100.
- **Pace**: one asset per tick, `MARKET_SPARKLINE_WARM_INTERVAL_MS` between ticks (default 4000). An asset whose `sparkline_1h` row is inside its TTL is skipped without a Provider call; when every target is fresh the lane idles for 15 s.
- **Cost per refresh**: one OHLCV read. The pool is the first registered pool of the asset (`origin: registry`); otherwise the Provider top pool from `readUnlistedToken` (`origin: provider`, Decision 0064 path, quota not consumed). A provider-chosen pool is re-validated only when the previous row's `poolChosenAt` is older than `MARKET_UNLISTED_METADATA_TTL_SECONDS` (default 1 h); inside that window the lane reuses the pool it already named rather than spending a lookup every refresh.
- **Budget**: the worker constructs the GeckoTerminal adapter with `MARKET_GECKOTERMINAL_BUDGET_WORKER` (default 10/min, capped at 30). Decision 0050 noted that only the API process built this Provider; that is no longer true, and the two processes share one egress IP, so the worker's share is small and the API keeps `MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE`. The sum is not refined to 30 because the API's own throttle already yields `stale` facts under 429; the lane's 429/throttle result parks the lane for 20 s.
- **Failures**: a Provider failure is logged with its reason code and the asset moves to the back of the round-robin — no retry inside the tick, no marker row written (the cache holds Provider facts only). Repository errors back off 1 s → 60 s like every other lane.
- **Gate**: `MARKET_SPARKLINE_WARM_ENABLED` (default `true`). The lane is constructed only when `MARKET_PROVIDER_GECKOTERMINAL_ENABLED=true`; otherwise the worker logs once that the lane stays idle with `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` (there is nothing to warm from, and the API answers the same code).

### 4. A 24h change the Provider skipped this time is served as `stale`, from the same Provider and the same pair

Fact kind `pair_price_change_h24` (`token:<address>`, `dexscreener`, value `{poolAddress, priceChangeH24}`), written whenever a fresh DexScreener snapshot's primary pair reports `priceChange.h24`, with that observation's `fetchedAt` and the price TTL.

When the current snapshot's primary pair lacks the field, the row's `priceChange24h` is the remembered value **only if** it belongs to the same `pairAddress` and is inside TTL + `MARKET_STALE_GRACE_SECONDS`, published as:

```json
{
  "value": "-0.31",
  "source": "dexscreener",
  "fetchedAt": "<when DexScreener reported it>",
  "ttlSeconds": 30,
  "quality": "stale",
  "reasonCode": "MARKET_FACT_NOT_REPORTED"
}
```

This is the existing `stale` semantic ("past TTL, the Provider could not confirm it now, `reasonCode` says why") applied to one field; nothing is inferred from another source, another pair, or the candles. Outside the grace window, or when the pair changed, the fact stays `unavailable` with `MARKET_FACT_NOT_REPORTED`. Applies to the overview rows and the asset page alike (both go through `pairFactsFor`); the unregistered-address path is unchanged.

### 5. "The Provider did not give it" versus "we could not parse it"

- `MARKET_FACT_NOT_REPORTED` (existing): the pair was published, the field was absent.
- `MARKET_PAIR_UNREPRESENTABLE` (new): the Provider reported base pairs for the token, but every one of them carried a value this codebase refuses (Decisions 0060/0062: a non-address pool identifier, a non-canonical number), so none was published. Previously this was `MARKET_PAIR_NOT_FOUND`, which claims the Provider knows no pair — it does. `TokenPairsSnapshot` gains `unrepresentableBasePairCount` (undefined on rows cached before this decision, read as 0) so the projection can tell the two apart. Decision 0062's rule stands: a pair is still dropped whole; this names the drop.

### 6. What is deliberately not done

- `GET /v2/watchlist` items do not get `sparkline`: Decision 0072 keeps that surface free of market-runtime reads, and the market tab renders `overview.watchlist.items[]`.
- No derived 24h change from candles. A percentage computed by LOOP from GeckoTerminal closes would be a fact inferred from another source; Decision 0034 forbids it, and the requester accepted "the Provider did not give it" as a terminal state.
- No fallback to a second pair for one field (a dust pool's `h24` is the number Decision 0062 was written to keep out).

## Consequences

- OpenAPI: `sparkline` required on both overview row schemas; `range24h` required on the asset resource; `MARKET_PAIR_UNREPRESENTABLE` documented; no new operation, status code, or header.
- New env: `MARKET_SPARKLINE_TTL_SECONDS` (60–3600, default 300; API and worker), `MARKET_GECKOTERMINAL_BUDGET_WORKER` (1–30, default 10; worker), `MARKET_SPARKLINE_WARM_ENABLED` (default true; worker), `MARKET_SPARKLINE_WARM_INTERVAL_MS` (1000–60000, default 4000; worker). `ops/api-dev.env` sets the lane on with the defaults.
- `MarketFactCacheRepository.getMany` and `WatchlistV2Repository.listDistinctAssetIds` are additive (integration tests cover both).
- Client rule (`docs/frontend-v2-market-api.md` §3): draw `sparkline.closes` when `status: available`; leave the slot blank when `unavailable`; **stop calling `/candles` per row**. The token page keeps its own candles read.
- Steady-state Provider cost on the Development stack: 12 targets / 300 s ≈ 2.4 GeckoTerminal requests per minute from the worker, plus one lookup per provider-charted asset per hour.

## Rollback

`MARKET_SPARKLINE_WARM_ENABLED=false` stops writing rows; rows age into `stale` then `MARKET_SPARKLINE_EXPIRED` and the client shows blank slots (as before, minus the fan-out). `MARKET_PROVIDER_GECKOTERMINAL_ENABLED=false` closes the field with `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` on both processes. The `pair_price_change_h24` rows expire by TTL; removing the recall leaves `MARKET_FACT_NOT_REPORTED` exactly as before.
