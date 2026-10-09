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

| Topic                  | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two kinds of refusal   | `classifyLogQueryError` returns `shape`, `throttle`, or `null`. **Shape** (the request is objected to; narrowing helps): typed `-32602` / `-32005`, HTTP 413, a JSON-RPC-shaped 4xx body with those codes (the 403 + `-32602 "Request blocked"` seen on 2026-09-22), or refusal text `limit exceeded`, `Request blocked`, `block range`, `more than`, `too wide`, `too large`, `exceed`. **Throttle** (the rate is objected to; narrowing would multiply requests against the same quota, which the API's balance reads share): HTTP 429, or text `rate limit`, `too many`, `quota`, `usage limit` (this is the only reading under which `-32001` counts — in EIP-1474 it is _resource not found_). Text is read only from the `details` of a JSON-RPC error or of a **4xx** `HttpRequestError`; a 5xx body is never read and a bare 403 is not a refusal. Throttles, timeouts, 5xx, and transport failures propagate unchanged to the lane's retry loop. |
| Narrowing order        | Halve the block range down to one block (as before); only then halve the address list down to one address. Limits are **kept on the client** across reads (`learnedRangeLimit`, `learnedAddressGroupLimit`): the next segment is issued at the known-good width and group size without rediscovering them; a read that completes with no refusal relaxes both limits one step, so a transient refusal cannot pin the client to one-block reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Fail closed            | A single-address, single-block request that is still refused throws `BscReadUnavailableError("BSC_LOG_QUERY_REJECTED")` with the original error as `cause`. No partial page is ever returned, so nothing is committed and no checkpoint moves (the Decision 0033 invariant holds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Request budget         | One segment read may issue at most `bscMaximumLogRequestsPerSegment` (512) client-side reads while narrowing (each read is at most endpoints × 4 HTTP attempts through viem's fallback and retry). Past that the read throws `BscReadUnavailableError("BSC_LOG_QUERY_BUDGET_EXHAUSTED")`. A Provider that only serves one block per request is not indexed through by grinding 22 000 reads per segment against a rationed quota; it is reported and fixed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Result order           | Because address splitting reorders requests, collected logs are sorted by `(blockNumber, logIndex)` before decoding, so a split never changes the order in which facts are stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Lane outcome           | Both lanes now map a `BscReadUnavailableError` / `BscChainMismatchError` from the **log reads** (not only from `getHead`) onto the existing `unavailable` tick. A shape refusal that survives narrowing never reaches the retry loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Backoff on refusal     | An `unavailable` tick whose reason is `BSC_LOG_QUERY_REJECTED` or `BSC_LOG_QUERY_BUDGET_EXHAUSTED` waits `retryDelayMs(consecutiveRefusals)` — 1 s, 2 s, 4 s … capped at 30 s, the retry loop's own schedule — before the next tick, so a persistent refusal costs one narrowing walk per backoff period, not one per 3 s. Every other `unavailable` reason keeps the 3 s idle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Backoff event          | `onInfrastructureBackoff` carries `lane`, `errorClass`, `rpcStatus`, `rpcCode`, `rpcUrlHost`, `method` next to the existing three fields, produced by `summarizeRpcError`, which walks viem's `cause` chain. Every value is a class name, an integer, a host name, or a method name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Unavailable visibility | A lane that idles on `unavailable` is logged **once per transition** (`LOOP BSC indexer lane is unavailable`, warn, with the same classification fields and the reason code) and once on recovery (`LOOP BSC indexer lane recovered`, info). The transition key is `reasonCode + rpcUrlHost + rpcCode`, so a change of refusing endpoint or code is a new line; a repeat is not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| What never appears     | The endpoint URL (it carries provider keys), the request body, the address list, response text, or any key. `rpcUrlHost` is the host name only via `endpointLabelFor`; the worker logger additionally re-validates every field (`lane` against the two lane names, `errorClass`/`method` against `[A-Za-z0-9_.-]{1,64}`, `rpcStatus` 100–599, `rpcUrlHost` against a host pattern).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Reason codes added

| Code                             | Where                                            | Meaning                                                                                              |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `BSC_LOG_QUERY_REJECTED`         | lane `runOnce` result, `BscReadUnavailableError` | Every endpoint refused the narrowest possible `eth_getLogs`; the segment is not readable right now.  |
| `BSC_LOG_QUERY_BUDGET_EXHAUSTED` | lane `runOnce` result, `BscReadUnavailableError` | Narrowing would need more than 512 requests for one segment; the endpoint policy is too restrictive. |

Both surface only in the worker log and in `runOnce` results (including
`pnpm indexer:backfill` output). `GET /v2/chain/status` is unchanged: it still
reports the lane by checkpoint height and lag, and `INDEXING_DELAYED`
semantics on wallet routes are unchanged.

`BSC_RPC_UNREACHABLE` is produced by `probeVerification`'s own `catch`
(Decision 0033), before any log read; on that path `errorClass`,
`rpcStatus`, `rpcCode`, `rpcUrlHost`, and `method` are `null`.

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
  `BSC_LOG_QUERY_REJECTED` with one warn line and backs off exponentially
  (1 s → 30 s) between narrowing walks, instead of a bare reason code every
  30 s. The `bsc-dataseed` `limit exceeded` answer is a shape refusal and is
  narrowed; the `1rpc` `-32001` usage limit and the `nodereal` `-32005`
  quota text are throttles and go straight to the retry loop's backoff.
- Tests: the earlier "rethrows `LimitExceededRpcError` for a single block"
  case now asserts `BSC_LOG_QUERY_REJECTED` with the original error as
  `cause`.
- Not done here: the runtime test does not compose the indexer lanes (its
  database fake has no `bscIndexer`), so the `onLaneAvailability` wiring in
  `worker-runtime.ts` is covered by the lane tests and the logger sanitizer
  test, not by a runtime-level test.
