# Decision 0119: NFT sale period read from the chain (S141-api)

- Status: Accepted (S141-api)
- Date: 2026-10-10
- Baseline: `integration/v2` = `8c4e038`
- Inputs: user ruling 2026-10-10 (testnet sale = 1 hour, else it cannot be
  tested); loop-contracts `main` `60f1ba3` and its Decision 0004 §5
  (`LoopLaunchFactory.nftSaleDuration()`, immutable `ProjectNFT.SALE_DURATION`,
  `MIN/MAX_SALE_DURATION` = 3,600 / 604,800 s); Decisions 0108 (Hooks config),
  0112 (deployment executor), 0114 (launch2 read model).
- Scope: `hooks-launch-config.ts`, the Factory reader, the project-config /
  review / deployment / submission services, the executor chain read and
  verification, the launch2 repository / stage / service / lane, ABI sync.
  **No migration, no new environment key, no new route.**

## Problem

The backend hard-coded the 7-day NFT sale in four places: the configHash
economics (`nftSaleDurationSeconds: 604_800`), the executor read-back
(`nft.saleDuration === 604800`, `saleEnd` / registry cutoff = start + 604800),
the launch2 stage derivation (`nft_sale` until start + 604800) and the
template card (`nftSaleSeconds: 604_800`). The contracts now take the period
per Factory (testnet 3,600 s, mainnet 604,800 s), so a 1-hour testnet launch
would have failed verification and, had it passed, shown a 7-day countdown.

## Decision

The period is a property of the **target Factory**, read from the chain;
never a constant and never an environment value.

### 1. Source of truth

| Reader                                             | Call                                                                                                                   | Pre-S141 Factory (no selector)                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `HooksLaunchFactoryReader.nftSaleDuration()` (API) | `LoopLaunchFactory.nftSaleDuration()` after the code-hash check; cached per process (immutable for a pinned code hash) | contract revert / zero data → `{seconds: 604800, legacy: true}`; RPC failure → unavailable |
| `HooksLaunchExecutorChain.readLaunch()` (worker)   | same, into `facts.factory.nftSaleDuration` / `nftSaleDurationLegacy`                                                   | same rule; an RPC failure is a retryable read failure                                      |

Only a contract-level revert means "legacy" (that Factory's NFTs are the old
`constant 7 days`); a transport failure never falls back. A reading outside
3,600..604,800 s is refused.

### 2. configHash (`hooks-launch-config.ts`)

`parseHooksLaunchDraft(input, { …, nftSaleDurationSeconds })` — the
parameter is required. `hooksLaunchFixedEconomicsFor(seconds)` returns the
frozen `hooksLaunchFixedEconomics` object itself for 604,800 and otherwise a
copy with only that key replaced **in place** (JSON key order kept).

- **Mainnet unchanged.** For 604,800 the canonical JSON, the
  `fixedEconomicsHash` and the configHash are byte-for-byte the pre-S141
  values. Proof: `test/hooks-launch-config.test.ts` pins the configHash
  `0x9b16d09e…3b3ab948` and the full economics JSON computed with the
  `8c4e038` code for the existing fixture; the integration test re-saves an
  owner draft as an operator at 604,800 s and approves it with the original
  hash.
- A 3,600 s Factory yields a different `fixedEconomicsHash`
  (`0x917f1b8f…d414d266` for the same fixture): a different template, which
  the project signs knowingly (loop-contracts Decision 0004 §3).
- The on-chain `TEMPLATE_HASH` and the EIP-712 request are unchanged.

Who reads the Factory before hashing:

- `PUT /v2/launch/projects/{id}/hooks-config` (project-config service,
  `factory` = the Factory reader). No reader or a failed read →
  `503 CAPABILITY_UNAVAILABLE`, `reasonCode HOOKS_LAUNCH_FACTORY_UNAVAILABLE`.
  This is new: saving a draft now needs the Factory pair.
