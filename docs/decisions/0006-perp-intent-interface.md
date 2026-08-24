# Decision 0006: Perp intent review and persistence interface

- Status: Accepted
- Date: 2026-08-25

## Context

Decision 0003 approves three native Perp intent routes and limits mutations to
Hyperliquid Testnet Core `order`, `cancel`, `modify`, `batch_modify`,
`update_leverage`, and `update_isolated_margin`. The provider contract records
the exact Hyperliquid action semantics, but it does not define a trusted native
BFF request. Historical prototype shapes are provenance and cannot become the
mobile contract by import or inference.

The HTTP interface must therefore separate the user's reviewable business
intent from wallet/account authority and from Hyperliquid wire fields. It also
needs an exact idempotency digest, durable owner-only state, and an atomic
domain finalizer before any provider mutation can later be enabled. A prepared
fixture is contract evidence only; it is not trading eligibility or a live
provider integration.

This decision extends, and does not weaken, the execution, signing, nonce,
eligibility, dependency, and reconciliation gates in
`contracts/hyperliquid-core-perp/contract.json`.

## Decision

### Scope and authority

- The interface is fixed to provider `hyperliquid`, network `testnet`, market
  `core_perps`, empty `dex`, and the BTC, ETH, and SOL allowlist. Mainnet,
  Spot, HIP-3, triggers, TP/SL, TWAP, scheduled cancellation, builder fields,
  withdrawal, transfer, and automation are not accepted by this interface.
- Every route uses the current Native Privy Bearer principal and existing LOOP
  bootstrap mapping. The backend resolves and revalidates the current unique
  wallet/account binding. A client cannot select an internal owner, account,
  wallet, address, subaccount, agent, network, DEX, asset index, provider
  nonce, signature, vault, expiry, or provider idempotency value.
- A cancel or modify target is a selector, not authority. Preparation and
  submission must prove that it belongs to the current server-resolved account
  and is still compatible with the reviewed intent.
- Request, review, result, and resource parsers accept `unknown`, reject
  accessors and non-plain data, reject unknown fields at every level, and emit
  deeply frozen values. No raw provider response or provider error message
  crosses the public boundary.

### Exact business-intent request

`POST /v1/perp/intents` accepts exactly one of these strict variants:

| Action          | Exact business fields                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Limit order     | `action: order`, Core `coin`, `side`, `order_type: limit`, positive decimal-string `size`, positive decimal-string `limit_price`, `time_in_force: gtc\|alo\|ioc`, and `reduce_only` |
| Market order    | `action: order`, Core `coin`, `side`, `order_type: market`, positive decimal-string `size`, positive decimal-string `max_slippage_percent`, and `reduce_only`                       |
| Cancel          | `action: cancel`, Core `coin`, and one strict target by `order_id` or `client_order_id`                                                                                             |
| Modify          | `action: modify`, Core `coin`, one strict target, `side`, positive decimal-string `size`, positive decimal-string `limit_price`, `time_in_force`, and `reduce_only`                 |
| Batch modify    | `action: batch_modify` and 1 through 39 strict modification entries                                                                                                                 |
| Leverage        | `action: update_leverage`, Core `coin`, `margin_mode: cross\|isolated`, and positive integer-string `leverage`                                                                      |
| Isolated margin | `action: update_isolated_margin`, Core `coin`, and nonzero signed decimal-string `margin_delta_usdc`                                                                                |

Leverage is deliberately not an order field. A leverage change and an order are
two different intents so that one operation authorizes at most one provider
transport attempt. The interface never silently performs two Hyperliquid
writes for one submit.

All financial and provider numeric values are strings. Positive decimals are
plain base-10 strings of at most 128 characters; exponents, whitespace, signs,
locale separators, redundant leading zeroes, zero, and non-finite spellings are
rejected.
The exact lexical value is material: `"1"` and `"1.0"` are different intents.
Leverage is a positive integer string and remains subject to fresh provider
metadata and account policy. `margin_delta_usdc` is nonzero, may be negative,
and has at most six fractional digits; the backend later derives any provider
direction field. Order IDs are canonical unsigned-64 integer strings no larger
than `18446744073709551615`. Client order IDs are lowercase `0x` plus exactly
32 hexadecimal digits.

