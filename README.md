# LOOP API

Private Backend-for-Frontend repository for the LOOP Flutter app.

## Current status

The runtime foundation and currently approved backend-only HTTP interfaces are
implemented as independently verified slices:

- Node.js 24 LTS, TypeScript, Fastify, and generated OpenAPI 3.1
- fail-closed environment validation and redacted structured logs
- process liveness and PostgreSQL-backed readiness endpoints
- PostgreSQL 17 local development through Docker Compose
- an initial opaque internal-user migration
- Privy Bearer access-token verification through the official server SDK
- a reusable Native Privy Bearer principal boundary for protected routes
- idempotent `POST /v1/bootstrap` mapping to an opaque internal UUID and a
  server-derived Stream user ID
- owner-bound Profile/privacy reads and replacements with non-writing defaults,
  optimistic versions, bounded display fields, and fail-closed privacy defaults
- atomic grouped Watchlist reads and replacements with server-derived order,
  snapshot versions, and bounded owner-local asset references
- inactive price-alert definition CRUD, notification-preference persistence,
  and read-only real alert history with UUID create idempotency and canonical
  decimal strings; evaluation and delivery remain unavailable
- separate `POST /v1/chat/token` and `POST /v1/video/token` interfaces that
  require an existing bootstrap mapping, derive the Stream user ID server-side,
  and enforce a fixed 3600-second lifetime
- six authenticated Hyperliquid Testnet private-read interfaces for strict
  config, account, position, open-order, fill, and user-funding projections;
  wallet/account authority is always resolved server-side
- an explicit `GET`/`PUT`/`DELETE /v1/perp/wallet-binding` lifecycle backed by
  PostgreSQL, monotonic binding epochs, and fresh exact Privy wallet matching;
  wallet IDs, addresses, and Privy DIDs never enter the mobile contract
- a default-off, lossless fixed-Testnet Hyperliquid Info reader with strict
  Core BTC/ETH/SOL projections and a PostgreSQL-backed global weighted quota
- encrypted, owner/wallet/version/route-bound cursors and fail-closed validation
  for stale, numeric-decimal, non-Core, Spot, HIP-3, and malformed provider data
- strict Perp intent preparation, owner-only status, and submit interfaces with
  canonical decimal-string DTOs, UUID idempotency, immutable reviews,
  server-generated cloids, PostgreSQL lifecycle records, and a default-deny
  per-action mutation gate
- the exact twelve authenticated Hyperliquid Spot Testnet route operations are
  registered in the main Fastify runtime and generated OpenAPI; their default
  services return a sanitized 503 before any claim, nonce, signer, or provider
  work
- an uncomposed fake-only Spot submission coordinator verifies coordinator
  ordering, one journal/nonce winner, the exact fields passed to fake
  signer/writer ports, DB-deadline admission, and durable
  unknown/reconciliation handoff without an SDK or network implementation
- an uncomposed read-only Spot submission preflight resolves current
  wallet/Agent authority before and after its reads, binds fresh metadata,
  available balance, account taker fee, and a positive aggregate policy
  decision to the persisted review, and passes only sanitized evidence to the
  atomic repository. Buy requires quote availability at least equal to the
  reviewed maximum spend; sell requires base availability at least equal to
  the reviewed size; the current taker rate cannot exceed the persisted cap
- an uncomposed Spot intent-preparation coordinator claims idempotency before
  dependency reads, performs zero reads on replay/pending, resolves the current
  wallet/Agent authority both before and after review, including the exact
  wallet ID, generates the server CLOID, strictly validates the executable
  review draft, and hands it to the atomic repository. The repository checks
  the resolver lease with the database clock after authority locks and again
  after deferred projection checks, and requires the active Agent to cover the
  review expiry; a real Testnet authority resolver and pure-read active-Agent
  reader are implemented and tested. A real Testnet metadata/book/fee reviewer
  and exact Hyperliquid price/lot formatter are also implemented and tested:
  they use BBO plus bounded depth, directed price quantization, a 10-quote-token
  minimum, an explicit injected quote/fee policy, and an internal deadline.
  Both adapters remain uncomposed
