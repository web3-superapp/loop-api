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

The six `GET /v1/perp/*` private-read interfaces also require the current Bearer
identity and bootstrap mapping. Set an independent server-only
`PERP_READ_CURSOR_HMAC_SECRET` of at least 32 characters only when testing with
an injected verified wallet resolver and fake provider reader. Leaving it blank
keeps cursor-backed private reads fail closed. The normal local runtime has no
wallet-binding database lifecycle and no Hyperliquid adapter, does not select a
linked wallet, and never substitutes the zero address; an authenticated request
therefore returns `wallet_binding_required` before provider work.

Validate the health and protected-route boundaries:

```sh
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
curl -i -X POST http://127.0.0.1:3000/v1/bootstrap
curl -i -X POST http://127.0.0.1:3000/v1/chat/token
curl -i -X POST http://127.0.0.1:3000/v1/video/token
curl -i http://127.0.0.1:3000/v1/perp/config
curl -i http://127.0.0.1:3000/v1/perp/account
curl -i http://127.0.0.1:3000/v1/perp/positions
curl -i http://127.0.0.1:3000/v1/perp/orders
curl -i http://127.0.0.1:3000/v1/perp/fills
curl -i http://127.0.0.1:3000/v1/perp/funding
```

These unauthenticated protected-route smoke checks must return a sanitized 401
with a Bearer challenge and must not create a user row or reserve quota. With a
valid bootstrapped identity and quota HMAC configured, both Stream routes still
return a sanitized 503 while the real licensed issuer is unavailable.
The Perp routes must not reveal or accept a wallet/account address; with a valid
bootstrapped identity and the default resolver they return a sanitized 409.

`.env.local` is ignored. Provider secrets, Privy refresh tokens, wallet keys,
agent keys, APNs private keys, Firebase service accounts, and Stream server
secrets must never be placed in tracked files or command examples.

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
the physical device. Backend-to-Flutter, physical-device, and credentialed
Stream integration are intentionally not being run during the current
backend-only phase.

Provider-specific device testing begins only after the matching server secret is
stored outside Git and the corresponding sandbox/Testnet gate is implemented.
