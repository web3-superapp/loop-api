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
import { viemLaunchChain } from "../bsc/viem-launch-chain.js";

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
  loopDynamicGraduationAdapterAbi,
  loopDynamicHookAbi,
  loopLaunchFactoryAbi,
  memeTokenAbi,
  nftEscrowAbi,
  officialPoolRouterAbi,
  officialTaxHookAbi,
  poolManagerAbi,
  projectNFTAbi,
  snapshotRegistryAbi,
} from "../launch/hooks-launch-protocol-abi.generated.js";
import {
  legacyS200CurveEngineAbi,
  legacyS200LoopDynamicHookAbi,
} from "../launch/hooks-launch-protocol-abi-legacy-s200.js";
import { legacyV2BuybackExecutorAbi } from "../launch/hooks-launch-protocol-abi-legacy-v2.js";
import { isLaunch2ContractRevert } from "./launch2-dynamic-chain.js";

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

/**
 * Decision 0152: the LoopDynamic Hook role decodes with the current ABI and
 * the frozen pre-S209 `BuyFeeCharged` (another topic0).
 */
export const launch2DynamicHookDecodeAbi: Abi = [
  ...loopDynamicHookAbi,
  ...legacyS200LoopDynamicHookAbi,
];

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
  // Decision 0131: LoopDynamic — the graduation adapter's Hook binding and
  // the per-project Hook's fee / candle / round / reward logs.
  dynamicGraduationAdapter: {
    abi: loopDynamicGraduationAdapterAbi,
    events: ["LoopHookBound"],
  },
  dynamicHook: {
    // Decision 0152: a pre-S209 Hook's `BuyFeeCharged(buyer, grossMeme,
    // fee)` (MEME) has another topic0 than the S209 `BuyFeeCharged(round,
    // buyer, grossQuote, fee)` (USD1); both decode, the argument names
    // (`grossMeme` / `grossQuote`) carry the generation.
    abi: launch2DynamicHookDecodeAbi,
    events: [
      "SellFeeCharged",
      "BuyFeeCharged",
      "CandleClosed",
      "EmptyCandlesSkipped",
      "RoundActivated",
      "RoundClosed",
      "BuyCredited",
      "BuyNotCredited",
      "RewardClaimed",
      // Decision 0146: S200 Hooks forward weight within a transaction.
      "CreditMoved",
    ],
  },
};

const poolManagerSwapEvent = getAbiItem({ abi: poolManagerAbi, name: "Swap" });
const poolRouterSwapEvent = getAbiItem({
  abi: officialPoolRouterAbi,
  name: "Swap",
});

function lower(value: string): string {
  return value.toLowerCase();
}

const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const zeroTopic = `0x${"0".repeat(64)}`;

/**
 * Decision 0129 §2 / 0132: the anchor tokens whose mint is not among the
 * logs (lower-case, unique; empty = every anchor is met).
 */
