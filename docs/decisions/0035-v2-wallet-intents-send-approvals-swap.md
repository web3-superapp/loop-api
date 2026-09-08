# Decision 0035: V2 wallet intents — Send, approvals, and Privy Swap

- Status: Accepted (backend); external Go/No-Go items open
- Date: 2026-09-08
- Scope: S6 backend (D15 Privy Swap + D16 Send/Approvals/unified result). The
  main-agent rulings of 2026-09-08 in `LOOP/docs/modules/S6-money-actions.md`
  are adopted below. The user may overturn any row.

## Context

S5 gave the backend a verified asset identity, a wallet inventory, snapshot
balances, an ERC-20 transfer index, and market prices with provenance. S6 is
the first step that moves funds. The product red lines are unchanged: every
funds action enters one signing exit, what is shown is what is signed, any
fact change invalidates the intent, a Provider write happens at most once, an
ambiguous result is `unknown` and never replayed, and everything fails closed
without a switch, credential, price, or chain verification.

Two signing shapes exist because Privy's Flutter SDK exposes different
primitives for the two paths. An embedded wallet can broadcast a
server-built transaction through `eth_sendTransaction` on the device; a
Privy Swap is a server-side Wallet API call whose request the user
authorizes with a device-generated authorization signature. The backend must
therefore hold two immutable payload shapes under one intent model.

## Rulings adopted (main agent, 2026-09-08)

| Topic          | Ruling                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write switch   | `BSC_WRITES_ENABLED` (default false) gates every prepare, report, and execute. Enabling it requires `BSC_WRITE_CANARY_ASSETS` (canonical asset ID allowlist) and `BSC_WRITE_CANARY_MAX_USD` (per-intent ceiling, default 20). Over the ceiling is `POLICY_BLOCKED`. Mainnet beyond the canary needs its own security decision.                    |
| Unified intent | One `wallet_intents` table for send/approve/revoke/swap with a canonical payload, a public review, `review_sha256`, `facts_observed_at`, `expires_at`, and nine states. `provider_operations` journals the single attempt. Any fact change expires the older intent. Clients hold only an opaque `intentId`.                                      |
| Send           | Server builds the exact unsigned transaction (native or ERC-20 `transfer`), pre-executes with `eth_call` + `estimateGas`, and binds chain 56, to, data, value, gas, fee fields, and the pending nonce. The device broadcasts via Privy `eth_sendTransaction`; the client reports the hash; the server reconciles the receipt to 15 confirmations. |
| Approvals      | Same path with `approve(spender, amount)`. Exact allowance by default; unlimited needs a separate acknowledged confirmation; revoke is `approve(spender, 0)`. The approval guard shows the decoded call.                                                                                                                                          |
| Inventory      | The transfer lane also indexes `Approval` events; the approvals page shows spender, observed block, and the current `allowance()` read. GoPlus approval facts stay unavailable without a key.                                                                                                                                                     |
| Swap           | Server `wallets.swap.quote` with `slippage_bps`; LOOP quote expiry 30 s; the intent binds the quote snapshot; execute is one server `wallets.swap.execute` with `privy-idempotency-key`, `privy-request-expiry`, and the user's authorization signature; status is polled; unknown locks. `privySwap.evidence` stays pending.                     |
| Simulation     | No Provider simulator. `eth_call` + `estimateGas` over the exact payload is `simulation: {status, source: rpc_call, observedAt}`; reverted or unavailable disables the sheet. No asset-change analysis or score.                                                                                                                                  |
| Slippage       | `swapPolicyV1` (awaiting product confirmation): default 50 bps, user maximum 300 bps; price impact ≥ 5 % blocks, 1–5 % needs a second confirmation.                                                                                                                                                                                               |
| Platform fee   | Dev sends no `fee_configuration`; `LOOP_SWAP_FEE_BPS` is a slot pending decision.                                                                                                                                                                                                                                                                 |
| Recipient      | Normalised + checksummed; first-recipient notice from own history; GoPlus address screening unavailable without a key (strong notice, no block); contract recipient warned.                                                                                                                                                                       |
| Balance / gas  | Spendable from S5a; gas-reserve check; `INSUFFICIENT_BALANCE`; `CHAIN_MISMATCH`.                                                                                                                                                                                                                                                                  |
| tx-result      | `GET /v2/wallet-intents/{intentId}` is the one status surface: pending / confirmed / reverted / failed / unknown.                                                                                                                                                                                                                                 |

