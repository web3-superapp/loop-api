# Decision 0027: V2 Privy account and device-session boundary

- Status: Accepted
- Date: 2026-09-02

## Context

The first V2 delivery needs one login and registration contract for Privy Email,
Apple, Google, and external-wallet entry. Privy, rather than LOOP, authenticates
those methods and owns their account-linking policy. The backend must not create
a password system or infer that two Provider users are the same from an email,
wallet address, alias, or device.

The product also needs a durable device audit projection and an idempotent local
logout result. That projection cannot become a second bearer credential or make
an expired/revoked Privy access token valid.

## Decision

### Identity and authentication

- Every protected V2 request verifies exactly one current Privy Bearer access
  token. Refresh tokens never enter LOOP.
- `POST /v2/session/bootstrap` creates or restores the LOOP account keyed only
  by the verified Privy subject. First bootstrap is registration; no separate
  password-registration route exists.
- The same verified Privy subject returns the same random LOOP `accountId`.
  Distinct Privy subjects are never merged by LOOP. Cross-method linking is a
  Privy Dashboard and SDK behavior that requires physical-device evidence.
- Public responses expose only opaque LOOP/session IDs and the deterministic
  server-derived Stream user ID. They omit Privy subjects, login method, email,
  phone, wallet address, token, and Provider response data.

### Device-session projection

- A device session is a non-authoritative audit record. It is not accepted as
  authentication, and `GET /v2/account/me` does not consult it when a current
  Privy access token is valid.
- Bootstrap requires `X-Loop-Contract-Version: 2.0`, a bounded semantic client
  version, `ios|android`, a canonical UUIDv4 installation ID, and a canonical
  UUIDv4 idempotency key. Duplicate raw security headers are rejected before
  Privy verification or persistence.
- Bootstrap idempotency uses digest version
  `device_session_bootstrap_v1`. Its SHA-256 domain binds operation, device,
  platform, client version, and contract version. A replay returns the original
  active creation projection even if that session was subsequently revoked.
- Account get-or-create, session creation, and the created event commit in one
  PostgreSQL transaction. A session/idempotency/event failure cannot leave a
  newly registered LOOP account behind.
- Creation is bounded before persistence: at most 20 new sessions per owner in
  a rolling 24 hours and 5 per owner/device pair in a rolling 24 hours. An exact
  idempotent replay is checked before these limits and remains available.
  There is no permanent active-session limit before a self-service device
  management route exists. Exhaustion returns `RATE_LIMITED`.
- `lastSeenAt` in this first slice is the original bootstrap observation time,
  not a continuous activity/presence signal. Device-management activity and
  retention policy belong to a later independently reviewed module.

### Logout

- `POST /v2/session/logout` requires the same mobile metadata plus the opaque
  `X-Loop-Session-ID` and a new UUIDv4 idempotency key.
- Logout digest version `device_session_logout_v1` binds the requested session,
  device, platform, client version, and contract version.
- Successful logout monotonically changes the owner-bound projection to
  `revoked`. The response sets `providerLogoutRequired: true`; the client must
  then call the Privy SDK logout operation.
- Missing and foreign-owner sessions have the same `SESSION_NOT_FOUND` result.
  That terminal result is durably bound to its idempotency key, so a retry does
  not re-evaluate or disclose whether the target later exists.
- New logout commands are bounded to 40 per owner and 5 per requested session
  in a rolling 24 hours. Exact-key replay is resolved before quota evaluation;
  both successful revocations and non-enumerating not-found results consume the
  quota. This limits attacker-controlled permanent command growth while a
  reviewed archive/tombstone retention design remains future work.

### Persistence and concurrency

- `device_sessions`, `device_session_commands`, and `device_session_events`
  retain owner binding, explicit digest versions, request correlation, terminal
  outcomes, and append-only lifecycle evidence without storing Provider tokens
  or raw Provider identity.
- Transaction-scoped advisory locks serialize bootstrap/logout idempotency
  keys. Owner/session row locks then enforce capacity and a single revocation
  timestamp. Immutable triggers prevent rebinding keys, digests, owners,
  devices, and terminal results.
- A logout command stores either a resolved owner-bound revoked session or a
  non-enumerating not-found terminal result. Database checks and a composite
  foreign key prevent a fabricated successful result.

## Consequences

Email, Apple, Google, and external-wallet clients share one backend contract;
the backend remains independent of how Privy authenticated the token. Session
replay, timeout, and logout outcomes are deterministic, but the App must still
manage the current Privy SDK session and obtain a fresh access token per normal
Privy behavior.

The automated implementation gate covers headers, authentication ordering,
error sanitation, idempotency, persistence, concurrency, limits, migrations,
and the frozen V1 contract. It does not prove physical-device login, Privy
account linking, provider logout, or a real Stream Chat/Video connection.

This slice is approved for bounded Development integration, not production
enablement or an indefinitely unprotected public environment. The owner/device
limits bound one verified account's durable growth, but they are not a Sybil
control because an attacker can obtain multiple Privy subjects. Before a
production rollout, and before leaving the Development endpoint broadly exposed
for an extended period, deployment must add a verified Cloudflare or application
control-plane quota with IP, Provider-subject, and global windows. Subjects must
be domain-separated HMACs rather than raw IPs or Privy identifiers. The gate also
requires alerting and a concurrency/load test; it cannot be satisfied by the
per-owner database limits alone.

## Rollback

The migration can be rolled back only while all three new relations are empty.
Once session audit data exists, rollback refuses destructive deletion. The V2
route slice can be disabled with `V2_SESSION_ENABLED=false` without weakening
Privy authentication or changing any V1 route.
