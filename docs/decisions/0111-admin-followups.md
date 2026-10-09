# Decision 0111: Operator console follow-ups — CLI approval trail, account unlock, operator disabled with the account (S130)

- Status: Accepted (S130-api), Development / BSC Testnet
- Date: 2026-10-10
- Baseline: `integration/v2` = `2347672`
- Inputs: main-agent S130 task; Decision 0110 §6 open questions 1, 3, 4;
  Decisions 0036 / 0046 (formula versions, approval CLI), 0108 (ops
  operators), 0109 (console accounts), 0110 (formula approval separation,
  login buckets).
- Scope: migration `000058_admin_followups` (two check constraints, no new
  table or column); one new `/admin/v1` operation
  (`POST /accounts/{accountId}/unlock`, 30 operations in
  `openapi/loop-admin.v1.json`); two read-only fields on the account object
  (`locked`, `lockedUntil`); one new reason code
  (`ADMIN_OPERATOR_DISABLED`); the `pnpm mining:approve-formula` arguments.
  No `/v1` or `/v2` change, no new environment key, no status code change
  on an existing route.

## Entities and stable IDs

| Entity            | Key                                                                | Change                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formula version   | `mining_formula_versions.config_version`                           | `approved_by` may be `cli:<name>` with `approved_by_account_id = null` (CLI approval). A console approval keeps name + account ID. Still set once (000056 trigger).           |
| CLI approver      | none (a label, `--approved-by`, `[A-Za-z0-9._@-]{1,60}`)           | Not an identifier: who was on duty, for the trail. Never a key; the audit row carries it in `after.approvedBy`.                                                               |
| Login-name bucket | `admin_login_attempts (scope='username', subject_key=lower(name))` | Deleted by the unlock route. Read (not stored) as `lockedUntil` on the account object. IP buckets are never touched by it.                                                    |
| Account command   | `admin_account_commands.idempotency_key`                           | New action `account.unlock` (same claim / fingerprint / replay rules as Decision 0109).                                                                                       |
| Ops operator      | `ops_operators.user_id` (Decision 0108)                            | Unchanged table. Disabling a reviewer / testnet acceptor account already set `enabled=false` through the 0108 bootstrap (S128); formula approval now also requires `enabled`. |

## 1. `pnpm mining:approve-formula` (break-glass channel)

```sh
pnpm mining:approve-formula <configVersion> --confirm \
  --approved-by <name> --reason "<text>" [--i-know-this-bypasses-review]
```

| Check (in order)                                                     | Refusal (`stderr`, exit 1)                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| one version argument, valid options, no repeats                      | `mining_approve_arguments_invalid`                              |
| `--approved-by` present                                              | `mining_approve_approver_required`                              |
| name `[A-Za-z0-9._@-]{1,60}` (so `cli:<name>` ≤ 64)                  | `mining_approve_arguments_invalid`                              |
| `--reason` present and not blank                                     | `mining_approve_reason_required`                                |
| reason ≤ 500 code points, no control / format characters             | `mining_approve_arguments_invalid`                              |
| `--confirm`                                                          | `mining_approve_confirmation_required`                          |
| `NODE_ENV=production` needs `--i-know-this-bypasses-review`          | `mining_approve_forbidden_in_production` (no connection opened) |
| `DATABASE_URL`                                                       | `mining_approve_database_unconfigured`                          |
| version exists / is `pending_approval`                               | `mining_approve_not_found` / `mining_approve_state_invalid`     |
| approver ≠ draft author (by name, case-insensitive, `cli:` stripped) | `mining_approve_self_approval`                                  |

- One transaction (row-locked version): retire the approved version,
  approve this one (`effective_at = approved_at = now`), set
  `approved_by = 'cli:<name>'`, `approved_by_account_id = null`, and insert
  `admin_audit_log` `mining.formula.approve` with actor `cli`,
  `actor_account_id = null`, `target_type = mining_formula_version`,
  `after = {configVersion, status, effectiveAt, retiredVersion,
channel: "cli", draftAuthor, approvedBy: "cli:<name>", reason, bypass}`.
  The audit row and the approval commit together or not at all.
- A refusal after the arguments (not found / state / self) writes
  `mining.formula.approve.failed` (actor `cli`, `after.reasonCode`) on a
  best-effort basis.
- `bypass` is `true` only with `NODE_ENV=production` (the console refuses
  approval there, so the CLI skips the reviewer gate); the switch has no
  effect elsewhere.
