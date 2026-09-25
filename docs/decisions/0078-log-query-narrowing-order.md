# Decision 0078: A refused `eth_getLogs` is narrowed by the dimension the Provider caps, addresses first

- Status: Accepted (S82b)
- Date: 2026-09-25
- Scope: `src/integrations/bsc/rpc-client.ts` (`readLogRangeWith`, the
  `eth_getLogs` transport lane), `src/config.ts` (one key,
  `BSC_LOG_ADDRESS_CHUNK_SIZE`, on the primary and launch chain slots),
  `.env.example`. Amends the narrowing order of Decision 0068 and the
  learned-limit discipline of Decisions 0068 and 0075. No `/v2` route,
  schema, response shape, enum, error code, or lane reason code changes; no
  migration.
- Baseline: `integration/v2` = `18c7742`

## Context

On 2026-09-25 the Development `erc20_transfer` lane never seeded its
checkpoint. Per-request logging of `createBscReadClient` against the
configured endpoints showed:

- The Asset Registry has 11 token addresses; `account_wallets` has 360
  addresses, sent as two wallet topic arrays of 200 (Decision 0075).
- publicnode caps `eth_getLogs` by **address count**: an `address` array of
  8 is served, 11 is refused with HTTP 403 / -32602 `Request blocked`
  whatever the topics (an empty topic list is refused too) and whatever the
  span. The refusal takes about 3 s. bsc-dataseed refuses every
  `eth_getLogs` with -32005 `limit exceeded`. Two quota-exhausted endpoints
  (-32001, HTTP 429 -32005) were removed from `BSC_RPC_URLS`.
- viem's `fallback` retried the whole endpoint list 4 times (its default
  `retryCount` is 3 and 403 / -32005 / 429 are all retryable), so one refused
  request cost about 16 s.
- `readLogRangeWith` narrowed a shape refusal range → topics → addresses.
  Halving 30 blocks to 1 and 200 topics to 1 never changes a 403 that is
  about 11 addresses; after about 6 minutes the 512-read budget ran out
  (`BSC_LOG_QUERY_BUDGET_EXHAUSTED`) and every tick started over, because
  one clean read doubled every learned limit back.
- With a quota-exhausted endpoint last in the list, viem rethrew _its_ 429,
  `classifyLogQueryError` saw a throttle, and the request was not narrowed
  at all even though publicnode had said exactly what was wrong.

## Rulings

### 1. Narrowing order follows the refusal, addresses first

A shape refusal (Decision 0068 classification, unchanged) halves one
dimension of the refused request and re-sends it:

1. If any refusal text of the request names a dimension — `address`;
   `topic`; `block range` / `range too` / `too wide` / `blocks span` /
   `max range` / `more than N results|logs|blocks` / `too many
results|logs|blocks` / `returned more than` / `response size` — the
   first named dimension (in the order below) that can still be halved is
   halved.
2. Otherwise — a bare `Request blocked` or `limit exceeded` — the order is
   **token addresses** (> 1: halve), then the **wallet topic array** (> 1:
   halve), then the **block range** (> 1 block: halve).
3. A request with one address, at most one wallet, and one block that is
   still refused fails closed as `BSC_LOG_QUERY_REJECTED` (unchanged).

Reason: the observed address cap (publicnode ~8–10) is two orders of
magnitude below the topic cap (go-ethereum and bnb-chain/bsc: 1,000
sub-topics per position), and at the ≤ 2,000-block segment width a span cap
is rarely the cause; when it is, Providers say so (`block range`,
`more than 10000 results`) and rule 1 halves the range first. `limit
exceeded` deliberately carries no hint: bsc-dataseed returns it for every
`eth_getLogs`, and hinting it as a range cap would recreate the failure
above whenever publicnode and dataseed both refuse.

Before a request is sent it is pre-split to the learned limits in the same
order (addresses, topics, range). Logs are still returned in block and log
order and never partially.

### 2. Configured address chunk

`BSC_LOG_ADDRESS_CHUNK_SIZE` (integer 1–100, default 8) is the maximum
number of token (emitter) addresses in one `eth_getLogs` request, for every
log read of the client (`readTransferLogs`, `readApprovalLogs`,
`readPoolEventLogs`). It is read by both the API and the worker config and
copied to the launch chain slot. It is the starting and the ceiling value of
the learned address limit: a refusal can only lower it. A value outside the
range fails startup (`ConfigurationError`).

### 3. Learned limits persist and relax slowly

