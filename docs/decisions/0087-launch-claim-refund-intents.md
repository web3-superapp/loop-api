# Decision 0087: Launch claim and refund Intents beside the purchase Intent

- Status: Proposed (backend, S92a)
- Date: 2026-09-27
- Scope: `POST /v2/launch/{launchId}/intents` (new body discriminator
  `kind`), `POST …/broadcast-report` and `GET …/intents/{launchIntentId}`
  (shared), `GET /v2/launch/{launchId}/history` (new optional
  `settlements`), the `launch_event` lane's Intent confirmation, and the
  0080 receipt reconciliation. Builds on Decisions 0076 (adapter, snapshot
  discipline, `encodeClaim` / `encodeClaimRefund`), 0077 (Intent prepare,
  report, lane), 0080 (receipt reconciliation), 0081 (Intent read), 0083
  (capability evidence), and 0085 (`readSaleSnapshot`). Contract interface:
  LOOP `docs/06-Launch合约接口需求.md` ("06") §2, §3, §4.1, §4.2.
- Baseline: `integration/v2` = `02ab1c2`. Migration `000044`.

## Context

A buyer can now reach the contract through `buy()` (0077, verified on
device), but nothing lets the money come back: a successful sale's tokens
are released by `claim(saleId)`, a failed or cancelled sale's USD1 by
`claimRefund(saleId)`. Both calls are already in ABI v1 and encoded by the
adapter; `Claimed` / `Refunded` are already indexed by the lane and
projected into `entitlements` / `refund_liabilities`. What was missing is an
Intent that seals those calls, admission rules that fail closed, and the
lane / receipt link from the log back to the Intent.

## Rulings

### 1. Entities and identity

