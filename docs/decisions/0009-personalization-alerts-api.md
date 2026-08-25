# Decision 0009: LOOP owns local personalization and inactive alert records

- Status: Accepted
- Date: 2026-08-25

## Context

The product requires editable Profile presentation, privacy preferences, an
ordered Watchlist, price-alert management, notification preferences, and alert
history before Flutter integration begins. The current runtime has no approved
paths or persistence owner for those capabilities.

Historical prototype research proposed external application-record and
notification providers and default-denied a custom social graph, Watchlist
store, notification inbox, alert scheduler, and delivery core until ownership
was selected. That material remains useful for exact field and safety
constraints, but its adapter is not production runtime. The user has now
approved the existing Node.js/Fastify/PostgreSQL backend as the owner of the
three app-local record groups while continuing Firebase separately.

These records are not provider truth. An alias is not identity, an asset key is
not proof that a market exists, a visibility preference is not copy-trading
authorization, an alert definition is not a running evaluator, and an enabled
notification preference is not evidence of delivery.

## Decision

- Use LOOP PostgreSQL as the system of record only for the authenticated user's
  Profile presentation, privacy preferences, grouped ordered Watchlist, inactive
  price-alert definitions, notification preferences, and sanitized alert-event
  history.
- Protect every route with the existing current Privy Bearer verifier and
  bootstrap mapping. The server derives the opaque LOOP owner UUID; no request
  accepts an owner, Privy DID, wallet, provider subject, delivery target, or
  Firebase token.
- Publish these canonical operations:
  - `GET` and `PUT /v1/profile`;
  - `GET` and `PUT /v1/profile/privacy`;
  - `GET` and `PUT /v1/watchlist`;
  - `GET` and `POST /v1/alerts`;
  - `GET`, `PUT`, and `DELETE /v1/alerts/{alert_id}`;
  - `GET /v1/alerts/history`;
  - `GET` and `PUT /v1/notification-preferences`.
- GET returns explicit version-0, fail-closed defaults without writing a row.
  Full-replacement PUT requests require `expected_version`. A transaction
  either applies one increment, returns an already-applied identical normalized
  state, or returns `version_conflict`; it never silently overwrites a different
  committed version.
- Watchlist PUT is a complete snapshot. The server derives all group/item
  positions, limits snapshots to 20 groups and 100 total items, and commits the
  version, groups, and items atomically. Group and asset keys are untrusted
  owner-local references, never authorization or market facts.
- Alert creation requires one lowercase UUID `Idempotency-Key`. A versioned
  canonical request digest is bound to the owner and created record using the
  shared idempotency table. Same key, owner, and digest returns the same alert;
  any other reuse returns `idempotency_conflict`.
- Alert definitions accept only an asset key, allowlisted comparison condition,
  canonical decimal-string threshold, and optional expiry. They remain
  `inactive`; requests cannot select a price source/provider, submit facts,
  activate evaluation, select a delivery target, or claim delivery.
- Notification preferences cover the fixed historical event types and default
  to disabled. Persisting enabled intent does not alter the reported
  `delivery=unavailable` capability.
- Alert history is read-only at the public boundary and returns only persisted,
  sanitized, source-attributed event rows. Empty history is an exact empty list;
  fixtures and demo trigger events never enter persistence.
- Alias and group names are untrusted display text and reject control and
  bidirectional-control characters. Avatar values remain bounded opaque
  `avatar:` references; arbitrary or signed URLs are not accepted.
- All responses retain the shared no-store/request-ID behavior and all database
  failures remain sanitized. Provider secrets, access/refresh tokens, wallet
  data, market prices, delivery tokens, raw provider payloads, and arbitrary
  nested values are excluded from these tables and logs.

## Explicitly closed capabilities

This decision does not authorize:

- public-profile lookup, discovery, following, followers, blocklists, or a
  social/relationship graph;
- follower membership enforcement or copy-trading permission/execution;
- market-price ingestion, price-source selection, polling, streaming, an alert
  evaluator, scheduler, trigger writer, retry worker, or provider outbox;
- Firebase/FCM/APNs configuration, device-token registration, Push delivery,
  delivery receipts, or a durable notification inbox;
- account export/deletion, retention automation, or provider-data deletion;
- Flutter/device integration, Mainnet, withdrawals, or automated trading.

A later numbered decision must select and prove the price-fact/evaluation path
before alert activation or event writes, and separately define the Firebase
project, exact push-provider names, device-token lifecycle, delivery/retry
semantics, privacy/export/deletion controls, and credentialed device evidence.

## Persistence and rollback

Migration `000005_personalization_alerts` is append-only. It introduces owner-
bound Profile/privacy tables, a versioned Watchlist snapshot, inactive alert
definitions bound to create-idempotency records, versioned notification
preferences, and append-only alert events. Readiness requires the exact
migration head and every relation.

Runtime rollback is forward-compatible: code may be reverted while the additive
tables remain. The migration's destructive down path is limited to empty
isolated local/test state and refuses to discard personalization, alert, or
idempotency records.

## Consequences

Flutter can integrate stable owner-only CRUD and reconciliation contracts before
provider work begins. Offline saves receive deterministic conflict behavior,
alert creation is replay-safe, and the API can truthfully represent that
evaluation and delivery are unavailable.

LOOP now owns a narrow amount of custom application data and must later provide
authenticated export/deletion and retention policy before production. This
ownership does not expand into the previously default-denied social graph,
notification core, scheduler, or provider truth sources.
