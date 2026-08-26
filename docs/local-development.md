# Local development and physical-device access

## Local API

Copy the committed safe template and start PostgreSQL:

```sh
cp .env.example .env.local
pnpm db:up
pnpm db:migrate
pnpm dev
```

Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET` only in the ignored `.env.local` to
enable `POST /v1/bootstrap`. Leave both blank to keep authentication disabled;
providing only one is a startup error. The mobile client sends only its current
Privy access token as a Bearer value and never sends a refresh token.

The implemented `POST /v1/chat/token` and `POST /v1/video/token` interfaces use
that same current Bearer token and require the Privy identity to have completed
`POST /v1/bootstrap`. Both reject body/query/client-selected user IDs and fix the
token lifetime at 3600 seconds. Set a unique server-only
`STREAM_TOKEN_QUOTA_HMAC_SECRET` of at least 32 characters in `.env.local` to
enable their atomic per-route user/IP quota boundary; raw LOOP user IDs and IPs
are not stored as quota subjects. If this secret is absent, the routes fail
closed with 503.

Do not enable `STREAM_API_KEY` or `STREAM_API_SECRET` yet. They are an
all-or-nothing pair, but the default issuer still returns 503 even when both are
present: `@stream-io/node-sdk` is deliberately not installed until its reviewed
Stream Source Code License Agreement is explicitly accepted and a real
Development Stream App is approved. No custom JWT implementation is used.

The wallet-binding lifecycle and six `GET /v1/perp/*` private-read interfaces
also require the current Bearer identity and bootstrap mapping. Binding is
available whenever Privy credentials are configured. A PUT re-reads the current
Privy user and may bind only the sole eligible embedded Ethereum wallet or the
exact wallet already stored; it never accepts an address.

Hyperliquid private reads are default-off. To enable the real narrow Testnet
reader, configure all of the following in ignored `.env.local`:

```text
PRIVY_APP_ID=<development-app-id>
PRIVY_APP_SECRET=<development-app-secret>
PERP_READ_CURSOR_HMAC_SECRET=<independent-secret-at-least-32-characters>
HYPERLIQUID_PRIVATE_READS_ENABLED=true
HYPERLIQUID_INFO_QUOTA_HMAC_SECRET=<another-secret-at-least-32-characters>
HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE=960
```

Missing any required value while the switch is true is a startup error. The
adapter URL is compiled as `https://api.hyperliquid-testnet.xyz/info` and cannot
be changed by environment or request input. Each real request first reserves
its documented weight in a server-global PostgreSQL 60-second window. No signer,
private key, Exchange action, WebSocket, Mainnet, or mutation is enabled.

Validate the health and protected-route boundaries:

```sh
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
curl -i -X POST http://127.0.0.1:3000/v1/bootstrap
curl -i -X POST http://127.0.0.1:3000/v1/chat/token
curl -i -X POST http://127.0.0.1:3000/v1/video/token
curl -i http://127.0.0.1:3000/v1/perp/wallet-binding
curl -i http://127.0.0.1:3000/v1/perp/config
curl -i http://127.0.0.1:3000/v1/perp/account
curl -i http://127.0.0.1:3000/v1/perp/positions
curl -i http://127.0.0.1:3000/v1/perp/orders
curl -i http://127.0.0.1:3000/v1/perp/fills
curl -i http://127.0.0.1:3000/v1/perp/funding
```

After bootstrap, exercise the binding lifecycle with a current Privy access
token. The examples deliberately contain no address or wallet ID:

```sh
curl -i \
  -H 'Authorization: Bearer <current-privy-access-token>' \
  http://127.0.0.1:3000/v1/perp/wallet-binding

curl -i -X PUT \
  -H 'Authorization: Bearer <current-privy-access-token>' \
  -H 'Content-Type: application/json' \
  --data '{"expected_binding_version":"0"}' \
  http://127.0.0.1:3000/v1/perp/wallet-binding

curl -i -X DELETE \
  -H 'Authorization: Bearer <current-privy-access-token>' \
  'http://127.0.0.1:3000/v1/perp/wallet-binding?expected_binding_version=1'
```

These unauthenticated protected-route smoke checks must return a sanitized 401
with a Bearer challenge and must not create a user row or reserve quota. With a
valid bootstrapped identity and quota HMAC configured, both Stream routes still
return a sanitized 503 while the real licensed issuer is unavailable.
The Perp routes must not reveal or accept a wallet/account address. A valid
bootstrapped identity without a binding receives sanitized 409
`wallet_binding_required`; a bound identity with private reads left off receives
503 `perp_unavailable`. With the switch and dependencies enabled, reads use the
fixed Testnet adapter. Real phone-issued Privy, nonempty Testnet-account, and
Flutter end-to-end evidence remain unverified.

`.env.local` is ignored. Provider secrets, Privy refresh tokens, wallet keys,
agent keys, APNs private keys, Firebase service accounts, and Stream server
secrets must never be placed in tracked files or command examples.

## Standalone reconciliation worker

Run the worker in a second terminal after PostgreSQL migrations are current:

```sh
pnpm worker:dev
```

For the compiled local entry point, use `pnpm build` followed by
`pnpm worker:start:local`. A deployed environment uses `pnpm worker:start` or
the `worker` Docker target and injects its database settings externally.

By default this process makes no provider call. It immediately runs one bounded
database-only Spot Agent lifecycle pass, then repeats every 60 seconds. Each
pass first expires elapsed signing handoffs and then retires identities whose
persisted Agent validity has elapsed. It uses fresh request UUIDs, never loads a
signer or provider credential, and can be temporarily disabled with
`SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED=false`.

To enable the separate narrow Testnet order reader, add all three values to
ignored `.env.local`:

```text
HYPERLIQUID_RECONCILIATION_READS_ENABLED=true
HYPERLIQUID_INFO_QUOTA_HMAC_SECRET=<independent-secret-at-least-32-characters>
HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE=960
```

The switch is independent from the HTTP process's
`HYPERLIQUID_PRIVATE_READS_ENABLED`. An enabled worker with a missing or weak
quota secret fails at startup. When API and worker share an outbound IP, every
replica must share this quota secret, capacity, policy, and PostgreSQL database
so the 960-weight global budget remains one bucket. The adapter is fixed to
Hyperliquid Testnet and may only read `orderStatus`, open orders, bounded fills,
and clearinghouse state. It can atomically finalize a strictly matching Core
limit `order`; market orders, modify, batch-modify, cancel, leverage,
isolated-margin, unknown domains, and ambiguous evidence are parked as
`operator_required`. It never loads a Privy credential, wallet key, signer,
Exchange adapter, transfer executor, or relay, and it never submits or replays
provider bytes.

With no due work, the process only performs its bounded polling cycles until
`SIGINT` or `SIGTERM`, then waits for any in-flight database call and closes
PostgreSQL cleanly. A real nonempty Testnet account and deployed worker remain
unverified.

## Physical phone on a trusted LAN

The safer default binds only to the Mac. For a short-lived trusted-LAN session:

1. Set `HOST=0.0.0.0` in `.env.local`.
2. Set `PUBLIC_BASE_URL=http://<mac-lan-ip>:3000`.
3. Allow only the required local firewall prompt.
4. Build Flutter with
   `--dart-define=LOOP_BACKEND_BASE_URL=http://<mac-lan-ip>:3000`.
5. Return `HOST` to `127.0.0.1` after the session.

Plain HTTP on a phone can be blocked by iOS App Transport Security or Android
network-security policy and should not be weakened globally. Prefer the HTTPS
tunnel below for repeatable integration.

## Cloudflare Development tunnel

The reserved Development hostname is:

```text
https://api-dev.quant-dinger.cc
```

Cloudflare Tunnel is the preferred route from a physical phone to the local API.
It keeps the Fastify listener on `127.0.0.1` and avoids inbound router port
forwarding. The operator must install `cloudflared`, authenticate the intended
Cloudflare account, create a named Development tunnel, and explicitly route the
hostname to `http://127.0.0.1:3000`.

Do not commit a tunnel token, `cert.pem`, credential JSON, or account ID. Do not
reuse this Development hostname for Mainnet, production signing, or production
customer traffic. When the tunnel is active, set:

```text
PUBLIC_BASE_URL=https://api-dev.quant-dinger.cc
TRUST_PROXY=true
```

In the current local-tunnel implementation, `TRUST_PROXY=true` trusts forwarded
client-address metadata only from loopback (`127.0.0.0/8` and `::1/128`), where
the local `cloudflared` process connects to Fastify. It is not a general
trust-all proxy setting and must not be reused for a remote load balancer or a
different network topology without a separate deployment decision.

Then build Flutter with:

```sh
cd <loop-mobile-repository>
bin/flutter run \
  --dart-define=LOOP_BACKEND_BASE_URL=https://api-dev.quant-dinger.cc
```

Before using a real phone token, repeat the unauthenticated smoke check against
`https://api-dev.quant-dinger.cc/v1/bootstrap`. A successful credentialed 200 is
not verified until the Flutter backend adapter is implemented and exercised on
the physical device. Backend-to-Flutter, physical-device, Privy wallet-binding,
nonempty Hyperliquid Testnet-account, Firebase, and credentialed Stream
integration are intentionally not being run during the current backend-only
phase.

Provider-specific device testing begins only after the matching server secret is
stored outside Git and the corresponding sandbox/Testnet gate is implemented.
