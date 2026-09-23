# LOOP API inventory

This file is the canonical inventory of LOOP-facing HTTP routes approved for the
native Flutter client. Route schemas in `src/routes/` remain the OpenAPI source
for implemented behavior. Provider REST/WebSocket paths, SDK methods, historical
prototype routes, and unassigned product ideas are not LOOP APIs.

The committed implemented contracts are `openapi/loop-api.v1.json` and
`openapi/loop-api.v2.json`. They are generated independently from route schemas
by `pnpm openapi:generate` and checked for drift by `pnpm openapi:check`. V1 is
the frozen compatibility surface; new product modules use V2.

`openapi/loop-api.v2.json` is the single source of truth for every count in this
repository's documentation. It currently publishes **132** V2 operations across
**109** V2 paths, and `GET /v2/meta/capabilities` currently returns **31**
capability IDs. Recount from the committed artifact after each module lands
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
- A device session is a durable audit projection, not a credential. Every
  protected call re-verifies Privy. Email, Apple, Google, and external-wallet
  login share this one backend path; distinct Privy subjects are never merged
  by email, wallet, Alias, or device.
- The complete wire contract and frontend sequence are documented in
  `docs/api-v2-conventions.md` and `docs/frontend-v2-session-api.md`; the
  `profile` module contract is in `docs/frontend-v2-profile-api.md`; the
  D20 security/settings/support contract is in
  `docs/frontend-v2-security-settings-api.md`.

| Method and path              | Request                                                                 | Success projection                                            | Interface     | Capability                                                                               |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `GET /v2/meta/client-policy` | No input                                                                | Versioned route/tab; configuration-driven version/terms gates | `implemented` | `implemented`; gates are `available` only from complete config, region stays unavailable |
| `GET /v2/meta/capabilities`  | No input                                                                | Runtime availability separated from external evidence         | `implemented` | `implemented`; deferred capabilities remain unavailable                                  |
| `POST /v2/session/bootstrap` | Bearer, contract/client/platform/device/idempotency headers; no payload | Opaque account/session plus server-derived Stream user ID     | `implemented` | `blocked-provider`; physical-device Privy matrix remains unverified                      |
| `GET /v2/account/me`         | Bearer and contract/client headers; no payload                          | Opaque account/authentication/communication projection        | `implemented` | `blocked-provider`; requires a current valid Privy token and bootstrap mapping           |
| `POST /v2/session/logout`    | Bootstrap headers plus owner-bound opaque session ID; no payload        | Durable revoked session and `providerLogoutRequired=true`     | `implemented` | `blocked-provider`; Privy SDK logout and physical-device behavior remain external        |

### V2 profile module (Decision 0030, `V2_MODULES_ENABLED=profile`)

| Method and path            | Request                                                                              | Success projection                                                                        | Interface     | Capability                                                                |
| -------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `GET /v2/profile/avatars`  | Public; no input                                                                     | Preset avatar catalog (`people-01..12`, `monogram`)                                       | `implemented` | `implemented`; upload stays `unavailable` (`AVATAR_STORAGE_NOT_SELECTED`) |
| `GET /v2/profile`          | Bearer + contract/client headers; no payload                                         | `loopId`, alias, avatarRef, bio, interests, `profileStatus`, `activatedAt`, CAS `version` | `implemented` | `implemented`; version-0 pending default without a write                  |
| `PUT /v2/profile`          | Same headers, no `Idempotency-Key`; `{expectedVersion, profile}`                     | Committed resource; version shared with `/v1/profile`                                     | `implemented` | `implemented`; `ALIAS_RESERVED` / `ALIAS_BLOCKED` policy applied          |
| `POST /v2/profile/loop-id` | Bootstrap header set incl. UUIDv4 `Idempotency-Key`; `{alias, avatarRef, interests}` | One-time activation `pending → active`; replay returns the current resource               | `implemented` | `implemented`; key bound to owner/route/body digest                       |
| `GET /v2/profile/privacy`  | Bearer + contract/client headers; no payload                                         | `discoverable`, `anonymousMode`, four `self\|everyone` visibilities, CAS `version`        | `implemented` | `implemented`; fail-closed version-0 default                              |
| `PUT /v2/profile/privacy`  | Same headers, no `Idempotency-Key`; `{expectedVersion, privacy}`                     | Committed resource, independent from V1 privacy                                           | `implemented` | `implemented`; no copy-trade field exists                                 |

The LOOP ID (`LOOP-` + 8 Crockford Base32) is assigned at account creation
by both V1 and V2 bootstrap, backfilled for existing accounts, immutable, and
never an authorization key. `GET /v2/account/me` is unchanged.

### V2 community and social-graph module (Decision 0031, `V2_MODULES_ENABLED=community`)

