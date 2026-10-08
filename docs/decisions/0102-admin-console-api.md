# Decision 0102: Operator console management API (S119)

- Status: Accepted (S119-api)
- Date: 2026-10-08
- Scope: migration `000050_admin_console` (three tables, two `meme_tokens`
  columns groups, one `mining_formula_versions` column); a new HTTP surface
  `/admin/v1/*` (20 operations) published as `openapi/loop-admin.v1.json`;
  the "database first, constant second" read priority for recommended
  communities and intel promotions; MEME `listing` filtering in every `/v2`
  list read; new environment keys `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`,
  `ADMIN_SESSION_SECRET` (and the API process now also reads
  `MEME_GRADUATION_EXECUTOR_ENABLED` / `LAUNCH_DEPLOYER_PRIVATE_KEY`); a new
  script `pnpm admin:hash-password`. No `/v1` change; no new `/v2` route or
  error code.
- Baseline: `integration/v2` = `c85c566`
- Inputs: `LOOP/docs/modules/S119-S120-admin-console.md` §0, §1, §3;
  `LOOP/docs/09-需求方v3需求与裁决.md` §2.1 (single administrator) and §3
  (operator console scope); `LOOP/docs/00-主代理规则.md`; Decisions 0046
  (formula versions), 0073 (community review), 0095 (recommended
  communities), 0100 (intel promotions), 0101 (MEME launchpad).

## Context

The requester asked for an operator console (09 §3): default-checked
recommended communities, mining coefficients, promotion content, reviews,
and a record of what was done. The console itself (S120, `loop-admin`) is a
thin server-rendered shell; every rule stays in this API and every change
lands in this database with an audit row. Until now each of these was a
constant, an environment variable, or a Dev-only script.

## Decision

### 1. Authentication

| Item           | Ruling                                                                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Principal      | One administrator, no roles: `ADMIN_USERNAME` (`^[A-Za-z0-9._@-]{1,64}$`) is the `actor` of every audit row.                                                                                                                                                                     |
| Password       | `ADMIN_PASSWORD_HASH` is an argon2id PHC string (`$argon2id$v=19$m=19456,t=2,p=1$…`), produced by `pnpm admin:hash-password` with Node's built-in `crypto.argon2` (no new dependency). Malformed → boot refused. The password is verified even for a wrong username (same cost). |
| Mounting       | All three `ADMIN_*` set → `/admin/v1/*` mounted. Any one missing → not mounted (`/admin/*` is the ordinary 404), `/v1` and `/v2` unaffected.                                                                                                                                     |
| Session        | Stateless cookie `loop_admin_session = base64url({v,sid,sub,iat,exp}).HMAC-SHA256`, key derived from `ADMIN_SESSION_SECRET` (≥ 32 chars). `HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`, `Secure` unless `PUBLIC_BASE_URL` is plain `http://`.                         |
| Logout         | `DELETE /admin/v1/session` revokes the `sid` in this process until it expires and clears the cookie. Rotating `ADMIN_SESSION_SECRET` revokes every session.                                                                                                                      |
| Lockout        | Five consecutive failures lock every login for 15 minutes: 423 `ADMIN_LOGIN_LOCKED`, `detailsSafe.retryAfterSeconds`, `Retry-After`. The right password is refused while locked. Per process, global (one account).                                                              |
| Check order    | The session is checked in `onRequest`, before body parsing, so an unauthenticated caller always gets 401 and never a validation detail.                                                                                                                                          |
| Contract rules | No Privy Bearer, no `X-Loop-Contract-Version`, no `Idempotency-Key` on this surface (design §1.1). Concurrency is guarded by `updatedAt` compare-and-set and state transitions instead.                                                                                          |

### 2. Migration `000050_admin_console`

