# Decision 0097: Swaps of a community's bound asset by its members become LOOP feed messages (群友买入)

- Status: Proposed (S108)
- Date: 2026-10-08
- Scope: one new reconciliation-worker lane (`community_member_buy_feed`), migration `000047` (tables `community_feed_cursors`, `community_member_buy_events`, index `account_wallets_active_address_idx`), one new Stream gateway method (`sendCommunityFeedMessage`) and Stream user (`loop_feed_bot`), the pure swap rule `classifySwap()` extracted from the public trades read, a bound-asset rule on `POST /v2/communities` / `PATCH /v2/communities/{id}`, and a new `boundAsset` block on the community resource. No new route, no new error code (one new `reasonCode`), no `/v1` change.
- Baseline: `integration/v2` = `f7c165f`
- Inputs: `LOOP/docs/modules/S108-S110-social-batch2b.md` §0, §1, §2.1, §6; `LOOP/docs/09` §6.1 item 3; Decisions 0032, 0033, 0089, 0094, 0095 §3.

## Context

docs/09 asks for "群友买入" in community chat: when a member buys the community's own token, the chat shows it. LOOP already indexes PancakeSwap V3 `Swap` logs of registered pools (`indexed_pool_events`, lane `pool_event`, Decision 0033) and already decides buy/sell for the public trades read (Decision 0095 §3). What was missing: a consumer-side position over those facts, a way for the server to post into a community channel, and a guarantee that `communities.bound_asset_key` names an asset LOOP can observe at all.

## Decision

### 1. Entities and IDs

