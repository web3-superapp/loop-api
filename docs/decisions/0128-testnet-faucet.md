# Decision 0128: testnet faucet — one tap funds a new embedded wallet with tBNB and MockUSD1 (S156-api)

- Status: Accepted (S156-api), BSC Testnet only (`LAUNCH_CHAIN_ID=97`)
- Date: 2026-10-12
- Baseline: `integration/v2` = `66b04fa` (Decision 0127, migration 000072)
- Inputs: user ruling 2026-10-12 (testnet wallets start at zero and the requirer cannot fund
  them; a server-side "claim test funds" action, 0.02 tBNB + 500 MockUSD1 per wallet address per
  24 h); S156 task sheet (contract frozen for S156-mobile); loop-contracts
  `contracts/mocks/MockUSD1.sol` (18 decimals, public `mint(address,uint256)`); Decision 0105
  (operator key `MEME_OPERATOR_PRIVATE_KEY`, testnet only).
- Scope: `GET /v2/testnet/faucet`, `POST /v2/testnet/faucet`, capability `testnetFaucet` in
  `GET /v2/meta/capabilities`, migration `000073_testnet_faucet_grants`. No `/v1` change; BSC
  Mainnet signing stays closed (the faucet refuses boot off chain 97).

## 1. Entities and IDs

- **Grant** `testnet_faucet_grants(grant_id uuid PK)`: one row per accepted POST.
  `owner_user_id → loop_users`, `idempotency_record_id → idempotency_records` (unique, digest
  `testnet_faucet_grant_v1`, scope `testnet_faucet_grant`), `wallet_id` (the opaque
  `account_wallets.wallet_id` of the session user's embedded wallet), `address` (lower-case;
  the cooldown key, never a primary or foreign key), `chain_id` (`eip155:97`), the two raw
  amounts, `usd1_token_address` (the USD1 contract this grant actually called `mint` on; see §8 —
  rows before S156b recorded `LAUNCH_USD1_ADDRESS`), the operator address, `bnb_tx` / `usd1_tx` (0x-64-hex or null),
  `status`, `failure_reason_code`, `granted_at` (the instant the grant was reserved), `completed_at`.
- `grantId` is not published; the client addresses the resource by `walletId`.
- Index `(address, granted_at desc)` answers the cooldown and `lastGrant` reads.

## 2. State machine

```text
pending ──bnb confirmed, usd1 confirmed──▶ granted
pending ──bnb confirmed, usd1 failed/reverted/unconfirmed──▶ partial
pending ──bnb broadcast, receipt not seen in time──▶ unknown
pending ──bnb not sent / reverted──▶ failed
```

- `pending` is written (with the idempotency record) in one transaction before anything is
  signed. The transaction takes the owner row lock and a transaction advisory lock on the address,
  re-checks the cooldown and inserts the row, so two requests for one address cannot both pass.
- Cooldown: the latest row of the address whose status is not `failed`; it blocks until
  `granted_at + TESTNET_FAUCET_COOLDOWN_SECONDS`. `partial` and `unknown` block (funds did or may
  have moved). A `pending` row left behind by a crashed process blocks for its cooldown window
  until the worker's sweep closes it (§9: `unknown` keeps blocking, `failed` releases it). S169: a `failed` row the operator attempted (`TESTNET_FAUCET_TRANSFER_FAILED`)
  blocks the address for `TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS` (default 300), and 5 such rows
  of one owner in a UTC day block that owner until the next UTC midnight; the sweep's
  `TESTNET_FAUCET_PENDING_EXPIRED` rows never block (§9).
- Order: tBNB first, then `MockUSD1.mint(address, amount)`; each waits for its receipt
  (1 confirmation). Both are signed by the operator key in the API process. Grants are serialised
  in-process (one operator nonce stream); a request waiting more than 2.5 s for the lock is
  `TESTNET_FAUCET_BUSY` and records nothing.
- Each transaction is signed locally first, so its hash is known before broadcast. A broadcast
  error is resolved by `eth_getTransactionByHash`: seen → keep waiting; not seen → not sent.
- Receipt waits are bounded (4.5 s each; RPC calls time out at 4 s) so the whole command stays inside the 15 s handler and
  socket budget. A request that still hits the handler timeout keeps running in the process; its
  row is finalised and the client reads the outcome with `GET` (or the same Idempotency-Key).

## 3. Preflight (before the reservation, nothing written on failure)

