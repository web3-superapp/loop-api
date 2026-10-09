# Decision 0036: V2 Launch catalog, Mining skeleton, and referral graph

- Status: Accepted (backend); every on-chain and formula item stays on the
  external Go/No-Go list
- Date: 2026-09-08
- Scope: S7 backend (D17 Launch off-chain slot, D18 Mining slot, D19 referral
  relationships). The main-agent rulings of 2026-09-08 in
  `LOOP/docs/modules/S7-launch-mining.md` are adopted verbatim below. The user
  may overturn any row.

## Context

The `02-合约产品方案` document has not been provided. Nothing about the Launch
contract (four-axis state, purchase, refund, claim, vesting, pool creation, LP
lock, staking) can be asserted, and the Mining formula, weights, price guard,
and reward budget have not been frozen (03 §19). What the product still needs
now is the off-chain part that does not depend on either: an application
catalog with a review state machine, the configuration _slots_ the client
renders as 待确认, the Mining rules page that shows a pending version, and the
invite-code relationship graph. Everything derived from a contract or a
formula is published as `unavailable` with a stable reason code; no prototype
number (unified supply, "permanent 1% tax", `…LOOP` contract suffix, 0.5 %
wallet cap, three fixed rounds, 10 %/5 % fees) enters the backend.

## Rulings adopted (main agent, 2026-09-08)

| Topic                | Ruling                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract absence     | Every on-chain fact is `unavailable` + `LAUNCH_CONTRACT_BASELINE_PENDING`; no Launch transaction is built; no prototype supply/tax/suffix is published.                                                                                                                                                                                                                                                    |
| Off-chain catalog    | `launch_projects` (name/ticker/narrative/material version, `reviewStatus: draft\|submitted\|in_review\|returned\|approved\|rejected`, KYB `pending\|unavailable`, attachments unavailable), `launches` (chain 56, `contractAddress: null`, `configDigest`, `scheduleStatus`, four-axis projection unavailable), `launch_rounds` (index 1..N, nullable time/price/eligibility/cap, `pending_confirmation`). |
| Application flow     | `POST /v2/launch/projects` (draft) → `PUT` (CAS `expectedVersion`) → `POST …/submit` (Idempotency-Key; `returned` may resubmit). Review only through `pnpm launch:review` (audit row, refused in production). Admin console and two-person review are a later module.                                                                                                                                      |
| Configuration slots  | `launch_configs` (`configVersion`, jsonb parameters, `pending_confirmation\|confirmed`, `effectiveAt`) with `walletRoundCap`, `walletProjectCap`, `feeBps`, `softCap`, `hardCap`, `tge`, `vesting`, `tierModeV1` slots; without a confirmed version the client renders 待确认.                                                                                                                             |
| Eligibility          | `GET /v2/launch/{launchId}/eligibility`: `mode: whitelist\|community\|activity\|unavailable` from the confirmed `tierModeV1` slot; result `{tier, reasonCode, snapshotBlock}`; no configuration → `unavailable(TIER_MODE_PENDING)`; never depends on staking.                                                                                                                                              |
| loop-stake           | `GET /v2/launch/stake` is always `unavailable(STAKING_CONTRACT_PENDING)` and `executable: false`.                                                                                                                                                                                                                                                                                                          |
| launch-trade         | `POST /v2/launch/{launchId}/intents` exists and is always `503 CAPABILITY_UNAVAILABLE`; the `launch_intents` relation holds every 03 §8.2 binding column plus `stateTupleDigest/snapshotBlockNumber/snapshotBlockHash` but has no write path.                                                                                                                                                              |
| History / holders    | `purchase_records`, `entitlements`, `refund_liabilities` (unique per launch + wallet), `refund_claims` exist as structure; reads return empty lists with `source: unavailable`; the four graduation steps are `pending`; pool evidence is unavailable (no contract address).                                                                                                                               |
| Venue milestones     | `venue_milestones` (`venueMilestoneId`, project, venue, marketType, nine-state enum, evidence digest/time/reviewer); `GET /v2/launch/projects/{id}/milestones`; `pnpm launch:milestone` records evidence; default `PREPARING`.                                                                                                                                                                             |
| loop-economy         | Only provable counts (projects by status, launches by schedule status, confirmed rounds) with `source: loop_db, observedAt`; supply/distribution/tax unavailable.                                                                                                                                                                                                                                          |
| Mining formula       | `mining_formula_versions` (`configVersion`, formula/weight-range/price-guard jsonb, `pending_approval\|approved\|retired`, `effectiveAt`); `miningFormulaV1-draft` seeded as `pending_approval`; without an `approved` version every power/reward/rank is `unavailable(MINING_FORMULA_BASELINE_PENDING)`.                                                                                                  |
| Snapshot skeleton    | Lane `mining-snapshot` (default off) computes `mining_snapshots` from `wallet_balance_snapshots` + fresh `market_fact_cache` prices + `community_mining_weights` only under an approved formula; implemented and tested, idle at runtime.                                                                                                                                                                  |
| Rewards / claim      | `mining_reward_ledger` structure; `claimable` is always `unavailable(REWARD_AUTHORITY_PENDING)`; the claim button is not executable.                                                                                                                                                                                                                                                                       |
| Rank                 | `GET /v2/mining/rank?scope=users\|communities` is unavailable until a snapshot exists; display rule: alias only for a discoverable, non-anonymous profile, otherwise `mining.rank.anonymousMember`.                                                                                                                                                                                                        |
| Invite codes / edges | `invite_codes` (one per account, `LOOP-` + 4 Crockford + 1 check symbol, random, non-enumerable), `referral_edges` (depth 1..5, `pending_activation\|pending_wallet\|pending_mining\|valid\|invalidated`, `lockedAt`, `effectiveFrom/To`). `POST /v2/referral/claim {inviteCode}` only within 7 days of activation and never bound before; self-invite, cycle rejected; depth capped at 5.                 |
| capabilities         | `launch`, `mining`, and the new `referral`: module enabled + repository → `available`; evidence `LAUNCH_CONTRACT_BASELINE_PENDING` / `MINING_FORMULA_BASELINE_PENDING`.                                                                                                                                                                                                                                    |

