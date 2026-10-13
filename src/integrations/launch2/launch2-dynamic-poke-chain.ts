import {
  createPublicClient,
  fallback,
  http,
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import { encodeLaunch2DynamicPoke } from "../../features/launch2/launch2-dynamic.js";
import type { Launch2DynamicPokeChain } from "../../features/launch2/launch2-dynamic-poke.js";
import { revertReasonOf } from "../launch/hooks-launch-executor-chain.js";
import { loopDynamicHookAbi } from "../launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0131: the `poke()` keeper's BSC Testnet client. It signs exactly
 * one call shape — `LoopDynamicHook.poke()` (no arguments, no value) —
 * locally (legacy, chain 97), with a 1.2× gas estimate, and waits for the
 * receipt. The key lives in this closure only; no result, error or log
 * carries it or an RPC URL.
 */

const lower = (value: string): string => value.toLowerCase();
const pokeData: Hex = encodeLaunch2DynamicPoke();
/** Name-addressed reads (`functionName: string`). */
const hookAbi = loopDynamicHookAbi as Abi;

export function createLaunch2DynamicPokeChain(input: {
  readonly privateKey: `0x${string}`;
  readonly rpcUrls: readonly string[];
  readonly transport?: Transport;
  readonly receiptTimeoutMs?: number;
}): Launch2DynamicPokeChain {
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new Error("LAUNCH2_DYNAMIC_POKE_RPC_NOT_CONFIGURED");
  }
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

  return Object.freeze<Launch2DynamicPokeChain>({
    pokerAddress: lower(account.address),
    chainId: () => client.getChainId(),
    async readPokeState(hook) {
      const block = await client.getBlock({ blockTag: "latest" });
      const read = <T>(functionName: string) =>
        client.readContract({
          address: hook as Address,
          abi: hookAbi,
          functionName,
          blockNumber: block.number,
        }) as Promise<T>;
      const [armed, initialized, candleId] = await Promise.all([
        read<boolean>("armed"),
        read<boolean>("initialized"),
        read<bigint>("candleId"),
      ]);
      return { armed, initialized, candleId, blockTimestamp: block.timestamp };
    },
    async simulatePoke(hook) {
      try {
        await client.call({
          account: account.address,
          to: hook as Address,
          data: pokeData,
        });
        return null;
      } catch (error) {
        return revertReasonOf(error) ?? "LAUNCH2_DYNAMIC_POKE_REVERTED";
      }
    },
    async sendPoke(hook) {
      const [gas, gasPrice, nonce] = await Promise.all([
        client.estimateGas({
          account: account.address,
          to: hook as Address,
          data: pokeData,
          value: 0n,
        }),
        client.getGasPrice(),
        client.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
      ]);
      const rawTx = await account.signTransaction({
        chainId: 97,
        type: "legacy",
        to: hook as Address,
        data: pokeData,
        value: 0n,
        nonce,
        gas: (gas * 12n) / 10n,
        gasPrice,
      });
      const hash = await client.sendRawTransaction({
        serializedTransaction: rawTx,
      });
      const receipt = await client.waitForTransactionReceipt({
        hash,
        timeout: input.receiptTimeoutMs ?? 60_000,
      });
      return { transactionHash: lower(hash), status: receipt.status };
    },
  });
}
