# Decision 0028: Adopt the 93-route manifest and frozen prototype as the shared product baseline

- Status: Accepted
- Date: 2026-09-07

## Context

The 2026-09-01 product package (`01-前端设计开发交接信息.md`,
`03-非合约产品方案.md`) freezes a 93-route information architecture with five
primary tabs and `community` as the post-login route. Two prototype builds are
in circulation: the Vercel build (94 screens, still containing `home`,
`onboarding`, `notifications`, and `copytrade-perms`) and the cliview.org build
(93 screens). Only the cliview.org file matches the SHA-256 fingerprint recorded
in the handover document (`bdbe1832…`).

The mobile client still carries a 103-surface catalog and the backend
inventory still names screens by that catalog. Both teams need one machine
readable route list so that API modules, deep links, and acceptance checklists
refer to the same identifiers.

## Decision

- `docs/routes-manifest.json` (mirrored from the workspace master at
  `LOOP/docs/routes-manifest.json`) is the only route inventory. It lists the 93
  slugs grouped by module `0,2,3,4,5,6,7,8`, the five tab slugs, and the
  prototype order. The missing module number `1` is intentional and must not be
  filled.
- The cliview.org prototype (SHA-256
  `bdbe183286c2d77c0de7f731818d5a8da9702ef08ed9a558a5189609c8b33c1a`) is the
  only visual/interaction reference. The Vercel build is superseded and must
  not be cited in decisions, tests, or handover documents.
- Backend module task sheets, `docs/api-inventory.md`, and frontend handover
  documents reference pages by manifest slug, never by the retired 103-surface
  IDs.
- The delivery sequence follows the D0–D21 roadmap in
  `docs/plans/2026-09-01-gitnexus-plan-v2-module-delivery-roadmap.md`,
  grouped into nine workspace steps described in `LOOP/docs/01-实施方案.md`.
- Contract-dependent Launch parameters stay configuration slots marked
  `PENDING` until `02-合约产品方案.md` is delivered.

## Consequences

- Any route or page name not in the manifest is a defect, not a feature.
- Local development maps PostgreSQL to `127.0.0.1:5433` through an untracked
  `compose.override.yaml` because another project occupies `5432`; the
  committed `compose.yaml` is unchanged.
- The full gate ran on 2026-09-07 with Node 24.19.0 / pnpm 10.28.0: format,
  lint, typecheck, `openapi:check`, 102 unit/contract files (1696 tests) and 23
  integration files (290 tests) pass. One lease-expiry timing test in
  `test/control-plane-repository.integration.test.ts` failed once and passed on
  rerun; it is tracked as a timing flake, not a regression.
