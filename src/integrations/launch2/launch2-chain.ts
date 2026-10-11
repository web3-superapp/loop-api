import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  fallback,
  getAbiItem,
  http,
  recoverTypedDataAddress,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type Transport,
} from "viem";
import { bscTestnet } from "viem/chains";

import type {
  Launch2BuybackChainState,
  Launch2Chain,
  Launch2ContractRole,
  Launch2DecodedLog,
  Launch2EventName,
  Launch2ViewerChainState,
} from "../../features/launch2/launch2-ports.js";
import {
  buybackExecutorAbi,
  curveEngineAbi,
  launchPublicationGateAbi,
  loopLaunchFactoryAbi,
  memeTokenAbi,
  nftEscrowAbi,
  officialPoolRouterAbi,
  officialTaxHookAbi,
  poolManagerAbi,
  projectNFTAbi,
  snapshotRegistryAbi,
} from "../launch/hooks-launch-protocol-abi.generated.js";
import { legacyV2BuybackExecutorAbi } from "../launch/hooks-launch-protocol-abi-legacy-v2.js";

/**
 * Decision 0114: the launch slot (BSC Testnet, chain 97) reader of the
 * launch2 read model. Logs are decoded per contract role with the ABI
 * generated from the loop-contracts Foundry build (`pnpm hooks:abi-sync`);
 * Decision 0122: the buyback executor of a v2-generation instance uses the
 * frozen v2 ABI (`buybackExecutorV2` role, other `BuybackCompleted` topic);
 * a log of an unexpected event is counted, never guessed. Reads of one
 * route answer are pinned to one block. It never signs or sends.
 */

export class Launch2ChainRefusedError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "Launch2ChainRefusedError";
    this.reasonCode = reasonCode;
  }
}

const roleAbis: Readonly<
  Record<
    Launch2ContractRole,
    { readonly abi: Abi; readonly events: readonly Launch2EventName[] }
  >
> = {
  factory: { abi: loopLaunchFactoryAbi, events: ["LaunchDeployed"] },
  gate: { abi: launchPublicationGateAbi, events: ["LaunchActivated"] },
  nft: { abi: projectNFTAbi, events: ["NftMinted", "Transfer"] },
  snapshots: {
    abi: snapshotRegistryAbi,
    events: ["SnapshotPublished", "PublicRoundOpenedWithoutHolders"],
  },
  curve: {
    abi: curveEngineAbi,
    events: ["CurveBought", "CurveSold", "Graduated"],
  },
  buybackExecutor: {
    abi: buybackExecutorAbi,
    events: ["BuybackCompleted", "BuybackPausedEvent", "BuybackResumed"],
  },
  buybackExecutorV2: {
    abi: legacyV2BuybackExecutorAbi,
    events: ["BuybackCompleted", "BuybackPausedEvent", "BuybackResumed"],
  },
  // Decision 0125: the MEME ERC-20 (generated ABI lists no events).
  meme: { abi: erc20Abi, events: ["Transfer"] },
  // Decision 0124: only `Swap`, and only the pool ids the lane asks for.
  poolManager: { abi: poolManagerAbi, events: ["Swap"] },
  // Decision 0126: the router's own Swap(poolId, payer, recipient, …),
  // renamed RouterSwap after decoding.
  poolRouter: { abi: officialPoolRouterAbi, events: ["Swap"] },
};

const poolManagerSwapEvent = getAbiItem({ abi: poolManagerAbi, name: "Swap" });
const poolRouterSwapEvent = getAbiItem({
  abi: officialPoolRouterAbi,
  name: "Swap",
});

function lower(value: string): string {
  return value.toLowerCase();
}

function stringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return lower(value);
  throw new Launch2ChainRefusedError("LAUNCH2_LOG_DECODE_FAILED");
}

/**
 * Public BSC Testnet endpoints refuse `eth_getLogs` once the address filter
 * grows past a handful of contracts (publicnode answers HTTP 403 "Request
 * blocked" from 10 addresses on; measured 2026-10-11). One lane poll covers
 * every Factory plus five contracts per instance, so the reader splits the
 * filter into batches of this size and merges the answers in log order.
 */
