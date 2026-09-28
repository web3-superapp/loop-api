# Decision 0089: Token logos are served by this API's own proxy, and batch pair snapshots live in their own namespace

- Status: Proposed (backend, S96 + S93b)
- Date: 2026-09-28
- Scope: new public route `GET /v2/market/logos/{chainId}/{file}`; the
  `logo.url` of every surface Decision 0072 extended (market overview,
  asset page, new pairs, wallet balances and launch-slot native balance,
  watchlist, mining assets, `search?domain=assets`); new table
  `token_logo_cache` (migration `000045`); new error code
  `PROVIDER_UNREACHABLE` (502); `token_pairs` batch rows (S93b, 0088 ruling
  4); outbound keep-alive in the worker (S93b, 0088 ruling 1).
- Baseline: `integration/v2` = `006f461`. Builds on Decisions 0034, 0072,
  0086, 0088. The number 0089 is this repository's.

## Context

Network check by a mainland-China tester, 2026-09-28 15:28, no VPN: LOOP API
0.5–1.4 s, Privy 2.7 s, Stream 0.29 s, BSC dataseed 0.37 s,
**raw.githubusercontent.com timed out**, Firebase timed out. Decision 0072
had the client load the upstream URL directly, so every Trust Wallet logo
failed there and users saw only monograms. DexScreener's CDN is not
guaranteed from there either.

## Decision

### 1. Route

`GET /v2/market/logos/{chainId}/{file}`, registered by the `market` module.

| Item      | Rule                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth      | none; no `X-Loop-Contract-Version` or other LOOP header required (an image loader sends none). OpenAPI `security: []`.                                   |
| `chainId` | enum `eip155:56` only (the only chain the 0072 rule covers). Anything else: 400 `INVALID_REQUEST`.                                                       |
| `file`    | `^(0x[0-9a-fA-F]{40}\|native)\.png$`; lowercased before use. Anything else, and any query string: 400 `INVALID_REQUEST`, no upstream request.            |
| 200       | PNG / JPEG / GIF / WebP bytes, `Content-Type` from the sniffed signature, strong `ETag`, `X-Content-Type-Options: nosniff`.                              |
| Caching   | `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`; `public, max-age=300` when a lower origin was served because a higher one failed. |
| 304       | `If-None-Match` matches (strong or `W/`, list, or `*`); `ETag` and `Cache-Control` repeated, empty body.                                                 |
| 302       | picture larger than 256 KiB; `Location` is the allow-listed upstream URL.                                                                                |
| 404       | `NOT_FOUND`: no origin has a picture.                                                                                                                    |
| 502       | `PROVIDER_UNREACHABLE`: an upstream timed out or failed and no stored picture exists.                                                                    |

Errors use the seven-field envelope with `Cache-Control: no-store`.

### 2. Origins and SSRF

The upstream URL never comes from the request. Candidates, in order
(0072 rules):

1. `dexscreener`: the base-pair `imageUrl` in the cached `token_pairs` fact
   of that address — the per-token row `token:<address>` first, then the
   batch row `tokenbatch:<address>` (§5). One `market_fact_cache` query, no
   Provider call. The primary pair is preferred; a pair where the token is
   only the quote is never used.
2. `trustwallet`: the rule URL (`…/assets/<EIP-55>/logo.png`,
   native `…/info/logo.png`).

Every candidate and every redirect hop passes `acceptTokenLogoUrl`
(https, no credentials/port, host exactly `cdn.dexscreener.com`,
`dd.dexscreener.com` or `raw.githubusercontent.com`, ≤ 512 chars). Redirects
are followed by hand (`redirect: "manual"`), at most three, each re-gated; a
redirect off the list is treated as "no picture". Bytes are accepted only by
signature (PNG, JPEG, GIF, WebP); SVG, HTML and empty bodies are "no
picture", whatever the upstream's `Content-Type` says.

### 3. Fetch and cache rules

| Upstream answer                                        | Stored row (`token_logo_cache`)          | Route |
| ------------------------------------------------------ | ---------------------------------------- | ----- |
| raster image ≤ 256 KiB (262 144 bytes)                 | `found`, bytes + ETag, **7 days**        | 200   |
| > 256 KiB (by `Content-Length` or by bytes read)       | `oversize`, no bytes, `source_url`, 24 h | 302   |
| every origin 4xx other than 408/429, or not an image   | `missing`, **24 h**                      | 404   |
| timeout (5 s per origin), network error, 5xx, 408, 429 | **nothing written**                      | 502   |

