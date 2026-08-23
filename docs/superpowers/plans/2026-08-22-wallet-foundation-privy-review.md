# LOOP Wallet Foundation and Privy Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement F1 Wallet expansion, F2 Asset detail, F6 Receive, and F11 unified provider review as a deterministic Privy-first HTML prototype without duplicating wallet infrastructure or regressing existing flows.

**Architecture:** Add a deterministic JavaScript source manifest, a pinned local QR dependency, a DOM-free simulated Privy adapter, and a separate review controller. The existing router remains the only navigation authority; strict parameter parsing and opaque review markers compose with its validated `{stack, voice}` projection. All executable-review semantics derive from a frozen `CanonicalReviewSource`; the HTML performs no network, signing, pricing, indexing, or real wallet actions. Production boundaries remain Privy Flutter + an app BFF for secrets and authorization signatures; later communication and Perp slices integrate Stream and Hyperliquid rather than replacing them.

**Tech Stack:** Static HTML5, CSS, vanilla JavaScript, Python 3 build scripts, Playwright Python sync API, vendored `qrcode-generator` 1.4.4 (MIT), official Privy-shaped public fixtures.

---

## Working constraints

- Source of truth is `src/`; never edit generated `app.html` directly.
- Design authority is `docs/superpowers/specs/2026-08-22-wallet-foundation-signing-design.md`; owner approved it on 2026-08-22.
- The directory has no Git metadata. Do not initialize Git, create worktrees, or claim commits. Replace commit checkpoints with named build/test evidence in this plan and `progress.md`.
- Use @test-driven-development for every behavior change: add a focused failing assertion, run it and observe the expected failure, then write production code.
- Use @verification-before-completion before claiming any task or slice complete.
- Execute tasks sequentially with @subagent-driven-development: fresh implementer, specification review, then code-quality review. Resolve and re-review every issue before the next task.
- `python3 build.py` and `python3 build_docs.py` are the only writers of `app.html` and `docs.html`.
- New wallet/review code and wallet/review payload surfaces: no real network, wallet SDK, signing, clipboard read, secret or secret-like fixture, seed/private-key field, dynamic remote script, remote QR, floating-point money arithmetic, custom QR/ABI encoder, RPC/indexer, price oracle, or action polling. The already approved deterministic account-onboarding seed/private-key demo fixtures are explicitly allowlisted existing regression material and must not be removed or weakened by this slice.
- Privy remains the production wallet boundary. Provider gaps render honestly; no hidden fallback or locally invented wallet primitive.

## File responsibility map

Create:

- `_tmp/verify_wallet_foundation.py` — focused source/build, adapter, route, screen, review, history, security, accessibility, and responsive verifier.
- `src/screens/asset.html`, `src/screens/receive.html` — F2/F6 semantic shells.
- `src/wallet-provider.js` — DTO normalization, immutable snapshots, fixtures, simulated Privy boundary; no DOM.
- `src/wallet-review.js` — canonical decoder, one-time review sessions, state/history/focus controller; no wallet primitive.
- `src/scripts-order.txt` — deterministic JavaScript manifest.
- `src/vendor/qrcode-generator-1.4.4.js`, `src/vendor/qrcode-generator.LICENSE.txt`, `src/vendor/vendor-lock.json` — pinned QR dependency and provenance.

Modify:

- `build.py`, `src/screens-order.txt`, `src/screens/wallet.html`, `src/screens/swap.html`, `src/screens/dapp.html`, `src/shell-close.html`, `src/app.js`, `src/style.css`.
- `_tmp/verify_split.py`, `_tmp/verify_docs.py`, `README.md`, `文档/页面清单.md`, `文档/开发进度安排.md`, `findings.md`, `progress.md`, `task_plan.md`.
- Regenerate `app.html` through `python3 build.py` only.

## Shared implementation contract

`src/scripts-order.txt` is exactly:

```text
vendor/qrcode-generator-1.4.4.js
wallet-provider.js
wallet-review.js
app.js
```

That list records the original wallet-foundation checkpoint. The current integrated production manifest is six scripts and inserts `wallet-transfer.js` plus the fail-closed `stream-chat-provider.js` before `app.js`; `src/test-fixtures/stream-chat-offline-fixture.js` remains outside the production bundle.

`src/vendor/vendor-lock.json` records:

