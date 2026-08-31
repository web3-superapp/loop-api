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

Runtime activation and verification evidence are independent too. The
Hyperliquid private-read capability below is implemented but default-off;
credentialed Privy, nonempty Testnet account, physical-device, shared-egress,
and deployed-environment evidence remain unverified.

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
- Local Profile, Watchlist, alert, and notification-preference replacements use
  an explicit resource version. A stale different state conflicts; an identical
  already-applied retry returns the committed resource instead of overwriting it.
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

## Personalization and inactive alert routes

LOOP PostgreSQL is the system of record for the authenticated owner's local
presentation and preference records. Alias, visibility, group, and asset keys
are untrusted presentation references: none are authentication, wallet, market,
social-graph, or trading authority.

| Method and path                    | Key contract                                                                                                       | Interface     | Capability                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------- |
| `GET /v1/profile`                  | Owner-only alias and opaque avatar reference; non-writing version-0 default                                        | `implemented` | `implemented`                                                             |
| `PUT /v1/profile`                  | Full replacement with `expected_version` and identical-retry success                                               | `implemented` | `implemented`                                                             |
| `GET /v1/profile/privacy`          | Fail-closed discoverability/copy-visibility preference; non-writing version-0 default                              | `implemented` | `implemented`; the value is not copy-trading authorization                |
| `PUT /v1/profile/privacy`          | Full replacement with `expected_version`; no social relationship is created                                        | `implemented` | `implemented`                                                             |
| `GET /v1/watchlist`                | Owner-only grouped ordered asset-reference snapshot                                                                | `implemented` | `implemented`; asset keys are not market facts                            |
| `PUT /v1/watchlist`                | Atomic whole-snapshot replacement, at most 20 groups/100 items, optimistic version protection                      | `implemented` | `implemented`                                                             |
| `GET /v1/alerts`                   | Bounded list of non-deleted inactive definitions                                                                   | `implemented` | storage `implemented`; evaluation and delivery `explicitly-disabled`      |
| `POST /v1/alerts`                  | UUID `Idempotency-Key`; strict asset/condition/decimal/optional-expiry definition; replay after deletion conflicts | `implemented` | creates `inactive` only                                                   |
| `GET /v1/alerts/{alert_id}`        | Owner-bound inactive definition                                                                                    | `implemented` | storage `implemented`; no activation                                      |
| `PUT /v1/alerts/{alert_id}`        | Full replacement with `expected_version` and identical-retry success                                               | `implemented` | remains `inactive`                                                        |
| `DELETE /v1/alerts/{alert_id}`     | Version-protected soft delete; absent/deleted remains non-enumerating                                              | `implemented` | no scheduler or delivery side effect                                      |
| `GET /v1/alerts/history`           | Bounded newest-first list of persisted sanitized real trigger facts; no public writer or fixture fallback          | `implemented` | read interface `implemented`; trigger production `explicitly-disabled`    |
| `GET /v1/notification-preferences` | Fixed event preferences, disabled version-0 defaults, explicit delivery unavailable                                | `implemented` | preference storage `implemented`; Firebase delivery `explicitly-disabled` |
| `PUT /v1/notification-preferences` | Atomic full fixed-set replacement with `expected_version`; enabled records intent only                             | `implemented` | delivery remains `explicitly-disabled`                                    |

Alert definitions accept no owner, provider/source URL, market fact, Firebase
token, delivery target, or scheduler field. Every alert remains `inactive` and
reports evaluation/delivery unavailable. The history relation is append-only,
but no current public or worker path can create an event. Empty history is
therefore a truthful empty list, not demo data. Decision 0009 defines the exact
ownership and closed-capability boundary. A create-key replay after the target
was soft-deleted returns `idempotency_resource_deleted`; it never resurrects or
projects the deleted definition as current.

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

The shared quota table keeps each window for seven complete days after that
window ends. The standalone worker deletes only older rows in bounded,
skip-locked batches and returns counts rather than capability rows or subject
HMACs. This maintenance does not refund attempts or change active-window quota
semantics.