| Method and path                                            | Request                                                                                  | Success projection                                                                                                                                                                   | Interface     | Capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/community/home`                                   | Bearer + contract/client headers; no payload                                             | `joined[]`, `discover[]` (≤5), `unread`/`liveVoice` unavailable, `freshness`                                                                                                         | `implemented` | `implemented`; Stream-derived counts stay `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /v2/communities`                                      | `sort=members\|newest\|miningPower\|activity`, `verification=verified\|all`, cursor page | Community summaries plus `ordering` (what the page was ordered by), per-row `miningPower` or `activity` on the two ordering sorts, and `recommendation` (`rule:verified-members-v1`) | `implemented` | `implemented`; `miningPower` ranks by the latest **complete** snapshot resolved through the same baseline as every mining read, `activity` by the 7-day message count the `community-channel-sync` lane observed in the official Stream channel (Decision 0061). An ordering whose fact does not exist answers `200` with `ordering.status = unavailable` + `reasonCode`, `items: []` and no cursor — never a silent fallback to another order                                                                                                                                                                |
| `POST /v2/communities`                                     | Write headers incl. UUIDv4 `Idempotency-Key`; name/slug/description/logo/asset           | `201` with a `pending` community owned by the applicant                                                                                                                              | `implemented` | `implemented`; verification is operator-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /v2/communities/{communityId}`                        | Bearer + contract/client headers; no payload                                             | Community record, viewer membership and permission flags, `miningPower`, `onlineCount`                                                                                               | `implemented` | `implemented`; `miningPower` from the latest snapshot under the formula in force (Decision 0043), tagged `subject: community` with the version `scope` plus the same `weight`/`participants` as `GET /v2/mining/communities/{id}` (Decision 0045); `onlineCount` observed from Stream per read as the channel members currently connected, `{count, observedAt, source: stream_member_presence}` or `unavailable` with one of eight reasons (Decision 0047); `chat.viewerPersona` is the caller's own community persona `{alias, projectionState}` or null (Decision 0055); announcements/links `unavailable` |
| `POST /v2/communities/{communityId}/join`                  | Write headers; no payload                                                                | Community resource with the viewer membership                                                                                                                                        | `implemented` | `implemented`; `member_count` maintained in the same transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE /v2/communities/{communityId}/membership`          | Write headers; no payload                                                                | Community resource with `membership: null`                                                                                                                                           | `implemented` | `implemented`; an owner must transfer first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /v2/communities/{communityId}/members`                | `role=all\|owner\|admin\|banned`, `q` alias prefix, cursor page                          | Owner→admin→member grouping, server counts, viewer permission flags, per-row `actions`                                                                                               | `implemented` | `implemented`; `items[].actions` is the per-row governance command list computed from the actor x action x target matrix plus the row's stored state, so the client renders it and derives nothing; `q` is a 1-40 code point alias prefix on the shared public alias search quota (Decision 0040); per-member `miningPower` is the account subject (`scope`, no weight) under the privacy rule (Decisions 0043/0045); online count `unavailable`                                                                                                                                                              |
| `POST /v2/communities/{id}/members/{publicProfileId}/role` | Write headers; `{role}`                                                                  | Refreshed member directory                                                                                                                                                           | `implemented` | `implemented`; owner-only; audited as `role_changed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST\|DELETE /v2/communities/{id}/members/{pid}/mute`     | Write headers; no payload                                                                | Refreshed member directory                                                                                                                                                           | `implemented` | `implemented`; owner or admin per the permission matrix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST\|DELETE /v2/communities/{id}/members/{pid}/ban`      | Write headers; no payload                                                                | Refreshed member directory                                                                                                                                                           | `implemented` | `implemented`; a ban also drops the follow edges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST\|DELETE /v2/connections/follow/{publicProfileId}`    | Write headers; no payload                                                                | `{profile, viewerFollows}`                                                                                                                                                           | `implemented` | `implemented`; target must be activated and `discoverable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /v2/connections`                                      | `direction=following\|followers`, cursor page                                            | Connections, `counts.following/followers`                                                                                                                                            | `implemented` | `implemented`; blocked accounts are omitted; per-row `miningPower` is the account subject (Decision 0045)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /v2/blocks`                                           | `kind=user`, cursor page                                                                 | Block rows plus `counts.user`                                                                                                                                                        | `implemented` | `implemented`; `contract`/`domain` are `CAPABILITY_UNAVAILABLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST\|DELETE /v2/blocks`                                  | Write headers; `{kind, stableId}`                                                        | `{block}` or `{block: null}`                                                                                                                                                         | `implemented` | `implemented`; a block removes both follow edges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /v2/message-requests`                                 | Cursor page                                                                              | Pending incoming requests over the frozen V1 `friend_requests` storage                                                                                                               | `implemented` | `implemented`; preview and AI moderation `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /v2/message-requests`                                | Write headers; `{targetPublicProfileId}`                                                 | One message-request item: the V2 producer for the V1 `friend_requests` store                                                                                                         | `implemented` | `implemented`; follow-grade admission, NOT_FOUND for every ineligible target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /v2/message-requests/{id}/decision`                  | Write headers; `{decision}`                                                              | `{messageRequestId, decision, blocked}`                                                                                                                                              | `implemented` | `implemented`; `report` = reject + block + audit in one transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /v2/mining/referral/rules`                            | Bearer + contract/client headers; no payload                                             | Versioned five-level Mining Power boost snapshot                                                                                                                                     | `implemented` | `implemented`; `edges` and `inviteCode` `unavailable` until D19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

