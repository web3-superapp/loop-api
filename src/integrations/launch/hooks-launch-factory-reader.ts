import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  ExecutionRevertedError,
  fallback,
  http,
  keccak256,
  type Address,
} from "viem";
import { bscTestnet } from "viem/chains";

import {
  hooksLaunchLegacyNftSaleDurationSeconds,
  isHooksLaunchNftSaleDuration,
} from "../../features/launch/hooks-launch-config.js";
import type { HooksLaunchFactoryReader } from "../../features/launch/hooks-launch-deployment.js";

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
function isContractRevert(error: unknown): boolean {
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
}): HooksLaunchFactoryReader {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(input.factoryAddress) ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.expectedRuntimeCodeHash) ||
    input.rpcUrls.length === 0
  ) {
    throw new Error("Hooks launch factory reader unavailable");
  }
  const factoryAddress = input.factoryAddress as Address;
  const client = createPublicClient({
    chain: bscTestnet,
    transport: fallback(
      input.rpcUrls.map((url) => http(url, { timeout: 8_000 })),
    ),
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

  return Object.freeze({
    factoryAddress,
    chainId: 97,
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
        if (!isContractRevert(error)) {
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
      try {
        const [deployer, initCodeHash] = await Promise.all([
          client.readContract({
            address: factoryAddress,
            abi: hooksLaunchFactoryAbi,
            functionName: "hookDeploymentFactory",
          }),
          client.readContract({
            address: factoryAddress,
            abi: hooksLaunchFactoryAbi,
            functionName: "previewHookInitCodeHash",
            args: [
              {
                projectOwner: request.projectOwner as Address,
                configVersion: request.configVersion,
                configHash: request.configHash as `0x${string}`,
                name: request.name,
                ticker: request.ticker,
                nftSaleStart: BigInt(request.nftSaleStart),
                buybackRecipient: request.buybackRecipient as Address,
                deadline: BigInt(request.deadline),
                memeSalt: request.memeSalt as `0x${string}`,
              },
            ],
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
