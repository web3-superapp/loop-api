# Decision 0058: Resolve an unregistered BSC token address on the market asset read

- Status: Accepted (S52; user request from the `#community-chat` prototype — a contract address pasted into a group must render a Token Card)
- Date: 2026-09-20
- Scope: `market` module, `GET /v2/market/assets/{assetId}` and `GET /v2/market/assets/{assetId}/candles`; one new Provider read (GeckoTerminal token lookup), one new quota capability, two new `market_fact_cache` fact kinds. No migration. `/v2/market/assets/{assetId}/trades|holders`, the overview, `/v2/assets`, the registry, and `/v1` are unchanged.
- Numbering: the task sheet named this `0057`; `0057-mining-snapshot-fail-closed-on-unread-holdings.md` already exists (uncommitted, S51) in the main tree, so this decision takes `0058`.

## Context

- The asset read (Decision 0034) only knew the asset registry. `GET /v2/market/assets/eip155:56:0x2170…f933f8` (BSC WETH, not registered on the Development stack) answered `404 NOT_FOUND`, so the chat client had nothing to draw for a pasted address, and the registry cannot pre-register every token users will paste.
- Both market Providers can describe an arbitrary address: GeckoTerminal `GET /networks/bsc/tokens/{address}?include=top_pools` returns symbol/name/decimals, token-level price/FDV/market cap/24h volume, and the top pools; DexScreener `GET /token-pairs/v1/bsc/{address}` returns the pairs (symbol and name of the base token, no decimals) and an empty list for an unknown token. Both were reachable from the main agent's machine on 2026-09-20; the GeckoTerminal shapes in this decision were observed live (WETH `200`, `0x…dead` `404 {"errors":[{"status":"404"}]}`).
- Resolving arbitrary addresses through Providers is an existence probe. Without a bound, an authenticated client could enumerate Provider coverage at the Provider's rate limit on LOOP's budget.

## Decision

### Entity and identity

- No new entity. The asset ID stays `eip155:56:<lowercase address>` (Decision 0033); a Provider lookup does not create a registry row, and nothing is written to `assets`.
- The market projection gains `asset.status: "unregistered"`. The registry statuses (`pending|verified|blocked`) are untouched; `unregistered` exists only on the market surface (`marketAssetStatuses`).
- `asset` on the market read is a three-way union discriminated by `status`:
  - registry projection (`pending|verified|blocked`) — byte-for-byte as before;
  - `unregistered`: `{assetId, chainId, address, symbol|null, name|null, decimals|null, status, source: {kind: "provider_lookup", provider, fetchedAt, ttlSeconds, quality: fresh|stale, blockNumber: null, verifiedAt: null}, updatedAt}`;
  - `{status: "unavailable", reasonCode}` when the address is unregistered and no Provider could describe it now.
- Identity fields a Provider did not report are `null`. DexScreener never reports decimals, so a DexScreener-resolved token has `decimals: null`; the backend does not read `decimals()` from chain for a lookup (registration remains the only chain-verified identity path), and never fills a field from a second source.

### Provider order and fallback

1. GeckoTerminal token lookup (when `MARKET_PROVIDER_GECKOTERMINAL_ENABLED`; shares the candles adapter and its 30/min throttle). One request yields identity, market facts, and top pools.
2. DexScreener pairs (when `MARKET_PROVIDER_DEXSCREENER_ENABLED`) when GeckoTerminal is disabled, unreachable, throttled, malformed, or answered 404.
3. Neither enabled → `200` with `asset.status: unavailable`, `reasonCode: MARKET_LOOKUP_PROVIDER_DISABLED`.

Fact attribution: from GeckoTerminal, `price`, `marketCap`, `fdv`, `volume24h` are token-level attributes; `priceChange24h` and `liquidityUsd` are the top pool's, and that pool is `primaryPair` (address-keyed pools only; a Uniswap V4 pool id is never a primary pair). From DexScreener the rule of Decision 0034 applies (deepest pair where the token is the base). Every fact carries `source`, `fetchedAt`, `ttlSeconds`, `quality`.

### Not found vs unavailable

| Situation                                                                | Answer                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `assetId` malformed (mixed-case address, wrong length, ticker)           | `400 INVALID_REQUEST`, before quota or Provider work                                                          |
| chain other than `eip155:56`                                             | `422 CHAIN_MISMATCH`                                                                                          |
| `eip155:56:native` not in the registry                                   | `404 NOT_FOUND` (the native asset is registry-only)                                                           |
| every **enabled** lookup Provider affirmatively answered "no such token" | `404 NOT_FOUND`                                                                                               |
| some enabled Provider could not be reached / throttled / malformed       | `200`, `asset` unavailable (or `stale` from the identity cache), facts unavailable with the Provider's reason |
| Provider described the token                                             | `200`, `asset.status: unregistered`                                                                           |

"Affirmative" is GeckoTerminal HTTP 404 (`MARKET_TOKEN_NOT_FOUND`) or a DexScreener empty pair list. Absence of an answer is never turned into `NOT_FOUND`.

### Capability and other blocks

- `capability` for an unregistered token: `{viewable: true, swappable: false, value: "viewable", reasonCode: "ASSET_NOT_REGISTERED"}`; for the unavailable variant `{viewable: false, swappable: false, value: "temporarily_unavailable", reasonCode}`. `swappable` is never true.
- `community` is `COMMUNITY_NOT_BOUND` (a community binds a registered asset). `security`/`holderCount` are read from GoPlus by address exactly as for a registered token (GoPlus is keyed by address), so they are `available` when GoPlus is configured and `MARKET_PROVIDER_GOPLUS_NOT_CONFIGURED` otherwise.

