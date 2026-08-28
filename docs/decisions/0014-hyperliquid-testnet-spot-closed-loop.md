# Decision 0014: Hyperliquid Testnet Spot closed loop

- Status: Accepted
- Date: 2026-08-26

## Context

LOOP needs one truthful mobile Spot path from a reviewed quote to an
authoritative result. The retained Hyperliquid implementation is Perp-specific,
defaults mutations off, and cannot be renamed or imported as the authority for
Spot. Hyperliquid also distinguishes token index, token ID, Spot-pair index,
and Exchange order asset; ticker-only mapping would be unsafe.

The first product slice is deliberately narrow: Development plus Hyperliquid
Testnet, one user-confirmed buy or sell, one capped aggressive limit order with
`Ioc`, and read-only reconciliation. There is no official TypeScript SDK.
Signing and Exchange writes therefore remain unavailable until an exact Node
implementation passes the committed official-Python conformance vectors and a
credentialed Testnet gate.

Official evidence:

- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets>

## Decision

### Product and route scope

Spot is an independent feature/domain. It may reuse provider-neutral security
and control-plane infrastructure, but it must not import Perp contracts,
repositories, routes, DTOs, action enums, errors, or reconciliation logic.
Existing Perp behavior remains present and dormant.

The approved public surface is exactly:

| Method   | Path                                                          |
| -------- | ------------------------------------------------------------- |
| `GET`    | `/v1/spot/config`                                             |
| `GET`    | `/v1/spot/markets/{market_id}/facts`                          |
| `GET`    | `/v1/spot/balances`                                           |
| `POST`   | `/v1/spot/intents`                                            |
| `GET`    | `/v1/spot/intents/{intent_id}`                                |
| `POST`   | `/v1/spot/intents/{intent_id}/submit`                         |
| `GET`    | `/v1/spot/wallet-binding`                                     |
| `PUT`    | `/v1/spot/wallet-binding`                                     |
| `DELETE` | `/v1/spot/wallet-binding?expected_binding_version={epoch}`    |
| `POST`   | `/v1/spot/agent-authorizations`                               |
| `GET`    | `/v1/spot/agent-authorizations/{authorization_id}`            |
| `POST`   | `/v1/spot/agent-authorizations/{authorization_id}/signatures` |

There is no first-slice `/quotes`, general orders list, fills list, cancel,
modify, resting limit, trigger, TP/SL, TWAP, batch, transfer, withdrawal,
bridge, builder-fee, vault, subaccount, automation, copy-trading, or Mainnet
route. `POST /v1/spot/intents` is the durable quote and F11 review resource.

Every route is no-store, strict-body/strict-query, owner-scoped, authenticated
with a freshly verified Privy Bearer token, and requires an existing LOOP
bootstrap principal. The client never supplies or selects provider URL,
network, account, wallet, Agent, token index, token ID, pair index, Exchange
asset, nonce, CLOID, provider idempotency value, wire action, or order
signature.

### Market and review authority

The server constructs an immutable, network-scoped market registry from one
bounded `spotMeta` or `spotMetaAndAssetCtxs` snapshot. Every supported market
binds all four provider identifiers: base/quote token index and token ID,
Spot-pair index, and Exchange order asset `10000 + pair index`. The public API
uses only a server-issued opaque `market_id`.

Outcome metadata and alternate `#...` or `+...` asset forms are not ordinary
Spot in this slice and are rejected rather than coerced into the four-ID model.

Executable facts use bounded Testnet Info reads. Metadata and `l2Book` create
one exact-decimal quote; `spotClearinghouseState` supplies balances and
`userFees` supplies a current fee when required. Duplicate, missing, delisted,
unknown, inconsistent, stale, or shape-drifted evidence fails closed.

The intent request contains only `market_id`, `side`, an exact positive decimal
amount with mode `quote` or `base`, and an optional server-bounded integer
`max_slippage_bps`. The first slice accepts only the natural exact-input UX:
`buy+quote` (maximum quote spend) and `sell+base` (base size to sell). The other
two pairings require a later contract revision. `spot_intent_request_v1` binds
the request; `spot_review_v1` binds the immutable review. The review includes
the Testnet label, market display identity, side, amount, computed base size,
source price and time, worst IOC price, maximum spend or minimum receive, fee
facts, metadata/policy versions, binding epoch, and expiry. All financial
values stay canonical decimal strings and all arithmetic uses exact
decimal/BigInt logic.

The first Exchange action is exactly one `order` containing exactly one Spot
order wire: derived asset, reviewed side/price/size, `reduceOnly=false`,
`limit.tif=Ioc`, and one unique server-generated lowercase 128-bit CLOID. The
submit path never silently refreshes or changes a reviewed value.

The buy maximum-spend bound applies to every IOC outcome. The sell
minimum-receive value is the bound for a complete fill of the reviewed base
size; any positive partial fill must preserve the same proportional
net-quote-per-base floor, while `not_filled` promises no settlement amount.
Submission revalidates that the current account Spot taker rate does not exceed
the reviewed product ceiling, and reconciliation verifies the applicable bound
with exact cross-multiplication before finalization.

