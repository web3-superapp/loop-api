# Decision 0088: Hot read routes run their legs together and reuse short-lived Provider observations

- Status: Proposed (backend, S93)
- Date: 2026-09-28
- Scope: `GET /v2/communities/{communityId}`, `GET /v2/chain/status`,
  `GET /v2/wallets/{walletId}/balances`, `GET /v2/communities/{communityId}/ai/overview`,
  `POST /v2/communities/{communityId}/ai/ask`, `GET /v2/market/assets/{assetId}`,
  `GET /v2/wallets/{walletId}/activity`, and a new operator script
  `pnpm route-latency`. Builds on Decisions 0047 (presence), 0033/0049 (chain
  status), 0063/0082 (balances legs, S86b pinned allowance), 0066 (Community
  AI knowledge), 0085/0086 (parallel reads, reuse windows).
- Baseline: `integration/v2` = `f4d156b`. No migration, no response-shape
  change, no new reason code, no OpenAPI change (`pnpm openapi:check`:
  "OpenAPI artifacts are current"). The number 0088 is this repository's; the
  loop-mobile Decision 0088 cited by 0077/0081 is a different document.

## Context

TestFlight users report every screen as slow. The main agent's log
extraction (staging = AWS Singapore 24 h, dev = this Mac) put these routes on
top: community detail p50 1.0 s staging / p95 1.7 s dev, balances p50 1.2 s /
2.5 s, chain status 2–3 s, AI overview 1.3–1.9 s, AI ask 3.3–4.6 s, asset
detail and candles p95 0.7–2.6 s, activity 0.4–0.6 s, voice join/leave ~1 s.

## Method

In-process harness (not committed): `buildApp` with the worktree's
`.env.local` (development Privy and Stream apps), a copy of the development
database (`loop_api_s93`, `pg_dump` of `loop_api_dev`), a fake bearer
verifier resolving the development account, real Providers: Stream, Privy,
DexScreener, GeckoTerminal, BSC mainnet `bsc-dataseed.bnbchain.org`, BSC
testnet `data-seed-prebsc-1-s1.bnbchain.org:8545`, and the launch contract
`0x2b26…3396` with USD1 `0x17d5…ce2b` read from its `getSaleConfig(1)`. There
is no Community AI key outside `ops/api-dev.local.env` (not read), so the model
is a stand-in that answers at once; the AI numbers are LOOP's own work only.
`pg.Client.query`, `fetch` and `http.client` diagnostics were timed per
request. The primary endpoint of the development stack,
`bsc-rpc.publicnode.com`, answered one `eth_blockNumber` in 1.8–8 s from this
Mac on 2026-09-28 (curl, six tries, `bsc-dataseed.bnbchain.org` 0.55–0.69 s
with a fresh TLS handshake each), so it was not used for the A/B runs; see
"Not changed / open".

Before and after were run by the same harness against two worktrees
(`f4d156b` and this branch), one after the other, over the same database and
endpoints.

## Results (ms, server-side, measured on this Mac 2026-09-28)

Three runs: **warm** = 10 requests 1.5 s apart (reuse windows hit);
**miss** = 4 requests 31 s apart (presence and price windows lapsed) or 3
requests 61 s apart (chain probe and candle windows lapsed); **+KA** = this
branch with ruling 7 (outbound keep-alive) as `src/server.ts` configures it.
"first" is the first request of a fresh process and is left out of p50.

| Route                                           | Run  | Before p50 / p95 | After p50 / p95 | After +KA p50 / p95 |
| ----------------------------------------------- | ---- | ---------------- | --------------- | ------------------- |
| `GET /v2/communities/:id` (324 members)         | warm | 1328 / 1570      | 25 / 1174\*     | 30 / 1117\*         |
| `GET /v2/communities/:id` (7 members)           | warm | 340 / 503        | 20 / 416\*      | 21 / 408\*          |
| `GET /v2/communities/:id` (324 members)         | miss | 1528 / 1808      | 1019 / 1202     | 780 / 1262          |
| `GET /v2/chain/status`                          | warm | 479 / 1286       | 262 / 974       | 234 / 581           |
| `GET /v2/chain/status`                          | miss | 1575 / 1659      | 644 / 819       | 802 / 1130          |
| `GET /v2/wallets/:id/balances`                  | warm | 904 / 1413       | 439 / 1570\*    | 560 / 1367\*        |
| `GET /v2/wallets/:id/balances`                  | miss | 1884 / 2152      | 1384 / 1586     | 563 / 1480\*        |
| `GET /v2/communities/:id/ai/overview`           | warm | 1825 / 2280      | 407 / 1462\*    | 412 / 1375\*        |
| `POST /v2/communities/:id/ai/ask` (stand-in AI) | warm | 1825 / 2348      | 427 / 466       | 394 / 495           |
| `GET /v2/market/assets/:id`                     | warm | 12 / 553         | 12 / 695        | 19 / 478            |
| `GET /v2/market/assets/:id`                     | miss | 567 / 661        | 416 / 536       | 212 / 473           |
| `GET /v2/market/assets/:id/candles`             | warm | 203 / 763        | 10 / 1311\*     | 19 / 1261\*         |
| `GET /v2/market/assets/:id/candles`             | miss | 1586 / 3281      | 1038 / 1750     | 1601 / 2017         |
| `GET /v2/wallets/:id/activity`                  | warm | 248 / 580        | 222 / 823\*     | 183 / 616\*         |
| `GET /v2/wallets` (Decision 0086, unchanged)    | warm | 17 / 609         | 14 / 575        | 17 / 601            |

