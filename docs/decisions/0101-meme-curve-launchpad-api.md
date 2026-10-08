# Decision 0101: MEME curve launchpad API (S116)

- Status: Accepted (S116-api)
- Date: 2026-10-08
- Scope: migration `000049_v2_meme_launchpad` (six tables, one lane, two idempotency digest versions); a new V2 module `meme` (nine operations under `/v2/meme`); a new capability `meme`; the `category=meme` market candidates; four worker lanes (`meme_event`, `meme_salt_pool`, `meme_intent_reconcile`, `meme_graduation_executor`), all default-off; new environment keys `MEME_*`; two scripts `pnpm meme:abi-check`, `pnpm meme:salt-refill`. No `/v1` change, no new error code.
- Baseline: `integration/v2` = `148b1e0`
- Inputs: `LOOP/docs/10-MEME曲线合约接口需求.md` (curve parameters, math, ABI); `LOOP/docs/modules/S115-S118-meme-launchpad.md` §0 and §2; `LOOP/docs/09-需求方v3需求与裁决.md` §1 position 3, §2 A2/A3/A4; loop-contracts `37cb992` (`abi/LoopMemeCurve.abi.json`, `docs/decisions/0001-meme-curve.md`, `scripts/lib/meme-math.ts`); BSC testnet deployment (curve `0xe108d45e…b39b8a`, token implementation `0xa87a54dc…f979f4da`, start block `135600269`).

## Context

v3 position 3 is the MEME tab: a four.meme-style bonding-curve launchpad quoted in USD1 (docs/10). One `LoopMemeCurve` contract clones a 1e9-supply `LoopMemeToken` per launch with CREATE2, sells 800M on a virtual-reserve constant-product curve (V0 = 6,000 USD1, T0 = 1.073e9), and once sold out anyone may `graduate` it into a PancakeSwap V3 full-range pool with the LP NFT burned. The backend must list and describe App-created tokens, recompute quotes, build create/buy/sell Intents for the device signing exit, index the curve's events, keep a vanity-suffix salt pool, and run a fallback `graduate` caller.

## Decision

### 1. Configuration and capability

| Key                                         | Default | Meaning                                                                              |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `MEME_CONTRACT_ADDRESS`                     | blank   | `LoopMemeCurve` on the launch slot (Decision 0038)                                   |
| `MEME_CONTRACT_VERSION`                     | blank   | semantic version; ABI major 1 only                                                   |
| `MEME_CONTRACT_START_BLOCK`                 | blank   | first block of the `meme_event` lane                                                 |
| `MEME_TOKEN_IMPLEMENTATION`                 | blank   | `LoopMemeToken` implementation (CREATE2 input)                                       |
| `MEME_SALT_POOL_TARGET`                     | 50      | free vanity salts the pool keeps (0–1000)                                            |
| `MEME_VANITY_SUFFIX`                        | `6666`  | hex suffix of mined addresses (0–8 chars; empty disables)                            |
| `MEME_CREATE_DAILY_LIMIT`                   | 3       | drafts per account per rolling 24 h                                                  |
| `MEME_INDEXER_ENABLED` (worker)             | false   | `meme_event` lane, salt pool, receipt reconcile                                      |
| `MEME_GRADUATION_EXECUTOR_ENABLED` (worker) | false   | fallback `graduate`; requires `LAUNCH_DEPLOYER_PRIVATE_KEY` (boot refused otherwise) |

The quote asset is the launch slot's `LAUNCH_USD1_ADDRESS`, so the Launch contract unit (Decision 0076) must be configured too. Any of the four `MEME_CONTRACT_*` / `MEME_TOKEN_IMPLEMENTATION` keys blank → contract `null`, reason `MEME_CONTRACT_NOT_CONFIGURED`; Launch USD1 blank → `MEME_USD1_NOT_CONFIGURED`. A present but malformed value refuses boot (the 0038/0076 discipline). The adapter's startup probe checks chain ID, `eth_getCode`, `params()` equal to the docs/10 §1 constants this backend recomputes with, `params().usd1` = the configured USD1, and `tokenImplementation()` = the configured implementation; any mismatch is `MEME_CONTRACT_PARAMS_MISMATCH`.

