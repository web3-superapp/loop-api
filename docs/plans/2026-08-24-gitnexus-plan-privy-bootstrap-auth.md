# GitNexus Engineering Plan

> Task: Implement Privy Bearer verification and idempotent internal-user bootstrap.
> Evidence verified at commit 38e5e92b4f91a6ca2531677adfedd38411c9f8fc; GitNexus index refreshed this session with --index-only --pdg. GitNexus 1.6.9 emitted metadata schema 5 without the runner identity expected by the skill, so graph/PDG findings are advisory and source-weighted unless source-verified.
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 28 sorted entries; exact generated plan path excluded.

> Implementation refinement: a source-read Flutter product constraint outside this target repository's pinned evidence requires bootstrap to return a backend-derived Stream user ID. The plan now derives loop_<uuid-without-hyphens> without connecting Stream or minting a provider token.

## 1. Objective

[verified] Add a Development-only endpoint that accepts the current Privy access token from Flutter, verifies it server-side, derives the trusted Privy user ID from verified claims, maps it to the existing opaque Loop UUID, and returns that UUID plus the deterministic server-derived Stream user ID.

[inferred] This establishes authentication/identity bootstrap and a server-owned Stream subject only. Stream token minting/connection, Firebase push, wallet actions, private Hyperliquid trading, withdrawals, Mainnet, and automated trading remain disconnected.

## 2. Current Behaviour

[verified] buildApp in src/app.ts composes Fastify, Helmet, OpenAPI, PostgreSQL lifecycle, two health routes, optional docs, not-found handling, and sanitized fallback errors. It has no protected route.

[verified] loadConfig in src/config.ts validates server/database inputs but no Privy input. createPostgresDatabase exposes only ping/close.

[verified] migration 000001 already gives loop_users an opaque database-generated UUID and unique, non-null privy_user_id constrained to 1-255 characters.

[verified] The Flutter client can obtain a current Privy access token but has no locked Loop backend adapter/DTO. Decision 0001 says the older cookie contract conflicts with native Bearer use and requires a follow-up decision.

## 3. Relevant Architecture

[verified] src/app.ts is the injection/composition boundary; SDK and identity types should stay behind narrow ports.

[verified] src/config.ts owns fail-closed parsing. Neither Privy variable will leave health available with auth unavailable; exactly one will fail startup; both will enable verification.

[verified] src/database/database.ts owns the pool. The unique constraint, not application memory, is the concurrency authority.

[inferred] Execution is: reject body -> parse one Bearer token -> verify -> validate trusted claim -> atomic lookup/create -> minimal response. Authentication failure must precede all persistence.

## 4. GitNexus Findings

[graph] GitNexus context(buildApp) plus impact(buildApp, upstream, depth 1) returned main and test/app.test.ts; source reads confirmed both. Quote: direct upstream: test/app.test.ts, main; LOW.

[graph] context(loadConfig) plus impact(loadConfig, upstream, depth 1) returned main, test/config.test.ts, and testConfig; source reads confirmed them. Quote: direct upstream: test/config.test.ts, main, testConfig; LOW.

[graph] context(createPostgresDatabase) plus impact(createPostgresDatabase, upstream, depth 1) returned buildApp; source reads additionally confirm health/tests use Database. Quote: direct upstream: buildApp; LOW.

[graph] Route/process exploration found only /openapi.json, /health/live, and /health/ready. Repository taint analysis returned no findings, but explicitly does not model every property/closure/implicit flow; it is not security proof.

## 5. Statement-Level PDG Findings

[graph] pdg_slice(buildApp) shows config controlling Fastify/OpenAPI/database setup, apiDocsEnabled guarding docs, and a sanitized error branch. [verified] Bootstrap registration must precede the not-found handler and preserve onClose.

[graph] pdg_slice(loadConfig) shows environment data entering Zod parsing and failed parsing throwing ConfigurationError before frozen output. [inferred] Pair validation belongs there and must never interpolate values.

[graph] pdg_slice(createPostgresDatabase) shows result data crossing a runtime guard. [inferred] UUID rows require validation; an absent conflict winner is an internal invariant failure.