\* p95 of n = 10 is the first request of the process (cold TLS, cold caches).

Reading the table:

- Candles were not changed; the differences are GeckoTerminal. In the
  before "warm" run GeckoTerminal answered `429` (the development worker
  shares the egress IP, Decision 0086 ruling 3). A `429` writes no cache
  row, so every request in that run asked GeckoTerminal again (p50 203 ms).
  In the other runs it answered `200` and the row was reused (p50 10–19 ms).
  The "miss" rows are two dependent GeckoTerminal calls (token → pool →
  OHLCV) and vary with that Provider.
- The chain status "miss +KA" run (802 ms) is within the spread of the
  public endpoint's probe. Its three samples are 782, 802 and 1130 ms. Both
  after-runs send the same RPC requests.
- Balances after "warm" without keep-alive (439 ms) is lower than with it
  (560 ms). The two runs were 20 minutes apart. Privy's balance view alone
  measured 400–630 ms in both, and it is now the page's floor (see "Not
  changed").

## Root causes and rulings

### 1. Community detail: presence was four Stream round trips on every read

One detail read issued, strictly in sequence: the community record, the
membership, the channel record, the Mining Power baseline (formula, snapshot,
standing, weight: five queries), and then the Stream presence read.
Presence paged `queryMembers` 100 members at a time, **one page after
another, on every read, never reused**. The 324-member community cost four
Stream round trips (4 × 330–500 ms); a 7-member one cost one (~330 ms). The
database part was 40–120 ms.

- The record, channel, Mining Power and presence legs start together;
  presence waits only for the channel record it needs. The channel, Mining
  Power and presence legs never reject, so the record read alone still
  decides whether the page exists for the viewer (404/403 unchanged). A
  presence read may now be sent for a community the record read then
  refuses; its result is discarded.
- The presence gateway reads the first page; if it is full, it reads pages
  2–5 together. The count is still the ordered sum up to the first short
  page, and all five pages full is still `bound_exceeded`. A 101–499 member
  channel sends up to 3 more Stream requests than it strictly needs, all in
  the same round trip.
- One Stream observation per channel is reused for **≤ 30 s**
  (`communityPresenceCacheTtlMilliseconds`). Past 15 s a read is still
  answered from it, and Stream is asked again beside the read. Concurrent readers
  share one Stream read. Only an observation (a count or the member bound) is
  remembered; a failure or a timeout is never reused. `observedAt` is the
  time Stream was read. The entries are held in process memory, capped at
  2 000 channels, and a restart empties them.

### 2. Chain status: five sequential RPC stages

Before: `verifyChain` → `probeEndpoints` (per endpoint `eth_chainId` +
`eth_blockNumber`) → `getHead` → two lane checkpoints one after another →
registry counts → launch `verifyChain` → launch `getHead`. That was three to
five RPC stages in sequence. The development stack's primary endpoint
`bsc-rpc.publicnode.com` answered in 1.8–8 s from this host at measurement
time; that is the development p95 of 7.8 s.

- Every leg runs together. The head waits only for the verification; the
  primary and launch heads are read in parallel.
- The endpoint probe is reused for **≤ 60 s**
  (`chainStatusObservationTtlMs`) and re-run beside the call past 30 s; each
  endpoint's `observedAt`/`latencyMs` are those of the probe that measured
  them. A `verified`/`mismatched` state was already cached for good by the
  client. An `unreachable`/`unknown` state is now asked again at most once
  per 60 s by this route. A recovery seen by any other read is reported at
  once through `currentVerification()`. **Heads are never reused**, so
  `lagBlocks` is always against a live head.

### 3. Balances: the launch slot was five testnet round trips in a row

The primary block (head, then token multicall and native balance together)
was already two round trips, in parallel with the other legs. On a cache miss
the page instead waited for two other legs:

- the launch slot: native `readBalances` (head + `eth_getBalance`), then USD1
  `readBalances` (head + multicall), then the S86b pinned allowance
  (multicall + header). That was five sequential round trips, ≈ 0.9 s on
  `data-seed-prebsc-1`;