```json
{
  "name": "qrcode-generator",
  "version": "1.4.4",
  "license": "MIT",
  "npm_integrity": "sha512-HM7yY8O2ilqhmULxGMpcHSF1EhJJ9yBj8gvDEuZ6M+KGJ0YY2hKpnXvRD+hZPLrDVck3ExIGhmPtSdcjC+guuw==",
  "source": "https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-1.4.4.tgz",
  "file": "vendor/qrcode-generator-1.4.4.js",
  "sha256": "18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780",
  "license_file": "vendor/qrcode-generator.LICENSE.txt",
  "license_sha256": "3a850fa5f08101db6f40676c2786e10bd2cd5fff7b12ffdf1e0c434d4e49d90c"
}
```

The only new globals are frozen facades:

```javascript
globalThis.LoopWalletProvider = Object.freeze({
  createSimulatedAdapter,
  normalizeBalanceResponse,
  normalizeTransactionPage,
  formatBaseUnits,
  addDecimalStrings
});
globalThis.LoopWalletReview = Object.freeze({
  decodeReviewSource,
  createController
});
```

Fixture maps, scenarios, sessions, digests, request bodies, callbacks, and controller internals remain closure-owned.

---

### Task 1: Add the focused RED verifier, deterministic build, dependency, and route shells

**Files:** create `_tmp/verify_wallet_foundation.py`, the manifest/vendor files, `src/screens/asset.html`, `src/screens/receive.html`; modify `build.py`, `src/screens-order.txt`, `src/app.js`, `_tmp/verify_split.py`.

- [x] Write source/build inventory assertions first: exact four-script manifest order; vendor metadata/checksums; no orphan/duplicate source JavaScript; `asset` and `receive` each occur exactly once immediately after `wallet`; 22 unique `.scr`/IDs; both routes exist. Run `python3 _tmp/verify_wallet_foundation.py` and observe failure because files/routes are absent.
- [x] Obtain `qrcode-generator@1.4.4` with `npm pack` in `mktemp -d`; verify package file SHA-256 `18ae…1780`. Obtain upstream MIT license and verify `3a85…d90c`. Mechanically copy only those two verified files and add the exact lock JSON; do not install a package tree.
- [x] Add minimal frozen `LoopWalletProvider`/`LoopWalletReview` shells and exact `scripts-order.txt`.
- [x] Change `build.py` to validate manifest uniqueness/existence, reject unlisted source-owned `.js` files (ignore AppleDouble), validate both locked hashes, and concatenate once in manifest order. Replace the old direct `app.js` read.
- [x] Add semantic F2/F6 fragments with exactly one `.scr`, unique `h1`, back button, `asset-content`/`receive-content`, and route metadata `Wallet→target`. Extend shared route inventory.
- [x] Extend focused Playwright checks: direct links activate exactly one non-inert screen; inactive screens are inert + `aria-hidden`; zero console/page errors; script banners occur once and in order.
- [x] Run GREEN: `python3 build.py && python3 _tmp/verify_wallet_foundation.py && python3 _tmp/verify_split.py && node --check src/wallet-provider.js && node --check src/wallet-review.js && node --check src/app.js`. Expected build count: 22.
- [x] Record checkpoint: `Task 1 — deterministic scripts/vendor + 22 route shells + shared regression PASS`.

---

### Task 2: Implement immutable Privy adapter and normalized DTOs

**Files:** modify `_tmp/verify_wallet_foundation.py`, `src/wallet-provider.js`.

