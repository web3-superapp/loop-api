import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  http,
  keccak256,
  parseAbi,
  TransactionNotFoundError,
  type Address,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import {
  bscTestnetChainReference,
  type LaunchChainReference,
} from "../../features/chain/chain-contract.js";
import type {
  TestnetFaucetChain,
  TestnetFaucetTransferOutcome,
} from "../../features/testnet-faucet/testnet-faucet-contract.js";
import { erc20IdentityAbi } from "./erc20-abi.js";
import { isBscRpcTransportError } from "./rpc-client.js";

/**
 * Decision 0128: the faucet's operator account on BSC Testnet. It signs
 * exactly two shapes: a plain tBNB transfer and `MockUSD1.mint(to, amount)`.
 * Every transaction is signed locally first so its hash is known (and
 * stored by the caller) before the broadcast; a broadcast error is resolved
 * by asking the node for that hash. Receipt waits are bounded. The key never
 * reaches a log or an error. BSC Mainnet is refused at construction.
 */

export const mockUsd1MintAbi = parseAbi([
  "function mint(address to, uint256 amount)",
]);

export class TestnetFaucetChainRefusedError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "TestnetFaucetChainRefusedError";
  }
}

/** Plain transfer gas (no calldata, EOA recipient). */
export const nativeTransferGas = 21_000n;

export function createTestnetFaucetChain(input: {
  readonly privateKey: `0x${string}`;
  readonly chainReference: LaunchChainReference;
  readonly rpcUrls: readonly string[];
  readonly receiptTimeoutMs?: number;
  readonly pollingIntervalMs?: number;
  readonly transport?: Transport;
}): TestnetFaucetChain {
  if (input.chainReference !== bscTestnetChainReference) {
    throw new TestnetFaucetChainRefusedError("TESTNET_FAUCET_WRONG_CHAIN");
  }
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new TestnetFaucetChainRefusedError(
      "TESTNET_FAUCET_RPC_NOT_CONFIGURED",
    );
  }
  const chain: Chain = bscTestnet;
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) => http(url, { timeout: 4_000, retryCount: 0 })),
      { retryCount: 0 },
    );
  const account = privateKeyToAccount(input.privateKey);
  const wallet = createWalletClient({ account, chain, transport });
  const reader = createPublicClient({
    chain,
    transport,
    pollingInterval: input.pollingIntervalMs ?? 500,
  });
  const receiptTimeoutMs = input.receiptTimeoutMs ?? 4_500;

  async function send(
    request: {
      readonly to: Address;
      readonly value: bigint;
      readonly data?: Hex;
      readonly gas: bigint;
    },
    onSigned: (transactionHash: string) => Promise<void>,
  ): Promise<TestnetFaucetTransferOutcome> {
    let serialized: Hex;
    try {
      const prepared = await wallet.prepareTransactionRequest({
        account,
        chain,
        to: request.to,
        value: request.value,
        gas: request.gas,
        ...(request.data === undefined ? {} : { data: request.data }),
      });
      serialized = await wallet.signTransaction(prepared);
    } catch {
      return { status: "not_sent" };
    }
    const hash = keccak256(serialized).toLowerCase() as Hex;
    // The caller's write failing means nothing was broadcast.
    await onSigned(hash);
    try {
      await reader.sendRawTransaction({ serializedTransaction: serialized });
    } catch {
      try {
        await reader.getTransaction({ hash });
      } catch (error) {
        return error instanceof TransactionNotFoundError
          ? { status: "not_sent" }
          : { status: "unconfirmed", transactionHash: hash };
      }
    }
    try {
      const receipt = await reader.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: receiptTimeoutMs,
      });
      return receipt.status === "success"
        ? { status: "confirmed", transactionHash: hash }
        : { status: "reverted", transactionHash: hash };
    } catch {
      return { status: "unconfirmed", transactionHash: hash };
    }
  }

  const faucetChain: TestnetFaucetChain = {
    operatorAddress: account.address.toLowerCase(),
    async readUsd1Decimals(usd1: string): Promise<number> {
      const decimals = await reader.readContract({
        address: usd1 as Address,
        abi: erc20IdentityAbi,
        functionName: "decimals",
      });
      return Number(decimals);
    },
    async estimateMintGas(estimate) {
      try {
        const gas = await reader.estimateGas({
          account: account.address,
          to: estimate.usd1 as Address,
          data: encodeFunctionData({
            abi: mockUsd1MintAbi,
            functionName: "mint",
            args: [estimate.to as Address, estimate.amountRaw],
          }),
        });
        return { kind: "ok" as const, gas };
      } catch (error) {
        if (isBscRpcTransportError(error)) {
          throw error;
        }
        return { kind: "reverted" as const };
      }
    },
    readGasPrice(): Promise<bigint> {
      return reader.getGasPrice();
    },
    readOperatorBalance(): Promise<bigint> {
      return reader.getBalance({ address: account.address });
    },
    sendNative(transfer) {
      return send(
        {
          to: transfer.to as Address,
          value: transfer.valueWei,
          gas: nativeTransferGas,
        },
        transfer.onSigned,
      );
    },
    sendMint(mint) {
      return send(
        {
          to: mint.usd1 as Address,
          value: 0n,
          gas: mint.gas,
          data: encodeFunctionData({
            abi: mockUsd1MintAbi,
            functionName: "mint",
            args: [mint.to as Address, mint.amountRaw],
          }),
        },
        mint.onSigned,
      );
    },
  };
  return Object.freeze(faucetChain);
}
