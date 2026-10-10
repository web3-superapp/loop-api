/**
 * Decision 0112: read-back verification of a deployed Hooks launch before
 * the executor may activate it. Pure: the chain client gathers facts, this
 * module compares them with what the project signed and the fixed
 * `hooks_launch_v1` template. Any failed check blocks activation; the
 * failed check names (never values) go to the audit event.
 */

const wad = 10n ** 18n;
const q128 = 1n << 128n;
export const hooksLaunchTemplateConstants = Object.freeze({
  memeTotalSupply: 1_000_000_000n * wad,
  curveSaleSupply: 800_000_000n * wad,
  initialLiquiditySupply: 200_000_000n * wad,
  graduationReserve: 133_333_332_000_000_000_000_000n,
  curveBuyTaxBps: 1_000n,
  curveSellTaxBps: 1_000n,
  perAddressCap: 5_000_000n * wad,
  earlyRoundSeconds: 3_600n,
  officialPoolTaxBps: 200n,
  lpFee: 2_500,
  tickSpacing: 60,
  nftPrice: 100n * wad,
  nftSaleDurationSeconds: 604_800n,
  hookPermissionMask: 0x3fffn,
  hookPermissionBits: 0x20ccn,
});

export interface HooksLaunchExpectedDeployment {
  readonly factoryAddress: string;
  readonly factoryCodeHash: string;
  readonly launchId: string;
  readonly projectOwner: string;
  readonly configVersion: number;
  readonly configHash: string;
  readonly name: string;
  readonly ticker: string;
  readonly nftSaleStart: bigint;
  readonly buybackRecipient: string;
  readonly hookSalt: string;
  readonly predictedMemeAddress: string;
  readonly predictedHookAddress: string;
}

export interface HooksLaunchDeployedEvent {
  readonly launchId: string;
  readonly projectOwner: string;
  readonly configVersion: number;
  readonly configHash: string;
  readonly meme: string;
  readonly nft: string;
  readonly curve: string;
  readonly hook: string;
  readonly hookSalt: string;
}

export interface HooksLaunchModules {
  readonly projectOwner: string;
  readonly configVersion: number;
  readonly configHash: string;
  readonly meme: string;
  readonly nft: string;
  readonly snapshots: string;
  readonly escrow: string;
  readonly gate: string;
  readonly curve: string;
  readonly graduationAdapter: string;
  readonly officialHook: string;
  readonly buybackAdapter: string;
  readonly priceRecorder: string;
  readonly buybackExecutor: string;
  readonly poolKey: {
    readonly currency0: string;
    readonly currency1: string;
    readonly fee: number;
    readonly tickSpacing: number;
    readonly hooks: string;
  };
}