The reviewed Stream Source Code License Agreement has been explicitly accepted,
and the default runtime uses exact `@stream-io/node-sdk@0.7.63` local signing
when the complete key/secret pair and independent quota HMAC capability are
present. The signer passes only the server-derived user ID and exact
whole-second `iat`/`exp`; it adds no product, role, call, or custom claims.
These interfaces have not been exercised with a real phone-issued Privy token,
Flutter, or a physical device, do not authorize server Chat/Video mutations,
and do not claim connected Stream state. Capability therefore remains
`blocked-provider` pending credentialed Development App and device evidence.
The Development-only `pnpm identity-stream:smoke` command can close the backend
credential-chain portion without printing identities or tokens, but its
existence is not evidence until an operator supplies a current phone-issued
token and the run passes.

## Implemented alias discovery and group-persona interfaces

Decision 0024 approves the exact authenticated routes below. Their migrations,
runtime schemas, generated OpenAPI, behavior tests, and PostgreSQL integration
tests are implemented. Local implementation does not by itself close the
separate real-Stream and physical-device evidence gates.

| Method and path                           | Key contract                                                                                                                         | Interface     | Capability         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------ |
| `GET /v1/discovery/users`                 | `alias_prefix` plus optional 1-20 `limit`; discoverable non-null public aliases; items expose only public-profile ID/alias/avatar    | `implemented` | `implemented`      |
| `POST /v1/chat/groups/resolve`            | Resolve one existing fixed `messaging` Stream channel only after current-member verification; never create a channel or add a member | `implemented` | `blocked-provider` |
| `GET /v1/chat/groups/{group_id}/me/alias` | Current-member-only read of the caller's retained immutable alias                                                                    | `implemented` | `blocked-provider` |
| `PUT /v1/chat/groups/{group_id}/me/alias` | First durable reservation wins; same-value retry; normalized name unique in group; projection is `pending` or `confirmed`            | `implemented` | `blocked-provider` |
| `GET /v1/chat/groups/{group_id}/aliases`  | Current-member-only prefix search; Stream rechecks requester and returned candidates; items expose only alias ID/alias               | `implemented` | `blocked-provider` |

Both search routes require a `unicode17_nfkc_lower_ws_v1` normalized prefix of
at least two Unicode code points, default to and cap results at 20, perform
prefix matching only, and return neither a total nor a pagination cursor.
Public aliases may be
duplicated; the authenticated caller is omitted. Group results also omit the
requester, departed members, and `pending` projections. A public item contains
exactly `public_profile_id`, `alias`, and
nullable `avatar_ref`; a group item contains exactly `group_alias_id` and
`alias`. No response contains an internal/Privy/Stream user ID, wallet or
address, provider channel ID, another alias, memberships, or a cross-group
correlation field.

Each search atomically reserves independent public- or group-search
user-per-minute, canonical-IP-per-minute, and user-per-day buckets. Subjects use
the existing server-only quota HMAC secret under a separate versioned domain;
raw users and IPs are not stored. Missing quota capability fails closed, and no
total/cursor endpoint can be used to bypass the bounded query. Public capacities
are 30/60/300 for user-minute/IP-minute/user-day; group capacities are
60/120/600 for the same buckets.

LOOP PostgreSQL is canonical for group aliases. A group alias remains reserved
after its owner leaves and is restored on rejoin; it is omitted from search
while that owner is not a current member. Stream member custom data is only a
server-written presentation projection. Before this capability can leave
`blocked-provider`, a real Development channel and accounts must prove member
verification, projection, leave/rejoin, candidate filtering, and permission
behavior. Direct Stream user search and client mutation of server-reserved
member fields must be disabled and verified before launch. Stable Stream user
IDs mean these aliases provide UI pseudonyms, not strong unlinkability.

## Approved Hyperliquid native Spot Testnet contract

Decision 0014 approves the following exact owner-scoped contract for one
manually reviewed capped IOC Spot buy or sell. All twelve operations are now
registered in the main Fastify runtime and generated OpenAPI with unavailable
default services. Authentication and strict request validation are reachable;
the default runtime returns a sanitized 503 for every valid authenticated
operation before any domain mutation. This does not claim a provider, signer,
wallet, or execution integration.

