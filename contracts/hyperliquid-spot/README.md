# Hyperliquid native Spot contract

This directory is the reviewable authority for LOOP's first Hyperliquid native
Spot vertical slice. It approves Development plus Hyperliquid **Testnet** only,
one manually reviewed capped IOC buy or sell, and read-only authoritative
reconciliation. The twelve route operations are registered in the main runtime
and generated OpenAPI with unavailable default services; this does not claim a
provider writer or signer is available.

Hyperliquid is the authority for token/pair metadata, books, balances, fees,
orders, fills, Agent authorization state, and settlement. Privy is the identity
and wallet authority. LOOP owns authentication, product policy, an opaque market
registry, exact-decimal review, durable idempotency, persistent nonce
allocation, single-attempt journaling, risk limits, and reconciliation. LOOP is
not a matching engine, price source, balance ledger, key store, general EIP-712
encoder, or alternate Hyperliquid protocol implementation.

## Current capability

- Provider: Hyperliquid native Spot.
- Network: Testnet, fixed server-side.
- Account: the current bound master account only.
- Order: one server-derived Spot asset, one buy or sell, one exact reviewed
  price and size, `reduceOnly=false`, `limit.tif=Ioc`, `grouping=na`, and one
  server CLOID.
- Result: immediate strict parsing plus read-only reconciliation after any
  ambiguous outcome.
- Writer: **unavailable**. No Node signing package is installed or composed.
- Mainnet: absent. Decision 0015 is a boundary, not an activation.

The first public contract is exactly the twelve routes in `contract.json`.
`POST /v1/spot/intents` is both the durable executable quote and the immutable
F11 review. There is no separate quote, general order-history, or fills
resource in this slice.

## Four provider identifiers

Ticker text is never enough to identify a Spot market. One immutable Testnet
registry record binds:

1. base and quote token indices;
2. base and quote token IDs;
3. the Spot-pair/universe index; and
4. Exchange order asset `10000 + pair index`.

The client sees only a server-issued opaque `market_id`. It cannot submit or
override any provider identifier. Testnet and future Mainnet registries, cache
keys, Agent identities, nonces, and idempotency domains cannot be shared.
Outcome assets and their alternate identifier forms are outside this contract.

## Wallet and signing boundary

Spot and the retained Perp compatibility routes use one provider-neutral
Hyperliquid master-wallet binding and one monotonic epoch. Spot must not create
a second independently mutable binding authority. Every balance, prepare,
authorization, and submit operation re-verifies the current Privy identity,
wallet selection, binding epoch, and policy.

An Agent is unique per owner, Testnet, and binding epoch. Its private key must
never enter application memory, logs, fixtures, Git, or the mobile client. The
owner may receive one server-generated, expiring `approveAgent` typed-data
payload because Privy must sign those exact public fields; the client cannot
choose or edit the Agent, nonce, domain, or action. GET/status resources and
signature-submission requests do not accept or return those authority fields.

## Fixtures and conformance

Files under `fixtures/` are public, non-secret verification evidence. They are
never runtime fallback data and may not be shown as provider success.

The signing vectors were generated offline from the official Python SDK at the
exact commit in `oss-lock.json`. No key material is committed. The recorded
signer is the public test identity used by the official SDK tests. The fixture
captures MessagePack bytes, hash preimages, action hashes, EIP-712 intermediate
hashes, signatures, and recovered addresses for two Spot IOC vectors and one
`approveAgent` vector.

There is no official TypeScript SDK. `@nktkas/hyperliquid@0.33.3` is only an
isolated conformance-spike candidate, not a selected runtime dependency. A
future adapter must reproduce the official vectors byte-for-byte before it can
be installed or composed. A green fixture-schema test is not a claim that a
runtime signer passed conformance.

## Fail-closed rules

- All financial values are canonical decimal strings. Provider values never
  pass through JavaScript `number` arithmetic.
- The server persists the reviewed size and worst price; submit never silently
  replaces them.
- Intent preparation uses permanent UUID idempotency. Every provider write has
  one durable transport attempt at most.
- Timeout, disconnect, post-send 429/5xx, crash, unknown OID/status, conflicting
  evidence, or an IOC unexpectedly reported as resting enters reconciliation
  or operator hold. No worker retries a write.
- Missing SDK, signer, policy, wallet, Agent, quota, metadata, nonce,
  reconciliation, or credentialed evidence returns unavailable or denied
  before Exchange I/O.
- Perp, cancel/modify, resting orders, triggers, TP/SL, TWAP, batch, vault,
  subaccount, transfer, withdrawal, bridge, builder fee, automation, and
  Mainnet are not writer actions in this contract.

See `sources.md` for primary evidence, `oss-lock.json` for exact source and
candidate provenance, and `target-inventory.json` for owned implementation
surfaces.