- the prices: 11 per-asset DexScreener `token-pairs` reads, 4 at a time (3
  waves, ≈ 1 s), on every price-TTL (30 s) miss.

Rulings:

- `BscReadClient.readBalances(owner, items, { atHead })`: a caller that
  already read the head on this client's interactive lane passes it. The
  head read is skipped, every call is pinned to `atHead.blockNumber`, and the
  returned head is `atHead`. Without the option nothing changes.
- The launch slot reads its head once. It then asks the native balance, the
  USD1 balance (both `atHead`) and the USD1 allowance (`atBlock`, S86b)
  together: two round trips instead of five. One 3 s deadline bounds the leg.
  The Decision 0082 failure table is unchanged per projection: a head or
  deadline failure makes the block unavailable
  (`LAUNCH_CHAIN_RPC_UNREACHABLE`, …) with the pair absent; a failed
  allowance drops only the pair; the 0077 same-block guard stays. The
  shared-slot root `launchUsd1` uses the same head → (balance ‖ allowance)
  path.
- `assetPriceConcurrency` 4 → 12 (the registry has 11 readable assets).
  Before raising it, three rounds of 11 concurrent `/token-pairs/v1`
  requests were sent on 2026-09-28; all 33 answered 200 in 0.18–0.46 s.
  The DexScreener batch endpoint was tried and rejected: `/tokens/v1` returned
  11 pairs for 11 tokens against 30 per token from `/token-pairs/v1`, so
  it is not the same fact.
- Unchanged: the primary block and its hedge, the Privy cross-check, the
  snapshot audit rows, and the response shape.

### 4. Community AI overview and ask: the knowledge was assembled serially

The overview never calls the model on the request path: the brief is
generated in the background and cached per community for an hour (Decision
0066). **No new cache was needed.** Its 1.8 s was the knowledge assembly,
run strictly in order: the community detail (with the four-page presence
read above), the bound asset's market facts, mining, voice room, the chat
channel record, Stream `queryChannels` for the messages, and persona
aliases. `ask` runs the same assembly before its own work.

- Mining and voice start with the community read; the asset and chat legs
  start once it has answered (the chat leg still needs the membership, and a
  non-member's channel is never read). Every leg settles to a source or an
  omitted reason. Sources are numbered in the same fixed order as before
  (`s1` profile, then asset, mining, voice, chat), so `sourceId`s and
  `omittedSources` do not depend on timing.
- `ask` has no redundant pre-reads beyond that assembly (idempotency begin,
  model, complete). With the stand-in model it costs 0.4 s. The real model
  time comes on top: the development log shows 4.6 s total, so about 3.2 s
  is expected.

### 5. Asset detail, candles, activity

- `GET /v2/market/assets/{id}` read the pair facts, then the bound
  community, then GoPlus, then the 24h range. They now run together. Only
  the Decision 0064 top-pool fallback still waits for the pair facts it
  replaces.
- `GET /v2/wallets/{id}/activity` read the head after the four database
  reads; it is now asked once the wallet is known to be the caller's, beside
  them. One head round trip (~170–220 ms) is the floor.
- Candles: token → top pool → OHLCV is a real dependency, not a serial
  accident. The cost on development is GeckoTerminal `429` (see the table).
  Not changed.

### 6. `pnpm route-latency`

`scripts/route-latency.ts` (`pnpm route-latency [--top N] [--route frag]
<log…>`, stdin without files). It reads the "Request completed" lines in raw
pino JSON (staging) or pino-pretty (development) and prints p95 / p50 / max /
n per `METHOD route`, using the same percentile rule as
`ops/route-latency.py`. Health probes are skipped, and only route templates
are printed.

### 7. Outbound keep-alive (found while measuring)

Node's `fetch` closes an idle pooled connection after 4 s (undici's default
`keepAliveTimeout`). Every Provider this API calls goes through `fetch`:
viem's RPC transport, the Privy SDK, the Stream node SDK, DexScreener,
GeckoTerminal and GoPlus. So any page opened more than 4 s after the last
call to that Provider paid a TCP + TLS handshake first. Measured from this
host: `eth_blockNumber` took 161–213 ms on a reused connection and 541–736 ms
after 5–10 s idle. With a 60 s keep-alive it took 156–228 ms after 5, 10 and
30 s idle.

- `configureOutboundKeepAlive()` (`src/core/http/outbound-keep-alive.ts`)
  installs the global undici `Agent` with `keepAliveTimeout: 60 000` (server
  hints are still honoured, up to 600 s). `src/server.ts` calls it before
  `buildApp`; tests and workers keep Node's default.
