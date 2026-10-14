import {
  BaseError,
  createPublicClient,
  encodePacked,
  fallback,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { bsc, bscTestnet } from "viem/chains";

import type {
  ChainGuardChain,
  ChainGuardFactoryReading,
} from "../../features/chain-guard/chain-guard-collect.js";
import type { ChainGuardLog } from "../../features/chain-guard/chain-guard-evaluate.js";

/**
 * Decision 0134: the read-only launch-chain reader of the chain guard.
 * Event signatures are StablecoinV2's (Sourcify `exact_match` of the BSC
 * USD1 implementation, verified 2025-11-09; docs/24 §7.1.2), the OZ
 * TransparentUpgradeableProxy's `Upgraded` / `AdminChanged`, and the OZ
 * `Ownable` `OwnershipTransferred` of the ProxyAdmin and the token, and
 * (Decision 0135) the PoolManager's `ProtocolFeeUpdated` /
 * `ProtocolFeeControllerUpdated` plus the fee controller's
 * `protocolFeeForPool`. A
 * `paused()` / `frozen()` that reverts or returns no data (the testnet mock
 * token implements neither) is `null`, never `false`. It never signs or
 * sends.
 */

export class ChainGuardChainRefusedError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "ChainGuardChainRefusedError";
  }
}

const usd1Abi = parseAbi([
  "function paused() view returns (bool)",
  "function frozen(address account) view returns (bool)",
]);

export const chainGuardEventsAbi = parseAbi([
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event Freeze(address indexed caller, address indexed account)",
  "event Unfreeze(address indexed caller, address indexed account)",
  "event FrozenAccountDrained(address indexed caller, address indexed account, uint256 amount)",
  "event FrozenFundsReallocated(address indexed caller, address indexed from, address indexed to, uint256 amount)",
  "event Upgraded(address indexed implementation)",
  "event AdminChanged(address previousAdmin, address newAdmin)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  // Decision 0135: Uniswap v4-core `IProtocolFees` (PoolId is bytes32).
  "event ProtocolFeeUpdated(bytes32 indexed id, uint24 protocolFee)",
  "event ProtocolFeeControllerUpdated(address indexed protocolFeeController)",
]);

/**
 * Decision 0135: Uniswap v4-core `IProtocolFeeController` (the PoolKey
 * tuple: currency0, currency1, fee, tickSpacing, hooks).
 */
const protocolFeeControllerAbi = [
  {
    type: "function",
    name: "protocolFeeForPool",
    stateMutability: "view",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "protocolFee", type: "uint24" }],
  },
] as const;

const factoryAbi = parseAbi([
  "function usd1() view returns (address)",
  "function poolManager() view returns (address)",
  "function platformTaxReceiver() view returns (address)",
  "function primaryKeeper() view returns (address)",
  "function fallbackKeeper() view returns (address)",
  "function deploymentExecutor() view returns (address)",
  "function feeVault() view returns (address)",
  "function loopRouter() view returns (address)",
]);

const poolManagerAbi = parseAbi([
  "function protocolFeeController() view returns (address)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

/** EIP-1967 `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`. */
export const eip1967ImplementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** EIP-1967 `bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)`. */
export const eip1967AdminSlot =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/** Uniswap v4 `StateLibrary.POOLS_SLOT`. */
const poolsSlot: Hex = `0x${6n.toString(16).padStart(64, "0")}`;

function lower(value: string): string {
  return value.toLowerCase();
}

/** The address in the low 20 bytes of a storage word; null for zero. */
export function slotAddress(word: Hex | undefined): string | null {
  if (word === undefined) return null;
  const value = BigInt(word) & ((1n << 160n) - 1n);
  if (value === 0n) return null;
  return `0x${value.toString(16).padStart(40, "0")}`;
}

/** A call that reverted / returned no data (not implemented), vs a transport error. */
export function isUnsupportedRead(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof BaseError &&
        (cause.name === "ContractFunctionRevertedError" ||
          cause.name === "ContractFunctionZeroDataError"),
    ) !== null
  );
}