| Object                                      | Shape                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admin_settings`                            | `key` pk ∈ {`recommended_community_ids`, `intel_promotions`, `meme_listing_policy`}, `value jsonb`, `updated_at` (written at millisecond precision, strictly increasing per key), `updated_by`. No row = the constant / environment value is in force.             |
| `admin_audit_log`                           | `audit_id uuid` pk (opaque), `seq bigint identity` (display number 「审计 #seq」 and keyset), `at`, `actor`, `action`, `target_type`, `target_id`, `before jsonb`, `after jsonb`, `request_id`. UPDATE / DELETE / TRUNCATE raise `admin_audit_log is append-only`. |
| `community_review_notes`                    | `note_id` pk, `community_id` → communities, `at`, `actor`, `decision ∈ {verify, reject}`, `reason_code` (`^[a-z][a-z0-9_]{0,63}$`), `reason_text` (1–280, required for reject), `audit_id`.                                                                        |
| `meme_tokens.listing` + reason columns      | `listing ∈ {listed, hidden}` default `listed`; `listing_reason_code`, `listing_reason_text`, `listing_changed_at`; hidden requires a reason code and a change time.                                                                                                |
| `mining_formula_versions.community_weights` | `jsonb` array `[{communityId, weight}]` or null: the weights a console draft proposes, applied when it is approved.                                                                                                                                                |

`down` refuses to run while any console fact exists. `schema.ts` lists the
three new relations and the head; the twelve integration suites that
truncate `communities` also truncate `community_review_notes`
(`admin_audit_log` has no foreign key and is never truncated; the console's
own suite uses a private database).

### 3. Read priority ("database first, constant second")

| Setting                 | Database value in force                                                                                                                                                                                                                    | Fallback                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Recommended communities | `admin_settings.recommended_community_ids` (ordered UUIDv4 list, ≤ 50, each verified at write time) replaces `RECOMMENDED_COMMUNITY_IDS` in `GET /v2/communities/recommended`; the read still filters to verified, first five pre-selected | `RECOMMENDED_COMMUNITY_IDS` (Decision 0095, unchanged)         |
| Intel promotions        | `admin_settings.intel_promotions`, validated by the same `defineIntelPromotions` (deeplink allow-list unchanged); `configVersion = intelPromotionsV1+db.<updated_at epoch ms>`, `effectiveAt = updated_at`                                 | the shipped list, `intelPromotionsV1` / `2026-10-08T00:00:00Z` |

The reader caches each key for 60 seconds; a console write invalidates the
key in the same process at once. A stored value that no longer validates
falls back to the constant and is logged (`ADMIN_SETTING_INVALID`); a
failed database read serves the last value read, else the constant
(`ADMIN_SETTING_UNREADABLE`). `/v2` response shapes are unchanged; the only
`/v2` schema change is `configVersion` of `GET /v2/intel/promotions` from
`const intelPromotionsV1` to the pattern `^intelPromotionsV1(\+db\.[0-9]{1,16})?$`.

MEME listing: `listing = 'hidden'` is excluded from `GET /v2/meme/tokens`
(`new`, `graduating`, `graduated` in SQL; `hot` in SQL **and** after the
60-second hot ranking cache, so a hide applies at once) and from
`GET /v2/market/assets?category=meme` (also when a Launch project shares
the asset). `GET /v2/meme/tokens/{id}` still answers and adds two fields:
`listing` (`listed | hidden`) and `listingReason` (`{reasonCode,
reasonText}` when hidden, else null). Trades, candles, holders, quotes, and
Intents of a hidden token are not blocked (hiding is a listing decision, not
a trading halt — that is `pause`).

### 4. Routes (`/admin/v1`, all but `POST /session` need the cookie)

| Route                                        | Behaviour                                                                                                                                                                                   | Audit action                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST/GET/DELETE /session`                   | login / current session / logout                                                                                                                                                            | `session.login`, `session.login_failed`, `session.logout` (best-effort) |
| `GET /overview`                              | accounts, communities by status, pending reviews, live voice rooms + joined members, MEME tokens by status + hidden, indexer lanes (last block, seconds since update), newest 20 audit rows | —                                                                       |
| `GET/PUT /settings/recommended-communities`  | CAS on `updatedAt`; `communityIds: null` deletes the console list                                                                                                                           | `settings.recommended_communities.update`                               |
| `GET/PUT /settings/intel-promotions`         | whole-list replacement, CAS; server assigns a UUIDv4 to cards without `id`; `items: null` restores the shipped list                                                                         | `settings.intel_promotions.update`                                      |
| `GET /communities`, `GET /communities/{id}`  | list (status, `q`, signed cursor) and detail with review notes                                                                                                                              | —                                                                       |
| `POST /communities/{id}/review`              | runs the Decision 0073 review service (status, `community_role_events`, owner feed row, push when the runtime exists), then writes the note + audit row                                     | `community.review.verify` / `.reject`                                   |
| `GET/POST /mining/formula-versions`          | list (50 newest) / create a `pending_approval` draft from `baseVersion` with editable parameters                                                                                            | `mining.formula.draft`                                                  |
| `POST /mining/formula-versions/{v}/approve`  | Decision 0046 semantics in one transaction: only `pending_approval`, retire the approved one, `effective_at = approved_at = now`, apply the draft's community weights                       | `mining.formula.approve`                                                |
| `POST /mining/formula-versions/{v}/withdraw` | `pending_approval → retired` only                                                                                                                                                           | `mining.formula.withdraw`                                               |
| `GET /meme/tokens`                           | every status and listing; `pause.available` / `reasonCode` for the buttons                                                                                                                  | —                                                                       |
| `POST /meme/tokens/{id}/listing`             | `listed                                                                                                                                                                                     | hidden` + reason (text required for hidden)                             | `meme.listing.update` |
| `POST /meme/tokens/{id}/pause`, `/unpause`   | executor signs `pause(token)` / `unpause(token)` after a dry run; 202 `submitted` with the hash; the `meme_event` lane moves the status                                                     | `meme.pause` / `meme.unpause` (also on a failed broadcast)              |
| `GET /audit`                                 | newest first, `actor` / `action` filters, signed cursor                                                                                                                                     | —                                                                       |