- A higher origin that failed and a lower one that answered: the picture is
  served (`max-age=300`) but not stored, so the better origin is tried again.
  A higher origin that answered 404 falls through normally and the lower
  origin's picture is stored.
- A row also records `candidate_url`, the top candidate when it was fetched.
  A row whose `candidate_url` differs from the current top candidate is
  refetched before its expiry (a DexScreener image appeared after a Trust
  Wallet file or a "missing" was stored).
- A `found` row past 7 days is refetched; if that refetch fails, the old
  bytes are served (never a 502 while a picture exists).
- One resolution per token is in flight at a time; concurrent requests share
  it (one cache read, one upstream fetch, one write). At most eight
  resolutions fetch upstream at once.
- Upstream requests use the global `fetch`, so the API process's 60 s
  keep-alive dispatcher (0088 ruling 7) applies.
- Without a database (`database.tokenLogoCache` absent) pictures are served
  and nothing is stored; cache read/write failures are logged and treated
  the same way.

### 4. Projection (`logo` on every asset row)

The response shape is unchanged: `{status:"available", url, source,
observedAt}` or `{status:"unavailable", reasonCode}`.

- `url` is always `<PUBLIC_BASE_URL>/v2/market/logos/eip155:56/<lowercase
address>.png` (or `native.png`). One URL per asset, whichever origin the
  projection chose, so a CDN caches it once.
- `source` / `observedAt` keep the 0072 meaning: `dexscreener` with the pair
  fact's `fetchedAt` when the row was built next to a pair fact with an
  admissible image, otherwise `trustwallet` with `null`. The proxy decides
  its own origin at fetch time from the cache; the two agree whenever the
  pair fact is cached.
- `unavailable` reasons: `TOKEN_LOGO_ADDRESS_UNKNOWN` (pool row without a
  base token), `TOKEN_LOGO_CHAIN_UNSUPPORTED` (any chain but BSC mainnet —
  a Provider image on another chain is no longer published, since the
  proxy cannot serve it), and new `TOKEN_LOGO_PROXY_UNAVAILABLE` (the
  `market` module, which registers the proxy route, is not enabled). Fail
  closed: no upstream URL is ever published as a fallback.
- The schema pattern is now
  `^https?://[^\s/?#]+(/[^\s?#]*)?/v2/market/logos/(eip155:56)/(0x[0-9a-f]{40}|native)\.png$`
  (http is allowed for local `PUBLIC_BASE_URL`; production config already
  requires https). The upstream hosts no longer appear in any response.
- Implementation: `createTokenLogoProjector({ publicBaseUrl })` in
  `src/features/market/token-logo.ts`; the market, wallet, watchlist,
  mining and community services receive it as `tokenLogos`.
- Launch project assets: no Launch projection publishes a `logo` today, and
  `src/features/launch/*` was not touched. When one does, it takes the same
  projector.

### 5. S93b: batch pair snapshots in their own namespace (0088 ruling 4)

Chosen option: **independent namespace**, the smaller change. The overview
batch read (`/tokens/v1`, one pair per token) writes
`subject_key = 'tokenbatch:<address>'` (fact kind `token_pairs`, source
`dexscreener`) and never `token:<address>`. The per-token read
(`/token-pairs/v1`, up to 30 pairs) keeps sole ownership of
`token:<address>`, so the asset page, wallet prices, alerts and mining can
never read a one-pair batch snapshot as their fact.

The batch reader still makes one cache query (0086) over both namespaces:
a fresh per-token row wins, then a fresh batch row; with both expired it asks
the batch endpoint, and on failure serves the newer of the two as `stale`
inside the grace window. No migration (subject keys are free-form under the
existing check). The rows written before this change under `token:` by the
batch expire within their 30 s TTL.

The "write only when there is no newer per-token row" option was not taken:
the batch only writes on a miss, when the per-token row is already expired,
so it would still overwrite it and per-token readers would still see one
pair for the next 30 s.

### 6. S93b: worker keep-alive (0088 ruling 1)

`runReconciliationWorker` calls `configureOutboundKeepAlive()` first, before
the database or any Provider client is built (option
`configureOutboundKeepAlive` is the test seam). All worker entry points go
through it (`src/reconciliation-worker.ts`).

### 7. New error code

`PROVIDER_UNREACHABLE`: 502, `availability`, retryable,
`errors.provider.unreachable`. Added to the frozen catalog (31 codes),
`docs/api-v2-conventions.md` and the contract test. Used only by the logo
route today.

