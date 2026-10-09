# Decision 0015: Mainnet Spot release boundary

- Status: Accepted boundary; Mainnet activation not approved
- Date: 2026-08-26

## Context

The current implementation target is Development plus Hyperliquid Testnet.
Changing a provider URL or remote flag would not isolate credentials, identity,
idempotency, policy, data, signing, reconciliation, mobile origin, or incident
response. It would also make an accidental Testnet-to-Mainnet promotion
possible without a reviewed release.

## Decision

Mainnet is a separate future release project, not an environment value in the
current service and not a client-selectable or remotely promoted mode. This
repository must not add a Mainnet provider URL, route, success schema,
credential name, signer namespace, fallback, or runtime switch while executing
Decision 0014.

A future Mainnet proposal requires a new numbered activation ADR and separate:

- Flutter and backend build artifacts with reviewed fixed origins;
- deployment, Privy application/audience, Agent identities and approvals,
  secret namespace, data plane, idempotency namespace, quotas, and audit sink;
- current product, jurisdiction, sanctions, age/entity, provider-terms, legal,
  privacy, and operational evidence;
- exact dependency and signing conformance rerun against then-current official
  sources;
- risk limits, market allowlist, kill switch, signer health, reconciliation
  readiness, alerting, on-call, unknown-result, key/Agent revocation,
  rollback, and read-only-degradation runbooks; and
- small, capped, manually supervised canary evidence.

Mainnet mutation eligibility must be a conjunction, never an OR or fallback:

```text
compiled Mainnet capability
AND runtime Mainnet approval
AND Mainnet deployment identity
AND current policy evidence
AND healthy signer
AND healthy reconciliation
```

Remote configuration may only narrow or close an already compiled capability;
it cannot grant Mainnet authority. Any absent, false, stale, unknown, or
mismatched term fails before signing or provider I/O. Testnet and Mainnet must
never automatically fall back to one another.

The first possible Mainnet release remains interactive Spot-only. Transfers,
withdrawals, bridges, resting-order management, leverage, Perp, builder fees,
copy trading, scheduled trading, and all other automation remain absent and
require their own later decisions.

## Consequences

Decision 0014 can be implemented without leaving a dormant Mainnet code path
that a configuration mistake could activate. Going live later requires an
explicit, independently reviewable release rather than editing one URL.

This decision records the boundary only. It does not approve, configure,
deploy, test, or schedule Mainnet.
