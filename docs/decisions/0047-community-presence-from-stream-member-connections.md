# Decision 0047: The community "online" number is read from Stream

- Status: Accepted (S22c). Supersedes the constant `communityPresence`
  capability and the constant `onlineCount` projection from Decision 0031.
- Date: 2026-09-16
- Scope: `onlineCount` on `GET /v2/communities/{id}` (and the same field on
  the four writes that return the community resource), the
  `communityPresence` capability, and the Stream community channel gateway.
  No migration; `members.counts.online` on
  `GET /v2/communities/{id}/members` is unchanged (see "Deferred").

## Context

`onlineCount` was typed `UnavailableProjection` and hard-wired to
`STREAM_PRESENCE_NOT_CONNECTED` at both projection sites; `communityPresence`
was `unavailableCapability(...)`. No read path had ever been built, so the
number could never appear regardless of Provider state.

The task brief froze "online = the official channel's `watcher_count`". That
was probed against the Development Stream application (`qpwjdy8zjbdu`,
channel `messaging:loop_community_439cabe6…` of `builders-guild`) on
2026-09-16 before any code was written, and the premise does not hold for a
server-side reader:

| Probe (server API key + secret)                                                                                                   | `watcher_count` in response |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `GET /channels/messaging/{id}` with `state: true`, `watchers_limit: 0` and `100`                                                  | absent                      |
| `POST /channels/messaging/{id}/query` (`getOrCreate`) with `state`, `watch`, `presence`, `watchers.limit: 1/100`                  | absent                      |
| `queryChannels` filtered by `cid`, `state`, `watch`, `presence`                                                                   | absent                      |
| Same three reads **while a client websocket was watching the channel** (the client's own watch query reported `watcher_count: 1`) | absent                      |

Stream populates `watcher_count` only on responses to the watching
connection itself. A server without a websocket connection cannot observe
it, and holding a server-side websocket per community to watch its channel
would be exactly the parallel presence core `AGENTS.md` forbids.

What a server _can_ observe, verified with the same live connection:

| Probe                                                                                             | Result                                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `queryMembers` on the channel, no filter                                                          | every member carries `user.online`; it read `true` for the connected member and `false` after the socket closed |
| `queryUsers` with `id: {$in: members}`                                                            | same `online` flag per user                                                                                     |
| `queryMembers` with `{online: true}` or `{"user.online": true}`, `queryUsers` with `online: true` | empty result: the filter is silently ignored, not honoured                                                      |

So the only honest server-side presence fact is **per member, is this
user's Stream connection open right now**, and it has to be paged.

## Rulings

| Topic                | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition           | `onlineCount.count` = the number of the community's official Stream channel members whose Stream user holds a live connection at `observedAt`. It is **not** "watching this channel", **not** "active recently", and **not** LOOP membership. Copy may call it "在线"; this document is where the exact meaning lives.                                                                                                                                                                                                                                                                                                |
| Shape                | `{status: "available", count, observedAt, source: "stream_member_presence"}` or `{status: "unavailable", reasonCode}`. `observedAt` is required: this is an observation (red line 5). `source` is a closed enum naming what was measured; if a watcher-based reading ever becomes possible it is a second `source` value, not a silent change of meaning.                                                                                                                                                                                                                                                             |
| Where it is observed | Only `GET /v2/communities/{id}`. The four writes that return the community resource (`POST /communities`, `PATCH`, `join`, `leave`) return `STREAM_PRESENCE_NOT_OBSERVED`: a write must not pay a Provider read, and a stale number on a write response would be a fixture. `members.counts.online` on the member list stays `STREAM_PRESENCE_NOT_CONNECTED` (see "Deferred").                                                                                                                                                                                                                                        |
| Zero                 | `count: 0` appears only when Stream reported zero connected members over the complete member set. Every failure is `unavailable` with a reason; nothing else ever reads as zero.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Reason codes         | Kept apart, one condition each: `STREAM_PRESENCE_NOT_CONNECTED` (no Stream credentials: reader not composed), `COMMUNICATION_RUNTIME_UNAVAILABLE` (no communication repository, so no channel record to ask about), `COMMUNITY_CHANNEL_NOT_PROVISIONED` (no channel row or not yet created on Stream), `COMMUNITY_CHANNEL_PROVISION_FAILED`, `STREAM_PRESENCE_READ_FAILED` (Stream fault, deterministic rejection, or a member without a boolean `online`), `STREAM_PRESENCE_READ_TIMEOUT` (budget exceeded), `STREAM_PRESENCE_MEMBER_BOUND_EXCEEDED` (see "Bound"), `STREAM_PRESENCE_NOT_OBSERVED` (write response). |
| Read path            | `StreamCommunityChannelGateway.readCommunityChannelPresence` pages `queryMembers` (`limit 100`, `offset`, `sort created_at asc`, empty filter) and counts `user.online === true`. It is read-only: no `getOrCreate`, no membership change. A member without a boolean `online` is a projection mismatch, never counted as offline.                                                                                                                                                                                                                                                                                    |
| Bound                | At most 5 pages (500 members) per read. When every page comes back full the gateway reports `bound_exceeded` and the field reads `STREAM_PRESENCE_MEMBER_BOUND_EXCEEDED`: a count of the first 500 is not a total and is not published. Development communities are far below this; raising it or replacing paging with a cached aggregate is a follow-up (see "Deferred").                                                                                                                                                                                                                                           |
| Timeout              | `createCommunityPresenceReader` races the gateway against a 3 000 ms budget (the same `streamProviderTimeoutMilliseconds` every Stream gateway uses), aborts the signal, and returns `STREAM_PRESENCE_READ_TIMEOUT`. The reader never throws, so `community`, `viewer`, `chat`, `voice`, and `miningPower` are unaffected by a slow or failed Stream answer.                                                                                                                                                                                                                                                          |
| Visibility           | Whoever may read the community detail may read the number; membership is not required. It publishes a count, never who is online.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Capability           | `communityPresence` reads runtime, the same pattern as `communityMining` (0043): `available` when the presence reader is composed (Stream credentials or an injected gateway) **and** the communication runtime is available; otherwise `STREAM_PRESENCE_NOT_CONNECTED` without credentials, `COMMUNICATION_RUNTIME_UNAVAILABLE` with credentials but no communication runtime. Evidence stays `notApplicable`, so the S9 capabilities baseline (no Stream) is byte-identical.                                                                                                                                        |
| Composition          | `buildApp` composes the reader from the community channel gateway when `config.stream !== null` or a gateway is injected; the gateway is created before the community service for that reason. Unit tests never reach Stream: the gateway is exercised with a stubbed `fetch`, the reader and routes with a fake gateway.                                                                                                                                                                                                                                                                                             |

## Deferred

- `members.counts.online` (member list) and any per-row presence stay
  unavailable. A list must not pay one Stream read per row. The intended
  path is a short-TTL (10–30 s) per-community cache of the observation this
  decision already produces, filled by the detail read and, later, by a
  single `queryUsers` batch (`id: {$in: [...]}`, up to 100 IDs per call) for
  the page's members. Either needs its own decision because it introduces a
  cache and a staleness contract (`observedAt` would then be the cache fill
  time, which still satisfies red line 5).
- The 500-member bound. Options, in order of preference: the same cache
  filled by the worker lane on a schedule (so a large community pays the
  paging cost once per interval, off the request path), or a Stream
  feature that returns an aggregate. Neither exists today.
- A watcher-based `source` if Stream ever exposes `watcher_count` to a
  server read. The shape is ready for it.

## Verification

- Probe evidence: the table above, produced by a one-off script (deleted;
  it used only the Development application and a 5-minute user token for
  one existing member) on 2026-09-16.
- Unit: `test/stream-communication-gateways.test.ts` "community channel
  presence" (two-page count `12/103` with the exact `payload` query,
  `bound_exceeded` after five full pages, mismatch on a missing `online`,
  500 → unavailable, 404 → rejected, non-community ID rejected before any
  request); `test/community-presence-reader.test.ts` (hand-written available
  shape with a fixed clock, real zero, the channel-side reasons before any
  Stream call, every gateway error → `READ_FAILED`, bound, a 20 ms budget
  that aborts the signal and reports `READ_TIMEOUT`, the unavailable reader
  and the not-observed constant); `test/v2-community-routes.test.ts`
  "Community presence from Stream member connections" (detail read
  available with `observedAt` in the past and one gateway call, join
  response `NOT_OBSERVED`, real zero, five unavailable reasons with the rest
  of the resource intact, and the capability in both directions plus the
  Stream-without-communication direction).
- Real read against Development (`builders-guild`, 2 channel members),
  through `createStreamCommunityChannelGateway` and
  `createCommunityPresenceReader` exactly as `buildApp` composes them, on
  2026-09-16: nobody connected →
  `{"status":"available","count":0,"observedAt":"2026-09-16T06:44:37.448Z","source":"stream_member_presence"}`;
  one member connection open →
  `{"status":"available","count":1,"observedAt":"2026-09-16T06:44:39.224Z","source":"stream_member_presence"}`;
  connection closed →
  `{"status":"available","count":0,"observedAt":"2026-09-16T06:44:41.063Z","source":"stream_member_presence"}`.
- Gate: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm openapi:check && pnpm test`
  and `pnpm test:integration` on an isolated database; results in the S22c
  report.
