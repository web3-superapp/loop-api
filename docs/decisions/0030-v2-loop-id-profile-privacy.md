# Decision 0030: V2 LOOP ID, profile activation, and privacy preferences

- Status: Accepted
- Date: 2026-09-07
- Scope: S2/D2 backend (`profile` module). Main-agent rulings of 2026-09-07
  in `LOOP/docs/modules/S2-identity-account.md` are adopted verbatim below;
  the user may overturn any row.

## Context

Login must land in `community` (Decision 0026), but a first-time account has
no public identity yet. The prototype `loop-id-setup` page shows a
system-generated LOOP ID, lets the user confirm an alias, pick a preset
avatar and interest tracks, and then continues into the product. The frozen
V1 profile contract (`/v1/profile*`, Decision 0009/0024) already stores the
mutable alias, opaque avatar reference, and a compare-and-swap version in
`user_profiles`; the mobile client also rejects unknown fields on
`GET /v2/account/me`, so the onboarding signal cannot be added there.

## Rulings adopted

| Topic                 | Ruling                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOOP ID format        | `LOOP-` + 8 Crockford Base32 characters (`0-9A-HJKMNP-TV-Z`), server-generated from 40 random bits, globally unique, immutable, non-enumerable, assigned when the account is created at first bootstrap. V1 `profile_code` stays V1-only.                  |
| `loop-id-setup`       | Not a self-chosen ID. A one-time idempotent activation: `POST /v2/profile/loop-id` confirms alias, avatar, interests and moves `profileStatus` from `pending` to `active`. The client redirects an unactivated account there after login.                  |
| Alias                 | Mutable, 1–40 code points, duplicates allowed (Decision 0024). New: compiled reserved words (`loop admin official support system mod moderator team` plus case/prefix/suffix variants) and an operator blocklist `V2_ALIAS_BLOCKED_TERMS` (default empty). |
| Avatar                | No storage Provider selected: `avatarUpload` is `unavailable` (`AVATAR_STORAGE_NOT_SELECTED`). V2 writes accept only presets `avatar:preset/people-01..12` (4×3 atlas) and `avatar:preset/monogram`, or `null`.                                            |
| Bio                   | Nullable, ≤160 code points, same character-safety rules as alias.                                                                                                                                                                                          |
| Interests             | `string[]` from `MEME DEFI AI GAMEFI NFT RWA`, ≤6, deduplicated server-side.                                                                                                                                                                               |
| Privacy V2            | `discoverable`, `anonymousMode`, `visibility.{totalAssets,miningPower,communities,tradeHistory}` ∈ `self\|everyone`. No `copy_trade_visibility`, no holdings broadcast. Stored in the new `privacy_preferences_v2`, independent from V1.                   |
| Notification switches | Frontend-local in this step; no backend field (D14).                                                                                                                                                                                                       |
| Onboarding signal     | `GET /v2/account/me` unchanged. `GET /v2/profile` returns `profileStatus` and `loopId`; the client chooses `loop-id-setup` or `community` from it.                                                                                                         |
| Recovery/MFA/export   | Availability comes only from `GET /v2/meta/capabilities`; all remain unavailable.                                                                                                                                                                          |

## Decision

### Persistence (migration `000015_v2_loop_id_profile`, append-only)

- `loop_users.loop_id text not null unique`, check
  `^LOOP-[0-9A-HJKMNP-TV-Z]{8}$`, immutable via trigger. Existing accounts
  are backfilled inside the migration with `public.loop_generate_loop_id()`
  (40 bits from `gen_random_uuid()`), which also becomes the column default so
  direct/legacy inserts cannot produce a null ID. Runtime account creation
  (`getOrCreateLoopUserInTransaction`, used by both V1 bootstrap and V2
  session bootstrap) generates the ID in Node with `crypto.randomBytes` and
  retries a fresh candidate on `loop_users_loop_id_unique` violations
  (savepoint rollback) at most 5 times, then fails closed
  (`LoopIdAllocationExhaustedError`, mapped explicitly by the V2 session
  service to the seven-field `INTERNAL_ERROR`). No sequential or
  client-supplied value is ever accepted.
- `user_profiles` gains `profile_status` (`pending|active`, default
  `pending`), `activated_at`, `bio`, `interests text[]` (default `{}`) with
  check constraints (bio 1–160 code points and `loop_alias_text_is_safe`;
  interests ⊆ enum, ≤6, unique). Activation is irreversible (trigger). The
  existing `alias`, `avatar_ref`, and `record_version` columns are shared
  unchanged with V1; V1 inserts receive the new defaults and V1 updates leave
  bio/interests/status untouched.
- `privacy_preferences_v2` (owner PK, `discoverable`, `anonymous_mode`, four
  visibility columns, `record_version`, timestamps).
- `profile_activation_commands`: permanent (`command_kind='activate'`,
  `idempotency_key`) records binding owner, `profile_activation_v1` digest,
  contract version, request ID, and result (`activated|already_active`).
- Rollback refuses while any `loop_users` row exists (an assigned LOOP ID is
  immutable) or any activation command / V2 privacy row exists.

### Routes (`src/routes/v2/profile.ts`, module gate `profile`)

Registered only when `V2_MODULES_ENABLED` contains `profile`; otherwise every
path is the V2 `NOT_FOUND` envelope (tested). Public fields are camelCase.

