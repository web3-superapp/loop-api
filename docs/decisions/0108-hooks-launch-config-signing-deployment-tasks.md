# Decision 0108: Hooks launch configuration, operator review, signing preparation, and deployment tasks (S125)

- Status: Accepted (S125-api), Development / BSC Testnet only
- Date: 2026-10-09
- Source: requirer branch `origin/codex/integrated-dual-pool-20261008`
  (forked from `83f5ac7`), Draft PR `web3-superapp/loop-api#6`, requirer
  Decisions 0090, 0093, 0094, 0095, 0096, 0097 (same numbers as unrelated
  LOOP decisions; renumbered here). Product rules: `LOOP-整体方案` §1, §2, §7.
- Baseline: `integration/v2` = `2de5a19`
- Scope: append-only owner drafts of the fixed `hooks_launch_v1` template,
  operator review with separation of duties, EIP-712 signing preparation,
  and verified `awaiting_executor` deployment tasks. **No broadcast, no
  executor, no activation, no mainnet.** Six new `/v2` routes; no capability
  change; no existing `/v2` key changes meaning.

## Number mapping

| Requirer                                               | LOOP                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- |
| Decision 0090 (Hooks project config drafts)            | 0108 §1                                              |
| Decision 0093 (ops control plane)                      | 0108 §2 (data model + service only)                  |
| Decision 0094 (Hooks ops workbench)                    | 0108 §2                                              |
| Decision 0095 (testnet signing request)                | 0108 §3                                              |
| Decision 0096 (preparation concurrency)                | 0108 §3                                              |
| Decision 0097 (signed deployment tasks)                | 0108 §4                                              |
| Migration 000050 `hooks_launch_project_configs`        | `000051_hooks_launch_project_configs`                |
| Migrations 000047 + 000049 + 000051 (subset)           | `000052_ops_hooks_operators`                         |
| Migration 000052 `hooks_review_and_testnet_acceptance` | `000053_hooks_review_and_testnet_acceptance`         |
| Migration 000053 `hooks_signed_deployment_tasks`       | `000054_hooks_signed_deployment_tasks`               |
| Migrations 000046, 000048                              | not ported (ops mining workbench; see Decision 0107) |

## Entities and stable IDs

| Entity                             | Key                                                 | Notes                                                                                   |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Launch project                     | `projectId` (existing UUID)                         | Owner = `launch_projects.owner_user_id`                                                 |
| Config version                     | `(projectId, version)`                              | Append-only; `version` starts at 1; `configHash` = keccak of the canonical ABI encoding |
| Operator                           | `ops_operators.user_id` (LOOP user)                 | Individual identity; `enabled=false` revokes; no shared login                           |
| Grant                              | `(user_id, permission, scope)`                      | `scope` = `*` or one `projectId`                                                        |
| Approval                           | `(projectId, version)`                              | Append-only; at most one per version                                                    |
| Testnet acceptance                 | `acceptanceId` (= operator operationId)             | Append-only evidence, chain 97 only                                                     |
| Deployment task                    | `jobId` (UUIDv4, opaque)                            | `awaiting_executor → cancelled` only                                                    |
| Authorization / submission command | `(jobId, fingerprint)` / `(owner, Idempotency-Key)` | Append-only                                                                             |

Wallets are referenced by the opaque `walletId` of the caller's inventory;
the signing address is resolved server-side and never accepted from the
client as an identity. Contract addresses (Factory, predicted MEME / Hook)
are facts on a task, never keys.

## Ruling

### §1 Owner drafts (`GET`/`PUT /v2/launch/projects/{projectId}/hooks-config`)

The authenticated project owner saves only name, ticker, logo URL,
description, links (≤ 8, https), `nftSaleStartAt` (unix seconds, ≥ 24 h
ahead), and the per-project `buybackRecipient`. The server derives the fixed
economics (supply 1e9, curve 8e8, LP 2e8, graduation reserve
133,333.332 USD1, taxes 10 % / 2 %, LP fee 2500, tick spacing 60, per-address
cap 5e6, NFT 100 USD1 / 7 days, early round 1 h, buyback 100 USD1 / ≥ 10 s);
any other key is `INVALID_REQUEST`. CAS on `expectedVersion`
(`VERSION_CONFLICT`); `Idempotency-Key` is refused (the existing Launch CAS
rule). A foreign project is `NOT_FOUND`. Saving never publishes or deploys.
The buyback recipient is configuration only — no address is compiled in
(the address in `LOOP-整体方案` §5 is entered per project, not shipped).

