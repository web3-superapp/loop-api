# Stream E1–E4 presentation contract

This slice is a presentation layer over the already pinned Stream Chat and Stream
Video boundary. Stream remains the only communication authority. The UI adds no
message store, delivery queue, socket, presence service, moderation service,
participant database, media transport, or reconnect engine.

This is the current communication presentation baseline, but it is not a live
integration. No Stream SDK/runtime/token endpoint is running from this repository.
The persistent 200,000-member single-group shape remains a written-provider-
confirmation Go/No-Go; until accepted, UI and backend design must assume
partitioned groups/topic channels with aggregate discovery, not a single giant
channel. User identity is the opaque internal LOOP user ID, while wallets are
bindable credentials. Risk presentation is limited to verifiable facts with
source and observation time; Pay and synthetic AI/numeric risk scoring are out of
scope.

The production prototype has no Stream credentials and therefore cannot connect.
Visible conversation data is labeled **Offline preview · not connected** and is
read-only. It is not the test fixture from `src/test-fixtures/`; that fixture remains
excluded from `app.html`. All provider writes are disabled and fail closed with
`STREAM_CHAT_PROVIDER_MUTATION_PENDING`.

`#dm` reuses the existing conversation shell within the exact 37-screen platform +
Perp manifest. The shared F11 origin remains stack-only and the four
platform-only routes remain excluded from review origins. DM transport and message
protection depend on the final provider/account policy; this prototype makes no
E2EE claim.

Audio Room status may only come from `StreamVideo.state.connection`,
`CallState.status`, `CallState.callParticipants`, and
`CallState.participantCount`. The visible roster is capped at 250 and full roster
delivery remains PENDING. Participant count is an integer from 0 through 50,000;
malformed or out-of-range projections are denied. Offline DTOs are fixed to
`disconnected` / `unavailable`, zero participants, and an empty visible roster.
The Home E3 entry consumes that same canonical DTO projection. With no verified
production Stream handle it renders `Unavailable · Stream Video not connected · 0
participants` and exposes only a non-mutating `Open preview` action; static live,
host, listener-count, connected, or joined claims fail closed.

The app has no local call state machine. Navigation session state, browser history,
BFCache restoration, and the F11 review origin persist only a screen stack—never
joined/reconnecting, microphone, hand, speaker, participant-count, or roster data.
Without a currently verified official Stream handle, reload and return paths render
the room unavailable. Production connected/joined projection remains PENDING until
that non-forgeable handle gate exists.
