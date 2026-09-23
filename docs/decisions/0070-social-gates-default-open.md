# Decision 0070: The social gates default to open

- Status: Accepted (S75b; user ruling 2026-09-23)
- Date: 2026-09-23
- Scope: `social_privacy_preferences` (migration 000038), every admission
  check that reads it (`POST /v2/message-requests`,
  `POST /v2/chat/direct-channels`, `POST /v2/chat/groups`, and their frozen
  V1 producers), and the V2 privacy centre (`GET|PUT /v2/profile/privacy`),
  which now carries the three gates. Amends Decision 0030 (privacy resource
  shape) and the "fail-closed social privacy" wording of the S3/S4 module
  records. `/v1` route code is unchanged.

## Context

Migration 000013 created `social_privacy_preferences` with `friend_requests`,
`group_invites`, and `direct_messages` all defaulting to `'disabled'` and the
table comment "Missing rows mean every social capability is disabled". Every
reader honoured that literally with an inner join:

| Reader                                                          | Rule before this decision                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `chat-channel-repository.resolveDirectTarget` (V2 + V1 direct)  | friendship **and** a row with `direct_messages = 'friends'`     |
| `chat-channel-repository.eligibleGroupTargets` (V2 + V1 groups) | friendship **and** a row with `group_invites = 'friends'`       |
| `chat-channel-repository` pre-submission recheck                | same, re-evaluated under lock before the Stream write           |
| `social-repository.sendFriendRequest` / `searchFriends` (V1)    | discoverable **and** a row with `friend_requests = 'enabled'`   |
| `community-repository.sendMessageRequest` (V2)                  | active profile, `privacy_preferences_v2.discoverable`, no block |

A row is only ever written by an explicit replacement (`PUT
/v1/profile/social-privacy`), and the client page that wrote it was retired
when the V2 privacy centre shipped without these switches. The Development
database on 2026-09-23 had 355 accounts, 312 activated profiles, and exactly
one `social_privacy_preferences` row. For every other account the whole
private-chat path was therefore unreachable: a message request could be
accepted (V2 does not read the gate), but `POST /v2/chat/direct-channels`
answered `404 NOT_FOUND` for the resulting friendship, and no screen existed
to change that. "Fail closed" was protecting a preference nobody could set.

## Decision (user ruling, 2026-09-23)

1. **A missing row means open.** `friend_requests = 'enabled'`,
   `group_invites = 'friends'`, `direct_messages = 'friends'`. Migration
   000038 moves the three column defaults to those values and rewrites the
   table comment. Every reader changes from an inner join to
   `coalesce(<column>, <open value>)`; the code default in
   `social-contract.ts` (`defaultSocialPrivacyValues`) and the V2 default
   (`defaultPrivacyV2Values`) carry the same values, so `GET
/v1/profile/social-privacy` and `GET /v2/profile/privacy` report what the
   admission checks actually apply.
2. **An explicit `disabled` is respected.** No row is rewritten and no
   backfill runs. The one existing Development row is already
   `enabled/friends/friends`. An account that turns a gate off through the
   privacy centre (or, historically, through V1) stays off.
3. **Group invites open as well.** The only argument for leaving
   `group_invites` closed would be spam from friends; the gate is
   friendship-scoped already, and the ruling asked for the DM path to work
   end to end, which includes small groups made of accepted friends. No
   reason to keep it closed was found.
4. **`discoverable` is unchanged and still required for message requests.**
   `POST /v2/message-requests` keeps its admission rule (active profile,
   `privacy_preferences_v2.discoverable = true`, no block in either
   direction) and now additionally refuses a target whose stored
   `friend_requests` is `'disabled'`, with the same non-enumerating
   `404 NOT_FOUND`. `discoverable` defaults to `false` (Decision 0030) and is
   not touched by this decision: a stranger can only start a conversation
   with an account that opted into being found. In the Development database
   only 2 of 352 `privacy_preferences_v2` rows are discoverable, so message
   requests remain unreachable for the other accounts until their owners
   flip that switch. That is the intended meaning of the switch, not a
   defect.
5. **The V2 privacy centre owns the three gates.** `GET|PUT
/v2/profile/privacy` gains `privacy.friendRequests`,
   `privacy.groupInvites`, and `privacy.directMessages`. `PUT` is still a
   full replacement: all three are required, values outside their enums
   are `400 INVALID_REQUEST`. The resource `version` stays the
   `privacy_preferences_v2` record version; the gates are committed to
   `social_privacy_preferences` in the same transaction, and a change to any
   gate bumps `version` (creating the `privacy_preferences_v2` row at
   version 1 if it did not exist). A social-only row (written by V1) reads
   as version 0 with `updatedAt: null` until the first V2 write adopts it.
   The social row's own `record_version` is not projected by V2.

## Contract

`GET /v2/profile/privacy`, no rows anywhere:

```json
{
  "privacy": {
    "discoverable": false,
    "anonymousMode": false,
    "visibility": {
      "totalAssets": "self",
      "miningPower": "self",
      "communities": "self",
      "tradeHistory": "self"
    },
    "friendRequests": "enabled",
    "groupInvites": "friends",
    "directMessages": "friends"
  },
  "version": 0,
  "updatedAt": null,
  "contractVersion": "2.0"
}
```

| Field            | Values                | Default   | Read by                                                                                 |
| ---------------- | --------------------- | --------- | --------------------------------------------------------------------------------------- |
| `friendRequests` | `enabled \| disabled` | `enabled` | `POST /v2/message-requests` (target side, together with `discoverable`), V1 send        |
| `groupInvites`   | `friends \| disabled` | `friends` | `POST /v2/chat/groups` (each invited friend), V1 group create, pre-submission recheck   |
| `directMessages` | `friends \| disabled` | `friends` | `POST /v2/chat/direct-channels` (target side), V1 direct create, pre-submission recheck |

Errors on the admission side are unchanged: every ineligible target is
`404 NOT_FOUND` on the V2 routes (`target_unavailable` in the V1 operation
record). `PUT /v2/profile/privacy` keeps `400 INVALID_REQUEST`,
`409 VERSION_CONFLICT`, `422 VALIDATION_FAILED`, `503 CAPABILITY_UNAVAILABLE`.

## Consequences

- Migration `000038_social_gates_default_open` (defaults + comment only; the
  rollback restores the 000013 defaults and wording). `latestMigrationName`
  updated.
- `GET /v1/profile/social-privacy` for an account without a row now returns
  `enabled/friends/friends` at version 0. The route code and its OpenAPI
  artifact are untouched; only the shared default constant moved, because
  a V1 read that reported "disabled" while the checks applied "enabled"
  would be a lie.
- Deployment to Development needs `pnpm db:migrate` and nothing else: the
  311 activated accounts without a row are open by absence, and the single
  existing row already carries the open values. No data-repair command.
- Client: the privacy centre must send all six presentation fields plus the
  three gates on `PUT`; see `docs/frontend-v2-profile-api.md`.
- Not changed: `discoverable` default, follow/search admission, block
  precedence, the friendship-only rule for direct channels and groups,
  Stream, `/v1` route code.
