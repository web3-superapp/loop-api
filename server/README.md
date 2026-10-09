# Prototype server material

`app-integrations-p0/adapter.mjs` is the original prototype adapter migrated for
traceability. It is not a production server entry point and must not be imported
by `src/` or deployed as the LOOP API.

The selected production runtime source root is now the repository-level `src/`
directory. Current route and provider-capability status is maintained in the
root `README.md` and `docs/api-inventory.md`; this historical directory does not
define it. Provider capabilities remain independently gated and must fail closed
when their configuration or verification evidence is absent.

The server identity key is an opaque internal user ID. Wallets are bindable
credentials, never the primary user key or Stream user ID. Pay remains outside
the current phase, and risk presentation may expose only sourced facts rather
than an invented verdict or numeric score.