| Entity                            | Key                                                     | Change                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch_intents`                  | opaque `intent_id` (unchanged)                          | `direction` (000023, `'buy'` only) is the Intent kind: `buy`, `claim`, `claim_refund`. `round_id` becomes nullable; `launch_intents_kind_round_check`: a buy has a round, a claim / refund has neither `round_id` nor `round_index`. A claim / refund pays 0 (`pay_amount_raw = 0`); a buy stays `> 0`.        |
| `launch_settlement_records` (new) | opaque `settlement_record_id`; unique `(tx, log_index)` | One row per `Claimed` / `Refunded` log whose wallet argument resolves to exactly one LOOP account (the 0077 resolution). `kind` `claimed` / `refunded`, `asset_id` (project token / USD1), `amount_raw`, `cumulative_raw`, block, `confirmation_state` `pending → confirmed`, `reorged` on a reorg (row kept). |

The wire kind is `claimRefund`; the column value is `claim_refund` (the
repository maps them once). The transaction hash is evidence, never a key;
the wallet address is never a key.

### 2. Request

`kind` is optional and defaults to `buy`:

- absent or `"buy"`: `{walletId, roundId, payAmount}` exactly as before;
  the idempotency digest parts are unchanged, so a pre-0087 client's replay
  is still a replay and an explicit `kind: "buy"` is the same request.
- `"claim"` / `"claimRefund"`: `{kind, walletId}` only. A `roundId` or
  `payAmount` on them, an unknown `kind`, or a missing `walletId` is
  `400 INVALID_REQUEST` (schema `anyOf` of two closed branches plus the
  service check); nothing is silently ignored. Digest parts
  `[launchId, walletId, kind]`, so one `Idempotency-Key` can never serve two
  kinds (`409 IDEMPOTENCY_CONFLICT`).

### 3. Admission (fail closed, one block)

Order: the unchanged 0077 gates (bare `503` without `BSC_WRITES_ENABLED` or
the four keys; adapter / chain `503 + reasonCode`; launch `404`; registry
`503`; embedded active owned wallet `404` / `422`; sale assets registered),
then:

1. Canary: only the counterparty allowlist (`COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`).
   Nothing is paid, so the asset allowlist, the per-Intent ceiling, and the
   daily ceiling do not apply; the Intent records `valueUsd = "0"` and adds
   nothing to the shared rolling window.
2. One block: `readSaleSnapshot(saleId)` (0085: head → one Multicall3 of
   `getState` / `getRounds` / `getSaleConfig` → hash check), then
   `getPosition(saleId, wallet)` pinned to that snapshot's block, then the
   snapshot hash is re-checked (`LAUNCH_SNAPSHOT_REORGED` otherwise). A read
   failure is `503` with the 0076 reason. The 0085 cache may serve the sale
   part for up to `LAUNCH_SNAPSHOT_CACHE_TTL_MS`; `getPosition` is always
   read at that snapshot's own block, so every fact of the Intent is from
   one block.
3. Shared cross-checks: zero `configVersion` → `503 LAUNCH_SALE_NOT_FOUND`;
   `usd1` differs → `503 LAUNCH_USD1_ADDRESS_MISMATCH`; configVersion drift →
   `409 DATA_STALE LAUNCH_CONFIG_VERSION_MISMATCH`.
4. Kind rules (all `409 DATA_STALE`, `detailsSafe.reasonCode`):

| Kind          | reasonCode (extra `detailsSafe`)                           | Rule                                                                                          |
| ------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `claim`       | `LAUNCH_CLAIM_NOT_OPEN` (`entitlementState`)               | `entitlementState ≠ VESTING` (NONE, FROZEN before TGE / pool, COMPLETED, REFUNDING, REFUNDED) |
| both          | `LAUNCH_SALE_PAUSED`                                       | `operationalState = PAUSED`                                                                   |
| `claim`       | `LAUNCH_NOT_PARTICIPANT`                                   | `cumulativeUsd1 = purchasedTokens = entitledTokens = claimedTokens = 0`                       |
| `claim`       | `LAUNCH_NOTHING_TO_CLAIM`                                  | `claimableTokens = 0` (nothing matured yet, or everything already claimed)                    |
| `claimRefund` | `LAUNCH_REFUND_NOT_OPEN` (`saleState`, `entitlementState`) | `saleState ∉ {FAILED, CANCELLED}` **or** `entitlementState ≠ REFUNDING`                       |
| `claimRefund` | `LAUNCH_NOT_PARTICIPANT`                                   | `cumulativeUsd1 = refundableUsd1 = refundedUsd1 = 0`                                          |
| `claimRefund` | `LAUNCH_NOTHING_TO_REFUND`                                 | `refundableUsd1 = 0` (already refunded)                                                       |

The brief asked for `saleState ∈ {FAILED, CANCELLED}` for refunds; 06
§4.1 makes the contract require `entitlementState = REFUNDING`. Both are
checked, so a sale whose refund window has closed (`REFUNDED`) is refused
here instead of reverting on chain. 5. Funds: native balance only; `gas × max fee > balance` →
`409 INSUFFICIENT_BALANCE LAUNCH_GAS_INSUFFICIENT`. 6. `eth_call` + `estimateGas` of the exact `claim(saleId)` /
`claimRefund(saleId)` payload; a reverted or unavailable simulation still
creates the Intent in `prepared` (`signing.allowed = false`), as for a
buy. Fee, nonce, gas limit × 1.2, and the unsigned transaction are built by
the same code as a buy.

### 4. Intent shape (wire)

A buy's `launchIntent` is **byte-identical** to before: no `kind`, no new
key (pinned by a key-set test). A claim / refund Intent uses the same
object with:

- `kind: "claim" | "claimRefund"` (optional property; absent means buy);
- `roundId: null`, `roundIndex: null` (schema widened to `string | null` /
  `integer | null`; a buy never emits null);
- `usd1Amount: "0"`, `minTokenAmount: "0"`, `eligibilityProof: []`;
- `expectedTokenAmount`: claim = `claimableTokens`, claimRefund = `"0"`;
- new optional `claimableTokens` (claim only) / `refundableUsd1`
  (claimRefund only), the `getPosition` value at `snapshotBlockNumber`;
- `walletCumulativeUsd1` = `getPosition.cumulativeUsd1`;
- `deadline` = `expiresAt` = now + 120 s: the signing window only. The
  contract functions take no deadline, so a transaction signed in time can
  still land later (see 5);
- `policy.valueUsd = "0"`; no `walletRoundCapUsd1` / `walletProjectCapUsd1`.

`payloadDigest` binds account, wallet, launch, project, saleId, chain,
both asset IDs, `direction` (= kind), the expected receive amount,
configVersion, the wallet's cumulative USD1, deadline, contract,
`stateTupleDigest`, snapshot block + hash, and the unsigned transaction.

### 5. State machine and reconciliation

Unchanged from 0077 / 0080 for every kind; the only kind-specific rule is
which log is evidence:

```
awaiting_signature ──report(hash)──────────────────────────────▶ submitted
submitted ──evidence log of that tx indexed (launch_event lane)──▶ confirmed
submitted ──receipt 0x1 at depth (reconcile lane)───────────────▶ confirmed
submitted ──receipt 0x0 at depth────────────────────────────────▶ reverted  (LAUNCH_TX_REVERTED, revertReason null)
submitted ──hash is another transaction─────────────────────────▶ failed    (LAUNCH_TX_PAYLOAD_MISMATCH)
submitted ──no receipt, now > deadline + 5 min (60 min pending)──▶ expired   (LAUNCH_TX_NOT_OBSERVED)
confirmed ──reorg removes the evidence log, no success receipt───▶ submitted
expired   ──evidence log of that tx indexed─────────────────────▶ confirmed (evidence wins)
```

Evidence log: `buy` → `Purchased` of the same launch and transaction
(0077 rule, unchanged); `claim` → `Claimed`, `claimRefund` → `Refunded` of
the same launch (hence saleId) and transaction **whose `wallet` argument is
the Intent wallet's address**. One SQL expression serves the lane's
re-projection and the late-report shortcut of `reportIntentBroadcast`.

Because `claim()` / `claimRefund()` have no on-chain deadline, a
transaction the endpoint no longer shows can still be mined after the Intent
was expired; its log then moves the Intent to `confirmed` (the last row).
A late _failed_ transaction leaves it `expired`, which is still true for the
client (the funds did not move).

### 6. Detail and history

- `myPosition` with `claimableTokens`, `claimedTokens`, `refundableUsd1`,
  `refundedUsd1` exists on `GET /v2/launch/{launchId}/holders` (0077); its
  `available` branch already emitted all four from `getPosition` (now pinned
  with non-zero values in a route test). `GET /v2/launches/{launchId}` has
  **no** `myPosition` and none was added (see Open questions).
- `GET /v2/launch/{launchId}/history` gains the optional array
  `settlements`, present only while `source` is `available` (absent in the
  unavailable branch, so those bytes are unchanged). Item:
  `{settlementRecordId, kind: "claimed" | "refunded", walletId, assetId,
amount, cumulativeAmount, transactionHash, logIndex, blockNumber,
blockHash, confirmationState, observedAt}`, newest first, ≤ 500. The
  existing `entitlements` / `refunds` aggregates are unchanged.

### 7. Capability evidence

0083's `evidence` has no per-action executable flag (it is one
`status` / `reasonCode` projection of the adapter). Nothing was added; the
client gates claim / refund exactly as it gates buy, on
`evidence.status == "confirmed"`, and then on the prepare answer.

### 8. Unavailable behaviour

Keys blank or `BSC_WRITES_ENABLED` off: the bare `503` for every kind, as
before. Contract unreadable: `503` + the 0076 reason. No fixture, default,
or cached position stands in for a chain read; no Intent is stored for a
refusal. A launch slot without an RPC leaves reported Intents `submitted`
(0080 unchanged).

## Tests

- `test/launch-claim-refund-intents.test.ts` (23): claim and claimRefund
  prepare (full claim body, decoded `claim(7)` / `claimRefund(7)`, reads are
  exactly `readSaleSnapshot` + `getPosition`); every 409 of both kinds
  (FROZEN / NONE / COMPLETED / paused / not participant / nothing matured /
  claimed all; LIVE / SUCCEEDED / REFUNDED / paused / not participant /
  refunded all); shared refusals (config drift, gas, counterparty,
  unreadable chain, unknown sale); no asset-canary requirement; reverted
  simulation; idempotent replay and cross-kind conflict; malformed bodies;
  bare 503; report + read; a legacy buy body answers exactly the pre-0087
  key set with no `kind`, and `kind: "buy"` replays it byte for byte.
- `test/v2-launch-s92a-routes.test.ts` (7): through Fastify/Ajv/
  fast-json-stringify: both `201`s, `GET` = prepare bytes, report, the eight
  seven-field 409s, five `400`s and the bare `503`, a legacy buy `201`
  without `kind`, history `settlements` (and absent when unavailable),
  holders `myPosition` four fields.
- `test/v2-launch-claim-refund-migration.test.ts` (3): 000044 contract.
- `test/launch-chain-repository.integration.test.ts`: kind round trip and
  schema checks; a `Claimed` log of the Intent's wallet confirms it, another
  wallet's log in that transaction does not; `Refunded` confirms a refund;
  receipts settle a claim and a refund `reverted` and a traceless claim
  `expired`; a late `Claimed` log confirms the expired claim; settlements
  of both kinds, stable IDs on replay, `pending → confirmed`, reorg →
  `reorged` and the Intent back to `submitted`.
- Every pre-existing buy test passes unchanged (only fixture objects gained
  `kind: "buy"` / `settlements: []` to satisfy the widened types, the
  000041 rollback test now steps down over three migrations, the schema
  readiness contract lists `launch_settlement_records`, and the seven
  integration suites that truncate every table now include it).

## Rollback

Revert the commit and run `000044` down: it refuses while any settlement row
or any non-buy Intent exists, then restores the buy-only checks.

## Open questions for the main agent

1. **`myPosition` on the detail route.** The brief placed `myPosition` on
   `GET /v2/launches/{id}`; it lives on `GET /v2/launch/{id}/holders`
   (0077), which already emits the four fields. Adding it to the detail
   would add a wallet-specific `getPosition` to the detail read that 0085
   ruling 3 kept separate. Not done; the client should read holders.
2. **Claim after `COMPLETED`.** 06 §4.1 says `claim` requires `VESTING`;
   once vesting is fully matured the axis becomes `COMPLETED` and a wallet
   that has not claimed everything can no longer claim under that wording.
   The backend follows 06 (`LAUNCH_CLAIM_NOT_OPEN` with
   `entitlementState: COMPLETED`). The contract party should confirm that
   `claim` also works in `COMPLETED`; if so, admit `COMPLETED` here.
3. **Refund gate.** Both `saleState ∈ {FAILED, CANCELLED}` (brief) and
   `entitlementState = REFUNDING` (06) are required. Confirm.
4. **Canary for claim / refund.** Only the counterparty allowlist applies
   and the value is 0 USD. Confirm that claims of a project token not in
   `BSC_WRITE_CANARY_ASSETS` are wanted (the funds flow to the user).
5. **`kind` on buy Intents.** Omitted to keep the buy bytes; the client
   reads a missing `kind` as `buy`. Emitting `kind: "buy"` everywhere is a
   one-line change if strict decoders prefer it.
