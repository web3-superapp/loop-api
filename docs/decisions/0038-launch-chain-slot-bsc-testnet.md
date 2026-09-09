# Decision 0038: Launch chain slot on BSC testnet (dual-chain infrastructure)

- Status: Accepted (backend); the 02 contract document is still pending
- Date: 2026-09-09
- Scope: S9 backend. The main-agent rulings of 2026-09-09 in
  `LOOP/docs/modules/S9-dual-chain.md` are adopted below. The user may
  overturn any row.

## Context

The project owner confirmed (2026-09-09) that the Launch contract will first
live on the BSC testnet (`eip155:97`) for a while. Until now every backend
path — chain status, registry, indexer, balances, wallet intents, and the
Launch catalog — recognised exactly one chain, `eip155:56`, through the
constants of Decision 0033 and the `launchChainId` literal of Decision 0036.

This step adds the infrastructure that lets **one module** point at another
chain without turning LOOP into a multi-chain product: two named chain slots.
The `primary` slot stays `eip155:56` and is not changed by a single byte; the
`launch` slot is `eip155:56` (default) or `eip155:97`, chosen by
configuration. When the 02 document arrives, the contract address, ABI, the
Launch event lane, and the Launch intent are attached to the `launch` slot
instead of to a hardcoded chain.

## Rulings adopted (main agent, 2026-09-09)

| Topic             | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain model       | Exactly two named slots: `primary = eip155:56` (unchanged) and `launch = LAUNCH_CHAIN_ID ∈ {56, 97}`, default `56`. No generic multi-chain support, no chain list.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Configuration     | `LAUNCH_CHAIN_ID`, `LAUNCH_BSC_RPC_URLS` (comma list), `LAUNCH_BSC_CONFIRMATIONS` (default 5), `LAUNCH_BSC_REORG_DEPTH_BLOCKS` (default 15). With `LAUNCH_CHAIN_ID=56` the primary RPC and parameters are reused and every `LAUNCH_BSC_*` key must be blank (otherwise startup fails). `LAUNCH_CHAIN_ID=97` without `LAUNCH_BSC_RPC_URLS` is `unavailable(LAUNCH_CHAIN_RPC_NOT_CONFIGURED)`, never a crash. The runtime `eth_chainId` must equal the configured value, otherwise `unavailable(LAUNCH_CHAIN_ID_MISMATCH)` plus a startup warning, in the same pattern as the Decision 0033 primary verification. |
| RPC client        | `integrations/bsc/rpc-client.ts` is reused and instantiated once per slot. Endpoint URLs never enter a response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Chain status      | `GET /v2/chain/status` gains `launchChain: {chainId, chainReference, verification, confirmations, reorgDepthBlocks, head, reasonCode} \| null`; `null` when the `launch` slot equals `primary` (nothing is published twice).                                                                                                                                                                                                                                                                                                                                                                                    |
| Launch catalog    | `launches.chain_id` is decided by the `launch` slot at creation time (existing rows stay `eip155:56`); `GET /v2/launch/overview`, `GET /v2/launches/{id}` and the list items publish `chainId`; the `launchChainId` constant becomes configuration. The contract-address slot stays `null`.                                                                                                                                                                                                                                                                                                                     |
| Wallet read       | `GET /v2/wallets/{walletId}/balances` gains `launchChain: {chainId, nativeBalance, availability, reasonCode} \| null`: only the native coin (tBNB) via `eth_getBalance`, no asset registry for 97, no Multicall3; `null` when the slots are equal. `spendableBalance` / gas reserve follow the primary rules (`WALLET_GAS_RESERVE_BNB` is reused).                                                                                                                                                                                                                                                              |
| Transaction shape | The unsigned-transaction `chainId` is injected from a parameter (no `56` constant); the `intent-contract.ts` literal widens to `56 \| 97`, but **only a Launch intent may bind 97** — send/swap/approval keep 56 (locked by tests). No executable Launch intent is added; `POST /v2/launch/{launchId}/intents` stays `503 LAUNCH_CONTRACT_BASELINE_PENDING`.                                                                                                                                                                                                                                                    |
| Indexer           | No new lane (no contract). `indexer_checkpoints` and `indexed_*` are already keyed by `(lane, chain_id)`; this step only proves that `eip155:97` can be written (integration test). `BSC_INDEXER_ENABLED` keeps driving only the primary chain.                                                                                                                                                                                                                                                                                                                                                                 |
| Capabilities      | No new capability ID. The `launch` capability's `evidence` gains `launchChainId`; `bscRead` keeps describing only the primary chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Not in scope      | Market / GoPlus / DexScreener data for 97; an asset registry or ERC-20 balances for 97; PancakeSwap testnet pools; a Launch event lane; any Launch transaction; any change to `BSC_WRITES_ENABLED` semantics.                                                                                                                                                                                                                                                                                                                                                                                                   |

## Testnet facts

Source: BNB Chain public documentation (`docs.bnbchain.org`, "BSC Testnet"
network information) and the main-agent brief of 2026-09-09. Verified by the
backend agent on **2026-09-09** with a JSON-RPC `eth_chainId` call against
`https://bsc-testnet-rpc.publicnode.com`; the endpoint answered `0x61`
(decimal 97).

