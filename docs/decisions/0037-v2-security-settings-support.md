# Decision 0037: V2 device sessions, security centre, account settings, support tickets, and public about

- Status: Accepted (backend); Privy security-method evidence open
- Date: 2026-09-09
- Scope: S8 backend (D20 `security devices key-export social-recovery
settings about support`). The main-agent rulings of 2026-09-08 in
  `LOOP/docs/modules/S8-profile-security-closeout.md` are adopted below. The
  user may overturn any row.

## Context

D20 closes the Profile axis. Everything that touches Privy security methods
(MFA, passkey, recovery password, automatic recovery, social recovery,
private-key export) still lacks Privy plan/SDK/physical-device evidence (03
§5.2, §19), so the backend may only say "unavailable, and here is why". What
the backend does own is the device-session audit projection from Decision
0027, a small account-level settings slot, support tickets, and a public
about/legal projection. None of it moves funds or touches a Provider.

## Rulings adopted (main agent, 2026-09-08)

| Topic       | Ruling                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Devices     | `GET /v2/devices` (all `device_sessions` of the account with the current-device marker, `lastSeenAt`, platform, `authStrength`); `POST /v2/devices/{sessionId}/revoke` with `Idempotency-Key`; revoking the caller's own session needs a step-up → `AUTH_STEP_UP_REQUIRED` always, MFA is not connected. High-risk new device = ≥2 sessions created in the last 24h. |
| Six methods | All read from `GET /v2/security/capabilities`, each `{status: unavailable, reasonCode: PRIVY_<X>_EVIDENCE_PENDING}`; the client shows the reason and a how-to-enable explanation; no local simulation; `key-export` is explanation plus a non-executable button.                                                                                                     |
| Security    | `security` page summary: device count, active sessions, approvals summary (S6 `GET /v2/approvals` `summary`), the mandatory security notification category, latest `security.event` notifications; no score.                                                                                                                                                         |
| Settings    | Account-level `GET/PUT /v2/settings` (`displayCurrency: USD` fixed, `language: zh-CN` fixed, `reduceMotion` stays local); logout is the existing V2 logout; network/notification/privacy/security/help rows are entry points.                                                                                                                                        |
| About       | Public `GET /v2/meta/about`: server `contractVersion`, `configVersion` list, terms version slot (`termsGate`), open-source attribution summary from `docs/open-source-attribution.md`; client version/build stay on the device.                                                                                                                                      |
| Support     | `POST /v2/support/tickets` (`Idempotency-Key`; category enum; body ≤2000 code points; attachments unavailable), `GET /v2/support/tickets?cursor=`; status `open\|answered\|closed` advanced only by the Dev script; emergency escalation is copy.                                                                                                                    |

## Implementation rulings

### Module gate and capabilities

Three new module IDs (`security`, `settings`, `support`) join
`V2_MODULES_ENABLED` and `v2ModuleRegistrars`. Their capabilities are
`available` only when the module is enabled and its runtime is composed:
`security` needs the session runtime (`V2_SESSION_ENABLED` plus Privy
credentials, because device sessions are the same projection), `settings` the
account-settings repository, `support` the support-ticket repository plus the
V2 cursor codec. The capability list grows to 31 entries (with S7); the
mobile enum is synchronised by the S8 frontend task. MFA, passkey, recovery, and key
export are deliberately **not** entries in `GET /v2/meta/capabilities`: they
are account-facing security methods, published by `GET /v2/security/capabilities`
with `evidence: pending`, and every one is `unavailable` in this step.

### Device sessions (`src/features/security/device-service.ts`)

- `GET /v2/devices` accepts the common read headers plus an optional
  `X-Loop-Session-ID`. The header only sets `isCurrent`/`currentSessionId`;
  it never authenticates. The list is newest-first, active rows before
  revoked rows, capped at 100 (`truncated` flags the cap; owner quotas from
  Decision 0027 bound growth). `lastSeenAt` remains the bootstrap observation
  time (Decision 0027); no presence signal is implied.
- `riskSignals.highRiskNewDevice = newSessions24h >= 2` with the policy
  (`deviceRiskV1`, 24 h, threshold 2) published beside it. It is a page hint;
  no server-side MFA or cooldown is enforced yet (03 §10.5 remains a Go/No-Go
  item).