| Method and path                                          | Request                                                    | Success projection                                                                                                      | Interface     | Capability                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/communities/{communityId}/ai/overview`          | Bearer + contract/client headers; no payload               | Eight abilities (`communityAnalytics` only for owner/admin), knowledge snapshot, three example questions, today's brief | `implemented` | `blocked-provider` without a Provider key. Five of the eight abilities are `unavailable` with their reason (no document corpus, no announcement feed, no AI write lane, no analytics source). `knowledge.documents` is always `unavailable`: LOOP has live sources, never a document count. The brief is a model call cached per community for one hour and needs an active membership |
| `POST /v2/communities/{communityId}/ai/ask`              | Write headers incl. UUIDv4 `Idempotency-Key`; `{question}` | `{answerId, answer, refusal, citations[], sources[], omittedSources[], model, generatedAt, disclaimer}`                 | `implemented` | `blocked-provider`; active membership only (403 otherwise); citations are intersected with the sources this request assembled; the question is never logged and the chat messages are never stored; quotas 6/account/minute and 200/community/day are durable and are spent before the Provider call                                                                                   |
| `POST /v2/communities/{id}/ai/answers/{answerId}/report` | Write headers; `{reason, note?}`                           | `201 {answerId, reportId, reason, createdAt}`                                                                           | `implemented` | `implemented`; one report per (answer, account); another account's answer is `404`, not `403`                                                                                                                                                                                                                                                                                          |

The knowledge sources are the community profile, the bound asset's market facts,
the community's mining numbers, the voice room state, and — for an active member
only — up to 100 official-channel messages from the last 7 days read through
Stream. Message authors are named by their Decision 0055 community persona; the
Stream user ID is reversed to the internal account UUID inside the gateway and
never travels further. Announcements are **not** a source while
`GET /v2/communities/{id}` still publishes them as `unavailable`.

### V2 search module (Decision 0031, `V2_MODULES_ENABLED=search`)

| Method and path  | Request                                                              | Success projection                                                                | Interface     | Capability                                                                        |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| `GET /v2/search` | `domain=users\|communities\|assets\|launch\|dapps`, `q`, cursor page | `{resultType, stableId, displaySnapshot, destination}` or `status: "unavailable"` | `implemented` | `implemented` for `users`/`communities`; the other three domains stay unavailable |

`users` and `communities` reuse the `public_alias_search` quota bucket and the
alias prefix normalization of `GET /v1/discovery/users`. Chat content is never
searched. `assets`, `launch`, and `dapps` answer `200` with
`status: "unavailable"` and consume no quota.

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
`verificationStatus: verified`; it refuses to run with `NODE_ENV=production`
and writes an operator audit row. `pnpm community:provision-channels --confirm`
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
capability's `evidence` carries `launchChainId`. `POST /v2/launch/{launchId}/intents` is unchanged (always
`503`); no Launch transaction exists for either chain.

| Method and path                                  | Request                                                                   | Success projection                                                                            | Interface     | Capability                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `GET /v2/launch/overview`                        | Bearer + contract/client headers; no payload                              | Approved launches by `scheduleStatus`; `graduated`/`myEligibility`/`staking` unavailable      | `implemented` | `implemented`; four-axis projection pinned to `unavailable`               |
| `GET /v2/launch/projects`                        | `status`, `limit`, owner-bound cursor                                     | Caller's applications, each with `reviewReasonCode` + `reviewReasonText`                      | `implemented` | `implemented`                                                             |
| `POST /v2/launch/projects`                       | Write headers incl. UUIDv4 `Idempotency-Key`; name/ticker/narrative/links | `201` draft; KYB and attachments `unavailable`                                                | `implemented` | `implemented`; review is operator-only (`pnpm launch:review`)             |
| `GET /v2/launch/projects/{projectId}`            | Bearer + headers                                                          | Project (owner: any status; others: `approved` only); `reviewReasonCode` + `reviewReasonText` | `implemented` | `implemented`; text is the display projection of the code (Decision 0041) |
| `PUT /v2/launch/projects/{projectId}`            | Same headers, no `Idempotency-Key`; `{expectedVersion, project}`          | Committed material (`draft`/`returned` only)                                                  | `implemented` | `implemented`; CAS                                                        |
| `POST /v2/launch/projects/{projectId}/submit`    | Write headers; no payload                                                 | `submitted`                                                                                   | `implemented` | `implemented`; `returned` may resubmit                                    |
| `GET /v2/launch/projects/{projectId}/milestones` | Bearer + headers                                                          | Venue milestones with evidence digest/time/reviewer                                           | `implemented` | `implemented`; recorded only by `pnpm launch:milestone`                   |
| `GET /v2/launches/{launchId}`                    | Bearer + headers                                                          | Launch + config slots + rounds + four axes + graduation steps + pool evidence                 | `implemented` | `blocked-provider`; every on-chain block `unavailable`                    |
| `GET /v2/launch/{launchId}/eligibility`          | Bearer + headers                                                          | `mode` from `tierModeV1`; `TIER_MODE_PENDING`                                                 | `implemented` | `blocked-product-legal`; Tier mode unconfirmed; never depends on staking  |
| `GET /v2/launch/{launchId}/holders`              | Bearer + headers                                                          | All `unavailable`                                                                             | `implemented` | `blocked-provider`                                                        |
| `GET /v2/launch/{launchId}/history`              | Bearer + headers                                                          | Empty records + `source: unavailable`                                                         | `implemented` | `blocked-provider`                                                        |
| `POST /v2/launch/{launchId}/intents`             | Write headers; `{walletId, roundId, payAmount}`                           | Always `503 CAPABILITY_UNAVAILABLE`                                                           | `implemented` | `blocked-provider`; `launch_intents` is structure only                    |
| `GET /v2/launch/stake`                           | Bearer + headers                                                          | `STAKING_CONTRACT_PENDING`, `executable: false`                                               | `implemented` | `blocked-provider`                                                        |
| `GET /v2/launch/economy`                         | Bearer + headers                                                          | Provable counts + `source: loop` (Decision 0049); supply/tax `unavailable`                    | `implemented` | `implemented`                                                             |

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

| Method and path                            | Request                    | Success projection                                                                                                                                                                                                                                                                                                                                 | Interface     | Capability                                                                                              |
| ------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /v2/mining/summary`                   | Bearer + headers           | `power`, `networkPower`, `estimatedToday` (budget × share) from the latest complete snapshot under the version in force; `snapshot.stale` + `latestAttempt` (Decision 0057); `power` is `MINING_SNAPSHOT_PENDING` for a wallet no snapshot includes; `referralBoost` `MINING_REFERRAL_BOOST_PENDING`                                               | `implemented` | `implemented` under an approved version (Development baseline); product numbers `blocked-product-legal` |
| `GET /v2/mining/assets`                    | Bearer + headers           | `included` power rows (with `referencePriceQuality: fresh\|proxied\|derived` and `referencePricePairAddress`, Decision 0059) + `excluded` held assets with the reason the latest attempt recorded (`MINING_PRICE_PAIR_NOT_FOUND`, …) or re-derived, each with the registry `symbol`; `source.stale` + `latestAttempt`; `formula` as on the summary | `implemented` | same; `503 CAPABILITY_UNAVAILABLE` when the Asset Registry cannot answer                                |
| `GET /v2/mining/rewards`                   | Bearer + headers           | `claimable`/`accumulated` `REWARD_AUTHORITY_PENDING`, `claimExecutable: false`; `estimatedToday` as summary                                                                                                                                                                                                                                        | `implemented` | rewards `blocked-product-legal`                                                                         |
| `GET /v2/mining/rank`                      | `scope=users\|communities` | Positive-power ranking (≤100) from the latest complete snapshot, `myPosition`; name by anonymous mode only, `power` null for others when `mining_power_visibility=self` (Decision 0049); `snapshot.stale` + `latestAttempt`; `formula` as on the summary                                                                                           | `implemented` | same as summary                                                                                         |
| `GET /v2/mining/communities/{communityId}` | Bearer + headers           | Weight record + members' power on the bound asset, caller's contribution, rank, participants; an unbound community's `weight` is `COMMUNITY_ASSET_NOT_BOUND` / `reviewStatus: not_applicable` (Decision 0046); `snapshot.stale` + `latestAttempt`                                                                                                  | `implemented` | needs a bound asset and an approved weight (`pnpm mining:community-weight`)                             |
| `GET /v2/mining/rules`                     | Bearer + headers           | Approved + pending versions with `scope`, `assetWeights`, `dailyOutput`, community `range`; `baseline` in force                                                                                                                                                                                                                                    | `implemented` | `implemented`                                                                                           |
| `GET /v2/mining/referral/rules`            | Bearer + headers           | Versioned five-level boost snapshot (moved from `community`)                                                                                                                                                                                                                                                                                       | `implemented` | `implemented`                                                                                           |

