# LOOP API inventory

This file is the canonical inventory of LOOP-facing HTTP routes approved for the
native Flutter client. Route schemas in `src/routes/` remain the OpenAPI source
for implemented behavior. Provider REST/WebSocket paths, SDK methods, historical
prototype routes, and unassigned product ideas are not LOOP APIs.

The committed implemented contracts are `openapi/loop-api.v1.json`,
`openapi/loop-api.v2.json`, the operator console surface
`openapi/loop-admin.v1.json` (Decision 0102), the public MEME page read
surface `openapi/loop-public.v1.json` (Decision 0147), and the website
registration surface `openapi/loop-web.v2.json` (Decision 0179). They are generated
independently from route schemas by `pnpm openapi:generate` and checked for
drift by `pnpm openapi:check`. V1 is the frozen compatibility surface; new
product modules use V2; the console, public, and web surfaces are never part of
the App's V2 artifact.

`openapi/loop-api.v2.json` is the single source of truth for every count in this
repository's documentation. It currently publishes **185** V2 operations across
**156** V2 paths, and `GET /v2/meta/capabilities` currently returns **34**
capability IDs (recounted at Decision 0128). Recount from the committed artifact after each module lands
rather than trusting a number quoted in prose.

## Status model

| Status                  | Meaning                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `implemented`           | Present in the current runtime and generated OpenAPI.                                                                                    |
| `approved-contract`     | Exact LOOP route approved; implementation is pending.                                                                                    |
| `blocked-provider`      | Provider execution or token issuance must fail closed until dependency, license, credential, and credentialed-evidence gates close.      |
| `blocked-product-legal` | Mutation must stop before signing/provider work until current product, regional, legal, sanctions, and eligibility evidence approves it. |
| `explicitly-disabled`   | Outside the approved phase; no route may be implemented.                                                                                 |

Interface and capability status are independent. For example, an implemented
route backed by an unavailable adapter remains `blocked-provider`; its existence
is not provider-integration evidence.

Runtime activation and verification evidence are independent too. The
Hyperliquid private-read capability below is implemented but default-off;
credentialed Privy, nonempty Testnet account, physical-device, shared-egress,
and deployed-environment evidence remain unverified.

## Frozen V1 common native contract

- All `/v1` routes below require exactly one current Privy Bearer token, except
  that bootstrap may create the internal mapping while every other protected
  route requires it to exist. No native route accepts cookies, CSRF tokens, or a
  Privy refresh token as authentication.
- The server derives the opaque LOOP user, Stream subject, wallet/account owner,
  and provider authorization subject. Client-selected identity, wallet/account
  or agent addresses, nonces, signatures, provider URLs, and provider
  idempotency values are rejected unless a route explicitly lists a signature
  as the result of an approved private signing handoff.
- Unknown fields are rejected. Money, price, size, balance, fee, funding,
  leverage, margin, and PnL values are canonical decimal strings, never JSON
  numbers.
- Protected responses are `Cache-Control: no-store`. Errors use stable LOOP
  codes and never expose raw provider or database messages.
- Local Profile, Watchlist, alert, and notification-preference replacements use
  an explicit resource version. A stale different state conflicts; an identical
  already-applied retry returns the committed resource instead of overwriting it.
- Total request deadline: 15 seconds. Provider read attempt: 5 seconds, with at
  most one pre-response transport/5xx retry inside the total deadline. Provider
  write attempt: 10 seconds, with no generic retry; ambiguous outcomes become
  durable `unknown`/`reconciling` state.

## V2 common native contract and first delivery

- New product routes use camelCase fields and require
  `X-Loop-Contract-Version: 2.0`. Protected calls also require a bounded
  `X-Loop-Client-Version` and one current Privy Bearer token.
- Bootstrap and logout require canonical lowercase UUIDv4 values for
  `Idempotency-Key` and `X-Loop-Device-ID`, plus
  `X-Loop-Platform: ios|android`. Logout additionally requires the opaque
  `X-Loop-Session-ID` returned by bootstrap.
- Every V2 error has exactly `code`, `category`, `retryable`, `userMessageKey`,
  `correlationId`, `detailsSafe`, and `providerReferenceSafe`. The correlation
  ID equals the response `X-Request-ID`; raw Provider/database errors are never
  projected.
- Decision 0166: shipped apps decode V2 objects strictly and reject unknown
  keys, so a new response key must first land in the mobile codec as an
  optional key and ship in a released build; only then may the server emit it
  (behind a default-off env gate until every supported build decodes it).
- A device session is a durable audit projection, not a credential. Every
  protected call re-verifies Privy. Email, Apple, Google, and external-wallet
  login share this one backend path; distinct Privy subjects are never merged
  by email, wallet, Alias, or device.
- The complete wire contract and frontend sequence are documented in
  `docs/api-v2-conventions.md` and `docs/frontend-v2-session-api.md`; the
  `profile` module contract is in `docs/frontend-v2-profile-api.md`; the
  D20 security/settings/support contract is in
  `docs/frontend-v2-security-settings-api.md`.

| Method and path              | Request                                                                 | Success projection                                                                                                                                                                              | Interface     | Capability                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v2/meta/client-policy` | No input                                                                | Versioned route/tab (v3 tabs `chat, square, meme, intel, wallet`, `productPolicyV2.2026-10-08`, Decision 0100; `defaultRoute: "chat"`, Decision 0105); configuration-driven version/terms gates | `implemented` | `implemented`; gates are `available` only from complete config, region stays unavailable                                                                                                   |
| `GET /v2/meta/capabilities`  | No input                                                                | Runtime availability separated from external evidence                                                                                                                                           | `implemented` | `implemented`; deferred capabilities remain unavailable; `launch` evidence confirmed per Decision 0083; `meme` (Decision 0101); `launch2` (Decision 0114); `testnetFaucet` (Decision 0128) |
| `POST /v2/session/bootstrap` | Bearer, contract/client/platform/device/idempotency headers; no payload | Opaque account/session plus server-derived Stream user ID                                                                                                                                       | `implemented` | `blocked-provider`; physical-device Privy matrix remains unverified                                                                                                                        |
| `GET /v2/account/me`         | Bearer and contract/client headers; no payload                          | Opaque account/authentication/communication projection                                                                                                                                          | `implemented` | `blocked-provider`; requires a current valid Privy token and bootstrap mapping                                                                                                             |
| `POST /v2/session/logout`    | Bootstrap headers plus owner-bound opaque session ID; no payload        | Durable revoked session and `providerLogoutRequired=true`                                                                                                                                       | `implemented` | `blocked-provider`; Privy SDK logout and physical-device behavior remain external                                                                                                          |

### V2 profile module (Decision 0030, `V2_MODULES_ENABLED=profile`)

| Method and path            | Request                                                                              | Success projection                                                                                                                      | Interface     | Capability                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/profile/avatars`  | Public; no input                                                                     | Preset avatar catalog (`people-01..12`, `monogram`)                                                                                     | `implemented` | `implemented`; presets stay valid; upload is `POST /v2/media/avatars` (Decision 0095)                                                                                                                         |
| `GET /v2/profile`          | Bearer + contract/client headers; no payload                                         | `loopId`, alias, avatarRef, bio, interests, `profileStatus`, `activatedAt`, CAS `version`                                               | `implemented` | `implemented`; version-0 pending default without a write                                                                                                                                                      |
| `PUT /v2/profile`          | Same headers, no `Idempotency-Key`; `{expectedVersion, profile}`                     | Committed resource; version shared with `/v1/profile`                                                                                   | `implemented` | `implemented`; `ALIAS_RESERVED` / `ALIAS_BLOCKED` policy applied                                                                                                                                              |
| `POST /v2/profile/loop-id` | Bootstrap header set incl. UUIDv4 `Idempotency-Key`; `{alias, avatarRef, interests}` | One-time activation `pending → active`; replay returns the current resource                                                             | `implemented` | `implemented`; key bound to owner/route/body digest                                                                                                                                                           |
| `GET /v2/profile/privacy`  | Bearer + contract/client headers; no payload                                         | `discoverable`, `anonymousMode`, four `self\|everyone` visibilities, `friendRequests`, `groupInvites`, `directMessages`, CAS `version`  | `implemented` | `implemented`; version-0 default without a row: presentation flags fail closed except totalAssets / tradeHistory / miningPower `everyone` (Decisions 0095, 0148), the three social gates open (Decision 0070) |
| `PUT /v2/profile/privacy`  | Same headers, no `Idempotency-Key`; `{expectedVersion, privacy}` (all nine values)   | Committed resource, independent from V1 privacy; the social gates are committed to `social_privacy_preferences` in the same transaction | `implemented` | `implemented`; no copy-trade field exists; any gate change bumps `version`                                                                                                                                    |

| `POST /v2/media/avatars`, `POST /v2/media/community-logos`, `POST /v2/media/project-nft-images` (0173) | Write headers incl. UUIDv4 `Idempotency-Key`; multipart, one part `file` (JPEG/PNG/WebP/HEIC, ≤ 5 MiB, ≥ 64 px) | `201 {mediaId, ref, url, width, height}`; stored as 512×512 WebP | `implemented` | `implemented` (Decision 0095); 6/min/user, idempotent per key, `VALIDATION_FAILED` reason codes |
| `GET /v2/media/{mediaId}.webp` | Public; no headers | `image/webp`, `immutable` cache, ETag/304 | `implemented` | `implemented` (Decision 0095) |

`avatarRef` also accepts the caller's own `avatar:media/{mediaId}` (else
`422 MEDIA_NOT_OWNED`); profile writes upsert the Stream user
`{id, name, image}` (Decision 0095). Privacy defaults: `totalAssets` and
`tradeHistory` are `everyone`.

The LOOP ID (`LOOP-` + 8 Crockford Base32) is assigned at account creation
by both V1 and V2 bootstrap, backfilled for existing accounts, immutable, and
never an authorization key. `GET /v2/account/me` is unchanged.

### V2 community and social-graph module (Decision 0031, `V2_MODULES_ENABLED=community`)

| Method and path                                                              | Request                                                                                                                         | Success projection                                                                                                                                                                            | Interface                                     | Capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/community/home`                                                     | Bearer + contract/client headers; no payload                                                                                    | `joined[]` (admin/member memberships), `owned[]` (communities the caller owns, each with `application` review state), `discover[]` (≤5), `unread`/`liveVoice` unavailable, `freshness`        | `implemented`                                 | `implemented`; Stream-derived counts stay `unavailable`; a community is in exactly one of `joined`/`owned` (Decision 0073)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /v2/communities`                                                        | `sort=members\|newest\|miningPower\|activity`, `verification=verified\|all`, `membership=all\|joined\|owned`, cursor page       | Community summaries plus `ordering` (what the page was ordered by), per-row `miningPower` or `activity` on the two ordering sorts, and `recommendation` (`rule:verified-members-v1`)          | `implemented`                                 | `implemented`; `miningPower` ranks by the latest **complete** snapshot resolved through the same baseline as every mining read, `activity` by the 7-day message count the `community-channel-sync` lane observed in the official Stream channel (Decision 0061). An ordering whose fact does not exist answers `200` with `ordering.status = unavailable` + `reasonCode`, `items: []` and no cursor — never a silent fallback to another order; every row carries `viewerMembership {role, status, pending}` and `boundAsset {assetId, symbol, logoUrl} \| null`, one set-based query each per page (Decision 0099); `membership=joined` = non-banned non-owner memberships under every `sort`                                                                                   |
| `POST /v2/communities`                                                       | Write headers incl. UUIDv4 `Idempotency-Key`; name/slug/description/logo (preset or own `logo:media/{id}`, Decision 0095)/asset | `201` with a `pending` community owned by the applicant                                                                                                                                       | `implemented`                                 | `implemented`; verification is operator-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /v2/communities/{communityId}`                                          | Bearer + contract/client headers; no payload                                                                                    | Community record, viewer membership and permission flags, `application` (owner only, else null; Decision 0073), `miningPower`, `onlineCount`                                                  | `implemented`                                 | `implemented`; `miningPower` from the latest snapshot under the formula in force (Decision 0043), tagged `subject: community` with the version `scope` plus the same `weight`/`participants` as `GET /v2/mining/communities/{id}` (Decision 0045); `onlineCount` observed from Stream as the channel members currently connected, `{count, observedAt, source: stream_member_presence}` or `unavailable` with one of eight reasons (Decision 0047); one observation per channel reused ≤ 30 s, re-read beside calls past 15 s, pages 2–5 read together, record/channel/Mining Power/presence legs run together (Decision 0088); `chat.viewerPersona` is the caller's own community persona `{alias, projectionState}` or null (Decision 0055); announcements/links `unavailable` |
| `POST /v2/communities/{communityId}/join`                                    | Write headers; optional `{notifications: default                                                                                | muted}` (Decision 0115)                                                                                                                                                                       | Community resource with the viewer membership | `implemented`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `implemented`; `member_count` maintained in the same transaction; `muted` is applied server-side by the channel sync lane after the Stream add (Decision 0115) |
| `DELETE /v2/communities/{communityId}/membership`                            | Write headers; no payload                                                                                                       | Community resource with `membership: null`                                                                                                                                                    | `implemented`                                 | `implemented`; an owner must transfer first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v2/communities/{communityId}/membership`                               | Bearer + contract/client headers; no payload                                                                                    | `membership` (or null), `notifications`, `channelSynced`                                                                                                                                      | `implemented`                                 | `implemented`; one PostgreSQL read, no Stream call; `channelSynced` = channel member `synced` and, for `muted`, the server-side mute confirmed (Decision 0115)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /v2/communities/{communityId}/resubmit`                                | Write headers; no payload                                                                                                       | Community resource with `application.status: pending`                                                                                                                                         | `implemented`                                 | `implemented` (Decision 0073); owner-only `rejected -> pending`, clears the reason and review time, audited as `community_resubmitted`; any other state is `409 DATA_STALE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PATCH /v2/communities/{communityId}`                                        | Write headers; any of `{name, description, logoRef, boundAssetKey}`                                                             | Community resource                                                                                                                                                                            | `implemented`                                 | `implemented`; owner or admin (Decision 0098); changing `boundAssetKey` is owner-only: an admin gets `403 PERMISSION_DENIED` with `detailsSafe.reasonCode = OWNER_ONLY_FIELD` (sending the stored value back is not a change); audited `community_profile_updated` with `owner_profile_edit` / `admin_profile_edit`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /v2/communities/{communityId}/members`                                  | `role=all\|owner\|admin\|banned`, `q` alias prefix, cursor page                                                                 | Owner→admin→member grouping, server counts, viewer permission flags, per-row `actions`                                                                                                        | `implemented`                                 | `implemented`; `items[].actions` is the per-row governance command list computed from the actor x action x target matrix plus the row's stored state, so the client renders it and derives nothing; `q` is a 1-40 code point alias prefix on the shared public alias search quota (Decision 0040); per-member `miningPower` is the account subject (`scope`, no weight) under the privacy rule (Decisions 0043/0045); online count `unavailable`                                                                                                                                                                                                                                                                                                                                 |
| `POST /v2/communities/{id}/members/{publicProfileId}/role`                   | Write headers; `{role}`                                                                                                         | Refreshed member directory                                                                                                                                                                    | `implemented`                                 | `implemented`; owner-only; audited as `role_changed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST\|DELETE /v2/communities/{id}/members/{pid}/mute`                       | Write headers; no payload                                                                                                       | Refreshed member directory                                                                                                                                                                    | `implemented`                                 | `implemented`; owner or admin per the permission matrix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST\|DELETE /v2/communities/{id}/members/{pid}/ban`                        | Write headers; no payload                                                                                                       | Refreshed member directory                                                                                                                                                                    | `implemented`                                 | `implemented`; a ban also drops the follow edges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST\|DELETE /v2/connections/follow/{publicProfileId}`                      | Write headers; no payload                                                                                                       | `{profile, viewerFollows}`                                                                                                                                                                    | `implemented`                                 | `implemented`; target must be activated and unblocked; `discoverable` not read (Decision 0096)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /v2/connections`                                                        | `direction=following\|followers`, cursor page                                                                                   | Connections, `counts.following/followers`                                                                                                                                                     | `implemented`                                 | `implemented`; blocked accounts are omitted; per-row `miningPower` is the account subject (Decision 0045)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /v2/blocks`                                                             | `kind=user`, cursor page                                                                                                        | Block rows plus `counts.user`                                                                                                                                                                 | `implemented`                                 | `implemented`; `contract`/`domain` are `CAPABILITY_UNAVAILABLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST\|DELETE /v2/blocks`                                                    | Write headers; `{kind, stableId}`                                                                                               | `{block}` or `{block: null}`                                                                                                                                                                  | `implemented`                                 | `implemented`; a block removes both follow edges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /v2/message-requests`                                                   | Cursor page                                                                                                                     | Pending incoming requests over the frozen V1 `friend_requests` storage                                                                                                                        | `implemented`                                 | `implemented`; preview and AI moderation `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /v2/message-requests`                                                  | Write headers; `{targetPublicProfileId}`                                                                                        | One message-request item: the V2 producer for the V1 `friend_requests` store                                                                                                                  | `implemented`                                 | `implemented`; follow-grade admission plus the target's `friendRequests` gate (default open, Decision 0070), NOT_FOUND for every ineligible target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /v2/message-requests/{id}/decision`                                    | Write headers; `{decision}`                                                                                                     | `{messageRequestId, decision, blocked}`                                                                                                                                                       | `implemented`                                 | `implemented`; `report` = reject + block + audit in one transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /v2/profiles/{publicProfileId}`, `GET /v2/profiles/by-loop-id/{loopId}` | Bearer + contract/client headers                                                                                                | Public profile: identity, bio, joinedAt, counts, relationship, visibility                                                                                                                     | `implemented`                                 | `implemented` (Decision 0095); not found / inactive / blocked-by-target = `404 PROFILE_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /v2/profiles/{publicProfileId}/holdings`                                | Bearer + contract/client headers                                                                                                | `{status available\|hidden\|unavailable, reasonCode, totalUsd, items, observedAt}`                                                                                                            | `implemented`                                 | `implemented`; on-chain via the wallet balance service; Decision 0169: `PROFILE_LAUNCH2_EMIT=on` (default off, app build ≥ 34) appends Launch-chain `launch2_meme` / `launch2_nft` rows + optional `launch2` block (off byte-identical); `blocked-provider` when RPC is down (unavailable, never zero)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /v2/profiles/{publicProfileId}/trades`                                  | `cursor`, `limit` 1–50                                                                                                          | `{status, reasonCode, items[{eventId, kind buy\|sell\|transfer_in\|transfer_out, ...}], nextCursor}`                                                                                          | `implemented`                                 | `implemented`; S82 indexer tables; Decision 0169: `PROFILE_LAUNCH2_EMIT=on` mixes in the Decision 0167 launch2 rows (no `eventId`) under a time-ordered cursor + optional `launch2` block (off byte-identical); unavailable before the transfer lane has a checkpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v2/profiles/{publicProfileId}/communities`                             | `cursor`, `limit` 1–50 (first page, default 20; cursor keeps the size)                                                          | `{status:"available", items[{communityId, name, slug, logoRef, memberCount, verificationStatus, joinedAt}], nextCursor}` or `{status:"unavailable", reasonCode:"PROFILE_COMMUNITIES_HIDDEN"}` | `implemented`                                 | `implemented` (Decision 0169); non-banned memberships of verified communities (= `counts.communities`), joinedAt desc; hidden when privacy `communities` ≠ everyone (default everyone since 0169; owner always sees)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DELETE /v2/friends/{publicProfileId}`                                       | Write headers; no payload                                                                                                       | `{publicProfileId, friendship: none, removed}`                                                                                                                                                | `implemented`                                 | `implemented` (Decision 0095); idempotent, audited `friendship_removed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /v2/communities/recommended`                                            | Bearer + contract/client headers                                                                                                | `{items: community summaries, defaultSelectedIds (first 5)}`                                                                                                                                  | `implemented`                                 | `implemented`; operator console list (`admin_settings`, Decision 0102) when saved, else `RECOMMENDED_COMMUNITY_IDS`; empty when neither is set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /v2/mining/referral/rules`                                              | Bearer + contract/client headers; no payload                                                                                    | Versioned five-level Mining Power boost snapshot                                                                                                                                              | `implemented`                                 | `implemented`; `edges` and `inviteCode` `unavailable` until D19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Decision 0099 (S111): `GET /v2/communities` rows carry
`viewerMembership: {role: owner|admin|member|null, status: active|muted|banned|null, pending}`
(the caller's own membership row of any status; `pending` is true only for the
owner of a `pending` application, since joins have no approval step) and
`boundAsset: {assetId, symbol, logoUrl} | null` (Asset Registry row of
`boundAssetKey`, no market read; logo through the Decision 0089 proxy, null when
the proxy is not served). A page of N rows costs the page query plus at most two
set-based reads (memberships `community_id = any(...)`, assets
`asset_id = any(...)`, the latter skipped when no row is bound). `membership=joined`
is confirmed as the caller's non-banned (`active` or `muted`) non-owner
memberships and combines with all four sorts and the keyset cursor. No migration,
no new error code — `implemented`. Frontend contract:
[`frontend-v2-community-api.md`](frontend-v2-community-api.md) §4.2.

Decision 0182 (S299): one token, one community. Migration 000100 releases
existing duplicate bindings (keeper = first-created `verified`, else
first-created; `rejected` rows untouched, one NOTICE each) and adds the partial
unique index `communities_bound_asset_key_unique` (`bound_asset_key` where not
null and `verification_status <> 'rejected'`). `POST /v2/communities`, `PATCH
/v2/communities/{id}` (changed key only) and `POST .../resubmit` answer `409
COMMUNITY_BOUND_ASSET_TAKEN` with `detailsSafe.communityId` (the holder's opaque
ID) when another non-rejected community binds the token; the console verify
of a rejected community answers `409 ADMIN_CONFLICT` /
`ADMIN_COMMUNITY_BOUND_ASSET_TAKEN`; the launch2 auto-binding records
`conflict` and warns `LAUNCH2_COMMUNITY_BOUND_ASSET_TAKEN` — `implemented`.

Decision 0097 (S108): `POST /v2/communities` and `PATCH /v2/communities/{id}`
refuse a `boundAssetKey` that is not an Asset Registry row (`422
VALIDATION_FAILED`, `detailsSafe.reasonCode = ASSET_NOT_REGISTERED`; an
unchanged key is not re-checked). Every community resource (detail and
commands, not list rows) carries `boundAsset: {assetId, symbol, name, logoUrl,
hasRegisteredPool} | null` — `implemented`. The default-on
`community_member_buy_feed` worker lane (`COMMUNITY_MEMBER_BUY_FEED_ENABLED`,
`COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS` default 15 000, range 5 000–600 000,
needs the Stream pair, quote set takes `BSC_USD1_TOKEN_ADDRESS` +
`BSC_USD1_VERIFIED`) turns `pool_event` swaps that buy a verified community's
bound asset, by an active member with public trades, into one `loop_feed_bot`
message (`custom.loop_schema = member_buy.v1`, no push) in the community
channel; at most 20 per community per pass, never ahead of the indexer
checkpoint, no history replay (tables `community_feed_cursors`,
`community_member_buy_events`, migration 000047) — `implemented`. Frontend
contract: `docs/frontend-v2-community-api.md` §「群友买入与绑定代币」.

### V2 Community AI (Decision 0066, registered with `V2_MODULES_ENABLED=community`)

Registered with the `community` module, but gated on one additional fact: a
Provider key (`COMMUNITY_AI_API_KEY`, falling back to `ANTHROPIC_API_KEY`).
Without it the `communityAi` capability stays `deferred`
(`COMMUNITY_AI_RUNTIME_DEFERRED`) and all three paths answer
`503 CAPABILITY_UNAVAILABLE` with that reason. There is no fixture answer.
The Provider origin is `COMMUNITY_AI_BASE_URL` (default
`https://api.anthropic.com`; the Development stack points it at the
Anthropic-compatible gateway `https://api.onlyrouter.ai`, Decision 0066
amendment 2026-09-23). Neither the key nor the origin is published.

| Method and path                                          | Request                                                    | Success projection                                                                                                      | Interface     | Capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/communities/{communityId}/ai/overview`          | Bearer + contract/client headers; no payload               | Eight abilities (`communityAnalytics` only for owner/admin), knowledge snapshot, three example questions, today's brief | `implemented` | `blocked-provider` without a Provider key. Five of the eight abilities are `unavailable` with their reason (no document corpus, no announcement feed, no AI write lane, no analytics source). `knowledge.documents` is always `unavailable`: LOOP has live sources, never a document count. The brief is a model call cached per community for one hour and needs an active membership; a cache miss answers `brief.reasonCode: COMMUNITY_AI_BRIEF_PENDING` immediately and generates in the background (one generation per community at a time, Decision 0066 amendment 2026-09-23 (2)). The knowledge sources (asset, mining, voice, chat) are read together, numbered in a fixed order (Decision 0088) |
| `POST /v2/communities/{communityId}/ai/ask`              | Write headers incl. UUIDv4 `Idempotency-Key`; `{question}` | `{answerId, answer, refusal, citations[], sources[], omittedSources[], model, generatedAt, disclaimer}`                 | `implemented` | `blocked-provider`; active membership only (403 otherwise); citations are intersected with the sources this request assembled; the question is never logged and the chat messages are never stored; quotas 6/account/minute and 200/community/day are durable and are spent before the Provider call                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /v2/communities/{id}/ai/answers/{answerId}/report` | Write headers; `{reason, note?}`                           | `201 {answerId, reportId, reason, createdAt}`                                                                           | `implemented` | `implemented`; one report per (answer, account); another account's answer is `404`, not `403`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The knowledge sources are the community profile, the bound asset's market facts,
the community's mining numbers, the voice room state, and — for an active member
only — up to 100 official-channel messages from the last 7 days read through
Stream. Message authors are named by their Decision 0055 community persona; the
Stream user ID is reversed to the internal account UUID inside the gateway and
never travels further. Announcements are **not** a source while
`GET /v2/communities/{id}` still publishes them as `unavailable`.

### V2 search module (Decision 0031, `V2_MODULES_ENABLED=search`)

