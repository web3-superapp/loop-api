# Decision 0109: Operator console role separation (S128)

- Status: Accepted (S128-api), Development / BSC Testnet
- Date: 2026-10-10
- Baseline: `integration/v2` = `a46592e`
- Inputs: `LOOP-整体方案` §7 (项目端 / 平台端; 编辑人、审批人、执行人权限分开，不以一个万能
  admin 替代); main-agent S128 design (roles, account table, routes);
  Decisions 0102 / 0105 (console, login hardening), 0108 (ops operators,
  grants, Hooks review service).
- Scope: migration `000055_admin_accounts`; 9 new `/admin/v1` operations
  (29 in total in `openapi/loop-admin.v1.json`); a role gate on every
  existing console route; one new console error code (`PERMISSION_DENIED`,
  403, category `authorization`); the session cookie format v2. No `/v1` or
  `/v2` change; no new environment key.

## Context

Until now the console had one administrator (`ADMIN_USERNAME`) who could do
everything, and the Hooks launch review from S125 (Decision 0108) existed
only as a service whose operators were created by a CLI. §7 asks for the
platform side to be split into independent people: an editor is not the
approver, the approver is not the executor, and no single "super admin"
does all of it. The project side (owner drafts, signing, deployment tasks)
stays in the App under `/v2/launch/projects/...` (Decision 0108) and is not
part of the console.

## Entities and stable IDs

| Entity                  | Key                                      | Notes                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console account         | `admin_accounts.id` (UUIDv4, opaque)     | `username` is a display/login name (unique case-insensitively), never a key. Role immutable. Never deleted; `disabled_at` is terminal.                                                               |
| Bootstrap administrator | — (environment)                          | `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH`; `accountId: null` everywhere. **Not stored in the table** (see §2).                                                                                        |
| Operator binding        | `admin_accounts.operator_user_id`        | reviewer / testnet_acceptor only (DB check); one **active** account per LOOP user (partial unique index), so one person cannot be reviewer and acceptor.                                             |
| Account command         | `admin_account_commands.idempotency_key` | UUIDv4 from the `Idempotency-Key` header; bound to actor + action + keyed request fingerprint. Append-only.                                                                                          |
| Launch review operation | `ops_operations.operation_id` (0108)     | = the `Idempotency-Key` of approve / testnet-acceptance (`acceptanceId` for an acceptance).                                                                                                          |
| Console audit row       | `admin_audit_log.audit_id` (0102)        | New column `actor_account_id` (null for the bootstrap administrator and anonymous rows); **no foreign key** — the log is never truncated and a key would pull it into `TRUNCATE loop_users CASCADE`. |
| Ops audit row           | `ops_audit.id` (0108)                    | New actor shape `admin_account` / `admin_console` with `admin_actor` (+ `admin_account_id`) for grants provisioned from the console.                                                                 |

## 1. Roles and permissions

A role is fixed when the account is created; permissions are derived from
the role only (`src/features/admin/admin-roles.ts`), never stored per
account.

| Permission        | platform_admin | reviewer | testnet_acceptor | auditor | Routes                                                                            |
| ----------------- | :------------: | :------: | :--------------: | :-----: | --------------------------------------------------------------------------------- |
| `console.read`    |       ✓        |          |                  |    ✓    | overview, settings GET, communities GET, mining GET, MEME GET                     |
| `console.write`   |       ✓        |          |                  |         | settings PUT, community review, mining draft/approve/withdraw, MEME listing/pause |
| `accounts.read`   |       ✓        |          |                  |    ✓    | `GET /accounts`                                                                   |
| `accounts.manage` |       ✓        |          |                  |         | `POST /accounts`, `/disable`, `/reset-password`                                   |
| `audit.read`      |       ✓        |    ✓     |        ✓         |    ✓    | `GET /audit`                                                                      |
| `launch.read`     |       ✓        |    ✓     |        ✓         |    ✓    | `GET /launch/projects`, `GET /launch/projects/{id}`                               |
| `launch.approve`  |                |    ✓     |                  |         | `POST /launch/projects/{id}/versions/{v}/approve`                                 |
| `testnet.read`    |       ✓        |          |        ✓         |    ✓    | (shown to the client; no route of its own yet)                                    |
| `testnet.accept`  |                |          |        ✓         |         | `POST /launch/projects/{id}/testnet-acceptance`                                   |

- No role holds two of edit (`console.write`), approve (`launch.approve`),
  accept (`testnet.accept`) — a unit test asserts it.
- The platform administrator (table account **and** the bootstrap one) has
  neither `launch.approve` nor `testnet.accept`.
