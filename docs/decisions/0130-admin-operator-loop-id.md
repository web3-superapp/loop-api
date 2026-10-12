# Decision 0130: console accounts accept the App-visible LOOP ID for the bound operator (S158-api)

- Status: Accepted (S158-api)
- Date: 2026-10-12
- Baseline: `integration/v2` = `37d171c` (Decision 0129)
- Inputs: requirer report 2026-10-12 (creating a reviewer with the LOOP ID shown in the App was
  refused with `ADMIN_FORM_INVALID … LOOP 用户 ID（UUID）`); S158 task sheet; Decision 0109
  (console accounts), Decision 0030 / migration 000015 (`loop_users.loop_id`).
- Scope: `POST /admin/v1/accounts` request, the `account.operator` projection on every account
  response (`GET /admin/v1/accounts`, account write receipts). No migration; no `/v1` or `/v2`
  change.

## 1. Problem

Reviewer and testnet-acceptor accounts bind one LOOP user (`admin_accounts.operator_user_id` →
`loop_users.id`, a UUID). Operators only ever see the user's `loop_users.loop_id`
(`LOOP-XXXXXXXX`) in the App, so they could not fill the form without a database lookup.

## 2. Request

- New optional `operatorLoopId`: `^LOOP-[A-Z0-9]{8}$`, case-insensitive on input, upper-cased by
  the server before lookup (stored LOOP IDs are upper-case Crockford Base32). A shape error is
  400 `INVALID_REQUEST`, like every other malformed field.
- reviewer / testnet_acceptor need `operatorUserId` **or** `operatorLoopId` (neither → 422
  `ADMIN_ACCOUNT_OPERATOR_REQUIRED`). Other roles may carry neither (422
  `ADMIN_ACCOUNT_OPERATOR_NOT_ALLOWED`).
- `operatorLoopId` is resolved in `createAdminAccountService().create` through
  `AdminAccountRepository.findOperatorUserIdByLoopId` (`select id from loop_users where
loop_id = $1`, the unique index `loop_users_loop_id_unique`):
  - no user → 422 `VALIDATION_FAILED`, `ADMIN_ACCOUNT_OPERATOR_LOOP_ID_NOT_FOUND`
    (`detailsSafe.operatorLoopId` = the upper-cased input);
  - both identities given and the LOOP ID names another user → 422 `VALIDATION_FAILED`,
    `ADMIN_ACCOUNT_OPERATOR_IDENTITY_MISMATCH`.
    Both refusals happen before the Idempotency-Key claim, so nothing is written.
- The binding stays the user ID. The resolved ID goes through the unchanged Decision 0109 path:
  existence re-check inside the transaction, one active account per LOOP user (409
  `ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND`), ops grants via the Decision 0108 bootstrap.
- Idempotency fingerprint: computed over the resolved `operatorUserId`, not the typed identity.
  A replay of the same key naming the same user by UUID or by LOOP ID is the same request.
  UUID-only requests fingerprint exactly as before.

## 3. Naming

The task sheet proposed `ADMIN_OPERATOR_NOT_FOUND` / `ADMIN_OPERATOR_IDENTITY_MISMATCH`. The
account-creation codes are all `ADMIN_ACCOUNT_OPERATOR_*` (`…_REQUIRED`, `…_NOT_ALLOWED`,
`…_USER_NOT_FOUND`, `…_ALREADY_BOUND`), so the new codes follow that prefix:
`ADMIN_ACCOUNT_OPERATOR_LOOP_ID_NOT_FOUND`, `ADMIN_ACCOUNT_OPERATOR_IDENTITY_MISMATCH`.

## 4. Response

`account.operator` gains required `loopId: string | null` — the bound user's `loop_users.loop_id`
(null only if the user row is gone). The list reads it with a left join on `loop_users`; write
receipts read it with the operator state. `operatorUserId` is unchanged.

## 5. Compatibility and rollout

Additive: old clients that send only `operatorUserId` behave as before; a client that ignores
`operator.loopId` is unaffected (the console renders through its own projection). Deploy loop-api
first, then loop-admin (whose form sends `operatorLoopId` only when the input is a LOOP ID and
still sends UUIDs as `operatorUserId`).

## 6. Verification

- Route contract (`test/admin-role-routes.test.ts`): shape 400, role refusal, unknown LOOP ID,
  mismatch, case-insensitive resolution, both-same accepted, one account per user across
  identities, `operator.loopId` on the list.
- PostgreSQL (`test/admin-role-separation.integration.test.ts`): resolution against the real
  `loop_users` row, unknown and mismatch leave `admin_accounts` unchanged, stored
  `operator_user_id` and grants, `operator.loopId` in the list.
- `openapi/loop-admin.v1.json` regenerated.
