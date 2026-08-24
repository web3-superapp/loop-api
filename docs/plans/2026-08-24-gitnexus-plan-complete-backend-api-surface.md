# GitNexus Engineering Plan

> Task: Prepare every currently approved LOOP backend API before beginning mobile/device integration.
> Evidence verified at commit 466fe2b71f908979606cd70ed346ae3ecc4ea25f; GitNexus index 2 commits behind at 38e5e92b4f91a6ca2531677adfedd38411c9f8fc, refresh skipped because analyzer runner provenance is unavailable (project runner delegates to a failing npx install, CLI 1.6.9 exposes no JSON runner identity, and schema-5 index metadata has no runner identity). Graph findings are navigation-only and source-weighted.
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 21 sorted entries; exact generated plan path excluded.

## 1. Objective

Build the complete backend-only contract needed before Flutter integration, in independently verified vertical slices. “Complete” means every currently approved mobile-facing route exists in generated OpenAPI, has strict schemas, authentication, stable fail-closed errors, tests, persistence where required, and an injectable provider boundary. It does not mean a provider is live without credentials and credentialed evidence.

The approved surface is identity bootstrap, separate Stream Chat/Video token loaders, Hyperliquid Testnet private reads plus intent/status/reconciliation flows, allowlisted user-signed agent authorization, and the six reviewed Privy same-chain transfer operations. Push HTTP APIs, profile/watchlist/search/support APIs, Pay, Mainnet, deposits/withdrawals, automated trading, HIP-3, TP/SL, TWAP, builder fees, and historical prototype adapters are outside this plan until a numbered decision explicitly enables them.

## 2. Current Behaviour

- [verified] The runtime currently exposes `GET /health/live`, `GET /health/ready`, conditional `GET /openapi.json`, and `POST /v1/bootstrap`; Stream token minting, private trading, rate limiting, and production deployment are absent (`README.md:7-23`, `README.md:49-68`).
- [verified] `POST /v1/bootstrap` rejects body/query input, parses exactly one bounded raw Authorization header, verifies the Privy token on every call, creates/loads the opaque LOOP UUID, derives `stream_user_id`, and returns no-store responses (`src/routes/bootstrap.ts:1-219`).
- [verified] Fastify composition, dependency injection, OpenAPI generation, request IDs, redacted logging, health routes, and global sanitized errors live in `buildApp` (`src/app.ts:12-200`).
- [verified] Configuration currently models only core HTTP/PostgreSQL and an all-or-nothing Privy credential pair (`src/config.ts:5-162`); provider-specific capability switches and deadlines do not exist.
- [verified] PostgreSQL has only `loop_users`; `Database.ping` checks migration `000001_create_internal_users` and that one table (`migrations/000001_create_internal_users.ts:1-41`, `src/database/database.ts:12-118`).
- [verified] Existing tests prove request correlation, sanitized errors, OpenAPI 3.1, strict bootstrap authentication/input rejection, repeated token verification, and concurrent user creation (`test/app.test.ts:36-192`, `test/bootstrap.test.ts:45-379`). CI applies migrations, runs one PostgreSQL suite, then `pnpm check` (`.github/workflows/ci.yml:13-70`).

## 3. Relevant Architecture

- [verified] Repository ownership is `src/app.ts` for composition, `src/config.ts` for fail-closed configuration, `src/routes/` for versioned schemas/OpenAPI, `src/integrations/` for narrow provider adapters, `src/features/` for policy/orchestration, append-only migrations, and behavior tests (`AGENTS.md:39-51`).
- [verified] Every protected boundary must validate the current Privy token and reject client-selected internal identity, Stream identity, wallet owner, or authorization subject (`AGENTS.md:19-23`).
- [verified] Stream must remain the communication truth source; LOOP owns only server token minting and thin policy/orchestration, not Chat/RTC state (`AGENTS.md:24-26`, `contracts/stream-chat/README.md:1-3`).
- [verified] Hyperliquid private reads, signing orchestration, policy, idempotency, and reconciliation belong in this backend; all trading numerics remain decimal strings and unknown writes are never blindly replayed (`AGENTS.md:27-35`).
- [verified] Wallets are replaceable credentials bound to opaque LOOP users, never primary keys or trusted client claims (`docs/product-decisions.md:21-35`).
- [verified] Provider “integrated” status requires exact dependency/license approval, fail-closed runtime composition, credentialed sandbox/Testnet tests, observability/audit/rate-limit/privacy controls, and deployment evidence (`docs/product-decisions.md:77-90`).

The implementation pattern for every slice is:

`Fastify route schema -> authenticated LOOP principal -> feature service/policy -> narrow provider port -> repository/journal -> sanitized response`.

No provider DTO, secret, wallet/provider identifier, signature, nonce, provider wire payload, or raw error crosses the route boundary unless the canonical API inventory explicitly permits that field.

## 4. GitNexus Findings

- [graph] `query(search_query="Fastify composition configuration PostgreSQL routes authentication backend provider adapters", repo="loop-api")` located `buildApp`, `loadConfig`, `createPostgresDatabase`, current tests, and the historical adapter. The result confirms the current composition seam but comes from the stale index.
- [graph] `context(buildApp)` reports direct callers `src/server.ts:main` and `test/app.test.ts`; `impact(buildApp, upstream, maxDepth=2, includeTests=true)` reports two depth-1 dependents and LOW risk. Both must remain compatible when composition grows.
- [graph] `context(loadConfig)` plus `impact(... maxDepth=2)` reports depth-1 dependents `src/server.ts:main`, `test/app.test.ts:testConfig`, and `test/config.test.ts`; every new environment field therefore needs test defaults and secret-safe failure assertions.
- [graph] `context(createPostgresDatabase)` plus `impact(... maxDepth=2)` reports `buildApp` as the sole depth-1 caller; repository expansion should preserve `Database.close`, `Database.ping`, and injectable fakes.
- [graph] `route_map(repo="loop-api")` lists only health/OpenAPI and misses `/v1/bootstrap`, proving the two-commit staleness. Route coverage and all proposed route claims are therefore source-derived, not graph-derived.
- [graph] `clusters` contains only historical app integration, database, and test communities; `processes` is dominated by historical adapter flows. Historical `server/app-integrations-p0` symbols are explicitly non-runtime and must not guide production composition.

Direct dependent accounting:

| Changed shared symbol | Depth-1 dependents that must be tested |
| --- | --- |
| `buildApp` | `src/server.ts:main`, `test/app.test.ts` |
| `loadConfig` | `src/server.ts:main`, `test/app.test.ts:testConfig`, `test/config.test.ts` |
| `createPostgresDatabase` | `src/app.ts:buildApp` |

