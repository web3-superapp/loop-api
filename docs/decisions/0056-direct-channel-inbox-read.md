# Decision 0056: Direct channel inbox read (`GET /v2/chat/direct-channels`)

- Status: Accepted (S50; fixes R14-1 of `docs/acceptance/2026-09-20-round14-verification.md`)
- Date: 2026-09-20
- Scope: `communication` module, one new read route, one new `CommunicationRepository` port, no migration. `POST /v2/chat/direct-channels`, `GET /v2/connections`, `GET /v2/message-requests`, the Stream gateway, and `/v1` are unchanged.

## Context

- R14-1: the client's conversation inbox draws the literal Stream user ID `loop_7e25420e…` as the title of a private-chat row. Stream names a 1:1 channel from the other member's `User.name`; LOOP publishes no profile facts to Stream, so the SDK falls back to `User.id`, which is the internal LOOP user UUID without hyphens — an internal primary key on a public surface (`00-主代理规则.md` §4.5).
- The client has no server fact to fix this with. `POST /v2/chat/direct-channels` answers `{targetPublicProfileId, streamCid}` for one target at a time and requires an accepted friendship; `GET /v2/connections` and `GET /v2/message-requests` carry public identities but no Stream identifier. Nothing maps `streamCid → public profile` for a list.
- Publishing a name to Stream (so `User.name` is set) was rejected: it would make Stream a second identity authority and would leak one alias into every group the account is in, undoing Decision 0055.

## Decision

### Route

`GET /v2/chat/direct-channels?limit&cursor` (operationId `listV2DirectChatChannels`). Read headers only (Privy Bearer, `X-Loop-Contract-Version: 2.0`, `X-Loop-Client-Version`); no body. `limit` 1–50, default 50; `cursor` and `limit` are mutually exclusive (community directory rule).

Response `200`:

```json
{
  "items": [
    {
      "streamCid": "messaging:loop_direct_<32 hex>",
      "peer": {
        "publicProfileId": "<uuid>",
        "loopId": "LOOP-XXXXXXXX",
        "alias": "Voyager_09",
        "avatarRef": null
      },
      "createdAt": "2026-09-20T06:45:09.123Z"
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

- `peer` is byte-for-byte the `profile` object of `GET /v2/connections` (`identityProjectionSchema`: `publicProfileId`, `loopId`, `alias`, `avatarRef`). The client renders one identity widget for both.
- `peer` is `null` when the other account has no presentable public identity: no `user_profiles` row (never activated, or removed by a future account-deletion flow). The channel row is still listed so the inbox can label it "已注销用户" instead of falling back to a Stream ID. Today the schema has no account-level ban or deactivation flag; `loop_users.loop_id` is `not null` since migration 000015. When an account-standing gate lands, it applies at the authentication boundary and this read inherits it without change.
- **No Stream user ID is projected.** The row carries `streamCid` (already public through the create route) and the peer's public identity only. Internal user UUIDs, Privy subjects, and `loop_<hex>` values never appear.

### Authority and scope

- `public.direct_channels` is the authority. Stream is not queried: the inbox mapping must be available whether or not the Stream connection is up, and Stream membership is not a stronger fact than the LOOP pair row that created the channel.
- Only rows the caller is a member of (`user_id_low = viewer or user_id_high = viewer`) and only `channel_state = 'active'`. `pending`, `cancelled`, and `operator_required` rows are not usable channels; the create route's operation locator remains the place to observe them.
- Blocking does not remove a row: the Stream channel still exists and the client still needs a name for it. `GET /v2/blocks` is the block authority.

### Pagination

Keyset on `(date_trunc('milliseconds', created_at) desc, stream_channel_id desc)`, newest channel first. The cursor is the owner/route/filter-bound AES-GCM + HMAC codec (`v2-cursor.ts`), route `v2DirectChannels`, filter `state=active`, continuation `{createdAt, streamChannelId, limit}`. The millisecond truncation matches the ISO value the response projects, exactly as the voice-room roster does. `limit` default 50, maximum 50 (`directChannelListLimits`).

### Errors

| HTTP | code                             | when                                                                                                                                    |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | bad headers, unknown query key, `limit` out of 1–50, `cursor`+`limit` both present, cursor invalid/expired/foreign                      |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | missing or invalid Privy Bearer                                                                                                         |
| 404  | `NOT_FOUND`                      | `communication` not in `V2_MODULES_ENABLED`                                                                                             |
| 503  | `CAPABILITY_UNAVAILABLE`         | communication repository not composed, cursor secret missing, Stream credentials missing (the module runtime is fail-closed as a whole) |

The seven-field V2 envelope is unchanged.

### Unavailable behaviour

There is no partial answer. Without the module runtime the route is `503 CAPABILITY_UNAVAILABLE`; the client keeps the inbox in its unavailable state and must not print any Stream-derived name.

## Consequences

- New port `CommunicationRepository.listDirectChannels` (PostgreSQL implementation in `src/database/communication-repository.ts`; the unavailable factory rejects with `CommunicationRepositoryUnavailableError`).
- `V2ChatService.listDirectChannels` with a `cursorCodec` option; `createUnavailableV2ChatService` rejects.
- OpenAPI operation count 128 → 129; the `/v2/chat/direct-channels` path gains a `get`.
- Client rule (see `docs/frontend-v2-communication-api.md` §3): the inbox private-chat row title is `peer.alias ?? peer.loopId`; `peer === null` renders "已注销用户"; a `streamCid` not present in this list renders no name at all (never the Stream fallback).