export function createChainGuardChain(input: {
  readonly rpcUrls: readonly string[];
  readonly chainReference: number;
  /** Test seam. */
  readonly transport?: Transport;
}): ChainGuardChain {
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new ChainGuardChainRefusedError("CHAIN_GUARD_CHAIN_NOT_CONFIGURED");
  }
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) =>
        http(url, { timeout: 10_000, retryCount: 1, batch: { batchSize: 32 } }),
      ),
      { retryCount: 0 },
    );
  const client = createPublicClient({
    chain: input.chainReference === 56 ? bsc : bscTestnet,
    transport,
  });

  async function optional<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (isUnsupportedRead(error)) return null;
      throw error;
    }
  }

  async function factoryAddress(
    factory: string,
    functionName:
      | "usd1"
      | "poolManager"
      | "platformTaxReceiver"
      | "primaryKeeper"
      | "fallbackKeeper"
      | "deploymentExecutor"
      | "feeVault"
      | "loopRouter",
  ): Promise<string> {
    return lower(
      await client.readContract({
        address: factory as Address,
        abi: factoryAbi,
        functionName,
      }),
    );
  }

  return Object.freeze<ChainGuardChain>({
    chainId: () => client.getChainId(),

    head: () => client.getBlockNumber({ cacheTime: 0 }),

    async readFactory(factory): Promise<ChainGuardFactoryReading> {
      const [
        usd1,
        poolManager,
        platformTaxReceiver,
        primaryKeeper,
        fallbackKeeper,
        deploymentExecutor,
        feeVault,
        loopRouter,
      ] = await Promise.all([
        factoryAddress(factory, "usd1"),
        factoryAddress(factory, "poolManager"),
        factoryAddress(factory, "platformTaxReceiver"),
        factoryAddress(factory, "primaryKeeper"),
        factoryAddress(factory, "fallbackKeeper"),
        factoryAddress(factory, "deploymentExecutor"),
        optional(() => factoryAddress(factory, "feeVault")),
        optional(() => factoryAddress(factory, "loopRouter")),
      ]);
      return Object.freeze({
        factory: lower(factory),
        usd1,
        poolManager,
        platformTaxReceiver,
        feeVault,
        loopRouter,
        primaryKeeper,
        fallbackKeeper,
        deploymentExecutor,
      });
    },

    async readUsd1(usd1) {
      const [paused, implementationWord, adminWord] = await Promise.all([
        optional(() =>
          client.readContract({
            address: usd1 as Address,
            abi: usd1Abi,
            functionName: "paused",
          }),
        ),
        client.getStorageAt({
          address: usd1 as Address,
          slot: eip1967ImplementationSlot,
        }),
        client.getStorageAt({
          address: usd1 as Address,
          slot: eip1967AdminSlot,
        }),
      ]);
      return Object.freeze({
        paused,
        implementation: slotAddress(implementationWord),
        proxyAdmin: slotAddress(adminWord),
      });
    },

    async readFrozen(usd1, addresses) {
      const values = await Promise.all(
        addresses.map((account) =>
          optional(() =>
            client.readContract({
              address: usd1 as Address,
              abi: usd1Abi,
              functionName: "frozen",
              args: [account as Address],
            }),
          ),
        ),
      );
      return new Map(
        addresses.map((account, index) => [account, values[index] ?? null]),
      );
    },

    async readProtocolFeeController(poolManager) {
      return lower(
        await client.readContract({
          address: poolManager as Address,
          abi: poolManagerAbi,
          functionName: "protocolFeeController",
        }),
      );
    },

    async readPoolSlot0(poolManager, poolId) {
      const slot = keccak256(
        encodePacked(["bytes32", "bytes32"], [poolId as Hex, poolsSlot]),
      );
      const word = await client.readContract({
        address: poolManager as Address,
        abi: poolManagerAbi,
        functionName: "extsload",
        args: [slot],
      });
      return BigInt(word);
    },

    async readProtocolFeePolicy(controller, key) {
      return optional(() =>
        client.readContract({
          address: controller as Address,
          abi: protocolFeeControllerAbi,
          functionName: "protocolFeeForPool",
          args: [
            {
              currency0: key.currency0 as Address,
              currency1: key.currency1 as Address,
              fee: key.fee,
              tickSpacing: key.tickSpacing,
              hooks: key.hooks as Address,
            },
          ],
        }),
      );
    },

    async readBalances(addresses) {
      const values = await Promise.all(
        addresses.map((account) =>
          client.getBalance({ address: account as Address }),
        ),
      );
      return new Map(
        addresses.map((account, index) => [account, values[index] ?? 0n]),
      );
    },

    async getLogs({ usd1, proxyAdmin, poolManagers, fromBlock, toBlock }) {
      // Decision 0135: USD1 + ProxyAdmin + each PoolManager (usually 3, at most 5
      // addresses — well under the 10-address limit of a public endpoint).
      const addresses = [
        ...new Set([
          usd1,
          ...(proxyAdmin === null ? [] : [proxyAdmin]),
          ...poolManagers,
        ]),
      ];
      const logs = await client.getLogs({
        address: addresses as Address[],
        events: chainGuardEventsAbi,
        fromBlock,
        toBlock,
        strict: true,
      });
      const decoded: ChainGuardLog[] = [];
      for (const log of logs) {
        const args: Record<string, string> = {};
        for (const [key, value] of Object.entries(
          log.args as Record<string, unknown>,
        )) {
          args[key] =
            typeof value === "bigint"
              ? value.toString(10)
              : lower(String(value));
        }
        decoded.push({
          name: log.eventName,
          address: lower(log.address),
          blockNumber: log.blockNumber.toString(10),
          transactionHash: lower(log.transactionHash),
          logIndex: log.logIndex,
          args,
        });
      }
      return decoded.sort((left, right) =>
        left.blockNumber === right.blockNumber
          ? left.logIndex - right.logIndex
          : BigInt(left.blockNumber) < BigInt(right.blockNumber)
            ? -1
            : 1,
      );
    },
  });
}