## 5. Statement-Level PDG Findings

- [graph] The stale PDG `pdg_query(mode="controls", target="buildApp")` found the configuration guard around OpenAPI registration. The source has since moved and added bootstrap composition, so only the invariant is retained: optional documentation must not change business route registration.
- [graph] `explain(repo="loop-api")` returned no persisted taint findings. This is not safety proof: closure/callback, property, and implicit flows are not modeled, and the index predates bootstrap.
- [verified] Source-level security ordering is load-bearing: strict request shape and raw Authorization parsing happen before provider verification, provider verification happens before internal-user lookup/create, and persistence/provider errors are sanitized (`src/routes/bootstrap.ts:78-218`). The shared authentication extraction must preserve that order.
- [verified] Source-level database ordering is load-bearing: provider identity is validated before parameterized insert/select, and readiness never exposes a database error (`src/database/database.ts:45-113`).

Planning consequence: no proposed safety decision relies on the stale PDG. Each mutation slice must add explicit tests that prove authentication, owner derivation, policy, durable intent/attempt state, and idempotency checks happen before any provider call.

## 6. Proposed Changes

### 6.1 Canonical API inventory and authentication decision

Create `docs/api-inventory.md` and `docs/decisions/0003-native-api-control-plane.md`. The inventory is authoritative for LOOP-facing paths and classifies every candidate as `implemented`, `approved-contract`, `blocked-provider`, `blocked-product-legal`, or `explicitly-disabled`. It supersedes historical browser Cookie/CSRF authentication for native routes while retaining the historical contract as provenance.

Extract bootstrap’s raw-header parser and sanitized Bearer handling into a reusable `src/core/http/privy-authentication.ts`. Add an authenticated principal service that verifies the current token, looks up an existing opaque LOOP user, and exposes only `{userId, streamUserId, privyUserId}` inside feature code. Bootstrap remains the only route that may create the user. Protected routes return `bootstrap_required` when a verified Privy identity has no LOOP mapping; they never accept owner/user/address fields as authority.

Create shared OpenAPI/error/header/decimal/cursor/idempotency schemas under `src/core/http/`. Preserve the bootstrap contract and all existing tests. Generate and version `openapi/loop-api.v1.json` from `buildApp`; CI fails if the generated artifact differs.

Canonical mobile-facing route inventory:

| Domain | Method and path | Contract state |
| --- | --- | --- |
| Health | `GET /health/live`, `GET /health/ready` | implemented |
| Identity | `POST /v1/bootstrap` | implemented |
| Stream | `POST /v1/chat/token`, `POST /v1/video/token` | approved-contract; provider may be unavailable |
| Perp config/read | `GET /v1/perp/config`, `/account`, `/positions`, `/orders`, `/fills`, `/funding` | approved-contract; Testnet/private only |
| Perp intent | `POST /v1/perp/intents`, `GET /v1/perp/intents/{intent_id}`, `POST /v1/perp/intents/{intent_id}/submit` | approved-contract; mutations default disabled |
| Agent authorization | `POST /v1/perp/agent-authorizations`, `GET /v1/perp/agent-authorizations/{authorization_id}`, `POST /v1/perp/agent-authorizations/{authorization_id}/signatures` | approved-contract; default disabled |
| Transfer | `GET /v1/transfer/assets`, `POST /v1/transfer/recipient-preflight`, `POST /v1/transfer/reviews`, `POST /v1/transfer/authorize`, `GET /v1/transfer/current-result`, `GET /v1/transfer/reconciliation` | reviewed target contract; provider/risk gates remain closed |

Push device registration, profile/privacy/watchlist/alerts/search/support, wallet selection, and generic capabilities routes remain unassigned rather than receiving guessed paths. Privy OTP/wallet creation, Stream messages/calls, and public Hyperliquid `metaAndAssetCtxs` remain direct official-SDK/provider responsibilities and are not LOOP routes.

### 6.2 Persistent control plane

Append migrations; never edit `000001`.

- `000002_api_control_plane`: `api_idempotency_records`, `provider_operations`, `audit_events`, and issuance-rate records. Store opaque IDs, internal user IDs, request/intent digests, status, non-secret provider references, timestamps, lease/fencing metadata, and sanitized outcome codes only.
- Update readiness to require the latest expected migration name and all mandatory tables, while returning only `up/down`.
- Add transaction helpers and repositories behind feature ports. Every mutation transaction creates/locks the idempotency/operation row and audit event before a provider call.
- Add `src/worker.ts` and a PostgreSQL-backed reconciliation runner. A lease selects work; it is not claimed as a signer fence. Unknown provider results remain held until an authoritative read resolves them.

Default request/provider policy recorded in ADR 0003:

- keep Fastify’s 15-second request timeout;
- provider reads use a 5-second attempt deadline and at most one retry for pre-response transport/5xx failures within the route deadline;
- provider writes use a 10-second attempt deadline, never a generic automatic retry, and timeout/connection close/post-send 429/5xx becomes `unknown`;
- the Privy transfer-specific one-time byte-identical replay is implemented only where its reviewed contract proves it safe and only before the original signed expiry;
- all tokens, signatures, formatter bytes, signed URLs, private keys, nonces, and provider secrets are excluded from persistence and logs.

### 6.3 Stream Chat and Video token loaders

Add `StreamTokenIssuer` and an unavailable implementation under `src/integrations/stream/`, a communication token service, and routes:

- Both POST routes accept exactly one Privy Bearer token and no body/query/client user ID.
- Success is exactly `{api_key, token, expires_at, user:{id}}`, with the server-derived Stream user ID and RFC 3339 expiry; every response is no-store.
- Authentication failures match the shared Bearer contract; quota returns 429; missing/partial Stream configuration returns 503; provider/internal errors are sanitized.
- TTL is 3600 seconds. Issuance is persistently rate-limited per internal user and IP. Tokens are never cached or persisted.
- Chat and Video remain separate routes even if a selected official server library produces compatible user tokens, so each mobile loader and future policy can evolve without a product discriminator supplied by the client.

Before adding a Stream server dependency, perform official-source version/license research and record the exact package/version/license in a numbered decision and attribution file. If the existing Stream license/procurement gate is not closed, ship the complete HTTP interface plus injectable fake/unavailable issuer, but do not invent JWT signing or claim Stream is integrated.

### 6.4 Hyperliquid private read/config contract

Add a strict `HyperliquidPrivateReader` port and unavailable adapter. Do not proxy public markets already read directly by Flutter. All private routes derive the current account from a server-verified Privy wallet binding; no query/body account or agent address is accepted. Until a unique eligible server-verified wallet exists, return `wallet_binding_required` without calling Hyperliquid.

