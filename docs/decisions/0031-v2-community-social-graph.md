# Decision 0031: V2 community, social graph, and search

- Status: Accepted
- Date: 2026-09-08
- Scope: S3/D3–D6 backend (`community` and `search` modules). The main-agent
  rulings of 2026-09-07 in `LOOP/docs/modules/S3-community-skeleton.md` are
  adopted verbatim below, plus three implementation rulings of 2026-09-08.
  The user may overturn any row.

## Context

Login lands in `community` (Decision 0026), but until now the module had no
runtime: `v2ModuleRegistrars.community` was `null` and every path answered
`NOT_FOUND`. The nine S3 pages (`community`, `community-discover`,
`community-profile`, `community-members`, `search`, `connections`,
`blocklist`, `dm-requests`, `referral`) need a community entity, a
three-tier governance model, a follow graph, a block list, a V2 view of the
existing stranger-request storage, and a bounded global search — all of it
backed by checkable facts, with every derived number that has no backend
(mining power, presence, unread, live voice, referral edges) reported as
`unavailable` rather than as a fixture or a zero.

Decision 0030 delivered the LOOP ID, the V2 profile, and
`privacy_preferences_v2.discoverable`, but noted that "no V2 search consumes
it yet". This decision is the consumer.

## Rulings adopted (main agent, 2026-09-07)

| Topic                      | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Community entity           | PostgreSQL is the truth for Community/Membership/Role/audit. `communityId` is an opaque UUID. Fields: `name` (1–40 code points, alias safety rules), `slug` (unique, `^[a-z0-9-]{3,32}$`), `description` (≤280), `logoRef` (`avatar:preset/community-<slot>` or null), `verificationStatus` (`pending\|verified\|rejected`), `boundAssetKey` (nullable, canonical `eip155:<chainId>:<0x lowercase>`, stored but not resolved before D10), `memberCount` (server-maintained), `createdAt`, `configVersion`. |
| Roles                      | Three tiers `owner \| admin \| member`. The 03 document's "Admin/Moderator" is one tier (`admin`) in this step; no custom roles and no channels.                                                                                                                                                                                                                                                                                                                                                           |
| Permission matrix[^matrix] | Owner: appoint/revoke admin, transfer ownership, mute, ban, edit. Admin: mute and ban members, approve joins. Member: view, join, leave. Every change appends an `audit_events` row with `RoleChanged` semantics.                                                                                                                                                                                                                                                                                          |
| Community source           | Users apply with `POST /v2/communities`, which creates a `pending` community with the applicant as owner. `verified` is set only by the Dev-only operator script `pnpm community:verify <communityId>`, which writes an audit row. Admin console and RBAC land in D17.                                                                                                                                                                                                                                     |
| Discovery list             | `GET /v2/communities?sort=members\|newest&verification=verified\|all`. Ordering uses only checkable facts (member count, creation time); "highest mining power", "fastest growing", and "most discussed" have no backend and are not offered. The response carries a `recommendationId` and the versioned rule `rule:verified-members-v1`.                                                                                                                                                                 |
| Home aggregate             | `GET /v2/community/home` returns `joined[]`, `discover[]` (≤5), `unread: unavailable` (Stream not connected), `liveVoice: unavailable`, and `freshness`.                                                                                                                                                                                                                                                                                                                                                   |
| Follow graph               | New directed graph: `POST/DELETE /v2/connections/follow/{publicProfileId}` and `GET /v2/connections?direction=following\|followers`. No consent is required. A blocked or non-discoverable target returns one non-enumerating error. The V1 friend graph stays for chat and folds in at D7.                                                                                                                                                                                                                |
| Blocks[^blocks]            | `POST/DELETE /v2/blocks` with `{kind: user\|contract\|domain, stableId}`. Only `user` is implemented; `contract` and `domain` return `CAPABILITY_UNAVAILABLE`. A block outranks following and DM: it removes both follow edges and rejects the DM request.                                                                                                                                                                                                                                                 |
| Stranger requests          | `dm-requests` reuses the V1 `friend_requests` storage, adapted as `GET /v2/message-requests` and `POST /v2/message-requests/{id}/decision {accept\|ignore\|report}`. `report` = reject + block + audit. AI moderation is `unavailable` in this step.                                                                                                                                                                                                                                                       |
| Search                     | `GET /v2/search?domain=users\|communities\|assets\|launch\|dapps&q=&cursor=`. `users` and `communities` are implemented; the other three answer `{status: "unavailable", reasonCode}`. Results carry `{resultType, stableId, displaySnapshot, destination}`. The alias prefix rules and the public search quota are reused. Chat content never enters this domain.                                                                                                                                         |
| Referral page              | Read-only. The five levels 10/5/3/2/1 and the rule copy come from `GET /v2/mining/referral/rules` (versioned static configuration). `edges` and `inviteCode` are `unavailable` until D19.                                                                                                                                                                                                                                                                                                                  |
| Member/online/unread       | Member counts come from PostgreSQL. Online counts, unread counts, and voice-room state are `unavailable` until Stream is connected; no fixture is shown.                                                                                                                                                                                                                                                                                                                                                   |

