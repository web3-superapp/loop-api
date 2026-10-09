# Decision 0046: Mining walkthrough fixes — a slot names its own reason

- Status: Accepted (S22a, Development baseline still Decision 0043/0044).
- Date: 2026-09-16
- Scope: `GET /v2/mining/summary`, `GET /v2/mining/assets`,
  `GET /v2/mining/rank`, `GET /v2/mining/communities/{id}`, `GET /v2/referral`,
  and the shared community-weight fragment used by the community-side
  `miningPower` (Decision 0045). No path, no removed field, no migration.

## Context

The S22 simulator walkthrough (`docs/modules/S22-mining-walkthrough-fixes.md`)
found three places where the wire contract let a screen contradict itself
or withhold a fact it had:

1. The summary's `referralBoost` slot emitted `MINING_FORMULA_BASELINE_PENDING`
   ("no formula version in force") while, on the same page, `formula` said a
   version was in force. A page-level code had been aliased into one slot
   (`referralBoostPending` in `mining-contract.ts`), and `GET /v2/referral`'s
   `boost` slot did the same.
2. `GET /v2/mining/assets` rows carried only `assetId`; the client showed
   truncated addresses although the Asset Registry holds every symbol. The
   composition and ranking pages also had no way to draw the
   "development baseline" label that the summary draws from `formula.scope`.
3. A community with **no bound asset** got
   `weight: {unavailable, COMMUNITY_WEIGHT_PENDING_REVIEW, reviewStatus:
pending_review}` — "weight under review" — while its four standing blocks
   correctly said `COMMUNITY_ASSET_NOT_BOUND`. Nothing was under review.

## Rulings

| Topic                                     | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MINING_FORMULA_BASELINE_PENDING` meaning | Exactly "no approved and effective formula version". Emitted only where that is the fact: every slot when `resolveMiningBaseline` is `pending`, the summary/assets/rank `formula` block, the rules `baseline`, the snapshot worker's idle state, the `communityMining` capability and the community-side `miningPower` without the `mining` module (that deployment has no version), and the `mining`/`referral` capability **evidence** (the product formula is still not approved — the 02 freeze fact, unchanged by a development baseline). While a version is in force, **no slot on any mining read emits it**; asserted structurally in the route tests.                                    |
| `MINING_REFERRAL_BOOST_PENDING`           | New code for the referral boost slot only: the version in force (or the absence of one) does not approve the boost. Emitted by `GET /v2/mining/summary.referralBoost` and `GET /v2/referral.boost` (the referral contract now imports the mining constant rather than restating it). It says nothing about power, output, or rank.                                                                                                                                                                                                                                                                                                                                                                 |
| Audit of the other users of the code      | `community-contract.ts` `mining`/`miningPower` (community module composed without a mining reader — the deployment has no version), `product-policy.ts` `v2CommunityMiningUnavailableReasonCode` (module disabled or baseline pending), `mining-power-reader.ts` and `mining-service.ts` `pending` branches, `mining-snapshot-worker.ts` idle: all mean "no version". Unchanged.                                                                                                                                                                                                                                                                                                                   |
| `symbol` on composition rows              | Required key on every `included[]` and `excluded[]` row. Value is the Asset Registry's on-chain `symbol()` for the row's `assetId` (`BNB` for `eip155:56:native`, `chain_native` row), read through `ChainRegistryRepository.listAssets` in one query per page — the same rows the snapshot lane priced. `null` only when the registry has no row for the asset; the service never derives a symbol from an address, a chain slot, or a fixture. A registry that cannot answer fails the page closed (`503 CAPABILITY_UNAVAILABLE`), like a mining repository that cannot answer; the summary, rewards, rank, community, and rules reads do not touch the registry and are unaffected.             |
| `formula` on assets and rank              | Both responses gain a required `formula` block, **identical in shape and source** to `GET /v2/mining/summary.formula` (`formulaState` over the same `resolveMiningBaseline` result): `{status: approved, configVersion, effectiveAt, scope}` or `{status: unavailable, reasonCode: MINING_FORMULA_BASELINE_PENDING, pendingVersion}`. The task asked for a bare `scope`; the rank resource already uses `scope` for `users \| communities`, and a bare nullable scope cannot distinguish "product version" (`null`) from "no version". Publishing the summary's block avoids both problems and gives the client a decoder it already has.                                                          |
| `weight` for an unbound community         | `projectCommunityWeight` (the single builder shared with the community-side `miningPower`, Decision 0045) returns `{status: unavailable, reasonCode: COMMUNITY_ASSET_NOT_BOUND, reviewStatus: not_applicable}` when `boundAssetId` is null; `{…, COMMUNITY_WEIGHT_PENDING_REVIEW, reviewStatus: pending_review}` only for a bound community without an approved weight. `reviewStatus` stays a required key; its enum is now `pending_review \| not_applicable` (`communityWeightReviewStatuses`) and each value pairs with exactly one reason code. Dropping the key instead would have made the branch's shape depend on the reason code; a fabricated `pending_review` was the lie being fixed. |
| `unavailable` blocks elsewhere            | Every other `{status: unavailable, reasonCode}` block is byte-identical to S21. The no-version responses of assets and rank gain only the new top-level `formula` key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Consequences

- Client changes (S22b): decode `MINING_REFERRAL_BOOST_PENDING` on the
  boost slot with a sentence that speaks only of the boost; render
  `included[].symbol` / `excluded[].symbol` (fall back to the address only
  when `null`); draw the baseline label on the composition and ranking pages
  from `formula.scope`; accept `reviewStatus: not_applicable` with
  `COMMUNITY_ASSET_NOT_BOUND` on the weight block.
- `createMiningService` now requires a `registry` (`listAssets`); `buildApp`
  passes the composed chain registry repository, which is the unavailable
  stub only when no database is configured.
- Nothing about the formula, the snapshot lane, rewards, or the referral
  graph moves.

## Verification

- Unit: `test/v2-mining-routes.test.ts` — hand-written symbols (`Cake`,
  `LOOP`, `BNB`) on included and excluded rows; `null` for an asset the
  registry lacks and `503` when the registry cannot answer (summary still
  `200`); `formula` on assets and rank in both states; unbound weight block
  `COMMUNITY_ASSET_NOT_BOUND` + `not_applicable`, bound-pending block
  unchanged; `referralBoost` `MINING_REFERRAL_BOOST_PENDING` in both states;
  structural walk of seven mining reads under the approved baseline asserting
  no string equals `MINING_FORMULA_BASELINE_PENDING`.
  `test/v2-referral-routes.test.ts` — `boost` uses the new code.
- OpenAPI regenerated (`pnpm openapi:generate`); the shared weight fragment
  appears once per use site by design.
