# LOOP Wallet Foundation and Privy Review Design

Date: 2026-08-22  
Status: owner-approved direction; independent specification review APPROVED after four passes

## 1. Decisions and outcome

This slice delivers:

- F1 Wallet overview expansion;
- F2 Asset detail;
- F6 Receive;
- F11 one LOOP-owned review surface for wallet-affecting requests;
- a provider adapter whose production implementation is Privy-first and whose HTML implementation is deterministic and offline.

The owner requires Privy to remain the wallet boundary and requires the same integration-first rule across the rest of the product. LOOP owns presentation, orchestration, policy copy, route state, and normalized provider state. LOOP does not own private keys, signing primitives, transaction construction, swap routing, token pricing, indexing, or wallet databases.

F11 is the single LOOP review surface. It is not a wallet, signer, Privy confirmation clone, or transaction builder. It displays a normalized, provider-sourced request and then hands the exact authorized request to Privy or to a connected external wallet. The visible final authorization experience depends on the wallet class and the official SDK path defined below; the product must not claim that a Privy native confirmation UI exists where Privy's Flutter documentation does not promise one.

## 2. Official provider basis

Binding references:

- [Privy Flutter installation](https://docs.privy.io/basics/flutter/installation)
- [Privy Flutter quickstart](https://docs.privy.io/basics/flutter/quickstart)
- [Privy authorization-signature utilities](https://docs.privy.io/controls/authorization-keys/using-owners/sign/utility-functions)
- [Privy wallet actions](https://docs.privy.io/wallets/actions/overview)
- [Privy Transfer API](https://docs.privy.io/api-reference/wallets/transfer)
- [Privy wallet-action status](https://docs.privy.io/wallets/actions/status)
- [Privy wallet balance](https://docs.privy.io/api-reference/wallets/get-balance)
- [Privy wallet transactions](https://docs.privy.io/api-reference/wallets/get-transactions)
- [Privy connected wallets](https://docs.privy.io/wallets/wallets/get-a-wallet/get-connected-wallet)
- [Privy owners and signers](https://docs.privy.io/controls/authorization-keys/owners/types)
- [Privy swap quote](https://docs.privy.io/wallets/actions/swap/get-quote)
- [viem ABI decoding](https://viem.sh/docs/contract/decodeFunctionData)
- [qrcode-generator upstream and MIT license](https://github.com/kazuhikoarase/qrcode-generator)

The documentation establishes these constraints:

1. Flutter has an official Privy SDK for Android and iOS, with EVM and Solana embedded-wallet support.
2. Flutter can request embedded EVM wallet RPC operations and can generate an authorization signature for a Privy API request owned by the authenticated user.
3. Privy Wallet Actions are the preferred abstraction for supported transfers and swaps and return asynchronous action resources.
4. Balance and transaction-history REST calls require app credentials and a Privy wallet ID, so they run through the BFF.
5. Wallet Action status and wallet transaction history are different resources and must remain different contracts.
6. Privy balance `display_values` uses asset-named keys such as `eth`, plus an optional requested currency key such as `usd`. There is no generic `display_values.asset` field.
7. `include_currency` is not supported when a custom `token` address is queried.
8. Connected external wallets are client connector objects, not automatically Privy wallet-ID resources. Watch-only addresses are not Privy wallets.

## 3. Scope and non-goals

### 3.1 In scope

- two new routed fragments: `#asset` and `#receive`;
- F1 upgrades to normalized wallet, balance, partial, stale, empty, unsupported, and watch-only states;
- F2 holdings by chain plus provider transaction history;
- F6 address/network selection, local QR rendering, and copy fallback;
- F11 request decoding for transfer, approval, swap, and Perp-order review extension;
- exact browser-history and modal lifecycle behavior;
- F16 and existing Swap entry-point migration to F11;
- static HTML adapter fixtures with zero network;
- a focused verifier and all prior regressions;
- README reconciliation to A-tier 47 / total 103 and generated-fragment count 22 after implementation.

### 3.2 Explicit non-goals

- F3–F5 send construction, F9–F10 Bridge, F12 transaction result, F13 history page, F17 approvals page, D3 Perp confirmation, or D8 Perp account UI;
- real credentials, real chain requests, real signing, or real Wallet Action polling in the static HTML milestone;
- custom signer, key custody, MPC, recovery, wallet database, transaction builder, swap/bridge router, RPC/indexer, fiat price service, QR web service, or background action runner;
- custom QR encoding algorithm; use a pinned mature encoder bundled locally when implementation begins;
- claiming production support for a wallet/action combination marked `provider_gap`;
- disabling or bypassing any Privy authentication, authorization-signature, policy, MFA, or connected-wallet confirmation step.

## 4. Source architecture

Implementation later adds these source-owned units:

```text
src/
  screens/
    asset.html
    receive.html
  vendor/
    qrcode-generator-1.4.4.js
    qrcode-generator.LICENSE.txt
    vendor-lock.json
  scripts-order.txt
  wallet-provider.js
  wallet-review.js
  app.js
  style.css
_tmp/
  verify_wallet_foundation.py
```

`app.html` remains generated only by `python3 build.py`.

Responsibility split:

- `wallet-provider.js`: raw Privy DTO documentation, frozen normalized DTO schemas, simulator fixtures, wallet capability resolution, no DOM.
- `wallet-review.js`: F11 local review controller, session map, transitions, formatting of normalized fields, provider handoff invocation.
- `app.js`: routes, parameters, DOM rendering, event wiring, local copy and QR fallback.
- `scripts-order.txt`: the only JavaScript concatenation manifest. The original wallet slice used `vendor/qrcode-generator-1.4.4.js`, `wallet-provider.js`, `wallet-review.js`, `app.js`; the current integrated manifest is exactly `vendor/qrcode-generator-1.4.4.js`, `wallet-provider.js`, `wallet-review.js`, `wallet-transfer.js`, `stream-chat-provider.js`, `app.js`.
- `vendor-lock.json`: exact dependency name/version, upstream source URL, MIT license identifier, and SHA-256 of the vendored bytes; the adjacent license file preserves the upstream notice.
- HTML fragments: semantic structure only.
- CSS: visual, responsive, focus, inert, loading, error, and reduced-motion states.

Production Flutter and BFF implementations are follow-on deliverables. The static HTML may implement only `SimulatedPrivyWalletAdapter`; naming, status copy, and tests must make that explicit.

`build.py` must read and validate `scripts-order.txt`, reject duplicates/missing files/unlisted JavaScript under `src/` (excluding only the exact top-level `src/test-fixtures/` boundary), verify the vendored checksum from `vendor-lock.json`, and concatenate each production file once inside the single existing inline `<script>` in manifest order. The Stream offline fixture stays under that test-only directory and is forbidden from `app.html`. No dynamic script or CDN is introduced. The pinned QR dependency is `qrcode-generator` 1.4.4, MIT-licensed from its upstream repository; implementation must record the exact vendored-file digest rather than trusting the version label.

## 5. Wallet-class capability matrix

`WalletClass` is exactly `privy_embedded | connected_external | watch_only`.

| Capability | Privy embedded wallet | Connected external wallet | Watch-only address |
|---|---|---|---|
| Identity/address | Privy Flutter `PrivyUser.embedded*Wallets` | Privy-supported external connector when available on the selected production platform | locally imported public address only |
| Privy wallet ID | required and available for wallet REST/Actions | not assumed; address/connector is not treated as a Privy wallet ID | unavailable |
| F1 balance | BFF → Privy `GET /wallets/{wallet_id}/balance` | `provider_gap` until a separately approved official balance integration exists | `provider_gap` until a separately approved read-only provider exists |
| F2 history | BFF → Privy `GET /wallets/{wallet_id}/transactions` | `provider_gap` | `provider_gap` |
| F6 receive | supported with Privy wallet address | supported with connected address | supported with imported public address |
| Transfer/swap | Privy Wallet Action through BFF with user authorization signature | not routed through Privy Wallet Actions unless official support is proven; otherwise `provider_gap` | unsupported |
| DApp request | Privy Flutter embedded EVM provider for documented RPC; production spike required per request method | connected wallet provider; its own confirmation UI owns final consent | unsupported |
| Perp authorization | review shape only in this slice; Hyperliquid/Privy signing capability remains a separate Go/No-Go | review shape only; execution provider gap | unsupported |

Provider gaps are normal states, not errors to hide. F1 and F2 keep navigation usable and show `Balance provider not available for this wallet` or `Transaction history is not available for this wallet`. Receive remains available. Signing actions are disabled for watch-only.

No RPC, indexer, or price-provider fallback may be introduced as an implementation convenience. A future provider must receive the same capability audit and owner approval required by the global integration-first decision.

## 6. Production action binding matrix

This matrix is binding. It separates who constructs a request, who possesses credentials, who authorizes it, where final confirmation occurs, and what returns.

| Review kind / wallet class | Provider path | Caller | Credential location | Authorization and final confirmation owner | Normalized return |
|---|---|---|---|---|---|
| `transfer` / embedded | Privy Wallet Action `transfer` | BFF after Flutter authorization | app ID/secret only in BFF; authenticated user key remains inside Privy Flutter | F11 shows the request; Flutter generates Privy authorization signature over the BFF-formatted exact request; Privy TEE validates it. Do not invent an additional Privy UI claim. | `handoff_pending` with Privy action ID; later `pending/succeeded/rejected/failed` |
| `swap` / embedded | Privy Wallet Action `swap` | BFF after Flutter authorization | same as above | same as above; quote fields shown only if returned by the official Privy path | same Wallet Action lifecycle |
| `approve` / embedded | documented Privy Flutter EVM provider RPC only after a production method spike, wrapped in a one-time DApp envelope | Flutter | Privy client session/user key; no app secret in Flutter | canonical decoder derives F11 from exact calldata; it re-decodes before the Privy provider call. Any SDK authentication/MFA remains enabled. | provider/RPC transaction hash or typed provider error, not a fabricated Wallet Action |
| `transfer` or `approve` / external | Privy-supported external connector/provider plus one-time local request envelope | Flutter client | external wallet session only | canonical decoder derives F11 from the immutable connector request; it re-decodes before the external wallet owns final approval/rejection UI | provider transaction hash or rejection/error |
| `swap` / external | none approved | none | none | `provider_gap`; do not fall back to a custom router | `unsupported` |
| any signing kind / watch-only | none | none | none | disabled before F11 | `unsupported` |
| `perp_order` / embedded or external | no execution in this slice | none | none | F11 may decode the normalized request, but primary handoff remains disabled with capability copy until the Hyperliquid + Privy spike passes | `unsupported` with `PERP_EXECUTION_PENDING` |

### 6.1 Required production Go/No-Go spike

Before real Flutter handoff work, a testnet spike must prove, using the installed Privy Flutter SDK version and official API:

- EVM and Solana embedded-wallet creation and stable wallet ID retrieval;
- Flutter authorization signing for the exact Wallet Action request returned/formatted by the BFF;
- BFF verification/forwarding with no app secret or authorization private material in Flutter;
- transfer and swap Wallet Action return/status parsing;
- the exact EVM RPC methods needed for DApp approvals and typed-data signing;
- whether the selected external-wallet connector path is supported on Flutter and how its rejection/result is returned;
- Hyperliquid chain/domain typed-data compatibility separately, before any Perp execution claim.

Go means the path is supported by current official SDK/API, works on Android and iOS testnet builds, and preserves the provider-owned authorization step. No-Go means the affected matrix cell remains `provider_gap` and an owner decision is required. No-Go never authorizes a custom signer.

### 6.2 Canonical request decoder and binding envelopes

One exact `decodeReviewSource(CanonicalReviewSource)` implementation is the only way to create a `LoopReviewIntent`. UI code, F16, and callers cannot construct, patch, or rewrite the review model.

`CanonicalReviewSource` is the immutable, digest-bound union of execution bytes/JSON and all trusted context needed to reproduce the review without outside state:

```js
{
  kind: 'transfer' | 'swap' | 'approve' | 'perp_order',
  execution: { provider_path, wallet_id, payload, execution_digest },
  context: {
    wallet_class,
    provenance,
    token_metadata: [{ asset_id, address, decimals, symbol }],
    dapp: { origin, allowlisted_label } | null,
    quote: { response, received_at_ms, freshness_deadline_ms } | null,
    labels: { spender, provider, environment }
  },
  source_digest,
  expires_at_ms
}
```

The entire source is exact-key validated and frozen before hashing. Token metadata comes from the named Privy asset registry/response or an approved allowlisted token registry; DApp origin comes from the immutable connector request; human labels are allowlisted metadata paired with their full address/provider ID and never replace it. The decoder allowlists endpoint/method, chain, wallet, token, spender/destination, provider-native amount semantics, quote identity/material terms, and the ERC-20 `approve(address,uint256)` ABI; it rejects all unknown or malformed shapes.

The production BFF creates a one-time `PrivyAuthorizationEnvelope`; Flutter never constructs or edits a wallet action request:

```js
{
  review_id: 'opaque-server-id',
  review_model: LoopReviewIntent,
  review_source: CanonicalReviewSource,
  source_digest: 'sha256:…',
  execution_digest: 'sha256:…',
  expires_at_ms: 0
}
```

The BFF owns an in-memory/ephemeral one-time record mapping `review_id` to the immutable `CanonicalReviewSource`, expiry, user, wallet ID, and `review_model` produced by the canonical decoder. F11 renders only that derived model. Immediately before authorization and again immediately before forwarding, the same decoder re-derives a model from the stored source and performs an exact deep comparison against the frozen reviewed model. Separately, an execution-critical projection checks endpoint, wallet, chain, token, destination/spender, provider-native amount field/string, amount type, calldata/value, and execution digest against the exact provider payload. Any mismatch consumes and rejects the envelope. On Continue, Flutter passes the unchanged official `WalletApiPayload` to Privy's `generateAuthorizationSignature`, then returns only `review_id`, source/execution digests, and the resulting signature. The BFF rejects mismatched, expired, consumed, wrong-user, wrong-wallet, wrong-endpoint, altered, or semantically divergent envelopes and forwards only its stored request. It never accepts a caller-supplied arbitrary Privy URL/body at handoff. The review ID is consumed before the first forward attempt, with provider idempotency handling retries. A refreshed quote always creates a new source, source digest, envelope, and review ID.

Embedded/external DApp RPC requests use an equivalent one-time `DappRequestEnvelope` held in a closure-owned client map. Its `CanonicalReviewSource` includes immutable `{to,data,value,chainId}` plus trusted token metadata, connector origin, allowlisted DApp/spender labels paired with full addresses, wallet class, expiry, and both digests. It is re-decoded and deep-compared immediately before the exact request is sent to the Privy embedded provider or external wallet. The client does not accept caller mutations after review opens.

For ERC-20 approvals, the production BFF uses pinned `viem` `decodeFunctionData`/`encodeFunctionData` with the minimal standard ERC-20 ABI; LOOP does not implement ABI encoding. Choosing a limited amount in F16 consumes the original envelope, asks the BFF to encode a new `approve(spender, limitedAmount)` request, stores it under a new review ID, decodes it again, and opens a new F11 model derived from that replacement. If the utility, ABI match, chain, token, or replacement construction is unavailable, limited rewriting is `provider_gap` and cannot Continue; the original unlimited calldata is never submitted under a limited review. HTML uses immutable semantic fixtures only and must include a deliberately mismatched unlimited-calldata/limited-display fixture that fails closed.

The HTML simulator models only immutable request fixtures, the opaque review ID, canonical derived model, and expected digest equality; it contains no real payload or signature. These envelopes are orchestration around official Privy/provider APIs and mature ABI utilities, not a parallel signing format.

## 7. Adapter contract and data ownership

### 7.1 Result and provenance unions

All adapter returns are deeply frozen discriminated unions:

```js
// success
{ ok: true, value, meta: {
  source: 'privy_balance' | 'privy_transactions' | 'privy_wallet_action' |
          'privy_flutter' | 'external_wallet' | 'prototype_fixture',
  fetched_at_ms: 0,
  stale: false,
  partial: false
} }

// failure
{ ok: false, error: {
  code: 'UNAUTHENTICATED' | 'UNSUPPORTED_WALLET' | 'PROVIDER_GAP' |
        'MALFORMED_PROVIDER_RESPONSE' | 'PROVIDER_UNAVAILABLE' |
        'USER_REJECTED' | 'POLICY_REJECTED' | 'ACTION_FAILED' |
        'PERP_EXECUTION_PENDING',
  retryable: false,
  safe_message: '…'
} }
```

Unknown provider response fields are ignored during normalization. Unknown LOOP request keys are rejected. This resolves the former contradiction: provider DTOs are forward-compatible inputs; normalized LOOP models are exact allowlisted outputs.

### 7.2 Raw Privy DTO boundary

Raw provider DTOs are never rendered directly. The normalizer recognizes only documented fields.

Balance input:

```js
{
  balances: [{
    chain: 'base',
    asset: 'eth',
    raw_value: '1000000000000000000',
    raw_value_decimals: 18,
    display_values: { eth: '1', usd: '2560.00' }
  }]
}
```

For a custom token, `asset` may not be a named asset and `include_currency` is unavailable; the request uses the official `token=chain:address` form. The normalizer accepts the raw amount/decimals but sets fiat value to `null` unless a separately approved provider supplies it.

Transaction input keeps documented provider vocabulary, including `status`, `details.type`, `raw_value`, `raw_value_decimals`, asset-named `display_values`, and `next_cursor`. LOOP derives `direction` only from documented `transfer_sent` / `transfer_received` detail types. Unknown transaction types normalize to `other`, not to a guessed transfer.

### 7.3 Normalized LOOP snapshots

```js
WalletSnapshot = {
  wallet_class: 'privy_embedded',
  wallet_ref: 'fixture-wallet-1',
  addresses: [{ chain_type: 'ethereum', address: '0x…' }],
  capabilities: {
    balances: 'supported', history: 'supported', receive: 'supported',
    transfer: 'supported', swap: 'supported', approve: 'spike_required'
  }
}

BalanceSnapshot = {
  status: 'ready' | 'loading' | 'empty' | 'partial',
  items: [{
    asset_id: 'ETH', chain_id: 'base',
    raw_value: '1000000000000000000', decimals: 18,
    amount_display: '1 ETH', fiat_currency: 'USD', fiat_value: '2560.00' | null,
    value_provenance: 'privy_balance' | 'unavailable'
  }],
  loop_total: {
    value: '46812.31' | null,
    currency: 'USD',
    label: 'LOOP total derived from Privy balances',
    excluded_asset_count: 0
  },
  chain_errors: [{ chain_id: 'solana', code: 'PROVIDER_UNAVAILABLE' }]
}

TransactionPage = {
  items: [{
    id: 'fixture-tx-1', direction: 'incoming' | 'outgoing' | 'other',
    provider_status: 'confirmed', chain_id: 'base', asset_id: 'ETH',
    raw_value: '1' | null, decimals: 18 | null,
    amount_display: '0.000000000000000001 ETH' | null,
    counterparty: '0x…' | null, transaction_hash: '0x…' | null,
    created_at_ms: 1746920539240
  }],
  next_cursor: null | 'opaque-fixture-cursor'
}
```

Transaction ID precedence is exact: non-empty `privy_transaction_id`, else non-empty `transaction_hash`. A record with neither is not assigned a synthetic identity; it is omitted and the page becomes `partial` with `MISSING_TRANSACTION_ID`. Missing transfer details, counterparty, amount, or hash remain `null` and do not invalidate an otherwise identified record. Pending/no-detail UI says `Transaction details pending`; unknown/non-transfer activity says `Wallet activity`; a missing counterparty says `Counterparty unavailable`; a missing hash has no explorer affordance. Provider status remains verbatim accessible text.

`loop_total` is an explicitly approved presentation aggregation, not a provider balance. It adds only Privy-supplied currency strings with fixed-point decimal arithmetic, never floating point and never a local price oracle. If any item has no Privy USD value, the subtotal excludes it and the UI states, for example, `Excludes 1 asset without a provider USD value`. If no item has provider currency data, total is unavailable.

GLYPH therefore shows its provider quantity and `Value unavailable`; it never shows a fabricated `$499.99` value. Only the separately labelled `Simulated provider succeeded` demo fixture may add GLYPH quantity, and it cannot change the USD subtotal by a locally invented price.

### 7.4 Adapter methods

```js
getWalletSnapshot()
getBalanceSnapshot({asset_id?, chain_id?})
getTransactionHistorySnapshot({asset_id, chain_id, cursor?})
getWalletActionSnapshot({action_id})
getReceiveTarget({asset_id, chain_id})
getReviewPreview({review_id})
handoffReview({review_id})
```

`getTransactionHistorySnapshot` and `getWalletActionSnapshot` are intentionally separate. Only the former powers F2. Only the latter powers post-handoff action state and later F12.

`handoffReview` does not own Cancel, Escape, or browser navigation. Those are local controller actions.

### 7.5 Simulator scenario ownership

The simulator is deterministic but not ambiguously stateless. A closure-owned `WalletScenarioStore` owns only an allowlisted non-sensitive scenario ID:

`normal | empty | loading | partial | provider_succeeded_demo | external_gap | watch_only`

It has no `localStorage`, `sessionStorage`, cookies, network, timers, action polling, wallet data, or history payload. Continue, pending, Cancel, rejection, and failure never mutate balances or select `provider_succeeded_demo`. That completed-state fixture is reachable only from a separate owner/test-only control labelled `Show completed provider fixture`; activating it emits a visibly labelled `Simulated provider succeeded` event before refreshing balances. Reload resets to default. Every returned object is a fresh deeply frozen snapshot.

## 8. Route contract

New routes:

```text
#asset?asset=ETH&chain=ethereum
#receive?asset=ETH&chain=ethereum
```

All parameters are strictly parsed, case-normalized, and allowlisted:

- asset: `ETH | SOL | USDC | GLYPH`;
- chain: `ethereum | base | arbitrum | solana`;
- receive chain must be compatible with the chosen asset fixture.

Canonicalization is exact:

- raw hash length is capped at 256 code units and each decoded value at 32 code points;
- malformed percent escapes, decoded/raw C0 controls or DEL, overlong input, empty recognized values, and any duplicate key reject the entire parameter set to the route's default fixture;
- unknown keys are stripped; unknown or incompatible allowlisted-key values fall back to the route's default fixture;
- canonical key order is always `asset`, then `chain`; asset is uppercase and chain lowercase;
- sanitization uses `history.replaceState` with the current validated navigation projection and never adds a history entry.

Direct deep links use Wallet as declared ancestry; in-app navigation preserves the real branch stack. Account routes accept no new parameters. Tests cover duplicate known/unknown keys, `%`/`%0`/invalid UTF-8 escapes, encoded and literal controls, 256/257 boundaries, 32/33-value boundaries, mixed casing, incompatible pairs, unknown keys, and canonical ordering.

F11 is not a hash route. It uses a bounded in-memory review session plus opaque history state as specified in section 13.

## 9. F1 Wallet overview

F1 renders only normalized snapshots.

- Header: `Wallet`, active wallet-class badge, shortened receive address.
- Total: `LOOP total derived from Privy balances` plus excluded-value disclosure when needed.
- Chain chips filter locally within the provider snapshot; they never trigger hidden RPC.
- Asset rows are accessible routed buttons and preserve `asset` and compatible `chain` parameters.
- Actions: Send, Receive, Swap, Bridge. Receive is active when an address exists. In this slice Send navigates to the selected/default F2 asset detail and never opens a form. Bridge is disabled with `Bridge provider integration is planned for the next slice.` Swap retains its existing simulated entry but must pass through F11. All actions still reflect wallet-class capability gaps.
- Approval and DApp sections remain, but F16 controls use `Review …` wording.

States:

- loading: labelled skeletons and no fake zero;
- empty: `No supported assets reported by Privy`;
- partial: unaffected chains remain usable with a chain-specific warning;
- stale: last provider values stay visible with timestamp and retry;
- provider gap: wallet/address and Receive remain; unavailable capability is named;
- watch-only: persistent `Watch-only — no signing actions are available`.

## 10. F2 Asset detail

F2 includes:

- asset symbol and provider-supported chain selector;
- provider quantity, provider fiat value or `Value unavailable`, and provenance copy;
- per-chain holdings from `BalanceSnapshot`;
- incoming/outgoing transaction history from `TransactionPage`;
- Receive plus one exact embedded-wallet demo control labelled `Review simulated transfer`; it opens the immutable canonical transfer fixture only. Connected external and watch-only states disable it with provider-gap/watch-only copy. It is not a send form or live request;
- no chart, price oracle, P&L, or Wallet Action lifecycle masquerading as history.

History states: loading, incoming/outgoing populated, empty, partial, malformed provider response, unsupported wallet, and cursor pagination. A cursor is opaque; the client never parses or edits it. Duplicate IDs are de-duplicated by exact provider transaction ID/hash and do not reorder existing rows.

## 11. F6 Receive

F6 renders only `getReceiveTarget` output:

- asset and compatible network selectors;
- full public address in selectable text;
- locally rendered deterministic QR from the same validated address string using a pinned mature QR encoder bundled with the prototype;
- `Copy address` with clipboard success or manual-select fallback;
- exact warning: `Only send ETH on Ethereum to this address. Using another asset or network may result in permanent loss.` with names substituted from normalized data;
- persistent watch-only/provider class label.

No remote QR service, custom QR algorithm, network request, private material, or seed phrase is allowed. In the test DOM the QR canvas/SVG has an accessible text alternative containing the exact address and network.

## 12. Unified `LoopReviewIntent`

The earlier `PrivyIntent` name is removed because Privy has a separate official Intents product. `LoopReviewIntent` is a frozen, exact-key, versioned display and handoff model. It is not calldata or a transaction model.

Common fields:

```js
{
  version: 1,
  id: 'review-swap-1',
  kind: 'transfer' | 'approve' | 'swap' | 'perp_order',
  wallet_class: 'privy_embedded' | 'connected_external',
  wallet_ref: 'fixture-wallet-1',
  chain_id: 'ethereum',
  provenance: 'privy_transfer_request' | 'privy_swap_quote' |
              'dapp_request' | 'hyperliquid_order_fixture' | 'prototype_fixture',
  provider_preview: 'available' | 'unavailable' | 'stale',
  expires_at_ms: 0,
  fields: { /* exact discriminated fields */ }
}
```

Kind-specific fields:

- transfer: provider `amount_type`, the exact effective provider decimal amount string, asset/verified decimals, fixed-point-derived base units for comparison/display only, source/destination chain/asset/address, and fee display only if provider supplied;
- approve: token, spender label/address, integer limit or unlimited sentinel, DApp origin;
- swap: spend asset/base units, receive asset, provider quote/minimum only when supplied, slippage/fee only when supplied;
- perp_order: provider `hyperliquid`, testnet/mainnet environment, market, side, order type, size string, leverage string, reduce-only flag, and provider capability `pending_spike` in this slice.

If an eligible transfer or approval request provides no optional preview, F11 displays `Action preview unavailable` and does not invent fees or simulation results. A swap is never eligible for this fallback: it requires a fresh Privy quote with output, fee/material terms, exact input/chain/token match, and a quote freshness deadline. All amounts are formatted from integer units or canonical provider decimal strings without floating point.

Privy Transfer and Swap keep different provider-native amount contracts. For Transfer, the canonical decoder chooses top-level `amount` when present; otherwise it uses `source.amount`, matching Privy's documented precedence. It accepts only a positive canonical decimal string matching `^(0|[1-9][0-9]*)(\.[0-9]+)?$`, length at most 100, with no sign, whitespace, separator, exponent, leading-zero variant, trailing dot, or precision beyond the verified token decimals. Both fields, if present, remain unchanged in the signed payload; the non-effective `source.amount` cannot affect review semantics. `amount_type` must be `exact_input` or `exact_output`, and copy states whether the amount is sent or received. Fixed-point conversion may derive base units for equality/formatting but must round-trip exactly to the effective decimal and must never replace the provider string. Swap continues to use the documented base-unit integer input. Tests cover top-level precedence, exact-input/output, decimal/base-unit round-trip, maximum length/precision boundaries, conflicting dual fields, zero/negative/scientific/overprecision rejection, and unchanged signed strings.

If Privy supplies an expiry, the deadline is the earlier of that expiry and LOOP's 30-second review freshness ceiling; otherwise the ceiling is 30 seconds from quote receipt. At Continue, the BFF obtains/validates a fresh quote for the exact stored input. If output, tokens, amount, chain, fee/material terms, route availability, or freshness differs from the reviewed model, the old envelope is consumed and no action executes; a new review ID/model must be shown. No-liquidity, unavailable, and stale quotes are `blocked`.

Exact summary fixtures:

- transfer: `You are preparing to ask Privy to send 0.01 ETH on Ethereum to 0x71C7…F0A2.`
- limited approval: `You are reviewing a request for Swap.zone to spend up to 1,000 USDC on Ethereum.`
- unlimited approval: `You are reviewing a request for Swap.zone to spend unlimited USDC on Ethereum.`
- swap: `You are preparing to ask Privy to swap 500 USDC for approximately 216,450 GLYPH on Ethereum (minimum 215,367.75 GLYPH).`
- Perp extension: `You are reviewing a Hyperliquid testnet market order to buy 0.01 ETH with 3× leverage.`

The Perp extension proves the product-wide review model can decode the domain, but this slice does not claim Perp execution is complete. Its primary action is disabled with `Privy + Hyperliquid execution requires the production capability spike.`

## 13. F11 state machine, history, and handoff

States:

`closed → decoding → ready | preview_unavailable | stale | blocked | decode_failed`

For supported embedded transfer/swap:

`ready → returning_to_origin → handoff_pending → provider_pending | provider_rejected | provider_failed`

The HTML simulator stops at a non-modal origin-route banner: `Simulated Privy handoff pending`. F12 is out of scope, so no success/result screen is fabricated.

For approval requests, the production return may be a provider transaction hash rather than a Wallet Action. For Perp and unsupported wallet combinations the state is `blocked`, not `ready`.

Primary action labels are exact:

- supported embedded request: `Continue with Privy`;
- supported connected-wallet request: `Continue to external wallet`;
- blocked request: no handoff button; show the provider-gap reason.

`preview_unavailable` may proceed only for an eligible transfer/approval when its request fields are complete, exact, canonical-decoder-derived, and provider-sourced; it requires an unchecked acknowledgement beside `Action preview unavailable`. A swap with unavailable/stale/mismatched/no-route quote is always `blocked`, has no Continue button, and offers `Refresh quote`. Refresh consumes the old review ID and opens a newly decoded envelope. Missing request identity, amount, destination/spender, chain, or provenance is `decode_failed` and cannot proceed. F11 is the only LOOP confirmation modal. Privy authentication/MFA or an external wallet's own approval UI may still appear because those provider-owned controls are not duplicate LOOP review layers and may not be bypassed.

### 13.1 Review-session storage

- `reviewSessionMap` is in-memory only, maximum five entries, five-minute TTL.
- A review history entry contains the existing sanitized navigation projection `{stack, voice}` plus `{loop_review:1, review_id}`. It contains no request fields. Account-only proof/panel fields are neither invented nor copied onto Wallet/Swap/DApp review entries.
- No amount, address, quote, request body, authorization payload/signature, provider object, callback, action ID, or user data enters URL, history, or storage.
- Session IDs are exact allowlisted fixture IDs in HTML and unpredictable server-issued opaque IDs in production.
- A mismatched, forged, expired, over-cap, consumed, or absent session fails closed.

### 13.2 Transition table

| Event | Session effect | History/route effect | Provider effect |
|---|---|---|---|
| Open F11 | create unconsumed session | `pushState({...validatedNavigationProjection, loop_review:1, review_id})` on the same canonical URL | none |
| Browser Back | retain unconsumed session until TTL | overlay closes; underlying route becomes active | none |
| Browser Forward after Back | reuse only the same live unconsumed and unexpired session | overlay reopens; an expired swap becomes blocked/Refresh; otherwise sanitize the stale entry and remain closed | none |
| Cancel button | consume/delete session | navigate back to origin; stale forward entry cannot reopen | none |
| Escape | same as Cancel | same as Cancel; focus restores to origin trigger | none |
| Shared veil click while F11 owns overlay | retain session unchanged | no-op; dialog/history remain open and focus is returned inside F11 | none |
| Provider/user Reject shown inside F11 | consume/delete session | return to origin with non-modal rejection notice | none beyond the already received rejection |
| Continue | atomically mark `handoff_pending`; no second Continue accepted | call `history.back()`; only after `popstate` has closed/inerted F11 and restored the exact origin route, delete review payload and invoke handoff in a microtask | one adapter handoff only |
| Continue with no valid prior entry | mark `handoff_pending` | `replaceState` with sanitized origin route, close F11, then invoke handoff | one adapter handoff only |
| Route/tab change while open | consume/delete | close review, complete requested navigation | none |
| Reload | in-memory map is lost | review state is sanitized; underlying route loads closed | none |
| BFCache restore | preserve a live unconsumed session; consumed IDs stay invalid | reopen only if entry/session pair is still valid | none |

`handoff_pending` is a compare-and-set transition. Repeated taps, key repeats, duplicate `popstate`, and Forward cannot produce a second provider call.

The account-history proof map remains untouched; F11 uses its separate bounded controller.

Router coordination is binding:

- `syncHash` builds the existing `{stack,voice}` projection. It never preserves review markers during ordinary navigation; a route/tab change first consumes/closes F11.
- the review controller may call `pushState` only with a projection that passes the same `isValidStack`/voice sanitization used by the router;
- `popstate` first validates and restores `stack`/voice, then asks the review controller to reopen only a valid entry/session pair; invalid review markers are removed with `replaceState` while retaining the validated navigation projection;
- `route()` consumes/closes any review before parsing a new hash;
- `persist()` and `restore()` continue to store only `stack`/voice and never review markers or sessions;
- neither controller calls `navigate()` merely to open/close F11, so `syncHash` cannot overwrite the overlay entry;
- tests exercise Back/Forward with valid and invalid navigation projections, route/hash edits while open, account-state noninterference, and stale marker sanitization.
- the shared veil handler checks the overlay owner first. When F11 is open it prevents/stops the veil event and asks the review controller to restore focus inside the dialog; it must not call legacy `closeSheets()`. When F11 is closed, existing legacy-sheet veil behavior remains unchanged.

## 14. F16 and Swap integration

F16 remains the allowance-choice intercept and F11 remains the explanation/handoff layer.

- `Approve 1,000` becomes `Review 1,000 limit`.
- `Allow unlimited` becomes `Review unlimited request`.
- Persistent text: `No token approval has occurred. Your choice will be reviewed before any wallet request.`
- F16 never creates or rewrites a review model. It selects either the original decoded unlimited request or asks the approved mature ABI utility path for a replacement limited request; F11 opens only from the canonical decoder output of the selected immutable envelope.
- F11 states the chosen limit, spender, origin, network, and provider preview availability.
- Only after Continue may the Privy embedded provider or connected external wallet receive the request.

Swap no longer jumps directly to success. It requires a fresh provider-backed/simulated Privy quote, opens F11, returns to the Swap origin before handoff, then shows the simulated pending banner. Pending, cancel, reject, failure, and quote refresh never change Wallet holdings. GLYPH quantity can appear only after the separate visibly labelled `Simulated provider succeeded` demo event described in section 7.5.

## 15. Accessibility and responsive behavior

- F11 uses `role="dialog"`, `aria-modal="true"`, accessible title/description, focus trap, inert background, Escape, explicit Cancel, and trigger focus restoration.
- The veil never confirms, cancels, closes, consumes, or hands off F11; it is the no-op transition in section 13.2.
- Asset rows and pagination controls are semantic buttons/links with visible focus.
- Loading uses status text; errors use live regions only when newly raised.
- At 375×667, primary/secondary F11 actions remain visible without obscuring decoded fields; long addresses wrap or middle-ellipsize while their accessible label preserves the full value.
- Reduced motion removes nonessential transitions and does not change state timing.

## 16. Security and non-duplication gates

- HTML: zero `fetch`, XHR, WebSocket, EventSource, dynamic script, remote QR, clipboard read, signing API, wallet SDK, key/seed/private-key field, and secret-like fixture.
- Production: Privy app secret and server authorization private key remain BFF-only. Flutter receives only public app/client identifiers, authenticated user session, BFF-formatted request material, and the resulting provider response.
- Every displayed field uses safe text insertion; no caller HTML reaches the DOM.
- Every adapter result and `LoopReviewIntent` is exact-key validated and deeply frozen.
- Request-preview provenance is shown at field level; unavailable provider fields remain unavailable.
- No floating-point value arithmetic.
- No custom signer, wallet, key export, action status vocabulary, balance/indexing service, price oracle, swap/bridge router, or confirmation bypass.
- No custom QR encoder; the selected mature dependency is pinned, locally bundled, license-recorded, and security-scanned before use.
- No `showWalletUIs:false` or equivalent bypass is permitted on platforms where Privy exposes such a control. The Flutter flow follows its official authorization APIs rather than pretending that React-only UI controls apply.
- Review copy never says an action is approved, signed, submitted, or complete before the provider reports that state.

## 17. Error contract

Required user-visible mappings:

- balance loading/empty/partial/stale/malformed;
- transaction history incoming/outgoing/empty/paginated/malformed/unsupported;
- connected external or watch-only provider gap;
- incompatible receive asset/network;
- clipboard unavailable;
- review expired/unknown/malformed/preview unavailable;
- user rejection, provider policy rejection, provider unavailable, action failed;
- Perp execution pending spike;
- stale/replayed/consumed review history sanitized.

Retry never changes wallet class or switches providers. `failed` must not be relabeled `rejected`: Privy documents that failed Wallet Actions may have onchain effects, so the UI directs the later F12 flow to inspect status/steps rather than blindly retry.

## 18. Focused verification

`_tmp/verify_wallet_foundation.py` must fail before implementation and pass afterward.

### 18.1 Build and docs

- source order contains `asset` and `receive` exactly once;
- script manifest contains the pinned QR library, provider, review controller, and app exactly once in the specified order; duplicates, missing/unlisted JS, license/checksum mismatch, and dynamic scripts fail;
- built HTML contains 22 routed fragments and is byte-identical across two builds;
- README says A-tier 47, total 103, generated 22;
- `app.html` has no hand edits;
- design/task docs state Privy-owned boundaries and offline HTML simulation.

### 18.2 Adapter schemas

- raw balance normalization proves asset-named `display_values` and ignores unknown provider keys;
- GLYPH/custom token has quantity and `fiat_value:null`;
- fixed-point total includes only Privy-supplied USD strings and exposes excluded count;
- success/error unions, provenance, loading, partial, stale, and malformed states are exact;
- simulator scenario state is deterministic, closure-owned, frozen, and reload-safe;
- `getTransactionHistorySnapshot` and `getWalletActionSnapshot` cannot be interchanged.
- envelope tests reject altered digest/body/endpoint, expired/consumed/wrong-user/wrong-wallet reuse, and duplicate handoff; the client never constructs a Privy request.
- canonical-decoder tests re-derive/deep-compare transfer/swap/approval models before authorization and handoff; limited-display/unlimited-calldata, amount/spender/chain/token/quote mismatches fail closed.
- `CanonicalReviewSource` tests prove every rendered quote/token/origin/label/expiry/provenance field is stored and digest-bound; a fresh quote creates a new source/envelope; execution-critical projection matches the exact provider payload.
- Transfer tests cover top-level `amount` precedence, provider-string preservation, exact-input/output copy, decimal/base-unit round-trip, and length/precision/grammar rejection without conflating Swap base units.

### 18.3 Wallet classes

- embedded supports the specified Privy-backed fixtures;
- connected external renders provider gaps and external-confirmation copy, never a fake Privy wallet ID;
- watch-only supports Receive and blocks all signing origins while keeping Wallet/Asset navigation usable;
- no hidden RPC/indexer/price fallback exists.

### 18.4 F1, F2, F6

- deep-link sanitization and ancestry for valid/unknown/incompatible, duplicate-key, malformed-percent/UTF-8, control-character, length-boundary, casing, and canonical-key-order cases; sanitization replaces rather than pushes;
- F1 normal/loading/empty/partial/stale/provider-gap/watch-only;
- F1 Send routes only to F2, Bridge remains disabled with exact scope copy, and no send/bridge form or live claim appears;
- F2 incoming, outgoing, other, pending/no-detail, nullable hash/counterparty, missing-both-ID partial, empty, pagination, duplicate, malformed, and unsupported history;
- F6 exact address/network warning, local QR equivalence, copy success/fallback, and no private material.

### 18.5 F11 kinds and exact copy

- transfer, limited approval, unlimited approval, swap with exact estimated/minimum output, and `perp_order` summaries match section 12 exactly and derive only from the bound source;
- field-level provenance and `Action preview unavailable` behavior;
- swap unavailable/stale/no-liquidity/mismatched/expired quotes are blocked; exact freshness boundary, Refresh-generated review ID, Back/Forward after expiry, and quote/request revalidation pass;
- Perp handoff disabled with `PERP_EXECUTION_PENDING`;
- provider error vocabulary preserved;
- F16 buttons say `Review`, persistent no-approval copy remains visible;
- Swap stops at simulated handoff pending and does not fabricate F12 success.
- pending/cancel/reject/failure/refresh never mutate holdings; only the separately labelled provider-succeeded demo fixture can add GLYPH.

### 18.6 History and accessibility

- every transition in section 13.2, including Back/Forward, Cancel, Escape, rejection, route/tab change, reload, BFCache, and missing-origin fallback;
- F11 veil click is a no-op with unchanged session/history and restored internal focus; legacy veil behavior remains unchanged when F11 is closed;
- Continue is exactly-once and F11 is closed before adapter invocation;
- review entries preserve validated `{stack,voice}` plus opaque markers; `syncHash`, `popstate`, `route`, `persist`, and `restore` coordination neither overwrites review state nor persists payload/session data;
- no request payload in URL/history/storage;
- forged, expired, consumed, mismatched, and over-cap sessions fail closed;
- focus trap/restore, inert background, veil non-confirmation, keyboard-only use, 375×667, reduced motion.

### 18.7 Regression/security

- existing account, owner-approved copy, watch-only, Chat→Swap→pending-with-unchanged-Wallet, F16, voice, route, docs, syntax, mobile, and security suites remain green;
- scan for `TODO`, `FIXME`, old 48/105 README claims, `PrivyIntent`, legacy F16 approval labels, prohibited AI-risk wording, custom-wallet claims, secrets, network primitives, and confirmation bypasses.

## 19. Completion gates

This design is ready for implementation planning only after:

1. independent specification review reports no remaining critical/high/medium issue — **PASS 2026-08-22**;
2. the owner reviews this written revision;
3. a TDD implementation plan is written and independently reviewed;
4. the user-selected subagent-driven workflow executes each plan task with a fresh implementer, spec review, and code-quality review;
5. all focused and full regressions pass.

This slice completes the HTML wallet foundation and versioned review contract only. It does not complete real Privy production integration, F3–F5, F12, external-wallet balance/history, or Perp execution.