[verified] Use INSERT ... ON CONFLICT DO NOTHING RETURNING id, then a separate SELECT only on conflict. One CTE statement can miss a concurrent winner under READ COMMITTED and is excluded.

## 6. Proposed Changes

1. docs/decisions/0002-privy-bearer-bootstrap.md: approve POST /v1/bootstrap, native Bearer auth, exact @privy-io/node 0.29.0, {user:{id},stream_user_id}, stable errors, and explicit deferrals.
2. package.json/pnpm-lock.yaml/attribution: add the exact SDK pin already recorded in contracts/privy-transfer/dependency-lock.json, plus a dedicated DB integration script.
3. .env.example and src/config.ts: add blank placeholders and immutable configured-or-null PRIVY_APP_ID/PRIVY_APP_SECRET pair; no secret value in errors/logs.
4. src/integrations/privy/access-token-verifier.ts: add a narrow port and process-scoped official adapter; call utils().auth().verifyAccessToken per request; expose only trusted user ID.
5. Identity repository/service modules: define the ID mapping port and enforce verifier-before-database order.
6. src/database/database.ts: preserve ping/close and add parameterized atomic mapping using the existing table/constraint; no migration change.
7. src/routes/bootstrap.ts: no requestBody, reject any body first, strict bounded single Bearer, no-store, 401 challenge, stable {code,message,request_id}, success only {user:{id},stream_user_id}, with the Stream ID derived server-side from the opaque UUID.
8. src/app.ts: inject/compose dependencies, add OpenAPI bearer scheme/tag, register the route, preserve existing lifecycle/errors.
9. Tests/CI/docs: synthetic-JWT adapter tests, fake-driven route tests, real PostgreSQL concurrency tests, CI execution, truthful README/local setup/attribution.

## 7. Implementation Sequence

1. Add decision 0002 as a documentation-only coherent step.
2. Install/pin the SDK; verify installed types before writing adapter code.
3. Add Privy config and value-safe tests.
4. Add verifier and synthetic ES256 tests; stop if exact API/claims differ.
5. Add repository and real serial/concurrent PostgreSQL tests.
6. Add service/route and rejection-order/sanitization tests.
7. Compose OpenAPI/route in buildApp and run app regressions.
8. Add CI/docs, run full verification, smoke-test the public tunnel, review for secrets, commit, and push.

## 8. Test Strategy

[verified] Extend config tests for absent/complete/partial pairs and a sentinel secret absent from errors.

[inferred] Generate ephemeral P-256 keys/JWTs to prove valid SDK mapping and rejection of signature, audience, issuer, expiry, or claim failures without real credentials.

[inferred] Route tests cover missing/malformed/duplicate/oversized auth; all request bodies; unavailable auth; success minimization/replay; repository failure; zero downstream calls on early rejection; no-store/challenge/request ID; and OpenAPI bearer/no-body shape.

[inferred] PostgreSQL tests prove sequential and concurrent same-user idempotency plus distinct IDs for distinct users against migrated schema.

[verified] Existing app tests continue to cover health, docs-off, not-found, and close. CI already provisions PostgreSQL/migrations.

Verification: pnpm db:migrate; pnpm test:integration; pnpm check; git diff --check; public ready; unauthenticated public bootstrap returns sanitized 401. A real phone token remains explicitly unverified until mobile integration.

## 9. Risk and Impact Analysis

[verified] buildApp directly affects main and app tests. loadConfig directly affects main, config tests, and testConfig. Database changes affect buildApp, health ping, and all fakes.

[inferred] Provider verification is security-critical. Token/header/claim/provider error content never reaches logs/responses. SDK errors that cannot reliably distinguish JWKS transport from invalid tokens fail closed as 401; only known unconfigured state is 503.

[inferred] Concurrency correctness depends on the unique constraint and a fresh second SQL statement. No client UUID is accepted.

[inferred] One SDK client preserves JWKS caching; token verification still runs every request and application code never caches tokens.

