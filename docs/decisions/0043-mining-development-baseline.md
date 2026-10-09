# Decision 0043: Mining development baseline (`miningFormula-devBaseline-2026-09-15`, now `-r2`)

- Status: Accepted (Development only); the product formula stays on the
  external Go/No-Go list until `02-合约产品方案` arrives. Revised by
  Decision 0044 (declared proxied prices, `-r2` version, listed zeros,
  `communityMining` never deferred).
- Date: 2026-09-15
- Scope: S20 backend. Lets the Development stack compute real Mining numbers
  from real inputs under a self-describing placeholder version, and makes the
  `communityMining` capability follow the formula fact instead of a constant.
  No migration: the formula document is jsonb and the operator paths write
  existing tables.

## Context

Decision 0036 seeded `miningFormulaV1-draft` with the right _shape_ (power =
holding × reference price × weight; daily output = share of network power)
and no parameters: `assetWeights: {}`, no community range, no budget. It also
left two constants that would never move: `product-policy.ts` published
`communityMining` as `unavailable(MINING_FORMULA_BASELINE_PENDING)` without
reading the database, and `community-service.ts` wrote `miningPower` as an
unavailable literal in three places. Even an approved formula could not have
turned a page on.

The user's ruling for S20: do not wait for approval; use existing formulas
where they exist and generic ones where they do not; ask only for what
genuinely cannot be computed. The main agent froze four points (A–D below).
Everything else in 0036 stays: production refuses every path here, missing
Providers fail closed, money is decimal strings, no fixture replaces a fact.
**The development baseline makes numbers computable; it does not make them
correct.**

## Rulings

