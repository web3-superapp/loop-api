import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
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
import { encodeMemeGraduateCalldata } from "./meme-contract-adapter.js";

/**
 * The graduation fallback executor's signer (Decision 0101, docs/10 §1:
 * "LOOP worker 60 秒内兜底调用"). It signs exactly one call shape,
 * `graduate(token)` on the configured curve, with the testnet deployer key
 * (`LAUNCH_DEPLOYER_PRIVATE_KEY`). It refuses mainnet: BSC Mainnet signing
 * stays closed. The key lives in this closure only; no error, result, or log
 * field ever carries it or an endpoint URL.
 */

export type MemeGraduationOutcome =
  | { readonly status: "confirmed"; readonly transactionHash: string }
  | { readonly status: "reverted"; readonly transactionHash: string }
  | { readonly status: "not_full" }
  | { readonly status: "failed"; readonly errorCode: string };

export interface MemeGraduationSender {
  /** Lowercase address of the executor account. */
  readonly address: string;
  graduate(token: string): Promise<MemeGraduationOutcome>;
}

export class MemeGraduationSenderRefusedError extends Error {
  readonly code = "meme_graduation_sender_refused";

  constructor(readonly reasonCode: string) {
    super("The MEME graduation sender cannot be created");
    this.name = "MemeGraduationSenderRefusedError";
  }
}

const receiptTimeoutMs = 60_000;

function errorCodeOf(error: unknown): string {
  if (error instanceof Error) {
    if (/NotFull/u.test(error.message)) {
      return "MEME_GRADUATE_NOT_FULL";
    }
    return `MEME_GRADUATE_${
      error.name
        .replace(/[^A-Za-z0-9]/gu, "")
        .toUpperCase()
        .slice(0, 40) || "FAILED"
    }`;
  }
  return "MEME_GRADUATE_FAILED";
}

export function createMemeGraduationSender(input: {
  readonly privateKey: `0x${string}`;
  readonly curveAddress: string;
  readonly chainReference: LaunchChainReference;
  readonly rpcUrls: readonly string[];
  readonly transport?: Transport;
}): MemeGraduationSender {
  if (input.chainReference !== bscTestnetChainReference) {
    throw new MemeGraduationSenderRefusedError("MEME_MAINNET_SIGNING_CLOSED");
  }
  if (input.rpcUrls.length === 0 && input.transport === undefined) {
    throw new MemeGraduationSenderRefusedError("MEME_CHAIN_RPC_NOT_CONFIGURED");
  }
  const chain: Chain = bscTestnet;
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 0 })),
      { retryCount: 0 },
    );
  const account = privateKeyToAccount(input.privateKey);
  const wallet = createWalletClient({ account, chain, transport });
  const reader = createPublicClient({ chain, transport });
  const curve = input.curveAddress.toLowerCase() as Address;
  return Object.freeze({
    address: account.address.toLowerCase(),
    async graduate(token: string): Promise<MemeGraduationOutcome> {
      const data = encodeMemeGraduateCalldata(token);
      try {
        // A dry run first: NotFull means someone else already graduated it.
        await reader.call({ account: account.address, to: curve, data });
      } catch (error) {
        const code = errorCodeOf(error);
        return code === "MEME_GRADUATE_NOT_FULL"
          ? { status: "not_full" }
          : {
              status: "failed",
              errorCode: "MEME_GRADUATE_SIMULATION_REVERTED",
            };
      }
      let hash: Hex;
      try {
        hash = await wallet.sendTransaction({
          account,
          chain,
          to: curve,
          data,
          value: 0n,
        });
      } catch (error) {
        return { status: "failed", errorCode: errorCodeOf(error) };
      }
      try {
        const receipt = await reader.waitForTransactionReceipt({
          hash,
          timeout: receiptTimeoutMs,
        });
        return receipt.status === "success"
          ? { status: "confirmed", transactionHash: hash.toLowerCase() }
          : { status: "reverted", transactionHash: hash.toLowerCase() };
      } catch {
        return { status: "failed", errorCode: "MEME_GRADUATE_RECEIPT_TIMEOUT" };
      }
    },
  });
}
