# Decision 0032: V2 community channels, voice rooms, and the V2 chat wrapper

- Status: Accepted
- Date: 2026-09-08
- Scope: S4/D7–D8 backend (`communication` module, `community` module
  extension). The main-agent rulings of 2026-09-08 in
  `LOOP/docs/modules/S4-communication.md` are adopted verbatim below, plus the
  implementation rulings in "Implementation rulings". The user may overturn any
  row.

## Context

Decision 0021 gave LOOP an official Stream user-token issuer and Decision 0025
gave it backend-created `group` and `direct` channels with a durable operation
state machine. Decision 0031 delivered the community entity, its three-tier
governance model, and the follow/block graph, but left every Stream-derived
community fact (`unread`, `liveVoice`, presence) `unavailable` because no
community channel existed.

S4 needs three things the backend does not have: an official Stream channel per
verified community whose membership tracks LOOP membership, backend-prepared
Stream Video `audio_room` rooms with a host-controlled speaker model, and a
`/v2` projection of the frozen `/v1` chat surface so the mobile client never
mixes contract versions.

## Rulings adopted (main agent, 2026-09-08)

| Topic                                                 | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official channel                                      | Stream `messaging` channel with `loop_channel_kind = "community"` and channel ID `loop_community_<communityId without hyphens>`, created when the community becomes `verified` (the verify script and any future Admin path call the same service). `created_by` is the community creator.                                                                                                                                 |
| Membership sync                                       | join → `addMembers`; leave and ban → `removeMembers`; unban → `addMembers` (revised 2026-09-08, see the revision section: an unban restores the membership instead of deleting it). Every one of those writes goes through a transactional outbox (`community_channel_sync_jobs`) executed after commit by a reconciliation-worker lane. A failure leaves the member `pending` and the UI shows "chat permission syncing". |
| Member cap                                            | `V2_COMMUNITY_CHANNEL_MEMBER_CAP` (default 3000, Stream's default channel ceiling). Above it the LOOP membership still stands and the channel member state becomes `capacityPending`, which the client renders as unavailable. The >3000 Go/No-Go stays open (Decision 0021).                                                                                                                                              |
| Gateway extension                                     | `channel-gateway.ts` gains the `community` kind with incremental `addMembers`/`removeMembers` and no exact member-set validation; a member that is already in (or already out of) the channel is a success. `group` and `direct` behavior is unchanged.                                                                                                                                                                    |
| DM                                                    | An accepted friendship (including one produced by accepting a message request) is the only DM admission rule. `/v2` wraps `POST /v2/chat/direct-channels`, `POST /v2/chat/groups`, `GET /v2/chat/operations/{operationId}`, `POST /v2/chat/token`, and `POST /v2/video/token` with camelCase fields, the seven-field error envelope, and the same state machine.                                                           |
| Small groups                                          | The Decision 0025 3–30 member groups stay as they are. Group member management (kick, rename) stays unavailable; leaving is delivered as `DELETE /v2/chat/groups/{groupId}/membership`, which performs the backend `removeMembers`.                                                                                                                                                                                        |
| Voice rooms                                           | Backend-prepared Stream Video `audio_room` with backstage enabled and the creator as host. Owner or admin opens a room; only the host may invite or remove speakers, mute everyone, or end the room. A listener raises a hand into a PostgreSQL queue with a sequence number. Room state is `live \| ended`; the participant count is a read-only Stream projection with `observedAt`.                                     |
| Voice pre-condition                                   | Decision 0005 still requires Stream Dashboard evidence that the `audio_room` `listener` role does not carry `create-call`. Until it is exported the mobile locator stays unavailable; the backend and the contract ship now with the capability evidence pending. Decision 0039 adds the operator switch (`STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF`) that turns the evidence `confirmed`.                                 |
| Chat search, forward, merge, Token Card, Community AI | Client-side (Stream `client.search`, Stream `sendMessage`, local rendering) or unavailable. None of them adds a LOOP endpoint; chat content never enters `/v2/search`.                                                                                                                                                                                                                                                     |
| E2EE                                                  | End-to-end encryption is not claimed anywhere.                                                                                                                                                                                                                                                                                                                                                                             |

## Implementation rulings

1. **The outbox is keyed by (community, account), not by job.** One row holds
   the latest intended Stream write for a pair, so a join immediately followed
   by a leave collapses to a single `remove` instead of racing two jobs. Re
   enqueuing resets `attempts`, `next_attempt_at`, and the lease. The worker
   claims rows with `for update skip locked` plus a fenced lease, attempts each
   provider call **exactly once** per lease, and moves an unknown result to
   `reconciling` with a bounded exponential backoff. After
   `COMMUNITY_CHANNEL_SYNC_MAX_ATTEMPTS` attempts, or on an authoritative
   projection mismatch, the job and the channel become `failed`; that is a
   terminal unresolved state, never a silent success. Every write-back
   (`completeJob`, `failJob`, `retryJob`, `markChannelProvisioned`) is fenced
   by the caller's own unexpired lease and writes the member and channel
   projections only inside the transaction that consumed that lease, so a
   worker whose lease already lapsed changes nothing. `markChannelProvisioned`
   never clears a `failed` channel: only a confirmed member write does.

2. **Re-verifying a verified community repairs rather than resynchronizes.**
   The early-exit branch of `verifyCommunity` only creates the missing channel
   row and the missing member rows, and only enqueues an `add` for a
   membership whose channel projection is absent or not yet `synced`. An
   account Stream already accepted is never reset and never re-enqueued.

   **The channel is provisioned lazily by the first `add` job.** Verification
   allocates the deterministic channel ID and the member rows inside the
   verifying transaction; the Stream `getOrCreate` happens in the worker, so a
   verification never performs a provider write and a lost response can never
   allocate a second channel.

3. **The worker process now parses Stream credentials.** Decision 0012 kept
   provider configuration out of the reconciliation process, and later
   decisions already widened it for Hyperliquid reads. The
   `community-channel-sync` lane needs a Stream server client, so
   `COMMUNITY_CHANNEL_SYNC_ENABLED` (default `false`) plus the complete
   `STREAM_API_KEY`/`STREAM_API_SECRET` pair are parsed there. Enabling the
   lane without the pair is a startup error; a missing pair with the lane off
   constructs no client at all.

4. **Voice rooms commit locally, then attempt one Stream write, and always
   report which happened.** LOOP PostgreSQL is authoritative for the room
   lifecycle, host identity, LOOP-side role intent, and the hand-raise queue;
   Stream stays authoritative for participants, media state, and live
   permissions. `speakerCount` and `listenerCount` are LOOP role intent, never
   a presence count; the observed participant count walks a bounded number of
   Stream member pages and reports `unavailable` rather than publishing a
   truncated total. Every command response carries
   `providerSync: {status: "confirmed" | "unconfirmed", reasonCode}`, so a
   committed LOOP transition is never presented as a confirmed provider fact.
   An exact idempotency replay skips the local transition and re-attempts only
   the (idempotent) provider call.

5. **`join` is idempotent; every write on an `ended` room is `DATA_STALE`.**
   Joining an already-joined room returns the account's current role rather
   than failing. A room that is not `provisioned` cannot be joined
   (`CAPABILITY_UNAVAILABLE`), because the Stream call may not exist; that
   check runs inside the join transaction, so the refusal leaves no
   membership, audit, or idempotency row behind.

6. **The hand-raise sequence is allocated under the `voice_rooms` row lock.**
   `voice_rooms.hand_raise_sequence` is incremented inside the same
   transaction that inserts the raise, so concurrent raises get a stable total
   order with no gaps and no duplicates. A partial unique index enforces at
   most one `pending` raise per (room, account); a second raise while one is
   pending is `DATA_STALE`. `sequence` is published as a decimal string, never
   a JavaScript number.

7. **Group leave inverts the usual order, and only because removal is
   idempotent.** `DELETE /v2/chat/groups/{groupId}/membership` authorizes the
   caller, performs the single Stream `removeMembers` call, and only then
   commits the LOOP membership deletion and its audit row. Stream treats
   removing a non-member as a success, so retrying after an unknown result is
   safe and can never report a leave that did not happen. An unknown provider
   result is `PROVIDER_DISCONNECTED` with no local change; the retry uses the
   same `Idempotency-Key`, and because `prepareChatGroupLeave` claims that
   record it recognizes an already-committed leave, replays only the
   idempotent Stream removal, and answers `200` instead of `DATA_STALE`. Decision 0025's
   freeze on `communication_group_members` is narrowed to exactly this
   transition: a non-creator member deleting its own row. Role changes and
   creator removal stay rejected by the database trigger.

8. **`GET /v2/communities/{id}` gains `chat` and `voice`.** `chat.status` is
   `available` only when the channel is provisioned **and** the viewer's
   channel member state is `synced`; `pending`, `capacityPending`, a failed
   channel, and a non-member each report their own machine reason code.
   `voice.status` is `available` only when a `live`, `provisioned` room exists
   and the viewer is a non-banned community member. A LOOP membership never
   implies a Stream channel membership.

## Persistence (migration `000017_v2_communication`, append-only)

Eight relations, all registered in `src/database/schema.ts`:

- `community_channels` — `community_id` primary key, deterministic
  `stream_channel_id`, `state` (`created | capacityPending | failed`),
  `member_cap`, `created_by_user_id`, `provisioned_at`, `last_error_code`,
  `record_version`.
- `community_channel_members` — `(community_id, owner_user_id)` primary key,
  `stream_user_id`, `state` (`synced | pending | removed | capacityPending`).
- `community_channel_sync_jobs` — the outbox: `(community_id, owner_user_id)`
  primary key, `kind` (`add | remove`), `state`
  (`pending | reconciling | succeeded | failed`), `attempts`,
  `next_attempt_at`, `last_error_code`, and a fenced
  `lease_worker_id`/`lease_expires_at` pair.
- `voice_rooms` — deterministic `call_id`, `state` (`live | ended`),
  `provision_state` (`pending | provisioned | reconciling | failed`),
  `backstage`, `hand_raise_sequence`, with a partial unique index enforcing at
  most one `live` room per community.
- `voice_room_members` — `role` (`host | speaker | listener`), `state`
  (`joined | left | removed`), one host per room.
- `voice_room_hand_raises` — `sequence` unique per room, `state`
  (`pending | invited | cancelled`), one `pending` row per (room, account).
- `voice_room_events` — append-only audit with a unique
  `idempotency_record_id`.
- `chat_group_membership_events` — append-only audit for the group-leave
  command, also with a unique `idempotency_record_id`.

`idempotency_records.digest_version` gains `communication_command_v1`, and the
scope `v2_communication_command`. Rollback refuses while any communication row
or command record exists.

## Routes

`communication` module (`src/routes/v2/chat.ts`,
`src/routes/v2/voice-rooms.ts`). Every write requires exactly one canonical
UUIDv4 `Idempotency-Key`; every read rejects one.

| Method   | Path                                                       | Semantics                                                      |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `POST`   | `/v2/chat/token`                                           | Stream Chat user token (one hour), camelCase                   |
| `POST`   | `/v2/video/token`                                          | Stream Video user token (one hour), camelCase                  |
| `POST`   | `/v2/chat/groups`                                          | V2 projection of the V1 group-create operation                 |
| `POST`   | `/v2/chat/direct-channels`                                 | V2 projection of the V1 direct get-or-create operation         |
| `GET`    | `/v2/chat/operations/{operationId}`                        | Owner-bound operation poll; 202 + `Location` while nonterminal |
| `DELETE` | `/v2/chat/groups/{groupId}/membership`                     | Leave a small group; creator is `PERMISSION_DENIED`            |
| `POST`   | `/v2/communities/{communityId}/voice-rooms`                | Open a room (owner or admin); 201                              |
| `GET`    | `/v2/communities/{communityId}/voice-rooms/current`        | The live room, or `null` with `COMMUNITY_VOICE_ROOM_NOT_LIVE`  |
| `GET`    | `/v2/voice-rooms/{voiceRoomId}`                            | One room with the viewer's role and hand raise                 |
| `GET`    | `/v2/voice-rooms/{voiceRoomId}/hand-raises`                | Pending queue in sequence order                                |
| `POST`   | `/v2/voice-rooms/{voiceRoomId}/join`                       | Idempotent join; returns `callCid`, role, and `expiresAt`      |
| `POST`   | `/v2/voice-rooms/{voiceRoomId}/leave`                      | Leave; the host must end the room instead                      |
| `POST`   | `/v2/voice-rooms/{voiceRoomId}/hand-raise`                 | Raise a hand (listener only, one pending)                      |
| `DELETE` | `/v2/voice-rooms/{voiceRoomId}/hand-raise`                 | Cancel a pending raise                                         |
| `POST`   | `/v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}` | Host invites a speaker and grants `send-audio`                 |
| `DELETE` | `/v2/voice-rooms/{voiceRoomId}/speakers/{publicProfileId}` | Host demotes a speaker and revokes `send-audio`                |
| `POST`   | `/v2/voice-rooms/{voiceRoomId}/mute-all`                   | Host mutes everyone                                            |
| `POST`   | `/v2/voice-rooms/{voiceRoomId}/end`                        | Host ends the room; every later write is `DATA_STALE`          |

`GET /v2/communities/{communityId}` (the `community` module) grows `chat` and
`voice`. The V2 artifact carried 52 operations under `/v2` at the time of this
decision (54 with the two
shared `/health/*` endpoints).

## Capabilities

`GET /v2/meta/capabilities` grows from 21 to 23 entries:

| Capability      | State                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `communityChat` | `available` only with `communication` enabled, the PostgreSQL communication repository composed, the community runtime available, and Stream credentials present; otherwise `unavailable` (`COMMUNICATION_RUNTIME_UNAVAILABLE`) or `deferred` (`V2_COMMUNICATION_RUNTIME_DEFERRED`) |
| `voiceRooms`    | The same availability, but `evidence` is `{status: "pending", reasonCode: "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING"}` until the Decision 0005 Dashboard export exists; Decision 0039 defines how an operator confirms it                                                              |

## Consequences

- Nothing here is Provider or device evidence. Without Stream credentials the
  channel gateway, the call gateway, and both capabilities fail closed, and the
  `community-channel-sync` lane is not constructed at all.
- A verified community's channel does not exist on Stream until the sync lane
  runs. `chat.status` reports `COMMUNITY_CHANNEL_NOT_PROVISIONED` until then;
  no CID is published early.
- The V1 chat routes, service, operation journal, and idempotency domain are
  untouched. The V2 wrapper adds no second state machine.
- Voice-room participant counts, live speaking state, and presence remain
  Stream facts. LOOP publishes only what it can prove, with `observedAt`.
- The `>3000` member Go/No-Go, the Decision 0005 role evidence (confirmed
  through the Decision 0039 switch once the Dashboard export exists), and
  real-device Stream connection evidence all remain open.

## Rollback

Remove `communication` from `V2_MODULES_ENABLED`: every route disappears and
both capabilities return to `deferred`. Set `COMMUNITY_CHANNEL_SYNC_ENABLED` to
`false` to stop all Stream membership writes; the outbox rows stay and resume
when it is re-enabled. The migration rolls back only while no communication row
exists, and restoring it re-freezes `communication_group_members`.

## Revision 2026-09-08 — S3/S4 integration hotfix

Real Stream Dev traffic (`LOOP/docs/integration/S3/report.md`,
`LOOP/docs/integration/S4/report.md`) produced four corrections. The main agent
ruled each of them on 2026-09-08; this section supersedes the affected rows
above.

| Finding                                                                                                                                                                                                                            | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-01: every write endpoint that carries a body failed with `AbortError` behind a real socket. Fastify derives `request.signal` from `request.raw.on("close")`, and Node 24 emits that as soon as the request body has been read. | `src/core/http/request-abort-signal.ts` installs an own `signal` property on each request in the first `onRequest` hook. It aborts only on a real client disconnect (`reply.raw` closed with `writableEnded === false`) or the 15s deadline. `handlerTimeout` stays as the framework's own reply guarantee. Covered by `test/request-abort-signal.test.ts`, which listens on a real port and uses `fetch`; `app.inject()` cannot reproduce the defect.                                                                                                                                                                              |
| BUG-02: `addMembers` never created the joiner's Stream user, so Stream answered HTTP 400 ("users ... don't exist") and the outbox retried a deterministic failure ten times.                                                       | `addMembers` upserts the joined accounts with the same `{id}`-only shape used at channel creation, before the `update`. A deterministic 4xx (anything but 408/425/429) now raises `StreamChannelRequestRejectedError`, and the sync lane records it as terminal `failed` with `last_error_code = stream_channel_request_rejected` instead of consuming its ten attempts. 5xx, timeouts, and quota answers stay retryable.                                                                                                                                                                                                           |
| BUG-03: the Stream application has no `listener` call role (`UpdateCallMembers` answers `role "listener" is invalid`), so every voice-room join stayed `unconfirmed`.                                                              | LOOP call roles are mapped to Stream call roles inside `call-gateway.ts`: `listener → user`, `speaker → speaker`, `host → admin` with a single fallback to `user` plus `updateUserPermissions` granting `send-audio`, `mute-users`, and `end-call` when the application rejects `admin` deterministically. The Decision 0005 pre-condition becomes evidence that the **`user`** role does not carry `create-call`, and the capability reason code is renamed `AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING`.                                                                                                                               |
| S3 FINDING-1/2: the member directory filtered out banned memberships (so an unban had no entry point) and an unban deleted the membership row (so it silently meant "removed from the community").                                 | `GET /v2/communities/{id}/members?role=banned` is a governance view restricted to an owner or admin (`viewer.canBan`); it returns the memberships whose `status` is `banned`, which the other views still exclude. `counts.all/owner/admin` remain the non-banned counts. `DELETE .../ban` now restores the membership to `role: member, status: active`, keeps the row and its `joined_at`, writes the `member_unbanned` audit as before, and enqueues an `add` channel-sync job (a no-op until the channel is provisioned). No governance action deletes a membership any more; leaving the community is the only path that does. |

Still open after this revision: the Decision 0005 Dashboard export (now for the
`user` role; the evidence requirements and the operator switch that records it
are Decision 0039), the `>3000` member Go/No-Go, and real-device Stream
evidence.
