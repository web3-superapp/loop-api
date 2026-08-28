# Decision 0019: Hyperliquid Testnet Spot IOC adapter selection

- Status: Accepted
- Date: 2026-08-28

## Context

Decisions 0014 and 0018 kept production Hyperliquid signing and Exchange
dependencies unselected until an exact implementation could be reviewed
against the pinned official Python oracle. The durable Spot submission path now
owns its nonce and one transport-attempt journal in PostgreSQL, but the existing
signer and writer ports had only fake implementations.

Hyperliquid has no official TypeScript SDK. A community package can therefore
implement bytes and typed-data construction only if it does not take over
network selection, nonce allocation, retries, order construction, or transport.
Remote signing also needs a provider idempotency key and a server-enforced
request expiry; returning a generic wallet object would lose those controls
when the low-level package invokes `signTypedData`.

Selecting an offline-conformant adapter is not the same as enabling a trading
capability. The product/legal policy, real Privy Agent lifecycle, final
just-before-send evidence, complete SBOM, credentialed Testnet mutation, and
authoritative reconciliation evidence are still missing.

## Decision

### Exact dependencies and allowed surface

`@nktkas/hyperliquid@0.33.3` is selected as an exact runtime dependency only
for:

- `canonicalize` with the package's exact `OrderRequest` action schema;
- `createL1ActionHash`;
- `signL1Action`; and
- the narrow local-wallet interface used to hand the resulting EIP-712 payload
  to LOOP's remote-signing port.

`viem@2.44.2` is selected only to recover the address that signed that exact
EIP-712 payload. It is not yet a Privy account adapter in this repository.

LOOP must not use `ExchangeClient`, a high-level order method, SDK transport,
SDK or process-local nonce management, automatic retry, Mainnet fallback, or
another action encoder. PostgreSQL remains the sole nonce and one-attempt
journal authority. The package and all direct dependencies stay exact in
`package.json` and `pnpm-lock.yaml`.

This decision supersedes only the “not selected or installed” dependency
statements in Decisions 0014 and 0018. It does not relax any of their runtime
composition, credentialed evidence, reconciliation, or product-policy gates.

### Signer boundary

The IOC signer accepts only the persisted Testnet action, nonce, expiry,
attempt deadline, server-only Agent custody reference, and expected Agent
address. It canonicalizes one strict IOC order, requests `source=b`, recomputes
the action hash, and recovers the signature against the expected address.

The low-level package never receives a Privy client. Instead it calls a narrow
LOOP remote-typed-data signer. A real implementation of that port must:

- locate the wallet only by the server-only custody reference;
- pass the per-call signing UUID as Privy's idempotency key;
- pass the persisted attempt deadline as Privy's absolute request expiry;
- treat the expected Agent address as an assertion, never a lookup key;
- return one strict 65-byte ECDSA signature; and
- never export or expose a private key.

The adapter rejects a malformed action, Mainnet, non-null vault, unsafe or
out-of-window nonce, late deadline, malformed custody reference, malformed
request UUID, zero/mixed-case address, malformed signature, or recovered-address
mismatch before it can claim a usable signature. Abort after a remote request
cannot prove cancellation, so late results are discarded and the provider-side
request expiry remains mandatory.

### Exchange writer boundary

The writer compiles exactly
`https://api.hyperliquid-testnet.xyz/exchange`. It accepts only the already
journaled Testnet action and signature, sends at most one `fetch`, disables
redirects, caches, and credentials, and has no retry path. It rejects non-2xx
responses and transport failures as ambiguous. A successful HTTP response must
be bounded, fatal-UTF-8, lossless JSON, but is deliberately not trusted as a
terminal trading result. Whether the response is syntactically accepted or
rejected, the coordinator records the attempt as unknown and authoritative
read-only reconciliation must decide the outcome. Response bodies are consumed
or cancelled best-effort so failure paths do not retain transport resources.

The main Fastify runtime continues to inject unavailable Spot services. These
adapters are not reachable from a public route and no credentialed provider
write is claimed.

### Verification and remaining gates

The selected primitives match both pinned official action hashes and Testnet
EIP-712 digests. A fake remote signer returns one pinned official signature and
the adapter independently recovers its expected address. Transport tests prove
one fixed request, no retry, bounded response handling, non-2xx ambiguity, and
pre-I/O rejection of malformed authority and timing.

This is hash/digest/signature-vector evidence, not direct observation of every
MessagePack/preimage byte and not a Privy or live-Exchange test. Direct byte
evidence, a complete transitive SBOM artifact, a real Privy Agent remote signer,
Agent authorization, final send admission, strict provider-outcome evidence,
credentialed Testnet IOC, crash/restart, and reconciliation remain required
before runtime composition.

## Consequences

LOOP now has reviewable, default-uncomposed adapters for the exact Testnet Spot
IOC envelope without delegating network, nonce, retry, or result authority to a
community SDK. The public Spot submit route remains a sanitized unavailable
capability, and no mobile, Mainnet, Perp, transfer, withdrawal, bridge, resting
order, batch, automation, or deployment work is authorized by this decision.
