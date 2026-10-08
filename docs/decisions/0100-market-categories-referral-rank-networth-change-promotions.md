# Decision 0100: Categorised market list, referral rank with `me`, net-worth 24h change, intel promotions, v3 primary tabs

- Status: Accepted (S112-api)
- Date: 2026-10-08
- Scope: no migration, no new table, no new error code, no new environment key, no `/v1` change. Two new `/v2` operations (`GET /v2/market/assets?category=`, `GET /v2/intel/promotions`), one changed operation (`GET /v2/mining/rank`: `scope=referrals`, `cursor`, `limit`, `me`, `nextCursor`, `display.avatarRef`), two changed responses (`GET /v2/wallets/{id}/balances`: `netWorth.change24h`, `netWorth.change24hUnavailable`, `balances[].valuation.change24hPct`; session bootstrap `navigation.primaryTabs`), one new read-only repository (`src/database/market-category-repository.ts`), two new configVersion registry entries (`marketCategories`, `intelPromotions`), product policy version `productPolicyV2.2026-09-01` -> `productPolicyV2.2026-10-08`.
- Baseline: `integration/v2` = `8c73740`
- Inputs: `LOOP/docs/modules/S112-S114-intel-wallet-visual.md` §0, §2, §3, §4; `LOOP/docs/09-需求方v3需求与裁决.md` §1, §6.2; read-only inventory 2026-10-08.

## Context

The v3 navigation (`docs/09` §1) replaces the five tabs with chat / square / meme / intel / wallet. The intel page (S113) shows three power ranks with the caller's own place and a market list in three categories; the wallet page (S114) shows the total value with its 24h move. Before this decision:

1. The market surface had a watchlist and a volume-ordered trending block only; no category list.
2. `/v2/mining/rank` had two scopes, a fixed 100 rows, no pagination, no referral rank, and the caller's place only on `users` (`myPosition`).
3. `netWorth` carried a value but no 24h change; rows carried a price but not the 24h move behind it.
4. There was no promotion card source.
5. `primaryTabs` was the v2 list `community, mining, launch, market, wallet`.

## Decision

### 1. `GET /v2/market/assets?category=major|meme|community&sort=marketCap|change24h|volume24h&cursor&limit`

Registered with the `market` module. Bearer, `X-Loop-Contract-Version: 2.0`, no body, no `Idempotency-Key` (read).

Candidates (registry rows that are not `blocked`, at most `candidateLimit = 100` per category):

