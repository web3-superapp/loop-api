# Decision 0060: One pool the adapter cannot name does not take down a token's whole price fact

- Status: Accepted (S51d; fixes the 2026-09-21 finding that the Mining lane reported `MINING_PRICE_NOT_FRESH` for BSC USDT under the r3 baseline)
- Date: 2026-09-21
- Scope: `dexscreener-adapter` normalisation (`/token-pairs/v1`, `/tokens/v1`, `/latest/dex/pairs`), `TokenPairsSnapshot`. No route, no migration, no wire field. Every read that goes through DexScreener pairs benefits: Mining snapshots, wallet valuation, Token pages, alerts.

## What was actually wrong

After deploying Decision 0059 (r3 approved, weights re-approved, snapshots invalidated back to `43880746`), `pnpm mining:snapshot --confirm` answered:

```
attempt 0652a197… incomplete; unread eip155:56:0x55d3…7955 (MINING_PRICE_NOT_FRESH)
```

The reported hypothesis was a stale cache the lane failed to refetch. That is **not** what happened, and the code already did the right thing: `MARKET_PRICE_TTL_SECONDS` is 30 s, the lane ticks every 5 min, so every tick's cache row is expired and `read()` goes to the Provider; the returned `fetchedAt` is that observation's own, and `quality: "fresh"` is only ever an in-TTL row or a successful refetch.

Read against the Development database, the real answer was:

```
quality: unavailable   reasonCode: MARKET_PROVIDER_RESPONSE_MALFORMED   fetchedAt: null
```

`unavailable` is not `fresh`, so the lane reported `MINING_PRICE_NOT_FRESH` — correctly, given what it was told. The malformed verdict came from the adapter. Fetching `/token-pairs/v1/bsc/0x55d3…7955` by hand and normalising the 30 entries one by one found exactly one offender:

```json
{
  "dexId": "fourmeme",
  "pairAddress": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444:4meme",
  "baseToken": {
    "address": "0x0410389360bA5d7609Ba8BA437FCb33376Bc4444",
    "symbol": "牛来人生"
  },
  "quoteToken": { "address": "0x55d3…7955", "symbol": "USDT" }
}
```

four.meme pools are identified as `{address}:4meme`, which is not an EVM address. `normalizePairList` called `malformed()` on it, and `malformed()` throws for the **whole response** — so one meme pool that happened to rotate into USDT's top-30 list made USDT unpriceable for every reader of the API. The other 26 entries in that same list were `USDT/USDC` pairs with USDT as the **base** token, i.e. a perfectly good price was sitting in the payload the adapter threw away.

This also explains the Development cache row of the previous evening holding a single pair: the list content rotates, and whether a token has a price at all depended on whether an un-nameable pool was in the window.

## Decision

**A pair the Provider identifies by something other than an EVM address is dropped and counted; the rest of the response is published.** Everything else that fails normalisation still refuses the whole response.

| Failure                                                                                                 | Before        | After                                      |
| ------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------ |
| Response shape does not parse                                                                           | whole refused | whole refused (unchanged)                  |
| A JSON **number** reached the normaliser (the transport lost precision), an unparseable timestamp/count | whole refused | whole refused (unchanged)                  |
| `pairAddress` / `baseToken.address` / `quoteToken.address` is not an EVM address                        | whole refused | that pair dropped, counted, rest published |

The split is the point: a lossy number is a statement about the **transport** and is systemic, so refusing everything is right (`parseJsonLossless` means a JS number can only appear if the kernel is broken). A pool identifier we cannot express is a statement about **that pool** — Decision 0052 already ruled that such an identifier is never stuffed into an address field, and a four.meme or Uniswap V4 pool is unusable for us anyway (no OHLCV, no trades, it can never be a declared reference pair).

Nothing is invented for the dropped pool: it is simply not published. The drop is not silent either — `TokenPairsSnapshot` gains `unrepresentablePairCount`, which is written into the `market_fact_cache` row with the fact, so "the Provider reported 30, we published 29" is visible to an operator. In a batch read the count is attributed by the raw token addresses of the dropped entry, so a token is never told about a pool that is not its own. The field is optional: a cache row written before this decision has no count, and `undefined` means "unknown", never "zero".

`readPair` (the Decision 0059 declared-pair read) inherits this: if the declared pool is the one that cannot be represented, the answer is `pair: null` and the caller fails closed on that asset — not on the Provider.

## Effect on Mining

With the fix, `readAssetPrice` for USDT answers `quality: fresh`, `fetchedAt` of the observation just made, and the base-token rule of Decision 0036 finds a `USDT/USDC` pair (~`0.9997`). So USDT is priced `fresh` again, not `derived`; the Decision 0059 stable rule stays in force as the fallback for whenever DexScreener's window holds no USDT-base pair. Decision 0057's behaviour is untouched: a holding that still cannot be valued keeps the run `incomplete`.

## Not changed

- `MINING_PRICE_NOT_FRESH` keeps its meaning ("the price fact is not a fresh observation"), which is what the lane was told. The lane needed no change: it already refetches on expiry and carries the fetched observation's own `fetchedAt` into the derived price. A regression test now pins that end to end (expired cache row → Provider re-read → in-band derived price adopted → `priceVersion` is the new observation).
- No wire field is added. Surfacing `unrepresentablePairCount` on the Token page's pool list (next to the `omittedCount` convention of Decisions 0050/0052) is a follow-up, not this fix.
