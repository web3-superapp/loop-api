# Decision 0004: Stream token interface with a license gate

- Status: Accepted
- Date: 2026-08-24

## Context

LOOP needs separate Native Flutter token loaders at `POST /v1/chat/token` and
`POST /v1/video/token`. Both authenticate a current Privy Bearer token, resolve
an existing opaque LOOP user, and derive the Stream user ID server-side. The
historical Stream contract used a browser cookie and CSRF proof; Decision 0003
supersedes that transport for the native client.

Official-source research found `@stream-io/node-sdk` `0.7.63` as the current
unified Node server SDK. It supports Node 18 and later and its
`generateUserToken` API accepts explicit `iat` and `exp` claims. Stream documents
that one user token can be used across products in the same Stream App, so Chat
and Video do not require different signing algorithms or credentials. The two
LOOP routes remain separate product and policy boundaries, but their names do
not create product-scoped Stream permissions.

The SDK is not published under MIT, BSD, or another ordinary open-source
license. Its tagged `LICENSE` is a Stream Source Code License Agreement that
requires, among other terms, an eligible current Stream customer and acceptance
of that agreement. LOOP has no recorded acceptance or procurement evidence yet.

Official evidence:

- <https://github.com/GetStream/stream-node/releases/tag/v0.7.63>
- <https://raw.githubusercontent.com/GetStream/stream-node/v0.7.63/package.json>
- <https://raw.githubusercontent.com/GetStream/stream-node/v0.7.63/src/StreamClient.ts>
- <https://getstream.io/docs/platform/authentication/>
- <https://raw.githubusercontent.com/GetStream/stream-node/v0.7.63/LICENSE>

## Decision

- Implement both exact HTTP interfaces, shared issuance policy, dependency
  injection port, unavailable adapter, persistent user/IP quota, OpenAPI, and
  tests without installing or reproducing the Stream SDK's JWT implementation.
- Keep runtime capability `blocked-provider`. The default adapter returns a
  sanitized 503 even if credentials are present. A real adapter may be added
  only after explicit license acceptance/procurement evidence and a separate
  dependency change.
- A future real adapter will pin the reviewed official package exactly, use one
  Development Stream App, and call `generateUserToken` with the server-derived
  user ID and explicit whole-second `iat`/`exp`, where `exp = iat + 3600`.
  Permanent tokens, deprecated token helpers, client-selected roles, claims,
  TTL, and user IDs remain forbidden.
- Success is exactly `{api_key, token, expires_at, user:{id}}`. Tokens are never
  cached, persisted, or logged. Chat and Video use separate capability names and
  quotas even though an official token has the same Stream-App product scope.
- Each attempt reserves both the opaque LOOP-user bucket and canonical client-IP
  bucket in one PostgreSQL transaction before calling the issuer. Bucket subjects
  are domain-separated HMAC-SHA256 values using a server-only quota key. The raw
  IP is not persisted. Quota reservation is not refunded after issuer failure.
- `STREAM_API_KEY` and `STREAM_API_SECRET` are an all-or-nothing configuration
  pair. `STREAM_TOKEN_QUOTA_HMAC_SECRET` is a separate minimum-32-character
  server secret. Partial provider configuration is a startup error; absent
  provider, license, or quota capability fails closed at request time.

## Consequences

The complete mobile-facing contract can be reviewed and integrated later
without falsely claiming Stream connectivity today. No custom JWT signer is
introduced. Enabling the real issuer still requires explicit license acceptance,
one Stream Development App API key/secret pair, server-secret storage, and
credentialed identity/expiry tests. Chat, Video, message, call, presence, media,
membership, and moderation state remain solely Stream-owned.

Before any sustained external deployment, the remaining operational gates are a
trusted pre-authentication IP throttle at Cloudflare or the HTTP ingress and a
retention/partition policy for expired issuance-quota windows. Post-authentication
issuance quota does not replace either control.
