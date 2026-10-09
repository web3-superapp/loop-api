# Decision 0003: Native API control plane

- Status: Accepted
- Date: 2026-08-24

## Context

LOOP's client is a native Flutter application. The historical Stream contract
described a browser cookie and CSRF boundary, while the implemented identity
slice already authenticates native requests with a current Privy access token.
The remaining approved backend surface needs one authentication rule, an exact
route inventory, and shared rules for deadlines, idempotency, provider outages,
and unknown financial writes before more provider-specific code is added.

An HTTP contract can be implemented and tested against an unavailable adapter
without proving that its provider is integrated. Provider credentials,
dependency and license approval, credentialed Testnet evidence, and current
product or eligibility evidence remain separate gates.

## Decision

### Native authentication and ownership

- Every protected route accepts exactly one bounded
  `Authorization: Bearer <Privy access token>` header and verifies it on every
  request. Native routes do not use the historical cookie/CSRF transport and
  never accept or forward a Privy refresh token.
- `POST /v1/bootstrap` is the only route allowed to create the mapping from a
  verified Privy identity to a random opaque LOOP user ID. Other protected
  routes only resolve an existing mapping and return `bootstrap_required` when
  it is absent.
- Internal user IDs, Stream user IDs, wallet owners, account or agent
  addresses, provider subjects, nonces, signatures, and provider idempotency
  values are never accepted as client-selected authority.
- Route schemas reject unknown fields. Input rejection and authentication
  happen before repository, policy, signing, or provider work. Errors are
  stable and sanitized; protected responses are `Cache-Control: no-store` and
  carry the server request ID.

### Canonical route surface

`docs/api-inventory.md` is the authoritative LOOP-facing route inventory. This
decision approves only the following groups:

| Domain              | Method and path                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health              | `GET /health/live`; `GET /health/ready`                                                                                                                                                              |
| Identity            | `POST /v1/bootstrap`                                                                                                                                                                                 |
| Stream tokens       | `POST /v1/chat/token`; `POST /v1/video/token`                                                                                                                                                        |
| Perp private reads  | `GET /v1/perp/config`; `GET /v1/perp/account`; `GET /v1/perp/positions`; `GET /v1/perp/orders`; `GET /v1/perp/fills`; `GET /v1/perp/funding`                                                         |
| Perp intents        | `POST /v1/perp/intents`; `GET /v1/perp/intents/{intent_id}`; `POST /v1/perp/intents/{intent_id}/submit`                                                                                              |
| Agent authorization | `POST /v1/perp/agent-authorizations`; `GET /v1/perp/agent-authorizations/{authorization_id}`; `POST /v1/perp/agent-authorizations/{authorization_id}/signatures`                                     |
| Same-chain transfer | `GET /v1/transfer/assets`; `POST /v1/transfer/recipient-preflight`; `POST /v1/transfer/reviews`; `POST /v1/transfer/authorize`; `GET /v1/transfer/current-result`; `GET /v1/transfer/reconciliation` |

The two Stream routes stay separate even if an approved official server library
can mint compatible tokens. Private Perp reads derive the current account from
a server-verified wallet binding and never proxy the public market data already
read directly by Flutter. Perp intent mutations are limited to Testnet Core
`order`, `cancel`, `modify`, `batch_modify`, `update_leverage`, and
`update_isolated_margin`. Agent authorization is limited to a server-derived,
user-reviewed Testnet `approveAgent` intent.

The six transfer routes retain the reviewed request variants and state machine
in `contracts/privy-transfer/`, but their authentication transport is replaced
by this Native Privy Bearer boundary and the opaque internal principal.

### Capability states

The inventory reports interface state separately from runtime capability:

- `implemented`: the route exists in the current runtime and OpenAPI.
- `approved-contract`: the exact route is approved but is not implemented yet.
- `blocked-provider`: the interface may exist, but provider execution is
  unavailable until its dependency, license, credentials, and credentialed
  evidence gates close.
- `blocked-product-legal`: a mutation is denied before provider or signing work
  because current product, regional, legal, sanctions, or eligibility evidence
  is absent, stale, unknown, or denied.
- `explicitly-disabled`: the surface is outside the approved phase and no route
  may be added.

An unavailable adapter may support schemas and negative tests, but it cannot
change `blocked-provider` or be described as a live integration. Unit fixtures
cannot enable a product/legal gate.

### Versioned OpenAPI artifact

