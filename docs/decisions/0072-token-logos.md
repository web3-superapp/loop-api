# Decision 0072: Every asset row carries a real token logo, from two allow-listed origins only

- Status: Accepted (S78c; requester ruling 2026-09-23 "token 都用真实的 logo，现在很多都是我们自己画的")
- Date: 2026-09-23
- Scope: a `logo` field on every V2 projection that lists an asset row —
  `GET /v2/market/overview` (watchlist and trending rows),
  `GET /v2/market/assets/{assetId}` (registered, unregistered, and native),
  `GET /v2/market/new-pairs` (base token of each pool row),
  `GET /v2/wallets/{walletId}/balances` (`balances[]` and
  `launchChain.nativeBalance`), `GET /v2/watchlist` (items),
  `GET /v2/mining/assets` (`included[]` and `excluded[]`), and
  `GET /v2/search?domain=assets` (`displaySnapshot.logo`). Extends the
  DexScreener adapter (Decision 0034) by one field. No migration, no new
  table, no new Provider call, no `/v1` change.
- Baseline: `integration/v2` = `d1ab379`

## Context

The client draws a first-letter monogram for every token
(`loop-mobile/lib/widgets/loop_assets.dart`, `LoopTokenLogo`) because no V2
projection publishes a picture. Product Rule 03 §5 says a logo is a display
field, never a key; Decision 0033 established that a wallet address, a
ticker, and an alias never identify anything. A logo therefore has to hang
off a row that is already keyed by its CAIP-19 `assetId`, must never be used
to merge or match, and — because the main-agent rules forbid trusting a URL
the client did not get from the BFF — must come from an origin the BFF has
vouched for.

Two sources exist without a new Provider or credential:

1. DexScreener already answers the pair endpoints this codebase reads with a
   per-pair `info` block whose `imageUrl` is the **base token's** picture
   (hosts `dd.dexscreener.com` / `cdn.dexscreener.com`). The adapter parsed
   pairs with `.passthrough()` and simply never projected the block.
2. The Trust Wallet assets repository publishes one file per BSC token at a
   fixed path keyed by the EIP-55 checksum address, and one for the native
   coin. The path is a rule, not an observation.

## Decision

### 1. Shape

```json
{ "status": "available", "url": "https://…", "source": "dexscreener" | "trustwallet", "observedAt": "2026-09-23T08:00:00.000Z" | null }
{ "status": "unavailable", "reasonCode": "TOKEN_LOGO_ADDRESS_UNKNOWN" | "TOKEN_LOGO_CHAIN_UNSUPPORTED" }
```

`observedAt` is the pair fact's `fetchedAt` for `dexscreener` and `null` for
`trustwallet`: the server never probes whether the Trust Wallet file exists,
so it has observed nothing. The JSON schema is one shared definition
(`src/routes/v2/token-logo-schema.ts`) so every surface publishes the same
codec; its `url` pattern is anchored to the host allow-list.

### 2. Origins and the gate

| Origin        | When                                                                                                                   | URL                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dexscreener` | the row is built next to a DexScreener pair fact and one of the asset's **own base pairs** carries an admissible image | the Provider's `info.imageUrl`, verbatim                                                                                                            |
| `trustwallet` | otherwise, for any BSC mainnet address or the native coin                                                              | `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/<EIP-55>/logo.png`; native: `…/smartchain/info/logo.png` |

The gate (`acceptTokenLogoUrl`) admits a URL only when it is absolute
`https://`, its hostname is exactly one of `cdn.dexscreener.com`,
`dd.dexscreener.com`, `raw.githubusercontent.com`, it carries no
credentials and no port, and it is at most 512 characters. Anything else is
**dropped**. It runs twice: at the adapter boundary, so a cache row never
holds a URL this codebase would not publish, and again at projection, so a
row cached before this decision is held to the same rule.

