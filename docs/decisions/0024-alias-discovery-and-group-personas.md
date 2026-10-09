# Decision 0024: Alias discovery and immutable group personas

- Status: Accepted
- Date: 2026-08-31

## Context

Decision 0009 made LOOP PostgreSQL the system of record for an owner's mutable
profile alias, opaque avatar reference, and fail-closed `discoverable`
preference. It deliberately left public-profile lookup and social discovery
closed. The product now requires two narrower identity presentations:

- one public profile alias that an authenticated user can find globally when
  its owner has opted into discovery; and
- one independently chosen alias for each Stream Chat group, fixed forever
  after that user first claims it in that group.

These presentations must not turn a wallet address, Privy subject, internal
LOOP user UUID, or Stream user ID into a public identity. They also must not
create a second message, membership, presence, or moderation authority beside
Stream. Stream remains authoritative for whether a user is currently a member
of a Chat channel, while LOOP must own alias immutability, uniqueness, and the
minimal discovery projection.

A Stream user has one stable server-derived ID across groups. Per-group aliases
therefore provide product- and UI-level pseudonyms only. They do not provide
strong unlinkability against a modified client, provider/operator access,
traffic analysis, or any surface that exposes the stable Stream subject.

## Decision

### Public alias discovery

- Approve
  `GET /v1/discovery/users?alias_prefix={prefix}&limit={limit}`. It requires the
  current Privy Bearer boundary and an existing bootstrap mapping.
- Search only profiles with both a non-null alias and
  `privacy.discoverable=true`. The existing profile alias remains mutable and
  public aliases are not globally unique; multiple users may intentionally
  publish the same alias. The authenticated caller is omitted from their own
  discovery result set.
- Identify a result only by a random opaque `public_profile_id`. A result item
  contains exactly `public_profile_id`, `alias`, and nullable `avatar_ref`. It
  contains no internal/Privy/Stream user ID, wallet, address, login method,
  group membership, other alias, or relationship field.
- Use normalized prefix matching only. The normalized prefix must contain at
  least two Unicode code points after trimming, NFKC normalization, and
  ASCII-space folding. Fuzzy matching, substring matching, a result total, and
  pagination cursors are not approved. `limit` defaults to 20 and is bounded to
  1 through 20. A bounded response may report only whether more matches were
  omitted.
- Pin the lookup-key contract as `unicode17_nfkc_lower_ws_v1`. Node 24.19 uses
  Unicode 17 only to validate normalized input length and returns the trimmed
  raw prefix; PostgreSQL 17 supplies Unicode 15.1 and is the sole lookup-key
  canonicalizer. The same immutable database function is used by stored
  generated keys and query prefixes, with the 37 Unicode 16/17 compatibility
  mappings explicitly bridged before PostgreSQL NFKC. Changing either Unicode
  engine or this mapping requires a new versioned key and migration; runtime
  code must never apply and forward a competing lookup-key transformation.
- Deterministic ordering and opaque IDs disambiguate duplicate public aliases;
  duplicate names never authorize selecting an internal owner or Stream
  subject.

### Existing Stream group resolution

- Approve `POST /v1/chat/groups/resolve` with one bounded
  `stream_channel_id`. The channel type is compiled as `messaging`; a request
  cannot select another type, CID, Stream App, or provider URL.
- Before creating or returning a LOOP mapping, the backend must ask Stream and
  prove that the current server-derived Stream user has actually joined the
  existing channel (`joined=true`), rather than merely having a pending or
  rejected invitation membership record. Absence, ambiguity, timeout,
  malformed provider data, or insufficient server permission fails closed.
- Resolve returns only a random opaque `group_id`. It never creates a Stream
  channel, adds or removes a member, changes roles, accepts an invitation, or
  exposes the provider channel ID in the response.
- LOOP PostgreSQL stores the one-to-one mapping between the fixed
  `messaging` channel and `group_id`. Stream remains the membership authority;
  the mapping is not evidence that a caller or candidate is still a member.

### Immutable per-group alias

- Approve `GET /v1/chat/groups/{group_id}/me/alias` and
  `PUT /v1/chat/groups/{group_id}/me/alias`. Every request first resolves the
  opaque group and verifies the caller's current membership through Stream.
- PUT accepts only an alias. The first successful reservation creates one
  random opaque `group_alias_id` for the `(group_id, internal_user_id)` pair.
  The stored normalized alias key is unique within that group.