### V2 referral module (Decision 0036, `V2_MODULES_ENABLED=referral`)

| Method and path           | Request                       | Success projection                                                             | Interface     | Capability                                                           |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------- |
| `GET /v2/referral`        | Bearer + headers              | Invite code (issued on first read), binding, level counts, boost `unavailable` | `implemented` | `implemented`; boost `MINING_REFERRAL_BOOST_PENDING` (Decision 0046) |
| `POST /v2/referral/claim` | Write headers; `{inviteCode}` | Binding (depth 1..5 edges materialised)                                        | `implemented` | `implemented`; 7-day window, once, no self/cycle                     |

### V2 chain module (Decision 0033, `V2_MODULES_ENABLED=chain`)

| Method and path            | Request                                    | Success projection                                                                                                                                                            | Interface     | Capability                                                             |
| -------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `GET /v2/chain/status`     | Bearer + contract/client headers; no input | Chain constants, RPC verification and head, per-endpoint health behind opaque refs plus a host-name `label` (Decision 0049), indexer lane, `launchChain` slot (Decision 0038) | `implemented` | `blocked-provider`; needs a configured, chain-56-verified RPC endpoint |
| `GET /v2/assets/{assetId}` | Canonical CAIP `assetId` in the path       | Registry identity read from on-chain calls plus a non-swappable capability                                                                                                    | `implemented` | `implemented`; `swappable` stays false until D15                       |

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
client-side reads, each at most endpoints × 4 HTTP attempts). A _shape_
refusal (HTTP 413, JSON-RPC -32602/-32005 typed or in a 4xx body, or
`limit exceeded` / `Request blocked` / `block range` / `more than` text) is
narrowed by block range, then by address, with the learned limits kept on
the client for the next segment; a _throttle_ (HTTP 429, `rate limit` /
`too many` / `quota` / `usage limit` text, which is the only reading of
-32001) is not narrowed and goes to the retry loop's exponential backoff.
A lane idling on either refusal code backs off 1 s → 30 s between ticks.
The retry-loop warn line and the once-per-transition `LOOP BSC indexer lane
is unavailable` line carry `lane`, `errorClass`, `rpcStatus`, `rpcCode`,
`rpcUrlHost` (host name only), and `method`; on `BSC_RPC_UNREACHABLE` (from
the chain-verification probe) these are `null`.

### V2 wallet module (Decision 0033, `V2_MODULES_ENABLED=wallet`)

| Method and path                       | Request                                                    | Success projection                                                                                                                          | Interface     | Capability                                                             |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `GET /v2/wallets`                     | Bearer + contract/client headers; no input                 | Opaque `walletId`, public `address`, `kind`, `status`, `isActive`                                                                           | `implemented` | `blocked-provider`; needs Privy credentials                            |
| `PUT /v2/wallets/active`              | No `Idempotency-Key`; `{walletId, expectedActiveWalletId}` | Committed wallet list; concurrent switch is `VERSION_CONFLICT`                                                                              | `implemented` | `implemented`; moves no funds and grants no signing authority          |
| `GET /v2/wallets/{walletId}/balances` | Bearer + contract/client headers; no input                 | One snapshot block; display/available/spendable/gasReserve/pending, valuation, Privy crossCheck; `launchChain` tBNB balance (Decision 0038) | `implemented` | `blocked-provider`; needs a verified RPC endpoint                      |
| `GET /v2/wallets/{walletId}/activity` | `cursor` or `limit` (1–50), mutually exclusive             | Indexed ERC-20 transfers with tx/log/block/confirmations plus indexer freshness                                                             | `implemented` | `blocked-provider`; `INDEXING_DELAYED` until the lane has a checkpoint |
| `GET /v2/wallets/{walletId}/receive`  | Bearer + contract/client headers; no input                 | Address and EIP-681 request for BSC only                                                                                                    | `implemented` | `implemented`                                                          |

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
`LAUNCH_CHAIN_RPC_UNREACHABLE` and never gates the primary balances. `GET
/v2/wallets` reuses one Privy inventory observation for 30 s and reports in
`source.observedAt` when Privy was actually read; the list itself is rebuilt
from the database every call, so an active-wallet switch is immediate.

### V2 market module (Decision 0034, `V2_MODULES_ENABLED=market`)

