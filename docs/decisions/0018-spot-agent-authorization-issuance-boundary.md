# Decision 0018: Spot Agent-authorization issuance boundary

- Status: Accepted
- Date: 2026-08-28

## Context

Decision 0014 permits one short-lived, server-built Hyperliquid Testnet
`approveAgent` handoff, and Decision 0016 permits renewable immutable Agent
generations. The persistence layer already owns generation selection, the
owner-wallet nonce high-water mark, immutable review and payload bindings, and
database-clock expiry checks. It did not yet have one feature coordinator that
could join current wallet authority, product policy, deterministic Privy Agent
allocation, exact typed-data materialization, and repository issuance without
turning those pieces into a live provider capability.

The official `approveAgent` formatter has an important representation boundary.
The EIP-712 typed-data `message.nonce` is a JSON number, while LOOP exposes and
passes durable nonces as canonical decimal strings so they are never rounded by
ordinary JavaScript number handling. A formatter that silently converts an
arbitrary `uint64` string to `number` could produce a rounded signing payload
whose digest no longer represents the nonce reserved by PostgreSQL.

Signature recovery, Privy signature-result parsing, relay, ambiguous-result
readback, and Agent-authorization reconciliation remain separate effectful
boundaries. Completing issuance orchestration must not imply that any of those
capabilities are available.

## Decision

### Coordinator and composition

A complete Spot Agent-authorization issuance coordinator is implemented as an
uncomposed feature slice. It remains absent from `src/app.ts`; the production
runtime continues to select the unavailable Spot Agent-authorization service.
Tests may compose the coordinator only with explicit fake or unavailable ports.

The coordinator accepts only the authenticated server-derived LOOP owner and
Privy subject, a fresh server request UUID, and an abort signal. It fixes the
provider to Hyperliquid, the network to Testnet, the action to `approve_agent`,
and the account kind to `master`. The client cannot select a wallet, Agent,
generation, policy, nonce, domain, primary type, expiry, allocator key, or
provider origin.

Issuance requires both current wallet authority and an affirmative current
product-policy decision. The coordinator resolves those authorities before any
allocation work and resolves them again afterwards. Both observations must
exact-match the owner, Privy subject, eligible embedded EVM wallet identity,
master address, binding epoch, policy version, and their bounded validity. A
missing, denied, stale, changed, malformed, or unavailable observation fails
before the repository can persist an issued handoff.

One absolute workflow admission window is created at request entry and is never
renewed by preflight retries, expiry cleanup, concurrent recovery, or replay.
It is at most eight seconds and may be shortened by either the current wallet
lease or current policy lease. Repository inputs carry the exact policy owner,
fixed Testnet/action coordinates, version, checked time, expiry, workflow start,
and absolute deadline as transient admission evidence. Those times do not enter
the immutable idempotency digest, because a legitimate replay is admitted by a
new current policy observation while reconstructing the original durable
payload.

PostgreSQL checks the wallet, policy, and admission windows with
`clock_timestamp()` before every guarded SQL statement, after deferred
constraints are forced, and immediately before commit. Transaction-local
statement and lock timeouts are re-armed to the remaining absolute admission
time before each statement and commit; sequential waits cannot each claim a new
eight-second budget. A stale, future, overlong, mismatched, or elapsed window
rolls the entire transaction back, including identity, nonce high-water,
authorization, operation, and event rows. Pool acquisition observes the same
abort signal and releases a client that arrives after cancellation without
opening a transaction.

The repository preflight always runs before the Privy Agent allocator. A
current prepared replay performs no allocation, but it is not returned from the
first snapshot: after the second wallet and policy observations, a second
owner-scoped database preflight must confirm the same current immutable
authorization and reconstruct its one-time payload. An elapsed handoff first
becomes durable history; its still-valid reserved identity is then reused
without another allocation. Only a new `issue_required` identity may call the
allocator, using the domain-separated owner, Testnet, binding-epoch, and
Agent-generation key from Decision 0016. This ordering reduces duplicate
external work; the future real allocator must still provide deterministic
response-loss recovery for that exact key.

The allocator output is `unknown` at the port boundary and is parsed as one
strict, exact DTO before use. Missing or additional fields, a zero or malformed
Agent address, an invalid custody reference, accessors, and non-plain values
fail closed. Raw allocator errors, credentials, wallet material, and responses
are neither logged nor returned.

### Nonce and typed-data representation

