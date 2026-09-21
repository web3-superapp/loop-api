# Decision 0063: the API domain is the Passkey relying party and publishes two static association files

- Status: Accepted (S64; main-agent task sheet 2026-09-21)
- Date: 2026-09-21
- Scope: two unauthenticated `GET /.well-known/*` routes, four `PASSKEY_*` configuration keys, one `ops/api-dev.env` value. No migration, no new entity, no state machine, no `/v2` operation, no change to any existing route, capability, or OpenAPI artifact.

## Context

- Privy creates LOOP passkeys under an origin, and that origin is the relying party. LOOP's mobile client talks to `https://api-dev.quant-dinger.cc` on the Development stack, so the API domain — not a marketing site — must be the domain that claims the app.
- Before a platform credential manager will offer a passkey created under a domain to an installed app, it fetches a static association file from that domain:
  - Google Play Services reads `https://<domain>/.well-known/assetlinks.json` and requires the statement to name the app's package and the SHA-256 fingerprint of the certificate that signed the installed build;
  - Apple reads `https://<domain>/.well-known/apple-app-site-association` (no extension) and requires `webcredentials.apps` to contain `<TEAMID>.<BUNDLEID>`.
- Both fetchers are anonymous. They send no Privy Bearer token, no `X-Loop-Contract-Version`, no `Idempotency-Key`, and they follow no redirect to an HTML page. Anything the `/v2` middleware stack would add to the response makes the file unusable.
- LOOP has no Apple Developer Team ID yet, and the Android builds that must reach these credentials are signed by the local debug keystore.

## Decision

### Entities, IDs, state machine

None. Both files are static projections of process configuration. They carry no user, no session, no wallet, no opaque LOOP ID, and no request-specific value; there is nothing to version, page, or transition. They are therefore outside the `/v2` contract surface and outside the `/v1` frozen surface, registered next to `/health/*` on every contract surface.

### Routes

| Route                                         | Auth | Answer when configured                                                                                                                                                                                                          | Answer when not configured |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `GET /.well-known/assetlinks.json`            | none | `200` with one statement: `relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"]`, `target.namespace: "android_app"`, `target.package_name`, `target.sha256_cert_fingerprints` | `404`                      |
| `GET /.well-known/apple-app-site-association` | none | `200` with `{"webcredentials": {"apps": ["<TEAMID>.<BUNDLEID>"]}}`                                                                                                                                                              | `404`                      |

Response headers on `200`: `Content-Type: application/json` exactly (the body is a pre-serialized buffer, because Fastify appends `; charset=utf-8` to any JSON content type it serializes itself, and Apple documents the bare type for the extension-less file) and `Cache-Control: public, max-age=300`. Five minutes is short enough that adding a signing fingerprint reaches the fetchers within one Development session and long enough that a retrying fetcher does not re-read the file every attempt. These are the only two LOOP responses that are not `no-store`; they contain no private fact.

The Helmet defaults still apply. `Content-Security-Policy` governs what a document may load; it does not restrict a JSON response fetched by Google Play Services or Apple's credential manager, and `default-src 'self'` adds no `connect-src` restriction to either. Nothing in the header set was relaxed for these routes.

### Errors and the unavailable behaviour

The `/v2` seven-field error envelope does not apply: the platform fetchers do not parse it and these are not `/v2` paths. The unconfigured answer is the repository's non-V2 error body, `{code: "not_found", message, request_id}`, with `Cache-Control: no-store`.

Fail closed means **absent**, not empty. An `assetlinks.json` with an empty fingerprint array, or an `apple-app-site-association` naming a placeholder Team ID, would make a broken association look configured — a fetcher would cache a statement that proves nothing, and an operator reading the file would believe the association exists. A 404 is exactly the signal "this domain claims no such app". Consequently:

- no `PASSKEY_ANDROID_CERT_SHA256` → `GET /.well-known/assetlinks.json` is `404`, even though the package name has a default;
- no `PASSKEY_IOS_TEAM_ID` → `GET /.well-known/apple-app-site-association` is `404`, which is today's state, because LOOP has no Apple Team ID yet;
- the two halves are independent: configuring Android does not publish an Apple file, and the reverse.

### Configuration

| Key                           | Default         | Validation                                                                                          |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `PASSKEY_ANDROID_PACKAGE`     | `com.cywd.loop` | dotted Android package name                                                                         |
| `PASSKEY_ANDROID_CERT_SHA256` | unset           | comma-separated list, each entry 32 colon-separated hex byte pairs, upper-cased, unique, at most 10 |
| `PASSKEY_IOS_TEAM_ID`         | unset           | ten characters, `[A-Z0-9]`, upper-cased                                                             |
| `PASSKEY_IOS_BUNDLE_ID`       | `com.cywd.loop` | dotted bundle identifier                                                                            |

A malformed value is a `ConfigurationError` at startup, not a silently dropped entry: publishing a subset of the fingerprints an operator intended is how a release build silently loses its passkeys. Lowercase hex is accepted and published upper-cased, because that is the form `keytool` prints and the form both platforms compare case-insensitively.

None of these values is a secret. A certificate fingerprint and a Team ID are public by construction — the whole point of the files is to publish them — so `ops/api-dev.env`, which is committed and carries no secret, is the right place for the Development value.

### Domains

`api-dev.quant-dinger.cc` is the Development relying party. A passkey is bound to the origin that created it, so a credential created against the Development API is not usable against a production API on a different domain; that is the intended isolation, not a defect.

Production gets its own relying-party domain, `app.<production domain>`, decided when the production stack is provisioned. The mobile client must read the relying-party domain from configuration rather than hard-coding `api-dev`, and the production build's release-keystore fingerprint must be added to `PASSKEY_ANDROID_CERT_SHA256` before its first passkey sign-up.

## Consequences

- The Development stack publishes `assetlinks.json` for `com.cywd.loop` with the debug keystore fingerprint, which is the keystore that signs both debug and profile builds. `apple-app-site-association` stays `404` until an Apple Team ID exists.
- The OpenAPI artifacts are unchanged: both routes carry `hide: true`, because they are platform discovery documents, not client-facing operations. Their route schemas still describe the published shapes and remain the source for this decision's table.
- Real-device verification (Google Play Services actually accepting the statement, an actual passkey created and re-offered) is **unverified** and belongs on the external Go/No-Go list; a served file is not evidence that the platform accepted it.
