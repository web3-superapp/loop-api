# Decision 0033: BSC chain registry, narrow indexer, wallet read, and V2 Watchlist

- Status: Accepted
- Date: 2026-09-08
- Scope: S5a backend (D10 + D12 + D13). The main-agent rulings of 2026-09-08 in
  `LOOP/docs/modules/S5-chain-market-wallet.md` are adopted below. S5b
  (D11 market, D14 alerts/notifications) is a separate decision. The user may
  overturn any row.

## Context

Decision 0026 named BSC as the product chain family but froze every address,
RPC, and contract as unverified configuration. Decisions 0030 and 0031
delivered identity, community, and search on PostgreSQL facts only:
`communities.bound_asset_key` was accepted and stored as a canonical
`eip155:<chainId>:<0x lowercase>` string but deliberately not resolved,
because no chain read existed.

S5a is that chain read. It has to establish, once, the identity substrate every
later module depends on (Market D11, Swap D15, Send D16, Launch D17, Mining
D19): what an asset is, what block a fact was observed at, which wallets an
account has, and how a reorg is reconciled. Without it those modules would each
invent their own asset key and their own freshness story.

## Rulings adopted (main agent, 2026-09-08)

| Topic              | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-built indexer | `contracts/integration-catalog`'s `forbidden_custom: custom_indexer` is 2026-08-23 research and is superseded: 03 §11 makes the Indexer a LOOP-owned system. A **narrow** BSC indexer is built — only ERC-20 `Transfer` for Asset Registry assets and Swap/Mint/Burn for registered PancakeSwap V3 pools. No full-chain indexing.                                                                                                                                                                                                                                                                                                                             |
| RPC                | viem `createPublicClient` + `fallback`; `BSC_RPC_URLS` is a comma list (≥1, production ≥2); chain ID 56 is verified through `eth_chainId` and a mismatch is `unavailable`; `BSC_CONFIRMATIONS` defaults to 15; reorg depth 64; per-endpoint health (latency, height gap) feeds the `networks` page.                                                                                                                                                                                                                                                                                                                                                           |
| Asset Registry     | `assets` keyed by `eip155:56:<0x lowercase>` (native `eip155:56:native`); `symbol/name/decimals` only from on-chain `symbol()/name()/decimals()`; `status: pending\|verified\|blocked`; `sources` records registration origin, block height, and verification time. `pnpm asset:register <address>` verifies on chain before writing. USD1 needs `BSC_USD1_TOKEN_ADDRESS` **and** `BSC_USD1_VERIFIED=true`. A ticker is never a key.                                                                                                                                                                                                                          |
| Asset capability   | `viewable` / `swappable` (false until D15) / `temporarily_unavailable` / `blocked`. The Token page renders a Swap entry only when `swappable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Wallet inventory   | Embedded wallets come from Privy's server SDK, external wallets from Privy linked accounts; LOOP stores `account_wallets` (opaque `walletId`, provider wallet ID, normalised address, kind, status, `is_active`); `PUT /v2/wallets/active` selects the active wallet.                                                                                                                                                                                                                                                                                                                                                                                         |
| Balances           | RPC `balanceOf` multicall over registry assets plus the native balance, carrying a snapshot block. Privy's `wallets.balance.get(chain=bsc)` is a cross-check source, and a difference is recorded as disputed. `displayBalance / availableBalance / spendableBalance / gasReserve / pending` are separate; in this step `available = display`, `spendable = display − gasReserve` (native only), and `pending` comes from unconfirmed indexed transfers. Valuation needs a price Provider, so `netWorth` is unavailable here and will carry `valuationCurrency`, `priceSource`, and `asOf` — and the note that it is not a spendable amount — when D11 lands. |
| Activity / history | `tx-history` uses indexer `Transfer` rows for registry assets. Scanning native transfers via `eth_getBlockByNumber` is too heavy, so native transfers are unavailable in this step. Each row carries tx/log/block/confirmations. Cross-chain and mining claims are unavailable.                                                                                                                                                                                                                                                                                                                                                                               |
| receive / networks | `receive` returns the active wallet address and an `eip155:56` EIP-681 string (`ethereum:<addr>@56`); only the BSC network segment is listed and other networks are simply absent, not unavailable placeholders. `networks` shows the BSC row plus per-endpoint health; custom RPC and testnets are unavailable.                                                                                                                                                                                                                                                                                                                                              |
| Watchlist v2       | `GET/PUT /v2/watchlist` (camelCase, `assetId`, CAS `expectedVersion`, `Idempotency-Key` rejected). The V1 table is reused: **not** by upper-casing the asset ID into `asset_key`, but by adding an `asset_id` column holding the canonical lowercase CAIP ID while V1 rows keep `asset_key`. Every written `assetId` must exist in the registry.                                                                                                                                                                                                                                                                                                              |
| Numbers            | Every amount and price is a string (smallest-unit integer plus `decimals`, or a decimal string). Chart doubles exist only after normalisation on the client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Pay                | Unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Implementation rulings (2026-09-08)

### Module gates

`chain` and `watchlist` join `v2ModuleIds`. `chain` carries the `bscRead`
capability and registers `/v2/chain/status` and `/v2/assets/{assetId}`;
`wallet` carries `walletRead` and registers the four `/v2/wallets*` routes;
`watchlist` carries the new `watchlist` capability and registers
`/v2/watchlist`. Folding all seven routes into the existing `wallet` gate was
rejected: an operator must be able to publish the read-only chain surface
without publishing the wallet inventory, and the capability projection would
otherwise have to lie about which of the three subsystems is actually live.

`bscRead` is `available` only when the module is enabled, at least one RPC
endpoint is configured, the registry repository is composed, **and**
`eth_chainId` has actually been observed to equal 56. An unprobed chain is
`BSC_CHAIN_VERIFICATION_PENDING`, an unreachable one `BSC_RPC_UNREACHABLE`, and
a wrong chain `BSC_CHAIN_ID_MISMATCH`. Verification is probed once at startup
(a warning, never a crash) and refreshed lazily; the capability projection
reads the live state per request rather than the state at composition time.

### Endpoint URLs are never published

`GET /v2/chain/status` identifies each endpoint by
`endpointRef = "rpc-" + sha256(url)[0..12]`. The URL is Provider configuration
and appears in no response, capability projection, or log field.

### Chain status fails closed

With no configured endpoint `GET /v2/chain/status` is
`CAPABILITY_UNAVAILABLE`, not an all-null "healthy" document. A configured but
degraded chain returns 200 and reports the degradation, because that is the
freshness surface the `networks` page needs.

### Wallet addresses

`GET /v2/wallets`, `/receive`, and `/balances` all publish the wallet's full
address (main-agent ruling, 2026-09-08): a user's own wallet address is a
public on-chain fact the wallet screens need, and truncation is a client
concern. The address is still never an identifier: every request names a wallet
by its opaque `walletId`, and the server rejects a client-selected address as
an account, owner, or authorization key.

### Active wallet selection is a compare-and-swap, not a command

`PUT /v2/wallets/active` takes `{walletId, expectedActiveWalletId}` and rejects
an `Idempotency-Key` (Decision 0030's rule for versioned replacements). A
concurrent switch from another device is `VERSION_CONFLICT`, never a silent
overwrite. The write moves no funds and grants no signing authority.

### Balances keep one row per readable asset

`GET /v2/wallets/{walletId}/balances` always emits exactly one row per readable
registry asset. The numeric fields live under a discriminated `balance` union
(`{status: "available", …}` or `{status: "unavailable", reasonCode}`), so a
per-asset multicall failure reports the failure instead of dropping the asset —
"we could not read this balance" must never look like "this wallet does not
hold it".

### Privy cross-check never overrides the chain

The RPC multicall is authoritative. Privy's balance view is compared only for
the native asset, because Privy reports named assets rather than token
addresses and a token match would be a guess. Both sides are rescaled to the
registry asset's `decimals` with integer arithmetic; a source reporting more
precision than the asset has is only comparable when the extra digits are zero,
otherwise the comparison is refused rather than rounded.

Privy does not report the block it read, so a difference cannot be attributed
to a real disagreement rather than to a later block: it is `unaligned` with
`blockDelta: null`, never `disputed`. `disputed` is reserved for a source that
reports its block and read the same one. None of `matched`, `unaligned`,
`disputed`, or `unavailable` changes the published RPC value, and a failed
cross-check never fails the request.

### Capability projection is evaluated per request

`GET /v2/meta/capabilities` builds its projection on every request, exactly
like the client policy, and reads chain verification synchronously from the
read client (`currentVerification()`). Verification is probed asynchronously,
so a projection captured at composition time would keep reporting a stale
pending or unreachable state after the endpoint recovered.

### Gas reserve is a published product policy

`spendableBalance = displayBalance − gasReserve` holds back a configured amount
of the native asset so a later transfer or Swap can still pay gas.
`WALLET_GAS_RESERVE_BNB` sets it in decimal BNB (default `0.005`, at most 1
BNB, converted with exact integer arithmetic). It is a display-side policy, not
a chain fact, so the response carries
`gasReservePolicy.configVersion = "walletGasReserveV1"` and the raw reserve.
Non-native assets have a zero reserve.

### Indexer lane state machine

The `erc20_transfer` lane runs in the standalone worker process (Decision 0012
shape) behind `BSC_INDEXER_ENABLED`, default off. Each tick:

```text
idle ──head unreachable──▶ unavailable ──backoff──▶ idle
  │
  ├─ registry has no token ─▶ idle (ASSET_REGISTRY_EMPTY)
  ├─ no checkpoint ─▶ seeded(from = BSC_INDEXER_START_BLOCK or head − 64)
  ├─ checkpoint hash matches chain ─▶ advanced(from … min(from+1999, head))
  └─ checkpoint hash differs ─▶ reorged(rewind 64 blocks but never below the
                                 lane's start block, mark every stored log at
                                 or above the rewind point removed, replay)
