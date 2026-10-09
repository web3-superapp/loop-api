# Decision 0044: Declared proxied reference prices, listed zeros, and the `communityMining` gate

- Status: Accepted (revises Decision 0036 "Snapshot skeleton" and Decision 0043
  "Capability", "Ranking")
- Date: 2026-09-15
- Scope: S20 follow-up (main-agent rulings of 2026-09-15). Migration
  `000028_v2_mining_reference_price_quality` (two columns on
  `mining_snapshot_powers`, append-only). Baseline version bumped to
  `miningFormula-devBaseline-2026-09-15-r2`.

## Context

Decision 0036 made the `mining-snapshot` lane refuse every proxied price:
"a proxied (native) price is refused; the lane never substitutes an asset".
The one proxied price on BSC is native BNB's, which the market fact service
reads as WBNB's pair price and publishes as `quality: proxied` with the proxy
named (Decision 0034). Under that rule BNB — the chain's own asset — could
never enter a snapshot, and the first Development snapshot of Decision 0043
showed exactly that (`excluded: [native, MINING_PRICE_NOT_FRESH]`), with the
wrong reason code on top: the price was fresh, it was merely proxied.

The main agent ruled that a WBNB proxy for BNB is acceptable — it is a 1:1
wrapper at the contract level and the chain's common practice — on three
conditions: it is marked `proxied` end to end so a screen can say where the
price came from; freshness is judged on the proxy's own observation time;
and the proxy relation lives in the version document, not in code.

Two smaller rulings arrived with it: `communityMining` must never read
`deferred` (that word is reserved for things LOOP chose not to build), and
the Decision 0038 baseline fixture must stay byte-identical. And the first
real run under 0043 showed that a ranking of "positive power only" renders
an honest zero as an empty list, which explains nothing.

## Rulings

| Topic                       | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared proxy              | A formula version may carry `formula.priceProxies: { [assetId]: proxyAssetId }` (an asset cannot proxy itself). The pure computation accepts a price read through a proxy only when the version declares exactly that proxy for that asset; any other proxy — or a proxied fact without a named proxy — is skipped with the new `MINING_PRICE_PROXY_NOT_DECLARED`. The development baseline declares `eip155:56:native → eip155:56:0xbb4c…` (WBNB) only when both are registered.      |
| Freshness                   | Judged on the Provider fact's own `fetchedAt` — for BNB that is WBNB's observation. A stale proxy is `MINING_PRICE_NOT_FRESH` whether or not it is declared; a fresh, declared proxy is used. The lane no longer decides usability; it reports `quality`, `fetchedAt`, and `proxyAssetId`, and the computation decides against the version.                                                                                                                                            |
| End-to-end marking          | Every `mining_snapshot_powers` row carries `reference_price_quality` (`fresh` \| `proxied`) and, when proxied, `reference_price_proxy_asset_id` (FK to `assets`, must differ from `asset_id`; the pair is constrained to agree). `GET /v2/mining/assets.included[]` publishes both as `referencePriceQuality` / `referencePriceProxyAssetId`. Existing rows default to `fresh`, which is true of them: a proxied price could not reach the table before this decision.                 |
| When a proxy stops being OK | The declaration is per version, so it retires with the version. It must not be carried into a product version if 02 names a different BNB price source, if the wrapper ever stops being 1:1 (a depeg, a migration of WBNB), or if the price-guard rules (TWAP, multi-source, liquidity cap) are frozen and the proxy's pair fails them. A declared proxy is never applied to any asset other than the one it is declared for.                                                          |
| `communityMining`           | Never `deferred`. Without the `mining` module, without its runtime, or without an approved and effective version it is `unavailable` — `MINING_FORMULA_BASELINE_PENDING` for the first and last, `MINING_RUNTIME_UNAVAILABLE` for a missing repository or a failed read — and `available` once a version is in force. Its evidence is `notApplicable` in every state; the product-freeze evidence stays on `mining` and `referral`. The Decision 0038 fixture is byte-identical again. |
| Listed zeros                | Rankings list every account in the snapshot (users) and every bound community with an approved weight under the version in force (communities): positive power first by `rank()`, then zero power with `position: null`. `participants` still counts positive power only. A structured zero — with its weight, bound asset, and display rule — replaces an empty list that could not say why.                                                                                          |
| Estimate labelling          | `estimatedToday` carries `scope` beside `formulaVersion`, `budget`, and `budgetStatus`, so the placeholder budget never appears without the version that owns it.                                                                                                                                                                                                                                                                                                                      |
| Baseline `-r2`              | The document of an approved version is immutable, so adding `priceProxies` meant a new version: `miningFormula-devBaseline-2026-09-15-r2`. Approving it retired `…-2026-09-15` through the normal one-approved index; the r1 snapshot reads as stale, its weights (none) as pending. The retired row stays as history.                                                                                                                                                                 |
| Fabricated inputs           | Unchanged and hardened: `wallet_balance_snapshots` has no provenance column, so a written row is indistinguishable from a chain observation. No test, script, or seed writes one against the Development database; the Development numbers are zero because the wallets hold zero.                                                                                                                                                                                                     |