| Topic                      | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Version identity        | A new row `miningFormula-devBaseline-2026-09-15` with `formula.scope = "development_baseline"`. `miningFormulaV1-draft` is untouched and stays `pending_approval` for the product V1 that 02 will define. The name is the user-facing rule label (red line 5), so it says what it is and contains no `V1`.                                                                                                                                                                                                                                                                                                                                                      |
| B. Asset weights           | Every registered, non-blocked BSC asset weighs exactly `1`. Without 02 any other number is invented economics; at weight 1 power degenerates to the USD value of the holding, which anyone can recompute from the snapshot row and which leaves no hidden bias when real weights replace it. The set is read from the registry by the operator script at creation time (today: BNB native, WBNB, USDT, Cake), never hard-coded.                                                                                                                                                                                                                                 |
| C. Community weight range  | Inclusive `[0.5, 2]`, pinned inside the version's `weightRange.community.range`. A community weight is written only through `pnpm mining:community-weight <communityId> <weight> --confirm`; no read path, lane, or repository defaults one. The range is a documented constant of this version, not a per-community judgement.                                                                                                                                                                                                                                                                                                                                 |
| D. Daily output budget     | `formula.dailyOutput = {status: "development_placeholder", budget: "1000000", unitKey: "mining.rules.dailyOutput.unit.loopTokenPending"}`. **One million placeholder units per day** is the only economic parameter, it is obviously a placeholder, it is read from the version row (so it is configuration under `configVersion`), and it retires with the row. Every estimate carries `budgetStatus: development_placeholder`.                                                                                                                                                                                                                                |
| Weight composition         | `power(account, asset) = holding × referencePriceUsd × assetWeight × communityWeight`, where the community factor applies only when exactly one community binds the asset and its weight is approved under the version in force. An asset the formula does not list is skipped (`MINING_ASSET_WEIGHT_NOT_CONFIGURED`); a bound asset whose weight is pending is skipped (`COMMUNITY_WEIGHT_PENDING_REVIEW`); two approved bindings on one asset skip it (`COMMUNITY_WEIGHT_AMBIGUOUS`). 0036's "asset weight _or_ community weight" is replaced: a community weight can never stand in for a missing asset weight, so the product draft still computes nothing. |
| Community power            | The non-banned members' power on the community's bound asset under the latest snapshot (the community factor is already inside each member's row). Requires a bound asset (`COMMUNITY_ASSET_NOT_BOUND`) and an approved weight under the version in force. `participants` counts members with positive power; `rank` is `rank()` among communities with positive power.                                                                                                                                                                                                                                                                                         |
| Account power and estimate | `power` = the account's total across its snapshot rows; `networkPower` = the snapshot total; `estimatedToday = budget × power ÷ networkPower`, exact rational arithmetic truncated to six fraction digits. Zero network power has no share (`MINING_NETWORK_POWER_ZERO`); an account without a snapshot row is `MINING_ACCOUNT_NOT_IN_SNAPSHOT`; a snapshot computed under another version is `MINING_SNAPSHOT_STALE`. `accumulated` and `claimable` stay `REWARD_AUTHORITY_PENDING`: no ledger row is ever written.                                                                                                                                            |
| Ranking                    | Every account in the snapshot (or every bound, weighted community): positive power first by `rank()` with shared positions on ties, zero power after it with `position: null` (Decision 0044); at most 100 rows. Alias only for a discoverable, non-anonymous, active profile; otherwise `mining.rank.anonymousMember`. A zero-power caller is `MINING_RANK_NOT_RANKED`; the community scope has no `myPosition` (`MINING_RANK_NOT_APPLICABLE`).                                                                                                                                                                                                                |
| Member and connection rows | `miningPower` on a member row or a connection is the subject's total power, published only when the subject's `privacy_preferences_v2.mining_power_visibility = 'everyone'` or the subject is the viewer; otherwise `MINING_POWER_PRIVATE`. A subject with no snapshot row is `MINING_ACCOUNT_NOT_IN_SNAPSHOT`.                                                                                                                                                                                                                                                                                                                                                 |
| Capability                 | `communityMining` is decided per request by `resolveMiningBaseline`: `unavailable(MINING_FORMULA_BASELINE_PENDING)` without the `mining` module or without an approved, effective version, `unavailable(MINING_RUNTIME_UNAVAILABLE)` without the repository or on a read failure, `available` otherwise; never `deferred` (Decision 0044). Its evidence is `notApplicable`; the 02 freeze stays on the evidence of `mining` and `referral`. The Decision 0038 baseline fixture is unchanged.                                                                                                                                                                    |
| In force                   | A version is in force when `status = approved` and `effectiveAt <= now`. `approveFormula` sets `effectiveAt = now`; a future `effectiveAt` written any other way keeps everything pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Operator paths             | `pnpm mining:dev-baseline --confirm` creates the row as `pending_approval` from the registry and refuses an existing one; `pnpm mining:approve-formula <configVersion> --confirm` (0036) approves it; `pnpm mining:community-weight <communityId> <weight> --confirm [--config-version <v>]` records a weight inside the range on a bound asset, once per asset per version; `pnpm mining:snapshot --confirm` runs the lane's `runOnce` with the worker's real repository, registry, and fresh-price reader. All four refuse `NODE_ENV=production` before opening a connection.                                                                                 |
| Price guard                | A fresh Provider price per asset. Native BNB's price is WBNB's and is accepted only because the version declares that proxy, carried as `proxied` on every row (Decision 0044, revising 0036).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Referral boost             | Still `MINING_FORMULA_BASELINE_PENDING`; edges are not validated to `valid` and no boost enters a power. Out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Migration path when 02 arrives

1. `pnpm mining:dev-baseline` is not run in any environment past Development;
   the product version is inserted by a migration (append-only) with its own
   `configVersion`, real `assetWeights`, the frozen community range, and a
   `dailyOutput` whose `status` is a new product value.
2. Approving the product version through the (then two-person) review path
   retires `miningFormula-devBaseline-2026-09-15` in the same transaction
   (`mining_formula_versions_one_approved_idx`); every snapshot under the dev
   baseline reads as `MINING_SNAPSHOT_STALE` until the lane computes under the
   product version, and every community weight reviewed under it reads as
   `pending_review` (weights are read per `configVersion`).
3. The `scope` field distinguishes the two on every projection, so a client
   that labelled the dev baseline needs no code change to stop.
4. Nothing written under the dev baseline is a fact a product path consumes:
   no ledger row, no reward, no referral validation.

## Consequences

- With the dev baseline approved, `GET /v2/meta/capabilities` gains one
  `available` entry (`communityMining`), every mining read publishes snapshot
  numbers, and `GET /v2/communities/{id}` / members / connections publish
  `miningPower` under the privacy rule.
- Today's Development inputs are real and small: the two active dev wallets
  hold zero of every registered asset on BSC mainnet, so the first snapshot is
  six rows of `0`, `networkPower = 0`, the estimate is
  `MINING_NETWORK_POWER_ZERO`, both rankings are empty, and every community
  has `boundAssetId: null` (`COMMUNITY_ASSET_NOT_BOUND`). Non-zero numbers
  require a funded dev wallet observed by the indexer and a community bound to
  a registered asset with a reviewed weight; neither is fabricated here.
- `listCommunityWeightInputs` now lists every bound community under a version
  (pending ones included) so the lane can exclude a bound asset whose weight
  is not yet reviewed instead of silently weighting it by the asset weight.
- `createV2CapabilitiesProjection` is asynchronous (one indexed read per
  request); the `V2ProductPolicyRuntime` gains `miningFormulaBaseline`.

## Verification

- `docs/frontend-v2-mining-api.md` §0 records the real Development runs of
  2026-09-15: the r1 row (six power rows, BNB excluded) and, after Decision
  0044, the r2 row with eight power rows at block `122037728`, two bound
  communities, and the projections read for account `3bb58597-…`.
- Unit: `test/mining-dev-baseline.test.ts` (documents, range boundaries
  `0.5`/`2` inclusive and `0.499…`/`2.000…1` outside, hand-computed shares
  `250000`, `333333.333333`, `0`, `25`, `1000000`, baseline resolution and
  probe), `test/mining-snapshot.test.ts` (weight composition and a
  hand-checked dev-baseline snapshot: `1081.17`, `249.925`,
  `0.00000000000000072078`, total `1331.09500000000000072078`),
  `test/v2-mining-routes.test.ts` (every read under the approved baseline,
  stale/future/zero/absent cases, capability flip pending → available →
  runtime-unavailable), `test/v2-community-routes.test.ts` (community,
  member, and connection `miningPower` with the privacy rule),
  `test/s7-operator-scripts.test.ts` (three new scripts: production refusal,
  `--confirm`, argument and range refusals).
- Integration: `test/s7-repositories.integration.test.ts` "development
  baseline" (create + duplicate, range/bound/conflict/version refusals,
  standings `1138.67` / `34.5000000000000001` / `0`, community standing `92`
  over non-banned members only, ranking with profile flags, member powers
  with visibility, balance asset IDs).
- Gate outputs are in the S20 report.