| Method and path  | Request                                                              | Success projection                                                                | Interface     | Capability                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/search` | `domain=users\|communities\|assets\|launch\|dapps`, `q`, cursor page | `{resultType, stableId, displaySnapshot, destination}` or `status: "unavailable"` | `implemented` | `implemented` for `users`/`communities`/`assets` (Decision 0090: a LOOP ID shaped `users` query pins the exact account first, regardless of `discoverable`; blocks and self still excluded); (Decision 0071: registry prefix match on symbol, name, address; `stableId` = CAIP-19 assetId, `destination.assetDetail`); `launch` is `LAUNCH_PROJECT_DIRECTORY_PENDING`, `dapps` is `DAPP_DIRECTORY_NOT_INTEGRATED` |

`users` and `communities` reuse the `public_alias_search` quota bucket and the
alias prefix normalization of `GET /v1/discovery/users`. Chat content is never
searched. `assets` reads the readable Asset Registry rows in memory and
consumes no quota (Decision 0071); `launch` and `dapps` answer `200` with
`status: "unavailable"`, each with its own reason code, and consume no quota.

The member directory publishes each row's governance commands as
`items[].actions` (`assignAdmin`, `revokeAdmin`, `transferOwnership`, `mute`,
`unmute`, `ban`, `unban`). The list is the same pair of predicates the write
path evaluates — the `actor x action x target` permission matrix and the
target's stored-state precondition — so a command can only be offered when
the matching write would be authorized. The viewer-level
`canInviteAdmin`/`canMute`/`canBan` booleans carry no target and gate only
viewer-level affordances such as the `role=banned` governance view; they are
not a row-action source.

Community identity projections are fixed to
`{publicProfileId, loopId, alias, avatarRef}`. `profile_code` stays V1-only;
wallet addresses, Privy subjects, and Stream IDs are never projected. An
account without an activated V2 profile receives
`409 PROFILE_ACTIVATION_REQUIRED` from every community and social-graph write.
An unverified community is visible only to its creator and its own non-banned
members, on every read surface. `pnpm community:verify <communityId>` is the
only path that sets
`verificationStatus: verified`, and `pnpm community:reject <communityId> --reason "<text>"`
the only path that sets `rejected` (Decision 0073; a verified community is refused).
Both refuse to run with `NODE_ENV=production`, write an operator audit row (the
reject row keeps the reason as `note`), write a `community.announcement` feed row
to the current owner, and push `community_application_verified|rejected` when
`FIREBASE_SERVICE_ACCOUNT_JSON_PATH` is composed (otherwise the script reports
`push unavailable (PUSH_RUNTIME_DEFERRED)`). `pnpm community:provision-channels --confirm`
(Decision 0050) re-drives the same `verifyCommunity` repair branch for every
verified community that has no `community_channels` row (rows written by a
seed), so the official channel and the per-member sync jobs come from the
product path; it never writes the channel table directly and is a no-op once
every verified community has a channel.

### V2 launch module (Decision 0036, `V2_MODULES_ENABLED=launch`)

The 02 contract document has not been provided: every on-chain Launch fact is
`unavailable` with `LAUNCH_CONTRACT_BASELINE_PENDING`, no Launch transaction
is built, and no prototype supply/tax/suffix number is published. Frontend
contract: `docs/frontend-v2-launch-api.md`. Since Decision 0038 every launch
summary publishes the `chainId` stored at approval time — `eip155:56` or,
while the Launch contract lives on the BSC testnet, `eip155:97` from the
`LAUNCH_CHAIN_ID` slot — and, only with `LAUNCH_CHAIN_ID=97`, the `launch`
capability's `evidence` carries `launchChainId`. Since Decision 0077 (S83b)
the `launch_event` worker lane (`LAUNCH_INDEXER_ENABLED`, default false)
indexes the configured contract, the Intent prepare and broadcast report
exist behind `BSC_WRITES_ENABLED`, eligibility is a stored Merkle root
(`pnpm launch:allowlist`), sales are registered by
`pnpm launch:register-sale`, and a USD1 approve towards the Launch contract
runs on the launch slot through `POST /v2/wallet-intents/approve` with
`assetId = eip155:97:<LAUNCH_USD1_ADDRESS>`.
Since Decision 0083 (S83b4) the `launch` capability's `evidence` follows the
adapter's startup observation: `pending` with the adapter's reason
(`LAUNCH_CONTRACT_BASELINE_PENDING` while the keys are blank, byte-identical
to before; `LAUNCH_CONTRACT_CODE_MISSING`, `LAUNCH_CONTRACT_VERSION_UNSUPPORTED`,
`LAUNCH_CONTRACT_VERIFICATION_PENDING`, `LAUNCH_CHAIN_*`), or `confirmed` with
`LAUNCH_CONTRACT_CONFIRMED` and the optional `launchContractVersion`.

Decision 0076 (S83a) adopts LOOP 06 as the contract interface: ABI v1
(`src/integrations/launch/launchpad-abi.v1.json`), a read/encode/decode
adapter, the `LAUNCH_CONTRACT_ADDRESS/VERSION/START_BLOCK` +
`LAUNCH_USD1_ADDRESS` keys (all blank, or all set), and an `available` branch
beside every unchanged `unavailable` branch. With the keys blank every Launch
response is byte-identical to before. Only `GET /v2/launches/{launchId}` reads
the chain (four axes, rounds, config at one block) once the contract is
verified and the sale is registered; `pnpm launch:abi-check <abi.json>`
accepts or refuses a delivered ABI.
Since Decision 0085 (S83b8) that read is one head read, one Multicall3
`eth_call` carrying `getState`/`getRounds`/`getSaleConfig` at that block, and
one reorg check; a successful sale snapshot is reused in memory for
`LAUNCH_SNAPSHOT_CACHE_TTL_MS` (default 1500) by the detail and eligibility
reads. No request, response, or error changes.

| Method and path                                                        | Request                                                                                                                             | Success projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Interface     | Capability                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/launch/overview`                                              | Bearer + contract/client headers; no payload                                                                                        | Approved launches by `scheduleStatus`, or by the projected `saleState` when `onChainState.source = chain` (S83b7); `onChainState` = `launch_event` lane projection (`source: chain`) once indexed; `graduated` available (projected `liquidityState ∈ {LP_LOCKED, COMPLETED}`, latest `LPNFTLocked` first, ≤ 50) once a contract is configured and indexed (S83b7b); `myEligibility`/`staking` unavailable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `implemented` | `blocked-provider`; axes from `getState` at the lane's segment end (Decision 0077); `LAUNCH_ONCHAIN_STATE_NOT_INDEXED` only without a checkpoint                                                           |
| `GET /v2/launch/projects`                                              | `status`, `kind` (0120: `all`/`ido`/`launch2`), `limit`, owner-bound cursor                                                         | Caller's applications, each with `reviewReasonCode` + `reviewReasonText`; 0122: `rejection {reasonCode, note, at}` while `rejected` (editable and resubmittable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `implemented` | `implemented`                                                                                                                                                                                              |
| `POST /v2/launch/projects`                                             | Write headers incl. UUIDv4 `Idempotency-Key`; name/ticker/narrative/links; optional `kind` (0120), optional `communityId` (0125)    | 0154 / 0164: name and ticker share the four.meme rule — any language or script, NFC + trimmed, 1–20 UTF-16 units, never upper-cased, not unique (S242 factory floor ≤ 80 UTF-8 bytes); 0168: at least one visible `[\p{L}\p{N}\p{S}\p{P}]`, tag characters only inside a 🏴…U+E007F flag, no leading `\p{M}` — 400 `INVALID_REQUEST` `detailsSafe {reasonCode: TEXT_NOT_VISIBLE \| TAG_OUTSIDE_FLAG \| LEADING_COMBINING_MARK, field}`; only `launchTextRulesVersion() == 2` is trusted (other values fail closed 503); 0164 §10 transition gate: on a pre-S242 Factory (on-chain `launchTextRulesVersion()`, absent = pre-S242) a ticker outside `^[A-Z0-9]{2,12}$` is 422 `HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY` on hooks-config save / signing-request / submission, probe unreadable 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`; narrative / description ≤ 2000 characters with LF / tab kept; control / bidi / format / filler characters 400 (ZWJ between characters + emoji tags kept). `201` draft; KYB and attachments `unavailable` | `implemented` | `implemented`; review is operator-only (`pnpm launch:review`)                                                                                                                                              |
| `GET /v2/launch/projects/{projectId}`                                  | Bearer + headers                                                                                                                    | Project (owner: any status; others: `approved` only); `reviewReasonCode` + `reviewReasonText`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `implemented` | `implemented`; text is the display projection of the code (Decision 0041)                                                                                                                                  |
| `PUT /v2/launch/projects/{projectId}`                                  | Same headers, no `Idempotency-Key`; `{expectedVersion, project}` (0125: `project.communityId`, absent = keep)                       | 0154 / 0164: name and ticker share the four.meme rule — any language or script, NFC + trimmed, 1–20 UTF-16 units, never upper-cased, not unique (S242 factory floor ≤ 80 UTF-8 bytes); 0168: at least one visible `[\p{L}\p{N}\p{S}\p{P}]`, tag characters only inside a 🏴…U+E007F flag, no leading `\p{M}` — 400 `INVALID_REQUEST` `detailsSafe {reasonCode: TEXT_NOT_VISIBLE \| TAG_OUTSIDE_FLAG \| LEADING_COMBINING_MARK, field}`; only `launchTextRulesVersion() == 2` is trusted (other values fail closed 503); 0164 §10 transition gate: on a pre-S242 Factory (on-chain `launchTextRulesVersion()`, absent = pre-S242) a ticker outside `^[A-Z0-9]{2,12}$` is 422 `HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY` on hooks-config save / signing-request / submission, probe unreadable 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`; narrative / description ≤ 2000 characters with LF / tab kept; control / bidi / format / filler characters 400 (ZWJ between characters + emoji tags kept). Committed material (`draft`/`returned` only)   | `implemented` | `implemented`; CAS                                                                                                                                                                                         |
| `POST /v2/launch/projects/{projectId}/submit`                          | Write headers; no payload                                                                                                           | `submitted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `implemented` | `implemented`; `returned` may resubmit                                                                                                                                                                     |
| `GET /v2/launch/projects/{projectId}/milestones`                       | Bearer + headers                                                                                                                    | Venue milestones with evidence digest/time/reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `implemented` | `implemented`; recorded only by `pnpm launch:milestone`                                                                                                                                                    |
| `GET /v2/launches/{launchId}`                                          | Bearer + headers                                                                                                                    | Launch + config slots + rounds + four axes + graduation steps + pool evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `implemented` | `blocked-provider`; four axes/rounds/config read from the contract once configured and registered (Decision 0076), otherwise `unavailable`                                                                 |
| `GET /v2/launch/{launchId}/eligibility`                                | Bearer + headers; optional `roundIndex`                                                                                             | `mode` from `tierModeV1`; `status: available` with `tier`, `snapshotBlock`, `allowlistRoot`, `eligibilityProof` (Decision 0077)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `implemented` | `blocked-provider`; needs contract + stored root equal to the chain root (`LAUNCH_ALLOWLIST_ROOT_MISMATCH`); all-zero chain root answers open without mode or stored root (0084); never depends on staking |
| `GET /v2/launch/{launchId}/holders`                                    | Bearer + headers                                                                                                                    | `holders` (indexed buyers), `myPosition` (`getPosition`), `walletCap` at one block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `implemented` | `blocked-provider`; `available` once the contract is configured, the sale registered, and the lane indexed (Decision 0077)                                                                                 |
| `GET /v2/launch/{launchId}/history`                                    | Bearer + headers                                                                                                                    | Caller's `purchaseRecords`/`entitlements`/`refunds` from the lane + `source.indexedBlockNumber/Hash`; since Decision 0087 `settlements` (Claimed → `kind: claimed`, Refunded → `kind: refunded`) while `source` is available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `implemented` | `blocked-provider`; lane-projected (Decisions 0077, 0087); unavailable bytes unchanged (no `settlements`)                                                                                                  |
| `POST /v2/launch/{launchId}/intents`                                   | Write headers; `{walletId, roundId, payAmount}` (`kind` absent/`buy`) or `{kind: "claim"\|"claimRefund", walletId}` (Decision 0087) | `201 launchIntent` binding every 03 §8.2 field + unsigned `buy()` / `claim(saleId)` / `claimRefund(saleId)`; claim/refund carry `kind`, null round; refusals carry `detailsSafe.reasonCode` (0087: `409 DATA_STALE` `LAUNCH_CLAIM_NOT_OPEN`, `LAUNCH_REFUND_NOT_OPEN`, `LAUNCH_SALE_PAUSED`, `LAUNCH_NOT_PARTICIPANT`, `LAUNCH_NOTHING_TO_CLAIM`, `LAUNCH_NOTHING_TO_REFUND`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `implemented` | `blocked-provider`; `503` byte-identical while `BSC_WRITES_ENABLED` is off or the contract keys are blank (Decision 0077); a buy's bytes are unchanged by 0087                                             |
| `POST /v2/launch/{launchId}/intents/{launchIntentId}/broadcast-report` | Write headers; `{txHash}`                                                                                                           | `200 launchIntent` `submitted` (then `confirmed` when the lane indexes the Purchased log — Claimed / Refunded of the Intent's wallet for claim / refund, Decision 0087 — or, since 0080, a success receipt; `reverted`/`failed`/`expired` from the receipt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `implemented` | `blocked-provider`; same gates as prepare (Decision 0077)                                                                                                                                                  |
| `GET /v2/launch/{launchId}/intents/{launchIntentId}`                   | Bearer + headers; no payload                                                                                                        | `200 launchIntent`, the prepare `201` projection (all 0080 states, `revertReason` on `reverted` only); owner-scoped, other accounts `404` (Decision 0081)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `implemented` | `blocked-provider`; same `503` gates as prepare/report, plus `503` when the Intent store is unreadable                                                                                                     |
| `GET /v2/launch/stake`                                                 | Bearer + headers                                                                                                                    | `STAKING_CONTRACT_PENDING`, `executable: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `implemented` | `blocked-provider`                                                                                                                                                                                         |
| `GET /v2/launch/economy`                                               | Bearer + headers                                                                                                                    | Provable counts + `source: loop` (Decision 0049); optional `onChain` (registered sales, SUCCEEDED raise, locked LP; `source: loop_indexer`) only with a configured contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `implemented` | `implemented`; `onChain` needs the lane checkpoint (Decision 0077)                                                                                                                                         |

### V2 Hooks launch configuration and deployment tasks (Decision 0108, inside `launch`)

Ported in S125 from the requirer branch `codex/integrated-dual-pool-20261008`
(requirer Decisions 0090/0095/0097; migrations renumbered 000051–000054).
Fixed `hooks_launch_v1` template, BSC Testnet only, no broadcast. Off by
default: while `HOOKS_LAUNCH_ENABLED` is not `on` every route answers `503
CAPABILITY_UNAVAILABLE` (`HOOKS_LAUNCH_DISABLED`). Signing and submission
additionally need `LAUNCH_CHAIN_ID=97` + launch RPC URLs +
`HOOKS_LAUNCH_FACTORY_ADDRESS` + `HOOKS_LAUNCH_FACTORY_CODE_HASH`
(`HOOKS_LAUNCH_FACTORY_UNAVAILABLE`). Operator approval / testnet acceptance
run through the console (Decision 0109: `POST /admin/v1/launch/projects/…`,
reviewer / testnet_acceptor accounts bound to LOOP users); operators are
provisioned by those console accounts or by `pnpm hooks:operator`.
Frontend contract: `docs/frontend-v2-hooks-launch-api.md`.

S132 (Decision 0112, migration 000059): the worker lane `hooks_launch_executor`
(default off, `HOOKS_LAUNCH_EXECUTOR_ENABLED=on` + `HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY`

- the Factory pair + `LAUNCH_CHAIN_ID=97`, else boot refused) claims tasks,
  persists then broadcasts `deployLaunch`, follows confirmations (default 3) and
  reorgs, verifies 28 read-back checks, and activates via
  `LoopLaunchFactory.activateLaunch`. The task resource gains `status`
  (9 values), `txHash`, `confirmations`, `activationTxHash`, `addresses`
  (predicted / deployed), `failure`, `attemptCount`, `events[]`, `updatedAt`;
  `DELETE` after a claim is `409 VERSION_CONFLICT`
  (`HOOKS_DEPLOYMENT_NOT_CANCELLABLE`). Console: `docs/frontend-admin-role-separation.md` §11.
  End-to-end evidence: anvil chain 97 with the real Foundry scripts
  (`test/hooks-launch-executor-anvil.integration.test.ts`); no BSC Testnet
  broadcast yet (Factory not deployed there).

S139 (Decision 0117, no migration): the NFT sale-start lead a saved config
must keep is `HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS` (default 86,400 = the
previous fixed value; floor 4,200 = Gate activation buffer 3,600 + 600; the
owner `PUT` and the operator save share it). S137 ran the full deploy →
28-check verify → activate path on BSC Testnet 97 (job
`421662f0-…`, instance `e600ac16-…`). `GET /admin/v1/launch/projects/{id}`
gains read-only `deploymentChainId` (`LAUNCH_CHAIN_ID`); the template's
`fixedEconomics.chainId` stays 56.
Decision 0150 adds the optional `deploymentMainnetAcknowledged: true`, present
only when `deploymentChainId` is 56 and `LAUNCH_MAINNET_ACK` opened the mainnet
action paths (absent otherwise, so earlier responses are byte-identical); the
Hooks task `chainId` widens from `97` to `56 | 97`.

