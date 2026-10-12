# Decision 0125: Mining and launch2 follow-ups of the S138 run (S148-api)

- Status: Accepted (S148-api), Development / BSC Testnet only. Patched by Decision 0129 §2 (S157-api, 2026-10-12): `meme_transfers_complete_at` is set only after the deploy-block mint and non-negative balances are verified; a log answer without a deploy-block mint is `LAUNCH2_RPC_LOGS_UNTRUSTED`.
- Date: 2026-10-11
- Baseline: `integration/v2` = `1b2b426`
- Inputs: `docs/integration/S138/report.md` (defects D1 / D2 / D3, observations ② ③),
  `docs/12-需求方交接对照与合并方案.md` (S145-api rulings ① ② ③, S147-api ruling on
  post-graduation balances), `docs/16-挖矿与邀请-中心化结算方案.md` §1.8 / §7, Decisions 0033
  (Asset Registry), 0097 (community bound asset), 0114 (launch2 lane), 0116 (hourly settlement),
  0122 (review rejections), 0123 (quantity weighting, claim gate).
- Scope: migration `000069_mining_and_launch2_followups`; `launch2_event` lane; mining settlement
  facts / runner; `GET /v2/mining/rewards` (`hourly`), `GET /v2/mining/rewards/epochs`;
  `POST` / `PUT /v2/launch/projects` (`communityId`); new console route
  `POST /admin/v1/launch/projects/{projectId}/materials/{materialVersion}/approve`; console
  project projection. No new capability, no new env.

## 1. Entities and IDs (migration 000069)

| Object                                     | Key                                       | Notes                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch_projects.community_id`             | `communities.community_id` (opaque UUID)  | Nullable; owner-only at save time                                                                                                           |
| `launch_project_approvals`                 | `approval_id` = Idempotency-Key (UUID)    | Append-only; `unique (project_id, material_version)`; a trigger refuses approving a rejected material version and rejecting an approved one |
| `launch2_meme_transfers`                   | `(chain_id, transaction_hash, log_index)` | Raw MEME ERC-20 `Transfer` facts, `removed` on reorg rewind; `instance_id` FK                                                               |
| `launch2_instances.meme_transfers_*`       | —                                         | `target_block` (the block the one-time re-scan must reach), `complete_at`                                                                   |
| `launch2_instances.community_binding(_at)` | —                                         | One automatic binding attempt and its outcome                                                                                               |
| `public.assets` row of a MEME              | `asset_id = eip155:97:<meme>`             | Same shape as `pnpm asset:register` (`chain_call`, `pending`, observed block); never a primary key by address elsewhere                     |

Wallet / token addresses stay facts, not keys: the registry row's ID is the existing
`chainId:address` asset ID scheme (Decision 0033); joins use instance / project / community IDs.

## 2. D1 (High): launch2 MEME → Asset Registry + community binding

- After each tick the `launch2_event` lane lists instances whose `LaunchDeployed` is indexed
  (`deployed_event_seen`) and whose MEME has no registry row **or** whose binding was never attempted
  (≤ 50 per tick). For a missing row it reads `symbol()` / `name()` / `decimals()` pinned to one block
  (`createLaunch2TokenIdentityReader`, launch slot RPC), checks the `assets` constraints, and inserts
  `status = pending`, `source_kind = chain_call`, `source_block_number` = that block
  (`on conflict do nothing` — a fixture / operator / blocked row is never changed). Legacy-factory
  instances (read-only indexing) are included: they are rows of the same table.
- In the same transaction, once per instance: if the project names a community and the asset row is
  not `blocked`, the community row is locked; it is bound (`bound_asset_key = asset ID`,
  `record_version + 1`, a `community_role_events` operator row `community_profile_updated` /
  `launch2_asset_auto_bound`) only when it is unbound, not rejected, and the **instance owner is its
  active owner**. Outcome on the instance: `bound | already_bound | conflict | not_owner |
