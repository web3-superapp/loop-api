# Hyperliquid native Spot contract

This directory is the reviewable authority for LOOP's first Hyperliquid native
Spot vertical slice. It approves Development plus Hyperliquid **Testnet** only,
one manually reviewed capped IOC buy or sell, and read-only authoritative
reconciliation. The twelve route operations are registered in the main runtime
and generated OpenAPI with unavailable default services; this does not claim a
provider writer or signer is available in the main runtime.

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
- Result: every bounded provider response remains unclassified and enters
  read-only authoritative reconciliation; no immediate terminal result is
  trusted in this slice.
- Preparation: an uncomposed coordinator permanently claims the idempotency
  key before dependency reads, resolves short-lived wallet/Agent authority
  before and after review, generates a 16-byte server CLOID, and accepts only a
  strict executable-review draft before the atomic repository handoff. Replay
  and pending claims perform no authority, reviewer, or CLOID work.
- Submission preflight: an uncomposed read-only adapter resolves current
  wallet/Agent authority before and after provider reads, exact-matches fresh
  metadata, checks quote balance against buy maximum spend or base balance
  against sell size, rejects a current taker rate above the persisted ceiling,
  and requires an injected positive aggregate policy decision. It never signs
  or writes.
- Agent issuance: an uncomposed coordinator checks aggregate product policy and
  the current master-wallet authority before and after preflight/allocation.
  Exact replay performs no allocation, an expired handoff reuses its persisted
  internal Agent identity, and PostgreSQL remains the nonce authority. The
  envelope nonce remains a canonical decimal string while the official
  `typed_data.message.nonce` is the exact JSON safe integer. One non-renewable
  admission deadline covers all passes; the database re-arms statement and lock
  waits from that absolute deadline before every guarded SQL statement and
  commit, rechecks the prepared signing handoff before commit, and confirms a
  replay in a second database transaction after the second authority checks.
- Writer: exact low-level Testnet signing and fixed-origin, one-attempt Exchange
  writer adapters are implemented and tested but **uncomposed**. The writer
  accepts only a bounded UTF-8 JSON response; it deliberately does not classify
  that response as a terminal outcome.
- Orchestration: an uncomposed coordinator verifies one call through the
  minimal signer and writer ports plus unknown/reconciliation handoff after the
  durable journal wins. The persisted DB deadline bounds signing and writer
  admission. Offline hash, EIP-712 digest, and signature vectors pass, but this
  is not a credentialed provider or runtime capability.
- Mainnet: absent. Decision 0015 is a boundary, not an activation.

The preparation coordinator is not a runtime capability. A real authority
resolver and pure-read current-Agent repository path are implemented and tested
but remain uncomposed. A real Testnet metadata/book/fee reviewer, exact
precision formatter, and read-only submission preflight are implemented and
tested but likewise remain uncomposed.
The reviewer uses best ask for buy, best bid for sell, bounded depth, directed
Hyperliquid price quantization, the official 10-quote-token minimum, an explicit
injected quote-notional/fee-rate policy, and a dependency deadline. It does not
read balances or imply funds availability; the submit preflight independently
reads current account evidence. Its 2-second balance and fee leases are checked
by the repository with the database clock before journaling and again after
deferred constraints. They are admission facts, not a local reservation, and
cannot cover the full 10-second attempt. Composition is forbidden until a
default-deny product/legal decision supplies the exact policy values and the
adapters are explicitly composed. The atomic
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
reconciliation path must enforce these semantics before the write path can be
composed; neither reviewer nor preflight proves final settlement. A real writer
also needs a just-before-send evidence rule or a durable proven-not-sent outcome
because private evidence can expire after the journal wins.

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
The issuance coordinator is behavior-tested only with injected ports and is not
selected by `src/app.ts`. The IOC adapter recovers the signer of its own exact
L1 payload, but there is no real Privy Agent allocator/resolver, owner-signature
recovery, relay journal, credentialed Hyperliquid mutation, or Agent
reconciliation handler.

## Fixtures and conformance

Files under `fixtures/` are public, non-secret verification evidence. They are
never runtime fallback data and may not be shown as provider success.

The signing vectors were generated offline from the official Python SDK at the
exact commit in `oss-lock.json`. No key material is committed. The recorded
signer is the public test identity used by the official SDK tests. The fixture
captures MessagePack bytes, hash preimages, action hashes, EIP-712 intermediate
hashes, signatures, and recovered addresses for two Spot IOC vectors and one
`approveAgent` vector.

There is no official TypeScript SDK. Decision 0019 selects the exact
`@nktkas/hyperliquid@0.33.3` package only for low-level canonicalization,
action hashing, and signing behind an uncomposed adapter. Its action hashes,
Testnet EIP-712 digests, and recovered signatures match the pinned official
Python vectors. Direct MessagePack/preimage byte observation, a complete SBOM,
Privy remote-signing evidence, and credentialed Testnet evidence remain gates;
therefore the adapter cannot be composed into the main runtime.

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
