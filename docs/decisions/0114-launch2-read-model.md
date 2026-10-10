# Decision 0114: MEME v2 (`launch2`) read model, `launch2_event` lane, `/v2/launch2/*` (S134)

- Status: Accepted (S134-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `3a0bf9c`; contracts `loop-contracts` `529b35f` (`protocol/`)
- Inputs: `docs/modules/S134-S137-meme-v2-app.md` §1–§2 (design), `LOOP-整体方案` §1–§5,
  loop-contracts Decision 0002, Decisions 0101/0103/0104 (S116 lane discipline), 0108/0112
  (S125/S132 tasks, `activated` = launchId + 11 module addresses).
- Scope: migration `000061_launch2_read_model`, worker lane `launch2_event` (default off),
  seven `/v2/launch2/*` routes, capability `launch2` (default deferred), V2 module id
  `launch2`. Project-side routes stay the S125 ones; nothing new is signed or sent server-side.

## Contract facts the read model relies on (from `protocol/src`)

| Contract                | Events indexed                                             | Views read                                                                                    |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `LoopLaunchFactory`     | `LaunchDeployed` (address cross-check)                     | —                                                                                             |
| `LaunchPublicationGate` | `LaunchActivated(launchId, configHash, activatedAt)`       | `published`                                                                                   |
| `ProjectNFT`            | `NftMinted`, ERC-721 `Transfer`                            | `mintedByAddress`, `totalMinted`                                                              |
| `SnapshotRegistry`      | `SnapshotPublished(root, cutoffBlock, cutoffBlockHash, …)` | `rootPublishedAt`; `publishSnapshot` calldata (signatures)                                    |
| `CurveEngine`           | `CurveBought`, `CurveSold`, `Graduated(officialPoolId, …)` | `soldSupply`, `accountedReserve`, `cumulativeBought`, `earlyRoundEndsAt`, `graduated`, `usd1` |
| `BuybackExecutor`       | `BuybackCompleted`, `BuybackPausedEvent`, `BuybackResumed` | `paused`, `lastSuccessfulAt`, `quoteNextOrder`                                                |
| `NftEscrow`             | —                                                          | `availableBudget`, `totalRecorded`, `totalSpent`                                              |

ABI: `pnpm hooks:abi-sync` (S132 mechanism) with the selection extended by these items;
`src/integrations/launch/hooks-launch-protocol-abi.generated.ts` regenerated from `529b35f`.

Facts that shape the design: (1) the curve and the NFT have **no pause** — only the buyback
executor pauses; (2) a buyback refused by a protection **reverts and leaves no log**; (3)
`SnapshotRegistry` verifies 2-of-3 signatures but not the holder list, and the format of
`dataHash` is not specified anywhere; (4) MEME transfers are locked until graduation, so
curve net = balance before graduation; (5) `sell` opens only after `earlyRoundEndsAt`.

## Entities and IDs (migration 000061)

| Table                      | Key                                                         | Notes                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch2_instances`        | `instance_id` (opaque UUIDv4); unique `job_id`, `launch_id` | Registry columns copied from the activated S132 task + approved config (11 addresses, sale start, buyback recipient); lane-owned projection (stage, next change, NFT sold, curve, snapshot, graduation, buyback, hold) |
| `launch2_events`           | `(chain_id, transaction_hash, log_index)`                   | Every decoded log, `removed` on rewind                                                                                                                                                                                 |
| `launch2_nft_mints`        | same                                                        | `NftMinted`                                                                                                                                                                                                            |
| `launch2_trades`           | same; opaque `trade_id`                                     | Buy: gross = reserveIn + tax, refund, cumulative; sell: net, tax, sold after                                                                                                                                           |
| `launch2_buybacks`         | same; opaque `buyback_id`                                   | `outcome executed` from `BuybackCompleted`; `rejected` admitted for a future keeper (no log exists)                                                                                                                    |
| `launch2_snapshot_members` | `member_id`; unique `(instance_id, member_address)`         | Cutoff holders rebuilt from transfers; `proof` only when verified                                                                                                                                                      |
| `launch2_positions`        | `position_id`; unique `(instance_id, holder_address)`       | NFT minted token / held, curve bought / sold, cumulative quota, USD1 spent / received, snapshot member                                                                                                                 |
| `launch2_intents`          | `intent_id`; unique `idempotency_record_id`                 | Append-only prepared signing requests (trigger refuses update/delete)                                                                                                                                                  |

Addresses are facts of chain tables only; nothing user-facing is keyed by them. The
`indexer_checkpoints` lane check admits `launch2_event`; `idempotency_records` admits
`launch2_intent_v1`. `canary-exposure.ts` adds open `launch2_intents` to the one rolling
canary window. `dev:reset-users` classifies the new tables (and the S132 events / nonces
it was missing).

## Stage machine (服务端唯一真相)

`deriveLaunch2Stage` (pure, `src/features/launch2/launch2-stage.ts`), evaluated by the lane
every tick (stored `stage` / `next_change_at`) and again on every route answer:

```
hold ─────────────────────────────────────────────▶ paused
Graduated seen ───────────────────────────────────▶ graduated   (any round; the last buy graduates atomically)
now < saleStart ──────────────────────────────────▶ upcoming     next = saleStart
saleStart ≤ now < saleStart + 604,800 ────────────▶ nft_sale     next = sale end
sale over, no SnapshotPublished ──────────────────▶ snapshot_pending (no clock)
published ≤ now < published + 3,600 ──────────────▶ priority     next = round end
afterwards ───────────────────────────────────────▶ public       (ends only by selling out)
```

Instances are listed only once the gate's `LaunchActivated` is indexed (or with a hold).
Trading routes re-check the contract's own gate on the chain state of the same block
(published, graduated, block time vs `earlyRoundEndsAt`).

**Holds (`paused`)**: `LAUNCH2_DEPLOYED_EVENT_MISMATCH` (the Factory's `LaunchDeployed`
names other module addresses / owner than the task) and `LAUNCH2_ACTIVATION_MISSING` (the
task says activated, but no gate `LaunchActivated` exists `reorgDepth` blocks past the
activation block). The buyback pause is `buyback.paused`, not a stage.

## Lane `launch2_event`

Per tick: register activated tasks of the configured Factory → read logs of the Factory and
each instance's gate / NFT / snapshots / curve / buyback executor over ≤ 2,000 blocks (one
`getLogs` with the address list, decoded per role; foreign Factory deployments are counted,
never attributed) → commit (rewind, upserts, per-instance reprojection, checkpoint) in one
transaction → verify published snapshots → refresh stages. Checkpoint discipline is S116's:
seed at the oldest deploy block; hash mismatch at the checkpoint rewinds by the slot's reorg
depth and marks facts above it `removed`; a late-registered instance re-scans from its
deploy block (idempotent upserts, no rewind).

Snapshot verification: holders with balance > 0 at `cutoffBlock` (from indexed transfers) →
`buildLaunchMerkleTree` (Decision 0077 construction: `keccak256(abi.encodePacked(address))`
leaves, sorted-pair nodes — exactly `SnapshotRegistry.isEligible`) → root must equal the
published root, the block hash at `cutoffBlock` must equal `cutoffBlockHash`, and the block
must be the last one before the sale end (its timestamp < end ≤ next block's). Verified →
proofs stored; otherwise `mismatch`, no proofs, and priority-hour buys fail closed
(`503 LAUNCH2_SNAPSHOT_UNVERIFIED`). Signatures are decoded from the publishing transaction
and the signers recovered (EIP-712 `LOOP NFT Snapshot` v1); a multisig-routed publication
leaves `signers` null. `dataHash` is stored, not interpreted.

Env (worker): `LAUNCH2_INDEXER_ENABLED=false`, `LAUNCH2_INDEXER_POLL_INTERVAL_MS=3000`;
Factory = `HOOKS_LAUNCH_FACTORY_ADDRESS`; RPC = the launch slot. Missing → the lane logs the
reason and stays idle. Logs: lane, reason code, opaque instance id, counts.

## MAX and quotes

`launch2-curve-math.ts` ports `CurveMath` and `CurveEngine._quoteBuy / quoteMaxBuy /
quoteSell / _grossForNet` in BigInt with the Solidity roundings; the anvil suite asserts
equality with the deployed contract's `quoteMaxBuy` / `quoteBuy`. MAX (整体方案 §3):
buy = min(remaining 0.5 % quota, remaining inventory) priced on the curve with the 10 % tax
(`limitedBy quota | inventory`), lowered to the wallet USD1 balance (`balance`); sell = MEME
balance bounded by sold supply (`balance | sold_supply`); `closed` outside the open rounds.
Quote `deadline` = max(now, block time) + `LAUNCH2_QUOTE_TTL_SECONDS` (60); `minOut` from
`slippageBps` (default `LAUNCH2_DEFAULT_SLIPPAGE_BPS` = 100).

Prepare discipline = Decision 0101 MEME v1 (one snapshot block, canary 0065 with USD1 at par,
exact `approve` first when the allowance is short, simulation when no approval is needed,
`device_eth_send_transaction`, Idempotency-Key replays the same Intent). There is no
broadcast-report route in the design; the lane sees the fill.

## Error codes

| HTTP | code                     | detailsSafe.reasonCode                                                                                                                                                                                                                                                                    |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 503  | `CAPABILITY_UNAVAILABLE` | `LAUNCH2_FACTORY_NOT_CONFIGURED`, `LAUNCH2_CHAIN_NOT_CONFIGURED`, `LAUNCH2_REPOSITORY_UNAVAILABLE`, `LAUNCH2_RUNTIME_UNAVAILABLE`, `LAUNCH2_CHAIN_READ_FAILED`, `LAUNCH2_WALLETS_UNAVAILABLE`, `LAUNCH2_WRITES_DISABLED`, `LAUNCH2_MAINNET_SIGNING_CLOSED`, `LAUNCH2_SNAPSHOT_UNVERIFIED` |
| 404  | `NOT_FOUND`              | `LAUNCH2_INSTANCE_NOT_FOUND` (unknown / not activated); wallet not the caller's: no reason                                                                                                                                                                                                |
| 409  | `DATA_STALE`             | `LAUNCH2_STAGE_MISMATCH` (`stage`), `LAUNCH2_SELL_NOT_OPEN`, `LAUNCH2_SOLD_OUT`, `LAUNCH2_QUOTA_EXHAUSTED`, `LAUNCH2_INSTANCE_PAUSED` (`holdReason`), `LAUNCH2_NFT_ALREADY_MINTED`, `LAUNCH2_PRICE_MOVED` (`expectedOut`, `minOut`)                                                       |
| 409  | `QUOTE_EXPIRED`          | `LAUNCH2_QUOTE_EXPIRED`                                                                                                                                                                                                                                                                   |
| 409  | `INSUFFICIENT_BALANCE`   | `LAUNCH2_USD1_BALANCE_INSUFFICIENT`, `LAUNCH2_MEME_BALANCE_INSUFFICIENT` (`maxAmountIn`), `LAUNCH2_GAS_INSUFFICIENT`                                                                                                                                                                      |
| 409  | `IDEMPOTENCY_CONFLICT`   | —                                                                                                                                                                                                                                                                                         |
| 422  | `VALIDATION_FAILED`      | `LAUNCH2_AMOUNT_INVALID`, `LAUNCH2_AMOUNT_ABOVE_MAX` (`maxAmountIn`, `maxAmountOut`, `limitedBy`), `LAUNCH2_DEADLINE_TOO_FAR`, `LAUNCH2_QUOTE_ZERO`, `LAUNCH2_WALLET_NOT_EMBEDDED`                                                                                                        |
| 403  | `POLICY_BLOCKED`         | `LAUNCH2_NOT_IN_SNAPSHOT`; canary reasons of Decision 0065                                                                                                                                                                                                                                |
| 400  | `INVALID_REQUEST`        | malformed query / body / cursor                                                                                                                                                                                                                                                           |

## Unavailable behaviour

Module off → no route, capability `deferred / LAUNCH2_MODULE_NOT_ENABLED`. Module on without
the Factory pair, off chain 97, without RPC, store, or cursor codec → every route 503 with
the reason and capability `unavailable` with it. Lane off → instances simply never appear
(empty list, not fixtures). Chain read failure on a quote / prepare → 503
`LAUNCH2_CHAIN_READ_FAILED`; on the buybacks route only `live` is null with
`liveUnavailable.reasonCode`. Evidence stays `pending / LAUNCH2_TESTNET_EVIDENCE_PENDING`.

## Differences from the design (S134-S137 §1–§2)

1. Stage `upcoming` added (activated, before the NFT sale opens); the design's table starts at
   `nft_sale` but activation must precede the sale by the buffer.
2. `paused` is an integrity hold, not "合约暂停": the curve and NFT cannot be paused on chain;
   the buyback pause is reported as `buyback.paused`.
3. Rejected buybacks are not listed: a protection refusal reverts without a log. The live
   `nextOrderBlockedReason` (from `quoteNextOrder` + views) shows what would refuse now.
4. "毕业后池地址": v4 pools have no address; the API returns `officialPoolId` + Hook address +
   fee / tick spacing.
5. `POST /v2/launch2/projects`, `GET /v2/launch2/projects/mine` not added (task: reuse S125).
6. Trades of the curve are in the detail (`recentTrades`, 20) — no separate trades route.

## Evidence

- Unit: `test/launch2-stage.test.ts` (incl. sold-out graduation in both rounds, hold),
  `test/launch2-curve-math.test.ts` (MAX by quota / inventory / balance, sell, closed),
  `test/launch2-indexer-worker.test.ts` (seed, routing, reorg rewind, late registration,
  snapshot reproduce / mismatch / wrong cutoff, stage refresh),
  `test/v2-launch2-routes.test.ts` (503 / deferred, shapes vs schemas, MAX, stage refusals,
  quote expiry before any chain read, price moved, above MAX, not in snapshot, unverified
  snapshot, NFT prepare, writes off, buybacks, positions).
- Integration (anvil chain 97, real Foundry deploy, throwaway database):
  `test/launch2-anvil.integration.test.ts` — S125/S132 deploy + activate → lane registers →
  2 NFT mints (one via the prepare) → 2-of-3 snapshot published → lane verifies → priority
  buy via quote + prepare (MAX / quote equal `quoteMaxBuy` / `quoteBuy`) → outsider 403 →
  instances / positions / trades equal the chain → rewind + checkpoint-hash reorg converge →
  intents append-only and counted in the canary window. No BSC Testnet run.

## Open (for the coordinator)

- Who builds and publishes the snapshot (2 of 3 signers) and the `dataHash` format — not
  defined by the contracts or the spec; the lane accepts any `dataHash` but requires the
  root to equal the Decision 0077 tree of the cutoff holders.
- Whether `paused` should instead follow the buyback pause after graduation.
- A buyback keeper (and recording of refused attempts) is not in this batch.
- No broadcast-report / intent read route; add if the App needs pending-state tracking.
