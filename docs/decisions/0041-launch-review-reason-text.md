# Decision 0041: Applicant-facing review reason text (`reviewReasonText`)

- Status: Accepted
- Date: 2026-09-11
- Scope: S16 follow-up item 6. Backend only: one added read-only field on the
  Launch project projection. No new table, no new column, no new migration.

## Context

The 2026-09-10 copy audit (S16 stream B, mobile) found the client rendering
`reviewReasonCode` straight into user-visible copy, so an internal identifier
(`needs_more_material`, `operator_manual_review`, …) reached the screen. The
mobile ruling was that a client must not translate a reason code into human
language at all: the backend owns the sentence and the client renders it.

`reviewReasonCode` is written by the operator path only
(`pnpm launch:review <projectId> <decision> [reasonCode]`, Decision 0036).
It is free text matching `^[a-z][a-z0-9_]{0,63}$` (migration 000023), defaults
to `operator_manual_review`, and is not a closed enum — so the projection must
stay correct for a code nobody has defined yet.

## Rulings

| Topic              | Ruling                                                                                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field              | `reviewReasonText` is added beside `reviewReasonCode` on `LaunchProjectProjection`, so every route that publishes a project (`GET`/`POST`/`PUT` `/v2/launch/projects…`, submit) carries it. No new route, no new resource.                                                                                      |
| Relationship       | The text is the **display projection** of the code. The code stays the machine-readable contract for logs, analytics, and client branching; the text is the only string a client renders. A client must never parse the text back into a code or branch on it.                                                  |
| Nullability        | `reviewReasonText` is null exactly when `reviewReasonCode` is null — including the non-owner projection, where the whole review trail is already null.                                                                                                                                                          |
| Resolution         | Catalog code matching the current `reviewStatus` → its sentence; otherwise (generic `operator_manual_review`, unknown code, or a catalog code used against another status) → the sentence for that status. A code can therefore never reach a screen.                                                           |
| Status-owned codes | A catalog entry owns one status, because "可以重新提交" is wrong advice on `rejected`. A mismatch degrades to the status sentence rather than to wrong instructions.                                                                                                                                            |
| Copy rules         | Chinese, one sentence, ≤ 40 characters: what is blocked now and when or how it changes. No promise, no internal identifier (no reason code, rule id, step number, config version), no "口径/观测/投影" vocabulary. Guarded by a test that rejects any latin character or underscore in every produced sentence. |
| Ownership          | The sentences live in `src/features/launch/launch-contract.ts` next to the review state machine, not in a route file and not in the database.                                                                                                                                                                   |
| Storage            | None. The text is computed per read from the stored status and code, so wording can change without a data migration and historical rows need no backfill.                                                                                                                                                       |
| Operator script    | Unchanged: `pnpm launch:review` still accepts any `^[a-z][a-z0-9_]{0,63}$` code. The catalog is a vocabulary, not a validator; an undocumented code degrades to the status sentence instead of being refused.                                                                                                   |
| Not in scope       | Localization (the app is zh-CN only; there is no `Accept-Language` negotiation in V2), operator free-text notes to the applicant, an admin review console, and reason text for any other module's reason codes.                                                                                                 |

## Copy table

| `reviewStatus` | `reviewReasonCode`           | `reviewReasonText`                                               |
| -------------- | ---------------------------- | ---------------------------------------------------------------- |
| any            | `null`                       | `null`                                                           |
| `returned`     | `needs_more_material`        | 材料还不完整，补齐后可以重新提交审核。                           |
| `returned`     | `official_links_unreachable` | 官方链接无法访问或核对，换成可访问的链接后可以重新提交。         |
| `returned`     | `material_mismatch`          | 名称、代币符号与简介之间对不上，改一致后可以重新提交。           |
| `returned`     | `ticker_conflict`            | 这个代币符号已被占用，换一个后可以重新提交。                     |
| `rejected`     | `duplicate_submission`       | 同一个项目已经有一份申请在审核，这份重复申请不再处理。           |
| `rejected`     | `policy_violation`           | 材料不符合上线规则，这份申请不会继续；调整后可以新建项目再提交。 |
| `draft`        | any other code               | 项目还是草稿，材料填完就可以提交审核。                           |
| `submitted`    | any other code               | 材料已提交，审核期间不能修改，有结果后状态会更新。               |
| `in_review`    | any other code               | 材料正在审核，这期间不能修改，有结果后状态会更新。               |
| `returned`     | any other code               | 材料被退回，修改后可以重新提交审核。                             |
| `approved`     | any other code               | 审核已通过，材料不再可改，可以继续后面的发行安排。               |
| `rejected`     | any other code               | 审核未通过，这份申请不能再提交，需要的话可以新建项目。           |

## Consequences

`launch-apply` renders `reviewReasonText` directly and deletes its local
code-to-copy mapping; the audit's "reasonCode on screen" class of defect
cannot recur for Launch review, because the client never sees a code it is
expected to translate. Changing a sentence is a copy change in one file with
no client release and no migration. Adding a new operator code without adding
it to the catalog is safe but uninformative — it reads as the status sentence
until the catalog entry lands.
