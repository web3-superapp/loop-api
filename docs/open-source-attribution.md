# Runtime dependency and license attribution register

This register covers the direct runtime and verification dependencies introduced
by the Node backend foundation. The exact transitive graph and integrity hashes
are recorded in `pnpm-lock.yaml`.

| Package                | Version | Purpose                                  | License                 |
| ---------------------- | ------: | ---------------------------------------- | ----------------------- |
| Fastify                |  5.12.1 | HTTP server and route lifecycle          | MIT                     |
| `@fastify/swagger`     |   9.8.1 | OpenAPI 3.1 generation                   | MIT                     |
| `@fastify/helmet`      |  13.1.1 | HTTP security headers                    | MIT                     |
| `@privy-io/node`       |  0.29.0 | Privy token and user/wallet reads        | Apache-2.0              |
| `@stream-io/node-sdk`  |  0.7.63 | Stream Chat/Video user-token signing     | Proprietary Stream SCLA |
| `pg`                   |  8.23.0 | PostgreSQL driver and pooling            | MIT                     |
| Zod                    |   4.4.3 | Fail-closed environment validation       | MIT                     |
| `node-pg-migrate`      |   9.0.0 | PostgreSQL schema migrations             | MIT                     |
| Vitest                 |  4.1.11 | Behavior and contract tests              | MIT                     |
| TypeScript             |   6.0.3 | Static typing and compilation            | Apache-2.0              |
| ESLint                 |  10.9.0 | Static analysis                          | MIT                     |
| Prettier               |   3.9.6 | Deterministic source formatting          | MIT                     |
| `tsx`                  | 4.23.12 | Local TypeScript execution/watch         | MIT                     |
| `lossless-json`        |   4.3.1 | Lossless provider JSON numbers           | MIT                     |
| Hyperliquid Python SDK |  0.24.0 | Offline signing-conformance oracle only  | MIT                     |
| `@nktkas/hyperliquid`  |  0.33.3 | Low-level Spot L1 canonicalize/sign only | MIT                     |
| `viem`                 |  2.44.2 | EIP-712 signature recovery               | MIT                     |

The Privy SDK entry covers the access-token verification boundary approved by
Decision 0002 and the verified current-user/wallet lookup approved by Decision 0010. It provides no backend signing or wallet execution path.

`@stream-io/node-sdk@0.7.63` is not open source. Its proprietary Stream Source
Code License Agreement was explicitly accepted by an authorized LOOP project
representative under the eligibility assertions recorded in Decision 0021. The
exact package is used only in the private backend to call `generateUserToken`
with `user_id`, `iat`, and `exp`; no permanent, role, call, or custom claims are
added. The SDK, dependency cache, and runtime image must remain private and
access controlled. A version change requires a new official-source and license
review.

The 2026-08-29 production-dependency audit reports no advisory through the new
Stream subtree. The repository-wide audit is not green: one high and one
moderate advisory both resolve through the pre-existing `viem > ws@8.18.3`
path. This Stream decision does not silently modify the frozen Hyperliquid
dependency subtree; that remediation remains a separate release gate.

Decisions 0011 and 0013 limit `lossless-json` to unauthenticated Hyperliquid
Testnet Info response parsing for private projections and order reconciliation.
The narrow adapters compile one Testnet URL; the package introduces no
configurable provider URL, provider SDK, signer, credentials, replay, or
mutation capability.

The Hyperliquid Python SDK is not a Node runtime dependency. Verification
fixtures under `contracts/hyperliquid-spot/` were generated offline from exact
commit `2fdb18f9517675ea03695a0962bd19eece9c83f0`; source, license, lockfile, and
fixture-oracle hashes are recorded in that contract's `oss-lock.json`. No
Python SDK code, credential, or private key is distributed with LOOP.

`@nktkas/hyperliquid@0.33.3` is selected only for `canonicalize`,
`createL1ActionHash`, `signL1Action`, and its narrow wallet interface. LOOP does
not use `ExchangeClient`, the SDK nonce manager, a high-level order method, or
any SDK transport. PostgreSQL remains the nonce and one-attempt journal
authority; the writer is a separate fixed-Testnet adapter. `viem@2.44.2`
recovers the signer of the same EIP-712 payload; a real Privy wallet resolver
has not been implemented.

The selected dependency graph is frozen in `pnpm-lock.yaml`, and the directly
used Hyperliquid subtree is recorded in
`contracts/hyperliquid-spot/oss-lock.json`. `pnpm licenses list --prod --json`
reports MIT for the selected package, its runtime dependencies, and `viem`.
The complete SBOM is still pending. Offline action-hash, EIP-712 digest, and
signature vectors pass, but direct MessagePack/preimage byte evidence,
credentialed Testnet mutation, Agent authorization, just-before-send preflight,
runtime composition, and crash/reconciliation evidence remain pending. The
production Spot capability therefore remains default closed.