## Storage

Migration `000045_v2_token_logo_cache` (append-only; `down` drops the table,
which only holds re-fetchable cache):

`token_logo_cache(chain_id, address, status, bytes, content_type, etag,
source, source_url, candidate_url, fetched_at, expires_at, created_at,
updated_at)`, primary key `(chain_id, address)`. Checks: chain
`eip155:<n>`; address lowercase `0x`+40 hex or `native`; status in
`found|missing|oversize`; `found` requires 1–262 144 bytes, a raster
content type, a quoted base64url ETag, source and source URL; `missing` /
`oversize` hold no bytes; URLs https and ≤ 512; `expires_at > fetched_at`.
`address` is the key of a cache of a public external fact (as
`market_fact_cache.subject_key` is); no LOOP entity is identified or joined
by it.

## Verification

- `test/token-logo-proxy.test.ts` (18): miss → fetch → store 7 d → hit;
  DexScreener first, Trust Wallet on its 404, batch-row image; off-list
  Provider image never fetched; native; 404 remembered 24 h then re-asked;
  early refetch when a Provider image appears; timeout → unreachable, no
  write; 5xx/408/429/network → unreachable; degraded served, not stored;
  expired bytes served when the refetch fails; > 256 KiB → redirect + marker
  (by header and by body), exactly 256 KiB proxied; 10 concurrent requests →
  1 fetch/1 read/1 write; 20 tokens at once → peak 8 upstream; redirect followed on-list only (metadata IP
  refused); SVG/HTML/empty refused; no database; sniffing; `If-None-Match`.
- `test/v2-market-logo-routes.test.ts`: 200 headers without any auth header,
  304/200 by ETag, checksum address and `native.png`, 404 envelope, 502
  envelope with no write, 302, degraded `max-age=300`, 400 for bad
  address/extension/chain/query/traversal before any upstream call, route
  absent without `market`.
- `test/token-logo.test.ts`: projector URL, `source` / `observedAt`, same URL
  for every origin, no upstream host in the output, proxy unavailable,
  chain unsupported, schema pattern.
- Route tests of market, wallet (watchlist + baseline fixture), mining,
  community search, and the search integration test: every `logo.url` is
  the proxy URL.
- `test/market-fact-service.test.ts` (+3): batch writes only `tokenbatch:`,
  per-token reader ignores it; fresh per-token before fresh batch, no
  Provider call; stale fallback takes the newer row.
- `test/worker-runtime.test.ts` (+2): keep-alive configured before the
  database; the default installs a new dispatcher.
- `test/token-logo-cache.integration.test.ts`: migration, checks, upsert,
  bytea round trip, the proxy against Postgres.

## Open for the main agent

1. `PROVIDER_UNREACHABLE` (502) is a new code in the frozen catalog; the
   task named 502. The alternative is the existing `PROVIDER_DISCONNECTED`
   (503). The mobile client only needs "not 200 → monogram".
2. `native.png` is an addition to "only `0x` + 40 hex": the native coin
   (BNB) also needs a logo that is reachable from mainland China.
3. `oversize` stores a 24 h marker (no bytes) so a large file is not
   downloaded again on every request; the task said "do not cache, 302".
4. The route is unauthenticated and triggers outbound requests. The address
   space is bounded per chain, misses are remembered 24 h, fetches are
   capped at eight at once, and the CDN absorbs repeats; there is no per-IP
   rate limit. If abuse is a concern, the edge (Cloudflare) is the place.
5. With the `market` module disabled every logo is
   `TOKEN_LOGO_PROXY_UNAVAILABLE` (fail closed). Every deployed stack enables
   `market`.
6. The client (loop-mobile) needs no change: it already loads `logo.url`
   and falls back to the monogram. Its host allow-list for images, if any,
   must admit the API origin.

## 主代理裁决（2026-09-28）

状态：Accepted，随 `integration/v2` 合并。

1. `PROVIDER_UNREACHABLE`（502）进错误目录：接受。
2. `native.png`：接受。
3. 超大图 24 h 标记 + 302：接受。
4. 无鉴权路由的限流：先靠 8 并发上限、24 h 未命中缓存与 Cloudflare 缓存；若出现滥用再加按 IP 限流。
5. 客户端：`loop_v2_chain_codec.dart` 的 `logoHosts` 只认三个外部主机，会把我们自己的 URL 当「无图」——S96b 前端同步放开后端 origin（0093 同类教训）。