- Bound roles derive their Decision 0108 `ops_grants`:
  reviewer → `launch.read`, `launch.approve`, `audit.read`;
  testnet_acceptor → `launch.read`, `testnet.read`, `testnet.accept`,
  `audit.read`. Optional `projectIds` (≤ 20) scopes every project
  permission to those projects ("按项目授权"); `audit.read` stays `*`
  (not project-scopable in 0108). No bound role ever gets `launch.edit`.
- Enforcement happens three times: the route's `onRequest` hook (403 before
  the body is parsed, so a refused role never sees a validation detail),
  the console service (`assertAdminPermission`), and for launch writes the
  Decision 0108 repository (row-locked operator + grant + self-approval
  checks as the bound LOOP user). `GET /session` publishes the permission
  list so loop-admin can hide buttons; hiding is cosmetic.

## 2. Accounts, bootstrap, login, sessions

- **Bootstrap choice: environment only, not upserted.** The
  `ADMIN_USERNAME` administrator keeps working exactly as before (role
  `platform_admin`, `accountId: null`), even without a database, so the
  console can always be recovered by whoever controls the deployment
  environment. It cannot be disabled or reset from the console; rotate the
  environment values instead. No account may take its name (any case).
  Rejected alternative: upserting it into the table at boot would let the
  environment silently overwrite a console-managed hash and adds a boot-time
  database write.
- Login (`POST /admin/v1/session`) looks up `admin_accounts` by exact
  username first, then the bootstrap name; exactly one argon2id
  verification runs either way. A disabled account is `ADMIN_LOGIN_INVALID`
  (counted like a wrong password). The Decision 0105 throttle (5 failures →
  15-minute lock, single flight, 2 argon2 slots) is unchanged and remains
  **global per process** across all accounts. A database error during the
  lookup refunds the attempt and answers 503.
- Cookie v2: `{v:2, sid, sub, aid, rol, cv, iat, exp}` HMAC-signed as
  before. `aid`/`cv` are null for the bootstrap administrator (`sub` must be
  `ADMIN_USERNAME`, `rol` must be `platform_admin`). v1 cookies are refused
  (everyone logs in again once after deploy).
- Every request with an account cookie re-reads the account: missing,
  disabled, username/role drift, or `credentials_version ≠ cv` → 401.
  Disabling or resetting an account therefore ends its sessions at once
  (unlike the bootstrap logout revocation, this does not depend on process
  memory).
- An administrator-set password (create, reset) sets
  `password_must_change`: the session's permissions are empty and every
  route except `GET/DELETE /session` and `POST /session/password` answers
  403 `ADMIN_PASSWORD_CHANGE_REQUIRED`. The holder changes it with their
  current password; the change bumps `credentials_version` (ending all other
  sessions) and the response sets a fresh cookie. A concurrent reset wins
  (409).
- Account writes (`platform_admin`): create (role fixed; reviewer /
  acceptor bound to an existing LOOP user and, in the same transaction,
  `provisionHooksLaunchOperator` enables the operator and replaces its
  grants with the role's, writing the `ops_audit` row), disable (terminal;
  a bound operator gets `enabled=false`, `operator.revoke` ops_audit row;
  your own account → 409 `ADMIN_ACCOUNT_SELF`; already disabled → 200
  `changed:false`), reset-password (not your own; disabled → 409). Each
  needs a UUIDv4 `Idempotency-Key`; an exact replay returns the current
  account with `replayed:true` (create: 200 instead of 201); another body
  or actor under the same key is 409 `ADMIN_IDEMPOTENCY_CONFLICT`. The
  stored fingerprint is HMAC-SHA256 keyed from `ADMIN_SESSION_SECRET`, so a
  fingerprint of a request carrying a password cannot be brute-forced
  offline.
- `provisionHooksLaunchOperator` (in `src/database/hooks-launch-review-repository.ts`)
  is the Decision 0108 CLI logic moved into the repository module; the CLI
  `pnpm hooks:operator` now calls it too (same locks, same before/after
  state, `deployment_cli` audit row unchanged).

## 3. Hooks launch review in the console

- `GET /launch/projects` lists every launch project newest first with the
  **stage** of its latest config version (precedence): `deploying` (an
  `awaiting_executor` task) > `accepted` (a `passed` BSC Testnet
  acceptance) > `approved` > `awaiting_approval`; `draft` when no config
  version exists. `status=` filters by stage; signed cursor (HMAC, bound to
  the filter). A reviewer / acceptor sees only projects their live
  `launch.read` grants cover (`scope: projects`); an operator disabled or
  without the grant → 403 `OPS_FORBIDDEN` (fail closed even if the console
  role says otherwise). platform_admin and auditor see all.
