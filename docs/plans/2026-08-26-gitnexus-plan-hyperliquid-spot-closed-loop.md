# GitNexus Engineering Plan

> Task: Implement the first Hyperliquid-native Spot closed loop on Testnet, while reserving Mainnet for a separate production-release gate.
> Evidence verified at commit 56ed32b16a896b3fa36b309a59b897ec699c8ad1. The GitNexus index is current at the same HEAD and includes PDG data. Analyzer provenance is unavailable in this environment, so graph results are navigation and impact evidence; verified source and official Hyperliquid documentation are authoritative.
> Evidence provenance schema 2; global dirty digest 9c8e85cd6850b4c829b5f7c3593ca14d9524f1600f1e44d509f9af31a3de3559; cited-path manifest 30 sorted entries; exact generated plan path excluded.

## 1. Objective

Deliver one backend-owned, credentialed Hyperliquid Testnet Spot vertical slice for the agreed product journey:

Privy login -> existing LOOP bootstrap -> Market -> token/market facts -> durable quote and F11 review -> current Privy authorization -> one capped-IOC Spot order attempt -> authoritative reconciliation -> refreshed wallet holdings.

The first mutation is a buy or sell against a server allowlisted native Hyperliquid Spot pair. It is implemented as an aggressive IOC limit order with a reviewed worst price, because Hyperliquid does not expose a separate market-order action. The backend owns pair resolution, agent identity, nonce allocation, signing, risk limits, idempotency, the one write attempt, and reconciliation.

Keep Perp code present but dormant and unchanged at the public contract. Do not implement perpetual trading, resting-limit order management, cancel/modify, TP/SL, TWAP, batch orders, transfers, withdrawals, bridge, automation, builder fees, or Mainnet in this slice.

## 2. Current Behaviour

