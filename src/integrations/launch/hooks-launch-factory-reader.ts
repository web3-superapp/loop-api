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
import { bscTestnet } from "viem/chains";

import {
  hooksLaunchLegacyNftSaleDurationSeconds,
  hooksLaunchLoopDynamicTemplateHash,
  isHooksLaunchMaxDynamicFeeWad,
  isHooksLaunchNftSaleDuration,
  type HooksLaunchLoopDynamicParams,
} from "../../features/launch/hooks-launch-config.js";
import type { HooksLaunchFactoryReader } from "../../features/launch/hooks-launch-deployment.js";
import { HooksLaunchFactoryTemplateMismatchError } from "../../features/launch/hooks-launch-executor.js";
import {
  loopDynamicLaunchFactoryAbi,
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
  const [kind, templateHash, router, hookFactory, registry] = await Promise.all(
    [
      read(factoryAddress, F, "hookKind"),
      read(factoryAddress, F, "TEMPLATE_HASH"),
      read(factoryAddress, F, "loopRouter"),
      read(factoryAddress, F, "loopHookDeploymentFactory"),
      read(factoryAddress, F, "routerRegistry"),
    ],
  );
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
        !isHooksLaunchMaxDynamicFeeWad(maxDynamicFeeWad.toString(10))))
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
  });
  // An S193 Factory's TEMPLATE_HASH has the trailing cap word, an S165 one
  // does not; the recomputed hash must equal the chain's either way.
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

export function createHooksLaunchFactoryReader(input: {
  readonly factoryAddress: string;
  readonly expectedRuntimeCodeHash: string;
  readonly rpcUrls: readonly string[];
  /**
   * Decision 0132: `loopDynamic` = a `LoopDynamicLaunchFactory`: the
   * template (Hook parameters, `TEMPLATE_HASH`) is read and verified, and
   * the Hook salt is mined for `loopHookDeploymentFactory()` /
   * `previewLoopHookInitCodeHash(request)` (bits 0x10C4). Absent =
   * OfficialTax, unchanged.
   */
  readonly hookKind?: "officialTax" | "loopDynamic";
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
}): HooksLaunchFactoryReader {
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
    chain: bscTestnet,
    transport:
      input.transport ??
      fallback(input.rpcUrls.map((url) => http(url, { timeout: 8_000 }))),
  });

  async function verifyNetworkAndCode(): Promise<void> {
    try {
      const [chainId, code] = await Promise.all([
        client.getChainId(),
        client.getBytecode({ address: factoryAddress }),
      ]);
      if (
        chainId !== 97 ||
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

  return Object.freeze({
    factoryAddress,
    chainId: 97,
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
        const code = await client.getBytecode({ address: deployer });
        if (code === undefined || code === "0x") {
          throw new Error("Token deployer has no code");
        }
        const initCodeHash = await client.readContract({
          address: deployer,
          abi: tokenDeployerAbi,
          functionName: "memeInitCodeHash",
          args: [request.name, request.ticker, factoryAddress],
        });
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