- three owner-bound Testnet Agent-authorization interfaces with a strict opaque
  signature input, non-reusable Agent identities, immutable digest bindings,
  and no reachable signable-payload or relay success while provider evidence is
  absent
- an uncomposed Spot Agent-authorization issuance coordinator that checks
  product and wallet authority twice, performs allocation only after repository
  preflight, reuses a reserved identity after signing-handoff expiry, and lets
  PostgreSQL bind the nonce to independently checked typed data. The public
  envelope keeps its nonce as a decimal string while the official EIP-712
  message uses the exact JSON safe integer. One absolute eight-second admission
  deadline covers every pass; PostgreSQL re-arms statement and lock waits from
  that absolute deadline before every guarded SQL statement and commit, and
  rechecks the signing handoff before returning it. Replay is confirmed again
  after the second authority check
- immutable, monotonic Spot Agent generations plus bounded database-only
  expiry/retirement maintenance, so a 24-hour Agent can be replaced without
  rotating the user's wallet-binding epoch
- six authenticated Privy same-chain transfer route boundaries with strict
  top-level variants, positive decimal-string amounts, server-owned authority,
  and no 2xx/provider/replay path while nested DTO and credential gates remain
  unresolved
- atomic HMAC-subjected user/IP issuance quotas for each Stream token route;
  raw LOOP user IDs and client IPs are not stored as quota subjects
- a durable provider-operation control plane with scope-wide idempotency,
  one-attempt write journals, versioned append-only audit events, atomic
  multi-subject issuance quotas, and stale-submission quarantine
- a standalone reconciliation worker process whose provider boundary supports
  authoritative reads only, with fenced leases, bounded retries, operator hold,
  abort-safe shutdown, and an independently buildable image; it also runs
  default-on database-only Spot Agent expiry/retirement maintenance. A
  default-off fixed-Testnet limit-order reader can atomically finalize generic
  and Perp state. A separately gated Spot IOC reader uses its dedicated
  projection-safe lane; every unsupported or ambiguous action remains
  operator-held
- a committed, deterministic OpenAPI artifact with a drift check
- unit, contract, worker, and PostgreSQL integration gates; a high-confidence
  tracked-secret guard; linting; type checking; production compilation; and
  separate migration/API-runtime/worker image builds

This is still **not a complete live provider integration**. The Privy server
verification boundary is implemented and can be enabled with local credentials,
but a real phone-issued token has not yet passed the physical-device gate. The
Stream HTTP interfaces and issuance policy are present, but the default issuer
returns a sanitized 503: the reviewed Stream SDK license has not been accepted,
the SDK is not installed, and a real Development App key/secret pair is not
enabled. The Hyperliquid wallet-binding lifecycle, resolver, and Testnet private
reader are implemented, but private reads are default-off and have not passed a
real Privy phone-token plus nonempty Testnet-account end-to-end gate. The Perp
reviewer, signer/executor, Agent authorization handoff, and every trading
mutation remain unavailable or denied before provider writes. The Spot prepare
and submit coordinators are ports plus fake-only behavior tests. The Agent
issuance coordinator is likewise implemented and behavior-tested but remains
uncomposed; its real Privy allocator, typed-data hasher, signature recovery,
relay, and dedicated reconciliation path are absent. A real Testnet
Spot authority resolver and pure-read current-Agent repository path are
implemented and tested, but remain uncomposed. The real Testnet
metadata/book/fee reviewer and exact precision formatter are implemented and
tested against injected strict-reader evidence, but no product policy values
select them in the main runtime and no credentialed intent preparation has run.
The product/legal gate, signer, and writer are absent, and neither coordinator
is selected by the main runtime. The read-only submit preflight is implemented
and tested against injected strict-reader evidence but remains uncomposed. Its
2-second balance and fee evidence is checked with the database clock before the
journal and again after deferred constraints; this is admission evidence, not a
funds reservation, and it does not cover the full 10-second transport attempt.
The immutable quote review does not imply funds availability.
The atomic prepare repository now performs its database-clock resolver-lease
and complete Agent-lifetime checks, including a final check after deferred
constraint waits. Runtime composition still requires a default-deny
product/legal decision with explicit quote-notional and fee-rate caps, plus
explicit safe composition of the implemented reviewer and resolver. Transfer
routes publish only
their reviewed negative contract and return a sanitized 503 after
authentication; there is still no trading execution path, Privy transfer
execution, Firebase push path, physical-device integration, or production
deployment. Interfaces, control-plane records, and quota primitives do not by
themselves prove a live provider integration. Profile/Watchlist and inactive
alert records are local PostgreSQL capabilities, but there is no price evaluator
or scheduler, Firebase device-token/delivery path, notification inbox, or social
graph.