PostgreSQL remains the sole nonce authority. It allocates the owner-wallet
authorization nonce inside the same issuance transaction that persists the
immutable Agent authorization and its append-only nonce allocation. No
coordinator, formatter, allocator, mobile client, SDK clock, or process-local
counter may allocate, increment, replace, or replay that nonce.

The outer signable envelope, repository interfaces, reviews, digests, and
database projections retain the nonce as one canonical unsigned decimal string.
The official EIP-712 typed-data `message.nonce` is the corresponding JSON safe
integer. Materialization is allowed only when the decimal string represents a
nonnegative integer no greater than `Number.MAX_SAFE_INTEGER`; conversion must
be exact, and converting the typed-data value back to canonical decimal text
must equal the envelope and database nonce byte-for-byte. An unsafe, rounded,
fractional, negative, exponent-form, padded, or otherwise noncanonical value
fails before issuance commits.

The formatter produces only the exact four-field Testnet `approveAgent`
EIP-712 contract and the fixed domain, primary type, `signatureChainId`, and
`hyperliquidChain` selected by Decision 0014. The repository strictly parses
that typed data, independently recomputes its signing digest, and requires it
to equal the formatter-provided digest before commit. It also persists the
SHA-256 of the exact typed-data JSON as a separate replay binding. Neither the
typed-data JSON nor a signature is stored; only the typed-data hash is durable.

### Expiry and Agent identity

The signing handoff lifetime is at most five minutes from the PostgreSQL clock.
Immediately before commit, an issued or replayed handoff must still be stored as
`prepared` with `signing_expires_at` after that clock; the coordinator also
checks the same expiry after the repository returns.

The Agent lifetime is positive and at most 24 hours from that same authority,
and the signing expiry must precede the Agent expiry. The server-generated Agent
name is exactly `Loop-` plus the first 11 lowercase hexadecimal Agent-address
characters followed by ` valid_until <unix-milliseconds>`. That millisecond
suffix must equal the separately persisted and displayed Agent validity;
missing, duplicated, seconds-based, padded, rounded, or mismatched suffixes fail
before commit. Both the coordinator and repository enforce this complete
deterministic value; an alternate base that merely satisfies the former
16-character limit is rejected on issuance and replay.

The repository continues to bind the immutable owner, Privy subject and wallet
identity digest, account address, binding epoch, Agent identity and generation,
Agent address and custody reference, nonce, policy, typed-data hashes, and both
expiries in one issuance record. Replay is permitted only when all reconstructed
bindings and both independently obtained digests match the durable record.

### Capability boundary

This decision does not select or install a production EIP-712 or Hyperliquid
dependency. The formatter and digest ports remain locally supplied verification
boundaries until an exact dependency, integrity, provenance, transitive SBOM,
license, official-Python conformance, and upgrade decision are accepted.

The following remain unavailable and uncomposed:

- a real Privy Agent-wallet allocator or credentialed allocation result;
- parsing the physical-device Privy signature result;
- canonical owner-signature recovery and current-wallet comparison;
- the atomic `prepared` to `submitting` relay-attempt journal;
- any Hyperliquid Exchange mutation, response parser, or automatic replay;
- authoritative `extraAgents` readback and the dedicated
  `spot_agent_authorization` reconciliation lane; and
- all Spot issuance, signing, relay, or trading composition in `src/app.ts`.

Any one of those missing, unknown, stale, malformed, or denied gates keeps the
public runtime on its sanitized unavailable response before provider signing or
write I/O.

Cancellation is guaranteed before the commit point: a signal observed while
waiting, executing, or validating rolls the transaction back. Once `COMMIT` has
been dispatched, its acceptance may be unknown and a simultaneous client abort
cannot prove that no local row was written. The workflow therefore checks the
combined signal again after the repository returns and treats that edge as
response loss; a retry must use owner-scoped replay confirmation and cannot
allocate another Agent, nonce, or authorization. There is still no provider
relay in this slice, so this local ambiguity cannot create a late Hyperliquid
mutation.

## Consequences

The backend can test issuance ordering, replay-without-allocation, dual wallet
and policy authority checks, strict allocator parsing, database-owned nonce
materialization, independent digest agreement, and bounded expiry without
inventing a relay or enabling a provider mutation.

The only truthful capability label for this slice is an implemented but
uncomposed issuance coordinator with fake-port behavior evidence. It is not a
live Privy integration, a completed owner-signature flow, an active Hyperliquid
Agent, a relay, a reconciliation path, or a Testnet trading capability.

Mainnet, Perp product work, transfers, withdrawals, bridges, resting orders,
automation, and deployment remain outside this decision.
