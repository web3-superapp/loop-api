# Decision 0034: V2 market facts, pool-event lane, price alerts, and context notifications

- Status: Accepted
- Date: 2026-09-08
- Scope: S5b backend (D11 market, D14 alerts/notifications) plus the
  `pool_event` indexer lane that S5a (Decision 0033) left for its first
  consumer. The main-agent rulings of 2026-09-08 in
  `LOOP/docs/modules/S5-chain-market-wallet.md` are adopted below. The user may
  overturn any row.

## Context

Decision 0033 established what an asset is and at which block a chain fact was
observed. It deliberately published every price, valuation, holder, and candle
as `unavailable` because no market Provider existed, and left the
`pool_event` lane unimplemented because nothing consumed it yet.

S5b is the first consumer. It has to say what a token is worth according to a
named Provider at a known time, what a security scanner reported, what a
registered pool actually traded, and — from the same price facts — when a user's
alert condition was met. The failure mode to avoid is the same as in 0033: a
number without provenance, a missing number turned into zero, or one Provider's
absence covered by another's guess.

## Rulings adopted (main agent, 2026-09-08)

| Topic                   | Ruling                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market Providers        | `MarketDataProvider` interfaces plus `createUnavailable*`. DexScreener (verified terms, no credential, official rate limit) on by default; GoPlus (`GOPLUS_APP_KEY/SECRET`) only with the key pair; GeckoTerminal implemented but `MARKET_PROVIDER_GECKOTERMINAL_ENABLED` defaults to false. A missing Provider closes only its own block.                                       |
| Fact shape              | Every fact is `{value, source, fetchedAt, ttlSeconds, quality, reasonCode}` with `quality ∈ fresh, stale, derived, unavailable`. Values are canonical decimal strings.                                                                                                                                                                                                           |
| Candles                 | `GET /v2/market/assets/{assetId}/candles?interval=15m,1h,4h,1d,1w`: GeckoTerminal OHLCV when enabled; otherwise derived from indexed V3 `Swap` events of a registered pool (`quality: derived`, labelled `market.candles.onChainSwapAggregate`); neither → unavailable.                                                                                                          |
| Holders / trades        | `holderCount` from GoPlus; the top-holder distribution stays unavailable. `trades` come from the `pool_event` lane for registered pools only; an unregistered pool is unavailable.                                                                                                                                                                                               |
| new-pairs / smart-money | new-pairs needs GeckoTerminal (default unavailable); smart-money is unavailable (D21).                                                                                                                                                                                                                                                                                           |
| Alerts V2               | `GET/POST/PUT/DELETE /v2/alerts` keyed by `assetId`, camelCase, Idempotency-Key on create; evaluator lane behind `ALERT_EVALUATOR_ENABLED` uses only `quality=fresh` prices; a trigger writes `price_alert_events` plus a `notifications` row with a dedupe window; feed `GET /v2/notifications/feed?cursor=` and `POST /v2/notifications/{id}/read`; push delivery unavailable. |
| Preferences V2          | Ten categories in `notification_preferences_v2`; `security.event` is always on and cannot be written; CAS; the four V1 categories are untouched.                                                                                                                                                                                                                                 |
| Numbers                 | Every price, amount, and volume is a string; the client draws from `Decimal`.                                                                                                                                                                                                                                                                                                    |

## Implementation rulings (2026-09-08)

### Provider transport is lossless and throttled

Every adapter shares `provider-http.ts`: an injected `fetch`, a sliding-window
throttle sized to the Provider's documented limit (DexScreener 300/min,
GeckoTerminal 30/min, GoPlus configurable, default 30/min — each can only be
lowered), an 8 s timeout, and a lossless JSON parse in which every JSON number
stays the exact digit string the Provider sent. A response is never turned
into a JavaScript number: DexScreener's 22-digit market caps and
GeckoTerminal's OHLCV values reach the client with every digit. The SHA-256
digest of the raw body is recorded with the cached fact; the body itself is
never stored or logged, and a Provider error carries a reason code but never
the URL or response text.

### Freshness policy: TTL, grace, and `requireFresh`

`market-fact-service` reads the cache first. Inside the TTL the row is `fresh`
and the Provider is not called. Past the TTL the Provider is called; on
success the row is replaced. On a Provider failure (throttled, unreachable,
malformed, rejected) a row inside `MARKET_STALE_GRACE_SECONDS` past its TTL is
served as `stale` with the failure's reason code; beyond that the fact is
`unavailable`. A disabled or uncredentialed Provider is `unavailable`
regardless of cache: turning a Provider off stops publishing its numbers. The
evaluator lane reads with `requireFresh`, which never accepts `stale`.

TTLs are configuration (`MARKET_PRICE_TTL_SECONDS` 30, `MARKET_SECURITY_TTL_SECONDS`
600, `MARKET_CANDLES_TTL_SECONDS` 60, grace 900).

### The primary pair is the deepest pair where the asset is the base

