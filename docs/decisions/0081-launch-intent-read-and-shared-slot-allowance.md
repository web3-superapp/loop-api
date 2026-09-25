# Decision 0081: Launch Intent read, shared-slot USD1 allowance, transaction hash form

- Status: Proposed (backend, S83b3)
- Date: 2026-09-25
- Scope: S83b3. Three backend items raised by the mobile slice S83c2
  (loop-mobile Decision 0089). Builds on Decisions 0038 (launch chain slot),
  0077 (Launch Intent prepare, broadcast report, `launchChain.usd1`), 0080
  (receipt reconciliation, `revertReason`), and 0088 (frozen `usd1` shape).
- Baseline: `integration/v2` = `c070c54`. No migration.

## Context

After a device broadcast the client could only learn the reconciled state
of a Launch Intent (0080) by replaying the report or the prepare. The
wallet page carries the USD1 balance/allowance only inside `launchChain`,
which is absent whenever the launch slot is the primary chain
(`LAUNCH_CHAIN_ID=56`, the default), so a shared-slot deployment would give
the client nowhere to read the allowance. The client also needs to compare
transaction hashes byte for byte.

## Rulings

### 1. `GET /v2/launch/{launchId}/intents/{launchIntentId}`

- **Entity / ID.** No new entity. It reads `launch_intents` by the opaque
  `intent_id` scoped by `owner_user_id` and `launch_id`
  (`LaunchChainRepository.getIntent`, already owner-scoped in SQL). No
  wallet address, hash, or ticker is a key.
- **Response.** `200 {launchIntent, contractVersion}` produced by the same
  `projectLaunchIntent` as the prepare `201` and the broadcast report: the
  body is byte-identical to a prepare replay at the same instant. It shows
  every 0080 state (`reverted`, `failed`, `expired`, `confirmed`,
  `submitted`, `awaiting_signature`), `revertReason` only on `reverted`,
  and the 0077 time rule (an unreported Intent past `expiresAt` reads
  `expired` / `LAUNCH_INTENT_EXPIRED`). The read never writes or advances
  state; the `launch_event` lane and the reconcile lane remain the only
  writers.
- **Ownership.** Another account's Intent, an unknown `launchIntentId`, and
  an Intent of a different `launchId` are the same `404 NOT_FOUND`
  (`detailsSafe: null`), so existence is never disclosed.
- **Headers.** Read headers (Bearer + `X-Loop-Client-Version` +
  `X-Loop-Contract-Version: 2.0`); no `Idempotency-Key`; query or body is
  `400 INVALID_REQUEST`; malformed IDs `400`.
- **Unavailable.** The report's gate, unchanged bytes: `503
CAPABILITY_UNAVAILABLE` with `detailsSafe: null` while
  `BSC_WRITES_ENABLED` is off, the four `LAUNCH_CONTRACT_*` keys are blank,
  or the Launch chain repository is not composed. An unreadable Intent
  store (`LaunchChainRepositoryUnavailableError`) is also `503
CAPABILITY_UNAVAILABLE`, never `404`. With writes off no Intent can be
  created, so the gate hides nothing a client could have.
- **Errors.** `launchReadErrors`: 400 `INVALID_REQUEST`; 401
  `AUTH_REQUIRED`/`AUTH_INVALID`; 404 `NOT_FOUND`; 409
  `ACCOUNT_BOOTSTRAP_REQUIRED`/`VERSION_CONFLICT`; 500 `INTERNAL_ERROR`; 503
  `CAPABILITY_UNAVAILABLE`/`PROVIDER_DISCONNECTED`/`REQUEST_TIMEOUT`.
- **OpenAPI.** `getV2LaunchIntent`; its `200` schema is the prepare `201`
  schema (asserted equal in `test/openapi.test.ts`).

### 2. Root `launchUsd1` on `GET /v2/wallets/{walletId}/balances`

- New **optional** root property `launchUsd1: {balance, allowance}`, the
  same schema object as `launchChain.usd1` (0088 shape: base-unit decimal
  strings, `additionalProperties: false`).
- **Present only when** the launch slot is shared with the primary slot
  (no separate launch client, so `launchChain` is absent), the four
  `LAUNCH_CONTRACT_*` keys are configured, and `balanceOf(wallet)` and
  `allowance(wallet, LAUNCH_CONTRACT_ADDRESS)` were read on the primary
  client at the same block (the helper `readLaunchChainUsd1` used by
  `launchChain.usd1`, same 3000 ms deadline).
- **Absent** when the slot is separate (read `launchChain.usd1` instead;
  the two are never both present), when the contract is not configured,
  when the two reads land on different blocks, or on any read failure
  (unconfigured RPC, chain mismatch, deadline, a client without the
  allowance call). Never `null`, never a guess, never an error of the page:
  the primary balances are unaffected.
- With those conditions false the document is byte-identical to before;
  the S9 baseline fixture test and a new test pin it.
- The read runs in parallel with the primary balance read, like the launch
  slot read (0063).

### 3. `transactionHash` form

Already true before this slice, now pinned by route tests:
`broadcast-report` accepts `txHash` in any case, lowercases it, then
requires `^0x[0-9a-f]{64}$` (`400 INVALID_REQUEST` otherwise). The
repository parses it with the same lowercase pattern, and
`launch_intents_transaction_hash_check` (000042) enforces it in PostgreSQL.
Every projection (prepare replay, report, the new read) therefore carries
`transactionHash` as lowercase `0x` + 64 hex, or `null` before a report. A
re-report of the same hash in another case is the same report (`200`, same
body), never `LAUNCH_INTENT_ALREADY_REPORTED`. No code change.

## Consequences

- The client can poll one Intent after broadcast instead of replaying a
  write.
- A shared-slot deployment exposes the USD1 allowance at the root.

## Open for the main agent

- The existing `broadcast-report` route does not map the same store failure;
  it reaches the generic handler (`500 INTERNAL_ERROR`). Left unchanged (no byte change to an
  existing route). Aligning it to `503` is a one-line follow-up if wanted.

- On a shared slot the USD1 approve path of 0077 still answers
  `422 CHAIN_MISMATCH` (the approve rule admits the USD1 → Launch pair only
  on a separate launch slot). `launchUsd1.allowance` is readable there but
  the app cannot yet raise it through `POST /v2/wallet-intents/approve`.
  Opening that pair on chain 56 would touch BSC Mainnet signing, which stays
  closed; it is not done here.

## Main-agent rulings (2026-09-25)

1. On a shared slot the allowance is readable but not raisable in the app: kept. Raising it is a mainnet write and waits for the production signing decision.
2. The broadcast-report store failure stays a generic 500 for now (bytes unchanged); revisit with the next Launch contract change.
3. `chat-channel-repository.integration.test.ts` "converges opposite direct requests" has now flaked in three separate worktrees today; tracked as a standalone fix (S85), not a Launch item.
