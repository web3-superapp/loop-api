# 0096: Bound Hooks signing preparation CPU and concurrency

Status: implemented locally, 2026-10-09. BSC Testnet only.

## Problem

Preparing one signing request searches a MEME CREATE2 suffix and independent Hook permission salt. A synchronous search can monopolize the API event loop. Unbounded overlapping requests would retain RPC work and consume CPU without a retry signal.

## Decision

Sync tools and async services share generator-based search math. Async draining yields through node:timers/promises setImmediate every 256 attempts. The service admits up to four concurrent preparations per instance; excess calls receive capability-unavailable with Retry-After: 5. A finally block releases admission after any repository, RPC, validation or search failure. This is admission control, not a persistent deployment job queue; rejected callers must retry.

The contract module helper revision authenticates factory calls and namespaces non-MEME module salts by factory. Recompute factory manifests, predictions and Hook salts after upgrading helper bytecode. The factory remains pinned to helper runtime hashes; do not submit old previews to the new factory.

## Validation and boundaries

Cooperative search returns the same salts/addresses as synchronous search and allows unrelated event-loop work to execute before completion. Four blocked requests reject a fifth; failures release all slots. Contract regressions cover unauthorized module occupancy, 160-wallet graduation, stale quote rollback, donation separation, failed migration retry and keeper recovery.

Local API non-database integration regression: 237 files / 3420 tests; directed final helper/service/route regression: 27 tests. TypeScript, ESLint and build checks pass. No database migration, live process restart or testnet broadcast was performed as part of this change. Across-instance queueing, signed submissions, transaction nonces, receipt/reorg handling and verified activation remain separate work.
