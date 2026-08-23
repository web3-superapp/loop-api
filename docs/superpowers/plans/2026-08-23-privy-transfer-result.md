# Privy Same-Chain Transfer and Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement F3 asset selection, F4 recipient safety, F5 exact-input amount review, the existing single F11 authorization surface, and F12 Privy transfer results as a deterministic offline prototype plus a credential-gated production integration contract.

**Architecture:** Extend the existing frozen Privy boundary with opaque prepared-review and result-binding capabilities, extend the existing F11 controller with an exact V1/V2 migration, and add separate DOM-free `TransferDraftController` (F3–F5) and `TransferResultController` (F12) closures. The HTML remains a zero-network, zero-signing fixture; production authority stays with Privy Wallet Actions and Flutter authorization signatures, while a thin BFF contract delegates EVM/Solana parsing and ENS/screening to pinned official/OSS adapters and fails closed until provider credentials exist.

**Tech Stack:** Static HTML5, CSS, vanilla JavaScript, Python 3 build/verifier scripts, Playwright Python sync API, existing pinned Acorn security bridge, Privy Wallet Actions/Flutter contract, viem `2.55.10` (MIT) and Anza `@solana/addresses` `6.10.0` (MIT) as production-BFF dependency declarations.

---

## Working constraints

- Design authority is `docs/superpowers/specs/2026-08-23-privy-transfer-result-design.md`; owner approved the written specification on 2026-08-23 and independent review returned `APPROVED` after the durable write-ahead correction.
- Source of truth is `src/`; never edit generated `app.html`. `python3 build.py` is its only writer.
- `docs.html` is generated only by `python3 build_docs.py`.
- The directory has no Git metadata. Do not initialize Git or create a worktree. Replace commit steps with named RED/GREEN/review checkpoints in this plan and `progress.md`.
- Use @test-driven-development for every behavior change: write the focused assertion, run it and observe the intended failure, implement the minimum contract-complete change, then rerun focused and affected regressions.
- Execute sequentially with @subagent-driven-development, as already selected by the owner. Every task uses a fresh implementer, then independent specification review and independent code-quality review; resolve all Medium+ findings before the next task.
- Use @verification-before-completion before claiming a task or this slice complete.
- Privy is the wallet/delivery backbone. Do not implement wallet custody, key generation, authorization signing, transaction construction, broadcasting, gas estimation, provider action lifecycle, ENS indexing, sanctions infrastructure, RPC infrastructure, or Wallet Action polling inside the HTML.
- The HTML fixture has no `fetch`, XHR, WebSocket, provider SDK, secret, JWT, authorization signature, private key, custom transaction, timer-driven fake completion, or production claim. Its fixture copy remains exactly `Simulated Privy — no network, no signing`.
- Credentials absent means production adapters are disabled and staging tests report `NOT RUN — CREDENTIALS REQUIRED`; it never means a local provider replacement.
- Amounts, balances, fees and comparisons use canonical decimal/integer strings only. No `Number`, `parseFloat`, `toFixed`, scientific notation or floating-point money arithmetic.
- Recipient, amount, wallet/review/action/submission IDs, request bytes, nonce, expiry, idempotency key and provider payload never enter URL, history, storage, DOM attributes, console, toast or unsafe error copy. Clipboard writes are forbidden except a trusted, explicit user action that writes only the currently bound canonical recipient address; clipboard reads are always forbidden.
- F11 remains one shared modal. F5 must not create a second signing/confirmation surface.
- Preserve V1 transfer top-level `amount` precedence, exact-output, Swap, approval, external-wallet and Perp regressions unchanged.

## File responsibility map

Create:

- `_tmp/verify_wallet_transfer.py` — focused F3/F4/F5/F11-V2/F12/contract/security/a11y verifier; it must not import the side-effecting foundation verifier.
- `src/screens/send.html` — F3 asset/chain selection states.
- `src/screens/send-to.html` — F4 address/ENS/fixture scanner/recent-recipient and safety acknowledgements.
- `src/screens/send-confirm.html` — F5 canonical amount, balance/gas provenance and review preparation.
- `src/screens/tx-result.html` — F12 `wallet_action | submission_unknown` result surface.
- `src/wallet-transfer.js` — DOM-free, separately constructed `TransferDraftController` (F3–F5 only) and `TransferResultController` (F12 only), fixed-point validation and exact fixture policy projection; no provider/network/signing primitive.
- `contracts/privy-transfer/bff-contract.json` — machine-readable BFF routes, exact Privy payload/header/body contract, result union and write-ahead state machine.
- `contracts/privy-transfer/dependency-lock.json` — selected production adapter versions, registries, integrity, licenses, repositories and `installed:false` credential/dependency gate.
- `contracts/privy-transfer/README.md` — Flutter/BFF ownership, secret/config categories, staging R0 instructions and capability-audit gates.
- `contracts/privy-transfer/fixtures/wallet-api-payload-v1.json` — public dummy-ID request and canonical formatter input.
- `contracts/privy-transfer/fixtures/wallet-api-payload-v1.canonical.bin.sha256` — hash of exact bytes produced by pinned official server formatter.
- `contracts/privy-transfer/fixtures/flutter-authorization-signature.json` — exact SDK/payload hash/status schema; contains public verification material only after credentialed test execution and otherwise records `NOT RUN — CREDENTIALS REQUIRED` with null signature.
- `contracts/privy-transfer/fixtures/provenance.json` — formatter/Flutter package versions, source URLs, integrity/hash, generation command and fixture hashes.