- `POST /v2/devices/{sessionId}/revoke` uses the logout header set (client
  version, contract, device ID, platform, `X-Loop-Session-ID`,
  `Idempotency-Key`). When the path session equals the header session the
  route answers `AUTH_STEP_UP_REQUIRED` before any persistence. Otherwise the
  repository writes a `device_session_commands` row with `command_kind =
'revoke'` and digest version `device_session_revoke_v1` (SHA-256 over
  `revoke`, target, caller session, device, platform, client version, contract
  version), flips the session to `revoked`, and appends the same
  `session_revoked` event as logout. Missing and foreign sessions are the
  non-enumerating `SESSION_NOT_FOUND` command result; exact replay returns the
  same `revokedAt`; a different digest under the same key is
  `IDEMPOTENCY_CONFLICT`. The 40/owner/day command quota is shared with logout.
- A successful revoke records one `security.event` notification (main-agent
  ruling 2026-09-09): `entityRef deviceSession:<sessionId>`, `contextRoute
devices`, payload `session_revoked` with device, platform, `revokedAt`, and
  the revoking session; `dedupeKey security.event:deviceSession:<id>:revoked:<UTC day>`,
  `source: loop_session`, so replays and repeated revokes add nothing. The
  write is best effort after the durable revocation: a feed failure never
  undoes or hides the revoke and is logged at `warn` with the session, owner,
  and request ID. `NotificationRepository.record` is the producer entry point.
- `POST /v2/devices/revoke-all` is registered so the client can show the
  reason instead of simulating it; it is always `AUTH_STEP_UP_REQUIRED` and
  never writes.

### Security centre (`src/features/security/security-service.ts`)

- `GET /v2/security/capabilities`: six fixed items in a fixed order, each
  `unavailable`, `reasonCode = evidence.reasonCode = PRIVY_<X>_EVIDENCE_PENDING`,
  plus a `guideKey` localisation key for the how-to-enable text.
- `GET /v2/security/summary` composes four blocks and never a score:
  `devices` (distinct active device IDs, active sessions, the 24 h signal),
  `approvals` (the S6 `ApprovalService.list` summary and freshness for the
  account's active wallet), `notifications.securityEvents` (`security.event`,
  `enabled: true`, `locked: true`, the Decision 0034 invariant), and
  `recentSecurityEvents` (the last 10 `security.event` notifications through
  the new `NotificationRepository.listRecentByType`). Each block is
  `available` or `unavailable` with the owning module's reason:
  `SEND_APPROVALS_RUNTIME_DEFERRED` (module off),
  `WALLET_INTENT_RUNTIME_UNAVAILABLE` (runtime not composed),
  `WALLET_RUNTIME_UNAVAILABLE`, `WALLET_NOT_SELECTED`, or the approvals
  route's own error code (`INDEXING_DELAYED`, `CAPABILITY_UNAVAILABLE`, …);
  `NOTIFICATIONS_RUNTIME_UNAVAILABLE`; `ACCOUNT_SESSION_RUNTIME_UNAVAILABLE`.
  A block failure never becomes a 500 or a zero.

### Account settings (`src/features/settings/`)

- `account_settings` (owner PK, `display_currency` check `= 'USD'`,
  `language` check `= 'zh-CN'`, `record_version`, timestamps). `GET` without
  a row is version 0 with the fixed defaults and writes nothing.
- `PUT /v2/settings` rejects `Idempotency-Key` (conventions, Decision 0030)
  and is CAS on `expectedVersion`. Because every value is fixed, the profile
  rule "identical content returns the committed record regardless of
  version" would make a conflict unreachable; the settings rule is therefore
  narrower: `expectedVersion === committed` commits `committed + 1`,
  `expectedVersion === committed − 1` is the lost-response retry of the write
  that produced the committed row and returns it, anything else is
  `VERSION_CONFLICT`. A value other than the fixed constant is
  `VALIDATION_FAILED` (422); an unknown field (`reduceMotion`, `theme`) is
  `INVALID_REQUEST`. The resource publishes `policy.fixed` and
  `policy.localOnly = [reduceMotion, theme]` so the client does not hard-code
  either.

### Support tickets (`src/features/support/`)

- Categories `account | security | wallet | trade | launch | mining |
community | other`. Body: same character-safety rule as alias (no control,
  bidirectional-control, or invisible formatting characters; shape failures
  are `INVALID_REQUEST`), trimmed, 1–2000 Unicode code points (`VALIDATION_FAILED`
  above), enforced again by the table check (`loop_alias_text_is_safe`,
  `char_length ≤ 2000`).
