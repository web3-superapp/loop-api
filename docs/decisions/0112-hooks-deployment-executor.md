# Decision 0112: Hooks deployment executor — broadcast, receipts, reorgs, module verification, activation (S132)

- Status: Accepted (S132-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `91b45a7`; contracts `loop-contracts` `33ed921` (`protocol/`)
- Builds on: Decision 0108 (signed `awaiting_executor` tasks), Decision 0109 (console),
  `LOOP-整体方案` §1 ("部署和激活不同：未激活实例不得 mint、买入或卖出收款", "链上核验并激活").
- Scope: migration `000059`, one worker lane (`hooks_launch_executor`, default off), the task
  resource of the three existing `/v2/launch/projects/{projectId}/hooks-deployments*` routes
  gains executor fields, the console detail mirrors them. **No new route, no mainnet, no
  capability change.** `ops/protocol-testnet-deploy.sh` is a runbook script (not executed).

## Contract facts the executor relies on (read from `protocol/src`, ABI from `forge build`)

- `LoopLaunchFactory.deployLaunch(LaunchRequest, hookSalt, projectSignature)` — `onlyExecutor`
  (`deploymentExecutor`), checks chain, deadline, version unused, EIP-712 signature against
  `nonces[projectOwner]`, deploys all modules atomically, increments the owner nonce, emits
  `LaunchDeployed`. The struct has no nonce field (the contract uses its own counter).
- `LoopLaunchFactory.activateLaunch(launchId, confirmedConfigHash)` — `onlyExecutor`; calls
  `LaunchPublicationGate.activateLaunch`, which requires `block.timestamp + buffer < nftSaleStart`
  and the exact config hash, then sets `published = true`. Activation is therefore the
  Factory's entry, not a direct gate call (the gate's `deployExecutor` is the Factory).
- ABI: `src/integrations/launch/hooks-launch-protocol-abi.generated.ts`, produced by
  `pnpm hooks:abi-sync` from `protocol/out/<C>.sol/<C>.json` (selected items + every error).
  `pnpm hooks:abi-sync --check` and `test/hooks-launch-protocol-abi.test.ts` compare it with
  the current Foundry build when the protocol checkout is present.

## State machine (migration 000059)

```
awaiting_executor ──claim──▶ claimed ──persist tx──▶ broadcast ──N conf──▶ confirmed ──verify──▶ verified ──activate + N conf──▶ activated
        │                      │  ▲                     │  │                  │   │                 │  │
        └─cancel (owner)       │  └──── reorged ◀───────┘  │                  │   └─────────────────┘  │ (receipt left the chain:
          ▼                    ▼            ▲              ▼                  ▼                        ▼  same tx re-sent)
      cancelled             failed ◀────────┴──────────────┴──────────────────┴────────────────────────┘
                     (retryable → claimed after the delay, attempt + 1; else final)
```

Allowed transitions (trigger `guard_hooks_deployment_task`, rewritten): `awaiting_executor →
claimed | cancelled`, `claimed → broadcast | failed`, `broadcast → confirmed | reorged |
failed`, `confirmed → verified | reorged | failed`, `verified → activated | reorged | failed`,
`reorged → claimed`, `failed → claimed` (only when `failure_retryable`). Same-status updates
only in `claimed/broadcast/confirmed/verified` (lease, confirmations, activation columns).
The S125 columns stay immutable; `tx_hash` changes only on `claimed → broadcast`;
`activation_tx_hash` only while `verified` (or cleared on `reorged → claimed`); attempt
counters only grow; `updated_at` is stamped by the trigger. CHECK constraints tie each state
to its evidence (lease for in-flight states, tx hash + raw tx + nonce + executor from
`broadcast`, block from `confirmed`, `launch_id` + addresses + verification from `verified`,
activation tx + block + time for `activated`, code + retryable flag iff `failed`). Partial
unique indexes keep one live task per project/version and per Factory/owner/nonce (live =
any non-terminal state, `activated`, or a retryable failure) and a unique `tx_hash`.