| Route                      | Auth / headers                                                 | Semantics                                                                                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/profile/avatars`  | public; no body/query                                          | Preset catalog `{avatarRef, atlas, slot, label}`.                                                                                                                                                                                                                                     |
| `GET /v2/profile`          | Bearer + `X-Loop-Contract-Version` + `X-Loop-Client-Version`   | `{profile:{loopId,alias,avatarRef,bio,interests,profileStatus,activatedAt}, version, updatedAt, contractVersion}`; no row → version 0, `pending`, LOOP ID still present; nothing is written.                                                                                          |
| `PUT /v2/profile`          | same; `Idempotency-Key` rejected                               | CAS on `expectedVersion` shared with V1 (identical retry returns the committed resource; stale → `VERSION_CONFLICT`). Does not change `profileStatus`.                                                                                                                                |
| `POST /v2/profile/loop-id` | bootstrap header set incl. `Idempotency-Key`, device, platform | Activation. Key is bound to owner + route + SHA-256 of (`activate`, contract version, alias, avatarRef, interests deduplicated and sorted). Same key + same body → current resource; different body → `IDEMPOTENCY_CONFLICT`; already active → 200 current resource without mutation. |
| `GET /v2/profile/privacy`  | as `GET /v2/profile`                                           | Version-0 fail-closed defaults (`false`, `false`, all `self`) without writing.                                                                                                                                                                                                        |
| `PUT /v2/profile/privacy`  | as `PUT /v2/profile`                                           | CAS on its own version; unknown fields (including any copy-trade field) are `INVALID_REQUEST`.                                                                                                                                                                                        |

The activation digest deliberately excludes device ID, platform, and client
version (main-agent ruling, 2026-09-07): activation is an account-level fact,
not a device fact. The logical operation is "activate this identity with this
content", so a retry from a reinstalled app or another device with the same
key/body must replay, while the same key with different content conflicts.
The device/platform headers are still required and validated so the route
shares the bootstrap header contract; they are simply not part of the key
binding. The same ruling confirms that the CAS routes reject a client
`Idempotency-Key` (see conventions, "Idempotency and writes").

### Validation and error codes

- JSON-schema shape failures (unknown field, wrong type, non-preset avatar,
  unknown interest, more than 6 interests, raw control characters, blank or
  whitespace-only alias/bio) → `INVALID_REQUEST` (400).
- Normalized-content failures (alias/bio trimmed length above 40 / 160 code
  points) → `VALIDATION_FAILED` (422).
- Alias policy (`src/features/profile/alias-policy.ts`): after NFKC +
  lower-case normalization, an alias is reserved when any alphanumeric token
  with digits stripped equals a reserved word, starts or ends with a reserved
  word of at least five letters (`admin`, `official`, `support`, `system`,
  `moderator`) after any surrounding reserved words are stripped
  (`AdminAlice`, `superadmin`, `LoopSupportBot`, `administrator`), or when the separator-free, digit-free string is a
  concatenation of reserved words. The short words `loop`, `team`, and `mod`
  match only a whole token (`loopy`, `teams`, `modern` stay allowed). Blocked
  terms match as substrings of the normalized alias and of its compact form
  (both sides NFKC + lower-case with whitespace and separators removed, so
  `rug pull` catches `rugpull`, `rug-pull`, `Rug_Pull`).
  Reserved is evaluated first. New catalog entries (both `validation`, 422,
  not retryable): `ALIAS_RESERVED` (`errors.alias.reserved`) and
  `ALIAS_BLOCKED` (`errors.alias.blocked`). The catalog had 28 codes at this
  decision and has 30 after Decision 0031;
  Decision 0029's table and `docs/api-v2-conventions.md` are updated.
- `ACCOUNT_BOOTSTRAP_REQUIRED` when the Privy subject has no LOOP account;
  `CAPABILITY_UNAVAILABLE` when the repository is not composed.

### Capabilities and policy gate follow-ups (S1-BE review items)

- `GET /v2/meta/capabilities` gains `profile` (`available` only when the module
  is enabled and the PostgreSQL repository is composed; `unavailable` with
  `PROFILE_RUNTIME_UNAVAILABLE` when enabled without a repository; `deferred`
  with `PROFILE_MODULE_NOT_ENABLED` otherwise) and `avatarUpload`
  (`unavailable`, `AVATAR_STORAGE_NOT_SELECTED`). The list is now 18 entries;
  the mobile enum is synchronized by the S2 frontend task.
- (a) Configuring any version or terms gate now requires both
  `V2_CLIENT_POLICY_CONFIG_VERSION` and `V2_CLIENT_POLICY_EFFECTIVE_AT`
  (startup `ConfigurationError` otherwise). The client policy is evaluated per
  request; while `effectiveAt` is in the future the configured gates stay
  `unavailable` with `reasonCode: POLICY_NOT_YET_EFFECTIVE` and switch on
  without a restart.
- (b) `docs/api-v2-conventions.md` records that a module must pass the
  canonical (sorted, deterministic) filter string to the cursor codec and map
  `InvalidV2CursorError` to `INVALID_REQUEST` in the route.

### OpenAPI

`scripts/generate-openapi.ts` enables every module ID so each delivered
registrar contributes to `openapi/loop-api.v2.json`; undelivered modules add
nothing. V1 remains byte-frozen.

## Consequences

- The frontend can decide the post-login route from `GET /v2/profile` without
  a change to `GET /v2/account/me`.
- V1 clients keep working: shared columns are read/written by both contracts
  with one CAS version (integration-tested in both directions).
- Avatar upload, alias uniqueness, social discovery by LOOP ID, and public
  profile lookup are not delivered here. `discoverable` is stored but no V2
  search consumes it yet.
- No Provider is involved; the capability is therefore `available` on local
  configuration alone, and physical-device evidence is not claimed.

## Rollback

Disable with `V2_MODULES_ENABLED` without `profile`; every V2 profile route
disappears and the capability returns to `deferred`. The migration rolls back
only while no V2 profile data exists (see above); the LOOP ID column is
otherwise retained.