- New dependency `undici@7.29.0`, pinned to the version Node 24.19 bundles,
  so the dispatcher is the same implementation `fetch` already uses. Nothing
  else changes: timeouts, retries, budgets. A server that closes earlier is
  simply reconnected, as before.
- Effect on the 31 s-apart runs: balances 1384 → 563 ms, community 1019 →
  780 ms, asset 416 → 212 ms.

## Verification

- `test/community-presence-reader.test.ts` (+6): reuse for 30 s, a refresh
  beside the call past 15 s that keeps the time Stream was read, never
  served at or past the window, concurrent readers share one read, failures
  and timeouts not remembered, the member bound remembered, zero TTL reads
  every time, negative TTL refused.
- `test/stream-communication-gateways.test.ts` (+2, 1 changed): pages 2–5
  are asked together after a full first page (peak 4 in flight); a short
  first page asks one page; the count of 103 members is unchanged.
- `test/v2-community-routes.test.ts` (+1): record, channel and presence are
  in flight together, and a second detail read inside the window does not
  call Stream.
- `test/chain-status-service.test.ts` (new, 5): all seven legs in flight
  before any answers; probe reused below 60 s, refreshed beside at 30 s,
  heads read every time; unreachable asked once per window and a recovery
  reported at once; a shared probe and a failed probe not remembered; zero
  window.
- `test/bsc-rpc-client.test.ts` (+1): `readBalances(…, { atHead })` sends no
  `eth_getBlockByNumber` and pins `eth_call`/`eth_getBalance` to the given
  block.
- `test/wallet-balances-latency.test.ts` (+2): the launch slot reads one
  head, then native, USD1 and allowance in flight together at it; a failed
  allowance keeps the native block and drops only the pair. The existing
  0082/S86b route cases pass unchanged.
- `test/market-fact-service.test.ts` (1 changed): at most twelve price reads
  at once, in order.
- `test/v2-community-ai.test.ts` (+2): mining and voice start with the
  community read, chat before mining/voice answer, answers in reverse order
  still number `s1…s4` in the fixed order; the assembly still fails when the
  community read fails.
- `test/market-overview-parallel-reads.test.ts` (+1): the asset detail's
  pair, security, community and range reads are in flight together.
- `test/v2-chain-wallet-routes.test.ts` (+1): the activity head is asked
  before the transfer page returns.
- `test/outbound-keep-alive.test.ts` (new, 2): the configured keep-alive
  governs `fetch` connection reuse against a server that sends no hint.
- `test/route-latency-script.test.ts` (new, 3).

## Not changed / open

- **Development primary endpoint.** `bsc-rpc.publicnode.com` took 1.8–8 s
  per request from this host on 2026-09-28. That is ops (`BSC_RPC_URLS`
  order, NodeReal pending), not code, and it dominates the development
  numbers for chain status, balances and activity.
- **Privy balance view** (400–630 ms per call) is the balances page's floor
  now; the cross-check cannot be reused without comparing a stale Privy
  value with a fresh block.
- **GeckoTerminal 429** on the shared development IP makes every candles
  request a Provider call (Decision 0086 ruling 3: no cooldown).
- **Voice join/leave** (~1 s): database, then Stream `updateCallMembers`,
  then the post-write observation (plus `ensureLive` on join). The order is
  inherent to a write followed by its observation; not changed.
- **DexScreener batch rows.** The market overview (0086) writes
  `/tokens/v1` batch snapshots into the same `token:<address>/token_pairs`
  cache rows that per-asset reads fill from `/token-pairs/v1`. The two
  endpoints return different pair sets (see ruling 3), so the wallet page
  can read either fact depending on which wrote last.
- Workers still use Node's default 4 s keep-alive.

## Rollback

Every ruling is local to its file. Reverting this commit restores the
previous behaviour; there is no migration and no stored state. The
presence and chain-status windows can be disabled in code (`0`) without other
change.

## 主代理裁决（2026-09-28）

状态：Accepted，随 `integration/v2` 合并。

1. `undici` 60 s 出站 keep-alive：接受；worker 进程也接上（S93b 一并做）。
2. 在场读数最长 30 s 旧、第 2–5 页投机预取：接受，`observedAt` 保持真值。
3. DexScreener 价格并发 4→12：接受，视为对 0063 上限的修订。
4. `token_pairs` 缓存被 overview 的批量快照（每币 1 对）与单币读（每币 30 对）交替覆盖：裁决——单币读为权威；批量快照只在该币没有更新的单币行时写入，或写入独立命名空间。开 S93b。
5. dev 的 publicnode 变慢：dev 是本机，不单独处理；用户环境（香港）API 已 dataseed 优先。
6. 余额下限 = Privy 交叉核对 0.4–0.6 s：接受。
7. 编号：loop-api 0088 与 loop-mobile 0088 是两份文档。