/** Every value the chain client reads back; addresses are lower-case. */
export interface HooksLaunchOnChainFacts {
  readonly factoryCodeHash: string | null;
  readonly factory: {
    readonly poolManager: string;
    readonly usd1: string;
    readonly platformTaxReceiver: string;
    readonly feeVault: string;
    readonly primaryKeeper: string;
    readonly fallbackKeeper: string;
    readonly pauseAuthority: string;
    readonly resumeAuthority: string;
    readonly activationBufferSeconds: bigint;
    readonly deployers: readonly {
      readonly name: "token" | "v4" | "sale" | "buyback";
      readonly address: string;
      readonly pinnedCodeHash: string;
      readonly actualCodeHash: string | null;
    }[];
  };
  /** null when `launchModules(launchId)` reverts (`LaunchNotFound`). */
  readonly modules: HooksLaunchModules | null;
  /** Runtime code hash per module address (null = no code). */
  readonly codeHashes: Readonly<Record<string, string | null>>;
  readonly meme: {
    readonly totalSupply: bigint;
    readonly templateTotalSupply: bigint;
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly launchFactory: string;
    readonly graduationAuthority: string;
    readonly curve: string;
    readonly graduated: boolean;
    readonly curveBalance: bigint;
    readonly adapterBalance: bigint;
  } | null;
  readonly curve: {
    readonly buyTaxBps: bigint;
    readonly sellTaxBps: bigint;
    readonly maxCumulativeBuy: bigint;
    readonly earlyRoundDuration: bigint;
    readonly meme: string;
    readonly usd1: string;
    readonly snapshots: string;
    readonly graduationAdapter: string;
    readonly publicationGate: string;
    readonly platformTaxReceiver: string;
    readonly soldSupply: bigint;
    readonly accountedReserve: bigint;
    readonly graduated: boolean;
  } | null;
  readonly hook: {
    readonly taxBps: bigint;
    readonly poolManager: string;
    readonly feeVault: string;
    readonly poolInitializer: string;
    readonly expectedInitialSqrtPriceX96: bigint;
    readonly currency0: string;
    readonly currency1: string;
    readonly lpFee: number;
    readonly tickSpacing: number;
  } | null;
  readonly gate: {
    readonly launchId: string;
    readonly configHash: string;
    readonly nftSaleStart: bigint;
    readonly activationBufferSeconds: bigint;
    readonly deployExecutor: string;
    readonly published: boolean;
  } | null;
  readonly nft: {
    readonly price: bigint;
    readonly saleDuration: bigint;
    readonly launchId: string;
    readonly usd1: string;
    readonly publicationGate: string;
    readonly escrow: string;
    readonly saleStart: bigint;
    readonly saleEnd: bigint;
    readonly totalMinted: bigint;
  } | null;
  readonly escrow: {
    readonly usd1: string;
    readonly launchFactory: string;
    readonly projectNft: string;
    readonly buybackExecutor: string;
  } | null;
  readonly buyback: {
    readonly usd1: string;
    readonly meme: string;
    readonly budget: string;
    readonly swapAdapter: string;
    readonly recipient: string;
    readonly primaryKeeper: string;
    readonly fallbackKeeper: string;
    readonly pauseAuthority: string;
    readonly resumeAuthority: string;
  } | null;
  readonly adapter: {
    readonly lpMemeAllocation: bigint;
    readonly lpFee: number;
    readonly tickSpacing: number;
    readonly launchFactory: string;
    readonly poolManager: string;
    readonly usd1: string;
    readonly currency0: string;
    readonly currency1: string;
    readonly meme: string;
    readonly curve: string;
    readonly projectBound: boolean;
    readonly finalized: boolean;
  } | null;
  readonly snapshots: {
    readonly launchId: string;
    readonly nft: string;
    readonly nftSaleEnd: bigint;
  } | null;
}

/** The ordered check list; the names are the audit vocabulary. */
export const hooksLaunchVerificationChecks = Object.freeze([
  "factory_code_hash",
  "deployer_code_hashes",
  "launch_event",
  "launch_registered",
  "modules_identity",
  "meme_address_predicted",
  "meme_suffix_6666",
  "hook_address_predicted",
  "hook_permission_bits",
  "module_code_present",
  "meme_supply",
  "meme_metadata",
  "meme_bindings",
  "meme_allocation",
  "curve_taxes",
  "curve_caps",
  "curve_bindings",
  "curve_untouched",
  "graduation_reserve",
  "hook_params",
  "pool_key",
  "gate_params",
  "gate_unpublished",
  "nft_params",
  "escrow_bindings",
  "buyback_params",
  "adapter_params",
  "snapshot_params",
] as const);
export type HooksLaunchVerificationCheck =
  (typeof hooksLaunchVerificationChecks)[number];

export interface HooksLaunchVerificationResult {
  readonly passed: boolean;
  readonly failedChecks: readonly HooksLaunchVerificationCheck[];
  readonly passedChecks: readonly HooksLaunchVerificationCheck[];
}

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