1. Capability configured (§5) — else 503 with the reason.
2. Body `{ walletId }` exactly; the wallet must be the session user's, `active`, `kind=embedded`
   with a Privy wallet ID — else 403 `PERMISSION_DENIED` `TESTNET_FAUCET_WALLET_NOT_OWNED` (one code
   for "not yours", "archived" and "external", so ownership cannot be probed).
3. Replay lookup by Idempotency-Key (same owner + digest → the stored outcome; different digest
   → 409 `IDEMPOTENCY_CONFLICT`).
4. Cooldown pre-check → 429 `RATE_LIMITED` `TESTNET_FAUCET_COOLDOWN`, `{ nextAvailableAt }`.
5. S169, inside the grant lock: the global daily caps of the UTC day (§9) → 503
   `TESTNET_FAUCET_DAILY_LIMIT`.
6. Chain reads: `USD1.decimals()` (must answer; else `TESTNET_FAUCET_USD1_UNAVAILABLE`),
   `estimateGas(mint)` (a revert → `TESTNET_FAUCET_USD1_UNAVAILABLE`), S169 `estimateGas` of the
   tBNB transfer (§9), `eth_gasPrice`, the operator balance. Operator balance
   `< bnbAmount + gasPrice × (nativeGas + mintGas) × 2 + reserve` → 503 `CAPABILITY_UNAVAILABLE`
   `TESTNET_FAUCET_OPERATOR_LOW` (`nativeGas` = the estimate, 21 000 when it reverted; `reserve`
   is non-zero only in the shared-key case of §9). Any read failure →
   `TESTNET_FAUCET_CHAIN_READ_FAILED`.

## 4. Errors

