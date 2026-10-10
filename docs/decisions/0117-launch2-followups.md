# Decision 0117: MEME v2 BSC Testnet round 1 follow-ups — sale lead, instance counterparties, contract fixes (S139)

- Status: Accepted (S139-api)
- Date: 2026-10-10
- Baseline: `integration/v2` = `8c4e038`
- Inputs: `docs/integration/S137/report.md` (blocking items 3, 6, 8);
  Decisions 0065 (BSC write canary), 0108 (Hooks config / signing / tasks),
  0112 (deployment executor, 28 checks), 0114 (launch2 read model).
- Scope: config `HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS`; the owner `PUT
hooks-config` and the operator `launch.config.save` paths; the
  `/v2/launch2/*` prepares; `GET /admin/v1/launch/projects/{projectId}`;
  frontend contracts. **No migration** (000062 belongs to S138), no new
  worker lane, no route added or removed.

## 1. Configurable NFT sale-start lead

### Problem

Decision 0108 fixed the lead between "now" and `nftSaleStartAt` at 86,400 s
in two places (`app.ts`, owner path; `hooks-launch-review-repository.ts`,
operator path). The contracts only need the sale start to be later than the
Gate's activation buffer (3,600 s) when `activateLaunch` lands. S137 had to
wait 24 h for the first NFT mint on BSC Testnet.

### Ruling

- New env `HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS`: integer, default `86400`
  (production semantics unchanged), floor `4200`, ceiling `2592000`
  (30 days). Anything else refuses boot.
- Floor = activation buffer 3,600 s + 600 s margin. The margin covers the
  owner's signature lifetime path (signing request → submit), executor claim,
  broadcast, `HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS` confirmations, the 28
  read-back checks and `activateLaunch` (S137: activated 26.5 s after claim).
  A task that still misses the window fails with the existing
  `HOOKS_ACTIVATION_WINDOW_CLOSED`; no new failure mode.
- Both paths read the one value: `config.hooksLaunch.minimumSaleLeadSeconds`
  is passed to `createHooksLaunchProjectConfigService` and, through
  `PostgresDatabaseConfig.hooksLaunch`, to
  `createPostgresHooksLaunchReviewRepository({ minimumLeadSeconds })`.
  Processes that do not pass it (workers, scripts) keep 86,400 s.
- Too-early starts stay `400 INVALID_REQUEST` (owner) /
  `OPS_INVALID_LAUNCH_CONFIG` (operator). Development sets 4200.

## 2. launch2 counterparties come from the activated instance registry

### Problem

`nft/prepare` and `trade/prepare` called `requireCanaryCounterparty`, i.e.
the static `BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST`. Every new instance (new
NFT + curve addresses) needed an env edit and an API restart; S137 added the
instance's NFT / curve / tUSD1 by hand.

### Ruling

For launch2 only, the counterparty check is
`requireLaunch2Counterparties` (`src/features/launch2/launch2-counterparty.ts`):
every target the user's wallet is pointed at — the transaction `to` (NFT or
curve), the approve token (USD1 or the instance MEME) and the approve spender
— must be in the trusted set of the instance the request named:

- the 11 module addresses stored on its `launch2_instances` row
  (meme, hook, nft, curve, gate, escrow, snapshots, graduationAdapter,
  buybackAdapter, priceRecorder, buybackExecutor), and
- the instance's USD1 = `CurveEngine.usd1()` read from that registered curve
  at the prepare's block.

Nothing is trusted when the row is not activated (`activatedAt` null) or is
held (`holdReason` set). Refusal: `403 POLICY_BLOCKED`,
`detailsSafe.reasonCode = LAUNCH2_COUNTERPARTY_NOT_INSTANCE`. In the current
code paths the targets always come from the row, so the check is a
fail-closed guard (a future code path cannot point a wallet elsewhere).

Unchanged: USD1 must be in `BSC_WRITE_CANARY_ASSETS`
(`ASSET_NOT_IN_CANARY_ALLOWLIST`), the per-intent ceiling
`BSC_WRITE_CANARY_MAX_USD` and the rolling daily ceiling
(`BSC_WRITE_CANARY_DAILY_MAX_USD`), the mainnet refusal
(`LAUNCH2_MAINNET_SIGNING_CLOSED`) and `BSC_WRITES_ENABLED`. Other write
flows (send, Launch v1, MEME curve) keep the static allowlist.

