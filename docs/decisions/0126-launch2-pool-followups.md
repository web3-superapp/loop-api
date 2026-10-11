# Decision 0126: MEME v2 official-pool follow-ups — signing window, wallet balances, own pool trades (S150-api)

- Status: Accepted (S150-api), Development / BSC Testnet only
- Date: 2026-10-11
- Baseline: `integration/v2` = `9b6e1d5` (Decisions 0124 / 0125, migrations 000068 / 000069)
- Inputs: `LOOP/docs/acceptance/2026-10-11-s142-emulator.md` §3cd40d5 (main agent's emulator buy
  and sell), `LOOP/docs/12-需求方交接对照与合并方案.md` (last items), Decision 0124 §9 open item
  "trader attribution", Decision 0125 §12 open items 2 / 3, loop-contracts
  `protocol/src/OfficialPoolRouter.sol` (`event Swap(PoolId indexed poolId, address indexed payer,
address indexed recipient, bool zeroForOne, uint256 amountIn, uint256 amountOut)`).
- Scope: `POST …/trade/prepare`, `POST …/pool/trade/prepare` (deadline), `GET …/pool/quote`
  (description only), `GET /v2/launch2/instances/{id}` (`viewer`), `GET /v2/launch2/me/positions`,
  new `GET /v2/launch2/instances/{id}/pool/trades`, the `launch2_event` lane, migration
  `000070_launch2_pool_wallet_attribution`, `GET /v2/mining/rewards` (`excludedAssets` reason
  code). New env `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS` (API); the worker now reads
  `LAUNCH2_POOL_ROUTER_ADDRESS` / `_CODE_HASH` too. No `/v1` change; nothing is signed or sent.

## 1. Signing window (finding: two Privy signatures did not fit 60 s)

- Quotes are unchanged: `GET …/quote` `deadline` and `GET …/pool/quote` `deadline = expiresAt`
  stay quote time + `LAUNCH2_QUOTE_TTL_SECONDS` (default 60 s) — the quote's freshness.
- `POST …/pool/trade/prepare` re-quotes at its own block (a fresh simulation, `basis` /
  `quotedAtBlock` = the prepare block, as before) but encodes
  `deadline = max(block time, now) + LAUNCH2_POOL_TRADE_DEADLINE_SECONDS` in the router call; the
  intent's `deadline` / `expiresAt` and the `quote` returned with it carry that value.
- `POST …/trade/prepare` (curve, same root cause): the body's `deadline` (the quote's) keeps the
  freshness check (past → `409 QUOTE_EXPIRED`, > 600 s ahead → `422 LAUNCH2_DEADLINE_TOO_FAR`, both
  unchanged); the deadline encoded in `buy` / `sell` and the intent's `deadline` / `expiresAt` are
  `max(body.deadline, max(block time, now) + LAUNCH2_POOL_TRADE_DEADLINE_SECONDS)`. The request
  digest still binds the body's deadline (replays unchanged).
- `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS`: integer 60..600, default 180 (one knob for both venues;
  the name follows the task). Still capped by the existing 600 s intent maximum. Slippage
  (`minOut` / `maxIn`) protects the price over the longer window; the contracts enforce it.

## 2. Wallet balances (`memeBalance`, `usd1Balance`)

- Detail `viewer` and each `GET /v2/launch2/me/positions` row gain (required keys):
  `memeBalance`, `usd1Balance` (decimal | null), `balanceStatus`
  (`available` | `not_graduated` | `unavailable`), `balanceReasonCode`
  (`LAUNCH2_CHAIN_READ_FAILED` | `LAUNCH2_CHAIN_NOT_CONFIGURED` | null), `balanceBlockNumber`.
