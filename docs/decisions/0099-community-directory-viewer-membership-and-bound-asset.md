# Decision 0099: Community directory rows carry viewerMembership and boundAsset

- Status: Accepted (S111)
- Date: 2026-10-08
- Scope: one changed response (`GET /v2/communities` rows gain `viewerMembership` and `boundAsset`), one clarified filter (`membership=joined`). No migration, no new operation, no new error code, no new environment key, no `/v1` change.
- Baseline: `integration/v2` = `8c73740`
- Inputs: `LOOP/docs/modules/S111-square-club-list.md` §1; `LOOP/docs/09-需求方v3需求与裁决.md` §1 position 2 and §6.2; Decisions 0061, 0072, 0073, 0089, 0097.

## Context

The S111 square redesign shows the community directory as DeBox-style club rows with an inline join pill and the bound token's symbol. The directory row (`CommunityDiscoverItem`) only carried the community summary, so the client could not tell whether the caller is the owner, a member, banned or unrelated, and it had only the raw `boundAssetKey`. Reading the detail per row would be N extra requests.

## Decision

### 1. `viewerMembership`

Every directory row, under every `sort` and every `membership` filter, carries

```json
{ "role": "owner" | "admin" | "member" | null,
  "status": "active" | "muted" | "banned" | null,
  "pending": false }
```

- `role`/`status` are the caller's own `community_memberships` row for that community, of any status. A banned row keeps its role and reads `status: "banned"` (the client hides the join pill). No row → `{ role: null, status: null, pending: false }`. The route requires a bearer, so "signed out" never reaches the projection.
- `pending` is true only when the caller's role is `owner` and the community's `verification_status` is `pending` (a creation application awaiting review). LOOP has no join-approval step (`POST …/join` admits immediately), so no join request can be pending; until such a step exists that half of `pending` is constantly false. A `rejected` application is decided, not pending. `pending` is derived from the row already read, with no extra query.
- After `POST /v2/communities/{id}/join` succeeds, the next directory read of that row reports `role: "member"`, `status: "active"` (same table, no cache).

### 2. `boundAsset`

Every directory row carries `boundAsset: { assetId, symbol, logoUrl } | null`:

- Same source as the Decision 0097 detail block: the `public.assets` (Asset Registry) row whose `asset_id` equals `community.bound_asset_key`. Only three fields: no name, no `hasRegisteredPool`, no price or market fact, so the directory never reads a market provider.
- `null` when the community is unbound or its key has no registry row (a pre-0097 binding).
- `logoUrl` is the Decision 0089 proxy URL from the shared `TokenLogoProjector`; `null` when the `market` module (the proxy) is not served or the chain is unsupported. It is never a guessed upstream URL. The detail block and the directory row now share one `projectAssetLogoUrl` helper.

### 3. Set-based reads

`createPostgresCommunityRepository().listCommunities` keeps its page query unchanged and then attaches both facts with at most two queries for the whole page:

1. `select community_id, role, status from public.community_memberships where owner_user_id = $1 and community_id = any($2::uuid[])`;
2. `select asset_id, symbol from public.assets where asset_id = any($1::text[])` over the distinct non-null bound keys; skipped when no row on the page is bound.

An empty page runs neither. The repository contract returns `CommunityDirectoryRecord` (`CommunityRecord` + `viewerMembership` + `directoryAsset`); the service projects it. The bound-asset read lives in the community repository, not a new `ChainRegistryRepository.getAssets`, because the 0097 detail block already reads `public.assets` there and the chain-registry repository is an optional composition of the community service (`assetRegistry` for search): making a non-optional row field depend on it would need an `unavailable` branch for a fact that is in the same PostgreSQL database. The integration test counts the statements of a 20-row page: exactly three (page + membership IN + asset IN), and two for a page without bound keys.

### 4. `membership=joined` confirmed

`joined` lists the communities where the caller has a non-owner membership whose status is not `banned`, i.e. `active` or `muted`. This is the existing rule (Decision 0072/0073, identical to `home.joined`) and is kept: a muted member is still a member (reads the channel, appears in the member directory and in `home.joined`), so dropping it from "我加入的" would make the two surfaces disagree. "Active membership" in the S111 design is read as "current membership"; leaving deletes the row, so departed accounts never appear. Owner communities stay in `membership=owned` only (0073: a community is in exactly one of the two). The filter is applied inside the page query, before ordering and the keyset, so it composes with all four sorts and the cursor (the cursor binds the filter, Decision 0061). No code change was needed for the filter.

## Wire shape

```json
{
  "communityId": "3fa85f64-5717-4562-b3fc-2c963f66af01",
  "name": "Frog Holders",
  "slug": "frog-holders",
  "description": null,
  "logoRef": "avatar:preset/community-03",
  "verificationStatus": "verified",
  "boundAssetKey": "eip155:56:0x1111111111111111111111111111111111111111",
  "memberCount": 9,
  "createdAt": "2026-09-07T01:00:00.000Z",
  "configVersion": "communityV1",
  "viewerMembership": { "role": "owner", "status": "active", "pending": false },
  "boundAsset": {
    "assetId": "eip155:56:0x1111111111111111111111111111111111111111",
    "symbol": "FROG",
    "logoUrl": "https://api-dev.example/v2/market/logos/eip155:56/0x1111111111111111111111111111111111111111.png"
  }
}
```

Both fields are `required` in the OpenAPI row schema (`additionalProperties: false`).

## Errors

No new code and no new reason code. The route keeps its shared read error set (`readErrors`: 400 `INVALID_REQUEST`, 401 `AUTH_REQUIRED`/`AUTH_INVALID`, 404 `NOT_FOUND`, 409 `ACCOUNT_BOOTSTRAP_REQUIRED`/`VERSION_CONFLICT`, 500 `INTERNAL_ERROR`, 503 `CAPABILITY_UNAVAILABLE`/`PROVIDER_DISCONNECTED`/`REQUEST_TIMEOUT`) in the seven-field envelope.

## Unavailable behaviour

Both facts come from PostgreSQL in the same repository as the page; there is no external provider. If either set query fails the whole read fails as the page read would (`CommunityRepositoryUnavailableError` → `503 CAPABILITY_UNAVAILABLE`); no row is ever published with a fabricated `viewerMembership` or `boundAsset`. A missing logo proxy degrades only `logoUrl` to `null`.

## Tests

- `test/v2-community-routes.test.ts`: rows with role owner / member (muted) / null / owner of a pending application / banned; `boundAsset` non-null (three keys only) and null; `membership=joined` forwarded with `sort=members` and `sort=newest`.
- `test/openapi.test.ts`: the row schema requires both fields with the published shapes.
- `test/community-repository.integration.test.ts`: `membership=joined` + `sort=members` lists active and muted non-owner memberships in member-count order, excludes banned, owned and unrelated communities, and pages by keyset; `membership=all` reports banned/owner/null relations; a 20-row page runs exactly three statements, projects `boundAsset` for registered keys (with a proxy `logoUrl`), `null` for unbound and unregistered keys; an owned pending application reads `pending: true` with two statements.