- [x] Add failing tests that the provider facade exposes exactly the five contracted functions and every returned adapter exposes exactly the seven contracted methods: `getWalletSnapshot`, `getBalanceSnapshot`, `getTransactionHistorySnapshot`, `getWalletActionSnapshot`, `getReceiveTarget`, `getReviewPreview`, and `handoffReview`. Exercise official-shaped balance/history payloads, unknown provider-field ignoring, GLYPH null fiat, exact totals/excluded count, malformed response errors, transaction-ID precedence and nullable fields, deep freeze, capability matrix, and scenarios `normal|empty|loading|partial|provider_succeeded_demo|external_gap|watch_only`.
- [x] Add failing exact-key request tests: factory options and every adapter argument reject unknown/missing/malformed LOOP keys rather than ignoring them. Cover wallet class/scenario, balance/history asset-chain filters, opaque cursor, action ID, Receive target, review ID, and handoff ID separately. This is intentionally stricter than forward-compatible raw provider DTO normalization.
- [x] Add failure-first tests proving pending/rejected/failed handoff cannot mutate holdings and fixture/session/scenario internals are not globally reachable. Add source/runtime assertions that `WalletScenarioStore`/`wallet-provider.js` use no `setTimeout`, `setInterval`, animation frame, or equivalent scheduled transition: loading and provider-completed states are explicit immutable scenarios only, never time-driven mutations. Run and observe the empty-shell failure.
- [x] Implement private `deepFreeze`, frozen `{ok,value,meta}` and safe `{ok:false,error}` result helpers. Never expose raw provider errors.
- [x] Implement string-only `formatBaseUnits` and `addDecimalStrings`; accept canonical unsigned decimal/integer text and decimals `0..36`; never use `Number`, `parseFloat`, `toFixed`, or floating-point provider arithmetic.
- [x] Normalize balances using only recognized Privy fields. Quantity comes from canonical `display_values[asset]` or raw units; fiat only from `display_values.usd`. Label total `LOOP total derived from Privy balances`, exclude null fiat, and report the count. Distinguish ready/empty/partial/stale/error honestly.
- [x] Normalize transaction pages: preserve status text; known transfer types plus `other`; choose non-empty `privy_transaction_id`, then hash; omit neither-ID records and mark partial `MISSING_TRANSACTION_ID`; preserve nullable hash/counterparty/details; treat cursor as opaque. De-duplicate exact provider IDs without reordering the first occurrence or any already-rendered row.
- [x] Implement closure-owned `createSimulatedAdapter({walletClass,scenario})` with the exact capability matrix for `privy_embedded`, `connected_external`, and `watch_only`. Every adapter call returns a fresh deeply frozen snapshot. Prove transaction-history and Wallet-Action resources cannot be substituted for each other. External/watch balance/history gaps return `PROVIDER_GAP`; watch-only signing returns `UNSUPPORTED_WALLET`; Receive remains available. The separate labelled demo control may instantiate the allowlisted `provider_succeeded_demo` scenario through the factory; do not add a generic mutable scenario setter or an eighth adapter method.
- [x] Run GREEN/security/regression: focused verifier, `node --check`, and a zero-match scan for floating point, network, WebSocket, and storage in `wallet-provider.js`, then `_tmp/verify_account.py` and `_tmp/verify_split.py`.
- [x] Record checkpoint: `Task 2 — frozen Privy adapter/DTOs + fixed-point arithmetic + wallet classes PASS`.

---

### Task 3: Implement strict routing and F1/F2/F6 rendered flows

**Files:** modify focused verifier, `src/app.js`, wallet/asset/receive fragments, `src/style.css`.

- [x] Add failing hostile-hash tests for canonical defaults/case/order, unknown-key stripping, incompatible-value fallback, duplicate-key total rejection, malformed percent/UTF-8, raw/encoded C0/DEL, 256/257 raw length, 32/33 decoded values, replacement without history growth, direct-link provenance, and browser Back. Canonical URLs are exactly `#asset?asset=ETH&chain=ethereum` and `#receive?asset=ETH&chain=ethereum`.
- [x] Add failing semantic tests: F1 accessible asset buttons and capability-scoped actions; Send routes to F2; Bridge disabled with exact next-slice copy; Receive routes to F6; stale values remain visible with timestamp and a same-provider Retry that cannot change wallet class/provider; F2 quantity/fiat-unavailable/per-chain/history/nullable/cursor/dedup states plus its required Receive control; F6 compatible selector/address/local QR/wrong-network/copy fallback. Assert the exact normalized warning template `Only send {ASSET} on {NETWORK} to this address. Using another asset or network may result in permanent loss.` (including the ETH/Ethereum fixture sentence), and absence of charts, P&L, invented price/explorer/send/Bridge/live-provider claims.
- [x] Implement a strict parser that validates raw percent sequences and lengths before decode, rejects controls/duplicates, allowlists route values, and returns canonical replacement metadata. Keep params in memory only; retain the validated navigation projection in history.
- [x] Replace F1 hard-coded balances and inline signing toasts with normalized semantic containers. Render wallet class, address, provider state, exact total provenance, chain filters, accessible asset buttons, loading/empty/partial/stale/gap/watch states.
- [x] Render F2 solely from normalized balance/history snapshots. Keep the opaque cursor out of URL/history. Its only executable signing demo control is exactly `Review simulated transfer`; disable it for unsupported wallet classes. Its Receive control opens F6 with the selected compatible pair. In-app Back must restore the exact Asset origin stack; a direct `#receive` link must use Wallet ancestry.
- [x] Render F6 compatible targets and exact address. Use only the pinned local library for QR SVG and store the exact payload in a data attribute. Its accessible alternative must contain the exact full address and network. Copy only through `navigator.clipboard.writeText`; on rejection/unavailable select and focus the address with `Copy unavailable — select the address manually.` Never read clipboard.
- [x] Add responsive/focus/reduced-motion CSS. Verify 375×667 has no horizontal overflow and primary controls remain reachable.
- [x] Run GREEN: build, focused verifier, account/shared regressions, `node --check src/app.js`.
- [x] Record checkpoint: `Task 3 — strict routes + normalized F1/F2/F6 + local QR PASS`.

