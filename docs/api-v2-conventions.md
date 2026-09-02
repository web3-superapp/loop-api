# LOOP API V2 conventions

Status: accepted baseline for new product routes. Decision 0026 is authoritative
for the V1 freeze and V2 product boundary.

## Contract and versioning

- New product routes use `/v2`; `/v1` remains a frozen compatibility surface.
- Public JSON fields use camelCase. Database snake_case values must be mapped in
  a repository or mapper before serialization.
- Every response schema is generated from its Fastify route and committed in
  `openapi/loop-api.v2.json`. The generated artifact must not be hand-edited.
- A breaking request, response, error, identifier, or behavior change requires a
  new major contract version and a migration period. Adding an optional response
  field still requires consumer review because clients reject unknown fields in
  security-sensitive flows.
- `contractVersion` identifies the public API contract. `configVersion`
  identifies a mutable product-policy/rule snapshot. They are not the service
  build version.

## Authentication, identity, and sessions

- Protected routes require exactly one current Privy Bearer access token.
- The backend verifies the current token on every protected request and derives
  the LOOP account server-side. It never accepts a client-selected LOOP account,
  Privy DID, Stream user ID, or wallet owner.
- A LOOP session is a server-side device/audit projection. It does not replace
  Privy authentication and is not a second long-lived bearer credential.
- `accountId`, `sessionId`, `walletId`, and all public resource IDs are opaque.
  Wallet addresses, aliases, tickers, phone/email values, and Provider subjects
  are not identity or authorization keys.
- A LOOP account may have multiple wallets. Wallet replacement or unlinking does
  not replace the account, social graph, or Stream identity.

## Headers and correlation

Every response returns:

- `X-Request-ID`: a new server-generated UUID for the HTTP call;
- `Cache-Control: no-store` for account, policy, capability, Provider, and other
  operational responses.

A client-supplied request ID is never trusted as the server correlation ID.
`correlationId` in an error body equals the response `X-Request-ID`.

Every V2 write requires:

- `Authorization: Bearer <current Privy access token>` when the operation is
  account-scoped;
- `Idempotency-Key`: one canonical lowercase UUIDv4 generated for the logical
  operation;
- `X-Loop-Client-Version`: the calling application semantic version;
- `X-Loop-Contract-Version: 2.0`;
- `X-Loop-Platform: ios|android` for a mobile operation.

Route schemas reject missing, duplicate, malformed, and unknown security-
sensitive inputs. The server still generates a new request ID for every replay.

## Idempotency and writes

- One idempotency key is permanently bound to the authenticated owner, route,
  operation kind, canonical request digest, client contract version, and any
  immutable intent/version inputs.
- The same key and identical canonical input returns the original operation or
  result. The same key with different input returns `IDEMPOTENCY_CONFLICT`.
- A timeout or lost response does not authorize a blind replay with a new key.
  The client uses the operation/status endpoint named by that module or the
  exact-key replay explicitly defined by a synchronous module such as D1
  bootstrap/logout.
- A Provider write is attempted at most once unless an exact Provider contract
  proves a safe idempotent retry. Unknown submission becomes a durable unknown
  or reconciling state; it is never presented as success.
- Authorization, eligibility, current wallet, policy, expiry, and immutable
  digest are rechecked at the module's final write-start boundary.

## Errors

Every V2 error body has exactly these fields:

```json
{
  "code": "CAPABILITY_UNAVAILABLE",
  "category": "availability",
  "retryable": true,
  "userMessageKey": "errors.capability.unavailable",
  "correlationId": "00000000-0000-4000-8000-000000000000",
  "detailsSafe": null,
  "providerReferenceSafe": null
}
```

- `code` is a stable uppercase machine code. UI behavior must not parse Provider
  text or `userMessageKey`.
- `category` is one of `authentication`, `authorization`, `availability`,
  `conflict`, `internal`, `rateLimit`, `stale`, or `validation`.
- `retryable` describes whether a fresh HTTP attempt may be reasonable. It never
  overrides operation idempotency or unknown-result reconciliation.
