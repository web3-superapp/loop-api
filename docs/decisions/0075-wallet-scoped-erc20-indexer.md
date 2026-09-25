# Decision 0075: The `erc20_transfer` lane indexes only logs that touch an active LOOP wallet

- Status: Accepted (S82; user ruling 2026-09-25)
- Date: 2026-09-25
- Scope: `src/bsc-indexer-worker.ts` (the `erc20_transfer` lane and its
  approval-coverage backfill), `src/integrations/bsc/rpc-client.ts`
  (`readTransferLogs` / `readApprovalLogs` wallet filter, topic-array
  narrowing, one refusal-text classification fix), `src/database/bsc-indexer-repository.ts`
  (wallet set read, coverage write), migration `000040`, one worker config
  key (`BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE`), `scripts/indexer-backfill.ts`.
  Extends Decisions 0033, 0035, and 0068; narrows 0033's lane scope. No
  `/v2` route, schema, response shape, enum, or error code changes. The
  `pool_event` lane (Decision 0034) is untouched.
- Baseline: `integration/v2` = `1ab26d7`

## Context

Decision 0033 scoped the `erc20_transfer` lane to "every `Transfer` log of a
readable Asset Registry address", and Decision 0035 added every `Approval`
log of the same addresses. For a registry that includes USDT and WBNB that
is, in practice, a copy of the two busiest token contracts on BSC:

| Development database, 14 days | Rows        | Size  |
| ----------------------------- | ----------- | ----- |
| `indexed_transfers`           | 109 million | 86 GB |
| `indexed_approvals`           | 37 million  | 24 GB |

USDT is 81 % of those rows and WBNB 19 %. `account_wallets` holds 360
addresses (10 `embedded`, 350 `external`, all `privy`). Every read of the
lane (`listWalletTransfers`, `sumPendingIncoming`, `hasOutgoingTransferTo`,
`earliestWalletActivityBlockNumber`, `listLatestApprovals`) already filters
by one LOOP wallet address, so every row that does not touch a LOOP wallet
is storage no product surface ever reads. No server sized for this product
holds that growth. The user ruled on 2026-09-25: index only logs that touch
our wallets.

## Rulings

### 1. Wallet set

Every tick reads the **distinct** `address` of every `account_wallets` row
with `status = 'active'` — any `kind`, any owner, `is_active` or not —
through `BscIndexerWalletSetRepository.listActiveWalletAddresses()`. The
worker lower-cases, de-duplicates, and sorts it (`normalizeWalletSet`), like
the registry token list it is re-read every tick; nothing is cached across
ticks. Addresses are chain facts used as a log filter only: they are never a
key of any new record other than the coverage row of ruling 3, whose key is
`(chain_id, lane, address)` because the address _is_ the filtered fact.

**Empty set.** The tick issues no `eth_getLogs`, commits an empty segment
(the checkpoint, the approval coverage start, and no rows), and returns
`kind: "idle"`, `reasonCode: "INDEXER_WALLET_SET_EMPTY"` with the segment's
`fromBlockNumber` / `toBlockNumber`. The checkpoint keeps pace with the
chain so that a wallet that appears later is covered from its first tick,
not from wherever the lane stalled. A reorg tick with an empty set still
rewinds (`removed = true`) and still counts the reorg; only the returned
`kind` is `idle`. An empty registry keeps its existing behaviour
(`ASSET_REGISTRY_EMPTY`, no advance) and is checked first.

The worker runtime creates the lane only when the wallet source is present
(`database.bscIndexerWallets`); without it the lane stays off instead of
falling back to an unfiltered scan.

### 2. Log filter

`BscTransferLogQuery` gains an optional `walletFilter: { walletAddresses,
topicChunkSize }`; the lane always sets it. The token `address` filter is
unchanged.

- `readTransferLogs` issues two topic-filtered reads per segment,
  `Transfer.from ∈ W` (topic 1) and `Transfer.to ∈ W` (topic 2), and merges
  them keyed by `(transactionHash, logIndex)`: a transfer between two LOOP
  wallets is returned once. The result is in block / log order.
- `readApprovalLogs` reads `Approval.owner ∈ W` (topic 1) only. An approval
  granted _to_ a LOOP wallet by someone else is not part of any LOOP
  wallet's approvals inventory and is not stored.
- An empty `walletAddresses` returns `[]` without a request. A chunk size
  outside `1..1000`, a non-integer, or an address that is not
  `0x` + 40 hex fails the read closed as `BSC_LOG_WALLET_FILTER_INVALID`
  (it is never widened to "no filter" nor narrowed silently).
- Absent `walletFilter` keeps the old unscoped read. Only the
  `pool_event` lane (`readPoolEventLogs`, now typed `BscLogRangeQuery`)
  and tests use unscoped reads.

The approval-coverage backfill (`backfillApprovalCoverageOnce`,
`pnpm indexer:backfill --from`) is scoped the same way, to today's wallet
set, and idles as `INDEXER_WALLET_SET_EMPTY` without one. It still only
lowers `approval_coverage_from_block`; it writes no coverage row.

### 3. Topic chunking and refusals

The wallet set goes into each request as a topic OR array of at most
`topicChunkSize` addresses (`BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE`, worker
config, `1..1000`, **default 200**). Every chunk is a separate request over
the full segment range; one chunk's logs are never substituted for another's.

Why 200:

- go-ethereum and the BNB Chain client (`bnb-chain/bsc`,
  `eth/filters/api.go`, checked 2026-09-25) both cap one topic position (and
  the address list) at `maxSubTopics = 1000` and refuse more with
  `exceed max addresses or topics per search position` — text the client
  already classifies as a shape refusal. 200 is a 5x margin under that cap.