Editable formula parameters (the "可编辑子集"): `assetWeights`,
`dailyOutputBudget` (the `development_placeholder` budget), `referralBoostStatus`,
`communityWeightRange`, `communityWeights` (default: the weights approved
under the version in force), `nftWeight` and `inviteInitialPower` (stored as
`formula.placeholders`, status `placeholder`, read by no snapshot — 09 §2
A5). Everything else (expression, price proxies, reference pricing, price
guard rules, scope) is copied from `baseVersion`.

### 5. Errors

The body is the `/v2` seven-field envelope (`code`, `category`,
`retryable`, `userMessageKey`, `correlationId`, `detailsSafe`,
`providerReferenceSafe`) with the console catalog:

| Code                     | HTTP | Category       | When                                                                                     |
| ------------------------ | ---- | -------------- | ---------------------------------------------------------------------------------------- |
| `ADMIN_SESSION_REQUIRED` | 401  | authentication | no / forged / expired / revoked cookie                                                   |
| `ADMIN_LOGIN_INVALID`    | 401  | authentication | wrong username or password                                                               |
| `ADMIN_LOGIN_LOCKED`     | 423  | rateLimit      | locked; `detailsSafe.retryAfterSeconds`, `Retry-After`                                   |
| `ADMIN_CONFLICT`         | 409  | conflict       | stale `updatedAt`, refused state transition, reverting dry run                           |
| `INVALID_REQUEST`        | 400  | validation     | schema, cursor, or limit                                                                 |
| `VALIDATION_FAILED`      | 422  | validation     | a rule refused the content; `detailsSafe.reasonCode` (+ `index`, `field`, `communityId`) |
| `NOT_FOUND`              | 404  | validation     | unknown route or target                                                                  |
| `CAPABILITY_UNAVAILABLE` | 503  | availability   | database down, executor off, production approval, broadcast failure                      |
| `REQUEST_TIMEOUT`        | 503  | availability   | handler deadline                                                                         |
| `INTERNAL_ERROR`         | 500  | internal       | unexpected; cause logged redacted                                                        |

### 6. Unavailable behaviour (fail closed)

- `ADMIN_*` incomplete → surface absent.
- No admin repository (no database) → every route 503
  `ADMIN_DATABASE_UNAVAILABLE`; `/v2` reads keep the constants.
- No community repository → review 503 `COMMUNITY_REVIEW_UNAVAILABLE`.
- Pause/unpause without `MEME_GRADUATION_EXECUTOR_ENABLED` + key →
  503 `MEME_EXECUTOR_DISABLED`; MEME contract unset →
  `MEME_CONTRACT_NOT_CONFIGURED` (or its `unconfiguredReason`); launch slot
  not testnet → `MEME_MAINNET_SIGNING_CLOSED`; no RPC →
  `MEME_CHAIN_RPC_NOT_CONFIGURED`. The list carries the same reason so the
  buttons are grey before anyone clicks.
