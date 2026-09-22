# Decision 0067: A push is a pointer to a fact the feed already holds

- Status: Accepted
- Date: 2026-09-22
- Scope: `POST`/`DELETE /v2/devices/push-token`, the FCM HTTP v1 sender, the
  `device_push_tokens`, `device_push_token_commands`, and `push_deliveries`
  tables (migration 000037), and the first three push events. Extends
  Decisions 0034 (notification feed and preferences) and 0037 (device
  sessions); no ruling in either is reversed.

## Context

Decision 0034 delivered the context notification feed, the ten preference
categories, and the price-alert evaluator, and closed push with one sentence:
`pushNotifications` is `unavailable` with `PUSH_RUNTIME_DEFERRED`, because no
Provider account, no credential, and no device-token lifecycle existed. The
account now exists: a Firebase project with an APNs key uploaded, and a
service-account JSON on the Development host. This decision builds the channel
that was deliberately missing, and nothing more.

The risk a push channel adds is not delivery failure. It is that a push is the
only LOOP surface that can be read without opening LOOP: it lands on a lock
screen, it is stored by the operating system, it is sent through two external
parties (Google, and for iOS also Apple), and it can be seen by whoever is
holding the handset. 03 §15.1 therefore bans wallet addresses, balances,
verification codes, recovery material, and exploitable security detail from
notification content, and requires re-authentication and a re-read on tap.

## Rulings

| Topic              | Ruling                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider           | FCM HTTP v1 only. Android is addressed natively; iOS is addressed through the APNs key uploaded to the same Firebase project. LOOP holds one credential and never calls APNs directly.                                                                            |
| Credential         | `FIREBASE_SERVICE_ACCOUNT_JSON_PATH` — a **file path**, read once at composition. The key never enters the environment, the config projection, a log line, or an API response. No Google SDK is added: the RS256 assertion is signed with `node:crypto`.          |
| Missing credential | `pushNotifications` stays `unavailable` with `PUSH_RUNTIME_DEFERRED`, and `POST /v2/devices/push-token` is refused with `503 CAPABILITY_UNAVAILABLE` (`detailsSafe.reasonCode`). A client never holds a token the backend would silently never use.               |
| Payload            | Exactly four keys: `type`, `entityRef`, `contextRoute`, `eventVersion`. Visible text is localization keys the device renders. No amount, address, ticker, balance, code, community name, or message body is ever sent.                                            |
| `entityRef` shape  | `<opaqueType>:<uuid>`, enforced by a pattern before the Provider call. The shape structurally excludes an address and a decimal amount; a producer that tries throws instead of sending.                                                                          |
| Token binding      | One active token per device session, one active row per token. The token is accepted only for the caller's own **active** session whose stored device and platform match the headers; otherwise `404 SESSION_NOT_FOUND`.                                          |
| Session end        | Logout and remote revoke retire the token in the **same transaction** as the session (`revoke_reason = 'session_revoked'`). A session that is gone stops being an address without a second write anyone could forget.                                             |
| Idempotency        | Both writes require an `Idempotency-Key` UUIDv4 recorded in `device_push_token_commands`. A replay returns the first outcome; the same key with a different request digest is `409 IDEMPOTENCY_CONFLICT`. Re-sending the same token keeps the same `pushTokenId`. |
| At most once       | `push_deliveries` is unique on `(push_token_id, event_key)`. The slot is taken **before** the Provider call, so a timeout can never become a second push.                                                                                                         |
| Rate limit         | Per device, per rolling hour: 20 optional events and 10 mandatory events, counted separately so a flood of community or alert pushes can never crowd out a security event.                                                                                        |
| Preferences        | Optional events consult `notification_preferences_v2` in the same SQL that selects targets, defaulting to the Decision 0034 product default. `security_event` is mandatory, has no preference row, and is never gated.                                            |
| Failure            | A suppressed, rate-limited, unauthorised, or failed push never changes what the producer already committed and never fails the caller's command. The in-app feed stays the authoritative record.                                                                  |

### Event dictionary, first batch

| `type`                         | Category                 | Gate       | `entityRef`               | `contextRoute` |
| ------------------------------ | ------------------------ | ---------- | ------------------------- | -------------- |
| `price_alert_triggered`        | `trade.priceAlert`       | preference | `priceAlert:<alertId>`    | `token`        |
| `security_event`               | `security.event`         | mandatory  | `deviceSession:<id>`      | `devices`      |
| `community_voice_room_started` | `community.announcement` | preference | `voiceRoom:<voiceRoomId>` | `voice-room`   |

`security_event` has two producers: a remote revocation (Decision 0037,
already a feed row) and a **new-device sign-in**, added here. A device is new
when the account already has another session and no other session — active or
revoked — was ever created on that device. Both write the feed row first; the
dedupe key is the session ID, so one session raises the event once, ever.

`price_alert_triggered` is sent only when `recordTrigger` actually wrote a
notification (`notificationId !== null`). A trigger collapsed by the dedupe
window, or suppressed by the owner's preference, wrote nothing and rings
nothing.

`community_voice_room_started` fans out to the community's active members,
excluding the host, bounded at 200 devices, and is **detached** from the
host's command: a member's handset must never be able to slow down or fail
the creation of a room.

### What a delivery row stores, and what it does not

`push_deliveries` holds the event type, an opaque event key, whether the event
was mandatory, the outcome, a reason code, and the FCM message name. It holds
no payload, no title or body, no address, and no amount. The row exists for
three jobs — at-most-once, the hourly budget, and an audit of what was
attempted — and none of them needs content. The table is append-only and a
resolved row is immutable, enforced by trigger.

A transient Provider failure is recorded as `failed` and is **not** retried:
there is no retry lane in this step, and the feed row is already there. This
is stated rather than hidden, because a silent retry queue would be the one
way a user could receive the same push twice.

### Capability and evidence

`pushNotifications` becomes `available` only when the Firebase credential, the
push repository, and the `notifications` module are all composed. Its
`evidence` stays `pending` with `PUSH_DEVICE_DELIVERY_EVIDENCE_PENDING`: no
physical handset has acknowledged a LOOP push yet, so an available capability
still does not claim a proven delivery path. The `push` block on the feed and
preferences resources, and the `delivery` block on a price alert, report the
same two states instead of the previous hard-coded `unavailable`.

## What is not in this decision

- No retry lane, no scheduled re-send, and no delivery receipt from the device.
- No notification centre: the feed is still read inside the context that owns
  its entries.
- No marketing, referral, mining, launch, or trade-result push: those
  categories exist in preferences but have no producer yet.
- No web push, no email, no SMS.
- No topic or segment messaging: every send addresses one device token, so
  every send is bounded by a row LOOP owns.

## Rollback

Unset `FIREBASE_SERVICE_ACCOUNT_JSON_PATH`. The capability returns to
`unavailable` with `PUSH_RUNTIME_DEFERRED`, registration is refused,
unregistration keeps working, every producer falls back to feed-only, and no
schema or route changes. Existing token rows stay until their sessions end.
