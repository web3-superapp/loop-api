# Hyperliquid Perp Production Adapter Implementation Plan

> **For agentic workers:** execute each task test-first. Shared application and build files require a later coordinated slice and are not targets here.

**Goal:** turn the reviewed R0 contract into a thin, credentialed Hyperliquid and Privy adapter without creating alternate trading, market-data, position, settlement, or signing infrastructure.

**Architecture:** Flutter and HTML presentation consumes normalized immutable views. A BFF owns configuration, Core-only policy, immutable review identity, reconciliation, and rate budgets. One protected executor consumes one durable queue for one distinct Privy agent and network pair; no concurrent signer-capable standby or automatic failover exists. The pinned Hyperliquid SDK exclusively owns action encoding, signing calls, nonce generation, in-process serialization, HTTP, and subscription transport; Privy-backed wallet objects perform signing. A queue lease cannot fence signer access. Hyperliquid remains the data and execution authority.

**Tech stack:** pinned `@nktkas/hyperliquid` v0.33.2 behind a single adapter, Privy backend and mobile SDKs already selected by the wallet slice, decimal-string utilities, standard persistent store for non-secret submission journals, and Hyperliquid Info, Exchange, and WebSocket APIs.

## File ownership for the next independent slice

Canonical whole-app owner: hyperliquid_core_perp. `target-inventory.json` is the sole machine-readable source of exact target paths, owner roots, and order. This plan references only the stable symbolic IDs below.

The original prototype's R0 verifier and mutation suite are historical provenance and were not migrated into `loop-api`. There is currently no replacement validation command; the current contract-test and mutation-suite entry point is **PENDING**. Before implementing any target below, the implementation slice must first create and review a new, traceable contract-test/mutation suite in this repository. That suite must read the merged catalog declared by the inventory, prove every structured target resolves to exactly one normalized, disjoint owner root, and pin the exact digest and byte size of every contract artifact. After that entry point exists, any prose, comment, marker, entity, Unicode, or copied-path change requires a new reviewed contract version. No task may invoke or claim evidence from the absent legacy verifier.

- Target T01: explicit network and credential validation; no defaults; fail closed.
- Target T02: authoritative, versioned, expiring regional, legal, sanctions, product, age-or-entity, and provider-terms decision gate before any production SDK or Privy mutation call; read-only capabilities stay separate.
- Target T03: protected single executor, durable queue, manual replacement hold, and authoritative revocation evidence; no nonce APIs or claimed application fence.
- Target T04: exact empty-dex, fresh Core meta, allowlist, asset and coin binding, and forbidden-action gate.
- Target T05: one long-lived pinned SDK client per Privy signer and network pair; no custom EIP-712, msgpack, nonce, HTTP, or WebSocket implementation.
- Target T06: read-only Info adapter and raw-to-normalized DTO validation.
- Target T07: order, cancel, modify, leverage, and margin envelope and nested-status parsing.
- Target T08: unknown-submission journal and authoritative readback.
- Target T09: thin SDK subscription lifecycle, provider-event dedupe, stale gates, and Info reconciliation; never build an orderbook or price feed.
- Target T10: owner-only versus agent-allowed action allowlist.
- Target T11: adapter-generated epoch, arrival-sequence, and raw-message-digest identity before normalization.
- Target T12: exact-decimal two-sided BBO or book to final-IOC immutable review binding through a thin locked decimal policy.
- Target T13: official ten-unique-user gate before SDK subscribe.
- Target T14: raw provider and normalized immutable types kept separate.
- Target T15: presentation-facing immutable DTOs only; no provider transport or signing.
- Target T16: risk-notice composition from immutable provider and eligibility DTOs only.
- Target T17: keep scope, production blocks, and operational caveats explicit.
- Target T18: preserve the exact provider, signing, execution, and eligibility contract.
- Target T19: preserve the explicit immutable non-production fixture.
- Target T20: preserve this exact symbolic target sequence.
- Target T21: preserve provider and dependency provenance gates.
- Target T22: preserve primary-source evidence and legal and credential limitations.
- Target T23: configuration, dependency, and default-deny evidence cases.
- Target T24: Privy authority, protected executor, revocation, and replacement cases.
- Target T25: strict Info schemas and Core-only market scope.
- Target T26: exact Exchange wires, source binding, and two-sided IOC policy.
- Target T27: pinned SDK nonce conformance and action-specific unknown-submission recovery.
- Target T28: SDK stream recovery, dedupe, stale gates, and ten-user precheck.
- Target T29: malicious contract, structured-inventory, exact-digest, and merge-context mutations.
- Target T30: credentialed Privy and Hyperliquid testnet gates and evidence.

## Task 1 — Configuration and dependency gate

