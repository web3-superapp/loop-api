# Decision 0002: Privy Bearer identity bootstrap

- Status: Accepted
- Date: 2026-08-24

## Context

The Flutter application authenticates with Privy and can obtain a current
Privy access token. The historical browser-oriented contract used cookies and
CSRF protection, which does not match the native client. The backend already
has an opaque UUID primary key and a unique `privy_user_id`, but it has no
credentialed authentication boundary or user bootstrap route.

Provider tokens and secrets must never be accepted as identity without
verification, logged, stored as application sessions, or returned to the
client. Stream, wallet, and trading integrations are separate security
boundaries and are not authorized by this decision.

## Decision

- Add `POST /v1/bootstrap` for the native Flutter client.
- Accept exactly one bounded `Authorization: Bearer <access-token>` value and
  no query parameters or request body. Every request verifies the access token
  again.
- Pin the official `@privy-io/node` SDK at `0.29.0`, matching the accepted
  transfer-contract dependency lock, and use the non-deprecated
  `PrivyClient.utils().auth().verifyAccessToken` API.
- Configure the SDK with `PRIVY_APP_ID` and `PRIVY_APP_SECRET` outside Git.
  Both absent leaves the protected route unavailable while health remains
  operational; a partial pair is an invalid startup configuration.
- Trust only the verified `user_id` claim. Never accept an internal user ID,
  Privy user ID, Stream user ID, wallet owner, or refresh token from the
  request body.
- Map the verified provider user ID to the existing database-generated Loop
  UUID using the unique constraint and an idempotent PostgreSQL insert/select.
  Do not change migration `000001`.
- Derive the future Stream user ID from the opaque internal UUID as
  `loop_<lowercase-uuid-without-hyphens>`. This creates no Stream connection and
  mints no provider token; it only fixes the server-owned provider identity.
- Return HTTP 200 for both first and repeated bootstrap calls with only:
  `{"user":{"id":"<loop-uuid>"},"stream_user_id":"loop_<uuid>"}`.
- Send `Cache-Control: no-store` on every response. Authentication failures
  use stable sanitized errors and never write a user record; 401 responses
  include a Bearer challenge.
- Use one SDK client per Fastify process so the official verifier can reuse
  its JWKS cache. Application code does not cache access tokens.

## Error contract

| Status | Code                         | Meaning                                                 |
| ------ | ---------------------------- | ------------------------------------------------------- |
| 400    | `invalid_request`            | A request body or otherwise invalid input was supplied. |
| 401    | `authentication_required`    | The Authorization header is missing.                    |
| 401    | `invalid_access_token`       | The Bearer value or verified token is invalid.          |
| 503    | `authentication_unavailable` | Privy verification is not configured locally.           |
| 500    | `internal_error`             | Persistence or an internal invariant failed.            |

The SDK does not reliably distinguish every invalid token from every JWKS
transport failure. Those failures remain fail-closed and are reported as an
opaque 401; the API does not infer provider availability from error text.

## Consequences

The backend gains a stable provider-independent identity boundary and a
server-owned Stream subject suitable for future token minting. Access tokens
may remain valid until their configured expiry; this decision does not claim
instant revocation.
Credentialed physical-device verification remains incomplete until the mobile
backend adapter sends a real current access token.

This decision does not add Stream token minting, Firebase push, wallet
operations, Hyperliquid private trading, rate limiting, withdrawals, Mainnet,
or automated trading. Each requires its own verified vertical slice.
