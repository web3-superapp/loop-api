# Decision 0106: iOS application identifier from configuration (S124-api)

- Status: Accepted (S124-api)
- Date: 2026-10-09
- Scope: the iOS app moved to a new Apple developer account (`LOOP/docs/13-Apple新账号迁移清单.md`). The old Team ID and the old iOS bundle ID are retired; the new bundle ID is `com.cywd.loopapp`; the new Team ID is supplied later through the environment. No migration, no new route, no new stable ID, no `/v2` wire change, no new error code.
- Baseline: `integration/v2` = `baf451a`
- Amends: Decision 0063 (`PASSKEY_IOS_BUNDLE_ID` default), Decision 0090 (§2 compiled-in iOS app ID).

## Ruling

1. **One source for the iOS app ID.** `PASSKEY_IOS_TEAM_ID` + `PASSKEY_IOS_BUNDLE_ID` form the only iOS application identifier the API publishes, `<TEAMID>.<BUNDLEID>`. `config.passkeyRelyingParty.ios.appId` and `config.appLinks.iosAppIds` are both derived from it in `loadConfig`; the compiled constant `appLinksIosAppId` is removed.
2. **Defaults.** `PASSKEY_IOS_BUNDLE_ID` defaults to `com.cywd.loopapp` (was the retired bundle). `PASSKEY_IOS_TEAM_ID` has no default. Validation is unchanged: Team ID ten `[A-Z0-9]` characters (upper-cased), bundle ID dotted; a malformed value is a `ConfigurationError` at startup.
3. **Fail closed without a Team ID.** `GET /.well-known/apple-app-site-association` still answers `200 application/json`, `public, max-age=3600`, but claims no iOS app: the body is exactly `{"applinks":{"details":[]}}` (no `webcredentials`). An empty `details` array is a valid association file and means "no app handles these paths"; serving the retired app ID instead would advertise an association no current build can satisfy. At startup the API logs exactly one `warn` with `reasonCode: "APPLE_TEAM_ID_MISSING"`. Only bundle ID configured = same as nothing configured.
4. **Android unchanged.** `assetlinks.json`, the Android package `com.cywd.loop`, `PASSKEY_ANDROID_PACKAGE` default, the debug keystore fingerprint and `ANDROID_RELEASE_CERT_SHA256` are not touched by the Apple account move.
5. **No other exposure.** No `/v2` route, capability, or `/v2/meta/about` field exposes the iOS app ID (checked); `openapi/*.json` is unchanged (both association routes are `hide: true`). The route schema now allows `applinks.details` to be empty.

## States

| `PASSKEY_IOS_TEAM_ID` | `PASSKEY_IOS_BUNDLE_ID` | AASA body                                                                                                    | Startup log             |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------- |
| set                   | set                     | `applinks.details[0].appIDs = ["<TEAM>.<BUNDLE>"]`, components `/u/*`, `/c/*`; `webcredentials.apps` same ID | none                    |
| set                   | unset                   | as above with `com.cywd.loopapp`                                                                             | none                    |
| unset                 | set or unset            | `{"applinks":{"details":[]}}`                                                                                | `APPLE_TEAM_ID_MISSING` |

## Operations

`ops/api-dev.env` and `ops/staging/api-staging.env` (outside this repository) carry the retired values and must be changed by the main agent: set `PASSKEY_IOS_TEAM_ID=<new Team ID>` (or remove it until the Team ID exists, which makes the file fail closed) and `PASSKEY_IOS_BUNDLE_ID=com.cywd.loopapp` (or remove it to take the default). Apple's CDN caches the association file; after the change, a new install of the new-account build is what proves the association.

## Tests

- `test/well-known-app-links-routes.test.ts`: team + bundle (byte-exact body), team only (default bundle), bundle only (empty `details`, one `APPLE_TEAM_ID_MISSING` warning), neither (empty `details`, warning, Android file byte-identical), no warning with a Team ID, config derivation.
- `test/well-known-passkey-routes.test.ts`: default bundle, malformed bundle, existing passkey cases on the new bundle.
- `test/config.test.ts`: no app ID without a Team ID, derived ID shared by passkeys and app links, Android package independent, malformed Team ID / bundle ID rejected.
