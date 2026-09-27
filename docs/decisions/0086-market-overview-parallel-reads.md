# Decision 0086: The market overview reads its Provider facts in one wave under a 1.2 s deadline, and the wallet list re-reads Privy beside the call

- Status: Proposed (backend, S90)
- Date: 2026-09-27
- Scope: `GET /v2/market/overview` (read orchestration only) and
  `GET /v2/wallets` (Privy inventory reuse). Builds on Decisions 0034 (fact
  cache and Provider fail-closed), 0063 (Privy inventory reuse), 0074
  (sparkline cache rows, remembered 24h change) and 0082.
- Baseline: `integration/v2` = `863fe5e`. No migration, no response-shape
  change, no new reason code, no OpenAPI change (`pnpm openapi:check` stays
  current).

## Context

Coordinator measurement on the development stack, 2026-09-27 16:07
(`api.log`): `GET /v2/market/overview` took **8422 ms** once; the same route
otherwise ran 400–1900 ms with the cache expired and 30–90 ms inside the TTL.
`GET /v2/wallets` took **594–969 ms** on every call in the log, against
30–160 ms for the other database routes.

### Measurement

An in-process harness (deleted afterwards): `buildApp` over a copy of the
development registry, pools, users, wallets, watchlist and fact cache
(`loop_api_s90`), a fake Privy bearer verifier resolving the development
account, the real DexScreener / GeckoTerminal / Privy adapters, `fetch`
and `pg` query timings recorded per request. The process was warmed with one
uncounted request, then the `token_pairs` and `new_pools` rows were aged
past their TTL before each measured request, as they are on a device that
opens the tab after 30 s. Registry: 12 readable assets (11 tokens + BNB);
watchlist of the account: 4 rows, 3 of them also in trending.

What one overview request sends (before):

| #   | call                                                                                           | count | time                     |
| --- | ---------------------------------------------------------------------------------------------- | ----- | ------------------------ |
| 1   | `loop_users` by Privy id (auth)                                                                | 1     | 2–5 ms                   |
| 2   | registry `listReadableAssets`                                                                  | 1     | 2–5 ms                   |
| 3   | watchlist `get` — **twice** (row set, then the block)                                          | 2     | 2–5 ms each              |
| 4   | `market_fact_cache.get` `token_pairs`, **one per address, serially**                           | 11    | 1–4 ms each, ~30 ms      |
| 5   | DexScreener `GET /tokens/v1/bsc/{11 addresses}` (the batch)                                    | 1     | 96–650 ms                |
| 6   | `market_fact_cache.put` `token_pairs` + `pair_price_change_h24`, **serially**                  | 21    | 1–19 ms each, ~60 ms     |
| 7   | `market_fact_cache.getMany` `sparkline_1h`                                                     | 1     | 3–5 ms                   |
| 8   | `recallPrimaryPairPriceChange` (USDT has no `h24` today) — **once per row**, USDT is in 2 rows | 2     | 1–3 ms each              |
| 9   | `market_fact_cache.get` `new_pools`                                                            | 1     | 1–3 ms                   |
| 10  | GeckoTerminal `GET /networks/bsc/new_pools` — **after** the DexScreener read returned          | 1     | 83–795 ms (and see 429s) |
| 11  | `market_fact_cache.put` `new_pools`                                                            | 1     | 4 ms                     |

So the rows were **not** read one Provider call per asset: the pairs batch
already covered every watchlist and trending address, and `pairFactsFor`
did reuse it (no `readTokenPairs` call was observed). The cost was:

1. the two Provider reads of the page ran one after the other;
2. the Provider HTTP kernel's timeout is 8 s. With a Provider request that
   stalls, the page waited for it in full. Reproduced by holding the
   DexScreener (or GeckoTerminal) request open: **9017 ms / 8340 ms**
   (DexScreener), **8274 ms / 8048 ms** (GeckoTerminal) — the 8422 ms of the
   log is one stalled request plus the rest of the page. Because a failed
   read writes no cache row, every following overview re-tried it and paid
   the 8 s again until it answered;
3. about 30 serial database round trips around the Provider reads.

