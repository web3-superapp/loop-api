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
- Every V2 write (command or compare-and-swap) accepts `X-Loop-Platform` and
  `X-Loop-Device-ID` and validates them when present (`ios|android`, canonical
  UUIDv4); the session module still requires them. Reads reject them like any
  other `X-Loop-*` header they do not expect.

Route schemas reject missing, duplicate, malformed, and unknown security-
sensitive inputs. The server still generates a new request ID for every replay.

## Idempotency and writes

- One idempotency key is permanently bound to the authenticated owner, route,
  operation kind, canonical request digest, client contract version, and any
  immutable intent/version inputs.
- The same key and identical canonical input returns the original operation or
  result. The same key with different input returns `IDEMPOTENCY_CONFLICT`.
- Versioned compare-and-swap replacements (`PUT /v2/profile`,
  `PUT /v2/profile/privacy`, `PUT /v2/settings`,
  `PUT /v2/launch/projects/{id}`, and any later
  `expectedVersion` resource) do not
  accept an `Idempotency-Key`: they are idempotent through `expectedVersion`
  (an identical retry returns the committed resource, a stale version is
  `VERSION_CONFLICT`), and a client-supplied key is rejected with
  `INVALID_REQUEST` so a lost-response retry is never mistaken for a durable
  command replay (main-agent ruling, Decision 0030).
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

### Error code family

`src/core/http/v2-error.ts` exports the frozen `v2ErrorCatalog`
(Decision 0029). Every code has exactly one HTTP status, category, `retryable`
value, and `userMessageKey`; a route schema may only narrow the codes it can
return. Modules raise errors with `V2ApiError.fromCode(code)`.

| Code                          | Status | Category         | Retryable | userMessageKey                      |
| ----------------------------- | ------ | ---------------- | --------- | ----------------------------------- |
| `ACCOUNT_BOOTSTRAP_REQUIRED`  | 409    | `authentication` | no        | `errors.account.bootstrapRequired`  |
| `ALIAS_BLOCKED`               | 422    | `validation`     | no        | `errors.alias.blocked`              |
| `ALIAS_RESERVED`              | 422    | `validation`     | no        | `errors.alias.reserved`             |
| `AUTH_INVALID`                | 401    | `authentication` | no        | `errors.auth.invalid`               |
| `AUTH_REQUIRED`               | 401    | `authentication` | no        | `errors.auth.required`              |
| `AUTH_STEP_UP_REQUIRED`       | 403    | `authentication` | no        | `errors.auth.stepUpRequired`        |
| `CAPABILITY_UNAVAILABLE`      | 503    | `availability`   | yes       | `errors.capability.unavailable`     |
| `CHAIN_MISMATCH`              | 422    | `validation`     | no        | `errors.chain.mismatch`             |
| `DATA_STALE`                  | 409    | `stale`          | no        | `errors.data.stale`                 |
| `IDEMPOTENCY_CONFLICT`        | 409    | `conflict`       | no        | `errors.idempotency.conflict`       |
| `INDEXING_DELAYED`            | 503    | `availability`   | yes       | `errors.indexing.delayed`           |
| `INSUFFICIENT_BALANCE`        | 409    | `conflict`       | no        | `errors.balance.insufficient`       |
| `INTERNAL_ERROR`              | 500    | `internal`       | no        | `errors.internal`                   |
| `INVALID_REQUEST`             | 400    | `validation`     | no        | `errors.request.invalid`            |
| `MAINTENANCE`                 | 503    | `availability`   | yes       | `errors.service.maintenance`        |
| `NOT_FOUND`                   | 404    | `validation`     | no        | `errors.resource.notFound`          |
| `PERMISSION_DENIED`           | 403    | `authorization`  | no        | `errors.permission.denied`          |
| `POLICY_BLOCKED`              | 403    | `authorization`  | no        | `errors.policy.blocked`             |
| `PROFILE_ACTIVATION_REQUIRED` | 409    | `conflict`       | no        | `errors.profile.activationRequired` |
| `PROVIDER_DISCONNECTED`       | 503    | `availability`   | yes       | `errors.provider.disconnected`      |
| `QUOTE_EXPIRED`               | 409    | `stale`          | no        | `errors.quote.expired`              |
| `RATE_LIMITED`                | 429    | `rateLimit`      | yes       | `errors.rateLimit.exceeded`         |
| `REGION_BLOCKED`              | 403    | `authorization`  | no        | `errors.region.blocked`             |
| `RESOURCE_CONFLICT`           | 409    | `conflict`       | no        | `errors.conflict.resource`          |
| `REQUEST_TIMEOUT`             | 503    | `availability`   | yes       | `errors.request.timeout`            |
| `SESSION_NOT_FOUND`           | 404    | `validation`     | no        | `errors.session.notFound`           |
| `SIMULATION_FAILED`           | 409    | `conflict`       | no        | `errors.simulation.failed`          |
| `SUBMISSION_UNKNOWN`          | 409    | `conflict`       | no        | `errors.submission.unknown`         |
| `VALIDATION_FAILED`           | 422    | `validation`     | no        | `errors.validation.failed`          |
| `VERSION_CONFLICT`            | 409    | `conflict`       | no        | `errors.version.conflict`           |