- `POST /v2/support/tickets` uses the community command header set
  (`Idempotency-Key` required, device/platform optional). The key binds to
  `idempotency_records` under scope `support_ticket_create`, digest version
  `support_ticket_create_v1` = SHA-256 of (`category`, `body`). Same key and
  digest replays the ticket with 200; a different digest or another owner is
  `IDEMPOTENCY_CONFLICT`. Creation is bounded to 20 tickets per owner per
  rolling 24 h (`RATE_LIMITED`). Every ticket carries its `events` (version 0
  `created` by `user`) and `attachments: {unavailable,
SUPPORT_ATTACHMENTS_UNAVAILABLE}`; no attachment column exists.
- `GET /v2/support/tickets` is an owner-bound cursor list (`supportTickets`
  route, filter `all`, keyset `(created_at, ticket_id)` row comparison with a
  microsecond-precise `createdAtCursor`, limit 1–50, default 25,
  `CAPABILITY_UNAVAILABLE` without a cursor secret). The notification feed
  cursor moved to the same row comparison and precision.
- Status moves only through `pnpm support:answer <ticketId> [note]`
  (`open → answered`) and `pnpm support:answer <ticketId> --close [note]`
  (`open|answered → closed`). The script refuses `NODE_ENV=production`, sanitises
  the note with the same text rule, and appends an `operator` event. The
  `support_tickets` trigger refuses deletes, any change to the immutable
  columns, and backwards status moves; `support_ticket_events` is append-only.
- `supportPolicyV1` (24 h response window, business days, escalation is copy)
  is published on every response so the page text is not hard-coded.

### About (`GET /v2/meta/about`)

Public, no headers, no input. Publishes `contractVersion`, the
`configVersions` list from the central registry
`src/features/meta/config-version-registry.ts` (each entry references the
owning module's constant: `productPolicy`, `sessionPolicy`, `community`,
`marketTrending`, `deviceRisk`, `accountSettings`, `support`, `swapPolicy`,
`bscWriteCanary`; `clientPolicy` with `effectiveAt` is appended from
configuration per request), the same `termsGate` union as the client policy,
and `openSource`. The attribution is a compiled constant
(`src/features/meta/open-source-attribution.ts`) carrying name, purpose, and
license only (versions live in `pnpm-lock.yaml` and are not published) rather
than a runtime file read: the Docker runtime image does not ship `docs/`, and
a build-time constant cannot fail at request time. Drift is caught by
`test/v2-meta-about.test.ts`, which parses the register table in
`docs/open-source-attribution.md` and compares names and licenses.
`clientBuild` is `{status: local, reasonCode: CLIENT_BUILD_IS_DEVICE_LOCAL}`:
the app version and build number never come from the server.

### Persistence

Migration `000024_v2_security_settings_support` (000023 is taken by the
parallel S7 branch): widens `device_session_commands` to the `revoke` kind and
its digest version, adds `support_ticket_create_v1` to
`idempotency_records`, and creates `account_settings`, `support_tickets`, and
`support_ticket_events` with the triggers above. Rollback refuses while any
ticket, event, settings row, revoke command, or support idempotency record
exists.

## Consequences

- The `devices`, `security`, `settings`, `about`, and `support` pages have a
  backend; `key-export` and `social-recovery` render only the reason and the
  guide. Nothing here proves a physical-device flow.
- `GET /v2/meta/capabilities` has 31 entries and `openapi/loop-api.v2.json`
  125 operations after the merge with S7 (Decision 0036).
- The `NotificationRepository` interface gains `listRecentByType`; fakes in
  the alert-evaluator and notifications route tests implement it.

## Go/No-Go and open items

- **Privy security methods**: MFA, passkey, recovery password, automatic
  recovery, social recovery (2-of-3, guardian revocation, audit), and key
  export need Privy plan/SDK/device evidence before any of the six items may
  leave `unavailable`; step-up for self-revoke and revoke-all depends on the
  same MFA evidence.
- **High-risk new device**: the signal is published; enforcing MFA or a
  cooldown (03 §10.5) waits for the MFA decision.
- **Terms/privacy/risk documents**: `termsGate` names a version only; document
  URLs are not published until legal supplies them.
- **Support operations**: the Dev script is the only status path; the reviewed
  Admin console and RBAC (D17) replace it.

## Rollback

Remove `security`, `settings`, `support` from `V2_MODULES_ENABLED` (routes
404, capabilities `deferred`); `GET /v2/meta/about` is always registered with
the meta routes and has no persistence. The migration's `down` runs only while
the new tables and the revoke commands are empty.
