# Decision 0121: MEME v2 buyback keeper (`launch2_buyback_keeper`) and quote stage consistency (S143)

- Status: Accepted (S143-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `0ac6a5b`; contracts `loop-contracts` main `bf9f170`
  (= `60f1ba3` sources + testnet manifests; the ABI selection was regenerated from it)
- Inputs: Decision 0112 (executor transaction discipline, nonce reservations, record
  before broadcast), Decision 0114 (read model, `launch2_buybacks`, open item "a buyback
  keeper"), Decision 0118 (lane pattern: default off, refuse boot without keys, chain 97
  only, idempotent, evidence rows), Decision 0119 (ABI sync), S137 report round 2
  observation 1, `BuybackExecutor.sol`, `NftEscrow.sol`, `PriceRecorder.sol`,
  `LoopLaunchFactory.sol`, loop-contracts Decision 0002 §5.
- Scope: migration `000065_launch2_buyback_keeper` (000064 is S142's), worker lane
  `launch2_buyback_keeper` (default off), optional `buyback.keeper` on
  `GET /v2/launch2/instances/{id}` and `summary.keeper` on `GET …/buybacks`,
  `buybackAttempts` on `GET /admin/v1/launch/projects/{projectId}`, quote / trade-prepare
  stage gate. No new route; no `/v1` change.

## Contract facts

`BuybackExecutor.execute()` is `onlyKeeper` (`primaryKeeper` / `fallbackKeeper`, immutables
copied from the Factory at deployment). It reverts with `BuybackPaused`, `TooSoon`
(`lastSuccessfulAt + MIN_SUCCESS_INTERVAL (10 s)`), `LaunchNotGraduated`, `NoBudget`,
`LockedPrincipalInsufficient` (official-pool USD1 principal < 10,000 or order > 1 % of it),
`ReferenceUnavailable` (`PriceRecorder.referencePrice()` not ready), `SpotOutsideProtection`
(spot > 5 % from the reference), `OutputBelowProtection` (< 99 % of the reference output),
`PartialFill`, `Unauthorized`; the escrow can add `BudgetExceeded`. One order =
`min(NftEscrow.availableBudget(), ORDER_AMOUNT = 100 USD1)` — the last order may be smaller.
Success emits `BuybackCompleted`; **a refusal reverts and leaves no log** (there is no
`Rejected` event; the task's "Executed/Rejected events" maps to `BuybackCompleted` + the
keeper's own refusal rows). The keeper pays gas; escrow funds move only on success.

`PriceRecorder.record()` is permissionless and nobody calls it today: the reference needs
≥ 30 samples, ≥ 60 s apart, no gap > 90 s, over 30 minutes. Without a sampler every
`execute()` is refused with `ReferenceUnavailable` (see Open 1).

## Flow (one tick, every `LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS`)

0. Node chain id must be 97 (`LAUNCH2_BUYBACK_KEEPER_CHAIN_MISMATCH`, nothing done). The
   keeper key must be the Factory's `primaryKeeper()` or `fallbackKeeper()` — checked at
   boot (refused, see Configuration) and, if the boot read failed, on the first tick
   (`LAUNCH2_BUYBACK_KEEPER_NOT_AUTHORIZED`: the lane never acts unverified).
1. Candidates: activated instances with `stage = graduated` (the lane indexed `Graduated`),
   plus any instance with an in-flight attempt. Read-model `buyback_paused` →
   `LAUNCH2_BUYBACK_PAUSED`, nothing simulated.
2. Backoff: the newest attempt `rejected` / `failed` with `next_eligible_at` in the future →
   wait (its reason / `LAUNCH2_BUYBACK_RETRY_WAIT`), no chain read.
3. Pre-checks on chain (no row): the executor's own keepers include the key
   (`…_NOT_KEEPER`), `budget()` = the instance escrow (`…_ESCROW_MISMATCH`), `paused()`
   (`…_PAUSED`), order > 0 (`…_NO_BUDGET`), `blockTime ≥ lastSuccessfulAt + 10`
   (`…_TOO_SOON`).
4. `simulateContract(execute)` from the keeper (decoded with the executor + escrow errors),
   then `estimateGas`. A revert → **`rejected` row** (`simulation = reverted`, reason code +
   contract error name, order amount); nothing signed or sent. The same reason and detail
   again → the same row: `rejection_count + 1`, `last_rejected_at`, new `next_eligible_at`
   (one row and one log line per persisting refusal). A different reason → a new row.
5. Gas price over 20 gwei → wait (`…_GAS_PRICE_ABOVE_CAP`), no row.
6. **Insert `pending`** (simulated order, gas) — at most one `pending | broadcast |
confirmed-unaligned` row per instance (unique partial index), so a repeated tick or a
   second worker never sends twice. Gas × 1.2 over 2,000,000 → `failed`
   (`…_GAS_ABOVE_CAP`).
7. Under the keeper account's nonce lock — the same advisory key and in-flight nonce set as
   the Hooks executor and the snapshot publisher (all three repositories now exclude each
   other's pending nonces) — sign a legacy chain-97 `execute()` and **record hash / nonce /
   raw bytes before sending**; send → `broadcast`. `insufficient funds` / rejected / nonce
   consumed → `failed`.
8. `broadcast`: no receipt → re-send the same bytes (nonce too low without our receipt →
   `failed` `…_TX_DROPPED`); reverted receipt → `failed` `…_TX_REVERTED` (e.g. the price moved
   between simulation and inclusion); success `confirmations` deep on a canonical block →
   `confirmed`.
9. `confirmed`: wait until the `launch2_event` lane's `launch2_buybacks` row of the same
   transaction exists, then set `buyback_id` (aligned). Until then
   `…_LEDGER_PENDING` and **no next order**. Receipt left the canonical chain before
   alignment → back to `broadcast`, same bytes re-sent.
10. The next order starts at step 2 once aligned and `TOO_SOON` has passed.

Backoff after a refusal (count n in a row): `TooSoon` → 10 s; everything else
`min(interval × 2^(n−1), 600 s)` (15, 30, 60 … 600 s at the default interval). After a
`failed` attempt: 60 s. Failed and rejected rows never block the instance permanently;
there is no attempt budget (the escrow is the budget).

## Entity (migration 000065)

`launch2_buyback_attempts`: `attempt_id` (opaque UUIDv4) PK; `instance_id` →
`launch2_instances`; `chain_id`; `attempt` (unique per instance); `status`
`rejected | pending | broadcast | confirmed | failed`; `keeper_address`,
`executor_address` (facts, never keys); `simulation` `passed | reverted`; `order_usd1`
(numeric, raw 18-decimal); `simulated_gas`; `reason_code`, `reason_detail` (contract
error name); `rejection_count`, `last_rejected_at`, `next_eligible_at`; `tx_hash`,
`tx_nonce`, `raw_tx`, `block_number`, `block_hash`, `confirmations`; `buyback_id` (the
ledger row; no FK — the lane may mark facts `removed` on a reorg); `created_at`,
`broadcast_at`, `confirmed_at`, `updated_at`. Guard trigger: identity columns immutable;
transitions `pending→pending|broadcast|failed`, `broadcast→broadcast|confirmed|failed`,
`confirmed→confirmed` (alignment once) `|broadcast` (reorg, only while unaligned),
`rejected→rejected` (same reason, count strictly up); transaction set once while
`pending`; no delete. Registered in `schema.ts`; `dev:reset-users` deletes rows of doomed
instances. Ledger alignment is by transaction hash; the keeper never writes
`launch2_buybacks`.

## Reads

- `GET /v2/launch2/instances/{id}` → `buyback.keeper` and `GET …/buybacks` →
  `summary.keeper`: `{lastAttemptAt, lastResult, reasonCode, nextEligibleAt} | null`
  (newest attempt). `lastAttemptAt` = latest refusal time for a refreshed `rejected`, else
  the insert time. `nextEligibleAt` = the stored backoff / retry time for `rejected` /
  `failed`; the last ledger success + 10 s for an aligned `confirmed`; null otherwise.
  Optional in the schema (additive), always present in answers.
- `GET /admin/v1/launch/projects/{projectId}` → `buybackAttempts[]` (newest 20): ids,
  attempt, status, simulation, keeper / executor address, `orderUsd1Wei`, `simulatedGas`,
  `reason {code, detail}`, rejection count / last / next, tx hash / nonce / block /
  confirmations, `buybackId`, timestamps. Never the raw transaction.

## Quote stage consistency (S137 observation 1)

`GET /v2/launch2/instances/{id}/quote` and `POST …/trade/prepare` gate on the **read-model
stage** (`deriveLaunch2Stage` over lane-confirmed facts + the clock — the value the
detail shows). After the hold / sold-out / closed-stage checks on that stage, the chain
stage at the quote block (`published`, `graduated`, block time vs `earlyRoundEndsAt`) must
be the same; otherwise `409 DATA_STALE` / `LAUNCH2_STAGE_MISMATCH` with
`detailsSafe.stage` = the read-model stage. MAX, amounts, deadline basis still come from
that block. Consequences: between `SnapshotPublished` on chain and the lane's confirmation
(~20 s on the testnet) the quote is 409 `snapshot_pending` (it was a 200 `priority`); a
graduation the lane has not confirmed is 409 with the read-model stage (it was
`LAUNCH2_SOLD_OUT`). No new code; the frontend contract §3.3 says so.

## Configuration (worker only)

| Env                                       | Default | Rule                                                                                                                          |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LAUNCH2_BUYBACK_KEEPER_ENABLED`          | `false` | `true` refuses boot unless the rest is valid                                                                                  |
| `LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY`      | —       | 32-byte hex; at boot it must be the Factory's `primaryKeeper()` or `fallbackKeeper()` (`Launch2KeeperBootRefusedError`, exit) |
| `LAUNCH2_BUYBACK_KEEPER_INTERVAL_SECONDS` | 15      | 10–3,600 (≥ `MIN_SUCCESS_INTERVAL`)                                                                                           |
| `LAUNCH2_BUYBACK_KEEPER_CONFIRMATIONS`    | 12      | 1–64                                                                                                                          |
| `HOOKS_LAUNCH_FACTORY_ADDRESS`            | —       | required (the keepers are read from it)                                                                                       |
| `LAUNCH_CHAIN_ID`                         | —       | must be `97` (BSC Mainnet signing stays closed)                                                                               |

Fixed policy (code): gas price cap 20 gwei, gas limit cap 2,000,000, failed-retry 60 s,
backoff cap 600 s. Missing RPC / repository at runtime → `LAUNCH2_CHAIN_NOT_CONFIGURED` /
`LAUNCH2_REPOSITORY_UNAVAILABLE` logged once, lane idle. An unreadable Factory at boot →
lane enabled with `LAUNCH2_BUYBACK_KEEPER_UNVERIFIED`, verified on the first tick.

## Key custody

The key is read from the worker environment only, lives in the integration closure
(`createLaunch2BuybackKeeperChain`), and never enters a log line, an error, a row, or a
response (`test/worker-runtime.test.ts` asserts the log lines). Testnet:
`LOOP_PRIMARY_KEEPER_PRIVATE_KEY` from `ops/protocol-testnet.local.env` into
`ops/api-dev.local.env` (not changed by this batch); the account needs tBNB. The fallback
keeper key stays offline as the spare. Mainnet: undecided (KMS / separate host).

## Errors / unavailable

No new HTTP error code. Lane reason codes (logged; `reasonCode` of `keeper` and of the
console rows): `LAUNCH2_BUYBACK_*` listed above. Logs: one line per new step (pending,
broadcast, confirmed, aligned, failed, a new refusal), one per changed waiting reason; a
refreshed refusal is silent.

## Evidence

- Unit: `test/launch2-buyback-keeper.test.ts` (classification of every contract error,
  backoff, Factory-keeper refusal, first-tick verification, execute → broadcast →
  confirmed → ledger alignment → `TOO_SOON` → next order with the next nonce, same-reason
  refresh vs new row, backoff skips simulation, pause in the read model / on chain, no
  budget, partial last order, escrow mismatch, executor keeper mismatch, gas price cap,
  insufficient funds + retry wait, reverted receipt, reorg re-send, paused pending without
  tx, lane log dedupe); `test/worker-runtime.test.ts` (config refusals, boot refusal for a
  non-keeper, enabled log without the key, deferred verification, idle reason, off);
  `test/v2-launch2-routes.test.ts` (`keeper` vs schema in detail and buybacks;
  quote / prepare 409 `LAUNCH2_STAGE_MISMATCH` with the read-model stage when the chain is
  ahead, 200 when they agree); `test/admin-role-contract.test.ts` (`buybackAttempts` in the
  artifact).
- Integration: `test/launch2-buyback-keeper-anvil.integration.test.ts` (anvil chain 97,
  real Foundry deploy, own throwaway database): activate → 5 NFT mints → publisher
  snapshot → public round → 160 generated wallets buy their quota until the last buy
  graduates → keeper before any price sample: `rejected ReferenceUnavailable`, nothing
  sent, refreshed not duplicated → 33 `record()` samples → three executions ≥ 10 s apart,
  each `confirmed` and aligned with the lane's `BuybackCompleted` row, nonces consecutive
  → detail `keeper` and console `buybackAttempts` → `pause()` → no broadcast (chain
  pre-check, then the read model) → update / delete refused; a non-keeper key is refused,
  the fallback keeper accepted.

## Open (for the coordinator)

1. **Nobody feeds `PriceRecorder.record()`**: on the testnet every buyback is refused
   (`LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE`) until something samples every 60–90 s for
   30 minutes and keeps doing it (one transaction per minute per graduated instance).
   Proposal: a `record()` sampler in this lane behind its own flag (same key / nonce lock),
   or an ops cron; needs a product decision on who pays the gas.
2. The task said "escrow ≥ 100 USD1"; the contract (and loop-contracts 0002 "每笔 100，末笔可少")
   orders `min(available, 100)`. The keeper follows the contract (it also orders a
   last partial amount). With NFTs priced at exactly 100 USD1 the two are the same.
3. Migration order: this branch has `000063 → 000065`; S142 adds `000064`. Merge S142
   first (or run `node-pg-migrate` with `--no-check-order` once) — a database that has
   applied 000065 refuses to apply an older 000064 by default.
4. No console action to pause / resume (the pause authority signs on chain) or to clear a
   backoff; an operator waits for `nextEligibleAt`.
5. Mainnet key custody (above); the keeper must not share the executor account on mainnet
   (Decision 0002 requires primary ≠ executor; the nonce lock makes sharing safe on the
   testnet only).
