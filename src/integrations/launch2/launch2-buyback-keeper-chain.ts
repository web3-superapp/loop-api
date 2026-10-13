import {
  BaseError,
  BlockNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  encodeFunctionData,
  fallback,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import {
  Launch2KeeperRevertError,
  type Launch2BuybackKeeperChain,
} from "../../features/launch2/launch2-buyback-keeper.js";
import {
  classifyHooksLaunchSendError,
  revertReasonOf,
} from "../launch/hooks-launch-executor-chain.js";
import {
  buybackExecutorAbi,
  loopDynamicBuybackAdapterAbi,
  loopDynamicHookAbi,
  loopLaunchFactoryAbi,
  loopRouterAbi,
  nftEscrowAbi,
} from "../launch/hooks-launch-protocol-abi.generated.js";
import { legacyV2BuybackExecutorAbi } from "../launch/hooks-launch-protocol-abi-legacy-v2.js";

/**
 * Decision 0121: the buyback keeper's BSC Testnet client. The keeper key
 * signs exactly one call shape — `BuybackExecutor.execute()` (no
 * arguments, no value) — locally (legacy, chain 97), so the transaction
 * hash is persisted before the bytes are sent. The key lives in this
 * closure only; no result, error, or log carries it or an RPC URL.
 */

export class Launch2KeeperChainRefusedError extends Error {
  constructor(readonly reasonCode: string) {
    super("The buyback keeper chain client cannot be created");
    this.name = "Launch2KeeperChainRefusedError";
  }
}

const lower = (value: string): string => value.toLowerCase();

/**
 * `execute()` reverts inside the escrow too (`BudgetExceeded`); its error
 * items join the executor ABI so the simulation decodes either name.
 * Decision 0122: the v2 generation's protection errors
 * (`ReferenceUnavailable`, `SpotOutsideProtection`,
 * `OutputBelowProtection`) join too — `execute()` has the same selector in
 * both generations and errors decode by selector, so one ABI names a
 * refusal of either executor.
 */
const executeAbi = [
  ...buybackExecutorAbi,
  // Decision 0131: a LoopDynamic executor swaps through
  // LoopDynamicBuybackAdapter → LoopRouter → the Hook; their errors decode
  // too (the executor's adapter is bound per instance).
  ...[
    ...legacyV2BuybackExecutorAbi,
    ...nftEscrowAbi,
    ...loopDynamicBuybackAdapterAbi,
    ...loopRouterAbi,
    ...loopDynamicHookAbi,
  ].filter(
    (item, index, all) =>
      item.type === "error" &&
      !buybackExecutorAbi.some(
        (own) => own.type === "error" && own.name === item.name,
      ) &&
      all.findIndex(
        (other) => other.type === "error" && other.name === item.name,
      ) === index,
  ),
] as Abi;

const executeData: Hex = encodeFunctionData({
  abi: buybackExecutorAbi,
  functionName: "execute",
});

export function createLaunch2BuybackKeeperChain(input: {
  readonly privateKey: `0x${string}`;
  readonly rpcUrls: readonly string[];
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
  readonly expectedChainId?: number;
}): Launch2BuybackKeeperChain {
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new Launch2KeeperChainRefusedError(
      "LAUNCH2_BUYBACK_KEEPER_RPC_NOT_CONFIGURED",
    );
  }
  const chainId = input.expectedChainId ?? 97;
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) =>
        http(url, { timeout: 10_000, retryCount: 1, batch: { batchSize: 32 } }),
      ),
      { retryCount: 0 },
    );
  const account = privateKeyToAccount(input.privateKey);
  const client = createPublicClient({ chain: bscTestnet, transport });

  async function read<T>(
    address: string,
    abi: Abi,
    functionName: string,
    blockNumber?: bigint,
  ): Promise<T> {
    return (await client.readContract({
      address: address as Address,
      abi,
      functionName,
      args: [],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })) as T;
  }

  return Object.freeze<Launch2BuybackKeeperChain>({
    keeperAddress: lower(account.address),
    chainId: () => client.getChainId(),
    async head() {
      const block = await client.getBlock({ blockTag: "latest" });
      return {
        number: block.number,
        hash: lower(block.hash),
        timestamp: block.timestamp,
      };
    },
    async block(blockNumber) {
      try {
        const block = await client.getBlock({ blockNumber });
        return { hash: lower(block.hash), timestamp: block.timestamp };
      } catch (error) {
        if (
          error instanceof BaseError &&
          error.walk((cause) => cause instanceof BlockNotFoundError) !== null
        ) {
          return null;
        }
        throw error;
      }
    },
    async factoryKeepers(factory) {
      const F = loopLaunchFactoryAbi as Abi;
      const [primary, fallbackKeeper] = await Promise.all([
        read<string>(factory, F, "primaryKeeper"),
        read<string>(factory, F, "fallbackKeeper"),
      ]);
      return { primary: lower(primary), fallback: lower(fallbackKeeper) };
    },
    async executorFacts(executor) {
      const E = buybackExecutorAbi as Abi;
      const [primary, fallbackKeeper, budget, orderAmount, interval] =
        await Promise.all([
          read<string>(executor, E, "primaryKeeper"),
          read<string>(executor, E, "fallbackKeeper"),
          read<string>(executor, E, "budget"),
          read<bigint>(executor, E, "ORDER_AMOUNT"),
          read<bigint>(executor, E, "MIN_SUCCESS_INTERVAL"),
        ]);
      return {
        primaryKeeper: lower(primary),
        fallbackKeeper: lower(fallbackKeeper),
        budget: lower(budget),
        orderAmount: BigInt(orderAmount),
        minSuccessInterval: BigInt(interval),
      };
    },
    async executorState(executor, escrow) {
      const block = await client.getBlock({ blockTag: "latest" });
      const E = buybackExecutorAbi as Abi;
      const [paused, lastSuccessfulAt, availableBudget] = await Promise.all([
        read<boolean>(executor, E, "paused", block.number),
        read<bigint>(executor, E, "lastSuccessfulAt", block.number),
        read<bigint>(
          escrow,
          nftEscrowAbi as Abi,
          "availableBudget",
          block.number,
        ),
      ]);
      return {
        blockTimestamp: block.timestamp,
        paused,
        lastSuccessfulAt: BigInt(lastSuccessfulAt),
        availableBudget: BigInt(availableBudget),
      };
    },
    async estimateExecute(executor) {
      // Simulate against the ABI first so a refusal carries the contract
      // error name (estimateGas alone returns undecoded revert data).
      try {
        await client.simulateContract({
          account: account.address,
          address: executor as Address,
          abi: executeAbi,
          functionName: "execute",
          args: [],
        });
      } catch (error) {
        const reason = revertReasonOf(error);
        if (reason !== null) throw new Launch2KeeperRevertError(reason);
        throw error;
      }
      try {
        return await client.estimateGas({
          account: account.address,
          to: executor as Address,
          data: executeData,
          value: 0n,
        });
      } catch (error) {
        const reason = revertReasonOf(error);
        if (reason !== null) throw new Launch2KeeperRevertError(reason);
        throw error;
      }
    },
    gasPrice: () => client.getGasPrice(),
    async pendingNonce() {
      return BigInt(
        await client.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
      );
    },
    async signExecute(executor, tx) {
      if (tx.nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Keeper nonce out of range");
      }
      const rawTx = await account.signTransaction({
        chainId,
        type: "legacy",
        to: executor as Address,
        data: executeData,
        value: 0n,
        nonce: Number(tx.nonce),
        gas: tx.gas,
        gasPrice: tx.gasPrice,
      });
      return { txHash: lower(keccak256(rawTx)), rawTx: lower(rawTx) };
    },
    async sendRaw(rawTx) {
      try {
        await client.sendRawTransaction({
          serializedTransaction: rawTx as Hex,
        });
        return "accepted";
      } catch (error) {
        return classifyHooksLaunchSendError(error);
      }
    },
    async receipt(txHash) {
      try {
        const receipt = await client.getTransactionReceipt({
          hash: txHash as Hex,
        });
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: lower(receipt.blockHash),
        };
      } catch (error) {
        if (
          error instanceof BaseError &&
          error.walk(
            (cause) => cause instanceof TransactionReceiptNotFoundError,
          ) !== null
        ) {
          return null;
        }
        throw error;
      }
    },
  });
}