function missingMintAnchors(
  logs: readonly Log<bigint, number, false>[],
  anchors: readonly { readonly token: string; readonly blockNumber: bigint }[],
): string[] {
  const missing = new Set<string>();
  for (const anchor of anchors) {
    const met = logs.some(
      (log) =>
        lower(log.address) === lower(anchor.token) &&
        log.blockNumber === anchor.blockNumber &&
        lower(log.topics[0] ?? "") === transferTopic &&
        lower(log.topics[1] ?? "") === zeroTopic,
    );
    if (!met) missing.add(lower(anchor.token));
  }
  return [...missing].sort();
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
  /**
   * Test seam: one transport per endpoint instead of the RPC URL list
   * (the fallback runs over them, and Decision 0129 §2 asks them one by
   * one when an answer misses a mint anchor).
   */
  readonly endpointTransports?: readonly Transport[];
  readonly expectedChainId?: number;
  /** Address-filter batch size per `eth_getLogs`; default 8. */
  readonly maxAddressesPerLogQuery?: number;
}): Launch2Chain {
  if (
    input.rpcUrls.length === 0 &&
    input.transport === undefined &&
    (input.endpointTransports ?? []).length === 0
  ) {
    throw new Launch2ChainRefusedError("LAUNCH2_CHAIN_NOT_CONFIGURED");
  }
  const expectedChainId = input.expectedChainId ?? 97;
  const maxAddresses = Math.max(
    1,
    Math.floor(
      input.maxAddressesPerLogQuery ?? launch2DefaultMaxAddressesPerLogQuery,
    ),
  );
  const endpoints =
    input.endpointTransports ??
    input.rpcUrls.map((url) =>
      http(url, { timeout: 10_000, retryCount: 1, batch: { batchSize: 32 } }),
    );
  const transport =
    input.transport ?? fallback([...endpoints], { retryCount: 0 });
  const client = createPublicClient({
    chain: viemLaunchChain(expectedChainId),
    transport,
  });
  // Decision 0129 §2: one client per endpoint, asked in order when the
  // fallback's answer misses a mint anchor (an empty answer is a success to
  // the fallback transport, so it never moves on by itself).
  const singles =
    input.transport !== undefined
      ? []
      : endpoints.map((endpoint) =>
          createPublicClient({
            chain: viemLaunchChain(expectedChainId),
            transport: endpoint,
          }),
        );

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

  /**
   * Decision 0152 (loop-contracts Decision 0015): the curve's per-address
   * purchase cap — `maxCumulativeBuy()` (S209, a Factory parameter), or
   * the frozen `MAX_CUMULATIVE_BUY()` constant when the curve has no such
   * function (a revert / empty answer = a pre-S209 curve). RPC failures
   * propagate. Immutable either way.
   */
  async function curvePurchaseCap(
    curve: string,
    blockNumber: bigint | undefined,
  ): Promise<bigint> {
    const at = blockNumber === undefined ? {} : { blockNumber };
    try {
      return await client.readContract({
        address: curve as Address,
        abi: curveEngineAbi,
        functionName: "maxCumulativeBuy",
        ...at,
      });
    } catch (error) {
      if (!isLaunch2ContractRevert(error)) throw error;
    }
    return await client.readContract({
      address: curve as Address,
      abi: legacyS200CurveEngineAbi,
      functionName: "MAX_CUMULATIVE_BUY",
      ...at,
    });
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

    async getLogs({
      roles,
      fromBlock,
      toBlock,
      poolSwaps,
      routerSwaps,
      mintAnchors,
    }) {
      const pools = [...(poolSwaps ?? new Map<string, readonly string[]>())];
      const routerIds = routerSwaps?.poolIds ?? [];
      if (
        roles.size === 0 &&
        pools.every(([, ids]) => ids.length === 0) &&
        routerIds.length === 0
      ) {
        return { logs: [], ignored: 0, skippedForeign: 0 };
      }
      const addresses = [...roles.keys()] as Address[];
      let queries = 0;
      const addressLogs = async (
        reader: typeof client,
      ): Promise<Log<bigint, number, false>[]> => {
        const found: Log<bigint, number, false>[] = [];
        for (let i = 0; i < addresses.length; i += maxAddresses) {
          found.push(
            ...(await reader.getLogs({
              address: addresses.slice(i, i + maxAddresses),
              fromBlock,
              toBlock,
            })),
          );
        }
        return found;
      };
      queries += Math.ceil(addresses.length / maxAddresses);
      let raw = await addressLogs(client);
      const anchors = (mintAnchors ?? []).filter(
        (anchor) =>
          anchor.blockNumber >= fromBlock && anchor.blockNumber <= toBlock,
      );
      let untrusted = missingMintAnchors(raw, anchors);
      if (untrusted.length > 0) {
        // Decision 0132: the first endpoint answering every anchor wins;
        // else the answer missing the fewest, and the lane degrades only
        // the instances whose anchor is still missing.
        for (const single of singles) {
          try {
            const answer = await addressLogs(single);
            const missing = missingMintAnchors(answer, anchors);
            if (missing.length < untrusted.length) {
              raw = answer;
              untrusted = missing;
            }
            if (missing.length === 0) break;
          } catch {
            // This endpoint refused or failed; ask the next one.
          }
        }
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
      // Decision 0135: a log of an address outside the tracked set (an
      // endpoint answering beyond the filter) is skipped before decoding and
      // counted apart; `ignored` is a tracked address's unknown topic only.
      let skippedForeign = 0;
      for (const log of raw) {
        const role = poolRoles.get(lower(log.address));
        if (role === undefined) {
          skippedForeign += 1;
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
      return {
        logs,
        ignored,
        skippedForeign,
        ...(untrusted.length === 0 ? {} : { untrustedTokens: untrusted }),
      };
    },

    async readMemeBalances({ token, addresses, blockNumber }) {
      const readers = [client, ...singles];
      for (const reader of readers) {
        try {
          const [supply, ...balances] = await Promise.all([
            reader.readContract({
              address: token as Address,
              abi: erc20Abi,
              functionName: "totalSupply",
              blockNumber,
            }),
            ...addresses.map((holder) =>
              reader.readContract({
                address: token as Address,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [holder as Address],
                blockNumber,
              }),
            ),
          ]);
          const byAddress: Record<string, string> = {};
          addresses.forEach((holder, index) => {
            byAddress[lower(holder)] = (balances[index] ?? 0n).toString(10);
          });
          return {
            balances: Object.freeze(byAddress),
            totalSupply: supply.toString(10),
          };
        } catch {
          // Pruned state / refusal: the next endpoint.
        }
      }
      throw new Launch2ChainRefusedError("LAUNCH2_RPC_STATE_UNAVAILABLE");
    },

    async readMemeTransferAlternatives({ token, fromBlock, toBlock }) {
      const answers: Launch2DecodedLog[][] = [];
      for (const single of singles) {
        let found: Log<bigint, number, false>[];
        try {
          found = await single.getLogs({
            address: token as Address,
            fromBlock,
            toBlock,
          });
        } catch {
          continue;
        }
        const decodedLogs: Launch2DecodedLog[] = [];
        for (const log of found) {
          let decoded;
          try {
            decoded = decodeEventLog({
              abi: erc20Abi,
              data: log.data,
              topics: log.topics,
              strict: true,
            });
          } catch {
            continue;
          }
          if (decoded.eventName !== "Transfer") continue;
          const args: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            decoded.args as Record<string, unknown>,
          )) {
            args[key] = stringify(value);
          }
          decodedLogs.push({
            contractAddress: lower(log.address),
            eventName: "Transfer",
            args: Object.freeze(args),
            transactionHash: lower(log.transactionHash),
            logIndex: log.logIndex,
            blockNumber: log.blockNumber,
            blockHash: lower(log.blockHash),
          });
        }
        answers.push(decodedLogs);
      }
      return answers;
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
      const maxCumulativeBuy = await curvePurchaseCap(request.curve, at);
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
          maxCumulativeBuy,
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

    async readCurvePurchaseCap(curve) {
      return curvePurchaseCap(curve, undefined);
    },

    async readWalletBalances(request) {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = block.number;
      const tokenAbi = memeTokenAbi as Abi;
      const usd1 = await read<string>(
        request.curve,
        curveEngineAbi,
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

    async readTransactionParties(transactionHashes) {
      const parties = new Map<
        string,
        { readonly from: string; readonly to: string | null }
      >();
      // Batched by the transport (32 per HTTP request).
      const answers = await Promise.all(
        [...new Set(transactionHashes.map(lower))].map(async (hash) => {
          const transaction = await client.getTransaction({
            hash: hash as Hex,
          });
          return [
            hash,
            {
              from: lower(transaction.from),
              to: transaction.to === null ? null : lower(transaction.to),
            },
          ] as const;
        }),
      );
      for (const [hash, party] of answers) parties.set(hash, party);
      return parties;
    },

    async readDynamicHookPool(hook) {
      const [manager, meme, quote, trustedRouter] = await Promise.all([
        client.readContract({
          address: hook as Address,
          abi: loopDynamicHookAbi,
          functionName: "manager",
        }),
        client.readContract({
          address: hook as Address,
          abi: loopDynamicHookAbi,
          functionName: "meme",
        }),
        client.readContract({
          address: hook as Address,
          abi: loopDynamicHookAbi,
          functionName: "quote",
        }),
        client.readContract({
          address: hook as Address,
          abi: loopDynamicHookAbi,
          functionName: "trustedRouter",
        }),
      ]);
      const a = lower(meme);
      const b = lower(quote);
      return {
        poolManager: lower(manager),
        currency0: BigInt(a) < BigInt(b) ? a : b,
        trustedRouter: lower(trustedRouter),
      };
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