| Method and path                           | Request                                       | Success projection                                                                                                                                                                                                                                                                                                                                                                                      | Interface     | Capability                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/market/overview`                 | Bearer + contract/client headers; no input    | Watchlist rows with price facts; trending registry assets by DexScreener 24h volume with `recommendationId`; `newPairs` card with `omittedCount` from the new-pairs fact (0053)                                                                                                                                                                                                                         | `implemented` | `blocked-provider`; each fact carries its own source/quality; `newPairs` unavailable with the new-pairs page's reason when its fact cannot be read                                                    |
| `GET /v2/market/assets/{assetId}`         | Canonical `assetId`                           | Registry identity, DexScreener facts from the deepest base pair, bound verified community, GoPlus fact list. An unregistered BSC address is resolved through GeckoTerminal → DexScreener (`asset.status: unregistered`, Decision 0058), quota-bound per user/IP/day (429). A registered asset with no usable DexScreener pair takes the same Provider top-pool facts, without the quota (Decision 0064) | `implemented` | `blocked-provider`; GoPlus needs credentials; unregistered lookup is `200` + unavailable when Providers are unreachable, `404` only on an affirmative "no such token", `503` without the quota secret |
| `GET /v2/market/assets/{assetId}/candles` | `interval=15m\|1h\|4h\|1d\|1w`, `limit` 1–300 | GeckoTerminal OHLCV, else candles derived from indexed V3 swaps (`quality: derived`, labelled); native BNB through the WBNB pool (`quality: proxied`, `proxyAsset`); an asset with no registered pool — registered (Decision 0064) or not (Decision 0058) — through GeckoTerminal OHLCV of the lookup's top pool, published as `pool.origin: provider`                                                  | `implemented` | `blocked-provider`; derived path needs a registered pool and the pool lane; without GeckoTerminal, or when the Provider knows no pool either, the block is `MARKET_POOL_NOT_REGISTERED`               |
| `GET /v2/market/assets/{assetId}/trades`  | `cursor` or `limit` (1–50)                    | Indexed swaps with tx/log/block/timestamp/confirmations and direction relative to the asset                                                                                                                                                                                                                                                                                                             | `implemented` | `blocked-provider`; unregistered pool or idle lane is `unavailable` — Provider pool trades are never published here (Decision 0064)                                                                   |
| `GET /v2/market/assets/{assetId}/holders` | Canonical `assetId`                           | GoPlus holder count; distribution `unavailable`                                                                                                                                                                                                                                                                                                                                                         | `implemented` | `blocked-provider`                                                                                                                                                                                    |
| `GET /v2/market/new-pairs`                | no input                                      | GeckoTerminal new pools when enabled, each keyed by `poolRef` (`address` or Uniswap V4 `poolId`, Decision 0052); risk screening `unavailable`                                                                                                                                                                                                                                                           | `implemented` | `explicitly-disabled` by default until GeckoTerminal terms are verified; enabled on the Development stack only (Decision 0050)                                                                        |
| `GET /v2/market/smart-money`              | no input                                      | Always `unavailable` (`SMART_MONEY_RUNTIME_DEFERRED`)                                                                                                                                                                                                                                                                                                                                                   | `implemented` | `explicitly-disabled` (D21)                                                                                                                                                                           |

Every market number is a canonical decimal string inside a fact object
`{value, source, fetchedAt, ttlSeconds, quality, reasonCode}`. Provider
responses are parsed losslessly (no JSON number becomes a JavaScript number),
throttled to the Provider's documented limit, cached in `market_fact_cache`
with the SHA-256 digest of the raw body, and served as `stale` only inside the
grace window when the Provider cannot be reached. A disabled Provider closes
its own facts and never borrows another source. Derived candles are aggregated
by the `pool_event` indexer lane (`pnpm indexer:backfill --lane pool_event`)
and priced in the pool's other token, never in USD.

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
| `GET /v2/notification-preferences`             | —                                                               | Ten categories; `security.event` locked on                                               | `implemented` | `implemented`                                                                                          |
| `PUT /v2/notification-preferences`             | No `Idempotency-Key`; `{expectedVersion, categories}` (all ten) | Committed preferences; `security.event: false` is `INVALID_REQUEST`                      | `implemented` | `implemented`; an optional category off also suppresses that event's push (Decision 0067)              |

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

| Method and path                                       | Request                                                                                                    | Success projection                                                                                                              | Interface     | Capability                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/wallet-intents/send/preflight`              | Write headers, no `Idempotency-Key`; `{walletId, address, chainId?}`                                       | Checksummed recipient, `isContract`, `isFirstRecipient`, screening `unavailable`, warning keys                                  | `implemented` | `implemented`; GoPlus address screening `blocked-provider`                                                                                                                                                                                                                          |
| `POST /v2/wallet-intents/send`                        | `Idempotency-Key`; `{walletId, assetId, amount, recipientAddress}`                                         | Immutable send intent: review, `unsignedTransaction`, `reviewSha256`, `simulation`, `policy`, `expiresAt`                       | `implemented` | `implemented` on Development inside the canary (Decision 0065: assets, 5 USD per intent, 25 USD rolling day, counterparty allowlist); `blocked-product-legal` everywhere else                                                                                                       |
| `POST /v2/wallet-intents/approve`                     | `Idempotency-Key`; `{walletId, assetId, spenderAddress, allowance, acknowledgeUnlimited?}`                 | Approve intent with decoded `approve(spender, value)`; the ceiling prices `min(allowance, balance)`                             | `implemented` | same switch and canary as `send`; the spender walks the counterparty allowlist                                                                                                                                                                                                      |
| `POST /v2/wallet-intents/revoke`                      | `Idempotency-Key`; `{walletId, assetId, spenderAddress}`                                                   | `approve(spender, 0)` intent                                                                                                    | `implemented` | same switch; a revoke removes exposure and is exempt from the counterparty allowlist                                                                                                                                                                                                |
| `POST /v2/wallet-intents/{intentId}/broadcast-report` | `Idempotency-Key`; `{txHash}`                                                                              | `submitted` after `eth_getTransactionByHash` matches the payload; mismatch is `VALIDATION_FAILED` and audited                   | `implemented` | open on Development; device broadcast still unverified (no funded wallet)                                                                                                                                                                                                           |
| `GET /v2/wallet-intents/{intentId}`                   | —                                                                                                          | State machine, hash, Provider action ID, reason code, receipt with confirmations                                                | `implemented` | `implemented`                                                                                                                                                                                                                                                                       |
| `GET /v2/wallet-intents`                              | `cursor` or `limit` (1–50)                                                                                 | Newest-first intents                                                                                                            | `implemented` | `implemented`                                                                                                                                                                                                                                                                       |
| `POST /v2/wallet-intents/{intentId}/cancel`           | `Idempotency-Key`; no body                                                                                 | `cancelled` for open intents; later states are `DATA_STALE`                                                                     | `implemented` | `implemented`                                                                                                                                                                                                                                                                       |
| `POST /v2/swap/quote`                                 | Write headers, no `Idempotency-Key`; `{walletId, sourceAssetId, destinationAssetId, amount, slippageBps?}` | Privy quote snapshot with 30 s expiry, price impact decision, `swapPolicyV1`, canary value                                      | `implemented` | `blocked-provider`; observed 2026-09-22: Privy answers `403 Swaps are not enabled for this app`, published as `503 CAPABILITY_UNAVAILABLE` (Decision 0065); device evidence still pending                                                                                           |
| `POST /v2/wallet-intents/swap`                        | `Idempotency-Key`; `{walletId, quoteId, confirmPriceImpact?}`                                              | Swap intent with `authorizationPayload` the device signs; stays `prepared` (`SWAP_SIMULATION_PROVIDER_PENDING`)                 | `implemented` | `blocked-provider`; no Provider simulation, evidence pending                                                                                                                                                                                                                        |
| `POST /v2/wallet-intents/{intentId}/execute`          | `Idempotency-Key`; `{authorizationSignature}`                                                              | One `wallets.swap.execute`; `submitted` / `failed` / `unknown`; a second call is `SUBMISSION_UNKNOWN`                           | `implemented` | `blocked-provider`; never run locally                                                                                                                                                                                                                                               |
| `GET /v2/approvals?walletId=`                         | —                                                                                                          | Spenders from indexed `Approval` events with live `allowance()` reads at one block; `freshness.approvalCoverageFromBlockNumber` | `implemented` | `blocked-provider`; `INDEXING_DELAYED` until the transfer lane has a checkpoint **and** Approval coverage (`approval_coverage_from_block`, migration 000025) reaches the wallet's earliest indexed activity; `pnpm indexer:backfill --lane erc20_transfer --from <block>` lowers it |
| `GET /v2/approvals/{assetId}/{spender}?walletId=`     | —                                                                                                          | One live allowance                                                                                                              | `implemented` | `implemented`; GoPlus approval facts `unavailable`                                                                                                                                                                                                                                  |

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
only the intents that may still spend) and
`BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST` (empty = every counterparty admitted).
The switch is on for the Development stack only. Ambiguous Provider
results become `unknown` and are reconciled by the default-off
`wallet-intent-reconcile` worker lane, never replayed; a late device
broadcast on an expired or cancelled intent is accepted only when the chain
already shows the matching payload. No transaction has been broadcast or
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