The standalone worker makes bounded lifecycle updates in PostgreSQL, but its
provider boundary remains read-only. Its retained Perp limit-order and dedicated
Spot IOC reconciliation capabilities are independently default-off and have not
passed a nonempty Testnet-account conformance or deployment gate. It has no
signer, executor, replay path, transfer finalizer, or provider-mutation
capability; market orders, modify, batch-modify, cancel, leverage, and
isolated-margin reconciliation remain operator-held.

Current product decisions are summarized in
[`docs/product-decisions.md`](docs/product-decisions.md). The runtime decision is
recorded in
[`docs/decisions/0001-node-fastify-foundation.md`](docs/decisions/0001-node-fastify-foundation.md)
and
[`docs/decisions/0002-privy-bearer-bootstrap.md`](docs/decisions/0002-privy-bearer-bootstrap.md).
The canonical route surface and shared control-plane rules are in
[`docs/api-inventory.md`](docs/api-inventory.md) and
[`docs/decisions/0003-native-api-control-plane.md`](docs/decisions/0003-native-api-control-plane.md).
The Stream interface and SDK license gate are recorded in
[`docs/decisions/0004-stream-token-interface-license-gate.md`](docs/decisions/0004-stream-token-interface-license-gate.md).
The Hyperliquid private-read boundary is recorded in
[`docs/decisions/0005-hyperliquid-private-read-interface.md`](docs/decisions/0005-hyperliquid-private-read-interface.md).
The Perp intent, idempotency, review, persistence, and default-deny boundary is
recorded in
[`docs/decisions/0006-perp-intent-interface.md`](docs/decisions/0006-perp-intent-interface.md).
The Testnet Agent-authorization negative interface and durable binding are
recorded in
[`docs/decisions/0007-agent-authorization-interface.md`](docs/decisions/0007-agent-authorization-interface.md).
The Privy same-chain transfer default-closed interface is recorded in
[`docs/decisions/0008-transfer-interface-default-closed.md`](docs/decisions/0008-transfer-interface-default-closed.md).
The local Profile, Watchlist, inactive alert, and notification-preference
ownership boundary is recorded in
[`docs/decisions/0009-personalization-alerts-api.md`](docs/decisions/0009-personalization-alerts-api.md).
The durable Privy wallet-binding lifecycle is recorded in
[`docs/decisions/0010-perp-wallet-binding-lifecycle.md`](docs/decisions/0010-perp-wallet-binding-lifecycle.md),
and the lossless fixed-Testnet private reader and weighted quota are recorded in
[`docs/decisions/0011-lossless-hyperliquid-private-reader.md`](docs/decisions/0011-lossless-hyperliquid-private-reader.md).
The separate, empty-reader reconciliation process boundary is recorded in
[`docs/decisions/0012-standalone-reconciliation-worker.md`](docs/decisions/0012-standalone-reconciliation-worker.md).
The default-off, limit-order-only Testnet authoritative reader and atomic Perp
finalizer are recorded in
[`docs/decisions/0013-testnet-perp-order-authoritative-reconciliation.md`](docs/decisions/0013-testnet-perp-order-authoritative-reconciliation.md).
The Spot-only Testnet contract, Mainnet isolation, and renewable Agent lifecycle
are recorded in Decisions
[`0014`](docs/decisions/0014-hyperliquid-testnet-spot-closed-loop.md),
[`0015`](docs/decisions/0015-mainnet-separate-release-gate.md), and
[`0016`](docs/decisions/0016-spot-agent-generation-lifecycle.md). Spot projection
isolation, fenced finalization, and the independently gated authoritative read
boundary are recorded in
[`0017`](docs/decisions/0017-spot-reconciliation-projection-isolation.md).
The uncomposed Spot Agent issuance coordinator, safe-integer typed-data nonce,
and retained default-closed signature/relay boundary are recorded in
[`0018`](docs/decisions/0018-spot-agent-authorization-issuance-boundary.md).