- `/v1/perp/config` returns Testnet network, Core allowlist, provider-observed minimums/fees/leverage limits with source/fetched/expires timestamps, and explicit read/mutation capability states. Unknown/stale facts remain unknown/unavailable.
- `/account`, `/positions`, `/orders`, `/fills`, and `/funding` return strict immutable projections. Pagination uses bounded `limit` plus opaque server cursors. All prices, sizes, balances, fees, funding, leverage, and PnL are decimal strings; numeric JSON is rejected.
- Reads use master/subaccount addresses, never the agent address. Core BTC/ETH/SOL only; nonempty dex, spot, HIP-3, and malformed provider data fail closed.

The reviewed Hyperliquid contract currently forbids installing/importing the candidate SDK before its dependency/license/conformance gate. Therefore provider-independent routes, schemas, ports, fixtures, and failure behavior may land first; no custom HTTP/WebSocket/signing replacement is allowed.

### 6.5 Hyperliquid intent, submission, status, and reconciliation

Append `000003_perp_intents` with immutable intent/review digest fields, one server-generated provider operation UUID, internal owner, Testnet network, action kind, state, idempotency binding, non-secret cloid/oid references, timestamps, and reconciliation metadata.

`POST /v1/perp/intents` requires an `Idempotency-Key` UUID header and a strict discriminated body for `order`, `cancel`, `modify`, `batch_modify`, `update_leverage`, or `update_isolated_margin`. It rejects account, owner, agent, nonce, signature, provider wire fields, Mainnet, transfers/withdrawals, triggers/TP-SL/TWAP, builder fields, and unknown keys. It returns a server-owned intent ID, immutable canonical review, expiry, and `prepared` state.

`POST /v1/perp/intents/{intent_id}/submit` accepts no body, locks the same owner/intent/idempotency record, revalidates current wallet/account, fresh Core metadata/quote, eligibility, expiry, and unchanged digest, persists `submitting`, then calls the provider port at most once. Client timeout never authorizes another call.

`GET /v1/perp/intents/{intent_id}` is the reconciliation contract and exposes only owner-bound state: `prepared`, `submitting`, `accepted`, `partial`, `filled`, `cancelled`, `rejected`, `unknown`, `reconciling`, or `expired`, plus sanitized provider references/facts. Authoritative Info/Exchange readback outranks local state; unknown statuses remain quarantined.

All production/Testnet mutations remain behind explicit per-action kill switches and current eligibility evidence. With today’s `PENDING_default_deny` evidence, creation may return a review only if it cannot imply eligibility; submission must return a stable disabled/forbidden response before any SDK/Privy call.

### 6.6 Allowlisted user-signed agent authorization

Append `000004_agent_authorizations`. The three routes implement `issue canonical intent -> submit signature -> status/reconciliation` for Testnet `approveAgent` only:

- The server derives user/account/network/agent/expiry and exact typed-data primary type; no arbitrary typed data or URL is accepted.
- The issue response contains only allowlisted canonical typed data plus display fields/digest/expiry needed for explicit mobile review.
- Signature submission binds the exact stored digest, recovers the expected current wallet address through an official audited boundary, enforces server expiry, persists before relay, and treats ambiguous relay as unknown/no replay.
- Mainnet, transfer, withdrawal, builder approval, unknown primary types, changed fields, and expired intents are rejected.

Without a credentialed Testnet agent workflow and signature-recovery evidence, these endpoints remain implemented but disabled before issuing signable payloads.

### 6.7 Privy same-chain transfer contract

Append domain-specific migrations/repositories for opaque preflight/review/authorization/result handles, wallet epoch bindings, attempts, locks, audit history, replay material, and reconciliation leases. Implement the six exact route paths and request/response variants already reviewed in `contracts/privy-transfer/bff-contract.json:25-369` and summarized in `contracts/privy-transfer/README.md:16-48`, superseding only the authentication transport with current Privy Bearer plus internal principal.

Preserve these contract constraints:

- owner, wallet/provider IDs, epoch, provider URL/action/submission IDs, nonce, expiry, idempotency key, risk verdict, cursor, and provider payloads are never accepted from page requests;
- material input changes invalidate acknowledgement/review/signature state;
- formatter bytes are exposed only by the private `issue_payload` variant and never logged/persisted after terminal cleanup;
- the official Privy formatter/signature flow is the cryptographic authority; LOOP does not reimplement it;
- provider write state is durable before transport; ambiguous outcomes follow only the reviewed transfer-specific replay policy; second uncertainty is permanently unknown;
- current-result/reconciliation derive their cursor/records from the authenticated user and accept no handle/query/body;
- unknown Privy action statuses are quarantined and projected unavailable.

Missing wallet, resolver/screening evidence, formatter evidence, or provider credentials returns a stable unavailable response before signing/submission. The existence of routes must not be described as a live transfer integration.

### 6.8 Documentation, contract artifact, and operational verification

Update README, local development docs, product decisions, attribution, `.env.example`, CI, and Docker targets after each slice. Maintain a checked-in generated OpenAPI artifact and endpoint inventory status. Add secret scanning over Git-tracked files and a Docker image build gate. Keep provider/device credentialed suites separately named and skipped/unverified when required inputs are absent; unit fakes never count as provider evidence.

## 7. Implementation Sequence

1. **API/control-plane decision and shared auth.** Add ADR 0003 and `docs/api-inventory.md`; extract reusable strict Privy Bearer parsing/principal resolution; add shared HTTP schemas/errors; add an OpenAPI generation/check command. Preserve bootstrap byte-for-byte behavior and commit independently.
2. **Persistent control plane.** Add migration 000002, transaction/repository ports, audit/idempotency/provider-operation state, latest-migration readiness, reconciliation worker shell, and PostgreSQL integration tests. No provider SDK call yet.
3. **Stream routes.** Add Chat/Video token services, exact route schemas, quotas, unavailable/fake issuers, OpenAPI/tests, and configuration. Perform official package/license research before any real issuer dependency. Commit the stable interface even when the real issuer remains unavailable.
4. **Perp private reads/config.** Define strict DTOs/cursors/config facts, ports, unavailable/fake adapters, routes, and contract tests from reviewed provider fixtures. Enforce server-derived account and decimal strings. Do not install a forbidden SDK or proxy public markets.
5. **Perp intent and reconciliation.** Add migration 000003, intent/idempotency/audit services, routes, fake adapter tests, restart/unknown-result worker tests, per-action kill switches, and default-deny eligibility. Keep real submission disabled until provider gates close.
6. **Agent authorization.** Add migration 000004 and the canonical Testnet approveAgent issue/signature/status contract with negative tests. Keep issue/relay disabled without approved workflow and signature evidence.
7. **Privy transfer.** Add append-only transfer migrations, the six Bearer-authenticated routes, state machine, official formatter boundary, transfer-specific replay/reconciliation worker, and exhaustive state/concurrency/expiry tests. Keep provider calls unavailable when any reviewed gate is missing.
8. **Final backend contract gate.** Regenerate OpenAPI once, run every unit/integration/worker/contract test, build runtime/migration images, scan tracked bytes for credentials, verify public unconfigured behavior through Cloudflare, update inventory statuses, and push atomic commits. Mobile/device integration starts only after this gate.

