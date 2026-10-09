# Decision 0026: V2 BSC product baseline and V1 freeze

- Status: Accepted
- Date: 2026-09-02

## Context

The existing `/v1` API was built for the earlier Hyperliquid Testnet and local
social/profile slices. Its public DTOs use snake_case and its error response is
`{code,message,request_id}`. That contract is already consumed by the current
mobile work and has a committed deterministic OpenAPI artifact.

The current non-contract product plan changes the target product substantially:
login completes into Community, the primary tabs are Community, Mining, Launch,
Market, and Wallet, and ordinary trading targets Privy-mediated same-chain Swap
on the BSC product family. Launch participation is a separate contract-backed
flow. Hyperliquid Spot/Perp is not part of the new product path.

The source baseline for this decision is the user-provided
`03-非合约产品方案.md`, version 1.0 dated 2026-09-01, with SHA-256
`825bf74eabfee1182a8e33664ee8d71be0a6a777ff716eba2c676fc95f64ef5b`.
The document specifies product semantics; it is not evidence that any Provider,
chain address, contract, region policy, or production deployment is live.

## Decision

### Freeze V1 and introduce V2

- `/v1` is a compatibility contract. New product modules are not added to it.
- Its existing route paths, request/response shapes, error envelope, operation
  IDs, and OpenAPI metadata remain unchanged. Security fixes require a separate
  decision and compatibility review.
- New product work uses `/v2`. Public request/response fields, errors, webhook
  projections, and future public events use camelCase.
- Generate and drift-check separate `openapi/loop-api.v1.json` and
  `openapi/loop-api.v2.json` artifacts from runtime route schemas. The V1
  artifact remains the compatibility golden; neither artifact is hand-edited.
- The runtime may serve both versions during migration. A route existing in V1
  does not imply that an equivalent V2 route exists or is approved.

### Product navigation baseline

- A completed login returns to `community`; there is no Home compatibility
  route or hidden Home tab.
- Primary tabs are ordered as `community`, `mining`, `launch`, `market`, and
  `wallet`.
- Force-update, region, and terms decisions are versioned server policy. Until a
  real policy source is configured, each gate reports `unavailable`; clients
  must not interpret an unknown gate as approval.

### BSC, USD1, PancakeSwap, and Privy

- BSC is the selected target chain family for the new product. Development and
  production/Mainnet registry entries, RPCs, addresses, confirmations, and
  release controls remain separate.
- USD1 and PancakeSwap V3 are target product dependencies, not verified runtime
  configuration. No token, router, pool, quoter, factory, or contract address is
  frozen by this decision. Placeholder or prototype addresses must not enter
  executable code, public facts, or signed payloads.
- Ordinary same-chain Swap is mediated by verified Privy capability, quote,
  simulation, user confirmation, signing/submission, and reconciliation. LOOP
  does not build an independent Swap router or take custody of a user key.
- Pre-graduation Launch purchase is a distinct intent/state machine. It cannot
  reuse ordinary Swap, add an unapproved sell/redemption path, or automatically
  convert into a Swap intent after graduation.
- Mainnet writes, transfers, Bridge, Launch writes, Mining settlement, and all
  other funds movement remain unavailable until their own Provider, contract,
  legal, security, reconciliation, and release decisions are accepted.

### Capability truthfulness

- V2 publishes a versioned client-policy projection and a module-capability
  projection.
- Capability projection separates runtime/configuration availability from
  external evidence. A configured credential can make a backend attempt
  reachable, but it is not proof of physical-device behavior, Provider
  correctness, production readiness, or integration.
- Missing policy, credentials, runtime composition, Provider evidence, chain
  registry data, or contract evidence fails closed with a stable reason code.
- No capability response exposes credentials, Privy subjects, Stream subjects,
  wallet addresses, Provider URLs, signing material, or raw Provider responses.

### V2 common contract

- Current Privy Bearer verification remains the authentication boundary for
  protected V2 routes. Provider access and refresh tokens never become a LOOP
  long-lived bearer token.
- Server-generated request correlation remains authoritative and is returned as
  `X-Request-ID` and `correlationId`. A client-provided request ID cannot replace
  it.
- Every V2 write requires authentication and authorization where applicable, a
  canonical UUIDv4 `Idempotency-Key`, client version, contract version, and a
  stable machine error contract.
- V2 errors contain `code`, `category`, `retryable`, `userMessageKey`,
  `correlationId`, `detailsSafe`, and `providerReferenceSafe`. Unknown details
  and Provider references are `null`, not reconstructed from raw errors.
- IDs are opaque and server-derived. Wallet addresses, aliases, tickers, URL
  parameters, and Provider subjects are never account or authorization keys.

### Existing Hyperliquid behavior

- Existing Hyperliquid routes remain only under their frozen V1 compatibility
  boundary. They are not ported into V2 and do not define the new Market,
  Wallet, Swap, Launch, or Mining contracts.
- Decision 0020's Hyperliquid freeze remains in force. This decision does not
  compose a signer/writer, enable Perp, enable Mainnet, or claim a credentialed
  transaction.

## Persistence and rollback

This baseline introduces no chain, wallet, balance, order, or funds-movement
persistence. The initial metadata routes are read-only configuration
projections.

If V2 must be rolled back before consumers depend on it, disable its route
composition and remove only the V2 generated artifact. Do not alter the V1
artifact, delete existing user/social records, or reinterpret existing V1 IDs.
Once a V2 consumer is released, breaking changes require a new contract version
and a compatibility period.

## Consequences and evidence gates

The backend can now deliver new product modules as narrow V2 vertical slices
without silently redefining the existing mobile contract. The initial metadata
surface lets the client render honest unavailable/deferred states while policy
and Provider inputs are missing.

This decision does not prove Privy login on a physical device, Stream Chat or
Video connection, BSC RPC/indexer correctness, wallet projection, Swap,
PancakeSwap, USD1, Launch contracts, Mining rules, Firebase delivery, region
eligibility, or production deployment. Each capability stays unavailable or
evidence-pending until its module gate is independently satisfied.
