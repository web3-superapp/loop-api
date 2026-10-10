# Decision 0122: MEME v2 on the third Factory generation, and the 2026-10-10 rulings (launch side) (S145)

- Status: Accepted (S145-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `dbc2831` (Decisions 0120 / 0121, migrations 000064 / 000065)
- Contracts: loop-contracts `main` (S144, Decision 0005 `buyback-without-price-guard`,
  merge `739255d`); the ABI was re-synced from a Foundry build of `122163d` (`main` at sync
  time = `739255d` + the S146 `OfficialPoolRouter` only — every selected item is identical).
  Testnet third Factory `0xc3acF98dBFDff8eD73dBe1F305DfDc688C81d1d2`, runtime code hash
  `0xf69d4f7256a6152e7e0f11810985cd488482b31efd8ab182b9c1ba468ad74748`
  (`protocol/deployments/bsc-testnet/factory-v3.json`).
- Inputs: user ruling 2026-10-10 (buyback: remove only the price protection), requirer answers
  `LOOP/docs/17` §四 (7 rejection reasons, 9 fixed recipient, 10 zero holders → public),
  `LOOP/docs/12` (S144-contracts, S142-admin open item 1), Decisions 0112, 0114, 0117, 0118,
  0120, 0121.
- Scope: migration `000066_launch2_generation_v3_and_rulings`; ABI sync; generation-aware
  read model / indexer / keeper / publisher; zero-holder opening; fixed buyback recipient;
  reviewer rejections (two new console routes); `kind` in the console projection. New env
  `LAUNCH2_BUYBACK_RECIPIENT` (API), `LAUNCH2_LEGACY_FACTORIES` (worker). No `/v1` change.

## 1. Factory generations

| Generation | Factories                                                               | BuybackExecutor                                                                                                                                                                                                            | SnapshotRegistry                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v2`       | every pre-S144 Factory (testnet S127 `0x1D02…CBde`, S141 `0x6A69…D9c0`) | price protection; `quoteNextOrder() → (amountIn, expectedNetOut, minMemeOut)` (reverts while the recorder is not ready); `BuybackCompleted(usd1Spent, memeDelivered, minMemeOut, referencePrice, spotPrice, successfulAt)` | no zero-holder opening                                                                                                                                                          |
| `v3`       | S144 and later (testnet `0xc3ac…d1d2`)                                  | no price protection; `quoteNextOrder() → (amountIn, executable)`; `BuybackCompleted(usd1Spent, memeDelivered, successfulAt)` (other topic0); new error `NoOutput`                                                          | `openPublicWithoutSnapshot()`, `openedWithoutHolders()`, `PublicRoundOpenedWithoutHolders(bytes32 indexed launchId, uint64 openedAt, uint64 openedBlock)`, error `HoldersExist` |

- **Factory address → generation.** `HOOKS_LAUNCH_FACTORY_ADDRESS` / `_CODE_HASH` stay the
  Factory new deployments go to; it is the build's generation (`v3`) unless its code hash is in
  the frozen table `launch2KnownFactoryGenerations` (the two older testnet hashes → `v2`, the
  third → `v3`). So a code upgrade that lands before dev switches Factories still tags new
  instances `v2`. `LAUNCH2_LEGACY_FACTORIES` (worker, `v2:0x…,…`) lists older Factories the
  `launch2_event` lane keeps indexing read-only (their `LaunchDeployed`, and activated tasks of
  those addresses are registered with that generation). Malformed, unknown generation,
  duplicate, or equal to the current Factory → boot refused.
- **Recorded, not guessed.** `launch2_instances.factory_generation` is written at registration
  (rows before 000066 are back-filled `v2`: they all came from price-protected Factories); every
  reader uses the row: the lane's role map (`buybackExecutorV2` = the frozen v2 ABI, so a v2
  `BuybackCompleted` decodes and a v3-shaped log from a v2 executor is ignored, and vice versa),
  `readBuybackState`, the publisher's zero-holder branch.
- **ABI.** `pnpm hooks:abi-sync` regenerated `hooks-launch-protocol-abi.generated.ts` (selection
  adds `openedWithoutHolders`, `openPublicWithoutSnapshot`, `PublicRoundOpenedWithoutHolders`).
  The v2 executor items are frozen verbatim (from the `bf9f170` generation) in
  `hooks-launch-protocol-abi-legacy-v2.ts`; `test/launch2-generation.test.ts` pins both
  `BuybackCompleted` topics and both `quoteNextOrder` shapes.
- **Executor verification (Decision 0112).** The deployment executor only acquires tasks of the
  current Factory and checks its code hash, so the 28 checks always run against the current
  generation; none of them read a price-protection item (the protection lived in bytecode the
  deployer code hashes pin). Tasks of older Factories are never re-verified.
- **Keeper (Decision 0121).** `execute()` has the same selector in both generations; the
  simulation decodes with the v3 executor errors plus the v2 protection errors plus the escrow's.
  Refusal families: `principal` (`LockedPrincipalInsufficient`), `legacy_price_protection`
  (`ReferenceUnavailable` / `SpotOutsideProtection` / `OutputBelowProtection`, v2 only),
  `interval`, `budget`, `paused`, `not_keeper`, `not_graduated`, `other` (`NoOutput` →
  `LAUNCH2_BUYBACK_NO_OUTPUT`, `PartialFill`, `RecipientBalanceMismatch`, unknown). The
  `price_protection` family is gone.

## 2. Buyback ledger and live state

- `launch2_buybacks.min_meme_out / reference_price_e18 / spot_price_e18` are nullable (no
  default); a v3 event stores all three null, a v2 event all three set (check
  `launch2_buybacks_protection_shape`). `GET …/buybacks` items: `minMemeOut`,
  `referencePriceUsd1`, `spotPriceUsd1` are `decimal | null` (null = v3).
- `live.nextOrderBlockedReason` (null = can run now), computed from one block:

| Value                             | When                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUYBACK_PAUSED`                  | executor paused                                                                                                                              |
| `BUYBACK_NOT_GRADUATED`           | read model not graduated                                                                                                                     |
| `BUYBACK_NO_BUDGET`               | `amountIn = 0`                                                                                                                               |
| `BUYBACK_TOO_SOON`                | v3, `executable = false`, block time < `lastSuccessfulAt + 10`                                                                               |
| `BUYBACK_PRINCIPAL_INSUFFICIENT`  | v3, `executable = false` and none of the above (official-pool USD1 principal < 10,000 or the order > 1 % of it — the only precondition left) |
| `BUYBACK_QUOTE_UNAVAILABLE`       | v3, `quoteNextOrder()` unreadable                                                                                                            |
| `BUYBACK_LEGACY_PRICE_PROTECTION` | v2 only: the quote reverted (reference not ready) or `minMemeOut = 0`                                                                        |

`BUYBACK_PROTECTION_BLOCKED` and `BUYBACK_PRICE_SOURCE_UNAVAILABLE` are no longer produced.

## 3. Zero holders → public (requirer answer 10, replaces Decision 0120 §4 for v3)

- Publisher (`launch2_snapshot_publisher`): when the indexed holder set at the confirmed cutoff
  is empty and `ProjectNFT.totalMinted()` at the cutoff is 0 (Decision 0120's checks, unchanged):
  - **v3** — inserts a `launch2_snapshot_publications` row with `action = open_without_holders`
    (no members, zero root / dataHash, no signers or signatures, cutoff kept as evidence) **before**
    anything is signed; then simulates `openPublicWithoutSnapshot()` from the submitter (= the
    executor account unless `LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY` is set), estimates gas,
    reserves the nonce under the shared advisory lock (Hooks executor / publisher / keeper),
    records hash / nonce / raw bytes, sends, follows to `confirmed` at `confirmations` (12) on a
    canonical block. Same status machine and retry / blocking rules as a publication; reason code
    while it runs `LAUNCH2_SNAPSHOT_OPENING_WITHOUT_HOLDERS`. A reverted simulation is `failed`
    (`LAUNCH2_SNAPSHOT_CONTRACT_REVERTED`, detail e.g. `HoldersExist`; only `SnapshotNotReady` is
    retryable). Anyone may call the function: `rootPublishedAt() ≠ 0` before starting →
    `LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN`, no row; a reverted receipt after someone else opened →
    `failed` `LAUNCH2_SNAPSHOT_OPENED_BY_OTHER`.
  - **v2** — no such function: the Decision 0120 closure (`closed_no_holders`) as before.
- `launch2_event` lane indexes `PublicRoundOpenedWithoutHolders` (snapshots role) into
  `launch2_events`; the projection sets `opened_without_holders_at / _block / _tx` (never with a
  snapshot root, never on a v2 instance — check constraint). Stage: opened → `public`
  (`nextChangeAt` null), after hold / graduated. The contract sets `earlyRoundEndsAt =
openedAt`, so the chain stage of quotes / prepares agrees (no proof needed, sells open).
- `GET /v2/launch2/instances/{id}`: `snapshot.status` gains `opened_without_holders`;
  `snapshot.openedWithoutHolders: {openedAt, blockNumber, transactionHash} | null` (optional key,
  always present); `snapshot.publication` is the latest `publish_snapshot` attempt only (null for
  an opening); `earlyRoundEndsAt` = `openedAt`. `closed_no_holders`, `snapshot.closure`,
  `launch2_snapshot_closures` and the console `snapshotClosure` stay for one version
  (**deprecated**, v2 instances only). The console publication rows carry `action`;
  `memberCount` may be 0 and `signerAddresses` empty for an opening. A retry grant on an opened
  instance is `LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN`.

## 4. Fixed buyback recipient (requirer answer 9)

`LAUNCH2_BUYBACK_RECIPIENT` (API; dev `0x28816c4C4792467390C90e5B426F198570E29307`). Owner
`PUT hooks-config`, the operator `launch.config.save`, `GET …/signing-request` and
`POST …/hooks-deployments` refuse a config naming another address: `422 VALIDATION_FAILED`
`HOOKS_BUYBACK_RECIPIENT_FIXED` (operator path `OPS_BUYBACK_RECIPIENT_FIXED`). Not configured
→ `503 CAPABILITY_UNAVAILABLE` `HOOKS_BUYBACK_RECIPIENT_UNAVAILABLE` (operator `OPS_UNAVAILABLE`):
never a free-form recipient. Comparison is case-insensitive. `GET hooks-config` adds
`buybackRecipientFixed: true` and `fixedBuybackRecipient` (lower-case | null). The configHash
rules are unchanged (the recipient was already part of the request).

## 5. Reviewer rejections (requirer answer 7)

Reasons `incomplete_materials | name_or_ticker_conflict | buyback_recipient_invalid |
community_binding_mismatch | other`; `note` 1–500 characters after trim, required for `other`,
shown to the applicant. Same permission model as approval: console `launch.approve` (reviewer
only — platform administrator, acceptor, auditor 403), run as the bound LOOP user through the
Decision 0108 service (`launch.approve` ops grant on the project), `operationId` =
`Idempotency-Key`, the owner never rejects (`OPS_SELF_APPROVAL`), audit `….requested` /
`.decided` / `.failed` + `ops_audit`.

- **Config version** — `POST /admin/v1/launch/projects/{projectId}/versions/{version}/reject`
  `{configHash, reasonCode, note?}`: latest version, same hash (`OPS_VERSION_CONFLICT`), catalog
  approved (`OPS_LAUNCH_NOT_APPROVED`), editor / owner excluded, not yet approved or rejected
  (`OPS_LAUNCH_CONFIG_DECIDED`; approve now also refuses a rejected version). Approve and reject
  lock the version row `for update`; a trigger refuses the second decision as a backstop.
  `hooks_launch_config_rejections` (PK project + version, append-only). Owner: `GET hooks-config`
  `approval.status: rejected` + `approval.rejection {reasonCode, note, at}`; saving a new version
  resubmits it (`awaiting_approval`).
- **Catalog material** — `POST /admin/v1/launch/projects/{projectId}/reject`
  `{materialVersion, reasonCode, note?}`: status `submitted | in_review`
  (`OPS_LAUNCH_NOT_IN_REVIEW`), `material_version` CAS (`OPS_VERSION_CONFLICT`). Sets
  `review_status = rejected`, `review_reason_code`, a `launch_review_events` operator row and a
  `launch_project_rejections` row (append-only, unique per material version) in one transaction.
  **`rejected` is now applicant-editable** (`draft | returned | rejected`): edit = material
  version + 1, submit → `submitted`. `GET /v2/launch/projects/{id}` (owner) adds
  `rejection {reasonCode, note, at} | null`; `reviewReasonText` has sentences for the five codes
  and the rejected status sentence now says it can be resubmitted.
- Console projection: list / detail `project` adds `kind`, `materialVersion`, `rejection`
  (catalog), `latestRejection` (latest config version); stage `rejected`; `?kind=all|ido|launch2`
  (bound into the cursor only when not `all`); detail `versions[].rejection`,
  `projectRejections[]`. Console 422 reason codes `ADMIN_REJECTION_NOTE_REQUIRED`,
  `ADMIN_REJECTION_NOTE_INVALID`.

## Entities (migration 000066)

`launch2_instances.factory_generation` (+ back-fill, no default), `opened_without_holders_*`
(+ shape check); `launch2_events.event_name` admits `PublicRoundOpenedWithoutHolders`;
`launch2_buybacks` protection columns nullable (+ all-or-none check);
`launch2_snapshot_publications.action` (+ per-action shape check replacing the column checks);
`launch_project_rejections`, `hooks_launch_config_rejections` (append-only triggers, single
decision trigger on approvals / rejections). Both new tables are in `schema.ts`; `dev:reset-users`
deletes rejections of doomed versions / reviewers. Down refuses while any v3 / rejection evidence
exists.

## Errors / unavailable

New V2 reason codes: `HOOKS_BUYBACK_RECIPIENT_FIXED` (422), `HOOKS_BUYBACK_RECIPIENT_UNAVAILABLE`
(503). New ops codes `OPS_BUYBACK_RECIPIENT_FIXED` (422), `OPS_LAUNCH_NOT_IN_REVIEW`,
`OPS_LAUNCH_CONFIG_DECIDED` (409). Lane / publisher / keeper codes:
`LAUNCH2_SNAPSHOT_OPENING_WITHOUT_HOLDERS`, `LAUNCH2_SNAPSHOT_OPENED_BY_OTHER`,
`LAUNCH2_BUYBACK_NO_OUTPUT`. No new capability.

## Evidence

- Unit: `test/launch2-generation.test.ts` (ABI pins, legacy list parsing, known-hash tagging,
  stage, `nextOrderBlockedReason`), `test/launch2-chain-generation.test.ts` (per-role decode of
  both `BuybackCompleted`, the opening event, both quote shapes), `test/launch2-snapshot-publisher.test.ts`
  (v3 opening: row first, open call signed, confirmed, done after indexing; other opener; `HoldersExist`;
  v2 closure), `test/launch2-buyback-keeper.test.ts` (families), `test/v2-launch2-routes.test.ts`
  (opened → public + quotable; v2 closure; nullable buyback fields; legacy blocked reason),
  `test/v2-hooks-launch-routes.test.ts` (422 / 503 / rejection read), `test/hooks-launch-review.test.ts`,
  `test/admin-role-routes.test.ts` (reject routes: role gate, note rule, owner, replay, audit;
  `?kind=`), `test/launch-contract.test.ts`, `test/config.test.ts`, `test/openapi.test.ts`.
- Integration: `test/launch2-creator-followups.integration.test.ts` (opening fact / v2 refusal /
  shapes, nullable ledger columns, `open_without_holders` rows, config + catalog rejection flows,
  single decision, append-only, console stage / kind), anvil suites on the v3 build:
  `launch2-buyback-keeper-anvil` (no `record()` feeding: executable right after graduation, three
  orders, null protection columns, `BUYBACK_TOO_SOON` between orders, legacy Factory entry
  registers nothing), `launch2-snapshot-publisher-anvil` (zero-holder sale opened by the
  publisher, lane → `public`, buy quote without proof).
- No BSC Testnet run.

## Open (for the coordinator)

1. Dev switch: set `HOOKS_LAUNCH_FACTORY_ADDRESS/CODE_HASH` to the third Factory,
   `LAUNCH2_LEGACY_FACTORIES=v2:0x6A69bA7a5A71C114301E20eF95f62Cd83d07D9c0` (and the S127
   Factory if any of its instances matter) and `LAUNCH2_BUYBACK_RECIPIENT` in
   `ops/api-dev.local.env` (not changed by this batch). Saved drafts were hashed for the old
   Factory (`HOOKS_FACTORY_TEMPLATE_MISMATCH` only when the sale period differs; the EIP-712
   domain binds the Factory address, so old signatures never verify on the new one).
2. The catalog review still has no console **approve** (only `pnpm launch:review`); the console
   can reject catalog material but approving it stays a CLI step. A console approve/return pair
   needs a product decision.
3. `community_binding_mismatch` exists as a reason although the project still has no LOOP
   community binding field (Decision 0120 open 2).
4. A rejected catalog project keeps its Hooks config versions; nothing ties a config rejection
   to the catalog status or vice versa.
5. Old drafts naming another recipient are refused at signing / submission; the owner has to
   save a new version (and get it approved again). Existing approved-but-not-deployed versions
   with another recipient are effectively dead.
6. `test/hooks-launch-protocol-abi.test.ts` compares the committed ABI with
   `loop-contracts/protocol/out`; at the S145 baseline that build was stale (pre-S144) and the test
   failed. The main checkout was rebuilt at `122163d` during this batch; the generated module
   matches it (`pnpm hooks:abi-sync --check`) and the test passes with or without
   `LOOP_PROTOCOL_DIR`.
