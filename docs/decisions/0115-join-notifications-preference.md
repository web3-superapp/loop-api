# Decision 0115: Join-time notification preference, applied by the channel sync lane (S135)

- Status: Accepted (S135-api)
- Date: 2026-10-10
- Baseline: `integration/v2` = `3a0bf9c`
- Inputs: main-agent S135 task; `docs/acceptance/2026-10-10-privy-switch-emulator.md`
  (onboarding joined 5 communities, 4 showed "joined, but mute did not
  succeed"); Decisions 0032 (channel sync outbox), 0055 / 0095 (persona,
  real identity), 0091 (channel roles).
- Scope: migration `000060_join_notifications_preference`, the join body,
  `GET /v2/communities/{communityId}/membership`, the
  `community-channel-sync` lane, the Stream community channel gateway.
  No new environment key, no new worker lane.

## Problem

The app called Stream `channel.mute()` right after
`POST /v2/communities/{id}/join` returned. The Stream channel membership is
written later, asynchronously, by the `community-channel-sync` lane
(Decision 0032), and Stream refuses a mute from a non-member. The one
community that worked was the one whose sync happened to finish first.

## Decision

The server owns the mute; the client no longer races the lane.

1. **Join body (optional).** `{ "notifications": "default" | "muted" }`.
   No body, `{}` and `null` are `default`, so every existing caller is
   unchanged — including its idempotency digest. `muted` is bound into the
   digest (`[communityId, "notifications=muted"]`), so one key used with two
   preferences is `IDEMPOTENCY_CONFLICT`. Any other value or key is
   `INVALID_REQUEST`.
2. **Stored on the membership.** `community_memberships.notifications`
   (`default` | `muted`, default `default`) is written only when the join
   creates the row; an already-active member keeps its preference. Leave
   deletes the row, so a re-join starts from the new request.
   `community_memberships.notifications_applied_at` is set once the lane
   confirmed the mute; a check keeps it null for `default` rows.
3. **Applied by the lane, after the add.** The job claim reads
   `memberMuteRequired = notifications = 'muted' and applied_at is null`.
   After `addMembers` resolved, the lane calls the new gateway method
   `muteCommunityChannelForMember` — one server-side
   `POST /chat/moderation/mute/channel` with `user_id = member` and
   `channel_cids = ["messaging:<channel>"]` — and records
   `notificationsApplied` in the same fenced `completeJob` transaction (only
   when the member ends `synced`). The gateway resolves only on a
   `channel_mute`/`channel_mutes` echo for that channel and member.
4. **Failure handling, under the existing retry budget.**
   - Transient (5xx, 408/425/429, timeout, unconfirmed echo): the job goes
     to `reconciling` with `last_error_code = stream_channel_mute_unavailable`
     and the usual backoff. The next attempt re-adds (idempotent) and mutes.
   - Deterministic rejection (other 4xx), or a transient failure on the
     last attempt: the membership is **not** failed — the add already
     happened. The job completes `synced`, the mute stays unapplied, and the
     lane logs `Community channel mute was not applied; the membership sync
completed without it` (`write: "mute"`). The user can still mute by
     hand in the chat page.
   - A member parked at the channel cap (`capacityPending`) is not muted.
5. **Only once.** A later `add` of the same membership (a role change,
   Decision 0091; a verification repair) does not mute again, so a user who
   unmuted in the app is never overridden.
6. **Read model.** `GET /v2/communities/{communityId}/membership` returns
   `{communityId, membership, notifications, channelSynced, contractVersion}`
   from one PostgreSQL read (no Stream call), `no-store`. `channelSynced`
   is true only when the channel member row is `synced` and, for `muted`,
   the mute was applied. A community the viewer cannot see is `NOT_FOUND`;
   no membership reads `membership: null, notifications: null,
channelSynced: false`. Clients poll it briefly after a muted join.

## Not changed

- `GET /v2/communities/{id}` and the community resource keep their shape;
  `viewer.membership` does not carry the new fields.
- Manual mute/unmute in the chat page stays a client Stream SDK call.
- No unmute path on the server: `default` never unmutes anything.

## Verification

- Unit: worker (mute after the confirmed add, no mute for default, no mute
  when the add failed, retry code, soft completion on rejection and on the
  last attempt, no mute at capacity); gateway (request shape, echo
  validation, 4xx/429/5xx classification, refused inputs, unavailable
  adapter); routes (body-less/`{}`/default digest unchanged, muted digest,
  invalid bodies, membership read shape, 404, query/Idempotency-Key refused);
  migration contract.
- Integration `test/join-notifications.integration.test.ts` (throwaway
  database from `DATABASE_URL_TEST` = `loop_api_test_s135`): join(muted) →
  one worker round → the Stream fake saw `addMembers` then the mute for that
  member, `channelSynced` flips to true; join(default) never mutes; a failed
  mute retries (`stream_channel_mute_unavailable`), re-adds and mutes on the
  next attempt; a re-add does not mute again and leave + re-join resets the
  preference; idempotency conflict across preferences; non-member read.
