# Decision 0039: Audio-room role evidence switch (`voiceRooms.evidence`)

- Status: Accepted (backend); the Dashboard evidence itself is still pending
- Date: 2026-09-10
- Scope: S15 backend. Adopts the main-agent rulings of 2026-09-10. The user
  may overturn any row.

## Context

Decision 0005 made the Stream Dashboard role export a pre-condition for voice
rooms, and Decision 0032 (revised 2026-09-08, BUG-03) fixed the subject of that
evidence: the `user` call role — the role a LOOP `listener` receives, because
the application defines no `listener` role — must not carry `create-call` on
the `audio_room` call type.

Until now `src/features/meta/product-policy.ts` hard-coded
`voiceRooms.evidence = {status: "pending", reasonCode: "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING"}`
and `V2CapabilityEvidenceStatus` knew only `notApplicable | pending`. The
mobile client treats that reason code as "keep the whole voice-room page
unavailable" (`docs/frontend-v2-communication-api.md`). Operations can now
produce the Dashboard screenshot (the first screenshot of 2026-09-10 still
showed `Any call` for the `user` role and is being corrected), but no
configuration existed that could publish the evidence as confirmed. The page
would have stayed unavailable forever.

This decision adds the switch. It does not add the evidence: the backend
still cannot observe Dashboard permissions, so the confirmation is an
operator statement recorded in configuration, and it is published as such.

## Rulings adopted (main agent, 2026-09-10)

| Topic               | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Configuration       | New optional key `STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF` (API process only). Blank or unset keeps today's behaviour. Non-blank: trimmed, 1–120 characters, no control / format / surrogate / private-use / unassigned code points (`\P{C}` only); anything else is a `ConfigurationError` at startup. Example: `dashboard-2026-09-10-user-role-no-create-call`.                                                             |
| Evidence projection | Unset → `{status: "pending", reasonCode: "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING"}` (unchanged). Set → `{status: "confirmed", reasonCode: null, reference: <value>}`.                                                                                                                                                                                                                                                           |
| Availability        | Unchanged. `voiceRooms.availability` is still decided by the `communication` module gate and the composed runtime (repository, community runtime, Stream credentials). The evidence is reported the same way whether the capability is `deferred`, `unavailable`, or `available`; the module gate never hides it and the evidence never opens the gate.                                                                        |
| Contract            | `V2CapabilityEvidenceStatus` gains `confirmed`. `evidence` gains the optional key `reference`, present only on `voiceRooms` and only while `confirmed`; on every other capability and while pending the key is **absent, never `null`** (the Decision 0038 rule). With `LAUNCH_CHAIN_ID` unset and this key unset or blank, `GET /v2/meta/capabilities` stays byte-identical to `test/fixtures/s9-baseline/capabilities.json`. |
| Startup log         | When the key is set, `buildApp` logs one `info` line `{capabilityId: "voiceRooms", evidenceReference}` so a deployment that publishes `confirmed` is traceable. The reference is an archive label; no secret is involved or logged.                                                                                                                                                                                            |
| Archive             | The screenshot is archived wherever operations decides; it is not committed to this repository. `.env.example` documents the requirement.                                                                                                                                                                                                                                                                                      |
| Worker              | The reconciliation worker does not parse the key: no worker lane projects capabilities. (The Decision 0038 parity rule covered chain slots, not this label.)                                                                                                                                                                                                                                                                   |

## Evidence requirements

The reference may be set only after a Stream Dashboard export (screenshot or
permission export) that shows **all** of the following for the Development
application LOOP uses:

| Permission  | `user` role on call type `audio_room` | `user` role under Global video permissions |
| ----------- | ------------------------------------- | ------------------------------------------ |
| Create call | **Not allowed**                       | **Not allowed**                            |
| Read call   | Allowed                               | Allowed                                    |
| Join call   | Allowed                               | Allowed                                    |
| Update call | Own only                              | Own only                                   |
| End call    | Own only                              | Own only                                   |
| Delete call | Not allowed                           | Not allowed                                |

Both columns are required: a per-type restriction is not evidence while the
global permission still grants `Any call`. The 2026-09-10 screenshot that
showed `Any call` therefore does **not** satisfy this decision; the key stays
blank until the corrected export exists. The label recorded in the key should
identify that export unambiguously (date and subject), because it is
published verbatim to the client and written to the startup log.

## Implementation

- `src/config.ts`: `optionalEvidenceReference` schema (trim, 1–120,
  `/^\P{C}+$/u`), key `STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF`,
  `AppConfig.streamAudioRoomUserRoleEvidenceRef: string | null`.
- `src/features/meta/product-policy.ts`: `V2CapabilityEvidenceStatus` adds
  `confirmed`; `V2CapabilityProjection.evidence.reference?: string`;
  `voiceRoomsCapability` builds the evidence from configuration alone and
  keeps the module/runtime branches as they were.
- `src/routes/v2/meta.ts`: `evidence.status` enum adds `confirmed`;
  `evidence.reference` (optional string, 1–120) under the existing
  `additionalProperties: false` object. `openapi/loop-api.v2.json`
  regenerated.
- `src/app.ts`: one `app.log.info` line when the key is set.
- `.env.example`, `docs/frontend-v2-communication-api.md`,
  `docs/api-inventory.md`, `docs/local-development.md`, and Decision 0032
  updated; 0032's "pending evidence" wording now points here.

## Tests

- `test/config.test.ts`: unset/blank → `null`; trimmed value, 1 and 120
  characters, non-ASCII printable text accepted; 121 characters (also when
  padded) refused; NUL, ESC, tab, newline, CR, DEL, NEL, zero-width space,
  RLO, BOM, and BEL refused with `must not contain control`.
- `test/v2-communication-routes.test.ts`: confirmed + available (module and
  runtime composed), confirmed + `unavailable` (module enabled without the
  community runtime), confirmed + `deferred` (module not enabled); the
  `reference` key appears on `voiceRooms` only; every other capability keeps
  exactly `["status", "reasonCode"]`; the confirmed document differs from the
  pending one in the `voiceRooms` entry only.
- `test/v2-chain-wallet-routes.test.ts`: the S9 baseline test now also runs
  with `STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF=""` and still requires the
  byte-identical `capabilities.json`.

## Consequences

- The client's rule becomes `availability === "available" &&
evidence.status === "confirmed"` for opening the voice-room page. A client
  that only checks the reason code still works: while pending the document
  is unchanged.
- `confirmed` is an operator assertion, not a backend observation. If the
  Dashboard permissions change later, nothing in the backend notices; the
  operator must clear the key. That is the same trust model as
  `BSC_USD1_VERIFIED` and the reason the value is published and logged rather
  than hidden.
- No other capability uses `confirmed` yet. Reusing the status for another
  evidence slot requires its own decision naming the evidence and the key.

## Rollback

Clear `STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF` and restart: the evidence
returns to `pending` and the document to its pre-0039 bytes. Reverting the
code removes the `confirmed` enum value and the `reference` key; a client
that never saw a confirmed document is unaffected.