[verified] No migration is needed. The endpoint is Development-tunnel-only and application rate limiting remains deferred/documented.

## 10. Files Expected to Change

| File | Symbols | Reason |
| ---- | ------- | ------ |
| docs/decisions/0002-privy-bearer-bootstrap.md | new decision | Security/dependency/API decision |
| package.json, pnpm-lock.yaml | dependencies/scripts | SDK and integration command |
| .env.example, src/config.ts | config schema/types | Safe all-or-none credentials |
| src/integrations/privy/access-token-verifier.ts | new module | Official SDK isolation |
| src/features/identity/internal-user-repository.ts | new module | Persistence port |
| src/features/identity/bootstrap-service.ts | new module | Auth-first orchestration |
| src/database/database.ts | Database/createPostgresDatabase | Atomic mapping |
| src/routes/bootstrap.ts | new route | HTTP/OpenAPI boundary |
| src/app.ts | BuildAppOptions/buildApp | Composition/registration |
| test/config.test.ts | config tests | Pair/value safety |
| test/privy-access-token-verifier.test.ts | new tests | SDK verification |
| test/bootstrap.test.ts | new tests | Route/service behavior |
| test/internal-user-repository.integration.test.ts | new tests | DB concurrency |
| test/app.test.ts | app regressions | Fake compatibility |
| .github/workflows/ci.yml | verify job | Integration execution |
| README.md, docs/local-development.md | status/setup | Truthful operation |
| docs/open-source-attribution.md | register | Apache-2.0 SDK |

## 11. Reusable Implementation Context