- The database repeats the rules: `mining_formula_versions_approved_by_check`
  now allows exactly two shapes — console (`name`, account ID) or CLI
  (`cli:<name>`, null account ID) — and refuses a CLI name equal to
  `'cli:' || lower(draft_author)`.
- The CLI keeps approving drafts without a recorded author (the
  `pnpm mining:dev-baseline` version is made by a script), unlike the
  console (409 `ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`). It does not apply
  `community_weights` (unchanged Decision 0046 behaviour of the script).
- The console list shows `approvedBy: null` for a CLI approval (its schema
  requires an account ID); the CLI name is in the audit row.

## 2. `POST /admin/v1/accounts/{accountId}/unlock`

- Permission `accounts.manage` (platform_admin). UUIDv4
  `Idempotency-Key` required. Body `{"reasonCode": "^[a-z][a-z0-9_]{0,63}$"}`.
- One transaction: claim the key (advisory lock + command row), row-lock
  the account, delete `admin_login_attempts` where `scope = 'username'` and
  `subject_key = lower(username)`, write `account.unlock` to
  `admin_audit_log` (`before`: `failureCount`, `locked`, `lockedUntil`;
  `after`: `locked: false`, `reasonCode`, `idempotencyKey`).
- IP buckets are not cleared: they count every name tried from an address
  and are not one account's to release.
- No bucket → 200 `changed: false`, `audit: null` (command row still
  written, so the key replays). Exact replay → 200 `replayed: true`,
  `changed: false`, `audit: null`, the account as it is now. Same key with
  another body or actor → 409 `ADMIN_IDEMPOTENCY_CONFLICT`.
- Unlocking a bucket that is not locked yet (failures below the limit) also
  clears it (`changed: true`, audited).
- `{accountId}` = `bootstrap` or the `ADMIN_USERNAME` name (any case) → 409
  `ADMIN_ACCOUNT_ENVIRONMENT`: the environment administrator has no
  account ID; its bucket expires by itself (15 min) or is cleared by the
  deployment operator in the database. Disabled account → 409
  `ADMIN_ACCOUNT_DISABLED` (terminal). Unknown → 404.
- Self-unlock is allowed (the caller is logged in, so it proves nothing
  new; a name can be locked by someone else's guesses while its holder is
  logged in).
- Account objects (`GET /accounts` items and every account write response)
  gain `locked: boolean` and `lockedUntil: date-time | null`, read from the
  bucket when `locked_until > now()` (database clock).

## 3. Disabling an account disables its operator; formula approval checks it

- S128 already disabled the bound `ops_operators` row in the disable
  transaction through `provisionHooksLaunchOperator` (the Decision 0108
  bootstrap, `ops_audit` `operator.revoke`, source `admin_console`). S130
  keeps that and adds `operatorEnabledBefore` beside `operatorEnabled` in
  the `account.disable` audit row.
- New: formula approval (Postgres repository, inside the approving
  transaction) row-locks the approver's `admin_accounts` row and its
  `ops_operators` row `for share` and refuses with 403 `PERMISSION_DENIED`:
  - account missing or disabled → `ADMIN_ACCOUNT_DISABLED`;
  - operator missing or `enabled = false` → `ADMIN_OPERATOR_DISABLED`.
    Both write `mining.formula.approve.failed`. So revoking the operator with
    the deployment CLI (`pnpm hooks:operator --user <id> --revoke --confirm`) now stops
    formula approval too (Decision 0110 §6 question 3), and a request that
    passed the session check just before a disable cannot approve.
- The launch review already refused a disabled operator (0108
  `OPS_FORBIDDEN`, 403). Normally a disabled account never gets that far:
  its sessions end at once (401) and it cannot log in.
- A disabled account stays terminal (trigger, unchanged).

## Error codes (new or newly reachable)

| Code                     | HTTP | `detailsSafe.reasonCode`                                                            | Where                          |
| ------------------------ | ---- | ----------------------------------------------------------------------------------- | ------------------------------ |
| `PERMISSION_DENIED`      | 403  | `ADMIN_OPERATOR_DISABLED` (new), `ADMIN_ACCOUNT_DISABLED`                           | formula approve                |
| `PERMISSION_DENIED`      | 403  | `ADMIN_ROLE_FORBIDDEN` (`permission: accounts.manage`)                              | unlock, non-admin roles        |
| `ADMIN_CONFLICT`         | 409  | `ADMIN_ACCOUNT_ENVIRONMENT`, `ADMIN_ACCOUNT_DISABLED`, `ADMIN_IDEMPOTENCY_CONFLICT` | unlock                         |
| `NOT_FOUND`              | 404  | `ADMIN_ACCOUNT_NOT_FOUND`                                                           | unlock                         |
| `INVALID_REQUEST`        | 400  | `ADMIN_IDEMPOTENCY_KEY_REQUIRED` / schema                                           | unlock                         |
| `CAPABILITY_UNAVAILABLE` | 503  | `ADMIN_DATABASE_UNAVAILABLE`                                                        | unlock / list without database |