## Implementation rulings

### One source object, one digest

`sealIntent(source)` produces the canonical payload (the source object
canonicalised), the public review (a projection of that payload), and
`reviewSha256 = sha256(canonicalJson(canonicalPayload))`. The review never
carries a field the payload does not; the digest covers every fact the
prepare relied on: asset, amount, recipient or spender facts, the unsigned
transaction, fee data and its observation time, the balance snapshot block,
the simulation result, the canary policy (`configVersion`, ceiling, USD value,
price source and fetch time), the quote snapshot, and `expiresAt`. The
PostgreSQL trigger `wallet_intents_payload_immutable` refuses any update to
those columns; only state, hash, action ID, reason, receipt, and
reconciliation columns ever change, and every change appends one
`wallet_intent_events` row (append-only by trigger) in the same transaction.

### State machine

```text
prepare ──simulation passed──▶ awaiting_signature ──▶ submitted ──▶ confirmed
   │                                   │                  │    └──▶ reverted
   └──reverted/unavailable──▶ prepared │                  ├──▶ failed
                                       │                  └──▶ unknown ──(lane)──▶ confirmed|reverted|failed
   open (prepared|awaiting_signature) ──cancel──▶ cancelled
   open ──expires_at passed / newer intent on the same wallet / policy version changed──▶ expired
```

- `prepared` is the state of an intent whose pre-execution reverted or could
  not be established. It is visible (the sheet shows why) but never signable:
  `signing.allowed = false`, and a broadcast report is `SIMULATION_FAILED`.
- `awaiting_signature` is the only state in which `signing.allowed` is true.
- A send/approve/revoke intent moves to `submitted` through
  `POST …/broadcast-report`; a swap intent through `POST …/execute`.
- `unknown` is reached when the Provider result is ambiguous or when a
  reported hash never appears within the poll budget. It is reconciled, never
  replayed; after the budget it is held and re-polled hourly for an operator.
- Expiry is projected lazily on every read (`state: expired`,
  `INTENT_EXPIRED`) and persisted by the lane or by the next write.

### Two signing modes