### Wallet and Agent authority

One provider-neutral Hyperliquid master-wallet binding and monotonic epoch is
the source of truth for both retained Perp compatibility and new Spot behavior.
Spot must not create a second independently mutable wallet authority. Bind,
rotate, refresh, and unbind resolve eligible Privy embedded EVM wallets
server-side. The first slice supports the master account only and never returns
the selected address or wallet ID.

Each LOOP owner, Testnet network, and binding epoch has at most one current
Agent identity, while immutable historical generations are retained under
[Decision 0016](0016-spot-agent-generation-lifecycle.md). The preferred
implementation is a Privy-managed server wallet whose private key is never
exported. The owner signs only one server-built,
short-lived Testnet `approveAgent` typed-data handoff. Signature submission
accepts only the opaque signature, verifies the exact stored digest, signer,
Agent, expiry, binding epoch, and unused state, journals at most one relay, and
uses authoritative readback after an ambiguous result. Agent authorization is
protocol-broad, so the LOOP signer interface independently allowlists only the
single Spot IOC order shape approved above.

Hyperliquid encodes Agent expiry inside the signed Agent name rather than in a
separate `approveAgent` field. LOOP therefore requires one canonical
`agentName` suffix, ` valid_until <unix-milliseconds>`, and proves that the
suffix exactly equals the separately displayed and persisted expiry before it
returns a signing payload. Missing, malformed, seconds-based, or mismatched
suffixes fail before nonce allocation is committed. The base name preceding
that suffix is nonempty and at most 16 characters, matching the selected
Hyperliquid client validator. The initial `spot_agent_v1` Testnet policy caps
the Agent lifetime at 24 hours from the database clock; longer or stale
validity is rejected inside the persistence transaction. This follows Privy's
[Hyperliquid Agent expiration guidance](https://docs.privy.io/recipes/hyperliquid/agents-and-subaccounts#setting-agent-expiration)
and the candidate client's
[`approveAgent` validator](https://github.com/nktkas/hyperliquid/blob/main/src/api/exchange/_methods/approveAgent.ts).

The authorization-creation response may contain the one-time server-generated
public `agentAddress`, `agentName`, nonce, domain, and typed-data fields that
Privy must sign. This is not client authority: the client cannot select, edit,
or resubmit those fields. They are excluded from GET/status resources, ordinary
logs, and the signature-submission body.

### Idempotency, nonce, and reconciliation

Intent preparation uses UUID `Idempotency-Key`, scope `spot_intent_prepare`,
provider domain `hyperliquid`, and operation kind `spot_intent`. Exact replay
returns the same resource without another quote; a changed digest conflicts.

Nonce allocation is persistent and atomic per Testnet signer identity. A nonce
is allocated only inside the same durable transaction that changes the intent
to submitting and records its sole transport-attempt UUID. A process-local
clock or SDK nonce manager is not the cross-process authority. Each provider
write has at most one attempt; timeouts, disconnects, ambiguous 429/5xx, or a
post-send crash become `unknown`/`reconciling` and are never blindly replayed.

The reconciliation worker is read/finalize-only. Its registry dispatch key is
the tuple `(domain, operation_kind)`, so `hyperliquid/spot_intent` cannot enter
the Perp handler. It uses the persisted CLOID plus bounded order, fill,
open-order, history, and balance evidence. Unknown OID/status, absence from a
bounded list, conflicting/malformed/truncated evidence, or unsupported status
never fabricates success or non-submission. Generic operation and Spot
projection finalization is one fenced PostgreSQL transaction.

### Default-closed implementation gate

No production Node signer or Hyperliquid Exchange SDK is selected or installed
by this decision. The only current runtime outcome for a write-capable adapter
is unavailable. Enabling the one Spot writer requires all of:

1. exact dependency, integrity, provenance, SBOM, and license review;
2. byte-for-byte MessagePack, action-hash, EIP-712, Testnet-source, address,
   trailing-zero, vault, expiry, CLOID, and signature conformance against the
   pinned official Python SDK oracle;
3. current Privy wallet/Agent and policy evidence;
4. a persistent nonce allocator and one-attempt journal;
5. healthy read-only reconciliation and kill switches; and
6. credentialed Testnet success, rejection, timeout, crash/restart, and
   no-second-write evidence.

Any missing, unknown, stale, malformed, or failed gate denies the mutation
before Privy signing, SDK use, or an Exchange request.

## Consequences

This decision authorizes implementation of the twelve Testnet Spot contracts,
persistence, readers, review, Agent handoff, one-attempt IOC executor, and
read-only reconciliation in narrow verified slices. It does not claim those
capabilities are already connected.

It does not authorize Mainnet, a runtime network selector, Perp work,
withdrawals, transfers, bridges, resting orders, cancellation, automation, or
deployment. Physical-phone and credentialed provider checks remain unverified
until they are actually run.
