# Decision 0029: V2 policy gates, module registry, and error code family

- Status: Accepted
- Date: 2026-09-07
- Scope: D0 closeout (S1-BE). No new business domain, table, or dependency.

## Context

Decision 0026 published `GET /v2/meta/client-policy` with every gate hard-coded
to `unavailable`. The next modules need a configuration-driven, fail-closed
version and terms gate, one V2 registration point with a per-module feature
gate, the complete 03 §13.3 error code family, and two shared primitives
(opaque cursors and opaque IDs) so that D2+ modules do not invent their own.

## Decision

### Client policy gates are configuration-driven and fail closed

`src/config.ts` owns the following keys. Blank values are treated as absent.

| Key                                                    | Rule                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `V2_CLIENT_POLICY_MIN_VERSION_IOS` / `_ANDROID`        | SemVer 2.0; required together with both store URLs                                  |
| `V2_CLIENT_POLICY_STORE_URL_IOS` / `_ANDROID`          | `https:` URL without credentials; required together with both minimum versions      |
| `V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS` / `_ANDROID` | Optional SemVer 2.0 hard floor; must not exceed the platform minimum                |
| `V2_CLIENT_POLICY_CONFIG_VERSION`                      | Optional `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; default `productPolicyV2.2026-09-01` |
| `V2_CLIENT_POLICY_EFFECTIVE_AT`                        | Optional RFC 3339 with explicit timezone, normalised to UTC; default constant       |
| `V2_TERMS_REQUIRED_VERSION`                            | Optional non-empty string (max 128)                                                 |

- **Version gate.** All four required keys valid → `versionGate.status =
"available"` with `minimumSupportedVersions`, `forceUpdateBelow`, and
  `storeUrls` per platform and `reasonCode: null`. None configured → the
  unchanged D0 `unavailable` projection (`forceUpdate: null`,
  `CLIENT_VERSION_POLICY_UNAVAILABLE`). Any partial set, malformed SemVer,
  non-https URL, hard floor without a policy, or hard floor above the minimum
  is a `ConfigurationError` at startup; the service never guesses.
- **Two floors.** A client below `forceUpdateBelow[platform]` must update
  before continuing. A client at or above the hard floor but below
  `minimumSupportedVersions[platform]` sees a dismissible update prompt. When
  no hard floor is configured both floors are the same version, so a minimum
  version alone is a hard block. The client compares its own version; the
  endpoint stays public and input-free.
- **Terms gate.** `V2_TERMS_REQUIRED_VERSION` set → `termsGate.status =
"available"` with `requiredVersion`; otherwise the unchanged `unavailable`
  projection. Whether a user has accepted that version is account state and
  belongs to a later authenticated module; the public gate only names the
  version.
- **Region gate stays `unavailable`.** No server-side region determination
  source (edge geo header, IP intelligence Provider, KYC/KYB Provider) has been
  selected, verified, or approved by legal/compliance (03 §16, §19). Until that
  decision exists the backend cannot assert `allowed` or `blocked`. The client
  must not derive region from device locale, SIM, or IP and must treat
  `unavailable` as "unknown, not approved".
- `configVersion`/`effectiveAt` on the client policy identify the mutable
  policy snapshot. Consumers must not pin them to constants. The capabilities
  projection keeps the compiled product constants; module gate changes are
  described by each capability's `reasonCode`, not by a snapshot bump.

### Contract shape

`versionGate` and `termsGate` are `oneOf` discriminated unions on `status`
(`"available" | "unavailable"`). The `unavailable` variants are byte-identical
to the D0 baseline; the `available` variants replace nullable placeholders with
required values:

```json
"versionGate": {
  "status": "available",
  "minimumSupportedVersions": { "ios": "1.4.0", "android": "1.3.2" },
  "forceUpdateBelow": { "ios": "1.2.0", "android": "1.3.2" },
  "storeUrls": { "ios": "https://…", "android": "https://…" },
  "reasonCode": null
}
"termsGate": { "status": "available", "requiredVersion": "terms-2026-09", "reasonCode": null }
```

The former `versionGate.status` value `active` and the former `termsGate`
values `accepted`/`required` are removed; they were never emitted. The
`forceUpdate: null` placeholder survives only in the `unavailable` variant for
byte compatibility and is superseded by `forceUpdateBelow` in the `available`
variant.

### Single V2 registration point and module gate

- `src/routes/v2/index.ts` exports `registerV2Routes(app, deps)`; `buildApp`
  calls it exactly once. `src/routes/v2/meta.ts` and `src/routes/v2/session.ts`
  (moved from `src/routes/v2-*.ts`) are always registered.
- `V2_MODULES_ENABLED` is a comma-separated set drawn from `community, search,
market, wallet, swap, sendApprovals, launch, mining, notifications, profile`
  (default empty). Unknown or duplicate IDs fail startup.
- `v2ModuleRegistrars` maps each module ID to its route registrar or `null`.
  All entries are `null` in this decision. An enabled module without a
  registrar registers no route, and its capability changes from `deferred` to
  `unavailable` with `reasonCode: MODULE_RUNTIME_NOT_REGISTERED` and evidence
  `notApplicable`. A module not listed is not registered even if its
  registrar exists.
- Module → capability: `community→community`, `wallet→walletRead`,
  `swap→privySwap`, `sendApprovals→sendApprovals`, `launch→launch`,
  `mining→mining`, `notifications→pushNotifications`. `search`, `market`, and
  `profile` have no capability entry yet; adding one is a consumer-reviewed
  contract change delivered with the module. `bscRead`, `pay`, `bridge`,
  `dappExecution`, and `communityAi` are not module-gated and remain deferred.
- Only a module's own delivered registrar, in its own numbered decision, may
  report `available`. The gate is not evidence of Provider, chain, or device
  readiness.

### Error code family

`src/core/http/v2-error.ts` exports the frozen `v2ErrorCatalog`. Each code has
exactly one HTTP status, category, `retryable`, localization key, and Bearer
challenge flag; routes only narrow the codes they may return.

| Code                         | Status | Category         | Retryable | userMessageKey                     |
| ---------------------------- | ------ | ---------------- | --------- | ---------------------------------- |
| `ACCOUNT_BOOTSTRAP_REQUIRED` | 409    | `authentication` | no        | `errors.account.bootstrapRequired` |
| `AUTH_INVALID`               | 401    | `authentication` | no        | `errors.auth.invalid`              |
| `AUTH_REQUIRED`              | 401    | `authentication` | no        | `errors.auth.required`             |
| `AUTH_STEP_UP_REQUIRED`      | 403    | `authentication` | no        | `errors.auth.stepUpRequired`       |
| `CAPABILITY_UNAVAILABLE`     | 503    | `availability`   | yes       | `errors.capability.unavailable`    |
| `CHAIN_MISMATCH`             | 422    | `validation`     | no        | `errors.chain.mismatch`            |
| `DATA_STALE`                 | 409    | `stale`          | no        | `errors.data.stale`                |
| `IDEMPOTENCY_CONFLICT`       | 409    | `conflict`       | no        | `errors.idempotency.conflict`      |
| `INDEXING_DELAYED`           | 503    | `availability`   | yes       | `errors.indexing.delayed`          |
| `INSUFFICIENT_BALANCE`       | 409    | `conflict`       | no        | `errors.balance.insufficient`      |
| `INTERNAL_ERROR`             | 500    | `internal`       | no        | `errors.internal`                  |
| `INVALID_REQUEST`            | 400    | `validation`     | no        | `errors.request.invalid`           |
| `MAINTENANCE`                | 503    | `availability`   | yes       | `errors.service.maintenance`       |
| `NOT_FOUND`                  | 404    | `validation`     | no        | `errors.resource.notFound`         |
| `PERMISSION_DENIED`          | 403    | `authorization`  | no        | `errors.permission.denied`         |
| `POLICY_BLOCKED`             | 403    | `authorization`  | no        | `errors.policy.blocked`            |
| `PROVIDER_DISCONNECTED`      | 503    | `availability`   | yes       | `errors.provider.disconnected`     |
| `QUOTE_EXPIRED`              | 409    | `stale`          | no        | `errors.quote.expired`             |
| `RATE_LIMITED`               | 429    | `rateLimit`      | yes       | `errors.rateLimit.exceeded`        |
| `REGION_BLOCKED`             | 403    | `authorization`  | no        | `errors.region.blocked`            |
| `REQUEST_TIMEOUT`            | 503    | `availability`   | yes       | `errors.request.timeout`           |
| `SESSION_NOT_FOUND`          | 404    | `validation`     | no        | `errors.session.notFound`          |
| `SIMULATION_FAILED`          | 409    | `conflict`       | no        | `errors.simulation.failed`         |
| `SUBMISSION_UNKNOWN`         | 409    | `conflict`       | no        | `errors.submission.unknown`        |
| `VALIDATION_FAILED`          | 422    | `validation`     | no        | `errors.validation.failed`         |
| `VERSION_CONFLICT`           | 409    | `conflict`       | no        | `errors.version.conflict`          |

- The `category` enum stays at the eight values of Decision 0026; the contract
  test fails if a ninth is introduced.
- `retryable` means a fresh HTTP attempt with the same inputs may be
  reasonable. `SUBMISSION_UNKNOWN`, `QUOTE_EXPIRED`, and `DATA_STALE` are not
  retryable: the client must reconcile or fetch new inputs first.
- `AUTH_STEP_UP_REQUIRED` is 403 without a Bearer challenge: the token is
  valid but the operation needs a stronger, module-defined authentication step.
- Frozen V1 `ApiError` values thrown inside a `/v2` request are mapped to one
  catalog code and take that code's fixed key; the previous per-V1-code keys
  (`errors.intent.*`, `errors.authorization.expired`, `errors.wallet.bindingRequired`,
  `errors.idempotency.resourceUnavailable`) are removed. `errors.internal`
  keeps its two-segment form for compatibility with the existing contract test.
- `V2ApiError.fromCode(code)` is the only constructor modules should use.

### Shared primitives

- `src/core/http/v2-cursor.ts`: AES-256-GCM + HMAC-SHA256 opaque cursor bound
  to `ownerId` (LOOP account UUID), `route` (`^[a-z][A-Za-z0-9]{0,63}$`), and a
  canonical `filter` string, with a 600 s TTL and a bounded flat continuation
  (≤16 keys, string/safe-integer/boolean values). Keyed by the independent
  `V2_CURSOR_HMAC_SECRET` (≥32 bytes); when absent `deps.cursorCodec` is `null`
  and list routes must report `CAPABILITY_UNAVAILABLE`. Domain strings differ
  from the social and Perp cursors, so keys and cursors are not interchangeable.
- `src/core/ids/opaque-id.ts`: `generateOpaqueId`, `isOpaqueId`,
  `parseOpaqueId`, and `opaqueIdPatternSource` for canonical lowercase UUIDv4
  public IDs. Existing account IDs (UUID v1–v8 from PostgreSQL) remain valid
  where their own schemas allow; new resources use v4 only.

## Consequences

- Development can now publish a real version/terms policy without a code
  change, and a misconfiguration stops the process instead of leaking a
  half-policy.
- The mobile client's current V2 meta parser (`loop_v2_meta.dart`,
  `loop_v2_meta_repository.dart`) must be updated in D0/D1 frontend work: it
  pins `configVersion`/`effectiveAt` to constants, knows only
  `active|unavailable` and `accepted|required|unavailable` gate statuses, and
  rejects the `forceUpdateBelow` key. Until it is updated it can only parse
  the unconfigured projection.
- Region policy, real store URLs, and the terms version are operator inputs
  recorded outside Git. Nothing in this decision proves a physical-device
  force-update flow.

## Rollback

Remove the new environment keys to restore the D0 unavailable projection
byte-for-byte; the OpenAPI `oneOf` still validates it. Disabling
`V2_MODULES_ENABLED` returns every gated capability to `deferred`. No
persistence was added.
