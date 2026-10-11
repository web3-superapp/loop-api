# Decision 0124: MEME v2 official-pool trading after graduation (S146)

- Status: Accepted (S146-api), Development / BSC Testnet only
- Date: 2026-10-11
- Baseline: `integration/v2` = `1b2b426` (Decisions 0122 / 0123, migrations 000066 / 000067)
- Contracts: loop-contracts `main` `122163d` (S146-contracts, loop-contracts Decision 0006
  `official-pool-router`, merge `f22a9ca`). Testnet router `OfficialPoolRouter`
  `0xcb022501A427154501aDcE5b6dC8f16674aE8f5D`, runtime code hash
  `0x94392c12b59acc4cd9f2fce6b139289ea166cb96bc91d54fe1d38a978399e118`, PoolManager
  `0xDe15B309d6E337dbc7794C404455f746c096B7DA` (`protocol/deployments/bsc-testnet/pool-router.json`).
- Inputs: `LOOP/docs/12` (S146-contracts PoolKey / `officialPoolId` / `zeroForOne` / eth_call
  quoting; S137 third round finding ② "the read model does not index official-pool trades"),
  requirer feedback `LOOP/docs/17` §四 (in-App post-graduation trading, 2 % pool tax),
  Decisions 0114, 0117, 0121, 0122.
- Scope: two new routes, the `pool` block of the instance detail, `launch2_event` indexing of
  the official pool's `Swap` logs, migration `000068_launch2_official_pool_trades`, ABI sync
  (`OfficialPoolRouter`, `PoolManager.extsload` / `Swap`). New API env
  `LAUNCH2_POOL_ROUTER_ADDRESS` / `LAUNCH2_POOL_ROUTER_CODE_HASH`. No `/v1` change; nothing is
  signed or broadcast by the backend.

## 1. Entities and IDs

| Entity            | Key                                                                 | Notes                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official pool     | `launch2_instances.official_pool_id` (from `Graduated`)             | Not a new row: the instance (opaque `instanceId`) owns it. Never keyed by address or ticker.                                                                                                    |
| Pool swap fact    | `(chain_id, transaction_hash, log_index)`                           | `launch2_pool_swaps`, one per PoolManager `Swap` log of the pool id; `removed` on a reorg rewind like every launch2 fact.                                                                       |
| Pool projection   | `launch2_instances.pool_*`                                          | Counts, USD1 volumes, taxes, last price / time; recomputed from non-removed facts on every commit that touches the instance.                                                                    |
| Pool trade intent | `launch2_intents.intent_id` (UUID), `kind` `pool_buy` / `pool_sell` | Same append-only table, idempotency scope `launch2_intent` and digest version `launch2_intent_v1` as the curve intents (request digest includes `official_pool`, side, mode, amount, slippage). |

## 2. PoolKey, direction, tax

- `PoolKey = (min(USD1, MEME), max(USD1, MEME), 2500, 60, hook)`, USD1 = the instance's
  `CurveEngine.usd1()` (the Decision 0117 trust anchor), hook = the registered instance hook.
  Each quote / prepare re-reads the hook's `currency0()` / `currency1()` / `poolManager()` at
  the quote block and requires: the rebuilt key's currencies equal the hook's,
  `keccak256(abi.encode(key)) == Graduated.officialPoolId`, and the hook's PoolManager equals
  the router's `poolManager()`. Any mismatch is 503 (`POOL_KEY_MISMATCH` /
  `POOL_ROUTER_MANAGER_MISMATCH`), never a guess.
