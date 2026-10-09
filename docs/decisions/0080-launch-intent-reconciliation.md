# Decision 0080: Receipt reconciliation of Launch purchase Intents

- Status: Accepted (backend, S83b2)
- Date: 2026-09-25
- Scope: S83b2. Main-agent ruling 4 on Decision 0077 ("extend the 0035
  reconcile lane to `launch_intents`"). Builds on Decisions 0035 (the
  `wallet-intent-reconcile` lane), 0038 (launch chain slot), and 0077
  (Launch Intent prepare, broadcast report, `launch_event` lane).
- Baseline: `integration/v2` = `8d99260`. Migration `000043`.

## Context

0077 confirms a reported Launch Intent only when the `launch_event` lane
indexes a `Purchased` log of its transaction. A `buy()` that reverts emits no
log, so its Intent stayed `submitted` forever; a hash that never lands did
the same. The 0035 lane already reads receipts for wallet Intents but never
looked at `launch_intents`.

## Rulings

### 1. Where it runs

The Launch part runs inside the existing `wallet-intent-reconcile` lane
(`WALLET_INTENT_RECONCILE_ENABLED`), after the wallet part, in the same tick
and the same backoff loop. It is wired only when the Launch chain repository
exists and the four `LAUNCH_CONTRACT_*` keys are set (no Intent can exist
otherwise). It reads through the **launch slot's** call client (0038): the
testnet client when `LAUNCH_CHAIN_ID=97`, the primary client when it is 56.
It never signs, broadcasts, or replays anything.

### 2. Entity changes (`000043`, append-only)

`launch_intents` gains:

