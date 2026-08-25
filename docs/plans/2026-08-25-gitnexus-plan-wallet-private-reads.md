# GitNexus Engineering Plan

> Task: Implement explicit Privy wallet binding and real Hyperliquid Testnet Core private reads before mobile integration.
> Evidence verified at commit b3e91cebc18d76551b40e8211303a40e9647dafd; GitNexus index refreshed this session with --index-only --pdg. CLI 1.6.9 cannot emit runner identity, so graph evidence is navigation/impact evidence and source is authoritative.
> Evidence provenance schema 2; global dirty digest 239ae7332b11290482c1c5048a28304015e022dfb04ba425a766f1f03f13a66f; cited-path manifest 33 sorted entries; exact generated plan path excluded.

## 1. Objective

Complete the backend-only wallet/private-read vertical slice: durable user-triggered Privy embedded-Ethereum binding, fresh server verification, lossless Hyperliquid Testnet Info reads, Core BTC/ETH/SOL projection, global weight budget, and tests. Keep signing, orders, transfers, Mainnet, subaccounts, automation, Firebase, and phone integration disabled.

## 2. Current Behaviour

- [verified] Six authenticated Perp GET routes already enforce server-owned account inputs, decimal strings, freshness, bounded cursors, new UUID per attempt, and narrow retry, but buildApp composes unavailable wallet and reader adapters (src/app.ts:287-363; src/features/perp/private-read-service.ts:654-1374).
- [verified] The resolver returns unknown and the feature layer revalidates owner, Privy subject, nonzero lowercase address, account kind, version, and expiry. The default refuses to guess (src/features/perp/wallet-binding-resolver.ts:1-54).
- [verified] Decision 0005 requires separate wallet lifecycle, strict provider conformance, global weight budget, and credentialed evidence before real reads (docs/decisions/0005-hyperliquid-private-read-interface.md).
- [verified] Perp intent rows persist account/version, but finalization does not lock a durable binding; Decision 0006 requires that before a real resolver is composed (docs/decisions/0006-perp-intent-interface.md; src/database/perp-intent-repository.ts:881-1098).
- [verified] Privy 0.29.0 provides users()._get(DID), while the current verifier owns its client internally (src/integrations/privy/access-token-verifier.ts).
- [verified] Quota consumption atomically adds one unit only; weighted cost is absent (src/database/control-plane-repository.ts:1126-1219).
- [verified] Migration head is 000005 and there is no wallet binding relation (src/database/schema.ts).

## 3. Relevant Architecture

- [verified] buildApp owns composition, createPostgresDatabase owns repositories/readiness, integrations own provider mechanics, and features own policy (AGENTS.md).
- [verified] Privy is identity/wallet authority, but wallet is a replaceable credential bound to the opaque LOOP UUID; clients cannot submit authority (docs/product-decisions.md).
- [verified] Binding version is a security epoch used by encrypted cursors and stored Perp reviews. Bind/rotate/unbind must change one durable monotonic epoch; identical refresh must not.
- [verified] The Hyperliquid contract permits separately approved read-only views with no ExchangeClient or signing path (contracts/hyperliquid-core-perp/README.md; contract.json).
- [inferred] @nktkas/hyperliquid 0.33.3 is unsafe for this read boundary because its HTTP path uses native JSON.parse and number oid/tid. A narrow lossless POST /info adapter is required; SDK/signing gates remain closed.

Target flow:

Authenticated principal -> durable selection -> current Privy exact match -> 15-second verified binding -> weighted quota -> fixed Testnet Info request -> lossless strict Core projection -> existing parser/cursor -> no-store response.

## 4. GitNexus Findings

- [graph] context+impact(buildApp, upstream, depth 2, tests) reported 10 affected symbols, seven direct dependents, three startup/OpenAPI processes, HIGH risk.
- [graph] context+impact(createPerpPrivateReadService) reported 11 affected symbols and four direct dependents: buildApp, service harness/file, and route tests; HIGH risk.
- [graph] context+impact(createUnavailablePerpWalletBindingResolver) reported nine affected symbols, direct buildApp/cursor-test dependence, HIGH risk.
- [graph] context+impact(createPostgresDatabase) reported 11 affected symbols and four direct callers: buildApp plus three integration suites; HIGH risk.
- [graph] context(loadConfig) found startup, OpenAPI, config tests, and integration setup as direct consumers.
- [graph] impact(consumeIssuanceQuota) was ambiguous and missed source consumers. Source inspection controls: Stream service/tests require cost-one compatibility.
- [graph] explain on app.ts/private-read-service.ts returned no taint findings and explicitly warned that closure/property/implicit flows are absent; this is not safety proof.

