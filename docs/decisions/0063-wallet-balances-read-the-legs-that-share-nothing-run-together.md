# Decision 0063: The wallet balances read runs its independent legs together, and each leg is given a budget it can be held to

- Status: Accepted (S63; fixes the 2026-09-21 device report "钱包页等很久", measured at 8016 ms for one `GET /v2/wallets/{walletId}/balances` on the Development stack)
- Date: 2026-09-21
- Scope: `wallet-read-service` (`getBalances`, `listWallets`), `market-fact-service` (`readAssetPrices`), `bsc/rpc-client` (point-read lane), `privy/wallet-reader` (balance query shape). No route, no migration, no wire field, no new reason code, no change to any published amount.

## What was wrong

`~/Library/Logs/LOOP/api.log` on the Development stack:

```
GET /v2/wallets/:walletId/balances  8016.65 ms
GET /v2/wallets                      746 ms
```

and eight earlier samples of the same route between 1961 ms and 8801 ms.

Read-only reproduction against the Development database and the Development
Providers (the cy wallet, twelve readable registry assets, the primary RPC list
in its configured order), timing every dependency call, five runs spaced 31 s
apart so the 30 s price TTL had expired each time — that is what a user opening
the wallet screen actually hits:

| Leg                                          | Calls |      Median | Share of the request |
| -------------------------------------------- | ----: | ----------: | -------------------: |
| `marketFacts.readAssetPrice` (one at a time) |    12 |     5785 ms |                  77% |
| `readClient.readBalances`                    |     1 |      873 ms |                  11% |
| `balanceReader.readBscBalances` (Privy)      |     1 |      481 ms |                   6% |
| launch-slot `readBalances` (chain 97)        |     1 |      460 ms |                   6% |
| repository and registry reads                |    16 |      ~50 ms |                  <1% |
| **Total**                                    |       | **7569 ms** |                      |

Five findings, not one:

1. **Nothing overlapped.** The wallet record, the registry, the chain read, the
   pending totals, the Privy cross-check, twelve prices, twelve audit
   snapshots, and the launch slot were awaited one after another, although only
   three of those legs actually consume another leg's output.
2. **Twelve Provider price reads in a row.** Each is a separate DexScreener
   request. Measured from this machine, that Provider answers a single token in
   170–1270 ms depending on the token, so twelve in a row is seconds.
3. **One stalled RPC endpoint cost six seconds.** The transport budget was
   6000 ms per endpoint, and viem's `fallback` moves to the next endpoint only
   after the current one has used its budget — with `retryCount` left at viem's
   default of 3, a fully unreachable set could be walked four times over.
4. **The launch slot gated the page.** It is a secondary fact of the wallet
   screen (Decision 0038) but it was read last, in series, against a Testnet
   endpoint that took 3392 ms in one of the five runs.
5. **The Privy cross-check has never worked.** Every call returned
   `400 {"error":"Must provide both chain and asset","code":"invalid_data"}`
   — the request named a chain and no asset — so the native row has been
   publishing `crossCheck: unavailable / PRIVY_BALANCE_CROSS_CHECK_FAILED`
   since Decision 0033, while still costing ~480 ms on the critical path.

## Decision

### A leg waits only for what it reads

`getBalances` now starts each leg as soon as its own inputs exist:

| Leg                     | Waits for                             |
| ----------------------- | ------------------------------------- |
| wallet record, registry | nothing                               |
| launch-slot balance     | the wallet address                    |
| indexer checkpoint      | nothing                               |
| asset prices            | the registry                          |
| Privy balance view      | the wallet's provider ID              |
| chain balances          | the address and the registry          |
| pending totals          | the head block                        |
| audit snapshots         | the chain balances                    |
| cross-check verdict     | the chain balances and the Privy view |

The Privy leg is split in two for this: `readPrivyNativeObservation` asks the
Provider (it needs nothing from the chain), and `compareNative` decides the
verdict once both observations are in hand. The verdict's reason codes keep the
exact order they had when the Provider was asked second — a wallet Privy cannot
address first, then a chain value that is missing, then a Provider failure — so
no row's `crossCheck` changes because of the new timing.