| Fact            | Value                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAIP-2 chain ID | `eip155:97` (chain reference 97, hex `0x61`)                                                                                                        |
| Native coin     | tBNB, 18 decimals; canonical asset ID `eip155:97:native`                                                                                            |
| Public RPC      | `https://bsc-testnet-rpc.publicnode.com`, `https://data-seed-prebsc-1-s1.bnbchain.org:8545` (the second one was not probed in this step)            |
| Faucet          | `https://www.bnbchain.org/en/testnet-faucet`                                                                                                        |
| Multicall3      | `0xcA11bde05977b3631167028862bE2a173976CA11` (same address as mainnet, taken from viem 2.44.2's `bscTestnet` definition; **not used** in this step) |

None of these is a Provider decision: the RPC list is local configuration,
never published, and the faucet is operator documentation only.

## Implementation rulings (backend, 2026-09-09)

### Configuration (`src/config.ts`)

`AppConfig.launchChain: LaunchChainConfig` is always present:

```ts
interface LaunchChainConfig {
  chainId: "eip155:56" | "eip155:97";
  chainReference: 56 | 97;
  rpcUrls: readonly string[]; // may be empty → the slot is unavailable
  confirmations: number;
  reorgDepthBlocks: number;
  sharedWithPrimary: boolean; // true exactly when LAUNCH_CHAIN_ID=56
}
```

- `LAUNCH_CHAIN_ID=56` (default): `rpcUrls`, `confirmations`, and
  `reorgDepthBlocks` are copied from the primary configuration
  (`BSC_RPC_URLS`, `BSC_CONFIRMATIONS`, `BSC_REORG_DEPTH_BLOCKS`), so an
  operator cannot accidentally run two different mainnet clients. Any
  non-blank `LAUNCH_BSC_RPC_URLS`, `LAUNCH_BSC_CONFIRMATIONS`, or
  `LAUNCH_BSC_REORG_DEPTH_BLOCKS` is a `ConfigurationError`.
- `LAUNCH_CHAIN_ID=97`: `LAUNCH_BSC_RPC_URLS` is parsed with the same rules as
  `BSC_RPC_URLS` (http(s) only, no credentials, at most 8, de-duplicated);
  blank leaves `rpcUrls` empty and the slot fails closed. Confirmations
  default to 5 and reorg depth to 15 — the testnet's shorter finality; both
  are still bounded to 1..1000.
- Any other `LAUNCH_CHAIN_ID` value fails startup.
- The reconciliation worker parses the same keys into
  `ReconciliationWorkerConfig.launchChain` so that one `.env` file is accepted
  or refused identically by both processes. The worker instantiates **no**
  launch-chain client, because no lane consumes it yet.

### Two read clients (`src/app.ts`)

`createBscReadClient` accepts either slot's configuration and selects the viem
chain definition by `chainReference` (`bsc` for 56, `bscTestnet` for 97); the
`eth_chainId` verification compares against the configured reference exactly
as before. `buildApp` composes:

- `bscReadClient` for the primary slot (unchanged), and
- `launchChainReadClient`, which is `null` when the slot is shared, the
  unavailable client (`LAUNCH_CHAIN_RPC_NOT_CONFIGURED`) when
  `LAUNCH_CHAIN_ID=97` without endpoints, or a second live client otherwise.

The launch client is verified once at startup; a non-verified state is a
warning, never a crash, and the live state is read per request. The
`options.launchChainReadClient` seam exists for tests only and is ignored when
the slot is shared.

### Reason codes of the launch slot

| reasonCode                          | Meaning                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `LAUNCH_CHAIN_RPC_NOT_CONFIGURED`   | `LAUNCH_CHAIN_ID=97` but no `LAUNCH_BSC_RPC_URLS`         |
| `LAUNCH_CHAIN_VERIFICATION_PENDING` | Endpoints configured; `eth_chainId` not yet observed      |
| `LAUNCH_CHAIN_RPC_UNREACHABLE`      | Every launch endpoint failed                              |
| `LAUNCH_CHAIN_ID_MISMATCH`          | The endpoint serves a chain other than the configured one |
| `BSC_BALANCE_CALL_FAILED`           | (balances only) the `eth_getBalance` read itself failed   |

The primary slot's `bscRead` capability and `BSC_*` reason codes are untouched.

### Projections

- `GET /v2/chain/status.launchChain` is `null` when shared. Otherwise it carries
  the slot's chain identity, live verification, confirmation policy, the head
  (only when verified), and one reason code. It publishes no endpoint list
  and no URL. The route still fails closed on the **primary** slot: a launch
  slot alone never turns the networks page on.
- `GET /v2/wallets/{walletId}/balances.launchChain` is `null` when shared.
  Otherwise `{chainId, availability, reasonCode, nativeBalance}` where
  `nativeBalance` is `{assetId: "eip155:97:native", symbol: "tBNB",
decimals: 18, rawValue, displayBalance, availableBalance, spendableBalance,
gasReserve, snapshot: {blockNumber, blockHash, observedAt, confirmations}}`
  or `null`. A launch-slot failure never fails the primary balances, and no
  `wallet_balance_snapshots` row is recorded for 97 (there is no registry
  asset to reference). `pending`, `valuation`, and `crossCheck` do not exist
  for the launch slot.
- Launch summaries publish `chainId` from the stored row
  (`"eip155:56" | "eip155:97"`), never from a constant.
- `GET /v2/meta/capabilities`: the `launch` entry's `evidence` gains
  `launchChainId`; every other entry is byte-identical.

### Intent chain policy (`src/features/wallet-intents`)

`UnsignedTransaction.chainId` and `IntentSource.chainId` widen to the two
slots. `isIntentChainAllowed(kind, chainReference)` is the single rule: 56 for
every kind, 97 only for `"launch"`. `buildUnsignedTransaction` takes the
`kind` and `chainReference` and refuses a disallowed pair before any bytes
are built; the send and approval services pass `bscChainReference`. The
wallet-intent route schemas keep `chainId: const 56` because those routes
can only ever prepare send/approve/revoke/swap intents. Broadcast
verification compares the observed chain with the payload's own `chainId`.

### Persistence

Migration `000026_v2_launch_chain_bsc_testnet` inserts the `eip155:97` row
into `public.chains` (`BNB Smart Chain Testnet`, confirmations 5, reorg depth
15). This is required because `launches.chain_id`, `indexer_checkpoints.chain_id`,
and every `indexed_*` table reference `chains` with `on delete restrict`.
`chains` is read only by primary key (`getChain`), so the new row appears in
no existing response. No asset row is seeded for 97. `down` deletes the row
and is refused by the foreign keys while any launch or checkpoint references
it.

### Operator script

`pnpm launch:review … approve` creates the `launches` row on the chain named
by `LAUNCH_CHAIN_ID` in the script's environment (the same `.env.local` the
API reads); an invalid value is `launch_review_launch_chain_invalid`.

