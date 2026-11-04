# Decision 0198: Privy Swap execution switch (S357, option A)

- Status: Accepted (backend); mainnet device run pending (user, docs/62)
- Date: 2026-11-04
- Scope: S357-api. Amends Decision 0035 (Swap specifics, Capabilities,
  Go/No-Go). User ruling 2026-11-04 "选 A": wallet Swap is Privy's own
  embedded-wallet swap; no LOOP routing, no platform fee.

## Context

Decision 0035 built quote → immutable intent → one execute, but kept every
Swap intent `prepared` (no Provider-side simulation) and the `privySwap`
evidence permanently `pending`, so the execute path was unreachable. S356
established on staging that Privy's swap quote works on `eip155:56`
(Uniswap V2/V3/V4 routing), is unsupported on BSC Testnet 97, and needs no
authorization signature; execute does (`privy-authorization-signature`).

## Rulings

| Topic                                | Ruling                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulation                           | No simulated Provider is connected. The intent keeps the honest fact `simulation = {status: unavailable, source: provider_quote, reasonCode: SWAP_SIMULATION_PROVIDER_PENDING}`.                                                                                                                                                                           |
| Protection                           | Privy enforces `minimum_output_amount` from `slippage_bps` (user choice, ≤ 300 bps, `swapPolicyV1`); the quote and the intent expire after 30 s; per-swap ceiling `PRIVY_SWAP_MAX_USD`; the existing canary asset allowlist, `BSC_WRITE_CANARY_MAX_USD`, and the rolling daily ceiling stay in force; price impact ≥ 5 % blocks, 1–5 % needs confirmation. |
| Execution switch                     | `PRIVY_SWAP_EXECUTION_ENABLED` = `off` (default) \| `on`.                                                                                                                                                                                                                                                                                                  |
| Ceiling                              | `PRIVY_SWAP_MAX_USD` (default `200`, positive decimal, ≤ 6 fraction digits) on the quote's input valuation (`requireFresh` Provider price; no price → not admitted). Applied only with execution on.                                                                                                                                                       |
| Chain                                | Swap is `eip155:56` only (unchanged); 97 assets never reach the selector (S357-mobile).                                                                                                                                                                                                                                                                    |
| Quote authorization (0035 open item) | Closed: `wallets.swap.quote` needs no authorization signature (S356 on staging).                                                                                                                                                                                                                                                                           |

## Switch semantics

**off** — byte-identical to Decision 0035: prepare creates `prepared`
(`signing.allowed = false`, `SWAP_SIMULATION_PROVIDER_PENDING`); execute is
`409 SIMULATION_FAILED` for every swap intent, including any intent left
`awaiting_signature` after the switch was turned off (rollback); nothing is
sent; `PRIVY_SWAP_MAX_USD` is not applied; `privySwap.evidence` is
`{status: pending, reasonCode: PRIVY_BSC_SWAP_DEVICE_EVIDENCE_PENDING}`.

**on** — prepare creates `awaiting_signature` (`signing.allowed = true`);
`privySwap.evidence` is `{status: confirmed, reasonCode: null}`. The task
brief asked for `verified`; the capability contract's enum is
`notApplicable | pending | confirmed` and released clients switch over it
exhaustively, so the existing `confirmed` carries the meaning and no new
enum value is published. Execute order:

1. body shape (`authorizationSignature` 1–4096 chars; optional
   `reviewSha256` `^[0-9a-f]{64}$`) → `400 INVALID_REQUEST`;
2. write admission, Privy app ID → `503 CAPABILITY_UNAVAILABLE`;
3. intent exists / is a swap → `404` / `422`; switch off or `prepared` →
   `409 SIMULATION_FAILED`;
4. intent expiry **or** quote expiry → intent `expired`, `409 QUOTE_EXPIRED`;
5. state `awaiting_signature` else `SUBMISSION_UNKNOWN` / `DATA_STALE`;
   policy `configVersion` unchanged else `DATA_STALE`;
6. canary ceiling and `PRIVY_SWAP_MAX_USD` on the sealed `policy.valueUsd`
   → `403 POLICY_BLOCKED` / `CANARY_CEILING_EXCEEDED` (the swap ceiling
   reuses the reason code the client already renders; `ceilingUsd` names
   the ceiling that was hit);