Every published value still comes from **one** block: the head is read once and
the token multicall and the native `eth_getBalance` are both pinned to it. They
are now issued together rather than one after the other, which changes when the
answers arrive and not which block answered.

### A price is read per asset, four at a time

`MarketFactService.readAssetPrices` reads many assets' prices under a fixed
concurrency of 4 and answers in the order asked. It is the existing
single-token read run concurrently: the same Provider endpoint, the same cache
row per token, the same in-flight sharing. The batch endpoint was rejected —
`/tokens/v1/{chain}/{addresses}` returns at most thirty pools across all
requested tokens, so a token with hundreds of pools would get a truncated pool
list, `selectPrimaryPair` could pick a different pool, and that truncated
snapshot would be written into the cache row the market module reads.

The bound is not decoration. Measured against DexScreener with eight distinct
tokens, twelve at once was slightly faster at the median (2260 ms vs 2780 ms)
and produced one `MARKET_PROVIDER_UNREACHABLE` in eight runs — a request that
sat for the kernel's whole 8 s budget. Four in flight produced none in
ninety-six requests. A fresh price is worth more than half a second.

Prices are also read while the chain read is in flight: a price is a fact about
the asset, not about this wallet. The balance still decides whether a row is
valued at all, and a row whose balance could not be read is still published
unvalued.

### Point reads get a budget an interactive screen can wait out

The RPC client now has two lanes over the same endpoints in the same order:

| Lane                | Per-endpoint budget | Whole-chain retry | Used by                                                  |
| ------------------- | ------------------: | ----------------- | -------------------------------------------------------- |
| point reads         |             2500 ms | none              | `eth_chainId`, `getHead`, `getBlockHash`, `readBalances` |
| scans and estimates |             6000 ms | viem default      | `eth_getLogs`, `eth_call`, gas estimates, allowances     |

A stalled endpoint now costs 2.5 s and is handed to the next endpoint once,
rather than costing 6 s and possibly being retried. Range scans keep the longer
budget: those are batch-shaped, and a premature timeout there would fail a read
closed for no reason.

The launch slot additionally gets a 3000 ms deadline on the whole projection.
When it elapses the slot is published as `availability: "unavailable"` with
`LAUNCH_CHAIN_RPC_UNREACHABLE` — the reason code it already uses for an
endpoint that will not answer — and the primary balances are published from the
block that _was_ read. The abandoned read finishes or fails inside its own
client; no partial or substituted value is ever produced.

### The Privy balance query names its asset

`{chain: "bsc", include_archived: false}` becomes
`{chain: "bsc", asset: "bnb", include_archived: false}`. Privy answers a
balance query only when it names both. With this, the cross-check works for the
first time: the cy wallet now reports `crossCheck: {status: "matched"}` for the
native row instead of the permanent `PRIVY_BALANCE_CROSS_CHECK_FAILED`. The
rule it serves is unchanged — the RPC read stays authoritative and a
disagreement is reported, never resolved.

### One Privy wallet inventory observation serves thirty seconds

`GET /v2/wallets` asked Privy on every call. The inventory is now remembered
per Privy subject for 30 s (`walletInventoryTtlMs`, per process, capped at 1000
subjects), and `source.observedAt` reports **when Privy was actually read** —
previously it reported `now()`, which claimed a freshness the response did not
have. The wallet list itself is still rebuilt from the database on every call,
so an active-wallet switch is visible immediately; only the question "which
wallets exist" is reused. A wallet linked in Privy appears up to 30 s later.

### One debug line, no facts in it

Each balances read logs its leg durations once at `debug`, under the message
`Wallet balances read segment timings`. Durations and counts only: no address,
no amount, no wallet ID, no user ID, no endpoint URL. Two real lines are in
"Measured after the change" below.

## Measured after the change

DexScreener's own latency moves by the hour — `curl` from this machine measured
the same eight tokens at 170–1270 ms in the afternoon and 3.2–4.6 s in the
evening — so a before/after taken hours apart would measure the Provider, not
the change. The numbers below are therefore **interleaved**: one run of
`5215e86`, then one run of this branch, then a 35 s wait so the price TTL
expires, six times over, same wallet, same twelve assets, same process shape.