`meme` joins `V2_MODULES_ENABLED` and `GET /v2/meta/capabilities`:

- module not enabled → `deferred` / `MEME_MODULE_NOT_ENABLED`;
- runtime not composed (no PostgreSQL or cursor secret) → `unavailable` / `MEME_RUNTIME_UNAVAILABLE`;
- contract not configured → `unavailable` / the configuration reason; every `/v2/meme/*` route answers `503 CAPABILITY_UNAVAILABLE` with `detailsSafe.reasonCode`;
- otherwise `available`; `evidence` is `confirmed` / `MEME_CONTRACT_OBSERVED` once the probe saw code and parameters, else `pending` with the adapter's reason (reads from PostgreSQL keep working while the RPC is unreachable).

### 2. Persistence (migration 000049)

- `meme_tokens` (`meme_token_id uuid` opaque key): creator (`creator_user_id`; `creator_wallet` is an attribute), metadata (name, symbol, description, `image_media_id` → `media_objects`, `links`), `metadata_hash`, `salt`/`predicted_address`/`vanity`, `token_address` (unique per chain, set by the lane), `asset_id` (Asset Registry row the lane registers), `status`, creation block/tx/time, the curve snapshot (`v_usd1`, `v_token`, `real_usd1`, `sold`, numeric(78,0)), counts, `full_at`, graduation facts (pool, tx, LP id, amounts, fee), residual, executor bookkeeping (`graduation_attempts`, `graduation_error`, `graduation_next_attempt_at`, `graduation_needs_operator`), and its create idempotency record.
- `meme_indexed_events`: non-trade logs of LOOP tokens (TokenCreated, CurveFull, Graduated, GraduationResidual, ResidualInjected, Paused, Unpaused), `removed` on rewind.
- `meme_trades`: Trade logs with `price_after_e18 = vUsd1After·1e18/vTokenAfter`, `removed` on rewind.
- `meme_holders`: net curve position per wallet, recomputed per segment, `frozen_at` = graduation time.
- `meme_salts`: mined salts per (chain, curve, implementation, suffix): `free` → `reserved` (by a draft) → `used`.
- `meme_intents`: create/buy/sell Intents with the sealed payload, approval, policy, report, receipt.
- `indexer_checkpoints.lane` admits `meme_event`; `idempotency_records.digest_version` admits `meme_token_create_v1`, `meme_intent_v1`.

Every table is in `requiredDatabaseRelations`; the down migration refuses while facts exist.

### 3. Token state machine

`draft` (POST /v2/meme/tokens) → `pending_chain` (create Intent broadcast reported) → `trading` (lane: TokenCreated matched) → `full` (CurveFull) → `graduated` (Graduated); `trading ⇄ paused` (Paused / Unpaused, the newest wins). A failed or expired create returns the token to `draft`. Status is recomputed from the stored, non-removed logs on every segment, so a reorg converges. Draft and pending_chain tokens are visible to their creator only (others: `404 NOT_FOUND` / `MEME_TOKEN_NOT_FOUND`).

TokenCreated is matched to a draft **by salt**, and accepted only when `metadataHash`, `name`, and `symbol` equal the draft's (the contract stores none of them); otherwise it is counted as `MEME_TOKEN_METADATA_MISMATCH` and not stored. Tokens LOOP did not create, and their events, are never stored ("App lists only App-created tokens", docs/10 §1). On match the lane registers the Asset Registry row (`pending`, `chain_call` evidence = the TokenCreated block) and marks the salt `used`.

