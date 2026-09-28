# Decision 0090: LOOP ID exact match in user search, and App Links / Universal Links for `/u/{loopId}`

- Status: Proposed (S98; main-agent task sheet 2026-09-28, following mobile Decision 0104)
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
| Privacy             | **Same admission as the alias branch, per Decision 0031 ruling 2**: target profile `active`, `privacy_preferences_v2.discoverable = true`, not the viewer, and no `user` block in either direction. A non-discoverable account is **not** found even by its exact LOOP ID. No existing decision grants an "exact ID bypasses `discoverable`" exception, so none is introduced here.                           |
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

- A pasted or linked LOOP ID now finds the account **only if that account turned on "可被发现"**. `discoverable` defaults to `false` (Decision 0030), and Decision 0070 observed only 2 of 352 Development accounts had it on, so most IDs will still return nothing until either users opt in or the main agent rules otherwise (see open question).
- Platform verification (Apple CDN fetch, Android `autoVerify`) and the TF build 8 Associated Domains entitlement are unverified until tested on devices against api-dev / api-staging.

## Open questions for the main agent

1. Should an **exact** LOOP ID match bypass `discoverable` (i.e. `discoverable` only hides from alias/prefix browsing)? The privacy-center copy "别人可以通过 LOOP ID 搜到你" reads as if the toggle governs exactly this, so the current behaviour is consistent with it; but with the default `false` the add-friend flow still fails for most accounts. Alternatives: flip the default for new accounts, or prompt in the client.
2. `PASSKEY_IOS_TEAM_ID=867CN6U7W9` should be set in `ops/api-dev.env` / staging if the task sheet's `webcredentials` is wanted on those hosts (a sub-agent must not edit ops).

## Evidence

- `test/v2-community-routes.test.ts` — LOOP ID case/whitespace variants pin the exact row first; non-LOOP-ID shapes pass no `exactLoopId`; cursor pages never re-pin; a page holding only the pinned row restarts the alias rows.
- `test/community-repository.integration.test.ts` — exact row first then alias rows, no duplicates, limit 1, unknown ID, non-discoverable, self, blocked in both directions, plain alias search unchanged.
- `test/well-known-app-links-routes.test.ts`, `test/well-known-passkey-routes.test.ts` — status, content type, cache header, exact bodies, release fingerprint, config validation, landing page with/without download link, malformed IDs, OpenAPI exclusion.
