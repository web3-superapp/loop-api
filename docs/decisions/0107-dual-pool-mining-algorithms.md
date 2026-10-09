# Decision 0107: Dual-pool mining algorithms ported as pure functions (S125)

- Status: Accepted (S125-api), Development baseline only
- Date: 2026-10-09
- Source: requirer branch `origin/codex/integrated-dual-pool-20261008`
  (forked from `83f5ac7`), Draft PR `web3-superapp/loop-api#6`. The requirer
  shipped these modules without a numbered decision of their own; their
  design note is `docs/superpowers/specs/2026-10-08-loop-integrated-development-design.md`
  (not ported). Product rule: `LOOP-整体方案` §6 (docs/evidence/2026-10-09-requirer-handoff).
- Baseline: `integration/v2` = `2de5a19`
- Scope: seven pure, side-effect-free calculators and their unit tests. No
  migration, no route, no capability, no worker, no `/v2` wire change.

## Ruling

1. **Ported verbatim, file by file** (no merge, no cherry-pick):

   | Requirer path                                     | LOOP path                                         |
   | ------------------------------------------------- | ------------------------------------------------- |
   | `src/features/mining/dual-pool-allocation.ts`     | `src/features/mining/dual-pool-allocation.ts`     |
   | `src/features/mining/asset-time-weight.ts`        | `src/features/mining/asset-time-weight.ts`        |
   | `src/features/mining/asset-power-allocation.ts`   | `src/features/mining/asset-power-allocation.ts`   |
   | `src/features/mining/nft-time-weight.ts`          | `src/features/mining/nft-time-weight.ts`          |
   | `src/features/mining/consensus-nft-allocation.ts` | `src/features/mining/consensus-nft-allocation.ts` |
   | `src/features/mining/reward-batch.ts`             | `src/features/mining/reward-batch.ts`             |
   | `src/features/mining/reward-merkle.ts`            | `src/features/mining/reward-merkle.ts`            |
   | `test/dual-pool-allocation.test.ts`               | same                                              |
   | `test/mining-asset-time-weight.test.ts`           | same                                              |
   | `test/asset-power-allocation.test.ts`             | same                                              |
   | `test/mining-nft-time-weight.test.ts`             | same                                              |
   | `test/mining-consensus-allocation.test.ts`        | same                                              |
   | `test/reward-batch-budget.test.ts`                | same                                              |
   | `test/reward-merkle-vectors.test.ts`              | same                                              |

2. **Coexists with, never replaces, the current mining read model.** The
   Mining Power board, formula versions (Decisions 0036/0043–0046), snapshot
   lane, and every `/v2/mining/*` response are untouched. Nothing imports the
   new modules at runtime yet; they are the algorithm library for the future
   daily-settlement worker.
3. **What the modules compute** (all amounts are decimal strings parsed to
   `bigint`; no JavaScript `number` carries an amount):
   - `allocatePoolBudget` / `allocateDualPoolBudget`: one pool's budget split
     pro rata by weight, floor division, remainder reported as
     `unallocatedRaw`. The consensus-NFT pool and the asset-power pool have
     independent denominators and budgets; unused budget never crosses pools.
   - `computeNftEpochWeights` / `allocateConsensusNftEpoch`: time-weighted
     `NFT count × community NFT coefficient` (18-decimal fixed point) over
     half-open, contiguous `[from, to)` segments that must cover the whole
     epoch per wallet/community; partial or overlapping history rejects the
     whole input.
   - `computeAssetEpochPower` / `allocateAssetPowerEpoch`: time-weighted
     `balance × USD18 price × asset Mining Weight` per wallet over complete
     history; a positive balance without a price rejects the input. The
     community NFT coefficient is not multiplied into this pool (§6).
   - `validateRewardBatchBudget`: append-only commitment preflight — one
     ordinary batch per pool and epoch, epoch `0..899`, per-pool ordinary
     lifetime cap 450,000,000 LOOP, global cap 900,000,000 LOOP (18 decimals);
     claiming never releases the cap.
   - `buildRewardMerkleBatch` / `verifyRewardProof`: OpenZeppelin
     StandardMerkleTree-compatible double-hashed leaves over
     `(schemaVersion, chainId, distributor, poolId, epochId, batchId,
leafIndex, beneficiary, amountRaw)`; sorted-pair hashing; the schema
     version is `keccak256("loop.dual-mining.reward-leaf.v1")`.
4. **Identifiers.** The calculators key rows by an opaque `walletId` string
   supplied by the caller (≤ 256 chars). Only the Merkle leaf carries an EVM
   address, because the on-chain distributor pays an address; a future worker
   must map LOOP wallet IDs to addresses at batch build time and never use the
   address as a LOOP primary key.
5. **No chain address is compiled in.** The distributor address and chain ID
   are inputs to `buildRewardMerkleBatch`; test vectors use synthetic
   addresses only.
6. **Not production approval.** Every result is labelled
   `formulaScope: "development_baseline"`. The 900-day / 2 × 500,000-per-day
   plan and the caps are the requirer's candidate values; parameters
   M01–M17 remain unconfirmed and are not approved by this decision. No
   reward, root, claim, or LOOP token exists in this repository.

## Unavailable behaviour

Nothing is exposed, so nothing can be unavailable on the wire. A future
settlement worker must refuse to run (not degrade) when any input history is
incomplete; the calculators already throw on incomplete input.

## Not ported (and why)

- `src/database/mining-repository.ts`, `community-repository.ts` changes and
  migration `000046_ops_mining_weights` (per-formula `bound_asset_id`,
  `community_weight_history_status`): they belong to the requirer's ops
  mining workbench, change live `/v2/mining/*` SQL, and conflict with our
  Decision 0102 approval path. Re-evaluate with the daily-settlement batch.
- `ops_mining_drafts`, `ops_jobs`, `src/features/ops/ops-mining-job.ts`: the
  requirer's ops mining job queue (same reason).
- EpochDistributor / LOOP token contracts: in the requirer's private
  contracts repository, not accessible.

## Tests

`pnpm test` runs the seven ported suites unchanged (allocation conservation
and pool independence, incomplete/overlapping history rejection, missing
price rejection, cap enforcement including corrections, deterministic Merkle
root vector and proof verification).