| Method and path                                         | Request                                                                       | Success projection                                                                                                                                                                  | Interface                                                                  | Capability                                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/chat/token`                                   | Write headers incl. UUIDv4 `Idempotency-Key`                                  | `{apiKey, token, expiresAt, user:{id}}` in camelCase                                                                                                                                | `implemented`                                                              | `blocked-provider` without Stream credentials or the persistent quota                                                                                                |
| `POST /v2/video/token`                                  | Write headers                                                                 | Same shape, separate quota bucket                                                                                                                                                   | `implemented`                                                              | as above                                                                                                                                                             |
| `POST /v2/chat/groups`                                  | Write headers; `{name, friendPublicProfileIds}`                               | V2 projection of the V1 group operation; 202 + `Location` if pending                                                                                                                | `implemented`                                                              | `implemented`; friendship stays the only admission rule                                                                                                              |
| `POST /v2/chat/direct-channels`                         | Write headers; `{targetPublicProfileId}`                                      | V2 projection of the V1 direct operation; 202 + `Location` if pending                                                                                                               | `implemented`                                                              | `implemented`; the unordered pair converges on one CID                                                                                                               |
| `GET /v2/chat/direct-channels`                          | Bearer + contract/client headers; `limit` 1–50 or `cursor`                    | `{items:[{streamCid, peer: connections `profile` shape                                                                                                                              | null, createdAt}], nextCursor}`; peer null = no presentable public profile | `implemented`                                                                                                                                                        | `implemented`; `direct_channels` is the authority, Stream is never read; no Stream user ID projected (Decision 0056) |
| `GET /v2/chat/operations/{operationId}`                 | Bearer + contract/client headers; no payload                                  | camelCase operation; `operatorRequired` is terminal and unresolved                                                                                                                  | `implemented`                                                              | `implemented`; unknown operation and wrong owner share one `NOT_FOUND`                                                                                               |
| `DELETE /v2/chat/groups/{groupId}/membership`           | Write headers; no payload                                                     | `{groupId, membership: null}`                                                                                                                                                       | `implemented`                                                              | `implemented`; the Stream removal precedes the LOOP commit                                                                                                           |
| `POST /v2/communities/{communityId}/voice-rooms`        | Write headers; no payload                                                     | `201` room resource with the creator as host                                                                                                                                        | `implemented`                                                              | `implemented`; owner or admin only; one live room per community; create then `go_live`, `backstage: false` when provisioned, else `reconciling` (0054)               |
| `GET /v2/communities/{communityId}/voice-rooms/current` | Bearer + contract/client headers                                              | The live room, or `null` with `COMMUNITY_VOICE_ROOM_NOT_LIVE`                                                                                                                       | `implemented`                                                              | `implemented`; `observed.participantCount` (live session) vs `memberCount` (authorized), own `observedAt` (0051); heals a backstage room once (0054)                 |
| `GET /v2/voice-rooms/{voiceRoomId}`                     | Bearer + contract/client headers                                              | Room incl. `communityName` (0052), viewer role, viewer hand raise, `joinedCount` incl. host                                                                                         | `implemented`                                                              | `implemented`; non-members are `PERMISSION_DENIED`; heals a backstage room once, read still answers on failure with `providerSync` unconfirmed (0054)                |
| `GET /v2/voice-rooms/{voiceRoomId}/hand-raises`         | Bearer + contract/client headers                                              | Pending queue in sequence order; `sequence` is a decimal string; entries carry the roster identity projection (`publicProfileId`/`display`/`isSelf`/`commands`, 0053), no `profile` | `implemented`                                                              | `implemented`; the order is a PostgreSQL fact, not a client guess; anonymous raisers unaddressable to non-hosts                                                      |
| `POST /v2/voice-rooms/{voiceRoomId}/join`               | Write headers; no payload                                                     | Room resource with the caller's role, `expiresAt`, counts observed after the Stream write                                                                                           | `implemented`                                                              | `implemented`; idempotent, re-join refreshes `joinedAt`; unprovisioned room or call still in backstage is `CAPABILITY_UNAVAILABLE` (`VOICE_ROOM_BACKSTAGE_NOT_LIVE`) |
| `POST /v2/voice-rooms/{voiceRoomId}/leave`              | Write headers; no payload                                                     | Room resource with `viewer.role: null`, counts observed after the Stream write                                                                                                      | `implemented`                                                              | `implemented`; the host must end the room instead; a no-op 200 for an account not in the live room (0069)                                                            |
| `POST\|DELETE /v2/voice-rooms/{voiceRoomId}/hand-raise` | Write headers; no payload                                                     | Room resource with the viewer's hand raise; `providerSync` reports the one custom call event                                                                                        | `implemented`                                                              | `implemented`; one pending raise per account; a second raise is `DATA_STALE`; sends `loop_event_kind: voiceRoomHandRaise` on the call as the host (0069)             |
| `GET /v2/voice-rooms/{voiceRoomId}/members`             | Bearer + contract/client headers; `role` required, `cursor`/`limit` exclusive | LOOP joined roster of one role view with leaderboard display rule, `handRaised`, `muted`, `commands[]` (0052/0053)                                                                  | `implemented`                                                              | `implemented`; authorization roster, never Stream presence; anonymous rows unaddressable to non-hosts; non-host gets only `unmute_self` on its own muted speaker row |
| `POST\|DELETE /v2/voice-rooms/{id}/speakers/{pid}`      | Write headers; no payload                                                     | Room resource plus `providerSync`                                                                                                                                                   | `implemented`                                                              | `implemented`; host-only; grants or revokes Stream `send-audio`; clears the mute intent                                                                              |
| `POST /v2/voice-rooms/{id}/speakers/{pid}/mute`         | Write headers; no payload                                                     | Room resource plus `providerSync`                                                                                                                                                   | `implemented`                                                              | `implemented`; host-only; LOOP mute intent then one Stream `muteUsers` for that member (0052)                                                                        |
| `DELETE /v2/voice-rooms/{id}/speakers/{pid}/mute`       | Write headers; no payload                                                     | Room resource; `providerSync` always confirmed (no Stream write)                                                                                                                    | `implemented`                                                              | `implemented`; the muted speaker itself or the host (0053); clears `muted_at`, audits `speaker_unmuted`; unmuted/listener target `DATA_STALE`                        |
| `POST /v2/voice-rooms/{voiceRoomId}/mute-all`           | Write headers; no payload                                                     | Room resource plus `providerSync`                                                                                                                                                   | `implemented`                                                              | `implemented`; host-only; sets the mute intent on every joined speaker                                                                                               |
| `POST /v2/voice-rooms/{voiceRoomId}/end`                | Write headers; no payload                                                     | Ended room; every later write is `DATA_STALE`                                                                                                                                       | `implemented`                                                              | `implemented`; host-only                                                                                                                                             |

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

| Method and path                       | Request                                                                                         | Success projection                                                                                                                                                                                                                                   | Interface     | Capability                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/devices`                     | Bearer + contract/client headers; optional `X-Loop-Session-ID`                                  | Owner's device sessions (newest first, ≤100), `sessionShortId`, `isCurrent`, `isCurrentDevice` (Decision 0049), `riskSignals` (≥2 new sessions in 24h), `revokeAll` unavailable                                                                      | `implemented` | `implemented`; `lastSeenAt` is the bootstrap time                                                                                                                       |
| `POST /v2/devices/{sessionId}/revoke` | Logout header set incl. `Idempotency-Key`, `X-Loop-Session-ID`; no body                         | `{session: {sessionId, status: revoked, revokedAt}}`; durable `revoke` command                                                                                                                                                                       | `implemented` | `implemented`; own session → `AUTH_STEP_UP_REQUIRED` (MFA not connected)                                                                                                |
| `POST /v2/devices/push-token`         | Logout header set incl. `Idempotency-Key`, `X-Loop-Session-ID`; `{platform, token, appVersion}` | `{registered: true, pushTokenId, platform, provider: fcm, appVersion, observedAt}`; the registration token is never echoed                                                                                                                           | `implemented` | `implemented` (Decision 0067); refused `CAPABILITY_UNAVAILABLE`/`PUSH_RUNTIME_DEFERRED` without a Firebase credential; revoked or foreign session → `SESSION_NOT_FOUND` |
| `DELETE /v2/devices/push-token`       | Same header set; no body                                                                        | `{registered: false, revokedAt, observedAt}`; `revokedAt: null` when the session had none                                                                                                                                                            | `implemented` | `implemented` (Decision 0067); always available, including while push delivery is not                                                                                   |
| `POST /v2/devices/revoke-all`         | Same header set; no body                                                                        | Always `403 AUTH_STEP_UP_REQUIRED`; nothing persisted                                                                                                                                                                                                | `implemented` | `blocked-provider`; needs Privy MFA evidence                                                                                                                            |
| `GET /v2/security/capabilities`       | Bearer + contract/client headers                                                                | Six items (`mfa`, `passkey`, `recoveryPassword`, `autoRecovery`, `socialRecovery`, `keyExport`) all `unavailable` + evidence                                                                                                                         | `implemented` | `blocked-provider`; `PRIVY_<X>_EVIDENCE_PENDING`                                                                                                                        |
| `GET /v2/security/summary`            | Bearer + contract/client headers                                                                | Devices block, approvals summary of the active wallet, locked `security.event`, last 10 security notifications; no score                                                                                                                             | `implemented` | `implemented`; approvals block `unavailable` without `sendApprovals` runtime/RPC/indexer                                                                                |
| `GET /v2/settings`                    | Bearer + contract/client headers                                                                | `{settings: {displayCurrency: USD, language: zh-CN}, version, updatedAt, policy}`; version 0 without a write                                                                                                                                         | `implemented` | `implemented`                                                                                                                                                           |
| `PUT /v2/settings`                    | Same headers, no `Idempotency-Key`; `{expectedVersion, settings}`                               | Committed resource; CAS on `expectedVersion`; non-fixed value is `VALIDATION_FAILED`                                                                                                                                                                 | `implemented` | `implemented`; both values are product constants in this step                                                                                                           |
| `POST /v2/support/tickets`            | Command headers incl. `Idempotency-Key`; `{category, body ≤2000 code points}`                   | `201` ticket envelope (`200` on exact replay); events, `attachments` unavailable, `policy`                                                                                                                                                           | `implemented` | `implemented`; 20 tickets per owner per 24h; attachments `explicitly-disabled`                                                                                          |
| `GET /v2/support/tickets`             | `cursor` or `limit` (1–50)                                                                      | Newest-first tickets with lifecycle events                                                                                                                                                                                                           | `implemented` | `implemented`; status advances only via `pnpm support:answer`                                                                                                           |
| `GET /v2/meta/about`                  | Public; no input                                                                                | `contractVersion`, every published `configVersion` (`bscWriteCanary` only while BSC writes are enabled, `clientPolicy` only when it differs from `productPolicy`, Decision 0049), `termsGate`, open-source attribution summary, `clientBuild: local` | `implemented` | `implemented`; terms document URLs are not published                                                                                                                    |

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
`avatarUpload` capability is not module-gated and stays `unavailable` with
`AVATAR_STORAGE_NOT_SELECTED` until a storage Provider decision exists.
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