- `major`: the static allow-list `marketMajorAssetIds` (`src/features/market/market-contract.ts`, configVersion `marketCategoriesV1`, effectiveAt `2026-10-08T00:00:00.000Z`) intersected with the registry. The list holds what the Development registry had on 2026-10-08: BNB native, USDT, WBNB, BTCB, ETH, XRP, ADA, DOT, LINK, UNI, Cake. USDC is not registered there and is left out (adding it later is a version step).
- `meme`: every distinct `launches.project_asset_id` (set by `pnpm launch:register-sale`, Decision 0077). The design note says `launch_rounds.project_asset_id`; that column does not exist, the project token lives on `launches` (migration 000042), so the server reads `launches`. Testnet tokens are included.
- `community`: one verified community per bound asset (`communities.verification_status = 'verified'`, `bound_asset_key` set), the one with most members then the oldest (the asset page's pick), row carries `community { communityId, name, logoRef }`.

Row: `{ assetId, symbol, name, logoUrl, quote, quoteUnavailable?, sparkline, community? }`.

- `quote = { priceUsd, change24hPct, marketCapUsd, volume24hUsd, observedAt, source, quality }` from the asset's primary DexScreener pair (deepest base pair). `quality` (`fresh | stale | proxied`) is an addition to the design note's field list: a stale price and native BNB priced through WBNB must stay labelled. A number the Provider did not report is `null` inside the quote; the 24h change uses the remembered value of the same pair (Decision 0074 §4) exactly as the overview does.
- `quote = null` when the price itself is unavailable, with `quoteUnavailable: { reasonCode }` (the price fact's reason: `MARKET_PROVIDER_DEXSCREENER_DISABLED`, `MARKET_PROVIDER_UNREACHABLE`, `MARKET_PAIR_NOT_FOUND`, …). An asset on a chain the market Provider is not read for (a BSC testnet Launch token) is not sent to DexScreener at all and gets `MARKET_CHAIN_NOT_PRICED` on both `quote` and `sparkline` (new reason code, not an error code).
- `logoUrl` is the overview rows' `logo.url` (Decisions 0072/0089), `null` when no URL can be formed.
- `sparkline` is the overview rows' cached projection (Decision 0074), never a Provider call.

Pricing: all candidates of the category in one `readTokenPairsBatch` (cache first, misses in 30-address chunks) plus one sparkline cache read, under the overview's 1200 ms deadline (Decision 0086). A read cut off is answered as an unreachable Provider, row by row. No per-row Provider read.

Order and pages: the whole candidate set is ordered by the sort field descending (`marketCapUsd`, `change24hPct`, `volume24hUsd`), rows without that number after every valued row, `assetId` ascending as the unique tie-breaker; `rules.ordering` names it (`dexscreener_market_cap_desc`, `dexscreener_price_change_h24_desc`, `dexscreener_volume_h24_desc`). `limit` 1–50, default 30. The cursor (`src/core/http/v2-cursor.ts`, route `marketCategoryAssets`, filter `category=…;sort=…`, bound to the caller) carries the last row's `(value, hasValue, assetId)` and its page size; the next page is every row strictly after that key on fresh prices. Prices move between pages, so a row may move across a page boundary; the keyset never repeats a key and never loops. `cursor` together with `limit` is `400` (the trades rule). `sort` defaults to `marketCap`.

Fail closed: `meme` / `community` without the candidate repository (database not composed, or its query fails with the unavailable error) is `503 CAPABILITY_UNAVAILABLE`, never an empty list; a missing cursor secret is `503` for every category (the trades rule). `major` needs only the registry.

The overview keeps `newPairs` / `smartMoney`; no route is removed. Candles are unchanged.

### 2. `/v2/mining/rank`

- `scope=users|communities|referrals` (default `users`), `limit` 1–50 (default 30), `cursor`; `cursor` with `limit` is `400`. A cursor chain stops after 500 rows (`miningRankPaging`); the last page and the 500th row carry `nextCursor: null`. The cursor is bound to the caller and scope (route `miningRank`) and carries its page size and the running row count.
- Keysets: users `(total desc, ownerUserId asc)`; communities `(power desc, name asc, communityId asc)`; referrals `(invitedCount desc, ownerUserId asc)`. Each is exactly the previous display order (positions are `rank()` over positive values, zero values follow with `position: null`), so the rows a client already showed keep their order. The keyset is on the value, not the snapshot, so a new snapshot between two pages continues from the same value.
- `scope=referrals`: inviters ranked by direct invitees in force, `referral_edges.depth = 1 and effective_to is null`, every `validation_status` counted (`pending_*` and `valid` alike; an `invalidated` edge always has `effective_to` set). Only inviters with at least one invitee are listed. Rule key `mining.rank.referrals.directActiveEdges` on the ranking block. This changes when an "effective invite" rule is approved. It is a live PostgreSQL read: it does not wait for a Mining snapshot, so `snapshot` / `formula` may be unavailable while the referral ranking is available. Rows: `{ position, invitedCount, display, isSelf }`; the count is always public; `display` follows Decision 0049 (anonymous mode alone hides another account's alias).
- `me: { rank, value, communityId? } | null` on every scope: users = the caller's position and power; communities = the best-ranked community the caller is a non-banned member of (`communityId` names it); referrals = position and invitee count. `value` is a decimal string. `null` when the caller has no place (zero power, no ranked community, no invitee) or the ranking is unavailable.
- `myPosition` is kept unchanged for older clients (`MINING_RANK_NOT_APPLICABLE` on communities and, new, referrals).
- `display` (alias branch) gains `avatarRef` (`user_profiles.avatar_ref` of the active profile, `null` when none): the S113 rank row shows a picture (B7). The anonymous branch is unchanged and carries no avatar.
- Backwards compatibility: row shapes of `users` and `communities` only gain fields. The page size of a request without `limit` drops from 100 to 30; an old client sees the first 30 rows and no error.
- Without a cursor secret the first page is still served with `nextCursor: null`; a cursor is then `503`.

### 3. `netWorth.change24h`

- Each row valuation gains `change24hPct` (DexScreener `priceChange.h24` of the same pair, percent points, `null` when not reported).
- `netWorth.change24h = { usd, pct } | null`, from the same price read: a row worth `v` whose price moved `p` % was worth `v / (1 + p/100)` and changed by `v·p / (100 + p)`; `usd` is the sum, `pct` is the sum over the summed earlier values × 100. Exact decimal arithmetic, rounded half away from zero to 6 (usd) and 4 (pct) places.
- Only valued rows worth more than zero count (a zero-value row cannot move the total). One counted row without a 24h number (or with `p <= -100`, which has no earlier value) makes the change `null` with `change24hUnavailable: { reasonCode: "PRICE_CHANGE_PARTIAL" }`; a partial sum is never published. Rows without a valuation are already outside `valueUsd` (`partial` net worth) and outside the change.
- A `netWorth` that is unavailable stays the unavailable branch (no change fields).

### 4. `GET /v2/intel/promotions`

- Static constant `src/features/market/intel-promotions.ts`, configVersion `intelPromotionsV1`, effectiveAt `2026-10-08T00:00:00.000Z`; registered with the `market` module (bearer, contract version, no query).
- Item `{ id (opaque UUIDv4), title (1–40), subtitle (≤ 80), imageUrl (https or null), deeplink, startsAt, endsAt, order }`; response `{ items, configVersion, effectiveAt, contractVersion }`; only cards with `startsAt <= now < endsAt`, ordered by `order` then `id`.
- `deeplink` allow-list: `/intel`, `/square`, `/meme`, `/community/profile?id=<lowercase UUIDv4>`. `defineIntelPromotions` refuses anything else (scheme, host, `//`, other paths, extra query) when the module loads, so a bad entry stops the process at start-up; the response schema carries the same pattern.
- First version: two placeholder cards, 「LOOP 挖矿算力周榜」 → `/intel`, 「推荐社区」 → `/square`, `imageUrl: null`, 2026-10-08 to 2027-01-01.

### 5. Primary tabs

`navigation.primaryTabs = ["chat", "square", "meme", "intel", "wallet"]` (`v2PrimaryTabs`), product policy `productPolicyV2.2026-10-08` effective `2026-10-08T00:00:00.000Z`. `defaultRoute` stays the `"community"` constant; changing it is a contract change left to the main agent (see open questions). Decision 0029's text about the old default is historical.

## Errors

No new code. `GET /v2/market/assets`: 400 `INVALID_REQUEST` (unknown/missing category, unknown sort, limit out of range, bad/foreign cursor, cursor with limit, extra query), 401, 409 `ACCOUNT_BOOTSTRAP_REQUIRED`, 503 `CAPABILITY_UNAVAILABLE`. `GET /v2/intel/promotions`: 400 (any query), 401, 409. `/v2/mining/rank`: as before plus 400 for cursor/limit and 503 for a cursor without the secret. New `reasonCode` values (fact-level, not error codes): `MARKET_CHAIN_NOT_PRICED`, `PRICE_CHANGE_PARTIAL`.

## Unavailable behaviour

- Category list: Provider off or unreachable → `200`, every row `quote: null` with the Provider reason; candidate source missing → `503`; no fixture rows.
- Referral rank: repository unavailable → `503 CAPABILITY_UNAVAILABLE` (`translate`). Users/communities without a snapshot → ranking/myPosition unavailable as before, `me: null`, `nextCursor: null`.
- Net worth change: `null` + `PRICE_CHANGE_PARTIAL`; market runtime missing keeps `netWorth` unavailable.
- Promotions: static, always answerable while the market module is on.

## Migration impact

None. All reads use tables written by other modules (`launches`, `communities`, `community_memberships`, `referral_edges`, `mining_snapshot_powers`, `user_profiles`, `privacy_preferences_v2`). `PostgresDatabase` gains `marketCategories`.

## Tests

- `test/v2-market-routes.test.ts`: three categories (major allow-list ∩ readable registry, blocked and non-major excluded; meme with a testnet row `MARKET_CHAIN_NOT_PRICED` and a mainnet row `MARKET_PAIR_NOT_FOUND`; community rows with the community), one batch per page, the three sort orders, a cursor walk, cursor bound to category/sort, cursor+limit and bad params 400, 503 without a candidate source or cursor secret, quote null with the Provider off, 401; promotions shape, query 400, 401.
- `test/v2-mining-routes.test.ts`: `me` on users/communities and null when unranked, unchanged row shapes plus `avatarRef`, keyset pages and repository call arguments, cursor bound to scope, 400s, the 500-row stop, referrals with anonymity, `me`, availability without a snapshot, and 503.
- `test/v2-chain-wallet-routes.test.ts`: `change24hPct` on valuations, `change24h` null + `PRICE_CHANGE_PARTIAL`, derived change for +5 % and −20 %.
- `test/market-categories-contract.test.ts`: deeplink allow-list (external links, schemes, `//`, other paths, extra query, upper-case IDs refused), entry validation, time window and order, list ordering and keyset walk, net-worth arithmetic and partial rule, rounding, the five tabs.
- `test/market-categories-rank.integration.test.ts` (real PostgreSQL): distinct Launch project tokens (testnet kept, blocked dropped), one verified community per bound non-blocked asset, referral counts by status/depth/end, keyset pages of referrals/accounts/communities equal to the full order, referral standing for ranked and unranked accounts, best community standing (banned excluded, outsider null).
- `test/s7-repositories.integration.test.ts`: the account ranking rows now carry `avatarRef`.
- Meta, session, about, OpenAPI tests follow the new tabs, policy version, registry entries, and two operations.

## Open questions for the main agent

1. `defaultRoute` is still the literal `"community"`, which is no longer a tab. Proposed: `"chat"` in the next policy step (a schema `const` change).
2. Referral rank counts every validation status; switch to `valid` only once the effective-invite rule is approved.
3. `major` omits USDC until it is registered (`pnpm asset:register`).
