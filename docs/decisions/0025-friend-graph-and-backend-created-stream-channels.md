# Decision 0025: Friend graph and backend-created Stream channels

- Status: Accepted
- Date: 2026-08-31

## Context

Decision 0024 introduced opt-in public Alias discovery and immutable,
group-local personas, but explicitly did not authorize a social graph or
Stream channel creation. The first mobile friends-and-chat flow now needs a
small accepted-friend graph, explicit consent before friendship, and
backend-mediated creation of Stream `messaging` channels.

This flow must preserve the existing identity boundaries. Privy remains the
authentication source, LOOP PostgreSQL owns social consent and idempotency,
and Stream remains authoritative for messages, channel membership, presence,
typing, read state, and history. Public Alias values can be duplicated and
changed, so they cannot safely identify a command target by themselves.

## Decision

### Public identity and search

- Continue to use the existing random `public_profile_id` as the only wire
  identifier for public-profile, friend-request, group-member, and direct-chat
  targets. Do not add a second `profile_ref` namespace.
- Add a server-generated, immutable, globally unique ten-character Crockford
  Base32 `profile_code` to public and friend identity surfaces. It exists only
  to let a person distinguish duplicate Alias values; authorization continues
  to require the complete `public_profile_id`.
- `profile_code` is never projected into Stream, exposed by group-local Alias
  APIs, or accepted as a command target. Wallet, Privy, internal LOOP, and
  Stream identifiers remain private.
- Keep public Alias values mutable and non-unique. `GET /v1/friends/search`
  uses the same normalization, result bound, and atomic public-search quota as
  `GET /v1/discovery/users`; it does not create a second enumeration budget.
- Search returns one of `none`, `outgoing_pending`, `incoming_pending`, or
  `friend`, plus the matching pending request reference when relevant.
  Nonexistent, non-discoverable, ineligible, and self targets are omitted.
  A command against any unavailable target returns the same
  `target_unavailable` response.

### Social privacy and friendship state

- Add a separate, owner-bound, versioned social-privacy resource with:
  `friend_requests=enabled|disabled`,
  `group_invites=friends|disabled`, and
  `direct_messages=friends|disabled`.
- Missing social privacy is version zero with every capability disabled.
  Replacement uses compare-and-swap and does not use `Idempotency-Key`.
- One unordered user pair has at most one pending request and at most one
  accepted friendship. The only transition to `friend` is an explicit accept
  by the current recipient. A reverse request while one is pending returns
  `incoming_request_pending`; it never auto-accepts.
- The first committed accept or reject wins. Pending requests expire after a
  bounded interval, rejected pairs have a bounded cooldown, and sends consume
  atomic sender, recipient, and canonical-IP quotas before revealing a target.
- The first slice supports accepted-friend listing and incoming/outgoing
  pending-request listing with stable, owner-bound, expiring HMAC keyset
  cursors. Cursors are bound to route, owner, filters, and page size; they are
  opaque to clients and cannot be replayed across users or list variants.
- Unfriend, blocking, QR lookup, wallet-address lookup, and group-member
  management are deferred. Therefore this Development slice does not claim a
  block check, relationship revocation, or complete external-launch abuse
  control. Those features require a later decision before external launch.

### Durable social commands

- New command-style POST routes require exactly one raw, canonical, lowercase
  UUIDv4 `Idempotency-Key`. The public `operation_id` is that same UUID, so the
  client knows the polling locator even if the first response is lost.
- A key is permanently bound, per owner and capability, to the operation kind
  and canonical request digest. An exact replay returns the original operation
  and result; using the key with different content or a different command
  returns `idempotency_conflict`.
- Friend request and decision operations are local PostgreSQL transactions and
  use a dedicated `social_operations` journal. They do not fabricate provider
  attempts in the generic external-provider journal.
- `request_id` remains a new per-HTTP-call correlation UUID in the
  `X-Request-ID` response header. It is not stored in or returned as the
  durable operation identity.

### Backend-created Stream channels

- Approve `POST /v1/chat/groups` for two through twenty-nine unique accepted
  friends plus the authenticated caller, producing three through thirty total
  members. The normalized group name and sorted public-profile target set are
  included in the idempotency digest. A new idempotency key may create another
  group with the same members.
