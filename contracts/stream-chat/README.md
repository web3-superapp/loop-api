# LOOP Stream Chat contract

> **Runtime status notice — 2026-08-29:** Decisions 0003, 0004, and 0021
> supersede this contract's earlier server-token transport and Node runtime
> status. The private backend now pins the separately reviewed and accepted
> `@stream-io/node-sdk@0.7.63`, composes its ordinary one-hour user-token issuer,
> and uses the Native Privy Bearer contract. Local signing is not credentialed
> Stream or device evidence. The acceptance recorded by Decision 0021 covers
> only that Node SDK version; it does not accept or enable the Flutter SDKs
> catalogued below. Flutter, provider end-to-end, Chat/Video behavior, and the
> large-group gates in this contract remain pending.

Stream is the sole communication authority for production Chat and Stream Video/Audio Rooms. LOOP does not implement a parallel message store, socket protocol, delivery engine, member database, moderation service, attachment CDN, custom communication-authentication core, participant presence system, SFU/WebRTC transport, or media reconnect engine. The LOOP BFF does own one narrow authentication responsibility: use the Stream-supported server token mechanism and server-only secret to mint short-lived provider user tokens for authenticated internal user IDs. It does not invent a token format, expose the secret, or become an independent Chat identity authority. This directory is a reviewable provider contract, not a chat backend or RTC backend.

## Current scope status

Stream Chat + Stream Video/Audio Rooms is the current provider selection. It is
not live: this repository contains no installed production SDK, composed server
runtime, deployed token endpoint, Stream credentials, or credentialed device
evidence. Paths and operations below describe the target fail-closed contract;
they do not prove an available service.

LOOP identity is an opaque internal user ID. Wallets are bindable credentials
attached to that identity and must never be used as a Stream user ID or durable
account primary key. Chat token cards and other risk-related presentation may
carry only verifiable facts with source and observation time; they may not claim
an AI Guard verdict or synthesize a numeric risk score. Pay and payment backend
work are outside the current phase.

The proposed persistent 200,000-member single group is a provider-confirmation
Go/No-Go. It stays blocked until Stream confirms in writing the exact member
limit, persistence and history semantics, concurrent-connection behavior,
moderation, pagination, rate limits, pricing, support model, and SLA. Without
accepted written confirmation, LOOP must use partitioned groups/topic channels
with an application-level directory and aggregate discovery experience. It must
not assume, simulate, or custom-build a single 200,000-member provider channel.

## Delivery state

- **credentials later:** the owner has not supplied a Stream application, public API key, secret, or Enterprise entitlements.
- Production therefore **fails closed** (`fail closed`). Missing API key, server token endpoint, token provider, injected official SDK bridge, role grant, or channel capability leaves Chat unavailable; it never falls back to a custom transport or the fixture.
- The migrated HTML prototype expected a thin boundary at `src/stream-chat-provider.js`, after `wallet-transfer.js` and before `app.js`. Those paths are historical contract evidence, not files or a runtime entry point in this backend repository. Any future production composition must remain fail closed and make no connected/ready success claim before credentialed proof.
- The migrated prototype's explicit offline fixture was at `src/test-fixtures/stream-chat-offline-fixture.js`, with historical `build.py` rules excluding it from `app.html`. None of those files is a runtime path in this repository. Their names are retained only as provenance for deterministic read-only review data, never as evidence of a connected Stream environment.
- This contract slice performs **no SDK install/import**. It records exact future Flutter pins and the required injected-bridge shape without adding package/build dependencies; it does not verify a current bridge or runtime.
- The real server framework, entry point, Stream server-SDK composition, and deployed token endpoint are all `PENDING`; no current contract field points to a production file in this repository.

## Boundary

The target flow authenticates to LOOP first. A future `POST /v1/chat/token` endpoint must use a same-origin authenticated session and CSRF protection and accept no client-selected `user_id`. The BFF must derive a random opaque internal chat subject matching exactly `^loop_[a-z0-9_-]{8,58}$`, mint an expiring Stream user token with the server-only secret, and return `Cache-Control: no-store`. Flutter will supply that endpoint as the official SDK token provider after deployment. The OpenAPI file records this target grammar; it is not evidence that the endpoint exists.

The target thin LOOP adapter must delegate only the pinned client's direct `queryMembers` and `getMessage` API queries, same-provider-object reconciliation, independent Chat/Video disconnect, and Audio Room operations to injected official SDK bridges. It must implement no Chat transport or state engine. Stream's Chat controllers/channel state and Video `CallState` remain authoritative. Channel listing must not be delegated until a proven no-write official server/BFF listing path closes the current `PENDING` gate, because the pinned client path has a delivery side effect.