Direct dependent tests must cover server/OpenAPI/app builders for buildApp/loadConfig, database literals and three integration callers for createPostgresDatabase, private-read service/route suites, cursor rotation, and Stream quota compatibility.

## 5. Statement-Level PDG Findings

- [graph] pdg controls for buildApp found the API-docs guard and Bearer-challenge branch. Provider composition must not become conditional on docs or weaken authentication.
- [graph] pdg flows for buildApp traced options through auth, repositories, wallet/reader, services, and routes. Existing injection precedence must remain.
- [graph] pdg controls for loadConfig found the fail-closed parse guard. Enablement must be all-or-nothing before AppConfig exists.
- [graph] pdg controls for createPerpPrivateReadService found cursor availability before reader work and binding revalidation after provider latency.
- [verified] readWithRetry retries only attempt timeout and typed pre-response/5xx. Reader 4xx/429/malformed/body-stage failures must be sanitized non-retryable unavailable, never generic 500/retry (src/features/perp/private-read-service.ts:927-974).
- [verified] prepare inserts provider operation before domain rows inside one transaction. Lock/compare binding before either insert (src/database/perp-intent-repository.ts:881-1010).

## 6. Proposed Changes

### 6.1 Decisions and dependency

Add Decision 0010 for explicit wallet lifecycle and Decision 0011 for a lossless read-only Hyperliquid transport.

0010 approves GET/PUT/DELETE /v1/perp/wallet-binding. GET returns stored state, binding_version, nullable account_kind, and last_verified_at only. PUT accepts only expected_binding_version and explicitly bind/refresh/rotates. DELETE takes only expected_binding_version and unbinds. No address/wallet ID/owner/account kind/network/dex/subaccount is accepted or returned. Initial unbound version is 0; bind/rotate/unbind add one; same-wallet refresh retains version. Only master is allowed. Without a current selection, exactly one eligible embedded EVM candidate is required; an existing exact selection remains valid among multiple candidates.

0011 approves fixed unauthenticated Hyperliquid Testnet POST /info reads and records why the candidate SDK is rejected for private reads while mutation/WebSocket/signing gates stay closed. Pin lossless-json 4.3.1 (MIT, no runtime dependencies) in package/lock and attribution. Do not install @nktkas/hyperliquid.

### 6.2 Durable wallet epoch

Append 000006_perp_wallet_bindings with:

- one permanent owner row: owner FK/PK, Privy subject, bound/unbound state, nullable wallet ID, nullable lowercase nonzero EVM address, nullable master kind, nonnegative bigint epoch, last verification and timestamps;
- bound-state consistency, partial unique active wallet ID/address constraints, and cleared authority on unbind;
- immutable events containing action, request ID, from/to version, timestamps only—no token, DID, address, wallet ID, or provider response;
- transition guards: authority changes exactly +1, refresh unchanged, nonempty rollback denied.

Add a strict repository with loop_users owner/Privy cross-check, row locks, expected-version CAS, idempotent identical retries, monotonic transitions, safe errors, and concurrency tests. Compose it through Database/readiness/fakes/scripts.

PerpIntentRepository.prepare must lock and compare bound state, owner, current Privy subject, address, kind, and epoch before generic/domain inserts. Mismatch rolls back and maps to existing stale intent.

### 6.3 Fresh Privy proof

Add a shared Privy client factory and narrow wallet-catalog reader. buildApp creates at most one client and injects it into verifier and users()._get(DID,{signal,timeout:4000,maxRetries:0}); keep the standalone verifier factory for tests.

The feature service strictly accepts only wallet + ethereum + wallet_client_type privy + connector_type embedded, validates nonzero EVM address and bounded nullable wallet ID, and never uses first item, wallet_index, or provider verified_at. Resolver loads the durable selection, performs a fresh lookup, matches ID+address or user-scoped address when ID is null, rejects duplicates, and returns a 15-second lease with the database epoch. No cache/stale fallback/negative cache/implicit write.

No binding or authoritative unlink -> required/409. Provider/DB/malformed/duplicate/cross-user failure -> unavailable/503. Outer abort propagates.

### 6.4 Lifecycle routes

Add strict no-store wallet binding routes/service tests. Versions are decimal strings safe beyond JavaScript integer range. Error bodies never reveal current authority. Successful identical retries return the committed state. Add OpenAPI and preserve current authentication/input guards.

