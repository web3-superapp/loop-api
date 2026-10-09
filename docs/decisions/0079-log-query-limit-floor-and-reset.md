# Decision 0079: Learned `eth_getLogs` limits have floors, reset when they stop paying, and never shrink on a throttle

- Status: Accepted (S82c)
- Date: 2026-09-25
- Scope: `src/integrations/bsc/rpc-client.ts` (`readLogRangeWith` and the
  learned-limit state of `createBscReadClient`), the `erc20_transfer` and
  `pool_event` lane log events (`src/bsc-indexer-worker.ts`,
  `src/bsc-pool-indexer-worker.ts`), the worker log allowlist
  (`src/reconciliation-worker-logger.ts`) and wiring
  (`src/worker-runtime.ts`). Amends rulings 3 and 5 of Decision 0078. No
  `/v2` route, schema, response shape, enum, error code, or migration; one
  new worker-log reason code, `BSC_LOG_LIMITS_RESET`.
- Baseline: `integration/v2` = `b4c4451` (contains Decision 0078)

## Context: the 2026-09-25 incident

Times are UTC+8, observed by the main agent on the Development stack.

- After Decision 0078 was deployed the `erc20_transfer` lane seeded its
  checkpoint within 6 s and caught up about 2,300 blocks.
- From 14:59 both log lanes (`erc20_transfer` and `pool_event`, which share
  one read client) failed every segment for 20 minutes: `worker.log`
  alternated `BSC_LOG_QUERY_REJECTED` (`LimitExceededRpcError` -32005,
  `rpcUrlHost` `bsc-dataseed.bnbchain.org`) and
  `BSC_LOG_QUERY_BUDGET_EXHAUSTED`. No segment succeeded.
- At the same time a fresh `createBscReadClient` from the same build read
  the lane's real next segment (11 tokens, 360 wallets, 2,000 blocks,
  publicnode + dataseed) in 8 requests and 4.7 s. The endpoints were fine;
  the worker's client instance was not.
- Mechanism: while catching up, publicnode rate-limited this host (HTTP 429) and bsc-dataseed answered every `eth_getLogs` with -32005
  `limit exceeded`. Decision 0078 ruling 5 narrowed a request whenever _any_
  endpoint gave a shape refusal, so each 429 + -32005 pair halved a limit;
  the limits reached 1 address, 1 wallet, 1 block. At that shape a segment
  needs hundreds of thousands of requests, so every read ran out of its
  512-read budget, no read was ever clean, the 16-clean-read relaxation
  never fired, and the client never widened again. Because both lanes share
  the client, both stalled.
- Mitigation before this change: bsc-dataseed removed from `BSC_RPC_URLS`
  (only publicnode remains) and the worker restarted.

## Rulings

### 1. A throttle anywhere in a request wins over a shape refusal (amends 0078 ruling 5)

