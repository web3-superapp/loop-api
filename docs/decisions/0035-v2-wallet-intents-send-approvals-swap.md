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

| Topic          | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write switch   | `BSC_WRITES_ENABLED` (default false) gates every prepare, report, and execute. Enabling it requires `BSC_WRITE_CANARY_ASSETS` (canonical asset ID allowlist) and `BSC_WRITE_CANARY_MAX_USD` (per-intent ceiling, default 20). Over the ceiling is `POLICY_BLOCKED`. Mainnet beyond the canary needs its own security decision.                                                                                                                    |
| Unified intent | One `wallet_intents` table for send/approve/revoke/swap with a canonical payload, a public review, `review_sha256`, `facts_observed_at`, `expires_at`, and nine states. `provider_operations` journals the single attempt. Any fact change expires the older intent. Clients hold only an opaque `intentId`.                                                                                                                                      |
| Send           | Server builds the exact unsigned transaction (native or ERC-20 `transfer`), pre-executes with `eth_call` + `estimateGas`, and binds chain 56, to, data, value, gas, fee fields, and the pending nonce. The device broadcasts via Privy `eth_sendTransaction`; the client reports the hash; the server reconciles the receipt to 15 confirmations.                                                                                                 |
| Approvals      | Same path with `approve(spender, amount)`. Exact allowance by default; unlimited needs the top-level `acknowledgeUnlimited: true` second confirmation and is priced against the ceiling by its actual exposure `min(allowance, balance)` at the snapshot block; revoke is `approve(spender, 0)`. The approval guard shows the decoded call.                                                                                                       |
| Inventory      | The transfer lane also indexes `Approval` events; the approvals page shows spender, observed block, and the current `allowance()` read. GoPlus approval facts stay unavailable without a key.                                                                                                                                                                                                                                                     |
| Swap           | Server `wallets.swap.quote` with `slippage_bps`; LOOP quote expiry 30 s; the intent binds the quote snapshot; execute is one server `wallets.swap.execute` with `privy-idempotency-key`, `privy-request-expiry`, and the user's authorization signature; status is polled; unknown locks. `privySwap.evidence` stays pending.                                                                                                                     |
| Simulation     | No Provider simulator. `eth_call` + `estimateGas` over the exact payload is `simulation: {status, source: rpc_call, observedAt}`; reverted or unavailable disables the sheet. A Swap has no exact payload to pre-execute, so it is `{status: unavailable, source: provider_quote, reasonCode: SWAP_SIMULATION_PROVIDER_PENDING}` and stays `prepared` until a Provider-side simulation exists (review ruling). No asset-change analysis or score. |
| Slippage       | `swapPolicyV1` (awaiting product confirmation): default 50 bps, user maximum 300 bps; price impact ≥ 5 % blocks, 1–5 % needs a second confirmation.                                                                                                                                                                                                                                                                                               |
| Platform fee   | Dev sends no `fee_configuration`; `LOOP_SWAP_FEE_BPS` is a slot pending decision.                                                                                                                                                                                                                                                                                                                                                                 |
| Recipient      | Normalised + checksummed; first-recipient notice from own history; GoPlus address screening unavailable without a key (strong notice, no block); contract recipient warned.                                                                                                                                                                                                                                                                       |
| Balance / gas  | Spendable from S5a; gas-reserve check; `INSUFFICIENT_BALANCE`; `CHAIN_MISMATCH`.                                                                                                                                                                                                                                                                                                                                                                  |
| tx-result      | `GET /v2/wallet-intents/{intentId}` is the one status surface: pending / confirmed / reverted / failed / unknown.                                                                                                                                                                                                                                                                                                                                 |

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
  not be established, and of every Swap intent until a Provider simulation
  exists. It is visible (the sheet shows why) but never signable:
  `signing.allowed = false`, and a broadcast report or execute is
  `SIMULATION_FAILED`.
- `awaiting_signature` is the only state in which `signing.allowed` is true.
- A send/approve/revoke intent moves to `submitted` through
  `POST …/broadcast-report`; a swap intent through `POST …/execute`.
- `unknown` is reached when the Provider result is ambiguous or when a
  reported hash never appears within the poll budget. It is reconciled, never
  replayed; after the budget it is held and re-polled hourly for an operator.
- Expiry is projected lazily on every read (`state: expired`,
  `INTENT_EXPIRED`) and persisted by the lane or by the next write.
- **Late broadcast report** (review ruling): a device may broadcast right
  before the intent expires, is superseded, or is cancelled elsewhere. When
  the reported hash is already observed on chain and matches the payload,
  an `expired` (`INTENT_EXPIRED`/`INTENT_SUPERSEDED`) or `cancelled` intent
  moves to `submitted` with a `late_broadcast_report` event; an unobserved
  hash stays `DATA_STALE`. The client must therefore report or cancel before
  preparing a new intent on the same wallet.