| Method and path                                                    | Key contract                                                                                                         | Interface     | Capability                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------- |
| `GET /v1/spot/config`                                              | Fixed Testnet policy, opaque allowlisted markets, review policy, and explicit capability state                       | `implemented` | `blocked-provider`                          |
| `GET /v1/spot/markets/{market_id}/facts`                           | One bounded metadata/book fact set; no raw provider identifier                                                       | `implemented` | `blocked-provider`                          |
| `GET /v1/spot/balances`                                            | Current bound master-account Spot holdings                                                                           | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/intents`                                            | UUID `Idempotency-Key`; business intent only; durable executable quote plus immutable F11 review                     | `implemented` | `blocked-provider`; `blocked-product-legal` |
| `GET /v1/spot/intents/{intent_id}`                                 | Owner-scoped reviewed execution/reconciliation resource                                                              | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/intents/{intent_id}/submit`                         | No body; fresh authority and review validation; one durable provider write attempt at most                           | `implemented` | `blocked-provider`; `blocked-product-legal` |
| `GET /v1/spot/wallet-binding`                                      | Provider-neutral binding state and monotonic epoch; no address or wallet ID                                          | `implemented` | `blocked-provider`                          |
| `PUT /v1/spot/wallet-binding`                                      | Bind, exact refresh, or rotate using only `expected_binding_version`                                                 | `implemented` | `blocked-provider`                          |
| `DELETE /v1/spot/wallet-binding?expected_binding_version={epoch}`  | Compare-and-swap unbind while retaining the monotonic epoch                                                          | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/agent-authorizations`                               | No body/query/client key; issue one server-owned expiring Testnet `approveAgent` handoff                             | `implemented` | `blocked-provider`; `blocked-product-legal` |
| `GET /v1/spot/agent-authorizations/{authorization_id}`             | Owner-scoped sanitized authorization state                                                                           | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/agent-authorizations/{authorization_id}/signatures` | Exact `{signature}` body; verify current owner/digest/Agent/epoch/expiry, journal one relay, then authoritative read | `implemented` | `blocked-provider`; `blocked-product-legal` |

`POST /v1/spot/intents` is the quote/review resource; no separate
`/quotes` route is approved. General order/fill lists, resting orders,
cancel/modify, triggers, TP/SL, TWAP, batch, transfers, withdrawals, bridges,
builder fees, automation, Perp extension, and Mainnet are outside this
contract.

The client can never choose or submit network, account, wallet, Agent, token
index/ID, pair index, Exchange asset, nonce, CLOID, provider idempotency value,
wire action, or order signature. The one authorization-creation response may
contain the server-generated public typed-data fields Privy must sign; the
client cannot edit them, and the signature-submission body still contains only
the opaque signature. The server-generated `agentName` must canonically end in
` valid_until <unix-milliseconds>` matching the displayed persisted expiry,
because Hyperliquid binds Agent expiry through that signed name; its nonempty
base is at most 16 characters and the initial `spot_agent_v1` Testnet policy
caps validity at 24 hours from the database clock. Agent identities use
monotonic generations inside one wallet-binding epoch; an elapsed current
identity is retired before the next generation is allocated. Authorization
status records the historical provider-operation result and is not, by itself,
proof that an Agent remains current. The standalone worker enables this
database-only expiry/retirement maintenance by default; it uses no Privy,
signer, relay, Exchange, or provider-read capability for that path. The contract
and official signing fixtures live under
`contracts/hyperliquid-spot/`. An uncomposed issuance coordinator now performs
policy and wallet-authority checks before and after preflight/allocation. Exact
replay calls no allocator and is confirmed again in PostgreSQL after the second
authority observations. An expired signing handoff reuses its persisted
internal Agent identity, and PostgreSQL remains the only nonce allocator. One
non-renewable, at-most-eight-second admission window covers every pass; the
database re-arms lock/query waits against that absolute deadline before every
guarded SQL statement and commit, then rechecks that an issued or replayed
handoff is still prepared and unexpired. The outer signable envelope retains a
canonical decimal-string nonce, while the official EIP-712 message carries the
exact corresponding JSON safe integer.