`ALIAS_RESERVED` and `ALIAS_BLOCKED` (Decision 0030) are alias-policy
rejections for V2 profile writes; the client shows the specific message and
never retries the same alias.

`RESOURCE_CONFLICT` (Decision 0031) means an immutable, caller-chosen
identifier is already taken by another resource (today: a community `slug`).
It is a conflict, not a shape failure, so the client asks the user for a
different value rather than retrying the same one.

`PROFILE_ACTIVATION_REQUIRED` (Decision 0031) means the account is
bootstrapped but has no activated V2 profile, so it has no public identity to
project into a community or the social graph. The client sends the user to
`loop-id-setup` (`POST /v2/profile/loop-id`) and retries afterwards; it is
never a Provider or availability failure.

`SUBMISSION_UNKNOWN`, `QUOTE_EXPIRED`, and `DATA_STALE` are never retried
blindly: the client reconciles through the module's status endpoint or fetches
fresh inputs. `AUTH_STEP_UP_REQUIRED` means the Bearer token is valid but the
operation needs a stronger, module-defined authentication step.

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
- Amount, price, and threshold request fields must be sent as JSON strings.
  A JSON number in such a field is `INVALID_REQUEST`: a route-level
  `preValidation` hook (`assertDecimalStringFields`) refuses it before AJV
  type coercion runs, so the number form is never silently accepted
  (main-agent ruling, Decision 0034; `POST /v2/alerts` tests a number, and a
  36-digit string that survives unchanged).

## Lists, cursors, and search

- Lists have an explicit maximum `limit` and use opaque, owner/route/filter-bound
  cursors from `src/core/http/v2-cursor.ts` keyed by `V2_CURSOR_HMAC_SECRET`.
  A cursor cannot be replayed across accounts, routes, or filters, expires
  after 600 seconds, and is `CAPABILITY_UNAVAILABLE` when the secret is absent.
- The `filter` string bound into a cursor must be the module's canonical form:
  deterministic key order (sorted), normalized values, no whitespace, and the
  same string on encode and decode. A module that builds it from raw query
  order will reject its own cursors.
- `InvalidV2CursorError` (malformed, foreign, expired, or tampered cursor) is
  a client input error: the route maps it to `INVALID_REQUEST`; it is never
  surfaced as `INTERNAL_ERROR` or retried.
- New public resource IDs are generated and validated with
  `src/core/ids/opaque-id.ts` (canonical lowercase UUIDv4).
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
- `versionGate` and `termsGate` are discriminated unions on
  `status: "available" | "unavailable"`. They become `available` only from the
  complete fail-closed configuration in Decision 0029
  (`V2_CLIENT_POLICY_*`, `V2_TERMS_REQUIRED_VERSION`); a partial version policy
  is a startup error, never a half-published gate. Configuring any gate also
  requires `V2_CLIENT_POLICY_CONFIG_VERSION` and
  `V2_CLIENT_POLICY_EFFECTIVE_AT`; while `effectiveAt` is still in the future
  the configured gates report `unavailable` with
  `reasonCode: POLICY_NOT_YET_EFFECTIVE` (evaluated per request). `regionGate` stays
  `unavailable` until a server-side region determination source is selected.
  Unavailable is not approval.