- Every device-broadcast intent carries `payload_verified`; the lane
  re-verifies the transaction against the payload before any receipt can
  finalise it, regardless of what the report already compared.

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
that cannot be priced with a **fresh** Provider price (`requireFresh`) is not
admitted (`CAPABILITY_UNAVAILABLE`, retryable) rather than assumed small — a
stale price is refused. `policy.exposureBasis` records what was priced:
`amount` (send, swap), `balance_at_prepare` (approve: `min(allowance,
balance)` at `exposureBlockNumber`), or `none` (revoke). Every write-start (`broadcast-report`, `execute`)
re-checks the switch, expiry, the policy `configVersion`, and the ceiling.

### Broadcast report verification

A reported hash that the endpoint already knows must match the payload
exactly, otherwise the report is `VALIDATION_FAILED` and a
`broadcast_report_rejected` event is written. A hash the endpoint has not
seen yet is accepted as `submitted` with `TX_PENDING_VERIFICATION`; the lane
re-checks the payload when the transaction appears and fails the intent on a
mismatch. A hash that never appears within roughly one hour of polls locks the
intent as `unknown` (`TX_NOT_OBSERVED`). When write admission fails at report
time the refusal is recorded (`broadcast_report_refused`) and no RPC or
Provider call is made. The lane handles each intent in its own try/catch:
a failed read is a `reconciliation_read_failed` event (reason
`RPC_RECEIPT_UNAVAILABLE` for an endpoint that refuses
`eth_getTransactionReceipt`, e.g. publicnode's 403) and never stops the
batch; a receipt that disappears after being stored is a `receipt_lost`
event and the intent waits for inclusion again.

### Swap specifics

- The quote is a server-side Privy call bound to the caller and wallet and
  stored in `swap_quotes` (migration `000022`) with its 30 s expiry. A prepare
  consumes it exactly once (`consumed_by_intent_id`, set before the intent
  row exists); a second prepare, an expired quote, or a foreign owner is
  `QUOTE_EXPIRED`.
- Price impact is `1 − estimatedOutputValueUsd ÷ inputValueUsd` from the
  market facts of both assets; without both prices it is `unavailable` and the
  swap is blocked, because the hard limit cannot be enforced on an unknown
  number.
- There is no exact payload to pre-execute for a swap: Privy builds the
  transaction at execute time. The intent carries
  `simulation: {status: unavailable, source: provider_quote, reasonCode:
SWAP_SIMULATION_PROVIDER_PENDING}`, stays `prepared`, and `execute` answers
  `SIMULATION_FAILED` (review ruling). The execute path below is implemented
  and unit-tested but unreachable through the API until a Provider-side
  simulation is connected.
- `authorizationPayload.url` must contain the Privy wallet ID: Privy's
  authorization signature covers the exact URL of the Wallet API request, so
  the payload cannot be built without it. The generated OpenAPI keeps the
  URL as a free string for that reason (`openapi.test` exception).
- Execute checks the Privy app ID before anything else, then is fenced twice:
  the intent moves `awaiting_signature → submitted` and the provider
  operation `prepared → submitting` before any bytes leave the process. A
  crash in between leaves an intent with no action ID that the lane locks as
  `unknown`; a second call is `SUBMISSION_UNKNOWN`. A Provider failure that
  proves nothing was sent (`unavailable`) is `failed` with
  `PRIVY_SWAP_NOT_SENT` and the user may prepare again; a definitive 4xx is
  `failed` (`PRIVY_SWAP_REJECTED`); anything ambiguous is `unknown`.
- Swap reconciliation applies the same poll budget and hourly hold as the
  device-broadcast path.

### Approvals inventory

The `erc20_transfer` lane reads `Approval` logs for the same registry
addresses and block range as `Transfer` logs and commits them in the same
transaction under the same checkpoint; a reorg rewind marks both tables. The
inventory lists the latest non-removed log per (asset, spender), re-reads
`allowance()` through Multicall3 at one block, records the observation, and
omits spenders whose current allowance is zero; an unreadable allowance is
reported as `unavailable`, never as zero. An allowance above 2^255 (or above
the token's total supply when known) is classified `isUnlimited` while its
raw value is kept.

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
(same lane as `indexed_transfers`), and `approval_observations`. Migration
`000022_v2_swap_quotes` adds `swap_quotes` and
`wallet_intents.payload_verified`. Amounts are `numeric(78,0)` or canonical
strings inside jsonb; nothing is a JavaScript number. A second LOOP account
claiming an already-mapped Privy wallet ID is `RESOURCE_CONFLICT` on the
wallet inventory routes, never an internal error.

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
- **Swap simulation**: no Provider-side simulation exists; every Swap intent
  is `prepared` and cannot be executed until one is connected.
- **Quote authorization**: Privy may also require an authorization signature
  on `wallets.swap.quote` for user-owned wallets; the quote route currently
  sends none and answers `VALIDATION_FAILED` on a definitive Provider 4xx.
- **RPC endpoint**: the reconciliation lane needs `eth_getTransactionReceipt`;
  publicnode answers 403 for it (S5 Go/No-Go item extended).
- **Product confirmation**: `swapPolicyV1` slippage and impact thresholds;
  `LOOP_SWAP_FEE_BPS`.
- **GoPlus**: address screening and approval facts stay unavailable.
- **Canary funds and test wallet**: user-provided; no broadcast was performed
  locally.
- **Multicall3 and the RPC provider** remain on the S5 Go/No-Go list.