The runtime still selects the unavailable service; signature recovery, relay,
and Agent reconciliation remain absent. A dormant repository-only submission
primitive now atomically binds fresh server-only wallet, market, policy, legal,
kill-switch, signer, and reconciliation evidence to exactly one transport
attempt and one persisted Agent nonce. It is not composed into a workflow or
provider-capable service; the registered submit route therefore returns 503,
and only a future first transaction winner may receive the internal execution
material. The PostgreSQL repository can now atomically project that exact
attempt to `unknown`/pending reconciliation for only two server-normalized
ambiguous-response reasons, or quarantine an elapsed attempt with the fixed
`submission_deadline_elapsed` reason. Both transitions update the generic and
Spot projections plus their append-only events in one transaction and preserve
the single nonce allocation. Generic deadline quarantine, reconciliation
leasing, completion, rescheduling, and operator holds all exclude both Spot
intent and Spot Agent authorization operations, so generic recovery cannot
leave either projection split. A dedicated
repository-only Spot intent lane atomically leases `unknown` intents into
`reconciling`, reclaims expired leases with a fresh fence, reschedules both
projections, parks both projections for an operator, and loads only sanitized
read authority. Its generic completion method always fails closed. A
Spot-specific repository finalizer now atomically resolves only a proven full
fill, exact IOC no-fill, or finite Spot rejection. It rechecks the persisted
CLOID, immutable action/review, both record versions, database-clock lease,
full size, exact quote/average-price arithmetic, reviewed IOC price bound,
fee-token identity, observation window, shared operation, Spot projection, and
both append-only histories. Fee display identity uses the same case-sensitive
grammar as the frozen Spot review rather than an uppercase-only database
subset. A negative fee/maker rebate, non-terminating
average-price quotient, partial/open/cancelled result, unknown or incompatible
status, unbounded evidence, or fee-token ambiguity is not automatically
finalized. A strict read-only Spot provider reader and runtime-validating atomic
handler are present. They use five bounded Testnet Info observations, lossless
OID/trade-ID parsing, exact decimal fill aggregation, and a second terminal
authority check before the finalizer. Production composition exposes the lane
only behind the independent default-false
`HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED` worker gate. It uses the Spot
repository as its lease/control plane and shares the process identity, abort
lifecycle, and provider-global quota with the generic worker without enabling
the retained Perp reader. The flag remains off until nonempty Testnet
conformance. Spot Agent
authorization submission recovery is a separate future lane and remains
safely stopped at `submitting` after its generic exclusion. A repository-backed,
uncomposed prepare coordinator now claims the permanent idempotency key before
dependency reads; replay and pending claims perform zero authority, review, or
CLOID work. A first claim resolves short-lived wallet/Agent authority, generates
a 16-byte server CLOID, strictly validates an executable review draft, resolves
authority again, and then invokes the atomic repository prepare method. It may
also return an existing owner-scoped public intent resource. It is not selected
by the main HTTP runtime: the registered routes still use unavailable services
and stop before any claim, submission journal, nonce, signer, or provider work.
The production Testnet authority resolver and pure-read current-Agent repository
path are implemented and tested but remain uncomposed. A real Testnet
metadata/book/fee reviewer and exact Hyperliquid precision formatter are now
implemented and tested but remain uncomposed as well. The reviewer binds BBO,
bounded executable depth, directed slippage-safe price quantization, the
10-quote-token minimum, an injected quote-notional/fee-rate policy, and a hard
dependency deadline into the existing strict draft verifier. It deliberately
does not read balances: funds availability is mutable account evidence for a
fresh submit preflight, not an immutable quote fact. Before runtime composition,
a default-deny product/legal decision must supply the exact policy values and
explicitly compose both adapters. An uncomposed read-only submit preflight now
resolves wallet/Agent authority before and after its reads, binds fresh metadata,
exact available funds, current account taker fees, and a positive aggregate
policy decision to the persisted review, and uses a hard internal deadline. Buy
checks quote availability against the reviewed maximum spend; sell checks base
availability against the reviewed size; a fee above the persisted cap requires
re-prepare. The atomic repository now
exact-matches the owner, Privy subject, wallet ID, address, binding epoch, and
Agent under locks; it rechecks the resolver lease with the database clock after
those waits and after deferred projection checks, and requires active Agent
validity to cover the complete review lifetime. The uncomposed v1 draft verifier
uses exact arithmetic, a 25 bps default/100 bps maximum slippage, a 15-second
review lifetime, 2-second reference freshness, and 15-second fee freshness. Its
quote-denominated `fee_estimate` is a conservative bound: it must cover exact
reviewed notional times `fee_rate` and is included in the displayed maximum
spend or minimum receive. The persisted `fee_rate` is the explicit product
ceiling after a fresh `userFees` observation proves the account rate is no
higher, and the estimate rounds upward to the quote-token atomic unit. Submit
preflight re-reads and rejects any later ceiling breach. Its 2-second private
balance/fee evidence is checked with the database clock before the journal and
after deferred constraints without claiming a balance reservation or
full-attempt lease. Buy maximum spend applies to
every IOC result. Sell minimum receive is the complete-fill amount, and a
partial fill must preserve its proportional net-quote-per-base floor during
authoritative finalization. The just-before-send evidence rule, actual fee-token
and rounding semantics, and bounded partial/full settlement checks remain
composition blockers; the reviewer and preflight do not implement them.
An additional uncomposed submission coordinator verifies the ordering and
fields across preflight -> atomic journal/nonce -> narrow signer -> strict
post-signature write-start guard -> single writer -> normalized unknown
handoff. Before writer invocation, signing failure, guard denial, or an expired
one-second permit is atomically recorded as a sanitized
`rejected/not_required` proven-not-sent result; this is not a provider
rejection. Once writer invocation begins, every resolution or rejection remains
unknown and no write is retried. A conservative
DB-clock budget and the persisted absolute attempt deadline stop writer
admission after a slow signer. The selected `@nktkas/hyperliquid@0.33.3`
low-level surface canonicalizes and signs only the journaled Testnet IOC; a
separate fixed-origin writer sends it at most once and discards bounded
lossless responses into the existing unknown/reconciliation path. Both pass
offline action-hash, EIP-712 digest, signature, and transport tests. They are
not main-app composed and do not prove a real Privy Agent signer, provider write, or
credentialed prepare/submit E2E. The strict Info reader is a real read adapter,
but the reviewer, preflight, and final guard still have only local
injected-evidence verification. Production terminal outcomes and provider
writes remain unavailable until Agent authorization, a real final guard,
policy, settlement-bound reconciliation, and credentialed Testnet gates pass.
Decision 0020 freezes further Hyperliquid product work after this verified
safety slice pending an explicit scope decision.