### Cache and TTL

`market_fact_cache`, no schema change:

| fact kind        | source                        | value                      | TTL                                                   |
| ---------------- | ----------------------------- | -------------------------- | ----------------------------------------------------- |
| `token_lookup`   | `geckoterminal`               | full lookup snapshot       | `MARKET_UNLISTED_PRICE_TTL_SECONDS` (default 60)      |
| `token_pairs`    | `dexscreener`                 | pairs (as Decision 0034)   | 60 s when read for a lookup (30 s for the registry)   |
| `token_identity` | `geckoterminal`/`dexscreener` | `{symbol, name, decimals}` | `MARKET_UNLISTED_METADATA_TTL_SECONDS` (default 3600) |

The identity row is written on every real Provider fetch. When no Provider answers, an identity row inside its TTL is served as `asset.source.quality: "stale"` with the Provider failure's `reasonCode`, and the price facts stay `unavailable`. Stale-grace for the price snapshot follows Decision 0034.

### Enumeration guard (quota)

`unlisted_token_lookup` / policy `unlisted_token_lookup_v1` on the Decision 0024 issuance-quota buckets (`issuance_rate_records`, HMAC subjects keyed by the existing `STREAM_TOKEN_QUOTA_HMAC_SECRET`; user IDs and IPs are never stored):

| bucket        | capacity |
| ------------- | -------- |
| `user_minute` | 30       |
| `ip_minute`   | 90       |
| `user_day`    | 600      |

- Consumed once per request, before any Provider call and regardless of cache state (a cache hit reveals coverage too), on both the asset read and the candles read for an unregistered address. Registered assets never consume it; malformed input is rejected before it.
- Exhaustion → `429 RATE_LIMITED` (`retryable: true`). Secret or control-plane repository missing → `503 CAPABILITY_UNAVAILABLE` for unregistered lookups only; registered assets keep working.

### Candles for an unregistered address

`GET /v2/market/assets/{assetId}/candles` resolves the same lookup (quota included). With GeckoTerminal enabled it reads OHLCV of the lookup's `primaryPair` (`pool.address` = pair, `pool.protocol` = the Provider's dex id such as `pancakeswap-v3-bsc`, `quoteAssetId: null`, `quoteSymbol: "USD"`, `priceUnit: "USD per <symbol|address>"`). There is no derived path: an unregistered address has no registered pool and no `pool_event` lane, so without GeckoTerminal the block is `MARKET_POOL_NOT_REGISTERED`; without a primary pair `MARKET_PAIR_NOT_FOUND`. The `pool.protocol` schema widens from `const pancakeswap_v3` to a bounded string.

`trades` and `holders` for an unregistered address remain `404 NOT_FOUND` (out of scope; the Token Card reads `holderCount` from the asset response).

**Amended by Decision 0064 (2026-09-22).** This Provider top-pool path is no longer reserved for unregistered addresses: a _registered_ asset for which LOOP has no registered pool takes the same path (same adapter, same cache rows and TTLs), because registering a token must not make it less readable than not registering it. Two things stay as written above: the enumeration quota is consumed only for an address the registry does not know, and identity for a registry asset always comes from the registry (`asset.status` is never `unregistered` for a registered token). The candles block now names the pool's origin — `pool.origin: "provider"` on this path, `"registry"` for a registered pool.

### Reason codes added

`MARKET_TOKEN_NOT_FOUND`, `ASSET_NOT_REGISTERED`, `MARKET_IDENTITY_FIELD_NOT_REPORTED` (reserved for the identity block), `MARKET_LOOKUP_PROVIDER_DISABLED`.

## Consequences

- `GeckoTerminal` adapter implements `TokenLookupProvider.readToken`; the Provider factory exposes `tokenLookup` (same instance as `candles`). `MarketFactService.readUnlistedToken` orchestrates cache, fallback, and not-found semantics. `MarketReadService.getAsset/getCandles` take a `caller` (principal + canonical IP) for the quota.
- New env: `MARKET_UNLISTED_PRICE_TTL_SECONDS` (5–3600, default 60), `MARKET_UNLISTED_METADATA_TTL_SECONDS` (60–86400, default 3600).
- OpenAPI: `getV2MarketAsset` and `getV2MarketCandles` gain `429`; `asset` becomes the three-way union; `candles.pool.protocol` is a string. Operation count unchanged.
- Client rule (see `docs/frontend-v2-market-api.md` §4a): a `0x` + 40-hex address seen in chat is lower-cased and sent as `eip155:56:<address>` to the asset read; the Token Card switches on `asset.status`, shows the address when `symbol` is null, never formats raw amounts when `decimals` is null, and never renders a Swap entry.
- Production default (`MARKET_PROVIDER_GECKOTERMINAL_ENABLED=false`) resolves through DexScreener only, so `decimals` is null there until GeckoTerminal terms are cleared; the Development stack has GeckoTerminal on (Decision 0050).

## Rollback

Set `MARKET_PROVIDER_GECKOTERMINAL_ENABLED=false` and `MARKET_PROVIDER_DEXSCREENER_ENABLED=false` to make every unregistered lookup answer `200` unavailable with `MARKET_LOOKUP_PROVIDER_DISABLED`, or remove `STREAM_TOKEN_QUOTA_HMAC_SECRET` to fail them closed with `503`; registered assets are unaffected either way. Cache rows expire by TTL; quota rows are retained by the Decision 0022 retention worker.