New tables:

| Table                            | Key                                                         | Notes                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks_launch_deployment_events` | `event_id` (identity)                                       | Append-only (`reject_hooks_review_mutation`): from/to status, kind, tx hash, block, confirmations, error code, safe `details`, `actor`. |
| `hooks_launch_executor_nonces`   | `reservation_id`; unique pending `(chain, executor, nonce)` | `pending → released` only; no delete. The executor nonce is reserved inside the transaction that persists the signed tx.                |

Stable IDs: `jobId` stays the only key. `launchId` (bytes32), every module address, tx hashes
and the executor address are chain facts stored on the task, never keys.

## Executor flow (`src/features/launch/hooks-launch-executor.ts`)

Per tick (default every 5 s): **preflight** — node chain ID 97, Factory runtime code hash =
`HOOKS_LAUNCH_FACTORY_CODE_HASH`, `factory.deploymentExecutor()` = the executor key's address;
any miss keeps the lane idle (`HOOKS_EXECUTOR_WRONG_CHAIN`, `HOOKS_FACTORY_CODE_MISMATCH`,
`HOOKS_EXECUTOR_NOT_AUTHORIZED`) and touches no task. Then up to 8 tasks **of this Factory
only** are leased (`for update skip locked`, lease 120 s, an expired lease is taken over and
recorded as `lease_taken_over`) and each is advanced as far as it can go without waiting:

1. **claimed** — re-read the latest config version and its approval (`HOOKS_CONFIG_SUPERSEDED`,
   `HOOKS_CONFIG_NOT_APPROVED`); pick the stored authorization with the latest deadline whose
   binding hash (shared helper with Decision 0108) and EIP-712 signature still match the task
   (`HOOKS_AUTHORIZATION_INVALID`); the deadline must exceed `max(wall clock, block time) + 60 s`
   (`HOOKS_SIGNATURE_EXPIRED` — **nothing is signed or sent**). If the task already has a
   transaction (reorg / retry): an existing successful receipt → `broadcast`; otherwise, while
   the executor's latest nonce has not passed it and its reservation is still pending, the
   **same raw bytes** are re-sent (`rebroadcast`, same hash). Else: owner Factory nonce
   unchanged (`HOOKS_OWNER_NONCE_CONSUMED`), version not yet deployed
   (`HOOKS_LAUNCH_ALREADY_DEPLOYED`), `nftSaleStart > block time + buffer + 120 s`
   (`HOOKS_ACTIVATION_WINDOW_CLOSED`, so nothing is deployed that could not be activated),
   `eth_estimateGas` (revert → `HOOKS_DEPLOY_SIMULATION_REVERTED` with the contract error
   name), gas × 1.25 ≤ cap (`HOOKS_DEPLOY_GAS_ABOVE_CAP`), gas price ≤ cap (else idle
   `HOOKS_GAS_PRICE_ABOVE_CAP`, no state change). Then **one transaction**: lock the task,
   advisory-lock the executor, reserve the lowest nonce ≥ the chain's pending count that no
   pending reservation holds, sign locally (legacy tx, chain 97), insert the reservation,
   store `tx_hash` / `raw_tx` / `tx_nonce`, move to `broadcast`, append the event; **commit,
   then send**. A crash after the commit re-sends the same bytes; the same task can never
   produce two different deploy transactions for one live nonce.
2. **broadcast** — receipt by hash. Missing: if a block was already recorded → `reorged`;
   if the executor nonce moved past ours and a second read still finds no receipt →
   `HOOKS_TX_DROPPED` (retryable, reservation released); otherwise re-send the same bytes.
   Found: a different block hash than recorded → `reorged`; a block hash that is not the
   canonical hash at that height → wait; `reverted` → `HOOKS_DEPLOY_REVERTED` (retryable);
   success → record block (`included`) and confirmations; at `HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS`
   (default 3) → `confirmed`.
3. **confirmed** — the same receipt/canonical checks (reorg → `reorged`), then read back and
   **verify** (below). Any failed check → `failed` `HOOKS_VERIFICATION_MISMATCH`
   (not retryable; the event's `details.failedChecks` lists the check names) and **no
   activation is ever sent**. All pass → `verified` with `launch_id`, the 11 module
   addresses, the passed check list and the module code hashes.
4. **verified** — deploy receipt still canonical (else `reorged`; the activation reservation
   is released on re-claim). No activation yet: gate unpublished (else
   `HOOKS_ACTIVATION_STATE_UNEXPECTED`), window still open, `estimateGas(activateLaunch)`
   (revert → `HOOKS_ACTIVATION_SIMULATION_REVERTED`), then the same reserve-sign-persist
   transaction (`activation_broadcast`) and send. With an activation: receipt missing after
   inclusion → re-send (`activation_reorged`); nonce passed → `activation_dropped` (re-sign);
   reverted → re-sign up to `maxAttempts`, then `HOOKS_ACTIVATION_REVERTED`; success with N
   confirmations **and** `gate.published() == true` → `activated`.

Retryable failures are re-claimed after `HOOKS_LAUNCH_EXECUTOR_RETRY_DELAY_SECONDS` (60) with
`attempt_count + 1`; at `HOOKS_LAUNCH_EXECUTOR_MAX_ATTEMPTS` (3) the failure becomes final.
RPC/DB errors never change state: the lane backs off (1 s doubling to 60 s) and retries.

## Verification checks (`src/features/launch/hooks-launch-verification.ts`)

28 named checks, all must pass before activation:

| Check                                             | Compares                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_code_hash`                               | Factory runtime code hash = configured pin                                                                                                               |
| `deployer_code_hashes`                            | the 4 module deployers' runtime hashes = the hashes the Factory pinned immutably (they embed every module's creation code, so module bytecode is pinned) |
| `launch_event`                                    | receipt `LaunchDeployed`: launchId, owner, version, configHash, MEME, Hook, hookSalt = signed/predicted; nft/curve = modules                             |
| `launch_registered`                               | `launchModules(launchId)` exists                                                                                                                         |
| `modules_identity`                                | owner, version, configHash                                                                                                                               |
| `meme_address_predicted` / `meme_suffix_6666`     | MEME = EIP-712-bound CREATE2 prediction; ends in `6666`                                                                                                  |
| `hook_address_predicted` / `hook_permission_bits` | Hook = prediction; `address & 0x3FFF == 0x20CC`                                                                                                          |
| `module_code_present`                             | 11 distinct module addresses, each with code (hashes recorded as evidence)                                                                               |
| `meme_supply`                                     | `totalSupply` = `TOTAL_SUPPLY` = 1e9 × 1e18                                                                                                              |
| `meme_metadata`                                   | name / symbol = signed name / ticker; 18 decimals                                                                                                        |
| `meme_bindings`                                   | launchFactory, curve, graduationAuthority = adapter, not graduated                                                                                       |
| `meme_allocation`                                 | curve holds 8e8, graduation adapter holds 2e8 MEME                                                                                                       |
| `curve_taxes`                                     | buy / sell tax 1000 bps                                                                                                                                  |
| `curve_caps`                                      | per-address cap 5e6 MEME, early round 3600 s                                                                                                             |
| `curve_bindings`                                  | meme, USD1, snapshots, adapter, gate, platform tax receiver = Factory's                                                                                  |
| `curve_untouched`                                 | sold 0, reserve 0, not graduated                                                                                                                         |
| `graduation_reserve`                              | Hook's immutable initial sqrt price = the price recomputed in TypeScript from the 133,333.332 USD1 reserve and 8e8 sale supply                           |
| `hook_params`                                     | 200 bps tax, fee 2500, tick spacing 60, PoolManager / fee vault = Factory's, initializer = adapter, currencies = pool key                                |
| `pool_key`                                        | sorted currencies (USD1, MEME), fee 2500, spacing 60, hooks = Hook                                                                                       |
| `gate_params`                                     | launchId, configHash, nftSaleStart, activation buffer, deployExecutor = Factory                                                                          |
| `gate_unpublished`                                | `published == false` before activation                                                                                                                   |
| `nft_params`                                      | price 100 USD1, 7 days, launchId, USD1, gate, escrow, start, end = start + 7 d, 0 minted                                                                 |
| `escrow_bindings`                                 | USD1, Factory, NFT, buyback executor                                                                                                                     |
| `buyback_params`                                  | recipient = signed `buybackRecipient`; keepers / pause / resume = Factory roles; meme, USD1, budget = escrow, swap adapter                               |
| `adapter_params`                                  | 2e8 LP allocation, fee, spacing, Factory, PoolManager, USD1, currencies, meme, curve, bound, not finalized                                               |
| `snapshot_params`                                 | launchId, NFT, sale end                                                                                                                                  |

