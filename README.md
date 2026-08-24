# LOOP API

Private Backend-for-Frontend repository for the LOOP Flutter app.

## Current status

The runtime foundation and first protected identity slice are implemented:

- Node.js 24 LTS, TypeScript, Fastify, and generated OpenAPI 3.1
- fail-closed environment validation and redacted structured logs
- process liveness and PostgreSQL-backed readiness endpoints
- PostgreSQL 17 local development through Docker Compose
- an initial opaque internal-user migration
- Privy Bearer access-token verification through the official server SDK
- idempotent `POST /v1/bootstrap` mapping to an opaque internal UUID and a
  server-derived Stream user ID
- unit/contract tests, linting, type checking, and production compilation

This is still **not a complete live provider integration**. The Privy server
verification boundary is implemented and can be enabled with local credentials,
but a real phone-issued token has not yet passed the physical-device gate. There
is still no Stream token minting, Hyperliquid private account/trading path,
Firebase push path, rate limiter, or production deployment.

Current product decisions are summarized in
[`docs/product-decisions.md`](docs/product-decisions.md). The runtime decision is
recorded in
[`docs/decisions/0001-node-fastify-foundation.md`](docs/decisions/0001-node-fastify-foundation.md)
and
[`docs/decisions/0002-privy-bearer-bootstrap.md`](docs/decisions/0002-privy-bearer-bootstrap.md).

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
- `GET /openapi.json` exposes the generated development contract when
  `API_DOCS_ENABLED=true`.

Run all repository checks with:

```sh
pnpm check
pnpm test:integration
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