## Implementation rulings (2026-09-08)

### Persistence (migration `000023_v2_launch_mining`, append-only)

Nineteen relations, all registered in `src/database/schema.ts`:
`launch_projects`, `launch_review_events` (append-only trigger), `launches`,
`launch_configs`, `launch_rounds`, `launch_intents`, `purchase_records`,
`entitlements`, `refund_liabilities`, `refund_claims`, `venue_milestones`,
`mining_formula_versions`, `community_mining_weights`, `mining_snapshots`,
`mining_snapshot_powers`, `mining_reward_ledger`, `invite_codes`,
`referral_edges` (delete refused by trigger), `referral_events` (append-only).
`idempotency_records.digest_version` gains `launch_command_v1` and
`referral_command_v1`. Rollback refuses while any project, edge, code,
snapshot, approved formula, or command record exists.

- **The four axes are pinned at the schema.** `launches.sale_state`,
  `entitlement_state`, `liquidity_state`, and `operational_state` exist with
  the exact 03 §8.3 names, but `launches_axes_unavailable_check` allows only
  `unavailable`, and `contract_address` / `state_tuple_digest` /
  `snapshot_block_*` are nullable. A later migration widens the enum from 02;
  until then no code path can write a chain state by accident.
- **One launch per approved project** (`launches_project_unique`), created by
  the operator approval inside the same transaction as the audit row.
- **Rounds reference their configuration**: `launch_rounds (launch_id,
config_version)` is a composite foreign key onto `launch_configs`, so a
  round can never name a configuration version that does not exist for its
  launch (S7 review).
- **Configuration slots are strings inside jsonb** and are projected as
  `{status: "confirmed", value}` only when the row is `confirmed`; otherwise
  `unavailable(LAUNCH_CONFIG_PENDING_CONFIRMATION)`. At most one confirmed row
  per launch (`launch_configs_one_confirmed_idx`).
- **`launch_intents` mirrors 03 §8.2**: account, wallet, launch, project,
  round, chain, USD1 `quote_asset_id`, project `asset_id`, direction (`buy`
  only, by check), pay amount, expected receive, `config_version`, wallet
  cumulative, expiry, contract address, `payload_digest`,
  `state_tuple_digest`, `snapshot_block_number`, `snapshot_block_hash`. It is
  a separate namespace from `wallet_intents` (own table, own idempotency
  digest version reserved, own states) and nothing writes it.