Module runtime code hashes are recorded (`verification.codeHashes`) but not compared to a
fixed value: every module carries per-launch immutables, so the binding to reviewed code is
the CREATE2 address equality for MEME and Hook plus the pinned deployer code hashes for the
rest. This is the strongest check available without per-launch reference bytecode.

## Configuration (worker process; all defaults keep it off)

| Key                                           | Default    | Notes                                                                                           |
| --------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `HOOKS_LAUNCH_EXECUTOR_ENABLED`               | `off`      | `on` refuses boot without the key, the Factory pair, or `LAUNCH_CHAIN_ID=97`                    |
| `HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY`           | empty      | 32-byte hex; never logged, never stored; its address must be the Factory's `deploymentExecutor` |
| `HOOKS_LAUNCH_FACTORY_ADDRESS` / `_CODE_HASH` | empty      | Now also parsed by the worker (same both-or-neither rule as the API)                            |
| `HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS`         | `3`        | 1–64                                                                                            |
| `HOOKS_LAUNCH_EXECUTOR_POLL_INTERVAL_MS`      | `5000`     | 1 000–600 000                                                                                   |
| `HOOKS_LAUNCH_EXECUTOR_LEASE_SECONDS`         | `120`      | 30–3 600                                                                                        |
| `HOOKS_LAUNCH_EXECUTOR_MAX_ATTEMPTS`          | `3`        | 1–10 (deploy attempts; also the activation re-sign budget)                                      |
| `HOOKS_LAUNCH_EXECUTOR_RETRY_DELAY_SECONDS`   | `60`       | 10–86 400                                                                                       |
| `HOOKS_LAUNCH_EXECUTOR_GAS_LIMIT_CAP`         | `16000000` | `deployLaunch` measured ≈ 11 M gas                                                              |
| `HOOKS_LAUNCH_EXECUTOR_MAX_GAS_PRICE_GWEI`    | `20`       | above it the lane defers                                                                        |

