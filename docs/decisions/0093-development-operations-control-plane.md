# 0093 Development operations control plane

User approved 2026-10-03. Operations is a separate web surface using the existing current Privy Bearer verification and internal LOOP principal. No public admin registration, API keys, local password identity, or provider secrets in the browser. PostgreSQL ops_operators and scoped ops_grants authorize each request and each transaction; enabled=false revokes access. Initial grants are deployment-admin controlled.

The web client holds an access token only in memory for the Development integration entry. Production routes are denied regardless of grants. This entry does not claim a finished production SSO flow. No mainnet/write/payment flags are enabled.

Database commands bind operationId to actor, action, target and canonical content hash. Repository calls share the same outer transaction through a savepoint-scoped Pool facade; nested repository commit never commits the operation. Successful operations, business changes and audit commit together. Non-success audit is separate and sanitized. Community review writes its in-app notification in that same transaction; push is explicitly not requested, not reported as delivered.

Mining drafts are separate from live formula data. All contributors are excluded from approval, edits invalidate review, publication checks revision/hash/expected active version under the existing publication advisory lock. Published weights remain versioned and immutable. Existing formula history without sufficient evidence is marked unknown.

Official sources consulted 2026-10-03:

- https://fastify.dev/docs/latest/Reference/Hooks/ — scoped authentication hooks precede handlers.
- https://www.postgresql.org/docs/17/explicit-locking.html — transaction row/advisory locks and conflict serialization.
- https://docs.privy.io/authentication/user-authentication/access-tokens — current access-token verification remains the identity boundary.

Tests must cover denied access, scope, revoked grants, self approval, content mismatch, lost response recovery, concurrent publish and rollback across reused repositories. PostgreSQL 16 local evidence must not be represented as the required PostgreSQL 17 container gate.

Verification tooling excludes only macOS AppleDouble `._*` sidecars (binary filesystem metadata) from ESLint, Vitest discovery, integration runner, Prettier and Docker context, matching the existing Git ignore. Observed external-volume sidecars were parsed as tests and Git pack indexes; application source and test coverage are unchanged. Production PostgreSQL 17 remains a separate required gate.

Deployment CLI bootstrap uses actor_kind=deployment_admin/source=deployment_cli with no claimed LOOP actor. It records the target and sanitized enabled/grant states before and after the atomic change. Deployment access logs identify the actual terminal operator. Historical falsely attributed bootstrap entries are reclassified, without inventing missing historical grant states. Migration 000049 refuses to discard CLI provenance on downgrade.