- **Refund liability is wallet-level**: `refund_liabilities_wallet_unique
(launch_id, wallet_id)` encodes "one aggregated liability per wallet";
  `refund_claims` reference it.
- **The draft formula carries rule keys only.** `miningFormulaV1-draft` has
  `assetWeights: {}`, `weightRange.loop/community.status =
pending_approval` with description keys, seven review-factor keys, and three
  price-guard rule keys (TWAP, multi-period/multi-source, liquidity cap). No
  weight number, no reward budget, no yield appears anywhere in the backend.
  `mining_formula_versions_one_approved_idx` allows at most one approved row.
- **Invite code format.** `LOOP-XXXXC`: four symbols from
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ` drawn from 20 random bits, plus a check
  symbol `(1·v1 + 3·v2 + 5·v3 + 7·v4) mod 32` (weights coprime to 32, so any
  single-symbol error is detected). Input is normalised (case, `I/L→1`,
  `O→0`, optional prefix). Uniqueness is a database constraint with up to
  eight allocation retries; the code is issued lazily on the first
  `GET /v2/referral` and is never sequential.

### Referral relationship rules

| Rule              | Behaviour                                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may claim     | An account with an activated V2 profile, inside `[activatedAt, activatedAt + 7 days)`, that has never been bound. Unactivated → `409 PROFILE_ACTIVATION_REQUIRED`; window closed → `403 POLICY_BLOCKED` (audited `claim_window_closed`).                                                                         |
| Code resolution   | Unknown code → `404 NOT_FOUND` (same as any missing resource; codes are not enumerable). Malformed code → `400 INVALID_REQUEST`.                                                                                                                                                                                 |
| Self / cycle      | Own code → `422 VALIDATION_FAILED` (audited `self_invite`). A code whose owner's ancestor chain contains the claimant → `422 VALIDATION_FAILED` (audited `referral_cycle`).                                                                                                                                      |
| Depth             | The inviter chain is walked with a recursive query over depth-1 edges up to 64 ancestors (cycle detection); edges are materialised for the inviter (depth 1) and each ancestor at depth + 1, **capped at 5**. A sixth ancestor is simply not an edge; the claim itself is not refused because the chain is long. |
| Already bound     | `409 DATA_STALE`; enforced under the owner lock and by `referral_edges_invitee_depth_unique`.                                                                                                                                                                                                                    |
| Replay            | Same `Idempotency-Key` + same code returns the original binding; same key + other code → `409 IDEMPOTENCY_CONFLICT`.                                                                                                                                                                                             |
| Validation status | Activation is a precondition, so a new edge is `pending_wallet` (no active wallet) or `pending_mining` (an active wallet exists). `valid` requires an approved Mining formula (D19) and is never produced here; `invalidated` requires `effective_to`.                                                           |
| Identity          | The inviter is never identified to the invitee (only the binding state, its validation status, and its lock time). Counts per level are grouped by `validationStatus`.                                                                                                                                           |
| Boost             | `GET /v2/referral.boost` is `unavailable(MINING_FORMULA_BASELINE_PENDING)`; the five level percentages come from the unchanged `referralRulesV1` snapshot and are Mining Power boosts, never revenue or commission.                                                                                              |

### Routes

`launch` module (`src/routes/v2/launch.ts`), `mining` module
(`src/routes/v2/mining.ts`), `referral` module (`src/routes/v2/referral.ts`).
The V2 artifact grows from 93 to 115 operations.

| Method | Path                                         | Semantics                                                                                                                                                                          |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v2/launch/overview`                        | Approved launches by `scheduleStatus`: `live`, `upcoming` (scheduled), `awaitingSchedule` (unscheduled, own segment), `ended`; `graduated`, `myEligibility`, `staking` unavailable |
| `GET`  | `/v2/launch/projects`                        | Caller's applications, `status` filter, owner-bound cursor                                                                                                                         |
| `POST` | `/v2/launch/projects`                        | Draft; `201`; Idempotency-Key bound to the body digest                                                                                                                             |
| `GET`  | `/v2/launch/projects/{projectId}`            | Owner sees every status; others only `approved` with `reviewReasonCode/submittedAt/reviewedAt/version` null; else `404`                                                            |
| `PUT`  | `/v2/launch/projects/{projectId}`            | CAS `{expectedVersion, project}`; only `draft\|returned`; no Idempotency-Key                                                                                                       |
| `POST` | `/v2/launch/projects/{projectId}/submit`     | `draft\|returned → submitted`; otherwise `DATA_STALE`                                                                                                                              |
| `GET`  | `/v2/launch/projects/{projectId}/milestones` | Venue milestones                                                                                                                                                                   |
| `GET`  | `/v2/launches/{launchId}`                    | Launch + project + config slots + rounds + four axes + graduation steps + pool evidence                                                                                            |
| `GET`  | `/v2/launch/{launchId}/eligibility`          | `mode` from `tierModeV1`; `TIER_MODE_PENDING` otherwise                                                                                                                            |
| `GET`  | `/v2/launch/{launchId}/holders`              | All unavailable                                                                                                                                                                    |
| `GET`  | `/v2/launch/{launchId}/history`              | Empty `purchaseRecords/entitlements/refunds` + `source: unavailable`                                                                                                               |
| `POST` | `/v2/launch/{launchId}/intents`              | Always `503 CAPABILITY_UNAVAILABLE`                                                                                                                                                |
| `GET`  | `/v2/launch/stake`                           | `STAKING_CONTRACT_PENDING`, `executable: false`                                                                                                                                    |
| `GET`  | `/v2/launch/economy`                         | Provable counts only                                                                                                                                                               |
| `GET`  | `/v2/mining/summary`                         | All numbers unavailable; names the pending formula version                                                                                                                         |
| `GET`  | `/v2/mining/assets`                          | Unavailable                                                                                                                                                                        |
| `GET`  | `/v2/mining/rewards`                         | `claimable` `REWARD_AUTHORITY_PENDING`, `claimExecutable: false`                                                                                                                   |
| `GET`  | `/v2/mining/rank`                            | `scope=users\|communities`; unavailable; anonymity rule                                                                                                                            |
| `GET`  | `/v2/mining/communities/{communityId}`       | Weight record (`approved` value or `pending_review`)                                                                                                                               |
| `GET`  | `/v2/mining/rules`                           | Approved (null) + pending versions with rule keys; referral levels                                                                                                                 |
| `GET`  | `/v2/mining/referral/rules`                  | Moved from `community`; path preserved                                                                                                                                             |
| `GET`  | `/v2/referral`                               | Invite code (issued on first read), binding, level counts, boost unavailable                                                                                                       |
| `POST` | `/v2/referral/claim`                         | Bind to an inviter (rules above)                                                                                                                                                   |