---

### Task 4: Implement canonical review decoding and one-time envelope validation

**Files:** modify focused verifier, `src/wallet-review.js`, `src/wallet-provider.js`.

- [x] Add failing exact-facade tests plus real transfer, approval, swap, and `perp_order` decoding cases. Cover top-level transfer `amount` precedence; when both top-level `amount` and `source.amount` exist and conflict, the top-level string alone controls review semantics while both original strings remain byte-for-byte unchanged in the stored/handoff payload; untouched exact-input/output strings; decimal/base-unit round trip; zero/negative/sign/space/scientific/leading-zero/trailing-dot/overprecision/101-char rejection; limited/unlimited approval semantics; fresh/stale/unavailable/mismatched swap quotes. Perp decoding must yield the exact summary, a blocked `PERP_EXECUTION_PENDING` result, no eligible handoff/button, and exact disabled reason `Privy + Hyperliquid execution requires the production capability spike.`
- [x] Add failing tamper tests for source/execution digest, live wallet/user/endpoint/chain/token/spender/destination/amount/calldata/value/quote/origin/metadata/label/provenance/expiry; reject unknown source/context/request keys; require every result to be deeply frozen.
- [x] Implement private exact-key validation and deterministic canonical serialization. This prototype compares deterministic fixture digests; it does not implement signing or expose sources/digests through global/history/URL/storage.
- [x] Implement `decodeReviewSource` as the only `LoopReviewIntent` constructor. Validate/freeze the full source first, then derive exact summary/detail text. Preserve full addresses and signed provider strings; abbreviate only in presentation. Use canonical positive-decimal grammar, length ≤100, verified precision, and exact round trip.
- [x] For swap, surface exact input, estimated output, minimum output, fees, received time/deadline, and chain. Calculate the freshness deadline exactly as `min(provider_expiry, received_at_ms + 30_000)` when provider expiry exists, otherwise `received_at_ms + 30_000`. Add RED cases immediately before, exactly at, and immediately after the boundary, plus an earlier provider expiry. At Continue, revalidate output, tokens, exact amount, chain, fee/material terms, route availability, identity, and freshness before any handoff; any difference consumes/blocks the old envelope and requires a new review. For every kind, field-level provenance must prove which visible preview values came from the digest-bound provider preview and which are explicitly unavailable; presence of generic decoded fields is insufficient. Stale/unavailable/no-liquidity/mismatch produces a blocked/refreshable controller result for Task 5 to render in F11 with no Continue and a `Refresh quote` action. Refresh consumes the old envelope and creates a new immutable source, source/execution digests, derived model, and review ID; it never edits/reuses the old request. Only an expired swap encountered on Forward may reopen a still-live session as blocked/Refresh; expired transfer, approval, and Perp entries sanitize and remain closed. For approval, derive limited/unlimited from immutable semantics; never trust a display label. Perp remains a blocked model extension only in this slice and can never call an adapter handoff.
- [x] Implement closure-owned controller sessions (maximum five, independent five-minute TTL) with frozen source/model, execution binding, origin projection, expiry, one-time state, and trigger reference. Add exact five-versus-six capacity and TTL-boundary tests: over-cap fails closed; BFCache retains only a live unconsumed pair; consumed IDs remain invalid; sessions/payloads never enter URL/history/storage. Task 4 performs re-decode, deep comparison, execution binding, context/freshness, and handoff-eligibility validation only; it does not perform the CAS/history/handoff transition, which Task 5 owns after origin-restoring `popstate`.
- [x] Add two immutable approval fixtures (limited/unlimited) plus one deliberate mismatch fixture. Document that production calldata decoding is pinned viem/BFF; add no ABI encoder/calldata construction.
- [x] Run GREEN/security/regression: build, focused verifier, `node --check`, zero unsafe storage/network/secret/`innerHTML` matches in the review module, then account/shared suites.
- [x] Record checkpoint: `Task 4 — canonical review decoder + semantic binding + one-time envelopes PASS`.

