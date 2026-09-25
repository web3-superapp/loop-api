# Decision 0076: Launch contract adapter, ABI v1, and the `available` wire branches

- Status: Accepted (backend, S83a); contract delivery still pending
- Date: 2026-09-25
- Scope: S83a backend. Main-agent brief of 2026-09-25
  (`LOOP/docs/modules/S83-launch-contract-readiness.md`) and the user ruling of
  the same day that LOOP defines the Launch contract interface itself
  (`LOOP/docs/06-Launch合约接口需求.md`, "06" below). Extends Decisions 0036
  and 0038; reverses nothing in them. The user may overturn any row.

## Context

Decision 0036 left every on-chain Launch fact `unavailable` because the 02
contract document never arrived. The user has now ruled that LOOP writes the
contract interface (06) and the contract party implements it. That is enough
to build everything on our side that does not need a deployed address: the
ABI, a read/encode/decode adapter, the configuration and persistence slots,
and the wire branches a client needs once a real sale exists. It is not
enough to publish any chain fact: until an address is configured and its
code observed, every projection stays byte-identical to today.

## Rulings

| Topic                      | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface baseline         | 06 is the contract interface. `src/integrations/launch/launchpad-abi.v1.json` transcribes 06 §3 (14 events) and §4.1/§4.2 (9 functions, 4 structs) verbatim: names, Solidity types, `indexed`, parameter and struct field order. A change to 06 is a new ABI file (`v2`), never an edit of `v1`.                                                                                                                                                                       |
| Axis encoding              | `uint8` → name by the row order of the 06 §2 tables, which 06 §3 pins for `saleState` (`3=SUCCEEDED 4=FAILED 5=CANCELLED`): sale `SCHEDULED LIVE ENDED SUCCEEDED FAILED CANCELLED`; entitlement `NONE FROZEN VESTING COMPLETED REFUNDING REFUNDED`; liquidity `NOT_STARTED PREPARING V3_LIVE LP_LOCKED COMPLETED RETRY_SCHEDULED`; operational `ACTIVE PAUSED`. An out-of-range value is `LAUNCH_CONTRACT_READ_INVALID`, never clamped.                                |
| Adapter boundary           | `src/integrations/launch/launch-contract-adapter.ts`: read-only `getState/getRounds/getSaleConfig/quote/getPosition/getRoundPosition`; pure `encodeBuy/encodeClaim/encodeClaimRefund` (calldata + `to`, never signed or broadcast); `decodeEvents(logs)` → a discriminated union of the 14 events keyed by `eventName` with `saleId`. It knows nothing about launches, accounts, or HTTP.                                                                              |
| Snapshot discipline        | A read without an explicit snapshot takes the launch-slot `latest` block (number + hash) once; every `eth_call` of that read runs at that `blockNumber`; the block hash at that number is re-read afterwards and a difference is `LAUNCH_SNAPSHOT_REORGED`. Every result carries `{blockNumber, blockHash}`. A multi-read projection (state + rounds + config) shares one snapshot.                                                                                    |
| `stateTupleDigest`         | Published exactly as `getState` returns it. The backend never recomputes it off chain (06 §2 defines it; recomputing would hide a contract bug behind our own arithmetic).                                                                                                                                                                                                                                                                                             |
| RPC client                 | The Decision 0038 `BscReadClient` exposes no viem client and no block-pinned `eth_call`, and S82 owns that file, so the adapter builds its own viem `PublicClient` from the launch slot's endpoint list (`LAUNCH_BSC_RPC_URLS` on 97, `BSC_RPC_URLS` on a shared slot) with the same fallback/timeout policy. The slot's `verifyChain()` is reused, so a chain-ID mismatch already observed by 0038 closes the adapter too. URLs never enter a response or a log line. |
| Configuration              | `LAUNCH_CONTRACT_ADDRESS` (0x + 40 hex, stored lowercase), `LAUNCH_CONTRACT_VERSION` (semver `MAJOR.MINOR.PATCH`), `LAUNCH_CONTRACT_START_BLOCK` (non-negative integer), `LAUNCH_USD1_ADDRESS` (0x + 40 hex). All blank → `launchContract: null`. All set → parsed. Any other combination refuses to boot, naming each missing key. Parsed by the API and the worker alike (0038 parity).                                                                              |
| Startup verification       | All four set: one `eth_getCode(LAUNCH_CONTRACT_ADDRESS)` on the launch slot at startup (non-blocking, like 0038's chain watch). Empty code → `LAUNCH_CONTRACT_CODE_MISSING` (sticky until restart) plus a warning; unreachable → retried on the next read. The API always starts.                                                                                                                                                                                      |
| ABI major                  | The adapter speaks ABI v1 only. `LAUNCH_CONTRACT_VERSION` with a major other than `1` is `LAUNCH_CONTRACT_VERSION_UNSUPPORTED` (unavailable, not a boot failure).                                                                                                                                                                                                                                                                                                      |
| Sale registry              | `launches.sale_id` (`bigint`, see below), `contract_address` (existing column), `contract_version`, `config_version_onchain`. A sale is read only when `sale_id` is set **and** the row's `contract_address`/`contract_version` equal the configured ones; otherwise `LAUNCH_SALE_NOT_REGISTERED` / `LAUNCH_SALE_CONTRACT_MISMATCH`. No route writes these columns in S83a.                                                                                            |
| Cross-checks (fail closed) | `getState.configVersion == 0x0…0` → `LAUNCH_SALE_NOT_FOUND` (an unknown `saleId` reads as zeroes, which would otherwise decode as `SCHEDULED`). `getState.configVersion ≠ getSaleConfig.configVersion`, or `≠ launches.config_version_onchain` when that is set → `LAUNCH_CONFIG_VERSION_MISMATCH`. `getSaleConfig.usd1 ≠ LAUNCH_USD1_ADDRESS` → `LAUNCH_USD1_ADDRESS_MISMATCH`.                                                                                       |
| Axis constraint            | `launches_axes_unavailable_check` keeps its name and admits, per axis, `unavailable` plus exactly the 06 §2 names. `idempotency_records.digest_version` gains `launch_intent_v1` (reserved for S83b).                                                                                                                                                                                                                                                                  |
| Wire rule                  | Every changed slot is a union whose `unavailable` branch is the **pre-S83a schema and bytes, unchanged** (locked by fixtures generated from `1ab26d7`). The new branch is added beside it and is distinguished by the field the old branch already carries: `status` where the old object has one, `source` for `onChainState`, the HTTP status for the Intent route.                                                                                                  |
| Behaviour in S83a          | Only `GET /v2/launches/{launchId}` reads the chain (four axes, rounds, config), and only when the adapter is available and the sale is registered. `contractAddress` in summaries is published only under the same conditions. Every other route changes schema only and still answers exactly as before.                                                                                                                                                              |

### `sale_id` storage

06 types `saleId` as `uint256`, assigned from 1 upward. The column is
`bigint` with `sale_id >= 1`, as briefed: a counter that starts at 1 cannot
reach 2^63 in practice, and the database is the only source the adapter takes
a sale ID from. The record carries it as a decimal string; it becomes a
`bigint` only at the adapter boundary. A contract that ever assigned a larger
ID would be a 06 violation and is out of scope.

### Round identity on the wire

On chain a round is `roundId: uint16`. On the LOOP wire `roundId` is already
the opaque UUID of `launch_rounds` (and the Intent request takes it). Stable-ID
rule (00 规则) wins over the ABI name: the `available` round item keeps
`roundId` = opaque UUID (or `null` when no `launch_rounds` row carries that
index) and publishes the chain's `roundId` as `roundIndex`, the existing
1-based field. `launch_rounds.round_index` **is** the on-chain `roundId`.
Every other 06 `Round` field keeps its 06 name. This is listed below for the
main agent to confirm.

### Reason codes (new unless marked)

| reasonCode                                | Where      | Meaning                                                           |
| ----------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `LAUNCH_CONTRACT_BASELINE_PENDING` (0036) | every slot | the four `LAUNCH_CONTRACT_*`/`LAUNCH_USD1_ADDRESS` keys are blank |
| `LAUNCH_CONTRACT_VERIFICATION_PENDING`    | four axes  | configured; `eth_getCode` not yet observed                        |
| `LAUNCH_CONTRACT_CODE_MISSING`            | four axes  | no code at the configured address on the launch chain             |
| `LAUNCH_CONTRACT_VERSION_UNSUPPORTED`     | four axes  | configured major ≠ 1                                              |
| `LAUNCH_CHAIN_RPC_NOT_CONFIGURED` (0038)  | four axes  | launch slot has no endpoint                                       |
| `LAUNCH_CHAIN_ID_MISMATCH` (0038)         | four axes  | the slot's `eth_chainId` differs                                  |
| `LAUNCH_CHAIN_RPC_UNREACHABLE` (0038)     | four axes  | no endpoint answered                                              |
| `LAUNCH_SALE_NOT_REGISTERED`              | four axes  | adapter available, `launches.sale_id` is null                     |
| `LAUNCH_SALE_CONTRACT_MISMATCH`           | four axes  | the row names another contract address/version                    |
| `LAUNCH_SALE_NOT_FOUND`                   | four axes  | `getState` returned a zero `configVersion`                        |
| `LAUNCH_CONFIG_VERSION_MISMATCH`          | four axes  | on-chain `configVersion` disagrees (see cross-checks)             |
| `LAUNCH_USD1_ADDRESS_MISMATCH`            | four axes  | the sale settles in a token other than the configured USD1        |
| `LAUNCH_CONTRACT_READ_FAILED`             | four axes  | an RPC read failed                                                |
| `LAUNCH_CONTRACT_READ_INVALID`            | four axes  | a value could not be decoded or is out of range                   |
| `LAUNCH_SNAPSHOT_REORGED`                 | four axes  | the snapshot block hash changed during the read                   |

When the four axes are unavailable for any of these reasons, `rounds` and
`config` fall back to their off-chain projections (byte-identical to today)
and `contractAddress` stays `null`.

## Not in S83a (S83b and later)

The `launch_event` indexer lane; `POST /v2/launch/{launchId}/intents` prepare
and its signing exit (0065); the eligibility evaluators and Merkle tree; the
economy from the contract; any write path for `launches.sale_id`; the
holders/history/eligibility `available` data. Their schemas exist now so
S83c can decode them; no code path emits them.

## ABI check

`pnpm launch:abi-check <abi.json>` compares a delivered ABI with v1: the 14
event signatures and their `indexed` flags, the `buy/claim/claimRefund`
selectors, and the four struct-returning read functions' output tuples (plus
`quote` and `getRoundPosition`). One line per item, `✓`/`✗`; any `✗` exits 1.
Extra items in the delivered ABI (OpenZeppelin `Paused(address)`, admin
functions) are listed as `info`, never failures: `Paused(uint256,address)`
and OpenZeppelin's `Paused(address)` have different topics and may coexist.

