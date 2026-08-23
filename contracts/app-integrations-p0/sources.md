# First-party provenance

Queried 2026-08-24. Exact archive, tag, commit, integrity and license hashes are
recorded in `dependency-lock.json`.

- [Supabase JavaScript official repository](https://github.com/supabase/supabase-js)
- [Supabase JavaScript v2.112.3 release](https://github.com/supabase/supabase-js/releases/tag/v2.112.3)
- [Supabase auth architecture](https://supabase.com/docs/guides/auth/architecture) — referenced to make the prohibition on Supabase Auth explicit.
- [Courier Node official repository](https://github.com/trycourier/courier-node)
- [Courier Node v9.1.0 release](https://github.com/trycourier/courier-node/releases/tag/v9.1.0)
- [Courier Flutter official repository](https://github.com/trycourier/courier-flutter)
- [Courier Flutter v5.0.3 release](https://github.com/trycourier/courier-flutter/releases/tag/v5.0.3)
- [Courier authentication documentation](https://www.courier.com/docs/platform/inbox/authentication)
- [Trigger.dev official repository](https://github.com/triggerdotdev/trigger.dev)
- [Trigger.dev v4.5.12 release](https://github.com/triggerdotdev/trigger.dev/releases/tag/v4.5.12)
- [Trigger.dev idempotency documentation](https://trigger.dev/docs/idempotency)

License scope matters: the `@trigger.dev/sdk` npm archive declares MIT while the
tagged platform repository root is Apache-2.0. The lock records both scopes and
does not collapse the repository license onto the package artifact.