### §2 Operator review (service + repository; no HTTP route in this batch)

Ported as `src/features/launch/hooks-launch-review.ts` and
`src/database/hooks-launch-review-repository.ts`. The requirer's native-JS
ops web console (`src/features/ops/web/*`, `src/routes/ops*.ts`) is **not**
ported: LOOP keeps loop-admin, which will host these commands after the
separation-of-duties batch decides operator sign-in.

- Permissions: `launch.read`, `launch.edit`, `launch.approve`,
  `testnet.read`, `testnet.accept`, `audit.read`. Commands:
  `launch.config.save` (edit), `launch.config.approve` (approve),
  `testnet.acceptance.record` (accept).
- Server-side separation of duties (§7: editor, approver, executor apart):
  - The editor of a version — the operator who saved it, or the project
    owner for an owner-saved draft — cannot approve it (`OPS_SELF_APPROVAL`).
    The project owner can never approve their own project.
    _Deviation from the requirer:_ they refused every owner-saved draft
    (`OPS_EDITOR_ID_UNKNOWN`), which made the owner route unable to reach
    approval at all; we treat the owner as that version's editor instead.
  - Only the latest version with a matching hash is approvable
    (`OPS_VERSION_CONFLICT`); a later owner save invalidates the approval for
    signing.
  - A testnet acceptance needs an approved version and an acceptor who did
    not edit or own it (`OPS_SELF_ACCEPTANCE`, new here).
  - The executor (future broadcast worker) is a separate identity; this
    batch has no executor at all.
- Each command: row-locked operator + grant check, operationId idempotency
  bound to actor + canonical SHA-256 (`OPS_IDEMPOTENCY_CONFLICT`), business
  insert, operation record, and success audit in one transaction; a
  rejection writes a sanitized `ops_audit` row after rollback.
- Operators are bootstrapped only by the deployment CLI
  `pnpm hooks:operator --user <id> --label <name> --permissions a,b [--scope <projectId>] --confirm`
  (or `--revoke --confirm`), refused under `NODE_ENV=production`, audited as
  `deployment_admin / deployment_cli` with before/after grant state.

### §3 Signing preparation (`GET …/hooks-config/signing-request?walletId=`)

BSC Testnet only. Requires `HOOKS_LAUNCH_ENABLED=on`, `LAUNCH_CHAIN_ID=97`
with launch RPC URLs, and `HOOKS_LAUNCH_FACTORY_ADDRESS` +
`HOOKS_LAUNCH_FACTORY_CODE_HASH` (both or neither; boot refuses a partial or
malformed pair, or any Factory on chain 56). Every call verifies chain ID 97
and the Factory runtime code hash, reads the owner wallet's Factory nonce,
mines the MEME salt (address suffix `6666`, salt bound to the launch ID) and
the Hook CREATE2 salt (permission bits `0x20CC` under mask `0x3FFF`), and
returns `LOOP Launch Factory` v1 EIP-712 typed data with a 900 s deadline.
Search is cooperative (yields every 256 attempts) and bounded (10^6); at most
four preparations per process (`503` + `Retry-After: 5`). It never signs,
stores, or broadcasts. EOA signatures only (no ERC-1271).

### §4 Deployment tasks (`POST …/hooks-deployments`, `GET`/`DELETE …/{jobId}`)

`POST` (UUIDv4 `Idempotency-Key`) verifies: active owned wallet equal to
`projectOwner`, latest config version/hash/name/ticker/start/recipient,
deadline in `(now, now + 3600]`, low-S 65-byte signature recovering to the
wallet, on-chain nonce, both CREATE2 predictions; then the repository locks
the project and requires an independent approval of exactly that latest
version (`403 POLICY_BLOCKED`, `HOOKS_CONFIG_NOT_APPROVED`). One active task
per project/version and per chain/Factory/wallet/nonce; renewing only the
deadline appends an authorization to the same task; different immutable
fields conflict (`409 VERSION_CONFLICT`). Exact replay of a key returns the
same task even after expiry; another body under the same key is
`409 IDEMPOTENCY_CONFLICT` (the requirer mapped both to `VERSION_CONFLICT`).
`DELETE` (UUIDv4 `Idempotency-Key`; naturally idempotent) moves
`awaiting_executor → cancelled`; it does not revoke a signature already
shared. Responses never contain the signature.

## Error codes (wire)

