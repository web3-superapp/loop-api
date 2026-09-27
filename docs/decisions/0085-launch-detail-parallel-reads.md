# Decision 0085: Launch detail reads one sale snapshot in one multicall, reused briefly

- Status: Proposed (backend, S83b8)
- Date: 2026-09-27
- Scope: `GET /v2/launches/{launchId}`, `GET /v2/launch/{launchId}/eligibility`,
  `GET /v2/launch/overview` (DB reads only), and the `launch_event` worker
  lane's idle log. Builds on Decisions 0076 (adapter, snapshot discipline),
  0077 (lane, eligibility, S83b7 overview segments), 0082 (RPC error
  classification), and 0084 (open-round eligibility).
- Baseline: `integration/v2` = `863fe5e`. No migration, no response-shape
  change, no new reason code, no OpenAPI change (`pnpm openapi:check` is
  current).

## Context

The main agent measured `GET /v2/launches/{id}` at about 8.7 s on the
development stack (contract configured on the BSC testnet, LoopLaunchpad
`0x2b26…3396`, sale 1) while other V2 reads averaged 364 ms.

### Measurement (temporary script, deleted after use)

An in-process harness built the real adapter with the configured contract,
`verifyChain` stubbed to `verified`, and a transport wrapper that timed every
JSON-RPC request. It ran the detail read's chain part exactly as
`launch-service.ts` does. Numbers are wall-clock on this Mac, 2026-09-27.

What the pre-0085 detail read did (`readChain`):

| Step | Call                                                      | Requests | Sequential stage |
| ---- | --------------------------------------------------------- | -------- | ---------------- |
| 0    | `availability()` → `eth_getCode` (first read per process) | 1        | once             |
| 1    | `takeSnapshot` → `eth_getBlockByNumber(latest)`           | 1        | 1                |
| 2    | `getState`, `getRounds`, `getSaleConfig` at block N       | 3        | 2 (parallel)     |
| 3    | `confirmSnapshot` → `eth_getBlockByNumber(N)`             | 1        | 3                |

The three `eth_call`s were already issued with `Promise.all` and all carried
the same `blockNumber`: the read was **not** serial. It was five requests in
three round trips.

Public endpoint `https://data-seed-prebsc-1-s1.bnbchain.org:8545`, 30 runs,
before/after interleaved:

| Path                               | Requests / read | Stages | mean    | p50    | p90    | min    | max      |
| ---------------------------------- | --------------- | ------ | ------- | ------ | ------ | ------ | -------- |
| before (3 × `eth_call` + 2 blocks) | 5               | 3      | 681 ms  | 595 ms | 897 ms | 502 ms | 1 371 ms |
| after (1 multicall + 2 blocks)     | 3               | 3      | 589 ms  | 584 ms | 665 ms | 511 ms | 781 ms   |
| after, cache hit (≤ 1.5 s)         | 0               | 0      | 0.01 ms | —      | —      | —      | —        |

Single request RTT to that endpoint: 160–230 ms typical (one-off outliers
400–630 ms). One read is therefore about `3 × RTT` ≈ 0.5–0.6 s; the
remainder is the RTT itself, not our code. The old path's tail came from
waiting for the slowest of three parallel `eth_call`s (e.g. 432 / 425 /
635 ms in the same stage).

The 8.7 s is reproduced exactly by an endpoint list whose **first endpoint
does not answer** (`http://10.255.255.1:8545` as a black hole, then
data-seed), which is what the main agent found on the dev stack
(`bsc-testnet-rpc.publicnode.com` first, timing out from this Mac):

| Path   | Requests / read | Result             |
| ------ | --------------- | ------------------ |
| before | 10              | 8 522 ms, 8 715 ms |
| after  | 6               | 8 036 ms, 8 159 ms |

Each of the three stages waits the adapter's 2 500 ms per-endpoint timeout
before viem's fallback moves on: `3 × 2.5 s + 3 × RTT ≈ 8.1–8.7 s`. Fewer
requests per stage does not remove that; only the endpoint order (fixed by
the main agent in ops) or fewer stages does. The same run against
`bsc-testnet-rpc.publicnode.com` alone timed out an `eth_call` outright
(`LAUNCH_CONTRACT_READ_FAILED`).

## Rulings

1. **One multicall per sale snapshot.** New adapter method
   `readSaleSnapshot(saleId)`: `eth_getBlockByNumber(latest)` → one
   Multicall3 `aggregate3` `eth_call` at that `blockNumber` carrying
   `getState`, `getRounds`, `getSaleConfig` → `eth_getBlockByNumber(N)` hash
   check. The 0076 snapshot discipline (take head, pin every call, re-read the
   hash afterwards) is unchanged. Multicall3 is viem's
   `readClient.multicall` on the adapter's own client (the same mechanism
   `rpc-client.ts` uses; the adapter still owns its client per 0076). Its
   address comes from viem's chain definitions:
   `0xca11bde05977b3631167028862be2a173976ca11` on both `bsc` and
   `bscTestnet` (verified live on 97: the "after" runs above went through it).