The endpoint errors of one `eth_getLogs` request are still all recorded
(Decision 0078). If **any** of them, or the error viem rethrows, is a
throttle (HTTP 429, `rate limit`, `too many requests`, `quota`, `usage
limit`; Decision 0068 classification unchanged), the throttle itself is
rethrown to the lane's exponential backoff and **nothing is narrowed**, even
if another endpoint returned a shape refusal. Reason: a shape refusal is
deterministic, so the same request will be refused again after the backoff
and can be narrowed then; a throttle is temporary, and narrowing multiplies
the requests sent against the exhausted quota. The rethrown error is the
throttle (not the last endpoint's error), so the lane log shows
`rpcStatus` 429 and the throttling host.

Consequence, accepted: an endpoint that is _permanently_ quota-exhausted
(the case Decision 0078 ruling 5 also covered) now stops narrowing for the
whole list, and the lane backs off with that host in its log line. Such an
endpoint must be removed from `BSC_RPC_URLS`, as was already done for the
two quota-exhausted endpoints in Decision 0078.

### 2. Learned limits have floors; only a named dimension goes below one

| Limit                       | Floor | Ceiling                      |
| --------------------------- | ----- | ---------------------------- |
| token addresses per request | 1     | `BSC_LOG_ADDRESS_CHUNK_SIZE` |
| wallets per topic OR array  | 100   | caller's topic chunk (200)   |
| blocks per request          | 500   | 2,000                        |

A shape refusal whose text **names** the dimension (Decision 0078 hints:
`address`, `topic`, `block range`, `more than N results`, ...) lowers the
learned limit to half the refused request, below the floor if need be. A
refusal that names no dimension (`Request blocked`, `limit exceeded`) lowers
the learned value no further than the floor; below it, the narrowing
applies to the rest of the **current segment read** only and is never
written back. The unhinted narrowing order also respects the floors: the
first dimension (addresses, topics, range) still _above_ its floor is
halved first, and only then one at or below it.

Why these numbers (the task suggested 1 / 8 / 32):

- The floors must let a client that is pinned at them still finish a
  segment inside the 512-read budget, otherwise the floor does not prevent
  the incident above. Today's wallet-scoped segment at the floors is
  11 addresses × 4 topic arrays (360 wallets at 100) × 4 ranges = **176
  requests per side**. At 1 / 8 / 32 it would be 11 × 45 × 63 = 31,185, far
  past the budget: the same deadlock with extra steps.
- Addresses: 1. The address count is the dimension publicnode actually caps
  without naming it (403 `Request blocked` above ~8, Decision 0078); a floor
  above a real unhinted cap would make every request of every segment be
  refused once. The ceiling (default 8) already bounds the cost.
- Topics: 100. go-ethereum and bnb-chain/bsc cap one topic position at 1,000
  sub-topics and name topics when they refuse; a Provider refusing fewer
  than 100 without saying so has not been observed.
- Range: 500. Span caps are reported with a recognisable text (`block
range`, `more than 10000 results`) and then still go below 500; an
  unhinted span cap below 500 costs a few refusals per read (the read-local
  limit carries it), not a persistent narrowing.

### 3. Reset when the learned shape stops paying

The three learned limits, the clean streak, and the probe state are reset to
the configured starting values (addresses `BSC_LOG_ADDRESS_CHUNK_SIZE`,
topics the caller's chunk, range 2,000) when:

- a segment read runs out of its 512-read budget
  (`BSC_LOG_QUERY_BUDGET_EXHAUSTED`, still returned to the lane), or
- a throttle aborts a read while any learned limit is below its ceiling
  (the throttle is still rethrown). A narrow shape multiplies the requests
  of every segment; against a rate-limited Provider it is exactly what
  keeps the lane throttled, and the live run below showed a client at the
  floors (176 requests per side) throttled on every attempt against
  publicnode. A real cap is re-learned from one refusal per halving (at
  most about 6 requests).

Each reset calls the client's `onLogQueryLimitsReset` hook; the worker logs
one warn line `LOOP BSC log-query limits reset to their configured values`
with `reasonCode` `BSC_LOG_LIMITS_RESET`, `detailReasonCode`
`BSC_LOG_QUERY_BUDGET_EXHAUSTED` or `BSC_LOG_QUERY_THROTTLED`,
`previous{Address,TopicGroup,Range}Limit` (before) and `learned*Limit` (after).
Numbers and codes only. The reset is on the shared client, so it frees both
lanes.

### 4. Faster, damped re-widening (amends 0078 ruling 3)

After **4** consecutive refusal-free segment reads (was 16) every learned
limit is doubled once, capped at its ceiling. One `erc20_transfer` tick is
three segment reads, so a narrowed client starts widening after about two
ticks, and from the floors it is back at the ceilings after 12 clean reads
(1→2→4→8 addresses, 100→200 wallets, 500→1,000→2,000 blocks). If the read
right after a widening is refused, the widening is rolled back (each limit
returns to its pre-probe value or lower) and the streak needed for the next
probe doubles: 4 → 8 → 16 → 32 (cap). A probe that holds restores 4. A
Provider that keeps its cap therefore costs one refused request per 32
clean reads at steady state, and a transient cap is re-widened within
minutes.

### 5. Observability

`BscReadClient.logQueryLimits()` (optional; absent on fakes and the
unavailable client) returns `learnedAddressLimit`, `learnedTopicGroupLimit`,
`learnedRangeLimit`, `relaxAfterCleanReads`. The lanes' retry-loop warn line
(`onInfrastructureBackoff`) and the `unavailable` / `recovered` lines carry
these four integers, so one log line tells whether the client has narrowed
to its floors.

## Invariants

- No log is dropped; a read still fails closed as a whole
  (`BSC_LOG_QUERY_REJECTED` at one address, one wallet, one block;
  `BSC_LOG_QUERY_BUDGET_EXHAUSTED` at 512 reads).
- A throttle is never narrowed.
- No API field, route, error code, or migration changes.

## Evidence

Fixture tests (`test/bsc-log-query-narrowing.test.ts`, "learned-limit
floors, throttle priority, and reset"):

- endpoint A 429 for three requests then serving, endpoint B -32005 on every
  request: three reads reject with the 429, one request per endpoint each,
  learned limits unchanged, no reset; the fourth read succeeds at the
  configured shape (4 requests);
- an unhinted Provider that serves only shapes at the floors: the first read
  learns exactly 1 / 100 / 500 in 6 refusals; a read at the floors costs 176
  requests; after 4, 8, 12 clean reads the limits are 2/200/1000, 4/200/2000,
  8/200/2000;
- an unhinted 100-block span cap: learned range stays 500, the read in
  flight goes to 63;
- a single-block-only Provider: 512 requests, `BSC_LOG_QUERY_BUDGET_EXHAUSTED`,
  one `BSC_LOG_LIMITS_RESET` (before 1/100/500, after 8/200/2000), the next
  read costs 4 requests;
- a throttle at the floors: one reset with `BSC_LOG_QUERY_THROTTLED`; a
  throttle at the ceilings resets nothing;
- a probe refused on the next read: rolled back to 6 addresses, streak
  8 → 16 → 32 → 32; after the cap lifts, the probe holds and the streak
  returns to 4;
- `pool_event` running out of budget after `erc20_transfer` narrowed the
  shared client to its floors: the reset restores both lanes' request counts
  (4 approvals requests, 2 pool requests).

`test/bsc-indexer-worker.test.ts`: a real client with a 429 endpoint and a
-32005 endpoint gives the lane one backoff event with `rpcStatus` 429 and
learned limits 8/200/2000/4.

Live read-only run, 2026-09-25 afternoon, `dist` build of this change,
Development `BSC_RPC_URLS` (publicnode only since the mitigation), 11
registry tokens, 360 random wallets, topic chunk 200. Each "segment" is what
one `erc20_transfer` tick reads: `readTransferLogs` (two sides) plus
`readApprovalLogs` over the latest 2,000 blocks (head−2029..head−30; the
five segments overlap in time because publicnode refuses blocks older than
about 10,000 with 403 `Archive requests require a personal token`, see
Consequences). A 429 is retried by the script like the lane (1 s, 2 s, ...).
The counts are `eth_getLogs` HTTP requests.

| Run                        | Seg 1                                     | Seg 2              | Seg 3              | Seg 4              | Seg 5              |
| -------------------------- | ----------------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ |
| normal, run A              | 12, 5.2 s                                 | 12, 4.3 s          | 12, 5.1 s          | 18 (3×429), 14.9 s | 18 (2×429), 13.7 s |
| normal, run B              | 12, 9.6 s                                 | 14 (1×429), 12.1 s | 12, 9.7 s          | 15 (1×429), 10.5 s | 12, 5.8 s          |
| from floors 1/100/500      | 37 (25 at floors, 429, reset, 12), 23.1 s | 12, 7.4 s          | 12, 7.1 s          | 12, 7.6 s          | 12, 5.3 s          |
| from floors, paced 1 req/s | 29 (17 at floors, 429, reset, 12), 45.0 s | 12, 20.6 s         | 15 (1×429), 31.9 s | 12, 19.0 s         | 12, 17.9 s         |

Learned limits after every normal segment: 8/200/2000. In both floor runs
publicnode answered 429 after 25 (unpaced) and 17 (paced at 1 request per
second) requests at the floors; the throttle reset the limits
(`BSC_LOG_LIMITS_RESET`, `BSC_LOG_QUERY_THROTTLED`, before 1/100/500) and the
same segment then completed at 8/200/2000 in 12 requests. A client at the
floors (528 requests per tick) never completed a read against publicnode in
this run, which is why ruling 3 resets on a throttle and not only on budget
exhaustion; the clean-read path of ruling 4 is covered by the fixture tests.
The Development worker was reading publicnode from the same host during the
run, so the rate budget was shared.

## Consequences

- A lane that hits a rate limit backs off instead of narrowing, and a
  client that did narrow comes back within a few ticks or immediately on the
  next budget exhaustion or throttle.
- A permanently quota-exhausted endpoint in `BSC_RPC_URLS` blocks narrowing
  for the whole list (ruling 1); remove it.
- Operators read the learned limits straight off the lane log lines.
- Not addressed here (observed during the live run): publicnode refuses
  `eth_getLogs` for blocks older than about 10,000 below head with HTTP 403
  / -32602 `Archive requests require a personal token`. That is classified
  as an unhinted shape refusal, so a lane whose checkpoint falls that far
  behind (about 75 minutes at current BSC block times) narrows each read to
  one cell and fails closed (`BSC_LOG_QUERY_REJECTED`, or budget exhaustion
  and a reset) on every tick, and cannot catch up without an archive-capable
  endpoint. Classifying it as its own non-narrowable refusal is left to a
  follow-up decision.

## Main-agent rulings (2026-09-25)

1. **Throttle reset kept.** The addition beyond the task sheet stays: the live run showed a client parked at the floor never leaves it under a per-second rate limit without this rule.
2. **Archive boundary** (publicnode "Archive requests require a personal token", 403 -32602): to be classified on its own and never narrowed, with the lane reporting "behind the provider's window, reseed"; tracked as S82d. Until then the runbook remedy is `ops/indexer-reseed.sh`.
3. **Endpoint hygiene is configuration.** A permanently throttled or quota-exhausted endpoint must be removed from `BSC_RPC_URLS` / `LAUNCH_BSC_RPC_URLS`; the client cannot tell it from a transient limit. Recorded in the ops runbook.

## S82d: archive refusals are a third class (2026-09-25)

Ruling 2 above, implemented.

- `classifyLogQueryError` returns `archive` when the refusal text (a 4xx body
  or a JSON-RPC error; never a 5xx page) matches `archive`, `personal
token`, `pruned`, `historical`, or `missing trie node`. It is checked after
  the throttle texts (a quota is still a rate objection) and **before** the
  shape codes, so publicnode's HTTP 403 / -32602 is no longer read as an
  unhinted shape refusal.
- Wording checked live on 2026-09-25 (`eth_getLogs`, 3-block range):
  publicnode mainnet (`bsc-rpc.publicnode.com`) answers HTTP 403 `{"code":
-32602, "message": "Archive requests require a personal token. …"}` from
  about 20,000 blocks back (the refusal starts roughly 10,000 behind head);
  publicnode testnet (`bsc-testnet-rpc.publicnode.com`) answers HTTP 200
  `{"code": -32701, "message": "History has been pruned for this block. …"}`
  3,000,000 blocks back; NodeReal and dRPC served the same ranges (dRPC
  failed a deep one with a 5xx "Temporary internal error", which stays an
  outage); `bsc-dataseed.bnbchain.org` answered `-32005 limit exceeded` at
  every depth (shape, unchanged); 1RPC only returned its `-32001` usage-limit
  text (throttle, unchanged), so its archive wording could not be observed.
- The range reader: an archive refusal with no shape refusal from another
  endpoint of the same request fails the read at once with
  `BscReadUnavailableError("BSC_LOG_ARCHIVE_REQUIRED")` (with the Provider
  classification). Nothing is narrowed, the learned limits are neither
  lowered nor reset, and the clean-read streak is not touched. If another
  endpoint refuses the shape, narrowing proceeds for that endpoint as before.
- The lanes: `erc20_transfer` and `pool_event` report `unavailable` /
  `BSC_LOG_ARCHIVE_REQUIRED` with `behindBlocks = head − fromBlock` on the
  run result and on the once-per-transition availability line (the worker
  logger now allowlists `behindBlocks`), and back off exponentially like the
  other refusals. The `launch_event` lane reads through the contract adapter;
  when the adapter's `LAUNCH_CONTRACT_READ_FAILED` wraps an archive refusal
  it reports `BSC_LOG_ARCHIVE_REQUIRED` with `behindBlocks` instead.
- The remedy stays operational (reseed with `ops/indexer-reseed.sh`, or an
  archive-capable endpoint in `BSC_RPC_URLS` / `LAUNCH_BSC_RPC_URLS`); the
  lane never skips the gap on its own.