| Route                    | Codes                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all                      | `401 AUTH_REQUIRED/AUTH_INVALID`, `409 ACCOUNT_BOOTSTRAP_REQUIRED`, `500 INTERNAL_ERROR`, `503 CAPABILITY_UNAVAILABLE` (`detailsSafe.reasonCode`)                                     |
| `GET hooks-config`       | `400 INVALID_REQUEST`, `404 NOT_FOUND`                                                                                                                                                |
| `PUT hooks-config`       | `400 INVALID_REQUEST` (shape, override key, start too soon, Idempotency-Key present), `404 NOT_FOUND`, `409 VERSION_CONFLICT`                                                         |
| `GET signing-request`    | `400 INVALID_REQUEST` (wallet not the caller's active wallet, bad version), `404 NOT_FOUND` (no draft / foreign project)                                                              |
| `POST hooks-deployments` | `400 INVALID_REQUEST` (signature, deadline, wallet, CREATE2), `403 POLICY_BLOCKED` (`HOOKS_CONFIG_NOT_APPROVED`), `404 NOT_FOUND`, `409 VERSION_CONFLICT`, `409 IDEMPOTENCY_CONFLICT` |
| `GET/DELETE …/{jobId}`   | `400 INVALID_REQUEST`, `404 NOT_FOUND`                                                                                                                                                |

`503` reason codes: `HOOKS_LAUNCH_DISABLED` (switch off, or no database
repository) and `HOOKS_LAUNCH_FACTORY_UNAVAILABLE` (Factory not configured,
wrong chain, RPC/code-hash failure, exhausted salt search, busy).

## Unavailable behaviour (fail closed)

- `HOOKS_LAUNCH_ENABLED` defaults to `off`: all six routes are registered
  (OpenAPI lists them) and answer `503 HOOKS_LAUNCH_DISABLED` after
  authentication. The routes live inside the `launch` module, so without
  `V2_MODULES_ENABLED=launch` they are `404` like every Launch path.
- Enabled without a Factory: drafts work; signing and submission answer
  `503 HOOKS_LAUNCH_FACTORY_UNAVAILABLE`. No fixture, no fake success.
- No capability entry is added; `GET /v2/meta/capabilities` is unchanged.

## Not ported (and why)

- `src/features/ops/web/*`, `src/routes/ops.ts`, `src/routes/ops-web.ts`,
  `scripts/copy-ops-web.mjs`, `openapi/loop-api.ops.json`: the requirer's
  ops console and its `/ops` API surface (LOOP uses loop-admin).
- `src/features/ops/ops-contract.ts` / `ops-repository.ts` beyond the
  launch/testnet commands: mining drafts/publish, community review, support
  answer — overlaps LOOP's admin (Decision 0102) and the requirer's mining
  migration 000046.
- `ops_mining_drafts`, `ops_jobs` tables; the mining / community / support
  permissions (the permission check can be extended by a later migration).
- `src/database/ops-transaction.ts` (savepoint facade for reusing other
  repositories inside an ops transaction; not needed by launch commands).
- `vitest.config.mjs`, `.prettierignore`, `.dockerignore`, `eslint.config.mjs`
  AppleDouble exclusions (environment-specific; not needed here).

## Tests

- Unit: `test/hooks-launch-config.test.ts`, `hooks-launch-project-config.test.ts`,
  `hooks-launch-deployment-crypto.test.ts`, `hooks-launch-submission.test.ts`
  (requirer suites, ported), `hooks-launch-review.test.ts`
  (self-approval, owner self-approval, independent approval, command
  validation, CLI arguments), `hooks-launch-migrations.test.ts`.
- Route: `test/v2-hooks-launch-routes.test.ts` (disabled 503 on all six
  routes with the seven-field body, no-repository 503, draft CAS / foreign /
  override / Idempotency-Key, signing response and failure reasons, a real
  signed end-to-end submission, `POLICY_BLOCKED`, `IDEMPOTENCY_CONFLICT`,
  owner-scoped task read/cancel).
- Contract: `test/hooks-launch-contract.test.ts` (operation IDs, headers,
  error families, string amounts in the committed OpenAPI artifact).
- Integration (`loop_api_test_s125`): `test/hooks-launch-repositories.integration.test.ts`
  (draft CAS and append-only, stored override refusal, missing / disabled /
  unscoped / wrong-permission operators with rejection audit, editor and
  owner self-approval, stale version, operationId replay/conflict, testnet
  acceptance gating, project listing, nonce reservation, approval
  invalidation by a newer draft, ten concurrent submissions, deadline
  renewal, cancellation and the status guard).
