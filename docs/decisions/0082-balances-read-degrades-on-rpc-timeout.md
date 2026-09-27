# Decision 0082: Balances read degrades on RPC timeout; internal errors are logged

- Status: Proposed (backend, S86)
- Date: 2026-09-27
- Scope: S86. `GET /v2/wallets/{walletId}/balances` and the V2 error
  handler. Builds on Decisions 0038 (launch chain slot), 0063 (point-read
  lane, parallel legs, 3000 ms launch deadline), 0077 (`launchChain.usd1`),
  and 0081 (root `launchUsd1`).
- Baseline: `integration/v2` = `8bf2cca`. No migration, no response-shape
  change, no new reason code.

## Context

The device's Launch purchase page reads the wallet balances to learn the
USD1 allowance. On the development stack the route returned
`500 INTERNAL_ERROR` about once in thirty reads (api.log 2026-09-27 09:18:05
and 09:24:32, five more on 2026-09-26 15:57–16:06), always after about
2525 ms, and the page then showed "allowance not read" and blocked the
purchase. The server log held one line, `Request failed INTERNAL_ERROR`,
with nothing about the cause.

### Reproduction

In-process harness: `buildApp` with the development env
(`.env.local` + `ops/api-dev.env` + `ops/api-dev.local.env`), a fake Privy
verifier resolving the dev account `3bb58597-…`, an `onError` hook, wait for
`/v2/chain/status.launchChain.verification === "verified"`, then
`GET /v2/wallets/d60627ca-…/balances` every 200 ms. Run with
`--stack-trace-limit=60` so the async frames survive. The harness was only
reading; it was deleted afterwards.

Captured error (before the fix):

```text
TimeoutError  host: https://bsc-rpc.publicnode.com
body: {"method":"eth_getBlockByNumber","params":["latest",false]}
at Object.request (viem/utils/rpc/http.ts:134:28)
at fn (viem/clients/transports/http.ts:148:35)
…
at fetch (viem/clients/transports/fallback.ts:138:48)
…
at getBlock (viem/actions/public/getBlock.ts:119:26)
at Object.getBlock (viem/clients/decorators/public.ts:2059:25)
at readHead (src/integrations/bsc/rpc-client.ts:1524:32)
at Object.readBalances (src/integrations/bsc/rpc-client.ts:1602:26)
at async Object.measure (src/features/wallet/wallet-read-service.ts:413:16)
at async Object.getBalances (src/features/wallet/wallet-read-service.ts:1072:16)
at async Object.<anonymous> (src/routes/v2/wallet.ts:129:24)
```

### Root cause

1. `BSC_RPC_URLS` on the development stack has a single mainnet endpoint.
   The primary `readBalances` reads the head through the point-read lane
   (`pointReadTimeoutMs = 2500`, fallback `retryCount: 0`), so one stalled
   `eth_getBlockByNumber` rejects with viem's `TimeoutError` after 2.5 s.
2. `readHead` does not classify transport errors, and `getBalances` passed
   the error to `chainUnavailable`, which mapped only
   `BscReadUnavailableError` / `BscChainMismatchError` to `503` and rethrew
   everything else. The raw `TimeoutError` reached Fastify and became
   `500 INTERNAL_ERROR`.
3. The secondary legs had the same gap: `projectLaunchChainNative` and
   `readLaunchChainUsd1` rethrew an unclassified error (a `TimeoutError` or
   `HttpRequestError` that arrives inside the 3000 ms deadline, e.g. both
   testnet endpoints failing fast), and the price leg had no catch at all;
   any of them rejected the final `Promise.all` and the whole page.
4. The error handler logged only the projected code at `warn`, so the cause
   was invisible.

## Rulings

### 1. Transport failures are a named class

`isBscRpcTransportError(error)` (`src/integrations/bsc/rpc-client.ts`) is
true when the error or any error in its `cause` chain is viem's
`TimeoutError`, `HttpRequestError`, or `SocketClosedError`. It says only
"the endpoint did not answer"; it never says anything about the chain.
The rpc-client itself is unchanged: the indexer lanes and write paths keep
their own classification.