| Run         |    `5215e86` | this branch |
| ----------- | -----------: | ----------: |
| 1           |      2580 ms |     2685 ms |
| 2           |     24531 ms |     3283 ms |
| 3           |      8302 ms |     3150 ms |
| 4           |     23204 ms |     2328 ms |
| 5           |     13212 ms |     3054 ms |
| 6           |     11634 ms |     2213 ms |
| **median**  | **12423 ms** | **2870 ms** |
| **slowest** |     24531 ms |     3283 ms |

The same comparison earlier in the day, while the Provider was healthy (five
runs each, not interleaved): 7569 ms median before, 2776 ms median after.

Run 2 shows what the point-read lane is for. On `5215e86` the launch slot alone
took **14874 ms** — a Testnet endpoint at 6000 ms per attempt, retried, and
read last so the page waited for all of it. On this branch the same leg took
1339 ms and was not on the critical path at all.

A run whose price cache is still warm — a user reopening the screen inside
30 s — now costs 560 ms end to end:

```
{"assetCount":12,"valuedCount":12,"totalMs":560,
 "segmentsMs":{"assetPrices":16,"assetRegistry":4,"chainBalances":547,
               "indexerCheckpoint":9,"launchChain":354,"privyCrossCheck":496,
               "snapshots":8,"walletRecord":3}}
```

and one whose prices had expired, in the same pair of runs, shows every leg
overlapping and the launch-slot deadline doing its job:

```
{"assetCount":12,"valuedCount":12,"totalMs":3054,
 "segmentsMs":{"assetPrices":2092,"assetRegistry":48,"chainBalances":1570,
               "indexerCheckpoint":16,"launchChain":3005,"privyCrossCheck":532,
               "snapshots":22,"walletRecord":11}}
```

The published document is unchanged: same block, same `blockHash`, same
`rawValue` per row (`USDT 2990000000000000000`, every other row `0`), same
`netWorth.valueUsd` (`2.988206`). The one difference is the one that was
broken: the native row's `crossCheck` is now
`{"status":"matched","reasonCode":null}` instead of
`PRIVY_BALANCE_CROSS_CHECK_FAILED`.

`GET /v2/wallets` inside the reuse window: 694 ms → 4–21 ms.

## What is still slow, and who decides it

After this change the request is, by construction, `max(chain read + verdict,
prices)`. Everything except prices finishes in about 1.4 s; the prices leg is
the whole remaining tail, and it is Provider latency, not our scheduling:
DexScreener answers `/token-pairs/v1/bsc/{token}` in 170–1270 ms **per token**,
measured with `curl` outside this process, and this wallet needs eight distinct
tokens. The p50 target of 1.5 s is therefore not met by scheduling alone. Four
levers remain, and each is a product or fact-policy call rather than an
implementation detail:

1. **Do not price a zero balance.** Eleven of this wallet's twelve rows hold
   nothing, and `valueUsd` for a zero row is exactly `0` whatever the price is.
   Skipping those reads would leave one Provider request and put the request
   near 1.0 s — but it removes `valuation.priceUsd`, `fetchedAt`, and `quality`
   from zero rows and changes `netWorth.unavailableCount`. That is a contract
   change; it needs a ruling.
2. **`MARKET_PRICE_TTL_SECONDS` is 30, not 60.** Raising it halves how often a
   wallet screen pays for a Provider read at all. It is a fact-freshness policy
   from Decision 0034.
3. **The Provider kernel's 8 s timeout** (Decision 0034) is the ceiling on one
   stalled price read, and therefore on this route's tail. A shorter budget
   would fall back to the stale cache row, which is the already-designed answer
   for an unreachable Provider.
4. **Keeping the registry's prices warm from the worker** would let the wallet
   screen read cache only. It adds a worker loop and a Provider budget
   question.

## Not done, and why

- **No cached balances.** Nothing on this route is served from a stored
  snapshot; when the chain cannot be read the capability still fails closed
  (Decision 0033). `wallet_balance_snapshots` stays an audit trail.
- **No reordering of the RPC endpoint list by latency.** viem's `rank` option
  polls every endpoint in the background; a wallet screen's latency is not
  worth a standing poll against four Providers.
- **No change to `readAllowances`, the indexer, or any write path.** They keep
  the 6 s lane they had.