## Perp wallet-binding lifecycle

The current principal may explicitly bind only a unique eligible Privy embedded
Ethereum wallet, or refresh the exact wallet already stored for that principal.
The current slice supports the master account only; interactive selection among
multiple eligible wallets and subaccounts is not approved.

| Method and path                                                   | Key contract                                                                                         | Interface     | Capability    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| `GET /v1/perp/wallet-binding`                                     | Non-writing state/version read                                                                       | `implemented` | `implemented` |
| `PUT /v1/perp/wallet-binding`                                     | Bind, refresh, or rotate using only `expected_binding_version`                                       | `implemented` | `implemented` |
| `DELETE /v1/perp/wallet-binding?expected_binding_version={epoch}` | Unbind while retaining and incrementing the monotonic authority epoch; no body or idempotency header | `implemented` | `implemented` |

Responses contain only `state`, `binding_version`, fixed-or-null
`account_kind`, and `last_verified_at`. No route accepts or returns a wallet
address, wallet ID, Privy DID, owner ID, network, DEX, or client-selected
authority. Every explicit PUT re-reads Privy; every private read revalidates the
exact stored wallet into a 15-second server-only lease.

## Hyperliquid Testnet private routes

Private reads use the exact server-verified master wallet binding, never an
agent or client-supplied address. Without it they return
`wallet_binding_required` before quota or Hyperliquid work. All routes are Core
BTC/ETH/SOL and Testnet only.

