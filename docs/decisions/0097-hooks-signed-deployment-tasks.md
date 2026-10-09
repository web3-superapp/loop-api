# 0097: Project signature verification and durable deployment tasks

Status: implemented locally, 2026-10-09. BSC Testnet only; no broadcast worker.

## Behavior

After the current configuration has independent approval, the project owner prepares an EIP-712 request, checks chain 97 and the registered wallet, then signs with the browser wallet. POST /v2/launch/projects/:projectId/hooks-deployments verifies the signature and records an awaiting_executor job. GET reads the owner-scoped job; DELETE cancels an awaiting job. Responses contain predicted addresses and status, never the saved signature.

Verification covers active owned wallet, latest configuration and approval hash, name/ticker/start/recipient, deadline, low-S 65-byte signature, chain nonce, independently recomputed MEME CREATE2 suffix 6666 and Hook permission mask 0x20cc. Factory or chain lookup failures reject rather than assuming compatibility. No private keys enter the API or UI.

## Concurrency and recovery

Migration 000053 adds tasks, append-only authorizations and append-only commands. Transactions lock the project and recheck latest approved configuration. A unique active task per project/version and per chain/factory/project-wallet/nonce prevents conflicting pending deployments. Exact idempotent replay remains readable after signature expiry. Renewing only the deadline appends authorization to the same task; changing immutable deployment fields conflicts. Canonical address/hash casing does not change deployment binding.

A timeout preserves the signed payload and Idempotency-Key for retry. The UI prevents replacing an unresolved submission with a fresh preparation. A task can only transition awaiting_executor to cancelled in this schema; immutable fields, authorization records and command records cannot be edited or deleted through normal SQL mutations.

## Boundaries

A recorded job is not a transaction or deployment. Cancellation does not revoke an already shared EIP-712 signature on chain. The future executor must recheck current job/config/deadline/nonce, claim work atomically, reserve signer nonces, persist transaction hashes, handle receipts/reorgs and verify modules before activation. New execution states require a reviewed migration; do not reuse this queue as a running worker without those transitions.

The local server has no Privy credentials, deployed Factory configuration or broadcast signer. Automated tests use synthetic signing accounts and an isolated PostgreSQL database. Preview mode does not request wallets, signatures or chain transactions.

## Validation

Seven signature-service cases include tampered fields, expiry, stale nonce, wrong signer, wrong wallet/Hook salt, exact replay and wrong chain. Five PostgreSQL cases cover approval enforcement, ten simultaneous duplicate commands, append-only renewal, cancellation/idempotency and cross-project nonce reservation. Full non-database API regression passed: 238 files / 3428 tests. The separate PostgreSQL submission suite passed 5/5. TypeScript, scoped ESLint, production build, formatting and deterministic OpenAPI checks passed. The rebuilt local server reports database up; an unauthenticated request with correct client-version headers to the job read endpoint returns 401. Browser inspection confirmed the project list and signature/task panel render in preview without initiating wallet requests.
