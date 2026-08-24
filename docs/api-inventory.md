# LOOP API inventory

This file is the canonical inventory of LOOP-facing HTTP routes approved for the
native Flutter client. Route schemas in `src/routes/` remain the OpenAPI source
for implemented behavior. Provider REST/WebSocket paths, SDK methods, historical
prototype routes, and unassigned product ideas are not LOOP APIs.

The committed implemented contract is `openapi/loop-api.v1.json`, generated
from those route schemas by `pnpm openapi:generate` and checked for drift by
`pnpm openapi:check`.

## Status model

| Status                  | Meaning                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `implemented`           | Present in the current runtime and generated OpenAPI.                                                                                    |
| `approved-contract`     | Exact LOOP route approved; implementation is pending.                                                                                    |
| `blocked-provider`      | Provider execution or token issuance must fail closed until dependency, license, credential, and credentialed-evidence gates close.      |
| `blocked-product-legal` | Mutation must stop before signing/provider work until current product, regional, legal, sanctions, and eligibility evidence approves it. |
| `explicitly-disabled`   | Outside the approved phase; no route may be implemented.                                                                                 |

Interface and capability status are independent. For example, an implemented
route backed by an unavailable adapter remains `blocked-provider`; its existence
is not provider-integration evidence.

## Common native contract

- All `/v1` routes below require exactly one current Privy Bearer token, except
  that bootstrap may create the internal mapping while every other protected
  route requires it to exist. No native route accepts cookies, CSRF tokens, or a
  Privy refresh token as authentication.
- The server derives the opaque LOOP user, Stream subject, wallet/account owner,
  and provider authorization subject. Client-selected identity, wallet/account
  or agent addresses, nonces, signatures, provider URLs, and provider
  idempotency values are rejected unless a route explicitly lists a signature
  as the result of an approved private signing handoff.
- Unknown fields are rejected. Money, price, size, balance, fee, funding,
  leverage, margin, and PnL values are canonical decimal strings, never JSON
  numbers.
- Protected responses are `Cache-Control: no-store`. Errors use stable LOOP
  codes and never expose raw provider or database messages.
- Total request deadline: 15 seconds. Provider read attempt: 5 seconds, with at
  most one pre-response transport/5xx retry inside the total deadline. Provider
  write attempt: 10 seconds, with no generic retry; ambiguous outcomes become
  durable `unknown`/`reconciling` state.

## Implemented routes

