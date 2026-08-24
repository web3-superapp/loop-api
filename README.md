# LOOP API

Private Backend-for-Frontend repository for the LOOP Flutter app.

## Current status

The repository boundary is ready, but the production backend is not implemented yet. Do not report Privy, Hyperliquid, or Agora as live until credentialed integration and testnet/device evidence exists.

## Responsibilities

- Issue short-lived Agora Chat and RTC tokens for internal, wallet-independent user IDs
- Hold server-only provider credentials and map provider failures to stable LOOP errors
- Orchestrate approved Privy server operations without taking custody of user keys
- Proxy and normalize Hyperliquid REST/WebSocket data, enforce Core market allowlists, freshness, precision, idempotency, and unknown-result reconciliation
- Provide request correlation, rate limiting, audit events, observability, environment separation, and region/eligibility gates

## Explicit non-goals

- No wallet keys, recovery phrases, or long-lived provider secrets in Flutter
- No custom matching engine, ledger, bridge, IM, RTC, or proprietary risk score
- No Stream integration; communication is Agora Chat + RTC
- No payment implementation in the current phase
- No HIP-3 markets or Hyperliquid builder fees

## Related repositories

- Flutter app: <https://github.com/web3-superapp/loop-mobile>
- Historical prototype and product contracts: <https://github.com/Doog-bot534/web3-superapp-prototype>

Framework selection, deployment topology, data persistence, and production credentials remain explicit follow-up decisions. Start with provider testnet/sandbox contracts and fail closed when configuration is missing.