Each step must stage only its intended files, run GitNexus `detect_changes(scope="staged")`, review affected flows, commit conventionally, and push. Do not bundle a half-finished provider adapter with a stable HTTP contract.

## 8. Test Strategy

### Shared authentication and HTTP

- missing, malformed, oversized, and duplicate raw Authorization headers -> stable 401 before verifier/database/provider;
- body/query/client identity injection on no-input routes -> 400 before authentication side effects;
- valid Privy identity without LOOP mapping -> `bootstrap_required`, never implicit owner creation;
- every protected call re-verifies the current access token; no access-token cache/persistence/logging;
- route errors preserve documented 400/401/403/404/409/422/429/500/503 semantics and never expose provider text;
- generated OpenAPI equals the checked-in artifact and contains no undocumented provider route.

### Persistence/control plane

- concurrent same idempotency key + same digest -> one operation and stable response;
- same key + different digest/owner -> conflict before provider;
- crash before send, after send, before response persistence, and after response persistence -> correct held/reconciliation state;
- stale worker lease cannot update after fencing token changes; lease is never treated as signer revocation;
- readiness fails until the latest migration/tables exist;
- audit payload contains no token, signature, secret, provider wire, or complete authorization payload.

### Stream

- Chat/Video routes bind the same derived Stream subject, reject all client IDs/body/query, return one-hour RFC3339 expiry, no-store, and never persist token;
- unconfigured/partial config -> startup failure or 503 exactly as decided; fake issuer success does not mark provider integrated;
- quota exhaustion -> 429 without issuer call; unexpected issuer error -> sanitized 500/503;
- token-loader retry can request a new token, but server never accepts a refresh token.

### Hyperliquid reads and intents

- private read account is server-derived and never agent/client-selected;
- decimal JSON numbers, malformed strings, stale facts, non-Core/dex-qualified coins, mismatched metadata, unknown fields/statuses -> unavailable/rejected, never zero/empty success;
- order/cancel/modify/batch/leverage/margin bodies accept only exact schemas; Mainnet, withdrawal, transfer, trigger, TP/SL, TWAP, builder, priority, nonce/signature fields -> reject before adapter;
- intent review digest changes on every material input/source/account change; repeated key/digest returns the same intent;
- timeout/post-send 429/5xx -> unknown, adapter called once, GET status reconciles by action-specific reads;
- states cover submitting/accepted/partial/filled/cancelled/rejected/unknown/reconciling; unknown provider status stays quarantined;
- process restart resumes reconciliation and never resubmits.

### Agent authorization

- only Testnet approveAgent primary type; new UUID per authorization; exact expiry and digest binding;
- altered network/address/agent/nonce/expiry/typed-data/signature -> reject before relay;
- signature from another wallet, expired intent, repeated/ambiguous relay -> reject or unknown/no replay;
- missing eligibility/workflow evidence -> disabled before returning signable bytes.

### Privy transfer

- every exact request/response variant and forbidden client field from the reviewed contract;
- handle ownership, wallet epoch, acknowledgement invalidation, canonical base64/digest, expiry, CAS/fencing, one permitted exact replay, second uncertainty, action polling/backoff, terminal stop, unknown-status quarantine;
- concurrent authorize/worker/reload paths preserve one attempt and owner binding;
- credentials/resolver/screening/formatter unavailable -> fail before formatter/signature/provider transport.

### Verification commands

Existing commands verified in `package.json:12-29` and CI:

```sh
pnpm install --frozen-lockfile
docker compose config --quiet
pnpm db:migrate
pnpm test:integration
pnpm check
git diff --check
```

The implementation adds and verifies `pnpm openapi:check`, `pnpm test:worker`, `pnpm test:contract`, `pnpm secrets:check`, and Docker runtime/migration image build commands before naming them as passing gates.

## 9. Risk and Impact Analysis

- **Authentication regression (critical):** centralizing bootstrap logic affects every future route. Preserve raw duplicate-header detection, order of validation, per-request verification, no-store, and all existing bootstrap tests.
- **Provider-route illusion (high):** a fake/unavailable adapter makes the HTTP contract testable but is not provider integration. Inventory/status/docs must distinguish contract-ready from credentialed/provider-ready.
- **Unknown write duplication (critical):** generic retries are forbidden. Persist identity/digest/state before transport and use action-specific authoritative reconciliation; transfer’s one replay is isolated from Hyperliquid.
- **Wallet ownership confusion (critical):** no client address/agent/wallet ID is authority. Multi-wallet selection has no approved API yet; provider calls remain unavailable unless the server can prove one eligible binding.
- **Decimal corruption (critical):** schemas reject numeric JSON for every trading value; exact decimal dependency requires official-source/license/lock review before arithmetic.
- **Stream contract conflict (high):** historical Cookie/CSRF OpenAPI conflicts with native Bearer. ADR 0003 must explicitly supersede only transport, keep server-derived identity/no-store/TTL, and leave Chat/Video truth in Stream.
- **Stream mutation side effects (high):** token endpoints do not authorize server Chat mutations or close RetryQueue/channel side-effect gates.
- **Hyperliquid SDK gate (high):** the reviewed contract currently forbids SDK install/import; implementing custom HTTP, WebSocket, signing, or nonce code to bypass it is prohibited.
- **Eligibility/legal gate (high):** all mutations remain disabled while evidence is pending/unknown/stale. Unit fakes cannot enable a kill switch.
- **Schema/migration growth (medium):** `Database` and app fakes can become monolithic. Split repositories/ports while preserving the direct dependents reported by GitNexus.
- **OpenAPI churn (medium):** route schemas are source of truth. Generate one artifact at step boundaries and once at final tip; never hand-edit it.
- **Local-only deployment (medium):** PostgreSQL/Cloudflare success proves local development routing, not production topology, signer exclusivity, or provider availability.

## 10. Files Expected to Change

