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
- Preparation: an uncomposed coordinator permanently claims the idempotency
  key before dependency reads, resolves short-lived wallet/Agent authority
  before and after review, generates a 16-byte server CLOID, and accepts only a
  strict executable-review draft before the atomic repository handoff. Replay
  and pending claims perform no authority, reviewer, or CLOID work.
- Writer: **unavailable**. No Node signing package is installed or composed.
- Orchestration: an uncomposed fake-only coordinator verifies one call through
  the minimal signer and writer ports plus unknown/reconciliation handoff after
  the durable journal wins. The persisted DB deadline bounds fake signing and
  writer admission. It does not prove signing conformance and is not a provider
  implementation or runtime capability.
- Mainnet: absent. Decision 0015 is a boundary, not an activation.

The preparation coordinator is not a runtime capability. A real authority
resolver and pure-read current-Agent repository path are implemented and tested
but remain uncomposed. A real Testnet metadata/book/fee reviewer and exact
precision formatter are implemented and tested but likewise remain uncomposed.
The reviewer uses best ask for buy, best bid for sell, bounded depth, directed
Hyperliquid price quantization, the official 10-quote-token minimum, an explicit
injected quote-notional/fee-rate policy, and a dependency deadline. It does not
read balances or imply funds availability; a fresh balance check belongs to
submit preflight. Composition is forbidden until a default-deny product/legal
decision supplies the exact policy values and both adapters are explicitly
composed. The atomic
repository already exact-matches owner, Privy subject,
wallet ID, address, binding epoch, and Agent under locks; it validates the
resolver lease with the database clock after those waits and again after
deferred projection checks, while requiring Agent validity through review
expiry. The v1 draft verifier currently locks a 25 bps default and 100 bps
maximum slippage, a 15-second review lifetime, a 2-second maximum
reference-source age, and a 15-second maximum fee-source age. It also uses exact
arithmetic to bind the real action notional to the reviewed maximum
spend/minimum receive. In v1, `fee_estimate` is a conservative
quote-denominated bound: it cannot be below `price * size * fee_rate`, and it is
included when proving the user's maximum spend or minimum receive. Changing
these numbers or fee semantics requires a coordinated reviewer, config,
contract, and test update.

For v1, the metadata reader's `metadataVersion` is already the
domain-separated SHA-256 of the canonical allowlisted registry projection, so
the durable draft stores that same digest as `metadataSha256`; it is not hashed
again as hexadecimal text. A fresh account `userSpotCrossRate` observation must
not exceed the explicit product fee ceiling. The persisted `fee_rate` is that
ceiling, not a claim about the final pair-adjusted rate or actual fee token; this
keeps the immutable settlement bound safe if the account rate changes within
the allowed policy. Buy reserves `maximum spend * rate`; sell reserves
`best-bid notional * rate`, which upper-bounds fee at every eligible bid while
the displayed minimum receive still uses the lower IOC limit notional. Both fee
bounds round upward to the quote token's atomic-unit scale. Submit must
fresh-read fees and reject if the current rate exceeds the reviewed ceiling.

Because the approved action is IOC, sell `minimum_receive` is conditional on
the complete `computed_base_size` filling. A positive partial fill must preserve
the same proportional net-quote-per-base floor; exact cross-multiplication can
verify that without division. `not_filled` promises no settlement amount. The
submit/reconciliation path must enforce these semantics before this adapter can
be composed; the reviewer alone does not prove the final settlement.

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