- Console `launch.config.save` (review service reads the Factory and passes
  `{nftSaleDurationSeconds}` to the repository's `execute`); missing →
  `OPS_UNAVAILABLE`. The repository refuses a save without it.

### 3. Cross-check before signing (fail closed)

`assertHooksLaunchFactoryTemplate(reader, config)` runs in
`GET …/hooks-config/signing-request` and in `POST …/hooks-deployments`
(the second because a client can sign typed data without the prepare). If
`config.fixedEconomics.nftSaleDurationSeconds !== factory.nftSaleDuration()`:
`503 CAPABILITY_UNAVAILABLE`, new `reasonCode HOOKS_FACTORY_TEMPLATE_MISMATCH`,
nothing signed or recorded. Remedy: save a new config version (re-hashed for
the current Factory) and get it approved again; a retry of the same version
never succeeds. Expected once the testnet Factory is switched from 7 days to
1 hour: every previously approved config hits this.

### 4. Executor verification (`hooks-launch-verification.ts`)

- `nft_params`: `nft.saleDuration === factory.nftSaleDuration` and
  `nft.saleEnd === nftSaleStart + factory.nftSaleDuration`.
- `snapshot_params`: `snapshots.nftSaleEnd === nftSaleStart +
factory.nftSaleDuration`.
- Both fail when the Factory reading is outside 3,600..604,800 s, or flagged
  legacy with anything but 604,800.
- `hooksLaunchTemplateConstants.nftSaleDurationSeconds` is removed (replaced
  by `min/max/legacyNftSaleDurationSeconds`).
- On `verified` the task's `verification` JSON gains
  `nftSaleDurationSeconds` and `nftSaleEnd` (decimal strings, the verified
  `ProjectNFT.saleEnd()`), plus `legacyFactory: true` for a pre-S141 Factory;
  the `verified` event `details` gain `nftSaleDurationSeconds` and, for a
  legacy Factory, `legacyFactory: true`.
- The pinned `factoryCodeHash` (`HOOKS_LAUNCH_FACTORY_CODE_HASH`) is
  configuration, unchanged in code; the new Factory has a new code hash.

### 5. launch2 read model (no migration)

`launch2_instances` has `nft_sale_start` only — there is no `nft_sale_end`
column, and S141 adds no migration. The instance record and lane instance
gain `nftSaleEnd` (ISO), selected by the repository from the registering
task's `verification ->> 'nftSaleEnd'` (`job_id` is the unique link). A task
verified before S141 has no such key; that code accepted only an NFT whose
period was exactly 604,800 s, so `nft_sale_start + 604800` is the fact for
those rows (not a fallback for new ones — every task verified from now on
carries the key). A non-integer or `≤ start` value is
`Launch2RepositoryUnavailableError`.

Uses: `deriveLaunch2Stage({ nftSaleEnd })` (`nft_sale` until it, then
`snapshot_pending`), the trading gate (`chainStageOf`), the NFT-mint prepare
deadline, the snapshot cutoff reproduction in the lane, `nftSale.endAt`, and
the per-instance `template.nftSaleSeconds` (`endAt − startAt`).
`launch2Template.nftSaleSeconds` and `launch2NftSaleEnd()` are removed.

## Error codes

| Where                                           | HTTP / code                                  | reasonCode                                     | When                                               |
| ----------------------------------------------- | -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `PUT hooks-config`                              | 503 `CAPABILITY_UNAVAILABLE`                 | `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`             | no Factory pair / read failed (new for this route) |
| `GET signing-request`, `POST hooks-deployments` | 503 `CAPABILITY_UNAVAILABLE`                 | `HOOKS_FACTORY_TEMPLATE_MISMATCH` (new)        | saved period ≠ Factory period                      |
| console `launch.config.save`                    | `OPS_UNAVAILABLE`                            | —                                              | Factory missing / unreadable                       |
| executor                                        | task `failed`, `HOOKS_VERIFICATION_MISMATCH` | failed checks `nft_params` / `snapshot_params` | NFT / registry period ≠ Factory period             |

## ABI

`pnpm hooks:abi-sync` from `loop-contracts/protocol/out` (built at
`492fc61`, whose sources equal `60f1ba3`; the extra commit only adds the
testnet `factory.json`). The selection adds `LoopLaunchFactory.nftSaleDuration`;
no other selected item changed (constructors and `deployProjectNft` are not
in the executor's view).

## Tests

- Unit: configHash golden values (604,800 unchanged; 3,600 different, only
  that key changes; bounds); verification at 3,600 and 604,800 Factories
  (pass, cross-mismatch, `saleEnd` / cutoff, out of bounds, legacy);
  project-config / review services (3,600 vs 604,800, no Factory, failed
  read); prepare / submission / route `HOOKS_FACTORY_TEMPLATE_MISMATCH`;
  stage derivation and lane / routes with 1-hour and 7-day instances.
- Integration: operator save at 3,600 vs 604,800 on PostgreSQL;
  `test/launch2-sale-duration-anvil.integration.test.ts` deploys the real
  Factory with `LOOP_NFT_SALE_DURATION_SECONDS=3600`, reads the legacy path
  against a contract without the selector, refuses a 7-day config at prepare,
  then draft → approval → signature → executor (verification records
  `nftSaleEnd`) → lane: `upcoming` → `nft_sale` (ends start + 3,600) →
  `snapshot_pending` exactly at `ProjectNFT.saleEnd()`.
  `test/helpers/anvil.ts` `deployProtocol` always sets the env (default
  604,800) so existing suites keep the 7-day Factory.

## Not done / follow-ups

- The BSC Testnet one-hour Factory (`0x6A69…D9c0`, code hash
  `0x6669c2af…6eacca`, loop-contracts `492fc61` `factory.json`) is not wired
  into any environment here: ops must update `HOOKS_LAUNCH_FACTORY_ADDRESS` /
  `HOOKS_LAUNCH_FACTORY_CODE_HASH`; drafts approved for the old Factory then
  need a re-save + re-approval (`HOOKS_FACTORY_TEMPLATE_MISMATCH`).
- Snapshot publication (S140) must take its cutoff from the instance's
  `nftSaleEnd`, not a constant; this batch changed only the lane's
  reproduction check.
