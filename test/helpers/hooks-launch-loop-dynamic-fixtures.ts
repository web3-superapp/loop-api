/**
 * TEST ONLY (Decision 0132): a LoopDynamic launch for the executor and
 * verification suites — the BSC Testnet experimental Factory's Hook
 * parameters (loop-contracts `deployments/bsc-testnet/
 * factory-20261013T134534Z.json`), a project signature over its
 * `TEMPLATE_HASH`, and read-back facts that pass every LoopDynamic check.
 */
import {
  hooksLaunchLoopDynamicTemplateHash,
  type HooksLaunchLoopDynamicParams,
} from "../../src/features/launch/hooks-launch-config.js";
import { createHooksLaunchDeploymentTypedData } from "../../src/features/launch/hooks-launch-deployment-crypto.js";
import type { HooksLaunchLoopDynamicOnChainFacts } from "../../src/features/launch/hooks-launch-loop-dynamic-verification.js";
import { hooksLaunchBindingHash } from "../../src/features/launch/hooks-launch-submission.js";
import {
  buybackRecipient,
  configHash,
  factoryAddress,
  factoryCodeHash,
  hookSalt,
  launchDeployedEvent,
  memeAddress,
  modules,
  nftSaleStart,
  ownerAccount,
  passingFacts,
  projectOwner,
} from "./hooks-launch-executor-fixtures.js";

const zero = "0x0000000000000000000000000000000000000000";

/** Testnet manifest `loopDynamic.params` (2026-10-13). */
export const testnetLoopDynamicParams: HooksLaunchLoopDynamicParams =
  Object.freeze({
    router: "0x7d1577a63007620db1cbee3eab3572b9d148aefe",
    baseSellFeePpm: 20_000,
    baseFeeRecipient: "0x0e2e2b52d5465f3e4576e71ee4dd1dff22557040",
    priceTiming: 1,
    routingPolicy: 1,
    routerRegistryAdmin: "0x3e64c464e739e108d88c9b805157eeb2a8a11767",
    excludeBuybackFromRewards: true,
    buyFeePpm: 20_000,
  });
/**
 * Manifest `loopDynamic.templateHash` of the S165 Factory — a chain fact
 * (pre-S193, no `maxDynamicFeeWad`), kept as the regression vector of the
 * ten-field formula.
 */
export const testnetLoopDynamicTemplateHash =
  "0x0e61af8199739dd4a9c5902178b87159d00c208639b8f4d504b24d263a3f8819";

/**
 * Decision 0144: the S193 Factory's parameters — loop-contracts
 * `deployments/bsc-testnet/factory-20261015T112941Z.json` `loopDynamic.params`
 * (main 47d7620, Decision 0013; new LoopRouter `0x21eE…943a`, cap 0.2e18).
 * Its template hash is computed from these (`hooksLaunchLoopDynamicTemplateHash`);
 * `s193TestnetManifestTemplateHash` is the manifest's recorded value, a chain
 * fact the computation must reproduce.
 */
export const s193LoopDynamicParams: HooksLaunchLoopDynamicParams =
  Object.freeze({
    router: "0x21eec27f759b6efb1e6c9a26a555ed40f08f943a",
    baseSellFeePpm: 20_000,
    baseFeeRecipient: "0x0e2e2b52d5465f3e4576e71ee4dd1dff22557040",
    priceTiming: 1,
    routingPolicy: 1,
    routerRegistryAdmin: "0x3e64c464e739e108d88c9b805157eeb2a8a11767",
    excludeBuybackFromRewards: true,
    buyFeePpm: 20_000,
    maxDynamicFeeWad: "200000000000000000",
  });
/** Manifest `loopDynamic.templateHash` (factory-20261015T112941Z.json). */
export const s193TestnetManifestTemplateHash =
  "0xe96acde581d40a074b1730374cd3aef400d27db8bad9d98ba82cf98fab876d67";

/**
 * Decision 0152 (loop-contracts Decision 0015 §5): the S200 testnet
 * manifest's parameters (`factory-20261015T185535Z.json`: router
 * `0x135C…A110`, cap 0.2e18) with the S209 default purchase cap — the
 * contracts' published vector. `s200TestnetManifestTemplateHash` is that
 * manifest's recorded (pre-S209, eleven-field) hash.
 */
export const s200LoopDynamicParams: HooksLaunchLoopDynamicParams =
  Object.freeze({
    router: "0x135c772b52ec87c669f3aa1fdf18a728ec7ea110",
    baseSellFeePpm: 20_000,
    baseFeeRecipient: "0x0e2e2b52d5465f3e4576e71ee4dd1dff22557040",
    priceTiming: 1,
    routingPolicy: 1,
    routerRegistryAdmin: "0x3e64c464e739e108d88c9b805157eeb2a8a11767",
    excludeBuybackFromRewards: true,
    buyFeePpm: 20_000,
    maxDynamicFeeWad: "200000000000000000",
  });
export const s200TestnetManifestTemplateHash =
  "0x7a0e33b7bb610d4c0007cb2c2a91e1802558bbe779898a60123e78a5ffd15aed";
export const s209LoopDynamicParams: HooksLaunchLoopDynamicParams =
  Object.freeze({
    ...s200LoopDynamicParams,
    maxCumulativeBuy: "5000000000000000000000000",
  });
/** loop-contracts Decision 0015 §5: the S209 default-cap vector. */
export const s209ContractsVectorTemplateHash =
  "0x327aac844dd76e91622e1ac509d419fe3e4abbfa844f2f1e65772a1a15a40791";

export const loopDynamicTemplate = Object.freeze({
  params: testnetLoopDynamicParams,
  templateHash: hooksLaunchLoopDynamicTemplateHash(
    testnetLoopDynamicParams,
  ).toLowerCase(),
});

