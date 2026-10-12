# Decision 0129: refusal numbers, MEME transfer coverage integrity, settlement retry backoff, security capability projection (S157-api)

- Status: Accepted (S157-api), Development / BSC Testnet only
- Date: 2026-10-12
- Baseline: `integration/v2` = `15e31e0` (Decision 0128, migration 000074)
- Inputs: user rulings 2026-10-12 (S157-api task sheet, four independent items);
  the 2026-10-12 incident (publicnode answered `eth_getLogs` for old blocks with `[]`
  during the MEME transfer re-scan; the coverage was marked complete with the history
  missing and the settlement saw the PoolManager with a negative balance); client
  codec `loop-mobile/lib/integrations/backend/v2/security/loop_v2_security_api.dart`
  at `2825f1d`; `LOOP/docs/modules/S2-identity-account.md` (S60a / S64);
  Decisions 0037, 0063, 0114, 0116, 0124, 0125, 0126.
- Scope: §1 `detailsSafe` keys on launch2 `409 INSUFFICIENT_BALANCE`; §2 the
  `launch2_event` lane and migration `000075_launch2_meme_coverage_integrity`
  (patch to Decision 0125); §3 the `mining_hourly_settlement` lane (no migration);
  §4 `GET /v2/security/capabilities` (revision of Decision 0037). No `/v1` change,
  no new route, no write path, BSC Mainnet signing stays closed.

## §1 Refusal numbers (launch2)

Additive `detailsSafe` keys, decimal strings in whole units (18 decimals, `formatLaunch2Amount`),
read at the same block as the check. No status code and no existing key changes.

| Route / reason                                                                               | Existing keys                     | Added                                      |
| -------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------ |
| `POST …/nft/prepare`, `LAUNCH2_USD1_BALANCE_INSUFFICIENT`                                    | `requiredUsd1`                    | `balanceUsd1`                              |
| `POST …/trade/prepare` (curve, balance-bound), `LAUNCH2_USD1_` / `MEME_BALANCE_INSUFFICIENT` | `maxAmountIn`                     | `balanceUsd1` (buy) / `balanceMeme` (sell) |
| `POST …/pool/trade/prepare`, `LAUNCH2_USD1_` / `MEME_BALANCE_INSUFFICIENT`                   | `maxAmountIn`, `requiredAmountIn` | `balanceUsd1` (buy) / `balanceMeme` (sell) |
| every launch2 prepare, `LAUNCH2_GAS_INSUFFICIENT`                                            | —                                 | `requiredBnb`, `balanceBnb`                |

