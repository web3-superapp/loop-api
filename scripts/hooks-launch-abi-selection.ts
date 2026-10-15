/**
 * Decision 0112: which ABI items of the loop-contracts Foundry build the
 * Hooks deployment executor consumes; Decision 0114 adds the events and
 * views the `launch2_event` lane and the `/v2/launch2/*` reads/prepares use.
 * Decision 0122: the selection is the current (v3) Factory generation; the
 * v2 BuybackExecutor items live frozen in
 * `src/integrations/launch/hooks-launch-protocol-abi-legacy-v2.ts`. Errors of every listed contract are
 * always kept so reverts decode to a contract error name.
 */
export const hooksLaunchAbiSelection = {
  LoopLaunchFactory: [
    "deployLaunch",
    "activateLaunch",
    "launchModules",
    "launchIdByOwnerVersion",
    "nonces",
    "deploymentExecutor",
    "activationBufferSeconds",
    "nftSaleDuration",
    "targetChainId",
    "poolManager",
    "usd1",
    "platformTaxReceiver",
    "feeVault",
    "primaryKeeper",
    "fallbackKeeper",
    "pauseAuthority",
    "resumeAuthority",
    "tokenDeployer",
    "v4Deployer",
    "saleDeployer",
    "buybackDeployer",
    "tokenDeployerCodeHash",
    "v4DeployerCodeHash",
    "saleDeployerCodeHash",
    "buybackDeployerCodeHash",
    "TEMPLATE_HASH",
    "LaunchDeployed",
    "LaunchActivated",
  ],
  LaunchPublicationGate: [
    "launchId",
    "configHash",
    "nftSaleStart",
    "activationBufferSeconds",
    "deployExecutor",
    "published",
    "activatedAt",
    "LaunchActivated",
  ],
  MemeToken: [
    "TOTAL_SUPPLY",
    "totalSupply",
    "name",
    "symbol",
    "decimals",
    "balanceOf",
    "launchFactory",
    "graduationAuthority",
    "curve",
    "graduated",
  ],
  CurveEngine: [
    "BUY_TAX_BPS",
    "SELL_TAX_BPS",
    "MAX_CUMULATIVE_BUY",
    "EARLY_ROUND_DURATION",
    "meme",
    "usd1",
    "snapshots",
    "graduationAdapter",
    "publicationGate",
    "platformTaxReceiver",
    "soldSupply",
    "accountedReserve",
    "graduated",
    "cumulativeBought",
    "earlyRoundEndsAt",
    "quoteMaxBuy",
    "quoteBuy",
    "quoteSell",
    "buy",
    "sell",
    "CurveBought",
    "CurveSold",
    "Graduated",
  ],
  OfficialTaxHook: [
    "TAX_BPS",
    "poolManager",
    "feeVault",
    "poolInitializer",
    "expectedInitialSqrtPriceX96",
    "currency0",
    "currency1",
    "lpFee",
    "tickSpacing",
  ],
  ProjectNFT: [
    "PRICE",
    "SALE_DURATION",
    "launchId",
    "usd1",
    "publicationGate",
    "escrow",
    "saleStart",
    "saleEnd",
    "totalMinted",
    "mintedByAddress",
    "balanceOf",
    "mint",
    "NftMinted",
    "Transfer",
  ],
  NftEscrow: [
    "usd1",
    "launchFactory",
    "projectNft",
    "buybackExecutor",
    "totalRecorded",
    "totalSpent",
    "availableBudget",
  ],
  BuybackExecutor: [
    "usd1",
    "meme",
    "budget",
    "swapAdapter",
    "recipient",
    "primaryKeeper",
    "fallbackKeeper",
    "pauseAuthority",
    "resumeAuthority",
    "paused",
    "lastSuccessfulAt",
    "quoteNextOrder",
    "ORDER_AMOUNT",
    "MIN_SUCCESS_INTERVAL",
    "execute",
    "pause",
    "BuybackCompleted",
    "BuybackPausedEvent",
    "BuybackResumed",
  ],
  OfficialV4GraduationAdapter: [
    "LP_MEME_ALLOCATION",
    "LP_FEE",
    "TICK_SPACING",
    "launchFactory",
    "poolManager",
    "usd1",
    "currency0",
    "currency1",
    "meme",
    "curve",
    "projectBound",
    "finalized",
  ],
  SnapshotRegistry: [
    "launchId",
    "nft",
    "nftSaleEnd",
    "root",
    "rootPublishedAt",
    "isEligible",
    "snapshotDigest",
    "publishSnapshot",
    "SnapshotPublished",
    // Decision 0122 (v3 Factory generation): zero-holder public opening.
    "openedWithoutHolders",
    "openPublicWithoutSnapshot",
    "PublicRoundOpenedWithoutHolders",
  ],
  // Decision 0124: the official-pool swap router the App trades through
  // after graduation, and the PoolManager views / events around it (slot0
  // through extsload, the Swap log the launch2_event lane indexes).
  OfficialPoolRouter: ["poolManager", "swapExactIn", "swapExactOut", "Swap"],
  PoolManager: ["extsload", "Swap"],
  // Decision 0131 (S166): the optional LoopDynamic official-pool Hook kind
  // (loop-contracts S164 + S165, Decision 0009). The per-project Hook (rounds,
  // candles, fees, claim), the shared exact-input LoopRouter the App and the
  // buyback adapter swap through, the graduation adapter that binds the Hook
  // (`LoopHookBound`), the Hook deployment factory (`LoopHookDeployed`), the
  // LoopDynamic Factory views, the trusted-router list, and the buyback
  // adapter's errors (keeper refusals).
  LoopDynamicHook: [
    "CANDLE_SECONDS",
    "initialized",
    "armed",
    "candleId",
    "candleOpenSqrtPriceX96",
    "lastSqrtPriceX96",
    "currentRoundId",
    "carry",
    "reservedRewards",
    "rounds",
    "buyWeight",
    "hasClaimed",
    "claimable",
    "currentDropWad",
    "manager",
    "trustedRouter",
    "meme",
    "quote",
    "memeIsCurrency0",
    "poolId",
    "baseSellFeePpm",
    "priceTiming",
    "routingPolicy",
    "routerRegistry",
    "excludeBuybackFromRewards",
    "rewardExcludedBuyer",
    // S165 (loop-contracts Decision 0009 §13): 2 % buy fee in MEME.
    "buyFeePpm",
    "buybackBuyer",
    // S179/S193 (loop-contracts Decision 0012, Decision 0144): dynamic sell
    // rate cap (0 = uncapped; absent on pre-S193 Hooks).
    "maxDynamicFeeWad",
    "poke",
    "claim",
    "SellFeeCharged",
    "CandleClosed",
    "EmptyCandlesSkipped",
    "RoundActivated",
    "RoundClosed",
    "BuyCredited",
    "BuyNotCredited",
    "BuyFeeCharged",
    "RewardClaimed",
  ],
  LoopRouter: ["manager", "activeActor", "swapExactInput"],
  LoopDynamicGraduationAdapter: [
    "hook",
    "hookFactory",
    "finalized",
    "lockedPoolId",
    "LoopHookBound",
    // Decision 0132 (S170): the executor's read-back of a LoopDynamic launch.
    "LP_MEME_ALLOCATION",
    "LP_FEE",
    "TICK_SPACING",
    "HOOK_PERMISSIONS",
    "launchFactory",
    "poolManager",
    "usd1",
    "currency0",
    "currency1",
    "meme",
    "curve",
    "projectBound",
    "launchId",
    "graduationSqrtPriceX96",
  ],
  LoopDynamicBuybackAdapter: [
    "router",
    "graduationAdapter",
    // Decision 0132 (S170): executor read-back.
    "usd1",
    "meme",
    "launchFactory",
    "executor",
    "bound",
  ],
  LoopHookDeploymentFactory: [
    "hookOf",
    "router",
    "baseSellFeePpm",
    "baseFeeRecipient",
    "priceTiming",
    "routingPolicy",
    "routerRegistry",
    "excludeBuybackFromRewards",
    "buyFeePpm",
    // Decision 0144: the cap every Hook of this factory gets (S193).
    "maxDynamicFeeWad",
    "LoopHookDeployed",
    // Decision 0132 (S170): Hook salt preview / registration read-back.
    "launchFactory",
    "poolManager",
    "quote",
    "LP_FEE",
    "TICK_SPACING",
    "maxOnchainSaltAttempts",
    "launchHook",
    "hookInitCodeHash",
    "computeAddress",
  ],
  LoopDynamicLaunchFactory: [
    "TEMPLATE_HASH",
    "hookKind",
    "loopRouter",
    "loopHookDeploymentFactory",
    "routerRegistry",
    "loopHook",
    // Decision 0132 (S170): the deployment executor, the signing
    // preparation and the factory reader target the LoopDynamic Factory
    // through its own ABI (same request / modules structs as
    // LoopLaunchFactory, no feeVault / v4Deployer / priceRecorder).
    "deployLaunch",
    "activateLaunch",
    "launchModules",
    "launchIdByOwnerVersion",
    "nonces",
    "deploymentExecutor",
    "activationBufferSeconds",
    "nftSaleDuration",
    "targetChainId",
    "poolManager",
    "usd1",
    "platformTaxReceiver",
    "primaryKeeper",
    "fallbackKeeper",
    "pauseAuthority",
    "resumeAuthority",
    "tokenDeployer",
    "saleDeployer",
    "buybackDeployer",
    "tokenDeployerCodeHash",
    "saleDeployerCodeHash",
    "buybackDeployerCodeHash",
    "loopDynamicDeployer",
    "loopDynamicDeployerCodeHash",
    "previewLoopHookInitCodeHash",
    "LaunchDeployed",
    "LaunchActivated",
  ],
  LoopRouterRegistry: ["admin", "isTrustedRouter"],
} as const satisfies Record<string, readonly string[]>;