### 6.5 Weighted global quota

Add optional quota bucket cost default 1. SQL inserts/adds cost and permits only issued_count + cost <= capacity; Stream stays equivalent.

Add Hyperliquid policy hyperliquid_info_v1 with domain-separated HMAC, 60-second global PostgreSQL window, default internal cap 960 versus official 1200. Reserve before actual fetch: meta 20, clearinghouseState 2, frontendOpenOrders 20, fills worst case 120, funding worst case 45. Denial is non-retryable 503 before fetch.

Config adds enabled flag, quota HMAC secret, and weight limit. Default disabled. Enabled requires Privy, cursor secret, strong quota secret; partial settings fail startup. Testnet URL is compiled, not configurable/client supplied.

### 6.6 Lossless transport and mapper

Add a fixed Testnet transport with injected fetch, response-size cap, JSON content-type check, lossless parser, and sanitized typed errors. Fetch rejection before Response -> retryable pre-response; 5xx -> retryable; 4xx/429, body read, oversize/content-type/parse/malformed 2xx -> non-retryable unavailable. Outer abort is preserved. No raw request/body enters Error/log.

Map against one <=60s strict Core meta:

- config: unique active BTC/ETH/SOL; derive size increment, leverage, margin mode; fees/minimum notional unavailable;
- account/positions: clearinghouseState user+dex empty; reject nonallowlisted positions; map exact decimal strings/nonzero position sign;
- orders: frontendOpenOrders user+dex empty; only ordinary Limit Gtc/Alo/Ioc; reject Spot/HIP-3/nonallowlist, trigger/TP-SL/TWAP/children/unknown; exact uint64 sort;
- fills: userFillsByTime, frozen server-owned seven-day window, aggregate false; reject mixed products, builder/TWAP, non-USDC fee, malformed values; sort by time then exact tid; 2000 rows means truncated;
- funding: userFunding over frozen seven days; strict funding delta/Core allowlist; hash+coin tie; 500 rows means truncated.

Fills/funding page locally within the frozen capped response using encrypted provider-neutral window+tuple cursor; cap remains honestly truncated and older history is not claimed. Positions/orders are fresh live-keyset, documented as non-snapshot. Cache only valid meta to its <=60s expiry. Existing service revalidates two-second private freshness and every normalized DTO.

### 6.7 Composition and docs

Real resolver is composed with configured Privy/database. Real reader is composed only with explicit enablement; injected dependencies still win. Update redaction, env template, README, local development, API inventory, product decisions, attribution, and regenerate OpenAPI once. State backend capability implemented while credentialed Testnet/Privy, device, tunnel, and deployment evidence remains unverified.

## 7. Implementation Sequence

1. Commit this plan only.
2. Add Decisions 0010/0011, exact lossless dependency, config/redaction tests; keep default disabled.
3. Add migration/repository/readiness and PostgreSQL concurrency/rollback tests.
4. Add shared Privy client, catalog reader, lifecycle service/resolver/routes/OpenAPI behavior.
5. Add Perp intent transactional binding compare and rotate/unbind race tests.
6. Add weighted quota and Stream compatibility/concurrency tests.
7. Add lossless transport, strict mapper, pagination and failure-stage tests.
8. Compose enablement, regenerate OpenAPI once, update docs, run full matrix, review staged GitNexus changes, commit coherent slices and push.
9. Report credentialed provider/device/deployment checks as unverified, per backend-first sequencing.

Before each symbol edit: refresh/index check and exact upstream impact. Before each commit: stage intended files, detect_changes(scope=staged), review, then atomic commit.

## 8. Test Strategy

Wallet:
- GET initial unbound 0 without write; one-candidate PUT -> bound 1; zero/multiple -> 409/no write;
- existing selection among multiple -> refresh; rotate/unbind/rebind monotonic; identical retry stable;
- concurrent CAS one winner; nullable ID; invalid/zero/address normalization; duplicate/user mismatch/unlink/provider failures/abort;
- cross-owner uniqueness, immutable safe events, old cursor invalidation, Perp prepare rollback on race.

Quota/transport:
- default cost one and Stream unchanged; weighted concurrent cap;
- quota before fetch and exact declared reservations;
- fixed URL/method/body; address absent from errors/logs;
- pre-response/abort/5xx/429/4xx/content/body/size/JSON/malformed response classes;
- oid/tid above 2^53 preserved exactly.