| Method and path          | Key contract                                                                                                        | Interface     | Capability                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------- |
| `GET /v1/perp/config`    | Network, Core allowlist, sourced/fetched/expires provider constraints, and explicit read/mutation capability states | `implemented` | `implemented`; default-off, E2E unverified      |
| `GET /v1/perp/account`   | Strict private account projection; decimal strings                                                                  | `implemented` | `implemented`; default-off, E2E unverified      |
| `GET /v1/perp/positions` | Strict position projection; bounded limit/opaque cursor where paginated                                             | `implemented` | `implemented`; default-off, nonempty unverified |
| `GET /v1/perp/orders`    | Strict current open-limit-order projection; bounded limit/opaque cursor                                             | `implemented` | `implemented`; default-off, nonempty unverified |
| `GET /v1/perp/fills`     | Strict recent fills projection with bounded coverage; bounded limit/opaque cursor                                   | `implemented` | `implemented`; default-off, nonempty unverified |
| `GET /v1/perp/funding`   | Strict recent user-funding ledger with bounded coverage; bounded limit/opaque cursor                                | `implemented` | `implemented`; default-off, nonempty unverified |

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

The resolver never guesses among multiple wallets, and the zero address is not
an empty-account fallback. With no binding, the routes return
`wallet_binding_required`; with private reads disabled or any stale/malformed
provider fact, they return `perp_unavailable`. When explicitly enabled, a
lossless narrow adapter posts only allowlisted requests to the compiled Testnet
Info URL and reserves a PostgreSQL global weighted quota first. No signer-capable
Hyperliquid Node/TypeScript SDK, configurable provider URL, Exchange action,
WebSocket, Mainnet, or mutation path has been installed.

### Perp intent and reconciliation

| Method and path                            | Key contract                                                                                                                                                                                       | Interface     | Capability                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------- |
| `POST /v1/perp/intents`                    | UUID `Idempotency-Key`; exact union of `order`, `cancel`, `modify`, `batch_modify`, `update_leverage`, or `update_isolated_margin`; returns server intent ID, immutable review, expiry, `prepared` | `implemented` | `blocked-product-legal`                                     |
| `POST /v1/perp/intents/{intent_id}/submit` | Owner-bound path ID; no body; checks expiry and the action-specific default-deny gate; no signer or Exchange adapter is composed                                                                   | `implemented` | `blocked-product-legal`                                     |
| `GET /v1/perp/intents/{intent_id}`         | Owner-bound durable status/reconciliation projection                                                                                                                                               | `implemented` | limit-`order` readback default-off; nonempty E2E unverified |

Status is one of `prepared`, `submitting`, `accepted`, `partial`, `filled`,
`cancelled`, `rejected`, `unknown`, `reconciling`, or `expired`. A repeated
owner/key/digest returns the same intent; a changed digest or owner conflicts
before provider work. Client timeout never authorizes resubmission. There is no
submit executor or transport journal writer. A separately enabled worker can
only consume an already-unknown Core limit `order`, read strict cloid-bound
Testnet Info evidence, and atomically finalize its generic operation plus Perp
intent/items. It cannot create or replay that provider write.

The idempotency owner/digest reservation commits before reviewer work. The
generic operation journal, immutable review, generated cloids, sanitized events,
and item identity then finalize atomically in PostgreSQL. Unfinished claims are
bounded per owner and by a service-wide fuse, and persist their explicit
`perp_intent_request_v1` digest version. Ordinary review facts may be at most 60
seconds old; a market-order quote may be at most two seconds old. Wallet
authority is resolved again after review latency. The real wallet resolver is
composed when Privy is configured, but the reviewer remains unavailable, and
every production submit is denied with `perp_mutation_disabled` before a wallet
re-resolution, reviewer, signer, SDK, or provider write. Tests may inject review
fixtures, but no Hyperliquid mutation SDK or executor is installed. The
read-only domain finalizer accepts only exact Core limit-`order` evidence;
market orders, `modify`, `batch_modify`, `cancel`, `update_leverage`, and
`update_isolated_margin` are operator-held before provider reads. Nonempty
Testnet-account conformance and a deployed worker remain mandatory evidence
gates.

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

Push device registration, a notification inbox, alert activation/evaluation,
Support, general public-profile detail, following/followers/blocklist, wallet or
QR search, alias history, cross-group correlation, and interactive
multiple-wallet selection have no approved complete runtime contract. The exact
alias discovery and group-persona routes in Decision 0024 are the only approved
Search/social exception; they do not imply a relationship graph. Privy
OTP/wallet creation, Stream messages/calls/moderation, and provider `/info`,
`/exchange`, or `/ws` operations remain official SDK/provider surfaces rather
than client-callable LOOP routes.
