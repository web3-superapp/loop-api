# Decision 0071: A policy refusal names its rule on the wire, and the registry is searchable

- Status: Accepted (S77b; user ruling 2026-09-23 "功能坏的先修")
- Date: 2026-09-23
- Scope: the `403 POLICY_BLOCKED` envelope of every money-action route
  (`POST /v2/wallet-intents/send|approve|revoke|swap`, `POST /v2/swap/quote`),
  the `assets`, `launch`, and `dapps` domains of `GET /v2/search`, and the
  Swap page's source of the "available balance" figure. Extends Decisions
  0031 (search), 0033 (Asset Registry), 0035 and 0065 (canary policy). No
  migration, no new table, no `/v1` change.
- Baseline: `integration/v2` = `2d407ca`

## Context (walkthrough 2026-09-23, three defects)

| #   | Observed on device                                                                                                                                 | What the server actually did                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sending 1 USDT to `0x4c3a…9fa9d` stopped at the confirm step with "当前策略不允许这笔操作 · 自定义上限还没有开放"; the page never said which rule. | `POST /v2/wallet-intents/send` answered `403 POLICY_BLOCKED` with `detailsSafe: { reasonCode: "COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST" }` (the route test at `test/v2-wallet-intent-routes.test.ts` "maps policy and balance refusals" has proven this since Decision 0065). The client's `MoneyPolicyRule` switch has no branch for that code (nor for the daily ceiling) and falls through to its default text. |
| 2   | Search "资产" segment: "域暂不可用 · 还没有开放", although the wallet lists 11 registered assets.                                                  | `GET /v2/search?domain=assets` returned `status: "unavailable"`, `ASSET_REGISTRY_DEFERRED` — the domain was never wired to the registry that Decision 0033 delivered.                                                                                                                                                                                                                                           |
| 3   | Swap page: "读不到可用余额" while the wallet page showed USDT 2.99.                                                                                | The swap page reads `GET /v2/wallets/{walletId}/balances` and takes `balance.spendableBalance` for `_sourceAssetId`; that field starts `null`, so the text is shown before any asset is picked. The contract already carries the figure; nothing on the server withholds it.                                                                                                                                    |

## Rulings

### 1. `403 POLICY_BLOCKED` — the reason slot is part of the OpenAPI surface

The wire codes are unchanged. What changes is that they are **enumerated**
in the route schema instead of described in prose, and the daily ceiling
carries the two figures a person can act on.

