# Decision 0042: An ownership transfer audits both of its role changes

- Status: Accepted
- Date: 2026-09-14
- Scope: S17b. Backend only: one added `community_role_events` row on the
  `transferOwnership` path and the migration that lets it exist. No route, no
  response field, no OpenAPI change, no behavior change to the transfer
  itself.

## Context

`POST /v2/communities/{communityId}/members/{publicProfileId}/role` with
`{"role":"owner"}` resolves to the `transferOwnership` governance action, the
only irreversible action in the app: an owner cannot take ownership back
without the new owner's cooperation. The action changes **two** memberships in
one transaction — the successor rises to `owner`, the previous owner falls to
`admin` (Decision 0031, permission matrix) — and both halves are intended.

Device testing on 2026-09-14 (`mock-defi-morning`, actor `cy`) found that
`community_role_events` recorded only the successor's `admin → owner` row. The
previous owner's `owner → admin` demotion appeared nowhere in the audit, so
the log could not answer "who lost ownership, and when" without inferring it
from the single-owner invariant. Inference is not a record, and this is the
one action for which a record matters most.

The cause is a collision between two rules of Decision 0031: the storage
section rules "one row per ... role change" **and** "a unique
`idempotency_record_id`". Because a transfer is two role changes under one
command, the second row could not be written at all — the insert failed with
`23505`, which the repository translates to `REPOSITORY_UNAVAILABLE`.

## Rulings

| Topic              | Ruling                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transfer behavior  | Unchanged. The successor becomes `owner`, the previous owner becomes `admin`, the single-owner partial index still holds, and `joined_at` still survives. This decision adds a record, never a state change.                                                                                                                                                                                                        |
| Row count          | A transfer appends exactly two `role_changed` rows. Every other governance action still appends exactly one.                                                                                                                                                                                                                                                                                                        |
| Outgoing row shape | `event_type = 'role_changed'`, `actor_user_id` = the previous owner (the actor of the command), `target_user_id` = the previous owner (the subject is also the actor: this is a self-demotion), `from_role = 'owner'`, `to_role = 'admin'`, `from_status = to_status = 'active'` (an owner row is always active, and a transfer moves no status).                                                                   |
| Reason code        | `action_transferownership_released`, beside the successor row's existing `action_transferownership`. The shared `action_transferownership` prefix keeps both legs greppable as one action; the `_released` suffix is the only thing that distinguishes the outgoing leg from the incoming one. The existing code is not renamed, so historical rows and existing assertions keep their meaning.                     |
| Correlation        | Both rows carry the same `idempotency_record_id` and the same `request_id`. The pair therefore rebuilds as a single command from the audit alone — no join through `community_memberships` and no reliance on `occurred_at` proximity.                                                                                                                                                                              |
| Ordering           | The outgoing row is appended before the incoming row, matching the order of the two membership updates. `occurred_at` defaults to `clock_timestamp()`, which advances inside a transaction, so `order by occurred_at, event_id` reproduces that order.                                                                                                                                                              |
| Uniqueness         | `community_role_events_idempotency_unique` moves from `(idempotency_record_id)` to `(idempotency_record_id, target_user_id)` (migration 000027). This amends the Decision 0031 storage line: the unit of uniqueness is one row per command **per subject**, not per command.                                                                                                                                        |
| Idempotency        | Unchanged in observable behavior. `governMember` still claims the command record first and returns early when `findCommunityAudit` finds any row for it, so a replayed `Idempotency-Key` appends nothing and the pair stays a pair. The narrowed constraint is the database's backstop for that guard, not the guard itself.                                                                                        |
| Null subjects      | The operator verification path (`pnpm community:verify`) writes `actor_user_id`, `target_user_id`, and `idempotency_record_id` all null and is unaffected: `NULLS DISTINCT` is kept, so those rows neither collide with each other nor lose any protection they had (a null `idempotency_record_id` was already non-unique). Every command path writes a non-null `target_user_id`, so no command path is weakened. |
| No new column      | `actor_user_id`, `target_user_id`, `from_role`, `to_role`, `from_status`, `to_status`, `reason_code`, `idempotency_record_id`, and `request_id` already carry everything the outgoing row needs. Nothing is added and no row is backfilled; the append-only trigger stays in force.                                                                                                                                 |
| Historical rows    | Not rewritten. Transfers audited before this migration keep their single row, and the missing half stays missing — an append-only audit is not retroactively corrected. The single-owner invariant remains the only way to read those older transfers.                                                                                                                                                              |
| Not in scope       | Publishing the audit over HTTP (no route reads `community_role_events` today), an admin console, operator-initiated transfers, and any audit change for `assignAdmin`, `revokeAdmin`, mute, ban, join, or leave.                                                                                                                                                                                                    |

## Verification

- `test/community-repository.integration.test.ts` — "audits both role changes
  of an ownership transfer under one command": asserts the ordered pair with
  its roles and reason codes, that both rows share one command record and one
  request, that a replay of the same `Idempotency-Key` leaves exactly two
  rows, and that one command still cannot append two rows about the same
  account (`23505` on
  `community_role_events_idempotency_unique`).
- `test/v2-community-transfer-audit-migration.test.ts` — the migration's
  constraint swap, its refusal to roll back while a command holds more than
  one row, and the absence of any column, data, table, or trigger change.
