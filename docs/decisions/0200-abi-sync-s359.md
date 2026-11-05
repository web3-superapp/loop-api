# Decision 0200: S359 Factory ABI from `pnpm hooks:abi-sync`; pre-S359 deploy path removed

- Status: Accepted
- Date: 2026-11-05
- Scope: S362-api. Amends Decision 0199 (signing / deployment on an older
  Factory, the hand-written ABI fragments). Source: loop-contracts main
  `e40a593` (S359 build, Decision 0019).

## What changed

- `src/integrations/launch/hooks-launch-protocol-abi.generated.ts` is synced
  from the S359 Foundry build. Pure additions: the 11-field `LaunchRequest`
  (`nftPrice`, `maxCumulativeBuy` after `memeSalt`) on `deployLaunch` /
  `previewHookInitCodeHash` / `previewLoopHookInitCodeHash`, the errors
  `InvalidNftPrice` / `InvalidMaxCumulativeBuy`, and — newly selected —
  `DEFAULT_NFT_PRICE()` + `LaunchNftPrice` (both Factories),
  `hookDeploymentFactory()` + `previewHookInitCodeHash` (OfficialTax
  Factory), `BuybackExecutor.orderAmount()`. No event or existing
  function signature changed.
- `scripts/hooks-launch-abi-sync.ts` now writes the module through Prettier
  (repository config), so a sync needs no follow-up `pnpm format`.
- `src/integrations/launch/hooks-launch-factory-terms-abi.ts` is deleted:
  every fragment it held is in the generated module. The reader's
  hand-written 9-field `previewHookInitCodeHash` / `hookDeploymentFactory`
  entries are deleted too (generated `loopLaunchFactoryAbi`).
- `hooksLaunchProjectTermsTupleComponents` is no longer an encoder input; a
  test asserts it equals the tail of the generated request tuple (both
  Factories, all three functions, field by field).
- No legacy 9-field fragment is kept: nothing decodes historical
  `deployLaunch` calldata (indexing reads events only, and
  `LaunchDeployed` / `LaunchMaxCumulativeBuy` are unchanged).

## Pre-S359 Factories are index-only

Staging and mainnet deploy new launches only on S359 Factories; older ones
(`LAUNCH2_LEGACY_FACTORIES`) are read-only. So the 9-field request is never
encoded:

- Factory reader `hookDeployment(request)` without terms throws
  `HooksLaunchRequestTermsMissingError` before any `eth_call`. Signing
  request and submission map it like every reader failure:
  `503 CAPABILITY_UNAVAILABLE` / `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`. On a
  pre-S359 current Factory this replaces Decision 0199's "default terms keep
  signing / deploying on every Factory" (saving a draft with default terms
  still works without a probe; non-default terms still get
  `422 HOOKS_LAUNCH_TERMS_UNSUPPORTED_BY_FACTORY`).
- Executor chain `deployData` without terms throws the same error; the
  executor fails the task non-retryably with
  `HOOKS_DEPLOY_SIMULATION_REVERTED`, `details.revert =
LAUNCH_REQUEST_TERMS_MISSING` (no broadcast, no retry loop).

## Factory generation

`launch2CurrentGeneration` stays `v3`; the S359 code hashes (A
`0x18c1…26e8`, B `0xaf42…a1ea`) are **not** added to
`launch2KnownFactoryGenerations`. That table only names Factories of an
older generation than the generated ABI; a generation is the module
surface the `launch2_event` lane and readers decode (Decision 0122:
`BuybackCompleted`, `quoteNextOrder`, `openPublicWithoutSnapshot`). S359
changes none of it (additive getters / errors / one Factory event), so an
unknown hash falling back to `v3` is correct, and the S340 / S311 / S243
`v3` legacy Factories keep decoding with the same ABI.
