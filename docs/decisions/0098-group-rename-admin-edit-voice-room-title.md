# Decision 0098: Small-group rename, admin community profile edit, voice-room title and speakers preview

- Status: Accepted (S109b)
- Date: 2026-10-08
- Scope: one migration (`000048_v2_group_rename_voice_title`: `communication_groups.name` becomes changeable through a version-stepped rename, new column `name_version`, new append-only table `communication_group_events`, new column `voice_rooms.title`, `voice_room_events` gains `speaker_stepped_down`), two new `/v2` operations (`PATCH /v2/chat/groups/{groupId}`, `DELETE /v2/voice-rooms/{voiceRoomId}/speakers/me`), one changed request (`POST /v2/communities/{communityId}/voice-rooms` takes an optional body), three changed responses (voice-room resource `room.title` and top-level `host`; live-list items `title` and `speakersPreview`; roster rows `avatarRef`), one changed permission (`editProfile` for admins, with an owner-only bound token), one new Stream gateway method (`updateGroupChannelName`). No new error code, no new environment key, no `/v1` change.
- Baseline: `integration/v2` = `f7c165f`
- Inputs: `LOOP/docs/modules/S108-S110-social-batch2b.md` §3.4, §3.5, §4, §5; `LOOP/docs/09-需求方v3需求与裁决.md` §6.2; main-agent addendum 2026-10-08 (S110-mobile delivered: speaker self step-down, room `host`, roster `avatarRef`).

## Context

Three gaps found by the 2026-10-08 read-only inventory block the S109b-mobile management centre, the group-info rename row and the S110-mobile voice-room redesign:

1. A small group's name is fixed at creation. Migration 000013's `communication_groups_guard` refuses any change to `name`, and the only update it admits is the Decision 0025 `pending -> active|cancelled|operator_required` transition.
2. `communitySelfPermissionMatrix.admin.editProfile` is `false`, so an admin cannot fix the community's name, description or logo, although the S109b management centre is for owners and admins.
3. Voice rooms have no title (`POST …/voice-rooms` takes no body; Decision 0093 reserved `title: null` on the live list), and a live-list card cannot show who is speaking.

## Decision

### 1. Small-group rename

Entity changes (migration 000048):

- `communication_groups.name_version integer not null default 1` (`>= 1`). Every existing row, legacy or group, gets 1.
- `guard_communication_group_mutation()` is replaced. Unchanged: deletes are refused; `group_id`, `stream_channel_type`, `stream_channel_id`, `channel_kind`, `create_operation_id`, `created_at` are immutable; `updated_at` never moves back; the Decision 0025 state transition is the same. New: when `name` or `name_version` differs, the update is admitted only if the group is `channel_kind = 'group'` and `active`, the state does not change, the name actually changes to a non-null value, and `name_version = old + 1`. The existing `communication_groups_metadata_check` (1–60 code points, trimmed, `loop_alias_text_is_safe`) still applies to the new name. The Decision 0032 member trigger is not touched.
- `communication_group_events(event_id, group_id → communication_groups, event_type 'group_renamed', actor_user_id → loop_users, old_name, new_name, name_version, idempotency_record_id → idempotency_records unique, request_id, created_at)`, `old_name <> new_name`, `name_version >= 2`, append-only through `reject_community_audit_mutation()`.

Audit table choice: `chat_group_membership_events` is not reused. Its rows mean "the membership changed" and it has no columns for the old and new name; widening its CHECK would mix two kinds of facts in one table and leave the names in nowhere structured. A dedicated table keeps the membership audit's meaning and gives later group-profile changes (description, avatar) one place.

`PATCH /v2/chat/groups/{groupId}` (Privy bearer, UUIDv4 `Idempotency-Key`, `X-Loop-Contract-Version: 2.0`), body exactly `{ name }`:

- The name rule is the creation rule (`chat-channel-contract.ts`, exported as `parseChatGroupName`): trimmed, 1–60 code points, no `Cc/Cf/Cs/Zl/Zp`. Anything else is `400 INVALID_REQUEST` (the creation route's mapping). The design note says "1–40 码点，与创建校验一致"; the creation check is 60, so the server follows creation and the client may cap the input at 40.
- Authorization, in one transaction under `select … for update` of the group row: the group must be an `active` friend group, else `404 NOT_FOUND`; a caller who is not a member gets the same `404` (the opaque ID is not enumerable); a member who is not the creator gets `403 PERMISSION_DENIED`.
- Same name: a successful no-op. `200` with the current `nameVersion` and `updatedAt`, nothing written, no audit row.
- Different name: `name`, `name_version + 1`, `updated_at = greatest(clock_timestamp(), updated_at)`, one `group_renamed` row stamped with that same `updated_at`.
- Idempotency: the command claims `idempotency_records` (communication scope, digest `chatGroupRename` over `[groupId, name]`). A replay whose rename was recorded answers from its audit row (`new_name`, `name_version`, `created_at`). A replay of a no-op (record claimed earlier, no audit row; detected with `xmax = 0` on the claim) answers the current row and writes nothing, so it can never revert a later rename. The same key with another name is `409 IDEMPOTENCY_CONFLICT`. A refused command rolls its claim back.
- Response: `200 { groupId, name, nameVersion, updatedAt, contractVersion }`.
- Stream: after the commit the service calls `StreamCommunityChannelGateway.updateGroupChannelName`, one `updateChannelPartial({ user_id: creator, set: { name } })` on `messaging:loop_group_*`, and requires the echo to be the same group channel carrying the new `custom.name`. Any failure (unavailable gateway, provider error, mismatch) is logged once (`correlationId`, `groupId`, `nameVersion`, error class; no provider body) and does not fail the command: PostgreSQL is the authority and the client already shows the new name. The call is made on every success, including a no-op and a replay, so retrying the same request repairs an earlier unconfirmed write. A `community_channel_sync`-style outbox for this write is left as a follow-up.
- `GET /v2/chat/operations/{id}` for the original create now reports the current name (it already read `communication_groups.name`). A pending create's reconciliation still compares against the stored name, and rename is refused while the group is pending, so the two never race.

### 2. Admin community profile edit

- `communitySelfPermissionMatrix.admin.editProfile` becomes `true`. Banned standing still denies; members still cannot edit.
- `boundAssetKey` stays owner-only, checked in `updateCommunity` under the community row lock: when the actor is not the owner and the request carries `boundAssetKey` with a value different from the stored one (setting, changing, or clearing), the whole request is refused with `CommunityOwnerOnlyFieldError` → `403 PERMISSION_DENIED`, `detailsSafe = { reasonCode: "OWNER_ONLY_FIELD" }`. Sending the stored value back unchanged is not a change and passes, so a client that resubmits the whole form does not fail.
- The audit row keeps `community_profile_updated` and records `reason_code = owner_profile_edit | admin_profile_edit`.
- Logo media authorization (Decision 0095: uploader or current owner/admin) is unchanged.

### 3. Voice-room title and speakers preview

- `voice_rooms.title text null`, `char_length(title) between 1 and 40 and title = btrim(title)`.
- `POST /v2/communities/{communityId}/voice-rooms` accepts an optional body `{ title?: string | null }`. No body (no `Content-Type`), `{}`, `null`, `title: null`, or a title that is empty after trimming open an untitled room. A title is trimmed and must be 1–40 code points with no control or format character; anything else, or another key, is `400 INVALID_REQUEST`. (Fastify's default type coercion applies to the string branch, as on every route.) The title is set at creation only. Opening rights are unchanged (owner/admin, `communication-repository.ts` create check).
- Digest: an untitled create keeps the pre-0098 digest `voiceRoomCreate [communityId]`; a titled one is `[communityId, "title", title]`, so the same key with another title is `IDEMPOTENCY_CONFLICT`.
- `VoiceRoomResource.room.title` (`string | null`) on create, read, current-room and every command response; the live list's `title` now carries the stored value.
- The OpenAPI document publishes the create `requestBody` as `required: false`: `@fastify/swagger` always writes `required: true`, so `buildApp` post-processes the document and marks any JSON body whose schema admits `null` as optional.
- `GET /v2/voice-rooms/live` items gain `speakersPreview: [{ publicProfileId, displayName, avatarRef }]`, 1–4 entries:
  - entry 0 is the host (the same projection as `host`);
  - then up to three LOOP `joined` speakers (`voice_room_members.role = 'speaker'`, `state = 'joined'`), ordered by `joined_at` ascending, then the account ID as a tie-break. `joined_at` is the time the account entered the room (a promotion keeps it), which matches the roster order of `GET …/members`;
  - each entry follows the host display rule: anonymous to the viewer (anonymous mode on and not the viewer) or without an active profile/alias → all three fields `null`; the entry still occupies its slot so the stack size matches the speakers present. The viewer always sees itself.
  - It is a PostgreSQL role-intent fact read in the same query as the list (one correlated `json_agg` limited to three rows per room); Stream is still not called.

### 4. S110 addendum: speaker step-down, room host, roster avatar

- `DELETE /v2/voice-rooms/{voiceRoomId}/speakers/me` (bearer, UUIDv4 `Idempotency-Key`, contract version, no body). Under the room row lock and the caller's member row lock: an ended room is `409 DATA_STALE`; the host is `403 PERMISSION_DENIED` (it ends the room instead); a caller that is not a joined speaker (listener, left, never joined) is a `200` no-op that writes nothing and reports `providerSync: confirmed` (the Decision 0069 leave style, not 204); a joined speaker becomes `listener` with `muted_at` cleared and one `voice_room_events` row `speaker_stepped_down` (`speaker -> listener`, `reason_code = self_step_down`). After the commit the service makes the host remove-speaker writes for the caller: revoke Stream `send-audio`, then reset the call member role to `listener`; `providerSync` reports them (`STREAM_PERMISSION_UNCONFIRMED` on failure) and the command still succeeds. Digest `voiceRoomSpeakerStepDown [voiceRoomId]`; a same-key replay of a recorded step-down answers the room again and repeats the idempotent Stream writes. The route is a static segment, so it never collides with `DELETE …/speakers/{publicProfileId}` (a profile ID is a UUID). A pending hand raise is not touched (a speaker has none: invite marks it `invited`).
- Room resource `host: { publicProfileId, displayName, avatarRef } | null` at the top level (beside `room` and `viewer`), on every response that returns the room resource. It is the live-list projection: three nulls when the host is anonymous to the viewer or has no active profile; the host always sees itself (`viewer.role = host`). The repository reads the host identity in the same viewer read; `null` is reserved and not produced today.
- `GET /v2/voice-rooms/{id}/members` rows gain `avatarRef: string | null`: the member's stored `user_profiles.avatar_ref` when `display.kind = alias` (named, or the viewer's own row), otherwise `null`. Hand-raise queue entries are unchanged.

## Errors

No new code. New `detailsSafe.reasonCode` value for `PERMISSION_DENIED`: `OWNER_ONLY_FIELD`. `PATCH /v2/chat/groups/{groupId}`: 400 `INVALID_REQUEST`, 401 `AUTH_REQUIRED`/`AUTH_INVALID`, 403 `PERMISSION_DENIED`, 404 `NOT_FOUND`, 409 `IDEMPOTENCY_CONFLICT`/`VERSION_CONFLICT`/`ACCOUNT_BOOTSTRAP_REQUIRED`, 503 `CAPABILITY_UNAVAILABLE`. Every error keeps the seven-field envelope.

## Unavailable behaviour

- Rename: when the communication runtime or repository is not composed the route answers `503 CAPABILITY_UNAVAILABLE` (the unavailable chat service). A Stream gateway without credentials does not block a rename; it is the logged, non-blocking provider step above.
- Voice title and preview: same availability as the existing voice-room routes; no fixture or default title is ever invented (`null` means untitled).

## Migration impact on existing data

- `communication_groups`: every row gets `name_version = 1`; names are unchanged. Only `active` friend groups become renamable.
- `voice_rooms`: every row gets `title = null`; live and ended rooms are unaffected.
- `voice_room_events`: only the type CHECK widens; existing rows are unaffected.
- `communication_group_events` starts empty.
- Rollback refuses while any rename is recorded, any `name_version <> 1`, any title is set, or any `speaker_stepped_down` event exists; otherwise it restores the 000013 guard verbatim and drops the new column, table and title.

## Tests

- `test/v2-communication-routes.test.ts`: rename commit-then-Stream order, payload trimming and digest, Stream failure still 200, same-name no-op, 403/404/409/503 mapping with the seven-field body, invalid names / extra keys / missing key / missing bearer / bad ID; voice-room create with title, untitled variants on the legacy digest, title validation, title on reads; live list `title` and `speakersPreview` (host first, anonymous entries null, four-entry maximum, the viewer sees itself).
- `test/v2-community-routes.test.ts`: `OWNER_ONLY_FIELD` envelope and a plain denial with `detailsSafe: null`.
- Step-down / host / roster avatar: route tests for the commit-then-revoke order and payloads, unconfirmed revoke still 200, non-speaker 200 no-op without Stream writes, host 403, ended 409, missing key 400, the `{publicProfileId}` route unaffected, host projection (self in anonymous mode, named, anonymous), roster `avatarRef` (named, anonymous null, own row); integration test for host refusal, listener no-op, step-down with audit row and cleared mute, replay, second call no-op, ended room stale, host identity on the viewer record, roster avatar.
- `test/stream-communication-gateways.test.ts`: `updateGroupChannelName` request shape, echo validation, 4xx/5xx classification, refused inputs.
- `test/v2-group-rename-voice-title-migration.test.ts`: migration SQL contract and head.
- `test/group-rename-voice-title.integration.test.ts` (real PostgreSQL): rename + version + audit + replay + conflict + no-op + no-op replay after a later rename; non-creator 403, non-member/unknown/pending 404; every other column still immutable, single-step version, pending name frozen, audit append-only, member trigger unchanged; admin edits name/description/logo, admin bound-token change/clear refused, unchanged value passes, owner may change, member denied, audit reasons; title round-trip and DB bounds; live-list speakers order, anonymity flag, leave drops a speaker.
