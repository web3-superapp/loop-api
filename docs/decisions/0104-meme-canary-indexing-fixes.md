# Decision 0104: MEME canary window, Intent admission, and index consistency fixes (S116c / FIX-B)

- Status: Accepted (FIX-B)
- Date: 2026-10-09
- Scope: review findings M1, M2, M5, m2, m3, m6, n3 of `LOOP/docs/integration/review-2026-10-09/loop-api-s111-s119-review.md` against Decisions 0065, 0077, 0101, 0103. No migration, no new route, no new catalog error code, no new stable ID, no new environment key. New `detailsSafe.reasonCode` values under existing codes: `MEME_INTENT_CREATE_IN_FLIGHT` (409 `DATA_STALE`); `MEME_CREATED_CREATOR_MISMATCH` is a worker log reason only.
- Baseline: `integration/v2` = `bedb36e`

## Entities and IDs

Unchanged. `meme_intents`, `meme_trades`, `meme_indexed_events`, `wallet_intents`, `launch_intents` keep their opaque UUID keys; nothing is keyed by a wallet address. The account (`loop_users.id`) is the unit of the canary window and of the row lock.

## M1 + n3: one canary day for wallet, Launch, and MEME

Before: wallet / Launch summed `wallet_intents ∪ launch_intents`; MEME summed those plus `meme_intents`, so MEME spending never reduced the room of Send / Swap / Launch.

Now `src/database/canary-exposure.ts` owns the only SQL of the window, read by `WalletIntentRepository.sumRecentExposureUsd` (Send, Swap, approvals, and Launch through `walletIntentExposureUsd`) and `MemeRepository.sumRecentExposureUsd` (MEME). It sums `policy.valueUsd` of:

| table            | counted states                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `wallet_intents` | `awaiting_signature`, `submitted`, `confirmed`, `reverted`, `unknown` (Decision 0065)     |
| `launch_intents` | same list (Decision 0077)                                                                 |
| `meme_intents`   | `broadcast_reported`, `confirmed`, and `prepared` with `expires_at > now` (Decision 0101) |

n3: the window boundary is `created_at >= since` in all three tables (MEME used `>`). The MEME service no longer adds `walletIntentExposureUsd` on top (it would double count); `MemeServiceDependencies.walletIntentExposureUsd` stays in the interface (owned by `meme-service.ts`, outside this change) and is unused by the Intent path.

The refusal is unchanged: `403 POLICY_BLOCKED` / `CANARY_DAILY_CEILING_EXCEEDED` with `exposureUsd`, `ceilingUsd`, `spentUsd`, `remainingUsd`, now built by one helper `assertDailyCanaryCeiling` for all three modules.

## M2: admission under the owner lock

Before: the ceiling was checked during `build` (after the idempotency claim, outside any transaction) and the row was inserted with a bare `pool.query`; two concurrent prepares both passed. A draft could have several `prepared` create Intents.

Now every Intent insert runs in a transaction that first locks `loop_users` (`lockV2Owner`) and then re-checks on what is stored at that moment. Chain reads still happen before, outside any transaction (the 0077 discipline).

- `CanaryExposureAdmission { since, admit(spentUsd) }` (`intent-contract.ts`), built by `dailyCanaryAdmission(writes, valueUsd, now)`; null when no daily ceiling is configured or the Intent carries no value (create without a first buy, Launch claim/refund, revoke). The pre-check stays (it fails fast before chain reads); the in-transaction check is authoritative.
- MEME `createIntent`: `canaryAdmission(built)` and `exclusiveCreate { memeTokenId }`. Launch `createIntent` (`src/database/launch-chain-repository.ts`, the same pattern the review flagged): `canaryAdmission`. Wallet `create`: optional `canaryAdmission` passed by Send / approve / Swap.
- One live create Intent per draft: the token row is locked (`for update`), its status must be `draft` (else `409 DATA_STALE / MEME_TOKEN_NOT_DRAFT` + `status`), and no create Intent of it may be `broadcast_reported` or `prepared` inside its window with a simulation that did not revert (else `409 DATA_STALE / MEME_INTENT_CREATE_IN_FLIGHT`). The same check also runs in the claim transaction before `build`, so a second prepare never replaces the draft's salt while the first transaction may already be on chain. A replay of the same `Idempotency-Key` still returns the original Intent (checked first, and again inside the insert transaction for a concurrent replay).
- Lock order: owner row → token row (API); the lane locks only token rows. No cycle.

