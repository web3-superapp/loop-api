# Decision 0005: Hyperliquid private-read interface

- Status: Accepted
- Date: 2026-08-24

## Context

LOOP needs authenticated Testnet account, position, open-order, fill, and user
funding views before Flutter integration begins. Public market metadata and price
contexts already remain a direct, read-only Flutter concern; these routes must
not become a public market proxy.

Hyperliquid's Info API requires the actual master or subaccount address. An agent
address returns a different or empty view, and the zero address is a real query
subject rather than a missing-account sentinel. Some user endpoints can include
Spot or multiple perp DEXes even when another request accepts `dex: ""`, so a
Core response cannot be inferred from address or coin spelling alone.

The official API has no Node or TypeScript SDK. The repository's reviewed
community candidate, `@nktkas/hyperliquid` 0.33.2, has drifted to 0.33.3 while
the required complete dependency, integrity, license, and conformance audit is
still open. No candidate SDK is installed by this decision.

Official evidence:

- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size>
- <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/releases/tag/0.24.0>
- <https://github.com/nktkas/hyperliquid/releases/tag/v0.33.3>

## Decision

- Implement `GET /v1/perp/config`, `/account`, `/positions`, `/orders`,
  `/fills`, and `/funding` as strict provider-neutral HTTP interfaces with an
  unavailable reader, fake test reader, generated OpenAPI, and no-store
  responses. Their runtime capability remains `blocked-provider`.
- Every route verifies the current Privy Bearer token and existing LOOP
  bootstrap mapping, then resolves one current server-verified eligible wallet
  binding. Clients cannot submit an account, wallet, address, agent, network,
  DEX, provider time range, or provider cursor state. Missing, ambiguous,
  expired, or unapproved bindings return `wallet_binding_required` before any
  Hyperliquid call.
- The default binding resolver does not select the first linked wallet and does
  not create or persist a guessed binding. Wallet selection, rotation, and
  subaccount lifecycle require a separate decision. The zero address is always
  invalid and is never a fallback.
- Reader inputs are fixed to Hyperliquid Testnet, Core perps, and `dex: ""`.
  Successful projections accept only BTC, ETH, and SOL that have been validated
  against the same fresh Core metadata boundary. Spot, HIP-3, nonempty DEX,
  unknown fields, unknown statuses, malformed data, and mixed-scope results
  make the complete response unavailable rather than being silently filtered.
- Prices, sizes, balances, margins, fees, funding, leverage, PnL, rates, and
  provider uint64 identifiers cross the LOOP boundary as strict decimal
  strings. Exponents, whitespace, locale separators, non-finite values, and
  JSON numbers are rejected. Nullable provider facts remain explicitly null or
  unavailable and are never converted to zero.
- Every success carries a source envelope identifying Hyperliquid, Testnet,
  Core perps, the dataset, and fetched/expiry times. Config metadata may live
  for at most 60 seconds. Private account snapshots may live for at most two
  seconds. A result stale on arrival fails closed.
- Positions are limited to the three Core coins. Orders are current ordinary
  open limit orders only. Fills are user fills, and funding is the user's actual
  funding ledger; public `fundingHistory` is not substituted for user funding.
  Historical coverage is bounded and explicitly reports truncation. It is not
  described as complete account history.
- List endpoints use bounded limits and an opaque ten-minute cursor. LOOP
  encrypts provider-neutral continuation state with AES-256-GCM under a
  domain-derived key, then HMAC-SHA256 authenticates the complete cursor and
  binds it to the current internal owner, wallet address, wallet binding
  version, route, limit, Testnet, Core, and empty DEX. Neither a malicious
  provider continuation nor the authenticated payload can expose those
  authorities. A tampered, expired, cross-route, cross-owner, or rotated-wallet
  cursor is an invalid request before provider work. A timestamp alone is not a
  valid provider cursor because inclusive time windows can contain more records
  than one provider response.
- Each provider read attempt receives a new UUID and a five-second deadline.
  One retry is allowed only for a pre-response transport failure, provider 5xx,
  or attempt timeout. Provider 4xx/429, malformed success, outer request abort,
  and unavailable capability are not retried. Two read attempts remain inside
  Fastify's 15-second route deadline.
- The stable external errors are `wallet_binding_required` (409) and
  `perp_unavailable` (503), in addition to the shared authentication, request,
  timeout, and internal errors. Provider errors and wallet addresses are not
  returned or logged.
- Fastify's raw incoming-request logs are disabled because `req.url` contains
  query values before validation. LOOP logs only the method, registered route
  template, server request ID, response status, and latency; rejected address,
  cursor, or other query values never enter request logs.
- Fastify's automatic `HEAD` aliases are disabled globally. The approved private
  read surface is exactly six `GET` operations; `HEAD` cannot trigger hidden
  authentication, wallet-resolution, or provider-read work.

## Consequences

The mobile-facing shapes, ownership rules, decimal policy, freshness, cursors,
and retry behavior can be reviewed before device work. Fake success fixtures do
not enable private reads. A real reader still requires an updated complete SDK
dependency audit, strict raw-provider conformance, a global Hyperliquid IP
weight budget, a reviewed wallet-binding lifecycle, credentialed Testnet
evidence, and deployment evidence. Trading, signing, Mainnet, transfers,
withdrawals, triggers, TP/SL, TWAP, HIP-3, and builder features remain disabled.
