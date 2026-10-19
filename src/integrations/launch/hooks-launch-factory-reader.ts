import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  encodeAbiParameters,
  ExecutionRevertedError,
  fallback,
  http,
  keccak256,
  type Abi,
  type Address,
  type Transport,
} from "viem";

import {
  hooksLaunchLegacyNftSaleDurationSeconds,
  hooksLaunchLoopDynamicHookPermissionBits,
  hooksLaunchLoopDynamicTemplateHash,
  isHooksLaunchMaxCumulativeBuy,
  isHooksLaunchMaxDynamicFeeWad,
  isHooksLaunchNftSaleDuration,
  type HooksLaunchLoopDynamicParams,
} from "../../features/launch/hooks-launch-config.js";
import type { HooksLaunchFactoryReader } from "../../features/launch/hooks-launch-deployment.js";
import { viemLaunchChain } from "../bsc/viem-launch-chain.js";
import { HooksLaunchFactoryTemplateMismatchError } from "../../features/launch/hooks-launch-executor.js";
import {
  loopDynamicLaunchFactoryAbi,
  loopLaunchFactoryAbi,
  loopHookDeploymentFactoryAbi,
  loopRouterRegistryAbi,
} from "./hooks-launch-protocol-abi.generated.js";

const zeroAddress = "0x0000000000000000000000000000000000000000";

/**
 * Decision 0132: the Hook parameters a LoopDynamic Factory commits in its
 * `TEMPLATE_HASH`, read from the chain (all immutable): the router from
 * `loopRouter()`, the fee / timing / routing / buyback settings from its
 * `loopHookDeploymentFactory()`, the registry admin from `routerRegistry()`
 * (zero for `LoopRouterOnly`). The recomputed template hash must equal
 * `TEMPLATE_HASH()` and `hookKind()` must be `LoopDynamic` (1), else the
 * Factory is not the template this backend hashes and every save /
 * signature fails closed.
 */