- `GET /launch/projects/{id}`: every config version (fields, hash, editor
  kind/user, approval), testnet acceptances, deployment tasks with the
  EIP-712-bound predicted MEME / Hook addresses, nonce, binding hash, and
  the number of signed authorizations. **No signature or signed payload is
  selected**. Out of scope → 404.
- `POST …/versions/{v}/approve` (reviewer) and `POST …/testnet-acceptance`
  (testnet_acceptor) run `createHooksLaunchReviewService().execute()` as the
  account's bound LOOP user with `operationId = Idempotency-Key`. The
  service keeps the rules: editor (operator who saved it, or the owner for
  an owner-saved draft) and project owner cannot approve
  (`OPS_SELF_APPROVAL`), only the latest version with its hash
  (`OPS_VERSION_CONFLICT`), acceptance needs an approved version and an
  acceptor who is neither editor nor owner (`OPS_SELF_ACCEPTANCE`). Audit:
  `admin_audit_log` intent row `<action>.requested` first (cannot write →
  503 `ADMIN_AUDIT_UNAVAILABLE`, nothing runs), then `.decided` / `.failed`
  (Decision 0105 pattern); the service writes its own `ops_audit` row in its
  transaction (`succeeded`, or `rejected` after rollback).
- These writes do not require `HOOKS_LAUNCH_ENABLED`: approval is an
  off-chain review fact; the switch keeps gating the App's signing and
  submission routes.

## 4. Error codes

