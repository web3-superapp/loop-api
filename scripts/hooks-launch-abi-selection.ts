/**
 * Decision 0112: which ABI items of the loop-contracts Foundry build the
 * Hooks deployment executor consumes; Decision 0114 adds the events and
 * views the `launch2_event` lane and the `/v2/launch2/*` reads/prepares use. Errors of every listed contract are
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
  ],
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