- `zeroForOne` = the input is currency0: buy = USD1 in, sell = MEME in.
- The `OfficialTaxHook` takes 2 % of the gross output (buy: MEME, sell: USD1) into the hook's
  `feeVault` (not the curve's `platformTaxReceiver`). Exact-input: `floor(gross × 200 / 10000)`
  in `afterSwap`; exact-output: the requested net plus `ceil(net × 200 / 9800)` in
  `beforeSwap`. The router's return value is always net.
- Quote tax: exact-output is the hook's own formula (exact); exact-input derives it from the
  net output as `floor(net / 49)` — exact except when two gross amounts give the same net
  (then 1 wei above). Indexed tax (from the `Swap` log's gross output) uses the exact-input
  rounding; an exact-output swap may be recorded 1 wei below the hook's ceiling. Both are
  documented on the wire.

## 3. Routes

### `GET /v2/launch2/instances/{instanceId}/pool/quote?side&mode&amount&walletId&slippageBps?`

- Mirrors the curve quote (`walletId` required like the curve's, decimal strings, `basis`,
  `deadline`) plus `venue: "official_pool"`, `mode` (`exactIn` | `exactOut`), `router`,
  `poolId`, `poolKey`, `zeroForOne`, `taxBps: 200`, `taxAmount` + `taxToken`, `taxUsd1`
  (= the sell tax, 0 for a buy), `priceBeforeUsd1` (PoolManager slot0 through `extsload`),
  `averagePriceUsd1`, `balance {usd1, meme}`, `exceedsBalance`, `quotedAtBlock`, `expiresAt`
  (= `deadline` = now + `LAUNCH2_QUOTE_TTL_SECONDS`, ≤ 600 s).
- Simulation: `eth_call` of the router from the wallet at the quote block —
  `swapExactIn(key, zeroForOne, amount, 0, wallet, deadline)` or
  `swapExactOut(key, zeroForOne, amount, 2^128, wallet, deadline)` — with the input token's
  balance and allowance (to the router) for the wallet overridden in that call only
  (`stateDiff`). The ERC-20 storage layout is discovered once per token by probing
  `balanceOf` / `allowance` under an override (Solidity and Vyper mapping orders, slots 0..15
  and the OpenZeppelin v5 namespaced ERC20 storage) and cached; tUSD1 and MemeToken are plain
  OpenZeppelin ERC20 (slots 0 / 1). A layout that is not found or a node that refuses state
  overrides is 422 `POOL_QUOTE_UNAVAILABLE` with `revertReason: STATE_OVERRIDE_UNSUPPORTED`.
- Slippage: exact-input `minOut = expectedOut × (1 − s)` (down), exact-output
  `maxIn = amountIn × (1 + s)` (up); `s` = `slippageBps` (0..5000, default
  `LAUNCH2_DEFAULT_SLIPPAGE_BPS`).
- Partial fills: the router fills partially and refunds when the price limit is reached;
  with the full-range graduation liquidity that is unreachable for any realistic size. An
  exact-output request beyond the pool's depth reverts `InsufficientOutput` →
  `POOL_INSUFFICIENT_LIQUIDITY`.

### `POST /v2/launch2/instances/{instanceId}/pool/trade/prepare`

- Body `{walletId, side, mode, amount, slippageBps}` (slippage an integer, required: it is
  part of the binding). The server re-quotes at one block (same checks) and builds:
  `to` = router, `value` 0, `swapExactIn(key, zeroForOne, amountIn, minOut, wallet, deadline)`
  or `swapExactOut(key, zeroForOne, amountOut, maxIn, wallet, deadline)`; recipient = the
  signing wallet.
- `approval`: an exact `approve(router, amount)` of the input token (buy: USD1, sell: MEME)
  for `amountIn` (exactIn) or `maxIn` (exactOut) when the allowance is short (nonce N, call
  N+1), else null.
- `simulation`: `eth_call` of the exact router call from the wallet with its real balance; while
  the approve is pending the allowance alone is overridden, so `passed` means "passes once the
  approve lands". `gas` = `eth_estimateGas` (same override) × 1.2; without an estimate the
  fallback 300,000 and `simulation.status = unavailable`.
- Intent fields: `amountIn` = the most the router may pull (`amountIn` / `maxIn`),
  `expectedOut`, `minOut` (exactOut: = the requested net), `taxUsd1` = the sell's USD1 tax (0
  for a buy), `refundUsd1` 0, `deadline` = the quote deadline, `expiresAt` = min(now + 600 s,
  deadline). The response adds `quote` (the pool quote it was built from, stored in the intent's
  policy so an `Idempotency-Key` replay returns the same pair).
- Policy: Decision 0065 canary (USD1 in `BSC_WRITE_CANARY_ASSETS`, per-intent and daily
  ceilings; value = USD1 in for a buy, USD1 out for a sell at par). Decision 0117
  counterparties: the instance's MEME / USD1 and the router **only after** its runtime code
  hash matched `LAUNCH2_POOL_ROUTER_CODE_HASH` (`requireLaunch2Counterparties({verifiedRouter})`).
  Writes need `BSC_WRITES_ENABLED`; BSC Mainnet signing stays closed.
- Balance: `maxIn` above the input-token balance is 409 `INSUFFICIENT_BALANCE`
  (`LAUNCH2_USD1_BALANCE_INSUFFICIENT` / `LAUNCH2_MEME_BALANCE_INSUFFICIENT`, `maxAmountIn` =
  the balance); native gas short is `LAUNCH2_GAS_INSUFFICIENT` (as the curve).

### Stage gate

Only the read-model stage `graduated` (the indexed `Graduated`, Decision 0121 §quote) is
tradable on the pool; anything else is 422 `POOL_NOT_GRADUATED` with `detailsSafe.stage`.
An integrity hold is 409 `LAUNCH2_INSTANCE_PAUSED`. The curve routes keep answering 409
`LAUNCH2_SOLD_OUT` for a graduated instance.

## 4. Error codes (seven-field envelope)

| HTTP | `code`                   | `detailsSafe.reasonCode`                                                                                                                                                                                                                            |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 422  | `VALIDATION_FAILED`      | `POOL_NOT_GRADUATED` (`stage`), `POOL_QUOTE_UNAVAILABLE` (`revertReason`: decoded error name / `UNKNOWN` / `STATE_OVERRIDE_UNSUPPORTED`), `POOL_INSUFFICIENT_LIQUIDITY`, `POOL_QUOTE_ZERO`, `LAUNCH2_AMOUNT_INVALID`, `LAUNCH2_WALLET_NOT_EMBEDDED` |
| 409  | `DATA_STALE`             | `LAUNCH2_INSTANCE_PAUSED`                                                                                                                                                                                                                           |
| 409  | `INSUFFICIENT_BALANCE`   | `LAUNCH2_USD1_BALANCE_INSUFFICIENT`, `LAUNCH2_MEME_BALANCE_INSUFFICIENT`, `LAUNCH2_GAS_INSUFFICIENT`                                                                                                                                                |
| 409  | `IDEMPOTENCY_CONFLICT`   | — (same key, other body)                                                                                                                                                                                                                            |
| 403  | `POLICY_BLOCKED`         | canary reasons (Decision 0065), `LAUNCH2_COUNTERPARTY_NOT_INSTANCE`                                                                                                                                                                                 |
| 503  | `CAPABILITY_UNAVAILABLE` | `POOL_ROUTER_NOT_CONFIGURED`, `POOL_ROUTER_CODE_MISMATCH`, `POOL_ROUTER_MANAGER_MISMATCH`, `POOL_KEY_MISMATCH`, `LAUNCH2_CHAIN_READ_FAILED`, `LAUNCH2_WRITES_DISABLED`, the Decision 0114 module reasons                                            |

`POOL_*` codes carry no `LAUNCH2_` prefix as the task named them (the buyback blocked reasons
are the precedent); they are new and unique in the API.

## 5. Unavailable behaviour (fail closed)

- `LAUNCH2_POOL_ROUTER_ADDRESS` / `LAUNCH2_POOL_ROUTER_CODE_HASH`: one unit, BSC Testnet only
  (`LAUNCH_CHAIN_ID=97`); partial or malformed → boot refused; both blank → the two pool routes
  answer 503 `POOL_ROUTER_NOT_CONFIGURED` and the detail's `pool.router` is null (the pool
  statistics are still shown).
