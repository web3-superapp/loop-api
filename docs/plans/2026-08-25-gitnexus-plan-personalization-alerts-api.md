# GitNexus Engineering Plan

> Task: Implement the approved LOOP Profile, Watchlist, and Alerts backend interfaces before mobile integration.
> Planning depth: Standard. Evidence verified at commit `70db59a873d0662103c125784865a3d51ab64c4b`; local GitNexus CLI 1.6.9 reports the index current at that commit, while the MCP repository context still reports stale metadata. Graph findings are therefore navigation-only and every implementation decision is source-weighted.
> Evidence provenance schema 2; global dirty digest `0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd`; cited-path manifest 17 sorted entries; exact generated plan path excluded.

## 1. Objective

Add a backend-owned, PostgreSQL-persistent application-preference slice for the current authenticated LOOP user:

- Profile presentation fields and privacy preferences.
- A grouped, ordered Watchlist with deterministic whole-snapshot reconciliation.
- Inactive price-alert definitions, notification preferences, and truthful alert history reads.

Every route must use the existing current Privy Bearer boundary, derive the opaque LOOP owner server-side, publish an exact Fastify/OpenAPI contract, and preserve no-store/sanitized errors. This slice deliberately does not implement a social graph, follow/block relationships, copy-trading authorization, a price evaluator/scheduler, Firebase delivery, a notification inbox, or provider claims.

## 2. Current Behaviour

- [verified] The runtime exposes 23 canonical operations across health, bootstrap, Stream token boundaries, Hyperliquid private reads/intents/Agent authorization, and closed Privy transfer boundaries; Profile, Watchlist, Alerts, and Push still have no current path or owner (`README.md:7-66`, `docs/api-inventory.md:205-207`).
- [verified] `buildApp` is the composition root for the PostgreSQL database, authentication hook, feature services, route registration, OpenAPI, request IDs, no-store headers, and sanitized errors (`src/app.ts:158-469`).
- [verified] Protected routes verify the Privy access token on each request, resolve an existing internal user, and expose only a server-derived `AuthenticatedLoopPrincipal`; an unbootstrapped verified user receives `bootstrap_required` (`src/core/http/authentication.ts:25-188`).
- [verified] PostgreSQL readiness is locked to migration `000004_agent_authorizations` and eleven required relations; `Database` currently composes internal-user, control-plane, Perp-intent, and Agent-authorization repositories (`src/database/schema.ts:1-17`, `src/database/database.ts:13-151`).
- [verified] The historical application contract recorded `alias`, opaque `avatar_ref`, privacy visibility, ordered asset keys, decimal-string alert definitions, notification preferences, and delivery references, but its runtime is explicitly historical and disabled (`contracts/app-integrations-p0/contract.json:55-117`, `AGENTS.md:42-45`).
- [verified] Historical provider-selection guidance forbade silently inventing a custom social graph, Watchlist store, notification inbox, scheduler, or delivery core before an ownership decision (`contracts/integration-catalog/README.md:24-26`). The user has now authorized LOOP/PostgreSQL ownership for the three local data groups, so a numbered decision is required before implementation.

## 3. Relevant Architecture

- [verified] Repository boundaries require `src/app.ts` composition, versioned routes as OpenAPI truth, narrow feature services, append-only migrations, and behavior tests with behavior code (`AGENTS.md:39-57`).
- [verified] Provider secrets and Privy refresh tokens never enter these DTOs, persistence, logs, fixtures, or Git; user ownership is always the internal UUID derived after current token verification (`AGENTS.md:18-23`).
- [verified] The existing system treats the LOOP user UUID as the durable account key and keeps mutable presentation data separate from provider/wallet identity (`docs/product-decisions.md:21-35`).
- [verified] Existing PostgreSQL repositories validate both inputs and returned rows with strict Zod schemas, execute parameterized SQL, expose domain errors, and are composed behind the `Database` interface (`src/database/database.ts:49-151`).
- [verified] Existing route tests prove strict input rejection before authentication, owner derivation, no-store/request-id headers, and stable error mapping; OpenAPI is deterministically regenerated and drift-checked (`test/openapi.test.ts:1-240`, `package.json:11-35`).

The intended path is:

`Fastify schema/strict parser -> current Privy Bearer -> server-derived LOOP principal -> feature service -> owner-bound PostgreSQL repository -> canonical response`.

There is no provider adapter in this slice. Price facts, scheduling, and delivery remain separate future boundaries.

## 4. GitNexus Findings

