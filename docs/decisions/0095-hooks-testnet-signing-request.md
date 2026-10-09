# Decision 0095: BSC Testnet Hooks signing-request preparation

- Status: Accepted for Development/Testnet only
- Date: 2026-10-09
- Scope: Owner-authenticated preparation of EIP-712 data and a CREATE2 Hook
  salt for the fixed `hooks_launch_v1` Factory. This does not authorize a
  deployment transaction, mainnet, custody, or payment.

## Decision

1. The API may expose
   `GET /v2/launch/projects/{projectId}/hooks-config/signing-request` only to
   the authenticated owner of the project. The request names an opaque wallet
   ID; the server resolves it through that owner's registered wallet inventory
   and requires it to be active. The client cannot supply an arbitrary signing
   address.
2. The endpoint uses the latest saved config version and hash, reads the
   project wallet's Factory nonce from BSC Testnet, and returns the exact
   `LOOP Launch Factory` EIP-712 domain, `LaunchRequest` typed data, bounded
   signature deadline, Hook init-code hash, mined Hook CREATE2 salt, and
   predicted Hook address. The endpoint never signs, stores a signature,
   broadcasts, or activates a project.
3. The Hook address must satisfy permission bits `0x20CC` under mask `0x3FFF`.
   Search is bounded; failure to find a salt returns unavailable and does not
   weaken the permission requirement.
4. The project MEME token address must end in `6666`. A separate user-facing
   `memeSalt` is mined against the Factory-pinned token deployer and init-code
   hash. The effective CREATE2 salt is `keccak256(abi.encode(launchId,
memeSalt))`, which prevents the same salt from colliding across launches.
   `memeSalt` is part of the owner's EIP-712 signature. The Factory rejects a
   request whose predicted MEME address does not end in `6666`. Token suffix
   mining and Hook permission mining are independent; other module addresses
   are not vanity-mined.
5. Factory address and expected runtime code hash must be configured together.
   They are accepted only when `LAUNCH_CHAIN_ID=97`; every signing preparation
   verifies chain ID, Factory code presence, and exact runtime code hash. The
   configured launch RPC endpoints remain server-side and are never returned.
6. The response is `no-store`. A changed config version, changed Factory
   nonce, expired deadline, or changed Factory code invalidates the request.
   The client must request a new payload and obtain a new wallet signature.
7. Project signatures are EOA EIP-712 signatures for this iteration. Smart
   contract wallets and ERC-1271 are not supported. The API does not hold or
   request project or executor private keys.

## Verification boundary

Local unit and route tests verify owner-scoped active-wallet resolution,
EIP-712 field order and Factory domain, and CREATE2 permission bits. Chain reads
still require a separately deployed and code-hash-verified BSC Testnet Factory.
The signing-request route is not a deploy-job state machine. Persistence of
owner signatures, executor transaction submission, receipt/reorg tracking,
module-by-module verification, activation and post-sale NFT snapshot processing
remain separate work before the management-to-chain publishing flow is complete.