A dropped Provider image is not the end of the row: the rule URL still
applies, so the row is published as `trustwallet`. The projection is
`unavailable` only when no rule URL can be formed:
`TOKEN_LOGO_ADDRESS_UNKNOWN` (a Provider pool row that names no base token)
or `TOKEN_LOGO_CHAIN_UNSUPPORTED` (the launch slot's `eip155:97` native
balance; the rule covers BSC mainnet only). This reading of "other hosts are
dropped and published as unavailable" — drop the URL, fall through to the
rule — is flagged for the main agent below.

### 3. Attribution rules that are not negotiable

- **A pair's image belongs to its base token.** `providerImageUrlFromPairs`
  only reads pairs where `baseTokenAddress === tokenAddress`, preferring
  the primary pair (`selectPrimaryPair`, already base-only), then any other
  base pair. A pair in which the asset is only the quote describes the other
  token's picture and is never used.
- **A proxy's picture is not the asset's.** Native BNB is priced through
  WBNB (`quality: proxied`, Decision 0044); the WBNB pair's image is
  discarded for the native row, which takes the native rule URL. The wallet
  applies the same rule through `proxyAsset !== null`.
- **The logo is not a market fact.** It is published even when every price
  block is `unavailable` (Provider disabled, throttled, unreachable): the
  rule URL follows from the address alone. It also never gates or colours a
  fact's `quality`.
- **Rows without a DexScreener fact in hand** (`/v2/watchlist`,
  `/v2/mining/assets`, `/v2/search?domain=assets`) get the rule URL only.
  They do not read the fact cache for a picture: no new Provider call, no
  new cache read, and no cross-surface dependency on the market runtime.

### 4. Cache and TTL

`TokenPairSnapshot.imageUrl` is one more field inside the `token_pairs`
jsonb value already cached in `market_fact_cache`; it inherits that row's
TTL, `fetchedAt`, and stale/grace behaviour and costs no request of its own.
A row written before this decision lacks the key; readers treat it as
`null` (integration test proves both directions). `UnlistedTokenMarket`
gains the same `imageUrl` (null on the GeckoTerminal path: its images live
on `coin-images.coingecko.com`, which is not on the allow-list and is not
adopted).

### 5. EIP-55

`toEip55Address` wraps viem's `getAddress`; the lowercase address this
codebase stores is re-encoded only on the way out, into the Trust Wallet
path. Tests cover lowercase, checksummed, upper-case, all-digit, and
non-address input.

### 6. Client contract

The client loads `url` directly (no BFF image proxy, no download on the
server). On **any** load failure — Trust Wallet has no file for the token,
DexScreener's CDN answers 404 or an error, the network is down — the client
falls back to its existing monogram for that row and does **not** retry in a
loop; one attempt per row per screen is enough. `source` and `observedAt`
are for provenance display and debugging, never for choosing a codec.
`unavailable` renders the monogram from the start.

## Consequences

- Every asset-row schema gains a required `logo` (strict codecs must add the
  key); `displaySnapshot.logo` on search results is `null` for users and
  communities. The wallet balances baseline fixture (`test/fixtures/s9-baseline/wallet-balances.json`)
  was regenerated with the field; the byte-identity that test proves
  (three app variants agree) is unchanged in meaning.
- The `/v2/wallets/{walletId}/activity` rows and the registry resource
  `GET /v2/assets/{assetId}` are **not** extended: activity rows are
  transfer events, and the registry resource is identity. Both remain a
  one-line addition if product asks.
- The community "bound asset" card has no server-side projection of its
  own (`boundAssetKey` only); it is covered by the `logo` on
  `GET /v2/market/assets/{assetId}`.

## Open for the main agent

1. Disallowed host → **drop and fall through to the Trust Wallet rule**
   (implemented) versus **drop and publish `unavailable`**. The former shows
   a real logo more often and is still a fixed, vouched-for URL; the latter
   is the stricter reading of the task text. One-line change either way.
2. Whether `GET /v2/assets/{assetId}` (registry resource) and wallet activity
   rows should carry `logo` too.