```

Event rows and the checkpoint advance commit in **one** transaction, so a
checkpoint can never claim a block whose logs were not stored. A segment is
written as multi-row INSERTs of at most 500 rows, all inside that same
transaction; the batch is de-duplicated on `(transaction hash, log index)`
first because a multi-row upsert cannot touch one conflict key twice. Rows are
unique on `(chain_id, transaction_hash, log_index)`, so a replayed segment is
idempotent across batch boundaries. A reorged-out log keeps its row with `removed = true` so a client
can reconcile what it already displayed instead of watching history silently
change. `pnpm indexer:backfill --from <block>` runs the same lane synchronously.

Endpoints cap `eth_getLogs` by block span and by result size, and report the
two through different JSON-RPC errors (`InvalidParams` and `LimitExceeded`).
The read client halves the range and retries on either; a single block that
still fails is an endpoint limitation and fails closed rather than silently
dropping logs.

A reorg rewind touches only the rewinding lane's own table
(`indexed_transfers`). Each lane owns its own checkpoint, so one lane must
never mark another lane's rows removed past that lane's checkpoint.

The `pool_event` lane is deliberately not implemented here: its storage,
ABIs, and `pnpm pool:register` are in place, but the lane itself — including
its own rewind — belongs to S5b, which is the first consumer (candles and
trades).

### Multicall3

Balance and identity reads use Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11`, taken from viem 2.44.2's built-in
`bsc` chain definition (`viem/chains`, `contracts.multicall3`, deployed at
block 15921452). LOOP does not hardcode it. It is a read-only aggregation
contract on a path that moves no funds, but it has **not** been independently
verified against an official BSC source; that verification belongs to the same
external Go/No-Go item as the RPC provider, and no funds-moving path may use it
before then.

