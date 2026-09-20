# Decision 0059: A formula version declares how an asset is priced when no pair has it as the base token

- Status: Accepted (S51c; resolves the item Decision 0057 left to the main agent: "pricing a stablecoin that is the quote of its own deepest pairs")
- Date: 2026-09-21
- Scope: `mining-snapshot` lane, the pure Mining computation, `mining_snapshot_powers` (migration `000034`, append-only), the DexScreener adapter and the market fact service (one added read), the Development baseline formula version (`…-r2` → `…-r3`), `pnpm mining:dev-baseline`, and one added field on `GET /v2/mining/assets.included[]`. No route is added or removed.

## The fact this fixes

Decision 0036 prices an asset only from a pair in which the asset is the **base** token: "a pair where the asset is only the quote is not a price of the asset". Since 2026-09-18 ~08:00 Z DexScreener's answer for BSC USDT (`0x55d3…7955`) is a short list — `WBNB/USDT`, `USDT/USDC` — in which USDT is usually only the **quote**. `selectPrimaryPair` therefore returned `null`, the lane reported `priceUsd: null`, and after Decision 0057 every run became `incomplete` with `MINING_PRICE_PAIR_NOT_FOUND`. That was the correct fail-closed behaviour (before 0057 the same fact was published as `power: 0`), but it left `GET /v2/mining/summary` pinned to the 05:22 Z snapshot of 2026-09-20 with `stale: true` for as long as DexScreener keeps answering that way.

The missing price is not unknowable: the pair itself states it. In `WBNB/USDT`, `priceUsd` is WBNB in USD and `priceNative` is WBNB in USDT, so one USDT is `priceUsd / priceNative` — exact integer arithmetic, no model, no interpolation. What it is _not_ is a direct observation, and 0036 refused it for a good reason: an inversion off a thin or broken pair can produce any number at all.

## Decision

A formula version may declare, per asset, a **reference pricing rule**. An asset without a rule keeps the base-token-only rule of Decision 0036 unchanged.

```jsonc
"referencePricing": {
  "eip155:56:0x55d398326f99059ff775485246999027b3197955": {
    "kind": "stable", "pegUsd": "1", "guardBps": 200
  },
  "eip155:56:0x…": { "kind": "pair", "pairAddress": "0x…", "pegUsd": "1" }
}
```

| Rule     | Where the price comes from                                                                                                                                       | Guard                                                                                                     | Quality             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------- |
| (none)   | The deepest pair in which the asset is the base token (Decision 0036)                                                                                            | —                                                                                                         | `fresh`             |
| `stable` | Only when the base rule finds nothing: the **deepest** pair in which the asset is the quote token, inverted as `priceUsd / priceNative`                          | The result must lie within `guardBps` of `pegUsd`, inclusive; outside it nothing is published             | `derived`           |
| `pair`   | The declared pair, read by its own pool address (`GET /latest/dex/pairs/bsc/{pairAddress}`), authoritative for that asset — the token pair list is not consulted | Base side: none (no inversion). Quote side: inverted and guarded against `pegUsd`, which is then required | `fresh` / `derived` |

Rules that make the guarantee explicit:

- **The peg is a guard, never a price.** When the derived price falls outside the band, the asset is _not_ valued at `pegUsd`; the holding stays unread and the run is `incomplete` with `MINING_PRICE_PAIR_NOT_FOUND` exactly as under Decision 0057. No constant ever becomes a published number.
- **An unguarded inversion is refused.** A `pair` rule whose asset is the pair's _quote_ token must declare `pegUsd`; without something to compare against there is no guard, and Decision 0036's refusal stands. `guardBps` defaults to **500** on a `pair` rule (`03-非合约产品方案` §19 leaves the Mining price guard to be frozen, so there is no product threshold to inherit; the default is pinned by this decision and lives with the formula version).
- **The version decides, not the lane.** The lane observes and reports (`quality: "derived"`, the pair, whether it inverted); the pure `selectMiningPrice` re-checks the rule, the pair address, and the guard before any derived price enters a snapshot. Both halves are unit-tested without I/O.
- **A declared pair is read by its own address.** `/token-pairs/v1/{chain}/{token}` returns only a subset of a token's pairs — that subset is what broke USDT — so a rule that pins a pool reads that pool. The Provider answer is cached under the new fact kind `pair`, subject `pair:{address}`, with the price TTL; without the Provider it is `unavailable(MARKET_PROVIDER_DEXSCREENER_DISABLED)` and the holding stays unread.
- **Determinism.** Among equally deep quote pairs the lowest pair address wins, so two runs over the same Provider fact agree.

