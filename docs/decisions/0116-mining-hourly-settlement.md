# Decision 0116: Mining hourly settlement, five-level referral power, minute display, claim vouchers (S138-api)

- Status: Accepted (S138-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `8c4e038`
- Inputs: `docs/16-挖矿与邀请-中心化结算方案.md` (§1 rules, §2 choices, §5 rulings, §6 frozen
  claim interface), requirer handoff `LOOP双轨挖矿开发说明-20261010.md` (§6–§9),
  Decisions 0046 (formula versions), 0107 (S125 pure functions), 0110/0111 (formula
  approval separation of duties), 0114 (launch2 read model), 0101 (MEME v1 curve).
- Scope: migration `000062_mining_hourly_settlement`, worker lane
  `mining_hourly_settlement` (default off), `GET /v2/mining/rewards` (additive `hourly`
  block), `GET /v2/mining/rewards/epochs`, `POST /v2/mining/claim/prepare`,
  `POST /v2/mining/claim/report`, `GET /v2/mining/claims`, and `/admin/v1/mining/...`
  parameter versions / epochs / replay / funding. No new capability: everything sits
  under `mining`.

## Entities and IDs (migration 000062)

| Table                         | Key                                                                                           | Notes                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mining_parameter_versions`   | `version_id` (opaque UUIDv4); unique `config_version`                                         | Five referral ratios (bps), two daily budgets (raw), release start (UTC midnight), release days, minimum claim, admitted asset weights, community coefficients (frozen copy), `effective_from`. `pending_approval → approved` (reviewer) or `→ withdrawn` (platform admin). Approved rows are immutable. |
| `mining_epochs`               | `epoch_id` (opaque); unique `hour_start`, unique `idempotency_key`                            | One UTC hour `[hour_start, hour_end)`. `pending → settling → settled` or `failed` (retryable). Budgets, denominators, allocated / unallocated per track, parameter version, `input_digest` (SHA-256 of canonical inputs), `input_summary`.                                                               |
| `mining_epoch_rewards`        | `(epoch_id, owner_user_id)`                                                                   | Both tracks: self power, referral power (sum) and per-level breakdown (`referral_levels` jsonb: ratio, effective members, NFT / asset power, equivalent NFT units by community), total power, rewards; `total_reward_raw = nft + asset` (check).                                                         |
| `mining_reward_ledger_events` | `event_id`; unique `(epoch_id, owner_user_id)` for `settled`, unique `claim_id` for `claimed` | Append-only (trigger). The only writer of the balance projection.                                                                                                                                                                                                                                        |
| `mining_reward_balances`      | `owner_user_id`                                                                               | Projection: `settled_total_raw`, `claimed_total_raw`, generated `unclaimed_raw`; `claimed ≤ settled` (check).                                                                                                                                                                                            |
| `mining_claims`               | `claim_id` (opaque); unique `idempotency_record_id`, unique `transaction_hash`                | Voucher: wallet (id + address), `cumulative_amount_raw`, `nonce`, `deadline`, signature, expected delta; state machine below; tx hash, block, confirmed delta.                                                                                                                                           |

The legacy `mining_reward_ledger` (000023, never written) is left untouched; it keeps its
`REWARD_AUTHORITY_PENDING` meaning for the legacy `claimable` / `accumulated` keys of
`GET /v2/mining/rewards`. Wallet addresses are facts on chain tables and the voucher only;
every user-facing key is an opaque ID. `idempotency_records` admits
`mining_claim_prepare_v1` and `mining_claim_report_v1`.

## Settlement algorithm (pure: `src/features/mining/hourly-settlement-calculator.ts`)

1. **Hour**: UTC `[H-1, H)`; settled only after `H + MINING_SETTLEMENT_INDEXER_GRACE_SECONDS`
   (default 120) and after every source lane that has instances (`launch2_event`,
   `meme_event`) checkpointed after that instant; otherwise the hour waits
   (`MINING_SETTLEMENT_INDEXER_BEHIND`), it is not failed.
2. **Parameter version**: the approved version with the greatest `effective_from ≤ t`.
   Budgets and referral ratios come from the version in force at the hour start;
   community coefficients and asset weights are sliced by `effective_from` inside the
   hour. No version in force at the hour start → the hour is not settled
   (`MINING_PARAMETERS_PENDING`). Hours before `releaseStartAt` or after
   `releaseStartAt + releaseDays` have no budget and are not settled.
3. **Hour budget** per track: `floor(daily / 24)`; hour 23 (UTC) gets
   `daily − 23 × floor(daily / 24)`, so a full day equals the daily budget exactly
   (500,000 LOOP: 20,833.333333333333333333 per hour, hour 23 + 8 wei).
4. **NFT self power** (fixed point 1e18): `Σ count(t) × coefficient(community, t)`
   integrated over the hour. Holdings are the ERC-721 `Transfer` timeline of every
   `launch2_instances.nft_address` (block time `event_at`); the community is the one whose
   `bound_asset_key` is the instance's MEME asset; a coefficient comes only from the
   parameter version (absent → 0, reported as `unweightedInstances`). NFTs stay valid
   after graduation (§5.4).
5. **Asset self power**: `Σ balance(t) × price(t) × weight(t)` integrated. Balances are
   curve net positions (`launch2_trades`, MEME v1 `meme_trades`); for launch2 MEME transfers
   are locked until graduation, so curve net equals balance (Decision 0114 fact 4). Price
   is the curve price after the last trade (`launch2PriceAt(sold_after)`,
   `meme_trades.price_after_e18`), a step function, so its hourly integral is the exact
   TWAP. After graduation neither balance nor price is indexed: the asset leaves the
   asset pool from `graduated_at` for everyone (`MINING_ASSET_GRADUATED_UNREADABLE`, listed
   in `input_summary.excludedAssets`) until official-pool price and transfer facts exist.
   Only assets with a positive weight in the version count (new assets weight 0).
6. **Attribution**: an address counts for the user whose `account_wallets` row is
   `active`; an address bound to two users is excluded (`ambiguousAddresses`); unbound
   addresses are dropped (`unattributedAddresses`).
7. **Five-level referral** (both tracks, no cap, §5.1): for every `referral_edges` row
   (depth 1..5) overlapping the hour, the inviter at that depth gets
   `ratioBps(depth) / 10000 × ∫ invitee self power` over the overlap of the edge's
   `[effective_from, effective_to)` with the hour. Only the invitee's **self** power is
   used (no recursion), the invitee is not reduced, NFT feeds NFT and asset feeds asset,
   depth > 5 does not exist in the graph. An invitee with zero self power contributes
   nothing and is not counted as effective (§5.2). Equivalent NFT units are kept per
   source community (`count × ratio`, decimal) and never become NFT holdings.
8. **Allocation** per track: `reward = floor(budget × total_u / Σ total)` with
   `total = self + referral` integrals (S125 `allocatePoolBudget`). Σ = 0 → nothing is
   allocated, the budget is not moved to the other track and not carried
   (`unallocated_*`). Rounding dust is unallocated.
9. **Idempotency**: `mining_epochs.idempotency_key = mining_hourly:<hour_start ISO>`;
   the epoch row is locked, rewards + `settled` ledger events + balances are written in
   one transaction; a settled epoch is never recomputed, a re-run is a no-op, the unique
   `(epoch_id, owner_user_id)` on settled events makes a double write impossible.
10. **Replay**: `GET /admin/v1/mining/epochs/{epochId}/replay` re-reads the same sources,
    recomputes, and compares `input_digest` and every reward row; nothing is written.

## Minute display (pure: `hourly-display.ts`, mirrored by the client)

`lastEpoch` = the newest settled epoch. With `now` in `[lastEpoch.hourEnd,
lastEpoch.hourEnd + 3600)`: `completedMinutes = floor((now − hourEnd) / 60)`,
`displayedAmount = floor(total × completedMinutes / 60)`, so minute 60 shows exactly
`total` (the remainder lands on the last minute). `displayState`:
`awaiting_first_settlement` (no settled epoch), `displaying` (inside the window),
`settling` (window over, next hour not settled yet: shows the full previous total),
`unavailable` (no repository / parameters). The display never changes the ledger;
`claimable` always comes from `mining_reward_balances`.

## Claim (EIP-712 voucher, Decision docs/16 §6)

Domain `LoopRewardClaim` / `1` / chain id / `MINING_REWARD_CLAIM_ADDRESS`; type
`Claim(address wallet,uint256 cumulativeAmount,uint256 nonce,uint256 deadline)`.

- `prepare` (Bearer, Idempotency-Key, `{walletId}`): embedded active wallet; chain reads
  `nonces(wallet)`, `claimed(w)` for this wallet and every wallet the user claimed with
  before, `paused()`, `balance()`. `paidOnChain = Σ claimed(w)`;
  `claimable = settled − paidOnChain`; `cumulativeAmount = claimed(wallet) + claimable`
  (so a second wallet never re-receives what the first was paid); deadline = now + 600 s.
  Refused while another claim is `submitting` / `confirming`, or a voucher for another
  wallet is still within deadline + 60 s (`MINING_CLAIM_IN_FLIGHT`). Simulates the call;
  checks native gas: short → `409 INSUFFICIENT_BALANCE` with
  `reasonCode CLAIM_GAS_INSUFFICIENT` and `suggestedSwapFrom/To/Amount` (BNB to buy) when
  USDT (`MINING_CLAIM_USDT_ADDRESS`) is held, else `reasonCode CLAIM_NO_GAS_SOURCE`.
  Returns the unsigned transaction for `device_eth_send_transaction`; the server never
  signs or sends a transaction. Every new prepare signs a fresh voucher; the previous one
  dies by nonce once any claim lands.
- `report` (`{claimId, transactionHash}`): reads the receipt; the `Claimed` log of the
  contract for that wallet and nonce is the only proof. Not found → `submitting`; mined,
  fewer than `MINING_CLAIM_CONFIRMATIONS` (default 3) → `confirming`; confirmed →
  `succeeded` and one `claimed` ledger event with the **logged** amount; reverted →
  `failed` (balance untouched). Re-reporting the same hash is idempotent; another hash on a
  claim that already has one is `409 RESOURCE_CONFLICT`.
- The worker re-checks `submitting` / `confirming` claims each tick and expires vouchers
  past deadline whose nonce is unused; a voucher whose nonce was consumed without a report
  is resolved from the `Claimed` log (bounded block range after the prepare block).

State machine: `claimable → submitting → confirming → succeeded`, `→ failed`, and
`claimable → expired`. Cancel/failure never touches the balance; only a confirmed
`Claimed` log moves `claimed_total_raw`.

## Unavailable behaviour (fail closed)

| Missing                                         | Effect                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| settlement repository                           | `hourly.displayState = unavailable` (`MINING_SETTLEMENT_UNAVAILABLE`); epochs/claims 503          |
| approved parameter version                      | worker idle `MINING_PARAMETERS_PENDING`; `hourly` = `awaiting_first_settlement`                   |
| `MINING_REWARD_SIGNER_PRIVATE_KEY`              | prepare 503 `MINING_CLAIM_SIGNER_NOT_CONFIGURED`                                                  |
| `MINING_REWARD_CLAIM_ADDRESS` / launch slot RPC | prepare / report 503 `MINING_CLAIM_CONTRACT_NOT_CONFIGURED` / `MINING_CLAIM_CHAIN_NOT_CONFIGURED` |
| launch slot = BSC Mainnet                       | prepare 503 `MINING_CLAIM_MAINNET_CLOSED`                                                         |
| `BSC_WRITES_ENABLED` off                        | prepare 503 `MINING_CLAIM_WRITES_DISABLED`                                                        |
| contract paused / underfunded                   | prepare 503 `MINING_CLAIM_CONTRACT_PAUSED` / `MINING_CLAIM_FUNDING_INSUFFICIENT`                  |
| chain read failure                              | 503 `MINING_CLAIM_CHAIN_READ_FAILED`                                                              |

## Admin (`/admin/v1/mining/...`, Decision 0109 roles)

Parameter drafts `console.write` (platform_admin) → approve `formula.approve` (reviewer,
not the author, bound operator enabled; audit `mining.parameters.approve.requested` then
`mining.parameters.approve` / `.failed`) → in force at `effective_from`. Epoch list /
detail / replay: `console.read` or `audit.read` (auditor, reviewer). Funding:
`balance()` vs Σ `unclaimed_raw`, `alert = balance < liability`. Manual settlement of a
completed hour: `console.write` and only with `MINING_SETTLEMENT_TEST_TRIGGER=true`
outside production.

## Deviations from docs/16

- Legacy `mining_reward_ledger` kept; new ledger is `mining_reward_ledger_events` +
  `mining_reward_balances`.
- `GET /v2/mining/rewards` keeps every existing key; the new data is the additive `hourly`
  block.
- Error envelope only allows scalar `detailsSafe`: `suggestedSwap` is flattened to
  `suggestedSwapFromSymbol`, `suggestedSwapToSymbol`, `suggestedSwapToAmount`.
  `CLAIM_GAS_INSUFFICIENT` / `CLAIM_NO_GAS_SOURCE` are reason codes under
  `409 INSUFFICIENT_BALANCE` (the catalog is closed).
- Graduated MEME assets leave the asset pool (no balance / price facts after graduation).
- Anti-cheat and "stopped / restricted" member states have no source yet; effectiveness
  is wallet binding + self power > 0.