| Mode                            | Kinds                 | What the device signs                                                                                                                  | What the backend does                                                                                                                                                                                                   |
| ------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_eth_send_transaction`   | send, approve, revoke | `unsignedTransaction` verbatim (chainId 56, from, to, data, value, gas, nonce, type, fee fields as 0x quantities)                      | Journals the attempt on the intent's provider operation, stores the reported hash, compares `eth_getTransactionByHash` (from/to/input/value/nonce/chainId) with the payload, reconciles the receipt to 15 confirmations |
| `privy_authorization_signature` | swap                  | `authorizationPayload` (`{version: 1, method: POST, url, body, headers: {privy-app-id, privy-idempotency-key, privy-request-expiry}}`) | Forwards the signature, `privy-idempotency-key = intentId`, and `privy-request-expiry = expiresAt` to `wallets.swap.execute` once; maps `WalletActionStatus` and step status to the intent; polls until terminal        |

The client must compare `reviewSha256` with the digest bound to the review it
renders before invoking either signer, and must never alter a field of the
signed object.

### Admission order

`writes switch → live chain verification → signable wallet (embedded with a
Privy wallet ID) → canary asset → USD ceiling → balance snapshot →
pre-execution → fee and pending nonce → seal`. A missing dependency is
`CAPABILITY_UNAVAILABLE`; a policy refusal is `POLICY_BLOCKED`; an amount
that cannot be priced is not admitted (`CAPABILITY_UNAVAILABLE`, retryable)
rather than assumed small. Every write-start (`broadcast-report`, `execute`)
re-checks the switch, expiry, the policy `configVersion`, and the ceiling.

### Broadcast report verification

A reported hash that the endpoint already knows must match the payload
exactly, otherwise the report is `VALIDATION_FAILED` and a
`broadcast_report_rejected` event is written. A hash the endpoint has not
seen yet is accepted as `submitted` with `TX_PENDING_VERIFICATION`; the lane
re-checks the payload when the transaction appears and fails the intent on a
mismatch. A hash that never appears within roughly one hour of polls locks the
intent as `unknown` (`TX_NOT_OBSERVED`).

### Swap specifics

- The quote is a server-side Privy call bound to the caller and wallet and
  held in-process for 30 s (`SwapQuoteStore`); a restarted or second replica
  simply answers `QUOTE_EXPIRED` and the client re-quotes. This is a Dev
  limitation recorded as an open item, not a durable quote store.
- Price impact is `1 − estimatedOutputValueUsd ÷ inputValueUsd` from the
  market facts of both assets; without both prices it is `unavailable` and the
  swap is blocked, because the hard limit cannot be enforced on an unknown
  number.
- There is no exact payload to pre-execute for a swap: Privy builds the
  transaction at execute time. The intent carries
  `simulation: {status: passed, source: provider_quote}` — the Provider quote
  is the pre-execution evidence and is labelled as such. Whether this
  satisfies the "reverted/unavailable disables the sheet" rule for Swap is a
  question for the main agent (see open items).
- Execute is fenced twice: the intent moves `awaiting_signature → submitted`
  and the provider operation `prepared → submitting` before any bytes leave
  the process. A crash in between leaves an intent with no action ID that the
  lane locks as `unknown`; a second call is `SUBMISSION_UNKNOWN`.

### Approvals inventory

The `erc20_transfer` lane reads `Approval` logs for the same registry
addresses and block range as `Transfer` logs and commits them in the same
transaction under the same checkpoint; a reorg rewind marks both tables. The
inventory lists the latest non-removed log per (asset, spender), re-reads
`allowance()` through Multicall3 at one block, records the observation, and
omits spenders whose current allowance is zero; an unreadable allowance is
reported as `unavailable`, never as zero.

### Capabilities

`sendApprovals` and `privySwap` are `available` only when the module is
enabled, the intent runtime is composed, an RPC endpoint is configured,
`BSC_WRITES_ENABLED` is true, and `eth_chainId` was observed to equal 56;
`privySwap` additionally needs Privy credentials and always carries
`evidence: {status: pending, reasonCode: PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING}`.
The mobile Swap confirm button is gated on that evidence.

### Reconciliation lane

`wallet-intent-reconcile` runs in the standalone worker behind
`WALLET_INTENT_RECONCILE_ENABLED` (default off). Each tick expires elapsed
open intents, leases up to ten `submitted`/`unknown` intents by pushing
`reconcile_after` forward, reads receipts over RPC for device-broadcast
intents, and polls `wallets.actions.get` for swap intents. It never signs,
broadcasts, or replays.

## Persistence

Migration `000021_v2_wallet_intents` adds `wallet_intents` (payload columns
frozen by trigger), `wallet_intent_events` (append-only), `indexed_approvals`
(same lane as `indexed_transfers`), and `approval_observations`. Amounts are
`numeric(78,0)` or canonical strings inside jsonb; nothing is a JavaScript
number.

## Rollback

Set `BSC_WRITES_ENABLED=false` (every write is `CAPABILITY_UNAVAILABLE` and
both capabilities report `BSC_WRITES_DISABLED`), disable `swap` and
`sendApprovals` in `V2_MODULES_ENABLED` (routes 404, capabilities deferred),
and leave `WALLET_INTENT_RECONCILE_ENABLED` off. The migration's `down` drops
the four tables and their triggers; no earlier table is touched.

## Go/No-Go and open items

- **Privy BSC Swap device evidence**: quote availability on a real embedded
  wallet, `wallets.swap.execute` with a user authorization signature, and the
  Flutter `generateAuthorizationSignature` handoff. The `authorizationPayload`
  shape is the backend's best reading of Privy's canonical request; byte-exact
  conformance is unverified.
- **Swap simulation source**: `provider_quote` instead of `rpc_call` (see
  above) needs a main-agent ruling.
- **Quote store**: in-process, single replica.
- **Product confirmation**: `swapPolicyV1` slippage and impact thresholds;
  `LOOP_SWAP_FEE_BPS`.
- **GoPlus**: address screening and approval facts stay unavailable.
- **Canary funds and test wallet**: user-provided; no broadcast was performed
  locally.
- **Multicall3 and the RPC provider** remain on the S5 Go/No-Go list.