export const launch2DefaultMaxAddressesPerLogQuery = 8;

export function createLaunch2Chain(input: {
  readonly rpcUrls: readonly string[];
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
  readonly expectedChainId?: number;
  /** Address-filter batch size per `eth_getLogs`; default 8. */
  readonly maxAddressesPerLogQuery?: number;
}): Launch2Chain {
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new Launch2ChainRefusedError("LAUNCH2_CHAIN_NOT_CONFIGURED");
  }
  const expectedChainId = input.expectedChainId ?? 97;
  const maxAddresses = Math.max(
    1,
    Math.floor(
      input.maxAddressesPerLogQuery ?? launch2DefaultMaxAddressesPerLogQuery,
    ),
  );
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) =>
        http(url, { timeout: 10_000, retryCount: 1, batch: { batchSize: 32 } }),
      ),
      { retryCount: 0 },
    );
  const client = createPublicClient({ chain: bscTestnet, transport });

  async function read<T>(
    address: string,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    blockNumber: bigint,
  ): Promise<T> {
    return (await client.readContract({
      address: address as Address,
      abi,
      functionName,
      args,
      blockNumber,
    })) as T;
  }

  return Object.freeze<Launch2Chain>({
    async verifyChain() {
      const id = await client.getChainId();
      return id === expectedChainId ? "ok" : "wrong_chain";
    },

    async getHead() {
      const block = await client.getBlock({ blockTag: "latest" });
      return {
        blockNumber: block.number,
        blockHash: lower(block.hash),
        timestamp: block.timestamp,
      };
    },

    async getBlock(blockNumber) {
      try {
        const block = await client.getBlock({ blockNumber });
        return { hash: lower(block.hash), timestamp: block.timestamp };
      } catch (error) {
        if (error instanceof Error && error.name === "BlockNotFoundError") {
          return null;
        }
        throw error;
      }
    },

    async getLogs({ roles, fromBlock, toBlock, poolSwaps, routerSwaps }) {
      const pools = [...(poolSwaps ?? new Map<string, readonly string[]>())];
      const routerIds = routerSwaps?.poolIds ?? [];
      if (
        roles.size === 0 &&
        pools.every(([, ids]) => ids.length === 0) &&
        routerIds.length === 0
      ) {
        return { logs: [], ignored: 0 };
      }
      const addresses = [...roles.keys()] as Address[];
      const raw: Log<bigint, number, false>[] = [];
      let queries = 0;
      for (let i = 0; i < addresses.length; i += maxAddresses) {
        queries += 1;
        raw.push(
          ...(await client.getLogs({
            address: addresses.slice(i, i + maxAddresses),
            fromBlock,
            toBlock,
          })),
        );
      }
      // Decision 0124: the PoolManager serves every v4 pool on the chain, so
      // its Swap logs are asked for by pool id (topic1), never by address
      // alone; the id list is split into batches of the same size.
      const poolRoles = new Map(roles);
      for (const [poolManager, ids] of pools) {
        poolRoles.set(lower(poolManager), "poolManager");
        for (let i = 0; i < ids.length; i += maxAddresses) {
          queries += 1;
          const logs = await client.getLogs({
            address: poolManager as Address,
            event: poolManagerSwapEvent,
            args: { id: ids.slice(i, i + maxAddresses) as Hex[] },
            fromBlock,
            toBlock,
          });
          raw.push(...(logs as unknown as Log<bigint, number, false>[]));
        }
      }
      // Decision 0126: the router's Swap logs, by pool id (topic1) as well.
      if (routerSwaps !== undefined && routerIds.length > 0) {
        poolRoles.set(lower(routerSwaps.router), "poolRouter");
        for (let i = 0; i < routerIds.length; i += maxAddresses) {
          queries += 1;
          const logs = await client.getLogs({
            address: routerSwaps.router as Address,
            event: poolRouterSwapEvent,
            args: { poolId: routerIds.slice(i, i + maxAddresses) as Hex[] },
            fromBlock,
            toBlock,
          });
          raw.push(...(logs as unknown as Log<bigint, number, false>[]));
        }
      }
      if (queries > 1) {
        raw.sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
        );
      }
      const logs: Launch2DecodedLog[] = [];
      let ignored = 0;
      for (const log of raw) {
        const role = poolRoles.get(lower(log.address));
        if (role === undefined) {
          ignored += 1;
          continue;
        }
        const spec = roleAbis[role];
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: spec.abi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
        } catch {
          ignored += 1;
          continue;
        }
        const decodedName = decoded.eventName as unknown as Launch2EventName;
        if (!spec.events.includes(decodedName)) {
          ignored += 1;
          continue;
        }
        const name: Launch2EventName =
          role === "poolRouter" ? "RouterSwap" : decodedName;
        const args: Record<string, string> = {};
        for (const [key, value] of Object.entries(
          (decoded.args ?? {}) as Record<string, unknown>,
        )) {
          args[key] = stringify(value);
        }
        logs.push({
          contractAddress: lower(log.address),
          eventName: name,
          args: Object.freeze(args),
          transactionHash: lower(log.transactionHash),
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          blockHash: lower(log.blockHash),
        });
      }
      return { logs, ignored };
    },

    async readSnapshotPublication(transactionHash) {
      let transaction;
      try {
        transaction = await client.getTransaction({
          hash: transactionHash as Hex,
        });
      } catch {
        return null;
      }
      try {
        const call = decodeFunctionData({
          abi: snapshotRegistryAbi,
          data: transaction.input,
        });
        if (call.functionName !== "publishSnapshot") return null;
        const args = call.args as readonly unknown[];
        return {
          signatures: [lower(String(args[4])), lower(String(args[5]))],
        };
      } catch {
        // Published through another contract (a multisig): no direct calldata.
        return null;
      }
    },

    async recoverSnapshotSigners(request) {
      const recovered: string[] = [];
      for (const signature of request.signatures) {
        try {
          recovered.push(
            lower(
              await recoverTypedDataAddress({
                domain: {
                  name: "LOOP NFT Snapshot",
                  version: "1",
                  chainId: expectedChainId,
                  verifyingContract: request.snapshots as Address,
                },
                types: {
                  Snapshot: [
                    { name: "launchId", type: "bytes32" },
                    { name: "nft", type: "address" },
                    { name: "cutoffBlock", type: "uint256" },
                    { name: "cutoffBlockHash", type: "bytes32" },
                    { name: "dataHash", type: "bytes32" },
                    { name: "root", type: "bytes32" },
                  ],
                },
                primaryType: "Snapshot",
                message: {
                  launchId: request.launchId as Hex,
                  nft: request.nft as Address,
                  cutoffBlock: request.cutoffBlock,
                  cutoffBlockHash: request.cutoffBlockHash as Hex,
                  dataHash: request.dataHash as Hex,
                  root: request.root as Hex,
                },
                signature: signature as Hex,
              }),
            ),
          );
        } catch {
          // An unrecoverable signature is simply not listed.
        }
      }
      return recovered;
    },

    async readViewerState(request): Promise<Launch2ViewerChainState> {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = block.number;
      const curveAbi = curveEngineAbi as Abi;
      const [
        published,
        graduated,
        earlyRoundEndsAt,
        soldSupply,
        accountedReserve,
        totalMinted,
        rootPublishedAt,
        usd1,
      ] = await Promise.all([
        read<boolean>(
          request.gate,
          launchPublicationGateAbi as Abi,
          "published",
          [],
          at,
        ),
        read<boolean>(request.curve, curveAbi, "graduated", [], at),
        read<bigint>(request.curve, curveAbi, "earlyRoundEndsAt", [], at),
        read<bigint>(request.curve, curveAbi, "soldSupply", [], at),
        read<bigint>(request.curve, curveAbi, "accountedReserve", [], at),
        read<bigint>(request.nft, projectNFTAbi as Abi, "totalMinted", [], at),
        read<bigint>(
          request.snapshots,
          snapshotRegistryAbi as Abi,
          "rootPublishedAt",
          [],
          at,
        ),
        read<string>(request.curve, curveAbi, "usd1", [], at),
      ]);
      const tokenAbi = memeTokenAbi as Abi;
      const [cumulativeBought, nftMinted, usd1Balance, memeBalance] =
        request.wallet === null
          ? [0n, false, null, null]
          : await Promise.all([
              read<bigint>(
                request.curve,
                curveAbi,
                "cumulativeBought",
                [request.wallet],
                at,
              ),
              read<boolean>(
                request.nft,
                projectNFTAbi as Abi,
                "mintedByAddress",
                [request.wallet],
                at,
              ),
              read<bigint>(usd1, tokenAbi, "balanceOf", [request.wallet], at),
              read<bigint>(
                request.meme,
                tokenAbi,
                "balanceOf",
                [request.wallet],
                at,
              ),
            ]);
      return {
        blockNumber: at,
        blockHash: lower(block.hash),
        curve: {
          published,
          graduated,
          earlyRoundEndsAt: BigInt(earlyRoundEndsAt),
          soldSupply,
          accountedReserve,
          blockTimestamp: block.timestamp,
        },
        cumulativeBought,
        nftMinted,
        nftTotalMinted: totalMinted,
        snapshotRootPublishedAt: BigInt(rootPublishedAt),
        usd1: lower(usd1),
        usd1Balance,
        memeBalance,
      };
    },

    async readWalletBalances(request) {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = block.number;
      const tokenAbi = memeTokenAbi as Abi;
      const usd1 = await read<string>(
        request.curve,
        curveEngineAbi as Abi,
        "usd1",
        [],
        at,
      );
      const [memeBalance, usd1Balance] = await Promise.all([
        read<bigint>(request.meme, tokenAbi, "balanceOf", [request.wallet], at),
        read<bigint>(usd1, tokenAbi, "balanceOf", [request.wallet], at),
      ]);
      return { blockNumber: at, memeBalance, usd1Balance };
    },

    async readHookPool(hook) {
      const [poolManager, currency0] = await Promise.all([
        client.readContract({
          address: hook as Address,
          abi: officialTaxHookAbi,
          functionName: "poolManager",
        }),
        client.readContract({
          address: hook as Address,
          abi: officialTaxHookAbi,
          functionName: "currency0",
        }),
      ]);
      return { poolManager: lower(poolManager), currency0: lower(currency0) };
    },

    async readBuybackState(request): Promise<Launch2BuybackChainState> {
      const head = await client.getBlock({ blockTag: "latest" });
      const block = head.number;
      const legacy = request.generation === "v2";
      const executorAbi = (
        legacy ? legacyV2BuybackExecutorAbi : buybackExecutorAbi
      ) as Abi;
      const escrowAbi = nftEscrowAbi as Abi;
      const [
        paused,
        lastSuccessfulAt,
        availableBudget,
        totalRecorded,
        totalSpent,
        next,
      ] = await Promise.all([
        read<boolean>(
          request.buybackExecutor,
          executorAbi,
          "paused",
          [],
          block,
        ),
        read<bigint>(
          request.buybackExecutor,
          executorAbi,
          "lastSuccessfulAt",
          [],
          block,
        ),
        read<bigint>(request.escrow, escrowAbi, "availableBudget", [], block),
        read<bigint>(request.escrow, escrowAbi, "totalRecorded", [], block),
        read<bigint>(request.escrow, escrowAbi, "totalSpent", [], block),
        // v3: (amountIn, executable); v2: (amountIn, expectedNetOut,
        // minMemeOut) and a revert while the price recorder is not ready.
        read<readonly unknown[]>(
          request.buybackExecutor,
          executorAbi,
          "quoteNextOrder",
          [],
          block,
        ).catch(() => null),
      ]);
      let nextOrderAmountIn: bigint | null = null;
      let nextOrderExecutable: boolean | null = null;
      if (next !== null) {
        nextOrderAmountIn = BigInt(next[0] as bigint);
        nextOrderExecutable = legacy
          ? BigInt(next[2] as bigint) > 0n
          : next[1] === true;
      }
      return {
        blockTimestamp: head.timestamp,
        paused,
        lastSuccessfulAt: BigInt(lastSuccessfulAt),
        availableBudget,
        totalRecorded,
        totalSpent,
        nextOrderAmountIn,
        nextOrderExecutable,
      };
    },
  });
}