Modify:

- `build.py`, `src/screens-order.txt`, `src/scripts-order.txt`.
- `src/wallet-provider.js`, `src/wallet-review.js`, `src/app.js`, `src/style.css`, `src/screens/wallet.html`, `src/screens/asset.html`, `src/shell-close.html`.
- `_tmp/verify_wallet_foundation.py`, `_tmp/verify_account.py`, `_tmp/verify_split.py`, `_tmp/verify_docs.py`.
- `README.md`, `文档/页面清单.md`, `文档/开发进度安排.md`, `文档/测试用例.md`, `findings.md`, `progress.md`, `task_plan.md`, and this plan's execution log.
- Regenerate `app.html` and `docs.html` only through their build scripts.

## Locked manifests and public facades

The exact 26-screen suffix is:

```text
wallet
asset
send
send-to
send-confirm
receive
tx-result
swap
dapp
profile
```

The current exact six-script production order is:

```text
vendor/qrcode-generator-1.4.4.js
wallet-provider.js
wallet-review.js
wallet-transfer.js
stream-chat-provider.js
app.js
```

`stream-chat-provider.js` is a DOM-free, fail-closed Stream Chat/Video integration seam. The immutable offline fixture is test-only at `src/test-fixtures/stream-chat-offline-fixture.js`; the builder excludes that directory and `app.html` must never contain fixture bytes or connected/ready success claims.

The transfer facade exposes constructors only; it never holds or returns provider capabilities:

```javascript
globalThis.LoopWalletTransfer = Object.freeze({
  createDraftController,
  createResultController
});
```

`LoopWalletProvider` adds one safe composition-root factory, `createSimulatedTransferRuntime`. It creates the registry and privileged functions in its own closure, passes `consumePreparedTransferReview` only into `LoopWalletReview.createController`, and passes `getTransferResultSnapshot` only into `createResultController`. It returns exactly `{page_adapter,review_controller,draft_controller,result_controller}`; `page_adapter` exposes existing read methods plus prepare only, and no returned controller snapshot contains canonical source, internal review ID, action/submission ID or the privileged functions. Existing `createSimulatedAdapter` remains the exact V1 seven-method regression adapter.

All fixture tables, draft records, recipient evidence, prepared/result handles, action/submission IDs, route generations, clocks and callbacks remain closure-owned. Reachability tests inspect globals, facade descriptors, returned runtime/page adapter/controllers, DOM and serialized snapshots. `LoopWalletReview` stays frozen; no second wallet client or review surface is added.

The production dependency declaration pins:

```json
{
  "viem": {
    "version": "2.55.10",
    "license": "MIT",
    "integrity": "sha512-Q9Ba+/ma81U2M5o5P2AQ7Ux8rTIwmCZvUcr8rKdQ22bV0IBFHllM2m5gWDP8hFaUN2nH2oW3QG44amRazflYNQ==",
    "source": "https://registry.npmjs.org/viem/-/viem-2.55.10.tgz",
    "repository": "https://github.com/wevm/viem.git"
  },
  "@solana/addresses": {
    "version": "6.10.0",
    "license": "MIT",
    "integrity": "sha512-vEoCGBTxG0HCERAn84KXkrJjl+pDaNzOpZ0qbgcPS98fYxP5yzbKB8SNOY2bzrbkRUmmw5Q3hqTRERemUN2Gcw==",
    "source": "https://registry.npmjs.org/@solana/addresses/-/addresses-6.10.0.tgz",
    "repository": "https://github.com/anza-xyz/kit.git"
  }
}
```

These packages are declared for the future production BFF, not downloaded into or executed by the HTML. Enabling them later requires an exact transitive lock/SBOM, license capture, registry integrity verification, capability audit and credentialed staging evidence.

