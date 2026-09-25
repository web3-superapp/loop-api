# Decision 0077: Launch event lane, purchase Intent prepare, Merkle eligibility, sale registry

- Status: Accepted (backend, S83b); contract delivery still pending
- Date: 2026-09-25
- Scope: S83b backend. Main-agent brief S83b of 2026-09-25 and its four
  additions from the merged frontend S83c (Decision 0088). Builds on
  Decisions 0034 (pool_event lane), 0035 (Intent path), 0038 (launch chain
  slot), 0065 (signing exit and canary), 0075 (lane state machine), and 0076
  (adapter, ABI v1, frozen wire shapes). Contract interface: LOOP
  `docs/06-Launch合约接口需求.md` ("06").
- Baseline: `integration/v2` = `101ca4a`. Migration `000042`.

## Context

0076 gave the adapter, the configuration, and the `available` branches but
left every list `unavailable`: nothing indexed the contract, nothing prepared
a purchase, nothing produced an allowlist root, and nothing registered a
`saleId`. This decision fills those four gaps without a deployed contract:
every path is exercised with ABI v1 fixture logs and in-memory chains, and
with the four `LAUNCH_*` keys blank every response is byte-identical to
`1ab26d7` (the S83a regression fixtures still pass unchanged).

## Rulings

### 1. Entities and identity

| Entity                         | Key                                                                           | Notes                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `launch_indexed_events`        | `(chain_id, transaction_hash, log_index)`                                     | Every decoded event of a **registered** sale. `wallet_address` (buyer / wallet argument) is an attribute, never a key. Amounts are decimal strings in `payload`. Reorged logs keep the row, `removed`. |
| `purchase_records`             | opaque `purchase_record_id`; unique `(tx, log_index)`                         | One per `Purchased` log whose buyer resolves to exactly one LOOP account (see 2). Adds `chain_id`, `round_index`, and `intent_id` (linked by the broadcast report).                                    |
| `entitlements`                 | opaque `entitlement_id`; unique `(launch_id, wallet_id)`                      | Only when a surviving `SaleFinalized(SUCCEEDED)` **and** `VestingScheduleCreated` exist. Frozen amount = Σ `Purchased.tokenAmount` of the wallet; claimed = max `Claimed.cumulativeClaimed`.           |
| `refund_liabilities`           | opaque; unique `(launch_id, wallet_id)`                                       | From the latest surviving `RefundLiabilityFrozen` of the wallet; refunded = max `Refunded.cumulativeRefunded`. One per wallet, never per purchase (03 §8.3).                                           |
| `refund_claims`                | opaque; unique `(tx, log_index)`                                              | One per `Refunded` log; `removed` on reorg.                                                                                                                                                            |
| `launches` (projection)        | `launch_id`                                                                   | Four axes + `state_tuple_digest` + `state_config_version` + snapshot block from `getState`; `pool_address`, `pool_id` (only when a `pools` row already exists), `lp_token_id`, `lp_unlock_at`.         |
| `launches` (registry)          | `launch_id`; unique `(chain_id, contract_address, sale_id)`                   | Adds `quote_asset_id`, `project_asset_id` (written by `pnpm launch:register-sale`).                                                                                                                    |
| `launch_allowlists`            | opaque `allowlist_entry_id`; unique `(launch, round, address)`                | Operator addresses for `whitelist`; the address is list data, not a primary key.                                                                                                                       |
| `launch_round_allowlist_roots` | opaque `allowlist_root_id`                                                    | Append-only (trigger). Root, snapshot block + hash, mode, leaf count, and the sorted member set (`members` jsonb).                                                                                     |
| `launch_intents`               | opaque `intent_id`; unique `idempotency_record_id`, unique `transaction_hash` | Adds `sale_id`, `round_index`, `min_token_amount_raw`, `deadline`, `eligibility_proof`, `unsigned_transaction`, `policy`, `transaction_hash`, `payload_verified`, `reported_at`.                       |

Digest columns (`state_tuple_digest`, `state_config_version`, `root`) store 64
hex without `0x`; the wire always carries `0x`-prefixed bytes32. The only
conversion is `bytes32ToColumn` / `columnToBytes32` in the repository layer
(0076 ruling 6). `config_version_onchain` keeps its 0076 `0x` format because
its constraint was written that way.

### 2. The `launch_event` lane

- Worker lane `src/bsc-launch-indexer-worker.ts`, switch
  `LAUNCH_INDEXER_ENABLED` (default `false`, same type as
  `BSC_INDEXER_ENABLED`). It reads the launch chain slot (97 or the shared 56
  client) and owns the checkpoint row `(launch_event, <launch chain>)`.
