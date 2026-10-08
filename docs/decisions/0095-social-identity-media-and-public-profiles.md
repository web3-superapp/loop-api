# Decision 0095: Social identity — media upload, real identity in Stream, public profiles, friend removal, recommended communities

- Status: Accepted (S107)
- Date: 2026-10-08
- Scope: one migration (`000046_v2_social_identity`: new table `media_objects`; community logo check widened; `privacy_preferences_v2` defaults and rows for `totalAssets` / `tradeHistory` flipped to `everyone`; `friendships` deletable; `social_graph_events` gains `friendship_removed`), eight new `/v2` operations, one new error code (`PROFILE_NOT_FOUND`), two new environment keys (`COMMUNITY_CHAT_REAL_IDENTITY`, `RECOMMENDED_COMMUNITY_IDS`), one operator script (`pnpm stream:users-backfill`), one public landing page (`/c/{communityId}`), two new runtime dependencies (`@fastify/multipart` 10.1.2, `sharp` 0.35.4). No `/v1` change.
- Baseline: `integration/v2` = `0ac7df4`
- Inputs: `LOOP/docs/modules/S107-social-identity.md` §1–§5 (contract), `LOOP/docs/09-需求方v3需求与裁决.md` B7 / B11 / D4 / §6.2 6–7.

## Context

Demand-side v3 (docs/09) removes the anonymous presentation: every user shows a real uploaded avatar and a user name in chat; tapping an avatar opens a public profile with holdings, trades, and relationship actions (add / delete friend, block); holdings and trades are public by default and can be switched off; registration ends on one "recommended communities" page. Before S107 the backend had no upload path (`avatarUpload` was fixed `unavailable`, Decision 0030), Stream users carried only `{id}` (Decision 0032: "LOOP publishes no profile facts to Stream"), community chat showed server-generated personas (Decision 0055), there was no read of another account's profile, and friendships were immutable (Decision 0031 / migration 000013: "until a deletion decision exists"). This decision is that deletion decision and supersedes the "no profile facts in Stream" rule of Decision 0032.

## Decision

### 1. Media objects (`media_objects`) and the `MediaStorage` port

- Entity: `media_objects(media_id uuid pk, owner_user_id → loop_users, kind 'avatar'|'community_logo', content_type 'image/webp', bytes bytea, width, height, sha256, idempotency_key uuid, request_sha256, created_at)`. Rows are immutable (an update trigger refuses); nothing deletes them in this step. `media_id` is a random UUIDv4 and the only public identifier; the owner never leaves the API.
- The bytes sit behind `MediaStorage` (`src/features/media/media-storage.ts`, PostgreSQL implementation `src/database/media-repository.ts`). Moving to S3 later replaces the implementation only; routes and refs stay.
- Processing (`sharp`): the upload is sniffed by magic bytes and must be JPEG, PNG, WebP or HEIC/HEIF; the declared multipart type is not trusted. It is decoded with EXIF orientation applied, refused when either side is below 64 px, then resized to **512 × 512 cover** and encoded **WebP quality 82** without metadata. Upload limit **5 MiB**, one file part named `file`, no other part; decoder pixel limit 50 MP.
- HEIC: the prebuilt `sharp` libvips decodes HEIF/AVIF but not HEVC-coded HEIC (patent-encumbered codec is not shipped). Such a file is refused as `MEDIA_DECODE_FAILED`; the client should hand the picker's JPEG to the API.
- Idempotency: `Idempotency-Key` is required; it is unique per owner. Replaying the same key with the same bytes and kind returns the stored object (201, same body); a different payload is `IDEMPOTENCY_CONFLICT`.
- Rate limit: **6 uploads per user per minute** (both routes together), through the existing `issuance_rate_records` quota (`capability = media_upload`, HMAC-keyed with `STREAM_TOKEN_QUOTA_HMAC_SECRET`). The quota is consumed before decoding, so a replay also counts.
- Read: `GET /v2/media/{mediaId}.webp` is a public image resource (no bearer, no LOOP headers, like the Decision 0089 logo proxy): `Cache-Control: public, max-age=31536000, immutable`, strong `ETag` from the stored SHA-256, `If-None-Match` → 304, unknown → 404 `NOT_FOUND`.

