# Decision 0127: one project owner, many Hooks projects; GET routes on a read-only database; pool market trades apart from buybacks (S151-api)

- Status: Accepted (S151-api), Development / BSC Testnet only
- Date: 2026-10-11
- Baseline: `integration/v2` = `6016421` (Decisions 0124–0126, migration 000070)
- Inputs: user ruling 2026-10-11 18:10 (docs/17 #21 "one wallet, several projects" = yes, no contract
  change); `LOOP/docs/12-需求方交接对照与合并方案.md` 12:48 (round five
  `HOOKS_LAUNCH_ALREADY_DEPLOYED`); `LOOP/docs/integration/preflight-2026-09-16/README.md`
  §2026-10-11 (GET routes that write); Decision 0124 open item "buybacks counted as pool trades";
  loop-contracts `protocol/src/LoopLaunchFactory.sol` (`deployLaunch`: `ownerVersion =
keccak256(abi.encode(projectOwner, configVersion))`, `VersionAlreadyUsed`;
  `launchIdByOwnerVersion`), `OfficialV4BuybackAdapter.sol` (the only buyback caller of
  `PoolManager.swap`).
- Scope: `PUT` / `GET /v2/launch/projects/{id}/hooks-config`, `GET …/hooks-config/signing-request`,
  operator `launch.config.save`; `GET /v2/market/*`, `GET /v2/wallets`, `GET /v2/referral`,
  `GET /v2/search`, `GET /v2/blocks`, `GET /v2/communities/{id}/members`; `GET
/v2/launch2/instances/{id}` (`pool`); migrations `000071_hooks_launch_owner_config_versions`,
  `000072_launch2_pool_user_trades`. No `/v1` change; nothing new is signed or sent; BSC mainnet
  signing stays closed.

## 1. Owner-unique Hooks config versions

Finding: the Factory deduplicates `(projectOwner, configVersion)` and the launchId binds only
owner + version + configHash, while versions started at 1 per project. An owner's second project
signed version 1 again and the executor failed it (`HOOKS_LAUNCH_ALREADY_DEPLOYED`, no chain write).

Decision (contract unchanged):

- **Entity** `hooks_launch_owner_config_versions(owner_user_id uuid PK → loop_users,
last_config_version int > 0)`: a monotonic counter per project owner (the LOOP account — the
  wallet that will sign is chosen only at signing time, so the account, which owns every candidate
  wallet, is the allocation scope). A trigger refuses any non-increasing update; the row is deleted only with its owner (`pnpm dev:reset-users`).
- **Allocation** (`allocateHooksLaunchConfigVersion`, inside the save transaction, after the
  project row lock; owner and operator saves share it):
  `next = greatest(counter + 1, max(version of the owner's projects) + 1, max(version of any
  deployment task whose project_owner is one of the owner's wallet addresses, active or archived)
  - 1)`. The counter upsert's row lock serialises concurrent saves of one owner's projects; lock
    order is project → counter on both paths.
- Within one project versions still only increase, but may skip numbers (A: 1, 2; B: 3; A: 4).
  `expectedVersion` (CAS) keeps its meaning: the project's own latest version. Approvals,
  rejections, signing requests (`request.configVersion`), tasks, the launch2 read model and the
  console all carry the allocated number — they already read it from the config row.
- **Migration 000071**: creates the counter and initialises it from each owner's historical
  maximum. No config, approval, rejection, task or instance row is rewritten; deployed instances
  keep their versions.
- **Signing guard**: `GET …/signing-request` reads the Factory's
  `launchIdByOwnerVersion(keccak(wallet, version))` before producing a signature. Non-zero (a draft
  saved before this decision colliding with a deployed project of the same wallet) →
  `422 VALIDATION_FAILED`, `reasonCode HOOKS_CONFIG_VERSION_USED` (re-save → new version → review).
  Unreadable → `503 CAPABILITY_UNAVAILABLE HOOKS_LAUNCH_FACTORY_UNAVAILABLE` (fail closed). The
  executor's own `HOOKS_LAUNCH_ALREADY_DEPLOYED` check is unchanged.
- Evidence: `test/hooks-launch-executor-anvil.integration.test.ts` (anvil 97: one owner wallet, two
  projects deployed and activated with versions 1 and 2 and different launchIds; a legacy version-1
  draft of a third project is refused with `version_used`), `test/hooks-launch-repositories.integration.test.ts`
  (cross-project / operator / concurrent allocation, wallet-address history, counter guards),
  `test/v2-hooks-launch-routes.test.ts` (422 / 503 mapping).

## 2. GET routes on a read-only database

Probed with a `default_transaction_read_only=on` app (`test/v2-read-only-get-routes.integration.test.ts`)
against the same requests on a writable one:

| Route                                                                             | What it wrote                                                                                                                                                                                                | Change                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/market/overview`, `/new-pairs`, `/assets/{id}`, `/candles`, `/holders`   | `market_fact_cache` upserts after each Provider read (pairs, batch pairs, price-change memory, unlisted identity). Only `MarketFactCacheUnavailableError` was swallowed; a PostgreSQL error escaped → `500`. | The API's fact service gets `onCacheWriteFailure`: any cache write failure is logged (`factKind`, `source`, error summary) and the observed fact is returned. Workers (sparkline warm, alert evaluator, mining snapshot) do not opt in — writing is their job, their failures still propagate. |
| `GET /v2/wallets`                                                                 | `account_wallets` sync (upsert / archive / pick active) on every call. Failure → `500`.                                                                                                                      | On a sync failure that is not a domain error, the stored inventory is served only if it equals what Privy reported (same active addresses, kinds, provider ids, exactly one active); otherwise `503 CAPABILITY_UNAVAILABLE`. Logged as `Wallet inventory sync failed`.                         |
| `GET /v2/referral`                                                                | first-read issuance of the account's invite code (+ audit event). Already `503`.                                                                                                                             | Unchanged: once issued it is a pure read; a first issuance cannot be answered without inventing a code, so it stays `503 CAPABILITY_UNAVAILABLE`.                                                                                                                                              |
| `GET /v2/search?domain=users\|communities`, `GET /v2/communities/{id}/members?q=` | alias-search quota buckets (anti-enumeration meter). Already `503`.                                                                                                                                          | Unchanged, fail-closed: failing open on a quota write would let enumeration bypass the meter.                                                                                                                                                                                                  |
| `GET /v2/blocks?kind=contract\|domain`                                            | nothing — not storage-backed, `503` in every mode                                                                                                                                                            | Unchanged; a false positive of the preflight (it treated every 503 as a write).                                                                                                                                                                                                                |

Cross-cutting: a GET/HEAD whose error carries SQLSTATE `25006` maps to `503 CAPABILITY_UNAVAILABLE`
`reasonCode DATABASE_READ_ONLY`; class `08`, `57P01`–`57P03`, `53300` map to
`DATABASE_UNAVAILABLE`. Writes and other SQLSTATEs are unchanged (`500` stays `500`).

## 3. Official-pool market trades apart from buybacks (main-agent default, pending user confirmation)

- `launch2_pool_swaps.caller_address` is the PoolManager `Swap` sender; buybacks are sent by the
  instance's `OfficialV4BuybackAdapter` (`buyback_adapter_address`; the executor address is
  excluded too for safety).
- Projection columns `launch2_instances.pool_user_trade_count`, `pool_user_buy_volume_usd1`,
  `pool_user_sell_volume_usd1` = the pool totals over swaps whose caller is neither address,
  recomputed with the other `pool_*` columns (same graduation rule; reorg-safe), bounded by a check
  (`≤` the totals). Migration 000072 backfills them from the non-removed facts of graduated
  instances only.
- `instance.pool` gains required `userTradeCount` (uint string), `userBuyVolumeUsd1`,
  `userSellVolumeUsd1` (decimal strings). `tradeCount` / `buyCount` / `sellCount` /
  `buyVolumeUsd1` / `sellVolumeUsd1` / `volume24hUsd1` / taxes keep their meaning (every swap).
- Evidence: keeper anvil suite (three buybacks → `tradeCount 3`, `userTradeCount 0`), pool anvil
  suite (router trades → both equal), route test.

## 4. Error codes and unavailable behaviour (new)

| Status | code                     | reasonCode                                    | When                                                                                          |
| ------ | ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 422    | `VALIDATION_FAILED`      | `HOOKS_CONFIG_VERSION_USED`                   | signing request for a (wallet, version) the Factory already recorded                          |
| 503    | `CAPABILITY_UNAVAILABLE` | `DATABASE_READ_ONLY` / `DATABASE_UNAVAILABLE` | any GET whose database work fails for those SQLSTATEs                                         |
| 503    | `CAPABILITY_UNAVAILABLE` | (none)                                        | `GET /v2/wallets` when the inventory cannot be recorded and the stored one differs from Privy |

## 5. Open items

1. Section 3 is the main agent's default; the user has not confirmed whether market statistics
   should exclude buybacks. Both readings are available; switching the UI is a client choice.
2. `instance.pool` has three new required keys and `GET /v2/launch2/instances/{id}` responses are
   decoded strictly by the shipped App: the API must not reach a device before an App build that
   accepts them.
3. Allocation scope is the LOOP account, not a single wallet: an owner using several wallets sees
   versions advance across all of them (harmless — versions only need to be unique per wallet).
4. Alias-search quota and first invite-code issuance stay fail-closed under a read-only database;
   preflight captures for those need a writable scratch copy.
