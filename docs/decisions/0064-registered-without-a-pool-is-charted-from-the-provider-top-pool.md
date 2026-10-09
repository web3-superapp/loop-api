# Decision 0064: A registered token LOOP has no pool for is charted from the Provider's top pool

- Status: Accepted (S66; user report from the real device — BSC ETH has no chart)
- Date: 2026-09-22
- Scope: `market` module, `GET /v2/market/assets/{assetId}` (`primaryPair` and the price facts) and `GET /v2/market/assets/{assetId}/candles`. No migration, no new Provider read, no new fact kind, no new env, no new reason code. `/v2/market/assets/{assetId}/trades|holders`, the overview, `/v2/assets`, the registry, and `/v1` are unchanged.

## Context

- Deployment `b90e577` answered `GET /v2/market/assets/eip155:56:0x2170ed0880ac9a755fd29b2688956bd959f933f8/candles?interval=1h&limit=24` with `200` and `candles.status: "unavailable"`, `reasonCode: "MARKET_POOL_NOT_REGISTERED"`. That asset is in the registry (`asset.status: "pending"`, registered through `asset:register`), but no PancakeSwap V3 pool of it is registered in `pools`.
- The same address, **not** registered, is charted: Decision 0058 resolves an unregistered address through the Provider token lookup and reads OHLCV of the top pool the Provider reports. So registering a token made it strictly less readable than leaving it out of the registry — the candles gate was "a registered pool exists", not "a pool exists".
- Only the two Provider-independent surfaces need a registered pool for a real reason: the derived candles and `/trades` are aggregates of `pool_event` rows, and LOOP only indexes pools it has registered.

## Decision

### Candles

`GET /v2/market/assets/{assetId}/candles` for a registry asset whose `pools` rows are empty takes the Decision 0058 Provider top-pool path instead of closing the block:

1. No OHLCV Provider enabled → `MARKET_POOL_NOT_REGISTERED` (unchanged: there is no source at all).
2. Provider token lookup (`MarketFactService.readUnlistedToken`, same adapter, same `token_lookup`/`token_pairs` cache rows, same TTLs, same Provider throttle) names the deepest pool it knows; OHLCV of that pool is the chart, in USD, `quality: fresh|stale`, `labelKey: null`.
3. The lookup answered but knows no pool (or affirmatively knows no such token) → `MARKET_POOL_NOT_REGISTERED`. A client that already handles that block needs no new case.
4. The lookup could not be reached / was throttled / malformed → that Provider reason code (`MARKET_PROVIDER_UNREACHABLE`, `MARKET_PROVIDER_RATE_LIMITED`, …). Not knowing is not the same as there being nothing, and the two are never conflated.

Registered pools keep precedence: when at least one pool of the asset is registered, the behaviour is byte-for-byte as before (Provider OHLCV of the first registered pool, then the indexed-swap derivation). The native asset keeps its Decision 0050 proxy: it is charted through the registered WBNB pool, and if WBNB itself has no registered pool, through WBNB's Provider top pool with `quality: proxied` and `proxyAsset` named.

### `pool.origin` on the candles block

`candles.pool` gains a required `origin: "registry" | "provider"`:

- `registry` — a pool LOOP has registered and indexes; the same pool backs `/trades` and the derived candles.
- `provider` — the top pool the market Provider reports; LOOP does not index it.

`candles.source` keeps its meaning (which Provider, or `loop_indexer`); `origin` answers the other question, which pool LOOP charted and whether LOOP knows it. The unregistered path of Decision 0058 now publishes `origin: "provider"`, the registered-pool and derived paths `origin: "registry"`.

### Quota

The Decision 0058 enumeration quota (`unlisted_token_lookup_v1`) is **not** consumed for a registry asset, on either read. The quota exists because an arbitrary address is an existence probe of Provider coverage; a registry asset id is a bounded, already-listable set (`GET /v2/assets`), so it probes nothing. Decision 0058's rule "registered assets never consume it" therefore holds unchanged. The Provider-side throttle and the cache TTLs are the same ones the unregistered path uses, so the extra read costs one cached Provider request per token per TTL.

### `primaryPair` and the price facts on the asset read

`GET /v2/market/assets/{assetId}` for a registry asset whose pairs Provider reported no usable pair (`primaryPair: null` — the Provider was unreachable, or knows no pair) falls back to the same lookup snapshot, and is published from it whole: `price`, `priceChange24h`, `liquidityUsd`, `volume24h`, `marketCap`, `fdv`, `primaryPair`, each with its own `source`/`fetchedAt`/`ttlSeconds`/`quality`. Taken whole, never one field from each Provider (Decision 0034). The registry stays the only source of identity: `asset` is still the registry projection with its real status (`pending|verified`), never `unregistered`.

Excluded from the fallback: a `blocked` asset (stays `ASSET_BLOCKED`) and the native asset (its facts must stay labelled `proxied` through WBNB, Decision 0050). The overview and the trending scan are unchanged — they read the batch endpoint and must not fan out one lookup per asset.

### What stays unavailable

- `/v2/market/assets/{assetId}/trades` for a registered asset without a registered pool stays `200` with `MARKET_POOL_NOT_REGISTERED`. That block is LOOP's own indexed swap lane: every item carries a log index, a block hash, confirmations, a reorg status, and `isOwn` matched against the caller's wallets, and it is paged by an HMAC cursor over `(blockNumber, logIndex)`. The Provider's pool trades carry none of those, so publishing them there would either lie about the fields or change the item contract for every client. Charting a token and claiming to list its on-chain trades are different promises; only the first one is kept here. Listing Provider trades is a separate surface and a separate decision.
- `/v2/market/assets/{assetId}/holders` never depended on a pool: `holderCount` is read from GoPlus by address and already answers for a registered asset with no pool; `distribution` stays `HOLDER_DISTRIBUTION_NOT_SUPPORTED`. Nothing changed here.

## Consequences

- `MarketReadService.getCandles` gains one branch (`pools.length === 0` for a registry asset) sharing `providerTopPoolCandles`; the three Provider-OHLCV projections (registered pool, registered without pool, unregistered address) now go through one `providerCandlesResource` helper, so a pool is never published without its origin.
- OpenAPI: `candles.pool.origin` added as a required enum on the available branch of `getV2MarketCandles`. Additive for readers; operation count unchanged. No error code, header, or status code changed.
- Cost: for a registered token with no registered pool, one extra Provider lookup per token per `MARKET_UNLISTED_PRICE_TTL_SECONDS` (60 s default), shared with the asset read through the same cache row.
- On the Development stack (`MARKET_PROVIDER_GECKOTERMINAL_ENABLED=true`, Decision 0050) the nine tokens registered in S65 are charted from Provider pools. In production, where GeckoTerminal is off by default, the candles block stays `MARKET_POOL_NOT_REGISTERED` until a pool is registered or that Provider is enabled — the fallback adds no source that was not already permitted.

## Rollback

Set `MARKET_PROVIDER_GECKOTERMINAL_ENABLED=false`: every candles read without a registered pool answers `MARKET_POOL_NOT_REGISTERED` again, exactly as before this decision, and the asset-read fallback has no lookup Provider to fall back to beyond DexScreener. Registering a pool for the asset returns it to the registry path with `origin: "registry"`. No data was written, so there is nothing to undo.