## Every Chat provider mutation is gated

The gate is deliberately broader than message sends and classifies operations by the pinned SDK's actual call graph, not by names such as “query” or flags such as `watch: false`. In the official SDK, `connectUser` upserts the user, `channel.watch()` is get-or-create, and `queryChannels(watch: false)` still submits returned channels to `ChannelDeliveryReporter`, which schedules `markChannelsDelivered` calls. These persistent provider writes make `connect_user`, `watch_channel`, and `query_channels` mutations; all must fail closed alongside message, thread, reaction, read/unread, moderation, and attachment mutations. A compliant future bridge must expose none of `connectUser`, `watchChannel`, `queryChannels`, `markChannelsDelivered`, `markRead`, or `markUnread` before the gate closes; attempted public operations must return `STREAM_CHAT_PROVIDER_MUTATION_PENDING`. No boolean or side-effect alias may bypass the gate.

`watch: false` is not proof of a read-only channel list. The locked `stream_chat` 10.3.0 `client.dart` and `channel_delivery_reporter.dart` hashes in `sdk-lock.json` prove the delivery-receipt path. Channel listing remains PENDING until an official server/BFF query is pinned and both source inspection and credentialed runtime evidence prove that it performs no provider write. No guessed substitute or ordinary client `queryChannels` alias may bypass that gate. The remaining `queryMembers` and `getMessage` bridges are classified from their direct pinned-source API calls, which contain no client mark-read, watch, or delivery-reporter hook.

## RetryQueue and ambiguous writes

The pinned `stream_chat` 10.3.0 source is explicit: `RetryQueue` listens for `connection.recovered`, then calls `channel.state?.retryFailedMessages()`. `Channel.sendMessage` also places retriable network failures in that retry queue. This candidate has no credentialed Flutter evidence that the automatic retry path can be safely suppressed or avoided. It therefore does not claim `refresh_do_not_replay` as an implemented behavior: every exposed production Chat provider mutation is **disabled and PENDING** with `STREAM_CHAT_PROVIDER_MUTATION_PENDING` until the real bridge is audited.

The future integration must assign the Stream `Message.id` before first submission and retain that same provider stable ID across the submit, response receipt, and authoritative `getMessage` query. An ambiguous result is held and reconciled with that same provider stable ID. Releasing the ID, refreshing, and replaying it is forbidden; changing to a new ID without fresh user reconfirmation is also forbidden. If the official SDK retry cannot be made safe under this model, Chat writes stay fail closed.

## Lossless events and exact Video projections

LOOP does not use milliseconds, event categories, or a synthetic object version to discard Stream signals. Every admitted official signal is projected in arrival order. Repeated signals are allowed; convergence comes from the provider object identity and a fresh official SDK projection/query. Thus distinct `reaction.new` and `reaction.updated` signals in the same millisecond are both retained. A stable provider event ID may be carried for observability, but the adapter does not turn it into a parallel state authority.

For Stream Video 1.4.3, the exact participant events are `call.session_participant_joined` and `call.session_participant_left`. They normalize to a fresh participant projection. Connection comes from `StreamVideo.state.connection`; call status comes from `CallState.status`; real-time participants come only from `CallState.callParticipants`. That participant projection is documented by Stream as truncated to 250 entries, while `CallState.participantCount` supplies the count. `queryMembers` is not treated as real-time participant presence, and rooms requiring a complete live roster over 250 stay PENDING.

Attachments remain Stream-owned. The picker mirrors the server's allowlist and size policy for early UX, while Stream settings are final. Signed channel URLs are member-scoped and expire; URLs/tokens are not persisted. An expired message attachment is refreshed through `getMessage`. Cleanup runs only for a definitively unsent/cancelled upload; an ambiguous send is refreshed before deletion.

Privacy uses a random internal ID, never a wallet address. Alias and avatar are mutable presentation fields. Tokens, signed URLs, wallet addresses, private keys, phrases, and other secrets are excluded from persistent state and logs. Export and deletion are authenticated server workflows using Stream tasks.

## Dependency and license gate

The official Chat Flutter package family is pinned to `10.3.0` (tag commit `34cd23c2b7be77f3788e65698072dbecb0ddd077`) and Stream Video/UI Kit to `1.4.3` (tag commit `c0bb3bce2d0503145b29a10eaea5df37929a131a`) with pub.dev archive SHA-256 values in `sdk-lock.json`.

Important: the current `v10.3.0` repository license is the proprietary **Stream Source Code License Agreement**, not BSD/MIT. It requires a current Stream customer and contains use/distribution restrictions. Procurement/legal acceptance and the signed Stream commercial terms are an R0 **license review** gate before downloading/installing the SDK or shipping it. No auxiliary OSS adapter is used in this slice.

