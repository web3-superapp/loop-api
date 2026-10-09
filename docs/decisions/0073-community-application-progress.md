# Decision 0073: An applicant can see, and is told, what happened to their community application

- Status: Accepted
- Date: 2026-09-23
- Scope: S79b backend. `GET /v2/community/home`, `GET /v2/communities`,
  `GET /v2/communities/{id}`, the new `POST /v2/communities/{id}/resubmit`,
  the operator scripts `pnpm community:verify` and the new
  `pnpm community:reject`, migration `000039`, two new push events, and one
  new feed event family. Extends Decisions 0031 (community), 0034 (feed),
  and 0067 (push); no ruling in any of them is reversed.

## Context

Decision 0031 made `POST /v2/communities` create a `pending` community with
the applicant as owner, and made `verified` operator-only. It said nothing
about the applicant afterwards: the home aggregate listed the pending
community inside `joined` with no indication that it was an application,
there was no way to reject one, no place to store why, and no notification
when the answer came. The 2026-09-23 product ruling keeps the entry point
where it is (the "apply" sheet at the bottom of discover) and asks for the
missing half: progress visible on the "my communities" surface, split into
"joined" and "created", each created row carrying its review state; the
community detail telling the owner "under review" or "rejected, because";
and the review result reaching the owner as a notification.

## Rulings

| Topic                   | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Created" means owned   | The "created" group is the set of communities whose **current owner** is the viewer (`community_memberships.role = 'owner'`), not `created_by_user_id`. After an ownership transfer the application, its review state, and its notifications follow the new owner; the previous owner keeps nothing that is no longer theirs to act on.                                                                                                                       |
| No double listing       | `home.joined` and `membership=joined` now exclude the viewer's owner memberships; `home.owned` and the new `membership=owned` filter carry them. A community appears in exactly one of the two groups.                                                                                                                                                                                                                                                        |
| Review facts            | `communities` gains `application_submitted_at` (the last submission), `reviewed_at`, and `rejected_reason` (1–280 code points, alias text-safety rules). A `pending` row has neither review column set; a `verified` row has `reviewed_at` and no reason; a `rejected` row has `reviewed_at` and, when the operator gave one, a reason. The pairing is a check constraint.                                                                                    |
| Who sees the reason     | The `application` block (`status`, `submittedAt`, `reviewedAt`, `rejectedReason`) is projected only to the current owner, on the detail, on `home.owned`, and on `membership=owned` rows. Every other viewer receives `application: null` on the detail and no block on list rows. The visibility predicate of Decision 0031 is unchanged: a stranger still cannot read an unverified community at all.                                                       |
| Reject is operator-only | `pnpm community:reject <communityId> --reason "<text>" [reasonCode]` is the only path to `rejected`. It refuses `NODE_ENV=production`, refuses a `verified` community (`community_reject_state_invalid`: unverifying is a different decision with channel consequences), is a no-op on an already rejected one, and otherwise sets the status, the reason, and `reviewed_at` in one transaction with a `community_rejected` audit row.                        |
| Reason is audited too   | `community_role_events` gains a nullable `note` (same 1–280 bound). The reject audit row stores the reason text there, so clearing `rejected_reason` on resubmission never erases why the previous version was refused.                                                                                                                                                                                                                                       |
| Resubmit is a command   | `POST /v2/communities/{id}/resubmit` moves `rejected → pending`, clears `rejected_reason` and `reviewed_at`, stamps `application_submitted_at`, and appends `community_resubmitted`. It is owner-only (new self action `resubmitApplication`), body-less, idempotent under `Idempotency-Key`, and `409 DATA_STALE` from any state other than `rejected`. `PATCH` stays a profile edit that never touches the status; the owner edits first, then resubmits.   |
| Verify path             | `pnpm community:verify` keeps its behaviour and additionally stamps `reviewed_at`, clears any reason, and may verify a `rejected` community directly (the operator reconsidered). The repair branch on an already verified community writes no audit row and raises no notification, exactly as before.                                                                                                                                                       |
| Feed row                | Both review outcomes write one `community.announcement` feed row to the owner: `entityRef: community:<id>`, `contextRoute: community-profile`, `contextParams.communityId`, `payload.event` = `community.application.verified` or `community.application.rejected`, plus `communityId`, `communityName`, `reviewedAt`, and `reason` (null when none). The dedupe key includes the audit event ID, so a second rejection after a resubmission is a second row. |
| Feed row is not gated   | The row is written regardless of the owner's `community.announcement` preference. It is the answer to the owner's own command, and the in-app feed is the authoritative record (Decision 0067); the preference gates the push only. The write happens after the review transaction commits and is best-effort: a feed failure is logged and never undoes the review.                                                                                          |
| Push                    | Two optional events, `community_application_verified` and `community_application_rejected`, category `community.announcement`, loc keys `push.communityApplicationVerified.*` and `push.communityApplicationRejected.*` (Android spelling by the existing dot-to-underscore rule). Payload is the Decision 0067 four-key pointer with `entityRef: community:<id>` and `contextRoute: community-profile`; no name, reason, or text travels.                    |
| Missing push runtime    | Without `FIREBASE_SERVICE_ACCOUNT_JSON_PATH` (or an unreadable file) the scripts compose no sender: the review and the feed row still happen and the script reports `push: unavailable (PUSH_RUNTIME_DEFERRED)`. Nothing is faked.                                                                                                                                                                                                                            |
| Payload bound           | The feed schema's payload value bound rises from 256 to 512 characters so a 280-code-point reason fits without truncation. No other field changes.                                                                                                                                                                                                                                                                                                            |

## State machine

```text
pending ──verify──▶ verified
pending ──reject──▶ rejected ──resubmit (owner)──▶ pending
rejected ──verify─▶ verified
verified ──reject─▶ refused (community_reject_state_invalid)
rejected ──reject─▶ no-op (changed: false; no audit, no notification)
```

## Error surface

No new error code. `resubmit`: `403 PERMISSION_DENIED` (not the owner, or
banned), `404 NOT_FOUND` (nonexistent or not visible), `409 DATA_STALE`
(not `rejected`), `409 IDEMPOTENCY_CONFLICT`, `409 PROFILE_ACTIVATION_REQUIRED`
is not raised because an owner necessarily has a profile. Script refusals are
process exit `1` with a machine code on stderr.

## What is not in this decision

- No Admin console; the two scripts remain the only review path (D17).
- No operator identity on the audit row (`actor_type = 'operator'`,
  `actor_user_id = null`, as in Decision 0031).
- No un-verify, no re-review of a verified community.
- No applicant-facing message thread with the reviewer.

## Rollback

Roll back migration 000039 (it refuses while a `community_resubmitted` row or
a review note exists). The routes and scripts keep their previous shape
except that `owned` is empty and `application` is `null`.
