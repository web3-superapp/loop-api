# Decision 0021: Official Stream user-token issuer

- Status: Accepted
- Date: 2026-08-29

## Context

Decision 0004 established the Native Chat and Video token contracts, persistent
per-product quotas, and an unavailable issuer. It required explicit acceptance
of the reviewed Stream license before installing or using the official server
SDK.

On 2026-08-29, an authorized LOOP project representative explicitly confirmed
that they had read and accepted the Stream Node SDK v0.7.63 Source Code License
Agreement, were a current Stream customer and not a Stream competitor, had
authority to accept the agreement for the project, and permitted the private
LOOP backend to install and use that SDK. This closes the license-acceptance
gate recorded by Decision 0004.

The accepted `0.7.63` package remains available and supports Node 18 or later.
Although a newer release exists, this decision does not silently widen the
accepted version or dependency surface. The tagged source shows that
`generateUserToken` performs local HS256 signing and accepts explicit `user_id`,
`iat`, and `exp` claims. Stream's authentication documentation states that one
user token for a Stream App can be used across its products.

Official evidence:

- <https://github.com/GetStream/stream-node/blob/v0.7.63/package.json>
- <https://github.com/GetStream/stream-node/blob/v0.7.63/src/StreamClient.ts>
- <https://github.com/GetStream/stream-node/blob/v0.7.63/LICENSE>
- <https://getstream.io/docs/platform/authentication/>

Locked artifact evidence:

- npm SRI:
  `sha512-S2jN73/AlBFzX/HlC83z6oKsTqzuFpVZaE+3Q39AA71X7R0FFrPNSWqClXyh1HutC/EZJfksMLp1RtuqibZ8JA==`;
- installed `LICENSE` SHA-256:
  `2ae19400d4ddde4d4a54e6194f6a089184fe35d415abebb61020b9ba485672bc`;
- installed `src/StreamClient.ts` SHA-256:
  `e94327186537435fd784a41559042bb83afafd0e2e21c7249d284eb3c859799e`;
- installed `src/utils/create-token.ts` SHA-256:
  `796da8bbb91938d36edda21d6a5684815b792e318c43fd812f4c9d7da661380b`.

## Decision

- Add `@stream-io/node-sdk` as an exact `0.7.63` private-backend runtime
  dependency. A version change requires renewed official-source and license
  review; a floating range is forbidden.
- Construct one process-scoped `StreamClient` only when the complete
  `STREAM_API_KEY`/`STREAM_API_SECRET` pair and the independent persistent quota
  secret are present. Dependency injection remains higher priority for isolated
  tests. Missing either capability selects the unavailable issuer.
- Call only `generateUserToken` with a valid server-derived Stream user ID and
  explicit positive whole-second `iat` and `exp`, with `exp = iat + 3600`. Do
  not pass `validity_in_seconds`, product, role, `call_cids`, or custom claims.
  Do not use permanent, deprecated, or call-scoped token helpers.
- Chat and Video retain separate LOOP routes and persistent quota capabilities,
  but receive the same ordinary Stream-App user-token scope. Complete Stream
  credentials never bypass missing persistent quota; that configuration still
  fails closed with 503.
- Preserve request cancellation. A request aborted before quota reservation
  performs no quota or issuer work. A request aborted after a successful quota
  reservation is not refunded and must stop before returning credentials. The
  original abort reason is propagated so Fastify can classify handler timeout
  correctly.
- Never log, cache, persist, or return the API secret. Never log, cache, or
  persist issued tokens. The response remains exactly
  `{api_key, token, expires_at, user:{id}}` with `Cache-Control: no-store`.
- Keep the SDK, dependency caches, and runtime images private and access
  controlled under the accepted Stream Source Code License Agreement.
- Treat the recorded acceptance as specific to the Node SDK v0.7.63. It does
  not close any separate Flutter SDK, commercial-plan, large-group, or
  credentialed product-acceptance gate.

## Consequences

The backend now has an official, locally signing default Stream issuer when
both the provider credential pair and the independent persistent-quota secret
are configured. Missing either capability remains fail-closed. Offline tests
verify the HS256 signature independently, exact claims, fixed lifetime, equal
Chat/Video scope, configuration matrix, and cancellation behavior.

This change is not credentialed provider or mobile evidence. Local signing does
not prove that the API key and secret belong to the same Development App or that
Stream will accept the token. A real phone-issued Privy access token, existing
bootstrap mapping, Development Stream App acceptance, Chat/Video client
connection, reconnect behavior, and physical-device tests remain unverified.
Stream message, channel, membership, presence, moderation, call, ringing, and
media state continue to belong solely to Stream and are not added by this
decision. The large-group Go/No-Go remains unchanged.