## Credentialed R0 release gates

1. Token identity binding, expiry/refresh, CSRF, rate limits, logout, replay resistance, and secret/log scans.
2. Credentialed proof for `connectUser` identity/upsert behavior, real channel creation/membership/capability/role tests, and `channel.watch()` get-or-create behavior; server calls bypass client permission checks and need separate authorization tests. Channel listing needs a pinned official server/BFF no-write implementation plus negative evidence against ordinary `queryChannels(watch: false)` delivery writes, or it remains disabled.
3. Credentialed source/runtime proof for either safe suppression/avoidance of the official RetryQueue auto-retry path or continued production mutation disablement; two-device message/update/delete, thread, reaction, mark-read/unread, pagination, reconnect, same-ID reconciliation, and ambiguous-outcome tests.
4. Upload type/size policy, progress/cancel, orphan cleanup, signed URL membership denial, 14-day expiry refresh, and deletion tests.
5. Flag/mute/ban/moderator/hard-delete workflows and audit evidence.
6. Privacy retention, export, pruning/hard deletion, and incident-log redaction tests.
7. Written Stream confirmation for the target persistent 200,000-member single group, followed by credentialed proof of messages, replies, reactions, mentions, read semantics, member pagination, concurrent connections, moderation, rate limits, pricing, support, and SLA. If written confirmation is absent or rejects any required semantic, the release architecture must use partitioned groups/topic channels instead.
8. Stream Audio Room proof for target audience tiers: role/capability grants, backstage/go-live, join/leave, request-to-speak, microphone permissions, moderator mute/kick/block/end, interruption/background/audio-route behavior, reconnection failure, participant privacy, the 250-entry real-time projection boundary, and the sales-confirmed 500/5,000/50,000 listener delivery model.

Until all R0 evidence passes, any future production composition stays fail closed and production Chat remains unavailable. The migrated HTML seam and fixture are historical provenance only and must never be selected as the LOOP API runtime.

## Official sources checked 2026-08-23

- Flutter SDK overview and server/client split: https://getstream.io/chat/docs/flutter-dart/
- Production authentication checklist: https://getstream.io/chat/docs/sdk/flutter/guides/go-live-checklist/
- Platform token provider and expiry: https://getstream.io/docs/platform/authentication/
- Reconnect recovery: https://getstream.io/chat/docs/sdk/flutter/stream-chat-flutter-core/stream-chat-core/
- Events: https://getstream.io/chat/docs/flutter-dart/event_object/
- Channels and members: https://getstream.io/chat/docs/flutter-dart/creating-channels/ and https://getstream.io/chat/docs/flutter-dart/channel-members/
- Threads, reactions, unread: https://getstream.io/chat/docs/flutter-dart/threads/ , https://getstream.io/chat/docs/flutter-dart/send_reaction/ , https://getstream.io/chat/docs/flutter-dart/unread/
- Attachments: https://getstream.io/chat/docs/flutter-dart/file-uploads/
- Moderation and permissions: https://getstream.io/chat/docs/sdk/flutter/guides/moderation/ and https://getstream.io/docs/platform/permissions/
- Privacy export/delete: https://getstream.io/chat/docs/flutter-dart/exporting_channels/ and https://getstream.io/chat/docs/flutter-dart/update_users/
- Official package metadata: https://pub.dev/packages/stream_chat_flutter
- Official Chat RetryQueue source at v10.3.0: https://github.com/GetStream/stream-chat-flutter/blob/v10.3.0/packages/stream_chat/lib/src/client/retry_queue.dart
- Official Chat Channel send/retry source at v10.3.0: https://github.com/GetStream/stream-chat-flutter/blob/v10.3.0/packages/stream_chat/lib/src/client/channel.dart
- Official Chat client source at v10.3.0 (`queryChannels` to delivery reporter and `markChannelsDelivered`): https://github.com/GetStream/stream-chat-flutter/blob/v10.3.0/packages/stream_chat/lib/src/client/client.dart
- Official Chat delivery reporter source at v10.3.0: https://github.com/GetStream/stream-chat-flutter/blob/v10.3.0/packages/stream_chat/lib/src/client/channel_delivery_reporter.dart
- Stream Video Flutter overview, exact call events, Audio Room tutorial, call state, and moderation: https://getstream.io/video/docs/flutter/ , https://getstream.io/video/docs/flutter/guides/call-events/ , https://getstream.io/video/sdk/flutter/tutorial/audio-room/ , https://getstream.io/video/docs/flutter/guides/call-and-participant-state/ , https://getstream.io/video/docs/flutter/guides/permissions-and-moderation/
- Official Video package metadata: https://pub.dev/packages/stream_video_flutter
