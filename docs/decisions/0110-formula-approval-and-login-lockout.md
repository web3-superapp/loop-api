# Decision 0110: Mining formula approval separation and per-username login lock (S129)

- Status: Accepted (S129-api), Development / BSC Testnet
- Date: 2026-10-10
- Baseline: `integration/v2` = `ccaeae9`
- Inputs: main-agent S129 task; Decision 0109 §7 open questions 2 and 3;
  Decisions 0046 (formula versions), 0102 / 0105 (console, login hardening),
  0109 (console roles).
- Scope: migrations `000056_formula_draft_author` and
  `000057_admin_login_attempts`; one new permission (`formula.approve`);
  two new reason codes; additive response fields on the formula version
  object; `detailsSafe.scope` on `ADMIN_LOGIN_LOCKED`; five new environment
  keys with defaults. No `/v1` or `/v2` change, no new route, no status code
  change.

## Context

After S128 the mining formula was still a one-person change: the platform
administrator (`console.write`) could save a draft and approve it. And the
console login lock (Decision 0105) was one counter per process: five wrong
passwords on any name locked every account for 15 minutes, and a restart
or a second instance reset or split it.

## Entities and stable IDs

| Entity          | Key                                             | Notes                                                                                                                                                                               |
| --------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formula version | `mining_formula_versions.config_version` (0046) | New: `draft_author_kind` (`admin_account` / `admin_bootstrap`), `draft_author` (display), `draft_author_account_id`; `approved_by`, `approved_by_account_id`. Set once.             |
| Draft author    | `draft_author_account_id` = `admin_accounts.id` | Null for the bootstrap administrator (kind `admin_bootstrap`) and for every version saved before 000056 or by a script (all three columns null = author unknown).                   |
| Approver        | `approved_by_account_id` = `admin_accounts.id`  | Always a console account (reviewer). Null for script approvals and older rows. No foreign key (like `admin_audit_log.actor_account_id`; accounts are never deleted).                |
| Login bucket    | `admin_login_attempts (scope, subject_key)`     | `scope = username`: lower-cased login name, or the shared `~malformed` key for text no account name can be. `scope = ip`: IPv4, or IPv6 /64 prefix, or `unknown`. Not a fact table. |

The login name is not an identifier of anything; it is only a throttling
key. Typed text that cannot be an account name is never stored.

## 1. Formula approval

| Permission        | platform_admin |     reviewer      | testnet_acceptor |    auditor     | Routes                                         |
| ----------------- | :------------: | :---------------: | :--------------: | :------------: | ---------------------------------------------- |
| `console.write`   |       ✓        |                   |                  |                | formula draft (= submit), withdraw (unchanged) |
| `formula.approve` |                |      ✓ (new)      |                  |                | `POST /mining/formula-versions/{v}/approve`    |
| formula list      | `console.read` | `formula.approve` |                  | `console.read` | `GET /mining/formula-versions` accepts either  |

- The approve route's guard changes from `console.write` to
  `formula.approve`; the service checks it again and requires an account
  session (the bootstrap administrator has no account ID and no
  `formula.approve`).
- No role holds both `console.write` and `formula.approve` (unit test).
  `formula.approve` is console-only: it is not an ops grant, so it is not
  scoped by `projectIds` and does not depend on the reviewer's
  `ops_operators.enabled` (see §6).
- Saving a draft stores its author (immutable, trigger). Approval, on the
  row-locked draft inside the approving transaction:
  - author unknown → 409 `ADMIN_CONFLICT` / `ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`
    (the draft must be saved again — use it as `baseVersion` of a new
    draft; the old one can be withdrawn);
  - author account = approver account → 403 `PERMISSION_DENIED` /
    `ADMIN_FORMULA_SELF_APPROVAL`;
  - otherwise the existing Decision 0046 semantics, plus `approved_by*`.
- The database enforces the same: `mining_formula_versions_separation_check`
  (an approver account requires a known author and differs from the author
  account), `…_approved_by_check` (approver only on a non-draft with
  `approved_at`), `…_draft_author_check` (column shapes), and the
  `mining_formula_versions_author_guard` trigger (author set only on insert;
  approver immutable once set).