| Code                      | HTTP | When (`detailsSafe.reasonCode`)                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED` (new) | 403  | `ADMIN_ROLE_FORBIDDEN` (+ `permission`), `ADMIN_PASSWORD_CHANGE_REQUIRED`, `OPS_FORBIDDEN`, `OPS_SELF_APPROVAL`, `OPS_SELF_ACCEPTANCE`; disable/reset by a role without `accounts.manage`                                                                                                                                                      |
| `ADMIN_CONFLICT`          | 409  | `ADMIN_IDEMPOTENCY_CONFLICT`, `ADMIN_ACCOUNT_USERNAME_TAKEN`, `ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND`, `ADMIN_ACCOUNT_DISABLED`, `ADMIN_ACCOUNT_SELF`, `ADMIN_ACCOUNT_ENVIRONMENT`, `ADMIN_UPDATED_AT_MISMATCH` (password CAS), `OPS_VERSION_CONFLICT`, `OPS_LAUNCH_NOT_APPROVED`, `OPS_LAUNCH_CONFIG_NOT_APPROVED`, `OPS_IDEMPOTENCY_CONFLICT` |
| `VALIDATION_FAILED`       | 422  | `ADMIN_PASSWORD_INVALID`, `ADMIN_ACCOUNT_OPERATOR_REQUIRED`, `ADMIN_ACCOUNT_OPERATOR_NOT_ALLOWED`, `ADMIN_ACCOUNT_OPERATOR_USER_NOT_FOUND`, `ADMIN_ACCOUNT_PROJECT_NOT_FOUND`, `ADMIN_OPERATOR_LABEL_INVALID`, `ADMIN_REASON_CODE_INVALID`, `ADMIN_REASON_TEXT_INVALID`, `OPS_INVALID_COMMAND`, `OPS_INVALID_LAUNCH_CONFIG`                    |
| `NOT_FOUND`               | 404  | `ADMIN_ACCOUNT_NOT_FOUND`, `ADMIN_LAUNCH_PROJECT_NOT_FOUND`, `OPS_NOT_FOUND`                                                                                                                                                                                                                                                                   |
| `INVALID_REQUEST`         | 400  | missing / non-UUIDv4 `Idempotency-Key`, schema, cursor                                                                                                                                                                                                                                                                                         |
| `ADMIN_LOGIN_INVALID`     | 401  | wrong current password on `POST /session/password`                                                                                                                                                                                                                                                                                             |
| `ADMIN_LOGIN_BUSY`        | 429  | both argon2 slots taken while hashing a new password                                                                                                                                                                                                                                                                                           |
| `CAPABILITY_UNAVAILABLE`  | 503  | `ADMIN_DATABASE_UNAVAILABLE`, `ADMIN_AUDIT_UNAVAILABLE`, `HOOKS_LAUNCH_REVIEW_UNAVAILABLE`, `OPS_COMMAND_FAILED`                                                                                                                                                                                                                               |

## 5. Unavailable behaviour (fail closed)

- No database: only the bootstrap administrator can log in; account and
  launch routes answer 503 `ADMIN_DATABASE_UNAVAILABLE`; an account cookie
  is 401 (cannot be re-checked). Account lookup failing at login → 503.
- No Hooks review repository → approve / acceptance 503
  `HOOKS_LAUNCH_REVIEW_UNAVAILABLE`.
- Node runtime without `crypto.argon2` while `ADMIN_*` is configured → boot
  refused (`ConfigurationError`).
- A reviewer / acceptor whose operator was disabled by the CLI (or whose
  grants were removed) keeps logging in but every launch read/write is 403
  `OPS_FORBIDDEN`.

## 6. Deviations from the task text

| #   | Task                                                   | Implemented                                                                                                   | Why                                                                                                                                         |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `/admin/login`, `/admin/session`, `/admin/accounts`, … | Under the existing prefix: `POST/GET /admin/v1/session`, `/admin/v1/accounts`, `/admin/v1/launch/projects`, … | One surface, one cookie `Path=/admin`, one artifact (Decision 0102).                                                                        |
| 2   | "所有写操作要 Idempotency-Key（照现有后台约定）"       | Required on the 5 new writes; the existing console writes keep `updatedAt` CAS / state transitions without it | Decision 0102 §1 explicitly has no Idempotency-Key on this surface; changing 12 existing writes is a client-breaking change for loop-admin. |
| 3   | —                                                      | Added `POST /admin/v1/session/password` and the forced first password change                                  | Otherwise the platform administrator knows every reviewer's password and can approve as them.                                               |
| 4   | Role enum                                              | `text` + check constraint (`admin_accounts_role_check`)                                                       | Every other status column in this schema is a checked text; enum types cannot be altered inside a transaction.                              |

## 7. Open questions (for the main agent)

1. A platform administrator can still reset a reviewer's password, log in
   as them before the holder does, and approve. It is audited
   (`account.reset_password`, then `account.password_change` and the
   approval by that account), but not prevented. Stronger: require the
   reviewer's own Privy login (step-up) for approve / accept, since they are
   LOOP users anyway. Do we want that next?
2. Mining formula draft and approve both stay with `platform_admin`
   (`console.write`), so the same person can still edit and approve a
   formula version. Split into a `formula.approve` permission for another
   role (e.g. reviewer), or require approver ≠ draft creator?
3. The login lock is still global per process: five wrong passwords on any
   account lock every account for 15 minutes. Per-username lock (with an
   anonymous bucket) is a small change if wanted.
4. The executor (broadcast worker) identity does not exist yet (Decision
   0108 has no executor); when it lands it must be a fourth, non-human
   principal, not a console role.
5. `testnet.read` has no console route of its own (acceptances are shown in
   the project detail under `launch.read`). Add a cross-project acceptance
   list if loop-admin needs one.

## Verification

The integration suites that truncate the `ops_*` tables explicitly
(`agent-authorization`, `alert`, `control-plane`, `internal-user`,
`perp-intent`, `perp-reconciliation`, `spot-agent-authorization`) now also
truncate `admin_account_commands` and `admin_accounts` (both reference
`loop_users`).

- Unit: `test/admin-roles.test.ts` (role table, duty separation, ops grant
  derivation incl. per-project scope, v2 cookie incl. tampered role,
  password-change-required principal, idempotency key shape, 0108 error
  projection), `test/admin-accounts-migration.test.ts`.
- Route: `test/admin-role-routes.test.ts` (role matrix on 9 representative
  routes × 4 roles with 403 before the body, platform_admin / acceptor /
  reviewer cross-refusals with zero commands executed, OPS_SELF_APPROVAL
  pass-through with `.failed` audit, idempotent replay / conflict, missing /
  malformed Idempotency-Key, account create rules, forced password change,
  disable / reset ending sessions, scoped launch reads and cursor binding,
  503 without database). Existing `test/admin-routes.test.ts` unchanged and
  green on the bootstrap administrator.
- Contract: `test/admin-role-contract.test.ts` and the updated operation
  list in `test/openapi.test.ts`.
- Integration (`loop_api_test_s128`):
  `test/admin-role-separation.integration.test.ts` — migration head and
  identity guards, reviewer creation with derived grants + `ops_audit`
  admin_console row + console audit, replay / conflict / one-account-per-user
  / unknown user / unknown project, disable + reset ending sessions and
  revoking the operator, the deployment CLI on the shared bootstrap,
  platform_admin (table and bootstrap) cannot approve or accept, acceptor
  cannot approve, reviewer cannot accept, owner-bound and editor-bound
  reviewers get `OPS_SELF_APPROVAL`, editor-bound acceptor gets
  `OPS_SELF_ACCEPTANCE`, independent approval + acceptance, stage filters
  `accepted` / `deploying`, detail without signatures, per-project scope.
