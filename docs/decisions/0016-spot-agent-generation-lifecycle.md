# Decision 0016: Spot Agent generation lifecycle

- Status: Accepted
- Date: 2026-08-26

## Context

Decision 0014 bounded each Hyperliquid Testnet Agent to 24 hours, but the
initial persistence schema allowed only one Agent identity for an owner,
network, and wallet-binding epoch. Refreshing the same Privy wallet does not
advance that binding epoch. Because the signed Agent name is immutable and
contains its expiry, the initial uniqueness rule would permanently prevent a
replacement Agent after the first one elapsed.

The authorization resource and the Agent identity represent different facts.
An authorization state such as `active` is the historical, terminal result of
one provider approval operation. Current trading authority is determined by
the associated identity lifecycle, the still-current wallet-binding epoch,
and a database-clock check of the persisted `agent_valid_until` value. A past
successful authorization must not be rewritten as a failed signing handoff
when its Agent later reaches its planned expiry.

## Decision

Each owner, Testnet network, and wallet-binding epoch may retain multiple
immutable Agent identity generations. Generations start at canonical string
`1`, increase by exactly one under the owner-and-epoch issuance lock, and are
stored as positive PostgreSQL `bigint` values. At most one generation may be
current in `reserved`, `authorization_pending`, `active`, or `operator_hold`;
`revoked` and `retired` generations remain immutable history.

The Privy remote-wallet allocation key is domain-separated over owner,
network, binding epoch, and Agent generation. A retry for one generation must
recover the same remote wallet, while a later generation must never recover or
reuse the prior Agent address, signer reference, key, or signed name.

`spot_agent_authorizations.agent_valid_until` remains the single persisted
expiry authority. The identity table does not copy or infer it. A database-only
lifecycle worker and the issuance preflight may lock owner, wallet binding,
identity, and latest authorization in that order. Once the database clock is
at or beyond the latest persisted Agent validity, they transition the current
identity to `retired` and append a sanitized `agent_validity_elapsed` event.
Only then may the next generation be reserved. `operator_hold` continues to
block a parallel Agent and can converge to `retired` only through this bounded
lifecycle path after the Agent validity has elapsed.

The standalone worker enables this database-only maintenance by default. It
runs one immediate pass and then one pass every 60 seconds, with at most 100
rows per operation. Prepared-handoff expiry runs before identity retirement;
the two operations receive separate fresh request UUIDs, and a failure in the
first lane does not suppress the second lane's attempt. Infrastructure errors
discard raw details and trigger one bounded exponential backoff from 1 to 30
seconds. `SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED=false` may pause the path for
operator maintenance. Neither setting nor loop receives a Privy client, signer,
relay, Exchange transport, or provider-read port.

Each repository lane advances a keyset cursor after a full candidate page and
wraps after reaching the end. A lock-contended earliest page therefore cannot
be selected forever while later due records starve; every individual candidate
still uses the common owner/binding/identity/authorization lock order and a
bounded lock timeout.

Signing-handoff expiry and Agent-validity expiry remain distinct:

- an unused `prepared` authorization whose short signing window elapsed moves
  to authorization `expired`; its identity may be reused while the Agent name's
  longer validity is still current;
- if that identity is in `operator_hold`, the authorization is still physically
  expired and removed from future sweep candidates, but the identity remains
  held until its Agent validity elapses or a separately approved recovery acts;
- an identity already in `revoked` or `retired` likewise cannot leave an elapsed
  signing handoff physically `prepared`; expiry changes only the authorization
  and preserves the terminal identity state;
- a successfully approved authorization may remain `active` as historical
  provider-result evidence after its identity retires;
- Spot intent preparation and submission must require the current identity,
  the matching active authorization, and `database_clock < agent_valid_until`.

The existing `spot_agent_authorization_issue_v1` digest is not rewritten.
Identity UUID, address, signed name, signer reference, and expiry already bind
one generation's authority. Existing identities are migrated to generation
`1` without updating their record version, timestamps, authorization digest,
nonce, or append-only events.

## Consequences

Agent renewal no longer requires a wallet rotation and does not erase prior
authorization or intent evidence. Concurrent renewal still admits only one
current generation and one authorization winner. A lossy rollback to the old
schema is refused after any generation other than `1` exists.

This decision does not enable Privy allocation, signature relay, Hyperliquid
Exchange writes, Mainnet, withdrawals, or automation. Those capabilities
remain default-closed behind their existing evidence gates.