| HTTP | code                             | reasonCode / detailsSafe                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | malformed `walletId`, extra body / query keys                                                                                                                                                                                                                                                                                                                                                                              |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 403  | `PERMISSION_DENIED`              | `TESTNET_FAUCET_WALLET_NOT_OWNED`                                                                                                                                                                                                                                                                                                                                                                                          |
| 409  | `IDEMPOTENCY_CONFLICT`           | same key, different body or owner                                                                                                                                                                                                                                                                                                                                                                                          |
| 409  | `RESOURCE_CONFLICT`              | `TESTNET_FAUCET_IN_FLIGHT` (same key while its grant is still pending)                                                                                                                                                                                                                                                                                                                                                     |
| 429  | `RATE_LIMITED`                   | `TESTNET_FAUCET_COOLDOWN`, `nextAvailableAt` (S169: also the failed-retry cooldown and the owner's 5 failures a day)                                                                                                                                                                                                                                                                                                       |
| 503  | `CAPABILITY_UNAVAILABLE`         | `TESTNET_FAUCET_PARTIAL`, `bnbTransactionHash`, `usd1TransactionHash` (key present only when that mint went out), `nextAvailableAt` (cooldown counts)                                                                                                                                                                                                                                                                      |
| 503  | `CAPABILITY_UNAVAILABLE`         | `TESTNET_FAUCET_SUBMISSION_UNKNOWN`, `bnbTransactionHash`, `nextAvailableAt` (tBNB broadcast, receipt not seen; cooldown counts)                                                                                                                                                                                                                                                                                           |
| 502  | `PROVIDER_UNREACHABLE`           | `TESTNET_FAUCET_TRANSFER_FAILED` (tBNB not sent, reverted, or its gas estimate reverted; nothing moved; S169: the failed-retry cooldown applies, then a new key retries)                                                                                                                                                                                                                                                   |
| 503  | `CAPABILITY_UNAVAILABLE`         | `TESTNET_FAUCET_DISABLED`, `TESTNET_FAUCET_WRONG_CHAIN`, `TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED`, `TESTNET_FAUCET_USD1_NOT_CONFIGURED`, `TESTNET_FAUCET_RPC_NOT_CONFIGURED`, `TESTNET_FAUCET_RUNTIME_UNAVAILABLE`, `TESTNET_FAUCET_OPERATOR_LOW`, `TESTNET_FAUCET_USD1_UNAVAILABLE`, `TESTNET_FAUCET_CHAIN_READ_FAILED`, `TESTNET_FAUCET_BUSY`, S169 `TESTNET_FAUCET_DAILY_LIMIT` (`nextAvailableAt` = next UTC midnight) |
| 503  | `REQUEST_TIMEOUT`                | handler budget exceeded (the grant may still complete; read `GET`)                                                                                                                                                                                                                                                                                                                                                         |

S156 alignment (coordinator, 2026-10-12): the client decodes only 502 / 503 for these outcomes, so
`TESTNET_FAUCET_PARTIAL` and `TESTNET_FAUCET_SUBMISSION_UNKNOWN` are 503 `CAPABILITY_UNAVAILABLE`
(the task sheet allowed 502 or 503), and a hash key is omitted rather than null when that leg did
not go out. Success bodies carry exactly the frozen keys.

A replay of the same Idempotency-Key answers the stored outcome: `granted` → the same 201 body;
`partial` / `unknown` / `failed` → the same error; `pending` → `TESTNET_FAUCET_IN_FLIGHT`.

## 5. Configuration and unavailable behaviour

| Variable                                 | Default                             | Rule                                                               |
| ---------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `TESTNET_FAUCET_ENABLED`                 | `false`                             | `true` with `LAUNCH_CHAIN_ID≠97` refuses boot                      |
| `TESTNET_FAUCET_BNB_AMOUNT`              | `0.02`                              | decimal, > 0, ≤ 1, ≤ 18 fraction digits                            |
| `TESTNET_FAUCET_USD1_AMOUNT`             | `500`                               | decimal, > 0, ≤ 1 000 000, ≤ 18 fraction digits                    |
| `TESTNET_FAUCET_COOLDOWN_SECONDS`        | `86400`                             | integer 60 … 2 592 000                                             |
| `TESTNET_FAUCET_OPERATOR_PRIVATE_KEY`    | blank → `MEME_OPERATOR_PRIVATE_KEY` | malformed refuses boot; never logged                               |
| `TESTNET_FAUCET_USD1_ADDRESS`            | blank → Hooks Factory `usd1()`      | malformed refuses boot (S156b, §8)                                 |
| `TESTNET_FAUCET_OPERATOR_RESERVE_BNB`    | `0.05`                              | decimal, > 0, ≤ 10; applied only in the shared-key case (S169, §9) |
| `TESTNET_FAUCET_DAILY_MAX_GRANTS`        | `200`                               | integer 1 … 100 000, per UTC day (S169)                            |
| `TESTNET_FAUCET_DAILY_MAX_BNB`           | `2`                                 | decimal, > 0, ≤ 1 000, per UTC day (S169)                          |
| `TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS` | `300`                               | integer 30 … 86 400 (S169)                                         |
| `TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS` | `900`                               | integer 120 … 86 400; API and worker (S169)                        |

USD1: see §8 (the MEME v2 USD1). The RPC list is `LAUNCH_BSC_RPC_URLS`. Not bound to `NODE_ENV`
(staging is `production` on BSC Testnet).

Capability `testnetFaucet` (evidence `notApplicable`), first matching reason wins:
`TESTNET_FAUCET_DISABLED` → `TESTNET_FAUCET_WRONG_CHAIN` (unreachable after a successful boot, kept
as defence in depth) → `TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED` → `TESTNET_FAUCET_USD1_NOT_CONFIGURED`
→ `TESTNET_FAUCET_RPC_NOT_CONFIGURED` → `TESTNET_FAUCET_RUNTIME_UNAVAILABLE` (no database). The
capability does not read the operator balance; `TESTNET_FAUCET_OPERATOR_LOW` appears only on POST.
Both routes are always registered (they are not a `V2_MODULES_ENABLED` module) and answer 503 with
the same reason while the capability is unavailable.

## 6. Audit and logging

Every finalised grant writes one structured `info` line `testnet_faucet.grant` with `grantId`,
`walletId`, `address`, `status`, `bnbTransactionHash`, `usd1TransactionHash`, `failureReasonCode`.
The key, signed payloads and RPC URLs never reach a log line or an error body.

## 7. Known limits

- One API process signs; two API replicas with the same operator key could race for a nonce. The
  faucet falls back to the MEME pause key, which the console uses rarely; a collision fails one
  side as `TESTNET_FAUCET_TRANSFER_FAILED` (nothing moved) or a partial grant.
- A broadcast that errors and is not visible to the node is treated as not sent; if it later lands
  the address got tBNB without a cooldown row (testnet funds only).
- Evidence: `test/v2-testnet-faucet-routes.test.ts` (route contract, all branches with a fake
  chain), `test/testnet-faucet-config.test.ts`, `test/testnet-faucet.integration.test.ts`
  (PostgreSQL reservation, cooldown, idempotency, concurrent reservation). No anvil run.

## 8. Amendment S156b (2026-10-12): the faucet mints the MEME v2 USD1

Finding on staging: the first real grant minted `LAUNCH_USD1_ADDRESS` (`0x17d554fd…ce2b`, the Launch
v1 IDO MockUSD1), while every MEME v2 / launch2 instance of Factory v3 trades in the S127 MockUSD1
`0x3a1236E68eCf3225640367c84b6F50A51D0B0195` (NFT 100 USD1, curve buys and sells). The granted USD1
could not buy an NFT in the app.

Decision: **the faucet grants the USD1 MEME v2 trades in.** Resolution, first match wins
(`TestnetFaucetConfig.usd1Source`):

1. `TESTNET_FAUCET_USD1_ADDRESS` (explicit override);
2. with launch2 configured (`HOOKS_LAUNCH_FACTORY_ADDRESS`), `LoopLaunchFactory.usd1()` read on the
   launch slot at grant time — the same anchor the Hooks executor checks and every instance's
   `CurveEngine.usd1()` copies; the first successful read is kept for the process (the Factory's
   `usd1` is immutable). Unreadable → 503 `TESTNET_FAUCET_CHAIN_READ_FAILED`; zero / malformed →
   503 `TESTNET_FAUCET_USD1_UNAVAILABLE`; nothing is written;
3. only without a Factory, `LAUNCH_USD1_ADDRESS`.

`TESTNET_FAUCET_USD1_NOT_CONFIGURED` now means none of the three is set. The capability, the GET and
POST bodies and every error shape are unchanged. `testnet_faucet_grants.usd1_token_address`
records the contract actually minted (column comment, migration 000074, comment only).
Evidence: `test/testnet-faucet-config.test.ts` (priority 1/2/3), `test/v2-testnet-faucet-routes.test.ts`
(mint `to` = the Factory's USD1, never `LAUNCH_USD1_ADDRESS`; explicit override; unreadable
Factory), `test/testnet-faucet-chain.test.ts` (`usd1()` read), `test/testnet-faucet.integration.test.ts`
(stored `usd1_token_address`, column comment).

## 9. Amendment S169 (2026-10-13): review fixes

Review of 2026-10-13, four findings. Capability `testnetFaucet`, the GET / POST bodies and every
existing error shape are unchanged; one reason code is new (`TESTNET_FAUCET_DAILY_LIMIT`), and
`TESTNET_FAUCET_TRANSFER_FAILED` now carries a short cooldown.

1. **Shared operator key keeps a pause reserve.** `TestnetFaucetConfig.operatorKeySource` records
   whether the key came from `TESTNET_FAUCET_OPERATOR_PRIVATE_KEY` (`faucet`) or the fallback
   `MEME_OPERATOR_PRIVATE_KEY` (`meme`). When the faucet is enabled with the `meme` key, the
   console is configured (`ADMIN_*`) and the MEME pause/unpause signer is composed in the same
   process, the API logs one boot `warn` `testnet_faucet.operator_shared_with_meme_pause`
   (`reserveBnb`, never the key) and the service adds `TESTNET_FAUCET_OPERATOR_RESERVE_BNB`
   (default 0.05) to the balance requirement of §3: below it, 503 `TESTNET_FAUCET_OPERATOR_LOW`,
   nothing written, so a pause transaction always has gas. With its own key, or without the
   pause signer, the reserve is 0.
2. **Global daily caps.** Inside the grant lock, before any chain read, the service sums the
   UTC day's rows with status `granted` / `partial` / `unknown` (`dailyTotals`): count ≥
   `TESTNET_FAUCET_DAILY_MAX_GRANTS` (default 200) or Σ `bnb_amount_raw` + this grant >
   `TESTNET_FAUCET_DAILY_MAX_BNB` (default 2 tBNB) → 503 `CAPABILITY_UNAVAILABLE`
   `TESTNET_FAUCET_DAILY_LIMIT` with `nextAvailableAt` = the next UTC midnight; nothing is
   written; one `warn` `testnet_faucet.daily_limit`. `pending` and `failed` rows do not count. The
   capability does not read the totals (it stays `available`); the client learns of it on POST.
3. **Failed retries are rate-limited; the tBNB gas is estimated.**
   - A `failed` row with `TESTNET_FAUCET_TRANSFER_FAILED` (the operator attempted) blocks its
     address for `TESTNET_FAUCET_FAILED_COOLDOWN_SECONDS` (default 300) from `granted_at`; an owner
     with 5 such rows since the UTC day start is blocked until the next UTC midnight (all their
     wallets). Both are 429 `RATE_LIMITED` `TESTNET_FAUCET_COOLDOWN` with `nextAvailableAt` (the
     latest of the applicable instants), applied in the pre-check, in the reservation transaction
     (owner lock + address lock) and in `GET` (`available` / `nextAvailableAt`).
   - The tBNB transfer is no longer signed with a fixed 21 000 gas: `eth_estimateGas` of the
     transfer runs in the preflight. Estimate 21 000 → 21 000; more (an EIP-7702-delegated or
     contract recipient) → estimate × 1.2. A revert is reserved and immediately recorded as
     `failed` / `TESTNET_FAUCET_TRANSFER_FAILED` **without signing or broadcasting** (it counts for
     the failed-retry rules); a transport error is 503 `TESTNET_FAUCET_CHAIN_READ_FAILED` with
     nothing written. The balance check uses the estimated gas (21 000 when the estimate
     reverted, so an operator too poor to estimate is `TESTNET_FAUCET_OPERATOR_LOW`, not a
     failed grant).
4. **Write failures after signing are logged and swept.**
   - A failed `recordTransactionHash` (`onSigned`) logs `error` `testnet_faucet.record_hash_failed`
     (`grantId`, `address`, `leg`, `transactionHash`, `errorClass`); the chain adapter then does not
     broadcast and the grant becomes `failed` (as before).
   - A failed `finalize` logs `error` `testnet_faucet.finalize_failed` (`grantId`, `walletId`,
     `address`, intended `status`, both hashes, `errorClass`); the response is 503
     `TESTNET_FAUCET_RUNTIME_UNAVAILABLE` and the row stays `pending`.
   - Worker lane `testnet_faucet_pending_sweep` (worker process, on with `TESTNET_FAUCET_ENABLED`;
     idle with a reason off chain 97 or without `LAUNCH_BSC_RPC_URLS`; every 60 s, 50 rows per
     pass, oldest first): rows still `pending` with `granted_at` older than
     `TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS` (default 900) are closed read-only —
     no `bnb_tx` → `failed`; `eth_getTransactionByHash(bnb_tx)` found → `unknown`
     (`TESTNET_FAUCET_SUBMISSION_UNKNOWN`, cooldown counts); not found → `failed`. Every sweep
     `failed` carries `TESTNET_FAUCET_PENDING_EXPIRED` (a stored code, never in a response body)
     and does not count toward any cooldown. A lookup that fails leaves the row for the next pass;
     the update is guarded by `status = 'pending'`, so a grant the API finished meanwhile is not
     overwritten. The worker never loads the operator key. Log lines (worker allowlist):
     `lane`, `testnetFaucetGrantId`, `testnetFaucetStatus`, `transactionHash`, `errorClass`.
5. §2 numbers aligned with the code: lock wait 2.5 s (was written 3 s), receipt wait 4.5 s (was
   written 5 s). The review's "stalled after 3 checks" is not part of this decision; it belongs to
   Decision 0129 §2 (launch2 MEME transfer coverage) and is not changed here.

No migration: the existing indexes `(address, granted_at desc)` and `(owner_user_id, …)` serve the
new reads; the daily totals scan the UTC day by `granted_at` (testnet volume, hundreds of rows a
day).

Evidence: `test/v2-testnet-faucet-routes.test.ts` (S169 block: gas estimate and headroom, reverted
estimate → failed without broadcast, 300 s failed cooldown, 5 failures a day, daily count and tBNB
caps incl. partial / unknown, reserve via the service and via app composition with the boot warn,
error logs for both write failures), `test/testnet-faucet-config.test.ts` (defaults, ranges, key
source, worker sweep config), `test/testnet-faucet-chain.test.ts` (native estimate, sweep lookup),
`test/testnet-faucet-sweep.test.ts` (sweep outcomes, lane backoff, worker log allowlist),
`test/worker-runtime.test.ts` (lane composition, idle off chain 97, off while disabled),
`test/testnet-faucet.integration.test.ts` (PostgreSQL: failed cooldown, owner daily failures
ignoring `PENDING_EXPIRED`, daily totals, sweep on real rows). No testnet run.