- Request body: 200 × 66-byte topics ≈ 14 KB. On 2026-09-25
  `bsc-rpc.publicnode.com` accepted 1,000 and 5,000 sub-topics over a
  1,999-block USDT range and answered **HTTP 503 "Request body size limit
  reached"** at 20,000 (a 5xx, which Decision 0068 deliberately treats as an
  outage, not a shape refusal — so the chunk size is what keeps us clear of
  it). `bsc-dataseed.bnbchain.org` refused `eth_getLogs` outright
  (`-32005 limit exceeded`) even for one sub-topic over 50 blocks, i.e. it
  is not a usable log endpoint whatever the chunk size.
- 360 wallets today → 2 chunks → 4 transfer requests + 2 approval requests
  per 2,000-block segment, well inside the 512-request segment budget of
  Decision 0068.

Refusals (Decision 0068 extended): `readLogRangeWith` now carries the topic
array as a third narrowing dimension. On a _shape_ refusal it halves the
block range down to one block, then the **topic array** down to one wallet,
then the token address list down to one address, and learns each limit on
the client (`learnedTopicGroupLimit`, relaxed one step after a clean read
like the other two). A single-wallet, single-address, single-block request
that is still refused fails the whole read as `BSC_LOG_QUERY_REJECTED`
(with the `rpcError` classification); running out of the 512-request budget
fails it as `BSC_LOG_QUERY_BUDGET_EXHAUSTED`. Either way nothing is
committed, the checkpoint does not move, and the lane backs off and logs
the transition once (Decision 0068). A chunk is never dropped.

Classification fix: `throttlePattern` matched any "too many", so a Provider
answering "too many topics" / "too many addresses" would have been treated
as a rate limit and propagated to the retry loop without narrowing. "too
many" now means throttle except when it names a filter part (`topics`,
`sub-topics`, `addresses`, `logs`, `results`), which is a shape refusal.
"too many requests" is still throttle.

Known limit (unchanged from Decision 0068, now reachable through topics): a
Provider whose topic cap is below the configured chunk size is first
narrowed by block range, so the read can exhaust the segment budget before
it learns the topic cap. The outcome is fail-closed and visible
(`BSC_LOG_QUERY_BUDGET_EXHAUSTED`); the operator lowers
`BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE`.

### 4. `indexer_wallet_coverage`

Migration `000040` adds:

| Column              | Type        | Notes                                      |
| ------------------- | ----------- | ------------------------------------------ |
| `chain_id`          | text        | FK `chains`                                |
| `lane`              | text        | `'erc20_transfer'` only (check constraint) |
| `address`           | text        | `^0x[0-9a-f]{40}$`                         |
| `from_block_number` | bigint      | first block the address was in the filter  |
| `first_covered_at`  | timestamptz | `clock_timestamp()` at first write         |

Primary key `(chain_id, lane, address)`.

`commitTransferSegment` takes `walletCoverage: { addresses, fromBlockNumber }`
and runs `insert … on conflict do nothing` for the tick's whole wallet set
**inside the same transaction** as the event rows and the checkpoint
upsert: a refused read, a failed insert, or a failed checkpoint write leaves
no coverage row, and a committed checkpoint always has one for every wallet
it filtered on. An existing row is never rewritten — not by a later tick,
not by a reorg replay that starts below it.

Semantics: for `address`, logs in `[from_block_number, checkpoint]` are
indexed. Logs below `from_block_number` are **not** indexed by this lane.
In particular an `external` wallet's on-chain history before it was linked
to a LOOP account (and every wallet's history before the lane first saw it)
is not covered. The table is the record a future on-demand history backfill
starts from; this decision builds no backfill and no read of the table.

What the published freshness means, unchanged on the wire:

- `freshness.indexerBlockNumber` (wallet activity, approvals) is still the
  lane checkpoint `lastBlockNumber`: "the lane has processed every block up
  to here". Its meaning does not change; it has never promised history
  before the lane's start and now does not promise history before the
  wallet's coverage start either.
- `freshness.approvalCoverageFromBlockNumber` (approvals inventory) is still
  the lane-level `approval_coverage_from_block`. For a wallet whose coverage
  row is later than that value, the true per-wallet approval coverage starts
  at the row's `from_block_number`. The inventory's existing guard compares
  coverage with the wallet's earliest _indexed_ activity, which for a
  wallet-scoped lane is never below the wallet's coverage start, so the
  guard does not detect pre-link approvals. This is the pre-existing
  "history before the lane started" gap, now per wallet. Expressing it on
  the wire needs a contract change and is left to the main agent (S82
  hand-off).

### 5. Reorg

Unchanged: a checkpoint hash mismatch rewinds `reorgDepth` blocks (never
below the lane start), marks every stored transfer and approval at or above
the rewind point `removed = true`, and replays the rewound range — with the
tick's wallet filter, and with coverage `fromBlockNumber` = the rewind point
for any address new in that tick.

## Not done

- **History backfill.** No read of `indexer_wallet_coverage`, no per-wallet
  backfill below `from_block_number`, no change to `pnpm indexer:backfill`
  beyond scoping it to the wallet set.
- **`pool_event`.** Decision 0034's lane, its checkpoint, and its reads are
  untouched.
- **Wire contract.** No `/v2` field, required-ness, enum, error code, or
  OpenAPI change; `docs/api-inventory.md` and `docs/frontend-*-api.md` are
  not edited. The mobile client's strict decoders see identical shapes.
- **Existing rows.** `indexed_transfers` / `indexed_approvals` keep their
  schema and their Development rows; removing the unscoped history is an
  operator step after merge.
- **Wallets leaving the set.** A wallet that is archived stops being
  filtered on; if it becomes active again, the blocks in between are not
  indexed for it and its coverage row still shows the original start. The
  table records first entry only (see the hand-off questions).
