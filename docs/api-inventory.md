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

## Implemented Stream token routes

| Method and path        | Request                                              | Success projection                        | Interface     | Capability         |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------- | ------------- | ------------------ |
| `POST /v1/chat/token`  | Bearer + existing bootstrap; no body/query/client ID | `{api_key, token, expires_at, user:{id}}` | `implemented` | `blocked-provider` |
| `POST /v1/video/token` | Bearer + existing bootstrap; no body/query/client ID | `{api_key, token, expires_at, user:{id}}` | `implemented` | `blocked-provider` |

Both tokens bind the same server-derived Stream subject, expire after 3600
seconds, and are never cached or persisted. Chat and Video have separate
capability quotas; each attempt atomically reserves both an internal-user bucket
and a canonical-IP bucket using domain-separated HMAC-SHA256 subjects, so raw
LOOP user IDs and IP addresses are not persisted in quota subjects. Quota
exhaustion is `429` without an issuer call. A missing quota HMAC capability or
unavailable real issuer returns `503`; a partial Stream API key/secret pair is a
startup error.

The default issuer remains unavailable even when a complete key/secret pair is
present. `@stream-io/node-sdk` is not installed and real credentials are not
enabled until its reviewed Stream Source Code License Agreement is explicitly
accepted and the Development App gate closes. These interfaces have not been
exercised with Flutter or a physical device, do not authorize server Chat/Video
mutations, and do not claim connected Stream state.

## Hyperliquid Testnet private routes

Private reads use a unique eligible server-verified master/subaccount wallet
binding, never an agent or client-supplied address. Without it they return
`wallet_binding_required` before Hyperliquid work. All routes are Core
BTC/ETH/SOL and Testnet only.

| Method and path          | Key contract                                                                                                        | Interface     | Capability         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------ |
| `GET /v1/perp/config`    | Network, Core allowlist, sourced/fetched/expires provider constraints, and explicit read/mutation capability states | `implemented` | `blocked-provider` |
| `GET /v1/perp/account`   | Strict private account projection; decimal strings                                                                  | `implemented` | `blocked-provider` |
| `GET /v1/perp/positions` | Strict position projection; bounded limit/opaque cursor where paginated                                             | `implemented` | `blocked-provider` |
| `GET /v1/perp/orders`    | Strict current open-limit-order projection; bounded limit/opaque cursor                                             | `implemented` | `blocked-provider` |
| `GET /v1/perp/fills`     | Strict recent fills projection with bounded coverage; bounded limit/opaque cursor                                   | `implemented` | `blocked-provider` |
| `GET /v1/perp/funding`   | Strict recent user-funding ledger with bounded coverage; bounded limit/opaque cursor                                | `implemented` | `blocked-provider` |

Stale, malformed, non-Core, nonempty-dex, spot, HIP-3, or unknown provider data
is unavailable rather than coerced to an empty or zero-valued success. Public
market data remains a direct read-only Flutter/provider concern and is not
proxied by these routes.

Config facts expire within 60 seconds and private snapshots within two seconds.
Positions accept an initial limit of 1–3; the other lists accept 1–50, default 20. A continuation cursor cannot be combined with a limit and is valid for ten
minutes. AES-256-GCM hides the provider continuation, including any authority a
malformed adapter might place inside it; an outer HMAC explicitly binds Testnet,
Core perps, empty DEX, owner, current wallet, binding version, route, and
original limit. Fills and user funding report `recent_window` coverage and
whether the provider-bounded window is truncated; they are never described as
complete history.

The default resolver never selects a first Privy wallet, and the zero address is
not an empty-account fallback. Until a reviewed server-side wallet binding and
real provider adapter exist, the routes return `wallet_binding_required` or
`perp_unavailable` before network work. No Hyperliquid Node/TypeScript package
has been installed.

### Perp intent and reconciliation

| Method and path                            | Key contract                                                                                                                                                                                       | Interface     | Capability              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- |
| `POST /v1/perp/intents`                    | UUID `Idempotency-Key`; exact union of `order`, `cancel`, `modify`, `batch_modify`, `update_leverage`, or `update_isolated_margin`; returns server intent ID, immutable review, expiry, `prepared` | `implemented` | `blocked-product-legal` |
| `POST /v1/perp/intents/{intent_id}/submit` | Owner-bound path ID; no body; checks expiry and the action-specific default-deny gate; no signer or Exchange adapter is composed                                                                   | `implemented` | `blocked-product-legal` |
| `GET /v1/perp/intents/{intent_id}`         | Owner-bound durable status/reconciliation projection                                                                                                                                               | `implemented` | `blocked-provider`      |

