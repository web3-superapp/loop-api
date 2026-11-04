# Decision 0199: Per-launch NFT price and per-address cap (S359)

- Status: Accepted (backend); needs an S359 Factory on the launch slot and
  `pnpm hooks:abi-sync` from the S359 build before non-default terms deploy
- Date: 2026-11-04
- Scope: S359-api. Requester 2026-11-04; user ruling "按千分之填整数做";
  coordinator ruling NFT price 1–1000 (one buyback order ≤ 1 % of the
  graduation reserve). Contracts: loop-contracts S359 / Decision 0019
  (commit 0e4177e). Amends Decisions 0152 / 0195 (the cap is now the
  project's, not the Factory admin default) and 0199 replaces the 100 USD1
  constant on S359 launches.

## Entities and storage

| Field               | Type    | Range   | Default | On chain                                                                  |
| ------------------- | ------- | ------- | ------- | ------------------------------------------------------------------------- |
| `nftPriceUsd1`      | integer | 1..1000 | 100     | `LaunchRequest.nftPrice` = n × 1e18 (also `BuybackExecutor.ORDER_AMOUNT`) |
| `walletCapPerMille` | integer | 1..1000 | 5       | `LaunchRequest.maxCumulativeBuy` = n × 1e24 raw MEME                      |

- Migration `000108_launch_project_terms`: two columns on the immutable
  application version `hooks_launch_project_config_versions`
  (`nft_price_usd1 integer not null default 100`, `wallet_cap_per_mille
integer not null default 5`, range checks). Every saved version carries
  the terms it was saved with, so the reviewed / signed version is the one
  deployed. Existing rows take the defaults (no rewrite; the 000051
  immutability trigger is not hit). `down` refuses while a non-default row
  exists.
- The terms are never part of the `config` JSON key set (the App decodes it
  strictly). On an S359 Factory they replace `fixedEconomics.nftPriceUsd1Raw`,
  `buybackOrderUsd1Raw`, `perAddressLifetimeBuyCapRaw` (and
  `loopDynamic.maxCumulativeBuy` when present) in place, so the configHash
  binds them; on an older Factory fixedEconomics and the configHash are
  byte-identical to before.
- No new opaque ID: the terms belong to `(projectId, configVersion)`.

## Write path (`PUT /v2/launch/projects/{projectId}/hooks-config`)

- `config.nftPriceUsd1` / `config.walletCapPerMille` optional; absent / null =
  default. A fraction, 0, a negative, a non-number or an out-of-range value
  is `422 VALIDATION_FAILED` with `detailsSafe.reasonCode`
  `LAUNCH2_NFT_PRICE_INVALID` / `LAUNCH2_WALLET_CAP_INVALID` and
  `detailsSafe.field`. (A JSON string is coerced by the route schema like
  every other number; a non-numeric string is the generic 400.)
- Factory generation probe (coordinator ruling 2026-11-04):
  `DEFAULT_NFT_PRICE()` (0xef14e547) answers on an S359 Factory; a
  missing-function revert = older Factory. Default terms (both absent /
  null, or exactly 100 / 5) are saved on the pre-S359 path **without
  probing**, so a save never fails on an unreachable probe. The answer is
  cached in process per `chainId:factoryAddress` (no expiry; a restart
  probes again; failures are not cached); a cache hit reads no chain. Only
  non-default terms with an unreadable probe are `503 CAPABILITY_UNAVAILABLE`
  / `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`. Signing request and submission use
  the same cache; on an S359 Factory a default-terms draft (template
  fixedEconomics) still signs and deploys `nftPrice = 100e18`,
  `maxCumulativeBuy = 5e24`.
- Older Factory + non-default terms = `422 VALIDATION_FAILED` /
  `HOOKS_LAUNCH_TERMS_UNSUPPORTED_BY_FACTORY` (save, signing request, and
  submission). Default terms keep working on every Factory.

## Signing and deployment

- S359 Factory: `GET …/hooks-config/signing-request` adds `request.nftPrice`
  and `request.maxCumulativeBuy` (decimal strings, always the actual value,
  never 0), the EIP-712 domain is `("LOOP Launch Factory", "2", chainId,
factory)` and the type is `LaunchRequest(bytes32 configHash,address
projectOwner,uint32 configVersion,string name,string ticker,uint64
nftSaleStart,address buybackRecipient,uint64 deadline,bytes32 memeSalt,
uint256 nonce,bytes32 templateHash,uint256 nftPrice,uint256
maxCumulativeBuy)`. Older Factory: domain "1", no terms — byte-identical.
- The draft's saved fixedEconomics must show the terms (a draft saved
  against another Factory → `503 HOOKS_FACTORY_TEMPLATE_MISMATCH`: re-save).
