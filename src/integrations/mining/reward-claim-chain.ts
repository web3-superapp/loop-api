import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { bsc, bscTestnet } from "viem/chains";

import type {
  MiningClaimChain,
  MiningClaimedLog,
} from "../../features/mining/hourly-settlement-ports.js";
import { loopRewardClaimAbi } from "./loop-reward-claim-abi.js";

/**
 * Decision 0116: `LoopRewardClaim` reads on the launch slot (BSC Testnet in
 * Development). Every read of one answer is pinned to one block. A
 * `Claimed` log is decoded with the ABI; a log that does not decode is not
 * a claim. It never signs or sends.
 */

function lower(value: string): string {
  return value.toLowerCase();
}

export function createMiningRewardClaimChain(input: {
  readonly rpcUrls: readonly string[];
  readonly chainReference: 56 | 97;
  /** Test seam (anvil / fake transport). */
  readonly transport?: Transport;
}): MiningClaimChain {
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new Error("MINING_CLAIM_CHAIN_NOT_CONFIGURED");
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

  async function read<T>(
    contract: string,
    functionName: "claimed" | "nonces" | "paused" | "balance" | "liabilityHint",
    args: readonly unknown[],
    blockNumber: bigint,
  ): Promise<T> {
    return (await client.readContract({
      address: contract,
      abi: loopRewardClaimAbi,
      functionName,
      args,
      blockNumber,
    } as never)) satisfies unknown as T;
  }

  function decodeClaimed(
    contract: string,
    log: {
      readonly address: string;
      readonly data: Hex;
      readonly topics: readonly Hex[];
      readonly transactionHash: Hex | null;
      readonly blockNumber: bigint | null;
    },
  ): MiningClaimedLog | null {
    if (lower(log.address) !== lower(contract)) return null;
    try {
      const decoded = decodeEventLog({
        abi: loopRewardClaimAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = decoded.args as {
        wallet: string;
        amount: bigint;
        cumulativeAmount: bigint;
        nonce: bigint;
      };
      return Object.freeze({
        transactionHash: lower(log.transactionHash ?? ""),
        blockNumber: log.blockNumber ?? 0n,
        wallet: lower(args.wallet),
        amountRaw: args.amount,
        cumulativeAmountRaw: args.cumulativeAmount,
        nonce: args.nonce,
      });
    } catch {
      return null;
    }
  }

  return Object.freeze<MiningClaimChain>({
    chainReference: input.chainReference,

    async readClaimState({ contract, wallet, otherWallets }) {
      const blockNumber = await client.getBlockNumber();
      const wallets = [
        ...new Set([lower(wallet), ...otherWallets.map(lower)]),
      ].sort();
      const [nonce, paused, balance, ...claimed] = await Promise.all([
        read<bigint>(contract, "nonces", [wallet], blockNumber),
        read<boolean>(contract, "paused", [], blockNumber),
        read<bigint>(contract, "balance", [], blockNumber),
        ...wallets.map((address) =>
          read<bigint>(contract, "claimed", [address], blockNumber),
        ),
      ]);
      return Object.freeze({
        blockNumber,
        nonce,
        paused,
        contractBalanceRaw: balance,
        claimedByWallet: new Map(
          wallets.map((address, index) => [address, claimed[index] as bigint]),
        ),
      });
    },

    async readFunding(contract) {
      const blockNumber = await client.getBlockNumber();
      const [balance, paused] = await Promise.all([
        read<bigint>(contract, "balance", [], blockNumber),
        read<boolean>(contract, "paused", [], blockNumber),
      ]);
      const hint = await read<bigint>(
        contract,
        "liabilityHint",
        [],
        blockNumber,
      ).catch(() => null);
      return Object.freeze({
        blockNumber,
        balanceRaw: balance,
        liabilityHintRaw: hint,
        paused,
      });
    },

    async readReceipt({ contract, transactionHash }) {
      const receipt = await client
        .getTransactionReceipt({ hash: transactionHash as Hex })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /could not be found|not found/iu.test(error.message)
          ) {
            return null;
          }
          throw error;
        });
      if (receipt === null) return Object.freeze({ kind: "not_found" });
      if (receipt.status === "reverted") {
        return Object.freeze({
          kind: "reverted",
          blockNumber: receipt.blockNumber,
        });
      }
      const head = await client.getBlockNumber();
      const logs = receipt.logs
        .map((log) =>
          decodeClaimed(contract, {
            address: log.address,
            data: log.data,
            topics: log.topics,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
          }),
        )
        .filter((log): log is MiningClaimedLog => log !== null);
      return Object.freeze({
        kind: "mined",
        blockNumber: receipt.blockNumber,
        confirmations:
          head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n,
        logs: Object.freeze(logs),
      });
    },

    async findClaimedLog({ contract, wallet, nonce, fromBlock, toBlock }) {
      const logs = await client.getLogs({
        address: contract as Address,
        event: loopRewardClaimAbi[6],
        args: { wallet: wallet as Address },
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        const decoded = decodeClaimed(contract, {
          address: log.address,
          data: log.data,
          topics: log.topics,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
        });
        if (
          decoded !== null &&
          decoded.wallet === lower(wallet) &&
          decoded.nonce === nonce
        ) {
          return decoded;
        }
      }
      return null;
    },

    async readNonce({ contract, wallet }) {
      const blockNumber = await client.getBlockNumber();
      const nonce = await read<bigint>(
        contract,
        "nonces",
        [wallet],
        blockNumber,
      );
      return Object.freeze({ nonce, blockNumber });
    },
  });
}