Fastify route schemas remain the single implemented-contract source. A
deterministic, credential-free generator builds the committed
`openapi/loop-api.v1.json` with the Development API origin and compares it
byte-for-byte in `pnpm check`. Generation uses unavailable provider adapters
and never contacts PostgreSQL or a provider. The artifact can be generated when
the production HTTP `/openapi.json` route is disabled; publishing that route and
building the contract are independent controls.

### Deadlines, retries, and idempotency

- Fastify limits receiving the complete request to 15 seconds and separately
  limits the full application route lifecycle to 15 seconds with
  `handlerTimeout`. A handler timeout returns sanitized `request_timeout` with
  HTTP 503 and aborts `request.signal`; provider adapters must observe that
  signal. Because cancellation is cooperative, any already-sent financial write
  still enters unknown-result reconciliation rather than being assumed absent.
- Provider reads have a 5-second attempt deadline. At most one retry is allowed
  for a pre-response transport or 5xx failure, and only while the total request
  deadline still permits it.
- Provider writes have a 10-second attempt deadline and no generic automatic
  retry. A timeout, connection close, or post-send 429/5xx becomes durable
  `unknown` or `reconciling` state and is resolved by authoritative provider
  reads.
- The only write replay exception is the reviewed Privy transfer replay: at
  most one byte-identical replay with the same signed envelope, provider
  idempotency key, and original expiry, before that expiry. A second uncertain
  outcome remains permanently unknown.
- Every new client request and provider transport attempt has a new correlation
  UUID. A durable operation ID and idempotency binding remain stable across
  reconciliation; the transfer exception also retains its contract-mandated
  provider replay identity.
- `POST /v1/perp/intents` requires a UUID `Idempotency-Key`. The same owner, key,
  and request digest resolve to one operation; a changed digest or owner is a
  conflict before provider work. Agent authorization receives a new
  server-generated authorization UUID. Transfer idempotency is server-derived;
  transfer page requests cannot choose it.
- Mutation state and a sanitized audit transition are committed before provider
  transport. Tokens, signatures, formatter bytes, signed URLs, private keys,
  nonces, secrets, and complete provider authorization payloads are neither
  logged nor retained as ordinary application data.

### Durable control-plane invariants

- A UUID idempotency key is unique within its operation scope, independent of
  owner. The record permanently binds the key to its first owner, key source,
  digest version, and request digest. Reuse by another owner or with another
  digest is the same sanitized conflict and creates no second operation.
- The generic provider-operation journal permits at most one transport attempt.
  `prepared -> submitting` atomically records a fresh transport-attempt UUID,
  deadline, version, and append-only audit event before any bytes may be sent.
  A stale `submitting` record is conservatively quarantined as `unknown`; it is
  never evidence that a write was not sent and never authorizes a replay.
- Business result state is separate from reconciliation scheduling. A worker
  may move only `unknown/pending -> unknown/leased`, then resolve it from an
  authoritative read, reschedule it, or park it as
  `unknown/operator_required`. Lease acquisition increments an independent
  reconciliation-attempt count, fence token, and record version; it never
  increments the provider-write attempt count.
- Worker writes compare owner, worker, fence, expected version, and an unexpired
  lease using the PostgreSQL wall clock after acquiring and materializing the
  row lock. The generic worker has only a read port and cannot sign, submit,
  execute, authorize, or replay provider writes. The transfer-specific
  byte-identical replay exception is isolated from this journal and worker.
- Every control-plane transition and its sanitized, versioned audit record
  commit in one transaction. Audit rows reject update and delete. Token-issuance
  quotas reserve every required subject bucket atomically using database time,
  a versioned policy snapshot, and server-HMAC subject keys; raw IP addresses
  and ordinary enumerable IP hashes are not stored.

## Consequences

The historical Stream cookie/CSRF contract remains provenance, but this decision
supersedes its authentication transport for the native token routes. Its
server-derived Stream identity, one-hour token TTL, no-store response, and
server-only secret requirements remain in force. Token issuance does not
authorize LOOP to implement Stream message, call, presence, or media state.

Development and Hyperliquid Testnet are the only enabled environments. Pay and
payment APIs, Mainnet, deposits or withdrawals, automated trading or trading
automation, HIP-3, trigger orders, TP/SL, TWAP, builder fees, public Hyperliquid
market proxying, and guessed Push/Profile/Wallet-selection APIs are not
approved. No route in this decision proves Stream, Hyperliquid, Privy transfer,
or any physical-device flow is integrated.