Market slippage is expressed in percent units, is greater than zero, and is no
greater than `1.00`. A market request is only a business intent; its reviewed
provider action is an aggressive IOC limit whose final price must be derived
from the exact fresh, immutable quote chain required by the provider contract.

Batch modification contains at most 39 entries and cannot repeat a target. The
limit is an explicit LOOP policy: it stays below the provider's 40-item weight
step, bounds review/result size, and is not evidence that provider submission is
enabled.

For every new order and every modify replacement, LOOP generates and persists a
new cryptographically random 128-bit lowercase client order ID. The mobile
client never supplies a client order ID for a new order. Every batch replacement
gets a distinct generated ID.

### Canonical request and idempotency

- `POST /v1/perp/intents` requires exactly one raw `Idempotency-Key` header.
  Its value is one canonical lowercase UUID. Missing, repeated, uppercase,
  trimmed, malformed, or noncanonical values are invalid before repository,
  binding, reviewer, policy, signing, or provider work.
- The permanent idempotency scope is `perp_intent_prepare`; the digest version
  is `perp_intent_request_v1`.
- Each request variant has an explicit fixed JSON field order, including nested
  targets and modifications. The SHA-256 input is UTF-8
  `loop.perp.intent.request.v1\0` followed immediately by that compact canonical
  JSON. Object insertion order does not affect the digest; array order and
  decimal lexical spelling do.
- The same owner, scoped key, digest version, and request digest resolve to the
  same intent. Reuse with another owner or another digest returns one sanitized
  `idempotency_conflict` before wallet resolution, reviewing, signing, or
  provider work and never creates a second operation.
- A short PostgreSQL transaction claims that binding before wallet resolution
  or reviewing. If review later fails, the same owner and digest may resume the
  claim; another owner or digest can never take it over. The reservation holds
  no wallet, review, provider, signing, or secret material.
- A new unfinished claim is admitted only while that owner has fewer than 32
  unfinished claims and the service-wide unfinished-claim fuse is below 10,000.
  Exact retries do not consume another slot. These durable bounds prevent an
  authenticated client from growing orphan reservations without limit while
  preserving permanent owner/digest conflict semantics. Completed records are
  retained as operation history; production volume requires an explicit
  partition/archive policy rather than deleting conflict evidence ad hoc.
- Expiry is permanent for that prepared resource. Replaying its key returns the
  same expired intent; creating a newly reviewed intent requires a new key.

The public intent UUID is also the generic provider-operation UUID. This makes
one durable identity span owner-facing status, transport journaling, audit, and
future reconciliation without exposing a provider nonce or signature.

### Immutable public review and resource

The public review is version `perp_review_v1` and fixes provider, Testnet, Core,
empty DEX, one strict action, and `source.fetched_at`/`source.expires_at`.
It must contain the client's exact material business intent. Its only permitted
augmentations are:

- a server-generated client order ID for a new limit or market order;
- a provider-derived final IOC limit price plus generated client order ID for a
  market order;
- a server-generated replacement client order ID for each modify entry.

A comparison rebuilds the original request and compares its canonical JSON;
changing a coin, side, target, size, price, time-in-force, reduce-only flag,
slippage, margin mode, leverage, margin delta, or batch order invalidates the
review.

Ordinary review facts may span at most 60 seconds from `fetched_at` through
`expires_at`. A market-order quote may span at most two seconds, matching the
provider contract. Preparation must prove the source is currently fresh. The
binding is resolved again after reviewer latency and its owner, Privy subject,
account address/kind, and version must still be identical. Submission must
revalidate expiry, wallet binding, reviewed target ownership,
market/source identity, current facts, and mutation policy. An expired or stale
review is never refreshed in place.

The public resource contains only:

- `intent_id`, action, public lifecycle state, immutable review, expiry, and
  created/updated timestamps;
- submission state `disabled` or `requires_revalidation`;
- nullable sanitized result facts.

Public lifecycle state is one of `prepared`, `submitting`, `accepted`,
`partial`, `filled`, `cancelled`, `rejected`, `unknown`, `reconciling`, or
`expired`. Result entries use a JSON integer index from 0 through 38, and only
sanitized state, nullable order/client-order identifiers, nullable decimal
fill facts, and a bounded safe reason code. A non-batch result has exactly index
0; a batch result covers every reviewed entry in order. Wallet and account
addresses, Privy subjects, binding versions, request/review digests, provider
payloads, nonces, signatures, and raw errors never appear in this resource or
ordinary logs.

