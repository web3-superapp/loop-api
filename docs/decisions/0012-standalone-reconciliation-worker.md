# Decision 0012: Standalone reconciliation worker process

- Status: Accepted
- Date: 2026-08-25

## Context

Decision 0003 established a durable provider-operation journal, fenced
reconciliation leases, and a generic worker that can perform authoritative
reads only. The worker existed as a tested library, but no production entry
point owned database readiness, process signals, connection shutdown, or an
independent runtime image. Consequently, the lease protocol could not yet be
operated as a separate service.

No provider mutation has been approved. There is also no approved Perp or
transfer authoritative reader/finalizer that can turn a real provider response
into an atomic domain result. Making the generic loop executable must not imply
that either capability is connected.

## Decision

- The reconciliation worker is a standalone Node.js process. It does not build
  or listen on the Fastify HTTP application.
- Its environment parser reads only `NODE_ENV`, `LOG_LEVEL`, and the
  `DATABASE_*` settings. Privy, Stream, Hyperliquid, transfer, signing, relay,
  and mobile credentials or feature flags are outside this process's config.
- Startup creates the PostgreSQL pool and proves the current migration/schema
  through the existing readiness check before it begins leasing work.
- `SIGINT` and `SIGTERM` abort the active worker loop exactly once. The runtime
  waits for that loop to finish before closing PostgreSQL and removes its signal
  listeners during shutdown.
- The worker retains one process identity while creating a new UUID for every
  reconciliation request. Lease claims, completions, retries, and operator
  holds continue to require owner, worker, fence token, record version, and an
  unexpired database-wall-clock lease.
- Logs are newline-delimited JSON with fixed service metadata and an allowlist
  of lifecycle, signal, retry, and safe error-code fields. Raw errors, provider
  responses, owners, credentials, wallet data, and request payloads are not log
  inputs.
- The production authoritative-reader registry remains empty. With the present
  composition, the process makes no provider call and has no signer, formatter,
  executor, relay, replay, or domain finalizer. An unknown leased domain is
  conservatively parked as `operator_required`.
- The API runtime, migration command, and worker have separate Docker build
  targets. Building an image is not a deployment decision.

## Consequences

The control-plane loop can now be started, stopped, tested as a real child
process, and packaged independently from HTTP traffic. Multiple replicas remain
safe under the existing `SKIP LOCKED` claim and fenced-write protocol.

This decision enables process operability only. The worker is not deployed, its
reader registry is empty, and it cannot reconcile a real Perp or transfer result
until a separate decision approves an authoritative reader, strict parser,
atomic domain finalizer, credentials, provider conformance evidence, and
deployment topology. Mainnet, provider writes, retries of provider writes,
withdrawals, and automated trading remain disabled.