| Entity                        | Key                                                      | Notes                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community_feed_cursors`      | `(lane, chain_id)`; lane ∈ {`community_member_buy_feed`} | `(last_block_number, last_log_index)` = consumed through that log. `last_log_index = 2147483647` means "the whole block".                                                 |
| `community_member_buy_events` | `(chain_id, transaction_hash, log_index, community_id)`  | One row per (swap log, community) the lane matched to an active member. `buyer_user_id` (internal, never leaves the API), `block_number`, `outcome`, `stream_message_id`. |
| Stream message                | `loop_buy_` + first 32 hex of `sha256(chainId            | txHash                                                                                                                                                                    | logIndex | communityId)` | Deterministic; the de-duplication key on the Stream side. |
| Stream user                   | `loop_feed_bot`                                          | `name: "LOOP"`, no `image`, `custom.loop_bot = true`.                                                                                                                     |

Nothing is keyed by a wallet address; the address only joins a swap to an `account_wallets` row inside one SQL statement.

### 2. Scope of one pass

1. Eligible community: `verification_status = 'verified'` and `bound_asset_key` not null.
2. Read pool: `pools.status = 'registered'` on the chain and one of its tokens is an eligible community's bound asset.
3. Swaps: `indexed_pool_events`, `event_kind = 'swap'`, `removed = false`, `(block_number, log_index)` strictly after the cursor and `block_number ≤` the `pool_event` checkpoint; oldest first; at most **200** per pass.
4. Member match, per (swap, community): an `account_wallets.status = 'active'` address equal to `payload.recipient` or `payload.sender`, owned by an `active` member of that community with an `active` profile. The recipient wins when both sides are members. A swap that matches nobody is just passed by the cursor.
5. Classification: `classifySwap()` (§4). Only `kind = buy` **and** base asset = the community's bound asset is a member buy.
6. Gate: `coalesce(trade_history_visibility, 'everyone') = 'everyone'` and `coalesce(anonymous_mode, false) = false` (the Decision 0095 defaults for a missing row). Otherwise skipped; no anonymous variant.
7. Channel: the community's `community_channels.stream_channel_id` with `provisioned_at` set; otherwise skipped.
8. Limit: **20 messages per community per pass**; further buys of that community in the pass are recorded `truncated` (not sent) and one warn line `MEMBER_BUY_FEED_TRUNCATED` per community.

### 3. State machine of an event row

`outcome` ∈ `pending → sent | rejected`, or a terminal decision at insert time: `truncated`, `skipped_not_buy`, `skipped_private`, `skipped_no_channel`.

- A buy to send is inserted `pending` with its message ID **before** the Stream call, then settled `sent` (Stream stored it, or Stream already holds that ID) or `rejected` (a deterministic Stream 4xx that is not a duplicate). `stream_message_id` is set exactly for `pending | sent | rejected` (check constraints).
- Any row that is not `pending` is never touched again; a `pending` row found on a later pass is re-decided and resent under the same ID (a crash between the insert and the send loses nothing and duplicates nothing).
- **Ruling (rows for sells and private buyers):** every member-matched swap gets a row, including `skipped_not_buy` and `skipped_private`. Reason: the row is the de-duplication key and the operator's answer to "why did this buy not show up" (the S108 acceptance step "trade_history=self 的成员不出现" is checked against it). It records nothing that is not already public on chain and in `indexed_pool_events`; it is internal (no route reads it) and holds the internal user ID only.

### 4. `classifySwap()`

`src/features/chain/swap-classification.ts`, shared by the public trades read (`public-profile-service.ts`, behavior unchanged) and the lane. Quote set = WBNB, USDT, USDC and the verified USD1 (`BSC_USD1_TOKEN_ADDRESS` + `BSC_USD1_VERIFIED`; the worker now parses the same pair the API does). Base = the non-quote token; when both or neither are quote assets, token0. Pool-perspective negative base amount = the pool paid it out = **buy**; anything else is sell. Stable set (USDT, USDC, USD1) drives `quoteIsStable`.

### 5. Cursor rules

- **First run** initializes the cursor to the then-current `pool_event` checkpoint, whole block (`2147483647`). History is never replayed into a channel.
- **Never ahead of the indexer:** a pass reads only `block_number ≤ checkpoint`. If the cursor is at or past the checkpoint (caught up, or the indexer rewound below it) the pass waits (`waiting_for_indexer`) and reads nothing.
- A short page (< 200 swaps) moves the cursor to `(checkpoint, whole block)`; a full page or a stall moves it to the last fully handled swap. The cursor only moves forward (SQL guard).
- Without any `pool_event` checkpoint the lane idles (`indexer_not_started`).

### 6. Reorg (ruling)

- A swap row with `removed = true` is never handled.
- **A message already sent is not withdrawn.** The `pool_event` lane commits only blocks `BSC_CONFIRMATIONS` (default 15) behind head and detects reorgs by block hash, so a reorg that removes a log the feed already consumed is outside the configured confirmation depth. Withdrawing would require an edit/delete path for bot messages and a second consumer of `removed` flips; not worth it at this depth.
- Logs that a deep reorg (or a newly registered pool's backfill) inserts **below** the cursor are not processed. Same reasoning; the trades read on the profile still shows them.

### 7. Stream send (`sendCommunityFeedMessage`)

- `StreamCommunityChannelGateway.sendCommunityFeedMessage({ streamChannelId, messageId, text, custom, signal })`: lazily upserts `loop_feed_bot` once per gateway instance (retried on the next send if it failed), then `channel.sendMessage({ message: { id, type: "regular", text, user_id: "loop_feed_bot", custom }, skip_push: true })`. The bot is **not** added as a channel member; server-side requests are not subject to channel permissions.
- A deterministic 4xx is followed by `getMessage(id)`: if Stream holds that ID the result is `duplicate` (success); otherwise `StreamChannelRequestRejectedError` → row `rejected`, pass continues. Any other failure is unavailable → the pass **stalls** at the last fully handled swap (cursor saved), logs `MEMBER_BUY_FEED_STREAM_UNAVAILABLE`, and the next pass resends.
- Input is validated before any request: community channel ID, `loop_buy_` ID, 1–200 code-point text, flat `custom` of ≤ 32 keys whose values are strings (≤ 256), booleans, null, or non-negative safe integers. The unavailable gateway rejects with `StreamChannelGatewayUnavailableError`.
- No push this batch (communities default to mute; the message stream is enough). A `community_member_bought` push is a to-do.
- Side effect: `readCommunityChannelMessages` (Community AI, Decision 0066) returns bot messages with `authorUserId: null`, exactly like any non-LOOP author.

### 8. Message payload (`custom`, schema `member_buy.v1`)

`text` = `群友买入 · {SYMBOL}` (no identity; notification and old-client fallback).

| Key                           | Type                   | Value                                                                                                      |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `loop_schema`                 | string                 | `member_buy.v1`                                                                                            |
| `loop_event_kind`             | string                 | `memberBuy`                                                                                                |
| `publicProfileId`             | string                 | buyer's public profile ID (name/avatar resolved live by the client)                                        |
| `assetId`, `symbol`           | string                 | bound asset                                                                                                |
| `decimals`                    | integer                | bound asset decimals                                                                                       |
| `amountRaw`                   | decimal-integer string | bought amount, absolute                                                                                    |
| `quoteAssetId`, `quoteSymbol` | string                 | the other side (e.g. `USDT`, `WBNB`)                                                                       |
| `quoteDecimals`               | integer                | quote decimals                                                                                             |
| `quoteAmountRaw`              | decimal-integer string | paid amount, absolute                                                                                      |
| `quoteIsStable`               | boolean                | quote is USDT/USDC/USD1                                                                                    |
| `txHash`                      | string                 | `0x` + 64 hex                                                                                              |
| `logIndex`                    | integer                |                                                                                                            |
| `chainId`                     | string                 | `eip155:56`                                                                                                |
| `blockNumber`                 | decimal-integer string |                                                                                                            |
| `blockTimestamp`              | string \| null         | **ISO-8601 UTC with `Z` and milliseconds**, never seconds; null only when the indexer stored no block time |

`quoteSymbol` and `quoteDecimals` go beyond the module sheet's list at the S108-mobile request (formatting a non-stable quote line); they are always sent. Amounts are chain facts, not fixtures.

### 9. Bound-asset rule and `boundAsset` (module sheet §1.3)

- `POST /v2/communities` and `PATCH /v2/communities/{id}`: a non-null `boundAssetKey` must exist in `assets` (any status), checked inside the command transaction; otherwise `422 VALIDATION_FAILED`, `detailsSafe.reasonCode = ASSET_NOT_REGISTERED`. On PATCH a key equal to the stored one is not re-checked, so a community bound before this decision keeps editing its other fields. A registered asset without a registered pool is accepted.
- The community resource (detail and every command returning it; not list rows) gains `boundAsset: { assetId, symbol, name, logoUrl, hasRegisteredPool } | null`. `null` = unbound, or bound to a key the registry does not hold. `logoUrl` is the Decision 0089 proxy URL, `null` when the `market` module is not served. `hasRegisteredPool = false` tells the management center that no 群友买入 will appear.
- S109b adds the admin/owner rule on `boundAssetKey` (`OWNER_ONLY_FIELD`); this decision does not touch permissions.

### 10. Configuration (worker process)

| Key                                            | Default         | Range                                                                                                    |
| ---------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `COMMUNITY_MEMBER_BUY_FEED_ENABLED`            | `true`          | `true`/`false`                                                                                           |
| `COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS`        | `15000`         | 5 000–600 000                                                                                            |
| `STREAM_API_KEY` / `STREAM_API_SECRET`         | —               | required; without them the lane is not constructed and logs `MEMBER_BUY_FEED_STREAM_NOT_CONFIGURED` once |
| `BSC_USD1_TOKEN_ADDRESS` / `BSC_USD1_VERIFIED` | unset / `false` | now also parsed by the worker, for the quote set only                                                    |

A failed repository read/write backs off 1 s → 60 s (`member_buy_feed_unavailable` on the shared retry line) and never stops the other lanes.

### 11. Log lines (`lane: community_member_buy_feed`)

| Level | Message                                                             | Fields                                                                                                          |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| warn  | `LOOP member buy feed lane stays idle: Stream is not configured`    | `reasonCode: MEMBER_BUY_FEED_STREAM_NOT_CONFIGURED`                                                             |
| info  | `LOOP member buy feed cursor initialized at the indexer checkpoint` | `reasonCode: MEMBER_BUY_FEED_CURSOR_INITIALIZED`, `blockNumber`                                                 |
| info  | `LOOP member buy feed posted a message`                             | `reasonCode: MEMBER_BUY_FEED_MESSAGE_SENT` / `MEMBER_BUY_FEED_MESSAGE_ALREADY_SENT`, `communityId`, `messageId` |
| warn  | `LOOP member buy feed truncated a community's pass`                 | `reasonCode: MEMBER_BUY_FEED_TRUNCATED`, `communityId`, `truncatedCount`                                        |
| warn  | `LOOP member buy feed message was rejected by Stream`               | `reasonCode: MEMBER_BUY_FEED_STREAM_REJECTED`, `communityId`, `messageId`                                       |
| warn  | `LOOP member buy feed could not reach Stream; the pass stalls`      | `reasonCode: MEMBER_BUY_FEED_STREAM_UNAVAILABLE`, `communityId`, `errorClass`                                   |

