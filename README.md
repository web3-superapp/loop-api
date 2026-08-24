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
- separate `POST /v1/chat/token` and `POST /v1/video/token` interfaces that
  require an existing bootstrap mapping, derive the Stream user ID server-side,
  and enforce a fixed 3600-second lifetime
- six authenticated Hyperliquid Testnet private-read interfaces for strict
  config, account, position, open-order, fill, and user-funding projections;
  wallet/account authority is always resolved server-side
- encrypted, owner/wallet/version/route-bound cursors and fail-closed validation
  for stale, numeric-decimal, non-Core, Spot, HIP-3, and malformed provider data
- strict Perp intent preparation, owner-only status, and submit interfaces with
  canonical decimal-string DTOs, UUID idempotency, immutable reviews,
  server-generated cloids, PostgreSQL lifecycle records, and a default-deny
  per-action mutation gate
- three owner-bound Testnet Agent-authorization interfaces with a strict opaque
  signature input, non-reusable Agent identities, immutable digest bindings,
  and no reachable signable-payload or relay success while provider evidence is
  absent
- six authenticated Privy same-chain transfer route boundaries with strict
  top-level variants, positive decimal-string amounts, server-owned authority,
  and no 2xx/provider/replay path while nested DTO and credential gates remain
  unresolved
- atomic HMAC-subjected user/IP issuance quotas for each Stream token route;
  raw LOOP user IDs and client IPs are not stored as quota subjects
- a durable provider-operation control plane with scope-wide idempotency,
  one-attempt write journals, versioned append-only audit events, atomic
  multi-subject issuance quotas, and stale-submission quarantine
- a generic reconciliation worker whose provider boundary supports
  authoritative reads only, with fenced leases, bounded retries, operator hold,
  and abort-safe shutdown
- a committed, deterministic OpenAPI artifact with a drift check
- unit/contract tests, linting, type checking, and production compilation

This is still **not a complete live provider integration**. The Privy server
verification boundary is implemented and can be enabled with local credentials,
but a real phone-issued token has not yet passed the physical-device gate. The
Stream HTTP interfaces and issuance policy are present, but the default issuer
returns a sanitized 503: the reviewed Stream SDK license has not been accepted,
the SDK is not installed, and a real Development App key/secret pair is not
enabled. The Hyperliquid private-read, Perp-intent, and Agent-authorization HTTP
contracts are present, but their default wallet resolver, reader, reviewer, and
authorization handoff remain unavailable. Every Perp submit and Agent issuance
is denied before signer/provider work. Transfer routes publish only their
reviewed negative contract and return a sanitized 503 after authentication;
there is still no live private account connection, trading execution path,
Privy transfer execution, Firebase push path, physical-device integration, or
production deployment. Interfaces, control-plane records, and quota primitives
do not by themselves enable any provider.

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
- `GET /v1/perp/config`, `/account`, `/positions`, `/orders`, `/fills`, and
  `/funding` require the same current identity plus a unique current
  server-verified wallet binding. The default runtime returns
  `wallet_binding_required`; fake success tests do not make Hyperliquid live.
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
- `GET /v1/transfer/assets`, the three transfer POST boundaries, and the two
  owner-session status routes expose the reviewed top-level contract. All six
  require bootstrap and currently return `transfer_unavailable`; OpenAPI
  deliberately publishes no transfer success schema.
- `GET /openapi.json` exposes the generated development contract when
  `API_DOCS_ENABLED=true`.

Run all repository checks with:

```sh
pnpm check
pnpm test:integration
```

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