---

### Task 5: Implement F11 modal lifecycle, history composition, and accessibility

**Files:** modify focused verifier, `src/wallet-review.js`, `src/app.js`, `src/shell-close.html`, `src/style.css`.

- [x] Add failing exact state-machine tests for `closed→decoding→ready|preview_unavailable|stale|blocked|decode_failed`, followed where eligible by `ready|preview_unavailable→returning_to_origin→handoff_pending→provider_pending|provider_rejected|provider_failed`. Perp/unsupported combinations are blocked. Require one handoff at most, stable safe errors, and no holdings mutation.
- [x] Add failing `preview_unavailable` tests: only a complete canonical provider-sourced transfer/approval may proceed, and only after the user checks an initially unchecked acknowledgement beside exact copy `Action preview unavailable`; its Continue remains disabled before acknowledgement. Swap never uses this fallback and is blocked/Refresh instead.
- [x] Add failing history tests. Opening F11 pushes exactly `{...validatedNavigationProjection,loop_review:1,review_id}` without payload. Browser Back closes and retains the live session; Forward reopens the same live pair; Cancel/Escape consumes it and calls browser Back to the origin entry so history length does not gain a replacement duplicate and stale Forward cannot reopen. Continue uses a compare-and-set, calls `history.back()`, waits for `popstate` to validate/restore/inert the exact origin and restore focus, then deletes review payload and invokes one handoff in a microtask. Only no-valid-prior-entry fallback may sanitize with `replaceState`. Route/tab changes consume; direct hostile markers and reload sanitize; BFCache revalidates expiry/context. Assert duplicate `popstate`, double/key-repeat Continue, and synchronous/pre-close handoff cannot produce a call.
- [x] Add failing router-coordination and isolation tests: ordinary `syncHash` never preserves review markers; `popstate` validates/restores stack and voice before asking the review controller to reopen; malformed stack/voice plus forged review markers sanitize to the safe validated navigation projection; `route()` consumes/closes before parsing any new hash; `persist()`/`restore()` remain `{stack,voice}`-only; open/close never call `navigate()`; account proof/panel fields and `accountHistoryProof` remain untouched. Scan history state, URL, and storage to exclude amount, address, quote, request/authorization payload, provider object, callback, action ID, and user data.
- [x] Add failing modal semantics: `role=dialog`, `aria-modal=true`, labelled title/description, kind badge, exact source/network/wallet/destination/spender/amount/fees/minimum/expiry fields, pending banner, disabled Continue while pending, visible Cancel, initial safe focus, cyclic trap, Escape, inert background, and focus restoration.
- [x] Add exact primary-action/capability assertions: embedded supported requests say `Continue with Privy`; supported connected-wallet requests say `Continue to external wallet`; blocked models expose no Continue; Perp shows `Privy + Hyperliquid execution requires the production capability spike.` Also assert every preview field's provider provenance/unavailable state, not just its rendered value.
- [x] Add one shared F11 dialog and explicit shared-veil ownership while retaining the existing F16 allowance chooser/intercept unchanged in this task. When F11 owns the veil, the handler prevents and stops the legacy veil event, must not call `closeSheets()`, retains session/history unchanged, and restores focus inside F11. It must not close F11 or another sheet underneath. Task 6 alone migrates F16 copy/buttons and routes its immutable choice into F11.
- [x] Wire the review controller to router/history without becoming a second navigation authority. Only IDs/markers enter history. Expired or invalid forward entries sanitize by replacement, never reopen a consumed intent.
- [x] Render human summary and full critical values with `textContent`/element construction. Continue closes the confirmation surface before calling the adapter; show deterministic pending/rejected/failed provider state separately.
- [x] Run GREEN plus account/shared regressions, syntax checks, focus/viewport/reduced-motion cases.
- [x] Record checkpoint: `Task 5 — one F11 modal + history-safe one-time lifecycle + a11y PASS`.

---

### Task 6: Route F16 approval and Swap through the single F11 flow