| File | Symbols | Reason |
| --- | --- | --- |
| `docs/decisions/0003-native-api-control-plane.md` | new decision | Native Bearer, exact route inventory, deadlines, retry/idempotency, capability states |
| `docs/api-inventory.md` | new inventory | Canonical implemented/approved/blocked/disabled surfaces |
| `src/core/http/*` | auth, schemas, errors | Reusable strict protected-route boundary |
| `src/app.ts` | `BuildAppOptions`, `buildApp` | Compose feature services/adapters/routes and OpenAPI tags |
| `src/config.ts`, `.env.example`, `test/config.test.ts` | provider configs/kill switches | Fail-closed exact configuration and redaction |
| `src/database/database.ts`, `src/database/repositories/*` | database composition/repositories | Control-plane, domain repositories, migration-head readiness |
| `migrations/000002_*` and later append-only migrations | new tables | Idempotency/audit/operations, Perp, agent auth, transfer |
| `src/features/communication/*`, `src/integrations/stream/*`, `src/routes/stream-tokens.ts` | token services/issuer/routes | Chat/Video token contracts |
| `src/features/perp/*`, `src/integrations/hyperliquid/*`, `src/routes/perp.ts` | reads/intents/reconciliation | Private Testnet API contract and default-deny execution |
| `src/features/transfer/*`, `src/integrations/privy/*`, `src/routes/transfer.ts` | transfer state/provider boundary/routes | Six reviewed transfer operations |
| `src/worker.ts`, `src/workers/*` | reconciliation workers | Resume held/unknown operations without blind replay |
| `openapi/loop-api.v1.json`, `scripts/generate-openapi.ts` | generated contract | Versioned client-facing interface and CI drift gate |
| `test/**/*.test.ts`, `test/**/*.integration.test.ts` | behavior/DB/worker/contract suites | Scenario coverage described in §8 |
| `package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml` | scripts/dependencies/gates | Exact researched dependencies and expanded verification |
| `README.md`, `docs/local-development.md`, `docs/product-decisions.md`, `docs/open-source-attribution.md` | status/runbooks | Honest contract-ready vs provider-ready reporting |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Prepare every currently approved LOOP backend API before any Flutter/device integration, with strict Native Privy Bearer identity, fail-closed provider ports, persistence, idempotency, audit, and reconciliation."
  acceptance_criteria:
    - "Canonical inventory contains only implemented or explicitly approved LOOP routes and classifies all blocked/disabled candidates."
    - "Every protected route verifies a current Privy access token and derives owner/Stream/account subjects server-side."
    - "Chat and Video token interfaces, Perp private reads/intents/status/agent authorization, and six transfer routes are present in generated OpenAPI."
    - "Missing provider credentials/evidence fails before provider side effects and does not claim integration."
    - "Trading/transfer numerics are decimal strings; unknown writes are durably held and reconciled without blind replay."
    - "Mainnet, withdrawals, automated trading, Pay, HIP-3, TP/SL, TWAP, builder fees, and unapproved historical APIs remain absent/disabled."
    - "Unit, PostgreSQL integration, worker, OpenAPI, build, and secret checks pass; provider/device tests without inputs remain unverified."
  evidence_provenance:
    schema_version: 2
    head_commit: "466fe2b71f908979606cd70ed346ae3ecc4ea25f"
    generated_plan_path: "docs/plans/2026-08-24-gitnexus-plan-complete-backend-api-surface.md"
    global_dirty_digest:
      algorithm: "sha256"
      canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
      value: "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
    cited_path_manifest:
      - {path: ".github/workflows/ci.yml", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:423a10064c97c0da56824efe1903111e360c8634cd698110df43a2fe8b4c31e3", index_digest: "sha256:423a10064c97c0da56824efe1903111e360c8634cd698110df43a2fe8b4c31e3", worktree_digest: "sha256:423a10064c97c0da56824efe1903111e360c8634cd698110df43a2fe8b4c31e3", untracked_digest: "absent"}
      - {path: "AGENTS.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:99d0464c357df467e3b656a03e8366404931e323815e2019750eacb95965ab07", index_digest: "sha256:99d0464c357df467e3b656a03e8366404931e323815e2019750eacb95965ab07", worktree_digest: "sha256:99d0464c357df467e3b656a03e8366404931e323815e2019750eacb95965ab07", untracked_digest: "absent"}
      - {path: "README.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:6ee2ab2c38eb4d6000bea2e8f4b91fed61e4f32485853b7dd870851ea51328a5", index_digest: "sha256:6ee2ab2c38eb4d6000bea2e8f4b91fed61e4f32485853b7dd870851ea51328a5", worktree_digest: "sha256:6ee2ab2c38eb4d6000bea2e8f4b91fed61e4f32485853b7dd870851ea51328a5", untracked_digest: "absent"}
      - {path: "contracts/hyperliquid-core-perp/README.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:72face3827873d1b19b22268189b8d0e7dec9b6889a6290080c61d405983463b", index_digest: "sha256:72face3827873d1b19b22268189b8d0e7dec9b6889a6290080c61d405983463b", worktree_digest: "sha256:72face3827873d1b19b22268189b8d0e7dec9b6889a6290080c61d405983463b", untracked_digest: "absent"}
      - {path: "contracts/hyperliquid-core-perp/contract.json", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:d77c57422754d2cebe8c7dc79d10e7046688f93d77fe3c520018f61e87322849", index_digest: "sha256:d77c57422754d2cebe8c7dc79d10e7046688f93d77fe3c520018f61e87322849", worktree_digest: "sha256:d77c57422754d2cebe8c7dc79d10e7046688f93d77fe3c520018f61e87322849", untracked_digest: "absent"}
      - {path: "contracts/privy-transfer/README.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:3cedd35d79366363786cfed8a38bc2dcd7b889f09161fcef958d7e6cfc786cf5", index_digest: "sha256:3cedd35d79366363786cfed8a38bc2dcd7b889f09161fcef958d7e6cfc786cf5", worktree_digest: "sha256:3cedd35d79366363786cfed8a38bc2dcd7b889f09161fcef958d7e6cfc786cf5", untracked_digest: "absent"}
      - {path: "contracts/privy-transfer/bff-contract.json", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:e2689369f1a853920666c09a5ad727d88d5c8debd1058330c0e06d1d80d3e5bb", index_digest: "sha256:e2689369f1a853920666c09a5ad727d88d5c8debd1058330c0e06d1d80d3e5bb", worktree_digest: "sha256:e2689369f1a853920666c09a5ad727d88d5c8debd1058330c0e06d1d80d3e5bb", untracked_digest: "absent"}
      - {path: "contracts/stream-chat/README.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:f9d453c35d45404b056180fd477d0d005446c3dbffcc96c022c32ba28957ede2", index_digest: "sha256:f9d453c35d45404b056180fd477d0d005446c3dbffcc96c022c32ba28957ede2", worktree_digest: "sha256:f9d453c35d45404b056180fd477d0d005446c3dbffcc96c022c32ba28957ede2", untracked_digest: "absent"}
      - {path: "contracts/stream-chat/token-service.openapi.yaml", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:09e9d5fe1a2292381ad10c8dbe0a3d489286df970c6faed5d3565a769dc79026", index_digest: "sha256:09e9d5fe1a2292381ad10c8dbe0a3d489286df970c6faed5d3565a769dc79026", worktree_digest: "sha256:09e9d5fe1a2292381ad10c8dbe0a3d489286df970c6faed5d3565a769dc79026", untracked_digest: "absent"}
      - {path: "docs/decisions/0001-node-fastify-foundation.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:c11000f0d1d5c68ecbada796cfdec978f69db7ba2c1b9fc4e6fe0d8fdf700d5e", index_digest: "sha256:c11000f0d1d5c68ecbada796cfdec978f69db7ba2c1b9fc4e6fe0d8fdf700d5e", worktree_digest: "sha256:c11000f0d1d5c68ecbada796cfdec978f69db7ba2c1b9fc4e6fe0d8fdf700d5e", untracked_digest: "absent"}
      - {path: "docs/decisions/0002-privy-bearer-bootstrap.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:6ceaed5d975c7a79a6af855d295ed03de9a0511c126c4a06a753e42758f65ec5", index_digest: "sha256:6ceaed5d975c7a79a6af855d295ed03de9a0511c126c4a06a753e42758f65ec5", worktree_digest: "sha256:6ceaed5d975c7a79a6af855d295ed03de9a0511c126c4a06a753e42758f65ec5", untracked_digest: "absent"}
      - {path: "docs/product-decisions.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:dd9266802a798dacc8b3e928bf68d84ddd1d564050b3b7813011228c7830b7e9", index_digest: "sha256:dd9266802a798dacc8b3e928bf68d84ddd1d564050b3b7813011228c7830b7e9", worktree_digest: "sha256:dd9266802a798dacc8b3e928bf68d84ddd1d564050b3b7813011228c7830b7e9", untracked_digest: "absent"}
      - {path: "migrations/000001_create_internal_users.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:2ec9adbae55fcb1edd2222d4c0d76a50b4559761e0401191e7f03885bcadbf8c", index_digest: "sha256:2ec9adbae55fcb1edd2222d4c0d76a50b4559761e0401191e7f03885bcadbf8c", worktree_digest: "sha256:2ec9adbae55fcb1edd2222d4c0d76a50b4559761e0401191e7f03885bcadbf8c", untracked_digest: "absent"}
      - {path: "package.json", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:5c55556c07d8acebd68440cec60c7be85c9efac2f9e80584a4342dcd475c9e64", index_digest: "sha256:5c55556c07d8acebd68440cec60c7be85c9efac2f9e80584a4342dcd475c9e64", worktree_digest: "sha256:5c55556c07d8acebd68440cec60c7be85c9efac2f9e80584a4342dcd475c9e64", untracked_digest: "absent"}
      - {path: "src/app.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:a0f35b758a875ae7a791fbc82a5df6ccbfe3e81e4f4559815d94535f12e7032e", index_digest: "sha256:a0f35b758a875ae7a791fbc82a5df6ccbfe3e81e4f4559815d94535f12e7032e", worktree_digest: "sha256:a0f35b758a875ae7a791fbc82a5df6ccbfe3e81e4f4559815d94535f12e7032e", untracked_digest: "absent"}
      - {path: "src/config.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:9eec7790eea028388d4542fff8b610046adec222722ad5b76e71d068aa31aa3e", index_digest: "sha256:9eec7790eea028388d4542fff8b610046adec222722ad5b76e71d068aa31aa3e", worktree_digest: "sha256:9eec7790eea028388d4542fff8b610046adec222722ad5b76e71d068aa31aa3e", untracked_digest: "absent"}
      - {path: "src/database/database.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:e4fa514d829e286458e4143761ceb6ee330ee6d268cc927533ebbec903b84197", index_digest: "sha256:e4fa514d829e286458e4143761ceb6ee330ee6d268cc927533ebbec903b84197", worktree_digest: "sha256:e4fa514d829e286458e4143761ceb6ee330ee6d268cc927533ebbec903b84197", untracked_digest: "absent"}
      - {path: "src/routes/bootstrap.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:d5dc33c8f6f430bb62525ecaaad37d39bfb90f8bc15d8aa02f55dba4b15b611c", index_digest: "sha256:d5dc33c8f6f430bb62525ecaaad37d39bfb90f8bc15d8aa02f55dba4b15b611c", worktree_digest: "sha256:d5dc33c8f6f430bb62525ecaaad37d39bfb90f8bc15d8aa02f55dba4b15b611c", untracked_digest: "absent"}
      - {path: "test/app.test.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:309808f8397555034f8b62970a18cf1252b44d342624feaebc4ae6afe923de21", index_digest: "sha256:309808f8397555034f8b62970a18cf1252b44d342624feaebc4ae6afe923de21", worktree_digest: "sha256:309808f8397555034f8b62970a18cf1252b44d342624feaebc4ae6afe923de21", untracked_digest: "absent"}
      - {path: "test/bootstrap.test.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:a676afdac3f60162545c43039d65f5799dc3714b2376b4f5c98a2639d41773e4", index_digest: "sha256:a676afdac3f60162545c43039d65f5799dc3714b2376b4f5c98a2639d41773e4", worktree_digest: "sha256:a676afdac3f60162545c43039d65f5799dc3714b2376b4f5c98a2639d41773e4", untracked_digest: "absent"}
      - {path: "test/config.test.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:2a39e40372aad4f75119abf994f42bcb870b20b5c462a92e67b7177673de4c60", index_digest: "sha256:2a39e40372aad4f75119abf994f42bcb870b20b5c462a92e67b7177673de4c60", worktree_digest: "sha256:2a39e40372aad4f75119abf994f42bcb870b20b5c462a92e67b7177673de4c60", untracked_digest: "absent"}
  primary_symbols:
    - {symbol: "buildApp", file: "src/app.ts", lines: "77-200", role: "Composition root, OpenAPI, cross-cutting HTTP behavior"}
    - {symbol: "loadConfig", file: "src/config.ts", lines: "99-162", role: "Fail-closed runtime/provider configuration"}
    - {symbol: "createPostgresDatabase", file: "src/database/database.ts", lines: "35-118", role: "Pool/repository/readiness composition"}
    - {symbol: "registerBootstrapRoute", file: "src/routes/bootstrap.ts", lines: "112-219", role: "Existing strict Native Bearer route pattern to preserve and extract"}
  related_symbols:
    - {symbol: "main", relationship: "CALLS buildApp/loadConfig", relevance: "Startup and graceful shutdown must remain compatible"}
    - {symbol: "BootstrapService.bootstrap", relationship: "auth -> repository -> derived identity", relevance: "Ordering pattern for protected routes"}
    - {symbol: "Database.internalUsers", relationship: "repository port", relevance: "Principal lookup and current user ownership"}
    - {symbol: "testConfig", relationship: "CALLS loadConfig", relevance: "Every config expansion requires safe test defaults"}
  execution_path:
    - "Fastify rejects malformed route input and parses exactly one raw Bearer header."
    - "Privy verifier validates the current access token; protected routes resolve an existing opaque LOOP user."
    - "Feature service derives provider subject/account and applies environment, capability, eligibility, freshness, and ownership policy."
    - "Mutation service acquires idempotency/operation state and writes an audit transition before provider transport."
    - "Narrow official-provider adapter performs a bounded read or one write attempt; raw provider data is strictly parsed."
    - "Known results are persisted and projected; unknown results remain held for worker reconciliation without blind replay."
    - "Route serializer returns only canonical LOOP fields plus request ID/no-store and sanitized stable errors."
  pdg_constraints:
    - description: "Input/header rejection must precede verifier, repository, policy, and provider calls."
      affected_statements: ["src/routes/bootstrap.ts:157", "src/routes/bootstrap.ts:170", "src/routes/bootstrap.ts:191"]
      implementation_consequence: "Extract shared authentication without moving side effects ahead of strict parsing."
    - description: "Provider authentication precedes internal identity persistence/lookup."
      affected_statements: ["src/features/identity/bootstrap-service.ts:35", "src/features/identity/bootstrap-service.ts:37"]
      implementation_consequence: "No unverified external ID may create/own a record."
    - description: "Optional OpenAPI registration is configuration-gated and independent from business route registration."
      affected_statements: ["src/app.ts:148"]
      implementation_consequence: "Generated artifact must be created in tests/build without enabling production docs."
  architectural_patterns:
    - {pattern: "route -> feature service -> narrow adapter/repository port", example_location: "src/routes/bootstrap.ts + src/features/identity/bootstrap-service.ts", usage_guidance: "Keep Fastify/provider types at their boundaries and inject fakes in buildApp tests."}
    - {pattern: "real provider adapter plus unavailable adapter", example_location: "src/integrations/privy/access-token-verifier.ts", usage_guidance: "Health stays operational while unconfigured protected capability fails closed."}
    - {pattern: "schema-driven OpenAPI and response serialization", example_location: "src/routes/bootstrap.ts", usage_guidance: "Every route documents exact fields/statuses/headers from the same Fastify schema."}
    - {pattern: "parameterized PostgreSQL repository with strict row validation", example_location: "src/database/database.ts", usage_guidance: "Validate external input and returned rows; never expose driver/provider details."}
  files_to_modify:
    - {file: "docs/decisions/0003-native-api-control-plane.md", symbols: ["new ADR"], intended_change: "Lock Native Bearer, exact routes, deadlines, retry/idempotency and blocked surfaces."}
    - {file: "docs/api-inventory.md", symbols: ["canonical route table"], intended_change: "Classify implemented/approved/blocked/disabled APIs."}
    - {file: "src/core/http/*", symbols: ["authentication", "schemas", "errors"], intended_change: "Reusable strict protected-route boundary."}
    - {file: "src/app.ts", symbols: ["BuildAppOptions", "buildApp"], intended_change: "Compose new services/adapters/routes while preserving direct dependents."}
    - {file: "src/config.ts", symbols: ["AppConfig", "loadConfig"], intended_change: "Provider configs, deadlines, quotas and kill switches."}
    - {file: "src/database/database.ts", symbols: ["Database", "createPostgresDatabase"], intended_change: "Repository composition and latest migration readiness."}
    - {file: "migrations/000002_* and later", symbols: ["append-only migrations"], intended_change: "Control plane, Perp, agent authorization and transfer persistence."}
    - {file: "src/features/communication/*", symbols: ["token service"], intended_change: "Chat/Video token issuance policy."}
    - {file: "src/features/perp/*", symbols: ["read service", "intent service", "reconciliation"], intended_change: "Testnet private read/write contract."}
    - {file: "src/features/transfer/*", symbols: ["transfer state machine"], intended_change: "Six reviewed transfer operations."}
    - {file: "src/integrations/stream/*", symbols: ["StreamTokenIssuer"], intended_change: "Official or unavailable provider boundary."}
    - {file: "src/integrations/hyperliquid/*", symbols: ["private reader", "executor"], intended_change: "Strict official or unavailable provider boundary."}
    - {file: "src/routes/*", symbols: ["stream", "perp", "transfer routes"], intended_change: "Canonical OpenAPI surfaces."}
    - {file: "src/worker.ts", symbols: ["reconciliation runner"], intended_change: "Resume unknown operations without blind replay."}
    - {file: "openapi/loop-api.v1.json", symbols: ["generated artifact"], intended_change: "Versioned exact mobile contract."}
    - {file: "test/**/*", symbols: ["unit", "integration", "worker", "contract tests"], intended_change: "All §8 scenarios."}
  tests:
    - file: "test/authentication.test.ts"
      scenarios: ["duplicate/malformed/missing Bearer -> reject before verifier", "valid verified but unbootstrapped identity -> bootstrap_required", "protected routes verify every request"]
    - file: "test/control-plane.integration.test.ts"
      scenarios: ["same key/same digest concurrency -> one operation", "same key/different digest -> conflict", "crash cut points -> held/reconciling", "latest migration readiness"]
    - file: "test/stream-tokens.test.ts"
      scenarios: ["Chat/Video derived subject and one-hour expiry", "body/query/client ID rejection", "quota before issuer", "unconfigured and sanitized failures"]
    - file: "test/perp-reads.test.ts"
      scenarios: ["server-derived account", "strict decimal/provider DTOs", "Core/Testnet only", "cursor/freshness/unavailable behavior"]
    - file: "test/perp-intents.test.ts"
      scenarios: ["strict action unions and disabled features", "idempotent prepare/submit", "unknown result no replay", "status/reconciliation state coverage"]
    - file: "test/agent-authorizations.test.ts"
      scenarios: ["allowlisted Testnet approveAgent only", "canonical digest/expiry/signature binding", "missing evidence disabled before signable payload"]
    - file: "test/transfer.test.ts"
      scenarios: ["six exact operations/variants", "forbidden client fields", "wallet epoch/ack/review binding", "exact replay and reconciliation constraints"]
    - file: "test/reconciliation-worker.integration.test.ts"
      scenarios: ["restart resumes unknown state", "lease/fencing rejects stale writer", "Hyperliquid never resubmits", "transfer only uses reviewed one-time replay"]
    - file: "test/openapi.test.ts"
      scenarios: ["generated artifact equality", "all canonical paths/statuses/security", "disabled/historical/provider paths absent"]
  verification_commands:
    - "pnpm install --frozen-lockfile"
    - "docker compose config --quiet"
    - "pnpm db:migrate"
    - "pnpm test:integration"
    - "pnpm check"
    - "git diff --check"
    - "New commands are added/tested before use: pnpm openapi:check; pnpm test:worker; pnpm test:contract; pnpm secrets:check; Docker runtime/migration image builds"
  risks:
    - "Provider-independent interface success is not credentialed provider success."
    - "Central auth regression could weaken every future route."
    - "Unknown write replay could duplicate a financial action."
    - "Client-selected wallet/account identity could cross the ownership boundary."
    - "Historical Stream Cookie/CSRF and current Native Bearer contracts conflict."
    - "Hyperliquid SDK/license/conformance and eligibility gates are currently closed."
    - "Transfer state/replay contract is substantially more complex than ordinary CRUD."
  assumptions:
    - "Current Flutter hard requirements remain bootstrap, separate Stream Chat/Video token loaders, and Hyperliquid private read/intent/reconciliation; recheck the mobile implementation constraints before changing route inventory."
    - "Development and Hyperliquid Testnet remain the only enabled environments; verify AGENTS.md and feature flags before every mutation slice."
    - "A protected private-account route can proceed only when the server proves one eligible current Privy wallet binding; otherwise return wallet_binding_required until a separate wallet-selection decision exists."
    - "The existing local PostgreSQL/Cloudflare environment remains available for unconfigured-provider smoke tests; verify health rather than assuming it."
  open_questions:
    - "Which exact official Stream server package/version/license is approved? This blocks a real issuer, not the stable HTTP interfaces."
    - "When will Stream secret/API key and credentialed app evidence be configured? Until then token endpoints return unavailable."
    - "When will the Hyperliquid SDK dependency/license/conformance gate and Testnet account/agent/eligibility evidence close? Until then provider execution remains disabled."
    - "How should a user choose among multiple server-verified wallets? No mobile-facing selection route is approved in current documents."
    - "Push device HTTP ownership and provider names are not decided; do not invent a route."
    - "Profile/watchlist/alerts/search/support have historical capability intents but no current authoritative provider/path decision."
  avoid:
    - "Do not repeat full repository discovery."
    - "Do not modify or import historical server/app-integrations-p0 runtime code."
    - "Do not edit migration 000001."
    - "Do not accept client-selected internal user, Stream user, wallet owner, account, agent, nonce, provider URL, or authorization subject."
    - "Do not persist/log tokens, signatures, signed URLs, keys, nonces, secrets, formatter bytes, or complete authorization payloads."
    - "Do not implement custom Stream message/call state, Hyperliquid HTTP/WebSocket/signing/nonce, wallet cryptography, matching/settlement, or risk score cores."
    - "Do not proxy public Hyperliquid markets through LOOP."
    - "Do not add Pay, Mainnet, deposits/withdrawals, automated trading, HIP-3, triggers, TP/SL, TWAP, builder fees, or guessed Push/Profile APIs."
    - "Do not treat fakes, fixtures, compilation, local Cloudflare routing, or unconfigured 503 behavior as provider integration evidence."
```

## 12. Assumptions and Open Questions

### Assumptions

- [assumed] The user’s “all interfaces” means all currently approved backend contracts, not historical prototype capabilities that are explicitly disabled or lack an authority/path decision.
- [assumed] A stable fail-closed HTTP route with exhaustive fake/unavailable-adapter tests is valuable before credentials arrive, provided status/docs never call it integrated.
- [assumed] The local single API/PostgreSQL/Cloudflare environment remains the Development smoke-test target; production/multi-region/signer topology is not implied.

### Blocking provider/product questions

1. Stream server package/version/license approval and secret/API key configuration block real token issuance, but not route/schema/service implementation.
2. Hyperliquid SDK dependency/license/conformance, one protected executor/agent workflow, funded Testnet account, and current eligibility evidence block provider execution; they do not block strict ports, routes, journals, or default-deny tests.
3. Privy transfer needs a unique server-verified wallet, official formatter evidence, resolver/screening decisions, and credentialed staging evidence before provider submission.
4. Multiple-wallet selection, Push HTTP ownership/provider names, and Profile/Watchlist/Alerts/Search/Support provider ownership have no current canonical contract. They stay outside the route inventory until decided.

### Explicitly deferred

- Flutter/backend client implementation and all physical-device/provider integration.
- Stream channel/message/call/moderation APIs beyond short-lived user tokens.
- Public Hyperliquid market proxying.
- Pay/payment/on-ramp/off-ramp/settlement/webhooks, Mainnet, deposits/withdrawals, automated trading, HIP-3, TP/SL, TWAP, and builder fees.
- Production deployment, autoscaling, signer failover, and multi-region topology.

## 13. Definition of Done

- [x] ADR 0003 and `docs/api-inventory.md` define the exact canonical route table, ownership, auth, deadlines, idempotency, capability states, and disabled surfaces.
- [x] Shared Native Privy Bearer parsing/principal resolution protects every implemented route and preserves all bootstrap behavior/tests.
- [x] Append-only migrations, latest-schema readiness, idempotency, audit, provider-operation journals, and reconciliation worker are implemented and PostgreSQL-tested.
- [x] Chat and Video token endpoints exist with exact OpenAPI/no-store/TTL/quota/fail-closed contracts; real issuer status is reported honestly as `blocked-provider`, with Flutter/device integration unverified.
- [x] Perp config/private reads reject client-selected account/provider fields and strictly preserve decimal strings/freshness.
- [x] Perp intent/submit/status and Agent-authorization routes implement strict idempotent, owner-bound, immutable prepared/status boundaries and default-deny policy; unknown/reconciling states remain reserved projections with no reachable provider write, finalizer, or blind-replay path.
- [ ] Six transfer routes implement the reviewed variants, ownership/binding/expiry/replay/reconciliation constraints, and fail closed before unavailable dependencies.
- [ ] Generated OpenAPI artifact includes every approved route and excludes historical/provider/disabled routes.
- [ ] Unit, integration, worker, contract, format, lint, typecheck, build, Docker, OpenAPI, diff, and tracked-secret checks pass with exact results recorded.
- [ ] Provider/device credentialed tests that were not run remain explicitly unverified; no provider is labeled integrated prematurely.
- [ ] Each vertical slice is committed atomically, GitNexus change impact reviewed, pushed to the existing remote branch, and the final worktree is clean.
