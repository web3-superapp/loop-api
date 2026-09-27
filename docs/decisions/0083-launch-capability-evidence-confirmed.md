# Decision 0083: Launch capability evidence follows the contract adapter

- Status: Proposed (backend, S83b4)
- Date: 2026-09-27
- Scope: `GET /v2/meta/capabilities`, the `launch` entry's `evidence` only.
  Builds on Decisions 0036 (evidence separate from the module gate), 0038
  (`launchChainId`), 0039 (`confirmed` evidence), and 0076 (adapter
  availability). Baseline: `integration/v2` = `8bf2cca`. No migration.

## Context

`evidence` of the `launch` capability was hard-coded to
`{status: "pending", reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING"}` even
after the four `LAUNCH_*` keys were set and the adapter had observed the
contract code. The mobile client (loop-mobile Decisions 0088/0089) gates the
whole launch-trade page on that field, so a working contract stayed closed.

## Rulings

1. **Source of truth.** The evidence is a projection of the adapter's
   `currentAvailability()` (Decision 0076): configuration (four keys, ABI
   major), chain ID, and the startup `eth_getCode`. The capability read never
   probes; the only probe is the existing one-shot `verifyAtStartup()` (plus
   the adapter's own on-demand probes on Launch reads). Runtime field:
   `V2ProductPolicyRuntime.launchContractEvidence`, wired in `app.ts` with
   `launchContractEvidenceFrom(launchContractAdapter)`.
2. **States.**

   | Adapter observation                     | `evidence`                                                                                                     |
   | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | Four keys blank                         | `{status: "pending", reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING"}` (pre-0083 bytes)                         |
   | Keys set, ABI major unsupported         | `{status: "pending", reasonCode: "LAUNCH_CONTRACT_VERSION_UNSUPPORTED"}`                                       |
   | Keys set, `eth_getCode` empty           | `{status: "pending", reasonCode: "LAUNCH_CONTRACT_CODE_MISSING"}`                                              |
   | Keys set, startup probe not yet settled | `{status: "pending", reasonCode: "LAUNCH_CONTRACT_VERIFICATION_PENDING"}`                                      |
   | Keys set, chain unverified / RPC down   | `{status: "pending", reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED" \| "…_ID_MISMATCH" \| "…_RPC_UNREACHABLE"}` |
   | Adapter available                       | `{status: "confirmed", reasonCode: "LAUNCH_CONTRACT_CONFIRMED", launchContractVersion}`                        |

   `launchChainId` keeps its Decision 0038 rule (present only while the
   launch slot is `eip155:97`) in every row. Fail closed: anything other
   than the adapter's `available` stays `pending`.

3. **`launchContractVersion`.** Added as an optional evidence field, present
   only while `status` is `confirmed` (the configured
   `LAUNCH_CONTRACT_VERSION`, `MAJOR.MINOR.PATCH`). It is named
   `launchContractVersion`, not `contractVersion`, so it cannot be confused
   with the document-level API `contractVersion: "2.0"`.
4. **Unchanged.** `availability` / `reasonCode` of the capability (the
   PostgreSQL catalog gate), the `mining` and `referral` evidence, and every
   other capability. No other route reads `evidence.status`; the per-field
   `unavailable(LAUNCH_CONTRACT_BASELINE_PENDING)` facts of
   `GET /v2/launch/overview` (`graduated`) and `GET /v2/launches/{id}`
   (`market`, `holders`) are separate facts not produced by the adapter and
   are out of scope.
5. **No new error codes.** `LAUNCH_CONTRACT_CONFIRMED` is an evidence reason,
   never an error.