export async function readHooksLaunchLoopDynamicTemplate(
  read: (address: Address, abi: Abi, functionName: string) => Promise<unknown>,
  factoryAddress: Address,
): Promise<{
  readonly params: HooksLaunchLoopDynamicParams;
  readonly templateHash: `0x${string}`;
  readonly hookDeploymentFactory: string;
  readonly routerRegistry: string;
}> {
  const F = loopDynamicLaunchFactoryAbi as Abi;
  const H = loopHookDeploymentFactoryAbi as Abi;
  const [kind, templateHash, router, hookFactory, registry, maxCumulativeBuy] =
    await Promise.all([
      read(factoryAddress, F, "hookKind"),
      read(factoryAddress, F, "TEMPLATE_HASH"),
      read(factoryAddress, F, "loopRouter"),
      read(factoryAddress, F, "loopHookDeploymentFactory"),
      read(factoryAddress, F, "routerRegistry"),
      // Decision 0152: S209 Factories answer the curve cap; an older one
      // has no such function (a revert = absent). RPC failures propagate.
      read(factoryAddress, F, "maxCumulativeBuy").catch((error: unknown) => {
        if (isHooksLaunchContractRevert(error)) return null;
        throw error;
      }),
    ]);
  const hdf = String(hookFactory) as Address;
  const [
    hookRouter,
    baseSellFeePpm,
    baseFeeRecipient,
    priceTiming,
    routingPolicy,
    hookRegistry,
    excludeBuybackFromRewards,
    buyFeePpm,
    launchFactory,
    maxDynamicFeeWad,
    requiredPermissionMask,
  ] = await Promise.all([
    read(hdf, H, "router"),
    read(hdf, H, "baseSellFeePpm"),
    read(hdf, H, "baseFeeRecipient"),
    read(hdf, H, "priceTiming"),
    read(hdf, H, "routingPolicy"),
    read(hdf, H, "routerRegistry"),
    read(hdf, H, "excludeBuybackFromRewards"),
    read(hdf, H, "buyFeePpm"),
    read(hdf, H, "launchFactory"),
    // Decision 0144: S193 Hook factories answer the cap; an S165 one has no
    // such function (a revert = absent). RPC failures propagate.
    read(hdf, H, "maxDynamicFeeWad").catch((error: unknown) => {
      if (isHooksLaunchContractRevert(error)) return null;
      throw error;
    }),
    // Decision 0152: 0x10C4 (pre-S209) or 0x10CC (S209) — must agree with
    // the generation the Factory's getters show.
    read(hdf, H, "REQUIRED_PERMISSION_MASK"),
  ]);
  const registryAddress = String(registry).toLowerCase();
  const admin =
    registryAddress === zeroAddress
      ? zeroAddress
      : String(
          await read(
            registryAddress as Address,
            loopRouterRegistryAbi,
            "admin",
          ),
        ).toLowerCase();
  const timing = Number(priceTiming);
  const policy = Number(routingPolicy);
  if (
    Number(kind) !== 1 ||
    String(hookRouter).toLowerCase() !== String(router).toLowerCase() ||
    String(hookRegistry).toLowerCase() !== registryAddress ||
    String(launchFactory).toLowerCase() !== factoryAddress.toLowerCase() ||
    (timing !== 0 && timing !== 1) ||
    (policy !== 0 && policy !== 1) ||
    typeof excludeBuybackFromRewards !== "boolean" ||
    (maxDynamicFeeWad !== null &&
      (typeof maxDynamicFeeWad !== "bigint" ||
        !isHooksLaunchMaxDynamicFeeWad(maxDynamicFeeWad.toString(10)))) ||
    (maxCumulativeBuy !== null &&
      (typeof maxCumulativeBuy !== "bigint" ||
        maxDynamicFeeWad === null ||
        !isHooksLaunchMaxCumulativeBuy(maxCumulativeBuy.toString(10)))) ||
    typeof requiredPermissionMask !== "bigint" ||
    requiredPermissionMask !==
      hooksLaunchLoopDynamicHookPermissionBits(
        maxCumulativeBuy === null ? {} : { maxCumulativeBuy: "1" },
      )
  ) {
    throw new HooksLaunchFactoryTemplateMismatchError();
  }
  const params: HooksLaunchLoopDynamicParams = Object.freeze({
    router: String(router).toLowerCase(),
    baseSellFeePpm: Number(baseSellFeePpm),
    baseFeeRecipient: String(baseFeeRecipient).toLowerCase(),
    priceTiming: timing,
    routingPolicy: policy,
    routerRegistryAdmin: admin,
    excludeBuybackFromRewards,
    buyFeePpm: Number(buyFeePpm),
    ...(maxDynamicFeeWad === null
      ? {}
      : { maxDynamicFeeWad: maxDynamicFeeWad.toString(10) }),
    ...(maxCumulativeBuy === null
      ? {}
      : { maxCumulativeBuy: maxCumulativeBuy.toString(10) }),
  });
  // An S193 Factory's TEMPLATE_HASH has the trailing cap word, an S165 one
  // does not, an S209 one also the purchase cap word (Decision 0152); the
  // recomputed hash must equal the chain's either way.
  const expected = hooksLaunchLoopDynamicTemplateHash(params);
  if (expected.toLowerCase() !== String(templateHash).toLowerCase()) {
    throw new HooksLaunchFactoryTemplateMismatchError();
  }
  return Object.freeze({
    params,
    templateHash: expected.toLowerCase() as `0x${string}`,
    hookDeploymentFactory: hdf.toLowerCase(),
    routerRegistry: registryAddress,
  });
}