### Default-deny preparation and submission

- A per-action mutation gate is injectable, but the production composition in
  this phase denies every Perp mutation without an environment-variable bypass.
- Preparation authenticates and resolves bootstrap and current wallet binding,
  then obtains a strict review from an injected reviewer. The default binding
  resolver remains unavailable; with an injected binding the default reviewer
  remains unavailable. A fake reviewer may prove a prepared contract in tests,
  but its resource reports `submission.state: disabled` and does not imply
  trading eligibility or a live Hyperliquid integration.
- Owner lookup hides existence: another owner and a nonexistent intent both
  return `perp_intent_not_found`. `GET` reads persisted state only and has no
  provider or signing side effect.
- Submitting an expired intent returns `perp_intent_expired`. Any other intent
  that is no longer `prepared` returns its current durable resource. A prepared
  intent is checked for expiry, then the mutation gate.
  The default gate returns `perp_mutation_disabled` before a wallet resolver,
  reviewer, signer, SDK, or executor can run, and the durable operation stays
  prepared.
- A future enabled implementation must revalidate all current authority and
  review facts before atomically recording `submitting`; it cannot infer
  eligibility from successful preparation.
- Before a real durable wallet-binding resolver can enable preparation, prepare
  finalization must also lock or optimistically compare that binding's current
  epoch/version in the same database transaction. The present post-review
  re-resolution closes reviewer-latency rotation in the provider-independent
  slice, but is not a substitute for that final transactional check.

The stable intent-specific failures are `perp_mutation_disabled`,
`perp_intent_not_found`, `idempotency_conflict`,
`perp_intent_claim_rate_limited`, `perp_intent_expired`, and
`perp_intent_stale`, in addition to shared
authentication, bootstrap, wallet-binding, validation, timeout, and unavailable
errors.

### Persistence and atomic reconciliation

Perp intent persistence owns a domain intent row, one ordered row per action
item, and append-only sanitized domain events. It stores the immutable canonical
business action, public review, non-secret internal owner/account and binding
facts, generated client order IDs, expiry, aggregate state, and sanitized result
facts. It never stores a signature, key, nonce, signed bytes, access token,
complete provider authorization payload, or raw provider error.

The currently implemented preparation boundaries are atomic database
transactions:

- claim/replay resolution permanently binds the scoped idempotency key to its
  owner, `perp_intent_request_v1` digest version, and request digest before any
  wallet or reviewer work;
- prepare finalization reuses that claim and inserts the generic provider
  operation, Perp intent, item rows, generic audit, and domain event together;

No provider executor or lifecycle writer is composed in this phase. Before any
submission gate may be enabled, the following additional boundaries must be
implemented and proven atomic:

- beginning submission and its one-attempt generic transport journal;
- authoritative submission result or unknown-result scheduling;
- every resolved reconciliation update to generic state/audit and Perp
  aggregate/item/event state.

That future lifecycle code must lock the generic provider operation before the
Perp intent. Immutable
owner, idempotency, action, review, account-binding, generated-ID, and expiry
fields cannot change after preparation.

The existing generic reconciliation worker does not yet implement this Perp
domain finalizer and therefore cannot process Perp lifecycle work. A future
Perp domain handler may perform an authoritative read and parse a decision, but
its resolved finalizer must perform database work only and atomically update
both the generic operation and Perp domain rows under the worker lease, fence,
and expected record version. Completing the generic operation first and then
updating the Perp result is forbidden because a crash would expose contradictory
owner-facing and control-plane state. Unknown writes are never generically
resubmitted.

## Consequences

The native request, review, bounded idempotency reservation, preparation
persistence, owner-only status, and negative submission behavior can be
implemented and tested without installing a Hyperliquid SDK or claiming a live
mutation path. A future provider adapter and domain lifecycle finalizer must
still pass the
complete dependency/license review, Privy owner/agent authorization boundary,
protected single-executor topology, fresh technical and product/legal evidence,
credentialed Testnet tests, unknown-submission drills, independent review, and
deployment gates from the provider contract.

No decision here enables Mainnet, Pay, funds movement, withdrawal, automation,
builder fees, triggers, TP/SL, TWAP, HIP-3, public market proxying, or client-side
signing.