- The router's code hash is read at startup (logged `verified` / `unavailable`) and before every
  pool quote / prepare; a verified answer is cached, a failed one is retried after 60 s. Code
  hash or PoolManager mismatch → 503 with the reason, nothing simulated.
- No fixture and no default numbers: a reverted or unsupported simulation is a 422 with the
  reason, a chain read failure a 503.

## 6. Indexing (`launch2_event` lane)

- The hook emits no events, so the lane reads the PoolManager's `Swap` logs, but never by
  address alone: `eth_getLogs(address = PoolManager, topic0 = Swap, topic1 ∈ pool ids)` for the
  `officialPoolId` of every graduated instance, the id list split into batches of the same size
  (8) as the address filter, merged in (block, logIndex) order with the module logs. The
  PoolManager and the hook's `currency0()` come from the instance hook (immutables, read once
  per hook). A graduation inside the same block segment triggers a second, pool-only read of the
  same range, so a swap right after graduation is never skipped.
- Each log keeps the raw event (`launch2_events`, `event_name = 'Swap'`, payload + the lane's
  `memeIsCurrency0`) and a typed fact `launch2_pool_swaps`: side (USD1 delta negative = buy),
  USD1 / MEME amounts (output gross of the tax), the tax at 2 % of the gross output, the price
  after the swap (USD1 per MEME from `sqrtPriceX96`), and the PoolManager caller (the router,
  the buyback adapter, any other router). A log that is not one-in-one-out stays raw only.