### Why the registry row is trustworthy

1. **Only executor-verified tasks become rows.**
   `registerActivatedInstances` inserts from
   `hooks_launch_deployment_tasks` with `status = 'activated'`, the configured
   Factory, chain 97. A task reaches `activated` only through Decision 0112:
   the `deployLaunch` receipt confirmed at `HOOKS_LAUNCH_EXECUTOR_CONFIRMATIONS`
   (12 on Development), the `LaunchDeployed` event decoded from the configured
   Factory, and all 28 read-back checks passed — Factory runtime code hash,
   per-module wiring against the Factory's immutables (USD1, pool manager,
   keepers, launchId, sale window, curve ↔ NFT ↔ gate ↔ escrow ↔ adapters),
   MEME `…6666`, Hook flags. The module addresses on the row are the
   `deployed_addresses` that verification read back, not user input.
2. **Activation is witnessed on chain.** `activatedAt` is set by the
   `launch2_event` lane from `LaunchActivated` of the same launchId under the
   S116 checkpoint / reorg discipline; a mismatch puts the row on hold
   (`LAUNCH2_DEPLOYED_EVENT_MISMATCH` / `LAUNCH2_ACTIVATION_MISSING`), which
   this check treats as untrusted.
3. **USD1 is bound by verification, not configuration.** Check
   `curve.usd1 == factory.usd1` (and the same for NFT, escrow, buyback,
   adapter) passed before activation; the curve's `usd1` is immutable, so
   reading it at the prepare block yields the verified value. The operator's
   canary asset list still has to admit it, so a new USD1 needs an explicit
   env decision.
4. **Writes stay narrow.** The rows are written only by the API's own
   registration from tasks and by the lane; there is no route that accepts an
   address for them.

## 3. Contract-document fixes (no behaviour change)

- Hooks §5: request-body format errors → `400 INVALID_REQUEST`; fields that
  differ from the approved latest config (configVersion, configHash, name,
  ticker, nftSaleStart, buybackRecipient) or a consumed Factory nonce →
  `409 VERSION_CONFLICT` (S137: tampered `nftSaleStart` → 409).
- Hooks §9.3: the success sequence is `created → claimed → broadcast →
confirmed → verified → activation_broadcast → activated`; `included` /
  `activation_included` are conditional (only when the first receipt
  observation is below the confirmation target) and must not be relied on.
- launch2 §3.1 / §3.3: starting price `0.00004166666625` (the earlier
  `0.000041666666625` was a typo; the test fixture carried the same typo and
  is corrected). Quotes in `upcoming` / `nft_sale` / `snapshot_pending` are
  `409 DATA_STALE / LAUNCH2_STAGE_MISMATCH` (`detailsSafe.stage`), not a 200
  with `limitedBy: closed`.
- `fixedEconomics.chainId` is the template value 56 (it is hashed into
  `configHash`, so it is not changed); the deployment chain is
  `LAUNCH_CHAIN_ID`. `GET /admin/v1/launch/projects/{projectId}` gains the
  read-only integer `deploymentChainId` (`56 | 97`, required).

## Unavailable behaviour

Unchanged from 0108 / 0114: without the Factory / chain / writes the routes
stay 503 with their reason codes; nothing in this decision returns a
fabricated success.

## Tests

- `test/config.test.ts`: default 86,400, floor 4,200, ceiling, refusals.
- `test/v2-hooks-launch-routes.test.ts`: default refuses a 5,000 s lead;
  `HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS=4200` accepts 5,000 s, refuses 4,100 s.
- `test/hooks-launch-repositories.integration.test.ts`: the operator save
  path honours the configured lead.
- `test/launch2-counterparty.test.ts`: instance modules + USD1 admitted;
  non-instance address refused (alone or mixed); unactivated / held instance
  refused.
- `test/v2-launch2-routes.test.ts`: NFT and curve-buy prepares pass with a
  non-empty allowlist that names none of the instance contracts; USD1 outside
  the canary asset list is still `ASSET_NOT_IN_CANARY_ALLOWLIST`.
- `test/admin-role-routes.test.ts`: `deploymentChainId` 56 / 97.
