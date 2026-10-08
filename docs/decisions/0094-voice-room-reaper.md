# Decision 0094: The `voice_room_reaper` worker lane ends abandoned and over-age voice rooms

- Status: Accepted (S106c)
- Date: 2026-10-08
- Scope: one new reconciliation-worker lane (`voice_room_reaper`), one new repository (`VoiceRoomReaperRepository`: a listing read and a row-locked end), four worker environment keys, five worker log messages. No route, no OpenAPI change, no migration, no new table or column, no new audit event type, no `/v1` change.
- Baseline: `integration/v2` = `0748c31`

## Context

A voice room ends only when its host calls `POST /v2/voice-rooms/{id}/end` (Decision 0032). A host who closes the app without ending leaves the room `live` forever. The Development database had one such room, live since 2026-09-22 with nobody in it; since Decision 0093 the plaza list shows it as "直播中 · 开播 15 天", and the one-live-room-per-community index (`voice_rooms_one_live_per_community_idx`) blocks that community from opening another room.

What LOOP knows about presence:

- `voice_room_members` is LOOP role intent (Decision 0051). Speakers and listeners move to `left` when they leave.
- **The host row is always `joined`.** The check `voice_room_members_host_state_check` (`role <> 'host' or state = 'joined'`) makes any other state unrepresentable, and `leave` refuses the host (it ends instead). So "host + speaker + listener joined = 0" is never true for any room: the abandoned 9-22 room has its host row `joined` today.
- Whether anyone, the host included, is actually connected is a Stream fact: the call's session participant count (`observeSession`, one `GetCall`; Decision 0051). AGENTS.md: Stream is the source of truth for presence.
- `voice_rooms.updated_at` and `voice_room_members.updated_at` are written by every LOOP room and member transition (join, leave, invite, remove, mute, provisioning, go-live write-back).

## Decision

### 1. The rule

Each pass lists at most **50** live rooms (`state = 'live'`, any provision state), oldest `created_at` first, with the database clock. For each room:

| Order | Condition                                                                                                               | Outcome                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1     | `now − created_at ≥ VOICE_ROOM_MAX_LIVE_HOURS` (default 12)                                                             | end, `VOICE_ROOM_MAX_AGE_ENDED`; no Stream read, whoever is in it |
| 2     | a `joined` speaker or listener exists                                                                                   | keep; no Stream read                                              |
| 3     | `now − greatest(voice_rooms.updated_at, max(voice_room_members.updated_at)) < VOICE_ROOM_IDLE_END_MINUTES` (default 10) | keep; no Stream read                                              |
| 4     | room not `provisioned` (no confirmed Stream call to observe)                                                            | keep (presence unknown); the hard cap still applies               |
| 5     | one Stream `observeSession`: confirmed `participantCount = 0`                                                           | end, `VOICE_ROOM_IDLE_ENDED`                                      |
| 6     | the read reports ≥ 1 device, fails, times out, or is malformed                                                          | keep (an unknown presence is not an empty room)                   |

"Idle" therefore means: LOOP has seen nobody but the host and no LOOP change for the idle window, **and** Stream confirms no device is connected right now. The host's own device counts as a participant, so a host alone in a room they are still in keeps it until the hard cap.

This departs from the module sheet's literal "host + speaker + listener joined all 0" because that condition is unsatisfiable (the host row cannot leave); the host's presence is taken from Stream, which is the only place it exists.

### 2. The end path

The lane ends a room the way `POST …/end` does, LOOP first, then Stream:

1. `endVoiceRoomByReaper` in one transaction: lock the `voice_rooms` row (`for update`, the same lock join and leave take), **re-check the rule under the lock** (`max_age`: `created_at` still older than the cap; `idle`: still no joined speaker/listener and no LOOP change within the window), and only then `state = 'ended'`, `ended_at`, `record_version + 1`, `updated_at`; cancel pending hand raises; append `voice_room_events` `room_ended` with `actor_user_id = null`, `idempotency_record_id = null`, a fresh `request_id`, and `reason_code` `voice_room_idle_ended` / `voice_room_max_age_ended` (the audit's lower-case form). A room that no longer qualifies (a listener joined between the listing and the end, the host ended it) is `skipped` and nothing is written.
2. Exactly one Stream `endCall`. If it is not confirmed, the LOOP room stays ended and the lane logs `STREAM_CALL_END_UNCONFIRMED` — the same outcome as the end command's `providerSync: unconfirmed` (0032). It is never retried or replayed; the room is no longer `live`, so no later pass touches it.

No actor and no idempotency key: this is a system transition, not a user command. The existing nullable audit columns carry it; no migration.

### 3. Lane composition and failure

- Lives in the reconciliation worker process like every other lane (`src/voice-room-reaper-worker.ts`), its own loop, one pass per `VOICE_ROOM_REAPER_INTERVAL_MS` (default 60 000).
- A failed listing read backs off 1 s → 60 s (`voice_room_reaper_unavailable` on the shared retry line) and never rejects the loop, so it cannot stop another lane. A failure on one room is logged and the pass continues with the next.
- Needs `STREAM_API_KEY` / `STREAM_API_SECRET` (parsed for this lane independently of `COMMUNITY_CHANNEL_SYNC_ENABLED`). Without them the lane is not constructed and the worker logs once `VOICE_ROOM_REAPER_STREAM_NOT_CONFIGURED`: without Stream it could neither observe presence nor end the call.
- At most 50 rooms per pass, at most one Stream read and one Stream write per room.

### 4. Configuration (worker process)

| Key                             | Default | Range           |
| ------------------------------- | ------- | --------------- |
| `VOICE_ROOM_REAPER_ENABLED`     | `true`  | `true`/`false`  |
| `VOICE_ROOM_REAPER_INTERVAL_MS` | `60000` | 5 000–3 600 000 |
| `VOICE_ROOM_IDLE_END_MINUTES`   | `10`    | 1–1 440         |
| `VOICE_ROOM_MAX_LIVE_HOURS`     | `12`    | 1–168           |

An out-of-range or malformed value refuses to start the worker.

### 5. Log lines (`lane: voice_room_reaper`)

| Level | Message                                                               | Fields                                                                                                                                       |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| info  | `LOOP voice room reaper ended a room`                                 | `voiceRoomId`, `reasonCode` (`VOICE_ROOM_IDLE_ENDED` / `VOICE_ROOM_MAX_AGE_ENDED`), `providerSyncStatus`, `requestId` (= audit `request_id`) |
| warn  | `LOOP voice room reaper could not confirm the Stream call end`        | `voiceRoomId`, `reasonCode: STREAM_CALL_END_UNCONFIRMED`, `detailReasonCode` (the end reason), `errorClass`, `requestId`                     |
| warn  | `LOOP voice room reaper could not end a room`                         | `voiceRoomId`, `reasonCode: voice_room_reaper_end_failed`, `errorClass`                                                                      |
| debug | `LOOP voice room reaper could not observe presence; the room is kept` | `voiceRoomId`, `errorClass`                                                                                                                  |
| warn  | `LOOP voice room reaper lane stays idle: Stream is not configured`    | `reasonCode: VOICE_ROOM_REAPER_STREAM_NOT_CONFIGURED` (once, at start)                                                                       |

No Stream response body, no token, no user ID.

## Client effect

None in the contract. A reaped room reads exactly like a host-ended one: `state: ended`, `endedAt`, every write `DATA_STALE`, gone from `GET /v2/voice-rooms/live` and `…/voice-rooms/current`. A device still in the Stream call receives Stream's `call.ended`.

## Not done

- No in-memory "empty for N consecutive passes": one confirmed zero plus ten minutes without a LOOP change is enough, and a worker restart would reset such a counter anyway.
- An unprovisioned live room (create or go-live unconfirmed) is ended only by the hard cap; it has no confirmed call to observe.
- Ordering is oldest first; if more than 50 rooms are live and the oldest 50 are all busy, newer rooms wait until the oldest reach the hard cap. Acceptable at current scale.
- No push notification on a reaped room (the host-ended path sends none either).

## Deployment note

The Development room live since 2026-09-22 (`b1ab0c3b-…`) is older than 12 h, so the first pass after the worker restarts ends it with `VOICE_ROOM_MAX_AGE_ENDED` — no manual data change. Verify with the info line above in `~/Library/Logs/LOOP` and `GET /v2/voice-rooms/live`.

## Tests

- `test/voice-room-reaper-service.test.ts`: the rule table (hard cap, occupied, recent activity, needs presence, configured thresholds, observed-zero-only), the LOOP-then-Stream order, no Stream read for occupied/recent/unprovisioned rooms, unknown presence keeps the room, unconfirmed Stream end, row-lock skip makes no Stream write, per-room failure isolation, 50-room cap, listing failure, abort; the lane loop's backoff and interval.
- `test/worker-runtime.test.ts`: lane wired with the Stream pair and interval, left out with one log line without it, off by switch, log fields of an end.
- `test/reconciliation-worker-config.test.ts`, `test/reconciliation-worker-logger.test.ts`: defaults, ranges, field sanitizing.
- `test/voice-room-reaper.integration.test.ts` (real PostgreSQL): an empty idle room is ended in one pass with a null-actor audit row while a room with a listener and a fresh room stay live; Stream-reported presence keeps a room; an over-age room with a listener is ended and its pending hand raise cancelled; the row-locked re-check skips a room a listener joined after the listing and an already-ended room; listing order and limit.