The learned address, topic, and range limits live on the client instance
and are reused by every later read and tick. A read with no shape refusal
counts one clean read; any refusal resets the count. After
**16 consecutive clean segment reads** (`bscLogLimitRelaxAfterCleanReads`;
one `erc20_transfer` tick is three segment reads, so about every five
ticks) every learned limit is doubled once, capped at its ceiling (2,000
blocks; `BSC_LOG_ADDRESS_CHUNK_SIZE`; the caller's topic chunk). A Provider
that keeps its cap therefore costs one refused request per probe, not one
per tick; a Provider whose cap was transient is re-widened within minutes.
Before, one clean read doubled every limit.

### 4. One attempt per endpoint on the log lane

`eth_getLogs` goes through a dedicated `fallback` with `retryCount: 0`
(each endpoint's `http` transport already has `retryCount: 0`), so one
request is at most one HTTP attempt per configured endpoint. A transient
failure propagates to the lane's exponential backoff (Decision 0068), as
point reads already do (Decision 0063). The other range-shaped reads
(Multicall, `getBlock`, simulation, gas) keep the existing aggregate
unchanged. Measured cost of one refused request against the Development
endpoint list (publicnode, bsc-dataseed): about 3–4 s (3.2 s extra on the
first transfer read in the live run below), down from about 16 s.

### 5. Shape refusals are attributed across the endpoint list

viem's `fallback` rethrows only the **last** endpoint's error. Each
endpoint transport of the log lane is wrapped so every error it returns for
the request in flight is recorded (an `AsyncLocalStorage` scoped to the one
`eth_getLogs` call). The request is narrowed when **any** recorded error or
the rethrown error is a shape refusal; the hint of rule 1 is read from all
of them. Only when none is a shape refusal does the rethrown error propagate
unchanged (throttle, timeout, 5xx). `BSC_LOG_QUERY_REJECTED` carries the
rethrown error when it is itself a shape refusal, otherwise the last
recorded shape refusal, so `rpcUrlHost` names the endpoint that refused.

## Invariants

- No log is dropped: every (address, wallet, block) cell of a segment is
  read exactly once or the whole read fails closed.
- The 512-read segment budget and its reason code are unchanged; each read
  is now at most one HTTP attempt per endpoint.
- A throttle alone is never narrowed.
- No new reason code, no API field, no change to Decision 0075's wallet
  topic chunk (`BSC_INDEXER_WALLET_TOPIC_CHUNK_SIZE`).

## Evidence

Fixture tests (`test/bsc-log-query-narrowing.test.ts`; a transport that
refuses > 8 addresses with 403 `Request blocked` and > 1,000 sub-topics
with `too many topics`): 11 tokens × 360 wallets × 30 blocks is read in 9
HTTP requests (1 `eth_chainId` + 8 `eth_getLogs`) for transfers and 4 for
approvals, equal to the same read against an uncapped endpoint in one
request per side; with a configured chunk of 100 the first read learns 6
from one refusal (10 requests) and the second read uses it (8 requests, no
refusal); a throttle is sent once per endpoint and not narrowed; a
`block range too large` refusal halves only the range; an earlier
endpoint's 403 is narrowed even when the last endpoint returned 429.

Live read-only run, 2026-09-25, Development endpoint list, 11 registry
tokens, 360 random wallets, head−30..head:

| Build                  | Read         | Result                           | HTTP | Time    |
| ---------------------- | ------------ | -------------------------------- | ---- | ------- |
| `18c7742` (before)     | transfers    | `BSC_LOG_QUERY_BUDGET_EXHAUSTED` | 610  | 349.0 s |
| `18c7742` (before)     | approvals    | `BSC_LOG_QUERY_BUDGET_EXHAUSTED` | 512  | 125.6 s |
| this change, chunk 8   | transfers #1 | ok                               | 8    | 3.1 s   |
| this change, chunk 8   | approvals #1 | ok                               | 4    | 1.0 s   |
| this change, chunk 8   | transfers #2 | ok                               | 8    | 2.4 s   |
| this change, chunk 8   | approvals #2 | ok                               | 4    | 1.0 s   |
| this change, chunk 100 | transfers #1 | ok, learns 6 from one 403        | 10   | 6.3 s   |
| this change, chunk 100 | approvals #1 | ok                               | 4    | 0.9 s   |
| this change, chunk 100 | transfers #2 | ok, learned limit reused         | 8    | 1.8 s   |
| this change, chunk 100 | approvals #2 | ok                               | 4    | 0.9 s   |

HTTP counts are `eth_getLogs` requests (chain verification and the head
read are outside the rows). The one refused 11-address request of the
chunk-100 run cost one publicnode 403 plus one bsc-dataseed reply (2 HTTP
requests, about 3.2 s), against 4 passes over the list before.

## Consequences

- The `erc20_transfer` lane seeds and advances against publicnode.
- An operator can lower `BSC_LOG_ADDRESS_CHUNK_SIZE` for a stricter
  Provider without waiting for the client to learn it; raising it above a
  Provider's cap costs one refused request per probe.
- A Provider that caps _span_ but reports it with no recognisable text is
  narrowed addresses and topics first; it still converges (range is last,
  not skipped) at the cost of extra refusals, bounded by the budget.
