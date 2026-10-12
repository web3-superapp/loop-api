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
  `granted_at + TESTNET_FAUCET_COOLDOWN_SECONDS`. `failed` (nothing moved) never blocks; `partial`
  and `unknown` block (funds did or may have moved). A `pending` row left behind by a crashed
  process blocks only for its cooldown window.
- Order: tBNB first, then `MockUSD1.mint(address, amount)`; each waits for its receipt
  (1 confirmation). Both are signed by the operator key in the API process. Grants are serialised
  in-process (one operator nonce stream); a request waiting more than 3 s for the lock is
  `TESTNET_FAUCET_BUSY` and records nothing.
- Each transaction is signed locally first, so its hash is known before broadcast. A broadcast
  error is resolved by `eth_getTransactionByHash`: seen → keep waiting; not seen → not sent.
- Receipt waits are bounded (5 s each) so the whole command stays inside the 15 s handler and
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
5. Chain reads: `USD1.decimals()` (must answer; else `TESTNET_FAUCET_USD1_UNAVAILABLE`),
   `estimateGas(mint)` (a revert → `TESTNET_FAUCET_USD1_UNAVAILABLE`), `eth_gasPrice`, the operator
   balance. Operator balance `< bnbAmount + gasPrice × (21 000 + mintGas) × 2` → 503
   `CAPABILITY_UNAVAILABLE` `TESTNET_FAUCET_OPERATOR_LOW`. Any read failure →
   `TESTNET_FAUCET_CHAIN_READ_FAILED`.

## 4. Errors

| HTTP | code                             | reasonCode / detailsSafe                                                                                                                                                                                                                                                                                                                        |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | malformed `walletId`, extra body / query keys                                                                                                                                                                                                                                                                                                   |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                                                                                                                                                                                                                                               |
| 403  | `PERMISSION_DENIED`              | `TESTNET_FAUCET_WALLET_NOT_OWNED`                                                                                                                                                                                                                                                                                                               |
| 409  | `IDEMPOTENCY_CONFLICT`           | same key, different body or owner                                                                                                                                                                                                                                                                                                               |
| 409  | `RESOURCE_CONFLICT`              | `TESTNET_FAUCET_IN_FLIGHT` (same key while its grant is still pending)                                                                                                                                                                                                                                                                          |
| 429  | `RATE_LIMITED`                   | `TESTNET_FAUCET_COOLDOWN`, `nextAvailableAt`                                                                                                                                                                                                                                                                                                    |
| 503  | `CAPABILITY_UNAVAILABLE`         | `TESTNET_FAUCET_PARTIAL`, `bnbTransactionHash`, `usd1TransactionHash` (key present only when that mint went out), `nextAvailableAt` (cooldown counts)                                                                                                                                                                                           |
| 503  | `CAPABILITY_UNAVAILABLE`         | `TESTNET_FAUCET_SUBMISSION_UNKNOWN`, `bnbTransactionHash`, `nextAvailableAt` (tBNB broadcast, receipt not seen; cooldown counts)                                                                                                                                                                                                                |
| 502  | `PROVIDER_UNREACHABLE`           | `TESTNET_FAUCET_TRANSFER_FAILED` (tBNB not sent or reverted; no cooldown, use a new key to retry)                                                                                                                                                                                                                                               |
| 503  | `CAPABILITY_UNAVAILABLE`         | `TESTNET_FAUCET_DISABLED`, `TESTNET_FAUCET_WRONG_CHAIN`, `TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED`, `TESTNET_FAUCET_USD1_NOT_CONFIGURED`, `TESTNET_FAUCET_RPC_NOT_CONFIGURED`, `TESTNET_FAUCET_RUNTIME_UNAVAILABLE`, `TESTNET_FAUCET_OPERATOR_LOW`, `TESTNET_FAUCET_USD1_UNAVAILABLE`, `TESTNET_FAUCET_CHAIN_READ_FAILED`, `TESTNET_FAUCET_BUSY` |
| 503  | `REQUEST_TIMEOUT`                | handler budget exceeded (the grant may still complete; read `GET`)                                                                                                                                                                                                                                                                              |

S156 alignment (coordinator, 2026-10-12): the client decodes only 502 / 503 for these outcomes, so
`TESTNET_FAUCET_PARTIAL` and `TESTNET_FAUCET_SUBMISSION_UNKNOWN` are 503 `CAPABILITY_UNAVAILABLE`
(the task sheet allowed 502 or 503), and a hash key is omitted rather than null when that leg did
not go out. Success bodies carry exactly the frozen keys.

A replay of the same Idempotency-Key answers the stored outcome: `granted` → the same 201 body;
`partial` / `unknown` / `failed` → the same error; `pending` → `TESTNET_FAUCET_IN_FLIGHT`.

## 5. Configuration and unavailable behaviour

| Variable                              | Default                             | Rule                                            |
| ------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `TESTNET_FAUCET_ENABLED`              | `false`                             | `true` with `LAUNCH_CHAIN_ID≠97` refuses boot   |
| `TESTNET_FAUCET_BNB_AMOUNT`           | `0.02`                              | decimal, > 0, ≤ 1, ≤ 18 fraction digits         |
| `TESTNET_FAUCET_USD1_AMOUNT`          | `500`                               | decimal, > 0, ≤ 1 000 000, ≤ 18 fraction digits |
| `TESTNET_FAUCET_COOLDOWN_SECONDS`     | `86400`                             | integer 60 … 2 592 000                          |
| `TESTNET_FAUCET_OPERATOR_PRIVATE_KEY` | blank → `MEME_OPERATOR_PRIVATE_KEY` | malformed refuses boot; never logged            |
| `TESTNET_FAUCET_USD1_ADDRESS`         | blank → Hooks Factory `usd1()`      | malformed refuses boot (S156b, §8)              |

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