## Quick start

Requirements:

- Node.js `24.19.0`
- pnpm `10.28.0` through Corepack
- Docker Desktop with Docker Compose v2

```sh
corepack enable
cp .env.example .env.local
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm dev
```

In a separate terminal, the independently runnable control-plane worker can be
started with `pnpm worker:dev`. With its default configuration it makes no
provider request. It immediately runs bounded database-only maintenance, then
every 60 seconds expires elapsed Spot signing handoffs and retires elapsed Agent
generations. `SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED=false` temporarily
disables that maintenance. Any due unsupported provider domain or action is
parked for an operator instead of guessed or replayed. Explicitly setting
`HYPERLIQUID_RECONCILIATION_READS_ENABLED=true` plus the independent quota
secret enables only the retained fixed-Testnet Perp limit-order evidence path.
`HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED=true` independently enables the
strict Spot IOC evidence lane. Both share one provider-global quota; neither
setting enables submission or replay.

The safe default listens on `http://127.0.0.1:3000` only.

- `GET /health/live` proves that the HTTP process is alive.
- `GET /health/ready` proves that required PostgreSQL access is working.
- `POST /v1/bootstrap` verifies a current Privy Bearer token and returns the
  server-derived LOOP and Stream user IDs. It returns 503 when Privy is
  unconfigured; returning the Stream ID does not connect Stream or mint a token.
- `POST /v1/chat/token` and `POST /v1/video/token` require the same current
  Privy Bearer boundary plus an existing bootstrap mapping. The interfaces are
  implemented, but return 503 while the quota HMAC capability or real licensed
  Stream issuer is unavailable.
- `GET`/`PUT /v1/profile`, `/v1/profile/privacy`, and `/v1/watchlist` expose
  only the current owner's local presentation/preferences. PUT uses
  `expected_version`; stale different state conflicts and an identical retry
  succeeds.
- `/v1/alerts` exposes owner-bound inactive definition CRUD,
  `/v1/alerts/history` exposes persisted real events only, and
  `/v1/notification-preferences` stores the fixed preference set. These routes
  do not activate evaluation or imply Firebase delivery.
- `GET /v1/perp/wallet-binding` returns only lifecycle state and version.
  `PUT` binds, refreshes, or rotates to the only eligible current Privy
  embedded Ethereum wallet using `expected_binding_version`; `DELETE` unbinds
  through the same version check. No operation accepts or returns an address.
- `GET /v1/perp/config`, `/account`, `/positions`, `/orders`, `/fills`, and
  `/funding` require the same current identity plus a unique current
  server-verified wallet binding. No binding returns
  `wallet_binding_required`; a binding with the private-read switch off returns
  `perp_unavailable`; enabling the complete server-only configuration activates
  the fixed Hyperliquid Testnet Info reader. This is not Mainnet or trading.
- `POST /v1/perp/intents`, `GET /v1/perp/intents/{intent_id}`, and
  `POST /v1/perp/intents/{intent_id}/submit` expose the durable Testnet/Core
  contract. The default runtime cannot prepare without a verified binding and
  reviewer, and submit always returns `perp_mutation_disabled` before provider
  work.
- `POST /v1/perp/agent-authorizations`, its owner-only status route, and its
  signature-submission route expose the approved negative Testnet contract.
  The default issue route returns `perp_mutation_disabled`; no successful
  signable payload, signature recovery, relay, or reconciliation transition is
  composed.
- `/v1/spot/*` exposes the exact twelve-operation Testnet Spot contract after
  current Privy authentication and bootstrap. The main runtime deliberately
  composes unavailable services, so every valid authenticated operation returns
  a sanitized 503 and no Spot claim, wallet change, Agent handoff, nonce,
  signature, or Hyperliquid/Spot provider request occurs. Privy verification
  and the required internal-user lookup still run.
- `GET /v1/transfer/assets`, the three transfer POST boundaries, and the two
  owner-session status routes expose the reviewed top-level contract. All six
  require bootstrap and currently return `transfer_unavailable`; OpenAPI
  deliberately publishes no transfer success schema.