export type HooksLaunchAbiContract = keyof typeof hooksLaunchAbiSelection;

interface AbiItem {
  readonly type: string;
  readonly name?: string;
}

function abiOf(artifact: unknown, contract: string): readonly AbiItem[] {
  const abi =
    typeof artifact === "object" && artifact !== null && "abi" in artifact
      ? (artifact as { readonly abi: unknown }).abi
      : artifact;
  if (!Array.isArray(abi)) {
    throw new Error(`${contract}: artifact has no abi array`);
  }
  return abi as readonly AbiItem[];
}

/** Keeps the selected functions/events (artifact order) plus every error. */
export function selectHooksLaunchAbi(
  artifacts: Readonly<Record<string, unknown>>,
): Record<HooksLaunchAbiContract, readonly AbiItem[]> {
  const result = {} as Record<HooksLaunchAbiContract, readonly AbiItem[]>;
  for (const [contract, names] of Object.entries(hooksLaunchAbiSelection) as [
    HooksLaunchAbiContract,
    readonly string[],
  ][]) {
    const abi = abiOf(artifacts[contract], contract);
    const wanted = new Set(names);
    const picked = abi.filter(
      (item) =>
        item.type === "error" ||
        ((item.type === "function" || item.type === "event") &&
          item.name !== undefined &&
          wanted.has(item.name)),
    );
    for (const name of names) {
      if (!picked.some((item) => item.name === name)) {
        throw new Error(`${contract}: ABI item ${name} is missing`);
      }
    }
    result[contract] = picked;
  }
  return result;
}

export function renderHooksLaunchAbiModule(
  selected: Readonly<Record<string, readonly unknown[]>>,
  sourceCommit: string,
): string {
  const lines = [
    "/**",
    " * GENERATED by `pnpm hooks:abi-sync` from the loop-contracts Foundry build",
    ` * (protocol/out, source commit ${sourceCommit}). Do not edit by hand.`,
    " * Decision 0112: the Hooks deployment executor's view of the protocol.",
    " */",
  ];
  for (const [contract, abi] of Object.entries(selected)) {
    const name = `${contract.charAt(0).toLowerCase()}${contract.slice(1)}Abi`;
    lines.push(`export const ${name} = ${JSON.stringify(abi)} as const;`);
  }
  return `${lines.join("\n")}\n`;
}