- Projection: `pool_trade_count / buy_count / sell_count`, `pool_buy_volume_usd1` (USD1 in),
  `pool_sell_volume_usd1` (USD1 out gross), `pool_tax_usd1` (sells), `pool_tax_meme` (buys),
  `pool_last_price_e18`, `pool_last_trade_at`; only while the graduation is indexed. The
  24-hour USD1 volume is computed at read time from the facts.
- Buyback executions are pool swaps too: they appear in the counts (their MEME goes to the
  buyback recipient); the buyback ledger stays the source for buybacks.

## 7. Detail `pool` block (additive)

`instance.pool` (optional in the schema, always present): null before graduation, else
`{poolId, router, tradeCount, buyCount, sellCount, buyVolumeUsd1, sellVolumeUsd1,
volume24hUsd1, taxUsd1, taxMeme, lastPriceUsd1, lastTradeAt}`.

## 8. Verification

- Route / contract: `test/v2-launch2-pool-routes.test.ts` (shapes from the route schemas, 503 /
  422 / 409 branches, calldata decode, approve / no-approve, replay, simulation reverted →
  not signable, detail block), `test/launch2-pool.test.ts`, `test/launch2-chain-log-batches.test.ts`
  (pool id topic batches), `test/launch2-indexer-worker.test.ts` (pool routing and the
  same-segment graduation pass), `test/config.test.ts`, migration contract
  `test/launch2-official-pool-migration.test.ts`, OpenAPI (182 operations).
- Anvil: `test/launch2-pool-anvil.integration.test.ts` — Foundry base + Factory, activation,
  zero-holder public opening, 160 buyers to graduation, router deployed from the same build;
  quote → prepare → the script account executes approve + router call for an exact-input buy
  and an exact-output sell; balances move exactly as quoted, the 2 % tax lands in the fee
  vault; a wrong code hash is 503; the lane indexes both swaps, a rewind forgets the sell and
  the lane re-reads it.

## 9. Open items

- Mainnet router: this router redeployed + audited, or Uniswap UniversalRouter (then a second
  adapter); `LAUNCH2_POOL_ROUTER_*` are BSC Testnet only until then.
- Trader attribution: the PoolManager `Swap` sender is the router, not the user; per-user pool
  positions would need the router's own `Swap(payer, recipient)` event (not indexed here) —
  S148-api already plans MEME balances via the `erc20_transfer` lane.
- State overrides depend on the RPC node (geth-family `eth_call` third parameter); the public
  BSC Testnet endpoints in `ops/` must be checked on the dev upgrade (a refusal shows as
  `STATE_OVERRIDE_UNSUPPORTED`, never as a fake quote).