- An available version gate carries two per-platform floors: below
  `forceUpdateBelow` the client must update before continuing; between that
  and `minimumSupportedVersions` it shows a dismissible prompt. The client
  compares its own version; the endpoint accepts no input.
- `configVersion` and `effectiveAt` on the client policy are the current policy
  snapshot from configuration and must not be pinned by consumers.
- A capability's `availability` describes the selected backend route/configuration
  state. Its `evidence` field separately records whether required external or
  physical-device evidence is still pending.
- `available` does not mean production-integrated. The stricter integration and
  release gates in repository decisions still apply.
- Deferred Community, BSC, Wallet, Swap, Send/Approvals, Launch, Mining, push,
  Pay, Bridge, DApp execution, and Community AI capabilities must remain visible
  as deferred/unavailable; a fixture cannot change their state.

## Module registry and feature gate

- `src/routes/v2/index.ts` is the only V2 registration point;
  `registerV2Routes(app, deps)` is called once by `buildApp`. Meta and session
  routes are always registered.
- `V2_MODULES_ENABLED` is a comma-separated subset of `community`,
  `communication`, `search`, `market`, `chain`, `wallet`, `swap`,
  `sendApprovals`, `launch`, `mining`, `referral`, `notifications`,
  `profile`, `watchlist`, `security`, `settings`, `support`. Unknown or
  duplicate IDs fail startup. A module not listed is not registered even
  if its code exists.
- Each module ships a registrar in `v2ModuleRegistrars` with its own decision.
  Until then the entry is `null`: enabling the module registers no route and
  moves its capability from `deferred` to `unavailable` with
  `reasonCode: MODULE_RUNTIME_NOT_REGISTERED`. Module → capability:
  `community→community`, `wallet→walletRead`, `swap→privySwap`,
  `sendApprovals→sendApprovals`, `launch→launch`, `mining→mining`,
  `notifications→pushNotifications`, `profile→profile` (delivered by
  Decision 0030; `available` only when the module is enabled and its
  repository is composed), `search→search` (delivered by Decision 0031).
  `community` and `search` are `available` only when the module is enabled and
  `buildApp` composed both the PostgreSQL community repository and the
  `cursorCodec`; `search` additionally needs the shared public-search quota.
  `security→security`, `settings→settings`, `support→support` (Decision 0037):
  `security` needs the session runtime (device-session repository plus Privy
  credentials), `settings` the account-settings repository, `support` the
  support-ticket repository and the `cursorCodec`. The six Privy security
  methods (MFA, passkey, recovery password, automatic recovery, social
  recovery, key export) are not capabilities here; `GET /v2/security/capabilities`
  reports each as `unavailable` with pending evidence.
  `market` gains a capability entry with its module after consumer review.
  `launch→launch`, `mining→mining`, and `referral→referral` are delivered by
  Decision 0036: `available` when the module is enabled and its repository
  is composed, with `evidence` always `pending`
  (`LAUNCH_CONTRACT_BASELINE_PENDING` / `MINING_FORMULA_BASELINE_PENDING`)
  because the contract and formula baselines do not exist.
  `communityMining` and `communityPresence` are not module-gated and stay
  `unavailable` (`MINING_FORMULA_BASELINE_PENDING`,
  `STREAM_PRESENCE_NOT_CONNECTED`), as does `avatarUpload`
  (`AVATAR_STORAGE_NOT_SELECTED`).
- Module registrars receive shared dependencies (config, authentication hooks,
  session service, and the optional `cursorCodec`) and never compose their
  own authentication or cursor boundary.

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
