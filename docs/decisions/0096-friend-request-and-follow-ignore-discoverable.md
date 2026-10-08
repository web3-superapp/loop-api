# Decision 0096: Friend requests and follows no longer require the target to be discoverable

- Status: Accepted (S107b)
- Date: 2026-10-08
- Scope: admission predicates only. `POST /v1/friend-requests` (repository `sendFriendRequest`) and `POST /v2/connections/follow/{publicProfileId}` (repository `follow`) stop reading `discoverable`. No migration, no new route, no new error code, no request/response shape change. The V2 OpenAPI artifact changes only in the follow operation's description. Search (`GET /v2/search`, `GET /v1/friends/search`, alias directory) is unchanged.
- Baseline: `integration/v2` = `81be95e`
- Inputs: main-agent task S107b (2026-10-08 simulator report), Decision 0095 §3, `LOOP/docs/09-需求方v3需求与裁决.md` (real-identity social).

## Context

Simulator run, 2026-10-08: the S109a public profile page (opened from a group-chat avatar; Decision 0095 §3 lets any activated account be read without consulting `discoverable`) showed an "add friend" button, and tapping it returned `404 target_unavailable` from `POST /v1/friend-requests`. The target (`Mark马克`) had neither a `privacy_preferences` row nor a `social_privacy_preferences` row.

Cause: the V1 friend-request admission query inner-joined `public.privacy_preferences` and required `privacy.discoverable = true`. A missing row therefore excluded the target, and `discoverable` defaults to `false`, so every account that never opened the privacy center could not receive a friend request at all. The V2 follow command had the same shape: `resolveTarget(..., requireDiscoverable: true)` with `coalesce(privacy_preferences_v2.discoverable, false)`, so a default account could not be followed either.

This contradicts the v3 real-identity social model: the app now leads users to other people's profiles from chat avatars and share links (Decision 0095), and the page offers "add friend" and "follow" on every one of them. Decision 0090 already removed `discoverable` from `POST /v2/message-requests` for the same reason, but (ruling 4) deliberately left follow and the frozen V1 friend-request path untouched.

## Decision

1. **Friend-request admission (`POST /v1/friend-requests`)** — the target is eligible when all of these hold:
   - the target profile exists and is activated (`alias is not null`) and is not the caller;
   - no `user` block exists in either direction (`public.user_blocks`, kind `user`; this check is new on the V1 path, which previously relied only on the `discoverable` join);
   - `coalesce(social_privacy_preferences.friend_requests, 'enabled') <> 'disabled'` (Decision 0070: a missing row is the open default; the column allows only `enabled | disabled`, so there is no `friends_only` state to preserve).

   `privacy_preferences` (V1 presentation preferences) is no longer joined. Every refusal is still the same non-enumerating `404 target_unavailable`. The V1 state-machine checks (existing friendship, pending pair, rejection cooldown) are unchanged.

2. **Follow admission (`POST /v2/connections/follow/{publicProfileId}`)** — the target must be an active profile other than the caller with no block in either direction; `discoverable` is not read. The `requireDiscoverable` option of the community repository's `resolveTarget` is removed (follow was its only `true` caller). Refusals stay `404 NOT_FOUND`. Unfollow is unchanged (it never read `discoverable`).
3. **`discoverable` from now on governs only listing**: whether alias-prefix search and recommendations list the account. The Decision 0090 search semantics (alias-prefix rows require `discoverable = true`; an exact LOOP ID match ignores it) are unchanged. No social command (follow, friend request, message request, direct channel, group invite) reads it.

### Revisions

- **Decision 0090, ruling 4**: the sentence "`POST /v2/connections/follow/{publicProfileId}` keeps requiring `discoverable = true`: a follow cannot be refused, so passive visibility stays under the target's control" and the closing sentence "The frozen V1 `/v1` friend-request path is not changed" are revised by items 1–2. The Consequences line "follow still does" is likewise superseded.
- **Decision 0031**: implementation ruling 2, "Follow and user search require `discoverable = true`", now applies to user search (alias-prefix rows) only; the follow-graph table row "A blocked or non-discoverable target returns one non-enumerating error" now reads "a blocked target".

### Note on the `/v1` freeze

Changing behavior behind a `/v1` route conflicts with the standing "`/v1` frozen" rule (00 §2, loop-backend). It is done here on the main agent's explicit instruction because the shipping mobile client still calls `POST /v1/friend-requests` from the public profile page (the V2 handoff in `docs/frontend-v2-social-api.md` names `POST /v2/message-requests`, which already ignored `discoverable` since Decision 0090). Only the admission predicate changes; the V1 route schema, error codes, and storage are untouched.

## Tests

- `test/social-repository.integration.test.ts` — a target with no `privacy_preferences` and no `social_privacy_preferences` row and a target with `discoverable = false` both receive a pending request; `friend_requests = 'disabled'` and a block in either direction still raise `SocialTargetUnavailableError`; alias search still hides the non-discoverable account.
- `test/community-repository.integration.test.ts` — follow succeeds for a non-discoverable target and for a target with no privacy rows; a block still refuses; search still hides the non-discoverable account; the Decision 0090 message-request test now expects follow to succeed.

## Consequences

- Any activated account that has not turned `friendRequests` off and has not blocked (or been blocked by) the caller can be sent a friend request and can be followed, matching what the public profile page offers.
- A user who wants to stop friend requests uses the `friendRequests` switch; there is no switch to refuse followers (a block remains the remedy). The privacy-center copy for `discoverable` should drop "关注你".
