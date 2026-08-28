# Primary evidence

Checked 2026-08-26. Hyperliquid's official documentation and official Python
SDK source are the protocol authority. Privy's official documentation is the
identity, wallet, and remote-signing authority. Community TypeScript packages
are candidates only and cannot override either authority.

## Hyperliquid official documentation

- API networks and official SDK index:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api>
- Spot metadata, asset contexts, and clearinghouse state:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot>
- General Info reads, order status, fills, open orders, and history:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>
- Asset identifiers and Spot `10000 + pair index` mapping:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids>
- Exchange order, IOC, CLOID, item-status, and `approveAgent` shapes:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint>
- The two signing schemes and canonicalization hazards:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing>
- Nonce retention, time window, API-wallet scope, and address-reuse rules:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets>
- Price significant figures and size-decimal rules:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size>
- Rate and user limits:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits>
- Exchange error responses:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses>
- Account Spot taker fees and discount semantics:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees>
- Account abstraction modes and balance interpretation:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes>

## Official conformance oracle

- Python SDK release 0.24.0:
  <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/releases/tag/0.24.0>
- Exact oracle commit:
  <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/tree/2fdb18f9517675ea03695a0962bd19eece9c83f0>
- Signing implementation:
  <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/hyperliquid/utils/signing.py>
- Exchange implementation and Spot example:
  <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/hyperliquid/exchange.py>
- Official signing tests:
  <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/tests/signing_test.py>
- Basic Spot order example:
  <https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/examples/basic_spot_order.py>

The oracle is verification-only and is not installed in the Node runtime. Its
exact file and dependency hashes are recorded in `oss-lock.json`.

## Privy authority

- Hyperliquid integration guide:
  <https://docs.privy.io/recipes/hyperliquid-guide>
- Agents and subaccounts:
  <https://docs.privy.io/recipes/hyperliquid/agents-and-subaccounts>
- Client-side owner/Agent split:
  <https://docs.privy.io/recipes/hyperliquid/client-side-usage>
- Policies and offline actions:
  <https://docs.privy.io/recipes/hyperliquid/policies-and-offline-actions>

Privy's request-authentication signatures are not substitutes for the owner's
Ethereum `approveAgent` signature. The mobile client may sign only the exact,
expiring server-issued payload and return only its opaque signature.

## TypeScript conformance-spike candidate

- `@nktkas/hyperliquid` v0.33.3 release:
  <https://github.com/nktkas/hyperliquid/releases/tag/v0.33.3>
- npm registry metadata and provenance:
  <https://registry.npmjs.org/@nktkas/hyperliquid/0.33.3>
- exact source commit:
  <https://github.com/nktkas/hyperliquid/tree/bb82eba38b177d3938c59fa1fb992e6c0bb0aa6b>

The candidate has not been installed, imported, or selected for production.
Its declared ranges are not a complete locked graph or SBOM. Any spike stays
isolated and may evaluate only the low-level canonicalization, action-hash,
EIP-712, signing, and wallet abstraction needed to satisfy LOOP's persistent
nonce and one-attempt boundaries. High-level in-memory nonce/send ownership is
not accepted as the backend authority.

The live provider-response fixtures are bounded public Testnet captures made on
2026-08-26. They preserve provider strings and identifier types but are test
evidence only, never cache seeds or runtime fallback data.
