# Decision 0013: Testnet Perp order authoritative reconciliation

- Status: Accepted
- Date: 2026-08-25

## Context

Decision 0012 made the generic reconciliation loop independently runnable but
left its production reader registry empty. A Perp submission whose transport
outcome is unknown therefore remains safely quarantined, but the worker cannot
yet use Hyperliquid Info evidence to resolve it.

The persisted Perp contract gives every `order` item a unique server-generated
cloid and retains its immutable reviewed coin, side, limit price, original
size, reduce-only flag, order type, and time-in-force. Hyperliquid Testnet's
read-only `orderStatus` endpoint accepts that cloid and can return the provider
order and its status. The supporting open-order, fill, and clearinghouse reads
can detect contradictory or malformed evidence, but absence from a bounded
response is not proof that a write was never submitted.

The other approved Perp action shapes do not all have equivalent evidence.
`update_isolated_margin` persists an incremental delta without a pre-submit
baseline or an expected post-state, so current account state cannot attribute
the change to this attempt. Batch, modify, cancel, and leverage reconciliation
also require separate action-specific contracts and conformance evidence.

Official evidence:

- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits>

## Decision

- Add a default-off worker capability selected only by
  `HYPERLIQUID_RECONCILIATION_READS_ENABLED=true`. Enabling it requires an
  independent server-only quota HMAC secret. It does not inherit the API
  process's `HYPERLIQUID_PRIVATE_READS_ENABLED` switch. API and worker replicas
  behind one egress must use the same `HYPERLIQUID_INFO_QUOTA_HMAC_SECRET`,
  policy version, capacity, and PostgreSQL control plane so their global weight
  cannot split into independent buckets.
- The adapter is compiled to
  `https://api.hyperliquid-testnet.xyz/info`. It supports only read-only Info
  calls and contains no signer, private key, Exchange action, configurable
  provider URL, replay, WebSocket, or Mainnet path.
- This first slice resolves only intents whose canonical action is a Core,
  non-trigger `order` with `order_type=limit`. Market orders lack the reviewed
  final limit price and time-in-force in the current reconciliation subject, so
  they are also placed in `operator_required`. `modify`, `batch_modify`,
  `cancel`, `update_leverage`, and `update_isolated_margin` are likewise held
  without a provider call. Supporting them requires a later decision and
  action-specific tests.
- The authoritative identity is the persisted generated cloid. Numeric OID
  requests are not accepted because JavaScript's native JSON serializer cannot
  prove exact unsigned 64-bit request values.
- One reconciliation attempt reserves a conservative global quota cost of 144
  and obtains four evidence classes: `orderStatus` by cloid,
  `frontendOpenOrders`, bounded `userFillsByTime`, and `clearinghouseState`.
  Every real Info request receives a new UUID. Provider reads happen before
  the database finalization transaction. The complete fill window is capped at
  seven days from the committed attempt; an older attempt is placed in
  `operator_required` before quota reservation or any provider call.
- A returned order must exactly match the immutable reviewed cloid, coin, side,
  limit price, original size, reduce-only flag, order type, and time-in-force.
  Open-order and fill evidence must agree with that identity; a buy fill may
  not exceed the reviewed limit and a sell fill may not fall below it. Unknown
  fields, malformed or truncated evidence, conflicting snapshots, `unknownOid`,
  an unknown status, or an excluded Spot/trigger/vault status never becomes a
  fabricated success, rejection, or proof of non-submission.
- For an `open` status, `orderStatus` must retain the reviewed original size;
  current remaining size comes from the sole matching `frontendOpenOrders`
  row, and its exact sum with matching fills must equal the original size.
  Rejected evidence must have no open row or fill and must retain the original
  size. Statuses tied to ALO, IOC, market, or reduce-only semantics must also
  match the reviewed time-in-force, limit-order type, and reduce-only flag.
- Exact provider `open` maps to domain `accepted`; exact `open` with a positive
  matching fill sum maps to domain `partial`. Both map the generic operation to
  `accepted`. Exact `filled` maps to domain `filled` and generic `succeeded`.
  The Core order cancellation allowlist maps to domain `cancelled` and generic
  `succeeded`; the Core order rejection allowlist maps to domain and generic
  `rejected`. The persisted provider OID remains a lossless decimal string.
  Filled size is an exact decimal sum; average fill price may remain absent
  until an approved decimal division policy exists.
- A resolved observation is finalized in one PostgreSQL transaction. It locks
  the generic provider operation first, then the Perp intent and ordered items;
  validates owner, domain, operation kind, action, account, immutable identities,
  worker, fence, record versions, and an unexpired database-wall-clock lease;
  then updates every item, the aggregate intent, the generic operation, and
  both append-only audit streams atomically. Any mismatch rolls the entire
  result back. A stale lease is discarded and is never followed by a retry,
  hold, or second completion write from the old worker.
- The generic registry distinguishes its existing control-plane completion
  mode from reviewed atomic-domain handlers. A successful atomic-domain handler
  is the sole completion writer; the generic service must not complete the same
  operation a second time.
- Errors, logs, audits, and persisted results remain sanitized. Raw provider
  requests or responses, wallet addresses, owner identifiers, secrets, and
  private keys are not log fields or generic result payloads.

## Consequences

The standalone worker can safely resolve an unknown Testnet Core limit-order
submission when strict positive provider evidence exists, without submitting or
replaying any provider write. Default configuration continues to make no
Hyperliquid request, and unresolved or unsupported evidence remains quarantined
for an operator.

This does not enable order placement, signing, cancellation, modification,
leverage or margin mutation, automated trading, withdrawals, Mainnet, or a
deployment. Nonempty Testnet-account conformance, shared-egress behavior, and
deployed worker evidence remain unverified. `update_isolated_margin` will need
an append-only schema decision that persists a sanitized immutable baseline or
expected post-state before automatic reconciliation can be considered.