- `userMessageKey` is a localization key, not a Provider/database error message.
- `detailsSafe` and `providerReferenceSafe` remain `null` unless a module defines
  and tests a bounded non-sensitive projection. Raw response bodies, stack
  traces, URLs, calldata, signatures, tokens, addresses, and secrets are never
  copied into them.
- Authentication errors include the standard Bearer challenge where applicable.
- Validation includes unknown query/body/header fields; malformed input is not
  echoed in the response.

## Data representation

- Timestamps are server-generated RFC 3339 date-time strings with an explicit
  timezone. Rules also carry `configVersion` and `effectiveAt`.
- Monetary values, balances, prices, sizes, fees, rates, and ratios use canonical
  integer or decimal strings according to the module contract. JavaScript
  floating-point numbers are forbidden for financial values.
- Chain assets use a canonical asset ID derived from namespace, chain, and
  verified token identity. Display symbol/name/logo never joins records.
- Addresses are normalized and validated inside a chain adapter. An address is
  returned only when the product explicitly needs the public on-chain fact; it
  is never reused as an opaque LOOP ID.
- Unknown, stale, unavailable, and blocked are distinct states. Missing data is
  not converted to zero, an empty success, or a fixture.

## Lists, cursors, and search

- Lists have an explicit maximum `limit` and use opaque, owner/route/filter-bound
  cursors. A cursor cannot be replayed across accounts or filters.
- Stable ordering includes a unique tie-breaker. Page totals are omitted unless
  the authoritative source can provide a consistent value.
- Search results carry a result type, stable opaque ID, display snapshot, and
  destination. Clients do not build routes from display text or tickers.
- Nonexistent, private, blocked, and otherwise unavailable identities use the
  same non-enumerating behavior required by the module.

## Policy and capability projections

- `GET /v2/meta/client-policy` and `GET /v2/meta/capabilities` are public,
  read-only bootstrap metadata. They accept no body or query.
- Client policy establishes `community` as the post-login route and fixes the
  primary tab order to Community, Mining, Launch, Market, Wallet.
- Version, region, and terms gates report `unavailable` while their authoritative
  policy source is absent. Unavailable is not approval.
- A capability's `availability` describes the selected backend route/configuration
  state. Its `evidence` field separately records whether required external or
  physical-device evidence is still pending.
- `available` does not mean production-integrated. The stricter integration and
  release gates in repository decisions still apply.
- Deferred Community, BSC, Wallet, Swap, Send/Approvals, Launch, Mining, push,
  Pay, Bridge, DApp execution, and Community AI capabilities must remain visible
  as deferred/unavailable; a fixture cannot change their state.

## Provider and funds boundaries

- Provider secrets, Privy refresh tokens, Stream server tokens, Firebase service
  accounts, wallet keys, recovery material, and signed payloads never enter the
  public API, logs, fixtures, or Git.
- Stream remains authoritative for messages, membership, delivery/read state,
  presence, typing, calls, participants, and media state.
- Privy remains the selected wallet/signing and ordinary Swap boundary. LOOP
  does not accept arbitrary calldata, destination, spender, Provider URL, or
  client-computed authorization subject.
- BSC, USD1, PancakeSwap V3, RPC/indexer, and contract addresses remain
  unavailable until exact official-source verification and a release decision.
- Launch purchase and ordinary Swap have separate IDs, intents, idempotency
  domains, statuses, and events. Pre-graduation Launch has no approved sell or
  redemption path.
- Mainnet and every funds-moving capability remain disabled until explicit
  security, legal, Provider, reconciliation, deployment, and rollback gates are
  satisfied.

## OpenAPI verification

The generator builds V1 and V2 independently from the same application
composition code:

- V1 contains shared health plus `/v1` and retains its frozen golden bytes;
- V2 contains shared health plus `/v2` and no `/v1` or Hyperliquid compatibility
  route;
- shared `/health/*` routes are unversioned operational endpoints and retain
  their established health error schema; the V2 seven-field error contract
  applies to `/v2/*` routes;
- the runtime development document may contain both versions;
- every operation ID is unique within its artifact;
- request/response schemas reject unknown properties where the contract is
  bounded;
- contract tests verify v2 camelCase body fields, error envelopes, no-store
  headers, and absence of sensitive identifiers.