- Graduated instances only (the read model's `graduation`): `Launch2Chain.readWalletBalances`
  reads `CurveEngine.usd1()` and both `balanceOf(wallet)` at one block of the launch slot. In-memory
  cache per (MEME, wallet) for 15 s (the task's upper bound; `balanceCacheMs` cannot exceed it).
  Positions read ≤ 8 rows at a time.
- Before graduation: null with `not_graduated` (the curve block is exact there). A failed read is
  null with `unavailable` and the reason — the detail / positions answer still succeeds; a balance
  is never guessed or zero-filled.

## 3. Own official-pool trades

### Attribution (lane)

- The lane, when the worker has the router pair, adds a third topic-filtered read:
  `eth_getLogs(address = router, topic0 = router Swap, topic1 ∈ official pool ids)`, the id list in
  batches of 8 like the PoolManager read (also in the same-segment graduation pass). The decoded log
  is named `RouterSwap` (role `poolRouter`) and kept raw in `launch2_events`
  (`event_name = 'RouterSwap'`, instance from its pool id).
- Pairing (`pairLaunch2RouterSwaps`, pure): a router log pairs with the PoolManager `Swap` of the
  same transaction (and block hash) and pool id whose `sender` is the router, that precedes it, is
  the newest such not yet paired, and whose input delta equals the router's `amountIn`
  (`-(zeroForOne ? amount0 : amount1)`). Anything else stays unattributed: the buyback executor,
  other routers, malformed values. The paired `payer` is the trader (`wallet_address`); `recipient`,
  the router's exact `amountIn` / net `amountOut` and its log index are stored with it.
- Re-scan (backfill): a graduated instance whose `pool_router_target_block` is null makes the tick
  start at its graduation block (same mechanism as 0125's MEME transfer coverage); target = the old
  checkpoint (or the segment end); `pool_router_complete_at` when a checkpoint reaches it. Upserts
  fill a missing attribution and never overwrite one (`coalesce`); `pool_trade_id` is kept. This
  attributes the two dev swaps (blocks 136098143, 136098447) on the first tick of a worker built
  from this branch with `LAUNCH2_POOL_ROUTER_*` set — no script, idempotent.
- Positions: a wallet with attributed pool swaps is a holder of `launch2_positions` (curve zeros),
  `last_activity_at` includes its newest pool swap.

### Entities / IDs (migration 000070)

| Object                                                        | Key                                       | Notes                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `launch2_pool_swaps.pool_trade_id`                            | opaque UUID (`gen_random_uuid()`, unique) | Public `poolTradeId`; the fact key stays `(chain_id, transaction_hash, log_index)`         |
| `launch2_pool_swaps.wallet_address` (+ 4 cols)                | — (fact, not a key)                       | All five null or all set (check constraint); index `(instance_id, wallet_address, block…)` |
| `launch2_events` `RouterSwap`                                 | `(chain_id, transaction_hash, log_index)` | Raw evidence; `removed` on rewind like every launch2 fact                                  |
| `launch2_instances.pool_router_target_block` / `_complete_at` | —                                         | One-time re-scan coverage                                                                  |

The wallet address is a fact column; routes look it up from the caller's opaque `walletId`.

### Routes

- `GET /v2/launch2/instances/{instanceId}/pool/trades?walletId=&limit=` (`walletId` required, the
  caller's; `limit` 1..50, default 20; newest first by block / log; no cursor):
  `{instanceId, walletId, poolTradeCount, lastPoolTradeAt, trades[{poolTradeId, side, inputToken,
outputToken, amountIn, amountOut, usd1Amount, memeAmount, taxAmount, taxToken, priceUsd1,
recipientAddress, tradedAt, transactionHash, logIndex, blockNumber}], contractVersion}`. Before
  graduation: 200 with an empty list.
- Detail `viewer` and positions rows: `poolTradeCount` (integer string), `lastPoolTradeAt`.
  The App confirms its trade by its own `poolTradeCount` growing, not the pool-wide `tradeCount`.

### Errors

| HTTP | code                     | reasonCode                                                                      |
| ---- | ------------------------ | ------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`        | — (missing / malformed `walletId`, `limit` outside 1..50)                       |
| 404  | `NOT_FOUND`              | `LAUNCH2_INSTANCE_NOT_FOUND`; a wallet not owned by the caller (no code)        |
| 503  | `CAPABILITY_UNAVAILABLE` | `LAUNCH2_REPOSITORY_UNAVAILABLE`, `LAUNCH2_WALLETS_UNAVAILABLE`, module reasons |

## 4. Mining exclusion reason codes (`/v2/mining/rewards` → `hourly.tracks.asset.excludedAssets`)

| Code                                     | Status       | Meaning                                                                                                        |
| ---------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `MINING_ASSET_GRADUATED_BALANCE_PENDING` | **new**      | Quantity-basis hour; the graduated MEME's post-graduation balance coverage (0125) had not completed. No price. |
| `MINING_ASSET_GRADUATED_UNREADABLE`      | kept, narrow | Only valuation-basis (pre-0123) hours replayed: no post-graduation price existed.                              |

- The runner writes the new code for quantity hours; the projection maps an old stored
  `…_UNREADABLE` of a non-valuation hour (`inputSummary.assetPowerBases` without `valuation`) to the
  new code. The summary is not digested, so replays keep their digests; nothing is rewritten.
- The server sends no Chinese text. Suggested App copy (S150-mobile): new code →
  「已毕业，外盘持有数量同步中」; old code → 「已毕业，外盘持有数量暂读不到」 (no 「价格」); unknown codes keep
  the generic fallback.

## 5. Unavailable behaviour

- Router pair missing in the worker: no router logs, no re-scan, pool swaps unattributed
  (`poolTradeCount: "0"`, empty `…/pool/trades`); pool statistics unaffected. Missing in the API:
  unchanged 0124 behaviour.
- Balance read failure / launch slot not configured: `balanceStatus: unavailable` + reason, never 0.
- Repository down: the new route and the detail / positions are 503 as before.

## 6. Verification

`test/v2-launch2-wallet-pool-routes.test.ts` (viewer balances + cache, not_graduated, unavailable,
positions, pool trades shape / validation / 404), `test/v2-launch2-pool-routes.test.ts` and
`test/v2-launch2-routes.test.ts` (180 s deadlines, two simulations), `test/launch2-indexer-worker.test.ts`
(router read, pairing rules, re-scan, no router), `test/launch2-chain-log-batches.test.ts` (router
topic batches, `RouterSwap` decode), `test/config.test.ts`, `test/launch2-generation.test.ts`
(worker config), `test/mining-hourly-runner.test.ts`, `test/v2-mining-rewards-routes.test.ts`,
`test/launch2-pool-wallet-attribution-migration.test.ts`; on PostgreSQL + anvil
`test/launch2-pool-anvil.integration.test.ts` (prepare deadline ≥ 180 s encoded in calldata; a lane
without the router leaves the buy unattributed, the routed lane re-scans from graduation and
attributes it — exact-input buy and exact-output sell both pair — positions / viewer balances equal
`balanceOf`, a rewind + re-read keeps the attribution). No BSC Testnet run in this batch.

## 7. Open items

- Wallets that only received MEME by transfer are not listed in positions (the detail with their
  `walletId` shows the balance); the 0125 `launch2_meme_transfers` facts could add them.
- The ops dev worker must carry `LAUNCH2_POOL_ROUTER_ADDRESS` / `_CODE_HASH` (same values as the
  API) for attribution and the dev backfill; the API needs no new value unless the 180 s default is
  changed.
