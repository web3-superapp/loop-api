# Decision 0057: A Mining snapshot that cannot value a held asset is not published

- Status: Accepted (S51; fixes the 2026-09-20 finding that `GET /v2/mining/summary` published `power: 0` for an account whose on-chain USDT is 2.99)
- Date: 2026-09-20
- Scope: `mining-snapshot` lane, `mining_snapshots` (migration `000033`, append-only), `MiningRepository`, `resolveMiningBaseline`, the `snapshot` block of every mining read, the community-side `miningPower`, one operator script. No route is added or removed; every wire change is an added optional field or a new `reasonCode`.

## What happened (root cause, verified against the Development database)

Account `3bb58597-…` (wallet `d60627ca-…`) holds 2.99 USDT on BSC. `wallet_balance_snapshots` has that fact at every observed block, including `123001004`, `123001423`, and `123001455` (all after the incident). The lane does **not** read the chain: `listBalanceInputs()` takes the latest `wallet_balance_snapshots` row per active wallet and readable asset, so the BSC RPC outage of 13:4x Z did not remove any holding from the lane's inputs. The RPC reorder in `ops/api-dev.local.env` was therefore not a fix: the snapshots of 14:00, 14:05, 14:10, and 14:15 Z, computed after the reorder, still have no USDT row.

The missing row is a **price** read, and it has been failing since 2026-09-18 ~08:00 Z, not since 13:49 Z today:

| Hour (UTC)          | snapshots |      with a USDT row |
| ------------------- | --------: | -------------------: |
| 09-17 02 … 09-18 07 |   12 each |              12 each |
| 09-18 08 / 09 / 10  |        12 |            7 / 5 / 1 |
| 09-18 11 → 09-20 14 |   12 each | 0 (a handful of 1–3) |

The lane prices each formula-weighted asset through `readAssetPrice(asset, {requireFresh: true})` → DexScreener `/token-pairs/v1/bsc/{USDT}` → `selectPrimaryPair`, which by Decision 0036 accepts only a pair in which the asset is the **base** token ("a pair where the asset is only the quote is not a price of the asset"). Since 09-18 DexScreener's answer for USDT is a short list (the cached fact of 13:55:49 Z holds two pairs: `WBNB/USDT`, `USDT/USDC`) in which USDT is usually only the quote. When no USDT-base pair is returned, `pair` is `null`, the lane hands `priceUsd: null` to the pure computation, and `computeMiningSnapshot` **skipped the asset for every account and still published the snapshot as computed**. Snapshot `537e93ea-…` (block `123000110`, 13:51:26 Z) has three rows per account (native, WBNB, Cake, all `0`) and no USDT row; `getAccountStanding` sums the rows it has, so the summary answered `power: {status: "available", value: "0"}` and `networkPower: "0"` — "we could not value it" was published as "it is worth nothing". That is the red line (`00-主代理规则.md` §4.4: fail closed, no fake fact).

Two contributing gaps: the lane never persisted **why** an asset was skipped (the `skipped` list lived only in the run result), and the standalone worker logs nothing per tick, so nobody could see 90 consecutive incomplete runs.

## Decision

### Option (a): an incomplete run is recorded but never becomes the latest snapshot