- Four keys blank → the tick is `idle` with
  `LAUNCH_CONTRACT_BASELINE_PENDING`; adapter unavailable → `unavailable` with
  the adapter's reason. Neither writes anything.
- Seed at `LAUNCH_CONTRACT_START_BLOCK`; segments of ≤ 2 000 blocks
  (`adapter.readLogs`, address = `LAUNCH_CONTRACT_ADDRESS` only); reorg = the
  checkpoint hash differs → rewind by the slot's reorg depth, mark every event
  at or above the rewind block `removed`, replay (0034 rules).
- `saleId → launchId` only through `launches.sale_id` for the configured
  address + version. An unregistered `saleId` is skipped and logged once per
  segment as `LAUNCH_SALE_UNREGISTERED`; no row is created. Unknown topics are
  logged as `LAUNCH_EVENT_UNRECOGNIZED`, never guessed.
- At the end of every segment the lane calls `getState` once per registered
  sale **at the segment's last block**; the four axes and `stateTupleDigest`
  come only from there. If that read fails (for example a non-archive endpoint
  during catch-up) the events still commit and the sale keeps its previous
  projection with its older snapshot block (`LAUNCH_STATE_PROJECTION_SKIPPED`).
- Everything of a segment — rewind, events, projections of each touched
  launch, axes, `pending → confirmed` purchase states (head − slot
  confirmations), checkpoint — commits in one transaction. Projections are
  recomputed from the raw events, never incremented, so a replay converges to
  the same rows and the same opaque IDs.
- Account resolution: a chain address becomes a LOOP `wallet_id` only when
  exactly one account lists it in `account_wallets`. Ambiguous or unknown
  addresses produce no LOOP record (they still count as holders). A wallet
  linked after its purchase is not back-projected until the next segment that
  touches the launch (see open question 3).
- Pools: `PoolPrepared` / `LiquidityAdded` set `launches.pool_address`;
  `pool_id` links only to an **existing** `pools` row (registered and verified
  by `pnpm pool:register`). The lane never inserts a `pools` row: that table's
  contract is "registered only after the identity was read on chain", and the
  pool lane indexes 56 only.

### 3. Read projections (shapes frozen by 0076 ruling 5)

| Route                             | Available when                                                         | Source                                                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/launch/overview`         | contract available, sale registered, checkpoint exists, sale projected | `launches` projection (`source: chain`). No checkpoint → `LAUNCH_ONCHAIN_STATE_NOT_INDEXED`; checkpoint but not yet projected → `LAUNCH_ONCHAIN_STATE_NOT_PROJECTED` (new).                                                     |
| `GET /v2/launch/{id}/holders`     | same + a readable chain                                                | `holderCount` = distinct surviving buyers; `myPosition`/`walletCap` = `getPosition`, `getSaleConfig`, `getRounds`, `getRoundPosition` of the caller's active wallet at one block. No active wallet → `LAUNCH_WALLET_NOT_FOUND`. |
| `GET /v2/launch/{id}/history`     | sale registered + checkpoint                                           | The caller's lane rows (≤ 500 each); `source` = checkpoint block + hash.                                                                                                                                                        |
| `GET /v2/launch/{id}/eligibility` | mode confirmed + contract + wallet                                     | Section 5. New optional query `roundIndex`.                                                                                                                                                                                     |
| `GET /v2/launch/economy`          | contract configured                                                    | New optional `onChain` (below).                                                                                                                                                                                                 |
| `GET /v2/launches/{id}`           | unchanged (0076: live chain read)                                      | —                                                                                                                                                                                                                               |

`economy.onChain` (new optional field, present only while the four keys are
set): `{status: "available", registeredSaleCount, totalRaisedUsd1,
lockedLpCount, source: "loop_indexer", indexedBlockNumber,
indexedBlockHash}`, or `unavailable(LAUNCH_ONCHAIN_STATE_NOT_INDEXED)` without
a checkpoint. `totalRaisedUsd1` sums surviving `SaleFinalized.totalRaisedUsd1`
with outcome `SUCCEEDED` only (a failed sale's raise is refunded).

### 4. Launch purchase Intent (`POST /v2/launch/{launchId}/intents`)

Admission order (each refusal is a 7-field error with `detailsSafe.reasonCode`;
nothing is stored for a refusal):

```text
BSC_WRITES_ENABLED + four keys (else bare 503, bytes unchanged)
→ body (walletId, roundId, payAmount decimal string, 18 decimals)
→ adapter availability, launch slot chainId verified (503 + reason)
→ launch visible, sale registered on this contract (503 + reason)
→ embedded, active, owned wallet (404 / 422) → LOOP round row (404)
→ Idempotency-Key claim (launch_intent_v1; replay returns the stored Intent)
→ canary: USD1 asset in BSC_WRITE_CANARY_ASSETS, contract in the
  counterparty allowlist, per-intent ceiling, rolling 24 h ceiling
  (USD1 valued at exactly 1 USD; wallet and Launch intents share the window)
