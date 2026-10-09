# Decision 0008: Privy transfer interface remains default-closed

- Status: Accepted
- Date: 2026-08-25

## Context

Decision 0003 approved six Native Privy Bearer routes for same-chain Privy
transfers while preserving the reviewed variants and state-machine constraints
in `contracts/privy-transfer/`. The reviewed contract fixes every route, the
top-level request and response keys, four command variants, the two recipient
acknowledgement kinds, and the internal exact-replay lifecycle.

It does not define the nested asset-selection, recipient-display,
acknowledgement-list, review-handle, result-handle, or public reconciliation
state DTOs. It also does not define handle encodings or independent bounds for
the Flutter authorization signature. The authenticated server-session language
does not yet decide how a Native Bearer client with multiple devices selects a
single current result when the two status routes accept no handle or cursor.

The exact `@privy-io/node` package is installed for access-token verification,
but that does not close the transfer formatter gate. The official formatter,
Flutter signature, amount oracle, recipient resolution and screening,
Wallet-API action, failure-injection, replay, and device evidence remain
unverified. The contract explicitly requires missing credentials to fail
closed.

## Decision

- Implement the six approved route paths behind the existing current Privy
  Bearer and opaque LOOP-principal boundary.
- Require an existing bootstrap mapping on every transfer route. No top-level
  request accepts a client-selected owner, wallet, epoch, provider ID, action
  ID, submission ID, nonce, expiry, idempotency key, cursor, URL, or provider
  payload because the four exact POST variants reject every unknown key.
- GET routes accept no body or query. POST routes reject unknown top-level
  fields and accept only the reviewed `resolve`, `acknowledge`, `issue_payload`,
  and `submit_signature` variants. The recipient acknowledgement kind is only
  `first_recipient` or `history_unknown`. Every route rejects an
  `Idempotency-Key` header and the provider-owned `privy-app-id`,
  `privy-idempotency-key`, `privy-request-expiry`, `authorization-signature`,
  and `privy-authorization-signature` headers because the backend owns those
  values.
- Treat values whose wire shape is not fixed by the reviewed contract as
  unresolved. Do not invent nested DTOs, handle encodings, or signature bounds.
  Unresolved values must still be finite plain JSON and recursively reject the
  exact names in each operation's reviewed `forbidden_client_keys` list. This is
  not a claim that unreviewed aliases can be inferred before the nested DTO is
  fixed. `amount_decimal` follows the shared native invariant: a positive
  canonical decimal string, never a JSON number, with the repository-wide
  128-character input ceiling. The authorization signature is a nonempty opaque
  string; no provider encoding or independent bound is claimed. The
  formatter-envelope SHA-256 is represented as 64 lowercase hexadecimal
  characters because that representation is explicit in the reviewed contract.
- Do not publish a success response schema while the required nested projection
  is unresolved. Every otherwise valid authenticated request returns sanitized
  HTTP 503 `transfer_unavailable` with `Cache-Control: no-store`.
- The unavailable boundary executes before any wallet resolution, screening,
  formatter, signer, persistence, provider transport, polling, replay, or
  reconciliation work. It creates no preflight, review, idempotency, submission,
  result, audit, or lease record.
- Route handlers independently force the same 503 if an incorrectly injected
  service ever resolves, so adding a service return cannot silently create an
  undocumented 2xx response.
- Missing provider capability is unavailable, not a proven product or legal
  denial. These routes do not return 403 for the default-closed state.
- The historical transfer-specific exact replay remains outside the generic
  provider-operation journal and generic read-only reconciliation worker. No
  replay behavior is implemented by this interface-only slice.

## Deferred gates

A later numbered decision must fix the public nested DTOs, opaque-handle policy,
expiry and material-change rules, Native current-result selection semantics,
transfer-specific durable schema, encrypted replay storage, official formatter
and Flutter handoff evidence, provider credentials, recipient resolution and
screening, authoritative polling, and the full fenced recovery state machine.

Only after those gates close may a 2xx transfer response, durable transfer
record, formatter payload, signature submission, provider write, exact replay,
or provider-result projection be added. Route existence and unit fakes are not
evidence of a live Privy transfer integration.

## Consequences

Flutter can discover the six reserved HTTP boundaries without the backend
claiming an unresolved success contract. Invalid schema, authority, and
client-idempotency inputs are rejected before authentication or provider work;
valid inputs still prove current Privy and LOOP ownership before receiving the
stable unavailable response.

The interface is intentionally not ready for provider or device integration.
Completing the missing DTO and session decisions is a prerequisite to mobile
success-path integration, not work hidden behind the current 503 response.
