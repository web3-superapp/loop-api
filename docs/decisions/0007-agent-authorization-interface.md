# Decision 0007: Agent authorization negative interface and durable binding

- Status: Accepted
- Date: 2026-08-25

## Context

Decision 0003 approves three owner-bound native routes for a Hyperliquid
Testnet `approveAgent` flow. The provider contract fixes the authority boundary:
the owner wallet signs this action, Privy remains the wallet authority, the
pinned Hyperliquid SDK must own user-signed action formatting and nonce
handling, and ambiguous relay is reconciled from `extraAgents` without an
automatic retry.

The local authority does not contain the exact official typed-data `types`,
`domain`, `message`, field order, primary-type value, nonce continuation, or an
audited externally signed relay API. The Hyperliquid SDK is not installed, its
complete dependency and license evidence is pending, and no credentialed
Privy/Hyperliquid Testnet evidence or signature-recovery adapter exists.
Inventing any of those fields would create an alternate EIP-712 encoder and
would violate the provider contract.

This decision therefore fixes the safe domain, persistence, and negative route
semantics without defining a successful signable issuance payload or claiming
that Agent authorization is connected.

## Decision

### Scope and server authority

- The action is exactly provider `hyperliquid`, network `testnet`, and action
  `approve_agent`. Mainnet, builder approval, transfer, withdrawal, wallet
  selection, arbitrary typed data, arbitrary URLs, and other user-signed actions
  are not accepted.
- Every route uses the current Native Privy Bearer principal and existing LOOP
  bootstrap mapping. The backend derives the internal owner, account, expected
  owner-wallet signer, Agent identity, network, action, primary type, digest,
  and both expiries. The mobile client cannot select or override them.
- Agent allocation is a future Privy provider port. Its output remains
  `unknown` until wallet lifecycle, credential, policy, revocation, and negative
  signing-probe evidence exists. It may never expose a private key, recovery
  secret, or signing credential.
- A newly allocated Agent address is permanently unique in LOOP persistence.
  Revoked, expired, retired, or operator-held addresses are never reused for a
  replacement.

### Exact native requests

`POST /v1/perp/agent-authorizations` has no request body, query, client
idempotency key, address, or network selector. The service receives only the
authenticated principal, a server request-correlation UUID, and its abort
signal.

`GET /v1/perp/agent-authorizations/{authorization_id}` accepts one canonical
lowercase authorization UUID in the path and no body or query.

`POST /v1/perp/agent-authorizations/{authorization_id}/signatures` accepts one
canonical lowercase path UUID and exactly this JSON object:

```json
{ "signature": "<opaque Privy signing result>" }
```

`signature` is a transient printable-ASCII string from 1 through 1024 bytes.
The interface deliberately does not assert a hex, recovery-ID, or byte-layout
shape that the local SDK evidence does not prove. Unknown fields, whitespace or
control characters, non-plain objects, accessors, and symbols are rejected.
Typed data, digest, nonce, owner, wallet/account or Agent address, primary type,
expiry, provider payload, URL, and idempotency values are never accepted in this
body.

When the mobile flow is eventually enabled, it signs the exact backend-issued
JSON through Privy's `eth_signTypedData_v4` boundary and submits only the
returned opaque signature string. Privy's request-authentication signature APIs
are not an Ethereum owner-wallet signature and must not be substituted. This
decision does not enable that mobile flow because the backend cannot yet issue
the exact official payload.

### Sanitized durable resource

The owner-facing status resource is exactly:

```json
{
  "authorization_id": "uuid",
  "state": "prepared|submitting|accepted|active|rejected|failed|unknown|reconciling|expired",
  "review": {
    "version": "perp_agent_authorization_review_v1",
    "provider": "hyperliquid",
    "network": "testnet",
    "action": "approve_agent",
    "account": {
      "address": "lowercase nonzero EVM address",
      "kind": "master|subaccount"
    },
    "signer_wallet_address": "lowercase nonzero EVM address",
    "agent": {
      "address": "lowercase nonzero EVM address",
      "name": "bounded server-generated safe name",
      "valid_until": "RFC 3339 timestamp"
    }
  },
  "signature": { "state": "required|consumed|expired" },
  "expires_at": "RFC 3339 signing-handoff expiry",
  "result": null,
  "created_at": "RFC 3339 timestamp",
  "updated_at": "RFC 3339 timestamp"
}
```

`prepared` maps to `signature.state: required`; `expired` maps to `expired`;
every other lifecycle state maps to `consumed`. `active`, `rejected`, and
`failed` require a matching sanitized result with `observed_at` and an optional
safe reason code. `unknown` and `reconciling` expose result state `unknown`.
Prepared, submitting, accepted, and expired resources have no result.

The resource never contains typed-data JSON, a complete authorization payload,
primary type, digest, payload hash, nonce, signature, key, token, Privy subject,
binding version, raw provider response, or raw error.

### Current negative behavior

- Issuance checks the Agent authorization mutation gate before an allocator,
  handoff, repository, signer, SDK, or provider call. The production default
  returns `perp_mutation_disabled` with HTTP 403 and creates zero rows.
- If a test or future composition allows the gate while the reviewed workflow
  is unavailable, issuance returns `agent_authorization_unavailable` with HTTP
  503 and creates zero rows. The current service exposes no allocator or
  provider-handoff injection point and performs no effectful call after this
  gate: no parser or transaction exists that can prove and durably bind an exact
  official signable payload before an external side effect.
