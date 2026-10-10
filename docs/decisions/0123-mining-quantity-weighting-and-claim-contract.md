# Decision 0123: Mining asset track by quantity, frozen defaults, claim contract tightening (S147-api)

- Status: Accepted (S147-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `dbc2831`
- Inputs: requirer feedback 2026-10-10 evening (`docs/16-挖矿与邀请-中心化结算方案.md` §7;
  `docs/17-需求方待拍板问题清单.md` §三 items 12–20, §四 "17 资产估值 → 按数量加权"),
  Decision 0116 (hourly settlement), 0107 (pure functions), 0110/0111 (approval separation),
  loop-mobile Decision 0141 (rewards codec, strict key sets), loop-admin Decision 0006
  (parameter UI).
- Scope: migration `000067_mining_quantity_weighting`; parameter document keys
  `assetPowerBasis`, `defaultCommunityCoefficient`; calculator / runner; `GET /v2/mining/rewards`
  `hourly.claim` gating; `POST /v2/mining/claim/prepare` `intent.unsignedTransaction` (strict) and
  `intent.payloadDigest` (new); `/admin/v1/mining/parameter-versions` draft / approve rules. No new
  route, no new capability, no new table.

## Rulings implemented

| docs/17 item             | Ruling (2026-10-10)                                           | Where it lives                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17 asset valuation       | **Quantity, not value**: power = balance TWAB × Mining Weight | `assetPowerBasis = "quantity"` in every new document; calculator `quantity` branch; no price is read                                                                                  |
| 12 budget spread         | Even over 24 UTC hours                                        | unchanged (`miningHourBudget`, hour 23 takes the remainder)                                                                                                                           |
| 13 referral ratios       | 10 / 5 / 3 / 2 / 1 %                                          | default `referralRatiosBps` `[1000, 500, 300, 200, 100]`                                                                                                                              |
| 14 zero-power hour       | Void, not carried                                             | unchanged (calculator step 8; `unallocated_*`)                                                                                                                                        |
| 15 NFT transfer timing   | Block time of the Transfer, time-weighted in the hour         | unchanged (ERC-721 `Transfer.event_at`)                                                                                                                                               |
| 18 community coefficient | Every community 1.0, adjustable per community                 | **new** `defaultCommunityCoefficient = "1"`: a community not listed in `communityCoefficients` counts 1.0                                                                             |
| 20 claim caps            | Daily 1,000,000 (both pools), total 900,000,000               | defaults 2 × 500,000 LOOP/day × 900 days; `miningClaimDailyCapRaw` / `miningClaimTotalCapRaw` pinned by tests; the caps themselves are enforced by `LoopRewardClaim` (S138-contracts) |

## Parameter document (Decision 0116 document + two keys)

| Key                           | New drafts                                                                 | Stored before 0123 (no key)   |
| ----------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| `assetPowerBasis`             | `"quantity"` (only value a draft may send; omitted → stored as `quantity`) | read as `"valuation"`         |
| `defaultCommunityCoefficient` | decimal, default `"1"`                                                     | read as `"0"` (the 0116 rule) |

- There never was a price / reference-price field in the hourly document (the 0116 price came from
  the curve facts, not from parameters). A draft that sends `referencePriceSource` or any unknown
  key is `422 ADMIN_MINING_PARAMETERS_INVALID (field)`; `assetPowerBasis: "valuation"` (or any value
  other than `quantity`) is `422 … field assetPowerBasis`.
- Approved rows are immutable (000062 trigger), so no historical version is rewritten.
- A **pending** draft written before 0123 (no `assetPowerBasis`) cannot be approved:
  `409 ADMIN_CONFLICT · ADMIN_MINING_PARAMETERS_BASIS_RETIRED` (service) and the 000067 trigger
  (database). It can be withdrawn; the platform admin redrafts it.

## Migration 000067

`require_mining_quantity_basis()` trigger, `before insert or update` on
`mining_parameter_versions`: an INSERT, or an UPDATE that moves `status` to `approved`, must carry
`document->>'assetPowerBasis' = 'quantity'` (SQLSTATE 23514). No row is updated or deleted; `down`
drops only the trigger and function. The dev version `miningHourlyV1-dev` (approved 2026-10-10,
no asset weights) is untouched and keeps settling under its own rule; since it admits no asset,
the asset pool is unallocated either way until a quantity version with weights is approved.

## Settlement changes (pure: calculator + runner)

- `MiningParameterSlice` gains `assetPowerBasis` and `defaultCoefficient` (from the version).
- Asset self power per slice:
  - `quantity`: `balanceRaw × weight / 1e18` per second (a 1e18 fixed-point token count × weight),
    integrated over the hour = **TWAB × weight**. Prices are neither read nor required.
  - `valuation` (replay of pre-0123 versions only): unchanged 0116 path,
    `balance × price × weight`, every second priced (`MINING_SETTLEMENT_PRICE_MISSING` otherwise).
- NFT coefficient: listed community → its coefficient; unlisted → `defaultCoefficient`; an instance
  bound to no single community → 0 (unchanged, `unboundInstances`).
- Runner: price segments are built only when a `valuation` slice is in force in the hour; a
  quantity-only hour has `prices: []`. `input_summary.assetPowerBases` lists the rules used.
- **Replay compatibility**: `miningInputDigest` omits `assetPowerBasis` when `valuation` and
  `defaultCoefficient` when 0, so an hour settled under a 0116 document hashes exactly as before.
  Pinned by a golden test: digest `aa63cd33…fb3b` and the per-user rewards were computed with the
  `dbc2831` code and are asserted against the new code.
- Graduated MEME assets still leave the asset pool from `graduated_at`
  (`MINING_ASSET_GRADUATED_UNREADABLE`): post-graduation ERC-20 balances are not indexed, and
  quantity weighting needs the balance even though it no longer needs the price.

## `GET /v2/mining/rewards` — `hourly`

- **No key added or removed** (the 0141 codec is strict on every object). `tracks.asset.holdings[]`
  stays `{assetId, balanceAtEndRaw, power}` — it never carried a valuation field; only the meaning of
  `power` changes for hours settled under a quantity version (token count × weight).
- `claim.executable` is true only when every condition holds; otherwise `reasonCode` is the first
  that fails (`miningClaimGate`):

  1. `MINING_SETTLEMENT_UNAVAILABLE` — store missing / down
  2. `MINING_PARAMETERS_PENDING` — no approved version in force now
  3. `MINING_NOTHING_SETTLED` — **new**: no hour settled yet
  4. `MINING_CLAIM_NOTHING_TO_CLAIM` — `claimableRaw = 0` (was `executable: true` before 0123)
  5. `MINING_CLAIM_BELOW_MINIMUM` — `0 < claimableRaw < minimumClaimRaw`
  6. `MINING_CLAIM_IN_FLIGHT` — the latest claim is `submitting` / `confirming`
  7. configuration (unchanged order): `MINING_CLAIM_MAINNET_CLOSED`,
     `…_CONTRACT_NOT_CONFIGURED`, `…_CHAIN_NOT_CONFIGURED`, `…_SIGNER_NOT_CONFIGURED`,
     `…_WRITES_DISABLED`

  `claimableRaw` here is the ledger (`settled − confirmed claimed`); prepare still re-checks the
  chain (`claimed(w)`, pause, funding, gas).

## `POST /v2/mining/claim/prepare` — `intent`

- `intent.unsignedTransaction` is now an OpenAPI object with **exactly eleven keys**
  (`additionalProperties: false`): `chainId` (56 | 97 integer), `to`, `data`, `value` (`"0x0"`),
  `from`, `gas`, `nonce`, `type` (`eip1559` | `legacy`), `maxFeePerGas`, `maxPriorityFeePerGas`,
  `gasPrice` (hex quantities; the fee keys of the other type are `null`). This is what the server
  already emitted; the schema now says so.
- **New** `intent.payloadDigest`: `0x` + 64 hex = keccak-256 over the UTF-8 bytes of the canonical
  JSON of `intent.unsignedTransaction` (keys sorted by code unit, no whitespace, `chainId` a JSON
  number, `null` kept). It equals `"0x" + localDigest(wire)` of the 0141 codec, so the client can
  compare its own digest with the server's before showing the sheet.

## Error / reason catalogue added

| Where                     | HTTP / code             | reasonCode                                                                                      |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `hourly.claim.reasonCode` | (no error)              | `MINING_NOTHING_SETTLED`                                                                        |
| admin approve             | `409 ADMIN_CONFLICT`    | `ADMIN_MINING_PARAMETERS_BASIS_RETIRED`                                                         |
| admin draft               | `422 VALIDATION_FAILED` | `ADMIN_MINING_PARAMETERS_INVALID` with `field: assetPowerBasis` / `defaultCommunityCoefficient` |

## Unavailable behaviour

Unchanged from 0116. A quantity-only hour no longer depends on price facts, so it cannot fail with
`MINING_SETTLEMENT_PRICE_MISSING`; a pre-0123 version still can on replay.

## Client impact (loop-mobile 0141 codec)

- `GET /v2/mining/rewards`: no shape change. New reason value `MINING_NOTHING_SETTLED` (needs a
  Chinese string; `requireReasonCode` accepts it by pattern). `executable` is now false in states
  where it used to be true (claimable 0 / below minimum / in flight).
- `POST /v2/mining/claim/prepare`: **one added key, `intent.payloadDigest`**. The 0141 codec reads
  `intent` with `strictMap({calldata, unsignedTransaction, signing})`, so the current app build
  rejects every 201 as `invalidPayload` until it adds `payloadDigest` to that set (S147-mobile).
  `unsignedTransaction` itself is unchanged (still the same eleven keys).

## Deviations

- The task suggested deleting or deprecating a "reference-price source / valuation" parameter field.
  The hourly document never had one (0116 read curve prices from facts); the basis is made explicit
  with `assetPowerBasis` instead, and old documents are interpreted, not edited.
- Community coefficient default 1.0 was missing in 0116 (an unlisted community counted 0); it is
  added as a versioned key so pre-0123 hours replay unchanged.
