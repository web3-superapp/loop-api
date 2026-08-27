# Decision 0017: Spot reconciliation projection isolation

- Status: Accepted
- Date: 2026-08-27

## Context

The shared reconciliation worker leases `provider_operations` before it looks
up the `(domain, operation_kind)` handler. A generic lease, reschedule, or
operator hold changes only the shared operation row. For Spot, that could leave
the owner-facing `spot_intents` or `spot_agent_authorizations` projection at
`unknown` while the shared row was already `leased` or
`operator_required`. The original deferred Spot constraint compared business
states but did not compare reconciliation scheduling states, so this split was
not rejected at commit.

Spot reconciliation also needs richer atomic results than the generic control
plane can persist. A fill must update exact amounts, price, fee identity, the
shared operation, and both append-only histories in one fenced transaction.
The generic completion path cannot provide that guarantee.

## Decision

Generic deadline quarantine, leasing, completion, rescheduling, and operator
holds exclude both `hyperliquid/spot_intent` and
`hyperliquid/spot_agent_authorization`. Those tuples may be recovered only by
their dedicated domain lanes.

PostgreSQL enforces the following projection pairs with deferred constraint
triggers:

| Domain state            | Shared operation state | Reconciliation status |
| ----------------------- | ---------------------- | --------------------- |
| `prepared` or `expired` | `prepared`             | `not_required`        |
| `submitting`            | `submitting`           | `not_required`        |
| `unknown`               | `unknown`              | `pending`             |
| `reconciling`           | `unknown`              | `leased`              |
| `operator_required`     | `unknown`              | `operator_required`   |

Known direct results retain `not_required`; the same business result produced
by fenced reconciliation uses `complete`. Spot intent `accepted`,
`partially_filled`, `filled`, `not_filled`, and `rejected` keep their existing
shared-state mapping. Spot Agent authorization `accepted`, `active`,
`rejected`, and `failed` do the same.

Migration installation takes writer-conflicting locks and rejects any existing
split projection. It never guesses, backfills, or rewrites an operation,
domain row, result, or event.

The Spot intent reconciliation lane uses the existing worker shell and retry
policy through a separate control-plane implementation:

- first lease atomically changes `unknown/pending` to
  `reconciling/leased` and appends both histories;
- an expired lease reclaim advances only the shared fence, lease, attempt
  count, and version while the domain remains `reconciling`;
- reschedule atomically returns to `unknown/pending`;
- operator hold atomically enters
  `operator_required/operator_required`; and
- a resolved authoritative read uses a Spot-specific atomic finalizer. Generic
  completion is unavailable in this lane.

Every write locks `provider_operations` before the Spot projection and checks
the owner, exact tuple, one persisted transport attempt, worker, fence, shared
record version, and database-clock lease expiry. A provider read never receives
a signer reference, nonce, signature, key, or raw provider payload.

The shared and domain record versions are deliberately independent. Lease
reclaim can advance only the shared version, while other valid domain-only
maintenance can advance only the domain version. Finalization therefore checks
both authorities explicitly and never requires version equality.

## Consequences

An accidental generic recovery write for either Spot tuple now fails closed,
and the owner-facing state cannot silently diverge from worker scheduling.
The dedicated Spot lane can reuse the tested reconciliation deadlines,
backoff, attempt budget, and process lifecycle without importing Perp domain
logic or gaining any provider-write capability.

This decision does not enable the Spot worker registration, Hyperliquid
Exchange writes, signing, Mainnet, cancellation, withdrawals, transfers, or
automation. The authoritative reader and terminal finalizer remain separate
default-closed gates and must preserve the evidence rules in Decision 0014.