- [graph] A query for owner-bound PostgreSQL CRUD located `buildApp`, `createPostgresDatabase`, `createPostgresAgentAuthorizationRepository`, and current route/service/integration tests as the reusable runtime patterns. Historical `server/app-integrations-p0` symbols were treated only as contract provenance.
- [graph] `context(buildApp)` identified seven direct dependents: server startup, OpenAPI rendering, bootstrap/Stream/app test builders, and their files. `impact(buildApp, upstream, maxDepth=2, includeTests=true)` reported HIGH risk with ten impacted symbols because this is the shared composition root.
- [graph] `context(createPostgresDatabase)` identified `buildApp` plus three PostgreSQL integration suites as direct callers. `impact(..., maxDepth=2, includeTests=true)` reported HIGH risk with eleven impacted symbols.
- [graph] `context(requireAuthenticatedLoopPrincipal)` confirmed that all existing protected route groups call the same principal assertion after the shared authentication hook.
- [graph] The local CLI reports the index current at `70db59a`, but the MCP repository context advertises older statistics. The plan therefore uses graph results only to locate seams and source/tests to verify every claim.

Direct dependent accounting:

| Changed shared symbol | Required protection |
| --- | --- |
| `buildApp` | Preserve its public signature/default production composition; run app, bootstrap, Stream, OpenAPI, and all route tests. |
| `createPostgresDatabase` / `Database` | Add repositories without changing `ping`/`close`; update every test fake and all PostgreSQL suites. |
| `requiredDatabaseRelations` / `latestMigrationName` | Append exactly one migration, update readiness and the exact schema contract test. |
| `ApiErrorCode` | Add only stable local-resource errors and verify global serialization remains unchanged. |

## 5. Statement-Level PDG Findings

- [graph limitation] `pdg_query(repo="loop-api", target="buildApp", mode="controls")` returned no rows because this index has no PDG layer. Refreshing with `--pdg` was not used: the available CLI does not expose the typed runner-provenance/status contract required by the planning skill.
- [verified] Strict body/query/header validation must stay before `authenticateLoopBearer`; authentication must stay before any owner-bound repository call (`src/core/http/authentication.ts:122-188` and existing route patterns).
- [verified] Database readiness checks the migration head and every required relation inside `ping`; a missing new relation must keep `/health/ready` down without leaking the driver error (`src/database/database.ts:125-146`).
- [verified] Optional API docs registration is independent of business route registration, so adding routes must work identically with docs enabled or disabled (`src/app.ts:388-416`).

Planning consequence: route tests will assert call ordering, and repository integration tests will assert owner isolation, transactions, optimistic concurrency, idempotent replay, and schema constraints. No security conclusion depends on PDG output.

## 6. Proposed Changes

### 6.1 Ownership and API decision

Create `docs/decisions/0009-personalization-alerts-api.md` and update the current product/API inventory. Decision 0009 explicitly selects LOOP PostgreSQL as system of record for these app-local fields only:

- Profile: mutable alias and opaque `avatar_ref`.
- Privacy: `discoverable` plus `copy_trade_visibility` as a display/preference value, never trading authorization.
- Watchlist: user-defined group keys/names and ordered asset-key references.
- Alerts: inactive definitions, fixed notification preferences, and read-only triggered-event history.

This decision supersedes the historical provider-selection default-deny only for those records. It does not authorize a social/relationship graph, market-price truth, evaluation scheduler, delivery outbox, Firebase/FCM, or notification inbox.

Canonical new operations:

| Domain | Method and path | Semantics |
| --- | --- | --- |
| Profile | `GET /v1/profile` | Return the current owner’s stored presentation projection or an explicit version-0 default. |
| Profile | `PUT /v1/profile` | Full replacement using `expected_version`; retrying an already-applied identical state succeeds. |
| Privacy | `GET /v1/profile/privacy` | Return owner-only preferences or private version-0 defaults. |
| Privacy | `PUT /v1/profile/privacy` | Full replacement using `expected_version`; values do not grant copy-trading rights. |
| Watchlist | `GET /v1/watchlist` | Return grouped ordered asset references plus collection version. |
| Watchlist | `PUT /v1/watchlist` | Atomically replace the entire normalized snapshot with optimistic conflict protection. |
| Alerts | `GET /v1/alerts` | List the owner’s non-deleted inactive definitions with bounded offset pagination. |
| Alerts | `POST /v1/alerts` | Idempotently create one inactive definition; require a lowercase UUID `Idempotency-Key`. |
| Alerts | `GET /v1/alerts/{alert_id}` | Return one owner-bound non-deleted definition. |
| Alerts | `PUT /v1/alerts/{alert_id}` | Full replacement using `expected_version`, with identical-retry success. |
| Alerts | `DELETE /v1/alerts/{alert_id}` | Soft-delete with required `expected_version`; already absent/deleted is a non-enumerating 204. |
| Alerts | `GET /v1/alerts/history` | Return only persisted real trigger facts; empty means no events, never demo data. |
| Preferences | `GET /v1/notification-preferences` | Return all fixed event preferences, disabled by default, plus delivery capability unavailable. |
| Preferences | `PUT /v1/notification-preferences` | Atomically replace the fixed preference set using `expected_version`. |