Refs:

| Ref                      | Accepted by         | Rule                                                                                                                                                                            |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avatar:media/{mediaId}` | `avatarRef` (V2)    | The object exists, `kind = avatar`, and the caller uploaded it. Otherwise 422 `VALIDATION_FAILED`, `detailsSafe.reasonCode = MEDIA_NOT_OWNED`.                                  |
| `logo:media/{mediaId}`   | community `logoRef` | `kind = community_logo` and the uploader is the caller (create) or a current owner/admin of that community (update). Otherwise 422 `VALIDATION_FAILED`, `MEDIA_NOT_AUTHORIZED`. |
| `avatar:preset/*`        | unchanged           | Preset people images are no longer offered by the client but remain valid and renderable. The default is `avatar:preset/monogram`.                                              |

`avatarUpload` is `available` when the `profile` module is registered, the PostgreSQL media storage is composed, and the quota secret is configured; otherwise `unavailable` with `AVATAR_STORAGE_UNAVAILABLE`.

### 2. Real identity in Stream

- Projection (`src/features/communication/stream-user-identity.ts`): Stream user `{ id, name, image, custom: { publicProfileId } }` with `name = alias` (omitted while the alias is null) and `image = PUBLIC_BASE_URL + /v2/media/{mediaId}.webp` for an `avatar:media/*` ref; for a preset or null avatar the `image` field is omitted, which Stream reports as no image (the contract's `null`). The Stream user ID, wallet address, LOOP user ID and LOOP ID are never put in any field.
- `publicProfileId` (custom user data): the account's `user_profiles.public_profile_id`, i.e. the opaque identifier `GET /v2/profiles/{publicProfileId}` reads. It is present only while the profile is `active` and omitted otherwise (an unactivated profile has no readable public profile). Reason: S109a (Decision 0112) makes avatars in community chat and small groups open the public profile page; the client only holds the Stream user there, and the Stream user ID must not be reversed into a LOOP identifier on the client. `publicProfileId` is already a public identifier (search results, connections, share links), so publishing it adds no new fact. Stream chat clients see custom data flattened onto the user (`User.extraData['publicProfileId']`), Stream video clients under `custom['publicProfileId']`.
- Decision 0032's rule "LOOP publishes no profile facts to Stream" is superseded for exactly these three facts: `name` (alias), `image` (uploaded avatar URL) and `publicProfileId`. Every other profile fact (bio, interests, LOOP ID, wallets, privacy, counts) stays out of Stream.
- Stream's server `upsertUsers` replaces the whole user object. Every server path that upserts users (direct/group channel creation, community channel creation and member add, voice-room host) therefore now upserts the full projected identity read from PostgreSQL in the same call, so no path erases a name or image. Without a database (tests, scripts that do not pass one) the old `{id}`-only shape is kept.
- Sync point: after a successful `PUT /v2/profile` or `POST /v2/profile/loop-id`, the service upserts the caller's projection. A Stream failure is logged (no identifiers) and never fails the profile write; the backfill repairs it.
- `pnpm stream:users-backfill [--apply]`: lists every account with an active profile and upserts its projection (including `publicProfileId`) in batches of 100. Without `--apply` it only prints counts (`examined`, `withName`, `withImage`, `withPublicProfileId`, `upserted`).
- `COMMUNITY_CHAT_REAL_IDENTITY` (default `true`, API and worker): when true the community channel sync no longer generates, attaches or re-projects personas (`community_channel_personas` is neither read nor written by the lane), and `community.chat.viewerPersona` is `null`. `false` restores Decision 0055 behaviour exactly. No table or code is removed. Personas already written onto Stream channel members stay as member custom data; the client decides display from the Stream user (S109a).

### 3. Public profiles

All four reads require a bootstrapped LOOP bearer (`X-Loop-Contract-Version: 2.0`). The target must have an activated profile. Not found, not activated, and **the target has blocked the viewer** all return the same 404 `PROFILE_NOT_FOUND` (no enumeration). `discoverable` is **not** consulted: it governs search and follow (Decision 0090), while a profile is reached from a chat avatar or a shared link. Viewing one's own profile is allowed and returns `relationship` all false/`none`.

- `GET /v2/profiles/{publicProfileId}` and `GET /v2/profiles/by-loop-id/{loopId}` (case-insensitive LOOP ID) → identity, `bio`, `joinedAt` (= `activatedAt`), `counts { followers, following, communities }` (communities = non-banned memberships of verified communities), `relationship { following, followedBy, friendship none|pending_out|pending_in|friends, blocked, blockedBy }` (`blockedBy` is always false in a 200 because that case is a 404), `visibility { holdings, trades }`.
- Visibility: `holdings = totalAssets == everyone`, `trades = tradeHistory == everyone`. The owner always sees their own data.
- `GET /v2/profiles/{id}/holdings` → `status available|hidden|unavailable`. Source: the target's **selected active wallet** (`account_wallets.is_active`) read through the same wallet balance service as `GET /v2/wallets/{id}/balances` (one RPC block, registry assets). Rows with a zero or unreadable balance are omitted; `totalUsd` is the sum of the listed `usdValue`s only when every listed row is valued, else `null`. No address is published. `unavailable` reasons: `WALLET_NOT_BOUND` (no active wallet), `BSC_READ_UNAVAILABLE` (chain not composed or unreadable), `WALLET_RUNTIME_UNAVAILABLE`. A zero is never substituted for an unreadable chain.
- `GET /v2/profiles/{id}/trades?cursor&limit` (limit 1–50, default 20) from the S82 indexer tables for the same wallet, newest first by `(block_number, log_index)`, opaque signed cursor (bound to viewer, route, target). Kind rules:
  1. **Swap** (`indexed_pool_events`, `event_kind = swap`, not removed) whose `payload.recipient` or `payload.sender` is the wallet. The traded asset is the pool token that is not a quote asset (quote set: WBNB, BSC USDT, BSC USDC, configured USD1; when both or neither are quote, `token0`). Pool amount of that asset `< 0` (pool paid it out) → `buy`, otherwise `sell`. `amount` = absolute asset amount; `usdValue` = absolute quote amount when the quote is a USD stablecoin (USDT/USDC/USD1), else `null`.
  2. **Transfer** (`indexed_transfers`, not removed, registry asset) to the wallet → `transfer_in`, from the wallet → `transfer_out`; a self-transfer is skipped; a transfer in a transaction already listed as a matched swap is skipped (it is the swap's leg). `usdValue` = amount when the asset is a USD stablecoin, else `null`.
  3. A swap routed through a router that keeps custody (multi-hop, native BNB unwrap) has the router as recipient, so it is not matched as a swap; its transfer legs appear as transfers. This is an indexer fact, not guessed.
  - `eventId` = deterministic UUID-shaped SHA-256 of `(chainId, txHash, logIndex)`; `blockTimestamp` is the pool event's block time; transfers have no stored block time, so it is taken from a pool event in the same block when one is indexed, else `null` (`blockNumber` is always present).
  - `unavailable`: `WALLET_NOT_BOUND`, `BSC_INDEXER_NOT_STARTED` (no `erc20_transfer` checkpoint), `V2_CURSOR_NOT_CONFIGURED`.
- Default flip (docs/09 B11 "主页持仓默认公开可关"): `defaultPrivacyV2Values.visibility.totalAssets` and `.tradeHistory` are `everyone`; the column defaults change too, and migration 000046 sets every stored `self` of those two columns to `everyone` (bumping `record_version`). `miningPower` and `communities` keep their fail-closed `self` default. A user who wants them hidden switches them off again (one client switch writes both).

### 4. Friend removal

`DELETE /v2/friends/{publicProfileId}` (bearer, `Idempotency-Key`, contract version) deletes the accepted `friendships` row of the pair if any. Idempotent: no friendship → `removed: false`. Each command writes one `social_graph_events` row `friendship_removed` (`result_status removed|absent`) under the social-graph idempotency scope, so a replay returns the first result and a different target with the same key is `IDEMPOTENCY_CONFLICT`. Target rules as follow/unfollow (nonexistent/inactive/self → `NOT_FOUND`; a block does not prevent removal). The friendship trigger is narrowed from "immutable" to "no update"; deletion is allowed. `friend_requests` history is untouched (still immutable), so a new request between the pair works as for strangers. Follow edges are not touched. An existing Stream direct channel is not removed (the direct-message gate is enforced when a channel is opened; S109 decides whether to hide it).

### 5. Recommended communities

`GET /v2/communities/recommended` returns `{ items: [community summary], defaultSelectedIds, contractVersion }` from `RECOMMENDED_COMMUNITY_IDS` (comma-separated canonical UUIDs, at most 50; anything else refuses boot). Only `verified` communities are listed, in configured order, duplicates removed; unknown or unverified IDs are skipped. `defaultSelectedIds` = the first five listed. An unset key is an empty list, not an error (the back-office project replaces the key with a table later).

### 6. `/c/{communityId}` landing page

Same static page family as `/u/{loopId}` (Decision 0090) and `/c/{id}/room` (Decision 0091): no database read, no echo of the ID, 404 page for a malformed ID, `Cache-Control: public, max-age=3600`. The `/c/*` Universal Link component is already published.

## Differences from the S107 contract (docs/modules/S107 §1–§5)

| Item                               | Contract         | Delivered                                                                             | Why                                                                                                                     |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Upload write headers               | bearer           | bearer + `X-Loop-Contract-Version: 2.0` + `Idempotency-Key`                           | Every V2 write requires both (00 §4.6); the key makes a lost-response retry safe.                                       |
| `holdings` / `trades` body         | `status` + data  | adds `reasonCode` (null unless `unavailable`)                                         | The client must tell "no wallet" from "chain down"; additive.                                                           |
| trade item                         | `blockTimestamp` | `blockTimestamp: string \| null` + `blockNumber`                                      | `indexed_transfers` stores no block time; it is taken from a pool event of the same block when indexed, never invented. |
| `image` in Stream                  | URL or `null`    | field omitted when no uploaded avatar                                                 | Stream represents "no image" as an absent field.                                                                        |
| `avatarUpload` unavailable reason  | —                | renamed `AVATAR_STORAGE_NOT_SELECTED` → `AVATAR_STORAGE_UNAVAILABLE`                  | A storage is now selected; the remaining failure is "not composed".                                                     |
| `DELETE /v2/friends` target errors | —                | `404 NOT_FOUND` (same family as follow/unfollow)                                      | Social commands share one non-enumerating code; profile reads use `PROFILE_NOT_FOUND`.                                  |
| Worker config                      | —                | worker also reads `PUBLIC_BASE_URL` (default `http://127.0.0.1:3000`, no https check) | The channel sync upserts the joiner's real `image`.                                                                     |

## Errors

New catalog code `PROFILE_NOT_FOUND` (404, `validation`, not retryable, `errors.profile.notFound`). `VALIDATION_FAILED.detailsSafe.reasonCode` values added: `MEDIA_TYPE_UNSUPPORTED`, `MEDIA_TOO_LARGE`, `MEDIA_DIMENSIONS_TOO_SMALL`, `MEDIA_DECODE_FAILED`, `MEDIA_NOT_OWNED`, `MEDIA_NOT_AUTHORIZED`. Every error keeps the seven-field envelope.

## Consequences

- Decision 0032's "no profile facts in Stream" and Decision 0055's persona display are superseded while `COMMUNITY_CHAT_REAL_IDENTITY=true`.
- `PUBLIC_BASE_URL` must be the public API origin in every environment that serves devices, or Stream images point at an unreachable host (Development: `ops/api-dev.env` already sets `https://api-dev.quant-dinger.cc`).
- Images live in PostgreSQL (≤ ~60 KB each after re-encode); backups grow accordingly until the S3 implementation lands.