function sqrtFloor(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * The graduation pool's initial sqrt price, replicated from
 * `OfficialV4GraduationAdapter.graduationSqrtPriceX96` with the template's
 * graduation reserve; a Hook whose immutable price differs was not built
 * from the `133,333.332 USD1 / 8e8 MEME` curve.
 */
export function expectedGraduationSqrtPriceX96(input: {
  readonly memeIsCurrency0: boolean;
  readonly graduationReserve?: bigint;
  readonly saleSupply?: bigint;
}): bigint {
  const reserve =
    input.graduationReserve ?? hooksLaunchTemplateConstants.graduationReserve;
  const sale = input.saleSupply ?? hooksLaunchTemplateConstants.curveSaleSupply;
  const virtualUsd1 = reserve / 3n;
  const virtualMeme = (sale * 4n) / 3n;
  const remaining = virtualMeme - sale;
  let priceWad = mulDiv(virtualUsd1 * virtualMeme, wad, remaining * remaining);
  if (!input.memeIsCurrency0) priceWad = mulDiv(wad, wad, priceWad);
  const scaled = mulDiv(priceWad, q128, wad);
  return sqrtFloor(scaled) << 32n;
}

const lower = (value: string): string => value.toLowerCase();
const same = (a: string, b: string): boolean => lower(a) === lower(b);

export function verifyHooksLaunchDeployment(input: {
  readonly expected: HooksLaunchExpectedDeployment;
  readonly event: HooksLaunchDeployedEvent | null;
  readonly facts: HooksLaunchOnChainFacts;
}): HooksLaunchVerificationResult {
  const { expected, event, facts } = input;
  const c = hooksLaunchTemplateConstants;
  const modules = facts.modules;
  const results = new Map<HooksLaunchVerificationCheck, boolean>();
  const check = (
    name: HooksLaunchVerificationCheck,
    predicate: () => boolean,
  ): void => {
    let ok: boolean;
    try {
      ok = predicate();
    } catch {
      ok = false;
    }
    results.set(name, ok);
  };
  const factory = facts.factory;

  check(
    "factory_code_hash",
    () =>
      facts.factoryCodeHash !== null &&
      same(facts.factoryCodeHash, expected.factoryCodeHash),
  );
  check(
    "deployer_code_hashes",
    () =>
      factory.deployers.length === 4 &&
      factory.deployers.every(
        (deployer) =>
          deployer.actualCodeHash !== null &&
          same(deployer.actualCodeHash, deployer.pinnedCodeHash),
      ),
  );
  check(
    "launch_event",
    () =>
      event !== null &&
      same(event.launchId, expected.launchId) &&
      same(event.projectOwner, expected.projectOwner) &&
      event.configVersion === expected.configVersion &&
      same(event.configHash, expected.configHash) &&
      same(event.meme, expected.predictedMemeAddress) &&
      same(event.hook, expected.predictedHookAddress) &&
      same(event.hookSalt, expected.hookSalt) &&
      modules !== null &&
      same(event.nft, modules.nft) &&
      same(event.curve, modules.curve),
  );
  check("launch_registered", () => modules !== null);
  check(
    "modules_identity",
    () =>
      modules !== null &&
      same(modules.projectOwner, expected.projectOwner) &&
      modules.configVersion === expected.configVersion &&
      same(modules.configHash, expected.configHash),
  );
  check(
    "meme_address_predicted",
    () => modules !== null && same(modules.meme, expected.predictedMemeAddress),
  );
  check(
    "meme_suffix_6666",
    () => modules !== null && lower(modules.meme).endsWith("6666"),
  );
  check(
    "hook_address_predicted",
    () =>
      modules !== null &&
      same(modules.officialHook, expected.predictedHookAddress),
  );
  check(
    "hook_permission_bits",
    () =>
      modules !== null &&
      (BigInt(modules.officialHook) & c.hookPermissionMask) ===
        c.hookPermissionBits,
  );
  const moduleAddresses =
    modules === null
      ? []
      : [
          modules.meme,
          modules.nft,
          modules.snapshots,
          modules.escrow,
          modules.gate,
          modules.curve,
          modules.graduationAdapter,
          modules.officialHook,
          modules.buybackAdapter,
          modules.priceRecorder,
          modules.buybackExecutor,
        ];
  check(
    "module_code_present",
    () =>
      moduleAddresses.length === 11 &&
      new Set(moduleAddresses.map(lower)).size === 11 &&
      moduleAddresses.every((address) => {
        const hash = facts.codeHashes[lower(address)];
        return typeof hash === "string" && hash.length === 66;
      }),
  );
  const meme = facts.meme;
  check(
    "meme_supply",
    () =>
      meme !== null &&
      meme.totalSupply === c.memeTotalSupply &&
      meme.templateTotalSupply === c.memeTotalSupply,
  );
  check(
    "meme_metadata",
    () =>
      meme !== null &&
      meme.name === expected.name &&
      meme.symbol === expected.ticker &&
      meme.decimals === 18,
  );
  check(
    "meme_bindings",
    () =>
      meme !== null &&
      modules !== null &&
      same(meme.launchFactory, expected.factoryAddress) &&
      same(meme.curve, modules.curve) &&
      same(meme.graduationAuthority, modules.graduationAdapter) &&
      !meme.graduated,
  );
  check(
    "meme_allocation",
    () =>
      meme !== null &&
      meme.curveBalance === c.curveSaleSupply &&
      meme.adapterBalance === c.initialLiquiditySupply,
  );
  const curve = facts.curve;
  check(
    "curve_taxes",
    () =>
      curve !== null &&
      curve.buyTaxBps === c.curveBuyTaxBps &&
      curve.sellTaxBps === c.curveSellTaxBps,
  );
  check(
    "curve_caps",
    () =>
      curve !== null &&
      curve.maxCumulativeBuy === c.perAddressCap &&
      curve.earlyRoundDuration === c.earlyRoundSeconds,
  );
  check(
    "curve_bindings",
    () =>
      curve !== null &&
      modules !== null &&
      same(curve.meme, modules.meme) &&
      same(curve.usd1, factory.usd1) &&
      same(curve.snapshots, modules.snapshots) &&
      same(curve.graduationAdapter, modules.graduationAdapter) &&
      same(curve.publicationGate, modules.gate) &&
      same(curve.platformTaxReceiver, factory.platformTaxReceiver),
  );
  check(
    "curve_untouched",
    () =>
      curve !== null &&
      curve.soldSupply === 0n &&
      curve.accountedReserve === 0n &&
      !curve.graduated,
  );
  const hook = facts.hook;
  const memeIsCurrency0 =
    modules !== null && same(modules.poolKey.currency0, modules.meme);
  check(
    "graduation_reserve",
    () =>
      hook !== null &&
      hook.expectedInitialSqrtPriceX96 ===
        expectedGraduationSqrtPriceX96({ memeIsCurrency0 }),
  );
  check(
    "hook_params",
    () =>
      hook !== null &&
      modules !== null &&
      hook.taxBps === c.officialPoolTaxBps &&
      hook.lpFee === c.lpFee &&
      hook.tickSpacing === c.tickSpacing &&
      same(hook.poolManager, factory.poolManager) &&
      same(hook.feeVault, factory.feeVault) &&
      same(hook.poolInitializer, modules.graduationAdapter) &&
      same(hook.currency0, modules.poolKey.currency0) &&
      same(hook.currency1, modules.poolKey.currency1),
  );
  check("pool_key", () => {
    if (modules === null) return false;
    const key = modules.poolKey;
    const usd1 = lower(factory.usd1);
    const memeAddress = lower(modules.meme);
    const [low, high] =
      BigInt(usd1) < BigInt(memeAddress)
        ? [usd1, memeAddress]
        : [memeAddress, usd1];
    return (
      same(key.currency0, low) &&
      same(key.currency1, high) &&
      key.fee === c.lpFee &&
      key.tickSpacing === c.tickSpacing &&
      same(key.hooks, modules.officialHook)
    );
  });
  const gate = facts.gate;
  check(
    "gate_params",
    () =>
      gate !== null &&
      same(gate.launchId, expected.launchId) &&
      same(gate.configHash, expected.configHash) &&
      gate.nftSaleStart === expected.nftSaleStart &&
      gate.activationBufferSeconds === factory.activationBufferSeconds &&
      same(gate.deployExecutor, expected.factoryAddress),
  );
  check("gate_unpublished", () => gate !== null && !gate.published);
  const nft = facts.nft;
  check(
    "nft_params",
    () =>
      nft !== null &&
      modules !== null &&
      nft.price === c.nftPrice &&
      nft.saleDuration === c.nftSaleDurationSeconds &&
      same(nft.launchId, expected.launchId) &&
      same(nft.usd1, factory.usd1) &&
      same(nft.publicationGate, modules.gate) &&
      same(nft.escrow, modules.escrow) &&
      nft.saleStart === expected.nftSaleStart &&
      nft.saleEnd === expected.nftSaleStart + c.nftSaleDurationSeconds &&
      nft.totalMinted === 0n,
  );
  const escrow = facts.escrow;
  check(
    "escrow_bindings",
    () =>
      escrow !== null &&
      modules !== null &&
      same(escrow.usd1, factory.usd1) &&
      same(escrow.launchFactory, expected.factoryAddress) &&
      same(escrow.projectNft, modules.nft) &&
      same(escrow.buybackExecutor, modules.buybackExecutor),
  );
  const buyback = facts.buyback;
  check(
    "buyback_params",
    () =>
      buyback !== null &&
      modules !== null &&
      same(buyback.recipient, expected.buybackRecipient) &&
      same(buyback.usd1, factory.usd1) &&
      same(buyback.meme, modules.meme) &&
      same(buyback.budget, modules.escrow) &&
      same(buyback.swapAdapter, modules.buybackAdapter) &&
      same(buyback.primaryKeeper, factory.primaryKeeper) &&
      same(buyback.fallbackKeeper, factory.fallbackKeeper) &&
      same(buyback.pauseAuthority, factory.pauseAuthority) &&
      same(buyback.resumeAuthority, factory.resumeAuthority),
  );
  const adapter = facts.adapter;
  check(
    "adapter_params",
    () =>
      adapter !== null &&
      modules !== null &&
      adapter.lpMemeAllocation === c.initialLiquiditySupply &&
      adapter.lpFee === c.lpFee &&
      adapter.tickSpacing === c.tickSpacing &&
      same(adapter.launchFactory, expected.factoryAddress) &&
      same(adapter.poolManager, factory.poolManager) &&
      same(adapter.usd1, factory.usd1) &&
      same(adapter.currency0, modules.poolKey.currency0) &&
      same(adapter.currency1, modules.poolKey.currency1) &&
      same(adapter.meme, modules.meme) &&
      same(adapter.curve, modules.curve) &&
      adapter.projectBound &&
      !adapter.finalized,
  );
  const snapshots = facts.snapshots;
  check(
    "snapshot_params",
    () =>
      snapshots !== null &&
      modules !== null &&
      same(snapshots.launchId, expected.launchId) &&
      same(snapshots.nft, modules.nft) &&
      snapshots.nftSaleEnd === expected.nftSaleStart + c.nftSaleDurationSeconds,
  );

  const failedChecks = hooksLaunchVerificationChecks.filter(
    (name) => results.get(name) !== true,
  );
  return Object.freeze({
    passed: failedChecks.length === 0,
    failedChecks: Object.freeze(failedChecks),
    passedChecks: Object.freeze(
      hooksLaunchVerificationChecks.filter((name) => results.get(name)),
    ),
  });
}