- Audit lines (Decision 0105 / 0109 pattern): `mining.formula.approve.requested`
  is written before the approval runs (cannot be written → 503
  `ADMIN_AUDIT_UNAVAILABLE`, nothing approved); the approving transaction
  writes `mining.formula.approve` (the existing action name, kept so earlier
  audit filters keep working) with `draftAuthor`, `approvedBy`,
  `requestedAuditId`; a refusal writes `mining.formula.approve.failed` with
  the `reasonCode`. All three carry the reviewer's `actorAccountId`.
- The `pnpm mining:approve-formula` CLI (Decision 0046) is the deployment
  channel and is unchanged; it does not set `approved_by` (§6).

State machine (unchanged): `pending_approval → approved → retired`,
`pending_approval → retired` (withdraw).

## 2. Login lock

Replaces the Decision 0105 per-process global lock.

| Bucket   | Counts                                                                                                                              | Lock                                              | Reset                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| username | consecutive failures of the lower-cased name (`ADMIN_LOGIN_USERNAME_MAX_FAILURES`, default 5)                                       | `ADMIN_LOGIN_USERNAME_LOCK_SECONDS` (default 900) | success deletes the bucket; lock expiry; 24 h idle                                                                        |
| ip       | failures in a fixed window from the first one (`ADMIN_LOGIN_IP_MAX_FAILURES` in `ADMIN_LOGIN_IP_WINDOW_SECONDS`, default 50 in 900) | `ADMIN_LOGIN_IP_LOCK_SECONDS` (default 900)       | window or lock expiry; 24 h idle. A success refunds only its own reservation (one valid account cannot clear an address). |

- Every attempt (after the shape check and the per-instance single flight)
  runs one transaction that row-locks both buckets in a fixed order,
  refuses when either is locked (423, nothing counted), and otherwise
  reserves one failure in both. The reservation that reaches a maximum sets
  the lock at once, so concurrent attempts on other instances are refused
  while it is being verified; a success or a refunded attempt lifts it.
  Database clock throughout.
- After argon2: wrong → the reservation stays (and the lock is refreshed to
  a full period from now); right → username bucket deleted, IP refunded;
  no verdict (account lookup error, argon2 busy) → both refunded.
- 423 `ADMIN_LOGIN_LOCKED` (status and code unchanged) now carries
  `detailsSafe: {scope: "username" | "ip", retryAfterSeconds}` and the same
  `Retry-After`. When both are locked, the longer one is named (tie:
  username).
- The per-instance single flight and the two argon2 slots (Decision 0105)
  stay: they bound memory, not guesses.
- The client address is Fastify's `request.ip` (trusting only the local
  cloudflared hop when `TRUST_PROXY=true`, Decision 0082 setup). IPv6 is
  keyed by /64 so one end site cannot rotate addresses.
- Audit: `session.login_failed` gains `lockScope`, `username` (only when it
  is an existing account or the bootstrap name, else null), `accountId`,
  `sourceIp`, `usernameFailures`, `ipFailures`; a new
  `session.login_locked` row is written for each bucket a failure locks
  (`scope`, `retryAfterSeconds`, `failures`, `username`, `accountId`,
  `sourceIp`). Attempts refused while locked are not audited (they cost
  nothing and would flood the log).
- Without a database (bootstrap administrator only) the same transitions
  run in an in-process store.

## 3. Error codes