1. Write failing tests for missing, blank, or unknown network configuration, any fixture fallback in production, wrong endpoints, top-level package pin, hash, or license drift, and import before explicit enablement. Add exact order, cancel, modify, leverage, margin, agent, withdraw, transfer, and funding cases proving missing, pending, unknown, denied, stale, malformed, or unavailable regional, legal, or trading evidence stops before both SDK and Privy.
2. Run only the new tests and record RED.
3. Generate a committed full lockfile; pin every transitive version, source, and integrity value and collect every license for the currently declared ranges in `oss-lock.json`, including `decimal.js` before any IOC price policy exists. SDK import, decimal policy, and production remain blocked until this gate passes.
4. Implement exact `mainnet` and `testnet` config loading with every credential represented by a secret reference, never a checked-in value. Implement one default-deny production-mutation eligibility gate over exact user, account, jurisdiction, product, action, and provider-terms context and authoritative evidence reference, policy version, checked-at, and expiry. Public Info and market reads use a separate capability gate with no signer or ExchangeClient path.
5. Verify GREEN with the newly created, repository-tracked contract-test/mutation suite. If that replacement entry point is still `PENDING`, stop; do not invoke or claim evidence from the absent legacy R0 verifier.
6. Commit only the config, complete dependency evidence, and tests.

## Task 2 — Pinned SDK client and Privy authority boundary

1. Write failing tests proving owner-only actions reject the agent account, agent trading actions reject unknown action types, account reads reject the agent address, and no key or signature is logged or persisted.
2. Add official SDK conformance fixtures for L1 `Agent` EIP-712 and user-signed `HyperliquidSignTransaction` EIP-712 without copying either encoder into LOOP.
3. Implement one long-lived pinned `ExchangeClient` inside one protected executor for one distinct Privy agent and network pair. Use its built-in `globalNonceManager` and lock; do not inject a custom nonce manager. Deployment policy must prohibit a signer-capable standby.
4. Write RED tests for two instances using the same agent, a second instance appearing after the first passed its queue check, crash ambiguity, attempted automatic failover, and reuse of a revoked or expired agent address. Every such case pauses before the SDK and enters operator hold.
5. Treat the durable lease as queue-consumer selection only. Do not claim it can fence an old signer-capable process or ExchangeClient.
6. Implement the manual replacement runbook: terminate old infrastructure; use Privy or owner authority to revoke the old agent; run a credentialed negative signing probe from the old instance and require `rejected_by_privy`; reconcile unknown actions; then create one replacement with a new distinct agent address. Missing evidence means no new executor and no trading.
7. Bind the immutable reviewed intent to the exact typed adapter call and compare only non-secret SDK request metadata. LOOP never receives or persists signatures, canonical bytes, or nonces.
8. Run the Privy policy audit and credentialed testnet owner and agent registration and revocation flow; keep production disabled.

## Task 3 — Info adapter

1. Write failing raw-schema tests for `meta`, `metaAndAssetCtxs`, `l2Book`, `clearinghouseState`, `openOrders`, `orderStatus`, fills, funding, agents and builders, and rate-limit responses, including unknown fields and malformed decimal strings.
2. Require `dex: ""` wherever supported. Bind each asset index and coin to one fresh Core meta snapshot plus the BTC, ETH, and SOL allowlist; reject `xyz:*`, nonempty dex, stale metadata, spot, HIP-3, deploy, and abstraction actions.
3. Implement exact request constructors and strict DTO validation with master and subaccount query addresses.
4. Preserve raw liquidation schema and dedupe by the account, network, and liquidation id tuple. Only fills and clearinghouse readback may create per-coin liquidation rows.
5. Prove malformed or stale provider data fails closed and never becomes a zero or empty success.

## Task 4 — Exchange adapter

1. Write failing tests for order, cancel by oid or cloid, individual and batch modify, leverage, isolated margin, and schedule-cancel requests, plus malicious nested fields.
2. Allow only exact limit wires, Gtc, Alo, or Ioc, grouping `na`, reduce-only, and a required unique lowercase 128-bit cloid on each order or replacement. Reject triggers, TP and SL, FrontendMarket, priority, builder, unknown fields, and reused cloids.
3. Before normalization, assign each raw BBO/l2Book message an adapter-generated identity exactly `(subscription_epoch, monotonic_arrival_sequence, raw_message_sha256)`. In one synchronous immutable envelope before any await, feed that exact hashed frame through one strict exact-decimal parser and emit source kind, coin, provider time, and bid and ask price, size, and count. Keep BBO and l2Book schemas non-interchangeable. Commit provider, network, epoch, sequence, raw hash, source kind, coin, provider time, and normalized price, size, and count fields in the canonical source-envelope digest. Bind review, Core meta, internal order intent, and provider wire structurally before IOC calculation; never join records by coin, timestamp, callback order, or latest cache.
4. Write RED cases for exact buy and sell bounds, rounding across a Core tick and significant-digit boundary, absent ask or bid, stale source, same-millisecond raw messages, reconnect epochs, reordered callbacks, and cross-record attacks. Synchronize raw bytes, raw hash, source revision, normalized quote, normalized digest, and envelope digest to BTC while review, meta, and order remain ETH; then synchronize review while meta and order remain ETH; change only the review source kind; and relabel BBO as l2Book. Every crossed record must fail. A complete BTC chain may pass only as a distinct fixture record with its own consistent identity.
5. After the full `decimal.js` dependency gate, implement the smallest decimal-string policy: buy chooses the greatest valid grid price no higher than the slippage cap; sell chooses the least valid grid price no lower than the slippage floor. Recheck buy crossing (`px >= ask`) and sell crossing (`px <= bid`) after conversion. Reject when no safe crossing price exists. Never use SDK `ROUND_DOWN` for both sides.
6. Bind the final exact-decimal IOC wire to the owner review. Any disconnect, adapter revision or epoch change, staleness, zero liquidity, account change, or input change forces rejection or a new review.
7. Implement only request orchestration around pinned SDK methods.
8. Parse both whole-batch pre-validation errors and per-item statuses even when top-level status is `ok`.
9. Never mutate local position, fill, funding, liquidation, or settlement state from submission acknowledgement.

