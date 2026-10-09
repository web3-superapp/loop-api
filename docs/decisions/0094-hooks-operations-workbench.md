# 0094 · Hooks 发射与挖矿治理纳入运营工作台

## Status

Accepted for Development/Testnet work on 2026-10-08. Extends 0090 and 0093.
Does not enable Mainnet writes, token sales, or real-fund operation.

## Decision

1. Hooks project configuration, NFT sale-time management, snapshot readiness,
   buyback recipient, M01–M17 rule review, and Testnet acceptance are managed
   from the existing `/ops` control plane. The project-owner draft screen may
   remain as a separate submission surface; operators review and administer
   the resulting project there.
2. The supplied address
   `0x28816c4C4792467390C90e5B426F198570E29307` is a buyback-token recipient
   value for the relevant project configuration. It is not an operator, deployer,
   treasury, or contract-owner identity. Recipient settings remain project
   scoped and require a recorded change reason.
3. Operator identity uses the existing verified LOOP principal and individual
   `ops_operators` records. No shared admin login or public self-registration.
   Access is granted by scoped permissions and every consequential write is
   append-audited.
4. Minimum permission groups are `launch.read`, `launch.edit`,
   `launch.approve`, `mining.read`, `mining.edit`, `mining.approve`,
   `testnet.read`, `testnet.accept`, and `audit.read`. The user configuring a
   project or editing a mining rule cannot approve that same version.
5. M01–M17 confirmation is a versioned, content-hashed business sign-off.
   Approving the record does not itself publish a reward formula or enable
   reward claims; the existing mining approval/publication checks remain in
   force.
6. Testnet acceptance records include chain, contract/config hashes, test
   checklist version, evidence references, actor, time, outcome, and reason.
   They are evidence records, not proof of independent security audit.
7. Contract deployer, emergency roles, executor and platform staff are distinct
   identities. The operations backend may show registered addresses and
   observed permissions; it never stores private keys or impersonates a
   multisig. Production high-impact on-chain authority must be held by the
   approved multisig.

## Rollout boundary

Implement the Development/Testnet schema, routes, permissions, and UI first.
Any Mainnet capability requires separate numbered security approval after the
BSC fork, USD1, buyback, and independent-audit gates pass.