| Code                     | HTTP | When (`detailsSafe`)                                                                                    |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED`      | 403  | `ADMIN_ROLE_FORBIDDEN` + `permission: formula.approve`; `ADMIN_FORMULA_SELF_APPROVAL` (new)             |
| `ADMIN_CONFLICT`         | 409  | `ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN` (new); `ADMIN_FORMULA_STATE_INVALID`                               |
| `ADMIN_LOGIN_LOCKED`     | 423  | `{scope, retryAfterSeconds}` (scope new)                                                                |
| `CAPABILITY_UNAVAILABLE` | 503  | `ADMIN_AUDIT_UNAVAILABLE` (approve intent row); `ADMIN_DATABASE_UNAVAILABLE` (login buckets unreadable) |

## 4. Unavailable behaviour (fail closed)

- Login buckets cannot be read or written → 503
  `ADMIN_DATABASE_UNAVAILABLE`, no password is verified. A failure that
  cannot be recorded after the verdict is still 401 (the reservation was
  already counted); a success that cannot clear the bucket still logs in
  (logged).
- Approval intent row cannot be written → 503, nothing approved.
- `NODE_ENV=production` → approval still 503
  `MINING_APPROVE_FORBIDDEN_IN_PRODUCTION` (checked after the role).

## 5. Deviations from the task text

| #   | Task                                      | Implemented                                                                                          | Why                                                                                                                  |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | "新增权限 formula.approve" (only that)    | Also opened `GET /mining/formula-versions` to `formula.approve`                                      | A reviewer has no `console.read`; without it the approver cannot see what they approve.                              |
| 2   | Self-approval error code not specified    | 403 `PERMISSION_DENIED` / `ADMIN_FORMULA_SELF_APPROVAL`                                              | Same shape as `OPS_SELF_APPROVAL` (Decision 0109).                                                                   |
| 3   | "所有写操作保持现有 Idempotency-Key 约定" | The approve route still takes no `Idempotency-Key`                                                   | That is the existing convention for this route (Decision 0109 §6 #2); a replay is 409 `ADMIN_FORMULA_STATE_INVALID`. |
| 4   | Draft author "账号 id"                    | Kind + display name + account ID; bootstrap drafts are `admin_bootstrap` with null ID and approvable | The bootstrap administrator has no account ID but is a known, different person from any reviewer.                    |
| 5   | IP lock "同一 IP"                         | IPv6 keyed by /64                                                                                    | A single IPv6 host usually controls a whole /64.                                                                     |

## 6. Open questions (for the main agent)

1. `pnpm mining:approve-formula` (deployment CLI) still approves any draft
   without author or approver records. Keep it as the break-glass path, or
   require `--approver-account` and the same separation?
2. A reviewer created with `projectIds` (scoped to some launch projects)
   still gets the global `formula.approve`. Should formula approval require
   an unscoped reviewer, or a separate role?
3. `formula.approve` does not check the reviewer's ops operator
   (`ops_operators.enabled`); disabling the operator by CLI only blocks
   launch reviews. Disabling the console account blocks both.
4. There is no console route to unlock a name or address early; an
   operator can delete the `admin_login_attempts` row. Add
   `POST /accounts/{id}/unlock` for platform_admin?
5. The IP bucket is only meaningful when `request.ip` is the real client:
   `TRUST_PROXY=true` behind the local cloudflared (set in
   `ops/api-dev.env`). If staging runs another proxy topology without it,
   every login shares one address bucket (50 failures from anyone would
   lock everyone for 15 minutes). Staging's value was not verified here.

## Verification

- Unit: `test/admin-login-attempts.test.ts` (keys, per-name lock without
  touching another name, success clears, cancel refunds the provisional
  lock, IP lock across names and its window, success does not reset the
  IP count, `ADMIN_LOGIN_*` defaults / overrides / range),
  `test/admin-formula-login-migration.test.ts`, `test/admin-roles.test.ts`
  (edit ≠ formula approve).
- Route: `test/admin-routes.test.ts` (per-name lock with
  `detailsSafe.scope`, another name not locked, audit rows; bootstrap
  administrator drafts with `draftAuthor` and is 403 on approve),
  `test/admin-role-routes.test.ts` (role matrix incl. formula draft /
  withdraw / list / approve; reviewer approves another's draft with
  `approvedBy` and two audit rows; own draft 403; unknown author 409 with
  `.failed` rows; production 503; per-name and per-IP locks via
  `remoteAddress`).
- Contract: regenerated `openapi/loop-admin.v1.json`; `test/openapi.test.ts`.
- Integration (throwaway database from `loop_api_test_s129`):
  `test/admin-formula-approval-lockout.integration.test.ts` — head
  000057; platform_admin (table and bootstrap) refused; reviewer approves
  platform_admin's draft, refused on their own, another reviewer approves
  it; unknown author 409; author cannot be set later; the database refuses
  approver = author; account A locked after 5 failures across two service
  instances while B logs in from the same address; success clears the
  name bucket; 50 failures from one address lock it on both instances and
  are audited without the sprayed names. `test/admin-console.integration.test.ts`
  now approves as a reviewer and expects the new audit rows.