Of the two options in the task (a: do not publish, fall back to the last complete snapshot and mark it stale; b: publish and mark each affected account's power unavailable), (a) is adopted:

- (b) would leave `networkPower`, both rankings, every community standing, and every member row reasoning about a partial total, and the stored `total_power` would be a number nobody may use. One invariant is simpler and safer: **a published snapshot values every positive holding it weights.**
- Every read path already resolves through `resolveMiningBaseline`, so the fallback to the last complete snapshot reaches the summary, the composition page, both rankings, `GET /v2/mining/communities/{id}`, and the community-side `miningPower` without per-page logic.

### Lane semantics

`computeMiningSnapshot` now separates two kinds of exclusion:

| Kind             | Reason codes                                                                                          | Effect                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Policy exclusion | `MINING_ASSET_WEIGHT_NOT_CONFIGURED`, `COMMUNITY_WEIGHT_PENDING_REVIEW`, `COMMUNITY_WEIGHT_AMBIGUOUS` | The version does not weight the asset; the snapshot is complete without it (unchanged, listed in `skipped`). |
| Unread holding   | `MINING_PRICE_NOT_FRESH`, `MINING_PRICE_PAIR_NOT_FOUND` (new), `MINING_PRICE_PROXY_NOT_DECLARED`      | A weighted asset with a **positive** observed balance that cannot be valued. The run is `incomplete`.        |

- `MINING_PRICE_PAIR_NOT_FOUND` names today's failure precisely: the Provider fact is fresh but lists no pair with the asset as base. Before, it was reported as `MINING_PRICE_NOT_FRESH`.
- A balance row with `rawValue = 0` for an asset that cannot be priced does not make the run incomplete: `0 × any price = 0`, nothing is zeroed by leaving it out. It stays in `skipped` with the price reason, exactly as before.
- An incomplete run is written to `mining_snapshots` with `status = 'incomplete'`, `unread_inputs = [{assetId, reasonCode}, …]`, `total_power = '0'`, `account_count = 0`, `price_version` null when no price was usable at all, and **no** `mining_snapshot_powers` rows (a trigger refuses them). The run result kind is `incomplete` with `MINING_SNAPSHOT_INCOMPLETE`; the standalone worker logs it at `warn` with the unread list; `pnpm mining:snapshot --confirm` prints it and exits 1.
- A complete run is unchanged except that `status = 'complete'` is now explicit.

### Reads

- `getLatestSnapshot()` returns the newest **complete** snapshot only. `getLatestSnapshotAttempt(configVersion)` returns the newest row of any status under a version.
- `resolveMiningBaseline` (all mining reads, the community projections) resolves, under the version in force:
  1. newest complete snapshot under the version → numbers from it; `stale = true` when a newer attempt under the version is `incomplete` or `invalidated`;
  2. no complete snapshot under the version and the newest attempt is `incomplete` → every number `unavailable(MINING_SNAPSHOT_INCOMPLETE)`;
  3. newest complete snapshot belongs to another version → `MINING_SNAPSHOT_STALE` (unchanged);
  4. nothing → `MINING_SNAPSHOT_NOT_AVAILABLE` (unchanged).
- The `snapshot` block (summary, rank, community; `source` on assets) gains two fields, always emitted, optional in the schema so the change is additive:
  - `stale: boolean` — a newer attempt under the same version did not complete; the numbers on the page are the last complete snapshot's and are older than the attempt.
  - `latestAttempt: {snapshotId, status: complete|incomplete|invalidated, computedAt, reasonCode: string|null, unreadInputs: [{assetId, reasonCode}]}` — the newest run under the version in force (the snapshot itself when not stale).
  - The unavailable `snapshot` variant gains optional `latestAttempt` (present when the version in force has an attempt but no complete snapshot).
- The community-side `miningPower` (community detail, member rows, connections) gains `stale: boolean` on both `available` shapes.
- `GET /v2/mining/assets.excluded[].reasonCode` prefers the reason recorded on the latest incomplete attempt for that asset over the re-derived one.
- **Nothing publishes `power: 0` because a read failed.** A zero is now only ever an observed zero balance.

### A wallet no snapshot includes yet (added the same day)

The device report of 14:34 Z (account `5d38f856-…`, wallet created 14:34 Z, `GET /v2/mining/summary` → `503 CAPABILITY_UNAVAILABLE`, correlation `51c0849a-…`) was checked against the API process of the day (pid 1214, started 13:55:27 Z): it logged every `/v2/mining/*` request as 200, the correlation ID never reached it, and after that account's bootstrap (14:30:32 Z) no mining request from it arrived at all — while `tunnel.log` shows the Cloudflare edge connection terminated at 14:33:37 Z and re-registered at 14:33:52 Z. Every per-account repository read (`getAccountStanding`, `listAccountPowers`, `listAccountBalanceAssetIds`, both rankings) was also run for that account against the Development database and answers normally (null / empty). The 5xx came from the edge during the reconnect, not from a query; the mobile side should check how a non-JSON 5xx is mapped (it surfaced as a LOOP-shaped `CAPABILITY_UNAVAILABLE` with a correlation ID the API never issued).

The reads are nonetheless made explicit for this case: `MiningRepository.hasActiveWallet(ownerUserId)` distinguishes an absent account with an active wallet — `MINING_SNAPSHOT_PENDING` ("shown after the next snapshot") on `power`, `estimatedToday`, `assets.totalPower`, `rank.myPosition`, and `communities/{id}.myContribution` — from one without any wallet, which keeps `MINING_ACCOUNT_NOT_IN_SNAPSHOT`. Member rows and connections keep `MINING_ACCOUNT_NOT_IN_SNAPSHOT` (no per-row wallet read). A route test walks the five reads for such an account and asserts `200` + `MINING_SNAPSHOT_PENDING` and no `CAPABILITY_UNAVAILABLE`; an integration test runs the repository reads for a fresh wallet with zero rows. Caveat for the copy: a wallet enters the lane's inputs only once `GET /v2/wallets/{walletId}/balances` has recorded a `wallet_balance_snapshots` row for it — "the next snapshot" includes it only after the wallet page has observed it.

### Repairing the Development data

Every snapshot published by the old writer while the USDT price was unreadable is a complete-looking row with a missing holding. The migration cannot tell them apart from honest rows (a row that lacks USDT because nobody held USDT looks the same), so it leaves `status = 'complete'` and provides an audited operator path:

`pnpm mining:invalidate-snapshots --after <snapshotId> [--reason CODE] --confirm` marks every complete snapshot computed after the given one as `invalidated` (`invalidated_at`, `invalidation_reason`, default `MINING_SNAPSHOT_PUBLISHED_INCOMPLETE`); explicit IDs are also accepted. An invalidated snapshot is never read as latest; `complete → invalidated` is the only transition the update trigger allows, and an `incomplete` row is immutable. Rows are never deleted (`mining_reward_ledger` may reference them).

For the Development stack the last honest snapshot is `43880746-17f3-43c3-8213-9e8033319093` (05:22:10 Z, USDT `2.99` at `0.9994` × `1.5` = `4.482309`); the 90 snapshots after it are all missing USDT. Commands, in order, after deploying this branch:

```sh
pnpm db:migrate
pnpm mining:invalidate-snapshots --after 43880746-17f3-43c3-8213-9e8033319093 --confirm
pnpm mining:snapshot --confirm      # exit 0 = complete snapshot written; exit 1 + "incomplete" = USDT still unpriced, summary stays on 43880746 with stale=true
```

Until DexScreener returns a USDT-base pair (or the pricing rule below is changed), every tick records an incomplete attempt and every read shows the 05:22 Z snapshot with `stale: true` and `latestAttempt.unreadInputs = [{USDT, MINING_PRICE_PAIR_NOT_FOUND}]`. That is the intended fail-closed state, not a bug.

### Not decided here (main agent)

- **Pricing a stablecoin that is the quote of its own deepest pairs.** _(Decided 2026-09-21 by Decision 0059 — see the addendum below.)_ Options: (1) keep the base-only rule (today; USDT stays unread whenever DexScreener omits `USDT/USDC`); (2) let a formula version declare a reference pair per asset (`referencePairs: {assetId: pairAddress}`) read through `/latest/dex/pairs/bsc/{pair}` — deterministic, no inversion, one more declared fact like `priceProxies`; (3) invert `priceUsd / priceNative` of a quote pair — derived, refused by Decision 0036 unless the price-guard rules of 03 §19 allow it. This decision implements none of them.
- Whether `stale` should also carry a maximum age after which the fallback snapshot is withdrawn. Today the client has `computedAt` and `latestAttempt.computedAt`.

## Consequences

- The dev baseline's "two wallets hold zero" fact is unaffected: a zero balance is still a `0` row.
- `MiningSnapshotRunResult` gains `unread`; `MiningRepository` gains `getLatestSnapshotAttempt`, `writeIncompleteSnapshot`, `invalidateSnapshots`; fakes in tests provide them.
- `mining_snapshots.price_version` is nullable (only for `incomplete` rows, by constraint).
- The rollback of `000033` refuses while any non-complete row exists.

## Addendum 2026-09-21 (Decision 0059: declared reference pricing)

The open item above is resolved by **Decision 0059**, which adopts a guarded
form of option (2)+(3): a formula version may declare, per asset, a
`referencePricing` rule — `{kind: "stable", pegUsd, guardBps}` or
`{kind: "pair", pairAddress}`. Under a `stable` rule, and only when the
base-token rule of Decision 0036 finds nothing, the price may be inverted out
of the deepest pair in which the asset is the _quote_ token
(`priceUsd / priceNative`) and is accepted only inside the declared band. An
asset without a rule keeps the base-only rule unchanged.

What does **not** change in this decision:

- An out-of-band derived price is still an **unread holding**: the reason code
  stays `MINING_PRICE_PAIR_NOT_FOUND`, the run is still `incomplete`, and the
  reads still fall back to the last complete snapshot with `stale: true`. The
  peg is a guard, never a published price.
- `power: 0` is still only ever an observed zero balance.

What is added: a power row carries `reference_price_quality = 'derived'` and
`reference_price_pair_address` (migration `000034`), and the wire gains
`referencePricePairAddress` plus the enum value `derived` on
`referencePriceQuality`.

The Development repair sequence of the section above is therefore extended:
after `pnpm db:migrate` and the invalidation, write and approve the r3
baseline (`pnpm mining:dev-baseline --confirm`,
`pnpm mining:approve-formula miningFormula-devBaseline-2026-09-15-r3 --confirm`)
and then run `pnpm mining:snapshot --confirm`. Under r3 the 2026-09-20
Provider answer values USDT at ≈ `0.9995` (inside ±2 % of `1`) and the lane
writes complete snapshots again.