RPC: the launch chain slot (`LAUNCH_BSC_RPC_URLS`, fallback order). Logs carry the job ID,
status pair, step, tx hash, executor / Factory address and confirmations only (worker log
allowlist extended).

## Wire changes (additive)

- Task resource (POST / GET / DELETE `…/hooks-deployments*`): `status` gains 7 values; new
  `txHash`, `confirmations`, `activationTxHash`, `addresses {predicted, deployed}`, `failure
{code, retryable}`, `attemptCount`, `events[]` (latest 100, oldest first; block numbers as
  decimal strings), `updatedAt`. The S125 keys keep their meaning (`memeAddress` /
  `hookAddress` remain the predictions). Never returned: signatures, raw transactions, keys.
- `DELETE` once claimed: `409 VERSION_CONFLICT`, `detailsSafe.reasonCode =
HOOKS_DEPLOYMENT_NOT_CANCELLABLE` (was: returned unchanged — no claimed state existed).
- Console: stage `activated`; `deploying` covers every state the executor still owns;
  `deploymentTasks[]` adds executor fields and events with safe `details` and `actor`
  (`docs/frontend-admin-role-separation.md` §11). No executor write endpoint exists.

## Error codes

Wire codes are unchanged (`409 VERSION_CONFLICT` gains one reason code). Task failure codes
and lane idle reasons are listed above and in `docs/frontend-v2-hooks-launch-api.md` §9.2.