## Task 5 — SDK nonce conformance and unknown submission

1. Run the pinned SDK's upstream nonce-manager and per-wallet and network lock tests as dependency evidence; write adapter tests proving exactly one long-lived client exists inside the protected executor for each distinct agent and network pair and no custom nonce callback is supplied.
2. Write restart, deregistration, expiration, subaccount, vault, and malicious agent-address-reuse tests. Provision a new Privy agent address after deregistration or expiry.
3. Implement only a non-secret journal keyed by account, network, action, required replacement cloid or cancel oid, review-intent digest, and opaque request id. Do not store or generate nonces.
4. For timeout, transport close, post-send 429, or post-send 5xx, enter `unknown_submission` and do not resubmit. Any future action goes through the same pinned SDK client after reconciliation permits it.
5. Apply the exact per-action map: orders and modifies by unique cloid; agent approval by `extraAgents`; leverage and margin by action-specific `clearinghouseState` fields; future builder approval by both `maxBuilderFee` and `approvedBuilders`. Keep `scheduleCancel` in operator hold because no authoritative schedule read exists.
6. Run an injected unknown submission testnet drill.

## Task 6 — WebSocket state machine

1. Write failing tests for snapshot then delta, repeated snapshot, duplicate fill, order, funding, and liquidation events, raw liquidation shape, old epochs, out-of-order provider timestamps, missed heartbeat, reconnect, and gaps.
2. Consume pinned SDK subscriptions. First prove the pinned transport exposes the exact raw frame and permits an atomic raw-frame and callback envelope; otherwise keep production market mutations blocked and do not add a second WebSocket. Capture exact raw UTF-8 bytes, compute SHA-256, allocate a strictly monotonic arrival sequence inside a new opaque connection epoch, and strictly decode BBO and l2Book through the single canonical parser before any await. This adapter-generated identity is for immutable review and dedupe; it is not a provider revision. For `l2Book`, atomically replace with each provider book message and never derive a local book from trades or diffs.
3. On disconnect, mark dependent views stale, disable mutations, back off with jitter, reconnect, resubscribe, and fetch Info snapshots before resuming.
4. Do not invent ordering between independent subscriptions.
5. Enforce the official ten-distinct-user limit before calling SDK subscribe: ten distinct users pass, the eleventh is rejected, and an already tracked user remains allowed. Record that v0.33.2 internally permits 15.
6. Run reconnect and rate-limit drills against testnet with credentials; record evidence.

## Task 7 — Integration and go-live review

1. Expose immutable adapter capabilities to the future Perp UI without editing shared application files in this slice.
2. Run all Perp tests, the repository-tracked replacement contract-test/mutation suite, wallet regressions, security scans, and deterministic builds. The replacement suite must exist and be reviewed before this task can pass; the historical R0 verifier is not a valid command or evidence source.
3. Validate Core non-trigger statuses exactly: `open` is nonterminal; the scoped terminal allowlist terminates; trigger, vault, and spot statuses are rejected; unknown values and `unknownOid` remain quarantined rather than hanging or being coerced.
4. Keep builder fields and `approveBuilderFee` rejected. Any future builder enablement needs a new owner-approved audit with the exact lowercase LOOP address, exact fee cap, main-wallet approval, both provider readbacks, credentials, and mutations.
5. Independently review complete dependency locks and licenses including decimal arithmetic, SDK source diff, protected executor topology, old-agent owner or Privy revocation and negative probe, signing and nonce vectors, IOC two-sided rounding, adapter source identity, logs, persisted journal fields, action-specific unknown submission, limits, and WebSocket recovery.
6. Obtain authoritative, versioned, current regional, legal, sanctions, product, age-or-entity, and provider-terms evidence and owner approval. Any missing, pending, unknown, denied, stale, malformed, or unavailable input denies every production mutation before SDK or Privy. Independently prove read-only scope cannot reach signing or Exchange actions.
7. Only then change production from disabled to a separately reviewed feature flag bound to the exact technical and eligibility evidence versions. Missing configuration must still fail closed and HTML must remain explicit offline fixture only.
