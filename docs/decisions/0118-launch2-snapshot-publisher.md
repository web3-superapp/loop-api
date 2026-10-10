# Decision 0118: MEME v2 snapshot publisher (`launch2_snapshot_publisher`, 2-of-3) (S140)

- Status: Accepted (S140-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `8c4e038`; contracts `loop-contracts` main `60f1ba3`
  (S141: Factory-defined NFT sale length; ABI regenerated from its build — `492fc61` is
  `60f1ba3` plus a deployment manifest only)
- Inputs: Decision 0114 (read model, snapshot verification, open item "who publishes the
  snapshot and the `dataHash` format"), Decision 0077 (Merkle construction), Decision 0112
  (executor transaction discipline, nonce reservations), 《整体方案》§3, S137 report
  disposition 7, `SnapshotRegistry.sol`.
- Scope: migration `000063_launch2_snapshot_publisher`, worker lane
  `launch2_snapshot_publisher` (default off), `snapshot.publication` on
  `GET /v2/launch2/instances/{id}`, `snapshotPublications` on
  `GET /admin/v1/launch/projects/{projectId}`. No new route; no `/v1` change.

## Contract facts

`SnapshotRegistry.publishSnapshot(cutoffBlock, cutoffBlockHash, dataHash, root, sig0, sig1)`
is callable by anyone once `block.timestamp ≥ nftSaleEnd` and `block.number > cutoffBlock`,
exactly once (`SnapshotAlreadyPublished`), with non-zero hash / root / dataHash. It recovers
two distinct signers from the EIP-712 digest (domain `LOOP NFT Snapshot` / `1` / chain id /
the registry; type `Snapshot(bytes32 launchId,address nft,uint256 cutoffBlock,bytes32
cutoffBlockHash,bytes32 dataHash,bytes32 root)`) and requires both in the three Factory
signers (`isSnapshotSigner`). It does not check the holder list, the cutoff, or `dataHash`.
Since S141 the sale length is a Factory immutable (1 h on the testnet Factory, 7 d on
mainnet); `SnapshotRegistry.nftSaleEnd()` = `ProjectNFT.saleEnd()`.

## `dataHash` (defined here)

`members` = the cutoff holders' addresses, lower-case `0x` hex, de-duplicated, sorted
ascending (string order = numeric order for fixed-width lower-case hex).
`dataHash = keccak256(utf8(JSON.stringify(members)))`, i.e. the hash of the exact text
`["0xaaa…","0xbbb…"]` (no spaces). Implemented by `launch2SnapshotDataHash`
(`src/features/launch2/launch2-snapshot-publisher.ts`). The full `members` array is stored
in the publication row so anyone can recompute both `dataHash` and `root`. The Merkle
`root` is Decision 0077's tree of the same members (`buildLaunchMerkleTree`). The
`launch2_event` lane still verifies root + cutoff, not `dataHash` (see Open).

## Flow (one tick)

For every activated instance without a verified snapshot (held / graduated instances start
nothing):

1. Read the registry immutables once (`nftSaleEnd`, `launchId`, `nft`); they must match the
   instance and `nftSaleEnd − nftSaleStart` must lie in `[3,600, 604,800]` (else
   `LAUNCH2_SNAPSHOT_SALE_END_MISMATCH`). Never derived from a 604,800 constant.
2. Wait until the head time ≥ `nftSaleEnd` (`…_SALE_OPEN`); stop if a root is already on
   chain (`…_ALREADY_ON_CHAIN`, the lane indexes it).
3. Cutoff = the largest block with `timestamp < nftSaleEnd` (binary search from the deploy
   block to the head); wait until `head − cutoff ≥ confirmations` (`…_CUTOFF_UNCONFIRMED`)
   and the `launch2_event` checkpoint ≥ `cutoff + confirmations` (`…_INDEXER_BEHIND`).
4. Holders at the cutoff = `Launch2Repository.nftHoldersAt` — the same function the lane
   verifies with. Empty → `…_NO_HOLDERS`. The balance sum must equal
   `ProjectNFT.totalMinted()` read at the cutoff block (`…_INDEXER_INCOMPLETE`).
5. Members, root, dataHash; choose two signer keys (registered ones first via
   `isSnapshotSigner`, the contract stays the judge); every chosen key's local EIP-712
   digest must equal `snapshotDigest(...)` on chain (`…_DIGEST_MISMATCH`); sign.
6. **Insert the attestation** (`pending`) — at most one `pending | broadcast | confirmed`
   row per instance (unique partial index), so a repeated tick or a second worker never
   publishes twice.
7. Simulate `publishSnapshot` from the submitter (decoded contract error). A revert →
   `failed` with `LAUNCH2_SNAPSHOT_CONTRACT_REVERTED` + `failureDetail` = the error name
   (`InvalidSnapshotSignatures`, …), not retryable except `SnapshotNotReady`. Gas over
   1,000,000 → `failed` (`…_GAS_ABOVE_CAP`); gas price over the cap → wait.
8. Under the submitter's nonce lock — the same advisory key and reservation set as the
   Hooks executor (Decision 0112; both repositories now exclude each other's in-flight
   nonces), sign a legacy chain-97 transaction and **record hash / nonce / raw bytes on
   the row before sending**; then send → `broadcast`. `insufficient funds` / rejected /
   nonce consumed → `failed` retryable.
9. `broadcast`: no receipt → re-send the same bytes (a nonce-too-low without our receipt →
   `failed` retryable `…_TX_DROPPED`); reverted receipt → `failed` (`…_TX_REVERTED`) or
   `mismatch` (`…_PUBLISHED_BY_OTHER`, another root on chain); success with
   `confirmations` blocks on a canonical block → `confirmed`.
10. `confirmed`: the lane's indexed root differs → `mismatch` (`…_PUBLISHED_BY_OTHER`); the
    lane says `mismatch` for our root → `mismatch` (`…_NOT_REPRODUCED`); not yet indexed and
    the receipt left the canonical chain (reorg) → back to `broadcast`, same bytes re-sent.
11. The `launch2_event` lane (unchanged) verifies the published snapshot → `verified`,
    proofs stored, stage `priority`.

Retries: a new attempt (new row, `attempt + 1`) only after a retryable failure, at most 3
retryable failures (`…_ATTEMPTS_EXHAUSTED`), 60 s apart (`…_RETRY_WAIT`). A non-retryable
`failed` or any `mismatch` stops the instance (`…_PUBLICATION_BLOCKED`) until an operator
acts (no console action in this batch — see Open).

## Entity (migration 000063)

`launch2_snapshot_publications`: `publication_id` (opaque UUIDv4) PK; `instance_id` →
`launch2_instances`; `attempt` (unique per instance); `status`
`pending | broadcast | confirmed | failed | mismatch`; attestation (immutable after insert):
`snapshots_address`, `cutoff_block`, `cutoff_block_hash`, `sale_end_at`, `members` (jsonb
array), `member_count`, `root`, `data_hash`, `signer_addresses` (2), `signatures` (2),
`submitter_address`; transaction: `tx_hash`, `tx_nonce`, `raw_tx` (set once, while
`pending`), `block_number`, `block_hash`, `confirmations`; `failure_code`, `failure_detail`
(contract error name), `failure_retryable`; timestamps. Guard trigger: allowed transitions
`pending→broadcast|failed|mismatch`, `broadcast→confirmed|failed|mismatch`,
`confirmed→mismatch|broadcast` (reorg), self-updates only while in flight; no delete.
Addresses are facts, never keys. Registered in `schema.ts`; `dev:reset-users` deletes rows
of doomed instances.

## Reads

- `GET /v2/launch2/instances/{id}` → `snapshot.publication`:
  `{status, txHash, cutoffBlock, memberCount} | null` (latest attempt). Additive; no
  existing key changed meaning. `signatures`, `members`, `raw_tx` are never returned.
- `GET /admin/v1/launch/projects/{projectId}` → `snapshotPublications[]` (newest first, ≤ 200):
  ids, attempt, status, cutoff block / hash, member count, root, dataHash, signer and
  submitter addresses, tx hash, block, confirmations, `failure {code, detail, retryable}`,
  the lane's `verification` of that root. No signature.

## Configuration (worker only)

| Env                                             | Default | Rule                                                                            |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED`            | `false` | `true` refuses boot unless the rest is valid                                    |
| `LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS`          | —       | 2–3 distinct comma-separated 32-byte hex keys (one key or blank → boot refused) |
| `LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY`        | —       | else `HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY` is reused; neither → boot refused      |
| `LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS`   | 5000    | 1,000–600,000                                                                   |
| `LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS`      | 12      | 1–64 (S137 disposition 5: 0.47 s testnet blocks)                                |
| `LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI` | 20      | over the cap → wait                                                             |
| `LAUNCH_CHAIN_ID`                               | —       | must be `97` (BSC Mainnet signing stays closed)                                 |

Missing RPC / repositories at runtime → the lane logs `LAUNCH2_CHAIN_NOT_CONFIGURED` /
`LAUNCH2_REPOSITORY_UNAVAILABLE` once and stays idle. A wrong node chain id →
`LAUNCH2_SNAPSHOT_CHAIN_MISMATCH` each tick, nothing signed.

## Key custody

Keys are read from the worker environment only, live in the integration closures
(`createLaunch2SnapshotSigners`, `createLaunch2PublisherChain`), and never enter a log line,
an error message, a row, or a response (tests assert the log lines). Testnet: use
`LOOP_SNAPSHOT_SIGNER_0_PRIVATE_KEY` and `LOOP_SNAPSHOT_SIGNER_1_PRIVATE_KEY` from
`ops/protocol-testnet.local.env` (signer 2 stays offline as the spare); the submitter
defaults to the executor account, which must hold tBNB. Mainnet: undecided — the design
assumes signer keys in a KMS / HSM or separate hosts so no single machine holds two of
three; holding two keys in one worker env, as here, is acceptable for the testnet only.

## Errors / unavailable

No new HTTP error codes. Lane reason codes (logged, never returned): `LAUNCH2_SNAPSHOT_*` as
listed above. The App keeps Decision 0114's behaviour: `stage = snapshot_pending` until the
lane indexes `SnapshotPublished`; priority buys need `verification = verified`.

## Evidence

- Unit: `test/launch2-snapshot-publisher.test.ts` (dataHash, waits, totalMinted cross-check,
  registered-first signers, broadcast → confirmed, reorg re-send, mismatch, contract revert
  blocks, retry budget, dropped / reverted, lane reason dedupe, config refusals);
  `test/worker-runtime.test.ts` (boot refusal, wiring, no key in logs, idle reason);
  `test/v2-launch2-routes.test.ts` (publication field vs schema).
- Integration: `test/launch2-snapshot-publisher-anvil.integration.test.ts` (anvil chain 97,
  real Foundry deploy): activated launch → 2 NFT mints → past sale end → unconfirmed cutoff
  publishes nothing → indexer behind publishes nothing → publish (executor account, anvil
  signers 9 / 10) → repeated ticks publish once (one nonce used) → `confirmed` → lane
  `verified`, 2 members, signers recovered → priority quote answers → console shows it →
  update / delete refused; an unregistered signer key → simulated `InvalidSnapshotSignatures`
  → `failed` non-retryable, nothing sent, next tick blocked; one key refuses boot. The suite
  deploys the Factory with `LOOP_NFT_SALE_DURATION_SECONDS` from
  `LOOP_TEST_NFT_SALE_DURATION_SECONDS` (default 604,800 — see Open).

## Open (for the coordinator)

1. With a 1-hour Factory (`LOOP_TEST_NFT_SALE_DURATION_SECONDS=3600`) the suite fails at
   activation: the S132 executor verification (`hooks-launch-verification.ts`,
   `nftSaleDurationSeconds: 604_800n`) and the Decision 0114 stage machine / lane
   verification (`launch2NftSaleEnd` = start + 604,800) still pin 7 days. That is S141-api's
   change; after it merges, flip the suite default to 3600. The publisher itself reads
   `nftSaleEnd()` only.
2. Should the `launch2_event` lane also require `dataHash` = this definition (a published
   snapshot with another `dataHash` would become `mismatch`)? Not done, to keep Decision
   0114's verification unchanged.
3. Zero NFT holders: nothing can be published (the contract needs a non-zero root), so the
   instance stays `snapshot_pending` forever and the public round never opens. Needs a
   product / contract rule.
4. Operator action for a blocked instance (non-retryable `failed` / `mismatch`) is not in
   the console; today it needs a manual decision and a new row.
5. Mainnet key custody (above).
