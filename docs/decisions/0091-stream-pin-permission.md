# Decision 0091: Community pin permission through Stream channel roles, and `/c/{communityId}/room` links

- Status: Accepted (S99b; main-agent task sheet 2026-09-28). The Stream grants change itself is **not applied**; see "Operator actions".
- Date: 2026-09-28
- Scope: the Stream channel role of official community channel members (Decisions 0032, 0055); the `community-channel-sync` lane and `governMember`; three operator scripts; `GET /.well-known/apple-app-site-association` components (amends Decision 0090); new `GET /c/{communityId}/room` landing page. No migration, no new table, no new `/v2` route, no new API error code, no response-shape change.

## Context

Requester feedback: in a community group chat any member can "pin" a message. Pinning is a Stream Chat capability decided by the grants of the Stream channel type; LOOP only has community roles (`owner` / `admin` / `member`, Decision 0031).

## Audit (read-only, 2026-09-28)

`pnpm stream:channel-type-audit` against the Stream app configured in the local `loop-api/.env.local` (only `getChannelType` + `listPermissions`):

- Channel type: every LOOP chat channel — official community (`loop_community_*`, Decision 0032), friend group (`loop_group_*`) and direct (`loop_direct_*`, Decision 0025) — is Stream type **`messaging`**.
- Channel role on join: `add_members` sent `{user_id}` (plus persona `custom`) with **no `channel_role`**, and `getOrCreate` added the creator the same way, so every member, including the owner, was a Stream default **`channel_member`**. No code path ever assigned a channel role.
- Grants of `messaging`:

| Action (Stream permission IDs)                                         | Roles holding it                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PinMessage` (`pin-message`, `-any-team`, `-owner`, `-owner-any-team`) | `admin`, **`channel_member`**, `channel_moderator`, `moderator`: `pin-message`; **`user`**: `pin-message-owner`; `global_admin`, `global_moderator`: `pin-message-any-team` |
| `UnpinMessage`                                                         | no such permission in the catalog: unpinning is governed by the `PinMessage` grants                                                                                         |
| `DeleteAnyMessage` (`delete-message`, `-any-team`)                     | `admin`, `channel_moderator`, `moderator`, `global_admin`, `global_moderator` (not `channel_member`)                                                                        |
| `UpdateAnyMessage` (`update-message`, `-any-team`)                     | `admin`, `channel_moderator`, `moderator`, `global_admin`, `global_moderator` (not `channel_member`)                                                                        |

So the reported bug has two independent causes: `channel_member` holds `pin-message` (any message), and the app role `user` holds `pin-message-owner` (own message). Stream grants the union of the app-role and channel-role grants, so both must go.

## Decision

### 1. Role mapping

`communityStreamChannelRole(role, status)` in `community-policy.ts` is the one mapping:

| Community membership      | Stream channel role  |
| ------------------------- | -------------------- |
| `owner` (active or muted) | `channel_moderator`  |
| `admin` (active or muted) | `channel_moderator`  |
| `member`                  | `channel_member`     |
| banned (any role)         | removed from channel |

Mute does not change the channel role (mute is enforced by LOOP, Decision 0031).

### 2. Sync points (all through the existing outbox, Decision 0032)

- **Join / verification / unban** — the existing `add` job. `claimDueJobs` now also returns `memberChannelRole`, derived **at claim time** from the current `community_memberships` row, so a job enqueued before a later role change applies the latest role. The worker passes it to `addMembers({..., channelRole})`; the gateway sends `channel_role` on `add_members` and then one `assign_roles` update, because Stream keeps the role of a member that is already in the channel. An `assign_roles` echo that contradicts the requested role is `unavailable` (retried); a member not echoed is accepted.
- **Role change** — `governMember` (`POST /v2/communities/{id}/members/{publicProfileId}/role` and transfer) enqueues an `add` for the target whenever the mapped channel role changes (`assignAdmin`, `revokeAdmin`, `transferOwnership` of a member). `add` is idempotent, so it only (re)assigns the role and re-attaches the persona. A transfer between two moderators (admin → owner, and the outgoing owner → admin) enqueues nothing. Mute/unmute enqueue nothing.
- **Leave / ban** — the existing `remove` job; the role disappears with the membership, no role call is made.

A `channelRole` is only accepted for a `loop_community_*` channel; group and direct channels are unchanged.

### 3. Grants (operator script, not applied here)

`pnpm stream:channel-type-grants` computes, for type `messaging`:

- every `PinMessage` / `UnpinMessage` permission (all four variants) is removed from every role other than `admin` and `channel_moderator`;
- `admin` and `channel_moderator` keep (or, if they had none, get `pin-message`);
- every other grant of every role is left exactly as it was; only the changed roles are sent, each with its complete next list.

Dry-run on 2026-09-28 (the diff `--apply` would write):

```
Stream channel type messaging: pin/unpin grant diff
  channel_member      - pin-message
  global_admin        - pin-message-any-team
  global_moderator    - pin-message-any-team
  moderator           - pin-message
  user                - pin-message-owner