| Method and path      | Request                    | Success projection            | Interface     | Capability                                                                                     |
| -------------------- | -------------------------- | ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health/live`   | No input                   | `{status, service, version}`  | `implemented` | `implemented`                                                                                  |
| `GET /health/ready`  | No input                   | `{status, checks:{database}}` | `implemented` | `implemented`                                                                                  |
| `POST /v1/bootstrap` | Bearer only; no body/query | `{user:{id}, stream_user_id}` | `implemented` | `blocked-provider`; server verifier exists, but phone-issued-token evidence remains unverified |

`GET /openapi.json` is a conditional Development documentation endpoint when
`API_DOCS_ENABLED=true`; it is not a mobile business route.

## Stream token routes

| Method and path        | Request                              | Success projection                        | Interface           | Capability         |
| ---------------------- | ------------------------------------ | ----------------------------------------- | ------------------- | ------------------ |
| `POST /v1/chat/token`  | Bearer only; no body/query/client ID | `{api_key, token, expires_at, user:{id}}` | `approved-contract` | `blocked-provider` |
| `POST /v1/video/token` | Bearer only; no body/query/client ID | `{api_key, token, expires_at, user:{id}}` | `approved-contract` | `blocked-provider` |

Both tokens bind the same server-derived Stream subject, expire after 3600
seconds, are never cached or persisted, and are persistently rate-limited per
internal user and IP. Quota exhaustion is `429`; missing or partial provider
configuration fails closed. These routes do not authorize server Chat/Video
mutations or claim connected Stream state.

## Hyperliquid Testnet private routes

Private reads use a unique eligible server-verified master/subaccount wallet
binding, never an agent or client-supplied address. Without it they return
`wallet_binding_required` before Hyperliquid work. All routes are Core
BTC/ETH/SOL and Testnet only.

| Method and path          | Key contract                                                                                                        | Interface           | Capability         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------ |
| `GET /v1/perp/config`    | Network, Core allowlist, sourced/fetched/expires provider constraints, and explicit read/mutation capability states | `approved-contract` | `blocked-provider` |
| `GET /v1/perp/account`   | Strict private account projection; decimal strings                                                                  | `approved-contract` | `blocked-provider` |
| `GET /v1/perp/positions` | Strict position projection; bounded limit/opaque cursor where paginated                                             | `approved-contract` | `blocked-provider` |
| `GET /v1/perp/orders`    | Strict open/order-state projection; bounded limit/opaque cursor                                                     | `approved-contract` | `blocked-provider` |
| `GET /v1/perp/fills`     | Strict fills projection; bounded limit/opaque cursor                                                                | `approved-contract` | `blocked-provider` |
| `GET /v1/perp/funding`   | Strict funding projection; bounded limit/opaque cursor                                                              | `approved-contract` | `blocked-provider` |

Stale, malformed, non-Core, nonempty-dex, spot, HIP-3, or unknown provider data
is unavailable rather than coerced to an empty or zero-valued success. Public
market data remains a direct read-only Flutter/provider concern and is not
proxied by these routes.

### Perp intent and reconciliation

| Method and path                            | Key contract                                                                                                                                                                                       | Interface           | Capability              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------- |
| `POST /v1/perp/intents`                    | UUID `Idempotency-Key`; exact union of `order`, `cancel`, `modify`, `batch_modify`, `update_leverage`, or `update_isolated_margin`; returns server intent ID, immutable review, expiry, `prepared` | `approved-contract` | `blocked-product-legal` |
| `POST /v1/perp/intents/{intent_id}/submit` | Owner-bound path ID; no body; revalidate binding, freshness, eligibility, expiry, and review digest before one write attempt                                                                       | `approved-contract` | `blocked-product-legal` |
| `GET /v1/perp/intents/{intent_id}`         | Owner-bound status/reconciliation projection                                                                                                                                                       | `approved-contract` | `blocked-provider`      |

Status is one of `prepared`, `submitting`, `accepted`, `partial`, `filled`,
`cancelled`, `rejected`, `unknown`, `reconciling`, or `expired`. A repeated
owner/key/digest returns the same intent; a changed digest or owner conflicts
before provider work. Client timeout never authorizes resubmission. Provider
timeout, disconnect, or post-send 429/5xx is reconciled through authoritative
reads and is never blindly replayed.

### Testnet agent authorization

| Method and path                                                    | Key contract                                                                                                   | Interface           | Capability              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------- |
| `POST /v1/perp/agent-authorizations`                               | Issue a new server-owned authorization UUID and canonical Testnet `approveAgent` review                        | `approved-contract` | `blocked-product-legal` |
| `POST /v1/perp/agent-authorizations/{authorization_id}/signatures` | Submit the signature for the exact stored digest and current expected wallet; persist before one relay attempt | `approved-contract` | `blocked-product-legal` |
| `GET /v1/perp/agent-authorizations/{authorization_id}`             | Owner-bound status/reconciliation projection                                                                   | `approved-contract` | `blocked-provider`      |

The server derives account, network, agent, typed-data primary type, digest, and
expiry. Arbitrary typed data or URLs, altered fields, Mainnet, transfers,
withdrawals, and builder approval are rejected. Missing credentialed workflow or
signature-recovery evidence blocks issuance of signable payloads. Ambiguous relay
is `unknown` and is not replayed.

## Privy same-chain transfer routes

All six routes are `approved-contract` with `blocked-provider` capability. They
use Native Privy Bearer authentication and an internal principal while retaining
the reviewed variants and bindings in
`contracts/privy-transfer/bff-contract.json`.

| Method and path                         | Exact request variants                                                                                                                                   | Exact success keys                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/transfer/assets`               | No body/query                                                                                                                                            | `asset_selections`                                                                                                                                                 |
| `POST /v1/transfer/recipient-preflight` | resolve: `command`, `asset_selection_id`, `recipient_input`; acknowledge: `command`, `preflight_handle`, `acknowledgement_kind`                          | resolve: `kind`, `preflight_handle`, `recipient_display`, `requires_acknowledgements`; acknowledge: `kind`, `preflight_handle`, `acknowledgements_recorded`        |
| `POST /v1/transfer/reviews`             | `preflight_handle`, `amount_decimal`                                                                                                                     | `prepared_review_handle`                                                                                                                                           |
| `POST /v1/transfer/authorize`           | issue: `command`, `prepared_review_handle`; submit: `command`, `prepared_review_handle`, `authorization_signature`, `official_formatter_envelope_sha256` | issue: `kind`, `prepared_review_handle`, `official_formatter_envelope_bytes_base64`, `official_formatter_envelope_sha256`; submit: `kind`, `result_binding_handle` |
| `GET /v1/transfer/current-result`       | No body/query/handle/cursor                                                                                                                              | `{kind,result}` or unavailable `{kind}`                                                                                                                            |
| `GET /v1/transfer/reconciliation`       | No body/query                                                                                                                                            | `{kind,state}` or unavailable `{kind}`                                                                                                                             |

Owner, wallet/provider IDs, wallet epoch, provider URL/action/submission IDs,
nonce, expiry, idempotency key, risk verdict, cursor, and provider payload are
server-owned and forbidden in page requests. Material change invalidates prior
acknowledgement, review, and signature state. Provider write state is durable
before transport. Only this domain permits the reviewed single byte-identical
replay before the original signed expiry; a second uncertainty remains unknown.
Unknown Privy statuses are quarantined and projected unavailable.

## Excluded and unassigned surfaces

The following are `explicitly-disabled`: Pay and payment processing, on-ramp or
off-ramp, settlement and payment webhooks, Hyperliquid Mainnet, deposits,
withdrawals, automated trading or trading automation, HIP-3, trigger orders,
TP/SL, TWAP, builder fees, and public Hyperliquid market proxying.

Push device registration, Profile/Privacy, Watchlist/Alerts, Search, Support, and
multiple-wallet selection have no approved ownership and exact path decision.
They are unassigned, not implied APIs; no guessed route may be added. Privy
OTP/wallet creation, Stream messages/calls/moderation, and provider `/info`,
`/exchange`, or `/ws` operations remain official SDK/provider surfaces rather
than LOOP routes.
