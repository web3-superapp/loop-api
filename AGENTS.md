# LOOP API repository instructions

Repository phase: `foundation-active`.

Build the private Backend-for-Frontend for the LOOP Flutter app through narrow,
verified Development/Testnet vertical slices. Read `README.md`,
`docs/product-decisions.md`, the applicable numbered decisions, and relevant
provider contracts before planning or changing behavior.

## Hard boundaries

- Development and Hyperliquid Testnet are the only enabled environments.
- Mainnet, withdrawals, automated trading, Pay, and payment endpoints remain
  disabled until explicit numbered security/product decisions enable them.
- Never commit or log provider secrets, Privy refresh tokens, wallet keys,
  recovery phrases, Hyperliquid agent keys, Firebase service accounts, APNs
  private keys, Cloudflare tunnel credentials, access tokens, signed URLs, or
  complete authorization payloads.
- Validate the current Privy access token on each protected mobile boundary.
  Never accept a client-selected internal user ID, Stream user ID, wallet owner,
  or authorization subject.
- Use random opaque LOOP user IDs. Wallet addresses are replaceable credentials,
  never database primary keys or Stream identities.
- Mint Stream Chat and Video tokens only server-side. Stream remains the source of
  truth for messages, delivery/read state, presence, calls, participants, and
  media state; do not build a parallel Chat or RTC core.
- Keep Hyperliquid private reads, signing, nonce allocation, risk checks,
  idempotency, relay, and unknown-result reconciliation in this backend. Use
  decimal strings and exact-decimal libraries; never use JavaScript `number` for
  money, price, size, leverage, fee, or balance values.
- Every new call uses a new UUID. Unknown write results are reconciled and are not
  automatically replayed unless an exact provider contract explicitly proves a
  safe, idempotent retry.
- Missing credentials, stale facts, unknown eligibility, malformed provider
  responses, and unavailable dependencies fail closed.
- Historical files under `server/app-integrations-p0/` and historical catalog
  contracts are provenance only and must not be imported by `src/`.

## Ownership

- `src/app.ts` owns Fastify composition and cross-cutting HTTP behavior.
- `src/config.ts` owns fail-closed environment parsing.
- `src/routes/` owns versioned HTTP surfaces; route schemas are the OpenAPI source.
- `src/database/` owns PostgreSQL connectivity, not feature policy.
- Future `src/integrations/` adapters own narrow official-provider boundaries.
- Future `src/features/` modules own identity, communication bootstrap, account,
  trading, and reconciliation behavior.
- `migrations/` is append-only after merge; never edit an applied migration.
- `contracts/` contains review inputs and target contracts. Updating runtime code
  does not silently redefine them.
- `test/` holds behavior and contract tests. Add tests with behavior changes.

## Required commands

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

Run `pnpm db:migrate` and real readiness checks against PostgreSQL for database or
migration changes. Provider/device tests that lack credentials or a physical
device are unverified, never passing.

Direct dependency versions remain exact. Change Node, pnpm, Fastify, OpenAPI,
PostgreSQL, the database library, persistence strategy, security boundary, or
verification strategy only with official-source research and a numbered decision
under `docs/decisions/`.
