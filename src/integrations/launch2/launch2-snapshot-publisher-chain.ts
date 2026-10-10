import {
  BaseError,
  BlockNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  encodeFunctionData,
  fallback,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import {
  Launch2PublisherRevertError,
  type Launch2PublishCall,
  type Launch2PublisherChain,
  type Launch2SnapshotMessage,
  type Launch2SnapshotSigner,
} from "../../features/launch2/launch2-snapshot-publisher.js";
import {
  classifyHooksLaunchSendError,
  revertReasonOf,
} from "../launch/hooks-launch-executor-chain.js";
import {
  projectNFTAbi,
  snapshotRegistryAbi,
} from "../launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0118: the snapshot publisher's BSC Testnet client and signer
 * keys. The submitter signs exactly one call shape — `publishSnapshot` on
 * an instance's `SnapshotRegistry` — locally (legacy, chain 97), so the
 * transaction hash is persisted before the bytes are sent. Snapshot signer
 * keys only produce EIP-712 `LOOP NFT Snapshot` v1 signatures. Keys live in
 * these closures only; no result, error, or log carries a key or RPC URL.
 */

export class Launch2PublisherChainRefusedError extends Error {
  constructor(readonly reasonCode: string) {
    super("The snapshot publisher chain client cannot be created");
    this.name = "Launch2PublisherChainRefusedError";
  }
}

/**
 * `isSnapshotSigner(address)` is a public mapping getter of
 * `SnapshotRegistry` that the generated selection (S134) does not carry;
 * the one-item fragment avoids regenerating the shared ABI module.
 */
const snapshotSignerAbi = parseAbi([
  "function isSnapshotSigner(address) view returns (bool)",
]);

const snapshotTypes = {
  Snapshot: [
    { name: "launchId", type: "bytes32" },
    { name: "nft", type: "address" },
    { name: "cutoffBlock", type: "uint256" },
    { name: "cutoffBlockHash", type: "bytes32" },
    { name: "dataHash", type: "bytes32" },
    { name: "root", type: "bytes32" },
  ],
} as const;

const lower = (value: string): string => value.toLowerCase();

function typedData(chainId: number, message: Launch2SnapshotMessage) {
  return {
    domain: {
      name: "LOOP NFT Snapshot",
      version: "1",
      chainId,
      verifyingContract: message.snapshots as Address,
    },
    types: snapshotTypes,
    primaryType: "Snapshot" as const,
    message: {
      launchId: message.launchId as Hex,
      nft: message.nft as Address,
      cutoffBlock: message.cutoffBlock,
      cutoffBlockHash: message.cutoffBlockHash as Hex,
      dataHash: message.dataHash as Hex,
      root: message.root as Hex,
    },
  };
}

export function createLaunch2SnapshotSigners(input: {
  readonly privateKeys: readonly `0x${string}`[];
  readonly chainId: number;
}): readonly Launch2SnapshotSigner[] {
  return Object.freeze(
    input.privateKeys.map((key) => {
      const account = privateKeyToAccount(key);
      return Object.freeze<Launch2SnapshotSigner>({
        address: lower(account.address),
        digest: (message) =>
          lower(hashTypedData(typedData(input.chainId, message))),
        sign: async (message) =>
          lower(await account.signTypedData(typedData(input.chainId, message))),
      });
    }),
  );
}

function publishData(call: Launch2PublishCall): Hex {
  return encodeFunctionData({
    abi: snapshotRegistryAbi,
    functionName: "publishSnapshot",
    args: [
      call.cutoffBlock,
      call.cutoffBlockHash as Hex,
      call.dataHash as Hex,
      call.root as Hex,
      call.signatures[0] as Hex,
      call.signatures[1] as Hex,
    ],
  });
}

export function createLaunch2PublisherChain(input: {
  readonly privateKey: `0x${string}`;
  readonly rpcUrls: readonly string[];
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
  readonly expectedChainId?: number;
}): Launch2PublisherChain {
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new Launch2PublisherChainRefusedError(
      "LAUNCH2_SNAPSHOT_RPC_NOT_CONFIGURED",
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
    args: readonly unknown[] = [],
    blockNumber?: bigint,
  ): Promise<T> {
    return (await client.readContract({
      address: address as Address,
      abi,
      functionName,
      args,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })) as T;
  }

  return Object.freeze<Launch2PublisherChain>({
    submitterAddress: lower(account.address),
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
    async registry(snapshots) {
      const S = snapshotRegistryAbi as Abi;
      const [nftSaleEnd, launchId, nft] = await Promise.all([
        read<bigint>(snapshots, S, "nftSaleEnd"),
        read<string>(snapshots, S, "launchId"),
        read<string>(snapshots, S, "nft"),
      ]);
      return {
        nftSaleEnd: BigInt(nftSaleEnd),
        launchId: lower(launchId),
        nft: lower(nft),
      };
    },
    registryRoot: async (snapshots) =>
      lower(await read<string>(snapshots, snapshotRegistryAbi, "root")),
    isSnapshotSigner: (snapshots, address) =>
      read<boolean>(snapshots, snapshotSignerAbi, "isSnapshotSigner", [
        address,
      ]),
    totalMintedAt: async (nft, blockNumber) =>
      BigInt(
        await read<bigint>(nft, projectNFTAbi, "totalMinted", [], blockNumber),
      ),
    snapshotDigest: async (call) =>
      lower(
        await read<string>(
          call.snapshots,
          snapshotRegistryAbi,
          "snapshotDigest",
          [call.cutoffBlock, call.cutoffBlockHash, call.dataHash, call.root],
        ),
      ),
    async estimatePublish(call) {
      // Simulate against the ABI first so a revert carries the contract
      // error name (estimateGas alone returns undecoded revert data).
      try {
        await client.simulateContract({
          account: account.address,
          address: call.snapshots as Address,
          abi: snapshotRegistryAbi,
          functionName: "publishSnapshot",
          args: [
            call.cutoffBlock,
            call.cutoffBlockHash as Hex,
            call.dataHash as Hex,
            call.root as Hex,
            call.signatures[0] as Hex,
            call.signatures[1] as Hex,
          ],
        });
      } catch (error) {
        const reason = revertReasonOf(error);
        if (reason !== null) throw new Launch2PublisherRevertError(reason);
        throw error;
      }
      try {
        return await client.estimateGas({
          account: account.address,
          to: call.snapshots as Address,
          data: publishData(call),
          value: 0n,
        });
      } catch (error) {
        const reason = revertReasonOf(error);
        if (reason !== null) throw new Launch2PublisherRevertError(reason);
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
    async signPublish(call, tx) {
      if (tx.nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Submitter nonce out of range");
      }
      const rawTx = await account.signTransaction({
        chainId,
        type: "legacy",
        to: call.snapshots as Address,
        data: publishData(call),
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
