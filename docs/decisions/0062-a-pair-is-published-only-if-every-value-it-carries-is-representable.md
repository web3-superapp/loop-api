# Decision 0062: A pair is published only if every value it carries can be represented exactly — and only that pair is dropped

- Status: Accepted (S61; fixes the 2026-09-21 finding that BTCB was `MINING_PRICE_NOT_FRESH` in three consecutive snapshot runs)
- Date: 2026-09-21
- Scope: `dexscreener-adapter` normalisation. Widens the per-pair rule of Decision 0060 from "the identifier is not an address" to "any value this pair carries cannot be represented exactly". No route, no migration, no wire field, no new reason code.

## What was wrong

With eight new assets registered and the r4 baseline approved,
`MINING_MOCK_HOLDINGS_ENABLED=true pnpm mining:snapshot --confirm` answered three times:

```
incomplete; unread eip155:56:0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c (MINING_PRICE_NOT_FRESH)
```

and `market_fact_cache` held **no** BTCB row at all — the read never reached `cache.put`, so the Provider call had thrown.

Read-only reproduction against the Development database, `readAssetPrice(asset, {requireFresh: true})` for every readable BSC asset, showed eleven `fresh` and exactly one failure:

```
BTCB  0x7130d2a1  status=pending  quality=unavailable  reason=MARKET_PROVIDER_RESPONSE_MALFORMED  pairs=0
```

So neither of the suspicions held: `status: pending` is not skipped (ten of the eleven healthy assets are `pending`), and checksum-cased addresses normalise fine (every other token's 30 pairs carry them). Normalising BTCB's 30 entries one at a time, then removing one field at a time from the offender, named the cause exactly:

```
#27 BTCB/WBNB 0x02259FDbF99Ea59e3Bb6589f67e99C0A6322AfF7 (dexId squadswap, liquidity $60.88)
    offending field: priceChange = {"h1":"0.59","h6":"0.47","h24":"3.725857251510287e+42"}
```

A dust pool reported a 24-hour price change of `3.725857251510287e+42` **as a string**. The transport is fine — `parseJsonLossless` delivered the Provider's own digits — but `normalizeDecimalString` refuses exponent notation (it cannot be re-expressed as a canonical decimal without expanding a 43-digit number, and this codebase refuses rather than approximates). `optionalDecimal` then called `malformed()`, which refuses the **whole response**, and BTCB had no price for any reader of the API.

This is the same shape of bug as Decision 0060 (one four.meme pool taking down USDT), one field further in: 0060 narrowed the fatal path to "identifier is not an address" and left every other field refusing the whole response.

## Decision

The per-pair rule is stated once, by cause rather than by field:

| Cause                                                                                                                   | Effect                                 |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| The response shape does not parse                                                                                       | whole response refused (`malformed()`) |
| A JSON **number** reaches the decimal normaliser                                                                        | whole response refused (`malformed()`) |
| A pool or token identifier that is not an EVM address (four.meme `{address}:4meme`, Uniswap V4 pool id — Decision 0052) | that pair dropped and counted          |
| One of the Provider's own digit strings that is not a canonical decimal (exponent notation, out of range)               | that pair dropped and counted          |
| A count or a timestamp outside its documented shape                                                                     | that pair dropped and counted          |

The line is drawn where the statement changes subject. A JSON number proves **the transport** lost precision — `parseJsonLossless` means that can only happen if the kernel is broken — and nothing in the response can be trusted. Everything else is a statement about **one pool**, and one pool's nonsense must not decide whether a token has a price.

A dropped pair is dropped whole: nothing is published about it, and no field is silently nulled. Nulling the offending field would have been the smaller change, but `null` already means "the Provider did not report it", and a pair with a nulled `priceUsd` can still win `selectPrimaryPair` (which ranks by liquidity) and would then answer "no price" for a token that has one. Publishing a pair only when every value it carries was read exactly keeps one rule and no new failure mode.

The drop stays visible: `TokenPairsSnapshot.unrepresentablePairCount` (Decision 0060) counts it, and it is stored with the fact in `market_fact_cache`.

## Verified after the change

`readAssetPrice(…, {requireFresh: true})` for every readable BSC asset in the Development registry, in one run:

| Asset                    | quality     |  pairs | dropped | primary pair  | priceUsd     |
| ------------------------ | ----------- | -----: | ------: | ------------- | ------------ |
| BNB (native, WBNB proxy) | `fresh`     |     30 |       0 | `0x16b9a828…` | 783.014      |
| Cake                     | `fresh`     |     30 |       0 | `0x0ed7e529…` | 2.53         |
| XRP                      | `fresh`     |     30 |       0 | `0xd15b00e8…` | 1.47         |
| ETH                      | `fresh`     |     30 |       0 | `0xd0e226f6…` | 2723.69      |
| ADA                      | `fresh`     |     30 |       0 | `0x673516e5…` | 0.2377       |
| USDT                     | `fresh`     |     29 |       1 | `0x4f31fa98…` | 0.9994       |
| DOT                      | `fresh`     |     30 |       0 | `0xdd5bad8f…` | 1.16         |
| **BTCB**                 | **`fresh`** | **29** |   **1** | `0x6bbc4057…` | **84709.79** |
| DOGE                     | `fresh`     |     30 |       0 | `0xc8469ec6…` | 0.09189      |
| WBNB                     | `fresh`     |     30 |       0 | `0x16b9a828…` | 783.014      |
| UNI                      | `fresh`     |     30 |       0 | `0x03cff636…` | 8.83         |
| LINK                     | `fresh`     |     30 |       0 | `0x0e1893be…` | 12.96        |

USDT's single drop is the four.meme pool of Decision 0060; BTCB's is the squadswap pool above.

## Tests

The offending squadswap entry and the deepest pancakeswap entry are captured **verbatim** from the 2026-09-21 response (only `url` removed) and pinned as fixtures: the list keeps the deep pair, counts one drop, and `selectPrimaryPair` prices BTCB at `84584.076`; the same pool with a plain decimal in that one field is kept (so the drop is attributable to the exponent alone, not to the pool); a count or timestamp outside its shape drops its pair and keeps the others; a JSON number still refuses the whole response.

## Consequences

- Every read through DexScreener pairs — Mining snapshots, wallet valuation, Token pages, alerts — stops depending on whether a dust pool with a nonsense field happens to be in a token's top-30 window.
- `MARKET_PROVIDER_RESPONSE_MALFORMED` now means what it says: the response, not one pool in it.
- Still open (unchanged by this decision): `unrepresentablePairCount` is not on the wire. Surfacing it next to the `omittedCount` convention of Decisions 0050/0052 remains a follow-up.