/** A predicted LoopDynamic Hook address (low 14 bits 0x10C4). */
export const loopDynamicHookAddress = `0x${"ce".repeat(18)}10c4`;
export const hookDeploymentFactory =
  "0x1536992cfd3f8996f9d573cece3e08dead284d3b";
export const routerRegistry = "0xbed2c2e1f9341c1a821182d8f96df98d52dfabe5";

export async function loopDynamicSignedPayload(deadline: number) {
  const request = {
    configHash,
    projectOwner,
    configVersion: 1,
    name: "Project",
    ticker: "MEME",
    nftSaleStart: nftSaleStart.toString(),
    buybackRecipient,
    deadline: String(deadline),
    memeSalt: `0x${"00".repeat(31)}09`,
    nonce: "0",
  };
  const typed = createHooksLaunchDeploymentTypedData({
    chainId: 97,
    verifyingContract: factoryAddress,
    request,
    templateHash: loopDynamicTemplate.templateHash,
  });
  const message = {
    ...typed.message,
    nftSaleStart: BigInt(request.nftSaleStart),
    deadline: BigInt(request.deadline),
    nonce: 0n,
  };
  const signature = await ownerAccount.signTypedData({ ...typed, message });
  return { walletId: "wallet-1", request, hookSalt, signature };
}

export function loopDynamicBindingHash(
  payload: Awaited<ReturnType<typeof loopDynamicSignedPayload>>,
): string {
  return hooksLaunchBindingHash({
    factoryAddress,
    request: payload.request,
    hookSalt: payload.hookSalt,
    memeAddress,
    hookAddress: loopDynamicHookAddress,
  });
}

export function loopDynamicLaunchDeployedEvent() {
  return { ...launchDeployedEvent(), hook: zero };
}

/** LoopDynamic facts passing every check (built from the OfficialTax ones). */
export function passingLoopDynamicFacts(): HooksLaunchLoopDynamicOnChainFacts {
  const base = passingFacts({ saleDuration: 3_600n });
  if (base.modules === null || base.adapter === null) {
    throw new Error("fixture");
  }
  const codeHashes: Record<string, string> = {};
  for (const [address, hash] of Object.entries(base.codeHashes)) {
    if (hash !== null && address !== base.modules.officialHook) {
      codeHashes[address] = hash;
    }
  }
  delete codeHashes[modules.priceRecorder];
  const roles = base.factory;
  return {
    hookKind: "loopDynamic",
    factoryCodeHash,
    factory: {
      hookKind: 1,
      templateHash: loopDynamicTemplate.templateHash,
      poolManager: roles.poolManager,
      usd1: roles.usd1,
      platformTaxReceiver: roles.platformTaxReceiver,
      primaryKeeper: roles.primaryKeeper,
      fallbackKeeper: roles.fallbackKeeper,
      pauseAuthority: roles.pauseAuthority,
      resumeAuthority: roles.resumeAuthority,
      activationBufferSeconds: roles.activationBufferSeconds,
      nftSaleDuration: 3_600n,
      nftSaleDurationLegacy: false,
      loopRouter: testnetLoopDynamicParams.router,
      loopHookDeploymentFactory: hookDeploymentFactory,
      routerRegistry,
      // Decision 0152: a pre-S209 Factory (no maxCumulativeBuy getter).
      maxCumulativeBuy: null,
      deployers: (["token", "sale", "buyback", "loopDynamic"] as const).map(
        (name, index) => ({
          name,
          address: `0x${(0x400 + index).toString(16).padStart(40, "0")}`,
          pinnedCodeHash: `0x${"e".repeat(63)}${index}`,
          actualCodeHash: `0x${"e".repeat(63)}${index}`,
        }),
      ),
    },
    modules: {
      ...base.modules,
      officialHook: zero,
      priceRecorder: zero,
      poolKey: { ...base.modules.poolKey, hooks: zero },
    },
    codeHashes,
    meme: base.meme,
    curve: base.curve,
    gate: base.gate,
    nft: base.nft,
    escrow: base.escrow,
    buyback: base.buyback,
    snapshots: base.snapshots,
    adapter: {
      ...base.adapter,
      hookFactory: hookDeploymentFactory,
      launchId: base.gate?.launchId ?? "",
      hook: zero,
      hookPermissions: 0x10c4n,
      graduationSqrtPriceX96: base.hook?.expectedInitialSqrtPriceX96 ?? 0n,
    },
    buybackAdapter: {
      usd1: roles.usd1,
      meme: memeAddress,
      launchFactory: factoryAddress,
      router: testnetLoopDynamicParams.router,
      graduationAdapter: modules.graduationAdapter,
      executor: modules.buybackExecutor,
      bound: true,
    },
    hookFactory: {
      launchFactory: factoryAddress,
      poolManager: roles.poolManager,
      router: testnetLoopDynamicParams.router,
      quote: roles.usd1,
      baseSellFeePpm: 20_000,
      baseFeeRecipient: testnetLoopDynamicParams.baseFeeRecipient,
      priceTiming: 1,
      routingPolicy: 1,
      routerRegistry,
      excludeBuybackFromRewards: true,
      buyFeePpm: 20_000,
      maxDynamicFeeWad: testnetLoopDynamicParams.maxDynamicFeeWad ?? null,
      lpFee: 2_500,
      tickSpacing: 60,
      requiredPermissionMask: 0x10c4n,
      launch: {
        meme: memeAddress,
        initializer: modules.graduationAdapter,
        buybackBuyer: modules.buybackAdapter,
        salt: hookSalt,
        saltRegistered: true,
        hook: zero,
      },
      initCodeHash: `0x${"9a".repeat(32)}`,
      predictedHook: loopDynamicHookAddress,
    },
  };
}
