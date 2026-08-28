# Decision 0020: Spot write-start admission and Hyperliquid freeze boundary

- Status: Accepted
- Date: 2026-08-28

## Context

Decision 0019 selected offline-conformant Testnet Spot IOC signer and Exchange
writer adapters without composing them into the runtime. The existing submit
coordinator performed a fresh preflight before opening the durable attempt, but
the balance, fee, policy, wallet, and Agent facts could change while the remote
signature was being produced. A failed signature or a denied final check also
left the journal in `submitting` until deadline quarantine even though LOOP
could prove that its Exchange writer had never been called.

This distinction is security-critical. Before writer invocation, LOOP can
prove no provider order was sent. At or after invocation, a synchronous throw,
abort, timeout, non-2xx response, malformed response, or process failure cannot
prove whether bytes reached Hyperliquid.

The product may change after this bounded backend slice. Further Hyperliquid
scope must therefore stay frozen instead of turning this safety primitive into
mobile, Mainnet, Perp, transfer, or additional order work by implication.

## Decision

### Final write-start boundary

The only allowed coordinator order is:

`preflight -> durable journal/nonce -> sign -> final read-only guard -> writer -> unknown/reconciliation`

The final guard receives only the current Privy subject, immutable review
subject, expected intent version, and a minimal attempt binding containing the
intent ID, Testnet network, transport-attempt ID, operation version, attempt
deadline, and expected Agent address. It does not receive the signature,
canonical action, nonce, signer custody reference, or Exchange transport.

An allow result must be a strict, exact permit bound to the owner, intent,
Testnet network, both record versions, transport attempt, Agent identity and
address, and review digest. Its lease is at most one second, cannot outlive the
persisted attempt deadline, and cannot outlive one second from the coordinator's
current clock even when the guard clock is slightly ahead. The coordinator
rechecks the permit immediately before writer invocation. The writer also
checks the canonical permit expiry before `fetch`.

The guard port and permit parser are implemented and behavior-tested, but a
production guard implementation and runtime composition remain unavailable.
An injected fake allow decision is test evidence only.

### Proven-not-sent terminal state

If the durable attempt exists but signing cannot complete, the final guard
denies or returns malformed evidence, or the accepted permit expires before
writer invocation, the coordinator calls a dedicated coordinator-only
repository capability. In one PostgreSQL transaction it changes:

- `provider_operations`: `submitting/not_required` to
  `rejected/not_required`, version 1 to 2;
- `spot_intents`: `submitting` to `rejected`, version 1 to 2; and
- both append-only histories with one sanitized reason; the generic audit
  history also retains the original transport-attempt binding.

The public `rejected` result in this path means **LOOP proved its Exchange
writer was not invoked**. It is not a Hyperliquid rejection. The nonce and
attempt remain consumed, no order/fill/fee identifiers are stored, no
reconciliation work is scheduled, and exact recovery replay is idempotent.

If that cleanup transaction fails or races deadline quarantine, the request
fails closed and the attempt is never signed or sent again. The existing
deadline quarantine may conservatively move it to `unknown` for read-only
reconciliation.

Once writer invocation starts, this capability is forbidden. Every writer
resolution becomes `submission_response_unclassified`; every writer rejection
becomes `submission_transport_ambiguous`. Both remain `unknown` with pending
authoritative reconciliation and no write retry.

No database migration or public OpenAPI change is required. Existing state and
projection constraints already allow an attempted Spot operation to finish as
`rejected/not_required`.

### Freeze boundary

After this safety slice is verified and pushed, Hyperliquid product development
is frozen pending an explicit product-scope decision. The freeze includes
runtime composition, mobile trading integration, additional Spot order types,
Perp, transfers, withdrawals, bridges, Mainnet, and automated trading.

The freeze does not convert missing external evidence into success. A real
Privy Agent signer, user-signed `approveAgent`, production final guard, healthy
worker readiness, reviewed settlement-bound reconciliation, funded Testnet
account, and credentialed one-attempt canary remain unverified and must be
reported as such if the scope is resumed.

## Consequences

The repository now distinguishes a durable attempt that LOOP can prove was not
sent from any attempt whose transport outcome may be ambiguous. This reduces
unnecessary reconciliation while preserving the no-second-write rule.

The main Fastify runtime remains default-unavailable for Spot mutation. This
decision is not provider integration evidence and does not claim that a Privy
signature, Hyperliquid Exchange write, Testnet fill, or wallet refresh occurred.