### Capabilities

`launch`, `mining`, and the new `referral` (28 entries) are `available` only
when the module is enabled and `buildApp` composed the repository (launch also
needs the cursor codec); `evidence` is always `{status: "pending",
reasonCode}` with `LAUNCH_CONTRACT_BASELINE_PENDING` or
`MINING_FORMULA_BASELINE_PENDING` (referral shares the latter: its boost
depends on the formula). The mobile enum gains `referral`. `communityMining`
stays `unavailable` unchanged.

### Operator scripts (Dev only)

- `pnpm launch:review <projectId> <review|approve|return|reject> [reasonCode]`
  — appends an operator `launch_review_events` row; `approve` creates the
  `launches` row (`unscheduled`, `contractAddress: null`).
- `pnpm launch:milestone <projectId> <venue> <marketType> <state> [--evidence <ref> --reviewer <id> [--observed-at <RFC 3339>]]`
  — enforces the 03 §8.4 state machine; `LISTED`/`FEATURED` require both
  evidence and reviewer; only `sha256(evidence)` is stored.
  `evidence_recorded_at` is the server clock at recording;
  `evidence_observed_at` is the operator-supplied platform time the evidence
  became verifiable (nullable, only with a digest, never derived).
- `pnpm mining:approve-formula <configVersion> --confirm` — approves one
  version, retires any other, sets `effectiveAt`.

All three refuse `NODE_ENV=production` before opening a connection.

### `mining-snapshot` lane

