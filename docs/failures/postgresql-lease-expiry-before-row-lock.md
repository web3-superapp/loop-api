# PostgreSQL lease expiry evaluated before a row-lock wait

## Summary

A worker completion can begin while its lease is valid, block behind another
transaction's row lock until the lease expires, and still update the operation
if the expiry predicate was evaluated during the original `UPDATE` scan.

## Root Cause

Placing `lease_expires_at > clock_timestamp()` directly in an `UPDATE` predicate
does not guarantee that the expression is evaluated after a conflicting tuple
lock is acquired. PostgreSQL may qualify the unchanged row before waiting and
continue the update after the lock is released. Using `clock_timestamp()` instead
of transaction-stable `current_timestamp` is necessary, but is not sufficient.

## Detection

The PostgreSQL integration test starts a valid leased completion, blocks it with
`SELECT ... FOR UPDATE`, waits past the lease expiry, and then releases the lock.
The completion must fail with `StaleProviderOperationLeaseError`.

## Prevention

Worker completion, reschedule, and operator-hold transitions first acquire the
matching row through a `MATERIALIZED` `SELECT ... FOR UPDATE` CTE without an
expiry predicate. Only after that CTE has acquired the lock may the outer update
compare the lease with `clock_timestamp()`. Owner, worker, fence token, and
record version remain part of the locked-row match.

## Evidence

- `test/control-plane-repository.integration.test.ts`:
  `rejects a completion blocked until after its lease expires`
- The first direct-`UPDATE` implementation resolved the operation after the
  forced expiry; the materialized-lock implementation rejects it and the full
  PostgreSQL integration suite passes.