## Implemented routes

| Method and path      | Request                    | Success projection            | Interface     | Capability                                                                                     |
| -------------------- | -------------------------- | ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health/live`   | No input                   | `{status, service, version}`  | `implemented` | `implemented`                                                                                  |
| `GET /health/ready`  | No input                   | `{status, checks:{database}}` | `implemented` | `implemented`                                                                                  |
| `POST /v1/bootstrap` | Bearer only; no body/query | `{user:{id}, stream_user_id}` | `implemented` | `blocked-provider`; server verifier exists, but phone-issued-token evidence remains unverified |

`GET /openapi.json` is a conditional Development documentation endpoint when
`API_DOCS_ENABLED=true`; it is not a mobile business route.

## Passkey relying-party discovery (Decision 0063)

The API origin is the relying party for LOOP passkeys, so it publishes the two
static association files the platform credential managers fetch. Both are
unauthenticated, carry no user or session fact, are excluded from the OpenAPI
artifacts (`hide: true`), and are the only LOOP responses that are not
`Cache-Control: no-store`. An unconfigured file is absent (`404`), never an
empty document: an empty statement list would make a broken association look
configured.

| Method and path                               | Request  | Success projection                                                                                                                                     | Interface     | Capability                                                                                                                    |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/assetlinks.json`            | No input | One `android_app` statement with `package_name` and `sha256_cert_fingerprints`; `Content-Type: application/json`, `Cache-Control: public, max-age=300` | `implemented` | published only when `PASSKEY_ANDROID_CERT_SHA256` is set, otherwise `404`; platform acceptance on a real device is unverified |
| `GET /.well-known/apple-app-site-association` | No input | `{webcredentials:{apps:["<TEAMID>.<BUNDLEID>"]}}`; same headers                                                                                        | `implemented` | `404` today: LOOP has no `PASSKEY_IOS_TEAM_ID`                                                                                |

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