- Once reserved, the displayed alias and its normalized key are permanent. An
  exact same-value retry returns the existing resource. Any different value
  returns an immutable-conflict result and never replaces the record.
- Leaving a Stream channel does not delete or release the record. If the same
  LOOP account later rejoins, it resumes the same alias; the alias remains
  unavailable to every other account while the group mapping exists.
- A group-alias response contains exactly `group_alias_id`, `alias`, and
  `projection_state`. The projection state is `pending` until the matching
  Stream member custom data is confirmed, then `confirmed`.

LOOP PostgreSQL is canonical for the group alias. After durable reservation,
the backend projects the alias and opaque alias ID into server-reserved Stream
channel-member custom data. A projection failure does not release or mutate the
alias: the database record remains `pending`, and an exact same-value retry may
repeat only the projection. Stream custom data is presentation/cache data and
is never accepted as identity, membership, uniqueness, or immutability proof.

### Group-local alias search

- Approve
  `GET /v1/chat/groups/{group_id}/aliases?alias_prefix={prefix}&limit={limit}`.
  The same normalized minimum-two-code-point prefix, 1-through-20 bound,
  default 20, prefix-only matching, no-total, and no-cursor rules apply.
- On every request, Stream must confirm that the requester is a current member.
  Every returned candidate must also be confirmed as a current member of that
  same channel. A retained alias belonging to a departed member continues to
  occupy its name but is not returned. The requester and aliases whose Stream
  projection is still `pending` are also omitted.
- A result item contains exactly `group_alias_id` and `alias`. It never exposes
  a public-profile ID, internal/Privy/Stream user ID, wallet or address, another
  group's alias, global alias, channel ID, memberships, or any cross-group
  correlation field.

### Enumeration and Stream controls

- Each public or group alias search atomically reserves three bounded quota
  buckets before database search: authenticated user per minute, canonical
  client IP per minute, and authenticated user per day. Public and group search
  use separate capabilities. Public search capacities are 30 per user-minute,
  60 per IP-minute, and 300 per user-day. Group search capacities are 60 per
  user-minute, 120 per IP-minute, and 600 per user-day.
- Reuse the existing server-only `STREAM_TOKEN_QUOTA_HMAC_SECRET` material, but
  derive subjects under an independent versioned alias-search HMAC domain. Raw
  LOOP user IDs and IP addresses are not stored as quota subjects. Missing
  quota capability fails closed; exhaustion returns a stable 429 without a
  discovery query.
- Before external launch, Stream roles/permissions and the Flutter client must
  be verified to prevent direct Stream user search and client mutation of the
  server-reserved member fields. LOOP always ignores those fields for
  authorization even if a provider or client misconfiguration changes them.
- Before external launch, the group-resolution provider call also needs a
  dedicated authenticated-user/IP rate limit (or an equivalent Cloudflare
  control) so arbitrary channel-ID probes cannot consume the shared Stream App
  quota. This deployment control is independent from alias-search quotas.
- Direct Stream `queryUsers`, wallet/address search, QR identity lookup,
  contacts/following, alias history, cross-group alias lookup, and a custom
  social graph are not approved by this decision.

## Persistence and rollback

The implementation uses additive PostgreSQL state for stable opaque public
profile IDs, existing-channel mappings, and permanent group-alias reservations.
The migration is append-only after merge. A rollback may leave these records
unused, but must not delete or recycle an alias reservation merely because a
user left a channel or a Stream projection is pending.

The database remains the canonical alias authority across runtime rollback,
provider outage, projection retry, and leave/rejoin. A future deletion or legal
retention workflow needs a separate decision because deletion may conflict with
the approved permanent-name and non-reassignment properties.

## Consequences and evidence gates

This decision approves a narrow discovery directory and group-persona boundary,
not a social graph or alternate Chat core. The additive migration, runtime
routes, generated OpenAPI, behavior tests, and PostgreSQL integration tests are
implemented; the five interface operations are therefore `implemented`.

Even after those local gates pass and the routes become `implemented`, provider
capability remains unverified until a real Development `messaging` channel with
at least two real test accounts proves membership rejection, member projection,
leave/rejoin retention, search filtering, and the required Stream role and
permission behavior. Physical-phone Privy login plus Flutter Chat tests remain
a separate device gate. No local fixture, injected adapter, or empty channel may
be reported as that evidence.
