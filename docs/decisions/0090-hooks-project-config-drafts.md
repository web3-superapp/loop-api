# Decision 0090: Hooks project configuration drafts

- Status: Accepted for Development/Testnet scaffolding only
- Date: 2026-10-08
- Scope: Owner-authenticated project configuration drafts for the fixed
  `hooks_launch_v1` template. This decision does not enable payment, deployment,
  publication, contract activation, or mainnet operation.

## Decision

1. The existing authenticated Launch project owner may save and read a separate
   Hooks configuration draft for that project. Ownership is checked in the
   database on every read and write; another account receives `NOT_FOUND`.
2. Drafts use compare-and-swap `expectedVersion`. Each successful save appends a
   new immutable database version; stale writes receive `VERSION_CONFLICT`.
3. Only project metadata, NFT sale timestamp, and the MEME buyback recipient are
   submitted. The server derives the fixed template economics and canonical
   `configHash`; unknown/economic override fields are rejected.
4. The API exposes only `GET` and `PUT /v2/launch/projects/{projectId}/hooks-config`.
   These are off-chain draft operations; there is no sign, publish, deploy,
   activate, buy, or payment route in this decision.
5. Publication lead time remains a server policy (currently a 24-hour
   Development/Testnet preflight). The deployed factory's activation buffer must
   be verified against the same policy before any future publish workflow.
6. Mining rules, USDT conversion, Gas sponsorship, production deployment,
   mainnet writes, and all withdrawal/payment functions remain unavailable until
   separate numbered decisions and required security evidence exist.

## Verification boundary

The HTTP route and fixed-template hash are testable locally. The migration must
be applied and readiness checked against `DATABASE_URL_TEST` before the feature
is considered integrated. A passing unit or route test is not migration,
testnet, security-audit, or release evidence.