[^matrix]:
    Two rights in this row are not what the routes below deliver, so they are
    pinned here rather than left contradictory. **`approveJoin` is deferred**:
    this step has no pending-membership state and communities are open-join,
    so an admin never approves anything; gated joins arrive with the Admin
    console in D17. **`edit` is delivered by `PATCH /v2/communities/{id}`**
    and is owner-only, so it appears in the matrix as the `editProfile` self
    action rather than as an action on another member.

[^blocks]:
    In this step a block is enforced on the **read** side: it hides the two
    accounts from each other's connection lists, user search, follow, and
    message-request list, removes both follow edges, and refuses to accept a
    message request across it. There is no V2 send surface yet, so **write-side
    interception lives in the D7 V2 messaging routes**; the frozen V1 friend
    request and channel creation paths are deliberately unchanged.

## Implementation rulings (main agent, 2026-09-08)

1. **Unactivated profile is its own error code.** An account can be
   bootstrapped (it has a `loop_users` row and a LOOP ID) and still have no
   activated V2 profile, in which case it has no `public_profile_id` to
   project and cannot appear in a member list, a follow edge, or a search
   result. That is neither an authorization refusal (`POLICY_BLOCKED`) nor a
   bootstrap failure. The catalog gains
   `PROFILE_ACTIVATION_REQUIRED` (409, `conflict`, not retryable,
   `errors.profile.activationRequired`) and, for a slug that another community
   already holds, `RESOURCE_CONFLICT` (409, `conflict`, not retryable,
   `errors.conflict.resource`), bringing it to 30 codes. The client
   routes the user to `loop-id-setup` and retries; Decision 0029's table and
   `docs/api-v2-conventions.md` are updated.
2. **Follow and user search require `discoverable = true`.** The ruled
   "blocked or undiscoverable targets are uniformly unavailable" is
   implemented as `privacy_preferences_v2.discoverable = true` on the target
   for `POST /v2/connections/follow/{id}` and `GET /v2/search?domain=users`.
   Because that preference is fail-closed and defaults to `false`
   (Decision 0030), an account must opt in before it can be followed or
   found. Reading a member directory, blocking, and unfollowing do not
   require it: hiding must never trap an existing relationship.
3. **The V1 `friend_requests` table and state machine are reused, not the V1
   service.** `GET /v2/message-requests` and the decision command read and
   write `public.friend_requests` (and `public.friendships` on accept) with
   the same transition guard trigger, but they do not call
   `SocialService.decideFriendRequest`. Two reasons: the V1 resource shape
   projects `profile_code`, which V2 must never publish; and `report` must
   apply reject + block + audit in one transaction, which composing the V1
   service cannot provide. The V1 routes, service, and `social_operations`
   idempotency domain are untouched.

## Decision

### Persistence (migration `000016_v2_community_social`, append-only)