**Files:** modify focused/shared verifiers, `src/screens/dapp.html`, `src/screens/swap.html`, `src/shell-close.html`, `src/app.js`, `src/style.css`.

- [x] Add failing F16 tests for exact controls `Review 1,000 limit` and `Review unlimited request` and the full persistent sentence `No token approval has occurred. Your choice will be reviewed before any wallet request.` F16 must select only immutable fixture IDs, open the same F11, and never directly claim approval/signature/broadcast success.
- [x] Add failing Swap tests: an available fresh simulated Privy quote opens F11; summary contains exact input, estimated output, minimum output and fees; stale/unavailable/no-liquidity blocks. Continue closes F11 then shows a simulated pending provider banner—never immediate F12/success.
- [x] Add balance invariants for pending, cancel, rejection, failure, replay, route change, and quote expiry. Remove `afterSwap()`-style immediate mutation and fabricated success overlay paths.
- [x] Add a separate, precisely labelled `Show completed provider fixture` control. Only this control may select the immutable completed-provider scenario; label result `Simulated provider succeeded`. Then and only then display the updated GLYPH quantity with `Value unavailable`; exclude it from fiat total.
- [x] Update Chat→Swap shared regression to expect review→pending and unchanged holdings. Assert both approval kinds and transfer use the same dialog node/controller/focus/history behavior.
- [x] Ensure exact approval copy distinguishes a limited allowance from unlimited; display semantics must match the canonical request or fail closed.
- [x] Run build, focused/shared/account suites, syntax/security scans, responsive F11 checks.
- [x] Record checkpoint: `Task 6 — F16 + Swap unified through F11; no fabricated completion PASS`.

---

### Task 7: Complete provider-state, security, accessibility, and mobile coverage

**Files:** extend focused verifier; modify wallet modules/screens/styles only where a new failing case requires it.

- [x] Add the full F1 matrix: loading, empty, partial, stale, embedded, connected-external gap, watch-only. Assert exact class badge/capability copy and no false zero/provider claim.
- [x] Add the full F2 matrix: all history directions/types/statuses, empty/partial/malformed records, nullable fields, opaque pagination, provider gap, disabled review capabilities.
- [x] Add F6 matrix: every compatible asset/chain option, wrong-network warning, long address wrapping, clipboard success/rejection/unavailable, exact QR payload, watch-only Receive support.
- [x] Add F11 matrix across transfer/limited approval/unlimited approval/swap/Perp extension; every safe error; expiry races; double-click; hostile history; route/tab/reload/BFCache transitions; exact watch-only and external-wallet failure copy.
- [x] Add 375×667 and desktop DOM assertions for overflow, reachability, dialog containment, 44px primary targets, focus-visible, inactive inert screens, and reduced motion.
- [x] Add source/runtime scans scoped to new/touched wallet/review modules: no network/storage/secrets/private keys/seed phrases/dynamic scripts/custom ABI or QR encoder; no untrusted `innerHTML`; no raw review source or wallet payload in URL/history/storage; no floating-point money operations. Explicitly allowlist and preserve the existing owner-approved account-onboarding deterministic seed/private-key demo fixtures. Convert any unsafe toast insertion on the touched path to `textContent`.
- [x] Run the verifier first and observe each new matrix group fail before the corresponding minimal production fix. Re-run focused and all existing suites after each group.
- [x] Record checkpoint: `Task 7 — full wallet/review state matrix + security + mobile/a11y PASS`.

---

### Task 8: Documentation, deterministic full regression, and independent final review

**Files:** modify `_tmp/verify_docs.py`, `README.md`, `文档/页面清单.md`, `文档/开发进度安排.md`, `findings.md`, `progress.md`, `task_plan.md`, this plan; regenerate `app.html`, `docs.html`.

- [x] First extend `_tmp/verify_docs.py` and the focused wallet documentation checks so they fail on the pre-implementation current-state claims: generated screen count must move from `20` to `22`; the current authoritative screen scope must be A-tier `47` and total `103`, never current A-tier `48` or total `105`. The tests must distinguish semantic units and historical changelog entries: `105 小时` is the approved review-time budget in `文档/开发进度安排.md` and must remain; historical `48 → 47` / `105 → 103` migration records may remain when explicitly labelled as history. Also require the focused wallet verifier, manifest/vendor provenance, offline Privy simulation boundary, no-signing/no-network milestone, and production Privy/BFF integration notes.
- [x] Update docs only with verified behavior. Mark this slice complete in project tracking only after all evidence below passes. Keep Stream/Hyperliquid and remaining A–I work explicitly pending/in progress rather than implying whole-project completion.
- [x] Run final verification from a freshly generated state:

```bash
python3 build.py
python3 _tmp/verify_wallet_foundation.py
python3 _tmp/verify_account.py
python3 _tmp/verify_split.py
python3 build_docs.py
python3 _tmp/verify_docs.py
python3 -m py_compile build.py build_docs.py _tmp/verify_wallet_foundation.py _tmp/verify_account.py _tmp/verify_split.py _tmp/verify_docs.py
node --check src/wallet-provider.js
node --check src/wallet-review.js
node --check src/app.js
```

- [x] Run security/source scans for TODO/FIXME, old screen counts, `PrivyIntent`, legacy F16/swap-success labels, new-wallet secrets/network/storage, unsafe `innerHTML`, floating-point money, dynamic remote code, and hidden fake provider claims. Every expected allowlist match—including the pre-existing approved account seed/private-key demo fixtures—must be scoped, explained, and proven unchanged in the verifier.
- [x] Build twice into a temporary comparison copy and require byte-identical `app.html`; build docs twice and require byte-identical `docs.html`. Record SHA-256 values.
- [x] Run independent specification review against the approved design and this plan, then independent code-quality review over all wallet-slice changes. Fix/re-run/re-review until both return approved with no open issue.
- [x] Record final slice evidence: `Task 8 — wallet foundation/F11 complete; all focused + regression + docs + deterministic + independent reviews PASS`.
- [x] Only after final evidence, advance the global A–I plan to Stream/communication, Hyperliquid/Perp, and remaining provider-boundary slices. Do not mark the global goal complete at this checkpoint.

---

## Task execution log

Populate after each RED/GREEN/review cycle; do not pre-check boxes or claim results before commands run.