### 2. Balances: every leg settles on its own

| Leg                                    | Failure                                                                                            | Projection (response stays `200` unless noted)                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary block (`snapshot`, `balances`) | No answer after 1500 ms, a transport failure, or the chain-id probe answered `BSC_RPC_UNREACHABLE` | **One** more read (hedged: started beside a slow first read, or after a failed one); the first complete read wins. Both failing is `503 CAPABILITY_UNAVAILABLE`, `detailsSafe.reasonCode = "BSC_RPC_UNREACHABLE"` |
| Primary block                          | `BscReadUnavailableError` (other reason), `BscChainMismatchError`                                  | Unchanged: `503 CAPABILITY_UNAVAILABLE`, `detailsSafe: null`, no retry                                                                                                                                            |
| `launchChain` (separate slot, native)  | Transport failure                                                                                  | `availability: unavailable`, `reasonCode: LAUNCH_CHAIN_RPC_UNREACHABLE`, `nativeBalance: null`                                                                                                                    |
| `launchChain` (separate slot, native)  | Anything else not already classified                                                               | Same block with `reasonCode: BSC_BALANCE_CALL_FAILED`; logged at `warn`                                                                                                                                           |
| `launchChain.usd1` / root `launchUsd1` | Transport failure or anything else                                                                 | Key absent (0077/0081 rule: never null, never a guess); logged at `warn` when unclassified                                                                                                                        |
| Per-asset prices                       | The price read rejects outright                                                                    | Every row `valuation: {status: unavailable, reasonCode: MARKET_PROVIDER_UNREACHABLE}`; `netWorth` follows the existing rules                                                                                      |
| Privy cross-check, audit snapshots     | Already absorbed                                                                                   | Unchanged                                                                                                                                                                                                         |
| Wallet record, asset registry, pending | Database                                                                                           | Unchanged: the only legs allowed to fail the page                                                                                                                                                                 |

The primary block keeps its required shape (`snapshot` is required and
non-null), so a primary chain that does not answer twice cannot be a `200`
without a contract change; it is a retryable `503`, never a `500`.

The second read is a hedge, not a sequential retry, because the endpoint's
latency is heavy-tailed rather than dead: 40 direct `eth_getBlockByNumber`
calls to `bsc-rpc.publicnode.com` from the development host measured p50
0.42 s, p90 4.6 s, max ≥ 6 s. Waiting the full 2.5 s budget before asking
again doubled the tail (a sequential retry left 2 non-`200` in 200 reads,
p95 3.4 s); starting the second read at 1500 ms
(`primaryReadHedgeDelayMs`) takes the fast answer instead. Both reads are
independent complete reads (each pins its own head and reads every asset at
that block), so whichever wins is one consistent block. At most one extra
read is ever started per page; worst case is 1.5 s + one point-read budget,
well inside the 15 s handler deadline. `primaryAttempts` is added to the
debug segment-timings line. Nothing is served from a stored
snapshot, and no leg ever produces a value it did not read.

The warn line for a degraded leg carries only the leg name, the error class
name, and whether it was a transport failure: no message, URL, address, or
amount.

### 3. Error handler: last line of defence and logged causes

- For a V2 `GET`/`HEAD` route, an error that reaches the handler and is a
  `BscReadUnavailableError` becomes `503 CAPABILITY_UNAVAILABLE` with
  `detailsSafe.reasonCode` = its reason code; a transport failure becomes
  the same with `BSC_RPC_UNREACHABLE`. Write routes keep their own
  classification (a write that leaks a raw transport error is still a
  `500` and is logged, so it is found and fixed where it belongs).
