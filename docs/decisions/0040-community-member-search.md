# Decision 0040: Community member search (`GET /v2/communities/{id}/members?q=`)

- Status: Accepted
- Date: 2026-09-10
- Scope: S16 stream D. Backend only: one optional query parameter on the
  existing member directory. No new table, no new column, no new migration.

## Context

`community-members` has shipped a search box since S3, but there was no
server-side parameter behind it, so the client showed a
"member search unavailable" placeholder. The 2026-09-10 simulator feedback
("why doesn't member search work? why wasn't the endpoint added?") makes the
gap a user-visible defect. `GET /v2/communities/{communityId}/members` had
cursor pagination only.

The pieces already exist: `user_profiles.alias_search_key` is a stored
generated column produced by `public.loop_alias_search_key_unicode17_v1`
(migration 000012) with a `(alias_search_key collate "C", public_profile_id)`
index, and the member directory already left joins `user_profiles`. The
public alias prefix contract and the public alias search quota are already
used by `GET /v2/search?domain=users`. This decision reuses all of them; it
adds no storage.

## Rulings

| Topic          | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parameter      | One optional `q` on the existing read route. No new route, no `POST` search, no separate "member search" resource.                                                                                                                                                                                                                                                                                                                                       |
| Normalization  | Trim, NFKC, lower-case, fold runs of ASCII spaces — the client-side mirror of `loop_alias_search_key_unicode17_v1`. Shared with the public alias prefix by construction: `createAliasPrefixSchema(minimumCodePoints)` in `alias-contract.ts` now produces both schemas.                                                                                                                                                                                  |
| Length         | 1–40 Unicode code points after normalization (the public alias search minimum is 2; one is enough here because the page is already scoped to a single community). Raw input is capped at 256 characters before normalization, as for the public alias prefix.                                                                                                                                                                                            |
| Rejected input | The alias character-safety set is unchanged: control, format (zero width included), surrogate, line-separator, and paragraph-separator code points are rejected in both the raw and the normalized form. `400 INVALID_REQUEST`.                                                                                                                                                                                                                          |
| Matching       | Literal **prefix** of the member alias, never a substring, never `loopId`, wallet address, or chat content. `%`, `_`, and `\` in the query are escaped and match literally. A membership whose profile row or alias is missing has a null key and is never a hit.                                                                                                                                                                                        |
| Where matched  | `profile.alias_search_key collate "C" like loop_alias_search_key_unicode17_v1($n)                                                                                                                                                                                                                                                                                                                                                                        |     | '%'`, added to the same ordered directory query. Ordering (owner → admin → member, then `joined_at`, then `membership_id`) is unchanged. |
| Counts         | `counts.all/owner/admin` stay the counts of the whole non-banned directory and do **not** shrink with `q`, so segment badges do not flicker while typing. An empty result is `items: []`, never a zero count.                                                                                                                                                                                                                                            |
| Pagination     | `q` coexists with `role`, `limit` (1–50, default 20), and `cursor`. The cursor filter becomes `community=<id>&q=<digest>&role=<role>`; a page without `q` keeps the original `community=<id>&role=<role>`, so cursors issued before this change stay valid.                                                                                                                                                                                              |
| Cursor binding | The digest binds the **normalized** key, not the raw text: `FRO`, `ｆｒｏ`, and `  fro  ` continue the same page because they return the same rows. Changing `q` — including adding or removing it — invalidates the cursor with `400 INVALID_REQUEST`.                                                                                                                                                                                                  |
| Quota          | A request carrying `q` consumes the existing public alias search quota (capability `public_alias_search`, 30/min per account, 60/min per IP, 300/day per account), keyed by HMAC over `STREAM_TOKEN_QUOTA_HMAC_SECRET` with the existing domain separation. A directory page without `q` is unmetered.                                                                                                                                                   |
| Fail closed    | When the quota secret is unconfigured the quota is the unavailable stub, so a `q` request answers `503 CAPABILITY_UNAVAILABLE`. The unfiltered directory keeps working. No fallback to an unmetered search, no client-side filtering hint.                                                                                                                                                                                                               |
| Errors         | `400 INVALID_REQUEST`, `401 AUTH_REQUIRED\|AUTH_INVALID`, `403 PERMISSION_DENIED` (only `role=banned`), `404 NOT_FOUND`, `409`, `429 RATE_LIMITED`, `500`, `503 CAPABILITY_UNAVAILABLE`. The route schema previously omitted 403 and 429; `memberListErrors` now declares both.                                                                                                                                                                          |
| Keyset fix     | Found while paging a narrowed directory: `joinedAt` reaches the cursor as the millisecond ISO string the response projects, while `community_memberships.joined_at` stores microseconds, so the raw comparison re-emitted the boundary row on every following page. Both the ordering and the keyset now compare `date_trunc('milliseconds', joined_at)`; `membership_id` still breaks ties. Cursor format is unchanged and existing cursors stay valid. |
| Not in scope   | Fuzzy or substring match, `loopId` search, ranking by relevance, presence or mining-power sorting, and searching the banned view by anything other than the same alias prefix.                                                                                                                                                                                                                                                                           |

## Entities, IDs, state

No new entity. `q` is not stored, not logged as raw text, and never appears in
a cursor in plaintext — a cursor carries only the SHA-256 prefix digest of the
normalized key. Member identity in the response is unchanged
(`publicProfileId`, `loopId`, `alias`, `avatarRef`); `publicProfileId` may be
`null` and such a row is still never a governance target.

## Unavailable behavior

| Condition                        | Result                                               |
| -------------------------------- | ---------------------------------------------------- |
| Quota secret unconfigured        | `503 CAPABILITY_UNAVAILABLE` for `q` only            |
| Quota exhausted                  | `429 RATE_LIMITED`                                   |
| Community repository unavailable | `503 CAPABILITY_UNAVAILABLE` (unchanged)             |
| `counts.online`, `miningPower`   | still `unavailable` with their existing reason codes |

## Consequences

The client can now drive the `community-members` search box directly, with
300 ms debounce and single-flight required by the shared quota. Because the
cursor binds `q`, a client that changes the query must discard the cursor and
restart at the first page; the server rejects the alternative rather than
silently interleaving two result sets.
