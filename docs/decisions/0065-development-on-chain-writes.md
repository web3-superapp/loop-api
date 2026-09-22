# Decision 0065: The Development stack may move real funds, inside a canary it can prove

- Status: Accepted (Development only)
- Date: 2026-09-22
- Scope: `BSC_WRITES_ENABLED` on the Development stack, the canary guards that
  bound it, and the Provider-refusal mapping the first live run exposed.
  Extends Decision 0035; no ruling there is reversed.

## Context

Decision 0035 built the whole funds path behind one switch and then left the
switch off: every prepare, broadcast report, and Provider execute answered
`CAPABILITY_UNAVAILABLE`, and no intent had ever been built from a real
wallet, a real price, and a real chain read. The user authorised (2026-09-22)
turning writes on for the **Development stack only**, with real but small
amounts, so the path can be verified with facts instead of fixtures. Product
red line 8 (BSC Mainnet signing and broadcast stay closed) is relaxed **only**
for this stack and only inside the limits below; production keeps
`BSC_WRITES_ENABLED=false` until its own security decision exists.

An open switch without a bound is not a canary. Decision 0035 already had two
bounds — an asset allowlist and a per-intent USD ceiling — and both are
per-request. Neither limits how much a mistake, or a loop in a client, can
move over a day, and neither says where funds may go. This decision adds the
two missing bounds and states exactly what the rollback is.

## Rulings

| Topic                   | Ruling                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where                   | Development stack only (`api-dev`). Production and any stack whose `NODE_ENV=production` keeps `BSC_WRITES_ENABLED=false`; this decision does not authorise it.                                                                                                                                               |
| Per-intent ceiling      | `BSC_WRITE_CANARY_MAX_USD` (existing). Development value: **5 USD**. Over it is `403 POLICY_BLOCKED` / `CANARY_CEILING_EXCEEDED` with `exposureUsd` and `ceilingUsd`.                                                                                                                                         |
| Rolling daily ceiling   | New `BSC_WRITE_CANARY_DAILY_MAX_USD` (optional; unset = no cumulative bound). Development value: **25 USD**. Over it is `403 POLICY_BLOCKED` / `CANARY_DAILY_CEILING_EXCEEDED` with the same two decimal strings.                                                                                             |
| Counterparty allowlist  | New `BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST` (optional; empty = every counterparty admitted). Applies to a send recipient and to an approve spender; a revoke (`approve(spender, 0)`) is always admitted because it removes exposure. Refusal is `403 POLICY_BLOCKED` / `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`. |
| Asset allowlist         | Unchanged (`BSC_WRITE_CANARY_ASSETS`), still required whenever writes are on.                                                                                                                                                                                                                                 |
| Provider capability 4xx | A Privy 401/403 on `wallets.swap.quote` is the Provider refusing the **app**, not the request. It is `503 CAPABILITY_UNAVAILABLE`, not `422 VALIDATION_FAILED`.                                                                                                                                               |
| Rollback                | `BSC_WRITES_ENABLED=false`. Nothing else has to move: every prepare, report, and execute returns to `CAPABILITY_UNAVAILABLE`, both capabilities report `BSC_WRITES_DISABLED`, and no schema or route changes.                                                                                                 |

### What the daily ceiling counts, and why

The rolling window is 24 hours ending now, measured on `wallet_intents.created_at`
and scoped to **one LOOP account** (every wallet it owns). The sum is the
`policy.valueUsd` sealed into each payload, added as decimal strings in
PostgreSQL `numeric` and returned as text; no JavaScript number touches it.

Only the states in which an intent may already have moved, or may still move,
funds are counted: `awaiting_signature`, `submitted`, `confirmed`, `reverted`,
`unknown`. A `prepared` intent is never signable, a `cancelled` intent was
withdrawn, a `failed` intent proved nothing was sent, and an `expired` intent —
including one superseded by the next preparation on the same wallet — never
reached a signer. Counting those would let a user exhaust the day by opening
and abandoning sheets, which is a denial of the product, not a safety gain.
`reverted` is counted: the chain executed the transaction.

