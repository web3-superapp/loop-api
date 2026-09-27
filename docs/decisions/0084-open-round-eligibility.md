# Decision 0084: Open-round eligibility is decided before the mode and allowlist gates

- Status: Proposed (backend, S83b5)
- Date: 2026-09-27
- Scope: `GET /v2/launch/{launchId}/eligibility` and the eligibility step of
  `POST /v2/launch/{launchId}/intents`. Builds on Decisions 0076 (one
  snapshot for contract reads) and 0077 (tierModeV1, stored Merkle roots).
- Baseline: `integration/v2` = `632967a`. No migration, no response-shape
  change, no new reason code.

## Context

On device (2026-09-27) sales 4 and 5 have two public rounds whose on-chain
`allowlistRoot` is all zero, yet the detail page showed "eligibility pending".
`decideEligibility` already answered `open` for a zero root regardless of
mode, but `getEligibility` refused with `TIER_MODE_PENDING` before reading
the chain whenever `tierModeV1` was not confirmed. The frontend (loop-mobile
Decision 0094) already renders the open branch.

## Decision

1. Evaluation order: read the round's `allowlistRoot` from `getRounds` at
   the snapshot block first.
   - All-zero root: return the open branch (`status: available`,
     `tier` = the round's configured tier or `public`, `allowlistRoot` all
     zero, `eligibilityProof: []`, `snapshotBlock` = the read block). Neither
     `tierModeV1` nor `launch_round_allowlist_roots` is consulted; the stored
     roots are not even queried.
   - Non-zero root: unchanged. Mode unconfirmed → `TIER_MODE_PENDING`;
     no stored root → `LAUNCH_ALLOWLIST_NOT_COMPUTED`; stored root differs →
     `LAUNCH_ALLOWLIST_ROOT_MISMATCH`; mode differs →
     `LAUNCH_ALLOWLIST_MODE_MISMATCH`.
2. When the root cannot be read at all (no contract configured, registry or
   baseline reason, contract read failure, no active wallet, round not on
   chain) and the mode is unconfirmed, the answer stays `TIER_MODE_PENDING`,
   byte-identical to before. With a confirmed mode those paths return their
   existing specific reason codes.
3. Intent prepare: an all-zero root skips the stored-root lookup and the
   proof; `buy()` is encoded with an empty proof. Non-zero roots are
   unchanged (the Intent still resolves membership from the stored root that
   equals the chain root; it has never refused on an unconfirmed mode).
4. The response `mode` stays `unavailable` while `tierModeV1` is unconfirmed,
   even when `result` is the open branch: `mode` describes LOOP's
   configuration, `result` the chain's round.

## Unavailable behaviour

Unchanged: without a contract every Launch eligibility response keeps the
Decision 0036 / 0076 bytes. The open branch is only produced from a real
chain read; no fixture or default stands in for the root.

## Tests

`test/v2-launch-s83b-routes.test.ts` "open rounds (Decision 0084)": zero root

- pending config and + unset `tierModeV1` → open; zero root + no stored root
  → open and the root table is not queried; non-zero root → the three refusals.
  `test/launch-intent-service.test.ts`: open round with an unset mode and no
  stored root prepares with `eligibilityProof: []` without querying roots.

## Main-agent rulings (2026-09-27)

1. Intent prepare should refuse a non-zero-root round while `tierModeV1` is unconfirmed, matching eligibility's `TIER_MODE_PENDING`; tracked as S83b6.
2. `GET /v2/launch/overview.myEligibility` stays unavailable for now; the home page does not render round eligibility.