| Route                                                                         | Input                                                        | Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Contract      | Runtime                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /v2/launch/projects/{projectId}/hooks-config`                            | Bearer + headers; no payload                                 | `{draft \| null, approval, latestDeployment, minSaleLeadSeconds, contractVersion}` (0120); owner-scoped; 0122: `approval.status` `rejected` + `approval.rejection`, `buybackRecipientFixed`, `fixedBuybackRecipient`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `implemented` | `implemented` behind `HOOKS_LAUNCH_ENABLED`                                                             |
| `PUT /v2/launch/projects/{projectId}/hooks-config`                            | Headers, no `Idempotency-Key`; `{expectedVersion, config}`   | 0154 / 0164: name and ticker share the four.meme rule — any language or script, NFC + trimmed, 1–20 UTF-16 units, never upper-cased, not unique (S242 factory floor ≤ 80 UTF-8 bytes); 0168: at least one visible `[\p{L}\p{N}\p{S}\p{P}]`, tag characters only inside a 🏴…U+E007F flag, no leading `\p{M}` — 400 `INVALID_REQUEST` `detailsSafe {reasonCode: TEXT_NOT_VISIBLE \| TAG_OUTSIDE_FLAG \| LEADING_COMBINING_MARK, field}`; only `launchTextRulesVersion() == 2` is trusted (other values fail closed 503); 0164 §10 transition gate: on a pre-S242 Factory (on-chain `launchTextRulesVersion()`, absent = pre-S242) a ticker outside `^[A-Z0-9]{2,12}$` is 422 `HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY` on hooks-config save / signing-request / submission, probe unreadable 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`; narrative / description ≤ 2000 characters with LF / tab kept; control / bidi / format / filler characters 400 (ZWJ between characters + emoji tags kept). New immutable version with server-derived `fixedEconomics` and `configHash`; 0122: `buybackRecipient` must be `LAUNCH2_BUYBACK_RECIPIENT` (422 `HOOKS_BUYBACK_RECIPIENT_FIXED`, unset → 503 `HOOKS_BUYBACK_RECIPIENT_UNAVAILABLE`; also on signing-request / submission) | `implemented` | `implemented` behind `HOOKS_LAUNCH_ENABLED`; CAS; sale lead `HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS` (0117) |
| `GET /v2/launch/projects/{projectId}/hooks-config/signing-request`            | Bearer + headers; `walletId`                                 | EIP-712 typed data (`types` include `EIP712Domain`, 0120), MEME salt (`…6666`), Hook salt (`0x20CC`; 0132: `0x10C4`, salt ≠ 0, `typedData.message.templateHash` = the LoopDynamic Factory `TEMPLATE_HASH` with `HOOKS_LAUNCH_HOOK_KIND=loopDynamic`), predicted addresses; 0127: `configVersion` is owner-unique across projects, 422 `HOOKS_CONFIG_VERSION_USED` when the Factory already recorded (wallet, version); 0160: Factory reads concurrent under an 8 s budget, slow RPC → 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`, nothing written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `implemented` | `blocked-provider`; needs the Testnet Factory configuration                                             |
| `POST /v2/launch/projects/{projectId}/hooks-deployments`                      | Write headers incl. UUIDv4 `Idempotency-Key`; signed request | `awaiting_executor` task; the executor (Decision 0112) advances it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `implemented` | `blocked-provider`; needs the Factory and an operator approval (`403 POLICY_BLOCKED` otherwise)         |
| `GET /v2/launch/projects/{projectId}/hooks-deployments/{jobId}`               | Bearer + headers                                             | Owner-scoped task with executor progress, addresses, events (0112); 0164: deploy simulation `InvalidName` / `InvalidTicker` → `failure.code` `HOOKS_LAUNCH_NAME_INVALID` / `HOOKS_LAUNCH_TICKER_INVALID`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `implemented` | `implemented` behind `HOOKS_LAUNCH_ENABLED`; progress needs the executor lane                           |
| `DELETE /v2/launch/projects/{projectId}/hooks-deployments/{jobId}`            | Write headers incl. UUIDv4 `Idempotency-Key`                 | `cancelled` task; `409` once claimed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `implemented` | `implemented` behind `HOOKS_LAUNCH_ENABLED`                                                             |
| S141 (Decision 0119, no migration): the NFT sale period is the target         |
| Factory's `nftSaleDuration()` (3,600 s on the BSC Testnet one-hour Factory,   |
| 604,800 s on mainnet / pre-S141 Factories). The draft save reads it into      |
| `fixedEconomics.nftSaleDurationSeconds` (so `PUT hooks-config` now also needs |
| the Factory pair, else `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`; at 604,800 s the   |
| `configHash` is byte-for-byte the pre-S141 one); signing preparation and      |
| submission refuse a config hashed for another period                          |
| (`503 HOOKS_FACTORY_TEMPLATE_MISMATCH`); the executor verifies the NFT        |
| period / `saleEnd` / registry cutoff against the Factory reading and records  |
| the verified `saleEnd` (and `legacyFactory: true` for a pre-S141 Factory).    |

| Route                                                              | Input                                                        | Output                                                                                                                    | Contract      | Runtime                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `GET /v2/launch/projects/{projectId}/hooks-config`                 | Bearer + headers; no payload                                 | `{draft \| null, approval, latestDeployment, minSaleLeadSeconds, contractVersion}` (0120); owner-scoped                   | `implemented` | `implemented` behind `HOOKS_LAUNCH_ENABLED`                                                     |
| `PUT /v2/launch/projects/{projectId}/hooks-config`                 | Headers, no `Idempotency-Key`; `{expectedVersion, config}`   | New immutable version with server-derived `fixedEconomics` and `configHash`                                               | `implemented` | `blocked-provider`; needs the Testnet Factory (sale period read, Decision 0119); CAS            |
| `GET /v2/launch/projects/{projectId}/hooks-config/signing-request` | Bearer + headers; `walletId`                                 | EIP-712 typed data (`types` include `EIP712Domain`, 0120), MEME salt (`…6666`), Hook salt (`0x20CC`), predicted addresses | `implemented` | `blocked-provider`; needs the Testnet Factory configuration                                     |
| `POST /v2/launch/projects/{projectId}/hooks-deployments`           | Write headers incl. UUIDv4 `Idempotency-Key`; signed request | `awaiting_executor` task; the executor (Decision 0112) advances it                                                        | `implemented` | `blocked-provider`; needs the Factory and an operator approval (`403 POLICY_BLOCKED` otherwise) |
| `GET /v2/launch/projects/{projectId}/hooks-deployments/{jobId}`    | Bearer + headers                                             | Owner-scoped task with executor progress, addresses, events (0112)                                                        | `implemented` | `implemented` behind `HOOKS_LAUNCH_ENABLED`; progress needs the executor lane                   |
| `DELETE /v2/launch/projects/{projectId}/hooks-deployments/{jobId}` | Write headers incl. UUIDv4 `Idempotency-Key`                 | `cancelled` task; `409` once claimed                                                                                      | `implemented` | `implemented` behind `HOOKS_LAUNCH_ENABLED`                                                     |

Dual-pool mining algorithms (Decision 0107) are library code only: no route.

### V2 MEME launchpad module (Decision 0101, `V2_MODULES_ENABLED=meme`)

The four.meme-style bonding-curve launchpad of the v3 MEME tab (docs/10,
`LoopMemeCurve` on the launch slot, BSC testnet in Development). Lists,
details, trades, K-lines, and holders read the `meme_event` lane's
PostgreSQL projection (migration 000049); the viewer block, quotes, and
Intents read the curve at one block. Without `MEME_CONTRACT_ADDRESS`,
`MEME_CONTRACT_VERSION`, `MEME_CONTRACT_START_BLOCK`,
`MEME_TOKEN_IMPLEMENTATION`, and the Launch `LAUNCH_USD1_ADDRESS`, the `meme`
capability is `unavailable` and every route answers `503
CAPABILITY_UNAVAILABLE` with `detailsSafe.reasonCode`. Intents additionally
need `BSC_WRITES_ENABLED` and the 97 slot (mainnet signing stays closed).
Worker lanes `meme_event`, `meme_salt_pool`, `meme_intent_reconcile`
(`MEME_INDEXER_ENABLED`) and `meme_graduation_executor`
(`MEME_GRADUATION_EXECUTOR_ENABLED` + `LAUNCH_DEPLOYER_PRIVATE_KEY`; waits
`MEME_GRADUATION_DELAY_SECONDS`, default 15 s, Decision 0103) are
default-off. `pnpm meme:abi-check <abi.json>` checks a delivered ABI against
`src/integrations/meme/meme-abi.v1.json`; `pnpm meme:salt-refill` fills the
vanity salt pool once. `category=meme` of `GET /v2/market/assets` now lists
App-created MEME tokens too, ungraduated ones priced from the curve
(`quote.source = loop_curve`). Decision 0103 (S116b): a graduated token
without a DexScreener quote is priced from its PancakeSwap V3 pool's
`slot0()` (`pool_slot0`, `quality: derived` on the market quote, 1.5 s
cache; a failed read keeps the earlier reason), and `graduation.residual`
below 1 USD1 and below 1 token (rounding dust) projects as `null`. Decision
0104 (S116c): the rolling canary day is one window over wallet, Launch, and
MEME Intents (`src/database/canary-exposure.ts`, `created_at >= since`) and is
re-checked under the owner lock in the insert transaction of all three; a
draft has at most one live create Intent (`409 MEME_INTENT_CREATE_IN_FLIGHT`);
sells also need USD1 on the canary allowlist; every chain read of the Intent
POST maps an RPC timeout or unknown error to `503 MEME_CONTRACT_READ_FAILED`;
the lane refreshes every `meme_trades` fact on a replayed key, reopens
`confirmed` Intents whose evidence a rewind removed, and refuses a
TokenCreated whose `creator` is not a create Intent's wallet
(`MEME_CREATED_CREATOR_MISMATCH`, logged). Frontend contract:
`docs/frontend-v2-meme-api.md`.

Decision 0151 (2026-10-16): classic launch **creation** is retired — every
new launch goes through Loop Hook (`/v2/launch2`). `POST /v2/meme/tokens` and
create Intents answer 410 `MEME_CLASSIC_LAUNCH_RETIRED` unless
`MEME_CLASSIC_CREATE_ENABLED=true`; reads, buy / sell, reports, K-lines,
holders, admin listing / pause, and the worker lanes are unchanged.

| Method and path                                                              | Request                                                                                                                                                                                                                      | Response                                                                                                                                                                                                                                                                                                                                      | Contract                                                                                                                                                                                                                                               | Runtime                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/meme/tokens`                                                        | `tab=new\|hot\|graduating\|graduated`, `limit` ≤ 50 or signed `cursor`                                                                                                                                                       | Rows with curve price/market cap (`loop_curve`) or DexScreener / pool `slot0` (`pool_slot0`, Decision 0103) for graduated (`quoteUnavailable` when none), progress, 1h change, 24h curve volume (`volume24hUsd1`, curve only), `holderCount`, `createdAt` (Decision 0142)                                                                     | `implemented`                                                                                                                                                                                                                                          | `implemented`; `hot` ranking cached 60 s; operator-hidden tokens (`listing=hidden`, Decision 0102) excluded at once; a `hot` page fills past hidden tokens (Decision 0105) |
| `POST /v2/meme/tokens`                                                       | Write headers incl. `Idempotency-Key`; `{name, symbol, description?, imageMediaId?, links?}`                                                                                                                                 | `201` draft detail with `metadataHash`, `salt`, `predictedAddress`, `vanity`; 0164: name / symbol any script, 1–20 UTF-16 units, never upper-cased; 0168: visible-character rule, refusal keeps `MEME_METADATA_INVALID` and adds `detailsSafe.textReasonCode`; `429 MEME_CREATE_RATE_LIMITED` past `MEME_CREATE_DAILY_LIMIT` per rolling 24 h | `retired (0151)`                                                                                                                                                                                                                                       | `retired (0151)`: 410 `MEME_CLASSIC_LAUNCH_RETIRED`, nothing written, unless `MEME_CLASSIC_CREATE_ENABLED=true` (default false; then as before)                            |
| `GET /v2/meme/tokens/{memeTokenId}`                                          | Bearer + headers                                                                                                                                                                                                             | Row + `curve`, `contract`, `viewer` (chain, 1.5 s cache) or `viewerUnavailable`, `graduation` (pool, LP burn tx, residual; dust → `null`, Decision 0103), `listing` + `listingReason` (Decision 0102; `reasonCode` = `OPERATOR_<CODE>`, Decision 0105)                                                                                        | `implemented`                                                                                                                                                                                                                                          | `implemented`; drafts creator-only; hidden tokens still readable                                                                                                           |
| `GET /v2/meme/best-trades`                                                   | `window=7d` (only, default)                                                                                                                                                                                                  | ≤ 10 `{rank, user{userId=publicProfileId, loopId, alias, avatar}, token{memeTokenId, symbol, logoUrl}, realizedUsd1, observedAt}`; curve sells − average curve buy cost, positive only, mapped visible accounts only (Decision 0142)                                                                                                          | `implemented`                                                                                                                                                                                                                                          | `implemented`; computed on read, cached 5 min per process                                                                                                                  |
| `GET /v2/meme/tokens/{memeTokenId}/trades`                                   | `limit` ≤ 100 or signed `cursor`                                                                                                                                                                                             | Trade logs newest first, wallet-side USD1, `account` when a public profile exists (0162 §D: null to others when the owner's trade history is `self`)                                                                                                                                                                                          | `implemented`                                                                                                                                                                                                                                          | `implemented`                                                                                                                                                              |
| `GET /v2/meme/tokens/{memeTokenId}/candles`                                  | `interval=1m\|5m\|15m\|1h\|4h\|1d`, `limit` ≤ 300                                                                                                                                                                            | OHLC of the post-trade curve price + USD1 volume, empty buckets not filled, frozen at graduation                                                                                                                                                                                                                                              | `implemented`                                                                                                                                                                                                                                          | `implemented`                                                                                                                                                              |
| `GET /v2/meme/tokens/{memeTokenId}/holders`                                  | `limit` ≤ 100 or signed `cursor`                                                                                                                                                                                             | Net curve positions, `shareBps`, `isCreator`, `isViewer`, frozen at graduation                                                                                                                                                                                                                                                                | `implemented`                                                                                                                                                                                                                                          | `implemented`                                                                                                                                                              |
| `GET /v2/meme/quote`                                                         | `tokenId`, `side=buy\|sell`, `amount`, optional `walletId`                                                                                                                                                                   | docs/10 §2 recomputation (`out`, `fee`, `refund`, impact, `walletCapHit`, `belowMinBuy`), basis chain or index; chain quote audit logs drift > 0.1%                                                                                                                                                                                           | `implemented`                                                                                                                                                                                                                                          | `implemented`                                                                                                                                                              |
| `POST /v2/meme/tokens/{memeTokenId}/intents`                                 | Write headers; `{kind: create\|buy\|sell, walletId, usd1Amount?\| tokenAmount?, minOut?\; `kind: create` `retired (0151)`: 410 `MEME_CLASSIC_LAUNCH_RETIRED`unless`MEME_CLASSIC_CREATE_ENABLED=true`; `buy`/`sell` unchanged | slippageBps?, deadlineSeconds?}`                                                                                                                                                                                                                                                                                                              | `201` Intent: `calldata`, `unsignedTransaction`, exact `approval` when the allowance is short, canary policy (one wallet + Launch + MEME day, re-checked under the owner lock, Decision 0104), simulation, signing; `409 MEME_INTENT_CREATE_IN_FLIGHT` | `implemented`                                                                                                                                                              | `blocked-provider` until `BSC_WRITES_ENABLED`; 97 only |
| `POST /v2/meme/tokens/{memeTokenId}/intents/{memeIntentId}/broadcast-report` | Write headers; `{txHash}`                                                                                                                                                                                                    | `prepared → broadcast_reported`; confirmed by the lane or the receipt                                                                                                                                                                                                                                                                         | `implemented`                                                                                                                                                                                                                                          | `implemented`                                                                                                                                                              |
| `GET /v2/meme/intents/{memeIntentId}`                                        | Bearer + headers                                                                                                                                                                                                             | Same projection, owner-scoped                                                                                                                                                                                                                                                                                                                 | `implemented`                                                                                                                                                                                                                                          | `implemented`                                                                                                                                                              |

### V2 MEME v2 read model (Decision 0114, `V2_MODULES_ENABLED=launch2`)

The 《整体方案》 launch (NFT sale → snapshot → priority hour → public curve →
graduation → buyback) as the App reads it. Instances are the S132 tasks that
reached `activated` on the configured Hooks Factory; the worker lane
`launch2_event` (`LAUNCH2_INDEXER_ENABLED`, default off; migration 000061)
indexes the Factory, gate, NFT, snapshot registry, curve, and buyback
executor logs with the S116 checkpoint / reorg discipline and rebuilds the
published snapshot from the NFT transfers. Without a Factory pair on
the BSC Testnet launch slot every route is `503 CAPABILITY_UNAVAILABLE`
(`LAUNCH2_FACTORY_NOT_CONFIGURED` / `LAUNCH2_CHAIN_NOT_CONFIGURED`; Decision
0133: the OfficialTax pair `HOOKS_LAUNCH_FACTORY_*` **or** the LoopDynamic
pair `LAUNCH2_DYNAMIC_FACTORY_*` is enough, only neither is not configured);
prepares also need `BSC_WRITES_ENABLED`. Capability `launch2` (deferred
until enabled; evidence pending until a BSC Testnet run). Evidence:
`test/launch2-anvil.integration.test.ts` (anvil chain 97, real Foundry
deploy); BSC Testnet round 1 (S137) registered an activated instance and
matched the chain 40/40 at `upcoming`. S139 (Decision 0117): the prepares'
counterparties are the activated instance's registered contracts plus its
curve-bound USD1 (`403 LAUNCH2_COUNTERPARTY_NOT_INSTANCE` otherwise), not
`BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST`; the canary asset list and ceilings
still apply. Frontend contract: `docs/frontend-v2-launch2-api.md`.

S146 (Decision 0124): official-pool (Uniswap v4) trading after graduation through
`OfficialPoolRouter` (`LAUNCH2_POOL_ROUTER_ADDRESS` + `LAUNCH2_POOL_ROUTER_CODE_HASH`, BSC Testnet
only, code hash checked at startup and per request; blank → 503 `POOL_ROUTER_NOT_CONFIGURED`).
The `launch2_event` lane also reads the PoolManager `Swap` logs of each graduated instance's
`officialPoolId` (topic-filtered, migration 000068 `launch2_pool_swaps`) into the detail's
`pool` block. Evidence: `test/launch2-pool-anvil.integration.test.ts` (anvil chain 97: graduate,
quote, prepare, execute the calldata, index).

S150 (Decision 0126): prepares encode prepare time + `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS`
(default 180 s; quotes keep their 60 s freshness); the lane also reads the router's own
`Swap(payer, recipient)` logs (topic-filtered by pool id, migration 000070) and attributes each
routed PoolManager swap to its payer (one-time re-scan from the graduation block); the detail
`viewer` and positions carry live MEME / USD1 balances and the wallet's `poolTradeCount`; new
`GET …/pool/trades`. Evidence: `test/launch2-pool-anvil.integration.test.ts` (unattributed →
re-scan → attributed, balances, positions), `test/v2-launch2-wallet-pool-routes.test.ts`.

S151 (Decision 0127): `instance.pool` adds the required `userTradeCount` /
`userBuyVolumeUsd1` / `userSellVolumeUsd1` — the same totals without the swaps the instance's
buyback adapter / executor sent (projection columns `pool_user_*`, migration 000072 with a
facts-only backfill); the existing pool fields keep counting every swap. Evidence:
`test/launch2-buyback-keeper-anvil.integration.test.ts` (three buybacks: `tradeCount` 3,
`userTradeCount` 0), `test/launch2-pool-anvil.integration.test.ts` (router trades count in both),
`test/v2-launch2-pool-routes.test.ts`.

S170 (Decision 0132): `HOOKS_LAUNCH_HOOK_KIND=loopDynamic` now saves, reviews, prepares, accepts
and executes Hooks launches on the LoopDynamic Factory (`LAUNCH2_DYNAMIC_FACTORY_ADDRESS` /
`_CODE_HASH` in the API and the worker; template read from chain and verified against
`TEMPLATE_HASH`; executor read-back of 31 LoopDynamic checks; migration 000078 admits the stored
`poolHookKind`). LoopDynamic pool swaps are attributed to the swap transaction's `from` for a
direct LoopRouter call (migration 000077 `attribution_source`). The MEME transfer coverage
(0129 §2) degrades a single instance on a missing mint anchor instead of idling the lane, and
every segment is vouched for by `balanceOf` / `totalSupply` at its last block. Evidence:
`test/hooks-launch-loop-dynamic-anvil.integration.test.ts` (real `DeployLoopProtocol` LoopDynamic
component on anvil: save → approve → sign → deploy → verify → activate → lane registers
`loopDynamic`), `test/launch2-indexer-worker.test.ts`, `test/launch2-dynamic.integration.test.ts`.

S245 (Decision 0163, migration 000093): `launch2_instances.listing` (`visible` / `hidden`,
operator-owned, never written by the indexer). Every list read drops `hidden` — `GET /v2/launch2/instances`
(all stages), `GET /v2/launch2/overview` (counts and activity), `GET /public/v1/meme`, Square
timeline / pinned event posts — while the detail, quotes, positions, `GET /public/v1/meme/{id}`
and a post by id still read it. `/v2` wire format unchanged (no `listing` — shipped App codecs are strict); `/public/v1/meme/{id}` carries `instance.listing`. Console:
`GET /admin/v1/launch2/instances`, `PUT /admin/v1/launch2/instances/{id}/listing`. Evidence:
`test/launch2-listing.integration.test.ts`, `test/admin-routes.test.ts`, `test/v2-launch2-routes.test.ts`.

S172 (Decision 0133): launch2 runs with only the LoopDynamic Factory pair — routes, capability
`launch2` and the `launch2_event` lane (Factories = LoopDynamic + legacy); a legacy entry equal to
the LoopDynamic Factory refuses worker boot; the faucet's `usd1()` source and the buyback keeper's
Factory fall back to the LoopDynamic Factory when there is no OfficialTax one. Evidence:
`test/launch2-dynamic-only.test.ts`.

S143 (Decision 0121): the worker lane `launch2_buyback_keeper`
(`LAUNCH2_BUYBACK_KEEPER_ENABLED`, default off; migration 000065
`launch2_buyback_attempts`) calls `BuybackExecutor.execute()` from a Factory
keeper key on graduated, unpaused instances (simulate first; refusals are
recorded, never sent; the ledger stays the `launch2_event` lane's). The
buyback summary (instance detail `buyback` and `GET …/buybacks` `summary`)
adds the optional `keeper` (`lastAttemptAt`, `lastResult`, `reasonCode`,
`nextEligibleAt`); the console project detail adds `buybackAttempts` (newest
20). Quote and trade prepare now gate on the read-model stage (the detail's);
a chain ahead of the lane is `409 LAUNCH2_STAGE_MISMATCH`. Evidence:
`test/launch2-buyback-keeper-anvil.integration.test.ts` (anvil chain 97,
graduation by 160 wallets, three executions); no BSC Testnet run (needs a
graduated Testnet instance, a keeper key with tBNB, and a fed price recorder).

S282 (Decision 0175, migration 000097): the operator-set custom community label
(`communities.label`, 1–12 characters, null = none) replaces the App's "verified" mark; the
review (`verificationStatus`) still gates search and public visibility. Written through
`PUT /admin/v1/communities/{id}/label` (console audit `community.label.update`). Every /v2
community projection that carries `verificationStatus` (community summary on lists / detail /
home / members / commands / recommended, `GET /v2/search` `displaySnapshot`, `GET
/v2/profiles/{id}/communities` items) adds the optional `label: string | null` only with
`COMMUNITY_LABEL_EMIT=on` (default off, byte-identical). Front-end contract:
`docs/frontend-v2-community-api.md` §社区自定义标签.

S307 / Decision 0186: `GET /v2/market/assets?category=` items and `GET /v2/market/overview`
watchlist / trending items add the optional `sparkline24h: string[] | null` (up to 24 hourly
closes: the row's own GeckoTerminal `sparkline`, else launch2 / MEME v1 chain trades bucketed
by hour) only with `MARKET_ROW_SPARKLINE24H_EMIT=on` (default off, byte-identical). No
migration. Front-end contract: `docs/frontend-v2-market-api.md` §12a.

S274 (Decision 0173, migration 000096): the project NFT picture. `POST /v2/media/project-nft-images`
(media kind `project_nft_image`, the community-logo upload rules) answers `201 {mediaId, ref,
url, mediaUrl, cid, ipfsUri, width, height}`; with `NFT_IMAGE_STORAGE=filebase` the stored
WebP is pinned to IPFS through the Filebase IPFS RPC API (`FILEBASE_RPC_ENDPOINT`,
`FILEBASE_RPC_TOKEN`) and `url` is `<IPFS_GATEWAY_BASE_URL>/<cid>`; `local` (default) keeps
`cid: null` and the media path. The Hooks draft (`PUT …/hooks-config` `config`) takes an
optional `nftImageAssetUrl` — the caller's own upload only (422 `MEDIA_NOT_OWNED`), stored
canonical (gateway URL when pinned) plus a server-side `nftImageCid` (not on `/v2`), appended
to the signed configHash tuple only when present. Instance list rows, the instance detail and
`GET /v2/launch2/me/positions` rows add the optional nullable `nftImageUrl`, emitted only with
`LAUNCH2_NFT_IMAGE_EMIT=on` (default off, Decision 0166 §D). The console project detail
(`GET /admin/v1/launch/projects/{projectId}` `versions[].config`) adds `nftImageAssetUrl` /
`nftImageCid` (null when none). Public ERC-721 metadata: `GET /v2/launch2/nft/{launchId}/{tokenId}`
(below). Evidence: `test/launch2-nft-image.test.ts`, `test/v2-media-routes.test.ts`,
`test/ipfs-pinner.test.ts` (opt-in live Filebase check), `test/launch2-nft-image.integration.test.ts`.

S280 (Decision 0174, no migration): `GET /v2/launch2/me/positions` rows add the optional
nullable `priceUsd1` / `valueUsd1` / `priceSource` (`curve` before graduation = the read-model
curve price × `curve.net`; `pool` after = `pool.lastPriceUsd1` × `memeBalance`; null when there
is no price or the balance is unavailable — never estimated), emitted only with
`LAUNCH2_POSITION_VALUE_EMIT=on` (default off, Decision 0166 §D); the rows' instances are read
in one batched query (`getInstances`, was one read per instance). New public
`GET /v2/launch2/instances/{instanceId}/pool/recent-trades` (below). Evidence:
`test/v2-launch2-position-value-routes.test.ts`, `test/launch2-position-value.integration.test.ts`.

S284 (Decision 0176, no migration): `GET /v2/launch2/me/positions` rows and the instance detail's
`viewer` add the optional nullable `avgCostUsd1` / `costBasisUsd1` / `realizedPnlUsd1` /
`unrealizedPnlUsd1` (signed) / `costCoverage` (`full` | `partial`) — moving-average cost replayed
in chain order from the wallet's curve trades then its attributed official-pool user swaps (router
amounts; buyback and reorged rows excluded), one `listCostTrades` read per request; priced and sized
like S280 (curve price × `curve.net` / pool last price × `memeBalance`). Emitted only with
`LAUNCH2_PNL_EMIT=on` (default off, Decision 0166 §D). Evidence: `test/launch2-cost-basis.test.ts`,
`test/v2-launch2-position-pnl-routes.test.ts`, `test/launch2-position-pnl.integration.test.ts`.

| Route                                                                            | Input                                                                                                    | Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Contract      | Runtime                                                                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/launch2/instances`                                                      | `stage`, `limit` ≤ 50 or signed `cursor`                                                                 | Rows: stage + `nextChangeAt` (clock-derived), NFT sold, curve sold / reserve / price                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `implemented` | `blocked-provider`; needs the Testnet Factory + lane                                                                                  |
| `GET /v2/launch2/overview`                                                       | Bearer + headers; no query                                                                               | 0139: newest 30 activity rows + stage counts; 0162: each row's `account` (actor's profile under trade visibility, or null) — 0166: key emitted only with `LAUNCH2_TRADER_ACCOUNT_EMIT=on` (default off, needs app build ≥ 31)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `implemented` | `blocked-provider`                                                                                                                    |
| `GET /v2/launch2/instances/{instanceId}`                                         | optional `walletId`                                                                                      | Template, contracts, snapshot, graduation, buyback (+ `keeper`), 20 trades (0162: each with the trader's `account` or null; 0166: only with `LAUNCH2_TRADER_ACCOUNT_EMIT=on`, default off), viewer (0126: balances, `poolTradeCount`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `implemented` | `blocked-provider`                                                                                                                    |
| `GET /v2/launch2/instances/{instanceId}/quote`                                   | `side`, `amount`, `walletId`, `slippageBps?`                                                             | One-block quote with tax, `minOut`, `deadline`, executable `max` (quota / inventory / balance), quota, eligibility; stage = read model (S143); 0170: nothing executable for want of balance → 409 `INSUFFICIENT_BALANCE` (`LAUNCH2_USD1/MEME_BALANCE_INSUFFICIENT`), not `LAUNCH2_QUOTE_ZERO`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `implemented` | `blocked-provider`                                                                                                                    |
| `POST /v2/launch2/instances/{instanceId}/nft/prepare`                            | Write headers incl. `Idempotency-Key`; `{walletId}`                                                      | `201` unsigned `mint()` (+ exact 100 USD1 approve); device signing exit; counterparties = instance registry (0117)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `implemented` | `blocked-provider`; needs `BSC_WRITES_ENABLED`                                                                                        |
| `POST /v2/launch2/instances/{instanceId}/trade/prepare`                          | Write headers; `{walletId, side, amount, minOut, deadline}`                                              | `201` unsigned `buy` (with Merkle proof in the priority hour) / `sell` (+ exact approve); `QUOTE_EXPIRED`, `PRICE_MOVED`; counterparties = instance registry (0117)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `implemented` | `blocked-provider`; needs `BSC_WRITES_ENABLED`                                                                                        |
| `GET /v2/launch2/instances/{instanceId}/buybacks`                                | `limit` ≤ 100 or signed `cursor`                                                                         | Executed buybacks, ledger summary (+ `keeper`, 0121), live executor / escrow state with `nextOrderBlockedReason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `implemented` | `blocked-provider`; rejected attempts leave no log                                                                                    |
| `GET /v2/launch2/instances/{instanceId}/candles`                                 | `interval` (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`, default `5m`), `limit` 1–500 (default 200), `before?` unix s | 0171: K-line `{instanceId, interval, quoteAsset USD1, source curve\|pool\|mixed, candles[{t,o,h,l,c,v,q,n}], latest}` — curve trades at `launch2PriceAt(running sold)` then official-pool swaps at `price_e18`, one series in chain order; empty buckets flat at the previous close up to now; `removed` excluded; SQL aggregate over `launch2_trades` / `launch2_pool_swaps`, no migration; 422 `LAUNCH2_CANDLE_*_INVALID`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `implemented` | `blocked-provider`; data only once the `launch2_event` lane has indexed trades                                                        |
| `GET /v2/launch2/me/positions`                                                   | Bearer + headers                                                                                         | Per instance × wallet: NFT, snapshot member, curve quota; 0126: graduated `memeBalance` / `usd1Balance` (≤ 15 s), `poolTradeCount`, pool-only wallets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `implemented` | `blocked-provider`                                                                                                                    |
| `GET /v2/launch2/nft/{launchId}/{tokenId}`                                       | No auth, no LOOP headers, no query; `launchId` 0x+64 hex, `tokenId` 1..n                                 | 0173: ERC-721 metadata `{name, description, image, image_gateway, attributes[Project, Token ID, Stage]}`; `image` = `ipfs://<cid>` when pinned, else the NFT picture URL, else the logo, else null; `Cache-Control: public, max-age=300, stale-while-revalidate=3600`, CORS `*`; 404 `LAUNCH2_INSTANCE_NOT_FOUND` / `LAUNCH2_NFT_NOT_MINTED` (tokenId > minted count)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `implemented` | `implemented`; stable path for a future on-chain `_baseURI`                                                                           |
| `GET /v2/launch2/instances/{instanceId}/pool/quote`                              | `side`, `mode` (`exactIn`/`exactOut`), `amount`, `walletId`, `slippageBps?`                              | 0153: a LoopDynamic instance quotes / prepares through its own Factory's `loopRouter()` (trusted Factories only: 503 `LAUNCH2_DYNAMIC_FACTORY_UNKNOWN`; current Factory ≠ env 503 `LAUNCH2_DYNAMIC_ROUTER_MISMATCH`). 0152: an S209 Hook (bits 0x10CC) takes the buy fee from the USD1 input — `taxToken`/`dynamic.baseTaxToken` `usd1`, `taxAmount` = ⌊amountIn × buyFeePpm / 1e6⌋, MEME output untaxed; pre-S209 Hooks unchanged. 0131: LoopDynamic instances go through `LoopRouter.swapExactInput` (exactIn only, `quote.dynamic`). 0124: graduated only; eth_call of `OfficialPoolRouter` (balance / allowance state override) on the PoolKey verified against `officialPoolId`; 2 % output tax, `minOut` / `maxIn`, `router`, `poolId`, `quotedAtBlock`, `expiresAt`                                                                                                                                                                                                                    | `implemented` | `blocked-provider`; needs `LAUNCH2_POOL_ROUTER_*`                                                                                     |
| `POST /v2/launch2/instances/{instanceId}/pool/trade/prepare`                     | Write headers; `{walletId, side, mode, amount, slippageBps}`                                             | `201` unsigned `swapExactIn` / `swapExactOut` to the router (+ exact approve of the input token), kind `pool_buy` / `pool_sell`, simulation under allowance override, plus `quote`; 0165: intent `taxUsd1` = the quote's (USD1-taxed S209 buys included)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `implemented` | `blocked-provider`; needs `BSC_WRITES_ENABLED` + router pair                                                                          |
| `GET /v2/launch2/instances/{instanceId}/pool/trades`                             | `walletId` (required, caller's), `limit` ≤ 50                                                            | 0126: the wallet's own pool swaps (0162: `account` = the caller's own profile; 0166: only with `LAUNCH2_TRADER_ACCOUNT_EMIT=on`, default off) attributed via the router `Swap(payer)`, newest first, `poolTradeCount` / `lastPoolTradeAt`; 0132: LoopDynamic swaps attributed to `tx.from` of a direct LoopRouter call (`attribution_source = transaction_sender`); other routers / the buyback stay anonymous                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `implemented` | `blocked-provider`; worker needs `LAUNCH2_POOL_ROUTER_*`                                                                              |
| `GET /v2/launch2/instances/{instanceId}/pool/recent-trades`                      | No Bearer (V2 read headers required); `limit` 1–50 (default 20)                                          | 0174: the instance's newest official-pool user swaps of every wallet (0127 / 0158 rule: no buyback swaps; reorged rows left out), newest first: `{txHash, blockNumber, at, side, memeAmount, usd1Amount, priceUsd1, wallet}` with `wallet` masked `0x1234…abcd` (null = anonymous); `[]` before graduation; 10 s reuse + `Cache-Control: public, max-age=10`; 429 `RATE_LIMITED` + `Retry-After` above `PUBLIC_RATE_LIMIT_PER_MINUTE` per visitor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `implemented` | `blocked-provider`; data from the `launch2_event` lane                                                                                |
| `GET /v2/launch2/instances/{instanceId}/dynamic-pool`                            | optional `walletId`                                                                                      | 0153: the Hook is checked against its own Factory (`loopHook(launchId)`, `loopRouter()`, `routerRegistry()`), `router` = that Factory's LoopRouter; new 503 reasons `LAUNCH2_DYNAMIC_FACTORY_UNKNOWN` / `LAUNCH2_DYNAMIC_ROUTER_MISMATCH`. 0152: `buyFeeToken` (`usd1` / `meme` by Hook generation), `summary.buyFeesUsd1` next to `buyFeesMeme`. 0131: every instance answers `hookKind`; 0132: every dependency 503 after the registry read adds `detailsSafe.hookKind` (`officialTax` → `not_applicable`); LoopDynamic: bound Hook at one block — armed, round, candle, drop, pot, weights, fee rates, routing / timing, indexed summary; 0144: `maxDynamicFeeWad` / `maxDynamicFeeBps` (sell rate = min(drop, cap)), `currentDynamicTaxBps`, `roundCloseRule` (S193: close ≥ open closes, flat included); 0146: `currentRoundBuyers` (merged weight BuyCredited + CreditMoved in − out, attributions), `viewer.indexedCurrentRoundWeightUsd1` / `weightReconciled` (vs chain `buyWeight`) | `implemented` | `blocked-provider`; LoopDynamic default off (no LoopDynamic Factory / LoopRouter deployed); route + contract + integration tests only |
| `GET /v2/launch2/instances/{instanceId}/dynamic-pool/rewards`                    | `walletId` (required, caller's), `limit` ≤ 100                                                           | 0131: the wallet's rounds with weight (`open` / `claimable` / `claimed` / `no_reward`), projected claimable, totals; 0146: merged weight (`creditedUsd1` + `movedInUsd1` − `movedOutUsd1`), `credits[]` with `attribution` (`loopRouter` / `registryRouter` / `delivery` / `moved` / `unknown`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `implemented` | `blocked-provider`; LoopDynamic default off (no LoopDynamic Factory / LoopRouter deployed); route + contract + integration tests only |
| `POST /v2/launch2/instances/{instanceId}/dynamic-pool/claim/prepare`             | Write headers; `{walletId, roundId}`                                                                     | 0131: `201` `claim(roundId)` on the indexed Hook as a `dynamic_claim` intent (simulated first; round not closed / already claimed / nothing to claim refused)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `implemented` | `blocked-provider`; LoopDynamic default off (no LoopDynamic Factory / LoopRouter deployed); route + contract + integration tests only |
| `POST /v2/launch2/instances/{instanceId}/dynamic-pool/claim/report`              | Write headers; `{intentId, transactionHash}`                                                             | 0131: records the hash once (append-only); `submitted` → `confirmed` from the indexed `RewardClaimed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `implemented` | `blocked-provider`; LoopDynamic default off (no LoopDynamic Factory / LoopRouter deployed); route + contract + integration tests only |
| Snapshot publication (Decision 0118, S140): the worker lane                      |
| `launch2_snapshot_publisher` (`LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED`, default off; |
| migration 000063 `launch2_snapshot_publications`) builds the cutoff holder list  |
| from the `launch2_event` transfers, signs it with two registered snapshot signer |
| keys, and submits `publishSnapshot`; the instance detail adds                    |
| `snapshot.publication` and the console project detail                            |
| (`GET /admin/v1/launch/projects/{projectId}`) adds `snapshotPublications`.       |
| Evidence: `test/launch2-snapshot-publisher-anvil.integration.test.ts` (anvil     |
| chain 97); no BSC Testnet run (runtime `blocked-provider`: needs the signer keys |
| in the worker env and a Testnet instance past its sale end).                     |
| deploy); no BSC Testnet run. Frontend contract:                                  |
| `docs/frontend-v2-launch2-api.md`. S141 (Decision 0119): `nft_sale` ends at      |
| the instance's verified `ProjectNFT.saleEnd()` (`nftSale.endAt`,                 |
| `template.nftSaleSeconds` per instance; one hour on the BSC Testnet Factory),    |
| never a 7-day constant; anvil evidence with a 3,600 s Factory through            |
| `snapshot_pending`: `test/launch2-sale-duration-anvil.integration.test.ts`.      |

S142 (Decision 0120, migration 000064): new stage `closed_no_holders` (terminal;
the publisher records `launch2_snapshot_closures` when `ProjectNFT.totalMinted()`
is 0 at the confirmed cutoff and the indexer caught up), instance detail adds
`snapshot.closure`; quotes / prepares refuse it with `LAUNCH2_STAGE_MISMATCH`.
Operator retry grant `POST /admin/v1/launch/projects/{projectId}/snapshot/retry`
(append-only `launch2_snapshot_publication_releases`) unblocks a `failed` /
`mismatch` publication. Evidence: `test/launch2-creator-followups.integration.test.ts`,
`test/launch2-snapshot-publisher.test.ts`, `test/v2-launch2-routes.test.ts`; no BSC
Testnet run (runtime `blocked-provider`, same as the publisher lane).

S145 (Decision 0122, migration 000066): third Factory generation (S144 contracts:
no buyback price protection, zero-holder public opening). Instances carry
`factory_generation` (`v2` = pre-S144, `v3`); the lane decodes each executor with its
own ABI and keeps indexing read-only `LAUNCH2_LEGACY_FACTORIES`. A v3 sale with
`totalMinted() = 0` is opened by the publisher (`openPublicWithoutSnapshot()`,
`action = open_without_holders`) → stage `public`, detail `snapshot.status =
opened_without_holders` + `snapshot.openedWithoutHolders`; `closed_no_holders` is
deprecated (v2 instances only). Buyback items: `minMemeOut / referencePriceUsd1 /
spotPriceUsd1` nullable (v3); `live.nextOrderBlockedReason` redefined from
`quoteNextOrder().executable` (`BUYBACK_TOO_SOON`, `BUYBACK_PRINCIPAL_INSUFFICIENT`,
`BUYBACK_QUOTE_UNAVAILABLE`, `BUYBACK_LEGACY_PRICE_PROTECTION`; `BUYBACK_PROTECTION_BLOCKED`
retired). Evidence: `test/launch2-generation.test.ts`, `test/launch2-chain-generation.test.ts`,
`test/v2-launch2-routes.test.ts`, `test/launch2-creator-followups.integration.test.ts`,
anvil `launch2-buyback-keeper-anvil` (no price samples) and
`launch2-snapshot-publisher-anvil` (zero-holder opening); no BSC Testnet run.

S157 (Decision 0129, migration 000075): launch2 `409 INSUFFICIENT_BALANCE` refusals carry
`balanceUsd1` / `balanceMeme` next to the existing keys and `LAUNCH2_GAS_INSUFFICIENT` carries
`requiredBnb` / `balanceBnb`. The `launch2_event` lane marks the MEME transfer coverage complete
only after verifying the deploy-block mint and non-negative balances (else re-scan; three failures
stall it with an error log), and a log answer missing a deploy-block mint is
`LAUNCH2_RPC_LOGS_UNTRUSTED` (next endpoint, else the tick is unavailable). Evidence:
`test/launch2-indexer-worker.test.ts`, `test/launch2-chain-log-batches.test.ts`,
`test/launch2-meme-coverage.test.ts`, `test/mining-launch2-followups.integration.test.ts`.

S148 (Decision 0125, migration 000069): the `launch2_event` lane registers every
MEME whose `LaunchDeployed` it indexed in the Asset Registry (`public.assets`,
`chain_call` / `pending`, like `pnpm asset:register`; existing rows untouched),
retried each tick (instances deployed earlier are caught up without SQL), and
binds the community the project names (`launch_projects.community_id`, accepted on
`POST` / `PUT /v2/launch/projects`, owner-only, 422 `LAUNCH_COMMUNITY_NOT_OWNED`)
when it is unbound and still owned (outcome on the instance, shown to reviewers as
`project.community.binding`). The lane also indexes each MEME's ERC-20 `Transfer`
logs (one re-scan from the deploy block per instance) for post-graduation mining
balances. Evidence: `test/launch2-indexer-worker.test.ts`,
`test/mining-launch2-followups.integration.test.ts`; no BSC Testnet run.

| Route                                                   | Input                                                       | Output                                                                                                                   | Contract      | Runtime                                              |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------------- |
| `GET /v2/launch2/instances`                             | `stage`, `limit` ≤ 50 or signed `cursor`                    | Rows: stage + `nextChangeAt` (clock-derived), NFT sold, curve sold / reserve / price                                     | `implemented` | `blocked-provider`; needs the Testnet Factory + lane |
| `GET /v2/launch2/instances/{instanceId}`                | optional `walletId`                                         | Template, contracts, snapshot (verification, publication), graduation, buyback summary, 20 trades, viewer block          | `implemented` | `blocked-provider`                                   |
| `GET /v2/launch2/instances/{instanceId}/quote`          | `side`, `amount`, `walletId`, `slippageBps?`                | One-block quote with tax, `minOut`, `deadline`, executable `max` (quota / inventory / balance), quota, eligibility       | `implemented` | `blocked-provider`                                   |
| `POST /v2/launch2/instances/{instanceId}/nft/prepare`   | Write headers incl. `Idempotency-Key`; `{walletId}`         | `201` unsigned `mint()` (+ exact 100 USD1 approve); device signing exit                                                  | `implemented` | `blocked-provider`; needs `BSC_WRITES_ENABLED`       |
| `POST /v2/launch2/instances/{instanceId}/trade/prepare` | Write headers; `{walletId, side, amount, minOut, deadline}` | `201` unsigned `buy` (with Merkle proof in the priority hour) / `sell` (+ exact approve); `QUOTE_EXPIRED`, `PRICE_MOVED` | `implemented` | `blocked-provider`; needs `BSC_WRITES_ENABLED`       |
| `GET /v2/launch2/instances/{instanceId}/buybacks`       | `limit` ≤ 100 or signed `cursor`                            | Executed buybacks, ledger summary, live executor / escrow state with `nextOrderBlockedReason`                            | `implemented` | `blocked-provider`; rejected attempts leave no log   |
| `GET /v2/launch2/me/positions`                          | Bearer + headers                                            | Per instance × wallet: NFT minted / held, snapshot member, curve bought / sold / cumulative quota                        | `implemented` | `blocked-provider`                                   |

### V2 mining module (Decisions 0036, 0043, and 0046, `V2_MODULES_ENABLED=mining`)

The product formula (`miningFormulaV1-draft`) stays `pending_approval`. In
Development the self-describing baseline
`miningFormula-devBaseline-2026-09-21-r4` (`scope: development_baseline`, every
registered asset at weight 1, community range `[0.5, 2]`, placeholder daily
output `1000000`, BNB priced through a declared WBNB proxy — Decisions 0043,
0044 — and USDT priced by the declared stable rule `peg 1 ± 200 bps`,
Decision 0059) can be approved through the operator scripts, after which every read
publishes snapshot numbers labelled with that scope. Frontend contract:
`docs/frontend-v2-mining-api.md`. Decision 0057: a lane run that cannot value a
positive weighted holding is recorded as an `incomplete` attempt and never
published; every read keeps the last complete snapshot with `snapshot.stale`

- `snapshot.latestAttempt`, or answers `MINING_SNAPSHOT_INCOMPLETE` without
  one; a wallet no snapshot includes yet reads `MINING_SNAPSHOT_PENDING` (200,
  never 503). `pnpm mining:invalidate-snapshots` withdraws snapshots published
  by the old writer. Decision 0059: a formula version may declare a
  `referencePricing` rule per asset (`stable` peg + guard, or a named `pair`
  read by its own address); a price inverted out of a pair's quote side is
  published as `referencePriceQuality: "derived"` with
  `referencePricePairAddress`, and a derived price outside the declared band
  keeps the holding unread (`MINING_PRICE_PAIR_NOT_FOUND`) instead of falling
  back to the peg. Decision 0060: a pair DexScreener identifies by something
  other than an address (four.meme `{address}:4meme`, Uniswap V4 pool ids) is
  dropped from the token's pair fact and counted
  (`unrepresentablePairCount`) instead of making the whole token's price
  `MARKET_PROVIDER_RESPONSE_MALFORMED`; a lossy JSON number still refuses the
  whole response. Decision 0062 widens that to any value a single pair
  carries that cannot be represented exactly — the Provider's own digits in a
  non-canonical shape (`priceChange.h24: "3.725857251510287e+42"` on a dust
  BTCB pool), a count or a timestamp outside its documented form — so one
  pool never decides whether a token has a price. Decision 0061: an observed balance carries
  `wallet_balance_snapshots.source` (`chain | mock_seed`); the lane counts a
  `mock_seed` row only under `MINING_MOCK_HOLDINGS_ENABLED` (refused under
  `NODE_ENV=production`), and every snapshot publishes
  `snapshot.holdingsSource` (`chain | mock_seed | mixed`) so a demonstration
  number is labelled as one. The wallet pages read the chain and never see a
  seeded row.

| Method and path                            | Request                                                                       | Success projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Interface     | Capability                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /v2/mining/summary`                   | Bearer + headers                                                              | `power`, `networkPower`, `estimatedToday` (budget × share) from the latest complete snapshot under the version in force; `snapshot.stale` + `latestAttempt` (Decision 0057); `power` is `MINING_SNAPSHOT_PENDING` for a wallet no snapshot includes; `referralBoost` `MINING_REFERRAL_BOOST_PENDING`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `implemented` | `implemented` under an approved version (Development baseline); product numbers `blocked-product-legal` |
| `GET /v2/mining/assets`                    | Bearer + headers                                                              | `included` power rows (with `referencePriceQuality: fresh\|proxied\|derived` and `referencePricePairAddress`, Decision 0059) + `excluded` held assets with the reason the latest attempt recorded (`MINING_PRICE_PAIR_NOT_FOUND`, …) or re-derived, each with the registry `symbol`; `source.stale` + `latestAttempt`; `formula` as on the summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `implemented` | same; `503 CAPABILITY_UNAVAILABLE` when the Asset Registry cannot answer                                |
| `GET /v2/mining/rewards`                   | Bearer + headers                                                              | Legacy keys unchanged (`REWARD_AUTHORITY_PENDING`); additive `hourly` block (Decision 0116): settled / claimed / claimable raw LOOP, last settled hour + minute display, two tracks, five levels, parameters, claim state; 0144: `hourly.claim.configurationReasonCode` (configuration reason, never masked by ledger reasons)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `implemented` | rewards `blocked-product-legal`                                                                         |
| `GET /v2/mining/rank`                      | `scope=users\|communities\|referrals`, `cursor` or `limit` (1–50, default 30) | Paged ranking (keyset, ≤500 rows per cursor chain, Decision 0100) from the newest settled hour (Decision 0148: users by `nft_total_power + asset_total_power`; communities with a bound asset by the hour's power belonging to them — NFT self / referral power of their instances from any holder or inviter the community has not banned (S208: membership not required), bound-asset power from members only, `participants` = contributing accounts; `snapshot` = that hour in the snapshot shape, `computedAt = hourEnd`; `MINING_SNAPSHOT_NOT_AVAILABLE` before the first settled hour) or live `referral_edges` depth-1 in-force counts (referrals); `me {rank, value, communityId?}`, `nextCursor`, `myPosition`; name by anonymous mode only, alias rows carry `avatarRef` (S316 / Decision 0188: communities rows carry the optional `avatarRef` = community logo ref or null), `power` null for others when `mining_power_visibility=self` (Decision 0049; default `everyone` since Decision 0148); `snapshot.stale` + `latestAttempt`; `formula` as on the summary | `implemented` | same as summary; referrals does not wait for a snapshot                                                 |
| `GET /v2/mining/communities/{communityId}` | Bearer + headers                                                              | Weight record + members' power on the bound asset, caller's contribution, rank, participants; an unbound community's `weight` is `COMMUNITY_ASSET_NOT_BOUND` / `reviewStatus: not_applicable` (Decision 0046); `snapshot.stale` + `latestAttempt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `implemented` | needs a bound asset and an approved weight (`pnpm mining:community-weight`)                             |
| `GET /v2/mining/rules`                     | Bearer + headers                                                              | Approved + pending versions with `scope`, `assetWeights`, `dailyOutput`, community `range`; `baseline` in force                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `implemented` | `implemented`                                                                                           |
| `GET /v2/mining/referral/rules`            | Bearer + headers                                                              | Versioned five-level boost snapshot (moved from `community`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `implemented` | `implemented`                                                                                           |

### V2 mining hourly settlement and claims (Decision 0116, `V2_MODULES_ENABLED=mining`)

S157 (Decision 0129 §3): a failed hour is retried after 1, 2, 4, 8 … minutes (cap 60) from its
last failure (`attempt_count`, `updated_at`; no migration) and logged once per real attempt —
`warn`, `error` from the 10th consecutive failure. Evidence: `test/mining-hourly-runner.test.ts`.

Worker lane `mining_hourly_settlement` (`MINING_SETTLEMENT_ENABLED`, default off;
migration 000062) settles each completed UTC hour from the launch2 / MEME v1
read models under a reviewer-approved parameter version. Claims sign an EIP-712
`LoopRewardClaim` voucher (`MINING_REWARD_SIGNER_PRIVATE_KEY`,
`MINING_REWARD_CLAIM_ADDRESS`, launch slot, `BSC_WRITES_ENABLED`); the device
sends the transaction. Contract: `docs/frontend-v2-mining-rewards-api.md`;
console: `docs/frontend-admin-role-separation.md` §12.
Decision 0184: `MINING_EMBEDDED_WALLET_ONLY` (default `false`) narrows the
address attribution (and the snapshot balance inputs) to embedded wallets;
off, every active wallet counts. `input_summary.walletKinds` records
`embedded | all` per settled hour.

| Method and path                 | Request                                             | Success projection                                                                                                                                                        | Interface     | Capability                                                                                       |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `GET /v2/mining/rewards/epochs` | Bearer + headers; `cursor`                          | Caller's settled hours (both tracks' power, raw rewards), 24 per page                                                                                                     | `implemented` | `blocked-provider` until a parameter version is approved and the lane runs                       |
| `GET /v2/mining/claims`         | Bearer + headers; `cursor`                          | Caller's claims (`claimable` / `submitting` / `confirming` / `succeeded` / `failed` / `expired`)                                                                          | `implemented` | same                                                                                             |
| `POST /v2/mining/claim/prepare` | Write headers incl. `Idempotency-Key`; `{walletId}` | `201` voucher (`cumulativeAmount`, chain `nonce`, 10-min deadline) + unsigned `claim(...)` (eleven-key `unsignedTransaction`, `payloadDigest`, Decision 0123); gas branch | `implemented` | `blocked-provider`: needs the deployed `LoopRewardClaim` (S138-contracts), signer key, writes on |
| `POST /v2/mining/claim/report`  | Write headers; `{claimId, transactionHash}`         | Receipt + `Claimed` log → `submitting` / `confirming` / `succeeded` (ledger once) / `failed`                                                                              | `implemented` | same                                                                                             |

Console (`/admin/v1/mining/...`): `parameter-versions` (list / draft / approve /
withdraw), `epochs` (list / detail / replay), `funding`, `epochs/settle`
(test trigger only) — `implemented`.

Decision 0187 (S313): mining pool roster — every launch2 MEME bound by a
verified community takes part at token weight 1 / NFT coefficient 1 (parameter
document keys `assetWeights` / `communityCoefficients` override,
`excludedAssets` / `excludedCommunities` → 0) in the hourly settlement and in
the snapshot (pool part valued by the settlement rules on the launch chain:
MEME balance × token weight + NFTs × NFT coefficient, no new `/v2` key).

Decision 0189 (S316 / S317): the power list — external tokens (a verified community's
bound asset that is not a launch2 MEME) are roster rows too, out until the
parameter document's `includedAssets` lets them in (weight = `assetWeights`
entry, else 1). The list is the only rule for community weight / standing /
discover `sort=miningPower` / hourly community rank (hours settled before 0189
keep the 0187 projection) / snapshot factor (no formula `assetWeights` entry
needed); `community_mining_weights` is no longer read. Pool rows carry `kind`
(`platform` | `external`) and `settleable` / `settleableReasonCode`; query
`kind` filters. S317: a let-in external token that is a registered ERC-20 on a
chain with an `erc20_transfer` lane (BSC mainnet) is settled hourly — pinned
`wallet_balance_snapshots` opening reading + `indexed_transfers`, members only;
a holder whose balance cannot be reconstructed counts 0 with a reason in the
epoch summary; a stale lane leaves only the external assets out of the hour
(`MINING_SETTLEMENT_SOURCE_STALE`). The opening reading must belong to a
current holder's wallet row and be at most 7 days old; the wallet sync deletes
an address's `indexer_wallet_coverage` row once it is nobody's active wallet.
Migration 000103: a snapshot power row may be unpriced (`referencePriceUsd`
null, `referencePriceQuality: "unavailable"`, optional `referencePriceReasonCode`
on `GET /v2/mining/assets` `included[]`) — written only under the worker switch
`MINING_SNAPSHOT_UNPRICED_POWER_EMIT` (default false, client first; see
`docs/frontend-v2-mining-api.md` §0.0).

| Method and path             | Request                                                    | Success projection                                                                                                                                                                                                                      | Interface     | Capability                                                                                                             |
| --------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/v1/mining/pool` | session cookie; `address`, `q`, `kind`, `cursor` / `limit` | `inForce`, `pendingDraftVersion`, roster rows (`communityId`, `assetId`, `memeAddress`, `kind`, `symbol`, `participate`, `tokenWeight`, `nftCoefficient`, `source`, `settleable`, `settleableReasonCode`, `pendingDraft`), `nextCursor` | `implemented` | `implemented`; saved through `POST /admin/v1/mining/parameter-versions` (see `docs/frontend-admin-mining-pool-api.md`) |

Decision 0125 (S148): the S7 snapshot lane computes asset power as holding × weight
(no price); `GET /v2/mining/summary` / `assets` carry `assetPowerBasis: "quantity"`;
`/v2/mining/rules` projects `expressionKey = mining.rules.formula.holdingTimesWeight` and
marks `priceGuardRules` deprecated.

Decision 0125 (S148, migration 000069): `GET /v2/mining/rewards/epochs` leaves
out hours with zero power on both tracks and no reward (S138 D2);
`hourly.claim.executable` is false with `MINING_CLAIM_CONTRACT_PAUSED` while
`LoopRewardClaim.paused()` is true (`MINING_CLAIM_CHAIN_READ_FAILED` when the
contract cannot be read; S138 D3); `hourly.displayState` is
`awaiting_first_settlement` (with `lastHour` / `display` / `tracks` null and
`claim.reasonCode = MINING_NOTHING_SETTLED`) until the caller's own first settled
hour with power. After graduation a launch2 MEME stays in the asset pool with
ERC-20 balances from the `launch2_event` lane's indexed MEME `Transfer` logs
(`launch2_meme_transfers`), once the instance's transfer coverage is complete.

Decision 0123 (S147, migration 000067): the asset track is weighted by token
quantity (balance TWAB × Mining Weight, no price) for every version drafted from
now on (`document.assetPowerBasis = quantity`, enforced on insert / approval);
pre-0123 versions replay under their valuation rule. Unlisted communities count
`defaultCommunityCoefficient` (default 1.0). `GET /v2/mining/rewards`
`hourly.claim.executable` is false while parameters are pending
(`MINING_PARAMETERS_PENDING`), nothing is settled (`MINING_NOTHING_SETTLED`),
claimable is 0 / under the minimum, or a claim is in flight.

### V2 testnet faucet (Decision 0128, `TESTNET_FAUCET_ENABLED`, BSC Testnet only)

Not a `V2_MODULES_ENABLED` module: both routes are always registered and answer
503 with the `testnetFaucet` capability reason until `TESTNET_FAUCET_ENABLED=true`
on `LAUNCH_CHAIN_ID=97` (any other chain refuses boot) with an operator key
(`TESTNET_FAUCET_OPERATOR_PRIVATE_KEY`, falling back to `MEME_OPERATOR_PRIVATE_KEY`),
a USD1 (S156b: `TESTNET_FAUCET_USD1_ADDRESS`, else the Hooks Factory's `usd1()` —
the MEME v2 USD1 — else `LAUNCH_USD1_ADDRESS`), and `LAUNCH_BSC_RPC_URLS`. The API
signs a tBNB transfer and `MockUSD1.mint(address, amount)`; migration 000073 `testnet_faucet_grants`
holds the per-address cooldown. Contract: `docs/frontend-v2-testnet-faucet-api.md`.
S169 (Decision 0128 §9): pause-key reserve `TESTNET_FAUCET_OPERATOR_RESERVE_BNB`, global UTC-day
caps (503 `TESTNET_FAUCET_DAILY_LIMIT`), failed-retry cooldown (300 s, 5 failures per owner per
day → 429), estimated tBNB gas, and the worker lane `testnet_faucet_pending_sweep`
(`TESTNET_FAUCET_PENDING_TIMEOUT_SECONDS`).

| Method and path           | Request                                             | Success projection                                                                                                                                                                                                | Interface     | Capability                                                                                                  |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /v2/testnet/faucet`  | Bearer + headers; `walletId` (own embedded wallet)  | `bnbAmount`, `usd1Amount`, `cooldownSeconds`, `available`, `nextAvailableAt`, `lastGrant`                                                                                                                         | `implemented` | `implemented`; default `unavailable` (`TESTNET_FAUCET_DISABLED`)                                            |
| `POST /v2/testnet/faucet` | Write headers incl. `Idempotency-Key`; `{walletId}` | `201` `bnb` / `usd1` `{amount, transactionHash}`, `grantedAt`, `nextAvailableAt`; 429 cooldown (incl. S169 failed-retry), 503 `TESTNET_FAUCET_PARTIAL`, 503 operator low, 503 `TESTNET_FAUCET_DAILY_LIMIT` (S169) | `implemented` | `blocked-provider` until the staging operator account holds tBNB; no on-chain (anvil / testnet) run in S156 |

### V2 square timeline (Decision 0143, always registered)

Capability `squareFeed` (available with the database and `V2_CURSOR_HMAC_SECRET`; else
`unavailable` / `SQUARE_REPOSITORY_UNAVAILABLE`). Migration 000084 `square_posts` /
`square_post_likes`; the worker lane `square_feed_ingest` (`SQUARE_FEED_INGEST_ENABLED`,
default on, every 60 s) writes buy / claim / graduation posts. Console:
`/admin/v1/square/posts` (list, get, create, patch, publish, archive).

| Method and path                               | Request                                                              | Success projection                                                                                                                           | Interface     | Capability    |
| --------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| `GET /v2/square/feed`                         | Bearer + headers; `scope` global / following, `cursor`, `limit` ≤ 30 | `scope`, `items[]` (`postId`, `kind`, `author`, `text`, `token`, `event`, `likeCount`, `likedByViewer`, `pinned`, `createdAt`), `nextCursor` | `implemented` | `implemented` |
| `POST /v2/square/posts`                       | Write headers incl. `Idempotency-Key`; `{text, tokenRef?}`           | `201` `{post}` (replay `200`); 422 text / tokenRef, 429 five a minute                                                                        | `implemented` | `implemented` |
| `DELETE /v2/square/posts/{postId}`            | Write headers incl. `Idempotency-Key`                                | `204` (own opinion only)                                                                                                                     | `implemented` | `implemented` |
| `PUT / DELETE /v2/square/posts/{postId}/like` | Write headers incl. `Idempotency-Key`                                | `{postId, likeCount, likedByViewer}`                                                                                                         | `implemented` | `implemented` |

### V2 referral module (Decision 0036, `V2_MODULES_ENABLED=referral`)

| Method and path             | Request                                                | Success projection                                                                                                                                                                                                              | Interface     | Capability                                                                                                              |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/referral`          | Bearer + headers                                       | Invite code (issued on first read), `inviteLink` (`/i/{code}`), binding, level counts, `stats` (direct / valid / L2–5), boost; 0166: `inviteLink` / `stats` / available boost only with `REFERRAL_CENTER_EMIT=on` (default off) | `implemented` | `implemented`; boost available from the newest settled hour, else `MINING_REFERRAL_BOOST_PENDING` (Decision 0046, 0162) |
| `GET /v2/referral/invitees` | Bearer + headers; `limit` 1–50 or owner-bound `cursor` | Direct invitees (profile, `boundAt`, `validationStatus` pending/valid/invalid from the newest settled hour; profile null when they blocked the caller)                                                                          | `implemented` | `implemented` (Decision 0162); 503 `V2_CURSOR_NOT_CONFIGURED` without the cursor secret                                 |
| `POST /v2/referral/claim`   | Write headers; `{inviteCode}`                          | Binding (depth 1..5 edges materialised)                                                                                                                                                                                         | `implemented` | `implemented`; once, no self/cycle, no time limit after activation (Decision 0181)                                      |

### V2 chain module (Decision 0033, `V2_MODULES_ENABLED=chain`)

| Method and path            | Request                                    | Success projection                                                                                                                                                                                                                                                                         | Interface     | Capability                                                             |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------- |
| `GET /v2/chain/status`     | Bearer + contract/client headers; no input | Chain constants, RPC verification and head, per-endpoint health behind opaque refs plus a host-name `label` (Decision 0049), indexer lane, `launchChain` slot (Decision 0038); endpoint probe and unverified chain state reused ≤ 60 s, heads read live, all legs together (Decision 0088) | `implemented` | `blocked-provider`; needs a configured, chain-56-verified RPC endpoint |
| `GET /v2/assets/{assetId}` | Canonical CAIP `assetId` in the path       | Registry identity read from on-chain calls plus a non-swappable capability                                                                                                                                                                                                                 | `implemented` | `implemented`; `swappable` stays false until D15                       |

`symbol`, `name`, and `decimals` are only ever the values an on-chain
`symbol()`/`name()`/`decimals()` call returned, recorded with the observing
block. `pnpm asset:register <address>` performs that read itself; a `verified`
row additionally requires `BSC_USD1_TOKEN_ADDRESS` and `BSC_USD1_VERIFIED`.
`pnpm pool:register <address>` registers a PancakeSwap V3 pool only when both
of its tokens are already readable registry rows. RPC endpoint URLs are never
published: `GET /v2/chain/status` identifies each endpoint by an opaque,
non-reversible `endpointRef` and shows only its host name as `label`. With no configured endpoint the route is
`503 CAPABILITY_UNAVAILABLE`, never an all-null healthy document. Since
Decision 0038 the response carries an optional `launchChain`: absent while the
`launch` chain slot (`LAUNCH_CHAIN_ID`) equals the primary chain (the document
is then byte-identical to S5), otherwise the BSC testnet's own verification, head, confirmation policy, and reason code
(`LAUNCH_CHAIN_RPC_NOT_CONFIGURED` / `LAUNCH_CHAIN_VERIFICATION_PENDING` /
`LAUNCH_CHAIN_RPC_UNREACHABLE` / `LAUNCH_CHAIN_ID_MISMATCH`), still without any
endpoint URL. The primary slot alone gates the route; `bscRead` describes only
the primary chain.

Indexer lane reason codes (worker log and `pnpm indexer:backfill` output,
never an API field): `BSC_RPC_UNREACHABLE`, `BSC_CHAIN_ID_MISMATCH`,
`BSC_BLOCK_HASH_UNAVAILABLE`, `BSC_BLOCK_TIMESTAMP_UNAVAILABLE`, and since
Decision 0068 `BSC_LOG_QUERY_REJECTED` (every endpoint refused even a
single-address, single-block `eth_getLogs`) and
`BSC_LOG_QUERY_BUDGET_EXHAUSTED` (narrowing a segment would exceed 512
client-side reads, each one HTTP attempt per endpoint since Decision 0078);
since S82d (Decision 0079) `BSC_LOG_ARCHIVE_REQUIRED` with `behindBlocks`
(head − the refused segment's first block): the endpoint refused the range
as an archive read (publicnode `Archive requests require a personal token`,
403 / -32602; `History has been pruned for this block`, -32701; any
`archive` / `personal token` / `pruned` / `historical` text) — never narrowed,
learned limits untouched, exponential backoff like the other refusals, and
also reported by the `launch_event` lane; since
Decision 0075 `INDEXER_WALLET_SET_EMPTY` (no active `account_wallets`
row: the segment commits empty and the checkpoint advances) and
`BSC_LOG_WALLET_FILTER_INVALID` (malformed wallet filter or chunk size). A _shape_
refusal (HTTP 413, JSON-RPC -32602/-32005 typed or in a 4xx body, or
`limit exceeded` / `Request blocked` / `block range` / `more than` text,
from the endpoint whose error viem rethrows or any earlier endpoint in the
list) is narrowed along the dimension its text names, otherwise addresses
first, then the wallet topic array, then the block range (Decision 0078).
Token addresses are sent at most `BSC_LOG_ADDRESS_CHUNK_SIZE` (default 8)
per request; learned limits are kept on the client across ticks and shared
by the `erc20_transfer` and `pool_event` lanes. Since Decision 0079 a refusal
that names no dimension keeps the learned limits at or above their floors
(1 address, 100 wallets per topic array, 500 blocks; the read in flight may
go lower), limits are probed wider after 4 consecutive refusal-free segment
reads (a probe refused on the next read is rolled back and doubles the
streak, up to 32; a probe that holds restores 4), and
`BSC_LOG_LIMITS_RESET` (warn line `LOOP BSC log-query limits reset to their
configured values`, `detailReasonCode` `BSC_LOG_QUERY_BUDGET_EXHAUSTED` or
`BSC_LOG_QUERY_THROTTLED`, `previous*Limit` before and `learned*Limit`
after, numbers only) resets all three learned limits to the configured
starting values whenever a segment read runs out of budget, or a throttle
aborts a read while any learned limit is narrowed. A _throttle_ (HTTP 429, `rate limit` /
`too many` / `quota` / `usage limit` text, which is the only reading of
-32001) is not narrowed and goes to the retry loop's exponential backoff;
since Decision 0079 a throttle from any endpoint of the request wins over a
shape refusal from another endpoint.
A lane idling on either refusal code backs off 1 s → 30 s between ticks.
The retry-loop warn line and the once-per-transition `LOOP BSC indexer lane
is unavailable` / `recovered` lines carry `lane`, `errorClass`, `rpcStatus`, `rpcCode`,
`rpcUrlHost` (host name only), and `method`; on `BSC_RPC_UNREACHABLE` (from
the chain-verification probe) these are `null`. Since Decision 0079 they also
carry `learnedAddressLimit`, `learnedTopicGroupLimit`, `learnedRangeLimit`,
and `relaxAfterCleanReads` (integers).

### V2 wallet module (Decision 0033, `V2_MODULES_ENABLED=wallet`)

| Method and path                               | Request                                                    | Success projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Interface     | Capability                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/wallets`                             | Bearer + contract/client headers; no input                 | Opaque `walletId`, public `address`, `kind`, `status`, `isActive`; Privy inventory reused ≤ 60 s, re-read beside calls past 30 s (Decision 0086)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `implemented` | `blocked-provider`; needs Privy credentials                                                                                                        |
| `PUT /v2/wallets/active`                      | No `Idempotency-Key`; `{walletId, expectedActiveWalletId}` | Committed wallet list; concurrent switch is `VERSION_CONFLICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `implemented` | `implemented`; moves no funds and grants no signing authority                                                                                      |
| `POST /v2/wallets/sync`                       | No body / query / `Idempotency-Key`                        | Decision 0185: re-reads Privy now (bypasses the 60 s reuse), reconciles (≤ 3 active external wallets, `address_conflict` for an address another account holds, `unlinked` on unlink); same list as `GET /v2/wallets` plus optional `externalWalletLimit` / `wallets[].archivedReason` (on GET / PUT only with `WALLET_LINK_POLICY_EMIT=on`)                                                                                                                                                                                                                                                                                                                                                                                                                        | `implemented` | `blocked-provider`; needs Privy credentials                                                                                                        |
| `GET /v2/wallets/{walletId}/balances`         | Bearer + contract/client headers; no input                 | One snapshot block; display/available/spendable/gasReserve/pending, valuation (with `change24hPct`, Decision 0100), `netWorth.change24h {usd, pct}` or `null` + `PRICE_CHANGE_PARTIAL` from the same price read, Privy crossCheck; `launchChain` tBNB balance (Decision 0038) and, with `LAUNCH_USD1_ADDRESS`, optional `launchChain.usd1 {balance, allowance}` (Decision 0077/0088; since loop-api Decision 0088 the launch slot reads one head, then native, USD1 and the pinned allowance together); on a shared slot with the contract keys, optional root `launchUsd1 {balance, allowance}` (Decision 0081); 0165: the USD1 token is the Hooks Factory `usd1()` when a Factory is composed (env address only without one; Factory read failure → pair absent) | `implemented` | `blocked-provider`; needs a verified RPC endpoint                                                                                                  |
| `GET /v2/wallets/{walletId}/networth/history` | `range` = `1d` / `7d` / `30d` / `180d` / `360d` (required) | Decision 0145: hourly snapshots downsampled (1 h / 4 h / 1 d / 3 d / 7 d, ≤ 120 points), `current` valued live (falls back to the newest snapshot, `origin`), `change24h {usd, pct, baselineAt}` or `null`, `high` / `low`, `fiat {currency, rate, amount, source, asOf, fetchedAt, quality}` (Decision 0149: CNY at the latest `fiat_fx_rates` row, default ECB via Frankfurter; `quality` `fresh` ≤ 26 h) or `null`; 503 `WALLET_NETWORTH_HISTORY_UNAVAILABLE` / `WALLET_NETWORTH_CURRENT_UNAVAILABLE`                                                                                                                                                                                                                                                           | `implemented` | `implemented`; snapshots from the worker lane `wallet_networth_snapshot` (migration 000085); rates from the lane `fiat_fx_rate` (migration 000088) |
| `GET /v2/wallets/{walletId}/activity`         | `cursor` or `limit` (1–50), mutually exclusive             | Indexed ERC-20 transfers with tx/log/block/confirmations plus indexer freshness; the head read runs beside the database reads (Decision 0088). Decision 0167: with `WALLET_ACTIVITY_LAUNCH2_EMIT=on` (default off, needs app build ≥ 32) the wallet's MEME v2 facts on the Launch chain (curve / pool buy & sell incl. delivery attribution, NFT mint, reward claim, buyback received) are mixed in as `kind` rows with an optional `launch2` block and a time-ordered cursor; off is byte-identical                                                                                                                                                                                                                                                               | `implemented` | `blocked-provider`; `INDEXING_DELAYED` until the lane has a checkpoint                                                                             |
| `GET /v2/wallets/{walletId}/receive`          | Bearer + contract/client headers; no input                 | Address and EIP-681 request for BSC only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `implemented` | `implemented`                                                                                                                                      |

Privy stays authoritative for which wallets exist; LOOP only issues the opaque
`walletId` and remembers the active selection. A wallet Privy stops reporting
is archived, never deleted. A wallet address is published as a public on-chain
fact, but only `walletId` is ever accepted as an identifier. Balances always
emit one row per readable registry asset: a per-asset chain-call failure is
reported as an unavailable `balance`, never as a missing asset. Privy reports
no block, so a balance difference is `unaligned`, never `disputed`. The native gas
reserve subtracted from `spendableBalance` is configured by
`WALLET_GAS_RESERVE_BNB` and published as `walletGasReserveV1`. The RPC
multicall is the authoritative balance
source: Privy's own balance view is a cross-check whose `disputed` or
`unavailable` result never changes the published value. Valuation and net worth
come from the D11 market facts (Decision 0034): a token row is valued from
the DexScreener price of the asset itself when it is `fresh` or `stale`
(`quality` passed through), the native row is valued through WBNB
(`quality: proxied`, `proxyAsset` named), and `netWorth` is
`available` only when every row is valued, otherwise `partial` with
`unavailableCount`; both carry `valuationCurrency: USD` and `isSpendable:
false`. Native
transfers and cross-chain activity stay `unavailable` in this step. Nothing is
served from a stored balance snapshot when the chain is unreadable.

Latency (Decision 0063): the legs of the balances read that share no input run
together — the launch slot, the Privy balance view, and the per-asset prices are
all in flight while the chain read is — and every published amount still comes
from the one block the chain read observed. Per-asset prices are read four at a
time through the same single-token Provider endpoint and the same cache rows,
never the batch endpoint. A point read (head, balances) is given 2500 ms per RPC
endpoint before the next endpoint is tried; scans and estimates keep 6000 ms. A
launch slot that has not answered in 3000 ms is published as
`LAUNCH_CHAIN_RPC_UNREACHABLE` and never gates the primary balances. Decision
0082: every leg settles on its own — a launch-slot RPC timeout or HTTP failure
is `LAUNCH_CHAIN_RPC_UNREACHABLE` (an unclassified launch failure
`BSC_BALANCE_CALL_FAILED`), a failed USD1 pair leaves `usd1`/`launchUsd1`
absent, a failed price read leaves every row `MARKET_PROVIDER_UNREACHABLE`;
the primary block gets one hedged second read (started after 1500 ms without
an answer, or at once after a transport failure or an unanswered chain-id
probe; the first complete read wins) and only then fails as `503 CAPABILITY_UNAVAILABLE` with
`detailsSafe.reasonCode: BSC_RPC_UNREACHABLE`, never `500`. Any V2 read route
maps a stray `BscReadUnavailableError` or viem timeout/HTTP/socket failure to
`503 CAPABILITY_UNAVAILABLE` (`detailsSafe.reasonCode`), and every V2
`INTERNAL_ERROR` is logged at error level with the redacted cause. `GET
/v2/wallets` reuses one Privy inventory observation for 30 s and reports in
`source.observedAt` when Privy was actually read; the list itself is rebuilt
from the database every call, so an active-wallet switch is immediate.

### V2 market module (Decision 0034, `V2_MODULES_ENABLED=market`)

| Method and path                                                  | Request                                                                                                                                                 | Success projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Interface     | Capability                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/market/overview`                                        | Bearer + contract/client headers; no input                                                                                                              | Watchlist rows with price facts; trending registry assets by DexScreener 24h volume with `recommendationId`; `newPairs` card with `omittedCount` from the new-pairs fact (0053); every row carries `sparkline` — the last 24 hourly closes projected from the cache row the `market_sparkline_warm` worker lane keeps warm, never a Provider read on the request path (Decision 0074); the pairs batch and the new-pools read go out together under a 1.2 s deadline, past which a fact is read as from an unreachable Provider (Decision 0086)                                                                                                                                                                                                                                                             | `implemented` | `blocked-provider`; each fact carries its own source/quality; `newPairs` unavailable with the new-pairs page's reason when its fact cannot be read; `sparkline` is `MARKET_SPARKLINE_NOT_CACHED` until the lane has written the asset and `MARKET_PROVIDER_GECKOTERMINAL_DISABLED` without GeckoTerminal |
| `GET /v2/market/assets`                                          | `category=major\|meme\|community` (required), `sort=marketCap\|change24h\|volume24h`, `cursor` or `limit` (1–50, default 30)                            | Categorised list (Decision 0100): `major` static allow-list `marketMajorAssetIds` ∩ readable registry, `meme` Launch project tokens (`launches.project_asset_id`, testnet kept), `community` verified bound assets with `community`; rows `{assetId, symbol, name, logoUrl, quote\|null, quoteUnavailable?, sparkline, community?}`; every candidate (≤100) priced in one DexScreener batch under the 1.2 s deadline; Decision 0105: `meme` curve tokens cut to the top 100 of the requested sort in SQL, graduated/Launch tokens to the 100 most recent, pool `slot0` read once per page (multicall) and never a sort key; keyset cursor bound to caller/category/sort                                                                                                                                     | `implemented` | `blocked-provider` per row (`quote: null` + reason; `MARKET_CHAIN_NOT_PRICED` for testnet); `meme`/`community` without the candidate repository and any category without the cursor secret → `CAPABILITY_UNAVAILABLE`                                                                                    |
| `GET /v2/intel/promotions`                                       | Bearer + contract/client headers; no input                                                                                                              | Promotion cards in force: the operator console list (`intelPromotionsV1+db.<epoch ms>`, Decision 0102) when saved, else the shipped list (`intelPromotionsV1`, Decision 0100), `deeplink` restricted to `/intel`, `/square`, `/meme`, `/community/profile?id=`; `configVersion`, `effectiveAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `implemented` | `implemented`; registered with the `market` module                                                                                                                                                                                                                                                       |
| `GET /v2/market/assets/{assetId}`                                | Canonical `assetId`                                                                                                                                     | Registry identity, DexScreener facts from the deepest base pair, bound verified community, GoPlus fact list. An unregistered BSC address is resolved through GeckoTerminal → DexScreener (`asset.status: unregistered`, Decision 0058), quota-bound per user/IP/day (429). A registered asset with no usable DexScreener pair takes the same Provider top-pool facts, without the quota (Decision 0064). Top-level `range24h` (24h high / low, `bars`) from the same cached hourly candles as the overview sparkline (Decision 0074 §1b); pair facts, GoPlus, bound community and range are read together (Decision 0088)                                                                                                                                                                                   | `implemented` | `blocked-provider`; GoPlus needs credentials; unregistered lookup is `200` + unavailable when Providers are unreachable, `404` only on an affirmative "no such token", `503` without the quota secret                                                                                                    |
| `GET /v2/market/assets/{assetId}/candles`                        | `interval=15m\|1h\|4h\|1d\|1w`, `limit` 1–300                                                                                                           | GeckoTerminal OHLCV, else candles derived from indexed V3 swaps (`quality: derived`, labelled); native BNB through the WBNB pool (`quality: proxied`, `proxyAsset`); an asset with no registered pool — registered (Decision 0064) or not (Decision 0058) — through GeckoTerminal OHLCV of the lookup's top pool, published as `pool.origin: provider`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `implemented` | `blocked-provider`; derived path needs a registered pool and the pool lane; without GeckoTerminal, or when the Provider knows no pool either, the block is `MARKET_POOL_NOT_REGISTERED`                                                                                                                  |
| `GET /v2/market/assets/{assetId}/trades`                         | `cursor` or `limit` (1–50)                                                                                                                              | Indexed swaps with tx/log/block/timestamp/confirmations and direction relative to the asset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `implemented` | `blocked-provider`; unregistered pool or idle lane is `unavailable` — Provider pool trades are never published here (Decision 0064)                                                                                                                                                                      |
| `GET /v2/market/assets/{assetId}/holders`                        | Canonical `assetId`                                                                                                                                     | GoPlus holder count; distribution `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `implemented` | `blocked-provider`                                                                                                                                                                                                                                                                                       |
| `GET /v2/market/new-pairs`                                       | no input                                                                                                                                                | GeckoTerminal new pools when enabled, each keyed by `poolRef` (`address` or Uniswap V4 `poolId`, Decision 0052); risk screening `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `implemented` | `explicitly-disabled` by default until GeckoTerminal terms are verified; enabled on the Development stack only (Decision 0050)                                                                                                                                                                           |
| `GET /v2/market/smart-money`                                     | no input                                                                                                                                                | Always `unavailable` (`SMART_MONEY_RUNTIME_DEFERRED`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `implemented` | `explicitly-disabled` (D21)                                                                                                                                                                                                                                                                              |
| `GET /v2/market/logos/{chainId}/{file}`                          | Public: no auth, no LOOP headers; `eip155:56` (published) or `eip155:1` / `eip155:8453` (read only), `0x`+40 hex or `native`, `.png` (or `.webp` alias) | Logo proxy (Decisions 0089, 0161): picture chosen by the 0072 origin rules (BSC: cached DexScreener base-pair image, else Trust Wallet of the chain), fetched with a 5 s timeout, re-encoded to a 128 × 128 WebP and kept in `token_logo_cache` (7 d; `manual` rows never expire); 200 `image/webp` with `ETag` + `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`, 304 on `If-None-Match`, no 302 any more, 404 `NOT_FOUND` (no picture, > 4 MiB, undecodable; remembered 24 h), 502 `PROVIDER_UNREACHABLE` on timeout (not cached). Worker lane `token_logo_prewarm` (default on, every 6 h) pre-warms native + 34 mainstream + registry + watchlisted + base tokens of the GeckoTerminal top-200 BSC pools (≈ 90–100 after de-duplication); `pnpm token-logo:prewarm` runs one pass | `implemented` | `implemented`; upstream reachability is external (DexScreener CDN, raw.githubusercontent.com, GeckoTerminal from the API host)                                                                                                                                                                           |
| `GET / POST / DELETE /admin/v1/market/logos/{chainId}/{address}` | Admin session cookie; `console.read` (GET) / `console.write` (POST, DELETE); POST multipart `file` PNG/JPEG/WebP/GIF ≤ 2 MiB                            | Decision 0161 §3: cached row state; manual upload normalised to 128 × 128 WebP stored as `source = manual` (never refetched or overwritten); DELETE returns the token to the upstreams; each write audited (`market.logo.override` / `market.logo.override_clear`) in the same transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `implemented` | `implemented`; 422 `TOKEN_LOGO_UPLOAD_INVALID` + `logoReasonCode`, 404 `TOKEN_LOGO_NOT_CACHED` / `TOKEN_LOGO_OVERRIDE_NOT_FOUND`, 503 `TOKEN_LOGO_CACHE_UNAVAILABLE`; loop-admin page not built                                                                                                          |

Every market number is a canonical decimal string inside a fact object
`{value, source, fetchedAt, ttlSeconds, quality, reasonCode}`. Provider
responses are parsed losslessly (no JSON number becomes a JavaScript number),
throttled to the Provider's documented limit, cached in `market_fact_cache`
with the SHA-256 digest of the raw body, and served as `stale` only inside the
grace window when the Provider cannot be reached. A disabled Provider closes
its own facts and never borrows another source. Derived candles are aggregated
by the `pool_event` indexer lane (`pnpm indexer:backfill --lane pool_event`)
and priced in the pool's other token, never in USD.

A 24h change DexScreener skipped for a pool (it does so transiently, per
pool, for a minute or two) is published as `stale` from the value it last
reported for the same pair, with that observation's `fetchedAt` and
`reasonCode: MARKET_FACT_NOT_REPORTED`; outside the grace window it stays
`unavailable`. `MARKET_PAIR_UNREPRESENTABLE` names the case in which every
base pair the Provider reported was dropped as unrepresentable, which is not
"no pair" (Decision 0074). The `market_sparkline_warm` lane
(`MARKET_SPARKLINE_WARM_ENABLED`, default on; runs only with
`MARKET_PROVIDER_GECKOTERMINAL_ENABLED`) refreshes one asset per
`MARKET_SPARKLINE_WARM_INTERVAL_MS` tick under the worker's own
`MARKET_GECKOTERMINAL_BUDGET_WORKER` share and skips rows inside
`MARKET_SPARKLINE_TTL_SECONDS`.

Every asset row also carries a `logo` (Decisions 0072, 0089): the market
overview rows, the asset page, the new-pairs rows, wallet balance rows (and
the launch slot's native balance), watchlist items, mining
`included`/`excluded` rows, and asset search results
(`displaySnapshot.logo`, `null` for other domains).
`{status: "available", url, source: "dexscreener" | "trustwallet", observedAt}`
or `{status: "unavailable", reasonCode}`. Since Decision 0089 `url` is always
this API's own logo proxy,
`<PUBLIC_BASE_URL>/v2/market/logos/eip155:56/<lowercase address | native>.png`
(the upstream hosts are unreachable from mainland China); `source` /
`observedAt` still name the 0072 origin (`dexscreener`: the `info.imageUrl` of
the asset's own base pair inside the cached pair fact; `trustwallet`: the
Trust Wallet assets-repository rule). The client loads it and falls back to
its monogram on any non-200 without retrying. Reason codes:
`TOKEN_LOGO_ADDRESS_UNKNOWN` (pool row without a base token),
`TOKEN_LOGO_CHAIN_UNSUPPORTED` (any chain but BSC mainnet, e.g. the
launch-slot testnet), `TOKEN_LOGO_PROXY_UNAVAILABLE` (`market` module off, so
the proxy route does not exist).

The overview's DexScreener batch snapshots (`/tokens/v1`, one pair per token)
are cached under `tokenbatch:<address>` and never overwrite the per-token
`token:<address>` row (`/token-pairs/v1`, up to 30 pairs) that the asset page,
wallet prices, alerts and mining read (Decision 0089 §5, S93b).

### V2 notifications module (Decision 0034, `V2_MODULES_ENABLED=notifications`)

| Method and path                                | Request                                                         | Success projection                                                                       | Interface     | Capability                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /v2/alerts`                               | `cursor` or `limit` (1–50)                                      | V2 alerts keyed by `assetId` with `state` active/triggered/expired                       | `implemented` | `implemented`                                                                                          |
| `POST /v2/alerts`                              | `Idempotency-Key`; `{assetId, condition, threshold, expiresAt}` | `201` new / `200` replay; same key with another body is `IDEMPOTENCY_CONFLICT`           | `implemented` | `implemented`; unregistered asset is `VALIDATION_FAILED`                                               |
| `GET /v2/alerts/{alertId}`                     | —                                                               | One owned alert                                                                          | `implemented` | `implemented`                                                                                          |
| `PUT /v2/alerts/{alertId}`                     | No `Idempotency-Key`; `{expectedVersion, …definition}`          | Re-armed alert; stale version is `VERSION_CONFLICT`                                      | `implemented` | `implemented`                                                                                          |
| `DELETE /v2/alerts/{alertId}?expectedVersion=` | —                                                               | `204` without enumeration                                                                | `implemented` | `implemented`                                                                                          |
| `GET /v2/notifications/feed`                   | `cursor` or `limit` (1–50)                                      | Context notifications (`type`, `entityRef`, `contextRoute`, `payload`) plus unread count | `implemented` | `implemented`; `push` reports `available` or `unavailable` (`PUSH_RUNTIME_DEFERRED`) per Decision 0067 |
| `POST /v2/notifications/{notificationId}/read` | `Idempotency-Key`; no body                                      | The notification with its first `readAt`                                                 | `implemented` | `implemented`                                                                                          |
| `GET /v2/notifications/unread-count`           | — (no query, no body, no `Idempotency-Key`)                     | `{unread, observedAt}`; same rows as the feed's `unreadCount` (Decision 0177)            | `implemented` | `implemented`; one indexed count; fine inbox events counted only with `NOTIFICATION_INBOX_EMIT=on`     |
| `POST /v2/notifications/read-all`              | `Idempotency-Key`; no body                                      | `{marked}`; naturally idempotent (repeat → `0`) (Decision 0177)                          | `implemented` | `implemented`; marks only rows visible under `NOTIFICATION_INBOX_EMIT`                                 |
| `GET /v2/notification-preferences`             | —                                                               | Ten categories; `security.event` locked on                                               | `implemented` | `implemented`                                                                                          |
| `PUT /v2/notification-preferences`             | No `Idempotency-Key`; `{expectedVersion, categories}` (all ten) | Committed preferences; `security.event: false` is `INVALID_REQUEST`                      | `implemented` | `implemented`; an optional category off also suppresses that event's push (Decision 0067)              |

Decision 0177 (S286) adds four inbox producers: `launch.graduated` /
`launch.badge_minted` (written by the default-on `notification_inbox` worker
lane from the MEME v2 read model, categories `launch.graduation` /
`launch.round`) and `social.friend_request` / `social.friend_accepted`
(written inside the `/v1/friend-requests` transactions, category
`community.mention`). The rows are always written; `NOTIFICATION_INBOX_EMIT`
(default `off`) hides them from every read and from push until the clients
decode the new feed `type` values. No historical backfill.

Decision 0178 (S291) adds the project owner's launch progress events, all
category `launch.round`: `launch.review_approved` / `launch.review_rejected`
(written inside the Hooks review command transaction), `launch.deploy_failed`
(inside the executor's final `failed` transition) and `launch.activated`
(the `notification_inbox` lane, once per registered instance). Same
always-write rule, gated by their own switch `LAUNCH_REVIEW_INBOX_EMIT`
(default `off`, independent of `NOTIFICATION_INBOX_EMIT`). No backfill.

V2 alerts share `price_alert_definitions` with the frozen V1 rows but never
the namespace: V1 rows keep `asset_key` and stay `inactive`; V2 rows carry the
canonical `asset_id` and move `active → triggered` when the default-off
`alert_evaluator` worker lane (`ALERT_EVALUATOR_ENABLED`) observes a `fresh`
DexScreener price that satisfies the condition. A trigger records the
append-only event and one context notification per dedupe window
(`ALERT_NOTIFICATION_DEDUPE_SECONDS`) in a single transaction. When
`FIREBASE_SERVICE_ACCOUNT_JSON_PATH` is configured (Decision 0067) the same
trigger also pushes a pointer — `type`, `entityRef`, `contextRoute` only — to
the owner's registered devices, at most once per device per event, inside a
per-device hourly budget. The feed row is written first and stays the
authoritative record: a suppressed, rate-limited, or failed push changes
nothing the client reads.

### V2 wallet-intent, swap, and approvals modules (Decision 0035, `V2_MODULES_ENABLED=sendApprovals,swap`)

| Method and path                                       | Request                                                                                                    | Success projection                                                                                                              | Interface     | Capability                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v2/wallet-intents/send/preflight`              | Write headers, no `Idempotency-Key`; `{walletId, address, chainId?}`                                       | Checksummed recipient, `isContract`, `isFirstRecipient`, screening `unavailable`, warning keys                                  | `implemented` | `implemented`; GoPlus address screening `blocked-provider`                                                                                                                                                                                                                                                   |
| `POST /v2/wallet-intents/send`                        | `Idempotency-Key`; `{walletId, assetId, amount, recipientAddress}`                                         | Immutable send intent: review, `unsignedTransaction`, `reviewSha256`, `simulation`, `policy`, `expiresAt`                       | `implemented` | `implemented` on Development inside the canary (Decision 0065: assets, 5 USD per intent, 25 USD rolling day, counterparty allowlist); the `403` `detailsSafe.reasonCode` is an OpenAPI enum and the daily refusal carries `spentUsd`/`remainingUsd` (Decision 0071); `blocked-product-legal` everywhere else |
| `POST /v2/wallet-intents/approve`                     | `Idempotency-Key`; `{walletId, assetId, spenderAddress, allowance, acknowledgeUnlimited?}`                 | Approve intent with decoded `approve(spender, value)`; the ceiling prices `min(allowance, balance)`                             | `implemented` | same switch and canary as `send`; the spender walks the counterparty allowlist                                                                                                                                                                                                                               |
| `POST /v2/wallet-intents/revoke`                      | `Idempotency-Key`; `{walletId, assetId, spenderAddress}`                                                   | `approve(spender, 0)` intent                                                                                                    | `implemented` | same switch; a revoke removes exposure and is exempt from the counterparty allowlist                                                                                                                                                                                                                         |
| `POST /v2/wallet-intents/{intentId}/broadcast-report` | `Idempotency-Key`; `{txHash}`                                                                              | `submitted` after `eth_getTransactionByHash` matches the payload; mismatch is `VALIDATION_FAILED` and audited                   | `implemented` | open on Development; device broadcast still unverified (no funded wallet)                                                                                                                                                                                                                                    |
| `GET /v2/wallet-intents/{intentId}`                   | —                                                                                                          | State machine, hash, Provider action ID, reason code, receipt with confirmations                                                | `implemented` | `implemented`                                                                                                                                                                                                                                                                                                |
| `GET /v2/wallet-intents`                              | `cursor` or `limit` (1–50)                                                                                 | Newest-first intents                                                                                                            | `implemented` | `implemented`                                                                                                                                                                                                                                                                                                |
| `POST /v2/wallet-intents/{intentId}/cancel`           | `Idempotency-Key`; no body                                                                                 | `cancelled` for open intents; later states are `DATA_STALE`                                                                     | `implemented` | `implemented`                                                                                                                                                                                                                                                                                                |
| `POST /v2/swap/quote`                                 | Write headers, no `Idempotency-Key`; `{walletId, sourceAssetId, destinationAssetId, amount, slippageBps?}` | Privy quote snapshot with 30 s expiry, price impact decision, `swapPolicyV1`, canary value                                      | `implemented` | `blocked-provider`; observed 2026-09-22: Privy answers `403 Swaps are not enabled for this app`, published as `503 CAPABILITY_UNAVAILABLE` (Decision 0065); device evidence still pending                                                                                                                    |
| `POST /v2/wallet-intents/swap`                        | `Idempotency-Key`; `{walletId, quoteId, confirmPriceImpact?}`                                              | Swap intent with `authorizationPayload` the device signs; stays `prepared` (`SWAP_SIMULATION_PROVIDER_PENDING`)                 | `implemented` | `blocked-provider`; no Provider simulation, evidence pending                                                                                                                                                                                                                                                 |
| `POST /v2/wallet-intents/{intentId}/execute`          | `Idempotency-Key`; `{authorizationSignature}`                                                              | One `wallets.swap.execute`; `submitted` / `failed` / `unknown`; a second call is `SUBMISSION_UNKNOWN`                           | `implemented` | `blocked-provider`; never run locally                                                                                                                                                                                                                                                                        |
| `GET /v2/approvals?walletId=`                         | —                                                                                                          | Spenders from indexed `Approval` events with live `allowance()` reads at one block; `freshness.approvalCoverageFromBlockNumber` | `implemented` | `blocked-provider`; `INDEXING_DELAYED` until the transfer lane has a checkpoint **and** Approval coverage (`approval_coverage_from_block`, migration 000025) reaches the wallet's earliest indexed activity; `pnpm indexer:backfill --lane erc20_transfer --from <block>` lowers it                          |
| `GET /v2/approvals/{assetId}/{spender}?walletId=`     | —                                                                                                          | One live allowance                                                                                                              | `implemented` | `implemented`; GoPlus approval facts `unavailable`                                                                                                                                                                                                                                                           |

Every funds action is one immutable intent (`wallet_intents`): the canonical
payload and the public review are generated from one source and
`reviewSha256` is the digest the client re-checks before invoking the signer.
Two signing modes exist: send/approve/revoke are broadcast by the device
through Privy `eth_sendTransaction` on the server-built `unsignedTransaction`,
and swap is one server-side `wallets.swap.execute` authorized by the device's
signature over `authorizationPayload`. `BSC_WRITES_ENABLED` (default false)
keeps every prepare, report, quote, and execute at `CAPABILITY_UNAVAILABLE`;
enabling it is a canary bounded by `BSC_WRITE_CANARY_ASSETS`,
`BSC_WRITE_CANARY_MAX_USD` on a fresh Provider price, and — since Decision
0065 — `BSC_WRITE_CANARY_DAILY_MAX_USD` (rolling 24 h per account, counting
only the intents that may still spend; since Decision 0104 one window with
Launch and MEME Intents, re-checked under the owner lock at insert) and
`BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST` (empty = every counterparty admitted).
The switch is on for the Development stack only. Ambiguous Provider
results become `unknown` and are reconciled by the default-off
`wallet-intent-reconcile` worker lane, never replayed; a late device
broadcast on an expired or cancelled intent is accepted only when the chain
already shows the matching payload. Since Decision 0080 the same lane also
settles reported Launch purchase Intents (`launch_intents`, read on the launch
chain slot): a receipt at the slot's confirmation depth moves `submitted` to
`confirmed` (status 0x1, idempotent with the `launch_event` Purchased log) or
`reverted` (`LAUNCH_TX_REVERTED`); an unverified hash that is another
transaction becomes `failed` (`LAUNCH_TX_PAYLOAD_MISMATCH`); no receipt past
the deadline plus grace becomes `expired` (`LAUNCH_TX_NOT_OBSERVED`); without
a launch-slot RPC it stays `unavailable` (`LAUNCH_CHAIN_RPC_NOT_CONFIGURED`)
and moves nothing. No transaction has been broadcast or
executed: the 2026-09-22 Development run reached `409 INSUFFICIENT_BALANCE`
at the gas-reserve check because no Development wallet holds BNB.

### V2 watchlist module (Decision 0033, `V2_MODULES_ENABLED=watchlist`)

| Method and path     | Request                                           | Success projection                                           | Interface     | Capability                                              |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------ | ------------- | ------------------------------------------------------- |
| `GET /v2/watchlist` | Bearer + contract/client headers; no input        | Ordered groups of `assetId` with registry identity per asset | `implemented` | `implemented`                                           |
| `PUT /v2/watchlist` | No `Idempotency-Key`; `{expectedVersion, groups}` | Committed resource; stale version is `VERSION_CONFLICT`      | `implemented` | `implemented`; unknown `assetId` is `VALIDATION_FAILED` |

V1 and V2 are the same owner-bound resource and share
`watchlist_versions.record_version`. They differ only in asset identity: a V1
row stores `asset_key`, a V2 row stores the canonical lowercase CAIP
`asset_id`, and exactly one of the two columns is set per row. A V2 replacement
owns the whole owner-level snapshot, so it replaces legacy V1 rows rather than
merging two asset namespaces. A watchlist entry is a user preference and never
evidence that a market, price, or trading path exists.

### V2 communication module (Decision 0032, `V2_MODULES_ENABLED=communication`)

| Method and path                                         | Request                                                                        | Success projection                                                                                                                                                                  | Interface                                                                  | Capability                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/chat/token`                                   | Write headers incl. UUIDv4 `Idempotency-Key`                                   | `{apiKey, token, expiresAt, user:{id}}` in camelCase                                                                                                                                | `implemented`                                                              | `blocked-provider` without Stream credentials or the persistent quota                                                                                                                                                              |
| `POST /v2/video/token`                                  | Write headers                                                                  | Same shape, separate quota bucket                                                                                                                                                   | `implemented`                                                              | as above                                                                                                                                                                                                                           |
| `POST /v2/chat/groups`                                  | Write headers; `{name, friendPublicProfileIds}`                                | V2 projection of the V1 group operation; 202 + `Location` if pending                                                                                                                | `implemented`                                                              | `implemented`; friendship plus each friend's `groupInvites` gate (missing row = open, Decision 0070)                                                                                                                               |
| `POST /v2/chat/direct-channels`                         | Write headers; `{targetPublicProfileId}`                                       | V2 projection of the V1 direct operation; 202 + `Location` if pending                                                                                                               | `implemented`                                                              | `implemented`; friendship plus the target's `directMessages` gate (missing row = open, Decision 0070); the unordered pair converges on one CID                                                                                     |
| `GET /v2/chat/direct-channels`                          | Bearer + contract/client headers; `limit` 1–50 or `cursor`                     | `{items:[{streamCid, peer: connections `profile` shape                                                                                                                              | null, createdAt}], nextCursor}`; peer null = no presentable public profile | `implemented`                                                                                                                                                                                                                      | `implemented`; `direct_channels` is the authority, Stream is never read; no Stream user ID projected (Decision 0056) |
| `GET /v2/chat/operations/{operationId}`                 | Bearer + contract/client headers; no payload                                   | camelCase operation; `operatorRequired` is terminal and unresolved                                                                                                                  | `implemented`                                                              | `implemented`; unknown operation and wrong owner share one `NOT_FOUND`                                                                                                                                                             |
| `DELETE /v2/chat/groups/{groupId}/membership`           | Write headers; no payload                                                      | `{groupId, membership: null}`                                                                                                                                                       | `implemented`                                                              | `implemented`; the Stream removal precedes the LOOP commit                                                                                                                                                                         |
| `PATCH /v2/chat/groups/{groupId}`                       | Write headers; `{name}` (1–60 code points, creation rule)                      | `{groupId, name, nameVersion, updatedAt}`                                                                                                                                           | `implemented`                                                              | `implemented` (Decision 0098); creator only (`PERMISSION_DENIED`), non-member/unknown/inactive `NOT_FOUND`; same name = no-op 200; audited `group_renamed`; Stream channel `name` set after the commit, failure logged only        |
| `POST /v2/communities/{communityId}/voice-rooms`        | Write headers; optional `{title}` (Decision 0098)                              | `201` room resource with the creator as host                                                                                                                                        | `implemented`                                                              | `implemented`; owner or admin only; one live room per community; create then `go_live`, `backstage: false` when provisioned, else `reconciling` (0054); optional `title` 1–40 code points, blank = none (0098)                     |
| `GET /v2/communities/{communityId}/voice-rooms/current` | Bearer + contract/client headers                                               | The live room, or `null` with `COMMUNITY_VOICE_ROOM_NOT_LIVE`                                                                                                                       | `implemented`                                                              | `implemented`; `observed.participantCount` (live session) vs `memberCount` (authorized), own `observedAt` (0051); heals a backstage room once (0054)                                                                               |
| `GET /v2/voice-rooms/{voiceRoomId}`                     | Bearer + contract/client headers                                               | Room incl. `communityName` (0052), top-level `host` by display rule (0098), viewer role, viewer hand raise, `joinedCount` incl. host                                                | `implemented`                                                              | `implemented`; non-members are `PERMISSION_DENIED`; heals a backstage room once, read still answers on failure with `providerSync` unconfirmed (0054)                                                                              |
| `GET /v2/voice-rooms/{voiceRoomId}/hand-raises`         | Bearer + contract/client headers                                               | Pending queue in sequence order; `sequence` is a decimal string; entries carry the roster identity projection (`publicProfileId`/`display`/`isSelf`/`commands`, 0053), no `profile` | `implemented`                                                              | `implemented`; the order is a PostgreSQL fact, not a client guess; anonymous raisers unaddressable to non-hosts                                                                                                                    |
| `POST /v2/voice-rooms/{voiceRoomId}/join`               | Write headers; no payload                                                      | Room resource with the caller's role, `expiresAt`, counts observed after the Stream write                                                                                           | `implemented`                                                              | `implemented`; idempotent, re-join refreshes `joinedAt`; unprovisioned room or call still in backstage is `CAPABILITY_UNAVAILABLE` (`VOICE_ROOM_BACKSTAGE_NOT_LIVE`)                                                               |
| `POST /v2/voice-rooms/{voiceRoomId}/leave`              | Write headers; no payload                                                      | Room resource with `viewer.role: null`, counts observed after the Stream write                                                                                                      | `implemented`                                                              | `implemented`; the host must end the room instead; a no-op 200 for an account not in the live room (0069)                                                                                                                          |
| `POST\|DELETE /v2/voice-rooms/{voiceRoomId}/hand-raise` | Write headers; no payload                                                      | Room resource with the viewer's hand raise; `providerSync` reports the one custom call event                                                                                        | `implemented`                                                              | `implemented`; one pending raise per account; a second raise is `DATA_STALE`; sends `loop_event_kind: voiceRoomHandRaise` on the call as the host (0069)                                                                           |
| `GET /v2/voice-rooms/{voiceRoomId}/members`             | Bearer + contract/client headers; `role` required, `cursor`/`limit` exclusive  | LOOP joined roster of one role view with leaderboard display rule, `avatarRef` (null when anonymous, 0098), `handRaised`, `muted`, `commands[]` (0052/0053)                         | `implemented`                                                              | `implemented`; authorization roster, never Stream presence; anonymous rows unaddressable to non-hosts; non-host gets only `unmute_self` on its own muted speaker row                                                               |
| `GET /v2/voice-rooms/live`                              | Bearer + contract/client headers; `cursor`/`limit` (≤50, default 20) exclusive | Live, provisioned, non-backstage rooms across visible communities, newest `startedAt` first; `joinable`, host by display rule, LOOP role counts, `countsObservedAt: null` (0093)    | `implemented`                                                              | `implemented`; never calls Stream; `title` (null when untitled) and `speakersPreview` (host first + ≤3 joined speakers, anonymous = three nulls; 0098); unavailable runtime / repository / cursor codec → `CAPABILITY_UNAVAILABLE` |
| `POST\|DELETE /v2/voice-rooms/{id}/speakers/{pid}`      | Write headers; no payload                                                      | Room resource plus `providerSync`                                                                                                                                                   | `implemented`                                                              | `implemented`; host-only; grants or revokes Stream `send-audio`; clears the mute intent                                                                                                                                            |
| `DELETE /v2/voice-rooms/{voiceRoomId}/speakers/me`      | Write headers; no payload                                                      | Room resource with `viewer.role: listener` plus `providerSync`                                                                                                                      | `implemented`                                                              | `implemented` (Decision 0098); speaker self step-down, LOOP commit then Stream `send-audio` revoke; host `PERMISSION_DENIED`; non-speaker 200 no-op; ended `DATA_STALE`; audited `speaker_stepped_down`                            |
| `POST /v2/voice-rooms/{id}/speakers/{pid}/mute`         | Write headers; no payload                                                      | Room resource plus `providerSync`                                                                                                                                                   | `implemented`                                                              | `implemented`; host-only; LOOP mute intent then one Stream `muteUsers` for that member (0052)                                                                                                                                      |
| `DELETE /v2/voice-rooms/{id}/speakers/{pid}/mute`       | Write headers; no payload                                                      | Room resource; `providerSync` always confirmed (no Stream write)                                                                                                                    | `implemented`                                                              | `implemented`; the muted speaker itself or the host (0053); clears `muted_at`, audits `speaker_unmuted`; unmuted/listener target `DATA_STALE`                                                                                      |
| `POST /v2/voice-rooms/{voiceRoomId}/mute-all`           | Write headers; no payload                                                      | Room resource plus `providerSync`                                                                                                                                                   | `implemented`                                                              | `implemented`; host-only; sets the mute intent on every joined speaker                                                                                                                                                             |
| `POST /v2/voice-rooms/{voiceRoomId}/end`                | Write headers; no payload                                                      | Ended room; every later write is `DATA_STALE`                                                                                                                                       | `implemented`                                                              | `implemented`; host-only                                                                                                                                                                                                           |

Abandoned rooms are ended by the default-on `voice_room_reaper` worker lane
(Decision 0094; `VOICE_ROOM_REAPER_ENABLED`, `VOICE_ROOM_REAPER_INTERVAL_MS`
default 60 000, needs the Stream pair): at most 50 live rooms per pass; a room
live for `VOICE_ROOM_MAX_LIVE_HOURS` (default 12) is ended regardless of who is
in it (log `VOICE_ROOM_MAX_AGE_ENDED`); a room with no joined speaker or
listener, no LOOP change for `VOICE_ROOM_IDLE_END_MINUTES` (default 10), and a
Stream session confirmed at zero devices is ended (log
`VOICE_ROOM_IDLE_ENDED`). The end is the host-end path without an actor: LOOP
first (audit `room_ended`, null actor, reason `voice_room_*_ended`), then one
Stream end; an unconfirmed Stream end logs `STREAM_CALL_END_UNCONFIRMED` and is
not retried. A reaped room reads exactly like a host-ended one.

Accepting a friend request (`POST /v1/friend-requests/{id}/decision`) or
a message request (`POST /v2/message-requests/{id}/decision`, `accept`)
enqueues the pair in `friend_direct_channel_jobs` inside the accept transaction
(Decision 0172, migration 000095). The default-on `friend_direct_channel`
worker lane (`FRIEND_DIRECT_CHANNEL_ENABLED`, `FRIEND_DIRECT_CHANNEL_INTERVAL_MS`
default 5 000, needs the Stream pair) runs the same idempotent
`direct_get_or_create` chat operation as `POST /v2/chat/direct-channels`
(accepter first, then the other direction), so the pair's channel exists even
when the App never calls the route; the App's own call converges on the same
CID. Refusals (no friendship, `directMessages` closed both ways) are skipped,
never failing the accept. `FRIEND_CHANNEL_BACKFILL_ENABLED` (default off)
enqueues up to 200 earlier friendship pairs with no direct channel per pass. No
route, schema or response key changes.

`GET /v2/communities/{communityId}` (the `community` module) additionally
carries `chat: {status, channelCid, memberState, reasonCode}` and
`voice: {status, currentRoomId, reasonCode}`. `chat.status` is
`available | syncing | unavailable` (revision, 2026-09-08): `available` only
when the official Stream channel is provisioned **and** the viewer's channel
member state is `synced`, `syncing` while the allocated channel or the viewer's
membership is still on its way to Stream, and `unavailable` when nothing is in
flight. A LOOP membership never implies a Stream channel membership.

The official channel is created when a community becomes `verified`. Its
membership is synchronized by the transactional outbox
`community_channel_sync_jobs`, executed after commit by the default-off
`community-channel-sync` worker lane (`COMMUNITY_CHANNEL_SYNC_ENABLED`, which
requires the complete Stream credential pair). Join enqueues `add`; leave and
ban enqueue `remove`; an unban restores the membership and enqueues `add`
(revision, 2026-09-08). Each provider call is attempted
exactly once per lease, an unknown result becomes `reconciling` with a bounded
backoff, and the channel member cap
(`V2_COMMUNITY_CHANNEL_MEMBER_CAP`, default 3000) parks a member as
`capacityPending` without touching its LOOP membership.

Every `synced` member of an official channel carries a community persona
(Decision 0055): one server-generated, immutable, community-unique
`<Word>-<4 digits>` name per (community, account), stored in
`community_channel_personas` and projected to the Stream channel member as
`custom.loop_group_alias` / `loop_group_alias_id` / `loop_group_alias_version`
(the Decision 0024 shape). The `add` sync job attaches it on `add_members`; a
persona lane in the same worker re-projects `pending` personas of `synced`
members with `updateMemberPartial` under bounded backoff; a `remove` resets the
projection. Every bookkeeping write is fenced by a projection lease
(migration 000032), so the add path, the lane, a second replica, and the
backfill never overwrite each other's outcome. The client draws only
`member.custom.loop_group_alias` (fallback "成员"), never `user.name`/`user.id`.
Members synced before this decision are backfilled with
`pnpm community:persona-backfill --confirm [--max N]` (dev only; needs
`DATABASE_URL`, `STREAM_API_KEY`, `STREAM_API_SECRET`; idempotent; the worker
may keep running; exit 1 while any projection is still pending or `--max`
stopped the run early).

`POST /v2/communities/{communityId}/voice-rooms` is the only product path
that opens a room; the mobile app carries no control for it yet, so on the
Development stack `pnpm voice-room:open <communityId> --confirm` (Decision 0050) runs the same `VoiceRoomService.createRoom` as the community owner. It
refuses `NODE_ENV=production`, reports the route's own error codes
(`RESOURCE_CONFLICT` while a live room exists), and never reports an
unconfirmed Stream call as provisioned.

Chat search, message forwarding, long-image merging, and Community AI add no
LOOP endpoint: the first two are client-side Stream SDK calls and the last is
`unavailable` (`COMMUNITY_AI_RUNTIME_DEFERRED`). Chat content never enters
`GET /v2/search`. End-to-end encryption is not claimed anywhere.

### V2 security, settings, and support modules (Decision 0037, `V2_MODULES_ENABLED=security,settings,support`)

| Method and path                       | Request                                                                                           | Success projection                                                                                                                                                                                                                                               | Interface     | Capability                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/devices`                     | Bearer + contract/client headers; optional `X-Loop-Session-ID`                                    | Owner's device sessions (newest first, ≤100), `sessionShortId`, `isCurrent`, `isCurrentDevice` (Decision 0049), `riskSignals` (≥2 new sessions in 24h), `revokeAll` unavailable                                                                                  | `implemented` | `implemented`; `lastSeenAt` is the bootstrap time                                                                                                                       |
| `POST /v2/devices/{sessionId}/revoke` | Logout header set incl. `Idempotency-Key`, `X-Loop-Session-ID`; no body                           | `{session: {sessionId, status: revoked, revokedAt}}`; durable `revoke` command                                                                                                                                                                                   | `implemented` | `implemented`; own session → `AUTH_STEP_UP_REQUIRED` (MFA not connected)                                                                                                |
| `POST /v2/devices/push-token`         | Logout header set incl. `Idempotency-Key`, `X-Loop-Session-ID`; `{platform, token, appVersion}`   | `{registered: true, pushTokenId, platform, provider: fcm, appVersion, observedAt}`; the registration token is never echoed                                                                                                                                       | `implemented` | `implemented` (Decision 0067); refused `CAPABILITY_UNAVAILABLE`/`PUSH_RUNTIME_DEFERRED` without a Firebase credential; revoked or foreign session → `SESSION_NOT_FOUND` |
| `DELETE /v2/devices/push-token`       | Same header set; no body                                                                          | `{registered: false, revokedAt, observedAt}`; `revokedAt: null` when the session had none                                                                                                                                                                        | `implemented` | `implemented` (Decision 0067); always available, including while push delivery is not                                                                                   |
| `POST /v2/devices/revoke-all`         | Same header set; no body                                                                          | Always `403 AUTH_STEP_UP_REQUIRED`; nothing persisted                                                                                                                                                                                                            | `implemented` | `blocked-provider`; needs Privy MFA evidence                                                                                                                            |
| `GET /v2/security/capabilities`       | Bearer + contract/client headers; optional `projection` (`pendingOnly` default / `current`, 0129) | Six items (`mfa`, `passkey`, `recoveryPassword`, `autoRecovery`, `socialRecovery`, `keyExport`); default all `unavailable` + evidence; 0129 `current`: `mfa` / `autoRecovery` `available` (confirmed), `passkey` available while the RP association is published | `implemented` | `implemented` (`current`); default `PRIVY_<X>_EVIDENCE_PENDING` kept for the 2825f1d codec                                                                              |
| `GET /v2/security/summary`            | Bearer + contract/client headers                                                                  | Devices block, approvals summary of the active wallet, locked `security.event`, last 10 security notifications; no score                                                                                                                                         | `implemented` | `implemented`; approvals block `unavailable` without `sendApprovals` runtime/RPC/indexer                                                                                |
| `GET /v2/settings`                    | Bearer + contract/client headers                                                                  | `{settings: {displayCurrency: USD, language: zh-CN}, version, updatedAt, policy}`; version 0 without a write                                                                                                                                                     | `implemented` | `implemented`                                                                                                                                                           |
| `PUT /v2/settings`                    | Same headers, no `Idempotency-Key`; `{expectedVersion, settings}`                                 | Committed resource; CAS on `expectedVersion`; non-fixed value is `VALIDATION_FAILED`                                                                                                                                                                             | `implemented` | `implemented`; both values are product constants in this step                                                                                                           |
| `POST /v2/support/tickets`            | Command headers incl. `Idempotency-Key`; `{category, body ≤2000 code points}`                     | `201` ticket envelope (`200` on exact replay); events, `attachments` unavailable, `policy`                                                                                                                                                                       | `implemented` | `implemented`; 20 tickets per owner per 24h; attachments `explicitly-disabled`                                                                                          |
| `GET /v2/support/tickets`             | `cursor` or `limit` (1–50)                                                                        | Newest-first tickets with lifecycle events                                                                                                                                                                                                                       | `implemented` | `implemented`; status advances only via `pnpm support:answer`                                                                                                           |
| `GET /v2/meta/about`                  | Public; no input                                                                                  | `contractVersion`, every published `configVersion` (`bscWriteCanary` only while BSC writes are enabled, `clientPolicy` only when it differs from `productPolicy`, Decision 0049), `termsGate`, open-source attribution summary, `clientBuild: local`             | `implemented` | `implemented`; terms document URLs are not published                                                                                                                    |

### Operator console management surface (Decision 0102, `/admin/v1`)

Mounted only when `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and
`ADMIN_SESSION_SECRET` are all set (else `/admin/*` is the ordinary 404).
Authentication is the signed `loop_admin_session` cookie (HttpOnly,
SameSite=Strict, 12 h); no Privy Bearer, no contract header, no
Idempotency-Key. Errors use the V2 seven-field envelope with the console
codes `ADMIN_SESSION_REQUIRED`, `ADMIN_LOGIN_INVALID`, `ADMIN_LOGIN_LOCKED`
(423), `ADMIN_LOGIN_BUSY` (429, Decision 0105), `ADMIN_CONFLICT`. Every write
appends `admin_audit_log` rows; writes with an external effect (community
review, MEME pause/unpause) append the intent row first and refuse with 503
`ADMIN_AUDIT_UNAVAILABLE` when it cannot be written (Decision 0105).
Frontend contract: `docs/admin-v1-api.md`.

Decision 0109 (S128) adds individual console accounts with one fixed role
each (`platform_admin`, `reviewer`, `testnet_acceptor`, `auditor`) and a
server-side permission check on **every** route above (403
`PERMISSION_DENIED`, before the body is parsed): reads need `console.read`,
writes `console.write`, `GET /audit` needs `audit.read`. The
`ADMIN_USERNAME` bootstrap administrator is a `platform_admin` and can
neither approve nor accept. Frontend contract for the new surface:
`docs/frontend-admin-role-separation.md`.

Decision 0110 (S129): mining formula approval moves to `formula.approve`
(reviewer only; platform_admin keeps drafting / withdrawing), the approver
must not be the draft's author (migration `000056_formula_draft_author`),
and the login lock is per username and per client IP in
`admin_login_attempts` (migration `000057`, shared by every instance).
Contract changes: `docs/frontend-admin-role-separation.md` §9.

Decision 0111 (S130): `POST /admin/v1/accounts/{id}/unlock` clears an
account's login-name lock (not the address buckets); account objects carry
read-only `locked` / `lockedUntil`; formula approval also needs the
reviewer's ops operator enabled (`ADMIN_OPERATOR_DISABLED`), so disabling
the account (which disables the operator in the same transaction) stops
both reviews; the `pnpm mining:approve-formula` CLI records `cli:<name>`
(migration `000058_admin_followups`). Contract changes:
`docs/frontend-admin-role-separation.md` §10.

| Route                                                               | Input                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Interface     | Capability                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /admin/v1/session`                                            | `{username, password}`                                                                               | session + `Set-Cookie`; Decision 0110: lock per username (5 in a row → 423 `scope: username`, 15 min) and per client IP (50 in 15 min → 423 `scope: ip`), shared in `admin_login_attempts`; one verification at a time per instance (else 429)                                                                                                                                                                                                                                                          | `implemented` | `implemented` when `ADMIN_*` set                                                                                |
| `GET /admin/v1/session`, `DELETE /admin/v1/session`                 | cookie                                                                                               | current session / logout (204, cookie cleared)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `implemented` | `implemented`                                                                                                   |
| `GET /admin/v1/overview`                                            | cookie                                                                                               | accounts, communities by status, pending reviews, live voice rooms, MEME by status, lanes, 20 audit rows                                                                                                                                                                                                                                                                                                                                                                                                | `implemented` | `implemented`; 503 without database                                                                             |
| `GET/PUT /admin/v1/settings/recommended-communities`                | `{communityIds\|null, updatedAt}`                                                                    | list in force + source; CAS 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `implemented` | `implemented`                                                                                                   |
| `GET/PUT /admin/v1/settings/intel-promotions`                       | `{items\|null, updatedAt}`                                                                           | cards + source + configVersion + `imageHosts`; Decision 0100 validation + no control/format characters, `imageUrl` ≤ 512 on an `INTEL_PROMOTION_IMAGE_HOSTS` host (Decision 0105)                                                                                                                                                                                                                                                                                                                       | `implemented` | `implemented`                                                                                                   |
| `GET /admin/v1/communities`, `GET /admin/v1/communities/{id}`       | `status`, `q`, signed cursor                                                                         | community rows / row + review notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `implemented` | `implemented`                                                                                                   |
| `POST /admin/v1/communities/{id}/review`                            | `{decision, reasonCode, reasonText}`                                                                 | Decision 0073 review + note; audit `community.review.requested` → `.decided`/`.failed`                                                                                                                                                                                                                                                                                                                                                                                                                  | `implemented` | `implemented`; 503 without the community repository                                                             |
| `PUT /admin/v1/communities/{id}/label` (0175)                       | `{label: string \| null}` (trim; empty/null clears; 1–12 chars)                                      | `{community, changed, audit \| null}`; audit `community.label.update` (before/after) only when the value changes                                                                                                                                                                                                                                                                                                                                                                                        | `implemented` | `implemented`; `console.write`; 422 `ADMIN_COMMUNITY_LABEL_TOO_LONG`; 404 `ADMIN_COMMUNITY_NOT_FOUND`           |
| `GET/POST /admin/v1/mining/formula-versions` (deprecated, 0187)     | draft `{configVersion, baseVersion, parameters}`                                                     | versions with editable parameters + `draftAuthor` / `approvedBy` (0110) / `pending_approval` draft; GET: `console.read` or `formula.approve`                                                                                                                                                                                                                                                                                                                                                            | `implemented` | `implemented`                                                                                                   |
| `POST /admin/v1/mining/formula-versions/{v}/approve`, `/withdraw`   | —                                                                                                    | version in force switched (weights applied) / draft retired; Decision 0110: approve = reviewer only (`formula.approve`), approver ≠ draft author (403 `ADMIN_FORMULA_SELF_APPROVAL`), unknown author 409; audit `.requested` → `mining.formula.approve` / `.failed`                                                                                                                                                                                                                                     | `implemented` | approve `blocked-product-legal` under `NODE_ENV=production` (`MINING_APPROVE_FORBIDDEN_IN_PRODUCTION`)          |
| `GET /admin/v1/meme/tokens`                                         | `status`, `listing`, `q`, signed cursor                                                              | every token + `pause` availability                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `implemented` | `implemented`                                                                                                   |
| `POST /admin/v1/meme/tokens/{id}/listing`                           | `{listing, reasonCode, reasonText}`                                                                  | listed / hidden (leaves `/v2` lists at once)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `implemented` | `implemented`                                                                                                   |
| `POST /admin/v1/meme/tokens/{id}/pause`, `/unpause`                 | `{reasonCode, reasonText}`                                                                           | 202 `submitted` + tx hash (testnet operator key); 409 `MEME_PAUSE_PENDING` while one is unmined; audit `meme.<action>.requested` → `.submitted`/`.failed`                                                                                                                                                                                                                                                                                                                                               | `implemented` | `blocked-provider` until `MEME_OPERATOR_PRIVATE_KEY` (curve owner, Decision 0105) + MEME contract + testnet RPC |
| `GET /admin/v1/launch2/instances`                                   | `listing` (`visible`/`hidden`), `q`                                                                  | Decision 0163: every launch2 instance with `listing`, `listingReason`, `listingUpdatedAt/By`, newest registered first, ≤ 200 (`console.read`)                                                                                                                                                                                                                                                                                                                                                           | `implemented` | `implemented`; needs migration 000093                                                                           |
| `PUT /admin/v1/launch2/instances/{id}/listing`                      | `{listing, reason}` (`reason` required for `hidden`)                                                 | Decision 0163: hidden leaves `/v2/launch2/instances` (every stage), overview counts / activity, `/public/v1/meme`, Square event posts; detail by id still reads it; audit `launch2.listing.update` (`console.write`)                                                                                                                                                                                                                                                                                    | `implemented` | `implemented`; needs migration 000093                                                                           |
| `GET /admin/v1/audit`                                               | `actor`, `action`, signed cursor                                                                     | append-only audit rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `implemented` | `implemented`                                                                                                   |
| `POST /admin/v1/session/password` (0109)                            | `{currentPassword, newPassword}`                                                                     | new session + `Set-Cookie`; bumps credentials version (other sessions end); clears `passwordChangeRequired`                                                                                                                                                                                                                                                                                                                                                                                             | `implemented` | `implemented`; console accounts only (bootstrap → 409)                                                          |
| `GET /admin/v1/accounts` (0109)                                     | cookie (`accounts.read`)                                                                             | accounts (≤ 500) with live operator grants + `bootstrap`; never a hash                                                                                                                                                                                                                                                                                                                                                                                                                                  | `implemented` | `implemented`; 503 without database                                                                             |
| `POST /admin/v1/accounts` (0109)                                    | UUIDv4 `Idempotency-Key`; `{username, password, role, operatorUserId?, operatorLabel?, projectIds?}` | 201 account; reviewer / acceptor get `ops_operators` + role-derived `ops_grants` in the same transaction (`ops_audit` `operator.provision`)                                                                                                                                                                                                                                                                                                                                                             | `implemented` | `implemented`; `accounts.manage` (platform_admin)                                                               |
| `POST /admin/v1/accounts/{id}/disable`, `/reset-password` (0109)    | `Idempotency-Key`; `{reasonCode}` / `{password}`                                                     | terminal disable (operator revoked) / new initial password; both end every session of the account                                                                                                                                                                                                                                                                                                                                                                                                       | `implemented` | `implemented`; `accounts.manage`                                                                                |
| `POST /admin/v1/accounts/{id}/unlock` (0111)                        | `Idempotency-Key`; `{reasonCode}`                                                                    | account with `locked: false`; deletes the `username` bucket of `admin_login_attempts` (IP buckets kept); audit `account.unlock`; nothing to clear → `changed: false`; bootstrap (`bootstrap` / its name) → 409 `ADMIN_ACCOUNT_ENVIRONMENT`                                                                                                                                                                                                                                                              | `implemented` | `implemented`; `accounts.manage` (platform_admin); 503 without database                                         |
| `GET /admin/v1/launch/projects`, `/{projectId}` (0109)              | `status` (stage), `kind` (0122), `limit`, signed cursor                                              | stage `draft/awaiting_approval/rejected/approved/accepted/deploying/activated` (0112, 0122); `project.kind / materialVersion / rejection / latestRejection` (0122); detail `versions[].rejection`, `projectRejections[]`, publication `action` (0122); versions + approvals + testnet acceptances + tasks with predicted / deployed addresses, executor progress and events (no signatures, no raw tx); read-only `deploymentChainId` (0117) and `deploymentMainnetAcknowledged` (0150, only when true) | `implemented` | `implemented`; `launch.read`; reviewer / acceptor scoped by their ops grants                                    |
| `POST /admin/v1/launch/projects/{id}/versions/{v}/approve` (0109)   | `Idempotency-Key` (= operationId); `{configHash, reason}`                                            | Decision 0108 approval as the bound LOOP user; editor / owner refused (`OPS_SELF_APPROVAL`)                                                                                                                                                                                                                                                                                                                                                                                                             | `implemented` | `implemented`; reviewer only (`launch.approve`)                                                                 |
| `POST /admin/v1/launch/projects/{id}/versions/{v}/reject` (0122)    | `Idempotency-Key` (= operationId); `{configHash, reasonCode, note?}`                                 | Reviewer rejection of the latest config version (five reasons, `other` needs a note); one decision per version; owner reads `approval.status = rejected`                                                                                                                                                                                                                                                                                                                                                | `implemented` | `implemented`; reviewer only (`launch.approve`)                                                                 |
| `POST /admin/v1/launch/projects/{id}/materials/{mv}/approve` (0125) | `Idempotency-Key` (= approvalId); `{reason}`                                                         | Reviewer approval of `submitted` / `in_review` catalog material at material version `mv` (CAS): `approved` + catalog `launches` row (launch chain slot) + `launch_project_approvals` row; console counterpart of `pnpm launch:review … approve`; summary `materialApproval`                                                                                                                                                                                                                             | `implemented` | `implemented`; reviewer only (`launch.approve`), owner excluded                                                 |
| `POST /admin/v1/launch/projects/{id}/reject` (0122)                 | `Idempotency-Key` (= rejectionId); `{materialVersion, reasonCode, note?}`                            | Reviewer rejection of `submitted` / `in_review` catalog material (CAS on material version); applicant edits and resubmits                                                                                                                                                                                                                                                                                                                                                                               | `implemented` | `implemented`; reviewer only (`launch.approve`)                                                                 |
| `POST /admin/v1/launch/projects/{id}/snapshot/retry` (0120)         | `Idempotency-Key` (= releaseId); `{reason}`                                                          | Append-only retry grant for a `failed` / `mismatch` MEME v2 snapshot publication; next tick = attempt N + 1; detail adds `snapshotReleases[]` + `snapshotClosure`                                                                                                                                                                                                                                                                                                                                       | `implemented` | `implemented`; platform_admin only (`console.write`); no chain write by the route                               |
| `POST /admin/v1/launch/projects/{id}/testnet-acceptance` (0109)     | `Idempotency-Key` (= acceptanceId); acceptance record                                                | BSC Testnet acceptance; editor / owner refused (`OPS_SELF_ACCEPTANCE`)                                                                                                                                                                                                                                                                                                                                                                                                                                  | `implemented` | `implemented`; testnet_acceptor only (`testnet.accept`)                                                         |
| `GET /admin/v1/chain-guard/incidents` (0134)                        | cookie (`console.read`)                                                                              | unresolved `chain_guard` incidents of the launch chain (≤ 200, newest sighting first): `{chainId, holdActive, holdKinds, items[{incidentId, kind, subject, details, firstSeenAt, lastSeenAt, hold}], generatedAt}`; read-only                                                                                                                                                                                                                                                                           | `implemented` | `implemented`; 503 `CAPABILITY_UNAVAILABLE` (`CHAIN_GUARD_REPOSITORY_UNAVAILABLE`) without database             |

Decision 0134 (S174): the read-only `chain_guard` worker lane
(`CHAIN_GUARD_ENABLED`, default off; migration `000079_chain_guard`,
tables `chain_guard_incidents` / `chain_guard_cursors`) watches USD1
`paused()` / `frozen()` of every address we depend on / the EIP-1967
implementation / ProxyAdmin and owner changes / frozen-fund seizure logs,
the Uniswap v4 protocol fee controller and each graduated pool's protocol
fee, and the BNB balance of the signer accounts. An unresolved USD1 pause
or freeze of one of our addresses makes `launch2_buyback_keeper`,
`hooks_launch_executor`, and `launch2_dynamic_poke` skip their ticks with
`CHAIN_GUARD_HOLD`. `pnpm chain:preflight` runs the same checks before a
deployment (exit 0 / 1 failed / 2 could not run; `--dry` for the testnet).

### V2 module gate (Decision 0029)

`registerV2Routes` in `src/routes/v2/index.ts` is the single V2 registration
point. `V2_MODULES_ENABLED` selects which module routes may register.
`profile` (Decision 0030), `community` and `search` (0031), `communication`
(0032), `chain`, `wallet`, and `watchlist` (0033), and `market` and
`notifications` (0034), `swap` and `sendApprovals` (0035), and `security`,
`settings`, and `support` (0037) ship their registrars;
every other module below has none yet, so enabling it registers no route and
only changes its capability projection.

| Module ID       | Capability projected                                    | Registrar   | Status                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community`     | `community`                                             | shipped     | routes and capability `implemented` (Decision 0031)                                                                                                                                                                                    |
| `communication` | `communityChat`                                         | shipped     | routes and capability `implemented` (Decision 0032)                                                                                                                                                                                    |
| `search`        | `search`                                                | shipped     | routes and capability `implemented` (Decision 0031)                                                                                                                                                                                    |
| `market`        | `marketRead`                                            | shipped     | routes and capability `implemented` (Decision 0034)                                                                                                                                                                                    |
| `chain`         | `bscRead`                                               | shipped     | routes and capability `implemented` (Decision 0033)                                                                                                                                                                                    |
| `wallet`        | `walletRead`                                            | shipped     | routes and capability `implemented` (Decision 0033)                                                                                                                                                                                    |
| `swap`          | `privySwap`                                             | shipped     | routes `implemented` (Decision 0035); `available` only with `BSC_WRITES_ENABLED`, Privy credentials, and a verified chain; evidence pending; the Provider itself has Swaps disabled for the app (Decision 0065)                        |
| `sendApprovals` | `sendApprovals`                                         | shipped     | routes `implemented` (Decision 0035); `available` only with `BSC_WRITES_ENABLED` and a verified chain; the switch is on for Development inside the Decision 0065 canary                                                                |
| `launch`        | `launch`                                                | not shipped | gate `implemented`; routes pending D17/D18 and 02 document                                                                                                                                                                             |
| `mining`        | `mining`, `communityMining`                             | shipped     | routes `implemented` (Decisions 0036, 0043); `communityMining` follows the approved-and-effective formula fact per request; evidence pending 02                                                                                        |
| `notifications` | `priceAlerts`, `notificationsFeed`, `pushNotifications` | shipped     | alerts, feed, and preferences `implemented` (Decision 0034); push `implemented` (Decision 0067), `available` only with a Firebase credential, else `unavailable`/`PUSH_RUNTIME_DEFERRED`; delivery evidence pending a physical handset |
| `profile`       | `profile`                                               | shipped     | routes and capability `implemented` (Decision 0030)                                                                                                                                                                                    |
| `watchlist`     | `watchlist`                                             | shipped     | routes and capability `implemented` (Decision 0033)                                                                                                                                                                                    |
| `security`      | `security`                                              | shipped     | routes and capability `implemented` (Decision 0037); MFA/passkey/recovery/key export stay `blocked-provider`                                                                                                                           |
| `settings`      | `settings`                                              | shipped     | routes and capability `implemented` (Decision 0037)                                                                                                                                                                                    |
| `support`       | `support`                                               | shipped     | routes and capability `implemented` (Decision 0037); attachments `explicitly-disabled`                                                                                                                                                 |

An enabled module without a registrar reports
`availability: unavailable, reasonCode: MODULE_RUNTIME_NOT_REGISTERED`. The
`avatarUpload` capability (Decision 0095) is `available` with the profile
runtime, the PostgreSQL media storage, and the upload quota secret; otherwise
`unavailable` with `AVATAR_STORAGE_UNAVAILABLE`.
`communityPresence` (Decision 0047) reads runtime: `available` when Stream
credentials and the communication runtime are composed,
`STREAM_PRESENCE_NOT_CONNECTED` without credentials,
`COMMUNICATION_RUNTIME_UNAVAILABLE` with credentials but no communication
runtime. `communityMining`
(Decisions 0043, 0044) is never `deferred`: it reads the database per request
and is `available` once a formula version is approved and effective,
`MINING_FORMULA_BASELINE_PENDING` before that or without the `mining` module,
`MINING_RUNTIME_UNAVAILABLE` when the repository cannot answer. `community` and `search` report `available`
only when the module is enabled and `buildApp` composed the PostgreSQL
community repository and the V2 cursor codec (plus the public search quota for
`search`); otherwise they fail closed. `bscRead` is `available` only when the
`chain` module is enabled, at least one RPC endpoint is configured, the registry
repository is composed, and `eth_chainId` was actually observed to equal 56; an
unprobed, unreachable, or mismatched chain fails closed with its own reason
code. `walletRead` additionally needs Privy credentials and the cursor codec.
`search`); otherwise they fail closed. `communication` projects two
capabilities: `communityChat` and `voiceRooms`, both `available` only with the
module enabled, the communication repository composed, the community runtime
available, and Stream credentials present. `voiceRooms.evidence` is
`{status: "pending", reasonCode: "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING"}` until an
operator records the Decision 0005 Stream Dashboard role evidence in
`STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF` (Decision 0039); it then becomes
`{status: "confirmed", reasonCode: null, reference: "<label>"}`. The `reference`
key is present only while confirmed and only on `voiceRooms` (absent, never
`null`, elsewhere), and the switch never changes `availability`. Until it is
confirmed the mobile locator stays unavailable even when the backend is
available.

V2 bootstrap has bounded session-creation quotas, exact durable replay, and
owner/device/contract-bound request digests. Logout durably records either one
monotonic revocation result or the same non-enumerating `SESSION_NOT_FOUND`
result. The first delivery intentionally continues to mint Chat and Video
tokens through frozen `POST /v1/chat/token` and `POST /v1/video/token`; both
resolve the same internal account created by V2 bootstrap. Decision 0032 adds
the camelCase `POST /v2/chat/token` and `POST /v2/video/token` projections of
the same issuance policy and quota; neither creates a second message API nor
claims a connected Stream client.

### Read-only database behaviour of GET routes (Decision 0127, S151)

Checked with a `default_transaction_read_only=on` connection
(`test/v2-read-only-get-routes.integration.test.ts`):

| Route                                                                             | Write it attempts                                 | Read-only answer                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /v2/market/overview`, `/new-pairs`, `/assets/{id}` (+ `candles`, `holders`)  | `market_fact_cache` upserts after a Provider read | `200` with the fresh Provider facts; the failed write is logged (`onCacheWriteFailure`)                    |
| `GET /v2/wallets`                                                                 | `account_wallets` sync of the Privy inventory     | `200` from the stored inventory when it equals what Privy reported; otherwise `503 CAPABILITY_UNAVAILABLE` |
| `GET /v2/referral`                                                                | first-read issuance of the account's invite code  | `200` once a code exists; first issuance `503 CAPABILITY_UNAVAILABLE` (a code is never invented)           |
| `GET /v2/search?domain=users\|communities`, `GET /v2/communities/{id}/members?q=` | alias-search quota buckets (security meter)       | `503 CAPABILITY_UNAVAILABLE` (fail-closed, unchanged)                                                      |
| `GET /v2/blocks?kind=contract\|domain`                                            | none — not storage-backed in any mode             | `503 CAPABILITY_UNAVAILABLE` (unchanged; the preflight counted it as a write)                              |

Any other GET whose PostgreSQL work fails with SQLSTATE `25006` (read-only) answers
`503 CAPABILITY_UNAVAILABLE` `reasonCode: DATABASE_READ_ONLY`; class `08`, `57P01`–`57P03`,
`53300` answer `DATABASE_UNAVAILABLE`; never `500`.

## Implemented routes

| Method and path      | Request                    | Success projection            | Interface     | Capability                                                                                     |
| -------------------- | -------------------------- | ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health/live`   | No input                   | `{status, service, version}`  | `implemented` | `implemented`                                                                                  |
| `GET /health/ready`  | No input                   | `{status, checks:{database}}` | `implemented` | `implemented`                                                                                  |
| `POST /v1/bootstrap` | Bearer only; no body/query | `{user:{id}, stream_user_id}` | `implemented` | `blocked-provider`; server verifier exists, but phone-issued-token evidence remains unverified |

`GET /openapi.json` is a conditional Development documentation endpoint when
`API_DOCS_ENABLED=true`; it is not a mobile business route.

## Passkey relying-party discovery (Decision 0063) and App Links (Decision 0090)

The API origin is the relying party for LOOP passkeys and the host of shared
LOOP ID links (`/u/{loopId}`), so it publishes the two static association files
the platform fetchers read plus a static landing page. All three are
unauthenticated, carry no user or session fact, are **excluded from the OpenAPI
artifacts** (`hide: true`; asserted by `test/well-known-app-links-routes.test.ts`),
and, with the public read surface below (Decision 0147), the only LOOP
responses that are not `Cache-Control: no-store`. Since
Decision 0090 both files are always published (the `/u/*` association uses the
fixed app identity); the passkey half is still fail-closed: without its
configuration the `webcredentials` key / `get_login_creds` statement is absent.

| Method and path                               | Request                                 | Success projection                                                                                                                                                                                                                                                                                                                                                                          | Interface     | Capability                                                                    |
| --------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| `GET /.well-known/assetlinks.json`            | No input                                | Statement 1: `handle_all_urls` for `com.cywd.loop`, debug keystore fingerprint + `ANDROID_RELEASE_CERT_SHA256`; statement 2 (only with `PASSKEY_ANDROID_CERT_SHA256`): passkey statement of Decision 0063; `Content-Type: application/json`, `Cache-Control: public, max-age=3600`                                                                                                          | `implemented` | always published; platform verification on a real device is unverified        |
| `GET /.well-known/apple-app-site-association` | No input                                | `{applinks:{details:[{appIDs:["<PASSKEY_IOS_TEAM_ID>.<PASSKEY_IOS_BUNDLE_ID>"],components:[{"/":"/u/*"},{"/":"/c/*"},{"/":"/i/*"}]}]},webcredentials:{apps:[same]}}` (`/c/*` since Decision 0091; app ID from config since Decision 0106, bundle default `com.cywd.loopapp`); without `PASSKEY_IOS_TEAM_ID`: `{applinks:{details:[]}}` + startup warn `APPLE_TEAM_ID_MISSING`; same headers | `implemented` | always published; Apple CDN fetch and TF build 8 entitlement check unverified |
| `GET /u/{loopId}`                             | `LOOP-` + 8 alnum, any case             | Static HTML landing page (`text/html; charset=utf-8`, `public, max-age=3600`); malformed ID → `404` HTML, `no-store`; no database read                                                                                                                                                                                                                                                      | `implemented` | download link only with `APP_DOWNLOAD_URL`                                    |
| `GET /i/{code}`                               | invite code, any case, `LOOP-` optional | Decision 0162: static HTML invite page (black, code, copy-and-download button, `APP_STORE_URL_IOS` / `APP_STORE_URL_ANDROID` links when set); one fixed inline script allowed by its CSP hash; never reads the database; bad code / check symbol → `404` HTML, `no-store`                                                                                                                   |
| `GET /c/{communityId}/room`                   | canonical lower-case UUIDv4             | Static HTML voice-room invitation page (Decision 0091), same headers as `/u/`; never echoes the community ID; malformed ID → `404` HTML, `no-store`; no database read                                                                                                                                                                                                                       | `implemented` | download link only with `APP_DOWNLOAD_URL`                                    |

## Public read surface (Decision 0147, `/public/v1`)

Read-only facts for the single-MEME web page (Vercel, another origin). Outside
`/v2`, like the well-known files: no Bearer token, no `X-Loop-Contract-Version`,
no `Idempotency-Key`. Published in its own artifact `openapi/loop-public.v1.json`
(tag `public`); the frozen `loop-api.v1.json` and `loop-api.v2.json` do not
contain it. Every `/public/*` answer carries
`Access-Control-Allow-Origin: *` (errors and the `OPTIONS` preflight `204`
included; `/v2` gets none); a `200` is `Cache-Control: public, max-age=15`, every
error `no-store`. Failures are `{ code, reasonCode }` (`400 INVALID_REQUEST`,
`404 NOT_FOUND`, `429 RATE_LIMITED` + `Retry-After`, `503 CAPABILITY_UNAVAILABLE`
with the launch2 reason as is); a 503 never carries a partial body. Per visitor
`PUBLIC_RATE_LIMIT_PER_MINUTE` (default 120, 10–10000) requests per one-minute
fixed window, in process memory (each replica counts on its own); a `429` also
carries `X-RateLimit-Limit` and `X-RateLimit-Remaining: 0`. The visitor
(S211) is `request.ip` with `TRUST_PROXY=false`; with `TRUST_PROXY=true` it is
the first public address among `PUBLIC_CLIENT_IP_HEADERS` (default
`x-forwarded-for`, read as its right-most public entry; `cf-connecting-ip` /
`x-real-ip` only when listed), else `request.ip`. `/v2` is unaffected. Identical URLs share one answer for 5 s, and concurrent reads of
one URL share one in-flight read (S207 single-flight; a failure reaches every
waiter as the same 503 and is not cached). Each read has a time budget — detail
8 s, list 10 s, candles 5 s, inside the 15 s `handlerTimeout` — answering
`503 CAPABILITY_UNAVAILABLE` / `PUBLIC_UPSTREAM_TIMEOUT` (Fastify's own
`FST_ERR_HANDLER_TIMEOUT` is projected the same way, never 500); a reply is never
sent twice or into a closed response. No wallet, user, viewer,
owner, buyer, or trader field appears anywhere. Evidence:
`test/public-meme-routes.test.ts`, `test/public-meme-resilience.test.ts`,
`test/public-meme.integration.test.ts`.

| Method and path                            | Request                                                                    | Success projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Interface     | Capability                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /public/v1/meme`                      | `stage` `all` (default) / `graduated` / `curve`, `limit` 1–50 (default 50) | `items[]` newest first: `instanceId`, `name`, `symbol`, `logoUrl`, derived `stage`, `memeTokenAddress`, `communityName` (bound, non-rejected), indexed `lastPriceUsd1`, `dynamic {armed, currentDynamicTaxBps}` (graduated LoopDynamic only, live Hook read), `dynamicReasonCode` (the 503 reason when that row's Hook read is unavailable; `dynamic` then null); `generatedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `implemented` | needs `V2_MODULES_ENABLED=launch2`; else 503 `V2_LAUNCH2_MODULE_DEFERRED`                                                                                                                           |
| `GET /public/v1/meme/{instanceId}`         | No input                                                                   | `instance` (identity, derived stage, contracts, `perAddressCurveCapMeme` — 0152: the curve's `maxCumulativeBuy()` / pre-S209 `MAX_CUMULATIVE_BUY()` read from the chain, the verified value when unreachable — `explorerBaseUrl`, `socials` from the saved links), `community` (`name`, `slogan` = first line of the description ≤ 60, `description`, `memberCount`, `verified`, `avatarUrl` null), `price` (`lastPriceUsd1`, `change24hPct` vs the 24 h reference, `asOf`), `dynamic` (graduated LoopDynamic: Hook at one block — `armed`, `currentRound`, `currentDynamicTaxBps`, cap, base fees, `buyFeeToken` (0152: `usd1` = S209 Hook, fee from the USD1 input; `meme` before), `pendingPotUsd1` = carry + round dynamic fees, `lastClosedRound`, `asOfBlock`; null for OfficialTax / before graduation), `totals` (curve tax, pool base buy fee MEME (`poolBaseBuyFeeMeme`, OfficialTax / pre-S209 Hooks) / buy fee USD1 (`poolBaseBuyFeeUsd1`, 0152: S209 Hooks) / sell fee USD1, dynamic fees, USD1 equivalent (both buy fees included), rewards allocated / claimed, buyback ledger) | `implemented` | Hook / registry failures 503 as `/v2/launch2/.../dynamic-pool` (`LAUNCH2_DYNAMIC_*`; 0153: incl. `_FACTORY_UNKNOWN` / `_ROUTER_MISMATCH`, legacy-Factory instances answer through their own router) |
| `GET /public/v1/meme/{instanceId}/candles` | `interval` `5m` only (else 400), `limit` 1–300 (default 300)               | `interval`, `source` `pool` / `curve`, `candles[] {t,o,h,l,c,v}` oldest first (USD1 per MEME): graduated LoopDynamic = the Hook's `CandleClosed` (high / low widened to the bucket's swaps, `v` = swap USD1), else indexed pool swaps; not graduated = curve trades at the marginal price after each trade, `v` = USD1 gross                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `implemented` | same gate                                                                                                                                                                                           |

## Website registration surface `/v2/web/*` (Decision 0179)

For the LOOP website (`loop-web`, same Privy App). Own artifact
`openapi/loop-web.v2.json` (contract surface `web`); mounted at runtime only
when `WEB_ORIGINS` is non-empty (default empty = 404). CORS only inside this
prefix and only for an `Origin` listed in `WEB_ORIGINS` (echoed, never `*`;
`Vary: Origin`; `Cross-Origin-Resource-Policy: cross-origin`; preflight 204 with
`GET, POST, PUT, OPTIONS` and `authorization, content-type, idempotency-key,
x-loop-contract-version`). Writes: Privy Bearer + `X-Loop-Contract-Version: 2.0`

- lower-case UUIDv4 `Idempotency-Key`; no App device / platform / client-version
  header and no device session. Errors are the seven-field V2 envelope with
  `detailsSafe.reasonCode`. No migration. Front-end contract:
  `docs/frontend-web-registration-api.md`. Evidence:
  `test/web-registration.test.ts`, `test/web-registration.integration.test.ts`;
  Decision 0180 (`GET /v2/web/referral/me`): `test/web-referral-dashboard.test.ts`,
  `test/web-referral-dashboard.integration.test.ts`. No username-suggestion
  route: the App's alias suggestion is client-side.

| Method and path                      | Request                                                  | Success projection                                                                                                                                                                                                                                                                                                                                                            | Interface     | Capability                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/web/session`               | Bearer + write headers; no body or `{}`                  | `{loopId, username, usernameRequired, walletAddress, invite {bound, canClaim}, observedAt}` (Decision 0181: no `windowEndsAt`); get-or-create (same account as the App)                                                                                                                                                                                                       | `implemented` | needs `V2_SESSION_ENABLED` (else 503 `WEB_SESSION_DISABLED`); Privy missing → 503 `PROVIDER_DISCONNECTED`                                                                             |
| `PUT /v2/web/profile/username`       | Bearer + write headers; `{username}`                     | `{username}`; pending → App activation command (claim allowed any time after, Decision 0181), active → alias CAS replace                                                                                                                                                                                                                                                      | `implemented` | needs `profile` module (else 503 `V2_PROFILE_MODULE_DEFERRED`); App alias rules (1–40 code points, reserved / blocked)                                                                |
| `POST /v2/web/referral/claim`        | Bearer + write headers; `{code}`                         | `{status: bound \| already_bound, inviterLoopId?}` via the App claim service                                                                                                                                                                                                                                                                                                  | `implemented` | needs `referral` module (else 503 `V2_REFERRAL_MODULE_DEFERRED`); refusals carry `REFERRAL_*` / `PROFILE_ACTIVATION_REQUIRED`                                                         |
| `GET /v2/web/referral/me[?cursor=]`  | Bearer only (no contract / idempotency / device headers) | Decision 0180: `{code, inviteLink, stats {direct, valid, deeper, pendingVerification, validAsOf} \| null, invitees [{loopId, username, depth 1, status valid\|pending\|void, joinedAt}] (100 a page), nextCursor, inviter, binding {bound, canClaim}, observedAt}`; App invite-center reads (`ReferralService.getDashboard`); code issued on first read (before the username) | `implemented` | needs `referral` module (else 503 `V2_REFERRAL_MODULE_DEFERRED`) and `V2_CURSOR_HMAC_SECRET` (else 503 `V2_CURSOR_NOT_CONFIGURED`); `stats` null before the first settled mining hour |
| `GET /v2/web/referral/preview?code=` | Public; no headers                                       | `{valid, inviter: {username, loopId} \| null}`; per-visitor 1-minute window (`PUBLIC_RATE_LIMIT_PER_MINUTE`), 429 `WEB_RATE_LIMITED`                                                                                                                                                                                                                                          | `implemented` | needs `referral` module                                                                                                                                                               |
| `GET /v2/web/meta`                   | Public; no headers                                       | `{appStore {ios, android, testflight}, observedAt}` from `WEB_APP_LINKS_*` (null when unset)                                                                                                                                                                                                                                                                                  | `implemented` | `implemented`                                                                                                                                                                         |

`GET /i/{code}` (Decision 0162 landing page) answers `302` to
`${WEB_BASE_URL}/i/{code}` when `WEB_BASE_URL` is set; blank keeps the API's
own page. The Universal Link / App Link host is unchanged (the API domain).

## Personalization and inactive alert routes

LOOP PostgreSQL is the system of record for the authenticated owner's local
presentation and preference records. Alias, visibility, group, and asset keys
are untrusted presentation references: none are authentication, wallet, market,
social-graph, or trading authority.

| Method and path                    | Key contract                                                                                                       | Interface     | Capability                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------- |
| `GET /v1/profile`                  | Owner-only alias and opaque avatar reference; non-writing version-0 default                                        | `implemented` | `implemented`                                                             |
| `PUT /v1/profile`                  | Full replacement with `expected_version` and identical-retry success                                               | `implemented` | `implemented`                                                             |
| `GET /v1/profile/privacy`          | Fail-closed discoverability/copy-visibility preference; non-writing version-0 default                              | `implemented` | `implemented`; the value is not copy-trading authorization                |
| `PUT /v1/profile/privacy`          | Full replacement with `expected_version`; no social relationship is created                                        | `implemented` | `implemented`                                                             |
| `GET /v1/watchlist`                | Owner-only grouped ordered asset-reference snapshot                                                                | `implemented` | `implemented`; asset keys are not market facts                            |
| `PUT /v1/watchlist`                | Atomic whole-snapshot replacement, at most 20 groups/100 items, optimistic version protection                      | `implemented` | `implemented`                                                             |
| `GET /v1/alerts`                   | Bounded list of non-deleted inactive definitions                                                                   | `implemented` | storage `implemented`; evaluation and delivery `explicitly-disabled`      |
| `POST /v1/alerts`                  | UUID `Idempotency-Key`; strict asset/condition/decimal/optional-expiry definition; replay after deletion conflicts | `implemented` | creates `inactive` only                                                   |
| `GET /v1/alerts/{alert_id}`        | Owner-bound inactive definition                                                                                    | `implemented` | storage `implemented`; no activation                                      |
| `PUT /v1/alerts/{alert_id}`        | Full replacement with `expected_version` and identical-retry success                                               | `implemented` | remains `inactive`                                                        |
| `DELETE /v1/alerts/{alert_id}`     | Version-protected soft delete; absent/deleted remains non-enumerating                                              | `implemented` | no scheduler or delivery side effect                                      |
| `GET /v1/alerts/history`           | Bounded newest-first list of persisted sanitized real trigger facts; no public writer or fixture fallback          | `implemented` | read interface `implemented`; trigger production `explicitly-disabled`    |
| `GET /v1/notification-preferences` | Fixed event preferences, disabled version-0 defaults, explicit delivery unavailable                                | `implemented` | preference storage `implemented`; Firebase delivery `explicitly-disabled` |
| `PUT /v1/notification-preferences` | Atomic full fixed-set replacement with `expected_version`; enabled records intent only                             | `implemented` | delivery remains `explicitly-disabled`                                    |

Alert definitions accept no owner, provider/source URL, market fact, Firebase
token, delivery target, or scheduler field. Every alert remains `inactive` and
reports evaluation/delivery unavailable. The history relation is append-only,
but no current public or worker path can create an event. Empty history is
therefore a truthful empty list, not demo data. Decision 0009 defines the exact
ownership and closed-capability boundary. A create-key replay after the target
was soft-deleted returns `idempotency_resource_deleted`; it never resurrects or
projects the deleted definition as current.

## Implemented Stream token routes

| Method and path        | Request                                              | Success projection                        | Interface     | Capability         |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------- | ------------- | ------------------ |
| `POST /v1/chat/token`  | Bearer + existing bootstrap; no body/query/client ID | `{api_key, token, expires_at, user:{id}}` | `implemented` | `blocked-provider` |
| `POST /v1/video/token` | Bearer + existing bootstrap; no body/query/client ID | `{api_key, token, expires_at, user:{id}}` | `implemented` | `blocked-provider` |

Both tokens bind the same server-derived Stream subject, expire after 3600
seconds, and are never cached or persisted. Chat and Video have separate
capability quotas; each attempt atomically reserves both an internal-user bucket
and a canonical-IP bucket using domain-separated HMAC-SHA256 subjects, so raw
LOOP user IDs and IP addresses are not persisted in quota subjects. Quota
exhaustion is `429` without an issuer call. A missing quota HMAC capability or
unavailable real issuer returns `503`; a partial Stream API key/secret pair is a
startup error.

The shared quota table keeps each window for seven complete days after that
window ends. The standalone worker deletes only older rows in bounded,
skip-locked batches and returns counts rather than capability rows or subject
HMACs. This maintenance does not refund attempts or change active-window quota
semantics.

The reviewed Stream Source Code License Agreement has been explicitly accepted,
and the default runtime uses exact `@stream-io/node-sdk@0.7.63` local signing
when the complete key/secret pair and independent quota HMAC capability are
present. The signer passes only the server-derived user ID and exact
whole-second `iat`/`exp`; it adds no product, role, call, or custom claims.
These interfaces have not been exercised with a real phone-issued Privy token,
Flutter, or a physical device, do not authorize server Chat/Video mutations,
and do not claim connected Stream state. Capability therefore remains
`blocked-provider` pending credentialed Development App and device evidence.
The Development-only `pnpm identity-stream:smoke` command can close the backend
credential-chain portion without printing identities or tokens, but its
existence is not evidence until an operator supplies a current phone-issued
token and the run passes.

## Implemented alias, friend, and Chat coordination interfaces

Decisions 0024 and 0025 approve the authenticated routes below. Their additive
PostgreSQL state, runtime schemas, generated OpenAPI, behavior tests, and
repository integration tests establish the local interface. They do not close
the separate real-Stream, Stream-permission, or physical-device evidence gates.

### Public Alias and immutable group persona

| Method and path                           | Key contract                                                                                                                                  | Interface     | Capability         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------ |
| `GET /v1/discovery/users`                 | `alias_prefix` plus optional 1-20 `limit`; discoverable non-null public aliases; items expose public-profile ID/code, alias, and avatar       | `implemented` | `implemented`      |
| `POST /v1/chat/groups/resolve`            | Resolve one existing fixed `messaging` Stream channel only after current-member verification; reject marked direct; never create/add a member | `implemented` | `blocked-provider` |
| `GET /v1/chat/groups/{group_id}/me/alias` | Current-member-only read of the caller's retained immutable group Alias                                                                       | `implemented` | `blocked-provider` |
| `PUT /v1/chat/groups/{group_id}/me/alias` | First durable reservation wins; same-value retry; normalized name unique in group; Stream projection is `pending` or `confirmed`              | `implemented` | `blocked-provider` |
| `GET /v1/chat/groups/{group_id}/aliases`  | Current-member-only prefix search; Stream rechecks requester and returned candidates; items expose only group Alias ID/Alias                  | `implemented` | `blocked-provider` |

Public and group searches require a `unicode17_nfkc_lower_ws_v1` normalized
prefix of at least two Unicode code points, default to and cap results at 20,
perform prefix matching only, and return neither a total nor a pagination
cursor. Public aliases may be duplicated; the authenticated caller is omitted.
The immutable ten-character `profile_code` distinguishes duplicate public
aliases but is never accepted as a command target or projected into Stream.
Group results omit the requester, departed members, and `pending` projections,
and expose no public-profile/code, internal/Privy/Stream user, wallet, channel,
membership, or cross-group correlation field.

Each search atomically reserves independent public- or group-search
user-per-minute, canonical-IP-per-minute, and user-per-day buckets. Public Alias
discovery and friend search share the same public-search budget. Subjects use
the existing server-only quota HMAC secret under a separate versioned domain;
raw users and IPs are not stored. Missing quota capability fails closed. Public
capacities are 30/60/300 for user-minute/IP-minute/user-day; group capacities
are 60/120/600.

LOOP PostgreSQL is canonical for group aliases. A group Alias remains reserved
after its owner leaves and is restored on rejoin; Stream member custom data is
only a server-written presentation projection. Stable Stream user IDs make
these aliases UI pseudonyms, not strong unlinkability.

### Social privacy, friends, and durable local commands

| Method and path                                         | Key contract                                                                                                                                                                                                                                 | Interface     | Capability    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| `GET /v1/profile/social-privacy`                        | Owner-only version; missing row is version 0 with the open defaults (friend requests enabled, group invites and direct messages friends; Decision 0070)                                                                                      | `implemented` | `implemented` |
| `PUT /v1/profile/social-privacy`                        | Full CAS replacement; no `Idempotency-Key`; exact enabled/disabled and friends/disabled preferences                                                                                                                                          | `implemented` | `implemented` |
| `GET /v1/friends`                                       | Accepted friends with public-profile ID/code, nullable current presentation, acceptance time, and encrypted owner-bound keyset cursor                                                                                                        | `implemented` | `implemented` |
| `GET /v1/friends/search`                                | Shared-quota public Alias prefix search plus none, outgoing-pending, incoming-pending, or friend relationship state                                                                                                                          | `implemented` | `implemented` |
| `POST /v1/friend-requests`                              | UUIDv4 command key equals operation ID; target only by public-profile ID; explicit pending request, no reverse-request auto-accept; admission = activated, unblocked, `friendRequests` not disabled, `discoverable` not read (Decision 0096) | `implemented` | `implemented` |
| `GET /v1/friend-requests`                               | Incoming or outgoing pending requests only, with owner/filter/page-size-bound encrypted cursor                                                                                                                                               | `implemented` | `implemented` |
| `POST /v1/friend-requests/{friend_request_id}/decision` | Recipient-only idempotent accept/reject; first decision wins; only accept creates the friendship                                                                                                                                             | `implemented` | `implemented` |
| `GET /v1/social/operations/{operation_id}`              | Owner-bound terminal local result; unknown/wrong owner is the same 404                                                                                                                                                                       | `implemented` | `implemented` |

`public_profile_id` remains the only command target. `profile_code` is immutable
presentation data, while Alias stays mutable and non-unique. Missing social
privacy is fail closed. Pending friend requests expire after seven days;
rejection applies a 24-hour pair cooldown. Cursors currently expire after ten
minutes and are bound to owner, route, direction/status filter, and original
page size. A cursor request cannot also choose a new `limit`.

Social command POSTs require exactly one raw lowercase UUIDv4
`Idempotency-Key`. That UUID is the public operation ID. An exact replay returns
the original result; reuse with a different digest conflicts. Local business
failures can also be journaled as terminal failed operations, while failures
before the durable claim (authentication, quota, or unavailable service) need
not produce an operation.

### Backend-created fixed Stream channels

| Method and path                          | Key contract                                                                                                                           | Interface     | Capability         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------ |
| `POST /v1/chat/groups`                   | Two through twenty-nine unique accepted friends plus caller; fixed persisted group channel ID; exact target privacy/friendship recheck | `implemented` | `blocked-provider` |
| `POST /v1/chat/direct-channels`          | One accepted friend; unordered pair converges on one fixed direct CID; exact target privacy/friendship recheck                         | `implemented` | `blocked-provider` |
| `GET /v1/chat/operations/{operation_id}` | Owner-bound status/reconciliation for group or direct; nonterminal 202 with `Location`/`Retry-After`, terminal 200                     | `implemented` | `blocked-provider` |

Both POSTs use a UUIDv4 `Idempotency-Key` equal to `operation_id`. LOOP persists
the operation, intended membership, and explicit Stream ID before the one
channel-creation attempt. The required bounded `{id}`-only Stream user upsert is
a separate provider mutation and never carries LOOP profile data. Ambiguous
channel results read the same ID and never allocate a second channel. Public
states are `pending`, `submitting`, `reconciling`, `succeeded`, `failed`, and
`operator_required`. Success returns a complete
`messaging:<fixed-id>` CID; group success additionally returns the opaque LOOP
`group_id` required by the group-Alias APIs.

Immediately before the provider call, every target must still be an accepted
friend and must allow `group_invites=friends` or `direct_messages=friends` as
appropriate. A failed final recheck atomically terminates the persisted
operation as `failed/target_unavailable`, marks its still-local mapping
cancelled, and records zero provider attempts. A later restored target requires
a new operation key; exact replay retains the original failure. Stream receives
only server-derived user IDs, fixed channel kind and schema fields, and the
group name. It receives no Alias, Profile code, public-profile ID, wallet, or
Privy subject. No group Alias is preclaimed.

Before this capability can leave `blocked-provider`, real Development accounts
must prove exact membership, direct convergence, group creation, reconciliation,
group Alias projection/leave/rejoin, and client permission denial. Message,
history, read, typing, presence, membership, moderation, and call truth stays in
the official Stream SDK. The detailed frontend contract and polling flow are in
[`frontend-social-chat-api.md`](frontend-social-chat-api.md).

## Approved Hyperliquid native Spot Testnet contract

Decision 0014 approves the following exact owner-scoped contract for one
manually reviewed capped IOC Spot buy or sell. All twelve operations are now
registered in the main Fastify runtime and generated OpenAPI with unavailable
default services. Authentication and strict request validation are reachable;
the default runtime returns a sanitized 503 for every valid authenticated
operation before any domain mutation. This does not claim a provider, signer,
wallet, or execution integration.

| Method and path                                                    | Key contract                                                                                                         | Interface     | Capability                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------- |
| `GET /v1/spot/config`                                              | Fixed Testnet policy, opaque allowlisted markets, review policy, and explicit capability state                       | `implemented` | `blocked-provider`                          |
| `GET /v1/spot/markets/{market_id}/facts`                           | One bounded metadata/book fact set; no raw provider identifier                                                       | `implemented` | `blocked-provider`                          |
| `GET /v1/spot/balances`                                            | Current bound master-account Spot holdings                                                                           | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/intents`                                            | UUID `Idempotency-Key`; business intent only; durable executable quote plus immutable F11 review                     | `implemented` | `blocked-provider`; `blocked-product-legal` |
| `GET /v1/spot/intents/{intent_id}`                                 | Owner-scoped reviewed execution/reconciliation resource                                                              | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/intents/{intent_id}/submit`                         | No body; fresh authority and review validation; one durable provider write attempt at most                           | `implemented` | `blocked-provider`; `blocked-product-legal` |
| `GET /v1/spot/wallet-binding`                                      | Provider-neutral binding state and monotonic epoch; no address or wallet ID                                          | `implemented` | `blocked-provider`                          |
| `PUT /v1/spot/wallet-binding`                                      | Bind, exact refresh, or rotate using only `expected_binding_version`                                                 | `implemented` | `blocked-provider`                          |
| `DELETE /v1/spot/wallet-binding?expected_binding_version={epoch}`  | Compare-and-swap unbind while retaining the monotonic epoch                                                          | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/agent-authorizations`                               | No body/query/client key; issue one server-owned expiring Testnet `approveAgent` handoff                             | `implemented` | `blocked-provider`; `blocked-product-legal` |
| `GET /v1/spot/agent-authorizations/{authorization_id}`             | Owner-scoped sanitized authorization state                                                                           | `implemented` | `blocked-provider`                          |
| `POST /v1/spot/agent-authorizations/{authorization_id}/signatures` | Exact `{signature}` body; verify current owner/digest/Agent/epoch/expiry, journal one relay, then authoritative read | `implemented` | `blocked-provider`; `blocked-product-legal` |

`POST /v1/spot/intents` is the quote/review resource; no separate
`/quotes` route is approved. General order/fill lists, resting orders,
cancel/modify, triggers, TP/SL, TWAP, batch, transfers, withdrawals, bridges,
builder fees, automation, Perp extension, and Mainnet are outside this
contract.

The client can never choose or submit network, account, wallet, Agent, token
index/ID, pair index, Exchange asset, nonce, CLOID, provider idempotency value,
wire action, or order signature. The one authorization-creation response may
contain the server-generated public typed-data fields Privy must sign; the
client cannot edit them, and the signature-submission body still contains only
the opaque signature. The server-generated `agentName` must canonically end in
` valid_until <unix-milliseconds>` matching the displayed persisted expiry,
because Hyperliquid binds Agent expiry through that signed name; its nonempty
base is at most 16 characters and the initial `spot_agent_v1` Testnet policy
caps validity at 24 hours from the database clock. Agent identities use
monotonic generations inside one wallet-binding epoch; an elapsed current
identity is retired before the next generation is allocated. Authorization
status records the historical provider-operation result and is not, by itself,
proof that an Agent remains current. The standalone worker enables this
database-only expiry/retirement maintenance by default; it uses no Privy,
signer, relay, Exchange, or provider-read capability for that path. The contract
and official signing fixtures live under
`contracts/hyperliquid-spot/`. An uncomposed issuance coordinator now performs
policy and wallet-authority checks before and after preflight/allocation. Exact
replay calls no allocator and is confirmed again in PostgreSQL after the second
authority observations. An expired signing handoff reuses its persisted
internal Agent identity, and PostgreSQL remains the only nonce allocator. One
non-renewable, at-most-eight-second admission window covers every pass; the
database re-arms lock/query waits against that absolute deadline before every
guarded SQL statement and commit, then rechecks that an issued or replayed
handoff is still prepared and unexpired. The outer signable envelope retains a
canonical decimal-string nonce, while the official EIP-712 message carries the
exact corresponding JSON safe integer.

The runtime still selects the unavailable service; signature recovery, relay,
and Agent reconciliation remain absent. A dormant repository-only submission
primitive now atomically binds fresh server-only wallet, market, policy, legal,
kill-switch, signer, and reconciliation evidence to exactly one transport
attempt and one persisted Agent nonce. It is not composed into a workflow or
provider-capable service; the registered submit route therefore returns 503,
and only a future first transaction winner may receive the internal execution
material. The PostgreSQL repository can now atomically project that exact
attempt to `unknown`/pending reconciliation for only two server-normalized
ambiguous-response reasons, or quarantine an elapsed attempt with the fixed
`submission_deadline_elapsed` reason. Both transitions update the generic and
Spot projections plus their append-only events in one transaction and preserve
the single nonce allocation. Generic deadline quarantine, reconciliation
leasing, completion, rescheduling, and operator holds all exclude both Spot
intent and Spot Agent authorization operations, so generic recovery cannot
leave either projection split. A dedicated
repository-only Spot intent lane atomically leases `unknown` intents into
`reconciling`, reclaims expired leases with a fresh fence, reschedules both
projections, parks both projections for an operator, and loads only sanitized
read authority. Its generic completion method always fails closed. A
Spot-specific repository finalizer now atomically resolves only a proven full
fill, exact IOC no-fill, or finite Spot rejection. It rechecks the persisted
CLOID, immutable action/review, both record versions, database-clock lease,
full size, exact quote/average-price arithmetic, reviewed IOC price bound,
fee-token identity, observation window, shared operation, Spot projection, and
both append-only histories. Fee display identity uses the same case-sensitive
grammar as the frozen Spot review rather than an uppercase-only database
subset. A negative fee/maker rebate, non-terminating
average-price quotient, partial/open/cancelled result, unknown or incompatible
status, unbounded evidence, or fee-token ambiguity is not automatically
finalized. A strict read-only Spot provider reader and runtime-validating atomic
handler are present. They use five bounded Testnet Info observations, lossless
OID/trade-ID parsing, exact decimal fill aggregation, and a second terminal
authority check before the finalizer. Production composition exposes the lane
only behind the independent default-false
`HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED` worker gate. It uses the Spot
repository as its lease/control plane and shares the process identity, abort
lifecycle, and provider-global quota with the generic worker without enabling
the retained Perp reader. The flag remains off until nonempty Testnet
conformance. Spot Agent
authorization submission recovery is a separate future lane and remains
safely stopped at `submitting` after its generic exclusion. A repository-backed,
uncomposed prepare coordinator now claims the permanent idempotency key before
dependency reads; replay and pending claims perform zero authority, review, or
CLOID work. A first claim resolves short-lived wallet/Agent authority, generates
a 16-byte server CLOID, strictly validates an executable review draft, resolves
authority again, and then invokes the atomic repository prepare method. It may
also return an existing owner-scoped public intent resource. It is not selected
by the main HTTP runtime: the registered routes still use unavailable services
and stop before any claim, submission journal, nonce, signer, or provider work.
The production Testnet authority resolver and pure-read current-Agent repository
path are implemented and tested but remain uncomposed. A real Testnet
metadata/book/fee reviewer and exact Hyperliquid precision formatter are now
implemented and tested but remain uncomposed as well. The reviewer binds BBO,
bounded executable depth, directed slippage-safe price quantization, the
10-quote-token minimum, an injected quote-notional/fee-rate policy, and a hard
dependency deadline into the existing strict draft verifier. It deliberately
does not read balances: funds availability is mutable account evidence for a
fresh submit preflight, not an immutable quote fact. Before runtime composition,
a default-deny product/legal decision must supply the exact policy values and
explicitly compose both adapters. An uncomposed read-only submit preflight now
resolves wallet/Agent authority before and after its reads, binds fresh metadata,
exact available funds, current account taker fees, and a positive aggregate
policy decision to the persisted review, and uses a hard internal deadline. Buy
checks quote availability against the reviewed maximum spend; sell checks base
availability against the reviewed size; a fee above the persisted cap requires
re-prepare. The atomic repository now
exact-matches the owner, Privy subject, wallet ID, address, binding epoch, and
Agent under locks; it rechecks the resolver lease with the database clock after
those waits and after deferred projection checks, and requires active Agent
validity to cover the complete review lifetime. The uncomposed v1 draft verifier
uses exact arithmetic, a 25 bps default/100 bps maximum slippage, a 15-second
review lifetime, 2-second reference freshness, and 15-second fee freshness. Its
quote-denominated `fee_estimate` is a conservative bound: it must cover exact
reviewed notional times `fee_rate` and is included in the displayed maximum
spend or minimum receive. The persisted `fee_rate` is the explicit product
ceiling after a fresh `userFees` observation proves the account rate is no
higher, and the estimate rounds upward to the quote-token atomic unit. Submit
preflight re-reads and rejects any later ceiling breach. Its 2-second private
balance/fee evidence is checked with the database clock before the journal and
after deferred constraints without claiming a balance reservation or
full-attempt lease. Buy maximum spend applies to
every IOC result. Sell minimum receive is the complete-fill amount, and a
partial fill must preserve its proportional net-quote-per-base floor during
authoritative finalization. The just-before-send evidence rule, actual fee-token
and rounding semantics, and bounded partial/full settlement checks remain
composition blockers; the reviewer and preflight do not implement them.
An additional uncomposed submission coordinator verifies the ordering and
fields across preflight -> atomic journal/nonce -> narrow signer -> strict
post-signature write-start guard -> single writer -> normalized unknown
handoff. Before writer invocation, signing failure, guard denial, or an expired
one-second permit is atomically recorded as a sanitized
`rejected/not_required` proven-not-sent result; this is not a provider
rejection. Once writer invocation begins, every resolution or rejection remains
unknown and no write is retried. A conservative
DB-clock budget and the persisted absolute attempt deadline stop writer
admission after a slow signer. The selected `@nktkas/hyperliquid@0.33.3`
low-level surface canonicalizes and signs only the journaled Testnet IOC; a
separate fixed-origin writer sends it at most once and discards bounded
lossless responses into the existing unknown/reconciliation path. Both pass
offline action-hash, EIP-712 digest, signature, and transport tests. They are
not main-app composed and do not prove a real Privy Agent signer, provider write, or
credentialed prepare/submit E2E. The strict Info reader is a real read adapter,
but the reviewer, preflight, and final guard still have only local
injected-evidence verification. Production terminal outcomes and provider
writes remain unavailable until Agent authorization, a real final guard,
policy, settlement-bound reconciliation, and credentialed Testnet gates pass.
Decision 0020 freezes further Hyperliquid product work after this verified
safety slice pending an explicit scope decision.

## Perp wallet-binding lifecycle

The current principal may explicitly bind only a unique eligible Privy embedded
Ethereum wallet, or refresh the exact wallet already stored for that principal.
The current slice supports the master account only; interactive selection among
multiple eligible wallets and subaccounts is not approved.

| Method and path                                                   | Key contract                                                                                         | Interface     | Capability    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| `GET /v1/perp/wallet-binding`                                     | Non-writing state/version read                                                                       | `implemented` | `implemented` |
| `PUT /v1/perp/wallet-binding`                                     | Bind, refresh, or rotate using only `expected_binding_version`                                       | `implemented` | `implemented` |
| `DELETE /v1/perp/wallet-binding?expected_binding_version={epoch}` | Unbind while retaining and incrementing the monotonic authority epoch; no body or idempotency header | `implemented` | `implemented` |

Responses contain only `state`, `binding_version`, fixed-or-null
`account_kind`, and `last_verified_at`. No route accepts or returns a wallet
address, wallet ID, Privy DID, owner ID, network, DEX, or client-selected
authority. Every explicit PUT re-reads Privy; every private read revalidates the
exact stored wallet into a 15-second server-only lease.

## Hyperliquid Testnet private routes

Private reads use the exact server-verified master wallet binding, never an
agent or client-supplied address. Without it they return
`wallet_binding_required` before quota or Hyperliquid work. All routes are Core
BTC/ETH/SOL and Testnet only.

| Method and path          | Key contract                                                                                                        | Interface     | Capability                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------- |
| `GET /v1/perp/config`    | Network, Core allowlist, sourced/fetched/expires provider constraints, and explicit read/mutation capability states | `implemented` | `implemented`; default-off, E2E unverified      |
| `GET /v1/perp/account`   | Strict private account projection; decimal strings                                                                  | `implemented` | `implemented`; default-off, E2E unverified      |
| `GET /v1/perp/positions` | Strict position projection; bounded limit/opaque cursor where paginated                                             | `implemented` | `implemented`; default-off, nonempty unverified |
| `GET /v1/perp/orders`    | Strict current open-limit-order projection; bounded limit/opaque cursor                                             | `implemented` | `implemented`; default-off, nonempty unverified |
| `GET /v1/perp/fills`     | Strict recent fills projection with bounded coverage; bounded limit/opaque cursor                                   | `implemented` | `implemented`; default-off, nonempty unverified |
| `GET /v1/perp/funding`   | Strict recent user-funding ledger with bounded coverage; bounded limit/opaque cursor                                | `implemented` | `implemented`; default-off, nonempty unverified |

Stale, malformed, non-Core, nonempty-dex, spot, HIP-3, or unknown provider data
is unavailable rather than coerced to an empty or zero-valued success. Public
market data remains a direct read-only Flutter/provider concern and is not
proxied by these routes.

Config facts expire within 60 seconds and private snapshots within two seconds.
Positions accept an initial limit of 1–3; the other lists accept 1–50, default 20. A continuation cursor cannot be combined with a limit and is valid for ten
minutes. AES-256-GCM hides the provider continuation, including any authority a
malformed adapter might place inside it; an outer HMAC explicitly binds Testnet,
Core perps, empty DEX, owner, current wallet, binding version, route, and
original limit. Fills and user funding report `recent_window` coverage and
whether the provider-bounded window is truncated; they are never described as
complete history.

The resolver never guesses among multiple wallets, and the zero address is not
an empty-account fallback. With no binding, the routes return
`wallet_binding_required`; with private reads disabled or any stale/malformed
provider fact, they return `perp_unavailable`. When explicitly enabled, a
lossless narrow adapter posts only allowlisted requests to the compiled Testnet
Info URL and reserves a PostgreSQL global weighted quota first. No signer-capable
Hyperliquid Node/TypeScript SDK, configurable provider URL, Exchange action,
WebSocket, Mainnet, or mutation path has been installed.

### Perp intent and reconciliation

| Method and path                            | Key contract                                                                                                                                                                                       | Interface     | Capability                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------- |
| `POST /v1/perp/intents`                    | UUID `Idempotency-Key`; exact union of `order`, `cancel`, `modify`, `batch_modify`, `update_leverage`, or `update_isolated_margin`; returns server intent ID, immutable review, expiry, `prepared` | `implemented` | `blocked-product-legal`                                     |
| `POST /v1/perp/intents/{intent_id}/submit` | Owner-bound path ID; no body; checks expiry and the action-specific default-deny gate; no signer or Exchange adapter is composed                                                                   | `implemented` | `blocked-product-legal`                                     |
| `GET /v1/perp/intents/{intent_id}`         | Owner-bound durable status/reconciliation projection                                                                                                                                               | `implemented` | limit-`order` readback default-off; nonempty E2E unverified |

Status is one of `prepared`, `submitting`, `accepted`, `partial`, `filled`,
`cancelled`, `rejected`, `unknown`, `reconciling`, or `expired`. A repeated
owner/key/digest returns the same intent; a changed digest or owner conflicts
before provider work. Client timeout never authorizes resubmission. There is no
submit executor or transport journal writer. A separately enabled worker can
only consume an already-unknown Core limit `order`, read strict cloid-bound
Testnet Info evidence, and atomically finalize its generic operation plus Perp
intent/items. It cannot create or replay that provider write.

The idempotency owner/digest reservation commits before reviewer work. The
generic operation journal, immutable review, generated cloids, sanitized events,
and item identity then finalize atomically in PostgreSQL. Unfinished claims are
bounded per owner and by a service-wide fuse, and persist their explicit
`perp_intent_request_v1` digest version. Ordinary review facts may be at most 60
seconds old; a market-order quote may be at most two seconds old. Wallet
authority is resolved again after review latency. The real wallet resolver is
composed when Privy is configured, but the reviewer remains unavailable, and
every production submit is denied with `perp_mutation_disabled` before a wallet
re-resolution, reviewer, signer, SDK, or provider write. Tests may inject review
fixtures, but no Hyperliquid mutation SDK or executor is installed. The
read-only domain finalizer accepts only exact Core limit-`order` evidence;
market orders, `modify`, `batch_modify`, `cancel`, `update_leverage`, and
`update_isolated_margin` are operator-held before provider reads. Nonempty
Testnet-account conformance and a deployed worker remain mandatory evidence
gates.

### Testnet agent authorization

| Method and path                                                    | Key contract                                                                                                                     | Interface     | Capability              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- |
| `POST /v1/perp/agent-authorizations`                               | No body/query/client key; default 403 before allocation, persistence, formatting, signing, or provider work; deliberately no 2xx | `implemented` | `blocked-product-legal` |
| `POST /v1/perp/agent-authorizations/{authorization_id}/signatures` | Strict owner-bound opaque signature input; prepared state stops at the default-deny gate before recovery or relay                | `implemented` | `blocked-product-legal` |
| `GET /v1/perp/agent-authorizations/{authorization_id}`             | Owner-bound sanitized durable status projection                                                                                  | `implemented` | `blocked-provider`      |

The future audited workflow must derive account, network, Agent, typed-data
primary type, digest, and expiry server-side. Arbitrary typed data or URLs,
altered fields, Mainnet, transfers, withdrawals, and builder approval are
rejected. Missing formatter, nonce-continuation, signature-recovery, credential,
and Testnet evidence blocks issuance of signable payloads. The current service
has no path to its durable `persistIssued` boundary and implements no relay or
reconciliation transition; `unknown` is a reserved future lifecycle state, not
evidence that an ambiguous relay has occurred.

## Privy same-chain transfer routes

All six routes are `implemented` with `blocked-provider` capability. They use
Native Privy Bearer authentication and an existing internal principal while
retaining only the exact reviewed top-level variants from
`contracts/privy-transfer/bff-contract.json`. Current OpenAPI contains no
transfer 2xx schema: every otherwise valid authenticated request returns 503
`transfer_unavailable` with no durable or provider side effect.

| Method and path                         | Current request boundary                                                                                                                                 | Current result                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `GET /v1/transfer/assets`               | No body/query/client idempotency header                                                                                                                  | 503; no asset-selection projection |
| `POST /v1/transfer/recipient-preflight` | resolve: `command`, `asset_selection_id`, `recipient_input`; acknowledge: `command`, `preflight_handle`, exact acknowledgement enum                      | 503; no preflight session          |
| `POST /v1/transfer/reviews`             | `preflight_handle`, positive canonical string `amount_decimal`                                                                                           | 503; no prepared review            |
| `POST /v1/transfer/authorize`           | issue: `command`, `prepared_review_handle`; submit: `command`, `prepared_review_handle`, nonempty opaque signature, lowercase formatter-envelope SHA-256 | 503; no formatter payload or relay |
| `GET /v1/transfer/current-result`       | No body/query/handle/cursor/client idempotency header                                                                                                    | 503; no current-result projection  |
| `GET /v1/transfer/reconciliation`       | No body/query/handle/cursor/client idempotency header                                                                                                    | 503; no reconciliation projection  |

Owner, wallet/provider IDs, wallet epoch, provider URL/action/submission IDs,
nonce, expiry, idempotency key, risk verdict, cursor, and provider payload remain
server-owned future facts. Unknown top-level fields, client `Idempotency-Key` or
provider signed headers, and JSON numbers for `amount_decimal` are rejected
before authentication. Unresolved nested JSON recursively rejects the exact
names in the reviewed `forbidden_client_keys` list; it does not claim to infer
unreviewed aliases. Handle and nested projection shapes remain deliberately
unresolved rather than guessed.

The reviewed material-change, durable write-before-transport, single
byte-identical replay, unknown-status quarantine, and fenced reconciliation
rules remain future implementation gates. The current runtime creates no
transfer session, idempotency record, submission, audit event, replay material,
result, or reconciliation lease and performs no formatter, signer, resolver,
screening, polling, or provider call.

## Excluded and unassigned surfaces

The following are `explicitly-disabled`: Pay and payment processing, on-ramp or
off-ramp, settlement and payment webhooks, Hyperliquid Mainnet, deposits,
withdrawals, automated trading or trading automation, HIP-3, trigger orders,
TP/SL, TWAP, builder fees, and public Hyperliquid market proxying.

Push device registration, a notification inbox, alert activation/evaluation,
Support, general public-profile detail, following/followers, blocklist,
unfriend, wallet or QR search, alias history, cross-group correlation,
backend-managed group membership, and interactive multiple-wallet selection
have no approved complete runtime contract. Decisions 0024 and 0025 approve
only the exact Alias, explicit friend-consent, accepted-friend, and
backend-created group/direct surfaces above; they do not imply follow/block,
relationship revocation, contacts, or arbitrary social lookup. Privy OTP/wallet
creation, Stream messages/calls/moderation, and provider `/info`, `/exchange`,
or `/ws` operations remain official SDK/provider surfaces rather than
client-callable LOOP routes.

For V2, BSC chain facts, verified USD1/PancakeSwap configuration, Asset
Registry/Indexer, Market, Wallet, ordinary Privy Swap, Send/Approvals, Launch,
Mining, Firebase delivery, Pay, Bridge, DApp execution, and Community AI remain
deferred or unavailable. The metadata capability projection reports that state;
it does not create an executable contract for any of those modules.