## Consequences

- The Development snapshot now holds eight rows (2 wallets × Cake, USDT,
  WBNB, BNB); the BNB rows read `reference_price_quality = proxied`,
  `reference_price_proxy_asset_id = eip155:56:0xbb4c…`, and the same
  `713.42` USD as the WBNB rows at the same `fetchedAt`.
- Two verified communities were bound through the product write path
  (`updateCommunity`, the `PUT /v2/communities/{id}` command, run as each
  owner): `mock-defi-morning → Cake` at weight `0.8`, `builders-guild → USDT`
  at weight `1.5`. The range refused `0.49` and `2.01` and accepted `0.5`,
  `2`, and `0.8`. Every Cake and USDT row in the snapshot now carries the
  community factor (`weight 0.8` / `1.5`).
- With zero holdings, `GET /v2/mining/rank` lists two accounts and two
  communities at `position: null`, `GET /v2/mining/communities/{id}` shows
  the weight, `communityPower 0`, `participants 0`, `rank MINING_RANK_NOT_RANKED`;
  `GET /v2/communities/{id}.miningPower` is `{available, "0", snapshotId,
formulaVersion, computedAt}`.
- Finding for the main agent: the community detail card's `miningPower`
  alone cannot say _why_ it is zero (no weight, no participant count); the
  explanation lives one tap away on `GET /v2/mining/communities/{id}`.
  Adding `participants`/`weight` to that projection is a contract choice
  for the next module pass, not made here.
- Finding for the mobile repository: `LoopV2S7Codec.unavailable` decodes
  every mining metric strictly as `{status: unavailable, reasonCode}` and
  calls `invalid()` on anything else, so today's client cannot render an
  `available` number at all (it will fail the contract on the summary once
  this branch is deployed) — hence no screen shows a number without its
  version today, and the `formula` block already sits on the summary
  screen for when it does.

## Verification

- Unit: `test/mining-snapshot.test.ts` (declared proxy `0.25 × 720.78 =
180.195` carried as `proxied`; undeclared proxy, wrong proxy, and stale
  proxy refused), `test/mining-snapshot-worker.test.ts` (a declared proxy is
  written with its quality; an undeclared one idles with
  `MINING_PRICE_PROXY_NOT_DECLARED`), `test/mining-dev-baseline.test.ts`
  (proxy declared only when both assets are registered; self-proxy
  refused), `test/v2-mining-routes.test.ts` (quality on `included[]`,
  listed zero-power community, `scope` on the estimate, capability never
  deferred), `test/v2-mining-reference-price-migration.test.ts`,
  `test/v2-chain-wallet-routes.test.ts` (fixture byte-identical).
- Integration: `test/s7-repositories.integration.test.ts` writes and reads a
  proxied BNB row, refuses a proxied row without a proxy, and lists a
  zero-power account at `position: null`.