DexScreener returns every pair a token appears in. Price, liquidity, volume,
change, FDV, and market cap are read from the pair with the highest `liquidity.usd`
among those whose `baseToken` is the asset. A pair where the asset is only the
quote is not a price of the asset and is never used. The response names the
pair (`primaryPair`) so the client can attribute the numbers.

### Security facts are a list, never a score

GoPlus flags become one `{fact, value, source, observedAt}` row each
(`openSource`, `mintable`, `honeypot`, `blacklist`, `buyTax`, …). No rating,
verdict, or risk summary is derived; the client shows the list with its source
and observation time, as the prototype's 合约事实 block does. The raw holder
list GoPlus attaches is dropped at the adapter; only `holder_count` is kept.

### Derived candles are labelled and priced in the pool's other token

With no OHLCV Provider, candles are aggregated in SQL from `indexed_pool_events`
(`event_kind = 'swap'`, `removed = false`) bucketed with `date_bin` on the log's
`block_timestamp`. Per bucket the repository returns the first and last
`sqrtPriceX96` (by block and log index), the max and min `sqrtPriceX96`, the
sum of the asset-side absolute amount, and the swap count. The service converts
each sqrt value with exact integer arithmetic:

```text
price1per0 = sqrtPriceX96² / 2¹⁹² · 10^(decimals0 − decimals1)
price for the asset = price1per0 when the asset is token0, its inverse otherwise
high/low swap orientation for a token1 asset (price is inverse-monotonic in sqrt)
```

The result is truncated to 18 fraction digits as a decimal string. The response
carries `quality: derived`, `source: loop_indexer`, `labelKey:
market.candles.onChainSwapAggregate`, the pool, `quoteAssetId`, and
`priceUnit` (for example `USDT per WBNB`). It is explicitly not a USD price.
Volume is the asset-side amount in the asset's decimals. Weekly buckets are
epoch-aligned (Thursday 00:00 UTC) on both the derived and the GeckoTerminal
path.

### The `pool_event` lane owns its own checkpoint and rewind