GeckoTerminal answered `429` to most `new_pools` reads during the
measurement (the development worker's sparkline lane shares the egress IP
and GeckoTerminal's 30/min limit is per IP). A 429 writes no cache row, so
the overview asks again on every call; the stale row inside the grace
window keeps the card `available`.

`GET /v2/wallets`: the whole cost is one Privy `GET /v1/users/{id}`
(**550–635 ms** per call; database sync 7–11 ms in 6 statements). The
inventory reuse window of Decision 0063 is 30 s and the device calls the
route every 1–3 minutes (log: 61 s, 91 s, 167 s, 129 s apart), so nearly
every call went to Privy. Privy itself costs 280–340 ms even back to back on
a warm connection, 800–1100 ms after a few seconds idle, 2.4 s on a cold
process — a Privy read on the request path can never be under 200 ms from
this host.

## Decision

### 1. Overview: one wave, one deadline

- The registry and the watchlist are read together, and the watchlist once.
- The pairs batch, the sparkline cache read and the GeckoTerminal new-pools
  read start together (`Promise.all`). Each still goes through its adapter's
  own per-Provider throttle (Decision 0034); nothing about the budgets
  changes, and the page sends exactly the same Provider requests as before:
  one DexScreener batch per 30 addresses and one new-pools read.
- Both Provider reads carry one signal: the request's abort signal combined
  with `AbortSignal.timeout(marketOverviewProviderDeadlineMs = 1200)`. A read
  cut off by the deadline is handled exactly as an unreachable Provider
  (the kernel already maps an abort to `MARKET_PROVIDER_UNREACHABLE`): the
  cached value inside TTL + `MARKET_STALE_GRACE_SECONDS` is published
  `stale` with that reason; with no usable row the fact is `unavailable`
  with that reason. Nothing new is invented and nothing is substituted.
  1200 ms is above every normal answer measured (96–795 ms, first TLS
  handshake included) and keeps the page under 1.5 s with a stalled
  Provider.
- Inside the request, one `PairFacts` per asset and one
  `recallPrimaryPairPriceChange` per `(address, pair)` are shared by every
  row that needs them (watchlist ∩ trending, BNB and WBNB). Rows are built
  with `Promise.all` in their original order.
- `readTokenPairsBatch` reads all cache rows in one `getMany` query instead
  of one `get` per subject, sends its ≤30-address chunks together rather than
  one after another, and writes the returned rows four at a time.
- Fail-closed semantics are unchanged: a single asset missing from the
  Provider's answer is that row's own `unavailable` / `stale` fact; the
  other rows, the trending order and the new-pairs card are untouched; a
  cache that cannot be read is `MARKET_FACT_CACHE_UNAVAILABLE` for every
  pairs fact as before.

### 2. `GET /v2/wallets`: 60 s window, shared read, refresh beside the call

- `defaultWalletInventoryTtlMs` 30 s → **60 s** (the ceiling set for this
  task). The observation stays in process memory and is empty after a
  restart; it is never persisted.
- Past half the window (30 s) a call is still answered from the
  observation, and Privy is re-read **beside** it; the next call gets the
  new observation. No answer is ever built from an observation older than
  the window, and `source.observedAt` keeps reporting when Privy was
  actually read (Decision 0063).
- Concurrent calls for the same Privy subject share one Privy read. The
  shared read is not bound to any single caller's abort signal (the SDK's
  own 4 s timeout bounds it); a caller whose request is aborted stops
  waiting. A refresh that fails leaves the observation in place until it
  expires; after that the caller waits for Privy and a failure is
  `503 PROVIDER_DISCONNECTED` as before.
- Effect: a user who uses the app at least once a minute never waits for
  Privy; a first call after more than 60 s idle still costs one Privy read.

## Results (same harness, same machine, real Providers)

`GET /v2/market/overview`, cache expired before each request:

| scenario                                       | before                           | after                          |
| ---------------------------------------------- | -------------------------------- | ------------------------------ |
| 5 requests, Providers answering                | 741 / 380 / 545 / 466 / 278 ms   | 402 / 148 / 207 / 140 / 138 ms |
| inside the TTL                                 | 170 ms (GeckoTerminal 429 retry) | 106 ms (same)                  |
| DexScreener request stalled                    | 9017 ms, then 8340 ms            | 1244 ms, then 1231 ms          |
| GeckoTerminal request stalled                  | 8274 ms, then 8048 ms            | 1238 ms, then 1223 ms          |
| database round trips per request (TTL expired) | 40                               | 28                             |
| Provider requests per request                  | 2 (serial)                       | 2 (together)                   |

`GET /v2/wallets`, one account, same process:

| call time             | before                 | after                        |
| --------------------- | ---------------------- | ---------------------------- |
| t = 0 (cold process)  | 1242 ms (Privy 628 ms) | 766 ms (Privy 269 ms)        |
| t = 5 s               | 19 ms                  | 17 ms                        |
| t = 35 s              | 662 ms (Privy)         | 31 ms (Privy re-read beside) |
| t = 38 s              | 11 ms                  | 8 ms                         |
| t = 68 s              | 644 ms (Privy)         | 24 ms                        |
| t = 133 s (65 s idle) | 664 ms (Privy)         | 618 ms (Privy)               |

## Not changed / open

- A failed Provider read still writes nothing, so a Provider that keeps
  failing (GeckoTerminal 429 on the development IP) is asked on every
  overview, now for at most 1.2 s. A short failure cooldown would stop that;
  not done here because it changes when a recovered Provider is seen.
- The development API and worker share GeckoTerminal's per-IP 30/min limit;
  `MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE` +
  `MARKET_GECKOTERMINAL_BUDGET_WORKER` above 30 on one IP produces the 429s.
- `GET /v2/wallets` after more than 60 s idle is still one Privy read
  (270–1100 ms). Getting it under 200 ms needs the list answered from the
  last database projection while Privy is re-read in the background, i.e. an
  observation older than 60 s — a coordinator decision on Decision 0063.