- `GET` reads only an owner-scoped durable projection. A foreign authorization
  and a nonexistent authorization both return
  `agent_authorization_not_found`; the route has no signing or provider side
  effect.
- Signature submission validates its strict body and performs the owner-scoped
  read first. Stored or PostgreSQL-clock elapsed expiry returns
  `agent_authorization_expired` before the mutation gate. A resource no longer
  in `prepared` returns its current durable status without verifying or relaying
  another signature.
- A current prepared resource then checks the same default-deny mutation gate.
  The default returns HTTP 403 without a signature verifier, SDK, relay, or
  state transition. An allowed gate still returns HTTP 503 locally, does not
  forward or persist the transient signature, and leaves the record unchanged.

The stable domain errors are:

| HTTP code                         | HTTP | Meaning                                     |
| --------------------------------- | ---- | ------------------------------------------- |
| `invalid_request`                 | 400  | Strict path/body/service input failed       |
| `perp_mutation_disabled`          | 403  | Current product/legal mutation gate denied  |
| `agent_authorization_not_found`   | 404  | Missing or foreign owner-bound resource     |
| `agent_authorization_expired`     | 409  | Stored signing handoff cannot be used       |
| `agent_authorization_unavailable` | 503  | Required audited adapter/evidence is absent |
| shared `internal_error`           | 500  | Corrupt internal state or invariant failure |

Shared authentication, bootstrap, timeout, and request-size errors retain their
existing meanings.

### Persistence, expiry, and idempotency

Migration 000004 adds:

- `perp_agent_identities`, a non-secret unique-address lifecycle registry;
- `perp_agent_authorizations`, an immutable issued-review and digest binding
  whose UUID is also the generic provider-operation UUID;
- `perp_agent_authorization_events`, an append-only sanitized domain journal.

The repository operation is intentionally named `persistIssued`. Calling it is
a claim that a future audited workflow already issued one exact signable
payload. It accepts only non-secret binding facts: server UUIDs, owner/account
and binding facts, Agent identity, sanitized public review, opaque primary-type
value, signing digest, SHA-256 of the typed-data JSON, signing expiry, and Agent
valid-until. It never accepts or stores the typed-data JSON, complete payload,
signature, nonce, signed bytes, key, access token, or raw provider response.
The current service has no path to `persistIssued`.

One PostgreSQL transaction inserts the server-sourced idempotency record,
generic provider operation, Agent identity, authorization row, generic audit,
and domain event. The authorization UUID is the server idempotency UUID. Every
future successful audited issuance/finalization must supply a fresh
server-generated UUID; the current negative issue route generates none. The
internal request digest is domain-separated and binds all non-secret immutable
issuance facts. Both the idempotency reservation and domain row persist the exact
`perp_agent_authorization_issue_v1` digest version. A duplicate identical
internal finalization resolves to the existing record; a collision, version
mismatch, or changed binding fails closed.

The database clock proves that the signing expiry is still future before any
row commits and projects an elapsed prepared record as expired. Signing expiry
cannot be later than Agent valid-until. Immutable issue facts, payload hashes,
digests, account/signer/Agent bindings, and expiries cannot change in place.
The owner-wallet signer cannot equal the Agent address. Agent identity rows
cannot be deleted or reassigned, so an address cannot be made reusable through
cleanup. Migration rollback is refused before any table is dropped whenever an
Agent identity or issued generic Agent-authorization operation exists. The down
migration first takes exclusive locks in repository write order, closing the
check/drop race with concurrent finalization. This preserves permanent
idempotency replay and identity history.

### Provider, relay, and reconciliation boundary

An unavailable Hyperliquid handoff type records the intended future separation
between issue and signature submission, with both outputs remaining `unknown`.
It is not injected into `BuildApp`, composed into the service, or called by any
route. Enabling that port requires all of the following in a later decision and
implementation slice:

- an installed and completely locked/licensed official SDK;
- official conformance fixtures for `HyperliquidSignTransaction` and
  `approveAgent` without copying an encoder into LOOP;
- an exact issue output parser and mobile success DTO;
- audited owner-wallet signature recovery against the stored digest and current
  expected wallet;
- a provider-supported continuation that relays the original SDK-owned action
  and nonce without LOOP regenerating, accepting, persisting, incrementing, or
  replaying the nonce;
- a transaction that records the one transport attempt before bytes can be
  sent; and
- credentialed Testnet success, rejection, timeout, process-crash, and
  `extraAgents` reconciliation evidence.

An ambiguous future relay becomes durable `unknown` and is read back from
`extraAgents` for the exact account, Agent address, name, and valid-until. It is
never generically retried. No nonce, relay-success shape, or reconciliation
transition is implemented by this decision.

## Consequences

The backend can expose and test an owner-safe negative contract, a strict
signature input boundary, and durable non-secret persistence invariants without
fabricating EIP-712 or provider behavior. Product/legal enablement alone cannot
accidentally create a signable record: missing technical evidence still returns
503 with zero rows.

A successful issuance response remains deliberately unavailable. Adding one is
an architecture and security change, not an adapter toggle, and requires a new
reviewed decision plus provider and physical-device evidence.
