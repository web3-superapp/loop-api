# Prototype server material

`app-integrations-p0/adapter.mjs` is the original prototype adapter migrated for traceability. It is not a production server entry point and must not be deployed as the LOOP API.

Production work should first select the runtime and deployment topology, then implement explicit Privy, Hyperliquid, and Agora boundaries with short-lived credentials, fail-closed configuration, idempotency, audit events, observability, and testnet/sandbox evidence.