| Method and path                                         | Key contract                                                                                                                          | Interface     | Capability    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| `GET /v1/profile/social-privacy`                        | Owner-only version; missing row is version 0 with friend requests, group invites, and direct messages all disabled                    | `implemented` | `implemented` |
| `PUT /v1/profile/social-privacy`                        | Full CAS replacement; no `Idempotency-Key`; exact enabled/disabled and friends/disabled preferences                                   | `implemented` | `implemented` |
| `GET /v1/friends`                                       | Accepted friends with public-profile ID/code, nullable current presentation, acceptance time, and encrypted owner-bound keyset cursor | `implemented` | `implemented` |
| `GET /v1/friends/search`                                | Shared-quota public Alias prefix search plus none, outgoing-pending, incoming-pending, or friend relationship state                   | `implemented` | `implemented` |
| `POST /v1/friend-requests`                              | UUIDv4 command key equals operation ID; target only by public-profile ID; explicit pending request, no reverse-request auto-accept    | `implemented` | `implemented` |
| `GET /v1/friend-requests`                               | Incoming or outgoing pending requests only, with owner/filter/page-size-bound encrypted cursor                                        | `implemented` | `implemented` |
| `POST /v1/friend-requests/{friend_request_id}/decision` | Recipient-only idempotent accept/reject; first decision wins; only accept creates the friendship                                      | `implemented` | `implemented` |
| `GET /v1/social/operations/{operation_id}`              | Owner-bound terminal local result; unknown/wrong owner is the same 404                                                                | `implemented` | `implemented` |

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