### 6.2 Append-only PostgreSQL model

Append `migrations/000005_personalization_alerts.ts`; never edit migrations 000001-000004.

- `user_profiles`: one optional row per LOOP user, nullable alias/avatar reference, integer record version, timestamps.
- `privacy_preferences`: one optional row per LOOP user, fail-closed defaults, visibility enum, integer record version, timestamps.
- `watchlist_versions`: one row per owner to serialize whole-snapshot updates.
- `watchlist_groups`: owner/group-key rows with a bounded Unicode display name and unique position.
- `watchlist_items`: owner/group/asset rows with unique in-group position and cascading group cleanup.
- `price_alert_definitions`: server UUID, owner, create-idempotency binding/digest, exact inactive definition, soft-delete timestamp, record version, timestamps.
- `notification_preference_versions` and `notification_preferences`: one version row plus a fixed event-type set per owner.
- `price_alert_events`: append-only sanitized source/fact/decimal projection for future evaluators; the public API gets no writer.

Use database constraints for owner foreign keys, canonical asset/group/event codes, bounded text, exact condition/visibility enums, non-negative canonical decimal strings, position uniqueness, versions, timestamps, and soft-delete consistency. Extend the existing `idempotency_records` digest-version allowlist for `price_alert_create_v1`; bind every created alert to the owner, idempotency record, and request digest in one transaction.

Update `latestMigrationName` and every required relation so readiness fails closed when the migration is incomplete. Add three narrow repositories to `Database`: profile/privacy, Watchlist, and Alerts/preferences/history.

### 6.3 Profile and privacy service

Implement strict contracts under `src/features/profile/` and routes under `src/routes/profile.ts`.

- Alias is nullable, trimmed, 1-40 Unicode code points when present, and rejects control/bidirectional-control characters. It is mutable display data, not a unique login or trusted identifier.
- `avatar_ref` is nullable and must remain an opaque `avatar:` reference matching the historical allowlist; arbitrary URLs, signed URLs, data URLs, wallet/provider identifiers, and nested values are rejected.
- Version-0 defaults are returned without causing a write. First successful PUT creates version 1; later replacements increment exactly once.
- Privacy defaults are `discoverable=false` and `copy_trade_visibility=private`. Supported visibility values are `private`, `followers`, and `public`, but the field is only a preference/projection; follower graphs and copy execution remain absent.
- A stale `expected_version` returns `version_conflict` unless the normalized desired state already equals the current state, which makes lost-response retries deterministic.

### 6.4 Grouped ordered Watchlist

Implement `src/features/watchlist/`, `src/database/watchlist-repository.ts`, and `src/routes/watchlist.ts`.

- PUT accepts a complete array of at most 20 groups and at most 100 total items. Group keys are bounded client-chosen slugs used only inside the owner’s preference namespace; they are not authorization IDs.
- Group names are trimmed bounded display text. Asset keys use the historical uppercase canonical reference pattern and are preferences only, never proof that a market exists or is tradable.
- Array order is canonical; persisted integer positions are server-derived. Group keys are unique and each asset is unique within a group.
- The repository locks/creates the owner version row, compares a canonical snapshot, and either returns an identical already-applied state, raises `version_conflict`, or atomically replaces groups/items and increments once.
- GET returns the exact committed snapshot; no optimistic item is reported as saved before the transaction commits.

### 6.5 Alerts, preferences, and history

Implement `src/features/alerts/`, `src/database/alert-repository.ts`, and `src/routes/alerts.ts`.