No address, user ID, profile ID, amount, or Stream body is logged.

## Unavailable behavior

No Stream pair → lane absent; no checkpoint → idle; Stream down → stall and retry with the same ID; channel not provisioned → `skipped_no_channel`. Nothing is ever posted from a fixture or a guess.

## Deployment and verification (Development)

1. `pnpm db:migrate` (000047). The worker needs no new env (Stream pair already set for `api-dev`); restart the worker. First pass logs `MEMBER_BUY_FEED_CURSOR_INITIALIZED` with the checkpoint block.
2. Bind a community to an asset that has a registered pool, e.g. via `PATCH /v2/communities/{id}` (owner) with a key from `select token0_asset_id, token1_asset_id from pools where status='registered'`; `GET /v2/communities/{id}` then shows `boundAsset.hasRegisteredPool: true`.
3. One buy on demand, using an existing indexed swap (no fabricated amounts): pick the newest buy of that asset in its pool (`amount0 < 0` when the asset is token0), set its `payload.recipient` to the test member's active wallet, and rewind the cursor to just before it:

   ```sql
   update indexed_pool_events set payload = jsonb_set(payload, '{recipient}', to_jsonb('<member wallet lowercase>'::text))
   where chain_id = 'eip155:56' and transaction_hash = '<tx>' and log_index = <i>;
   update community_feed_cursors set last_block_number = <block> - 1, last_log_index = 2147483647
   where lane = 'community_member_buy_feed';
   ```

   Within one interval the channel shows the card and the worker logs `MEMBER_BUY_FEED_MESSAGE_SENT`; `select outcome from community_member_buy_events` shows `sent`. A member with `tradeHistory = self` produces a `skipped_private` row and no message. (Rewinding replays at most 200 swaps of bound pools; only member-matched ones produce rows, already-handled ones are never resent.)

