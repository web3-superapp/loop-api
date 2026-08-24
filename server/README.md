# Prototype server material

`app-integrations-p0/adapter.mjs` is the original prototype adapter migrated for traceability. It is not a production server entry point and must not be deployed as the LOOP API.

There is currently no selected server framework, live SDK composition, HTTP runtime, deployed endpoint, credentialed environment, or production persistence in this directory.

Production work should first select the runtime and deployment topology, then implement explicit Privy, Hyperliquid, and **Stream Chat + Stream Video/Audio Rooms** boundaries with short-lived credentials, fail-closed configuration, idempotency, audit events, observability, and sandbox/testnet evidence.

The server identity key must be an opaque internal user ID. Wallets are bindable credentials, never the primary user key or Stream user ID. The server may project only verifiable, sourced risk facts; it must not generate or endorse AI Guard verdicts or numeric risk scores. Pay and payment endpoints are outside the current phase and must not be added.

A persistent 200,000-member single Stream channel is blocked until Stream confirms the exact requirement in writing. Without that approval, server design must use partitioned groups/topic channels and must not emulate one giant provider channel with a custom chat core.