Six relations, all registered in `src/database/schema.ts`:

- `communities` — the entity above. `name_search_key` is a stored generated
  column over `loop_alias_search_key_unicode17_v1(name)` so community search
  shares the alias normalization. Check constraints enforce the ruled name,
  slug, description, logo, verification, and canonical asset-key shapes;
  `verified_at` is null unless `verification_status = 'verified'`.
- `community_memberships` — `unique (community_id, owner_user_id)`, a partial
  unique index on `(community_id) where role = 'owner'`, `role`, `status`
  (`active|muted|banned`), `joined_at`, `record_version`. An owner row is
  always `active`. A banned row is retained so the account cannot rejoin.
- `community_role_events` — append-only audit; one row per creation,
  verification, join, leave, role change, mute, unmute, ban, and unban, with
  `from_role/to_role/from_status/to_status`, `actor_type` (`member|operator`),
  and a unique `idempotency_record_id`.
- `follow_edges` — `primary key (follower_user_id, followee_user_id)` with a
  self-follow check.
- `user_blocks` — `unique (owner_user_id, kind, stable_id)`, `kind`,
  `target_user_id` (non-null exactly for `kind = 'user'`), `reason_code`.
- `social_graph_events` — append-only follow/block/message-request audit with
  a unique `idempotency_record_id`.

Accepting a message request across a block in either direction is
`DATA_STALE`: no friendship is created. The member directory left joins
`user_profiles`, so a membership whose profile row is missing is still listed
and still counted (its `publicProfileId` is `null` and it can never be a
governance target), keeping the page and the server counts consistent.

`member_count` is maintained by an `after insert or update of status or
delete` row trigger on `community_memberships` that updates
`communities.member_count`. The update takes the community row lock inside
the same transaction, so concurrent joins can neither lose nor double count
(integration-tested with eight parallel joins). Banned rows are excluded.

`idempotency_records.digest_version` gains `community_command_v1` and
`social_graph_command_v1`. Rollback refuses while any community, membership,
audit, follow edge, block, or command record exists.

### Permission matrix

`src/features/community/community-policy.ts` is a pure lookup table with no
I/O. The routes, the PostgreSQL repository, and the tests all read the same
values, so widening a right requires changing this table.

| Actor \ action | assignAdmin | revokeAdmin | transferOwnership | mute          | unmute        | ban           | unban         | leave (self) |
| -------------- | ----------- | ----------- | ----------------- | ------------- | ------------- | ------------- | ------------- | ------------ |
| `owner`        | member      | admin       | admin, member     | admin, member | admin, member | admin, member | admin, member | no           |
| `admin`        | —           | —           | —                 | member        | member        | member        | member        | yes          |
| `member`       | —           | —           | —                 | —             | —             | —             | —             | yes          |

Each cell lists the target roles the actor may act on; `—` is empty.
Additional invariants encoded in the same module:

- `owner` never appears as a target role, so an owner cannot be downgraded,
  muted, or banned by anyone. Ownership changes only through
  `transferOwnership`, which also demotes the previous owner to `admin`.
- An owner cannot leave; it must transfer first (`PERMISSION_DENIED`).
- `editProfile` (`PATCH /v2/communities/{id}`) is owner-only and changes only
  the keys present in the body; `slug` and `verificationStatus` are immutable
  through it, and each edit appends a `community_profile_updated` audit row.
- A ban is community scoped. It does not touch the personal follow graph;
  only `POST /v2/blocks` removes follow edges.
- Self-targeting a governance action is always denied.
- A banned actor has no standing. A muted actor keeps governance standing,
  because mute only silences chat, which Stream owns.
- A transition the stored state does not allow (muting a muted member,
  revoking a non-admin, unbanning an active member) is `DATA_STALE`, not a
  permission failure: the caller refreshes and decides again.
- The member directory returns `viewer: {membership, canInviteAdmin, canMute,
canBan}` derived from the same table.

### Routes