~~~yaml
implementation_context: {
    "task_summary": "Implement Privy Bearer authentication and idempotent internal-user bootstrap at POST /v1/bootstrap.",
    "acceptance_criteria": [
      "Invalid or missing authentication causes zero database calls and a sanitized 401.",
      "A process-scoped @privy-io/node verifier trusts only verified claims.user_id.",
      "Valid requests return one stable server-generated Loop UUID plus a deterministic server-derived Stream user ID and expose no provider credential or token.",
      "Sequential and concurrent calls for one Privy identity leave one row and return the same UUID.",
      "OpenAPI, config, CI, tests, docs, and attribution truthfully describe only this slice."
    ],
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "38e5e92b4f91a6ca2531677adfedd38411c9f8fc",
      "generated_plan_path": "docs/plans/2026-08-24-gitnexus-plan-privy-bootstrap-auth.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
      },
      "cited_path_manifest": [
        {
          "path": ".env.example",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e0090fd619559fdc10696fc168a32094f4ddaa3033c2a29b7b4362b8d5849dc7",
          "index_digest": "sha256:e0090fd619559fdc10696fc168a32094f4ddaa3033c2a29b7b4362b8d5849dc7",
          "worktree_digest": "sha256:e0090fd619559fdc10696fc168a32094f4ddaa3033c2a29b7b4362b8d5849dc7",
          "untracked_digest": "absent"
        },
        {
          "path": ".github/workflows/ci.yml",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:59814181f1ac76448a3f4a219381510ab68cac6c6d954acedd412ba34038ebbc",
          "index_digest": "sha256:59814181f1ac76448a3f4a219381510ab68cac6c6d954acedd412ba34038ebbc",
          "worktree_digest": "sha256:59814181f1ac76448a3f4a219381510ab68cac6c6d954acedd412ba34038ebbc",
          "untracked_digest": "absent"
        },
        {
          "path": "AGENTS.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:99d0464c357df467e3b656a03e8366404931e323815e2019750eacb95965ab07",
          "index_digest": "sha256:99d0464c357df467e3b656a03e8366404931e323815e2019750eacb95965ab07",
          "worktree_digest": "sha256:99d0464c357df467e3b656a03e8366404931e323815e2019750eacb95965ab07",
          "untracked_digest": "absent"
        },
        {
          "path": "README.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0b0f3f6f68d89c3bfec2c950cc13c13c70aad57d4f496062c9e35f7943a115f6",
          "index_digest": "sha256:0b0f3f6f68d89c3bfec2c950cc13c13c70aad57d4f496062c9e35f7943a115f6",
          "worktree_digest": "sha256:0b0f3f6f68d89c3bfec2c950cc13c13c70aad57d4f496062c9e35f7943a115f6",
          "untracked_digest": "absent"
        },
        {
          "path": "contracts/privy-transfer/README.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3cedd35d79366363786cfed8a38bc2dcd7b889f09161fcef958d7e6cfc786cf5",
          "index_digest": "sha256:3cedd35d79366363786cfed8a38bc2dcd7b889f09161fcef958d7e6cfc786cf5",
          "worktree_digest": "sha256:3cedd35d79366363786cfed8a38bc2dcd7b889f09161fcef958d7e6cfc786cf5",
          "untracked_digest": "absent"
        },
        {
          "path": "contracts/privy-transfer/dependency-lock.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3ad210fa9b3dd04bbfb5b81af7d1c690872eb1b07d5d4e9c0b342e54311bb18b",
          "index_digest": "sha256:3ad210fa9b3dd04bbfb5b81af7d1c690872eb1b07d5d4e9c0b342e54311bb18b",
          "worktree_digest": "sha256:3ad210fa9b3dd04bbfb5b81af7d1c690872eb1b07d5d4e9c0b342e54311bb18b",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0001-node-fastify-foundation.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c11000f0d1d5c68ecbada796cfdec978f69db7ba2c1b9fc4e6fe0d8fdf700d5e",
          "index_digest": "sha256:c11000f0d1d5c68ecbada796cfdec978f69db7ba2c1b9fc4e6fe0d8fdf700d5e",
          "worktree_digest": "sha256:c11000f0d1d5c68ecbada796cfdec978f69db7ba2c1b9fc4e6fe0d8fdf700d5e",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0002-privy-bearer-bootstrap.md",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/local-development.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4448fabdc597d36881dd18018f0e974d3e7bcbd5545d544bf1ee151c312dc58f",
          "index_digest": "sha256:4448fabdc597d36881dd18018f0e974d3e7bcbd5545d544bf1ee151c312dc58f",
          "worktree_digest": "sha256:4448fabdc597d36881dd18018f0e974d3e7bcbd5545d544bf1ee151c312dc58f",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/open-source-attribution.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f88a8f8da873054daec0bf4690f8459d01dd34e2a66e154f08622215cc99fade",
          "index_digest": "sha256:f88a8f8da873054daec0bf4690f8459d01dd34e2a66e154f08622215cc99fade",
          "worktree_digest": "sha256:f88a8f8da873054daec0bf4690f8459d01dd34e2a66e154f08622215cc99fade",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/product-decisions.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e44ef860611f0f49d09446210703b3322aab4731003b5588ff9314167b972a18",
          "index_digest": "sha256:e44ef860611f0f49d09446210703b3322aab4731003b5588ff9314167b972a18",
          "worktree_digest": "sha256:e44ef860611f0f49d09446210703b3322aab4731003b5588ff9314167b972a18",
          "untracked_digest": "absent"
        },
        {
          "path": "migrations/000001_create_internal_users.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2ec9adbae55fcb1edd2222d4c0d76a50b4559761e0401191e7f03885bcadbf8c",
          "index_digest": "sha256:2ec9adbae55fcb1edd2222d4c0d76a50b4559761e0401191e7f03885bcadbf8c",
          "worktree_digest": "sha256:2ec9adbae55fcb1edd2222d4c0d76a50b4559761e0401191e7f03885bcadbf8c",
          "untracked_digest": "absent"
        },
        {
          "path": "package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:abb4c7da44134ad630a8b8ae9035808c02ee55ffaab7a63270b87082aba63682",
          "index_digest": "sha256:abb4c7da44134ad630a8b8ae9035808c02ee55ffaab7a63270b87082aba63682",
          "worktree_digest": "sha256:abb4c7da44134ad630a8b8ae9035808c02ee55ffaab7a63270b87082aba63682",
          "untracked_digest": "absent"
        },
        {
          "path": "pnpm-lock.yaml",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4b2b0b815c02c743f977d33e7ee56e740ed3242f04a8dfe755fae3172c38c6c0",
          "index_digest": "sha256:4b2b0b815c02c743f977d33e7ee56e740ed3242f04a8dfe755fae3172c38c6c0",
          "worktree_digest": "sha256:4b2b0b815c02c743f977d33e7ee56e740ed3242f04a8dfe755fae3172c38c6c0",
          "untracked_digest": "absent"
        },
        {
          "path": "src/app.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4af3310b32d01e78252c5c84c82f11c568883a764e4a06a69c78843b16b4647e",
          "index_digest": "sha256:4af3310b32d01e78252c5c84c82f11c568883a764e4a06a69c78843b16b4647e",
          "worktree_digest": "sha256:4af3310b32d01e78252c5c84c82f11c568883a764e4a06a69c78843b16b4647e",
          "untracked_digest": "absent"
        },
        {
          "path": "src/config.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4bf143ff2cc051df688ca6c1f12755a21560d828eda1b63c5662509a3a8dce0b",
          "index_digest": "sha256:4bf143ff2cc051df688ca6c1f12755a21560d828eda1b63c5662509a3a8dce0b",
          "worktree_digest": "sha256:4bf143ff2cc051df688ca6c1f12755a21560d828eda1b63c5662509a3a8dce0b",
          "untracked_digest": "absent"
        },
        {
          "path": "src/database/database.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:410f9d5c111d88f6e2074a0a6a1082bf5da8adc2de5fd7bc12fa0f532dbd7f8a",
          "index_digest": "sha256:410f9d5c111d88f6e2074a0a6a1082bf5da8adc2de5fd7bc12fa0f532dbd7f8a",
          "worktree_digest": "sha256:410f9d5c111d88f6e2074a0a6a1082bf5da8adc2de5fd7bc12fa0f532dbd7f8a",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/identity/bootstrap-service.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/identity/internal-user-repository.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "src/integrations/privy/access-token-verifier.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "src/routes/bootstrap.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "src/routes/health.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:5aa0ae802f2181a22a57491f6672f922f376538a861e9235a1b374925c603853",
          "index_digest": "sha256:5aa0ae802f2181a22a57491f6672f922f376538a861e9235a1b374925c603853",
          "worktree_digest": "sha256:5aa0ae802f2181a22a57491f6672f922f376538a861e9235a1b374925c603853",
          "untracked_digest": "absent"
        },
        {
          "path": "src/server.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e4ab56bf145d8c4d5b303acc5dc126c25628c3234c5d00e7b096b8f8f4a80c26",
          "index_digest": "sha256:e4ab56bf145d8c4d5b303acc5dc126c25628c3234c5d00e7b096b8f8f4a80c26",
          "worktree_digest": "sha256:e4ab56bf145d8c4d5b303acc5dc126c25628c3234c5d00e7b096b8f8f4a80c26",
          "untracked_digest": "absent"
        },
        {
          "path": "test/app.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9581aeb595e4e2e4d2da039ef8ea372a2ebdaa15c2858056e3e123810264f564",
          "index_digest": "sha256:9581aeb595e4e2e4d2da039ef8ea372a2ebdaa15c2858056e3e123810264f564",
          "worktree_digest": "sha256:9581aeb595e4e2e4d2da039ef8ea372a2ebdaa15c2858056e3e123810264f564",
          "untracked_digest": "absent"
        },
        {
          "path": "test/bootstrap.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "test/config.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d179b442c3c3660ce5289f24327810cbf534e73d0bc908f0bdaac18fd4f4b614",
          "index_digest": "sha256:d179b442c3c3660ce5289f24327810cbf534e73d0bc908f0bdaac18fd4f4b614",
          "worktree_digest": "sha256:d179b442c3c3660ce5289f24327810cbf534e73d0bc908f0bdaac18fd4f4b614",
          "untracked_digest": "absent"
        },
        {
          "path": "test/internal-user-repository.integration.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "test/privy-access-token-verifier.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        }
      ]
    },
    "primary_symbols": [
      {
        "symbol": "buildApp",
        "file": "src/app.ts",
        "lines": "65-164",
        "role": "Fastify composition, lifecycle, route registration, sanitized errors."
      },
      {
        "symbol": "loadConfig",
        "file": "src/config.ts",
        "lines": "100-149",
        "role": "Fail-closed environment parsing."
      },
      {
        "symbol": "Database / createPostgresDatabase",
        "file": "src/database/database.ts",
        "lines": "9-69",
        "role": "Pool lifecycle and future internal-user persistence."
      },
      {
        "symbol": "up",
        "file": "migrations/000001_create_internal_users.ts",
        "lines": "5-28",
        "role": "Existing opaque UUID and unique Privy identity schema; unchanged."
      },
      {
        "symbol": "registerHealthRoutes",
        "file": "src/routes/health.ts",
        "lines": "44-107",
        "role": "Existing route/schema/error pattern to preserve."
      }
    ],
    "related_symbols": [
      {
        "symbol": "main",
        "relationship": "CALLS buildApp and loadConfig",
        "relevance": "Production startup/composition."
      },
      {
        "symbol": "test/app.test.ts",
        "relationship": "test-of buildApp",
        "relevance": "Direct caller and Database fake."
      },
      {
        "symbol": "test/config.test.ts",
        "relationship": "test-of loadConfig",
        "relevance": "Configuration contract."
      },
      {
        "symbol": "registerHealthRoutes",
        "relationship": "USES Database.ping",
        "relevance": "Database expansion must preserve readiness."
      }
    ],
    "execution_path": [
      "Reject any body, then parse exactly one bounded Bearer token.",
      "Verify the token on every request through the singleton SDK client.",
      "Pass only verified claims.user_id to the internal-user repository.",
      "INSERT ... ON CONFLICT DO NOTHING RETURNING; SELECT in a fresh statement on conflict.",
      "Return 200 with user.id and stream_user_id, no-store, and request ID."
    ],
    "pdg_constraints": [
      {
        "description": "Preserve buildApp close hook, docs guard, and sanitized fallback ordering.",
        "affected_statements": [
          "src/app.ts:65",
          "src/app.ts:112",
          "src/app.ts:124",
          "src/app.ts:134"
        ],
        "implementation_consequence": "Compose once, register bootstrap before not-found, leave shutdown intact."
      },
      {
        "description": "Keep configuration failure before frozen config construction.",
        "affected_statements": [
          "src/config.ts:100",
          "src/config.ts:129",
          "src/config.ts:134"
        ],
        "implementation_consequence": "Validate Privy variables as a pair without value interpolation."
      },
      {
        "description": "Validate database rows before returning application IDs.",
        "affected_statements": [
          "src/database/database.ts:27",
          "src/database/database.ts:43",
          "src/database/database.ts:54"
        ],
        "implementation_consequence": "Validate UUID and treat an absent conflict winner as an internal invariant failure."
      }
    ],
    "architectural_patterns": [
      {
        "pattern": "Composition-root injection",
        "example_location": "src/app.ts buildApp",
        "usage_guidance": "Inject fakes in tests; production creates one verifier and repository."
      },
      {
        "pattern": "Fail-closed Zod config",
        "example_location": "src/config.ts loadConfig",
        "usage_guidance": "Both Privy variables absent disables auth, one is invalid, both enable it."
      },
      {
        "pattern": "Sanitized API errors",
        "example_location": "src/app.ts and src/routes/health.ts",
        "usage_guidance": "Never expose provider errors, tokens, claims, secrets, or DB details."
      },
      {
        "pattern": "Append-only migrations",
        "example_location": "migrations/000001_create_internal_users.ts",
        "usage_guidance": "Use the existing constraint; do not edit/add a migration."
      }
    ],
    "files_to_modify": [
      {
        "file": "docs/decisions/0002-privy-bearer-bootstrap.md",
        "symbols": [
          "new decision"
        ],
        "intended_change": "Approve security/dependency/API boundary and deferrals."
      },
      {
        "file": "package.json",
        "symbols": [
          "dependencies",
          "scripts"
        ],
        "intended_change": "Pin @privy-io/node 0.29.0 and add integration test command."
      },
      {
        "file": "pnpm-lock.yaml",
        "symbols": [
          "lock graph"
        ],
        "intended_change": "Lock provider SDK graph and integrity."
      },
      {
        "file": ".env.example",
        "symbols": [
          "Privy placeholders"
        ],
        "intended_change": "Add blank safe App ID/secret names."
      },
      {
        "file": "src/config.ts",
        "symbols": [
          "environmentSchema",
          "AppConfig",
          "loadConfig"
        ],
        "intended_change": "Add all-or-none Privy config."
      },
      {
        "file": "src/integrations/privy/access-token-verifier.ts",
        "symbols": [
          "new port/adapter"
        ],
        "intended_change": "Isolate official SDK and narrow verified principal."
      },
      {
        "file": "src/features/identity/internal-user-repository.ts",
        "symbols": [
          "new port"
        ],
        "intended_change": "Define trusted identity-to-UUID persistence."
      },
      {
        "file": "src/features/identity/bootstrap-service.ts",
        "symbols": [
          "new service"
        ],
        "intended_change": "Enforce verify-before-database ordering."
      },
      {
        "file": "src/database/database.ts",
        "symbols": [
          "Database",
          "createPostgresDatabase"
        ],
        "intended_change": "Implement atomic pool-backed mapping."
      },
      {
        "file": "src/routes/bootstrap.ts",
        "symbols": [
          "new route"
        ],
        "intended_change": "Strict HTTP, auth errors, no-store, OpenAPI."
      },
      {
        "file": "src/app.ts",
        "symbols": [
          "BuildAppOptions",
          "buildApp"
        ],
        "intended_change": "Compose/inject and register route/security scheme."
      },
      {
        "file": "test/config.test.ts",
        "symbols": [
          "loadConfig tests"
        ],
        "intended_change": "Cover config pair and secret-safe failures."
      },
      {
        "file": "test/privy-access-token-verifier.test.ts",
        "symbols": [
          "new tests"
        ],
        "intended_change": "Exercise official SDK with synthetic JWTs."
      },
      {
        "file": "test/bootstrap.test.ts",
        "symbols": [
          "new tests"
        ],
        "intended_change": "Cover route/service behavior and sanitization."
      },
      {
        "file": "test/internal-user-repository.integration.test.ts",
        "symbols": [
          "new tests"
        ],
        "intended_change": "Prove real PostgreSQL concurrency."
      },
      {
        "file": "test/app.test.ts",
        "symbols": [
          "regressions"
        ],
        "intended_change": "Adapt fakes without changing existing behavior."
      },
      {
        "file": ".github/workflows/ci.yml",
        "symbols": [
          "verify job"
        ],
        "intended_change": "Run PostgreSQL integration tests."
      },
      {
        "file": "README.md",
        "symbols": [
          "status"
        ],
        "intended_change": "Describe only configured bootstrap."
      },
      {
        "file": "docs/local-development.md",
        "symbols": [
          "setup"
        ],
        "intended_change": "Document safe local/device checks."
      },
      {
        "file": "docs/open-source-attribution.md",
        "symbols": [
          "register"
        ],
        "intended_change": "Add SDK license entry."
      }
    ],
    "tests": [
      {
        "file": "test/config.test.ts",
        "scenarios": [
          "none -> auth unavailable",
          "both -> configured pair",
          "partial -> value-safe ConfigurationError"
        ]
      },
      {
        "file": "test/privy-access-token-verifier.test.ts",
        "scenarios": [
          "valid synthetic ES256 -> principal",
          "wrong aud/iss/exp/signature/claims -> invalid"
        ]
      },
      {
        "file": "test/bootstrap.test.ts",
        "scenarios": [
          "missing/malformed/duplicate/oversized -> 401 and zero DB",
          "any body -> 400 before verifier",
          "unconfigured -> 503",
          "valid -> user.id plus derived stream_user_id/no-store",
          "replay -> stable ID",
          "DB failure -> sanitized 500",
          "OpenAPI -> bearer/no requestBody"
        ]
      },
      {
        "file": "test/internal-user-repository.integration.test.ts",
        "scenarios": [
          "serial same ID -> one UUID",
          "concurrent same ID -> one row/UUID",
          "different IDs -> distinct UUIDs"
        ]
      },
      {
        "file": "test/app.test.ts",
        "scenarios": [
          "health/docs-off/not-found/close remain unchanged"
        ]
      }
    ],
    "verification_commands": [
      "pnpm db:migrate",
      "pnpm test:integration",
      "pnpm check",
      "git diff --check",
      "curl --fail-with-body https://api-dev.quant-dinger.cc/health/ready",
      "curl -i -X POST https://api-dev.quant-dinger.cc/v1/bootstrap"
    ],
    "risks": [
      "Auth is security-critical despite a small static blast radius.",
      "SDK invalid-token errors may include JWKS transport failures; all fail closed and only known unconfigured state is 503.",
      "Access tokens may remain valid until expiry; instant revocation is not claimed.",
      "Concurrent first bootstrap requires a second SQL statement for a fresh READ COMMITTED snapshot.",
      "Database interface changes affect app composition, health, and fakes.",
      "Development tunnel has no application rate limiter yet."
    ],
    "assumptions": [
      "Check installed 0.29.0 types and adapter tests for utils().auth().verifyAccessToken.",
      "Check only presence/non-empty status of PRIVY_APP_ID and PRIVY_APP_SECRET; never print values.",
      "Run migrations before PostgreSQL integration tests.",
      "Re-check public readiness before device handoff."
    ],
    "open_questions": [
      "No blocking contract question: decision 0002 locks POST /v1/bootstrap and {user:{id},stream_user_id}.",
      "Real phone-issued token verification waits for the mobile adapter.",
      "Static verification key, rate limiting, Stream token minting/connection, wallet, and trading are separate decisions."
    ],
    "avoid": [
      "Do not repeat full repository discovery.",
      "Do not replace established patterns without evidence.",
      "Do not read, print, log, commit, forward, or snapshot .env.local or secrets/tokens.",
      "Do not accept client-selected internal/provider/Stream/wallet IDs or refresh tokens.",
      "Do not implement Stream token minting/connection, wallet, private trading, withdrawals, Mainnet, or automation here.",
      "Do not edit migration 000001 or add a redundant migration.",
      "Do not treat no-taint output as security proof."
    ]
  }