`src/bsc-pool-indexer-worker.ts` runs the 0033 state machine
(seeded/advanced/reorged/idle/unavailable, 2000-block segments, 64-block rewind
never below the lane's start) over `Swap/Mint/Burn` logs of `pools.status =
'registered'`. Its rewind marks only `indexed_pool_events` rows removed and
advances only the `pool_event` checkpoint row; the transfer lane's rows and
checkpoint are never touched, and the unit test asserts it. Both lanes share
`BSC_INDEXER_ENABLED`, `BSC_INDEXER_START_BLOCK`, and the read client;
`pnpm indexer:backfill --from <block> --lane pool_event` runs it synchronously.

`block_timestamp` is taken from the RPC log's `blockTimestamp` field
(publicnode returns it; viem exposes it) and, when an endpoint omits it, from
one `eth_getBlockByNumber` per distinct block. It is never interpolated from
a height. Swap rows additionally store `amount0`, `amount1`, and
`sqrt_price_x96` as `numeric(78,0)` so the candle SQL never parses JSON.

### Market responses are 200 with independently unavailable blocks

A Provider that is off, throttled, silent, or uncredentialed does not fail the
request: the affected block is `{status: "unavailable", reasonCode}` (or a fact
with `quality: unavailable`) while the other blocks stand. The exceptions that
remain errors are inputs (`INVALID_REQUEST`, `CHAIN_MISMATCH`, unknown asset
`NOT_FOUND`) and a missing cursor secret (`CAPABILITY_UNAVAILABLE`). A pool lane
that never ran, an unregistered pool, and the native asset (DexScreener needs a
token address; WBNB is never substituted) are all `unavailable` blocks.

### Trending is an ordering, not a recommendation

`GET /v2/market/overview` orders readable registry token assets by DexScreener
24h volume, capped at 20, and stamps the list with a per-response
`recommendationId` (UUIDv4) and `rules {configVersion: marketTrendingV1,
effectiveAt, ordering: dexscreener_volume_h24_desc}`. No engagement, mining, or
community signal enters the ordering.

### Alerts V2 share the table, not the namespace

`price_alert_definitions` gains `asset_id`, `triggered_at`, and
`last_evaluated_at`; `asset_key` becomes nullable with a check that exactly one
of the two is set. V1 rows are `inactive` and keyed by `asset_key`; V2 rows are
`active` or `triggered` and keyed by the canonical asset ID (a check constraint
ties the namespace to the state). Every V1 repository read adds `asset_key is
not null` and every V2 read `asset_id is not null`, so neither surface can see
the other's rows. The same split applies to `price_alert_events`. The create
idempotency scope is `price_alert_create_v2` with its own digest domain.

State machine: `active` → (evaluator, fresh price satisfies the condition) →
`triggered` (one-shot, `triggeredAt` set, `version + 1`). `PUT` re-arms to
`active`. `expired` is a projection of an `active` row past `expiresAt`; the
evaluator never reads it. Thresholds are positive decimal strings compared with
scaled integer arithmetic; `above`/`at_or_above`/`below`/`at_or_below` keep the
V1 meanings.

### A trigger is one transaction and one notification per window

`recordTrigger` flips the definition with `where state = 'active'`, inserts the
append-only event (`source`, `sourceFactRef = dexscreener:<pairAddress>`,
`observedAt = fetchedAt`), and inserts the notification `on conflict
(owner_user_id, dedupe_key) do nothing`, all in one transaction. A concurrent
second trigger sees no row to flip and returns `already_triggered`. The dedupe
key is `trade.priceAlert:<alertId>:<floor(observedAt / ALERT_NOTIFICATION_DEDUPE_SECONDS)>`
(default 3600 s), so a re-armed alert firing again inside the window records
its event but not a second notification. When the owner has disabled
`trade.priceAlert` the event is still recorded and the notification is not.

### Notifications are context rows, not a centre

A notification carries `type` (one of the ten categories), `entityRef`
(`priceAlert:<alertId>`), `contextRoute` (`token`), `contextParams`
(`{assetId}`), a string-only display `payload` (asset, condition, threshold,
observed value, source, observed time), `source`, `observedAt`, and `readAt`.
The feed is owner-bound, newest first, with the V2 cursor codec and an unread
count. `POST /v2/notifications/{id}/read` is naturally idempotent (the first
`readAt` is kept); it still requires the V2 `Idempotency-Key` because it is a
write, but the key is not bound to a durable command. `push` is always
`{status: unavailable, reasonCode: PUSH_RUNTIME_DEFERRED}`.

### `security.event` is rejected, not corrected

`PUT /v2/notification-preferences` requires all ten categories. The route
schema declares `security.event` as `const: true`, so a request that sends
`false` is `400 INVALID_REQUEST` and nothing is written; the alternative of
silently ignoring the value was rejected because a client would then believe
it had disabled the category. The category is never stored: the nine optional
categories live in `notification_preferences_v2`, `security.event` is projected
as `{enabled: true, locked: true}`. Defaults for an owner without a row are
every category on except `community.all` (prototype: 大群建议关闭). The V1
four-category tables are untouched.

### Capabilities

`market` gains `marketRead` (new ID; the mobile enum is synchronised by the
frontend S5 work): `available` when the module is enabled and the registry,
fact cache, indexer repository, and cursor codec are composed. Provider
availability is not part of the capability; it is on every fact. `notifications`
projects three capabilities: `priceAlerts` and `notificationsFeed` (module
enabled plus repository plus cursor codec) and `pushNotifications`, which is
`unavailable` with `PUSH_RUNTIME_DEFERRED` unconditionally — the module gate
no longer moves it, because no FCM/APNs runtime or device-token lifecycle
exists.

## Persistence

Migration `000020_v2_market_alerts` adds `market_fact_cache` (subject key,
fact kind, source, normalised value, raw digest, fetched time, TTL),
`indexed_pool_events.block_timestamp/amount0/amount1/sqrt_price_x96` with the
swap-field check and a partial index for candles, the `price_alert_definitions`
and `price_alert_events` `asset_id` columns and namespace checks, the
`notifications` table with its dedupe unique index, and
`notification_preference_v2_versions` / `notification_preferences_v2`. It also
extends the `idempotency_records` digest check with `price_alert_create_v2`
while keeping every earlier value. Amounts are `numeric(78,0)`; nothing is a
JavaScript number.

## Rollback

Disable `market` and `notifications` in `V2_MODULES_ENABLED`, set
`MARKET_PROVIDER_DEXSCREENER_ENABLED=false`, and leave
`ALERT_EVALUATOR_ENABLED` off; every route then reports `NOT_FOUND` and every
lane stays idle. The migration's `down` deletes V2 alert rows and events,
drops the new tables and columns, and restores the previous digest check; V1
rows are untouched.

## Consequences and evidence gates

The backend can now publish a price with its source and time, a security fact
list with its scanner, a swap tape and derived candles with their pool, and a
triggered alert with the fact that triggered it. What it still cannot do:
push a notification, screen new pairs, show holder distribution, or price the
native asset.

### Wallet valuation (main-agent ruling, S5b patch)

`GET /v2/wallets/{walletId}/balances` values each token row from the
DexScreener price of that asset (deepest base pair) when the fact is `fresh`
or `stale`; a stale price is passed through as `quality: stale` with its
reason. `valueUsd = displayBalance × priceUsd` with exact decimal-string
arithmetic. The native row is `unavailable`
(`MARKET_NATIVE_ASSET_NOT_SUPPORTED`): WBNB is never used as a proxy. A row
whose balance is unavailable is not valued (`BALANCE_UNAVAILABLE`); without
the market runtime every row and the total are `MARKET_RUNTIME_UNAVAILABLE`.
`netWorth` is `available` only when every row is valued, otherwise `partial`
with `unavailableCount` and the sum of the valued rows; both carry
`valuationCurrency: USD`, `priceSource`, `asOf` (latest fetch time), and
`isSpendable: false` — a valuation is display information and never a
balance.

External Go/No-Go items stay open: GoPlus credentials, GeckoTerminal
commercial terms, a BSC endpoint that serves `eth_getLogs` and log
`blockTimestamp` under load, and FCM/APNs.