`community` module (`src/routes/v2/community.ts` + `social.ts`), `search`
module (`src/routes/v2/search.ts`). A module not listed in
`V2_MODULES_ENABLED` registers no route and every path is the V2 `NOT_FOUND`
envelope (tested). Every write requires exactly one canonical UUIDv4
`Idempotency-Key`; every read rejects one.

| Method   | Path                                                  | Semantics                                                                           |
| -------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET`    | `/v2/community/home`                                  | `joined[]`, `discover[]` (≤5), `unread`/`liveVoice` unavailable, `freshness`        |
| `GET`    | `/v2/communities`                                     | `sort=members\|newest`, `verification=verified\|all`, cursor page, `recommendation` |
| `POST`   | `/v2/communities`                                     | Apply; creates `pending` with the applicant as owner; 201                           |
| `GET`    | `/v2/communities/{communityId}`                       | Record header + viewer permissions; mining/presence/announcements/links unavailable |
| `POST`   | `/v2/communities/{communityId}/join`                  | Idempotent join; banned is `PERMISSION_DENIED`                                      |
| `DELETE` | `/v2/communities/{communityId}/membership`            | Leave; owner is `PERMISSION_DENIED`; no membership is `DATA_STALE`                  |
| `GET`    | `/v2/communities/{communityId}/members`               | `role=all\|owner\|admin`, owner→admin→member then `joinedAt`, server counts         |
| `POST`   | `/v2/communities/{id}/members/{publicProfileId}/role` | `{role}` → assignAdmin / revokeAdmin / transferOwnership                            |
| `POST`   | `/v2/communities/{id}/members/{publicProfileId}/mute` | Mute                                                                                |
| `DELETE` | `/v2/communities/{id}/members/{publicProfileId}/mute` | Unmute                                                                              |
| `POST`   | `/v2/communities/{id}/members/{publicProfileId}/ban`  | Ban; also drops the follow edges between actor and target                           |
| `DELETE` | `/v2/communities/{id}/members/{publicProfileId}/ban`  | Unban (removes the retained membership row)                                         |
| `POST`   | `/v2/connections/follow/{publicProfileId}`            | Follow                                                                              |
| `DELETE` | `/v2/connections/follow/{publicProfileId}`            | Unfollow (idempotent)                                                               |
| `GET`    | `/v2/connections`                                     | `direction=following\|followers`, counts, cursor page                               |
| `GET`    | `/v2/blocks`                                          | `kind=user`; `contract`/`domain` are `CAPABILITY_UNAVAILABLE`                       |
| `POST`   | `/v2/blocks`                                          | Block a user; removes both follow edges in the same transaction                     |
| `DELETE` | `/v2/blocks`                                          | Unblock; never restores a follow edge                                               |
| `GET`    | `/v2/message-requests`                                | Pending incoming requests; preview and AI moderation unavailable                    |
| `POST`   | `/v2/message-requests/{messageRequestId}/decision`    | `accept` / `ignore` / `report`                                                      |
| `GET`    | `/v2/search`                                          | `users`/`communities` live; `assets`/`launch`/`dapps` answer 200 + `unavailable`    |
| `GET`    | `/v2/mining/referral/rules`                           | Versioned static rule snapshot under the community module                           |

The V2 artifact carries 34 operations under `/v2` (36 total with the two
shared `/health/*` endpoints); 23 of the `/v2` operations are new in this
decision.

`GET /v2/mining/referral/rules` deliberately lives in the community module
rather than in a new `mining` module: it is a read-only product constant with
no mining runtime behind it, and creating a half-empty `mining` module would
claim readiness the backend does not have.

### Read visibility

A community that is not `verified` is visible only to its creator and to its
own non-banned members. Discovery, community search, `GET /v2/communities/{id}`,
and the member directory all apply the same predicate, so an unverified
community cannot be enumerated through any read surface. Joining only requires
the community to exist, because the joiner becomes a legitimate reader by that
command.

### Identity projection

Every V2 projection here uses exactly
`{publicProfileId, loopId, alias, avatarRef}`. `profile_code` (V1 only),
wallet addresses, Privy subjects, and Stream IDs never leave the repository.
`freezeIdentity` re-validates the shape before serialization and fails closed
(`CAPABILITY_UNAVAILABLE`) rather than publishing an out-of-contract value.

### Idempotency, cursors, and quotas

- Every write claims a durable `idempotency_records` row bound to owner,
  scope (`v2_community_command` / `v2_social_graph_command`), key source, and
  the canonical SHA-256 digest of (domain, operation, contract version,
  normalized inputs). The same key with different input is
  `IDEMPOTENCY_CONFLICT`; an identical replay finds the original audit row
  and returns the current resource without repeating the state change.
- Lists use `src/core/http/v2-cursor.ts` with the owner ID, a per-route name,
  and a canonical sorted filter string. The page size travels inside the
  encrypted continuation, so `limit` and `cursor` are mutually exclusive and a
  cursor cannot be widened. A cursor from another account, route, or filter is
  `INVALID_REQUEST`.
- `verification` narrows only the `communities` search domain, so it is not
  bound into a `users` cursor: an unrelated query parameter cannot invalidate
  a page mid-pagination.
- `GET /v2/search` consumes the same `public_alias_search` quota bucket as
  `GET /v1/discovery/users` for both live domains, and reuses
  `parseAliasSearchPrefix` for normalization and the 2–40 code-point bound.
  The three deferred domains consume no quota.

### Capabilities

`GET /v2/meta/capabilities` grows from 18 to 21 entries:

| Capability          | State                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `community`         | `available` only with the module enabled, the PostgreSQL repository composed, and a `cursorCodec`; otherwise `unavailable` (`COMMUNITY_RUNTIME_UNAVAILABLE`) or `deferred` (`V2_COMMUNITY_RUNTIME_DEFERRED`) |
| `search`            | as above plus the public search quota; `SEARCH_RUNTIME_UNAVAILABLE` / `V2_SEARCH_RUNTIME_DEFERRED`                                                                                                           |
| `communityMining`   | always `unavailable` (`MINING_FORMULA_BASELINE_PENDING`)                                                                                                                                                     |
| `communityPresence` | always `unavailable` (`STREAM_PRESENCE_NOT_CONNECTED`)                                                                                                                                                       |

Without `V2_CURSOR_HMAC_SECRET` the module fails closed rather than serving
unsigned pagination.

### Operator path

`scripts/community-verify.ts` (`pnpm community:verify <communityId>
[reasonCode]`) reads `.env.local`, refuses to run when `NODE_ENV=production`
before opening any connection, sets `verification_status = 'verified'` with
`verified_at`, and appends a `community_verified` audit row with
`actor_type = 'operator'`. It is the only way to verify a community; the API
has no self-serve path.

## Consequences

- The community module is registered and `available` on local configuration
  alone. That is not Provider or device readiness: mining, presence, unread,
  live voice, announcements, official links, referral edges, invite codes,
  and the three deferred search domains all stay `unavailable` and the client
  must render them as such.
- An account with no activated V2 profile cannot create, join, or follow.
  Integration flows must run `POST /v2/profile/loop-id` first.
- Because `discoverable` is fail-closed, a second account is invisible to
  follow and user search until it sets `PUT /v2/profile/privacy`
  `{discoverable: true}`. Integration scripts must do that explicitly.
- The V1 friend graph, its routes, and its `social_operations` idempotency
  domain are unchanged; `GET /v2/message-requests` is a second reader of the
  same table. D7 folds the two graphs together.
- `boundAssetKey` is stored and echoed but never resolved: no price, supply,
  holder, or Token Card fact is implied before D10.

## Rollback

Remove `community` and `search` from `V2_MODULES_ENABLED`: every route
disappears, the two capabilities return to `deferred`, and
`communityMining`/`communityPresence` stay `unavailable`. The migration rolls
back only while no community or social-graph data exists.
