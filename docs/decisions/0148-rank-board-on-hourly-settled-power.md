# Decision 0148: Power ranks on the hourly settled power, mining power visible to everyone by default (S205-api)

- Status: Accepted (S205-api), Development / BSC Testnet only
- Date: 2026-10-16
- Baseline: `integration/v2` = `b59c3bf`
- Inputs: user ruling 2026-10-16 after the staging device walk-through; Decisions 0043
  (Ranking, Community power), 0049 (rank privacy projection), 0100 (rank cursor, `me`), 0116 /
  0123 (hourly settlement, `mining_epochs`, `mining_epoch_rewards`), 0015 migration
  (`privacy_preferences_v2.mining_power_visibility`).
- Scope: `GET /v2/mining/rank` (`scope=users|communities`; `referrals` unchanged), migration
  **000087**, the privacy default (`GET /v2/profile/privacy` version-0 projection, missing-row reads
  in the rank and member rows). No new route, table, error code, reason code, environment key or
  capability. **No response field is added, removed or renamed**; OpenAPI v2 regenerated for
  descriptions only.

## Context

On staging (2026-10-16) both power boards showed 0 for everyone and every row "not ranked":

- The rank read only the snapshot lane (`mining_snapshots` / `mining_snapshot_powers`, the coin
  track holdings snapshot). Nobody on staging holds an admitted asset and the first MEME list is
  empty, so every snapshot total has been 0 since 2026-10-10.
- The NFT track power exists only in the hourly settlement: today's `mining_epochs` row has
  `denominator_nft_power = 5.43`, and 7 of its 12 users have `nft_total_power > 0`. The rank never
  read it.
- Every other account's power read "only visible to the owner": `mining_power_visibility` defaults
  to `self` (000015), and a missing privacy row read as `self`.

The user ruled both shall change. The local dev database shows the same picture (latest settled
hour `2026-10-16T03:00Z`, 9 rows, 7 with power: 1.725 / 1.65 / 1.5 / 0.27 / 0.15 / 0.09 / 0.045).

## Decision

### 1. Source: the newest settled hour

`MiningRepository.getLatestRankEpoch()` = the `mining_epochs` row with `status = 'settled'` and the
greatest `hour_start` (index `mining_epochs_recent_idx`), with its parameter version's
`config_version`. `pending`, `settling` and `failed` hours are never read. Both ranks of one
response read the same epoch.

### 2. Users

- Power = `nft_total_power + asset_total_power` of the account's `mining_epoch_rewards` row (self
  and five-level referral power of both tracks), PostgreSQL `numeric` over the stored decimal
  strings, published as a normalised decimal string (no JS `number`).
- Every account with a row in the epoch is listed. Ordering, ties, zero power and keyset are those of
  Decisions 0043 / 0044 / 0100 unchanged: `rank()` over positive power (shared positions on ties),
  zero power after them with `position: null`, keyset `(total desc, ownerUserId asc)`.
- `participants` = accounts with positive power in the epoch. `me`, `myPosition`, `display` and
  `powerVisibility` (Decision 0049) unchanged.
- An account without a row in the epoch had no power in that hour (no holding, no powered
  invitee): `myPosition = MINING_RANK_NOT_RANKED`, `me: null`. It is no longer
  `MINING_SNAPSHOT_PENDING` / `MINING_ACCOUNT_NOT_IN_SNAPSHOT`, which describe the snapshot lane.

### 3. Communities

`mining_epoch_rewards.nft_holdings` is `[{instanceId, communityId, countAtEnd, power}]`: the NFT
**self** power per instance, already `count × coefficient(community)` and already tagged with the
community whose bound asset is the instance's MEME (`null` = unbound, coefficient 0). It splits by
community exactly. Referral NFT power is stored per level as `nftPower` plus
`nftUnitsByCommunity: [{communityId, units}]` (equivalent NFT units = `count × ratio`); its
community part is `units × coefficient`. `asset_holdings` is `[{assetId, balanceAtEndRaw, power}]`;
asset referral power is stored per level only, never per asset.