→ one snapshot: getState, getSaleConfig, getRounds, getRoundPosition,
  getPosition, quote, block header; confirmSnapshot
→ 06 §4.1 checks → eligibility proof → USD1 balance, allowance, native gas
→ eth_call + estimateGas of buy() → fee, nonce → seal (payloadDigest)
```

| reasonCode                                                                                                                          | HTTP / code                  | Rule                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `LAUNCH_SALE_NOT_LIVE` (+`saleState`)                                                                                               | 409 `DATA_STALE`             | `saleState ≠ LIVE`                                                                 |
| `LAUNCH_ROUND_NOT_ON_CHAIN`                                                                                                         | 409 `DATA_STALE`             | `getRounds` has no item with this `roundIndex`                                     |
| `LAUNCH_ROUND_NOT_OPEN`                                                                                                             | 409 `DATA_STALE`             | `max(now, block time)` outside `[startAt, endAt)`                                  |
| `LAUNCH_SALE_PAUSED`                                                                                                                | 409 `DATA_STALE`             | `operationalState = PAUSED`                                                        |
| `LAUNCH_DEADLINE_TOO_CLOSE`                                                                                                         | 409 `DATA_STALE`             | fewer than 15 s left before the round end                                          |
| `LAUNCH_CONFIG_VERSION_MISMATCH`                                                                                                    | 409 `DATA_STALE`             | `getState` ≠ `getSaleConfig` or ≠ `config_version_onchain`                         |
| `LAUNCH_BELOW_MIN_PURCHASE` (+`minPurchaseUsd1`)                                                                                    | 422 `VALIDATION_FAILED`      | amount < `minPurchaseUsd1`                                                         |
| `LAUNCH_WALLET_ROUND_CAP_EXCEEDED` (+`remainingUsd1`)                                                                               | 422                          | round position + amount > `walletRoundCapUsd1`                                     |
| `LAUNCH_WALLET_PROJECT_CAP_EXCEEDED` (+`remainingUsd1`)                                                                             | 422                          | cumulative + amount > `walletProjectCapUsd1`                                       |
| `LAUNCH_ROUND_CAP_EXCEEDED` (+`remainingUsd1`)                                                                                      | 422                          | round raised + amount > `roundCapUsd1`                                             |
| `LAUNCH_HARD_CAP_EXCEEDED` (+`remainingUsd1`)                                                                                       | 422                          | Σ rounds raised + amount > `hardCapUsd1`                                           |
| `LAUNCH_QUOTE_ZERO`                                                                                                                 | 422                          | `quote` returned 0                                                                 |
| `LAUNCH_ALLOWLIST_NOT_COMPUTED`                                                                                                     | 403 `POLICY_BLOCKED`         | chain root ≠ 0 but LOOP stored no root for the round                               |
| `LAUNCH_ALLOWLIST_ROOT_MISMATCH`                                                                                                    | 403                          | no stored root equals the chain `allowlistRoot` (or its members do not rebuild it) |
| `LAUNCH_ALLOWLIST_MODE_MISMATCH`                                                                                                    | 403                          | the matching root was computed under another `tierModeV1`                          |
| `LAUNCH_WALLET_NOT_ELIGIBLE`                                                                                                        | 403                          | wallet is not a member                                                             |
| `ASSET_NOT_IN_CANARY_ALLOWLIST`, `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`, `CANARY_CEILING_EXCEEDED`, `CANARY_DAILY_CEILING_EXCEEDED` | 403                          | 0065 / 0071, same extra fields                                                     |
| `LAUNCH_USD1_BALANCE_INSUFFICIENT`                                                                                                  | 409 `INSUFFICIENT_BALANCE`   | USD1 balance < amount                                                              |
| `LAUNCH_USD1_ALLOWANCE_INSUFFICIENT` (+`allowanceUsd1`)                                                                             | 409 `INSUFFICIENT_BALANCE`   | allowance to the contract < amount → approve first (section 6)                     |
| `LAUNCH_GAS_INSUFFICIENT`                                                                                                           | 409 `INSUFFICIENT_BALANCE`   | native balance < gas × max fee                                                     |
| `LAUNCH_SALE_ASSETS_UNREGISTERED`, any 0076 adapter reason                                                                          | 503 `CAPABILITY_UNAVAILABLE` | registry/adapter/chain not readable                                                |

- `minTokenAmount = quote()` (fixed price, no slippage); `deadline =
min(now + 120 s, round end)`; `expiresAt = deadline`.
- A reverted or unavailable simulation still creates the Intent in
  `prepared` (`signing.allowed = false`, `LAUNCH_SIMULATION_REVERTED` /
  `LAUNCH_SIMULATION_UNAVAILABLE`), exactly like 0035.
- `payloadDigest` = SHA-256 of the canonical JSON of every 03 §8.2 binding
  (account, wallet, launch, project, round ID + index, saleId, chain, USD1 and
  project asset IDs, `buy`, amounts, `configVersion`, round and project
  cumulative, deadline, contract, `stateTupleDigest`, snapshot block and
  hash, proof, unsigned transaction).
- The `201` gains only optional fields: `projectAssetId`, `saleId`,
  `walletRoundCapUsd1`, `walletProjectCapUsd1` (same snapshot, 0088),
  `simulation`, `policy`, `signing`, `transactionHash`, and in
  `unsignedTransaction` `from`, `gas`, `nonce`, `type`, `maxFeePerGas`,
  `maxPriorityFeePerGas`, `gasPrice`. The 409 of this route adds
  `INSUFFICIENT_BALANCE` to the enumerated codes.

States: `prepared | awaiting_signature` at prepare → `submitted` on the
broadcast report → `confirmed` when the lane indexes a surviving `Purchased`
log of that transaction (back to `submitted` on a reorg). An unreported Intent
past `expiresAt` is published as `expired`. There is no receipt reconciler for
Launch intents: a reverted transaction stays `submitted` (open question 4).

### 5. Broadcast report (`POST /v2/launch/{launchId}/intents/{launchIntentId}/broadcast-report`)

Added at the main agent's request (0088). Same discipline as the 0035 wallet
report: write headers, `{txHash}`; same gates as prepare (bare 503 without
the switch or the keys). Only `awaiting_signature` may be reported; the same
hash again returns the Intent unchanged; another hash is `409 DATA_STALE /
LAUNCH_INTENT_ALREADY_REPORTED`; an unsignable Intent is
`LAUNCH_INTENT_NOT_SIGNABLE`; a report past `expiresAt` needs the transaction
to be observable (`LAUNCH_INTENT_EXPIRED` otherwise). When the launch slot
already sees the transaction its `from/to/input/value/chainId` must equal the
sealed payload (`422 VALIDATION_FAILED / LAUNCH_TX_PAYLOAD_MISMATCH`). The
report is pending evidence only: history always reads the index, and the
Purchased row carries the `intent_id` once both exist.

### 6. USD1 approve on the launch slot

- `isIntentChainAllowed(kind, chain, launchAllowance)` admits chain 97 for
  `launch` intents and for **approve / revoke whose token is
  `LAUNCH_USD1_ADDRESS` and whose spender is `LAUNCH_CONTRACT_ADDRESS`**.
  Send, swap, and every other approval stay on 56.
- Request: the existing `POST /v2/wallet-intents/approve` with
  `assetId = "eip155:97:<LAUNCH_USD1_ADDRESS>"` — the CAIP asset ID already
  names the chain, so no new `chainId` field. Any other 97 asset, any other
  spender, or a missing launch slot is `422 CHAIN_MISMATCH`, decided before
  the canary. The asset row exists once `pnpm launch:register-sale` ran.
- The approve walks the full 0065 canary (the 97 USD1 asset ID must be in
  `BSC_WRITE_CANARY_ASSETS`), is valued at par (`priceSource: usd1_par`), and
  reads balance, code, simulation, fee, and nonce on the launch slot. The
  broadcast report and the reconcile lane read receipts from the chain the
  intent was recorded on. `unsignedTransaction.chainId` in the wallet-intent
  schema widens from `const 56` to `enum [56, 97]`.

### 7. `balances.launchChain.usd1`

Optional, shape frozen by 0088: `{"balance": "<uint>", "allowance": "<uint>"}`
(base units; allowance to `LAUNCH_CONTRACT_ADDRESS`). Present only when
`LAUNCH_USD1_ADDRESS` is set, the `launchChain` block is present (launch slot
≠ primary), and both values were read at the same block; otherwise absent,
never `null`. It is never part of the Intent `201`.

### 8. Eligibility and Merkle

- Leaf `keccak256(abi.encodePacked(address))` (20 bytes); node
  `keccak256(min ‖ max)` (OpenZeppelin `MerkleProof` commutative hashing);
  leaves sorted and de-duplicated; an unpaired node is promoted. Verified
  against an independent implementation and the known vector
  `keccak256(address(0)) = 0x5380c7b7…767312a` (`test/launch-merkle.test.ts`).
  `StandardMerkleTree` is not used (its leaf is double-hashed `abi.encode`).
- Modes (`tierModeV1` of the confirmed configuration):
  - `whitelist`: `launch_allowlists` rows of the round
    (`pnpm launch:allowlist import <csv> --launch --round [--source]`).
  - `community`: active wallets of accounts whose membership in
    `eligibilityCommunityId` (configuration slot) is `active` and joined at or
    before the snapshot block time, wallet first seen by then.
  - `activity`: active wallets of accounts with a positive power in a
    `complete` Mining snapshot computed in the 30 days up to the snapshot time.
- `pnpm launch:allowlist compute --launch --round --snapshot-block [--confirm]`
  reads the block header on the launch chain, evaluates once, prints the root;
  `--confirm` appends it. LOOP never writes a root on chain.
- Read time: the chain `allowlistRoot` selects the stored set; a zero root is
  an open round (`tier` = the round's tier or `public`, empty proof). Tier of a
  member: the LOOP round's `eligibilityTier`, else `whitelist → priority`,
  `community`/`activity → community`.
- Refusals keep the unchanged Decision 0036 result object (`tier: null,
snapshotBlock: null`) with the reason code.

### 9. `pnpm launch:register-sale`

`--launch <id> --sale-id <n> [--confirm] [--rescan]`. Reads `getState` +
`getSaleConfig` at one block and refuses, before any write:
`LAUNCH_NOT_FOUND`, `LAUNCH_CHAIN_MISMATCH`, `LAUNCH_SALE_ALREADY_REGISTERED`,
`LAUNCH_SALE_REGISTERED_DIFFERENTLY`, `LAUNCH_PROJECT_TOKEN_UNRECORDED` (no
`projectTokenAddress` in the confirmed configuration — LOOP's record of the
token), `LAUNCH_SALE_NOT_FOUND`, `LAUNCH_CONFIG_VERSION_MISMATCH`,
`LAUNCH_USD1_ADDRESS_MISMATCH`, `LAUNCH_PROJECT_TOKEN_MISMATCH`,
`LAUNCH_SALE_ID_TAKEN`, and every 0076 adapter reason. Without `--confirm` it
is a dry run; under `NODE_ENV=production` it refuses to start without
`--confirm`. With it: both tokens are registered in the launch chain's Asset
Registry (identity read from the contracts, `pending`), the sale registry and
asset pair are written, and a `sale_registered` operator row is appended to
`launch_review_events`. `--rescan` drops the `launch_event` checkpoint so a
late-registered sale's earlier events are replayed.

### 10. Unavailable behaviour

Four keys blank: every Launch response is byte-identical to `1ab26d7`; the
Intent and report routes answer the bare `503`; `economy` has no `onChain`;
`launchChain` has no `usd1`; the lane idles. `BSC_WRITES_ENABLED` off: both
Intent routes are the bare `503`. Rollback: blank the keys and set
`LAUNCH_INDEXER_ENABLED=false`; `000042`'s `down` refuses while lane facts,
allowlists, Intents, or `sale_registered` rows exist.

## Open questions for the main agent

1. Tier of an `activity` member is published as `community` (the frozen enum
   has no `activity` tier). Confirm or rename.
2. Approve **and revoke** of USD1 → Launch contract are admitted on 97 (revoke
   only removes exposure). Confirm revoke is wanted.
3. A wallet linked to an account after its purchase is only projected when a
   later segment touches that launch; a full replay is `pnpm
launch:register-sale … --rescan` (resets the lane). A dedicated
   re-projection command could be added.
4. No receipt reconciler for Launch intents: a reverted `buy()` stays
   `submitted` (no `Purchased` log ever confirms it). The 0035 reconcile lane
   could be extended to `launch_intents`.
5. `holderCount` counts distinct buyers of surviving `Purchased` logs, not
   current token holders (the project token is not indexed).