Mapper:
- Core meta uniqueness/delist/size increment/margin/TTL cache;
- account/position decimal/sign/leverage/zero behavior;
- orders reject every forbidden/mixed variant;
- seven-day fills/funding, 2000/500 truncation, same-time tie, encrypted cursor, cross-scope replay rejection, live orders/positions semantics;
- mixed/unknown/numeric financial/exponent/hash/uint64/stale/shape drift -> sanitized 503, never empty/zero success.

Run pnpm install, pnpm check, pnpm test:contract, pnpm test:worker, pnpm db:up, pnpm db:migrate, pnpm test:integration, pnpm secrets:check, docker compose config --quiet, and both Docker builds. Exercise empty rollback/up and rollback refusal with binding history. Credentialed suites remain unverified without inputs.

## 9. Risk and Impact Analysis

- HIGH composition: buildApp/loadConfig/database affect startup, OpenAPI, and many fakes; preserve injection/defaults and direct tests.
- HIGH authority: no GET/read-path selection; only explicit PUT changes selection.
- HIGH transaction: lock/compare before operation insert to close review/rotation race.
- HIGH numeric: provider uint64 requires lossless parse before projection.
- HIGH retry/privacy: response-stage failure cannot retry; raw address/body cannot enter errors.
- MEDIUM availability: strict unknown/mixed rejection may make views unavailable after provider drift or Spot/HIP-3 activity; intentional fail closed.
- MEDIUM quota: worst-case reservation underutilizes allowance but cannot oversubscribe it.
- MEDIUM pagination: distinguish live keyset from bounded frozen history.
- Migration: concurrency, partial uniqueness, immutable audit, destructive down guard.
- Evidence: fakes do not prove credentialed Privy/Testnet/device/deployment.

## 10. Files Expected to Change

