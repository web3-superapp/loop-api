# Hyperliquid Perp R0 contract

This directory is a reviewable integration contract, **not production-ready** code. Provider **credentials later** is a binding constraint: production remains disabled and fails closed until the credentialed testnet gate in the implementation plan passes.

Hyperliquid is the only authority for Perp markets, orders, fills, positions, funding, liquidation events, and settlement. Privy remains the only wallet and signing authority. LOOP may add presentation, orchestration, and policy, but must not implement a matching engine, price feed, position ledger, settlement ledger, key store, EIP-712 encoder, or alternate signer.

R0 deliberately installs and imports no Hyperliquid SDK. `oss-lock.json` pins only the top-level candidate and official/source conformance oracles; the runtime dependency graph is explicitly **PENDING**, not locked. Implementation must first generate a complete lockfile with every transitive version, source, integrity, and license and must fail closed on any gap. The only runnable artifact in this slice is the standard-library verifier.

Production has no implicit network and no fixture fallback. The HTML prototype may load `fixtures/offline-r0.json` only when `LOOP_OFFLINE_HYPERLIQUID_FIXTURE=1` is explicitly set, and it must display the exact simulation label. The fixture cannot send network requests, sign, submit, or imply provider success.

Regional, legal, sanctions, product-availability, age/entity, and provider-terms eligibility is `PENDING_default_deny`. Every production mutation—including orders, cancellations, account changes, agent authorization, withdrawals, transfers, and funding movement—passes one mandatory gate before either the Hyperliquid SDK or Privy signer is called. Missing, pending, unknown, denied, stale, malformed, or unavailable evidence denies the action. Public Info and market WebSocket reads are a separate capability and have no path to signing or Exchange actions.

R0 is Core perpetuals only: `dex` is exactly `""`; BTC/ETH/SOL asset indices and coin names must come from one fresh Core `meta` snapshot and the immutable allowlist. HIP-3, spot, dex abstraction/deploy, triggers, TP/SL, TWAP, priority fields, builder fields, and unknown nested order fields are rejected.

Account reads always use the master or subaccount address, never the agent address. Owner-only actions are routed through the Privy user wallet; routine trading L1 actions may use a Privy-managed registered agent wallet. The pinned SDK exclusively owns signing, nonce generation/serialization, HTTP, and subscriptions. Its nonce manager and semaphore are process-local. R0 therefore requires one protected executor and durable input queue for each distinct agent/network, with no warm signer-capable standby and no automatic failover. Every executor uses a distinct Privy agent address that replacements never reuse.

A queue lease selects a consumer but **cannot fence** a process that still holds signer access, revoke an ExchangeClient, or prove an old instance stopped. Any second instance or pause-after-check ambiguity stops SDK calls and enters operator hold. Replacement is manual: terminate old infrastructure, revoke the old Hyperliquid agent through the owner, revoke its Privy signing authority, and run a credentialed negative signing probe proving Privy rejects the old instance. Without all evidence there is no replacement executor and no trading; an approved replacement gets a new agent address.

Market orders bind a fresh raw provider BBO/l2Book timestamp and an adapter-generated `source_revision` into one immutable review. The revision is exactly `(subscription_epoch, monotonic_arrival_sequence, raw_message_sha256)`; it is not a provider field. A canonical source-envelope digest commits provider, network, epoch, sequence, raw hash, source kind, coin, provider time, and normalized price/size/count fields. One strict parser consumes the exact hashed frame; `bbo.data.bbo` and `l2Book.data.levels` are non-interchangeable schemas. Before IOC calculation, `review.coin == normalized.coin == fresh Core meta.coin == order_intent.coin`, raw/normalized/review source kinds match, and review/meta/order/wire assets match. A fully synchronized alternate coin is valid only as its own complete record, never by crossing source, review, meta, or order records.

This raw-frame path stays `PENDING` until the pinned SDK transport proves it exposes the exact frame and atomic callback correlation. LOOP cannot open a parallel WebSocket or implement a second feed to satisfy this requirement. If the pinned SDK cannot support it, production market mutations remain blocked while separately approved read-only views may still operate.

IOC prices enforce both directions: buy requires `ask <= px <= ask*(1+s)` and sell requires `bid*(1-s) <= px <= bid`. Tick/significant-digit conversion moves toward less aggression—buy down, sell up—and then rechecks crossing and slippage; one SDK `ROUND_DOWN` rule cannot serve both sides. The future implementation is a thin exact-decimal policy over mature `decimal.js`, but its full transitive lock/integrity/license gate is still PENDING, so production remains blocked. Zero quote liquidity, stale data, disconnect, epoch/revision change, or input/account change requires rejection or new review. Unknown submissions use action-specific readback and never auto-retry. Builder codes are completely disabled in R0.

Raw liquidation events preserve only `lid`, `liquidator`, `liquidated_user`, `liquidated_ntl_pos`, and `liquidated_account_value`. LOOP dedupes by account/network/lid and cannot invent time, coin, or size; per-coin UI requires fills plus clearinghouse readback.

Verification from the candidate root:

```text
python3 _tmp/verify_hyperliquid_perp.py --mutation-suite
```
