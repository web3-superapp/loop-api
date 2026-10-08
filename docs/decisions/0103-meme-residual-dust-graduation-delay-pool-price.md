# Decision 0103: MEME residual dust, graduation delay, pool slot0 price (S116b)

- Status: Accepted (S116b-api)
- Date: 2026-10-08
- Scope: three follow-ups to Decision 0101 from the S118 testnet run (`LOOP/docs/integration/S118/report.md`, defects D1, D3, L1). No migration, no new route, no new error code, no new stable ID. One new environment key (`MEME_GRADUATION_DELAY_SECONDS`, worker only); one additive enum value on two wire fields (`priceSource.source` / `quote.source` = `pool_slot0`) and one on `quote.quality` (`derived`).
- Baseline: `integration/v2` = `c85c566`
- Supersedes: the "60 s" wait of Decision 0101 §graduation executor; the `residual` reading of `docs/frontend-v2-meme-api.md` §4.

## 1. D1: residual dust projects as null

Every graduation of the v1 curve leaves rounding dust in the contract (S118: `usd1Left = 100012` wei, `tokensLeft = 23` wei), so `graduation.residual` was never null and the client read it as "the pool was taken by someone else".

- The `meme_event` lane keeps storing `GraduationResidual` / `ResidualInjected` unchanged; `meme_tokens.residual_usd1 / residual_tokens` keep the exact sum.
- `projectMemeGraduation` returns `residual: null` when `usd1Left < 1e18` **and** `tokensLeft < 1e18` (less than 1 USD1 and less than 1 whole token, both 18 decimals). Otherwise both raw strings are returned unchanged.
- Three wire states: no residual event → `null`; dust → `null`; ≥ 1 USD1 or ≥ 1 token → `{usd1Left, tokensLeft}`.
- Meaning for the client: non-null = the pool already existed at graduation and part of the funds stayed in the contract (only an operator can inject them). Dust is never shown.

## 2. D3: graduation delay is configurable, default 15 s

`MEME_GRADUATION_DELAY_SECONDS` (worker, default `15`, integer `0–600`; out of range or non-integer refuses boot) replaces the hard-coded 60 s: a token `full` for at least this long without a `Graduated` log is a `graduate(token)` candidate. The executor's polling interval stays 15 s, the retry interval 5 min, the attempt cap 10. The value is carried in `memeGraduationExecutor.delaySeconds` and only parsed into the executor while `MEME_GRADUATION_EXECUTOR_ENABLED=true`; the range is validated regardless. Expected `full → graduated` on testnet: about 15–30 s plus the receipt.

## 3. L1: graduated token without a DEX quote is priced from its pool's slot0

A graduated token on BSC testnet (or a mainnet pair DexScreener has not indexed) had `priceUsd1 = null`. The pool LOOP itself created is a fact on chain, so its price is read rather than invented.

- Read: `slot0().sqrtPriceX96` of `meme_tokens.pool_address` (the `Graduated` log's pool, PancakeSwap V3) at the latest block, through the MEME curve adapter's launch-slot client (`MemeContractAdapter.readPoolSqrtPriceX96`). A zero price, a malformed pool address or any read error is a failed read.
- Price: `sqrtPriceX96² / 2^192` is `token1 / token0`. token0 is the lower address (the V3 factory sorts the pair), so no further read is needed: token is token0 → `price = sqrtP² / 2^192`; token is token1 → `price = 2^192 / sqrtP²`. Both the token and USD1 have 18 decimals, so the raw ratio is the display ratio. Result is USD1 per token, 1e18-scaled, rounded down; USD1 counted at par (the Launch rule). Market cap = price × 1e9 supply.
- Cache: one reader per process shared by the MEME routes and `category=meme`; a successful read is reused for `memeRules.chainReadCacheMs` = 1.5 s (the same window as the detail's viewer reads); a failure is never cached.
- Order: DexScreener first (mainnet only, as before); only a missing DexScreener price triggers the slot0 read. A failed slot0 read keeps the earlier reason: `MEME_DEX_CHAIN_NOT_PRICED` on 97 (MEME routes), `MARKET_CHAIN_NOT_PRICED` (market category), or the DexScreener reason on 56.
- Wire, MEME routes (`GET /v2/meme/tokens`, `GET /v2/meme/tokens/{id}`): `priceUsd1`, `marketCapUsd1`, `priceSource = {source: "pool_slot0", observedAt}`; `change1hPct` stays null after graduation; no `quoteUnavailable`.
- Wire, `GET /v2/market/assets?category=meme`: `quote = {priceUsd, marketCapUsd, change24hPct: null, volume24hUsd: null, observedAt, source: "pool_slot0", quality: "derived"}`, `sparkline = unavailable / MEME_POOL_SPARKLINE_UNAVAILABLE`. Only candidates on the launch slot's chain are read; the candidate query now returns `graduatedPool` (the graduated MEME token's pool, else null).
- Fail closed: without the MEME contract configuration (no USD1 / no RPC) the reader returns nothing and the earlier reason stands; no fixture or estimate replaces a failed read.

## Consequences

- Clients must accept `pool_slot0` in `priceSource.source` and `quote.source`, and `derived` in `quote.quality`; the label should say the price is derived from the pool.
- Deploy: no migration. API restart picks up L1/D1; worker restart picks up D3 (set `MEME_GRADUATION_DELAY_SECONDS` only to change the 15 s default).