| File(s) | Symbols | Reason |
| --- | --- | --- |
| docs/decisions/0010-*,0011-* | new ADRs | Lifecycle and lossless read authority |
| package.json,pnpm-lock.yaml,docs/open-source-attribution.md | dependency | Exact parser/license |
| migrations/000006_* | up/down | Durable epoch/events |
| src/database/perp-wallet-binding-repository.ts | repository | Locked lifecycle |
| src/database/database.ts,schema.ts | composition/readiness | New repository/head |
| src/database/perp-intent-repository.ts | prepare | Final binding compare |
| src/database/control-plane-repository.ts | quota | Weighted cost |
| src/integrations/privy/* | shared client/catalog | Current wallet proof |
| src/features/perp/wallet-binding-* | service/resolver | Explicit lifecycle/fresh lease |
| src/routes/perp-wallet-binding.ts | routes | Three protected APIs |
| src/integrations/hyperliquid/* | transport/reader | Lossless strict Testnet reads |
| src/config.ts,src/app.ts,.env.example | enablement | Default-off composition/redaction |
| openapi/loop-api.v1.json,docs/api-inventory.md | contract | Lifecycle/provider status |
| test/*wallet-binding*,test/*hyperliquid*,existing suites | tests | Behavior/integration/regression |
| README.md,docs/local-development.md,docs/product-decisions.md | docs | Honest readiness |

## 11. Reusable Implementation Context

~~~yaml
implementation_context:
  task_summary: "Explicit durable Privy wallet binding plus lossless default-off Hyperliquid Testnet Core private reads."
  acceptance_criteria:
    - "Binding routes are owner-bound, never accept/return authority, and maintain a monotonic epoch."
    - "Every private read fresh-verifies the stored selection before Hyperliquid."
    - "Reads are fixed Testnet/Core/BTC-ETH-SOL, weighted, lossless, strict, and sanitized."
    - "Perp intent finalization rejects rotated/unbound authority transactionally."
    - "Existing Stream quota and current API contracts remain compatible."
    - "Full local verification passes; credentialed/device/deployment evidence is unverified."
  evidence_provenance:
    {
      "schema_version": 2,
      "head_commit": "b3e91cebc18d76551b40e8211303a40e9647dafd",
      "generated_plan_path": "docs/plans/2026-08-25-gitnexus-plan-wallet-private-reads.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "239ae7332b11290482c1c5048a28304015e022dfb04ba425a766f1f03f13a66f"
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
          "head_digest": "sha256:7b3b266fcbe52d48c0943dbca0486f2b38c66cffff87e9a17cdb8ed15bbd7765",
          "index_digest": "sha256:7b3b266fcbe52d48c0943dbca0486f2b38c66cffff87e9a17cdb8ed15bbd7765",
          "worktree_digest": "sha256:7b3b266fcbe52d48c0943dbca0486f2b38c66cffff87e9a17cdb8ed15bbd7765",
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
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f4a3d228effae9cef3d2ec7c55a51cec1d4fa5b4d9ee2de7a0a713ef413e34df",
          "index_digest": "sha256:f4a3d228effae9cef3d2ec7c55a51cec1d4fa5b4d9ee2de7a0a713ef413e34df",
          "worktree_digest": "sha256:b4489e21ec2581d6030af61c450991ecc92332017ee2e2db3ab9e03e354bc38f",
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
          "head_digest": "sha256:535e02241bdf82e51d2b21e886f09f6a39fba1b5504ccdbf4cec4ecc4b451741",
          "index_digest": "sha256:535e02241bdf82e51d2b21e886f09f6a39fba1b5504ccdbf4cec4ecc4b451741",
          "worktree_digest": "sha256:535e02241bdf82e51d2b21e886f09f6a39fba1b5504ccdbf4cec4ecc4b451741",
          "untracked_digest": "absent"
        },
        {
          "path": "contracts/hyperliquid-core-perp/README.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:72face3827873d1b19b22268189b8d0e7dec9b6889a6290080c61d405983463b",
          "index_digest": "sha256:72face3827873d1b19b22268189b8d0e7dec9b6889a6290080c61d405983463b",
          "worktree_digest": "sha256:72face3827873d1b19b22268189b8d0e7dec9b6889a6290080c61d405983463b",
          "untracked_digest": "absent"
        },
        {
          "path": "contracts/hyperliquid-core-perp/contract.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d77c57422754d2cebe8c7dc79d10e7046688f93d77fe3c520018f61e87322849",
          "index_digest": "sha256:d77c57422754d2cebe8c7dc79d10e7046688f93d77fe3c520018f61e87322849",
          "worktree_digest": "sha256:d77c57422754d2cebe8c7dc79d10e7046688f93d77fe3c520018f61e87322849",
          "untracked_digest": "absent"
        },
        {
          "path": "contracts/hyperliquid-core-perp/oss-lock.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:25fe55c272d3eb489d882b08bda56eb3074f3ec05ec78321752fb0d838b8b6b2",
          "index_digest": "sha256:25fe55c272d3eb489d882b08bda56eb3074f3ec05ec78321752fb0d838b8b6b2",
          "worktree_digest": "sha256:25fe55c272d3eb489d882b08bda56eb3074f3ec05ec78321752fb0d838b8b6b2",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/api-inventory.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:10ffab0c7c4277b95eae9d45adcf78c6f5f3ab938cdd6fd7171f771142432a13",
          "index_digest": "sha256:10ffab0c7c4277b95eae9d45adcf78c6f5f3ab938cdd6fd7171f771142432a13",
          "worktree_digest": "sha256:10ffab0c7c4277b95eae9d45adcf78c6f5f3ab938cdd6fd7171f771142432a13",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0002-privy-bearer-bootstrap.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6ceaed5d975c7a79a6af855d295ed03de9a0511c126c4a06a753e42758f65ec5",
          "index_digest": "sha256:6ceaed5d975c7a79a6af855d295ed03de9a0511c126c4a06a753e42758f65ec5",
          "worktree_digest": "sha256:6ceaed5d975c7a79a6af855d295ed03de9a0511c126c4a06a753e42758f65ec5",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0005-hyperliquid-private-read-interface.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:cd54555730301ab8a3806c7e2df553b3c3f17f8eb5d368569906409fdcf7e9ef",
          "index_digest": "sha256:cd54555730301ab8a3806c7e2df553b3c3f17f8eb5d368569906409fdcf7e9ef",
          "worktree_digest": "sha256:cd54555730301ab8a3806c7e2df553b3c3f17f8eb5d368569906409fdcf7e9ef",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0006-perp-intent-interface.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:960acb88b0c3da9f4b49b726e900197d906e3e1a47f40a0d67174b9acd9442ce",
          "index_digest": "sha256:960acb88b0c3da9f4b49b726e900197d906e3e1a47f40a0d67174b9acd9442ce",
          "worktree_digest": "sha256:960acb88b0c3da9f4b49b726e900197d906e3e1a47f40a0d67174b9acd9442ce",
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
          "head_digest": "sha256:b00da2ffdea0501f309f9c24291c717e0a25b7e1394d13a21e3e321a65000a27",
          "index_digest": "sha256:b00da2ffdea0501f309f9c24291c717e0a25b7e1394d13a21e3e321a65000a27",
          "worktree_digest": "sha256:b00da2ffdea0501f309f9c24291c717e0a25b7e1394d13a21e3e321a65000a27",
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
          "head_digest": "sha256:b3f8593fdda36fdb4436495eeb03545ebaf4b952d069516cf13a9653dd1c69cf",
          "index_digest": "sha256:b3f8593fdda36fdb4436495eeb03545ebaf4b952d069516cf13a9653dd1c69cf",
          "worktree_digest": "sha256:b3f8593fdda36fdb4436495eeb03545ebaf4b952d069516cf13a9653dd1c69cf",
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
          "head_digest": "sha256:963b2f015cb07ece99cce22078fe2b060f98863b9b3e845520b30718b4dbee10",
          "index_digest": "sha256:963b2f015cb07ece99cce22078fe2b060f98863b9b3e845520b30718b4dbee10",
          "worktree_digest": "sha256:963b2f015cb07ece99cce22078fe2b060f98863b9b3e845520b30718b4dbee10",
          "untracked_digest": "absent"
        },
        {
          "path": "migrations/000005_personalization_alerts.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a39c7776175bb5ec32572fb9f4c786cd2b90998112fbcc59810abc6e22454a20",
          "index_digest": "sha256:a39c7776175bb5ec32572fb9f4c786cd2b90998112fbcc59810abc6e22454a20",
          "worktree_digest": "sha256:a39c7776175bb5ec32572fb9f4c786cd2b90998112fbcc59810abc6e22454a20",
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
          "head_digest": "sha256:0733cee2748de24d605278625bded353d9b0ea27103ef7b1274b709ec4601a90",
          "index_digest": "sha256:0733cee2748de24d605278625bded353d9b0ea27103ef7b1274b709ec4601a90",
          "worktree_digest": "sha256:0733cee2748de24d605278625bded353d9b0ea27103ef7b1274b709ec4601a90",
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
          "head_digest": "sha256:07bcccbc826560e3b4e32022f0a02914ebe18ca76844a428c010f548f40cbf61",
          "index_digest": "sha256:07bcccbc826560e3b4e32022f0a02914ebe18ca76844a428c010f548f40cbf61",
          "worktree_digest": "sha256:07bcccbc826560e3b4e32022f0a02914ebe18ca76844a428c010f548f40cbf61",
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
          "head_digest": "sha256:ced8a10af48013a9faa537cb57fc4129ab8b4209dce19542ab52f40374d52559",
          "index_digest": "sha256:ced8a10af48013a9faa537cb57fc4129ab8b4209dce19542ab52f40374d52559",
          "worktree_digest": "sha256:ced8a10af48013a9faa537cb57fc4129ab8b4209dce19542ab52f40374d52559",
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
          "head_digest": "sha256:bc50ac533f1080f2a6b452a420ed2c1016d600dfd1954a67865bc4213a248ba7",
          "index_digest": "sha256:bc50ac533f1080f2a6b452a420ed2c1016d600dfd1954a67865bc4213a248ba7",
          "worktree_digest": "sha256:bc50ac533f1080f2a6b452a420ed2c1016d600dfd1954a67865bc4213a248ba7",
          "untracked_digest": "absent"
        },
        {
          "path": "src/database/control-plane-repository.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:171610d4378ebd6003bb515114741c060c50d9af1c0a65e892e670044e7ffa18",
          "index_digest": "sha256:171610d4378ebd6003bb515114741c060c50d9af1c0a65e892e670044e7ffa18",
          "worktree_digest": "sha256:171610d4378ebd6003bb515114741c060c50d9af1c0a65e892e670044e7ffa18",
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
          "head_digest": "sha256:c4a6a18099e93623c09cdfc90edc4f0eec10dad990bf2624345c5316d0a4d8fa",
          "index_digest": "sha256:c4a6a18099e93623c09cdfc90edc4f0eec10dad990bf2624345c5316d0a4d8fa",
          "worktree_digest": "sha256:c4a6a18099e93623c09cdfc90edc4f0eec10dad990bf2624345c5316d0a4d8fa",
          "untracked_digest": "absent"
        },
        {
          "path": "src/database/perp-intent-repository.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3f69788ffa42c3f9ffe967f4a68ba34a70e1dc17123919549fce896038dc7126",
          "index_digest": "sha256:3f69788ffa42c3f9ffe967f4a68ba34a70e1dc17123919549fce896038dc7126",
          "worktree_digest": "sha256:3f69788ffa42c3f9ffe967f4a68ba34a70e1dc17123919549fce896038dc7126",
          "untracked_digest": "absent"
        },
        {
          "path": "src/database/schema.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:eca35e5d7bac4043eae0f821a30e920f3f3e1b173b8dede91a94221851ba5996",
          "index_digest": "sha256:eca35e5d7bac4043eae0f821a30e920f3f3e1b173b8dede91a94221851ba5996",
          "worktree_digest": "sha256:eca35e5d7bac4043eae0f821a30e920f3f3e1b173b8dede91a94221851ba5996",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/perp/private-read-cursor.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9b9ad93e1946c8b9c272852fefe6f1ce3e35ce461bdeabe2949ed2fe4b70731c",
          "index_digest": "sha256:9b9ad93e1946c8b9c272852fefe6f1ce3e35ce461bdeabe2949ed2fe4b70731c",
          "worktree_digest": "sha256:9b9ad93e1946c8b9c272852fefe6f1ce3e35ce461bdeabe2949ed2fe4b70731c",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/perp/private-read-service.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ec3f4568d66cc1f57c6a964dbca9f9d9b0e5fc55d83ff523d286719cba64837e",
          "index_digest": "sha256:ec3f4568d66cc1f57c6a964dbca9f9d9b0e5fc55d83ff523d286719cba64837e",
          "worktree_digest": "sha256:ec3f4568d66cc1f57c6a964dbca9f9d9b0e5fc55d83ff523d286719cba64837e",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/perp/wallet-binding-resolver.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d82dcebd6452eaf7af8e9e33d43acd3973160fe3c837939f7895c0f2912015de",
          "index_digest": "sha256:d82dcebd6452eaf7af8e9e33d43acd3973160fe3c837939f7895c0f2912015de",
          "worktree_digest": "sha256:d82dcebd6452eaf7af8e9e33d43acd3973160fe3c837939f7895c0f2912015de",
          "untracked_digest": "absent"
        },
        {
          "path": "src/integrations/hyperliquid/private-reader.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:618f731bab07dd22b5b73621f96d96f8795e83fb111424c884c3d18b9db47567",
          "index_digest": "sha256:618f731bab07dd22b5b73621f96d96f8795e83fb111424c884c3d18b9db47567",
          "worktree_digest": "sha256:618f731bab07dd22b5b73621f96d96f8795e83fb111424c884c3d18b9db47567",
          "untracked_digest": "absent"
        },
        {
          "path": "src/integrations/privy/access-token-verifier.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6529820780f7fb0414a0d2e8fae4d5f96daca05cccc05f737f44009bd8f2968f",
          "index_digest": "sha256:6529820780f7fb0414a0d2e8fae4d5f96daca05cccc05f737f44009bd8f2968f",
          "worktree_digest": "sha256:6529820780f7fb0414a0d2e8fae4d5f96daca05cccc05f737f44009bd8f2968f",
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
          "head_digest": "sha256:172328e0ba3f3b42241123c94903999fac0211863960418b84b252ff3db784a3",
          "index_digest": "sha256:172328e0ba3f3b42241123c94903999fac0211863960418b84b252ff3db784a3",
          "worktree_digest": "sha256:172328e0ba3f3b42241123c94903999fac0211863960418b84b252ff3db784a3",
          "untracked_digest": "absent"
        },
        {
          "path": "test/control-plane-repository.integration.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:26c595d780825dd1430e26659a72a2ad9ce6980b9f6d5038b1c765db86e184eb",
          "index_digest": "sha256:26c595d780825dd1430e26659a72a2ad9ce6980b9f6d5038b1c765db86e184eb",
          "worktree_digest": "sha256:26c595d780825dd1430e26659a72a2ad9ce6980b9f6d5038b1c765db86e184eb",
          "untracked_digest": "absent"
        },
        {
          "path": "test/database-schema.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e9c86be4bb1bb028cbcf3c86c1857e1366345d368427eca68aca54d74e0f6554",
          "index_digest": "sha256:e9c86be4bb1bb028cbcf3c86c1857e1366345d368427eca68aca54d74e0f6554",
          "worktree_digest": "sha256:e9c86be4bb1bb028cbcf3c86c1857e1366345d368427eca68aca54d74e0f6554",
          "untracked_digest": "absent"
        },
        {
          "path": "test/perp-intent-repository.integration.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2b3a85c651cc9365a30487ccf941e3bac813f112bc47398b4b965d478d9297b0",
          "index_digest": "sha256:2b3a85c651cc9365a30487ccf941e3bac813f112bc47398b4b965d478d9297b0",
          "worktree_digest": "sha256:2b3a85c651cc9365a30487ccf941e3bac813f112bc47398b4b965d478d9297b0",
          "untracked_digest": "absent"
        },
        {
          "path": "test/perp-private-read-routes.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:104d6248617b3da5e3f7e0493b12fb558d54b979fdaa8c602a56ca4ca99a302a",
          "index_digest": "sha256:104d6248617b3da5e3f7e0493b12fb558d54b979fdaa8c602a56ca4ca99a302a",
          "worktree_digest": "sha256:104d6248617b3da5e3f7e0493b12fb558d54b979fdaa8c602a56ca4ca99a302a",
          "untracked_digest": "absent"
        },
        {
          "path": "test/perp-private-read-service.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ac357ade9d71f6c210bbad354cbcf7e04aa167a04de6ff5d832728d9aabcdfad",
          "index_digest": "sha256:ac357ade9d71f6c210bbad354cbcf7e04aa167a04de6ff5d832728d9aabcdfad",
          "worktree_digest": "sha256:ac357ade9d71f6c210bbad354cbcf7e04aa167a04de6ff5d832728d9aabcdfad",
          "untracked_digest": "absent"
        }
      ]
    }
  primary_symbols:
    - {symbol: "buildApp", file: "src/app.ts", lines: "176-522", role: "Composition root"}
    - {symbol: "loadConfig", file: "src/config.ts", lines: "175-273", role: "Fail-closed config"}
    - {symbol: "createPostgresDatabase", file: "src/database/database.ts", lines: "64-172", role: "Repository/readiness"}
    - {symbol: "createPerpPrivateReadService", file: "src/features/perp/private-read-service.ts", lines: "1327-1374", role: "Retry/parser/cursor"}
    - {symbol: "consumeIssuanceQuota", file: "src/database/control-plane-repository.ts", lines: "1126-1219", role: "Global quota"}
    - {symbol: "prepare", file: "src/database/perp-intent-repository.ts", lines: "881-1098", role: "Atomic intent finalizer"}
  execution_path:
    - "Bearer auth -> durable selection -> fresh Privy match -> weighted quota -> fixed lossless Info -> existing parser/cursor."
  guardrails:
    - "No automatic selection, client authority, subaccount, Mainnet, SDK Exchange, signer, nonce, transfer, or mutation."
    - "No native JSON.parse for uint64 provider results and no raw provider request/body in errors/logs."
    - "No provider call before fresh binding and quota."
    - "OpenAPI regenerated only at final artifact step."
  verification:
    - "pnpm check"
    - "pnpm test:contract"
    - "pnpm test:worker"
    - "pnpm test:integration"
    - "pnpm secrets:check"
    - "docker compose config --quiet"
    - "pnpm docker:build:migration"
    - "pnpm docker:build:runtime"
  unresolved:
    - "Credentialed Privy/Testnet/device/deployment evidence."
    - "Interactive multi-wallet selection, subaccounts, mutation/signing, history beyond seven-day caps."
~~~

## 12. Assumptions and Open Questions

- [assumed] Seven days is the first bounded fills/funding window; cap truncation is explicit.
- [assumed] A 15-second fresh binding lease covers the existing read deadline without cross-request cache.
- [assumed] Internal 960/1200 weight margin is appropriate for Development; production egress topology remains a deployment gate.
- [verified] Registry metadata for lossless-json 4.3.1: MIT, no runtime dependencies, integrity sha512-SqD/Bg3ZfltBJ2Z14hJ/BihnvtV553WO4g9/ePtlp4lrnl9jF3AdIJt53A/Wkg/0Li+LMfxaBqgx1MiFZdQlpQ==. Lock verification remains execution work.
- [verified] Privy stays 0.29.0; required DID lookup exists and upgrading is outside scope.
- Phone/Cloudflare integration is intentionally deferred.

## 13. Definition of Done

Decisions, exact dependency record, migration, repository, three binding routes, real default-off reader, quota, composition, docs, and OpenAPI are committed. Resolver never guesses and makes rotation invalidate cursor/intent authority. Reader preserves uint64, emits existing decimal DTOs, rejects mixed/unknown/stale data, respects quota/retry stages, and exposes no mutation path. Full local checks and Docker builds pass, commits are atomic and pushed, and missing credentialed/device/deployment evidence is reported unverified.