```

After `--apply` the script re-reads the type and exits `1` if the pin diff is not empty (`stream_channel_type_grants_not_converged`) or if any non-pin grant of any role changed (`stream_channel_type_grants_collateral_change`).

`DeleteAnyMessage` / `UpdateAnyMessage` are already moderator-only; with the role mapping above, community owners/admins gain them in their own community channel (Stream delete/edit of others' messages). That is consistent with governance (Decision 0031) and is reported, not changed.

### 4. Backfill of existing members

`pnpm community:stream-roles-backfill` reads every `synced` member of a provisioned official channel (non-banned) with its mapped role, reads Stream's current `channel_role` with a read-only `queryMembers` (≤100 per call, filter `id $in`), and prints each difference. `--apply` sends one `assign_roles` per channel batch, acting as the channel creator. A member Stream does not report is counted as "not in the Stream channel" and left to the sync lane. `--max N`, 200 ms pacing. Re-running is safe; a role change that races the backfill is corrected by its own `add` job or by the next run.

### 5. `/c/{communityId}/room` links (amends Decision 0090)

- AASA `components` becomes `[{"/":"/u/*"},{"/":"/c/*"}]`. `assetlinks.json` is unchanged (it is domain-wide; path filters live in the Android manifest).
- `GET /c/{communityId}/room`: static HTML with the `/u/` headers (`text/html; charset=utf-8`, `public, max-age=3600`, CSP `default-src 'none'`, `no-referrer`, `noindex`), "语音房邀请", optional "下载 LOOP" from `APP_DOWNLOAD_URL`. It never reads the database and never echoes the community ID. Anything other than a canonical lower-case UUIDv4 → `404` "链接无效", `no-store`. `hide: true`, not in OpenAPI.

## Unavailable behaviour

- Without Stream credentials the community gateway stays the unavailable gateway: jobs retry as before, and the two new gateway methods reject `unavailable`. No role is ever assumed.
- The three scripts refuse (exit 1, sanitized code) without `STREAM_API_KEY`/`STREAM_API_SECRET` (and `DATABASE_URL` for the backfill); they print no secret and no provider payload beyond role names and permission IDs.
- The landing page has no unavailable state.

## Consequences

- Until the grants script is applied, the mapping changes nothing visible: `channel_member` can still pin. The role sync can ship first; the grants change is the switch.
- **The `messaging` grants are shared with friend groups and direct chats.** After `--apply`, nobody pins in a group or a direct chat (all their members are `channel_member`), and nobody pins their own message anywhere (`user` loses `pin-message-owner`).
- An add job now makes three Stream calls (`upsertUsers`, `add_members`, `assign_roles`) instead of two.
- A role change briefly moves the member projection back to `pending` until the lane re-confirms it.

## Operator actions (main agent)

1. Merge; let the worker pick up the new `add` jobs (no restart needed beyond the normal deploy).
2. `pnpm community:stream-roles-backfill` (dry run), then `--apply`, per environment (api-dev, staging) with that environment's database and Stream app.
3. `pnpm stream:channel-type-grants` (dry run), review, then `--apply` per Stream app. Rollback: re-add the removed IDs to the listed roles with the same script shape or the Stream Dashboard (the dry-run output is the exact inverse).

## Open questions for the main agent

1. Group/direct chats: accept "no pinning" there, or should group creators become `channel_moderator`, or should community channels move to a dedicated channel type (`loop_community`, requires re-creating channels — Stream channel type is immutable per channel)?
2. Removing `pin-message` from the app-level `moderator` / `global_*` roles follows the "only `channel_moderator` and `admin`" rule literally; LOOP assigns none of these roles today. Keep them if an operator console will use them.

## Tests

- `test/community-channel-sync-worker.test.ts` — join as `channel_member`, owner/promotion as `channel_moderator`, leave/ban remove without a role.
- `test/stream-communication-gateways.test.ts` — `add_members` carries `channel_role` and is followed by `assign_roles`; contradicting echo → unavailable; role on a group channel or unknown role refused before the provider; `assignMemberChannelRoles` body; `readMemberChannelRoles` read-only query; fail-closed gateway.
- `test/community-repository.integration.test.ts` — verification enqueues owner `channel_moderator` / member `channel_member`; `assignAdmin` / `revokeAdmin` re-enqueue with the new role; mute enqueues nothing; leave → `remove`; moderator-to-moderator transfer enqueues nothing; backfill source query.
- `test/stream-pin-permission-scripts.test.ts` — mapping; grant diff (fake client) incl. add-when-missing and no-op; dry run writes nothing; apply sends only changed roles and re-reads; not-converged and collateral-change failures; audit output; backfill dry-run output and apply calls; argument/config refusals.
- `test/well-known-app-links-routes.test.ts`, `test/well-known-passkey-routes.test.ts` — AASA exact bodies with `/c/*`; landing page 200/404, headers, no DB read, no ID echo, OpenAPI exclusion.