Formatter/signature provenance also pins `@privy-io/node@0.29.0` (Apache-2.0, npm integrity `sha512-Tcpy8ZDi14SzAmqFXRSgKTgMsk8truxAXodHuRR08XjLSfZLAx2Kfh8EBSoKTPxK9KakMjRhO6+nw66RtiiYdg==`, official `privy-io/node-sdk`) and `privy_flutter@0.10.1` (MIT, publisher `privy.io`). The server formatter golden bytes may be generated offline with public dummy IDs. A real Flutter authorization signature requires an authenticated test user and stays `NOT RUN — CREDENTIALS REQUIRED` until staging credentials exist; no substitute signing algorithm or fabricated signature is permitted.

## Mandatory post-GREEN gate for every implementation task

Before any Task 1–8 checkpoint may be marked PASS, run this complete gate from a freshly generated state (plus that task's RED/focused commands), then dispatch independent specification and code-quality reviewers for that task:

```bash
python3 build.py
python3 _tmp/verify_wallet_transfer.py
python3 _tmp/verify_wallet_foundation.py
python3 _tmp/verify_account.py
python3 _tmp/verify_split.py
python3 build_docs.py
python3 _tmp/verify_docs.py
python3 -m py_compile build.py build_docs.py _tmp/verify_wallet_transfer.py _tmp/verify_wallet_foundation.py _tmp/verify_account.py _tmp/verify_split.py _tmp/verify_docs.py
node --check _tmp/js_ast_call_model.js
node --check src/wallet-provider.js
node --check src/wallet-review.js
node --check src/wallet-transfer.js
node --check src/app.js
```

For determinism, build `app.html` twice into a `mktemp -d` comparison copy and require `cmp -s`; repeat for `docs.html`. Record both SHA-256 values. A task checkpoint requires both independent reviews to return `APPROVED` with no open Medium+ issue; fixture GREEN never substitutes for credentialed staging R0.

---

### Task 1: Establish the focused RED gate and deterministic 26-screen skeleton

**Files:** create `_tmp/verify_wallet_transfer.py` and four screen fragments; modify `build.py`, `src/screens-order.txt`, `src/scripts-order.txt`, `_tmp/verify_wallet_foundation.py`, `_tmp/verify_split.py`, `_tmp/verify_docs.py`, `README.md`, `findings.md`, `文档/页面清单.md`, `文档/开发进度安排.md`; create the minimal `src/wallet-transfer.js` frozen-facade shell.

- [x] Add focused source/build assertions first: exact 26-screen order, then-exact five-script wallet skeleton (now evolved to the exact six-script production manifest above), four unique semantic screen fragments, four routes, one F11 dialog, no second confirmation dialog, no orphan scripts/screens, and no new network/storage/signing primitive. Run `python3 _tmp/verify_wallet_transfer.py`; expected failure is missing screens/routes/script. Contract assertions are added only in Task 2.
- [x] Add Playwright RED checks for direct `#send`, `#send-to`, `#send-confirm`, `#tx-result`, exactly one active non-inert screen, canonical safe ancestry, zero console/page errors, and honest unavailable state without a closure binding.
- [x] Create minimal fragments with one `.scr`, one visible H1, route-focus target, safe back control and semantic state containers. Do not add working buttons or fake provider data yet.
- [x] Insert the screens after `asset` as `send`, `send-to`, `send-confirm`, then retain `receive`, insert `tx-result`, and keep the remaining order. Update `EXPECTED_SCREENS` and its exact `26-screen` failure text.
- [x] Add `wallet-transfer.js` with only the frozen two-constructor facade shell and insert it after `wallet-review.js`. Update `EXPECTED_SCRIPTS`, orphan-script checks and script-order runtime assertions.
- [x] Extend the shared route inventory and current 22-screen assumptions to 26 without weakening exact-count/order checks. Update known-screen/stack bounds from 22 to 26 and wallet route stack depth from three to four only where required.
- [x] Add RED docs assertions for the current generated 26-screen manifest, then update only current-tense screen-count/manifest facts in `_tmp/verify_docs.py`, README, findings, `文档/页面清单.md` and `文档/开发进度安排.md`. Preserve historical/changelog 22-screen evidence and all feature-completion claims as pending until Task 9; do not pre-claim F3–F5/F12 behavior.
- [x] Run GREEN: `python3 build.py`, the new focused verifier, foundation/shared regressions, and `node --check` on all four product modules. Expected generated screen count: 26.
- [x] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [x] Record checkpoint: `Task 1 — 26 deterministic route shells + isolated transfer verifier PASS`.

### Task 2: Add the credential-gated production integration contract

**Files:** create the contract, dependency, README and four fixture/provenance files under `contracts/privy-transfer/`; extend `_tmp/verify_wallet_transfer.py`; modify `build.py` only to validate fixed contract paths/strict JSON if the RED gate proves build ownership is needed.

- [ ] Add RED tests that strict-parse both JSON files, reject duplicate keys/symlinks/unknown schema versions, and require provider authority `Privy`, communication authority `Stream`, Perp authority `Hyperliquid`, with auxiliary resolution/screening explicitly subordinate and disabled without credentials.
- [ ] Define exact BFF operations for asset selections, recipient preflight, review prepare, Flutter authorization submission, result projection and current-wallet reconciliation. Client request allowlists must exclude user ID, wallet ID, chain/asset metadata, action/submission ID, endpoint, expiry, nonce, idempotency key and screening verdict.
- [ ] Encode the exact Privy `WalletApiPayloadV1`: full `https://api.privy.io/v1/wallets/{wallet_id}/transfer` URL, HTTP `POST`, only the three signed `privy-*` headers, and the exact same-chain named-asset body. Basic Auth, content-type, trace and authorization signature are explicitly outside signed headers.
- [ ] Encode and RED-test the mandatory post-signature/pre-POST sequence: after Flutter returns, BFF validates exact payload bytes, authorization signature, expiry, nonce, idempotency key and review binding; then immediately re-resolves ENS, re-screens the canonical address, rereads authenticated wallet/epoch, balance and sponsorship/config, and deep-compares every material field against the signed review/body. Any mismatch consumes the review and returns F5 for a wholly new prepare before any write-ahead attempt or transport byte.
- [ ] Encode `TransferResultSnapshot = wallet_action | submission_unknown`, normalized action/step enums, provider-unknown-key policy, REST-first low-frequency polling that stops permanently at a terminal state, webhook capability gate and no caller-supplied action/submission ID. Unknown raw step type/status maps only to `provider_step/unknown`, creates no explorer link, and never overrides Privy's top-level action status.
- [ ] Encode `SubmissionAttempt` and state transitions: attempt+owner/wallet lock durable commit before any transport byte, proved-zero-byte unlock only, encrypted replay material, response-record-before-binding, exact replay within signed expiry, durable unknown after expiry, CAS lease/fencing recovery, startup scan and evidence-backed operator close.
- [ ] Encode the explicit synchronous Privy 5xx branch: durably record the 5xx first; permit exactly one controlled replay within the original signed expiry using byte-identical URL/body/signed headers/authorization signature/idempotency key; forbid a new key/review/body; any second timeout/uncertain outcome becomes durable `submission_unknown` and retains the owner+wallet lock.
- [ ] Record `viem@2.55.10` and `@solana/addresses@6.10.0` exact metadata above with `runtime_target:"production_bff"`, `installed:false`, and `enablement:"credential_and_capability_audit_required"`. Do not vendor or execute either package in the HTML.
- [ ] Record `@privy-io/node@0.29.0` and `privy_flutter@0.10.1` as the official formatter/signature provenance. The dependency lock distinguishes npm/pub registries and records the Node integrity above; the Flutter archive hash is resolved and fixed during the isolated fixture-generation audit before any signature evidence is accepted.
- [ ] Document required categories—not secret values—for Privy app/server/authorization config, Alchemy RPC, Chainalysis screening and optional Enterprise webhook. Chainalysis endpoint/raw fields remain `pending_credentialed_audit`; do not invent them.
- [ ] Add staging R0 commands/placeholders that produce `NOT RUN — CREDENTIALS REQUIRED` until configured and cannot count as `production_integration_complete`.
- [ ] Run the focused contract tests plus `python3 build.py`; expected GREEN proves an exact, disabled production contract without network code or secret fixtures.
- [ ] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [ ] Record checkpoint: `Task 2 — Privy-first BFF/Flutter contract + OSS dependency gate PASS`.

### Task 3: Implement separate DOM-free draft and result controller contracts

**Files:** modify `_tmp/verify_wallet_transfer.py`, `src/wallet-transfer.js`.

- [ ] Add RED tests for the exact frozen facade `{createDraftController,createResultController}` using frozen mock capabilities. `createDraftController` receives only a prepare-only page adapter and constructor clock; `createResultController` receives only a private projector function and binding sink. Page methods never accept `now_ms`, provider source objects, user/wallet IDs, result/action/submission IDs or privileged functions.
- [ ] Implement closure-owned, bounded, TTL/generation-scoped draft state with phases `asset -> recipient -> amount -> preparing -> review_open`. It owns F3–F5 only. Reload, logout, wallet/account epoch change, invalid ancestry, route change and stale generation consume the draft.
- [ ] Use mock adapter-issued asset selection IDs from normalized balance rows. F3 cannot synthesize chain/asset metadata or continue with zero/unsupported/stale data.
- [ ] Implement the HTML-only recipient policy as an exact frozen fixture lookup, labelled simulated. It does not parse arbitrary addresses, query ENS, score risk or claim Chainalysis. Unknown input is invalid/unavailable. Production behavior remains solely in the Task 2 contract.
- [ ] Cover EVM clear/blocked/unavailable/first/seen/history-unknown, ENS success/change/failure, Solana canonical/on-curve/off-curve fixture results, ENS-on-Solana unsupported and EVM↔Solana substitution. First and history-unknown acknowledgements are independent and reset on material change.
- [ ] Implement canonical decimal validation and independent string/base-unit comparison for zero, over-balance, decimals `0..36`, 100/101 characters, leading zeros, precision overflow and stale balance. Do not offer Max unless the fixture proves usable balance semantics.
- [ ] `prepareReview()` sends only the raw draft to the mock prepare-only capability, receives only the handle, consumes the draft generation on failure, and never exposes canonical source.
- [ ] Implement `TransferResultController` as a separate closure. It owns only its private result binding/cursor projection, never draft fields or prepared handles, and exposes deeply frozen display snapshots without action/submission IDs.
- [ ] Run focused controller tests, malicious descriptor/prototype/accessor vectors and exact global/DOM/snapshot reachability tests.
- [ ] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [ ] Record checkpoint: `Task 3 — separate F3–F5 draft and F12 result controller contracts PASS`.

### Task 4: Migrate the single F11 controller from V1-only to exact V1/V2

**Files:** modify `_tmp/verify_wallet_transfer.py`, `_tmp/verify_wallet_foundation.py`, `src/wallet-review.js`, `src/shell-close.html`, `src/app.js`, and the four formatter/signature fixture files.

- [ ] Add RED V1 regressions first: static fixture lookup, top-level transfer `amount` precedence, exact-input/exact-output, Swap/approval/external/Perp models and current history/focus lifecycle remain byte/behavior compatible.
- [ ] Extend `createController` with an exact optional private `consumePreparedTransferReview` constructor capability while preserving the V1 `{adapter}` path. Add RED V2 tests using a private mock capability: `openPreparedTransfer({prepared_review_handle,live_context,origin})` calls only that capture; no `openSource`, canonical-looking caller object, adapter method or page-visible resolver is accepted.
- [ ] Extend the canonical decoder with exact `version:2` transfer source/execution/context keys, asset selection/chain family/wallet epoch, screening/history acknowledgements, fresh balance, gas mode, request expiry, full `WalletApiPayloadV1`, source/execution digests and preview-unavailable state.
- [ ] In `mktemp -d`, verify the pinned npm tarball integrity, create an exact temporary lock, install with lifecycle scripts disabled, and run a one-purpose Node harness that imports only `@privy-io/node@0.29.0` `formatRequestForAuthorizationSignature`. Generate the public dummy-ID golden input/hash/provenance; require byte equality and reject forbidden signed headers. Do not commit `node_modules`.
- [ ] Create the Flutter signature evidence file bound to that payload SHA and `privy_flutter@0.10.1`. Before credentials it must say `NOT RUN — CREDENTIALS REQUIRED` with null signature/public-key; staging later uses only the official Flutter method and stores public verification material outside the HTML.
- [ ] Revalidate live owner/wallet/endpoint/epoch, selection, recipient/screening TTL, balance/config, source/execution digest and origin before Continue. A material change consumes the review and returns F5 for a new prepare.
- [ ] Preserve the unchecked `Action preview unavailable` acknowledgement. Render V2 facts inside the same F11 node and maintain the existing marker/history/focus/inert/veil/one-time CAS lifecycle.
- [ ] Run focused transfer + foundation/account/shared, syntax and AST security gates.
- [ ] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [ ] Record checkpoint: `Task 4 — one F11 exact V1/V2 migration + formatter binding PASS`.

### Task 5: Build the private Privy transfer composition root and safe runtime

**Files:** modify `_tmp/verify_wallet_transfer.py`, `_tmp/verify_wallet_foundation.py`, `src/wallet-provider.js`, `src/wallet-review.js`, `src/wallet-transfer.js`, `src/app.js`.

- [ ] Add RED exact-interface tests: `createSimulatedAdapter` retains exactly seven V1 methods; the provider facade adds exactly `createSimulatedTransferRuntime`; its `page_adapter` has the safe read/handoff methods plus prepare only, never consume/result-projector capabilities.
- [ ] Add RED asset-selection and prepare tests: opaque IDs bind owner/wallet epoch/chain family/chain/asset/metadata/decimals/balance/expiry; same-symbol cross-chain, forged, replayed, expired and cross-wallet IDs fail closed; raw drafts reject caller chain/metadata/wallet/user/time/provider fields.
- [ ] Implement the runtime-closure prepared registry, atomic one-use private consume capability and private result projector. Add frozen action/unknown fixtures and safe error mappings; no timer completion or balance mutation.
- [ ] Construct the already implemented review/draft/result controllers inside `createSimulatedTransferRuntime`, injecting private functions directly. Return exactly `{page_adapter,review_controller,draft_controller,result_controller}` deeply frozen.
- [ ] Add reachability tests over globals, own descriptors, lexical page references, returned runtime/controllers, DOM and serialization; no private function, source, internal review ID, action ID or submission ID is reachable. Preserve V1 action snapshot regression and resource separation.
- [ ] Run focused RED/GREEN, foundation/account/shared, syntax, fixed-point and security scans.
- [ ] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [ ] Record checkpoint: `Task 5 — private Privy composition root + opaque adapter/runtime bindings PASS`.

### Task 6: Render F3/F4/F5 and exact send-route lifecycle

**Files:** modify `_tmp/verify_wallet_transfer.py`, `_tmp/verify_account.py`, `_tmp/verify_split.py`, four wallet screen fragments as needed, `src/screens/wallet.html`, `src/screens/asset.html`, `src/app.js`, `src/style.css`.

- [ ] Add RED route tests for canonical stacks: Wallet `['scr-wallet']`; F3 `['scr-wallet','scr-send']`; F4 adds `scr-send-to`; F5 adds `scr-send-confirm`. Wallet/F2 Send starts a fresh F3 flow; push transitions are exact; direct F4/F5 links without closure proof sanitize to Wallet.
- [ ] Add exact direct-`#send` RED cases: authenticated embedded + unlocked creates a fresh F3 generation with Wallet ancestry; unauthenticated renders the F3 unauthenticated state without a draft/selection; owner+wallet unknown lock redirects to the unique F12 reconciliation cursor. Direct navigation never revives a stale generation.
- [ ] Add RED history/privacy tests: hashes contain no parameters; `history.state` contains only bounded route proof/generation markers; recipient/amount/selection/internal IDs never appear. Back restores the prior valid phase; reload/BFCache/account or wallet mismatch destroys the flow.
- [ ] Render F3 from adapter-derived supported selections with asset, chain, balance and provider provenance. Cover unauthenticated/loading/empty/partial/unavailable/external gap/watch-only; only authenticated embedded + supported + positive/fresh balance continues.
- [ ] Render F4 address/conditional ENS input, fixture scanner and recent recipient controls. Show validating, clear, invalid, ENS failed, blocked, unavailable, first-time and history-unknown. Block blocked/unavailable/expired; require the two independent acknowledgements where applicable.
- [ ] Render F5 amount input and canonical summary. Cover invalid/zero/over-balance/stale/native-reserve-unknown/provider-unavailable/screening-expired/preview-unavailable/preparing/prepare-failed. Show no custom gas control, fake estimate or unsafe Max.
- [ ] F5 Continue only prepares/opens the existing F11 and carries `data-requires-signing`; F3/F4 controls are not signing controls. Update watch-only's exact control inventory and expected matrix.
- [ ] Use only safe DOM construction and `textContent`. Full recipient is viewable/copyable only by explicit user action; clipboard writes only the canonical address and never reads clipboard.
- [ ] Add 375×667/desktop styles, 44px targets, no horizontal overflow, meaningful focus restoration, status/error `aria-live`, non-color-only warnings and reduced motion.
- [ ] Run focused, account/shared, foundation, syntax/AST and viewport suites.
- [ ] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [ ] Record checkpoint: `Task 6 — F3/F4/F5 safe routed UI → single F11 PASS`.

### Task 7: Implement F12 result union, status reconciliation and unknown-send lock UX

**Files:** modify `_tmp/verify_wallet_transfer.py`, `src/wallet-provider.js`, `src/wallet-transfer.js`, `src/app.js`, `src/screens/tx-result.html`, `src/style.css`.

- [ ] Add RED DTO tests for exact `WalletActionResult` and `SubmissionUnknownResult`; unknown has no action ID/status/hash/steps/explorer and never maps to failed. Result lookup accepts only an owner/wallet-bound opaque handle.
- [ ] Normalize official-shaped REST action fixtures into pending/succeeded/rejected/failed and bounded steps. Ignore unknown raw keys; map unknown raw step type/status only to `provider_step/unknown` with null explorer link; reject malformed required/read fields, unsafe prototypes/accessors/provider text, invalid hashes/timestamps and wallet/action/result mismatches. Low-frequency polling stops after the first terminal state and cannot be restarted by stale route/visibility events.
- [ ] Add event-order fixture tests: duplicate same state is idempotent, pending transitions to one terminal, terminal regression/conflict quarantines, webhook-before-binding inbox is bounded/TTL, and similar amount/address never auto-binds.
- [ ] Implement F12 route replacement: action ID or submission unknown replaces the entire send stack with `['scr-wallet','scr-tx-result']`; stale F3/F4/F5 Back/Forward markers sanitize to Wallet. F12 in-app Back replaces to Wallet.
- [ ] Render pending, succeeded, rejected, failed, malformed/unavailable and submission unknown exactly. Pending includes `Refresh status`, elapsed explanation and a safe Wallet return without retry; rejected may return to F5 only through a wholly new draft/prepare/review; failed warns that chain effects may exist and has no blind retry. Only succeeded may trigger provider-authoritative balance/history refresh. Pending/rejected/failed/unknown never mutate holdings.
- [ ] Build explorer links only from fixed `chain_id -> base URL` and canonical hashes. Provider URL/text is never rendered. Accelerate/cancel remain absent.
- [ ] Model the production write-ahead states only as explicit immutable fixture scenarios. Unknown fixture atomically activates an owner+wallet lock across every outgoing-transfer entry point (Wallet, F2, F3, every other Send CTA and direct `#send`), consumes all outstanding prepared-transfer handles, invalidates every prior send generation, and blocks creation of selection, draft, nonce, review or idempotency key. Receive/read-only remain available. Only exact action binding or evidence-backed operator reconciliation releases the lock.
- [ ] Test every restart/cut-point projection against `bff-contract.json`: signature not returned/pre-BFF validation failure; durable attempt+lock transaction failure; commit then proved-zero-byte failure; crash before write; crash during/after ambiguous write; timeout; response received before durable record; response recorded before binding; action-ID response; expiry; exact replay; duplicate workers and stale fencing token. Pre-commit failures create no attempt/provider request; only audited zero-byte proof may infer `not_submitted`; ambiguous crashes retain lock/unknown; action-ID success records the response before atomic binding. Add the explicit synchronous 5xx sequence: durable 5xx record -> exactly one byte-identical replay under the original key/review/expiry -> action binding or durable unknown; startup recovery scanning must never create a new key/review/body. The HTML does not execute transport or pretend to persist the server record.
- [ ] Implement result lifecycle distinctions: HTML result handle is closure-only and reload becomes honestly unavailable; production contract uses an authenticated device-flow current-result cursor, restores only a unique owner+wallet binding without an action ID, and returns unavailable when multiple flows are ambiguous. Result-binding TTL/logout/user switch clears client access but never deletes a durable submission attempt or owner+wallet send lock; the original owner sees reconciliation again after reauthentication.
- [ ] Run focused, foundation/account/shared, syntax/AST and balance-invariant suites.
- [ ] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [ ] Record checkpoint: `Task 7 — F12 action/unknown union + wallet-scoped reconciliation lock PASS`.

### Task 8: Complete adversarial, accessibility, security and provider-boundary matrices

**Files:** extend `_tmp/verify_wallet_transfer.py`; modify touched production files only when a new failing assertion requires it.

- [ ] Add full asset/chain substitution vectors: forged/replayed/expired selection; same symbol cross-chain; owner/wallet epoch changes; EVM↔Solana; stale balance/config.
- [ ] Add fixed-point independent-oracle vectors: zero/sign/space/scientific/leading/trailing decimal, maximum precision, 100/101 chars, exact balance/one-unit-over and native reserve/sponsorship uncertainty.
- [ ] Add recipient matrix: EVM checksum fixture, ENS change/expiry/failure, Solana malformed/noncanonical/base58/decoded length/on/off curve, ENS-on-Solana, Chainalysis blocked/unavailable/429/5xx/malformed/expired, first/seen/partial-history-unknown and acknowledgement reset.
- [ ] Add V1/V2 injection, prepared/result ownership/TTL/capacity/double-use, formatter bytes, exact post-sign validate→re-resolve→re-screen→reread→deep-compare-before-write TOCTOU, action/submission caller-ID and event-order vectors.
- [ ] Add wallet-wide unknown-lock vectors for every Send CTA/direct route, selection/draft/nonce/review/key creation, atomic prepared-handle consumption, all-generation invalidation, TTL/logout/reload persistence and exact-action/operator-only release.
- [ ] Add route/history/privacy attacks: duplicate/hostile hash, malformed state, direct/reload/BFCache, stale generation, and action/recipient/amount/request data scans across URL/history/storage/DOM/console/toast. Clipboard tests allow only a trusted explicit click writing the exact bound canonical recipient; they reject automatic writes, any other data and every clipboard read.
- [ ] Extend AST gates for the new source section: no network/storage bypass, dynamic execution, custom signing/transaction/gas/ENS/base58/checksum implementation, floating-point money, unsafe `innerHTML`, timers that fabricate provider completion or direct balance mutation.
- [ ] Add mobile/desktop keyboard/focus/inert/dialog/44px/reduced-motion cases and exact status text+icon semantics.
- [ ] Run each matrix RED before minimal fixes, followed by transfer focused + foundation/account/shared regression after each group.
- [ ] Run the mandatory post-GREEN gate, deterministic double builds and both independent task reviews; resolve and re-review every Medium+ issue.
- [ ] Record checkpoint: `Task 8 — transfer adversarial/security/a11y/provider boundary PASS`.

### Task 9: Update documentation, run deterministic full regression and complete independent review

**Files:** modify docs/tracking/verifiers listed above; regenerate `app.html`, `docs.html`; update this plan's execution log.

- [ ] Extend docs RED assertions first: current generated screen count is 26; F3/F4/F5/F12 and one F11 are accurately described; production contract paths and dependency pins exist; Privy is primary; Stream/Hyperliquid remain authoritative for their domains; credentials/staging R0 remain pending; no production-connected claim appears.
- [ ] Update `文档/页面清单.md` to record the approved gas/preview/accelerate-cancel corrections without silently rewriting historical requirements. Update `文档/测试用例.md` with the exact new focused verifier and resolved semantics.
- [ ] Update README/progress/findings/task plan only from verified evidence. Mark at most `prototype_complete`; do not mark `production_integration_complete` or the global A–I goal complete while credentialed gates and remaining modules are pending.
- [ ] Run the final chain from freshly generated artifacts:

```bash
python3 build.py
python3 _tmp/verify_wallet_transfer.py
python3 _tmp/verify_wallet_foundation.py
python3 _tmp/verify_account.py
python3 _tmp/verify_split.py
python3 build_docs.py
python3 _tmp/verify_docs.py
python3 -m py_compile build.py build_docs.py _tmp/verify_wallet_transfer.py _tmp/verify_wallet_foundation.py _tmp/verify_account.py _tmp/verify_split.py _tmp/verify_docs.py
node --check _tmp/js_ast_call_model.js
node --check src/wallet-provider.js
node --check src/wallet-review.js
node --check src/wallet-transfer.js
node --check src/app.js
```

- [ ] Run scoped source/security scans for TODO/FIXME, old screen/script counts, custom wallet/signature/transaction/gas/address parser, network/storage bypass, unsafe DOM, floating-point money, provider secret/payload leakage and fake completion. Preserve the existing approved account-onboarding fixture allowlist exactly.
- [ ] Build `app.html` twice and require byte identity; build `docs.html` twice and require byte identity. Record final byte sizes and SHA-256 values.
- [ ] Run independent specification review against the approved spec and this plan, then independent code-quality review across all slice changes. Fix, rerun the entire evidence chain and re-review until both return `APPROVED` with no open Medium+ issue.
- [ ] Record final slice evidence: `Task 9 — Privy F3/F4/F5/F11-V2/F12 prototype_complete; production credentials R0 pending; all focused/regression/docs/determinism/reviews PASS`.
- [ ] Advance the active global A–I plan to the next approved Stream/Hyperliquid/provider integration slice. Do not call the global goal complete at this checkpoint.

---

## Task execution log

Populate only after each real RED/GREEN/review cycle; do not pre-check boxes or claim future evidence.

- 2026-08-23 — Owner approved the design direction and later the final written specification. Independent specification review completed four rounds; the final exception review returned `APPROVED` after adding durable write-ahead attempt/lock, crash recovery and CAS/fencing semantics.
- 2026-08-23 — Implementation plan drafted from current repository evidence and exact official/registry dependency metadata. Independent plan-document review completed four rounds; the final exception review returned `✅ Approved` after correcting private capability reachability, task ordering, post-sign/write-ahead cut points, complete route/result lifecycle and per-task regression gates.
- 2026-08-23 — Task 1 completed RED→GREEN: exact 26-screen/five-script skeleton, four honest unavailable route shells, frozen two-constructor transfer facade, canonical route/F11 26-screen bounds, isolated route/resource/security mutations and fail-before-launch AST integrity gate. Final full gate and app/docs double-build determinism passed; independent specification and code-quality reviews returned `APPROVED`. Final hashes: app `9553b2b354189b61c99be967d57ec0822e5d9d85277333ed3268ffd589fde153`, docs `b33545479c1943a97aa4543c3261e25d675764bdfb3fbb53af16131de66ee61b`. F3–F5/F12 behavior and credentialed production integration remain pending.
