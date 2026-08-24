# Primary evidence

Checked 2026-08-23. Hyperliquid official documentation and official SDK source are the protocol authority. Privy official recipes are the wallet/signing boundary evidence. The selected TypeScript library is a pinned community adapter candidate, not a protocol authority and not installed in R0.

## Hyperliquid official documentation

- API networks and SDK index: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api>
- Info endpoint and order statuses: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>
- Asset IDs and Core/HIP-3 namespace rules: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids>
- Perpetual account, metadata, position, and funding reads: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals>
- Exchange order/cancel/modify/leverage/margin/agent/builder actions: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint>
- Signing and the distinct L1/user-signed schemes: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing>
- Nonces and API wallets: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets>
- WebSocket endpoints and reconnect requirement: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket>
- WebSocket subscriptions, snapshots, fills, funding, and liquidation: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions>
- Timeouts and heartbeats: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats>
- Rate and user limits: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits>
- Batched and pre-validation error shapes: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses>
- Tick and lot size: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size>
- Builder authorization/readback semantics: <https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes>
- Hyper Foundation official site and current Terms link: <https://www.hyperfoundation.org/>

## Official SDK source conformance oracle

- Release 0.24.0: <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/releases/tag/0.24.0>
- EIP-712 and msgpack signing source: <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/0.24.0/hyperliquid/utils/signing.py>
- Exchange actions: <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/0.24.0/hyperliquid/exchange.py>
- Info reads: <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/0.24.0/hyperliquid/info.py>
- WebSocket behavior: <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/0.24.0/hyperliquid/websocket_manager.py>

## Privy official wallet/signing boundary

- Hyperliquid quickstart: <https://docs.privy.io/recipes/hyperliquid-guide>
- Agent wallets and expiration: <https://docs.privy.io/recipes/hyperliquid/agents-and-subaccounts>
- Client-side owner/agent split: <https://docs.privy.io/recipes/hyperliquid/client-side-usage>
- Hyperliquid policies and offline actions: <https://docs.privy.io/recipes/hyperliquid/policies-and-offline-actions>

## Pinned maintained community candidate

- `@nktkas/hyperliquid` v0.33.2 source: <https://github.com/nktkas/hyperliquid/tree/v0.33.2>
- Release provenance: <https://github.com/nktkas/hyperliquid/releases/tag/v0.33.2>
- MIT license: <https://github.com/nktkas/hyperliquid/blob/v0.33.2/LICENSE>
- SDK nonce manager: <https://github.com/nktkas/hyperliquid/blob/v0.33.2/src/api/exchange/_methods/_base/_nonce.ts>
- SDK per-wallet/network request lock and Exchange shell: <https://github.com/nktkas/hyperliquid/blob/v0.33.2/src/api/exchange/_methods/_base/_shell.ts>
- Exact order schemas: <https://github.com/nktkas/hyperliquid/blob/v0.33.2/src/api/exchange/_methods/order.ts>
- Raw liquidation schema: <https://github.com/nktkas/hyperliquid/blob/v0.33.2/src/api/subscription/_methods/userEvents.ts>
- Subscription limit implementation: <https://github.com/nktkas/hyperliquid/blob/v0.33.2/src/transport/websocket/_subscriptionManager.ts>
- Declared dependency ranges: <https://github.com/nktkas/hyperliquid/blob/v0.33.2/deno.json>

The official current limit is 10 unique users across user-specific WebSocket subscriptions, while the pinned SDK source hard-codes 15. LOOP must apply the 10-user guard before the SDK.

Exact top-level commit/archive hashes, source-oracle hashes, npm integrity, runtime requirement, and upgrade gate are recorded in `oss-lock.json`. This is not a locked runtime graph: declared dependency ranges are recorded, and a full transitive lockfile/integrity/license audit remains `PENDING` and blocks implementation.

Hyperliquid WebSocket BBO/l2Book messages provide market data and provider time, not a `source_revision` field. LOOP's review identity is explicitly adapter-generated from subscription epoch, monotonic raw-message arrival sequence, and SHA-256 of the exact raw UTF-8 message. This identity never replaces provider market authority. One canonical strict parser must prove the hashed raw frame yields the normalized bid/ask used for IOC; BBO and l2Book data shapes cannot be relabeled or parsed interchangeably. A second canonical source-envelope digest commits provider, network, epoch, sequence, raw hash, source kind, coin, provider time, and normalized price/size/count fields. Structural checks bind those fields to the exact review, fresh Core meta, internal coin-bearing order intent, and asset-bearing Hyperliquid wire. Exact-frame access and atomic callback correlation through the pinned SDK are still `PENDING`, and LOOP cannot open an alternate feed to bypass that gate.

No legal eligibility conclusion is asserted by this R0 evidence set. Current Terms, applicable law, sanctions, jurisdiction, product availability, user age/entity status, and provider-terms acceptance require separately owned authoritative evidence with version and expiry. Until every decision is current and approved, every production mutation is denied before Hyperliquid SDK or Privy signing; public market reads are independently scoped.

The two-sided IOC boundary uses the official tick/significant-digit rules cited above. `decimal.js` is only a declared mature arithmetic candidate for a future thin policy; its range is not a complete runtime pin. Until the full transitive version/source/integrity/license gate closes, no price-policy runtime or production trading may be enabled.
