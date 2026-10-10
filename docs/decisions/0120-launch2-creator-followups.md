# Decision 0120: MEME v2 creator follow-ups — resumable creator flow, product kind, wallet-ready typed data, no-holder closure, snapshot retry grant (S142)

- Status: Accepted (S142-api), Development / BSC Testnet only
- Date: 2026-10-10
- Baseline: `integration/v2` = `0ac6a5b`
- Inputs: loop-mobile Decision 0138 (S135 creator pages, open items 1, 2, 3, 5, 6),
  Decision 0139 (S136 user pages), `LOOP/docs/modules/S134-S137-meme-v2-app.md` §3,
  Decision 0118 Open 3 (zero NFT holders) and Open 4 (operator action for a blocked
  publication), Decisions 0108 / 0109 / 0112 / 0114 / 0117 / 0119.
- Scope: migration `000064_launch2_creator_followups`; additive fields on
  `GET /v2/launch/projects/{projectId}/hooks-config`, `GET|POST /v2/launch/projects`,
  `GET /v2/launch/projects/{projectId}/hooks-config/signing-request`,
  `GET /v2/launch2/instances/{id}`, `GET /admin/v1/launch/projects/{projectId}`; one new
  console route `POST /admin/v1/launch/projects/{projectId}/snapshot/retry`; a new launch2
  stage `closed_no_holders`. No `/v1` change, no new worker lane, no new env.

## Why

The S135 App could not resume the creator flow after a cold start (no way to read the
approval state, the running deployment task, or the earliest sale start), could not list
only MEME v2 projects, and had to patch the EIP-712 payload before handing it to Privy.
On the publisher side, Decision 0118 left two dead ends: a sale with zero NFT holders stays
`snapshot_pending` forever, and a non-retryable `failed` / `mismatch` publication blocks the
instance until someone writes SQL.

## 1. Resumable creator flow (`GET hooks-config`)

The read response gains three required keys (the `draft` object is unchanged):