- [verified] The API currently exposes 40 OpenAPI operations and no /v1/spot/* route. The inventory describes bootstrap, Stream, profile/watchlist/alerts, transfer placeholders, and Perp-oriented wallet/private-read/intent surfaces (docs/api-inventory.md; scripts/generate-openapi.ts; test/openapi.test.ts).
- [verified] POST /v1/bootstrap already verifies a current Privy access token, creates or finds the internal LOOP UUID, and derives the Stream user ID. Spot must require this mapping rather than invent another identity source (src/core/http/authentication.ts; src/app.ts).
- [verified] buildApp is the central Fastify composition root, uses UUID request IDs, bounded request/handler timeouts, redacted failures, strict route registration, and generated OpenAPI (src/app.ts:194-574).
- [verified] The generic control plane already persists provider-operation states, one bounded transport attempt, durable attempt IDs/deadlines, idempotency claims, leases/fences, reconciliation scheduling, quotas, and append-only audits (migrations/000002_api_control_plane.ts; src/database/control-plane-repository.ts).
- [verified] Perp prepare demonstrates the required sequence: strict input and digest, idempotency claim/replay, wallet resolution, provider review, freshness validation, authority re-resolution, and atomic prepare. Its submit remains fail-closed because no signer or Exchange adapter is composed (src/features/perp/perp-intent-service.ts:658-847).
- [verified] Existing wallet binding and agent-authorization storage are Perp-named. Spot must not import Perp feature contracts or make Perp the authority for a new product domain (migrations/000003_perp_intents.ts; migrations/000004_agent_authorizations.ts; docs/decisions/0010-perp-wallet-binding-lifecycle.md).
- [verified] Reconciliation workers lease one operation at a time and are read-only with respect to provider actions. Atomic-domain handlers finalize generic and domain state in one transaction (docs/decisions/0012-standalone-reconciliation-worker.md; src/features/reconciliation/reconciliation-service.ts:306-467).
- [verified] The production reader registry is keyed only by domain. Adding a second hyperliquid handler without changing that key would either collide or route Spot operations into the Perp handler (src/features/reconciliation/authoritative-reader.ts:102-178; src/reconciliation-worker-readers.ts:28-51).
- [verified] Hyperliquid Info quota is provider-global and backed by PostgreSQL. Spot API reads and worker reads must share it rather than create a second budget (src/integrations/hyperliquid/info-quota.ts).
- [verified] Current config and product decisions keep Mainnet, withdrawals, and automation disabled. Testnet is the only trading environment contemplated by the running backend (src/config.ts; .env.example; docs/product-decisions.md).

## 3. Relevant Architecture

### 3.1 Ownership

- Spot product contracts, services, policies, and DTOs live under src/features/spot/.
- Hyperliquid HTTP, exact serializers/parsers, signer adapter, and provider readers live under src/integrations/hyperliquid/.
- Generic identity, idempotency, provider-operation, audit, quota, and reconciliation primitives remain shared.
- Database composition remains in src/database/; Spot has independent repositories and rows.
- Routes live under src/routes/spot-*.ts and are composed by buildApp.
- Spot code must not import src/features/perp/**, Perp repositories, Perp routes, or Perp reconciliation readers. A shared primitive must first move behind a provider-neutral or identity-neutral port with Perp compatibility tests.

### 3.2 Authority boundary

- Privy remains the identity and embedded-wallet truth source.
- The client may send only product intent: server-issued market ID, side, amount mode/value, and an optional bounded slippage preference.
- The client never sends network, account address, wallet ID, agent address, provider pair index, provider order asset, nonce, CLOID, wire action, typed-data domain, or order signature.
- Every authenticated Spot route verifies the current Privy bearer and requires the existing LOOP bootstrap mapping.
- The mobile wallet signs only the narrowly allowlisted one-time approveAgent handoff. After F11, POST submit requires a fresh authenticated request; the server-owned per-user Testnet agent signs the exact reviewed order.
- Wallet rotation, unbind, binding-epoch change, expired review, changed market metadata, agent change, policy change, or material quote change invalidates the intent. There is no silent repricing.

### 3.3 Hyperliquid Spot identity

The implementation must keep four provider identifiers distinct and network-scoped:

1. token index from spotMeta.tokens[].index for balances;
2. chain token ID from spotMeta.tokens[].tokenId;
3. Spot pair index from spotMeta.universe[].index;
4. Exchange order asset equal to 10000 + pair index.

The server issues an opaque market_id bound to Testnet, the pair/token identifiers, metadata version/hash, and policy allowlist. Client ticker text or a raw numeric ID is never execution authority.

Official protocol constraints are sourced from:

- Hyperliquid Spot Info: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot
- Exchange endpoint: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- Asset IDs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
- Tick and lot size: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
- Signing: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
- Nonces/API wallets: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- Official Python SDK Spot example at commit 2fdb18f9517675ea03695a0962bd19eece9c83f0: https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/examples/basic_spot_order.py

## 4. GitNexus Findings

- [graph] Repository index is current at HEAD: 206 files, 15,273 symbols, 283 processes, with PDG data.
- [graph] context and impact for buildApp reported HIGH risk: seven direct and three depth-two consumers, including server startup, OpenAPI generation, and tests. New options must preserve current dependency-injection precedence and default-off behavior.
- [graph] impact for loadConfig reported HIGH risk: eleven direct and seven depth-two consumers across startup, OpenAPI, bootstrap/Stream tests, and integration setup. Spot enablement must be additive and all-or-nothing.
- [graph] impact for createPostgresDatabase reported HIGH risk: five direct and seven depth-two consumers, including buildApp and integration test factories. Database interface additions require compatible fakes.
- [graph] createPostgresControlPlaneRepository was LOW risk and is the correct reusable boundary for generic idempotency/provider-operation/audit/quota behavior.
- [graph] createReconciliationWorkerReaders and runReconciliationWorker had low direct impact, but source inspection found a semantic collision: dispatch currently uses domain only while both Perp and Spot use hyperliquid.
- [graph] queries around registerPerpIntentRoutes and Perp prepare identified reusable sequencing but also a hard feature boundary. Spot should copy invariants, not import Perp domain types.
- [graph] no persisted taint finding was returned for the inspected paths. This is not proof of safety because closure/property/implicit flows may be absent from the analysis.

## 5. Statement-Level PDG Findings

- [graph] Perp prepare controls show request/body validation and digest before idempotency claim, replay before provider work, wallet resolution before review, review freshness checks, authority re-resolution, then atomic preparation. Spot prepare must preserve this order (src/features/perp/perp-intent-service.ts:665-797).
- [graph] requestSha256 flows through idempotency claim, replay binding checks, and final prepare. Spot uses a domain-separated spot_intent_request_v1 digest and refuses a key reused with a different digest.
- [graph] applyReadResult controls show malformed/operator results go to operator hold, pending/retry results are boundedly rescheduled, atomic-domain resolved results skip generic completion, and only generic readers use the generic completion write (src/features/reconciliation/reconciliation-service.ts:306-349).
- [verified] The worker performs one authoritative read under a lease and does not expose submit/sign/replay capability. Spot reconciliation must preserve that port (src/features/reconciliation/authoritative-reader.ts:60-100).
- [verified] Current find(operation.domain) at reconciliation-service line 391 and the single hyperliquid registration at reconciliation-worker-readers line 50 require a tuple-key migration before a Spot reader can be registered.

## 6. Proposed Changes

### 6.1 Record the Spot and release decisions first

Add a Spot ADR and contract package that lock:

- Hyperliquid-native Spot, Testnet only;
- one intent equals one capped-IOC order;
- exact Decimal/BigInt values, never JavaScript floating point for financial/wire values;
- server-issued market identity and server-owned policy;
- one provider write attempt, no blind retry;
- per-user/per-network/per-binding-epoch agent identity;
- current owner binding and one-time approveAgent authorization;
- read-only authoritative reconciliation;
- Perp remains dormant and behavior-compatible;
- Mainnet is a future, separately approved release, not a URL toggle.

Create contracts/hyperliquid-spot/ with official-source links, field/ID mapping, canonical fixtures, provider response fixtures, signing vectors, an OSS lock, and a target inventory. There is no official TypeScript SDK. Before selecting any community package or custom signer, pin its exact version/license/SBOM and pass byte-for-byte conformance against the official Python SDK commit above. Until then the Exchange writer stays unavailable.

### 6.2 Public API contract for the agreed loop

All Spot routes are no-store, Privy Bearer protected, LOOP-bootstrap required, strict-body/strict-query, and owner-scoped.

Core closed-loop routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /v1/spot/config | Server policy, allowlisted markets, capability state, review policy; no raw provider IDs |
| GET | /v1/spot/markets/{market_id}/facts | Executable token/market facts from one bounded metadata and book snapshot |
| GET | /v1/spot/balances | Current bound master-account Spot holdings |
| POST | /v1/spot/intents | Durable quote plus immutable F11 review; requires UUID Idempotency-Key |
| GET | /v1/spot/intents/{intent_id} | Owner-scoped review/execution/reconciliation resource |
| POST | /v1/spot/intents/{intent_id}/submit | Fresh-authenticated, exact reviewed one-attempt submit |

Required onboarding/authority routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /v1/spot/wallet-binding | Read binding state/epoch without returning wallet authority |
| PUT | /v1/spot/wallet-binding | Explicit bind/refresh/rotate from current Privy wallet catalog |
| DELETE | /v1/spot/wallet-binding | Explicit unbind with expected epoch |
| POST | /v1/spot/agent-authorizations | Create one exact, expiring approveAgent handoff |
| GET | /v1/spot/agent-authorizations/{authorization_id} | Poll owner-scoped authorization state |
| POST | /v1/spot/agent-authorizations/{authorization_id}/signatures | Accept only the expected owner signature and reconcile approval |

Do not add a standalone /quotes resource in the first slice. POST /v1/spot/intents is the durable quote/review resource, eliminating quote-to-review drift. Public indicative prices remain the mobile public Testnet adapter; backend facts are for execution.

Do not add general /orders or /fills lists yet. The intent resource returns authoritative facts for its one order, and balances close the wallet loop. Add history/list endpoints only after this slice or before supporting resting limit orders.

Intent request:

~~~json
{
  "market_id": "server-issued opaque identifier",
  "side": "buy",
  "amount": {
    "mode": "quote",
    "value": "25.00"
  },
  "max_slippage_bps": 50
}
~~~

Rules:

- amount.mode is quote or base; value is a canonical positive decimal string.
- max_slippage_bps is optional, integer, bounded by the server's lower product cap; omission uses the server default.
- buy/sell, amount, and slippage are intent, not authority.
- unknown fields, exponents, signs where forbidden, noncanonical zeros, excess precision, below-minimum orders, disabled markets, and stale metadata fail before persistence/provider write.

The prepared intent returns:

- intent ID, prepared status, created/expires timestamps;
- market/base/quote display identity and Testnet label;
- side, amount mode/value, computed base size;
- reference price and source timestamp;
- reviewed worst IOC limit price;
- maximum spend or minimum receive;
- fee rate/estimate and source;
- metadata version, policy version, binding epoch;
- review_digest using spot_review_v1;
- capability/authorization state without wallet, agent, nonce, or raw wire fields.

First creation returns 201. Exact idempotent replay returns the same resource without a new quote or provider read. Reusing the key with a different spot_intent_request_v1 digest returns 409.

The review TTL is a server policy, initially targeted at 10-15 seconds and finalized through physical-device Testnet latency measurements. Expiry always requires a new intent and visible re-review.

### 6.3 Market facts, quote, and exact arithmetic

Add a strict Testnet Spot Info adapter using:

- spotMeta and spotMetaAndAssetCtxs for tokens, pairs, delisting/context, oracle/mark/mid context, and metadata version;
- l2Book for the reviewed executable quote and depth;
- spotClearinghouseState for balances;
- userFees when needed for a current fee estimate;
- frontendOpenOrders, orderStatus, userFillsByTime, and historicalOrders for reconciliation.

The metadata mapper:

- rejects duplicate/missing token and pair identifiers, inconsistent symbols, unsupported quote token, delisted/unknown pairs, and shape drift;
- constructs one immutable network-scoped market registry snapshot;
- enforces the server allowlist using stable token/pair identity, not ticker alone;
- never shares registry/cache entries between Testnet and future Mainnet.

Price and size formatting follow official constraints: price has at most five significant figures and at most 8 - szDecimals decimal places; size uses the base token szDecimals. Strip trailing zeros in the wire serializer. All calculations use Decimal/BigInt/string and compare the final rounded size/notional against minimums and reviewed bounds.

For the capped IOC quote, walk the bounded L2 book to calculate the base size, expected average price, and a worst price constrained by server/client slippage. Reject insufficient reviewed depth. The submit path uses the exact persisted base size and worst price; it never refetches and changes them silently.

### 6.4 Shared wallet authority without Perp coupling

Add a provider-neutral Hyperliquid wallet-binding port and an ADR-backed migration path:

- preserve the existing Perp routes and behavior for compatibility;
- make Spot /wallet-binding the product-facing contract;
- use one durable owner binding/epoch as the source of truth, not parallel Perp and Spot bindings;
- bind only an eligible Privy embedded EVM wallet resolved server-side;
- support only the Hyperliquid master account in the first slice; subaccount/vault/agent addresses are never queried as the user account;
- bind/rotate/unbind increment the monotonic epoch; an exact refresh does not;
- every Spot read/prepare/submit fresh-verifies the selected wallet against Privy;
- no route accepts or returns the selected address/wallet ID.

The implementation may adapt the current Perp repository behind the neutral port or introduce a compatibility migration. It must not create two independently mutable binding authorities.

### 6.5 Agent identity and approveAgent handoff

Use a unique Testnet agent identity per LOOP user, network, and binding epoch. Prefer a Privy server wallet/signer so the agent private key is never exported to application memory, logs, fixtures, Git, or the mobile client.

Authorization creation:

- resolves current binding and exact agent identity;
- builds only the approved Testnet approveAgent action and typed-data domain;
- stores canonical action, owner, binding epoch, agent identity, request/review digest, issued/expiry times, and policy version;
- returns only the mobile-signable canonical payload required by Privy.

Signature submission:

- accepts one signature string only;
- verifies signer equals the current bound owner;
- verifies the exact stored digest/domain/action, expiry, binding epoch, and unused status;
- submits approveAgent once with its own durable attempt journal;
- reconciles approval against authoritative provider state;
- cannot be repurposed for arbitrary typed data or another agent/network.

Agent authorization is protocol-broad, so LOOP policy must enforce Spot-only operations. There is no Perp, transfer, withdrawal, leverage, vault, subaccount, or arbitrary Exchange action in the Spot signer interface.

### 6.6 Persistence and atomicity

Add migration 000007_hyperliquid_spot_closed_loop with:

1. spot_intents and spot_intent_events;
2. spot_agent_identities and append-only identity events;
3. spot_agent_authorizations and append-only authorization events;
4. hyperliquid_signer_nonces keyed by network and signer identity/address;
5. any compatibility columns/views required to expose one neutral wallet-binding epoch.

spot_intents stores internal authority and review evidence:

- intent/provider-operation/owner IDs;
- fixed network = testnet and provider = hyperliquid;
- opaque market ID plus internal pair index, order asset, base/quote token indices and token IDs;
- metadata hash/version and policy version;
- side, amount mode/value, base size, worst price, fee estimate/rate;
- binding epoch and agent identity ID;
- server-generated unique CLOID;
- request/review digests and facts/expiry timestamps;
- state and sanitized provider outcome: oid as exact decimal string, filled base/quote, average price, terminal reason, timestamps.

Domain and generic state writes are atomic:

- prepare inserts/claims idempotency, generic provider operation, Spot intent, and events in one transaction after locking/revalidating authority;
- submit revalidates current owner/binding/agent/review/policy/metadata, then atomically commits generic and Spot state to submitting plus the durable transport attempt before any provider write;
- finalization atomically updates provider operation, Spot intent, and both audit/event streams;
- no terminal generic state may disagree with the Spot projection.

Use constants:

- idempotency scope: spot_intent_prepare;
- request digest domain: spot_intent_request_v1;
- provider domain: hyperliquid;
- operation kind: spot_intent;
- review digest domain: spot_review_v1.

Database down migration refuses destructive rollback once Spot intent/authorization history exists.

### 6.7 Nonce, signing, and one-attempt executor

Nonce allocator:

- allocates transactionally per actual signing agent and network;
- returns max(current wall-clock milliseconds, last allocated + 1);
- persists allocation before provider write and never reuses a consumed/uncertain nonce after crash/restart;
- validates Hyperliquid's allowed time window and the 100-highest-nonce behavior;
- remains shared if any future domain can use the same signer.

Signing conformance:

- constructs the exact order action using asset = 10000 + Spot pair index;
- uses MessagePack with canonical ordering and exact decimal strings;
- includes nonce, optional vaultAddress null/absent semantics, and expiry exactly as reviewed;
- computes the connection ID and phantom-agent EIP-712 signature with source b for Testnet;
- uses the Exchange signing domain required by Hyperliquid;
- proves byte-for-byte/hash/signature equivalence with pinned official Python SDK vectors for buy/sell, quote/base amount, boundary precision, and nonce cases.

Executor:

- accepts only a stored prepared Spot intent ID and the internally loaded canonical action;
- exposes no generic sign/send method;
- allows one order action, one order item, one CLOID, and IOC only;
- journals the attempt before sending;
- sends at most once;
- treats timeout/pre-response ambiguity as unknown, never as retryable failure;
- parses both top-level status and statuses[0], because top-level ok can contain an item error;
- sanitizes all provider payloads/errors and never logs signature, nonce payload, wallet address, or raw response.

Immediate outcomes:

- filled -> finalize filled;
- partial IOC fill -> finalize partially_filled with exact amounts;
- no-fill IOC/rejection -> finalize not_filled or rejected with safe code;
- accepted/ambiguous/resting/unrecognized -> unknown plus reconciliation; an impossible resting IOC is an invariant alert/operator hold, not an automatic second write.

### 6.8 Authoritative Spot reconciliation

Change AuthoritativeReaderRegistry from find(domain) to find(domain, operationKind), with a canonical tuple key and duplicate validation. Register:

- hyperliquid + perp_intent -> existing Perp handler;
- hyperliquid + spot_intent -> new Spot handler.

Update direct callers/tests before registering Spot to prevent cross-domain dispatch.

The Spot worker loads internal order identity and queries the real bound master account, never the agent address. It correlates server CLOID/oid across orderStatus, frontendOpenOrders, userFillsByTime, historicalOrders, and balance evidence. It must handle:

- filled and partial-filled terminal evidence;
- explicit provider rejection/no-fill;
- accepted but still pending;
- unknownOid, missing/truncated history, response drift, conflicting oid/CLOID, and conflicting fill/order evidence;
- bounded retries followed by operator_required, never fabricated success/failure.

The worker performs Info reads only. It never signs, submits, replays, cancels, changes price, or allocates a nonce. Atomic-domain finalization writes generic and Spot results together. Shared Hyperliquid Info quota applies across API facts/balances/review and both Perp/Spot workers.

### 6.9 Composition, enablement, and Mainnet boundary

Current implementation:

- add only explicit Testnet Spot capability configuration;
- default disabled and fail closed unless all signer, policy, quota, Privy authorization, and reconciliation inputs are present;
- keep injected test adapters higher priority than production composition;
- do not add Mainnet URL, runtime network selector, fallback, credentials, market cache, nonce namespace, or agent approval;
- keep withdrawalsEnabled and automatedTradingEnabled false.

Future production launch is a separate ADR/release project. Mainnet must have separate deployment artifacts, API origin/config, Privy audience/credentials as applicable, data/cache/nonce namespaces, market mapping, funded accounts, agent identities and user approvals, policy evidence, monitoring, runbooks, legal/compliance/security signoff, canary limits, and kill switch.

The future effective gate is conjunctive:

compiled Mainnet capability AND runtime Mainnet enablement AND deployment network Mainnet AND current policy evidence AND healthy signer AND healthy reconciliation.

A remote flag may close trading but cannot be the only control that opens Mainnet. There is no Testnet-to-Mainnet runtime fallback.

### 6.10 OpenAPI, docs, and observability

- Add a Spot OpenAPI tag and the 12 exact paths once contracts stabilize.
- Extend the API inventory and product decisions with implemented/default-off/credentialed status.
- Document required local secrets by name only; never commit values.
- Add structured safe metrics for prepares, idempotent replays, review expiry, authorization state, submit attempt count, immediate outcome, reconciliation age/result, shared quota denial, and kill-switch state.
- Alerts identify request/operation/intent UUID and safe reason code only.
- Regenerate OpenAPI once and assert no Mainnet, transfer, withdrawal, automation, arbitrary signer, raw provider-ID, or Perp mutation capability leaked.

## 7. Implementation Sequence

1. Commit this generated plan alone after user review.
2. Add the Spot ADR, Mainnet release-boundary ADR, contract inventory, official fixtures, OSS research, and signing conformance harness. Keep writer unavailable.
3. Extract the neutral wallet-binding port and provider-generic Info quota/transport primitives; preserve all Perp behavior with characterization tests.
4. Change reconciliation registry and worker dispatch to the domain plus operation-kind tuple; pass Perp regression tests before adding Spot.
5. Add migration 000007, Spot repositories, generic/Spot atomic transactions, append-only events, nonce allocator, readiness checks, and database fakes.
6. Add strict Spot contracts/services/routes with unavailable adapters: config, facts, balances, prepare/get/submit, binding, and authorization. Regenerate nothing yet.
7. Implement and verify the real Testnet Spot metadata/book/balance/fee readers, market registry, quote reviewer, exact precision formatter, and shared quota.
8. Implement the Privy-backed per-user Testnet agent identity and exact approveAgent issue/signature/reconciliation flow. Keep order submit unavailable until approval E2E passes.
9. Select/pin the Node signing implementation only after official-Python conformance passes. Implement the nonce allocator and one-attempt capped-IOC executor.
10. Add Spot authoritative reconciliation and register it under hyperliquid + spot_intent.
11. Compose the default-off Testnet capability, update env/docs/inventory/attribution, regenerate OpenAPI once, run the full local matrix, review staged impact, and commit coherent slices.
12. Run credentialed Testnet E2E with a funded allowlisted account, then perform physical-phone integration. Report provider/device/tunnel/deployment checks as unverified until actually run.
13. Start Mainnet only as the separate release project described above; do not extend this implementation opportunistically.

Before each symbol edit, refresh/check GitNexus and inspect direct upstream impact. Before each commit, stage only the intended slice, review detected changes and tests, then commit atomically.

## 8. Test Strategy

### 8.1 Contract and authority

- every Spot route rejects malformed path/query/body, unknown fields, body smuggling, non-UUID keys, invalid bearer, and missing bootstrap before feature/provider work;
- owner A cannot read/submit owner B intent, binding, balances, or authorization;
- no API accepts/returns network selector, raw provider IDs, wallet/agent address, nonce, wire action, or order signature;
- OpenAPI contains exactly the approved Spot surface and no Mainnet/Perp mutation/withdrawal/automation path.

### 8.2 Market and arithmetic

- distinguish token index, tokenId, pair index, and order asset; prove Testnet mapping cannot reuse a Mainnet fixture;
- duplicate/missing/delisted/unknown metadata fails closed;
- exact five-significant-figure price, 8 - szDecimals price decimals, size decimals, trailing-zero stripping, min size/notional, quote/base amount conversion;
- no exponent, float, Number coercion, NaN/Infinity, negative zero, or precision loss;
- L2 depth walk, insufficient depth, slippage boundary, fee boundary, metadata/book timestamp and TTL.

### 8.3 Review and idempotency

- first create versus exact replay; concurrent same-key requests return one intent/quote; changed digest conflicts;
- canonical digest stability across key order and explicit normalization;
- every material field change creates a new digest/review;
- expired/stale facts, changed metadata/policy, wallet rotation, unbind, agent change, or authorization loss requires re-review;
- submit cannot silently recalculate size/price or call provider twice.

### 8.4 Binding and agent authorization

- initial bind, exact refresh, rotate, unbind/rebind monotonic epoch;
- concurrent CAS one winner and atomic prepare/submit rollback on rotation race;
- zero/multiple Privy wallet candidate, duplicate wallet, wrong subject/owner, unlink, provider failure, timeout, and abort;
- authorization wrong wallet/digest/domain/network/agent/epoch, expiry, replay, signature malleability/canonicality, and arbitrary typed-data injection;
- provider approval ambiguous response reconciles without resubmission.

### 8.5 Nonce, signing, and execution

- parallel allocation uniqueness, monotonicity, process restart, transaction rollback, clock rollback/forward, expired/future boundary, and no reused uncertain nonce;
- pinned official SDK fixture equivalence for MessagePack bytes, connection ID, EIP-712 digest/signature, Testnet source, asset = 10000 + pair index, CLOID, and trailing-zero behavior;
- top-level error, top-level ok plus item error, filled, partial fill, no-fill IOC, rejected, accepted, unexpected resting, malformed, 4xx, 5xx, pre-response failure, response timeout, and body-stage failure;
- crash before journal, after journal/before send, during send, after response/before finalization, and after atomic finalization;
- assert one provider order write maximum for every intent.

### 8.6 Reconciliation

- tuple registry dispatches Perp and Spot independently and rejects duplicates;
- query account is current master owner, never agent;
- orderStatus/open orders/fills/history agreement, partial fill aggregation, exact oid/tid above 2^53, CLOID mismatch, unknownOid, missing/truncated/conflicting evidence;
- bounded pending/retry schedule, stale lease/fence discard, attempt exhaustion/operator hold;
- atomic Spot plus generic finalization and no generic second completion;
- worker has no signer/executor/cancel/replay dependency;
- Spot API and Perp/Spot workers share the same provider-global quota.

### 8.7 Required verification commands

Run and record exact results:

~~~sh
pnpm install --frozen-lockfile
docker compose config --quiet
pnpm db:migrate
pnpm test:integration
pnpm test:contract
pnpm test:worker
pnpm check
pnpm docker:build:migration
pnpm docker:build:runtime
pnpm docker:build:worker
pnpm secrets:check
git diff --check
~~~

Also test a clean migration up/down, rollback refusal with Spot history, credentialed Testnet agent approval/order/reconciliation, tunnel reachability, and physical-phone F11/submit latency. Missing credentials/device evidence is unverified, never passing.

## 9. Risk and Impact Analysis

- HIGH signing correctness: MessagePack ordering, decimal formatting, source, EIP-712 scheme, and nonce semantics can create valid-looking but wrong signatures. Mitigation: pinned official SDK oracle and default-closed conformance gate.
- HIGH financial authority: agent approval is protocol-broad. Mitigation: unique epoch-scoped agents and a narrow Spot-only executor with no generic Exchange method.
- HIGH ambiguous writes: timeout cannot be classified as failure. Mitigation: pre-write journal, exactly one send, server CLOID, authoritative multi-signal reconciliation, no blind retry.
- HIGH composition: buildApp/loadConfig/database affect startup/OpenAPI/tests. Mitigation: additive optional dependencies, injected adapter precedence, explicit enablement matrix, direct consumer tests.
- HIGH cross-domain dispatch: current domain-only registry would misroute Spot/Perp. Mitigation: tuple-key migration before Spot registration.
- HIGH authority race: binding/agent/policy may change after F11. Mitigation: locked transactional revalidation immediately before submitting transition and no silent re-review.
- HIGH Mainnet separation: network IDs, signing source, approvals, nonce history, balances, and risk posture differ. Mitigation: no Mainnet config in this slice and a separate deployment/release gate.
- MEDIUM metadata drift: dynamic token/pair mapping may change. Mitigation: versioned server registry, intent-bound metadata hash, strict expiry and reconciliation.
- MEDIUM availability: strict response parsing can reject provider drift. Intentional fail-closed behavior is preferable to false balances/orders.
- MEDIUM quota contention: facts/review/balances/workers share one budget. Mitigation: weighted reservation, bounded cache, observable denial, worker backoff.
- MEDIUM initial scope: no general history/cancel. Acceptable because IOC plus intent result and balances complete the first swap loop; unexpected resting is held as an invariant incident.
- Evidence limitation: current graph has no analyzer provenance and no taint result is safety proof. Source review, behavior tests, official fixtures, and credentialed E2E remain mandatory.

## 10. Files Expected to Change

| File(s) | Symbols/area | Reason |
| --- | --- | --- |
| docs/decisions/0014-*,0015-* | new ADRs | Spot boundary and future Mainnet release |
| contracts/hyperliquid-spot/* | contract/fixtures/locks | Official provider and signing evidence |
| package.json,pnpm-lock.yaml,docs/open-source-attribution.md | exact dependency | Only after signer/serializer conformance |
| migrations/000007_* | schema up/down | Spot intents, agents, auth, events, nonces |
| src/database/database.ts,src/database/schema.ts | composition/readiness | New repositories and migration head |
| src/database/spot-*.ts | repositories/finalizers | Atomic domain state |
| src/database/control-plane-repository.ts | reused transaction/quota ports | Spot integration without policy leakage |
| src/features/identity or src/features/wallet/* | neutral binding port | One authority source; Perp compatibility |
| src/features/spot/* | contracts/services/policy | Independent Spot domain |
| src/routes/spot-*.ts | 12 routes | Mobile closed-loop API |
| src/integrations/hyperliquid/*spot* | readers/reviewer/executor/signer | Strict Testnet provider adapters |
| src/integrations/hyperliquid/info-quota.ts | shared quota port | API/worker provider-global budget |
| src/integrations/hyperliquid/lossless-info-transport.ts | generic bounded transport | Remove Perp-only type leakage |
| src/features/reconciliation/authoritative-reader.ts | tuple registry | Domain plus operation kind dispatch |
| src/features/reconciliation/reconciliation-service.ts | tuple lookup | Correct handler selection |
| src/reconciliation-worker-readers.ts | Spot registration | Read-only authoritative handler |
| src/worker-runtime.ts | database/reader wiring | Spot worker composition |
| src/config.ts,src/app.ts,.env.example | default-off Testnet capability | Safe composition |
| scripts/generate-openapi.ts,openapi/loop-api.v1.json | generated contract | Publish approved endpoints |
| docs/api-inventory.md,docs/product-decisions.md,README.md | status/runbook | Honest scope and inputs |
| test/*spot*,test/*reconciliation*,existing app/config/db tests | behavior/regression | Closed loop and affected consumers |

Number the ADRs from the repository's actual next available sequence at implementation time; 0014/0015 are expected from the current tree, not authority to overwrite a concurrent decision.

## 11. Reusable Implementation Context

~~~yaml
implementation_context:
  task_summary: "Hyperliquid-native Testnet Spot closed loop: quote/review, Privy-approved per-user agent, one capped-IOC submit, reconciliation, balances."
  locked_scope:
    provider: "Hyperliquid native Spot"
    implementation_network: "testnet only"
    future_release_network: "mainnet through a separate ADR/deployment gate"
    first_order_type: "single capped IOC buy or sell"
    perps: "remain present but dormant; no new Perp work"
    excluded:
      - "resting limit order management"
      - "cancel/modify/TP-SL/TWAP/batch"
      - "transfer/withdrawal/bridge/automation/builder fees"
      - "mainnet runtime switch or fallback"
  route_contract:
    core:
      - "GET /v1/spot/config"
      - "GET /v1/spot/markets/{market_id}/facts"
      - "GET /v1/spot/balances"
      - "POST /v1/spot/intents"
      - "GET /v1/spot/intents/{intent_id}"
      - "POST /v1/spot/intents/{intent_id}/submit"
    authority:
      - "GET /v1/spot/wallet-binding"
      - "PUT /v1/spot/wallet-binding"
      - "DELETE /v1/spot/wallet-binding"
      - "POST /v1/spot/agent-authorizations"
      - "GET /v1/spot/agent-authorizations/{authorization_id}"
      - "POST /v1/spot/agent-authorizations/{authorization_id}/signatures"
  constants:
    idempotency_scope: "spot_intent_prepare"
    request_digest_domain: "spot_intent_request_v1"
    provider_domain: "hyperliquid"
    operation_kind: "spot_intent"
    review_digest_domain: "spot_review_v1"
  invariants:
    - "All Spot routes authenticate current Privy bearer and require LOOP bootstrap."
    - "Client never supplies network, account, agent, raw provider IDs, nonce, wire action, or signature."
    - "One intent has one server CLOID and at most one provider order write."
    - "Financial values remain exact Decimal/BigInt/canonical strings."
    - "Binding, agent, policy, metadata, and review are revalidated before submission."
    - "Unknown write outcome is reconciled and never blindly replayed."
    - "Worker can read/finalize only and is selected by domain plus operation kind."
    - "Generic provider operation and Spot projection finalize atomically."
    - "Testnet and future Mainnet identities, data, nonces, agents, approvals, and deployments never mix."
  external_inputs_before_credentialed_e2e:
    - "Privy server-wallet/signer capability, authorization key or quorum, and restrictive policies, supplied through local secret storage rather than chat/Git."
    - "One funded Hyperliquid Testnet embedded-wallet account able to approve an API wallet."
    - "Initial Spot market allowlist and product risk limits; safe defaults may be proposed."
  acceptance_criteria:
    - "The 12 approved Spot endpoints have strict OpenAPI and behavior tests."
    - "A prepared F11 review is durable, idempotent, exact, expiring, and cannot be silently repriced."
    - "A current authorized user can submit one reviewed Testnet capped-IOC order through a per-user server agent."
    - "Every submit sends at most once and ambiguous outcomes converge through authoritative read-only reconciliation."
    - "Intent outcome and refreshed Spot balances close the agreed backend loop."
    - "Perp regressions and the complete local verification matrix pass."
    - "Mainnet, withdrawals, transfers, and automation remain unreachable."
  evidence_provenance:
    {
      "schema_version": 2,
      "head_commit": "56ed32b16a896b3fa36b309a59b897ec699c8ad1",
      "generated_plan_path": "docs/plans/2026-08-26-gitnexus-plan-hyperliquid-spot-closed-loop.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "9c8e85cd6850b4c829b5f7c3593ca14d9524f1600f1e44d509f9af31a3de3559"
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
          "head_digest": "sha256:e351e5462aca70605d1dea7f337bcdd87cdfe408f302f7c3877b22e9efeb70df",
          "index_digest": "sha256:e351e5462aca70605d1dea7f337bcdd87cdfe408f302f7c3877b22e9efeb70df",
          "worktree_digest": "sha256:e351e5462aca70605d1dea7f337bcdd87cdfe408f302f7c3877b22e9efeb70df",
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
          "head_digest": "sha256:201cf0545602b6f0191b6af2dbfa88f2bf2890ebd8906b0914531b2c1394d7e2",
          "index_digest": "sha256:201cf0545602b6f0191b6af2dbfa88f2bf2890ebd8906b0914531b2c1394d7e2",
          "worktree_digest": "sha256:201cf0545602b6f0191b6af2dbfa88f2bf2890ebd8906b0914531b2c1394d7e2",
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
          "worktree_digest": "sha256:e6be9b46c6b71339666624b1d777a992db7f6c85554cfd4a9c043d127e4ffd73",
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
          "head_digest": "sha256:72f98960e923c6ea2f3854dddb97611aab0d876a5202c9f6466dcae5415cd932",
          "index_digest": "sha256:72f98960e923c6ea2f3854dddb97611aab0d876a5202c9f6466dcae5415cd932",
          "worktree_digest": "sha256:72f98960e923c6ea2f3854dddb97611aab0d876a5202c9f6466dcae5415cd932",
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
          "head_digest": "sha256:f84d91f9c999b44c279c351581fb31af4ec8fbdd27d20865d05e7e097c094832",
          "index_digest": "sha256:f84d91f9c999b44c279c351581fb31af4ec8fbdd27d20865d05e7e097c094832",
          "worktree_digest": "sha256:f84d91f9c999b44c279c351581fb31af4ec8fbdd27d20865d05e7e097c094832",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0003-native-api-control-plane.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:23056052297b386c5d06d53f095f4c2e02a044c6b6ec9cb2fb4ba61e297302f0",
          "index_digest": "sha256:23056052297b386c5d06d53f095f4c2e02a044c6b6ec9cb2fb4ba61e297302f0",
          "worktree_digest": "sha256:23056052297b386c5d06d53f095f4c2e02a044c6b6ec9cb2fb4ba61e297302f0",
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
          "path": "docs/decisions/0010-perp-wallet-binding-lifecycle.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a34799cdb9d38f4671aeac7c82bae3e8a69df1dd5a625f65e30c5e719eecace6",
          "index_digest": "sha256:a34799cdb9d38f4671aeac7c82bae3e8a69df1dd5a625f65e30c5e719eecace6",
          "worktree_digest": "sha256:a34799cdb9d38f4671aeac7c82bae3e8a69df1dd5a625f65e30c5e719eecace6",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0012-standalone-reconciliation-worker.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:42a35a6e5c47261c7a0181f1312977453355c1586f15ce4a798ae5b41e8549fe",
          "index_digest": "sha256:42a35a6e5c47261c7a0181f1312977453355c1586f15ce4a798ae5b41e8549fe",
          "worktree_digest": "sha256:42a35a6e5c47261c7a0181f1312977453355c1586f15ce4a798ae5b41e8549fe",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/decisions/0013-testnet-perp-order-authoritative-reconciliation.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:dc2a4a63679cbe10d61412a61d833bb7f3a50cab540977ba798043fc990a4ccf",
          "index_digest": "sha256:dc2a4a63679cbe10d61412a61d833bb7f3a50cab540977ba798043fc990a4ccf",
          "worktree_digest": "sha256:dc2a4a63679cbe10d61412a61d833bb7f3a50cab540977ba798043fc990a4ccf",
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
          "head_digest": "sha256:685ad03d350fdba254ac5670b8997103287fbbaf71d08e5c4befe7f55b35ad41",
          "index_digest": "sha256:685ad03d350fdba254ac5670b8997103287fbbaf71d08e5c4befe7f55b35ad41",
          "worktree_digest": "sha256:685ad03d350fdba254ac5670b8997103287fbbaf71d08e5c4befe7f55b35ad41",
          "untracked_digest": "absent"
        },
        {
          "path": "migrations/000002_api_control_plane.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9481e5d4366fc6f55c4b9a5c8d1eb6a7b45ea8773ad6bc7b4a6800f912b9af77",
          "index_digest": "sha256:9481e5d4366fc6f55c4b9a5c8d1eb6a7b45ea8773ad6bc7b4a6800f912b9af77",
          "worktree_digest": "sha256:9481e5d4366fc6f55c4b9a5c8d1eb6a7b45ea8773ad6bc7b4a6800f912b9af77",
          "untracked_digest": "absent"
        },
        {
          "path": "migrations/000003_perp_intents.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4e52aebdd4dc0ddb883720db0d5813a1d4008e02866dd04e4a3ed2e04c95b5d3",
          "index_digest": "sha256:4e52aebdd4dc0ddb883720db0d5813a1d4008e02866dd04e4a3ed2e04c95b5d3",
          "worktree_digest": "sha256:4e52aebdd4dc0ddb883720db0d5813a1d4008e02866dd04e4a3ed2e04c95b5d3",
          "untracked_digest": "absent"
        },
        {
          "path": "migrations/000004_agent_authorizations.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:5248cedab86679837f3f60e1ad90e506fddcd857bc0083ad411af06762c59e28",
          "index_digest": "sha256:5248cedab86679837f3f60e1ad90e506fddcd857bc0083ad411af06762c59e28",
          "worktree_digest": "sha256:5248cedab86679837f3f60e1ad90e506fddcd857bc0083ad411af06762c59e28",
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
          "head_digest": "sha256:aef8b48c77c0cbf19b1d1b860035bd19a324e31d9f75e46d928dc2401cc3141f",
          "index_digest": "sha256:aef8b48c77c0cbf19b1d1b860035bd19a324e31d9f75e46d928dc2401cc3141f",
          "worktree_digest": "sha256:aef8b48c77c0cbf19b1d1b860035bd19a324e31d9f75e46d928dc2401cc3141f",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/generate-openapi.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6cf698f91cafea5912cacbd91016fd85310da82db088e5f509bf2f5064bfb214",
          "index_digest": "sha256:6cf698f91cafea5912cacbd91016fd85310da82db088e5f509bf2f5064bfb214",
          "worktree_digest": "sha256:6cf698f91cafea5912cacbd91016fd85310da82db088e5f509bf2f5064bfb214",
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
          "head_digest": "sha256:8ba115b35ed5425e748b322eee21bb7489a50fb7d3edcb8f46097752ed58f69d",
          "index_digest": "sha256:8ba115b35ed5425e748b322eee21bb7489a50fb7d3edcb8f46097752ed58f69d",
          "worktree_digest": "sha256:8ba115b35ed5425e748b322eee21bb7489a50fb7d3edcb8f46097752ed58f69d",
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
          "head_digest": "sha256:088f8d9a7f56844cfc311ead8b968ce5a3e1057ab2452918f0f9ed68508925c0",
          "index_digest": "sha256:088f8d9a7f56844cfc311ead8b968ce5a3e1057ab2452918f0f9ed68508925c0",
          "worktree_digest": "sha256:088f8d9a7f56844cfc311ead8b968ce5a3e1057ab2452918f0f9ed68508925c0",
          "untracked_digest": "absent"
        },
        {
          "path": "src/core/http/authentication.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:69d8980e65d5db401f066ef90d1f3029c1712176f468d00877d1f71fe3107903",
          "index_digest": "sha256:69d8980e65d5db401f066ef90d1f3029c1712176f468d00877d1f71fe3107903",
          "worktree_digest": "sha256:69d8980e65d5db401f066ef90d1f3029c1712176f468d00877d1f71fe3107903",
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
          "head_digest": "sha256:70f19a1763651587ba41afef5f0de5f1d30ebc8bef520b9f5d9e24f86d7a59a4",
          "index_digest": "sha256:70f19a1763651587ba41afef5f0de5f1d30ebc8bef520b9f5d9e24f86d7a59a4",
          "worktree_digest": "sha256:70f19a1763651587ba41afef5f0de5f1d30ebc8bef520b9f5d9e24f86d7a59a4",
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
          "head_digest": "sha256:3be50859eeac0a1f57c07af6bffaf23f81c69015be8140ba2f392dc5697cbf89",
          "index_digest": "sha256:3be50859eeac0a1f57c07af6bffaf23f81c69015be8140ba2f392dc5697cbf89",
          "worktree_digest": "sha256:3be50859eeac0a1f57c07af6bffaf23f81c69015be8140ba2f392dc5697cbf89",
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
          "head_digest": "sha256:eedb2a3489ef3d24db2e46a780a18fb54521ea48dbe29151c0b38a7c4e9f990a",
          "index_digest": "sha256:eedb2a3489ef3d24db2e46a780a18fb54521ea48dbe29151c0b38a7c4e9f990a",
          "worktree_digest": "sha256:eedb2a3489ef3d24db2e46a780a18fb54521ea48dbe29151c0b38a7c4e9f990a",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/perp/perp-intent-service.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0b20526968eb7eb3e1975f938d71bd587883ef1df5fd5b5f5399aad5096a6063",
          "index_digest": "sha256:0b20526968eb7eb3e1975f938d71bd587883ef1df5fd5b5f5399aad5096a6063",
          "worktree_digest": "sha256:0b20526968eb7eb3e1975f938d71bd587883ef1df5fd5b5f5399aad5096a6063",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/reconciliation/authoritative-reader.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4006bddc5a207d3f828fd35969e2d21f99b84638e623c759534af6d204cb9f7e",
          "index_digest": "sha256:4006bddc5a207d3f828fd35969e2d21f99b84638e623c759534af6d204cb9f7e",
          "worktree_digest": "sha256:4006bddc5a207d3f828fd35969e2d21f99b84638e623c759534af6d204cb9f7e",
          "untracked_digest": "absent"
        },
        {
          "path": "src/features/reconciliation/reconciliation-service.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:28935db064384a5cc7bd57b846566a5afc1ce2726a647862473fd2393e0aee22",
          "index_digest": "sha256:28935db064384a5cc7bd57b846566a5afc1ce2726a647862473fd2393e0aee22",
          "worktree_digest": "sha256:28935db064384a5cc7bd57b846566a5afc1ce2726a647862473fd2393e0aee22",
          "untracked_digest": "absent"
        },
        {
          "path": "src/integrations/hyperliquid/info-quota.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6b7ee53c94959ea2e9f464f0bad90b1c26173dfca7309813f837c4a6d58bfda0",
          "index_digest": "sha256:6b7ee53c94959ea2e9f464f0bad90b1c26173dfca7309813f837c4a6d58bfda0",
          "worktree_digest": "sha256:6b7ee53c94959ea2e9f464f0bad90b1c26173dfca7309813f837c4a6d58bfda0",
          "untracked_digest": "absent"
        },
        {
          "path": "src/integrations/hyperliquid/lossless-info-transport.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2fdce3d3741140a7e9b6d8e5632e3a21074274206db917ac68a90862131c9d55",
          "index_digest": "sha256:2fdce3d3741140a7e9b6d8e5632e3a21074274206db917ac68a90862131c9d55",
          "worktree_digest": "sha256:2fdce3d3741140a7e9b6d8e5632e3a21074274206db917ac68a90862131c9d55",
          "untracked_digest": "absent"
        },
        {
          "path": "src/reconciliation-worker-readers.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fd41274e1c0ef0496ee4c1c341a3df5db9568f98e5a71df55633aae31e113cba",
          "index_digest": "sha256:fd41274e1c0ef0496ee4c1c341a3df5db9568f98e5a71df55633aae31e113cba",
          "worktree_digest": "sha256:fd41274e1c0ef0496ee4c1c341a3df5db9568f98e5a71df55633aae31e113cba",
          "untracked_digest": "absent"
        },
        {
          "path": "src/worker-runtime.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0e28d2fca6c8272892a311c24471ca0176dd9e099e2f63a1650bb5e8b0bcd0f6",
          "index_digest": "sha256:0e28d2fca6c8272892a311c24471ca0176dd9e099e2f63a1650bb5e8b0bcd0f6",
          "worktree_digest": "sha256:0e28d2fca6c8272892a311c24471ca0176dd9e099e2f63a1650bb5e8b0bcd0f6",
          "untracked_digest": "absent"
        },
        {
          "path": "test/openapi.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d44d8e4b7e0dd5727bd7930197c4c80e3a03f4e9f1b838a428f37ba534683820",
          "index_digest": "sha256:d44d8e4b7e0dd5727bd7930197c4c80e3a03f4e9f1b838a428f37ba534683820",
          "worktree_digest": "sha256:d44d8e4b7e0dd5727bd7930197c4c80e3a03f4e9f1b838a428f37ba534683820",
          "untracked_digest": "absent"
        }
      ]
    }
~~~

## 12. Assumptions and Open Questions

- Locked by the user: the product is Hyperliquid-native Spot; implementation is Testnet first; Mainnet is activated only through the production-launch work; the closed loop above is accepted.
- Default proposal unless changed before implementation: begin with a very small allowlist, server default slippage, and conservative per-order/daily limits. Exact symbols and numbers are product/risk inputs and can be changed without changing the architecture.
- Privy App ID/secret alone may not authorize server-side agent signing. Credentialed implementation needs Privy server-wallet/signer setup, an authorization key or quorum, and restrictive policies. Secret values belong in local env/secret management, not chat or Git.
- Credentialed E2E needs one funded Hyperliquid Testnet Spot account and a pair available on Testnet.
- Review TTL must be tuned using the agreed physical-phone path; the implementation must start conservative and fail expired rather than silently extend.
- Mainnet readiness, legal/compliance posture, launch limits, monitoring SLOs, and incident ownership are intentionally deferred to the separate release project.

## 13. Definition of Done

- The Spot ADR/contract and official signing conformance evidence are committed.
- The 12 approved Testnet Spot endpoints are implemented with strict OpenAPI, auth/bootstrap, no-store, owner isolation, and safe errors.
- Wallet binding has one neutral durable authority epoch and existing Perp behavior remains compatible.
- A user can create and complete the exact approveAgent authorization for one epoch-scoped Testnet agent without exposing agent private material.
- POST intents returns an idempotent, immutable, exact, expiring F11 review based on allowlisted Testnet Spot metadata/book/fees.
- POST submit revalidates all authority and policy, allocates a durable nonce, signs the exact capped-IOC action, and sends at most once.
- Immediate and ambiguous outcomes converge through read-only, tuple-routed, atomic authoritative reconciliation.
- GET intent and GET balances expose the final safe result and refreshed holdings, completing the backend loop.
- All required local checks, migrations, Docker builds, security scans, and Perp regressions pass.
- Credentialed Testnet E2E and physical-phone evidence are recorded; anything not executed is explicitly unverified.
- Mainnet, Perp mutation, transfer, withdrawal, bridge, automation, and arbitrary signing remain unreachable.
