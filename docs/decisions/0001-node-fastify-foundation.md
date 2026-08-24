# 0001 — Node, Fastify, OpenAPI, and PostgreSQL foundation

- Status: Accepted
- Date: 2026-08-24

## Context

`loop-api` already held provider contracts and a historical prototype adapter,
but it had no selected runtime, package manager, HTTP entry point, persistence,
tests, or deployable artifact. LOOP currently runs in Development against
Hyperliquid Testnet. The first integration target is a physical Flutter device,
and the Development API hostname is `api-dev.quant-dinger.cc`, whose DNS is
managed by Cloudflare.

The backend must eventually validate Privy access tokens, derive all internal and
Stream identities server-side, mint short-lived Stream credentials, and mediate
private Hyperliquid operations. It must never claim those providers are connected
before credentials and test evidence exist.

## Decision

- Runtime: Node.js `24.19.0` LTS.
- Package manager: pnpm `10.28.0` through Corepack, with an exact lockfile.
- Language: TypeScript `6.0.3`, ESM, strict compiler settings.
- HTTP framework: Fastify `5.12.1`.
- Contract: OpenAPI `3.1.0`, generated from the same JSON Schemas used by
  Fastify for route validation and serialization via `@fastify/swagger` `9.8.1`.
- Persistence: PostgreSQL `17.11`; local development uses the exact
  `postgres:17.11-alpine3.24` image.
- Database access and migrations: `pg` `8.23.0` and `node-pg-migrate` `9.0.0`.
- Verification: Vitest, ESLint, Prettier, TypeScript type checking, and a
  production compilation are required before a branch is pushed.

Configuration is validated before the listener starts. PostgreSQL is required,
so missing or malformed database configuration fails closed. Logs use generated
request IDs and redact authorization, cookie, CSRF, and response-cookie fields.
Readiness returns only `up` or `down`; it never returns connection strings or raw
driver errors.

The default listener remains `127.0.0.1`. A developer must explicitly choose
`HOST=0.0.0.0` for trusted-LAN device testing. Cloudflare Tunnel is the preferred
way to expose `api-dev.quant-dinger.cc`; tunnel authentication and DNS mutation
are separate operator actions and are not committed to this repository.

OpenAPI JSON is enabled by default only outside production and can be disabled
with `API_DOCS_ENABLED=false`. Production requires an HTTPS public base URL.

The initial `loop_users` table uses a random UUID primary key and a unique Privy
user identifier. It intentionally contains no wallet primary key, Stream secret,
provider token, refresh token, or trading key.

## Consequences

- Fastify handles routing, validation, timeouts, request correlation, structured
  logging, and response serialization; feature code can remain narrow.
- OpenAPI is executable contract output rather than a manually maintained second
  description of implemented routes.
- Provider SDKs, auth routes, private trading routes, queues, and deployment
  topology remain separate decisions and slices.
- The lean runtime image excludes migration tooling. Docker exposes a separate
  `migration` target for release jobs, and readiness remains unavailable until
  the current required migration and schema are present.
- The migrated Stream token contract's HttpOnly-cookie/CSRF target conflicts with
  the current native Flutter Privy Bearer-token boundary. No token endpoint may be
  implemented until a follow-up decision supersedes that authentication shape.
- Cloudflare protects transport and routing but does not replace application
  authentication, authorization, rate limiting, idempotency, or audit controls.