## M5: reorg consistency of the `meme_event` lane

- `meme_trades` `on conflict (chain_id, transaction_hash, log_index)` now refreshes every fact column (`token_address`, `meme_token_id`, `wallet`, `is_buy`, `usd1_amount`, `token_amount`, `fee_usd1`, `v_usd1_after`, `v_token_after`, `sold_after`, `price_after_e18`, `traded_at`, block, hash, `removed`); `meme_indexed_events` likewise refreshes `contract_address`, `token_address`, `meme_token_id`, `event_name` besides the payload. A transaction re-included after a reorg at the same key with different execution results replaces the old facts; projections are recomputed from them as before.
- Rewind: every `confirmed` MEME Intent on the chain whose transaction had a log in the rewound range, or whose stored receipt block is in the range, returns to `broadcast_reported` with `receipt = null`, `reason_code = null`, `reconcile_after = null`. The lane's replay (TokenCreated / Trade of that transaction) or the receipt reconcile lane confirms it again; a create Intent's token returns to `pending_chain` through the existing reprojection.

State machine addition: `confirmed → broadcast_reported` (lane rewind only).

## m2: sells need USD1 on the canary allowlist

The USD1 allowlist check ran only when USD1 was paid; a sell receives USD1 and is valued in it, so every kind (create, buy, sell) now requires USD1 in `BSC_WRITE_CANARY_ASSETS` (`403 POLICY_BLOCKED / ASSET_NOT_IN_CANARY_ALLOWLIST`).

## m3: TokenCreated must come from the draft's create wallet

A salt is not bound to its creator on chain (loop-contracts 0001 §4). A TokenCreated that matches a draft by salt and metadata is accepted only when `payload.creator` equals the `wallet_address` of some create Intent of that draft (any state: a signed but unreported Intent is still the creator's). Otherwise it is counted in `CommitMemeSegmentResult.creatorMismatchCount`, not stored (no token address, no Asset Registry row, salt not marked used), and the worker logs a warning `MEME_CREATED_CREATOR_MISMATCH` with the block and count. The draft stays a draft; the creator's next prepare finds the predicted address occupied and gets a fresh salt (Decision 0101).

## m6: chain reads on the POST path fail closed as 503

Every chain read of `POST /v2/meme/tokens/{id}/intents` (availability, snapshot, block, `getCurve`, `getCode`, balances, allowances, simulation call, fee data, nonce) goes through `chainRead`: a `V2ApiError` keeps its meaning, `MemeContractUnavailableError` keeps its reason, and anything else (a viem `TimeoutError`, an HTTP/socket failure, a malformed answer, a plain `Error`) is `503 CAPABILITY_UNAVAILABLE / MEME_CONTRACT_READ_FAILED` instead of `500`. The quote audit and gas estimate keep their best-effort handling.

## Unavailable behavior

Unchanged: without writes `503 MEME_WRITES_DISABLED`; without the repository `503 MEME_REPOSITORY_UNAVAILABLE`; the window SQL failing inside the insert transaction is a repository outage (`503`/`500` per module as before), never an admission.

## Tests

- `test/meme-canary-indexing-fixes.integration.test.ts` (PostgreSQL): MEME spend blocks Send, Swap, Launch, and MEME; the `>=` boundary; stale pre-checks refused in-transaction for Launch and wallet; two concurrent 60 USD buys under a 100 USD day → one stored, one refused; three concurrent creates → one stored, two `MEME_INTENT_CREATE_IN_FLIGHT`, a new one after expiry, refused again once reported; creator mismatch refused and counted, own wallet accepted; reorg refreshes the facts of a re-included trade, reopens lane- and receipt-confirmed Intents (not those below the range), they are leased by reconcile and re-confirmed by the replay.
- `test/v2-meme-routes.test.ts`: sell without USD1 allowlisted → 403; RPC timeout on fee data and a plain read error → 503 `MEME_CONTRACT_READ_FAILED`; daily refusal on the pre-check and on the insert re-check; second create → 409 with the seven-key error body.