- `approval`: `null` without a draft; else `{configVersion, status, approvedAt}`, `status`
  `approved` only when `hooks_launch_config_approvals` holds the draft's version **with the
  same configHash** (the submission gate's rule, Decision 0108), otherwise
  `awaiting_approval`. There is no reject state in the review model and the approver's note
  is not exposed (see Open).
- `latestDeployment`: the newest `hooks_launch_deployment_tasks` row of the project for the
  owner (any version, any status), projected exactly like
  `GET hooks-deployments/{jobId}`; `null` when none. The id comes from the config repository
  (`getOwnedProgress`), the projection from the submission repository, so a missing row is
  `null`, never invented.
- `minSaleLeadSeconds`: `HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS` (Decision 0117, 4,200–2,592,000).

Unavailable behaviour unchanged: no config repository → `503 HOOKS_LAUNCH_DISABLED`; a
failing submission store surfaces through the existing submission error mapping.

## 2. Catalog product kind (`launch_projects.kind`)

- Column `kind text not null default 'ido'` check `ido | launch2`; index
  `(owner_user_id, kind, created_at desc, project_id desc)`.
- Set by `POST /v2/launch/projects` with optional `kind` (absent = `ido`; part of the
  idempotency digest only when `launch2`, so `ido` digests are byte-identical to before), and
  by an `after insert` trigger on `hooks_launch_project_config_versions` (owner save and
  operator `launch.config.save` alike). Back-filled to `launch2` for projects that already
  have a config version. Nothing sets it back to `ido`; `PUT /v2/launch/projects/{id}` does
  not accept it.
- `GET /v2/launch/projects?kind=all|ido|launch2` (default `all`); a non-`all` kind is bound
  into the cursor filter (`all` keeps the pre-0120 binding, so old cursors stay valid).
- Every `project` projection carries `kind`.

## 3. Wallet-ready typed data

`typedData.types` of the signing request now lists the standard
`EIP712Domain` (`name string, version string, chainId uint256, verifyingContract address`)
before `LaunchRequest`. Wallet RPCs (`eth_signTypedData_v4`, Privy `provider.request`) can
take the object as is. The digest is unchanged (every EIP-712 implementation derives the same
domain type from the four-field domain); the submission still verifies against the
server-built typed data. Local signers (viem / ethers) given the explicit type need a bigint
`chainId`; the tests do that.

## 4. No-holder closure (stage `closed_no_holders`)

When the publisher reaches a candidate whose indexed holder set at the confirmed cutoff is
empty — i.e. after the existing cutoff-confirmation and indexer-caught-up waits — it reads
`ProjectNFT.totalMinted()` at the cutoff block. Non-zero → `LAUNCH2_SNAPSHOT_INDEXER_INCOMPLETE`
(never a closure). Zero → it inserts one immutable `launch2_snapshot_closures` row
(`instance_id` PK, chain, `reason = no_holders`, snapshots address, sale end, cutoff block /
hash, `total_minted = 0`) and returns `LAUNCH2_SNAPSHOT_CLOSED_NO_HOLDERS`. Closed instances
are no longer publisher candidates.

`deriveLaunch2Stage`: sale over, no `SnapshotPublished`, closure present →
`closed_no_holders`, `nextChangeAt = null` (terminal); an integrity hold still wins. The
launch2 lane and the read service pass `closedNoHolders`; the live stage used by quotes /
prepares maps "early round never started + closure" to `closed_no_holders`, so they answer
`409 DATA_STALE / LAUNCH2_STAGE_MISMATCH` (`detailsSafe.stage`). `GET /v2/launch2/instances/{id}`
adds required `snapshot.closure: {reason: "no_holders", cutoffBlock, closedAt} | null`; the
console detail adds `snapshotClosure` (with the cutoff hash and sale end).

## 5. Snapshot retry grant (console)

`POST /admin/v1/launch/projects/{projectId}/snapshot/retry` — `console.write` (platform
administrator only; reviewers / acceptors / auditors 403), `Idempotency-Key` = `releaseId`,
body `{reason}` (1–500 chars trimmed). In one transaction: replay the key (same project,
reason and actor → `replayed: true`; otherwise `ADMIN_IDEMPOTENCY_CONFLICT`), lock the
project's latest instance and its latest publication attempt N, and append an immutable
`launch2_snapshot_publication_releases` row (`released_attempt` unique per instance) when
attempt N is `failed` or `mismatch`. The publisher's candidate query then ignores attempts
≤ max(released_attempt) for blocking, the retryable-failure budget and the retry delay, so
its next tick starts attempt N + 1 from the chain. The released rows stay untouched. The
route signs and sends nothing.

Refusals (`ADMIN_CONFLICT` unless noted, `detailsSafe.reasonCode`):
`ADMIN_LAUNCH_PROJECT_NOT_FOUND` / `LAUNCH2_INSTANCE_NOT_FOUND` (404 `NOT_FOUND`),
`LAUNCH2_SNAPSHOT_NOTHING_TO_RETRY`, `LAUNCH2_SNAPSHOT_NOT_RETRYABLE` (+ `status`),
`LAUNCH2_SNAPSHOT_ALREADY_RELEASED` (also the loser of a concurrent grant),
`LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN` (root indexed), `LAUNCH2_SNAPSHOT_CLOSED_NO_HOLDERS`,
`ADMIN_IDEMPOTENCY_CONFLICT`. Audit: `launch.snapshot.retry.requested` first (cannot be
written → 503 `ADMIN_AUDIT_UNAVAILABLE`, nothing runs), then `.decided` or `.failed`. The
console detail adds `snapshotReleases[]` (newest first, ≤ 200).

## Entities (migration 000064)

- `launch_projects.kind` + trigger `hooks_config_version_marks_launch2`.
- `launch2_instances.stage` check admits `closed_no_holders`.
- `launch2_snapshot_closures` (PK `instance_id`), `launch2_snapshot_publication_releases`
  (PK `release_id` opaque UUIDv4; unique `(instance_id, released_attempt)`): both append-only
  (update / delete raise), both in `schema.ts`, both deleted with doomed instances by
  `dev:reset-users`. Down refuses while any closure / release / closed stage exists.
  Addresses are facts, never keys.

## Errors / unavailable

No new V2 error code. New console reason codes listed in §5. Publisher reason code
`LAUNCH2_SNAPSHOT_CLOSED_NO_HOLDERS` (logged). Missing chain / signer configuration keeps
the publisher idle as in Decision 0118, so no closure can be recorded without a chain read.

## Evidence

- Unit / route: `test/v2-hooks-launch-routes.test.ts` (approval, latest task = direct read,
  lead, missing task → null, EIP712Domain in typed data), `test/hooks-launch-deployment-crypto.test.ts`
  (digest unchanged with the explicit domain type), `test/v2-launch-routes.test.ts` (create /
  list by kind, digest, cursor binding), `test/launch2-stage.test.ts`,
  `test/launch2-snapshot-publisher.test.ts` (closure only when chain says 0, once, not before
  confirmation / catch-up), `test/v2-launch2-routes.test.ts` (closed stage, `snapshot.closure`,
  quote 409), `test/admin-role-routes.test.ts` (platform admin only, audit trail, replay,
  conflicts, detail fields), `test/openapi.test.ts`.
- Integration (PostgreSQL): `test/launch2-creator-followups.integration.test.ts` (kind create /
  filter / check, closure immutability and candidate exclusion, read model + lane flag, grant
  conflicts / replay / budget release, concurrent grants), `test/hooks-launch-repositories.integration.test.ts`
  (progress read, trigger marks `launch2`). Anvil suites updated for the explicit domain type.
- No BSC Testnet run.

## Open (for the coordinator)

1. The review model has no reject state and the approver's `reason` is an operator note; the
   App's 等审核页 can show `awaiting_approval` / `approved` only. Exposing reviewer comments or
   adding a reject decision needs a product rule (who writes the applicant-facing text).
2. "社区绑定" (0138 open 4) is still four `links`; no LOOP community binding field.
3. `closed_no_holders` is terminal on the API side; whether the project may relaunch (new
   catalog project or a new config version on the same project) is a product question.
   The contracts keep the unsold MEME in the curve; no refund path exists because nothing was
   paid.
4. A retry grant does not re-sign or bump gas by itself; if the cause (signer key, contract
   state) is not fixed, the next attempt fails the same way and needs another grant.
5. EIP-712 first signature with Privy on a real device (0138 open 6) still needs a run.