- Every V2 `INTERNAL_ERROR` is logged once at `error` level,
  `"Unhandled error in V2 request"`, with `requestId`, `errorName`,
  `errorMessage` and `errorStack` (first 10 frames). The message and frames
  are redacted by `src/core/http/error-log.ts`: URL path/query/userinfo
  dropped (host kept), `Bearer …` and `key=`/`token=`/`secret=`/… values
  replaced, `0x` hex of 40+ digits replaced, message capped at 600
  characters. Nothing of it reaches the response body. The existing
  `warn` "Request failed" line is unchanged.

### 4. Reason codes

No new code. Used: `BSC_RPC_UNREACHABLE` (now also in `detailsSafe` of the
balances `503`), `LAUNCH_CHAIN_RPC_UNREACHABLE`, `BSC_BALANCE_CALL_FAILED`,
`MARKET_PROVIDER_UNREACHABLE`.

## Verification

- Service tests (`test/wallet-balances-latency.test.ts`, "primary block
  hedge"): a first read that never answers is overtaken by the hedge; a
  fast first read starts no second read; two timeouts are
  `CAPABILITY_UNAVAILABLE` + `BSC_RPC_UNREACHABLE`.
- Route tests (`test/v2-chain-wallet-routes.test.ts`, "RPC timeouts on the
  balances legs"): primary `TimeoutError` once → `200` after two reads;
  twice → `503` + `BSC_RPC_UNREACHABLE`, body without the host; probe
  unreachable once → `200`; mismatch → no retry; launch slot `getHead` /
  `readBalances` / `readAllowances` throwing `TimeoutError` → `200` +
  `LAUNCH_CHAIN_RPC_UNREACHABLE`, no `usd1`; unclassified launch error →
  `BSC_BALANCE_CALL_FAILED`; shared-slot USD1 timeout → `launchUsd1`
  absent; price read rejection → rows unvalued. All six new balances-leg
  cases fail against the pre-fix service.
- Error handler tests (`test/v2-error-handler-rpc.test.ts`): GET timeout /
  wrapped HTTP failure / `BscReadUnavailableError` → `503`; POST timeout →
  `500`; `INTERNAL_ERROR` log line at level 50 with name, redacted message,
  ≤10 frames, and no key path, userinfo, query secret, address, or token.
- Harness after the fix, same development env, 200 reads each, 200 ms
  apart. The harness connected with `default_transaction_read_only=on` so
  it could not write to `loop_api_dev`; the price leg therefore failed on
  its cache write in 160 of 200 reads and was reported unvalued (before
  this fix that alone would have been a `500`).

  | Build                                      | non-`200`                       | `500` | p50     | p95     | max     |
  | ------------------------------------------ | ------------------------------- | ----- | ------- | ------- | ------- |
  | Sequential retry, no probe retry           | 1 (`503`, probe at read 0)      | 0     | 1093 ms | 2871 ms | 3748 ms |
  | Sequential retry + probe retry             | 2 (`503` `BSC_RPC_UNREACHABLE`) | 0     | 1220 ms | 3386 ms | 5327 ms |
  | **Final: hedged at 1500 ms + probe retry** | **0**                           | 0     | 1077 ms | 2527 ms | 4038 ms |

  In the final run one primary attempt timed out (`TimeoutError`,
  `bsc-rpc.publicnode.com`) and the hedge answered.

## Open for the main agent

- A primary chain that fails twice is still a `503` for the whole page,
  including the launch slot block the Launch purchase needs. Making it a
  `200` would need `snapshot` (and the rows) to become nullable: a contract
  change, not made here.
- The development stack has one mainnet endpoint in `BSC_RPC_URLS`; a
  second endpoint (ops change) removes most of the retry cost.
- `launchChain.usd1` was absent in 6/200, 6/200 and 12/200 otherwise-`200`
  harness reads (native tBNB available). A temporary diagnostic (not
  committed) attributed all 4 absences of a further 100-read run to the
  0077 same-block rule: the USD1 `readBalances` head was exactly one block
  ahead of the `readAllowances` head (e.g. `133395817` vs `133395816`); the
  3000 ms deadline and call failures never fired. BSC testnet produces
  blocks fast enough that two independent head reads often straddle a
  block. The client then shows "allowance not read" although nothing
  failed. Pinning the allowance multicall to the balance block (on the
  point-read lane) needs an rpc-client interface change and is left for a
  ruling; it is the remaining cause of that message.

## Main-agent rulings (2026-09-27)

1. **Same-block rule miss (usd1 absent ~3% of reads):** fix by pinning the allowance read to the balance head block on the point-read lane; tracked as S86b (rpc-client interface change), not folded into this fix.
2. Both primary reads failing stays 503 for now; the `snapshot` contract change is not worth it while a second mainnet endpoint is pending.
3. Ops: a second mainnet endpoint (NodeReal paid tier) is on the user's list; until then the extra read carries the tail.
4. Probe-unreachable triggering the extra read: kept.

## S86b: allowance read pinned to the balance block (ruling 1)

- **Interface.** `BscChainCallClient.readAllowances(owner, items, options?)`
  takes `options.atBlock?: bigint` (`BscAllowanceReadOptions`). Without it
  nothing changes (head from `latest` on the aggregate lane). With it:
  - the allowance multicall names `atBlock` (`eth_call` block parameter),
    never `latest`;
  - the returned `head.blockNumber` is `atBlock`, and `head.blockHash` comes
    from `eth_getBlockByNumber(atBlock)` on the same endpoint list. The
    header read runs concurrently with the multicall (no added round trip)
    and doubles as proof that the endpoint still serves that block. We read
    the hash rather than copy the balance read's hash so that the result
    carries only facts that this read observed; the wallet service compares
    block numbers, as before;
  - both reads use the interactive point-read lane (`pointReadAggregate`,
    same endpoints and order, short budget, no whole-chain retry), which is
    the lane the balance read used. This makes a same-endpoint answer the
    usual case;
  - if the header read fails or returns no block, the read fails closed as
    `BscReadUnavailableError("BSC_PINNED_BLOCK_UNAVAILABLE")` with the
    `summarizeRpcError` summary. A refused `eth_call` at that block becomes
    the per-item `BSC_ALLOWANCE_CALL_FAILED` (`rawValue: null`) through
    `allowFailure`. In neither case is a value from another block returned.
  - `asChainCallClient` and the unavailable client keep rejecting; the
    optional parameter only widens the signature.
- **Wallet service.** `readLaunchChainUsd1` (serving both
  `launchChain.usd1` and the shared-slot `launchUsd1`) now reads the USD1
  balance first and then calls `readAllowances(..., { atBlock:
balances.head.blockNumber })`. A single `withDeadline` (3000 ms) still
  bounds both reads. The Decision 0077 block-equality check stays as a
  guard. `BSC_PINNED_BLOCK_UNAVAILABLE` is a `BscReadUnavailableError`, so
  the pair is absent (not `null`, not `500`), as for every other failure.
- **Cost.** The two reads are now sequential rather than parallel. That adds
  one point-read round trip (the multicall and the header together) to this
  leg, which runs concurrently with the other balances legs. The same 3 s
  deadline applies.
- **Response shape.** Unchanged. The field is still absent when the
  endpoint has pruned or not yet caught up to the block, when a read fails,
  or when the deadline elapses.
- **Tests.** `test/bsc-rpc-client.test.ts` covers four cases: the pinned
  `eth_call` and header name `atBlock`, with no `latest`; the head equals
  that of a preceding balance read, while an unpinned read would have
  straddled; a refused or missing header gives `BSC_PINNED_BLOCK_UNAVAILABLE`;
  and a refused pinned `eth_call` gives a failed item. `test/v2-chain-wallet-routes.test.ts`
  covers three cases: `launchChain.usd1` and `launchUsd1` pass the balance
  block as `atBlock` and are present even with a fake whose unpinned head
  would be one block ahead; and a refused pinned block gives `200` with the
  pair absent.