## Unavailable behaviour (fail closed)

- Unlock without a database → 503; a failed transaction leaves the bucket,
  the command row, and the audit row all unwritten.
- `lockedUntil` cannot be read → the account list / write fails 503 (it is
  read in the same query or transaction), never a guessed `false`.
- CLI: the approval and its audit row are one transaction; a refused-attempt
  row that cannot be written is skipped (best effort, the refusal stands).
- Formula approval when the operator row cannot be read → 503 (repository
  unavailable), nothing approved.

## Deviations from the task text

| #   | Task                                           | Implemented                                                                                         | Why                                                                                                             |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | `--approved-by <说明>` (free text)             | Account-name characters, 1–60 (`[A-Za-z0-9._@-]`): name romanised or staff number                   | Same alphabet as every actor column; `cli:<name>` fits the 64-char shape and the author comparison stays exact. |
| 2   | "作者为 cli: 同名时拒绝"                       | Refused when the name equals the draft author's name (console or `cli:`), case-insensitively        | No script writes a `cli:` author today; the console author name is the realistic collision.                     |
| 3   | Production: require the switch                 | The previous unconditional production refusal of the CLI is replaced by the switch                  | As asked. The console approve route stays 503 in production.                                                    |
| 4   | Unlock "幂等重放返回同一结果"                  | Replay returns `replayed: true`, `audit: null`, the account's current state (Decision 0109 pattern) | Same envelope as the other account writes; the first response's `audit` reference is in the audit log.          |
| 5   | §3 "同一事务把 ops_operators.enabled 置 false" | Already the case since S128; S130 adds the approval-time check and the audit field                  | The missing half was formula approval not looking at the operator.                                              |
| 6   | Account object adds `lockedUntil`              | Also `locked: boolean`                                                                              | The task's button rule names `locked: true`.                                                                    |

## Open questions (for the main agent)

1. The bootstrap administrator's own name bucket cannot be unlocked from
   the console. Acceptable (wait 15 minutes / database), or add a
   deployment CLI?
2. `GET /admin/v1/mining/formula-versions` shows `approvedBy: null` for CLI
   approvals. Add a `channel: "cli"` + name to the object (additive schema
   change) so the console can show who used the break-glass path?
3. A reviewer created with `projectIds` still gets the global
   `formula.approve` (Decision 0110 §6 question 2, unchanged here).

## Verification

- Unit: `test/s7-operator-scripts.test.ts` (CLI: missing approver / reason,
  invalid names and reasons, repeats, production switch and `bypass`,
  approval call shape, self-approval mapped and recorded),
  `test/admin-followups-migration.test.ts` (000058 shape, rollback guard,
  head).
- Route: `test/admin-role-routes.test.ts` — unlock: role table (403),
  missing key / bad body (400), bootstrap (`bootstrap`, `operator`,
  `OPERATOR`) 409, unknown 404, list shows `locked` / `lockedUntil`,
  unlock clears, exact replay, key reuse 409, nothing to clear, one audit
  row, disabled 409.
- Contract: regenerated `openapi/loop-admin.v1.json`;
  `test/openapi.test.ts`, `test/admin-role-contract.test.ts`.
- Integration (throwaway database from `loop_api_test_s130`):
  `test/admin-followups.integration.test.ts` — head 000058; CLI refuses
  without `--approved-by` / `--reason` / production switch and writes
  nothing; CLI approval stores `cli:oncall-07`, null account ID, one audit
  row (actor `cli`); CLI self-approval refused (script and database),
  `.failed` row; production with the switch → `bypass: true`; unlock
  after five failures: name bucket gone, IP count unchanged, login works,
  replay, key conflict, bootstrap 409, audit and command rows; disabling a
  reviewer sets `ops_operators.enabled=false` (audit
  `operatorEnabledBefore: true`, `operatorEnabled: false`, `ops_audit`
  `operator.revoke`), launch approve 403 `OPS_FORBIDDEN`, formula approve
  403 `ADMIN_ACCOUNT_DISABLED`; operator revoked by the deployment CLI
  alone → 403 `ADMIN_OPERATOR_DISABLED`; an active reviewer still
  approves. Existing suites updated for the CLI arguments and for
  reviewers that now need an enabled operator row.
