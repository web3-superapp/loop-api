# Decision 0061: Two discover orderings that name their source, and a demonstration holding that admits what it is

- Status: Accepted (S60; answers the 2026-09-21 device report: 「算力最高」「讨论最多」 are dead segments, and every mining number on the device is zero because two wallets hold nothing)
- Date: 2026-09-21
- Scope: `GET /v2/communities` (two new `sort` values, one new response field, two new optional item fields), `community_channel_activity` (new table), the `community-channel-sync` lane (one new step), `wallet_balance_snapshots.source` and `mining_snapshots.holdings_source` (migration `000035`, append-only), the `mining-snapshot` lane and `pnpm mining:snapshot`, the Development baseline version (`r3` → `r4`), `ops/seed-mock.sh --holdings`. No route is added or removed; no `/v1` path is touched.

## The two reports

1. **Discover has four segments and two of them do nothing.** `community_discover_screen.dart` disables 「算力最高」 and 「讨论最多」 with the honest reason that no source exists: `communitySortValues` was `["members", "newest"]`.
2. **Mining shows zeros because nothing is held.** The Development stack has two real wallets, and what they hold (2.99 USDT) is one asset at one amount. A formula of the shape `holding × referencePrice × weight` cannot be checked against that: there is no second amount to compare, and no community weight is visible in any number.

Both are fixed without loosening red line 4: nothing publishes a number that was not measured, and the demonstration holdings say, on the wire, that they are demonstration holdings.

## Part 1 — `sort=miningPower` and `sort=activity`

### What each ordering is

| `sort`        | Orders by                                                                              | Source                                                                     |
| ------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `members`     | `communities.member_count`                                                             | stored column (unchanged)                                                  |
| `newest`      | `communities.created_at`                                                               | stored column (unchanged)                                                  |
| `miningPower` | the community's power on its bound asset under the **latest complete** Mining snapshot | `mining_snapshot_powers`, joined through `community_mining_weights`        |
| `activity`    | messages observed in the official Stream channel over the last **7 days**              | `community_channel_activity`, written by the `community-channel-sync` lane |

`miningPower` resolves its snapshot through `resolveMiningBaseline` — the same function every mining read uses (Decision 0043/0057) — so the discover ranking can never rank by a snapshot the mining pages consider incomplete, stale, or withdrawn. The repository never picks a snapshot itself: `listCommunities` refuses `sort=miningPower` without a caller-resolved `miningOrdering`.

### The response says what it was ordered by

`GET /v2/communities` gains one always-emitted field:

```jsonc
"ordering": {
  "status": "available",
  "sort": "miningPower",
  "basis": {
    "kind": "miningSnapshot",
    "snapshotId": "…", "formulaVersion": "…", "computedAt": "…",
    "scope": "development_baseline", "stale": false
  }
}
```

`basis.kind` is `stored` for the two column sorts, `miningSnapshot` for `sort=miningPower`, and `channelActivity` (`windowDays`, `observedCommunityCount`, `observedAt`) for `sort=activity`.

**When the fact does not exist the ordering is `unavailable` and the page is empty:**

```jsonc
{
  "items": [],
  "nextCursor": null,
  "ordering": {
    "status": "unavailable",
    "sort": "activity",
    "reasonCode": "COMMUNITY_ACTIVITY_NOT_OBSERVED",
  },
}
```

Status stays `200`; the page was answered, the ordering was not. Three alternatives were rejected:

- **falling back to `members`** — the client asked for one order and would be shown another, with no way to tell;
- **`503 CAPABILITY_UNAVAILABLE`** — the community list itself is available; only one ordering of it is not, and a 503 would also hide the reason behind a generic error state;
- **ordering everything at zero** — that is the exact shape of a fabricated fact: "nobody talks in any community" is a claim nobody measured.

The list read is never performed in the unavailable case, so an ordering nobody can apply also spends no query.

Reason codes on `ordering.reasonCode` for `sort=miningPower` are the mining reason codes the mining pages already publish (`MINING_FORMULA_BASELINE_PENDING`, `MINING_SNAPSHOT_NOT_AVAILABLE`, `MINING_SNAPSHOT_INCOMPLETE`, `MINING_SNAPSHOT_STALE`, `MINING_RUNTIME_UNAVAILABLE`); for `sort=activity` it is `COMMUNITY_ACTIVITY_NOT_OBSERVED`.