The daily ceiling is an **admission gate at prepare time only**. It is not
sealed into the payload, does not change `bscWriteCanaryV1`, and is not
re-checked at `broadcast-report`: a device that already holds a signable,
digest-bound review must always be able to finish or cancel it. The per-intent
ceiling keeps its existing write-start re-check. The one hole this leaves is
the late broadcast of an intent that expired before it was reported; the
per-intent ceiling still bounds it.

### Order of admission

Unchanged from Decision 0035, with the two new gates inserted where they cost
nothing and refuse earliest:

```text
writes switch → verified chain → signable wallet → asset (shape → native →
canary allowlist) → counterparty allowlist → fresh USD price → per-intent
ceiling → daily ceiling → balance snapshot → pre-execution → fee, gas reserve,
nonce → seal
```

The counterparty allowlist is checked before any Provider or RPC read, so a
refused recipient costs no quota. The daily ceiling is checked after the
per-intent ceiling because it needs the same priced value.

### Configuration is validated, not assumed

`BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST` accepts a comma-separated list of
0x-prefixed 20-byte addresses, normalised to lowercase; anything else refuses
to boot. `BSC_WRITE_CANARY_DAILY_MAX_USD` is a positive decimal with at most 6
fraction digits, like the per-intent ceiling; `0` refuses to boot rather than
silently meaning "unlimited". An absent or empty value of either is the
documented "no bound" case, never a parse failure.

## What the first live run against the Development database showed

Run in process (`buildApp`, real `loop_api_dev`, real RPC, real Provider;
only the Privy access-token verifier was stubbed to the tester's own account,
and nothing was signed or broadcast):

- `POST /v2/wallet-intents/send/preflight` → `200`, checksummed recipient,
  `isFirstRecipient: true`, screening `unavailable`.
- `POST /v2/wallet-intents/send` (USDT 0.5) → `409 INSUFFICIENT_BALANCE`. The
  wallet holds 2.99 USDT and **0 BNB**; the ERC-20 `eth_call` returns true and
  `eth_estimateGas` returns 52 001 gas, so the refusal is the gas-reserve
  check, not the token balance. The same request at 0.001 USDT is refused
  identically, which is what proves it is gas.
- Ceiling and allowlist refusals are observable and distinguishable:
  `CANARY_CEILING_EXCEEDED` (`exposureUsd: "5.9976"`, `ceilingUsd: "5"`) and
  `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`.
- `POST /v2/swap/quote` → the Provider answered `403 {"error":"Swaps are not
enabled for this app"}`. Under Decision 0035 that became `422
VALIDATION_FAILED`, which tells the user their input was wrong when in fact
  LOOP's app has no Swap capability. It is now `503 CAPABILITY_UNAVAILABLE`.
- `sendApprovals` and `privySwap` report `available` once `eth_chainId == 56`
  is observed. `privySwap.available` remains a statement about LOOP's
  configuration, not about the Provider: the Provider's refusal is only
  knowable by calling, and `evidence` stays `pending` regardless.

## Open items (unchanged or newly evidenced)

- **Gas.** No Development wallet holds BNB, so no send intent can currently
  reach `awaiting_signature`. An ERC-20 send only needs the maximum fee
  (62 401 gas after headroom at the observed 0.05 gwei is ~0.00001 BNB); a
  native BNB send additionally needs `WALLET_GAS_RESERVE_BNB` (0.005) to
  remain. Funding is the user's call.
- **Privy Swap is disabled for the app.** Quote, prepare, and execute cannot
  run until Swaps are enabled for the Privy app. This is a dashboard fact, not
  a code change.
- **RPC receipts.** Of the four configured endpoints, only
  `bsc-dataseed.bnbchain.org` served `eth_getTransactionReceipt`; publicnode
  answers 403 (archive token) and the two commercial endpoints are out of
  quota. The reconciliation lane needs receipts, so the healthy endpoint must
  stay first in `BSC_RPC_URLS`.
- Everything Decision 0035 left open (device evidence, Swap simulation, GoPlus
  screening, `LOOP_SWAP_FEE_BPS`, `swapPolicyV1` confirmation) is unchanged.