~~~

## 12. Assumptions and Open Questions

- [assumed] Installed 0.29.0 exposes PrivyClient.utils().auth().verifyAccessToken and expected snake_case claims; check types/typecheck/adapter tests.
- [assumed] Local .env.local has both variable keys; check presence only, never values.
- [assumed] PostgreSQL is reachable; prove via migration and integration suite.
- [assumed] Cloudflare still routes the Development hostname; prove public readiness before handoff.

No blocking contract question remains. Decision 0002 locks POST /v1/bootstrap and {user:{id},stream_user_id}. Deferred: mobile adapter/real-token phone test, static verification key, rate limiting, Stream token minting/connection, push, wallet, private trading, withdrawals, Mainnet, automation.

## 13. Definition of Done

- Decision 0002 approves exactly this boundary.
- Exact SDK is locked, typechecked, tested, and attributed.
- Missing/invalid auth or any body produces no DB call and only sanitized errors.
- Valid auth trusts only verified claims.user_id and returns one opaque UUID plus its deterministic server-derived Stream ID with no-store.
- Real PostgreSQL tests prove sequential/concurrent idempotency.
- Existing app behavior and OpenAPI checks pass.
- pnpm db:migrate, pnpm test:integration, pnpm check, and git diff --check pass.
- Public readiness passes; unauthenticated public bootstrap returns sanitized 401.
- No secret/token/DID/session/credential/.env.local content enters Git, logs, fixtures, or responses.
- Docs keep Stream, push, wallet, and private trading explicitly disconnected.
