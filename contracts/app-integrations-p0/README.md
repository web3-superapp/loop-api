# P0 managed app integrations — R0 contract v2

> **Historical, runtime-disabled input.** This package remains useful for typed
> boundary and fail-closed review, but it is not the current LOOP API runtime.
> Current scope is defined by the repository `README.md` and
> `docs/product-decisions.md`; in particular, Pay is out of scope and risk UI may
> show only verifiable sourced facts, never an AI Guard verdict or numeric score.

This package is an isolated, runtime-disabled contract and thin server adapter for
three managed application capabilities:

- Supabase stores only LOOP-owned application records.
- Courier is the sole notification runtime spike.
- Trigger.dev schedules/retries price-alert evaluation and never supplies prices.

It does not add screens or implement a second business core. Privy remains the
identity, wallet and signature authority; Stream remains chat/video authority;
Hyperliquid remains the core-whitelist Perp authority. Provider market facts stay
read-only authoritative inputs.

## Enablement state

`contract.json` intentionally declares `production_enabled: false`. Missing
credentials fail closed and may never select the offline fixture. The fixture is
available only when `LOOP_OFFLINE_APP_INTEGRATIONS_FIXTURE=1`; it has no network,
mutation, authentication, or provider-truth semantics.

Before runtime enablement, the owner must provide credential references, lock the
complete transitive dependency graphs, update the contract status in review, and
pass credentialed tenant-isolation, token/revocation, retry/replay, and stale-fact
tests. Package pins here are provenance decisions, not installed dependencies.

## Thin adapter boundary

`server/app-integrations-p0/adapter.mjs` depends on injected official-SDK ports.
It supplies only allowlists, verified-context enforcement, idempotency material,
and exact-decimal alert policy. It cannot authenticate users, sign wallet
requests, create market facts, send Stream messages, or place Hyperliquid orders.

The v2 boundary validates every Supabase input and provider-returned row against a
descriptor-safe, exact, per-table typed schema. Unknown keys, accessors, proxies,
nested objects in scalar fields, cross-tenant rows and provider-truth-shaped values
fail closed; reads return frozen allowlisted projections rather than SDK objects.

Courier accepts an exact event envelope and event-specific payload only. LOOP
derives delivery idempotency as SHA-256 over event type, verified Privy DID and
source event ID. Caller routing, template, channel, extra fields and caller-chosen
delivery keys are rejected before the official Courier port.

Price-alert freshness reads a private branded server clock inside the adapter
closure. The public method has no clock parameter; extra caller arguments are
ignored. Non-finite time, rollback, facts older than 300 seconds and expired alert
definitions fail closed. A fake clock exists only inside the private self-test
factory and has a distinct WeakSet brand.

Production composition no longer accepts a status string. Both enablement and the
official port bundle require private WeakSet brands minted inside the credentialed
composition root. The enablement capability is consumed on its first attempt;
copies, replay and unbranded/mock port bundles fail closed. No public mint exists in
this runtime-disabled R0 package. Before branding, exact descriptor-safe port and
clock methods are captured into frozen, receiver-bound snapshots, so later property
replacement cannot change an already composed adapter.

Every side effect requires a Privy DID produced by the BFF verifier. Incoming
provider events must preserve raw body and headers until the provider-specific
official verification algorithm/SDK has checked signature, timestamp, and replay.

## Data exit

Supabase enablement requires tested Postgres dump and table-level JSON exports.
Courier and Trigger.dev IDs stored in LOOP tables are references, not authorities;
exportable LOOP event/alert definitions remain the migration source of record.

The original prototype's `_tmp/verify_app_integrations_p0.py` verifier was not
migrated and is not a current command in this repository. The only retained local
adapter check is:

```text
node server/app-integrations-p0/adapter.mjs --self-test
```

That self-test validates the historical adapter in isolation; it is not evidence
of a production BFF runtime or live provider integration.