| Column            | Meaning                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receipt`         | Finalized receipt fact `{status: success/reverted, blockNumber, blockHash, gasUsed, effectiveGasPrice, confirmations, observedAt}`; decimal strings only. |
| `reason_code`     | Why the lane settled it without success: `LAUNCH_TX_REVERTED`, `LAUNCH_TX_NOT_OBSERVED`, `LAUNCH_TX_PAYLOAD_MISMATCH`.                                    |
| `revert_reason`   | Decoded revert reason; check-constrained to `state = 'reverted'`. Always null today (see 5).                                                              |
| `reconcile_after` | Lease/pacing (15 s lease, batch 10), as in 0035.                                                                                                          |

`launch_intents_report_check` now also requires a transaction hash for
`reverted` and `failed`. The 000023 state check already admitted every target
state; no enum changes in the database. IDs are unchanged (opaque
`intent_id`); the transaction hash is evidence, never a key. `down` refuses
while any reconciled row exists.

### 3. State machine

```
awaiting_signature ──report(hash)──▶ submitted
submitted ──Purchased log indexed (launch_event lane)──────────────▶ confirmed
submitted ──receipt 0x1, depth ≥ confirmations (this lane)────────▶ confirmed
submitted ──receipt 0x0, depth ≥ confirmations────────────────────▶ reverted  (LAUNCH_TX_REVERTED)
submitted ──unverified hash is another transaction────────────────▶ failed    (LAUNCH_TX_PAYLOAD_MISMATCH)
submitted ──no receipt, now > deadline + 5 min────────────────────▶ expired   (LAUNCH_TX_NOT_OBSERVED)
            (tx still pending in the endpoint's mempool: deadline + 60 min)
confirmed ──reorg removes the Purchased log, no success receipt───▶ submitted (0077 unchanged)
expired   ──a Purchased log of its hash is indexed────────────────▶ confirmed (evidence wins)
```

- **Depth.** `head − receipt.block + 1 ≥` the slot's confirmations
  (`LAUNCH_BSC_CONFIRMATIONS`, default 5, on 97; the primary depth on 56).
  Both outcomes wait for the depth, not only success; a shallower receipt is
  not stored.
- **Deadline.** `expiresAt` equals the on-chain `buy()` deadline (0077). After
  it a still-unmined transaction can only revert, so a missing receipt past
  the grace is final. Graces: 5 minutes with no trace of the transaction, 60
  minutes when the endpoint still reports it pending.
- **Payload.** A report accepted without the transaction in hand
  (`payload_verified = false`) is verified first with the same comparison as
  the report route (`launchTransactionMatches`); a match sets the flag.
- **Idempotency, first evidence wins.** Every write of this lane is
  `update … where state = 'submitted' and transaction_hash = $hash`. If the
  lane already confirmed the Intent it is not leased and a stale settle is a
  no-op. If the receipt confirmed it first, the lane's re-projection keeps it
  `confirmed` (`receipt->>'status' = 'success'` counts as evidence alongside
  the Purchased log), so a later segment without the log (not yet indexed,
  or reorged) never sends a receipt-confirmed Intent back. `reverted` and
  `failed` are never touched by the lane (a reverted transaction emits no
  log).
- `cancelled` and `unknown` are not produced for Launch Intents.
- A receipt read refused with HTTP 403 is a per-Intent read failure
  (`LAUNCH_RPC_RECEIPT_UNAVAILABLE`, other errors
  `LAUNCH_INTENT_RECONCILE_READ_FAILED`), logged, retried after the lease;
  the Intent does not move.
- Canary exposure (0065) is unchanged: `reverted` still counts in the rolling
  window, `expired`/`failed` do not, as for wallet Intents.

### 4. Visibility (wire)

- `POST /v2/launch/{launchId}/intents` (idempotent replay) and
  `POST …/broadcast-report` (same-hash replay) return the stored Intent, so
  they now show `reverted` / `failed` / `expired` after reconciliation. All
  three were already in the frozen `state` enum (S83a/S83b): **no enum
  change**.
- `signing.reasonCode` for a settled Intent is the stored `reason_code`
  (`LAUNCH_TX_REVERTED`, `LAUNCH_TX_NOT_OBSERVED`,
  `LAUNCH_TX_PAYLOAD_MISMATCH`) instead of `LAUNCH_INTENT_ALREADY_REPORTED`.
  `signing.allowed` stays false.
- New optional property `launchIntent.revertReason: string | null`, present
  **only when `state` is `reverted`** (null today). Absent in every other
  state, so no existing response changes bytes. A strict decoder that
  rejects unknown keys would fail only on a reverted Intent — a state it
  never received before either. The receipt fact is internal and never on
  the wire.
- `GET /v2/launch/{launchId}/history` is unchanged: it lists indexed
  `Purchased` logs, and a reverted or expired buy has none. It never showed
  Intent states.

### 5. Revert reason

Public endpoints expose no `debug_traceTransaction`, and an `eth_call` replay
of the calldata runs on a different state (later block, other transactions
of the same block already applied), so it can name a reason the transaction
never hit. `revert_reason` therefore stays null. A trace-capable Provider
can fill it later without a wire change.

### 6. Unavailable behaviour

- Contract keys blank, or no Launch repository: the part is not wired; the
  wallet part is unchanged.
- Keys set but no launch-slot client (`LAUNCH_CHAIN_ID=97` with blank
  `LAUNCH_BSC_RPC_URLS`): the part returns `unavailable` /
  `LAUNCH_CHAIN_RPC_NOT_CONFIGURED` (one warn line per change), leases
  nothing, moves nothing; reported Intents stay `submitted`.
- No route's `unavailable` branch changes; the `503` bytes of 0077 are
  untouched.

### 7. Logs

`lane: launch_intent_reconcile`, messages `LOOP launch intent reconciliation
is unavailable`, `LOOP launch intent receipt read failed`, `LOOP launch
intent settled from its receipt`, with `launchIntentId`, `toState`,
`reasonCode` only (worker logger allowlist).

## Consequences

- A reverted `buy()` is visible to the client within one tick after the
  confirmation depth instead of never.
- A receipt can confirm an Intent before the `launch_event` lane catches up
  (e.g. the lane is behind the endpoint's history window, S82d); the lane's
  later Purchased log is idempotent with it.
- Open for the main agent: whether `revertReason` should be dropped from the
  wire until a trace-capable Provider exists (it is always null today).

## Main-agent rulings (2026-09-25)

1. `revertReason` stays on the wire as an optional field that is null until a Provider with trace support exists; the client decodes it as optional.
2. Expiry graces accepted: 5 minutes past the deadline with no trace, 60 minutes while the node still shows the transaction pending.
3. A `Purchased` log for an expired Intent moves it to `confirmed`: kept. The chain is the authority.
4. `reverted` keeps counting toward the canary daily exposure, as wallet Intents do.