## Unavailable behaviour (fail closed)

Executor off (default): tasks stay `awaiting_executor`, routes answer as before. On but the
Factory does not authorize the key, the code hash differs, or the node is not chain 97: the
lane idles with the reason and claims nothing. Mainnet signing stays closed (config refuses
`LAUNCH_CHAIN_ID=56`). No fixture or simulated progress is ever shown.

## Evidence

- `test/hooks-launch-executor-anvil.integration.test.ts`: `anvil --chain-id 97`, the real
  `DeployBscTestnetBase` + `DeployLoopFactoryBscTestnet` Foundry scripts (roles = anvil
  accounts 1–11), throwaway PostgreSQL database; owner draft → independent approval →
  signing request → EIP-712 signature → submission → executor deploy → 3 confirmations →
  28 checks → activation → `gate.published() == true`; `anvil_reorg` of the receipt block →
  `reorg_detected`, `reclaimed_after_reorg`, `rebroadcast` with the **same** tx hash →
  activated; a read-layer fault (Hook tax 300 bps) → `HOOKS_VERIFICATION_MISMATCH`,
  `failedChecks = ["hook_params"]`, executor nonce unchanged, gate unpublished; an expired
  signature → failed with no tx and no reservation; an unauthorized key → idle; a missing
  key → boot refused. The suite skips with the reason when anvil / forge / loop-contracts are
  absent (CI).
- Unit: executor state machine against an in-memory repository and a scriptable chain
  (`test/hooks-launch-executor.test.ts`), every verification check
  (`test/hooks-launch-verification.test.ts`), config, migration, logger, worker wiring, ABI
  sync, send-error classification. Integration: leases under concurrency, takeover, nonce
  reservation and gap reuse, transition / hash / append-only guards, retry delay, cancel
  refusal, console projection (`test/hooks-launch-executor-repository.integration.test.ts`).

## Not done / open

- No BSC Testnet broadcast: the Factory is not deployed on chain 97 yet.
  `ops/protocol-testnet-deploy.sh` (outside this repository; not run against BSC Testnet)
  checks chain 97, the deployer key (from `MEME_OPERATOR_PRIVATE_KEY`) against
  `BSC_TESTNET_EXPECTED_DEPLOYER`, minimum balances (deployer 0.10, executor 0.05, each keeper
  0.05 tBNB), deploys base → verify → Factory → verify, writes the addresses back to
  `ops/protocol-testnet.local.env` (resumable), and prints `HOOKS_LAUNCH_FACTORY_ADDRESS` /
  `_CODE_HASH`. It was rehearsed end to end against a local anvil (chain 97) with a scratch env
  file, including a resumed second run; rehearsal artifacts were removed.
- Contracts finding: `protocol/foundry.toml` (33ed921) has no `fs_permissions`, so
  `VerifyBscTestnetBase` / `VerifyLoopFactoryBscTestnet` revert on `vm.createDir`
  ("not allowed to be accessed for write operations") as shipped. The runbook works around it
  with a temporary config that adds `fs_permissions = [{ access = "read-write", path =
"./deployments" }]`; the permanent fix belongs in loop-contracts.
- No fee bumping / replacement of a stuck transaction (same bytes are re-sent; a gas price
  spike leaves it pending until mined or dropped → re-signed).
- Reorgs deeper than the configured confirmations after `activated` are not tracked.
- A version already deployed on chain by a path other than this executor
  (`HOOKS_LAUNCH_ALREADY_DEPLOYED`) needs an operator.
- Tasks signed for a previous Factory are never leased by an executor configured for a new one.