- 2026-08-22 — Independent implementation-plan review completed after five correction rounds: `APPROVED`.
- 2026-08-22 — Task 1 RED: 20 initial missing-contract failures; quality RED additions: 22 build-boundary failures and 9 screen-manifest failures. GREEN: 22-screen build, focused/shared/account suites, JS syntax, exact vendor hashes, and byte-exact generated artifact passed. Independent specification review: `APPROVED`. Independent quality review after path/lock/stale-output/screen-manifest fixes: `APPROVED`.
- 2026-08-22 — Task 2 RED: facade, DTO, exact-key, immutability, provider-isolation, bounded-input, and adversarial array-shape failures were established before implementation and each remediation. GREEN: frozen Privy adapter/DTOs, string-only fixed-point arithmetic, exact wallet-class capability matrix, focused/shared/account suites, JS syntax, and security scans passed. Independent specification review: `APPROVED`. Independent quality review after prototype/accessor pollution, bounded-input, isolated-global, freshness, and decimal-array-shape fixes: `APPROVED`.
- 2026-08-22 — Task 3 RED: hostile hashes, semantic F1/F2/F6 states, local QR/copy, exact navigation projection/provenance, adapter-derived signing gates, detail-presence rendering, descriptor safety, private authorization, and confused-deputy cases failed before implementation and each remediation. GREEN: strict canonical routes, normalized Privy-backed Wallet/Asset/Receive views, pinned local QR, write-only clipboard, bounded private Navigation ancestry proof, fresh private capability authority, mobile/a11y CSS, focused/account/shared suites, and both JS syntax checks passed on a 562,213-byte 22-screen build. Independent specification review after three remediation rounds: `APPROVED`. Independent quality review after five adversarial remediation rounds: `APPROVED`.
- 2026-08-22 — Task 4 RED: canonical decoder/controller, provider-path matrix, refresh identity/freshness, Forward/BFCache, real navigation projection, unavailable quote union, adapter authority, external identity, owner binding, capacity pruning, and authoritative provider-preview cases failed before implementation and each remediation. GREEN: digest-bound transfer/approval/swap/Perp review models, exact string arithmetic, strict source/provider DTOs, Privy/external/watch capability enforcement, closure-owned one-time sessions, fresh adapter authority and preview revalidation, and no Task 5 handoff/history transition. Final root-run build/focused/account/shared/syntax chain passed on a 622,589-byte 22-screen build. Independent specification review after four remediation rounds: `APPROVED`. Independent quality review after authoritative-preview remediation: `APPROVED`.
- 2026-08-22 — Task 5 RED: state-machine, acknowledgement, history/CAS, hostile marker, exact Navigation-entry/projection proof, modal/a11y, external identity, Perp fields, provider outcome binding, stable error-copy, and DOM provider-state cases failed before implementation and remediation. GREEN: one F11 dialog, exact marker-only history, closure-private bounded marker/session pair proofs, Back/Forward/BFCache/reload/route lifecycle, `returning_to_origin→handoff_pending→provider_*`, exactly-once adapter handoff, full digest-bound critical fields/provenance, fixed LOOP-owned provider error copy, complete inert/focus/veil behavior, and no holdings/storage mutation. Final fresh root-run build/focused/account/shared/three-syntax chain passed on a 668,591-byte 22-screen build. Independent specification review after three remediation rounds: `APPROVED`. Independent quality review after hostile provider-message remediation: `APPROVED`.
- 2026-08-22 — Task 6 RED: F16 identity and allowance binding, Swap-to-F11 routing, balance invariants, fabricated completion, completed-fixture authority, external approval kinds, provider/review ID aliases, quote-refresh windows/TTL, misleading DApp/Profile entries, mutable runtime authority, and hostile intrinsic/DOM replacement cases failed before implementation and remediation. GREEN: F16 and Swap share the one F11 lifecycle; limited/unlimited embedded/external approvals use exact same-ID provider fixtures; 13 exact immutable refresh windows cover the bounded source interval without aliases and cannot revive a five-minute-expired session; all non-completed outcomes leave holdings unchanged; the sole completed fixture is trusted-click, closure-ephemeral, reload-reset, watch-only fail-closed, and does not enter URL/history/storage; Profile is F17 plan-only; signing inventory reflects the real 12 controls. Final fresh root-run build/focused/account/shared/three-syntax chain passed on a 678,830-byte 22-screen build. Independent specification review after TTL remediation: `APPROVED`. Independent quality review after private-authority and intrinsic-capture remediation: `APPROVED`.
- 2026-08-23 — Task 7 RED: complete F1/F2/F6/F11 provider-state matrices, honest F2 loading, QR/toast DOM safety, 375×667/desktop containment and 44px targets, full safe-error UI coverage, history/storage projection integrity, and scoped wallet/signing source gates all failed before implementation and remediation. GREEN: real provider-state routes, one F11 36-cell safe-error DOM matrix, private QR/history/storage sanitizers, honest loading UI, 48px stale Retry, mobile/desktop/focus/inert/reduced-motion coverage, and a pinned test-only Acorn 8.15.0 AST gate covering all 12 wallet/signing sections with pre-launch hash/license verification and fail-closed call/data-flow contracts. Final fresh root evidence passed on a 693,924-byte 22-screen build: focused `ALL PASS`, AST bridge plus three production syntax checks, account, and shared suites all exit 0. Independent specification review after the state-integrity/security remediation loop: `APPROVED`. Independent quality review after F2/loading, target-size, signing-manifest, AST/global-alias, and local-provenance remediation: `APPROVED` with no open issue.
- 2026-08-23 — Task 8 RED: stale screen counts, weak current/historical count assertions, documentation source/generated drift, non-structural inventory totals, raw-text script injection, CDN-dependent/unpinned Marked execution, parser-fallback gaps, and vendor-lock duplicate-key/symlink attacks were reproduced before each remediation. GREEN: generated sources now structurally recompute 103 unique items with A/B/C = 47/46/10; `docs.html` is byte-synced to source, offline, and embeds the official pinned `marked@18.0.10` UMD with MIT license, exact lock, strict JSON, confined non-symlink regular-file checks, and safe raw-text fallback for missing/incompatible/throwing/non-string/Promise parser outcomes. Tamper, stale-source, mixed-case injection, and internal/external symlink tests fail closed. Independent specification and quality re-reviews returned `APPROVED` with no open issue. Final root evidence passed focused `ALL PASS`, account/shared/docs suites, Python and JavaScript syntax, Acorn AST protocol, source/security scans, deterministic rebuilds, and exact SHA-256: app `724e66cd544bd648bbc7b93d630d24178a8405318b051c75c67c51302ab2fb25`, docs `d9122461ce1eee45de42252b5c0b96b84b6f994735eccd85fc54607b8b505a18`. Wallet foundation/F11 is complete; the global A–I goal remains in progress.