- Alert conditions are exactly `above`, `at_or_above`, `below`, and `at_or_below`; thresholds remain canonical decimal strings and JavaScript numbers are rejected.
- Asset keys are opaque references. The request accepts no source/provider URL, owner, user, DID, wallet, price fact, delivery target, Firebase token, or scheduler field.
- Every definition is returned with `state=inactive`, `evaluation.state=unavailable`, and `delivery.state=unavailable`. No route activates a rule in this slice.
- POST hashes a versioned canonical request and binds it to the required UUID idempotency key. Same key/same owner/same digest returns the same resource; any other reuse returns `idempotency_conflict` before another insert.
- GET/list/update/delete are owner-bound. Updates use normalized full replacement and version comparison; deletion is soft so future genuine history remains referentially intact.
- Notification preferences cover the historical fixed event types (`price_alert_triggered`, `provider_activity_projected`, `security_notice`, `support_update`) and default to disabled. Persisting `enabled=true` records user intent only; the response still says delivery is unavailable until Firebase/provider work is composed.
- Alert history exposes bounded offset pagination over persisted `price_alert_events`. Events include only sanitized asset/condition/threshold/value, source code, opaque fact reference, and observation time. There is no public event-write route and no fixture fallback.

### 6.6 Composition, OpenAPI, documentation, and CI

- Extend `BuildAppOptions` only with optional injectable services while retaining production defaults backed by the composed database repositories.
- Register the three route modules under new `profile`, `watchlist`, and `alerts` OpenAPI tags; keep global error/no-store/request-id behavior unchanged.
- Add `version_conflict` and `alert_not_found` as stable errors; persistence failures continue to sanitize to 500.
- Regenerate `openapi/loop-api.v1.json` from runtime schemas and update the exact path/operation assertions.
- Update README, product decisions, API inventory, schema readiness tests, integration script, and CI timeout only if the measured gate requires it.
- Do not change dependencies, runtime versions, provider configuration, Cloudflare, mobile code, or Firebase configuration in this slice.

## 7. Implementation Sequence

1. Commit this plan as the clean planning baseline.
2. Add Decision 0009, migration 000005, schema readiness, repository interfaces/composition, and migration constraint tests.
3. Implement Profile/privacy contract, repository/service/routes, unit/route/PostgreSQL tests, then run targeted checks and commit.
4. Implement grouped Watchlist snapshot contract and conflict-safe repository/routes/tests, then run targeted checks and commit.
5. Implement inactive Alerts, preferences, history, idempotency, routes/tests, then run targeted checks and commit.
6. Integrate all routes in `buildApp`, regenerate OpenAPI, update docs/inventory/scripts, and run direct-dependent regression tests.
7. Run database migration against the local PostgreSQL instance, the full integration suite, contract/unit gates, static/build/OpenAPI/secret checks, Docker image builds where proportionate, and `git diff --check`.
8. Run GitNexus change detection/impact review as non-authoritative navigation evidence, fix regressions, commit the final gate, and push the existing branch only after the worktree is clean.

## 8. Test Strategy

### Profile/privacy

- Missing/malformed/duplicate Bearer and strict body/query rejection occur before verifier/repository calls.
- Version-0 defaults cause no write; first PUT creates version 1; subsequent PUT increments once.
- Same normalized retry succeeds; stale different state returns `version_conflict`.
- Owner A cannot read or mutate owner B; null clearing and invalid alias/avatar/control characters are covered.
- Privacy defaults fail closed; visibility is persisted but never treated as copy-trade authorization.

### Watchlist

- Empty defaults, grouped/order round trip, Unicode display names, and server-derived positions.
- Duplicate keys/assets, oversized groups/items, invalid asset/group keys, unknown fields, and numeric/provider facts are rejected.
- Atomic replacement rollback leaves the previous snapshot/version intact.
- Concurrent same-version different snapshots yield one commit and one conflict; an identical replay returns the committed resource.
- Owner isolation is proved with real PostgreSQL rows.

### Alerts/preferences/history

- Required lowercase UUID idempotency header is checked before authentication and storage.
- Same-key/same-digest concurrency creates one alert; cross-owner or different-digest reuse conflicts.
- Numeric/exponent/malformed decimal thresholds, provider/source/owner authority fields, invalid conditions, and expired malformed timestamps are rejected.
- Owner-bound get/list/update/delete, version conflicts, identical replay, soft deletion, and non-enumerating repeated delete are covered.
- Preferences default to all disabled, replace atomically, and continue to report delivery unavailable even when intent is enabled.
- History returns only inserted sanitized real rows in stable newest-first pages; no row means an exact empty list.

### Cross-cutting and verification

