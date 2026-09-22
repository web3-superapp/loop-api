# Decision 0068: A Provider refusal of `eth_getLogs` is narrowed, then fails closed, and is always visible

- Status: Accepted
- Date: 2026-09-22
- Scope: `src/integrations/bsc/rpc-client.ts` (log range reads), the
  `erc20_transfer` and `pool_event` indexer lanes, the reconciliation worker
  log fields, and the `LOOP BSC indexer lane is unavailable` /
  `LOOP BSC indexer lane recovered` log lines. Extends Decisions 0033 and
  0034; no ruling in either is reversed. No API response, config projection,
  migration, or route changes.

## Context

On 2026-09-22 the Development stack's `erc20_transfer` lane failed
continuously and the worker printed only:

```
{"reasonCode":"bsc_indexer_unavailable","retryDelayMs":30000,"consecutiveFailureCount":6,"msg":"LOOP reconciliation worker infrastructure retry scheduled"}
```

Assembling the lane by hand showed the cause: every configured endpoint
refused the lane's `eth_getLogs` (11 registry addresses, the `Transfer`
topic, a 30-block range):

| Endpoint                    | Answer                                                       |
| --------------------------- | ------------------------------------------------------------ |
| `bsc-rpc.publicnode.com`    | HTTP 403, body `{"code":-32602,"message":"Request blocked"}` |
| `bsc-dataseed.bnbchain.org` | `limit exceeded`                                             |
| `1rpc.io`                   | JSON-RPC `-32001` usage limit                                |
| `nodereal`                  | JSON-RPC `-32005` quota exhausted                            |

viem's `fallback` transport rethrows the last endpoint's error, an
`HttpRequestError` with `status: 403`. That is neither a
`LimitExceededRpcError` nor an `InvalidParamsRpcError`, so the existing range
halving did not engage; it is not a `BscReadUnavailableError`, so the lane
did not go `unavailable`; the lane's retry loop caught it with a bare
`catch {}` and reported only a reason code. Three defects, one symptom.

## Rulings

| Topic                  | Ruling                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is a refusal      | `isLogQueryRejection`: HTTP 403 / 413 / 429; JSON-RPC `-32602`, `-32001`, `-32005` (from the typed error **or** from a JSON-RPC-shaped 4xx body); or refusal text (`limit exceeded`, `Request blocked`, `usage limit`, `rate limit`, `quota`, `too many`). A timeout, a 5xx, or a transport failure is **not** a refusal and still propagates unchanged.                            |
| Narrowing order        | Halve the block range down to one block (as before); only then halve the address list down to one address. An address-group limit learned on one leaf applies to every pending leaf of the same read, so it is discovered once per segment, not once per block.                                                                                                                     |
| Fail closed            | A single-address, single-block request that is still refused throws `BscReadUnavailableError("BSC_LOG_QUERY_REJECTED")` with the original error as `cause`. No partial page is ever returned, so nothing is committed and no checkpoint moves (the Decision 0033 invariant holds).                                                                                                  |
| Request budget         | One segment read may issue at most `bscMaximumLogRequestsPerSegment` (512) `eth_getLogs` requests while narrowing. Past that the read throws `BscReadUnavailableError("BSC_LOG_QUERY_BUDGET_EXHAUSTED")`. A Provider that only serves one block per request is not indexed through by grinding 22 000 requests per segment against a rationed quota; it is reported and fixed.      |
| Result order           | Because address splitting reorders requests, collected logs are sorted by `(blockNumber, logIndex)` before decoding, so a split never changes the order in which facts are stored.                                                                                                                                                                                                  |
| Lane outcome           | Both lanes now map a `BscReadUnavailableError` / `BscChainMismatchError` from the **log reads** (not only from `getHead`) onto the existing `unavailable` tick. A classified refusal never reaches the retry loop.                                                                                                                                                                  |
| Backoff event          | `onInfrastructureBackoff` carries `lane`, `errorClass`, `rpcStatus`, `rpcCode`, `rpcUrlHost`, `method` next to the existing three fields, produced by `summarizeRpcError`, which walks viem's `cause` chain. Every value is a class name, an integer, a host name, or a method name.                                                                                                |
| Unavailable visibility | A lane that idles on `unavailable` is logged **once per transition** (`LOOP BSC indexer lane is unavailable`, warn, with the same classification fields and the reason code) and once on recovery (`LOOP BSC indexer lane recovered`, info). Not once per 3-second tick.                                                                                                            |
| What never appears     | The endpoint URL (it carries provider keys), the request body, the address list, response text, or any key. `rpcUrlHost` is the host name only via `endpointLabelFor`; the worker logger additionally re-validates every field (`lane` against the two lane names, `errorClass`/`method` against `[A-Za-z0-9_.-]{1,64}`, `rpcStatus` 100–599, `rpcUrlHost` against a host pattern). |

### Reason codes added

| Code                             | Where                                            | Meaning                                                                                              |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `BSC_LOG_QUERY_REJECTED`         | lane `runOnce` result, `BscReadUnavailableError` | Every endpoint refused the narrowest possible `eth_getLogs`; the segment is not readable right now.  |
| `BSC_LOG_QUERY_BUDGET_EXHAUSTED` | lane `runOnce` result, `BscReadUnavailableError` | Narrowing would need more than 512 requests for one segment; the endpoint policy is too restrictive. |

Both surface only in the worker log and in `runOnce` results (including
`pnpm indexer:backfill` output). `GET /v2/chain/status` is unchanged: it still
reports the lane by checkpoint height and lag, and `INDEXING_DELAYED`
semantics on wallet routes are unchanged.

## Invariants

1. A checkpoint is written only in the same transaction as every log of its
   range (Decision 0033). Narrowing never relaxes this: any refused leaf aborts
   the whole segment read.
2. No fixture stands in for a chain fact: a refused read yields
   `unavailable`, never an empty page.
3. Provider URLs, request bodies, and address lists never enter a log line.
4. `BSC_INDEXER_*` configuration, its projection, and every `/v2` response
   are byte-identical before and after this decision.

## Consequences

- The Development failure of 2026-09-22 now logs
  `errorClass=HttpRequestError rpcStatus=403 rpcCode=-32602 rpcUrlHost=bsc-rpc.publicnode.com method=eth_getLogs`
  and, if narrowing does not help, the lane idles on
  `BSC_LOG_QUERY_REJECTED` with one warn line instead of a 30-second retry
  storm.
- Tests: the earlier "rethrows `LimitExceededRpcError` for a single block"
  case now asserts `BSC_LOG_QUERY_REJECTED` with the original error as
  `cause`.
- Not done here: the runtime test does not compose the indexer lanes (its
  database fake has no `bscIndexer`), so the `onLaneAvailability` wiring in
  `worker-runtime.ts` is covered by the lane tests and the logger sanitizer
  test, not by a runtime-level test.
