# Decision 0093: The live voice-room list (`GET /v2/voice-rooms/live`)

- Status: Accepted (S106; module sheet `docs/modules/S106-v3-navigation.md` §7).
- Date: 2026-10-08
- Scope: one new read route in `src/routes/v2/voice-rooms.ts`, `VoiceRoomService.listLiveRooms`, `CommunicationRepository.listLiveVoiceRooms`. No migration, no new table, no new error code, no Stream call.

## Context

The v3 navigation (docs/09 §1) moves voice rooms into the plaza tab: a cross-community list of the rooms that are live now. Every existing voice-room read is scoped to one community or one room and requires community membership; there is no cross-community read.

## Decision

1. **Route.** `GET /v2/voice-rooms/live`, `operationId: listV2LiveVoiceRooms`, tag `communication`, Privy Bearer per request, the V2 read headers, query `cursor?` / `limit?` (default 20, maximum 50, mutually exclusive because the cursor carries the page size, the rule of every V2 list). Registered as a static path, so it never shadows `GET /v2/voice-rooms/{voiceRoomId}`.
2. **Scope.** A room is listed when `state = 'live'`, `provision_state = 'provisioned'` and `backstage = false`: exactly the rooms a member can enter now (Decision 0054). `provisioned` is added to §7's `live && !backstage` so a room whose go-live write-back is still reconciling is not advertised. The community must be visible to the caller under the community directory predicate (verified, or created by the caller, or a non-banned membership), so an unverified community cannot be enumerated through this list.
3. **Order and cursor.** Newest `startedAt` first; keyset `(date_trunc('milliseconds', created_at), voice_room_id) desc`. The cursor is the shared V2 codec bound to owner, route `liveVoiceRooms` and filter `live`; its continuation is `{startedAt, voiceRoomId, limit}`. A cursor of another owner or route, or one without both keys, is `400 INVALID_REQUEST`. Without a cursor codec the read is `503 CAPABILITY_UNAVAILABLE` (the roster rule).
4. **Item.** `{voiceRoomId, communityId, communityName, communityLogoRef, title, host: {publicProfileId, displayName, avatarRef}, listenerCount, speakerCount, countsObservedAt, startedAt, joinable}`, response `{items, nextCursor, observedAt, contractVersion}`.
   - `startedAt` is `voice_rooms.created_at`: there is no separate start column, and a provisioned room goes live at creation (Decision 0054).
   - `title` is always `null`: rooms have no title (create takes no body). It is kept so a later room title is additive; the client shows `communityName`.
   - `communityLogoRef` / `host.avatarRef` instead of §7's `communityLogoUrl` / `avatarUrl`: LOOP stores preset references (`avatar:preset/...`), never URLs, and the community and profile resources already publish them as `logoRef` / `avatarRef`.
   - `host.publicProfileId` instead of §7's `userId`: the internal account ID is never projected; `publicProfileId` is the opaque public identity used everywhere else. `displayName` is the host's alias under the leaderboard display rule (Decisions 0049, 0052): null when the host's anonymous mode is on (unless the caller is the host) or there is no alias / active profile, and then `publicProfileId` and `avatarRef` are null too, so an anonymous host cannot be identified from the list.
   - `listenerCount` / `speakerCount` are the LOOP `joined` role-intent counts (Decision 0051, host excluded), the same numbers as `participants.listenerCount` / `speakerCount` on the room resource. No Stream-observed count is stored for a room and this read never calls Stream, so `countsObservedAt` is always `null`; live presence remains `participants.observed` on `GET /v2/voice-rooms/{voiceRoomId}`.
   - `joinable` is a non-banned membership in the room's community, the join predicate. It does not promise the join succeeds (an account without an active profile is still refused at join).
   - `observedAt` is the server time of the read.
5. **Capability.** The route lives in the `communication` module: disabled module → 404 (no route), runtime unavailable (`voiceRooms.availability: unavailable`) → the unavailable service → `503 CAPABILITY_UNAVAILABLE`; a repository outage → `503 CAPABILITY_UNAVAILABLE`. The `voiceRooms.evidence` gate stays a client rule as for every voice-room route.

## Not done

- No index: the scan is over live rooms only (one per community at most) and is bounded by `limit`. If the plaza grows, a partial index on `voice_rooms (created_at desc, voice_room_id desc) where state = 'live'` is the follow-up.
- No Stream presence per row: one Stream read per row would make the list as slow as its slowest call and burn the Stream quota on scroll.

## Tests

- `test/live-voice-room-service.test.ts`: default page size, the extra-row probe, cursor content, last page, the host display rule (anonymous, no alias, no profile, self), limit and cursor refusals, fail-closed repository and unavailable service.
- `test/v2-communication-routes.test.ts` (`live voice rooms (Decision 0093)`): full item shape, no Stream call, cursor paging, foreign-owner and foreign-route cursors, limit bounds, unknown query, auth and contract headers, the seven-field 503 body, no cursor codec, unavailable runtime 503, disabled module 404, no shadowing of `/v2/voice-rooms/{id}`.
- `test/communication-repository.integration.test.ts` (`listLiveVoiceRooms`): real PostgreSQL scope (unprovisioned, backstage, ended and invisible-unverified rooms excluded; the creator sees its unverified community), counts, `joinable` including a banned member, keyset paging with a millisecond tie, invalid input as unavailable.