community_unavailable | asset_blocked | none`. An existing binding is never overwritten.
- Failures: an unreadable identity → warning `LAUNCH2_ASSET_IDENTITY_UNAVAILABLE`, an identity that
  violates the registry constraints → `LAUNCH2_ASSET_IDENTITY_INVALID`; both retried next tick, the
  lane keeps indexing. Database errors follow the lane's backoff.
- **The two dev instances**: nothing to run. The first tick of a worker built from this branch
  (with `LAUNCH2_INDEXER_ENABLED`) registers both MEMEs (and makes the binding attempt; their projects
  have no `community_id`, so the outcome is `none` until a project names one before deployment —
  existing projects are approved, so their owners bind communities through the existing community PATCH,
  which now passes `ASSET_NOT_REGISTERED`). If the S138 SQL fixture rows exist they are kept as they are.

## 3. Post-graduation balances (S147 ruling, S138 observation ③)

- The lane adds each instance's MEME address with role `meme` (`erc20Abi` `Transfer`; the generated
  MEME ABI lists no events). `getLogs` itself is unchanged; the worker routes `meme` logs to
  `launch2_meme_transfers` (not `launch2_events`, whose `Transfer` rows are the NFT's).
- Coverage: an instance with `meme_transfers_target_block` null makes the tick start at its deploy
  block (like a late-registered instance; idempotent upserts) and records target = the checkpoint it
  had reached (or the segment end when seeding). `complete_at` is set when a committed checkpoint
  reaches the target.
- Settlement facts: for a graduated launch2 asset, an hour whose end is after `complete_at` gets
  `postGraduation = {from = max(graduation, hourStart), openingBalances (Σ transfers before from,
mint / burn address excluded), moves in [from, hourEnd)}`. The runner adds those balances as asset
  segments for `[from, hourEnd)` **under quantity slices only** and does not list the asset in
  `excludedAssets`. Pre-graduation balances still come from curve trades (exact: MEME cannot leave the
  curve before graduation). A valuation (pre-0123) hour, or an hour that ended before coverage
  completed, keeps the 0123 behaviour (`MINING_ASSET_GRADUATED_UNREADABLE`), so every hour already
  settled replays to its stored digest.

## 4. D2: `GET /v2/mining/rewards/epochs`

`listUserEpochRewards` leaves out rows with `nft_total_power = 0`, `asset_total_power = 0` and
`total_reward_raw = 0`. Same cursor, same page size.

## 5. D3 and `displayState`: `GET /v2/mining/rewards` → `hourly`

- **displayState** (S138 observation ②, main-agent ruling): `awaiting_first_settlement` (existing
  enum value) until the caller has one settled hour with power or reward (or a settled balance);
  then `displaying` / `settling` from the network's newest settled hour as before. While awaiting,
  `lastHour`, `display`, `tracks` are `null` (the pre-first-settlement shape the 0141 codec already
  accepts); `totals`, `referral`, `parameters` unchanged. The claim gate's `MINING_NOTHING_SETTLED`
  uses the same per-user fact.
- **Claim gate**: when every 0123 condition holds, the service reads `LoopRewardClaim.paused()`
  (`readFunding`). Appended to the 0123 order:

  | #   | reasonCode                       | When                                      |
  | --- | -------------------------------- | ----------------------------------------- |
  | 8   | `MINING_CLAIM_CONTRACT_PAUSED`   | `paused()` is true                        |
  | 8   | `MINING_CLAIM_CHAIN_READ_FAILED` | the contract cannot be read (fail closed) |

  **Deviation from the task text** (`CLAIM_CONTRACT_PAUSED`): the existing code
  `MINING_CLAIM_CONTRACT_PAUSED` (prepare's 503) is reused, because the App's
  `miningClaimUnavailableText` already maps it to「领取合约已暂停，暂不能领取」; a new code would
  render the generic text. `MINING_CLAIM_CHAIN_READ_FAILED` already existed (prepare); the App shows
  the generic「领取暂不可用」.

## 6. Catalog material approval (S145 ruling ①)

`POST /admin/v1/launch/projects/{projectId}/materials/{materialVersion}/approve`, body
`{reason}`, `Idempotency-Key` = `approvalId` = ops `operationId`, `launch.approve` (reviewer only),
mirroring `versions/{version}/approve`. New ops command `launch.project.approve`
(`{materialVersion}`): owner refused (`OPS_SELF_APPROVAL`), status must be `submitted` /
`in_review` (`OPS_LAUNCH_NOT_IN_REVIEW`), CAS on `material_version` (`OPS_VERSION_CONFLICT`). It does
what `pnpm launch:review <id> approve` does — `approved`, `review_reason_code =
operator_manual_review`, the catalog `launches` row on `LAUNCH_CHAIN_ID` (repository option
`launchChainId`) — plus the `launch_project_approvals` row, a `launch_review_events` operator row,
`ops_operations` / `ops_audit`, and the console's `.requested` / `.decided` / `.failed` admin audit.
Errors: 400 / 403 / 404 / 409 (`OPS_LAUNCH_NOT_IN_REVIEW`, `OPS_VERSION_CONFLICT`,
`OPS_IDEMPOTENCY_CONFLICT`) / 422 `ADMIN_REASON_TEXT_INVALID` / 503.

## 7. Community on the project (S145 ruling ③)

- `POST /v2/launch/projects` top-level / `PUT …` `project.communityId`: UUID or null. Create: absent
  or null = none (only a named community enters the idempotency digest, so old digests are
  unchanged). Replace: absent = keep, null = clear. A new value must be a non-rejected community whose
  active `owner` membership is the caller: else `422 VALIDATION_FAILED` /
  `LAUNCH_COMMUNITY_NOT_OWNED` (also for a missing community: no enumeration).
- v2 projection: `project.communityId` **present only when set** — the 0141-era App decodes the
  project with a strict key set, so unbound projects keep their exact shape.
- Console summary (list and detail): `materialApproval`, `communityId`, `community {communityId,
name, verificationStatus, boundAssetKey, binding}` — for the `community_binding_mismatch` review.

## 8. Unavailable behaviour

- No launch2 lane (flag off / no RPC / no factory): nothing is registered or indexed (unchanged
  idle reasons). No `launch2MemeAssets` repository: the lane indexes but registers nothing.
- Identity read failure: warning, retry next tick (never a guessed symbol).
- Transfer coverage incomplete: post-graduation balances are not used (asset excluded from
  graduation on, `MINING_ASSET_GRADUATED_UNREADABLE`), never zero-filled.
- Claim contract unreadable: `executable: false` / `MINING_CLAIM_CHAIN_READ_FAILED`.
- Material approval without the review repository: 503 `HOOKS_LAUNCH_REVIEW_UNAVAILABLE`.

## 9. Client impact

- loop-mobile: no new key in `GET /v2/mining/rewards`; a new user now sees
  `awaiting_first_settlement` (existing enum). `project.communityId` appears only on projects that
  name a community — the App must add it to its project key set before offering the picker.
- loop-admin: one new button / route; three new summary keys (always present).

## 10. Evidence

`test/launch2-indexer-worker.test.ts` (meme role, transfer routing, one-time re-scan, registration
warnings), `test/mining-hourly-runner.test.ts` (post-graduation segments, coverage / valuation
fall-backs), `test/v2-mining-rewards-routes.test.ts` (own first hour, paused / unreadable contract,
zero-power epochs), `test/v2-launch-routes.test.ts` (`communityId`), `test/admin-role-routes.test.ts`
(material approval), `test/mining-launch2-followups-migration.test.ts`, and on PostgreSQL
`test/mining-launch2-followups.integration.test.ts` + `test/mining-settlement.integration.test.ts`
(D2). No BSC Testnet run in this batch.

## 11. Legacy snapshot channel by quantity (main-agent ruling, from S148-mobile)

0123 changed only the hourly settlement; the S7 snapshot lane (`mining-snapshot.ts`, read by
`/v2/mining/summary`, `/v2/mining/assets`, `/v2/mining/rank`, community power) still computed
`holding × referencePriceUsd × weight`, so `included[].power` disagreed with the App's
「持有量 × 权重」.

- `computeMiningSnapshot`: `power = holding × weight`. The reference price is still selected and
  published on each row (`referencePriceUsd / Quality / ProxyAssetId / PairAddress`, the
  `priceVersion`), but it no longer multiplies the power.
- `GET /v2/mining/summary` and `GET /v2/mining/assets` carry a new required key
  `assetPowerBasis: "quantity"` (both the available and the unavailable shapes). **Strict clients
  must add the key** (S148-mobile).
- `GET /v2/mining/rules`: `expressionKey` is projected as
  `mining.rules.formula.holdingTimesWeight`; a stored version carrying the retired
  `mining.rules.formula.holdingTimesReferencePriceTimesWeight` is mapped (stored documents and the
  dev-baseline version are not rewritten, so no re-approval is needed). `priceGuardRules` stays in the
  response (schema-required, strict clients) and is marked **deprecated** in the schema: it only
  governs which observed price is published, never the power.
- Snapshots already stored keep the power they were computed with until the lane writes the next
  snapshot (its normal cadence); nothing is recomputed in place.
- Known limit (kept fail-closed): a weighted asset with a positive holding and no usable price still
  makes the snapshot `incomplete` (Decision 0057), because the power row stores a non-null
  `reference_price_usd`. Dropping that requirement needs a nullable column and a schema change —
  listed below.

## 12. Open items (not implemented here)

1. Snapshot lane: allow a power row without a reference price (nullable `reference_price_usd`, the
   four `referencePrice*` response fields nullable) now that the price does not enter the power.
2. S146-mobile: `GET /v2/launch2/me/positions` and the instance detail `viewer` lack the wallet's
   post-graduation MEME balance — suggested `memeBalance` (raw string, read at one block; the
   `launch2_meme_transfers` facts of this batch can also back it).
3. S146-mobile: per-wallet external-pool (official v4 pool) trade history; the read model does not
   index pool swaps yet (S146-api scope).
4. A material approval by the dev CLI (`pnpm launch:review`) writes no `launch_project_approvals`
   row, so `materialApproval` stays null for those projects.
5. Main-agent ruling (2026-10-11): projects already approved — including the two dev instances —
   get **no** after-the-fact way to set `communityId`. Their communities are bound by hand (the
   community owner sets the bound asset through the existing community edit, which accepts the MEME
   once this lane has registered it).