### Rows carry the fact they were ordered by

A `sort=miningPower` row carries `miningPower` — the same `subject: "community"` projection as `GET /v2/communities/{id}` (power, snapshot, scope, `stale`, `weight`, `participants`), built from the same page query, so the card and the detail cannot disagree. A community with no approved weight under the version in force is **listed**, after every ranked community, with `miningPower: {status: "unavailable", reasonCode: COMMUNITY_ASSET_NOT_BOUND | COMMUNITY_WEIGHT_PENDING_REVIEW}`. A community that carries a weight but whose members hold nothing has `power: "0"` — an observed zero, which is a different thing from an absent one.

A `sort=activity` row carries `activity: {status:"available", messageCount, windowDays: 7, bounded, observedAt}` or `{status:"unavailable", reasonCode: COMMUNITY_ACTIVITY_CHANNEL_NOT_OBSERVED}`. `bounded: true` means the message page Stream returned was full and still began inside the window: more messages exist than were counted, so `messageCount` is a floor and the client must render it as one.

`sort=members` and `sort=newest` rows carry neither field. The cursor already binds the sort (`communityDiscoverFilter`), so a cursor issued under one ordering is `INVALID_REQUEST` under another — unchanged, and now covered by a test.

Paging: the keyset value is the ordering fact, with `-1` as the sentinel for a community the fact does not cover, in both the `ORDER BY` and the cursor. That is what makes paging continuous from the ranked communities into the unranked ones.

### How activity is observed

Stream publishes no "messages in the last seven days" number. The `community-channel-sync` lane therefore observes it, as the last step of a tick and never in a way that can affect a membership job:

- `listChannelsDueForActivity` returns provisioned channels whose observation is missing or older than 15 minutes, oldest first, at most 25 per tick;
- one `queryChannels` call reads those channels with `message_limit: 100` and `state: true`;
- each channel's messages inside the window are counted, `channel.message_count` (Stream's lifetime total) and `last_message_at` are kept for operators, and the row is replaced with `observed_at`;
- a provider failure logs one sanitized warn line and records **nothing**. A channel Stream did not answer for keeps its previous observation: an unobserved channel is not an inactive one.

There is deliberately no database lease on this sweep, unlike the job claim: two replicas would at worst spend one duplicate provider read, and the write is an idempotent replacement by the newest observation. `observed_at` is `not null` by constraint — an activity count without the time it was measured is not a fact — and the discover read only orders by observations younger than six hours, so a lane that stops running degrades to `unavailable` instead of ranking by stale counts.

`community_channel_activity` cascades on community delete, so it can never block the seed purge.

## Part 2 — demonstration holdings that say so

### `wallet_balance_snapshots.source`

`chain | mock_seed`, default `chain`. Every existing row is a chain observation: the wallet read path is the only writer and it only ever observed a chain. That path now writes `source = 'chain'` explicitly and also **re-asserts** it on conflict, so a chain observation can never inherit a seeded row's provenance.

`mock_seed` rows are written by `ops/seed-mock.sh --holdings` at block `0` with a zero block hash — no block observed them, and the snapshot block (the highest observed balance block) is therefore never moved by a seeded row.

### The lane opts in, and production cannot

`MiningRepository.listBalanceInputs({includeMockSeedHoldings})`: the seeded rows are not a different value of the same query, they are invisible to it unless asked for. The flag comes from `MINING_MOCK_HOLDINGS_ENABLED` (default `false`), which **both** configuration loaders refuse under `NODE_ENV=production` — the process does not start rather than compute a number from a balance nobody observed. `pnpm mining:snapshot` refuses production outright, as before.

### Every number says which kinds of balance it counted

`computeMiningSnapshot` derives `holdingsSource` (`chain | mock_seed | mixed`) from the balances that actually **produced power**: a seeded balance of an asset the version does not weight colours nothing, because it changes no number. It is stored on `mining_snapshots.holdings_source` and published on the `snapshot` block of every mining read (`/v2/mining/summary`, `/rank`, `/assets.source`, `/communities/{id}`) as an added optional field. The client renders a demonstration marker for anything other than `chain`.

The **wallet** pages are unaffected in both directions: they read the chain live and write `chain` rows; they never read `wallet_balance_snapshots` as a balance. A seeded holding is therefore invisible on the wallet, which is correct — the wallet states what an address holds, and these addresses hold nothing.

