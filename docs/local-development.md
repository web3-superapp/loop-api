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

Validate the two health boundaries:

```sh
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
curl -i -X POST http://127.0.0.1:3000/v1/bootstrap
```

The unauthenticated bootstrap smoke check must return a sanitized 401 with a
Bearer challenge and must not create a user row.

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

Then build Flutter with:

```sh
cd <loop-mobile-repository>
bin/flutter run \
  --dart-define=LOOP_BACKEND_BASE_URL=https://api-dev.quant-dinger.cc
```

Before using a real phone token, repeat the unauthenticated smoke check against
`https://api-dev.quant-dinger.cc/v1/bootstrap`. A successful credentialed 200 is
not verified until the Flutter backend adapter is implemented and exercised on
the physical device.

Provider-specific device testing begins only after the matching server secret is
stored outside Git and the corresponding sandbox/Testnet gate is implemented.
