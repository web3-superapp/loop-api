# Decision 0010: Explicit Perp wallet-binding lifecycle

- Status: Accepted
- Date: 2026-08-25

## Context

The six authenticated Hyperliquid private-read routes and Perp intent review
already consume a server-resolved wallet binding. Their cursor and persisted
review contracts bind authority to a monotonic `bindingVersion`, but the
runtime has no durable selection or lifecycle. Selecting the first linked
Privy wallet during an ordinary read would make a GET request silently choose
or rotate a trading account and could not close the final Perp intent
transaction against a concurrent change.

Privy 0.29.0 can query a user by verified DID and returns linked accounts. Its
embedded Ethereum account ID is nullable, and its linked-account verification
timestamp is historical provider metadata rather than a current LOOP proof.

Official evidence:

- <https://docs.privy.io/user-management/users/managing-users/querying-users>
- <https://docs.privy.io/api-reference/users/get>
- <https://docs.privy.io/user-management/users/the-user-object>
- <https://github.com/privy-io/node-sdk/blob/v0.29.0/src/lib/user-utils.ts>

## Decision

- Add `GET`, `PUT`, and `DELETE /v1/perp/wallet-binding`. Every route requires
  the current Privy Bearer and existing LOOP bootstrap mapping. No route
  accepts or returns an owner, Privy DID, address, wallet ID, network, DEX,
  agent, or subaccount authority. The only exposed account kind is the fixed
  `master` discriminator.
- `GET` reports only stored `bound`/`unbound` state, a decimal-string binding
  version, nullable fixed `master` kind, and nullable last verification time.
  An absent row is a non-writing `unbound` version `0` default.
- `PUT` accepts exactly `expected_binding_version` and is the only action in
  this slice that may bind, refresh, or rotate. With no current selection it
  binds only when the current Privy user has exactly one eligible embedded
  Ethereum wallet. With a selection it first exact-matches that wallet even if
  other eligible wallets exist; if the selection disappeared, rotation is
  allowed only when exactly one eligible candidate remains.
- An eligible account is `type=wallet`, `chain_type=ethereum`,
  `wallet_client_type=privy`, and `connector_type=embedded`, with a nonzero EVM
  address. A non-null provider wallet ID is matched together with the address;
  a null ID uses the address inside the already verified Privy user scope.
  Array position and `wallet_index` are never authority.
- `DELETE` accepts only `expected_binding_version` and explicitly unbinds.
  Bind, rotate, and unbind increment one durable signed-bigint epoch by exactly
  one. Refreshing the exact same authority retains the version. Identical
  already-applied retries return the committed state; stale different changes
  conflict.
- One permanent owner row retains the epoch after unbind. Active wallet ID and
  address are unique across LOOP owners. Append-only lifecycle events retain
  action, request ID, from/to versions, and timestamps only; they never retain
  a token, DID, wallet ID, address, or raw Privy response.
- The resolver is read-only. It loads the stored selection, performs a fresh
  Privy lookup with the outer abort signal, a four-second SDK timeout, and zero
  SDK retries, then exact-matches the selection. A success creates a 15-second
  in-memory verified lease using the database epoch; there is no cross-request
  cache, stale fallback, negative cache, or implicit persistence.
- No stored selection or an authoritative current response proving it was
  removed returns `wallet_binding_required`. Provider/network/rate-limit
  failure, malformed responses, duplicate exact matches, identity mismatch,
  and database corruption return unavailable. Dependency failure is never
  misreported as a user-remediable missing binding.
- Perp intent finalization locks and compares the current binding row before
  inserting the generic operation or domain intent. A rotate or unbind race
  rolls back the complete finalization and produces the existing stale-intent
  failure.

## Consequences

Private reads and future reviewed intents share one explicit, replaceable
authority epoch without exposing wallet authority in the mobile contract.
Interactive selection among multiple unbound wallets, Hyperliquid subaccounts,
delegation, agent wallets, signing, and mutation remain separate decisions.
Credentialed Privy/device evidence remains required before claiming the
lifecycle has been exercised with a real mobile-created wallet.