Status is one of `prepared`, `submitting`, `accepted`, `partial`, `filled`,
`cancelled`, `rejected`, `unknown`, `reconciling`, or `expired`. A repeated
owner/key/digest returns the same intent; a changed digest or owner conflicts
before provider work. Client timeout never authorizes resubmission. The later
provider lifecycle states are reserved by the resource contract, but no submit
executor, transport journal writer, or Perp domain reconciliation finalizer is
composed in this phase.

The idempotency owner/digest reservation commits before reviewer work. The
generic operation journal, immutable review, generated cloids, sanitized events,
and item identity then finalize atomically in PostgreSQL. Unfinished claims are
bounded per owner and by a service-wide fuse, and persist their explicit
`perp_intent_request_v1` digest version. Ordinary review facts may be at most 60
seconds old; a market-order quote may be at most two seconds old. Wallet
authority is resolved again after review latency. The default wallet resolver
and reviewer remain unavailable, and every production submit is denied with
`perp_mutation_disabled` before a wallet re-resolution, reviewer, signer, SDK,
or provider call. Tests may inject review fixtures, but no Hyperliquid mutation
SDK, executor, or domain lifecycle finalizer is installed. Provider timeout and
authoritative readback behavior remain a mandatory future gate, not a currently
implemented claim.

### Testnet agent authorization

| Method and path                                                    | Key contract                                                                                                                     | Interface     | Capability              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- |
| `POST /v1/perp/agent-authorizations`                               | No body/query/client key; default 403 before allocation, persistence, formatting, signing, or provider work; deliberately no 2xx | `implemented` | `blocked-product-legal` |
| `POST /v1/perp/agent-authorizations/{authorization_id}/signatures` | Strict owner-bound opaque signature input; prepared state stops at the default-deny gate before recovery or relay                | `implemented` | `blocked-product-legal` |
| `GET /v1/perp/agent-authorizations/{authorization_id}`             | Owner-bound sanitized durable status projection                                                                                  | `implemented` | `blocked-provider`      |

The future audited workflow must derive account, network, Agent, typed-data
primary type, digest, and expiry server-side. Arbitrary typed data or URLs,
altered fields, Mainnet, transfers, withdrawals, and builder approval are
rejected. Missing formatter, nonce-continuation, signature-recovery, credential,
and Testnet evidence blocks issuance of signable payloads. The current service
has no path to its durable `persistIssued` boundary and implements no relay or
reconciliation transition; `unknown` is a reserved future lifecycle state, not
evidence that an ambiguous relay has occurred.

## Privy same-chain transfer routes

All six routes are `implemented` with `blocked-provider` capability. They use
Native Privy Bearer authentication and an existing internal principal while
retaining only the exact reviewed top-level variants from
`contracts/privy-transfer/bff-contract.json`. Current OpenAPI contains no
transfer 2xx schema: every otherwise valid authenticated request returns 503
`transfer_unavailable` with no durable or provider side effect.

| Method and path                         | Current request boundary                                                                                                                                 | Current result                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `GET /v1/transfer/assets`               | No body/query/client idempotency header                                                                                                                  | 503; no asset-selection projection |
| `POST /v1/transfer/recipient-preflight` | resolve: `command`, `asset_selection_id`, `recipient_input`; acknowledge: `command`, `preflight_handle`, exact acknowledgement enum                      | 503; no preflight session          |
| `POST /v1/transfer/reviews`             | `preflight_handle`, positive canonical string `amount_decimal`                                                                                           | 503; no prepared review            |
| `POST /v1/transfer/authorize`           | issue: `command`, `prepared_review_handle`; submit: `command`, `prepared_review_handle`, nonempty opaque signature, lowercase formatter-envelope SHA-256 | 503; no formatter payload or relay |
| `GET /v1/transfer/current-result`       | No body/query/handle/cursor/client idempotency header                                                                                                    | 503; no current-result projection  |
| `GET /v1/transfer/reconciliation`       | No body/query/handle/cursor/client idempotency header                                                                                                    | 503; no reconciliation projection  |

Owner, wallet/provider IDs, wallet epoch, provider URL/action/submission IDs,
nonce, expiry, idempotency key, risk verdict, cursor, and provider payload remain
server-owned future facts. Unknown top-level fields, client `Idempotency-Key` or
provider signed headers, and JSON numbers for `amount_decimal` are rejected
before authentication. Unresolved nested JSON recursively rejects the exact
names in the reviewed `forbidden_client_keys` list; it does not claim to infer
unreviewed aliases. Handle and nested projection shapes remain deliberately
unresolved rather than guessed.

The reviewed material-change, durable write-before-transport, single
byte-identical replay, unknown-status quarantine, and fenced reconciliation
rules remain future implementation gates. The current runtime creates no
transfer session, idempotency record, submission, audit event, replay material,
result, or reconciliation lease and performs no formatter, signer, resolver,
screening, polling, or provider call.

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
