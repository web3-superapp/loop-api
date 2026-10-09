# Decision 0022: Bounded issuance-quota retention

- Status: Accepted
- Date: 2026-08-29

## Context

The shared `issuance_rate_records` table persists atomic Stream user/IP and
Hyperliquid provider-global quota windows. Subjects are server-HMAC values, not
raw LOOP user IDs or IP addresses, but every new subject/window combination
creates another row. The reservation path intentionally never mutates an older
window, and no retention job currently removes expired rows. Sustained use
would therefore grow this operational table without bound.

Decision 0004 requires a retention or partition policy before sustained
external Stream deployment. These counters are enforcement state, not the
append-only business audit trail. Keeping them indefinitely adds privacy and
storage cost without improving current-window enforcement.

## Decision

- Retain every quota row for seven complete days after its own window ends.
  Window end is `window_started_at + window_duration_seconds`, evaluated with
  the PostgreSQL wall clock. The retention duration is a compiled policy and
  cannot be shortened through environment or request input.
- Add a `window_started_at` index so expired-window discovery does not require
  the capability-first primary-key order.
- Delete at most 1,000 rows per maintenance call. Candidate rows are ordered
  deterministically, locked with `FOR UPDATE SKIP LOCKED`, and deleted by their
  complete primary key in the same statement. Multiple worker replicas may run
  safely without waiting on or deleting the same batch.
- The repository accepts a fresh request UUID, validates the fixed retention
  and bounded limit, and returns only a deleted-row count. It never returns or
  logs subject HMACs, capability rows, credentials, or provider data.
- The standalone worker owns this database-only maintenance loop. One run makes
  at most ten batch calls, stops early after the first partial batch, and then
  waits one minute. It coalesces concurrent one-shot runs, observes process
  cancellation between calls, and uses bounded exponential backoff with a fixed
  sanitized reason code after database failures.
- Maintenance is enabled by default. An explicit worker-only switch may pause
  it for operator database maintenance; that switch does not change the
  retention policy or enable any provider capability.
- No migration or maintenance query updates or deletes `audit_events`, product
  records, idempotency bindings, provider operations, wallet bindings, alerts,
  or Stream-owned state.

## Consequences

Quota enforcement remains atomic because only windows that ended more than
seven days earlier are eligible. Cleanup is bounded, retryable, and independent
of the API and every provider transport. Deployments must run the standalone
worker for automatic cleanup; temporarily pausing it can increase storage but
cannot weaken active quota enforcement.

This decision does not provide pre-authentication ingress throttling, provider
metrics, a general privacy deletion workflow, Stream client connectivity, or
any Hyperliquid product capability. The append-only audit policy is unchanged.