- `test/app.test.ts`: default production composition remains buildable and existing route families still register.
- `test/database-schema.test.ts`: migration head and every relation are exact.
- `test/openapi.test.ts`: all 14 new operations, security, schemas, statuses, no-store headers, and deferred routes/fields are exact.
- Existing bootstrap, Stream, Perp, transfer, worker, config, secret, and contract suites remain green.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm openapi:generate`, `pnpm openapi:check`, targeted Vitest files, `pnpm db:migrate`, `pnpm test:integration`, `pnpm check`, `pnpm secrets:check`, Docker migration/runtime builds if the full baseline remains locally available, and `git diff --check`.

Provider/device tests are explicitly not part of this backend-only gate. Firebase delivery, price evaluation, Cloudflare public smoke, and physical-phone integration remain unverified rather than passing.

## 9. Risk and Impact Analysis

- **HIGH — composition root:** `buildApp` and `Database` are shared by every route family. Keep additions narrow/optional and run all direct dependents and full suites.
- **HIGH — tenant isolation:** every row is keyed by internal user UUID; routes never accept owner identity. PostgreSQL integration tests must use two owners and hostile IDs.
- **HIGH — concurrency/data loss:** whole-snapshot Watchlist/preferences updates can overwrite offline edits. Required versions, row locks, canonical equality, and one transaction are load-bearing.
- **HIGH — false capability claims:** inactive rules and enabled notification intent must never imply a running evaluator or Firebase delivery. Capability fields, docs, and tests stay unavailable.
- **MEDIUM — idempotency scope:** alert creation reuses the shared idempotency table. Composite owner/digest binding and conflict tests prevent cross-owner replay.
- **MEDIUM — privacy/spoofing:** aliases/group names are untrusted presentation text. Length/control/bidi validation and output schemas are required; no uniqueness or authority is inferred.
- **MEDIUM — migration/readiness:** nine new relations must migrate atomically and be required by readiness; migration/schema/integration gates cover partial state.
- **LOW — pagination:** bounded offset pagination is acceptable for the initial per-owner alert limits but may later migrate to an opaque cursor without changing ownership semantics.

Rollback is forward-only: do not edit or roll back historical migrations in a shared environment. If runtime code must be reverted, leave migration 000005 applied and deploy code compatible with its additive tables; destructive `down` is for isolated local/test databases only.

## 10. Files Expected to Change

- `docs/decisions/0009-personalization-alerts-api.md` — ownership/security/persistence/closed-capability decision.
- `docs/product-decisions.md`, `docs/api-inventory.md`, `README.md` — current truthful status and exact route inventory.
- `migrations/000005_personalization_alerts.ts` — append-only schema and idempotency digest extension.
- `src/database/schema.ts`, `src/database/database.ts` — readiness and repository composition.
- `src/database/profile-repository.ts`, `watchlist-repository.ts`, `alert-repository.ts` — strict owner-bound persistence.
- `src/features/profile/*`, `src/features/watchlist/*`, `src/features/alerts/*` — contracts and services.
- `src/routes/profile.ts`, `src/routes/watchlist.ts`, `src/routes/alerts.ts` — Fastify/OpenAPI boundaries.
- `src/core/http/api-error.ts`, `src/app.ts` — stable errors and composition.
- `openapi/loop-api.v1.json` — generated artifact only.
- `test/profile-*.test.ts`, `test/watchlist-*.test.ts`, `test/alert-*.test.ts` plus app/schema/OpenAPI/integration script updates.

No dependency manifest/lockfile, environment secret, Flutter file, provider adapter, Cloudflare configuration, Firebase configuration, historical contract, or prior migration should change.

## 11. Reusable Implementation Context

```yaml
task:
  original: "可以，开始这三组接口，firebase我会继续推进"
  interpreted: "At Standard depth, implement backend-only Profile/privacy, grouped Watchlist, and inactive Alerts/preferences/history using Fastify/OpenAPI/PostgreSQL; defer Firebase delivery and price evaluation."
  category: "feature + architecture + transactional"
evidence_provenance:
  schema_version: 2
  head_commit: "70db59a873d0662103c125784865a3d51ab64c4b"
  generated_plan_path: "docs/plans/2026-08-25-gitnexus-plan-personalization-alerts-api.md"
  global_dirty_digest:
    algorithm: "sha256"
    canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
    value: "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
  cited_path_manifest:
    - {path: "AGENTS.md", state: "clean", digest: "sha256:f4a3d228effae9cef3d2ec7c55a51cec1d4fa5b4d9ee2de7a0a713ef413e34df"}
    - {path: "README.md", state: "clean", digest: "sha256:1a3a95c46ba241fd0089c4418eed1ec6740228c7e52360c2a76b52f287025d94"}
    - {path: "contracts/app-integrations-p0/contract.json", state: "clean", digest: "sha256:f90e93bda3a7ddd03d91ff5d5533541f4d0138d2925a854ea570b0caf899a981"}
    - {path: "contracts/integration-catalog/README.md", state: "clean", digest: "sha256:c5f15863b021c304bacac5e489771eba291890e106e7a6e7787441ae4e9cc636"}
    - {path: "docs/api-inventory.md", state: "clean", digest: "sha256:426dc867193107c561137b8bc9f7be8b3dd820b38997403c35f089166a58e748"}
    - {path: "docs/decisions/0003-native-api-control-plane.md", state: "clean", digest: "sha256:23056052297b386c5d06d53f095f4c2e02a044c6b6ec9cb2fb4ba61e297302f0"}
    - {path: "docs/product-decisions.md", state: "clean", digest: "sha256:4ccbf1dccf5946a9e1e8e46a7e9487430bb090888426c94716b465970708f95e"}
    - {path: "migrations/000001_create_internal_users.ts", state: "clean", digest: "sha256:2ec9adbae55fcb1edd2222d4c0d76a50b4559761e0401191e7f03885bcadbf8c"}
    - {path: "migrations/000004_agent_authorizations.ts", state: "clean", digest: "sha256:5248cedab86679837f3f60e1ad90e506fddcd857bc0083ad411af06762c59e28"}
    - {path: "package.json", state: "clean", digest: "sha256:205f8a8e9422d8749af9a773326534d8fdef339895d3a1e8a08c13cc5622c33c"}
    - {path: "src/app.ts", state: "clean", digest: "sha256:b8527ac9d026dc293515aa4609f051fcd1065b70380d1acca83fab8826f13736"}
    - {path: "src/core/http/api-error.ts", state: "clean", digest: "sha256:c8a80ddbabffe10466e5e32ef702f0d39be924447c30ed0bce9caba3c6ae87e2"}
    - {path: "src/core/http/authentication.ts", state: "clean", digest: "sha256:69d8980e65d5db401f066ef90d1f3029c1712176f468d00877d1f71fe3107903"}
    - {path: "src/database/database.ts", state: "clean", digest: "sha256:a7d5fb36e2f07f98fe88054daef90efb118873cfcd071542fd5319b4691647af"}
    - {path: "src/database/schema.ts", state: "clean", digest: "sha256:a47da5f2d665873c1eb2919c762ec4dee8258c37cc70274e16dfb56824974e9a"}
    - {path: "test/database-schema.test.ts", state: "clean", digest: "sha256:f1e0200080ef54bd0fb21a34fb1873321bf097e4a32d533651b3b54392177c41"}
    - {path: "test/openapi.test.ts", state: "clean", digest: "sha256:2b4b133c70ff9268601a0f4e13022ba8af66bfbf3fee1b69cb482787390bede5"}
primary_symbols:
  - {symbol: "buildApp", file: "src/app.ts", lines: "158-469", role: "Composition, cross-cutting HTTP, route registration and OpenAPI"}
  - {symbol: "createPostgresDatabase", file: "src/database/database.ts", lines: "49-151", role: "Pool, repositories, readiness, lifecycle"}
  - {symbol: "requireAuthenticatedLoopPrincipal", file: "src/core/http/authentication.ts", lines: "177-188", role: "Owner derivation for every protected route"}
  - {symbol: "requiredDatabaseRelations", file: "src/database/schema.ts", lines: "1-17", role: "Fail-closed migration readiness"}
related_symbols:
  - {symbol: "renderOpenApiArtifact", relationship: "CALLS buildApp", relevance: "All new schemas must deterministically render without a live database/provider"}
  - {symbol: "main", relationship: "CALLS buildApp/createPostgresDatabase", relevance: "Production defaults and graceful close must remain compatible"}
  - {symbol: "authenticateLoopBearer", relationship: "SETS authenticated principal", relevance: "No repository access before current-token verification"}
execution_path:
  - "Strict route schema/parser rejects unknown, malformed, or client-authority fields."
  - "Current Privy access token is verified and mapped to an existing opaque LOOP user."
  - "Feature service normalizes local presentation/preference data and applies version/idempotency policy."
  - "Owner-bound repository locks the version/idempotency row and commits one transaction."
  - "Route returns the strict projection with no-store and request ID; provider capabilities remain unavailable."
pdg_constraints:
  - description: "Strict validation precedes authentication and persistence."
    affected_statements: ["src/core/http/authentication.ts:122-188"]
    implementation_consequence: "Route tests assert verifier/repository zero calls for invalid input."
  - description: "Readiness validates the migration head and every required relation."
    affected_statements: ["src/database/database.ts:125-146"]
    implementation_consequence: "Migration 000005 and readiness/schema tests change together."
  - description: "No PDG layer is available for buildApp."
    affected_statements: []
    implementation_consequence: "Use source-order assertions and full direct-dependent tests; graph is non-load-bearing."
architectural_patterns:
  - {pattern: "route -> service -> repository", example_location: "src/routes/perp-intents.ts + src/features/perp/perp-intent-service.ts + src/database/perp-intent-repository.ts", usage_guidance: "Keep Fastify and pg types at their respective boundaries."}
  - {pattern: "versioned append-only migration plus exact readiness list", example_location: "migrations/000004_agent_authorizations.ts + src/database/schema.ts", usage_guidance: "Do not edit prior migrations."}
  - {pattern: "strict route behavior tests with injectable fakes", example_location: "test/perp-intent-routes.test.ts", usage_guidance: "Prove validation/auth/owner/service order and stable errors."}
files_to_modify:
  - {file: "docs/decisions/0009-personalization-alerts-api.md", symbols: ["new ADR"], intended_change: "Lock LOOP/PostgreSQL ownership and closed provider boundaries."}
  - {file: "migrations/000005_personalization_alerts.ts", symbols: ["up", "down"], intended_change: "Add profile/privacy/watchlist/alerts/preference/history relations."}
  - {file: "src/database/database.ts", symbols: ["Database", "createPostgresDatabase"], intended_change: "Compose three new repositories without changing lifecycle semantics."}
  - {file: "src/app.ts", symbols: ["BuildAppOptions", "buildApp"], intended_change: "Compose services and register fourteen routes."}
  - {file: "src/features/profile/*", symbols: ["contracts", "ProfileService"], intended_change: "Normalize and version Profile/privacy state."}
  - {file: "src/features/watchlist/*", symbols: ["contracts", "WatchlistService"], intended_change: "Normalize grouped snapshot and version conflicts."}
  - {file: "src/features/alerts/*", symbols: ["contracts", "AlertService"], intended_change: "Inactive definitions, preferences, and history."}
  - {file: "src/routes/profile.ts", symbols: ["registerProfileRoutes"], intended_change: "Four protected Profile/privacy operations."}
  - {file: "src/routes/watchlist.ts", symbols: ["registerWatchlistRoutes"], intended_change: "Two protected snapshot operations."}
  - {file: "src/routes/alerts.ts", symbols: ["registerAlertRoutes"], intended_change: "Eight protected alert/preference/history operations."}
  - {file: "openapi/loop-api.v1.json", symbols: ["generated artifact"], intended_change: "Publish exact implemented surface."}
tests:
  - file: "test/profile-routes.test.ts"
    scenarios: ["strict pre-auth validation", "defaults", "owner principal", "stable error mapping"]
  - file: "test/profile-repository.integration.test.ts"
    scenarios: ["first create", "version increment", "identical retry", "stale conflict", "owner isolation"]
  - file: "test/watchlist-routes.test.ts"
    scenarios: ["groups/order", "limits/duplicates", "strict client authority rejection"]
  - file: "test/watchlist-repository.integration.test.ts"
    scenarios: ["atomic replacement", "concurrency", "rollback", "owner isolation"]
  - file: "test/alert-routes.test.ts"
    scenarios: ["idempotency", "decimal strings", "inactive capability truth", "CRUD/preferences/history"]
  - file: "test/alert-repository.integration.test.ts"
    scenarios: ["same-key concurrency", "cross-owner conflict", "soft delete", "preference versions", "real history paging"]
  - file: "test/openapi.test.ts"
    scenarios: ["fourteen new operations", "security/status/body exactness", "provider/push/activation fields absent"]
verification_commands:
  - "pnpm format:check"
  - "pnpm lint"
  - "pnpm typecheck"
  - "pnpm openapi:generate && pnpm openapi:check"
  - "pnpm db:migrate"
  - "pnpm test:integration"
  - "pnpm check"
  - "pnpm secrets:check"
  - "pnpm docker:build:migration"
  - "pnpm docker:build:runtime"
  - "git diff --check"
risks:
  - "Shared composition-root regression"
  - "Cross-owner data exposure"
  - "Lost-update during offline Watchlist/preferences reconciliation"
  - "Inactive alert or enabled preference falsely implying evaluator/Firebase delivery"
  - "Historical provider-selection decision being superseded too broadly"
assumptions:
  - "The user authorizes LOOP/PostgreSQL as system of record for these app-local records."
  - "Grouped Watchlists are an owner-local preference model, not a social/provider truth source."
  - "A stable inactive alert definition is useful before evaluation and Firebase delivery are implemented."
open_questions:
  - "Which price-fact authority and evaluator/scheduler will activate definitions later? This does not block inactive CRUD."
  - "Which Firebase project, exact push provider names, and device-token lifecycle will deliver notifications? This does not block preferences."
  - "What are the future export/delete retention requirements for these tables? Account deletion remains a separate authenticated workflow."
avoid:
  - "Do not import or modify server/app-integrations-p0 runtime code."
  - "Do not implement following/followers/blocklist/social graph or use privacy preference as authorization."
  - "Do not accept owner/DID/wallet/provider/source URL/Firebase token/market fact fields from clients."
  - "Do not run a price scheduler/evaluator, write fake trigger history, or claim Firebase delivery."
  - "Do not edit prior migrations or dependency pins."
  - "Do not expose raw PostgreSQL errors or loosen existing auth/log redaction."
```

## 12. Assumptions and Open Questions

### Assumptions

- [assumed] “开始这三组接口” is explicit authorization to supersede the old pending-provider ownership gate for app-local Profile/privacy, Watchlist, alert definitions/preferences/history using the already accepted Node/PostgreSQL stack.
- [assumed] Group keys, asset keys, alias, and visibility are untrusted presentation/preferences; none are authentication, wallet, market, or trading authority.
- [assumed] Firebase is being progressed separately by the user, so this backend must expose no token-registration/delivery success until that work is ready for a separate decision and integration gate.

### Non-blocking future decisions

1. Choose and credential the price-fact authority plus evaluator/scheduler before adding alert activation or trigger writes.
2. Define the Firebase project/provider names, APNs/mobile configuration, device-token lifecycle, topic strategy, delivery retries, and privacy/export/deletion policy before Push routes.
3. Decide whether social discovery, following, followers, blocklist, and follower-only copy visibility use a provider or a separately reviewed LOOP graph.
4. Define account export/delete and retention workflows before exposing destructive privacy operations.

### Explicitly deferred

- Firebase/FCM/APNs setup, device registration, push delivery, delivery outbox, and notification inbox.
- Price polling/stream ingestion, evaluation scheduling, alert activation, trigger creation, and delivery retry.
- Social discovery, follow/follower/block lists, public profile lookup, profile search, and copy-trading authorization.
- Flutter/mobile integration, Cloudflare public smoke, and physical-device evidence.
- Mainnet, withdrawals, automated trading, provider execution, or dependency/version changes.

## 13. Definition of Done

- [ ] Decision 0009 narrowly records LOOP/PostgreSQL ownership, security/privacy constraints, concurrency/idempotency semantics, and unavailable evaluator/Firebase capabilities.
- [ ] Migration 000005 is append-only, applies cleanly, constrains all nine new relations, and readiness requires the exact new head/relations.
- [ ] All 14 new protected operations are implemented with exact schemas, server-derived ownership, no-store headers, stable errors, and deterministic version/idempotency behavior.
- [ ] Profile/privacy default and replacement semantics are PostgreSQL-tested, including normalization, retries, conflicts, and tenant isolation.
- [ ] Grouped Watchlist replacement is atomic and PostgreSQL-tested under concurrency and failure.
- [ ] Alerts are inactive; preferences may persist intent but delivery remains unavailable; history contains only genuine persisted events and has no public writer.
- [ ] OpenAPI, README, product decisions, and API inventory describe the exact implemented and deferred boundaries without provider-integration claims.
- [ ] Targeted route/service/repository/migration tests and the full unit, contract, worker, PostgreSQL integration, static, build, secret, OpenAPI, Docker, and diff gates pass with exact results recorded.
- [ ] Firebase/evaluator/physical-device/Cloudflare/provider tests that were not run are explicitly unverified.
- [ ] Commits are narrow, the existing remote branch is pushed, and the final worktree is clean.