## Regression guarantee

With `LAUNCH_CHAIN_ID` unset every existing field keeps its value and
position. The additive fields are exactly the three the rulings name:
`chain/status.launchChain: null`, `balances.launchChain: null`, and
`capabilities[launch].evidence.launchChainId: "eip155:56"`. Launch
`chainId` already existed and keeps the value `"eip155:56"`. The existing
route, contract, and OpenAPI tests were not relaxed.

## Rollback

Unset `LAUNCH_CHAIN_ID` (or set it to `56`) and clear `LAUNCH_BSC_*`; the
launch slot collapses onto the primary slot and the three additive fields
report `null` / `"eip155:56"`. Migration `000026`'s `down` removes the
`chains` row once no launch or checkpoint references it.

## Integration checklist once 02 arrives

In order, all against the `launch` slot rather than a chain constant:

1. **Contract registry**: a `launch_contracts` (or `launches.contract_address`
   - ABI version) record keyed by `launch_id`, verified on the launch chain
     through `eth_getCode` before it is published; `contractAddress` leaves
     `null`.
2. **`launch_event` lane**: a worker lane on `launchChainReadClient` for the
   02 event names (`SaleStateChanged`, `Purchased`, `SaleFinalized`,
   `BudgetsFrozen`, `RefundLiabilityFrozen`, `Refunded`,
   `VestingScheduleCreated`, `Claimed`, `PoolPrepared`, `LiquidityAdded`,
   `LPNFTLocked`, `LiquidityRetryScheduled`, `Paused`, `Unpaused`) writing
   `purchase_records`, `entitlements`, `refund_liabilities`, and the four-axis
   projection; its checkpoint is `(lane = launch_event, chain_id = launch
slot)`, separate from the primary lanes, with its own `LAUNCH_INDEXER_ENABLED`.
3. **Intent construction**: `POST /v2/launch/{launchId}/intents` prepares a
   `launch` intent through `buildUnsignedTransaction({kind: "launch",
chainReference: launchChain.chainReference, …})`, pre-executed on the launch
   client, with the 03 §8.2 bindings and the state-tuple digest; the client
   switches the Privy chain from the intent's canonical `chainId`.
4. **Canary**: a testnet canary allowlist (`eip155:97:native` and the USD1
   test token) under a launch-specific write switch, separate from
   `BSC_WRITES_ENABLED`, so mainnet writes stay closed while testnet Launch
   purchases are exercised end to end.
5. **Chain status / networks page**: publish the launch lane's checkpoint under
   `launchChain` once the lane exists; still no endpoint URLs.

## Consequences and evidence gates

The backend can now describe the Launch chain slot, read a wallet's tBNB
balance on it, and record which chain a launch belongs to. It still cannot
assert any Launch contract fact, build any Launch transaction, index any
Launch event, or price anything on 97. The public testnet RPC has been
verified only for `eth_chainId`; its `eth_getLogs` and
`eth_getTransactionReceipt` behaviour under load belongs to the same external
Go/No-Go list as the mainnet provider (Decisions 0033, 0035).
