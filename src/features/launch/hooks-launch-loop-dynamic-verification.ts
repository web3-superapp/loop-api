import {
  hooksLaunchLoopDynamicTemplateHash,
  type HooksLaunchLoopDynamicParams,
} from "./hooks-launch-config.js";
import {
  expectedGraduationSqrtPriceX96,
  hooksLaunchTemplateConstants,
  type HooksLaunchDeployedEvent,
  type HooksLaunchExpectedDeployment,
  type HooksLaunchModules,
  type HooksLaunchOnChainFacts,
} from "./hooks-launch-verification.js";

/**
 * Decision 0132: read-back verification of a launch deployed by a
 * `LoopDynamicLaunchFactory` (loop-contracts S164 + S165, Decision 0009)
 * before the executor activates it. Same discipline as Decision 0112 —
 * pure, every failed check blocks activation, only check names reach the
 * audit trail — with the LoopDynamic module set:
 *
 * - no Hook at deployment: `LaunchDeployed.hook` and `modules.officialHook`
 *   are the zero address, the pool key's `hooks` is zero, and there is no
 *   price recorder (also zero);
 * - the Hook is CREATE2-deployed at graduation by the Factory's
 *   `LoopHookDeploymentFactory`; the project-signed `hookSalt` is
 *   registered there (`launchHook(launchId).saltRegistered`), and
 *   `computeAddress(salt, hookInitCodeHash(launchId))` is the predicted
 *   Hook address the task was bound to, with permission bits 0x10C4;
 * - the Hook parameters the Factory deploys with (fees, timing, routing,
 *   buyback exclusion, router) are the template the project signed
 *   (`TEMPLATE_HASH` = `hooksLaunchLoopDynamicTemplateHash(params)`);
 * - the graduation adapter is a `LoopDynamicGraduationAdapter` bound to the
 *   Hook factory and the launch id; the buyback adapter swaps through the
 *   shared LoopRouter.
 *
 * Template economics (supply split, curve taxes, NFT price, …) are checked
 * exactly as for OfficialTax.
 */

export const hooksLaunchLoopDynamicHookPermissionBits = 0x10c4n;
const zeroAddress = "0x0000000000000000000000000000000000000000";

export interface HooksLaunchLoopDynamicExpectation {
  /** The Factory's verified Hook parameters (executor preflight). */
  readonly params: HooksLaunchLoopDynamicParams;
  /** Lower-case `TEMPLATE_HASH` the project signed. */
  readonly templateHash: string;
}

/** Every value the chain client reads back for a LoopDynamic launch. */
export interface HooksLaunchLoopDynamicOnChainFacts {
  readonly hookKind: "loopDynamic";
  readonly factoryCodeHash: string | null;
  readonly factory: {
    readonly hookKind: number;
    readonly templateHash: string;
    readonly poolManager: string;
    readonly usd1: string;
    readonly platformTaxReceiver: string;
    readonly primaryKeeper: string;
    readonly fallbackKeeper: string;
    readonly pauseAuthority: string;
    readonly resumeAuthority: string;
    readonly activationBufferSeconds: bigint;
    readonly nftSaleDuration: bigint;
    /** Always false: every LoopDynamic Factory has `nftSaleDuration()`. */
    readonly nftSaleDurationLegacy: false;
    readonly loopRouter: string;
    readonly loopHookDeploymentFactory: string;
    readonly routerRegistry: string;
    readonly deployers: readonly {
      readonly name: "token" | "sale" | "buyback" | "loopDynamic";
      readonly address: string;
      readonly pinnedCodeHash: string;
      readonly actualCodeHash: string | null;
    }[];
  };
  readonly modules: HooksLaunchModules | null;
  readonly codeHashes: Readonly<Record<string, string | null>>;
  readonly meme: HooksLaunchOnChainFacts["meme"];
  readonly curve: HooksLaunchOnChainFacts["curve"];
  readonly gate: HooksLaunchOnChainFacts["gate"];
  readonly nft: HooksLaunchOnChainFacts["nft"];
  readonly escrow: HooksLaunchOnChainFacts["escrow"];
  readonly buyback: HooksLaunchOnChainFacts["buyback"];
  readonly snapshots: HooksLaunchOnChainFacts["snapshots"];
  readonly adapter:
    | (NonNullable<HooksLaunchOnChainFacts["adapter"]> & {
        readonly hookFactory: string;
        readonly launchId: string;
        readonly hook: string;
        readonly hookPermissions: bigint;
        readonly graduationSqrtPriceX96: bigint;
      })
    | null;
  readonly buybackAdapter: {
    readonly usd1: string;
    readonly meme: string;
    readonly launchFactory: string;
    readonly router: string;
    readonly graduationAdapter: string;
    readonly executor: string;
    readonly bound: boolean;
  } | null;
  readonly hookFactory: {
    readonly launchFactory: string;
    readonly poolManager: string;
    readonly router: string;
    readonly quote: string;
    readonly baseSellFeePpm: number;
    readonly baseFeeRecipient: string;
    readonly priceTiming: number;
    readonly routingPolicy: number;
    readonly routerRegistry: string;
    readonly excludeBuybackFromRewards: boolean;
    readonly buyFeePpm: number;
    /**
     * Decision 0144: `maxDynamicFeeWad()` (raw WAD string); null for an
     * S165 Hook factory without the getter.
     */
    readonly maxDynamicFeeWad: string | null;
    readonly lpFee: number;
    readonly tickSpacing: number;
    readonly launch: {
      readonly meme: string;
      readonly initializer: string;
      readonly buybackBuyer: string;
      readonly salt: string;
      readonly saltRegistered: boolean;
      readonly hook: string;
    };
    /** `hookInitCodeHash(launchId)`. */
    readonly initCodeHash: string;
    /** `computeAddress(launch.salt, initCodeHash)`. */
    readonly predictedHook: string;
  } | null;
}

