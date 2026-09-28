# Decision 0090: LOOP ID exact match in user search, and App Links / Universal Links for `/u/{loopId}`

- Status: Accepted (S98; main-agent task sheet 2026-09-28, following mobile Decision 0104)
- Date: 2026-09-28
- Scope: `GET /v2/search?domain=users` matching rule; `GET /.well-known/apple-app-site-association` and `GET /.well-known/assetlinks.json` content (amends Decision 0063); new `GET /u/{loopId}` landing page; two optional environment keys. No migration, no new entity, no state machine, no new error code, no response-shape change.

## Context

Users exchange their LOOP ID (`LOOP-FE3EMCPE`), and mobile Decision 0104 lets them copy, share, and paste it, and opens `https://<api host>/u/LOOP-…` links into the `search` page. The backend `users` domain only matched the alias prefix (`user_profiles.alias_search_key`), never `loop_users.loop_id`, so a pasted or linked ID always returned "no results". The hosts also did not publish the `/u/*` association files the platforms need before they hand such a link to the app.

## Decision

### 1. LOOP ID exact match (`users` domain)

| Topic               | Rule                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger             | `q`, after trimming surrounding whitespace, matches `^LOOP-[0-9A-Z]{8}$` case-insensitively (`loopIdSearchQuery` in `src/features/identity/loop-id.ts`). The shape is looser than the Crockford alphabet on purpose: a typed `I`/`L`/`O`/`U` still takes the exact path and simply matches nobody. No Crockford aliasing (`O`→`0`) is applied. Five-character invite codes and other shapes never trigger it. |
| Comparison          | Upper-cased query equals `loop_users.loop_id` (stored upper-case, unique, check-constrained) — an index-backed equality, never a prefix or substring match on the LOOP ID, so the ID space stays non-enumerable.                                                                                                                                                                                              |
| Ordering            | The exact account is the first row of the **first page** (no cursor). It is excluded from the alias-prefix rows on every page, so it never appears twice. It counts against the page `limit`.                                                                                                                                                                                                                 |
| Cursor              | Unchanged binding (owner, route, canonical filter). The continuation keeps the last **alias** row's `searchKey`/`stableId`; when a page held only the pinned account, the continuation carries only `limit`, and the next page starts the alias rows from the top without re-pinning.                                                                                                                         |
| Privacy             | **Revised by the main-agent ruling below.** Both branches require an active profile, exclude the viewer, and exclude a `user` block in either direction. The alias-prefix branch additionally requires `privacy_preferences_v2.discoverable = true`; the exact LOOP ID branch does **not** read `discoverable` (a missing privacy row does not hide the account either).                                      |
| Self                | Excluded, as before: searching your own LOOP ID returns no row for you.                                                                                                                                                                                                                                                                                                                                       |
| Alias requirement   | The exact branch does not require a non-null alias (the display title already falls back to the LOOP ID); the alias branch still does.                                                                                                                                                                                                                                                                        |
| Non-LOOP-ID queries | Byte-identical SQL predicates and ordering to before; the repository receives no `exactLoopId`.                                                                                                                                                                                                                                                                                                               |
| Quota / errors      | Same `public_alias_search` quota, same validation (`parseAliasSearchPrefix` still runs first), same error codes. Unknown and hidden IDs both return an empty `results` array (non-enumerating).                                                                                                                                                                                                               |
| Response            | Shape unchanged; no "exact match" flag is exposed.                                                                                                                                                                                                                                                                                                                                                            |

Implementation: `SearchUsersInput` gains optional `exactLoopId` + `includeExactMatch`; `SearchUserRecord` gains `exactLoopIdMatch` and a nullable `searchKey` (null only for an exact row without alias). The PostgreSQL query is an `exact_match` CTE `union all` the bounded `prefix_match` CTE, ordered `exact desc, alias_search_key, public_profile_id`, limited once.

### 2. Association files (amends Decision 0063)

There was already one route per file (Decision 0063, passkeys); the `/u/*` association is merged into them, no second route exists.

- `apple-app-site-association` always answers 200 with `{"applinks":{"details":[{"appIDs":["867CN6U7W9.com.cywd.loop"],"components":[{"/":"/u/*"}]}]}}`. `webcredentials.apps` is added **only** when `PASSKEY_IOS_TEAM_ID` is configured, exactly as Decision 0063 ruled. With `PASSKEY_IOS_TEAM_ID=867CN6U7W9` the body is byte-identical to the S98 task sheet document (tested).
- `assetlinks.json` always answers 200. Statement 1: `["delegate_permission/common.handle_all_urls"]`, `com.cywd.loop`, the Development debug keystore `AE:60:…:3E:FA`, followed by `ANDROID_RELEASE_CERT_SHA256` entries (comma-separated, validated like `PASSKEY_ANDROID_CERT_SHA256`, must not repeat the debug fingerprint). With no passkey configuration the body is byte-identical to the task sheet document (tested). When `PASSKEY_ANDROID_CERT_SHA256` is set, Decision 0063's statement follows unchanged as statement 2.
- The iOS app ID, Android package, and debug fingerprint are compiled constants in `src/config.ts` (public facts of the app build, not secrets).
- `Cache-Control: public, max-age=3600` for both (was 300). `Content-Type: application/json` exactly, no redirect, no authentication.
- The `404` path of Decision 0063 no longer exists for these two files.