const hooksLaunchFactoryAbi = [
  {
    type: "function",
    name: "tokenDeployer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "projectOwner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "launchIdByOwnerVersion",
    stateMutability: "view",
    inputs: [{ name: "ownerVersion", type: "bytes32" }],
    outputs: [{ name: "launchId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "nftSaleDuration",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "hookDeploymentFactory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "previewHookInitCodeHash",
    stateMutability: "view",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "projectOwner", type: "address" },
          { name: "configVersion", type: "uint32" },
          { name: "configHash", type: "bytes32" },
          { name: "name", type: "string" },
          { name: "ticker", type: "string" },
          { name: "nftSaleStart", type: "uint64" },
          { name: "buybackRecipient", type: "address" },
          { name: "deadline", type: "uint64" },
          { name: "memeSalt", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const tokenDeployerAbi = [
  {
    type: "function",
    name: "memeInitCodeHash",
    stateMutability: "pure",
    inputs: [
      { name: "name", type: "string" },
      { name: "ticker", type: "string" },
      { name: "launchFactory", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/**
 * A contract-level revert (or empty return data) of a view: on a pre-S141
 * Factory `nftSaleDuration()` has no selector and the call reverts. Network
 * and RPC failures are not reverts and stay unavailable.
 */
export function isHooksLaunchContractRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError ||
        cause instanceof ExecutionRevertedError,
    ) !== null
  );
}

/**
 * Decision 0164 (§10): the Factory's text-rule generation. S242 factories
 * expose `launchTextRulesVersion() external pure returns (uint8)` (2);
 * earlier factories have no such function, so the call reverts with no
 * return data.
 *
 * - a value ≥ 2 → `utf8` (the S242 `LaunchText` floor);
 * - a revert without return data, or empty return data → `ascii` (the
 *   pre-S242 `^[A-Z0-9]{2,12}$` `_validTicker`);
 * - anything else (RPC / transport error, timeout, a revert carrying data
 *   or a reason, a value below 2) → `null`: unreadable, fail closed.
 *
 * (An earlier draft inferred the generation from the revert order of a
 * simulated `deployLaunch`; replaced by this getter, which does not depend
 * on the factories' check order.)
 */
export const hooksLaunchTextRulesVersionAbi = loopLaunchFactoryAbi.filter(
  (item) => item.type === "function" && item.name === "launchTextRulesVersion",
);

export function hooksLaunchTextRulesFromVersion(
  version: unknown,
): "utf8" | null {
  return typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 2 &&
    version <= 255
    ? "utf8"
    : null;
}

/**
 * True only for "no such function" on a contract: an `eth_call` revert
 * with no return data and no reason beyond the node's generic
 * "execution reverted", or a call that returned no data at all.
 */
export function isHooksLaunchMissingFunctionRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  if (
    error.walk((cause) => cause instanceof ContractFunctionZeroDataError) !==
    null
  ) {
    return true;
  }
  const reverted = error.walk(
    (cause) => cause instanceof ContractFunctionRevertedError,
  );
  if (!(reverted instanceof ContractFunctionRevertedError)) return false;
  const raw = reverted.raw;
  const reason = reverted.reason?.trim().toLowerCase();
  return (
    (raw === undefined || raw === "0x") &&
    reverted.data === undefined &&
    reverted.signature === undefined &&
    (reason === undefined || reason === "execution reverted")
  );
}

export function createHooksLaunchFactoryReader(input: {
  readonly factoryAddress: string;
  readonly expectedRuntimeCodeHash: string;
  readonly rpcUrls: readonly string[];
  /**
   * Decision 0132: `loopDynamic` = a `LoopDynamicLaunchFactory`: the
   * template (Hook parameters, `TEMPLATE_HASH`) is read and verified, and
   * the Hook salt is mined for `loopHookDeploymentFactory()` /
   * `previewLoopHookInitCodeHash(request)` (bits 0x10C4; Decision 0152:
   * 0x10CC for an S209 Factory, by its template). Absent =
   * OfficialTax, unchanged.
   */
  readonly hookKind?: "officialTax" | "loopDynamic";
  /**
   * Decision 0150: the launch slot the Factory lives on (the node must
   * report it; it is the EIP-712 domain chain id); absent = 97.
   */
  readonly chainReference?: 56 | 97;
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
}): HooksLaunchFactoryReader {
  const chainReference = input.chainReference ?? 97;
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(input.factoryAddress) ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.expectedRuntimeCodeHash) ||
    (input.rpcUrls.length === 0 && input.transport === undefined)
  ) {
    throw new Error("Hooks launch factory reader unavailable");
  }
  const factoryAddress = input.factoryAddress as Address;
  const loopDynamic = input.hookKind === "loopDynamic";
  const client = createPublicClient({
    chain: viemLaunchChain(chainReference),
    transport:
      input.transport ??
      fallback(input.rpcUrls.map((url) => http(url, { timeout: 8_000 }))),
  });

  // Decision 0155: concurrent reads of one command (the submission runs its
  // nonce / token / Hook reads in parallel) share one in-flight network and
  // code check instead of each downloading the ~28 KB Factory code; every
  // new call after it settles still verifies afresh.
  let verifying: Promise<void> | null = null;
  function verifyNetworkAndCode(): Promise<void> {
    verifying ??= verifyNetworkAndCodeOnce().finally(() => {
      verifying = null;
    });
    return verifying;
  }
  async function verifyNetworkAndCodeOnce(): Promise<void> {
    try {
      const [chainId, code] = await Promise.all([
        client.getChainId(),
        client.getBytecode({ address: factoryAddress }),
      ]);
      if (
        chainId !== chainReference ||
        code === undefined ||
        code === "0x" ||
        keccak256(code).toLowerCase() !==
          input.expectedRuntimeCodeHash.toLowerCase()
      ) {
        throw new Error("wrong network or no Factory code");
      }
    } catch {
      throw new Error("Hooks launch factory read unavailable");
    }
  }

  // Immutable for a code-hash-pinned Factory: read once, then reuse.
  let saleDuration: {
    readonly seconds: number;
    readonly legacy: boolean;
  } | null = null;
  let template: Awaited<
    ReturnType<typeof readHooksLaunchLoopDynamicTemplate>
  > | null = null;
  async function loopDynamicTemplate() {
    if (template !== null) return template;
    await verifyNetworkAndCode();
    try {
      template = await readHooksLaunchLoopDynamicTemplate(
        (address, abi, functionName) =>
          client.readContract({ address, abi, functionName }),
        factoryAddress,
      );
    } catch {
      throw new Error("Hooks launch factory read unavailable");
    }
    return template;
  }

  // Decision 0164: immutable for a code-hash-pinned Factory; an unreadable
  // answer is not cached (the next call reads again).
  let tickerRule: "utf8" | "ascii" | null = null;
  async function tickerTextRule(): Promise<"utf8" | "ascii"> {
    if (tickerRule !== null) return tickerRule;
    await verifyNetworkAndCode();
    let outcome: "utf8" | "ascii" | null;
    try {
      outcome = hooksLaunchTextRulesFromVersion(
        await client.readContract({
          address: factoryAddress,
          abi: hooksLaunchTextRulesVersionAbi,
          functionName: "launchTextRulesVersion",
        }),
      );
    } catch (error) {
      outcome = isHooksLaunchMissingFunctionRevert(error) ? "ascii" : null;
    }
    if (outcome === null) {
      throw new Error("Hooks launch factory text rules unreadable");
    }
    tickerRule = outcome;
    return outcome;
  }

  return Object.freeze({
    factoryAddress,
    chainId: chainReference,
    tickerTextRule,
    hookKind: loopDynamic ? ("loopDynamic" as const) : ("officialTax" as const),
    ...(loopDynamic
      ? {
          async loopDynamicTemplate() {
            const read = await loopDynamicTemplate();
            return { params: read.params, templateHash: read.templateHash };
          },
        }
      : {}),
    async nftSaleDuration() {
      if (saleDuration !== null) return saleDuration;
      await verifyNetworkAndCode();
      let read: { readonly seconds: number; readonly legacy: boolean };
      try {
        const value = await client.readContract({
          address: factoryAddress,
          abi: hooksLaunchFactoryAbi,
          functionName: "nftSaleDuration",
        });
        read = { seconds: Number(value), legacy: false };
      } catch (error) {
        if (!isHooksLaunchContractRevert(error)) {
          throw new Error("Hooks launch factory read unavailable", {
            cause: error,
          });
        }
        read = {
          seconds: hooksLaunchLegacyNftSaleDurationSeconds,
          legacy: true,
        };
      }
      if (!isHooksLaunchNftSaleDuration(read.seconds)) {
        throw new Error("Hooks launch factory sale duration out of range");
      }
      saleDuration = Object.freeze(read);
      return saleDuration;
    },
    async nonce(projectOwner: string) {
      await verifyNetworkAndCode();
      try {
        return await client.readContract({
          address: factoryAddress,
          abi: hooksLaunchFactoryAbi,
          functionName: "nonces",
          args: [projectOwner as Address],
        });
      } catch {
        throw new Error("Hooks launch factory read unavailable");
      }
    },
    async ownerVersionLaunchId(projectOwner: string, configVersion: number) {
      await verifyNetworkAndCode();
      try {
        const launchId = await client.readContract({
          address: factoryAddress,
          abi: hooksLaunchFactoryAbi,
          functionName: "launchIdByOwnerVersion",
          args: [
            keccak256(
              encodeAbiParameters(
                [{ type: "address" }, { type: "uint32" }],
                [projectOwner as Address, configVersion],
              ),
            ),
          ],
        });
        return launchId.toLowerCase();
      } catch {
        throw new Error("Hooks launch factory read unavailable");
      }
    },
    async tokenDeployment(request: {
      readonly name: string;
      readonly ticker: string;
    }) {
      await verifyNetworkAndCode();
      try {
        const deployer = await client.readContract({
          address: factoryAddress,
          abi: hooksLaunchFactoryAbi,
          functionName: "tokenDeployer",
        });
        const [code, initCodeHash] = await Promise.all([
          client.getBytecode({ address: deployer }),
          client.readContract({
            address: deployer,
            abi: tokenDeployerAbi,
            functionName: "memeInitCodeHash",
            args: [request.name, request.ticker, factoryAddress],
          }),
        ]);
        if (code === undefined || code === "0x") {
          throw new Error("Token deployer has no code");
        }
        return { deployer, initCodeHash };
      } catch {
        throw new Error("Hooks launch factory read unavailable");
      }
    },
    async hookDeployment(request: {
      readonly projectOwner: string;
      readonly configVersion: number;
      readonly configHash: string;
      readonly name: string;
      readonly ticker: string;
      readonly nftSaleStart: string;
      readonly buybackRecipient: string;
      readonly deadline: string;
      readonly memeSalt: string;
    }) {
      await verifyNetworkAndCode();
      const launchRequest = {
        projectOwner: request.projectOwner as Address,
        configVersion: request.configVersion,
        configHash: request.configHash as `0x${string}`,
        name: request.name,
        ticker: request.ticker,
        nftSaleStart: BigInt(request.nftSaleStart),
        buybackRecipient: request.buybackRecipient as Address,
        deadline: BigInt(request.deadline),
        memeSalt: request.memeSalt as `0x${string}`,
      };
      try {
        // Decision 0132: a LoopDynamic Hook is CREATE2-deployed at
        // graduation by the Factory's LoopHookDeploymentFactory; the salt
        // passed to deployLaunch is registered (and checked) there.
        const [deployer, initCodeHash] = loopDynamic
          ? await Promise.all([
              client.readContract({
                address: factoryAddress,
                abi: loopDynamicLaunchFactoryAbi,
                functionName: "loopHookDeploymentFactory",
              }),
              client.readContract({
                address: factoryAddress,
                abi: loopDynamicLaunchFactoryAbi,
                functionName: "previewLoopHookInitCodeHash",
                args: [launchRequest],
              }),
            ])
          : await Promise.all([
              client.readContract({
                address: factoryAddress,
                abi: hooksLaunchFactoryAbi,
                functionName: "hookDeploymentFactory",
              }),
              client.readContract({
                address: factoryAddress,
                abi: hooksLaunchFactoryAbi,
                functionName: "previewHookInitCodeHash",
                args: [launchRequest],
              }),
            ]);
        const deployerCode = await client.getBytecode({ address: deployer });
        if (deployerCode === undefined || deployerCode === "0x") {
          throw new Error("Hook deployment factory has no code");
        }
        return { deployer, initCodeHash };
      } catch {
        throw new Error("Hooks launch factory read unavailable");
      }
    },
  });
}