| `detailsSafe.reasonCode`               | Fires when                                                                                               | Extra decimal-string fields                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST` | send recipient / approve spender outside `BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST` (revoke always admitted) | —                                                                                                |
| `CANARY_CEILING_EXCEEDED`              | one intent's USD value > `BSC_WRITE_CANARY_MAX_USD`                                                      | `exposureUsd`, `ceilingUsd`                                                                      |
| `CANARY_DAILY_CEILING_EXCEEDED`        | rolling 24 h total (spent + this intent) > `BSC_WRITE_CANARY_DAILY_MAX_USD`                              | `exposureUsd`, `ceilingUsd`, **`spentUsd`**, **`remainingUsd`** (new; `max(0, ceiling − spent)`) |
| `ASSET_NOT_IN_CANARY_ALLOWLIST`        | asset registered but not in `BSC_WRITE_CANARY_ASSETS`                                                    | —                                                                                                |
| `ASSET_BLOCKED`                        | registry `status = blocked`                                                                              | —                                                                                                |
| `UNLIMITED_EXPOSURE_EXCEEDS_CEILING`   | unlimited approve valued at the current balance > ceiling                                                | `exposureUsd`, `ceilingUsd`                                                                      |
| `PRICE_IMPACT_BLOCKED`                 | swap price impact at or above the hard limit                                                             | —                                                                                                |

- `policyBlockedErrorSchema` (in `src/routes/v2/wallet-intents-schemas.ts`)
  replaces the generic `403` on every wallet-intent and swap route:
  `detailsSafe` is `null` **or** an object with `additionalProperties: false`,
  `reasonCode` from the enum above, and the four optional decimal strings.
  `test/wallet-intent-contract.test.ts` pins the enum to
  `walletIntentRefusalReasonCodes` minus the one `422` code
  (`NATIVE_ASSET_NOT_APPROVABLE`), so a new refusal cannot be added without
  the OpenAPI enum moving with it.
- Gas shortfall stays `409 INSUFFICIENT_BALANCE` (Decision 0065); it is not a
  policy and is not in this enum.
- The order of admission (Decision 0065) is unchanged; the counterparty check
  still runs before any Provider or RPC read.
- Suggested zh-CN copy per code is in `docs/frontend-v2-wallet-intents-api.md`
  §7.1. The client owns the wording; the server owns the code.

### 2. `GET /v2/search?domain=assets` reads the Asset Registry

- Source: the readable rows of `public.assets` for `eip155:56`
  (`listReadableAssets`, i.e. everything except `blocked`) — the same rows the
  wallet balance list and `pnpm asset:register` use. No new table, no new
  SQL, no Provider call: the registry is an operator-curated dozen, so the
  match is in memory (`src/features/community/asset-search.ts`).
- Query: 2–64 code points after trim / NFKC / whitespace fold / lower-case
  (64 so a whole pasted address fits). Matched as a **prefix** against, in
  rank order: exact `symbol`, `symbol` prefix, `name` prefix, any later word
  of `name` ("bnb" finds "Wrapped BNB"), contract address with `0x`, or bare
  hex of at least four digits. Never a substring match.
- Row shape is the existing search row: `resultType: "asset"`,
  `stableId` = canonical CAIP-19 `assetId` (the registry's identity key since
  Decision 0033; the schema's `stableId` now accepts opaque UUIDs **or** asset
  IDs), `displaySnapshot.title` = symbol, `subtitle` = name, `avatarRef` /
  `memberCount` `null`, `verificationStatus` = `verified` only for a
  registry-verified row, otherwise `pending`. `destination` is
  `{ kind: "assetDetail", assetId }` — the only destination that carries a
  parameter, and the only key the client may open the token page with.
- Ordering and paging: rank → symbol → assetId; keyset cursor on the last
  `assetId` under the route `v2SearchAssets`, owner- and filter-bound like
  every other V2 cursor. A continuation whose row vanished starts from the
  top.
- Quota: none. The alias-search quota exists to slow alias enumeration; the
  registry is public and already fully listed by the wallet.
- Unavailable: only when no chain registry repository is composed —
  `ASSET_REGISTRY_NOT_COMPOSED` (replaces `ASSET_REGISTRY_DEFERRED`).

### 3. Launch and DApp stay unavailable, with honest, distinct reasons

| Domain   | Before                    | Now                                | Meaning                                                                                                                           |
| -------- | ------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `launch` | `LAUNCH_MODULE_DEFERRED`  | `LAUNCH_PROJECT_DIRECTORY_PENDING` | The Launch module is shipped; there is no project directory to search until the contract product document (02) provides projects. |
| `dapps`  | `DAPP_DIRECTORY_DEFERRED` | `DAPP_DIRECTORY_NOT_INTEGRATED`    | No DApp directory Provider is integrated (red line 9: DApp is read-only / Go-No-Go).                                              |

Both still answer `200`, `status: "unavailable"`, empty results, and consume
no quota.

### 4. Swap available balance: no contract change

The Swap page's figure is `GET /v2/wallets/{walletId}/balances` →
`items[].balance.spendableBalance` (Decision 0063), the same source and the
same `freshness` block the wallet page renders. `POST /v2/swap/quote` reads
the same balance snapshot for its `INSUFFICIENT_BALANCE` check but does not
echo it, and in Development the quote answers `503 CAPABILITY_UNAVAILABLE`
(Privy Swaps not enabled for the app, Decision 0065), so a `fromBalance` on
the quote would not have shown the walkthrough anything. The defect is
client-side (S77a): the "读不到可用余额" text is rendered while no source
asset is selected, and must instead say that an asset has to be chosen. If,
after choosing, the row is `unavailable`, the row's own `reasonCode` is the
text to show.

## Contract impact

| Location                                      | Change                                                                                                   | Breaking                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Money-action `403` `detailsSafe`              | Typed: `reasonCode` enum + optional `exposureUsd`/`ceilingUsd`/`spentUsd`/`remainingUsd`; `null` allowed | No                                  |
| `CANARY_DAILY_CEILING_EXCEEDED`               | Adds `spentUsd`, `remainingUsd`                                                                          | No                                  |
| `GET /v2/search` `resultType`                 | Adds `asset`                                                                                             | No                                  |
| `GET /v2/search` `stableId`                   | `anyOf` opaque UUID \| CAIP-19 asset ID                                                                  | No                                  |
| `GET /v2/search` `destination.kind`           | Adds `assetDetail`; optional `destination.assetId` present only for that kind                            | No                                  |
| `search?domain=assets`                        | `available` with rows; `ASSET_REGISTRY_NOT_COMPOSED` only without a registry                             | Yes (was always unavailable)        |
| `search?domain=launch` / `dapps` reason codes | Renamed (see §3)                                                                                         | Code rename; status/shape unchanged |
| `subtractDecimalStrings` (`market-contract`)  | New exact helper                                                                                         | Internal                            |

## Verification

- `test/asset-search.test.ts` — query normalization and limits, rank order,
  address forms, paging.
- `test/v2-community-routes.test.ts` — assets domain over HTTP (symbol /
  name / address / native; empty result; cursor page; 400 on one code
  point; no quota), `ASSET_REGISTRY_NOT_COMPOSED` without a registry, the
  two renamed deferred codes.
- `test/v2-search-assets.integration.test.ts` — real `public.assets` rows
  (pending, verified, blocked) through the real cursor codec.
- `test/v2-wallet-intent-routes.test.ts` — HTTP `403` for the daily ceiling
  now asserts `spentUsd` / `remainingUsd`; `test/wallet-intent-services.test.ts`
  asserts the figures after two settled intents.
- `test/wallet-intent-contract.test.ts` — enum ↔ `walletIntentRefusalReasonCodes`
  and the typed `detailsSafe` shape.
- `test/market-contract.test.ts` — `subtractDecimalStrings`.

## Rollback

Code-only; revert to `2d407ca`. Nothing durable changed shape.