Community power over the epoch = Σ over the community's **non-banned** members (0043 rule) of

1. `nft_holdings[].power` where `communityId` = the community, plus
2. `trunc(Σ referral_levels[].nftUnitsByCommunity[communityId = the community].units × coefficient, 18)`,
   plus
3. `asset_holdings[].power` where `assetId` = the community's `bound_asset_key` (0043's coin track
   rule, now on the hour's holdings).

- `coefficient` (published as `weight`) = the community's entry in the epoch version's
  `communityCoefficients`, else its `defaultCommunityCoefficient`, else 0 — the calculator's rule.
  The epoch version is the one in force at the hour start (`mining_epochs.version_id`).
- Listed: every community with a bound asset. The approved snapshot weight
  (`community_mining_weights`) is no longer a precondition: the hourly settlement weights NFTs by
  the parameter version, not by that table (on dev the only community whose NFTs carry power,
  `S138 QA MEME Mining`, has no `community_mining_weights` row and was invisible before).
- `participants` per row = members with positive community power; the top-level `participants`
  stays the count of ranked rows on the page (0100). Ordering / keyset
  `(power desc, name asc, communityId asc)` and `me` (best-ranked non-banned membership) unchanged.

Differences to state, all by construction:

- **Asset referral power is not counted** for any community (no per-asset breakdown exists). It
  still counts on the users rank. The asset track is 0 on dev and staging today.
- Part 2 is exact while the coefficient does not change inside the hour; when a parameter version
  with another coefficient takes effect mid-hour (`input_summary.versionIds` has more than one id)
  it uses the coefficient at the hour start. Truncation to 18 decimals matches the stored powers.
- An NFT counts for a community only through members: the holder's self part if the holder is a
  member, the inviter's referral part if the inviter is a member. Σ of community powers is
  therefore not Σ of account powers. On dev the three holders of `S138 QA MEME Mining` NFTs are not
  members; its one member gets 0.15 from referrals, so the board shows that community at 0.15 and
  every other at 0.

### 4. `snapshot` block (shape unchanged)

For `users` / `communities` the `snapshot` slot describes the ranked hour in the existing
`MiningSnapshotProjection` shape, so `MiningSnapshotComputed` keeps decoding it:

| Field            | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| `snapshotId`     | `epochId` (UUIDv4)                                             |
| `computedAt`     | `hour_end`                                                     |
| `blockNumber`    | `"0"` (an hour has no single block)                            |
| `blockHash`      | `0x` + the hour's `input_digest` (SHA-256 of the inputs)       |
| `formulaVersion` | the parameter version's `config_version`                       |
| `priceVersion`   | `mining_hourly:<hour_start ISO>` (the epoch's idempotency key) |
| `stale`          | `false` (a settled hour is immutable)                          |
| `latestAttempt`  | `{snapshotId: epochId, status: complete, computedAt: hourEnd}` |
| `holdingsSource` | `chain` (settlement reads indexed chain facts only)            |

`computedAt = hour_end`, not `settled_at`: the power is the average over `[hour_start, hour_end)`,
so the end of the window is the instant it describes; it is the same anchor the minute display of
`GET /v2/mining/rewards` uses (Decision 0116), and it is a whole hour, which is what the board's
「快照 MM-dd HH:mm」 kicker prints. `settled_at` is a few minutes later and only says when the worker
ran. `formula` stays the snapshot baseline state every mining page publishes (Decision 0046).

### 5. No settled hour

`ranking`, `myPosition` and `snapshot` = `{status: unavailable, reasonCode:
MINING_SNAPSHOT_NOT_AVAILABLE}` (the existing "no snapshot" shape and code; the client copy is
「还没有算力快照」), `me: null`, `nextCursor: null`, HTTP 200. A repository failure is 503 as before.
`scope=referrals` is unchanged and never waits for either source.

### 6. Unchanged

The snapshot lane and every other `/v2/mining/*` read (summary, assets, rewards estimate, community
detail `GET /v2/mining/communities/{id}`, member / connection `miningPower`, discover
`sort=miningPower`) keep the snapshot source. `getAccountStanding` / `getCommunityStanding` still
read the snapshot.

### 7. Mining power visibility defaults to `everyone`

- Contract default (`defaultPrivacyV2Values.visibility.miningPower`) = `everyone`; a missing
  `privacy_preferences_v2` row reads as `everyone` in the rank (`powerVisibleToOthers`) and in
  member rows (`listMemberPowers`).
- Migration **000087**: column default `everyone`; every stored `self` → `everyone` with
  `record_version + 1` and a fresh `updated_at`. **Why all of them**: a row is written only by a
  privacy replacement, which always carries the whole document, so a stored `self` cannot be told
  apart from the old default the client sent back while the owner changed another switch
  (`record_version` / `updated_at` are per row, not per field; there is no per-field history). The
  owner can set `self` again in the privacy centre. The version bump makes a client holding the old
  version re-read before it writes (`409` on a stale `expectedVersion`). `everyone` rows are
  untouched. `down` restores only the default and never moves rows back.
- Impact on dev (read-only query 2026-10-16): `privacy_preferences_v2` has **0 rows**, so 0 rows
  move; all 18 accounts change through the missing-row default. Staging (dev import 2026-10-12
  plus later sign-ups) is expected to be of the same order; the migration prints nothing, run
  `select count(*) from privacy_preferences_v2 where mining_power_visibility = 'self'` before
  deploying to know the number.

## Consequences

- The staging boards show the NFT track power the hourly settlement already pays. They move once
  an hour (after each settlement), not with every snapshot.
- Positions on the users rank and `GET /v2/mining/summary`'s power can differ: the summary is the
  snapshot (coin track) and the rank is the settled hour (both tracks). Converging the summary is a
  separate decision.
- Mobile: **no change required**. Every field keeps its name, type and pattern (`snapshotId` UUID,
  `blockNumber` `^(0|[1-9][0-9]{0,19})$`, `blockHash` `^0x[0-9a-f]{64}$`, `formulaVersion` /
  `priceVersion` patterns, `latestAttempt.status = complete` with `stale = false` and the same
  `snapshotId`, which is the consistency the 0141 codec checks); `MINING_SNAPSHOT_NOT_AVAILABLE`
  and `MINING_RANK_NOT_RANKED` are codes it already renders. The provenance line still says
  「LOOP 算力快照」, which reads correctly for an hourly settlement.
- Accounts that kept `self` deliberately are now public until they switch back.

## Tests

- `test/v2-mining-routes.test.ts` (unit): ranking from the epoch with ties, zero power last and the
  hour as the `snapshot` block, independent of the snapshot lane; repository calls carry
  `epochId`; account absent from the hour → `MINING_RANK_NOT_RANKED`; no settled hour →
  `MINING_SNAPSHOT_NOT_AVAILABLE` on `ranking` / `myPosition` / `snapshot`, referrals still
  available; 503 on a repository failure; existing 0049 / 0100 rank tests moved to the epoch.
- `test/mining-power-visibility-migration.test.ts` (unit): 000087 SQL, schema head, contract
  default.
- `test/mining-rank-hourly.integration.test.ts` (PostgreSQL, real SQL through `commitEpoch`): no
  epoch → null; newest settled hour chosen over an older settled and a newer failed hour; exact
  `1.725 + 0.275 = 2` tie at position 1, zero last, keyset pages equal the full order; standings
  and absence; community split (self NFT of its instances + referral units × coefficient + bound
  asset), banned member excluded, unbound community absent, bound community without members listed
  at 0, coefficient from the version (listed `1.50` → `1.5`, default `1`), community tie and
  keyset, best community, outsider null; missing privacy row → visible.
- `test/mining-power-visibility-migration.integration.test.ts` (PostgreSQL): new rows default
  `everyone`; stored `self` rows flip with version + 1, `everyone` rows untouched, re-run is a no-op,
  `down` restores only the default.
- `test/s7-repositories.integration.test.ts`, `test/market-categories-rank.integration.test.ts`:
  snapshot-rank assertions removed (moved to the hourly suite); missing-row default now visible.