/** The ordered LoopDynamic check list (audit vocabulary). */
export const hooksLaunchLoopDynamicVerificationChecks = Object.freeze([
  "factory_code_hash",
  "factory_template",
  "deployer_code_hashes",
  "launch_event",
  "launch_registered",
  "modules_identity",
  "meme_address_predicted",
  "meme_suffix_6666",
  "hook_address_predicted",
  "hook_permission_bits",
  "hook_salt_registered",
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
  "hook_factory_params",
  "pool_key",
  "gate_params",
  "gate_unpublished",
  "nft_params",
  "escrow_bindings",
  "buyback_params",
  "adapter_params",
  "buyback_adapter_params",
  "snapshot_params",
] as const);
export type HooksLaunchLoopDynamicVerificationCheck =
  (typeof hooksLaunchLoopDynamicVerificationChecks)[number];

const lower = (value: string): string => value.toLowerCase();
const same = (a: string, b: string): boolean => lower(a) === lower(b);

export function verifyHooksLaunchLoopDynamicDeployment(input: {
  readonly expected: HooksLaunchExpectedDeployment;
  readonly template: HooksLaunchLoopDynamicExpectation;
  readonly event: HooksLaunchDeployedEvent | null;
  readonly facts: HooksLaunchLoopDynamicOnChainFacts;
}): {
  readonly passed: boolean;
  readonly failedChecks: readonly HooksLaunchLoopDynamicVerificationCheck[];
  readonly passedChecks: readonly HooksLaunchLoopDynamicVerificationCheck[];
} {
  const { expected, template, event, facts } = input;
  const c = hooksLaunchTemplateConstants;
  const modules = facts.modules;
  const factory = facts.factory;
  const results = new Map<HooksLaunchLoopDynamicVerificationCheck, boolean>();
  const check = (
    name: HooksLaunchLoopDynamicVerificationCheck,
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
  const params = template.params;

  check(
    "factory_code_hash",
    () =>
      facts.factoryCodeHash !== null &&
      same(facts.factoryCodeHash, expected.factoryCodeHash),
  );
  check(
    "factory_template",
    () =>
      factory.hookKind === 1 &&
      same(factory.templateHash, template.templateHash) &&
      same(hooksLaunchLoopDynamicTemplateHash(params), template.templateHash) &&
      same(factory.loopRouter, params.router),
  );
  check(
    "deployer_code_hashes",
    () =>
      factory.deployers.length === 4 &&
      new Set(factory.deployers.map((deployer) => deployer.name)).size === 4 &&
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
      // The Hook does not exist yet; the event carries the zero address
      // and the registered salt.
      same(event.hook, zeroAddress) &&
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
  const hookFactory = facts.hookFactory;
  check(
    "hook_address_predicted",
    () =>
      modules !== null &&
      hookFactory !== null &&
      same(modules.officialHook, zeroAddress) &&
      same(hookFactory.launch.hook, zeroAddress) &&
      same(hookFactory.predictedHook, expected.predictedHookAddress),
  );
  check(
    "hook_permission_bits",
    () =>
      (BigInt(expected.predictedHookAddress) & c.hookPermissionMask) ===
      hooksLaunchLoopDynamicHookPermissionBits,
  );
  check(
    "hook_salt_registered",
    () =>
      modules !== null &&
      hookFactory !== null &&
      hookFactory.launch.saltRegistered &&
      !/^0x0{64}$/u.test(lower(hookFactory.launch.salt)) &&
      same(hookFactory.launch.salt, expected.hookSalt) &&
      same(hookFactory.launch.meme, modules.meme) &&
      same(hookFactory.launch.initializer, modules.graduationAdapter) &&
      same(hookFactory.launch.buybackBuyer, modules.buybackAdapter),
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
          modules.buybackAdapter,
          modules.buybackExecutor,
        ];
  check(
    "module_code_present",
    () =>
      modules !== null &&
      same(modules.priceRecorder, zeroAddress) &&
      same(modules.officialHook, zeroAddress) &&
      moduleAddresses.length === 9 &&
      new Set(moduleAddresses.map(lower)).size === 9 &&
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
  const adapter = facts.adapter;
  const memeIsCurrency0 =
    modules !== null && same(modules.poolKey.currency0, modules.meme);
  check(
    "graduation_reserve",
    () =>
      adapter !== null &&
      adapter.graduationSqrtPriceX96 ===
        expectedGraduationSqrtPriceX96({ memeIsCurrency0 }),
  );
  check(
    "hook_factory_params",
    () =>
      hookFactory !== null &&
      same(hookFactory.launchFactory, expected.factoryAddress) &&
      same(hookFactory.poolManager, factory.poolManager) &&
      same(hookFactory.quote, factory.usd1) &&
      same(hookFactory.router, factory.loopRouter) &&
      same(hookFactory.router, params.router) &&
      same(hookFactory.routerRegistry, factory.routerRegistry) &&
      hookFactory.baseSellFeePpm === params.baseSellFeePpm &&
      same(hookFactory.baseFeeRecipient, params.baseFeeRecipient) &&
      hookFactory.priceTiming === params.priceTiming &&
      hookFactory.routingPolicy === params.routingPolicy &&
      hookFactory.excludeBuybackFromRewards ===
        params.excludeBuybackFromRewards &&
      hookFactory.buyFeePpm === params.buyFeePpm &&
      hookFactory.maxDynamicFeeWad === (params.maxDynamicFeeWad ?? null) &&
      hookFactory.lpFee === c.lpFee &&
      hookFactory.tickSpacing === c.tickSpacing &&
      same(factory.loopHookDeploymentFactory, adapter?.hookFactory ?? ""),
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
      same(key.hooks, zeroAddress)
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
  const saleDuration = factory.nftSaleDuration;
  const saleDurationValid =
    saleDuration >= c.minNftSaleDurationSeconds &&
    saleDuration <= c.maxNftSaleDurationSeconds;
  const nft = facts.nft;
  check(
    "nft_params",
    () =>
      nft !== null &&
      modules !== null &&
      saleDurationValid &&
      nft.price === c.nftPrice &&
      nft.saleDuration === saleDuration &&
      same(nft.launchId, expected.launchId) &&
      same(nft.usd1, factory.usd1) &&
      same(nft.publicationGate, modules.gate) &&
      same(nft.escrow, modules.escrow) &&
      nft.saleStart === expected.nftSaleStart &&
      nft.saleEnd === expected.nftSaleStart + saleDuration &&
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
  check(
    "adapter_params",
    () =>
      adapter !== null &&
      modules !== null &&
      adapter.lpMemeAllocation === c.initialLiquiditySupply &&
      adapter.lpFee === c.lpFee &&
      adapter.tickSpacing === c.tickSpacing &&
      adapter.hookPermissions === hooksLaunchLoopDynamicHookPermissionBits &&
      same(adapter.launchFactory, expected.factoryAddress) &&
      same(adapter.poolManager, factory.poolManager) &&
      same(adapter.usd1, factory.usd1) &&
      same(adapter.currency0, modules.poolKey.currency0) &&
      same(adapter.currency1, modules.poolKey.currency1) &&
      same(adapter.meme, modules.meme) &&
      same(adapter.curve, modules.curve) &&
      same(adapter.hookFactory, factory.loopHookDeploymentFactory) &&
      same(adapter.launchId, expected.launchId) &&
      same(adapter.hook, zeroAddress) &&
      adapter.projectBound &&
      !adapter.finalized,
  );
  const buybackAdapter = facts.buybackAdapter;
  check(
    "buyback_adapter_params",
    () =>
      buybackAdapter !== null &&
      modules !== null &&
      same(buybackAdapter.usd1, factory.usd1) &&
      same(buybackAdapter.meme, modules.meme) &&
      same(buybackAdapter.launchFactory, expected.factoryAddress) &&
      same(buybackAdapter.router, factory.loopRouter) &&
      same(buybackAdapter.graduationAdapter, modules.graduationAdapter) &&
      same(buybackAdapter.executor, modules.buybackExecutor) &&
      buybackAdapter.bound,
  );
  const snapshots = facts.snapshots;
  check(
    "snapshot_params",
    () =>
      snapshots !== null &&
      modules !== null &&
      same(snapshots.launchId, expected.launchId) &&
      same(snapshots.nft, modules.nft) &&
      saleDurationValid &&
      snapshots.nftSaleEnd === expected.nftSaleStart + saleDuration,
  );

  const failedChecks = hooksLaunchLoopDynamicVerificationChecks.filter(
    (name) => results.get(name) !== true,
  );
  return Object.freeze({
    passed: failedChecks.length === 0,
    failedChecks: Object.freeze(failedChecks),
    passedChecks: Object.freeze(
      hooksLaunchLoopDynamicVerificationChecks.filter((name) =>
        results.get(name),
      ),
    ),
  });
}
