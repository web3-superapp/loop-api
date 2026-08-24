# LOOP API

Private Backend-for-Frontend repository for the LOOP Flutter app.

## Current status

The repository boundary is ready, and the original repository's provider contracts and prototype adapter have been migrated here with source history. The production backend is **not implemented**. There is no live provider SDK composition, server runtime, deployed endpoint, credentialed environment, or production data path in this repository.

The current communication selection is **Stream Chat + Stream Video/Audio Rooms (voice)**. This is a product and contract decision, not a claim that Stream is integrated. Do not report Privy, Hyperliquid, Stream Chat, or Stream Video as live until credentialed integration and sandbox/testnet/device evidence exists.

Current product decisions are summarized in [`docs/product-decisions.md`](docs/product-decisions.md).

## Responsibilities

- Issue short-lived Stream Chat and Stream Video user tokens for opaque internal user IDs
- Hold server-only provider credentials and map provider failures to stable LOOP errors
- Orchestrate approved Privy server operations without taking custody of user keys
- Proxy and normalize Hyperliquid REST/WebSocket data, enforce Core market allowlists, freshness, precision, idempotency, and unknown-result reconciliation
- Provide request correlation, rate limiting, audit events, observability, environment separation, and region/eligibility gates
- Preserve provider-sourced, time-stamped facts for risk presentation without inventing an AI Guard verdict or numeric risk score

The internal user ID is the account and communication identity. Wallets are bindable, replaceable credentials attached to that identity; a wallet address must never become the database primary key or Stream user ID.

The proposed persistent 200,000-member group is a provider-confirmation **Go/No-Go**. A single Stream channel may be used only after Stream confirms the exact member, persistence, concurrency, moderation, pagination, rate-limit, commercial, and SLA requirements in writing. Until then, the implementation baseline is partitioned groups/topic channels with an application-level directory and aggregate discovery experience, not an assumed 200,000-member single channel.

## Explicit non-goals

- No wallet keys, recovery phrases, or long-lived provider secrets in Flutter
- No custom matching engine, ledger, bridge, IM, RTC, or proprietary risk score
- No custom Chat or media transport; communication uses the selected Stream products through thin adapters
- No AI Guard endorsement and no synthetic or numeric risk score; only verifiable facts with source and observation time
- No Pay or payment backend implementation in the current phase
- No HIP-3 markets or Hyperliquid builder fees

## Related repositories

- Flutter app: <https://github.com/web3-superapp/loop-mobile>
- Frozen HTML prototype, product documents, research, and historical verifiers: <https://github.com/web3-superapp/loop-mobile/tree/main/reference/legacy-prototype>
- Original repository retained for migration traceability: <https://github.com/Doog-bot534/web3-superapp-prototype>

## Migrated material

- `contracts/hyperliquid-core-perp/` and `contracts/privy-transfer/` are reusable contract baselines, not proof of a live integration.
- `contracts/stream-chat/` and `contracts/stream-ui/` are the current communication contract baselines. They remain fail-closed design inputs and are not evidence of an installed SDK, running token service, or connected Stream environment.
- `contracts/app-integrations-p0/` and `contracts/integration-catalog/` are historical prototype research and inventory. Entries for payment, AI Guard, or other candidates do not authorize current implementation; the current-scope decisions in this README and `docs/product-decisions.md` take precedence.
- `server/app-integrations-p0/adapter.mjs` is a historical prototype adapter, not the production LOOP API entry point.
- The migration merge commit keeps the original Git history as a parent so earlier decisions remain traceable.

Framework selection, deployment topology, data persistence, and production credentials remain explicit follow-up decisions. Start with provider testnet/sandbox contracts and fail closed when configuration is missing.