### What a snapshot records

`mining_snapshot_powers` gains `reference_price_pair_address` (nullable) and its quality check is widened to `('fresh', 'proxied', 'derived')` (migration `000034`, append-only; nothing is backfilled, rollback refuses while a derived row exists). A `derived` row must name its pair, so the inversion can be rechecked against the same Provider fact later. A `fresh` row may name one (it does when the price came from a declared pair); rows written before this decision carry `null`.

### Wire

`GET /v2/mining/assets.included[]` gains `referencePricePairAddress: string | null` and `referencePriceQuality` gains the value `derived`. **This is the one breaking risk for a strict client**: a client that validates `referencePriceQuality` against a closed `{fresh, proxied}` enum will reject a row priced this way. The mobile client already carries the field; the new value and field are called out in `docs/frontend-v2-mining-api.md`.

### Development baseline

`miningFormula-devBaseline-2026-09-15-r2` is superseded by **`miningFormula-devBaseline-2026-09-15-r3`**, identical except that it declares

```json
"referencePricing": {
  "eip155:56:0x55d398326f99059ff775485246999027b3197955":
    { "kind": "stable", "pegUsd": "1", "guardBps": 200 }
}
```

(declared only when that asset is registered, exactly like `priceProxies`). `pnpm mining:dev-baseline --confirm` writes r3 and prints the declared rules; approval remains a second explicit step. With r3 in force and the 2026-09-20 Provider answer, USDT is valued at `priceUsd/priceNative` of the deepest `*/USDT` pair — ≈ `0.9995`, well inside ±2 % — and the lane produces complete snapshots again. If the inversion ever leaves the band, the lane goes back to recording incomplete attempts and the reads fall back to the last complete snapshot with `stale: true`.

## Alternatives rejected

- **Publish the peg (`USDT = 1`) as a constant.** A configured number is not an observation; it would be the same class of error as the `power: 0` of Decision 0057.
- **Keep base-only and wait for DexScreener.** Leaves the product's Mining numbers frozen for an unbounded time on a fact that is present in the data.
- **Invert any quote pair without a declaration.** Decision 0036's objection stands: an inversion off an arbitrary pair is not a price of the asset. The declaration plus the band is what makes it checkable.

## Consequences

- `MarketPairsProvider` and `MarketFactService` gain `readPair`; `createUnavailableMarketPairsProvider` refuses it like the others; the lane's `MiningPriceReader` requires it (only used by a `pair` rule).
- `MiningSnapshotPower` gains `referencePricePairAddress`; `MiningPriceInput` gains `pairAddress` and `derivedInverted`.
- `divideDecimalStrings` is added to the market decimal helpers (exact, truncating, `null` on a zero divisor).
- No product price guard is approved by this decision: `03` §19 still owns TWAP, multi-source, and liquidity-cap rules, and the baseline still carries all three as `pending_approval`.

## Commands after deploying this branch (Development)

```sh
pnpm db:migrate
pnpm mining:dev-baseline --confirm                                    # writes …-r3 as pending_approval
pnpm mining:approve-formula miningFormula-devBaseline-2026-09-15-r3 --confirm   # retires r2
pnpm mining:snapshot --confirm                                        # exit 0 = a complete snapshot was written
```

A snapshot computed under r3 is a different formula version from the last complete r2 snapshot, so until the first r3 snapshot exists the reads answer `MINING_SNAPSHOT_STALE` (Decision 0057, case 3) — run `pnpm mining:snapshot --confirm` right after the approval.