- Approve `POST /v1/chat/direct-channels` for one accepted friend. An unordered
  friend pair has one durable direct-channel mapping; concurrent calls in
  either direction converge on the same explicit Stream CID.
- Both channel kinds use a server-generated, explicit, persisted Stream
  channel ID. They never use a Stream distinct-channel identifier. The LOOP
  operation, channel target, intended membership, and direct-pair or group
  mapping are durable before the provider write begins.
- Immediately before the provider call, the backend rechecks accepted
  friendship and the target users' relevant social-privacy capability. A
  failed recheck performs no provider write.
- Before channel creation, the backend derives every Stream user ID from an
  internal LOOP UUID and upserts only `{id}` through the Stream server SDK. It
  never copies public Alias, `profile_code`, public-profile ID, wallet, Privy
  subject, or group persona into Stream user custom data.
- Stream channels contain only the fixed custom fields
  `loop_channel_kind=group|direct` and
  `loop_channel_schema_version=1`, plus the group display name where relevant.
  Initial group creation never preclaims or projects a group-local Alias.
- Provider success is accepted only after an authoritative response proves the
  exact `messaging` CID, channel kind, schema version, and complete member set.
  A timeout or ambiguous response moves the operation to reconciliation and
  reads that same fixed ID; it never allocates another ID or silently creates a
  second channel.
- A durable `pending` operation that never claims a provider attempt must
  converge to a terminal local failure after a bounded dispatch window. A
  fixed-ID attempt that remains unavailable beyond bounded reconciliation, or
  whose authoritative projection disagrees with the intended kind or exact
  membership, converges to `operator_required`. Polling must never leave these
  cases in an unbounded nonterminal state.
- Public chat operation states are `pending`, `submitting`, `reconciling`,
  `succeeded`, `failed`, and `operator_required`. `operator_required` is a
  terminal unresolved result, not a disguised failure. Nonterminal HTTP
  responses use 202 with `Location` and `Retry-After`; known terminal results
  and exact replays use 200.
- `GET /v1/chat/operations/{operation_id}` is owner-bound and covers both group
  and direct commands. Unknown operation and wrong owner have the same 404.

### Stream truth source and compatibility

- Mobile obtains only a backend-minted Stream user token. Ordinary Stream
  clients must not retain permission to create channels for other users,
  change channel membership, mutate server-owned member fields, or update
  channel ownership. Dashboard permission verification remains an external
  launch gate.
- Messages, history pagination, membership, read state, typing, presence, and
  calls continue through the official Stream SDK. LOOP does not add parallel
  message or history endpoints.
- The existing `/v1/chat/groups/resolve` stays read-only. It accepts unmarked
  legacy messaging channels and marked `group` channels, but rejects a channel
  marked `direct` so a direct conversation can never acquire a group-persona
  namespace.
- Group-local Alias uniqueness and immutability from Decision 0024 remain
  unchanged: aliases may repeat across groups, but normalized aliases cannot
  repeat within one group and cannot be changed after first reservation.

## Persistence and rollback

The implementation uses an append-only migration for profile codes, social
privacy, friend requests, accepted friendships, social operations, direct
channels, chat operations, group metadata, and intended group membership.
Database constraints serialize unordered-pair transitions and bind operation
IDs to one owner, kind, and digest.

After merge, rollback may leave the new routes disabled, but must not delete,
recycle, or silently remap public profile codes, accepted relationships,
operation IDs, group IDs, fixed Stream channel IDs, or permanent group Alias
reservations.

## Consequences and evidence gates

The local implementation, generated OpenAPI, unit tests, route tests, and
PostgreSQL integration tests can establish the contract and fail-closed
behavior. They do not prove live Stream permissions, provider consistency, or
physical-device behavior.

Before external launch, two real Privy accounts on physical devices must prove
friend consent, direct-channel convergence, group creation, immutable group
Alias behavior, restart/history discovery, and negative authorization. The
Stream Dashboard must also prove that client-side channel/member mutations are
denied. Unfriend, blocking, leave/removal, account deletion, retention, and
push-notification behavior remain explicitly unverified and out of this
Development slice.