- Formula approval under `NODE_ENV=production` → 503
  `MINING_APPROVE_FORBIDDEN_IN_PRODUCTION`, exactly like
  `pnpm mining:approve-formula`.

## Deviations from the design (`S119-S120-admin-console.md` §1)

| #   | Design                                               | Implemented                                                                                                          | Why                                                                                                                                    |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Error body `{ error: { code, message, requestId } }` | The `/v2` seven-field envelope with console codes                                                                    | The task says "错误模型同 v2"; the actual v2 model (00 §4.6) is the seven-field envelope; one parser for S120.                         |
| 2   | Routes as listed                                     | Two extra reads: `GET /admin/v1/session`, `GET /admin/v1/communities/{id}`                                           | S120 needs "am I logged in" and the review detail page (design §2 "列表 + 详情").                                                      |
| 3   | "挖矿系数不新造表"                                   | No new table; one new column `mining_formula_versions.community_weights`, and `formula.placeholders` in the document | A version switch makes every community weight of the old version `pending_review`; the draft must carry weights to approve atomically. |
| 4   | Withdraw                                             | Drafts only (`pending_approval → retired`)                                                                           | Withdrawing the version in force would stop every mining number; approve another version instead.                                      |
| 5   | Approve                                              | Refused under `NODE_ENV=production`                                                                                  | Parity with the approval script (03 §19 freeze).                                                                                       |
| 6   | `meme_listing_policy` key                            | Reserved in the key check; no route reads or writes it                                                               | The design names the key but not its content.                                                                                          |
| 7   | Pause "走执行器钱包"                                 | 202 `submitted` without waiting for the receipt; status moves via the `meme_event` lane                              | A receipt can take longer than the 15 s handler deadline.                                                                              |
| 8   | `configVersion = …+db.<updated_at epoch>`            | epoch in **milliseconds**                                                                                            | Two saves in one second must not share a version.                                                                                      |

## Open questions (for the main agent)

1. Should formula approval be allowed on Staging (if it runs
   `NODE_ENV=production`)? Today it is refused there, like the script.
2. `listingReason.reasonText` of a hidden MEME is published on the `/v2`
   detail. Confirm it is user-facing copy (the console labels it so), or
   publish only the code and let the App show fixed copy.
3. `meme_listing_policy`: what should it mean (e.g. "new tokens hidden
   until reviewed")? Nothing reads it yet.
4. Lockout and logout revocation are per process and in memory: a restart
   clears the lock and re-validates a logged-out cookie until it expires.
   Acceptable for one administrator behind Cloudflare Access (S120 / docs
   07), or should sessions move to the database?
5. `GET /v2/meta/about` still lists `intelPromotions` with the static
   `intelPromotionsV1`; the per-response `configVersion` is authoritative.
   Make the registry dynamic?
6. Multi-admin, roles, 2FA, rollback (design §4) remain open.

## Verification

- `test/admin-routes.test.ts` (17): mounting, boot refusal, 401 on every
  protected operation of the artifact, cookie attributes, login / lock /
  expiry / forged / logout, one audit row per write, CAS 409, validation 422,
  production approval 503, pause 503 / 202 / 409, audit paging.
- `test/admin-auth-settings.test.ts` (11): argon2id, hash script output,
  session codec, throttle, envelope, read priority and caching.
- `test/v2-meme-routes.test.ts`: hidden tokens leave `new` and `hot` (after
  the hot cache), detail carries `listing`.
- `test/openapi.test.ts`: the admin artifact is deterministic, holds exactly
  the 20 operations, all cookie-secured, and never appears in V1/V2.
- `test/admin-console.integration.test.ts` (7, PostgreSQL): migration head,
  append-only audit, settings CAS + read priority through the `/v2`
  services, review note beside `community_role_events`, hidden MEME in
  `listTokens` / `rankHotTokens` / `listMemeCandidates`, approval switching
  the version in force with weights applied.