### The assets are real, the holdings are not

The ten tokens the seeded communities bind are real BNB Smart Chain tokens (BTCB, ETH, DOGE, XRP, ADA, LINK, UNI, DOT, CAKE, USDT), registered by `pnpm asset:register`, which reads symbol, name and decimals **from the token contract**, and priced through the same DexScreener path as every other price. `--holdings` refuses to run while any of them is unregistered and prints the exact commands: it must never invent an asset row.

Exactly one community may carry an approved weight on a given asset — a second one makes the asset `COMMUNITY_WEIGHT_AMBIGUOUS` and drops it out of every snapshot — so exactly ten communities are bound, one per asset, each with its own weight in the version's `0.5–2.0` range. The weights are not written by the seed: `pnpm mining:community-weight` is the only path that writes one, and the seed prints the commands with the community IDs it bound.

The holdings are a ladder: account `n` holds `ladder[((n-1)/10) % 5]` units (`10, 50, 100, 500, 1000`) of `asset[((n-1) % 10)]`, so every bound asset has five holders with five different amounts and `power = holding × referencePrice × weight` can be checked by hand. The hand-computed table and the values the API actually published are in `LOOP/docs/integration/seed-mock/mining-verification.md`.

### The Development baseline moves to `r4`

A formula version's `assetWeights` are fixed when the version is written, and an asset registered afterwards is simply not weighted by it. Registering ten tokens therefore requires a new version: `miningFormula-devBaseline-2026-09-21-r4`. Community weights are recorded per version, so every weight is re-approved under `r4`. Nothing else about the baseline changes (every registered asset still weighs `1`; the community weight is the only asset-level difference, which is exactly what makes it visible in the numbers).

## Deployment order (Development)

```sh
pnpm db:migrate
pnpm asset:register 0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c   # BTCB
pnpm asset:register 0x2170ed0880ac9a755fd29b2688956bd959f933f8   # ETH
pnpm asset:register 0xba2ae424d960c26247dd6c32edc70b295c744c43   # DOGE
pnpm asset:register 0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe   # XRP
pnpm asset:register 0x3ee2200efb3400fabb9aacf31297cbdd1d435d47   # ADA
pnpm asset:register 0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd   # LINK
pnpm asset:register 0xbf5140a22578168fd562dccf235e5d43a02ce9b1   # UNI
pnpm asset:register 0x7083609fce4d1d8dc0c979aab8c869ea2c873402   # DOT
ops/seed-mock.sh --holdings                                       # binds + seeds, prints the rest
pnpm mining:dev-baseline --confirm                                # writes r4 from the registry
pnpm mining:approve-formula miningFormula-devBaseline-2026-09-21-r4 --confirm
pnpm mining:community-weight <communityId> <weight> --confirm     # ten times, as printed
MINING_MOCK_HOLDINGS_ENABLED=true pnpm mining:snapshot --confirm
```

The worker process needs `MINING_MOCK_HOLDINGS_ENABLED=true` in its environment for the periodic lane to keep counting them; without it the next tick writes a `chain`-only snapshot and the demonstration numbers disappear from the pages.

## Consequences and limits

- `CommunitySummary` is unchanged; the two ordering facts are **added optional** fields on the discover item, and `ordering` is an added required field of the list response. A strict client decoder must be extended before it can read the new response (the discover list is the only affected route).
- `MiningSnapshotRecord`, `WriteMiningSnapshotInput` and `MiningSnapshotRunResult` gain `holdingsSource`; `listBalanceInputs` gains a required argument; `MiningBalanceInput` gains `source`.
- The activity sweep spends one `queryChannels` call per tick at most, on channels that are due. In the Development stack most mocked communities have a provisioned channel and no messages, so the honest answer for them is `0` — an observed zero, not an absence.
- **Unverified here:** whether Stream accepts this server-side `queryChannels` shape against the real credentials, and what it returns for a channel with no messages. The gateway treats every provider fault as unavailable and records nothing, so the failure mode is the `unavailable` ordering, not a wrong number. It must be checked on the Development stack with real credentials before 「讨论最多」 is called done.
- Not decided here: whether `activity` should count reactions or threads (only top-level `messages` are counted today), and whether a community should be allowed to bind an asset another community already weights (still refused).