- `POST …/hooks-deployments` accepts the two optional request fields; on an
  S359 Factory they must equal the draft's (`409 VERSION_CONFLICT`), on an
  older one they must be absent (`400 INVALID_REQUEST`). The binding hash
  covers them (the request JSON).
- Executor: `deployLaunch` tuple `(address projectOwner, uint32
configVersion, bytes32 configHash, string name, string ticker, uint64
nftSaleStart, address buybackRecipient, uint64 deadline, bytes32 memeSalt,
uint256 nftPrice, uint256 maxCumulativeBuy)` (selector 0xd2d589a0) when the
  signed request carries terms; the Hook init-code previews use the same
  tuple.
- Verification (OfficialTax and LoopDynamic): with terms,
  `curve.maxCumulativeBuy() == maxCumulativeBuy`, `nft.PRICE() == nftPrice`,
  `BuybackExecutor.ORDER_AMOUNT()` (or `orderAmount()`) `== nftPrice`; the
  receipt's `LaunchMaxCumulativeBuy` (if any) must match the curve. The
  executor scans receipt logs by topic, so the S359 order
  (`LaunchMaxCumulativeBuy` → `LaunchNftPrice` → `LaunchDeployed`) needs no
  adjacency change. `verification.nftPrice` is recorded with the task.
- The conversion and the struct / EIP-712 field order live in one module,
  `src/features/launch/hooks-launch-project-terms.ts` (plus the hand-written
  ABI fragments `src/integrations/launch/hooks-launch-factory-terms-abi.ts`,
  to be replaced by `pnpm hooks:abi-sync`).

## Read path (switch `LAUNCH2_PROJECT_TERMS_EMIT`, off | on, default off)

Off: every response is byte-identical to before. On, three keys
`nftPriceUsd1`, `walletCapPerMille`, `maxCumulativeBuyRaw` are added to:

- the hooks-config draft `config` (GET and PUT responses);
- `GET /v2/launch/projects/{projectId}` `project` (newest config version;
  defaults when none saved);
- `GET /v2/launch2/instances/{instanceId}` `instance` (verified chain facts:
  `verification.nftPrice` / `curveMaxCumulativeBuy`; `nftPriceUsd1` /
  `walletCapPerMille` are null only when the chain value is not a whole
  USD1 / permille — possible for a pre-S359 admin-set cap);
- `GET /admin/v1/launch/projects/{projectId}` `project`.

Independent of the switch (value changes only, same keys): the instance
`template.nftPriceUsd1` / `buybackOrderUsd1` / `perAddressCap`, the NFT
sale price, the buyback summary and the NFT mint prepare use the instance's
verified price (100 USD1 for every launch verified before this decision).
The curve quote already read the curve's own `maxCumulativeBuy()`; only its
description changed.

## Unavailable behaviour

No Factory reader, unreadable probe, or unreadable module getters → the
existing `503 CAPABILITY_UNAVAILABLE` reasons; verification fails closed
(`buyback_params` / `nft_params` / `curve_caps`). Nothing returns a default
in place of an unread chain fact.