7. `reviewSha256`, when sent, equals the intent's → else `409 DATA_STALE`;
8. the sealed `authorizationPayload` is consistent with the intent
   (`authorizationPayloadConsistent`) → else `409 DATA_STALE`;
9. signable wallet and the same Privy wallet → `DATA_STALE`;
10. fence (`submitted` + provider operation `submitting`), one
    `wallets.swap.execute`, outcome mapping unchanged from 0035
    (`PRIVY_SWAP_REJECTED` / `PRIVY_SWAP_NOT_SENT` → `failed`, ambiguous →
    `unknown`, never replayed).

No new error code or bare string was introduced.

## Authorization payload conformance

Checked against `@privy-io/node` 0.29.0 (`lib/authorization.ts`,
`resources/wallets/swap.ts`) and the Privy swap docs (S356 copy):

| Field         | Privy                                                                                                   | LOOP `SwapAuthorizationPayload`                                                                      | Result             |
| ------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| `version`     | `1`                                                                                                     | `1`                                                                                                  | match              |
| `method`      | `POST`                                                                                                  | `POST`                                                                                               | match              |
| `url`         | `${baseURL}/v1/wallets/${walletId}/swap`, no trailing slash; SDK baseURL default `https://api.privy.io` | `https://api.privy.io/v1/wallets/${providerWalletId}/swap`                                           | match (see risk 1) |
| `body`        | the JSON body actually sent = params minus the `privy-*` header fields                                  | the same frozen object the adapter spreads into `swap.execute` params                                | match              |
| `headers`     | only `privy-app-id`, `privy-idempotency-key` (if sent), `privy-request-expiry` (if sent)                | exactly these three; idempotency key = intent ID; expiry = intent `expiresAt` in Unix ms as a string | match              |
| serialisation | RFC 8785 `canonicalize`, P-256 ECDSA over SHA-256, base64 DER, multiple signatures comma-joined         | device-side (`generateAuthorizationSignature`); backend forwards verbatim                            | n/a                |

The raw `wallets().swap.execute` resource used by the adapter adds no
default `privy-request-expiry` (only the higher-level `swaps()` service
does), so the header Privy receives is the one that was signed. A
conformance unit test (`test/privy-swap-authorization-conformance.test.ts`)
signs the issued payload with the SDK's own `generateAuthorizationSignature`,
sends it through the real adapter into a recording SDK surface, rebuilds the
signature input from what was sent with `formatRequestForAuthorizationSignature`,
and verifies the signature. No field had to change.

Residual risks:

1. If `PRIVY_API_BASE_URL` is ever set for the SDK, the payload URL (fixed
   `https://api.privy.io`) would differ from the request URL. It is unset on
   every environment; do not set it without passing the same base to
   `createSwapService`.
2. `destination.caip2` is sent although Privy documents it as optional for
   same-chain swaps; quote accepted it (S356). Execute acceptance is part of
   the device run.
3. Whether the Flutter SDK's `generateAuthorizationSignature` canonicalises
   the same way is the mobile half (S357-mobile, decision 0282) and the
   device run.

## Reconciliation

`WALLET_INTENT_RECONCILE_ENABLED` already polls `wallets.actions.get`
(`include=steps`) for swap intents. Fixed here: the tracked hash is the
**last** hashed step (`swapActionTransactionHash`) — an ERC-20 source swap
can carry an `approve` step first, which the previous `find` picked. A hash
that changes while pending is stored again (`provider_action_pending`).

## Rollback

Set `PRIVY_SWAP_EXECUTION_ENABLED=off`: open swap intents can no longer be
executed (`SIMULATION_FAILED`), evidence returns to pending, submitted ones
keep reconciling. No migration; no schema change.

## Staging enable order (after the user's go-ahead only)

1. `BSC_RPC_URLS` (mainnet, supports `eth_getTransactionReceipt`),
   `BSC_WRITES_ENABLED=true`, `BSC_WRITE_CANARY_ASSETS` (e.g.
   `eip155:56:native,eip155:56:0x55d398326f99059ff775485246999027b3197955`),
   `BSC_WRITE_CANARY_MAX_USD=20`.
2. `WALLET_INTENT_RECONCILE_ENABLED=true` on the worker (already true on
   staging) with Privy credentials.
3. `PRIVY_SWAP_MAX_USD=20`, then `PRIVY_SWAP_EXECUTION_ENABLED=on`.
4. Device run 0.002 BNB → USDT; record in `docs/62-兑换真机验证-<date>.md`.