## Rollback

Blank the four keys: the adapter is `unavailable(LAUNCH_CONTRACT_BASELINE_PENDING)`
and every response is byte-identical to `1ab26d7`. Migration `000041`'s
`down` refuses while any row holds a chain axis value, a `sale_id`, or a
`launch_intent_v1` record.

## Main-agent rulings on the S83a report (2026-09-25)

1. **`roundIndex` on the wire, `roundId` stays LOOP's opaque ID.** Accepted; 06 §4.2 now carries a note.
2. **Axis numbers are now explicit in 06 §2** (row order, as encoded here) and every read **must revert with `SaleNotFound()`** on an unknown `saleId`. The zero-`configVersion` guard stays as a second line.
3. Migration order: S82 (000040) merged first, then this (000041). Resolved in the merge commit.
4. **`reasonCode` widened to a list** on the unavailable branch: accepted. S83c must decode `reasonCode` as any string, never a fixed literal.
5. **S83b shapes are frozen as published here.** S83b may only add optional fields to the eligibility/holders/history available branches and the intents `201` body; anything else is a new decision.
6. **Digest storage keeps the column format** (64 hex characters, no `0x`); the wire keeps `0x`-prefixed bytes32. Conversion lives in the repository layer, once.
7. **`sale_id` is registered by an operator script** (`pnpm launch:register-sale --launch <launchId> --sale-id <n> --confirm`, S83b): it reads `getSaleConfig` first, refuses when `usd1` or the project token disagrees with LOOP's records, writes a `launch_review_events` audit row, and is refused in production without the flag. Deriving it from events is rejected: nothing on chain names LOOP's launch.