`metadataHash = keccak256(canonicalJson({ version: "memeMetadataV1", memeTokenId, name, symbol, description, imageMediaId, links }))`. Including `memeTokenId` makes two identical drafts distinct.

### 4. Curve math and quotes

`src/features/meme/meme-curve-math.ts` is a line-for-line port of loop-contracts `scripts/lib/meme-math.ts` (which the contract suite proves equal to the chain): BigInt only, fees `ceil`, reserves `ceil(k/·)` so the user is rounded down, the fill branch with an exact refund (`fee = ceil(net·100/9900)`), sells refused beyond the sold supply. `test/fixtures/meme/curve-quotes.json` is 121 steps generated from that reference with its seeded RNG (`rng(20261008n)`), replayed exactly in `test/meme-curve-math.test.ts`.

`GET /v2/meme/quote` recomputes on the curve read from the chain (`getCurve`, 1.5 s cache) or, when the chain is unreadable, on the indexed snapshot (`basis.source = loop_indexer`). The chain's `quoteBuy` / `quoteSell` at the same block audits the recomputation; a relative difference above 0.1% (10 bps) is logged as `MEME_QUOTE_DRIFT` with both numbers and is never answered. Rounding differences cannot occur while the contract equals the reference (the invariant `vUsd1 == ceil(k/vToken)` makes the state a function of `sold`); a drift therefore means a different contract or a stale snapshot, which is why it is a warning and not silently corrected. `quoteBuy` on chain checks neither the wallet cap nor the minimum buy (loop-contracts 0001 §3.9), so the quote returns `walletCapHit`, `walletCapRemaining` (with `walletId`), and `belowMinBuy` itself.

Prices: `priceUsd1 = vUsd1/vToken`, `marketCapUsd1 = price × 1e9`, both USD1 decimal strings (USD1 counted at par, the Launch rule). `progressBps = sold·10000/800M`. `change1hPct` compares with the newest trade at or before now − 1 h, or the opening price `V0/T0` when none. A graduated row reads DexScreener (chain 56 only); on the testnet it is `priceUsd1: null` with `quoteUnavailable.reasonCode = MEME_DEX_CHAIN_NOT_PRICED`.

### 5. Intents (Decision 0077 discipline)

`POST /v2/meme/tokens/{id}/intents` with `kind` `create | buy | sell`:

- Gates: `BSC_WRITES_ENABLED` (else `503 MEME_WRITES_DISABLED`); the launch slot must be 97 (`503 MEME_MAINNET_SIGNING_CLOSED` on 56, the 00 §4.8 red line); adapter availability; a signable embedded wallet of the caller.
- Decision 0065 canary: USD1 must be a canary asset, the curve a canary counterparty (when the allowlist is non-empty), the per-Intent ceiling on the USD1 the wallet pays (buy/create) or receives (sell) at par, and the rolling daily ceiling over wallet + Launch + MEME Intents.
- One snapshot block for every read: `getCurve` (status must be TRADING: `409 MEME_CURVE_FULL` / `MEME_CURVE_NOT_TRADING`), balances, allowances, block time.
- Checks the contract applies: minimum buy 1 USD1 (`422 MEME_BELOW_MIN_BUY`), wallet cap 40M tokens on balance + output (`422 MEME_WALLET_CAP_EXCEEDED`, `remainingTokens`), USD1 balance ≥ paid, token balance ≥ sell, native gas, `minOut ≤ quote` (`422 MEME_MIN_OUT_ABOVE_QUOTE`; default slippage 100 bps).
- Allowance short → `approval { token, spender, amount, calldata, unsignedTransaction }`: an **exact** `approve` (never unlimited) to sign first with nonce N; the main call has nonce N+1, a fixed gas limit, and `simulation.status = unavailable` / `MEME_APPROVAL_REQUIRED`. Otherwise the call is simulated and estimated (+20%); a reverted simulation leaves `signing.allowed = false`.
- create: only the creator; the draft's salt is re-checked with `eth_getCode` on the predicted address; a salt someone else already used (salts are not bound to the creator on chain, loop-contracts 0001 §4) is marked `used` and replaced (vanity if the pool has one, else random) before building; the reservation is refreshed.
- `deadline` = max(now, block time) + `deadlineSeconds` (default 300, 30–1800) for buy/sell; `createToken` has no deadline, `expiresAt` bounds the signing window.
- The payload digest is SHA-256 of the canonical binding (account, wallet, token, kind, amounts, snapshot block, calldata, unsigned transactions, approval, policy). `Idempotency-Key` replays the same Intent.

