# Decision 0092: Launch Intent build refusals pass through the PostgreSQL repository

- Status: Accepted (S104; main-agent defect sheet 2026-09-30).
- Date: 2026-09-30
- Scope: `createPostgresLaunchChainRepository().createIntent` (Decisions 0077, 0087), `LaunchChainRepositoryUnavailableError`, the operator log summary of Decision 0082. No migration, no new route, no new error code, no response-shape change.

## Defect

On-device evidence 2026-09-30 17:29:56: `POST /v2/launch/{launchId}/intents` (buy, round R1 ended 09:28:13Z) answered `500 INTERNAL_ERROR` instead of 06 §4.1 `409 DATA_STALE` with `reasonCode: LAUNCH_ROUND_NOT_OPEN`.

`prepareLaunchIntent` passes `buildIntent` / `buildSettlementIntent` as the `build` callback of `chain.createIntent`. Every 06 §4.1 refusal (`refuse()` → `V2ApiError` `DATA_STALE` / `VALIDATION_FAILED` / `POLICY_BLOCKED` / `INSUFFICIENT_BALANCE`) and every read failure (`unavailableWith()` → 503, `LaunchContractUnavailableError`) is thrown from that callback. The PostgreSQL `createIntent` ran `await input.build()` inside its own `try { … } catch (error) { return translate(error); }`, and `translate()` rewrote anything but its four repository error classes into `LaunchChainRepositoryUnavailableError`, which the route projects as 500. So on the real repository **every** build-time refusal was a 500.

Tests missed it because the unit/route tests use the in-memory `chainRepositoryFake` (its `createIntent` awaits `build()` with no translation), and the PostgreSQL integration test only called `createIntent` with a `build` that succeeds.

## Decision

1. `createIntent` runs `build` through `runCallerCallback`, which wraps a thrown value in a module-private `CallerCallbackError`; `translate()` unwraps it and rethrows the caller's original value unchanged. Only the repository's own work (argument parsing, the idempotency transaction, the insert, the winner read) goes through the outage mapping. Chosen over "`translate()` lets `V2ApiError` through" because (a) the database layer does not import the HTTP error type, and (b) the callback may throw non-`V2ApiError` values the service already maps (`LaunchContractUnavailableError`, `BscReadUnavailableError` → 503 in `translateChain`); those must reach the service too. `createIntent` is the only method of this repository that runs a caller callback.
2. `LaunchChainRepositoryUnavailableError` accepts `{ cause }`; `translate()` sets it to the original error. The cause is for the log only; the response for this error is byte-for-byte unchanged (bare `500 INTERNAL_ERROR`).
3. `summarizeErrorForLog` (Decision 0082) adds `errorCause`: the cause chain, outermost first, at most 4 entries, each `{ errorName, errorMessage }` with the same redaction as `errorMessage`; no stack, no driver fields (a PostgreSQL `detail` or SQL parameters are never read). Absent when the error has no cause, cycle-safe.

## Idempotency after a refusal

Unchanged: the key's idempotency record is claimed before `build` runs; a refused build stores no Intent row. A retry with the same key and body runs `build` again; the same key with another body is still `IDEMPOTENCY_CONFLICT`.

## Tests

- `test/launch-intent-refusal.integration.test.ts` (new): the launch service with the real PostgreSQL `createIntent` — buy after the round window and before it opens → 409 `LAUNCH_ROUND_NOT_OPEN`; buy while PAUSED → 409 `LAUNCH_SALE_PAUSED`; below minPurchase → 422 `LAUNCH_BELOW_MIN_PURCHASE`; claim while FROZEN / REFUNDING → 409 `LAUNCH_CLAIM_NOT_OPEN`; claim while VESTING+PAUSED → 409 `LAUNCH_SALE_PAUSED`; chain unreadable → 503 `LAUNCH_CONTRACT_READ_FAILED`; none stores an Intent. `createIntent` rethrows the exact value `build` throws; the repository's own failures remain `LaunchChainRepositoryUnavailableError` (500) with a `cause`. All 10 cases fail on the pre-fix repository.
- `test/v2-error-handler-rpc.test.ts`: `errorCause` summary and redaction; the `Unhandled error in V2 request` line carries `errorCause` while the 500 body is unchanged.