- `GET /openapi.json` exposes the generated development contract when
  `API_DOCS_ENABLED=true`.

Run all repository checks with:

```sh
pnpm secrets:check
pnpm test:contract
pnpm test:worker
pnpm test:integration
pnpm check
pnpm docker:build:migration
pnpm docker:build:runtime
pnpm docker:build:worker
```

`pnpm secrets:check` guards the current Git-tracked snapshot against forbidden
credential files and a small set of high-confidence token patterns. It does not
scan Git history, infer arbitrary opaque provider secrets, or read the ignored
local `.env.local`; that file remains the only local place for the current Privy
credentials. The three Docker commands build distinct migration, lean API
runtime, and worker targets and do not deploy any image.

Route schemas are the source of truth for
[`openapi/loop-api.v1.json`](openapi/loop-api.v1.json). Do not edit the artifact
by hand:

```sh
pnpm openapi:generate
pnpm openapi:check
```

See [`docs/local-development.md`](docs/local-development.md) for physical-phone
and Cloudflare development-domain setup. `api-dev.quant-dinger.cc` is reserved
for Development; it must never be pointed at a Mainnet or production-signing
runtime.

## Responsibilities

- Validate Privy access tokens and map them to opaque internal user IDs
- Issue short-lived Stream Chat and Stream Video user tokens for server-derived
  Stream user IDs
- Hold server-only provider credentials and map provider failures to stable LOOP
  errors
- Orchestrate approved Privy server operations without taking custody of user
  keys
- Mediate Hyperliquid Testnet private account and trading operations with Core
  allowlists, freshness, decimal precision, idempotency, risk checks, and
  unknown-result reconciliation
- Provide request correlation, rate limiting, audit events, observability,
  environment separation, and region/eligibility gates
- Preserve provider-sourced, time-stamped facts for risk presentation without
  inventing an AI Guard verdict or numeric risk score

The internal user ID is the account and communication identity. Wallets are
bindable, replaceable credentials attached to that identity; a wallet address
must never become the database primary key or Stream user ID.

The proposed persistent 200,000-member group is a provider-confirmation
**Go/No-Go**. A single Stream channel may be used only after Stream confirms the
exact member, persistence, concurrency, moderation, pagination, rate-limit,
commercial, and SLA requirements in writing. Until then, the implementation
baseline is partitioned groups/topic channels with an application-level directory
and aggregate discovery experience.

## Explicit non-goals

- No wallet keys, recovery phrases, Privy refresh tokens, or long-lived provider
  secrets in Flutter, fixtures, logs, or Git
- No Mainnet, withdrawals, automated trading, Pay, or payment backend in the
  current phase
- No custom matching engine, ledger, bridge, IM, RTC, or proprietary risk score
- No custom social graph, price-alert scheduler/evaluator, notification inbox,
  or Firebase delivery claim in the current runtime
- No custom Chat or media transport; communication uses the selected Stream
  products through thin adapters
- No AI Guard endorsement and no synthetic or numeric risk score
- No HIP-3 markets or Hyperliquid builder fees

## Related repositories

- Flutter app: <https://github.com/web3-superapp/loop-mobile>
- Frozen HTML prototype, product documents, research, and historical verifiers:
  <https://github.com/web3-superapp/loop-mobile/tree/main/reference/legacy-prototype>
- Original repository retained for migration traceability:
  <https://github.com/Doog-bot534/web3-superapp-prototype>

## Migrated material

- `contracts/hyperliquid-core-perp/` and `contracts/privy-transfer/` are reusable
  contract baselines, not proof of a live integration.
- `contracts/stream-chat/` and `contracts/stream-ui/` are communication contract
  baselines. Authentication details that conflict with the current physical
  Flutter client must be superseded by a numbered API/security decision before
  implementation.
- `contracts/app-integrations-p0/` and `contracts/integration-catalog/` are
  historical prototype research and inventory. They do not authorize Pay,
  AI Guard, or other deferred providers.
- `server/app-integrations-p0/adapter.mjs` is a historical prototype adapter, not
  the production LOOP API entry point.

Provider implementations start with sandbox/Testnet contracts and fail closed
when configuration or verification evidence is missing.