States: `prepared` → `broadcast_reported` → `confirmed | failed | expired`; an unreported Intent past `expiresAt` reads `expired`. The report verifies the observed transaction against the sealed payload (`422 MEME_TX_PAYLOAD_MISMATCH`). `confirmed` comes from the lane (TokenCreated of the transaction for create; a Trade of the transaction and wallet for buy/sell; a late log also confirms an `expired` one) or from the receipt at the slot's confirmation depth; `0x0` → `failed` / `MEME_TX_REVERTED`; nothing after the deadline + 5 min (60 min while pending) → `expired` / `MEME_TX_NOT_OBSERVED`.

### 6. Worker lanes (default-off)

- `meme_event`: the Decision 0034 machine (seed at the start block → advance → rewind by the slot's reorg depth on a hash mismatch), ≤ 2,000-block segments, checkpoint `(meme_event, eip155:97)`, archive refusals reported as `BSC_LOG_ARCHIVE_REQUIRED`. The slot's read client is the launch slot's (the learned log-limit logic of Decision 0079 lives in that client; the single-address meme query never narrows by address).
- `meme_salt_pool` (5 min): frees reservations of drafts older than 30 min (the draft loses its salt and gets one when it prepares), then mines offline (`keccak256(0xff ++ curve ++ salt ++ keccak256(EIP-1167 initcode with the implementation))`, OpenZeppelin 5.6 `Clones`) in 20,000-draw slices that yield the event loop, until the target. About 2 s of CPU per `6666` hit on this machine. Verified against the deployed curve's `predictTokenAddress`.
- `meme_intent_reconcile` (5 s): the receipt rules above.
- `meme_graduation_executor` (15 s, only with the executor key): tokens `full` for ≥ 60 s get `graduate(token)` signed by the deployer key (dry run first; `NotFull` = someone graduated it); every attempt sets the next try 5 min later; 10 failed attempts set `graduation_needs_operator`. Only the lane's `Graduated` log moves the token to `graduated`. The sender refuses chain 56.

### 7. Market category

`category=meme` candidates = App tokens in `trading | full | graduated` (by `meme_tokens.asset_id`) ∪ the Launch project tokens (kept: IDO is hidden, not deleted). An ungraduated token's `quote` comes from its curve on any chain with `source: "loop_curve"`, `quality: "fresh"`, `change24hPct` against the newest trade 24 h ago (or the opening price), 24 h wallet-side volume; its sparkline is unavailable (`MEME_CURVE_SPARKLINE_UNAVAILABLE`). Graduated and Launch tokens keep the DexScreener path. The `source` enum of the category quote gains `loop_curve`.

### 8. Errors

No new catalog code. The design note's MEME codes are `detailsSafe.reasonCode` values under existing codes:

| reasonCode                                                                                                                                                                                                        | HTTP / code                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `MEME_TOKEN_NOT_FOUND`                                                                                                                                                                                            | 404 NOT_FOUND                                      |
| `MEME_CURVE_NOT_TRADING`, `MEME_CURVE_FULL`, `MEME_TOKEN_NOT_DRAFT`, `MEME_TOKEN_NOT_ON_CHAIN`, `MEME_SALT_TAKEN`, `MEME_INTENT_*`                                                                                | 409 DATA_STALE                                     |
| `MEME_USD1_BALANCE_INSUFFICIENT`, `MEME_SELL_EXCEEDS_BALANCE` (intent), `MEME_GAS_INSUFFICIENT`                                                                                                                   | 409 INSUFFICIENT_BALANCE                           |
| `MEME_WALLET_CAP_EXCEEDED`, `MEME_BELOW_MIN_BUY`, `MEME_METADATA_INVALID`, `MEME_IMAGE_NOT_OWNED`, `MEME_QUOTE_ZERO`, `MEME_MIN_OUT_ABOVE_QUOTE`, `MEME_SELL_EXCEEDS_BALANCE` (quote), `MEME_TX_PAYLOAD_MISMATCH` | 422 VALIDATION_FAILED                              |
| `MEME_CREATE_RATE_LIMITED`                                                                                                                                                                                        | 429 RATE_LIMITED (+ `dailyLimit`)                  |
| `MEME_CONTRACT_*`, `MEME_USD1_NOT_CONFIGURED`, `MEME_WRITES_DISABLED`, `MEME_MAINNET_SIGNING_CLOSED`, `MEME_REPOSITORY_UNAVAILABLE`, `MEME_CURSOR_NOT_CONFIGURED`, `MEME_WALLETS_UNAVAILABLE`                     | 503 CAPABILITY_UNAVAILABLE                         |
| `MEME_SALT_UNAVAILABLE`                                                                                                                                                                                           | internal log only; the client sees `vanity: false` |

## Deviations from the design note (S115-S118 §2)

1. **Extra table `meme_indexed_events`** for the non-trade logs, so status, graduation, and residual are recomputed after a rewind (the note lists five tables).
2. **`meme_trades.account_id` is not stored**: the account is resolved at read time from `account_wallets` (a wallet can be re-bound; a stored id would go stale). Trades and holders show `account` only for an active public profile.
3. **Holders are curve positions**, not ERC-20 balances: wallet-to-wallet transfers are not indexed. The viewer block reads `balanceOf` on chain.
4. **No salt → random salt, not `salt: null`**: `createToken` needs a salt, so a draft without a vanity salt gets a random one (`vanity: false`) and still returns `salt` and `predictedAddress`.
5. **Approval carries its own unsigned transaction** (exact amount) inside the MEME Intent instead of going through `POST /v2/wallet-intents/approve`, whose launch-slot rule admits only USD1 → the Launch contract and whose canary needs every token as a registered canary asset; sell approvals of new meme tokens could never pass it.
6. **Image**: the draft takes a `mediaId` the caller uploaded through `POST /v2/media/community-logos` (same 512×512 WebP pipeline; no new media kind).
7. **Intent states** follow the note (`prepared → broadcast_reported → confirmed | failed | expired`), not Launch's longer list; a reverted receipt is `failed` with `MEME_TX_REVERTED`.
8. **Residual** (loop-contracts 0001 §3.3): `GraduationResidual` minus `ResidualInjected` is published as `graduation.residual`.
9. **Daily limit** counts drafts (every accepted POST) in a rolling 24 h window, not a calendar day.
10. **`deadlineSeconds`** default 300 (note) with bounds 30–1800.

## Open questions

1. Should approvals go through the wallet-intents surface (with a new rule admitting "USD1 or a LOOP meme token → the curve") instead of the embedded approve?
2. Calendar-day (UTC+8) vs rolling 24 h for the creation limit.
3. A dedicated `meme_logo` media kind instead of reusing community logos.
4. Pre-graduation pool sniping and salt front-running are contract-level risks (loop-contracts 0001 §4); the backend only replaces a taken salt.
5. Mainnet: USD1 address, treasury, multisig, and a separate executor key; the executor and Intents stay closed on 56 until a decision opens them.
6. Graduated tokens on 97 have no DEX quote at all (DexScreener does not index the testnet); the S117 client shows the unavailable branch.
