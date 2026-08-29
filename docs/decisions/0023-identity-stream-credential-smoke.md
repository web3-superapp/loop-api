# Decision 0023: Privy-to-Stream credential smoke runner

- Status: Accepted
- Date: 2026-08-29

## Context

The Privy Bearer boundary, idempotent bootstrap mapping, Stream Chat and Video
token routes, official Stream issuer, and persistent issuance quotas are all
composed in the Development runtime. Offline and PostgreSQL tests cover their
contracts, and the configured Stream key/secret pair passes an authenticated
read-only App lookup. The remaining backend evidence requires one current
physical-phone Privy access token to exercise the deployed route chain.

An access token must not be pasted into chat, placed in a command argument or
environment variable, written to a file, emitted in terminal output, or exposed
through an HTTP redirect. The smoke runner also receives Stream user tokens in
successful responses, so response bodies and provider credentials need the same
non-disclosure treatment.

## Decision

- Add the Development-only `pnpm identity-stream:smoke` operator command. It
  accepts no command arguments and obtains exactly one current Privy access
  token from standard input. Interactive terminal input is hidden; piped input
  is bounded and is never echoed.
- Reject empty, oversized, whitespace-bearing, or non-JWT-shaped input before
  network work. The token exists only in process memory for the duration of the
  run and is not cached, persisted, or installed in `process.env`.
- Read the target from `PUBLIC_BASE_URL`. Permit plaintext HTTP only for a
  literal `127.0.0.1` or `::1` loopback origin and permit the remote Development
  target only at `https://api-dev.quant-dinger.cc`. Reject credentials, query
  strings, fragments, non-root base paths, other schemes, and other remote
  origins.
- Fail before reading the token when `NODE_DEBUG` is non-empty or
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. Node HTTP diagnostics can disclose
  authentication headers, and disabled TLS verification would invalidate the
  fixed HTTPS-origin guarantee.
- Send four sequential Bearer requests: bootstrap twice, Chat token once, and
  Video token once. Disable redirects, apply an independent ten-second timeout,
  require `Cache-Control: no-store`, and cap each JSON response body at 32 KiB.
  The command uses explicit private Node HTTP/HTTPS agents rather than
  environment-proxy-aware global clients. Never print a response body,
  Authorization header, LOOP/Privy/Stream user ID, API key, or issued token.
- Require both bootstrap responses to contain the same opaque LOOP UUID and
  matching server-derived Stream user ID. Require both token responses to use
  that Stream user ID and one API key, and require each JWT to contain only the
  reviewed HS256 header plus `user_id`, positive whole-second `iat`/`exp`, an
  exact 3600-second lifetime, a canonical 32-byte HS256 signature segment, and
  an `expires_at` value matching `exp`.
- Interactive mode emits one fixed hidden-input prompt followed by one fixed
  pass line on success. Failures emit one stable, sanitized reason code and
  never include caught error text, HTTP bodies, URL query data, request IDs,
  credentials, tokens, or provider payloads. Terminal close and catchable
  termination signals restore the previous raw-mode state before failure.
- This command proves the deployed backend credential chain only. It does not
  prove Flutter login behavior, Stream Chat or Video connection, reconnect,
  refresh, logout, channel permissions, call capabilities, or physical-device
  media behavior.

## Consequences

The first credentialed Privy-to-Stream backend gate can be run without creating
a tracked fixture or asking an operator to disclose a bearer token to another
person. Email, Google, Apple, and external-wallet login methods continue to use
the same backend path; one method is sufficient for the first backend smoke,
while the complete login-method matrix remains a physical-device acceptance
gate.

The runner is not a monitoring endpoint and must not be scheduled. Sustained
external testing still requires ingress pre-authentication throttling,
observability, and the separate mobile Stream connection evidence recorded in
the current product decisions.

JavaScript strings cannot provide a physical heap-zeroization guarantee. This
decision guarantees that the runner does not deliberately persist, forward to
another origin, or emit the token; it does not claim protection from a
privileged debugger, compromised runtime, terminal recording, clipboard
history, or process-memory inspection.