2. **All or nothing.** `allowFailure: false`: any inner call that reverts,
   any transport error, any undecodable value fails the whole read, with the
   same classification as before (`LAUNCH_CONTRACT_READ_FAILED`,
   `LAUNCH_CONTRACT_READ_INVALID`, `LAUNCH_SNAPSHOT_REORGED`). The detail
   page then answers the existing unavailable shape (off-chain `rounds` /
   `config`, `onChainState.source = "unavailable"`); no mixed-block or
   partial chain fact can be published.
3. **Short in-memory cache.** `LAUNCH_SNAPSHOT_CACHE_TTL_MS` (API only;
   integer 0–10 000, default **1500** ≈ half a BSC block interval; 0
   disables). Keyed by `saleId` inside the adapter, i.e. per configured
   contract and therefore per registered launch; each entry carries its own
   `blockNumber`/`blockHash`. Semantics:
   - a pending read is shared by concurrent callers (detail + eligibility
     fired together cost one read);
   - a successful read is served for TTL measured from when it **started**,
     unchanged: `snapshotBlockNumber`, `snapshotBlockHash`, and
     `stateTupleDigest` are the values that read observed, never recomputed;
   - a failed or reorged read is dropped at once and never served;
   - memory only; a restart empties it; the worker's adapter keeps the
     default 0 (no cache) because the lane pins its own snapshots.
     Worst-case staleness of a served value: TTL + one block.
4. **Who shares it.** `GET /v2/launches/{id}` (`readChain`) and
   `GET /v2/launch/{id}/eligibility` (round and `allowlistRoot`) both read
   `readSaleSnapshot`. Eligibility now also fetches `getState` and
   `getSaleConfig` in the same multicall; a failure of either now fails the
   eligibility read the same way a `getRounds` failure always did (fail
   closed; under an unconfirmed mode the bytes stay `TIER_MODE_PENDING`).
   `holders` (wallet-specific `getPosition`/`getRoundPosition`) and the Intent
   prepare (fresh snapshot bound into the Intent) are **not** changed.
5. **Overview.** Already batched: it never reads the chain (S83a) and reads
   PostgreSQL three times — `listLaunches`, the lane checkpoint, and one
   `listStateProjections(launchIds)` (`launch_id = any($1)`). The first two
   now run concurrently. The S83b7 segmentation is untouched (its 10 cases
   pass).
6. **Worker idle log carries the cause.** The `launch_event` lane's
   `unavailable` outcome now carries `rpcError = summarizeRpcError(cause)`
   (Decision 0068 summary) whenever a Provider error exists: the adapter's
   `LaunchContractUnavailableError.cause` for `readLogs`, and the read
   client's `BscReadUnavailableError.rpcError` for head/hash reads.
   `onUnavailable(reasonCode, detail)` receives `errorClass`, `rpcStatus`,
   `rpcCode`, `rpcUrlHost`, `method` (plus `behindBlocks` for S82d), the same
   names as "LOOP BSC indexer lane is unavailable", and `worker-runtime.ts`
   already spreads them into "LOOP launch_event lane is idle". Host name
   only: never a URL path, query string, body, or key. viem's `TimeoutError`
   keeps no request body, so its `method` is `null`.

## Unchanged

Every response shape and byte (the S83a regression fixtures pass), every
reason code, the OpenAPI document, `/v1`, the Intent path, the indexer's
state machine, and the 0076 reorg rule.

## Tests

- `test/launch-sale-snapshot.test.ts` (new, 7): RPC order head → one
  Multicall3 `eth_call` at block N (decoded: `getState`, `getRounds`,
  `getSaleConfig` to the launchpad) → hash check, strictly sequential
  timeline; concurrent callers share one read; TTL 0 never caches; within TTL
  no RPC and the same block/digest even after the chain moved, at TTL a new
  read with the new block/digest; any one inner revert fails the whole read
  and is not cached; transport failure, invalid enum, and reorg keep their
  reason codes and a reorged read is not cached; detail + eligibility fired
  together cost one probe + one snapshot read, a second detail within TTL
  costs nothing, after TTL one read.
- `test/v2-launch-contract-routes.test.ts`: the detail test now asserts one
  `eth_call` to Multicall3 at the snapshot block; two new fail-closed cases
  (`getRounds` / `getSaleConfig` revert inside the multicall) answer the
  existing unavailable shape.
- `test/launch-indexer-worker.test.ts`: an unavailable outcome logs
  `errorClass`/`rpcUrlHost` and never the key path or query.
- `test/config.test.ts`: default 1500, 0 accepted, out-of-range refused.

## Rollback

`LAUNCH_SNAPSHOT_CACHE_TTL_MS=0` disables the cache without a deploy.
Reverting the commit restores the three single `eth_call`s.

## For the main agent

- Three round trips is the floor while 0076 requires the hash re-read
  **after** the calls. Running the hash check concurrently with the
  multicall (the 0082/S86b pinned-allowance pattern) would make it two
  (≈ −190 ms on data-seed) at the cost of not detecting a reorg that lands
  between the call and the hash read. Not done; needs a ruling on 0076.
- A dead first endpoint still costs 2.5 s per stage. viem's fallback
  `rank` option or a "last endpoint that answered first" preference would
  remove that class of incident in code rather than in ops ordering; both
  change the 0038/0076 endpoint policy and are not done here.