### 3. `GET /u/{loopId}` landing page

- Static HTML (`text/html; charset=utf-8`, `public, max-age=3600`) for a visitor without the app: the upper-cased LOOP ID, "在 LOOP 里添加好友", and a hint to paste the ID in LOOP search. A "下载 LOOP" link appears only when `APP_DOWNLOAD_URL` (https, no credentials; validated at startup) is set.
- Accepts `LOOP-` + 8 letters/digits, any case. Anything else → `404` HTML "链接无效", `no-store`.
- Never reads the database and never says whether the account exists. No script, no third-party resource; `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; …`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.

### OpenAPI

The three routes are `hide: true` (not `/v2`, not part of the client contract); `docs/api-inventory.md` lists them. The `searchV2` description now states the LOOP ID rule, so `openapi/loop-api.v2.json` changes only in that description.

## Unavailable behaviour

None new. Search stays governed by the `search` capability. The association files have no unavailable state; the passkey parts are absent without their configuration.

## Consequences

- A pasted or linked LOOP ID finds any active, unblocked account other than the viewer, whatever its `discoverable` value. Alias-prefix browsing still shows only discoverable accounts.
- Message requests ("add friend") no longer consult `discoverable` (ruling 4 below); follow still does. An account found by exact LOOP ID can therefore be sent a friend request unless it turned `friendRequests` off or a block exists.
- Platform verification (Apple CDN fetch, Android `autoVerify`) and the TF build 8 Associated Domains entitlement are unverified until tested on devices against api-dev / api-staging.

## Open questions for the main agent

1. ~~Should an exact LOOP ID match bypass `discoverable`?~~ Ruled below.
2. ~~`PASSKEY_IOS_TEAM_ID` on api-dev / staging~~ — the main agent sets it in ops.
3. ~~**Open:**~~ Ruled below (ruling 4). Follow and message-request admission still require `discoverable = true`. With this ruling a non-discoverable account can be found by LOOP ID but cannot be sent a friend request (`404 NOT_FOUND`), so the add-friend complaint persists for the default (`false`) account. Should `POST /v2/message-requests` (and follow) admit a target the caller reached by exact LOOP ID — e.g. drop `discoverable` from those gates, leaving `friendRequests` (Decision 0070) as the recipient's opt-out?

## Main-agent ruling (2026-09-28)

1. **Exact LOOP ID match bypasses `discoverable`.** Handing someone your LOOP ID is an explicit act; `discoverable` governs only passive alias/prefix discovery. Blocks (both directions) and self-exclusion still apply. The privacy-center copy "别人可以通过 LOOP ID 搜到你" therefore holds. **This revises Decision 0031 implementation ruling 2** for `GET /v2/search?domain=users`: `discoverable = true` is now required only for the alias-prefix rows; follow admission under ruling 2 is not changed by this ruling.
2. `PASSKEY_IOS_TEAM_ID=867CN6U7W9` is set in ops by the main agent (no code change).
3. `Cache-Control: public, max-age=3600` for the passkey files as well: accepted.

4. **(2026-09-28, closes open question 3) `POST /v2/message-requests` no longer requires the target to be `discoverable`.** The recipient-side gates are exactly two: the recipient's `friendRequests` switch (Decision 0070, default `enabled`) and a block in either direction; an unactivated target and self stay excluded. Every refusal is still the same non-enumerating `404 NOT_FOUND`; the V1 state-machine conflicts (existing friendship, pending pair, rejection cooldown) are still `409 DATA_STALE`. **`POST /v2/connections/follow/{publicProfileId}` keeps requiring `discoverable = true`**: a follow cannot be refused, so passive visibility stays under the target's control. This revises **Decision 0031** (the message-request admission row "identical to `follow` … `discoverable = true`") and **Decision 0070** item 4 ("`discoverable` is unchanged and still required for message requests") and its `friendRequests` table row. The frozen V1 `/v1` friend-request path is not changed.
   - Privacy-center meaning (client copy to be aligned by the frontend): 「可被发现」 = others can find you by alias and follow you; your LOOP ID can always be searched exactly and used to send you a friend request unless 「允许陌生人发好友申请」(`friendRequests`) is off.

## Evidence

- `test/v2-community-routes.test.ts` — LOOP ID case/whitespace variants pin the exact row first; non-LOOP-ID shapes pass no `exactLoopId`; cursor pages never re-pin; a page holding only the pinned row restarts the alias rows.
- `test/community-repository.integration.test.ts` — a non-discoverable recipient receives a message request, `friendRequests=disabled` and a block still refuse, follow still refuses a non-discoverable target; exact row first then alias rows, no duplicates, limit 1, unknown ID, non-discoverable and privacy-row-less accounts found by exact ID but not by alias prefix, self, blocked in both directions, plain alias search unchanged.
- `test/well-known-app-links-routes.test.ts`, `test/well-known-passkey-routes.test.ts` — status, content type, cache header, exact bodies, release fingerprint, config validation, landing page with/without download link, malformed IDs, OpenAPI exclusion.