### Activity is never an empty success

`GET /v2/wallets/{walletId}/activity` returns `INDEXING_DELAYED` when the lane
has no checkpoint. An empty page would be indistinguishable from "this wallet
has no history", which is exactly the confusion the fail-closed rule exists to
prevent. When the lane has run, the response carries its own freshness
(`indexerBlockNumber`, `headBlockNumber`, `lagBlocks`).

### V1 and V2 Watchlist are one resource with two asset namespaces

They share `watchlist_versions.record_version`, so a V1 write is visible to a
V2 compare-and-swap and vice versa. `watchlist_items` gains `asset_id`; a check
constraint enforces that exactly one of `asset_key` (V1) and `asset_id` (V2) is
set per row, with a partial unique index per namespace. The primary key moves
to a surrogate `item_id` because `asset_key` is now nullable.

Three consequences are deliberate.

The frozen V1 **read** adds `items.asset_key is not null` to its join, so it
keeps its exact shape instead of failing closed on a row it cannot represent —
no V1 request or response field changes. For an account that has migrated, V1
therefore reports the V2 groups with empty `items` rather than an error.

A V2 `PUT` owns the whole owner-level snapshot: it replaces legacy V1 rows
rather than merging two asset namespaces into one list.

The frozen V1 **write** refuses once the account holds any `asset_id` row. A V1
replacement would delete the V2 rows through the group cascade, so it returns
V1's existing `version_conflict` instead of destroying the newer namespace. No
V1 field or status code is added; the client reads V2 and retries there. The
migration is one-way, once.

## Persistence

Migration `000019_v2_chain_registry_wallet` adds `chains` (seeded with BSC),
`assets` (seeded with `eip155:56:native`), `pools`, `indexer_checkpoints`,
`indexed_transfers`, `indexed_pool_events`, `account_wallets`,
`wallet_balance_snapshots`, and the `watchlist_items.asset_id` column. Raw
chain amounts are `numeric(78,0)` and are read back as strings; no balance,
amount, or block height becomes a JavaScript number.

`wallet_balance_snapshots` is an audit trail of balances actually observed at a
block. It is **not** replayed as a current balance when the chain is
unreadable: the balances route fails closed instead.

## Rollback

Disable `chain`, `wallet`, and `watchlist` in `V2_MODULES_ENABLED` and clear
`BSC_RPC_URLS`; every route then reports `NOT_FOUND` or
`CAPABILITY_UNAVAILABLE`. The migration's `down` removes the new tables and the
`asset_id` column after deleting V2 watchlist rows; V1 watchlist rows, the V1
contract, and every existing account record are untouched.

## Consequences and evidence gates

The backend can now state, with a block number attached, what an asset is, what
an account's wallets are, and what those wallets hold. Market, Swap, Send,
Launch, and Mining can build on one canonical asset ID instead of inventing
their own.

This decision does **not** prove a production RPC provider, PancakeSwap or
USD1 addresses, physical-device Privy wallet behaviour, price data, or any
funds movement. BSC Mainnet signing and broadcasting remain closed. The
following stay unverified and belong to the external Go/No-Go list: a BSC RPC
endpoint that serves `eth_getLogs` under production load, the official USD1
address, GoPlus and GeckoTerminal terms, and FCM/APNs.