`requiredBnb` is the gas fee ceiling the check compared: (gas limit of the call, plus the
approve's 80,000 when an approve is needed) × `maxFeePerGas` (EIP-1559) or `gasPrice`.
`balanceBnb` is the wallet's native balance from the same read. The S155 App reads only the
existing keys and ignores the new ones until its next batch.

## §2 MEME transfer coverage integrity (patch to Decision 0125)

Entities: no new entity. `launch2_instances` gains `meme_transfers_coverage_failures integer
not null default 0` (consecutive failed checks). IDs unchanged (`instanceId` opaque).

Rules:

1. **Untrusted log answers.** For each segment the lane passes `mintAnchors` — for every
   instance whose `deploy_block_number` lies inside the segment, its MEME's `Transfer` from the
   zero address at that block — to `Launch2Chain.getLogs`. The reader checks the address-filter
   answer of the fallback transport; if any anchor is missing it asks each endpoint of the RPC
   list in order (an endpoint that errors is skipped) and keeps the first answer that holds every
   anchor. No endpoint has it: `Launch2ChainRefusedError("LAUNCH2_RPC_LOGS_UNTRUSTED")`; the
   lane returns `unavailable` / `LAUNCH2_RPC_LOGS_UNTRUSTED` without committing the segment
   (checkpoint unchanged, next tick retries). The empty answer is never swallowed.
2. **Completion needs proof.** `commitSegment` no longer sets `meme_transfers_complete_at` from
   the checkpoint position. After each committed segment the lane reads
   `listMemeCoverageChecks` (instances with `target ≤ the committed block`, not complete,
   `failures < 3`) and applies `assessLaunch2MemeCoverage`:
   - complete ⇔ a non-removed transfer from `0x000…0` at `deploy_block_number` exists **and**
     Σ(in) − Σ(out) ≥ 0 for every address except the zero address;
   - otherwise `retry`: failures + 1, `meme_transfers_target_block = null` (the lane re-scans
     the instance from its deploy block next tick), warn
     `LOOP launch2_event MEME transfer coverage incomplete; re-scanning` with
     `reasonCode LAUNCH2_MEME_COVERAGE_INCOMPLETE`, `instanceId`, `detailReasonCode`
     (`DEPLOY_MINT_MISSING`, `NEGATIVE_BALANCE`, or both joined by `.`), `attempts`, `count`
     (negative addresses);
   - the third consecutive failure is `stalled`: failures = 3, the target block is kept (no
     re-scan), one error `LOOP launch2_event MEME transfer coverage incomplete after 3
re-scans; operator required`; the instance is no longer checked.
   - complete resets failures to 0.
3. **Operator reset** (after fixing the RPC list): `update public.launch2_instances set
meme_transfers_coverage_failures = 0, meme_transfers_target_block = null where instance_id
= '<id>';` — the lane re-scans and checks again.
4. **Migration 000075** adds the column and un-marks `meme_transfers_complete_at` on every
   instance whose indexed transfers already fail the same check (today's incident), so the lane
   re-checks them, re-scans, and the settlement treats their post-graduation balances as pending
   (`MINING_ASSET_GRADUATED_BALANCE_PENDING`, Decision 0126) until coverage is proven. Transfer
   rows are not touched. `down` drops the column only.

Assumption recorded: every MEME mints at its deploy block (the user's statement; the anvil
lane suites exercise it against the real Factory). An instance that does not would stall after
three checks with `DEPLOY_MINT_MISSING`, never be marked complete.

## §3 Settlement retry backoff (`mining_hourly_settlement`)

No migration: `mining_epochs.attempt_count` (consecutive failures; `recordEpochFailure`
increments it) and `updated_at` (set to `clock_timestamp()` on every failure) already exist.

- Next attempt of a `failed` hour = `updated_at + min(2^(attempt_count − 1), 60)` minutes:
  1, 2, 4, 8, 16, 32, 60, 60, … Before it the scheduled runner answers `skipped` /
  `MINING_SETTLEMENT_RETRY_BACKOFF` without reading facts (silent: no log, not an attempt).
  An operator `test_trigger` is not held back.
- Logging: one `LOOP mining hour not settled` per real failed attempt (`attempts` =
  `attempt_count`); `warn` below 10, `error` from the 10th consecutive failure on — by then the
  backoff is at its 60-minute cap, so at most one error per failing hour per hour.
- Unchanged: `MINING_SETTLEMENT_INDEXER_BEHIND` still warns once per tick (it stops the tick).

## §4 Security capability projection (revision of Decision 0037)

Client check (2825f1d codec): it accepts **only** `status: "unavailable"` with `evidence.status:
"pending"`, rejects any extra key (strict maps), and fails the whole read otherwise. There is no
`available` form it parses. Changing the default response would turn the security centre's
methods section into an error on every installed App, so:

- **Default (no query) = `?projection=pendingOnly`**: the Decision 0037 bytes, unchanged.
- **`?projection=current`** (opt-in; any other query key or value is `400 INVALID_REQUEST`):
  - `mfa`: `available`, `reasonCode: null`, evidence `{status: "confirmed", reasonCode:
"PRIVY_MFA_CLIENT_TOTP", reference: "S60a: privy_flutter TOTP enrolment in 安全设置
(docs/modules/S2-identity-account.md)"}`;
  - `passkey`: `available` with `PRIVY_PASSKEY_CLIENT_ENROLLMENT` / "S64: privy_flutter passkey
    link/enroll; RP = the API domain (loop-api Decision 0063)" **while the API publishes a
    relying-party association** (`PASSKEY_ANDROID_CERT_SHA256` or `PASSKEY_IOS_TEAM_ID`);
    otherwise `unavailable` / `PASSKEY_RELYING_PARTY_NOT_CONFIGURED` (pending) — fail closed,
    a passkey cannot work without the association file;
  - `autoRecovery`: `available` with `PRIVY_EMBEDDED_WALLET_DEFAULT_RECOVERY` / "S60a: Privy
    内置钱包默认由登录方式恢复；换设备后用同一邮箱登录即可（来源：Privy）" (user ruling 2026-09-21);
  - `recoveryPassword`, `socialRecovery`, `keyExport`: unchanged (`unavailable`,
    `PRIVY_<X>_EVIDENCE_PENDING`).
- Schema: `status` ∈ {`unavailable`, `available`}, `reasonCode` nullable, `evidence.status` ∈
  {`pending`, `confirmed`}, optional `evidence.reference` (1–120 chars, confirmed only).
- Frontend follow-up: widen the codec to accept `available` + `confirmed` + `reference` and
  `reasonCode: null`, then send `projection=current`. Once no installed App predates that, a
  later decision may flip the default.

## Error codes and unavailable behaviour

New reason codes: `LAUNCH2_RPC_LOGS_UNTRUSTED` (lane result, not an HTTP answer),
`LAUNCH2_MEME_COVERAGE_INCOMPLETE` (log), `MINING_SETTLEMENT_RETRY_BACKOFF` (runner outcome),
`PASSKEY_RELYING_PARTY_NOT_CONFIGURED` (capability reason). No new HTTP error code. Missing
configuration keeps every path fail closed: no RPC → lane idle as before; no passkey association
→ passkey unavailable.
