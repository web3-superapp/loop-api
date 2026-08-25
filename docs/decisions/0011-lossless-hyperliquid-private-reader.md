# Decision 0011: Lossless Hyperliquid private reader

- Status: Accepted
- Date: 2026-08-25

## Context

Decision 0005 defines strict provider-neutral private-read responses but leaves
the runtime reader unavailable. The reviewed community SDK candidate has moved
from 0.33.2 to 0.33.3. Its HTTP transport parses responses with native
`JSON.parse`, its public fill/order identifiers are JavaScript numbers, it does
not validate response schemas, and its request error retains the request and a
provider-body excerpt. Direct adoption therefore cannot prove exact uint64
identifiers, response-stage retry classification, or the repository's
no-address/no-provider-body logging boundary.

Hyperliquid's Info endpoint is an unauthenticated read API. The provider
documents a 1200-weight per-IP minute budget, weights of 2 for
`clearinghouseState`, 20 for most other Info calls, and additional response-size
weight for fills and funding.

Official and dependency evidence:

- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids>
- <https://github.com/nktkas/hyperliquid/releases/tag/v0.33.3>
- <https://github.com/josdejong/lossless-json>

## Decision

- Do not install `@nktkas/hyperliquid` for this slice. Add exact
  `lossless-json` 4.3.1 (MIT, no runtime dependencies) solely to parse Info
  responses without losing numeric lexemes. Its registry integrity is
  `sha512-SqD/Bg3ZfltBJ2Z14hJ/BihnvtV553WO4g9/ePtlp4lrnl9jF3AdIJt53A/Wkg/0Li+LMfxaBqgx1MiFZdQlpQ==`.
- This is a read-only carve-out. A narrow adapter may POST only allowlisted
  request bodies to the compiled Testnet URL
  `https://api.hyperliquid-testnet.xyz/info`. It has no signer, key, nonce,
  Exchange action, configurable URL, WebSocket, or Mainnet path. Existing SDK
  ownership gates remain unchanged for all mutations and subscriptions.
- The runtime is default-off. `HYPERLIQUID_PRIVATE_READS_ENABLED=true` requires
  Privy credentials, the Perp cursor secret, and an independent quota HMAC
  secret. Partial enabled configuration is a startup error.
- A PostgreSQL-backed global policy reserves weight before every real request.
  The Development default is 960 weight/minute, below the provider's 1200.
  Quota consumption gains an atomic positive `cost` while existing Stream
  calls continue to cost one.
- The transport caps response bytes, requires JSON content type, parses all
  numeric tokens losslessly, and never includes its request or response body in
  an error. A failure before receiving a `Response` and provider 5xx may be
  retried by the existing service. Provider 4xx/429, body-read failure,
  oversize/wrong-content/invalid JSON, and malformed 2xx are sanitized
  unavailable failures and are not retried. Outer abort is preserved.
- Every read uses one fresh Core `meta` boundary. BTC, ETH, and SOL must exist
  exactly once and be active. Any returned Spot, HIP-3, nonallowlisted Core
  asset, trigger, TP/SL, TWAP, builder fill, unknown field/status, malformed
  value, or mixed scope makes the complete response unavailable; it is never
  silently filtered.
- `config` uses `meta`; fees and minimum notional remain explicitly
  unavailable. `account` and `positions` use `clearinghouseState` with empty
  DEX. `orders` uses `frontendOpenOrders` because ordinary `openOrders` lacks
  the fields required by the accepted DTO.
- `fills` uses `userFillsByTime` with `aggregateByTime=false` over a frozen
  server-owned seven-day window. `funding` uses `userFunding` over the same
  bound. Results are sorted newest-first with exact tuple identities. Provider
  caps of 2000 fills and 500 funding rows set `coverage.truncated=true`.
- Fills/funding continuation pages refetch and page only inside the encrypted
  frozen window and never claim records older than a capped response.
  Positions/orders use live keyset pagination and are explicitly not described
  as point-in-time snapshots.
- Successfully parsed Core metadata may be reused only through its source
  expiry and for no more than 60 seconds. No private result or error is cached.

## Consequences

The existing private-read HTTP shapes can become a real Testnet read capability
without importing a signer-capable SDK or corrupting provider identifiers.
Strict scope rejection can make a whole view unavailable for an account with
Spot/HIP-3 activity or after provider schema drift; this is the accepted
fail-closed behavior. Credentialed Testnet, physical-device, shared-egress, and
deployment evidence remain unverified gates, and no trading capability is
enabled.