`MINING_SNAPSHOT_ENABLED` (default `false`) in the standalone worker. Each
tick: no approved formula → `idle(MINING_FORMULA_BASELINE_PENDING)` and no
further read. Otherwise: latest `wallet_balance_snapshots` per active wallet
and readable asset, approved community weights joined to the community's
bound asset (read for the approved formula's `configVersion` only, so a
weight reviewed under a retired version never enters a snapshot), one
**fresh** DexScreener price per weighted asset (`requireFresh`;
a proxied native price is refused), then the pure
`computeMiningSnapshot(inputs, formula)`:
`power = holding × referencePriceUsd × weight` per account and asset with
exact decimal-string arithmetic, snapshot block = highest observed balance
block, `priceVersion = source:<latest fetchedAt>`. Assets without a weight or
without a fresh price are skipped and reported; nothing is defaulted. The
repository writes `mining_snapshots` + `mining_snapshot_powers` in one
transaction. The lane never settles or claims a reward.

## Consequences

- The application flow, catalog, rules page, and referral graph run on
  PostgreSQL alone. That is not contract or formula readiness; the client
  must render every derived number as `—` with "待确认（configVersion）".
- `GET /v2/mining/referral/rules` now belongs to the `mining` module: a
  deployment that enables `community` but not `mining` loses the path.
- The activation guard trigger (Decision 0030) makes `user_profiles.activated_at`
  immutable, so the 7-day window can only be moved by inserting a backdated
  profile (integration test) — not by an `UPDATE`.
- No route, script, or lane touches a chain, a Provider write, or a Privy
  signer.

## Rollback

Remove `launch`, `mining`, `referral` from `V2_MODULES_ENABLED` (routes 404,
capabilities deferred) and leave `MINING_SNAPSHOT_ENABLED` off. The migration's
`down` refuses while data exists.

## Go/No-Go and the 02 integration checklist

Open items: the 02 contract document (ABI, addresses, audit, event names),
the USD1 address, PancakeSwap V3 parameters and LP locker policy, Mining
formula/weights/price guard/reward budget approval, the Tier mode
confirmation, and the Admin module with two-person review.

When 02 arrives, in order:

1. Migration: widen `launches_axes_unavailable_check` to the 02 enums; add
   the `launch_intents` digest version to `idempotency_records`; add the pool
   reference on `launches` once a project asset exists.
2. Indexer: a `launch_event` lane for the 02 event names
   (`SaleStateChanged`, `Purchased`, `SaleFinalized`, `BudgetsFrozen`,
   `RefundLiabilityFrozen`, `Refunded`, `VestingScheduleCreated`, `Claimed`,
   `PoolPrepared`, `LiquidityAdded`, `LPNFTLocked`, `LiquidityRetryScheduled`,
   `Paused`, `Unpaused`) writing `purchase_records`, `entitlements`,
   `refund_liabilities`, and the four-axis projection with
   `stateTupleDigest` + snapshot block.
3. Intent: `POST /v2/launch/{launchId}/intents` gains a prepare that binds the
   03 §8.2 fields and the tuple digest, with its own signing exit; still no
   sell/redeem.
4. Eligibility: the `tierModeV1` evaluators (whitelist / community /
   activity) against a snapshot block.
5. Economy: supply/distribution/tax from the contract, never from the
   prototype.

## Revision 2026-09-09 (S7 integration findings)

Source: `docs/integration/S7/report.md` §5.

- **`officialLinks` optional (finding 1).** `POST/PUT /v2/launch/projects`
  accept a `project` without `officialLinks`; omission equals four `null`
  links. `PUT` remains a whole-material replacement, so a client that wants to
  keep links must send them back.
- **Implicit `PREPARING` rows (finding 2).** `GET …/milestones` publishes the
  five 03 §8.4 tracks (`lbank/spot`, `binance/alpha`, `binance/perpetual`,
  `binance/spot`, `bithumb/spot`). A track without a stored row is projected
  as `{venueMilestoneId: null, state: "PREPARING", evidence: all null,
version: 0, updatedAt: null}`; nothing is written. Stored rows come first.
- **Transition table and script arguments (findings 3, 4).** The venue
  state machine and the `--evidence`/`--reviewer` pairing rule
  (`--observed-at` only with `--evidence`) are now in
  `docs/frontend-v2-launch-api.md` §4.8 / §6. No code change.
- Finding 5 (`pending_wallet` is the reachable referral state without a
  wallet) is recorded as expected behaviour.