## Tests

- `test/swap-classification.test.ts`: quote/stable sets, buy, sell, both-quote, neither-quote.
- `test/member-buy-feed-service.test.ts`: idle without checkpoint; cursor initialization without replay; never past the checkpoint (caught up / rewound); public buy sent with the full payload, sell / private / anonymous skipped; base ≠ bound asset; unprovisioned channel; 20-per-community truncation with one event per community; idempotent re-read; Stream stall and same-ID resend; deterministic rejection; full-page cursor; repository failure propagates; abort.
- `test/stream-community-feed-message.test.ts`: unavailable gateway; one bot upsert then sends with `skip_push`; duplicate ID via `getMessage`; deterministic rejection; 5xx / failed upsert unavailable; malformed input refused before any request.
- `test/community-member-buy-feed-worker.test.ts`, `test/worker-runtime.test.ts`, `test/reconciliation-worker-config.test.ts`: backoff, interval, lane composition with/without Stream and switch, config defaults and ranges.
- `test/v2-community-routes.test.ts`: `ASSET_NOT_REGISTERED` envelope on POST and PATCH; `boundAsset` projection and `null`.
- `test/v2-community-member-buy-feed-migration.test.ts`, `test/community-member-buy-feed.integration.test.ts` (real PostgreSQL): bound-asset rule on create/update (unchanged legacy key allowed), `boundAsset.hasRegisteredPool` flips with a registered pool; a verified community with one public and one `self` member — public buy sent once, public sell `skipped_not_buy`, self buy `skipped_private`, removed swap ignored, swap above the checkpoint held until the checkpoint advances, history before the first checkpoint never sent, repeated and rewound passes send nothing again; 000047 rolls back and forward.

## Not done

- No push (`community_member_bought` to-do).
- No retraction of a sent message after a deep reorg (§6).
- No per-community opt-out switch; the gate is the member's own trade-history privacy.
- Sells are not posted (module sheet: buy only).
