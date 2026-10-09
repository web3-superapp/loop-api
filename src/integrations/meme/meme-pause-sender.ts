import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
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
import { encodeMemePauseCalldata } from "./meme-contract-adapter.js";
import { MemeGraduationSenderRefusedError } from "./meme-graduation-sender.js";

/**
 * The operator console's pause/unpause signer (Decision 0102). It signs
 * exactly two call shapes, `pause(token)` and `unpause(token)` on the
 * configured curve. Decision 0105: it signs with its own key,
 * `MEME_OPERATOR_PRIVATE_KEY`, never the deployer key the graduation
 * fallback uses, so the two never race for one nonce. The curve is
 * `Ownable`: the operator address must own it (transferOwnership +
 * acceptOwnership), otherwise every dry run reverts. Testnet only: BSC
 * Mainnet signing stays closed.
 *
 * A dry run comes first; a revert (already paused, not the owner, unknown
 * token) is reported without broadcasting. A broadcast transaction is
 * reported as `submitted` with its hash — the request does not wait for
 * the receipt; the `meme_event` lane indexes the `Paused` / `Unpaused` log
 * and moves the token status. The key never reaches a log or an error.
 */

export type MemePauseAction = "pause" | "unpause";

export type MemePauseOutcome =
  | { readonly status: "submitted"; readonly transactionHash: string }
  | { readonly status: "simulation_reverted" }
  | { readonly status: "failed"; readonly errorCode: string };

/**
 * Decision 0105: where a broadcast transaction stands. `pending` = known to
 * the node but not mined; `settled` = mined (either way) or dropped;
 * `unknown` = the read failed (callers treat it as pending).
 */
export type MemePauseTransactionState = "pending" | "settled" | "unknown";

export interface MemePauseSender {
  /** Lowercase address of the executor account. */
  readonly address: string;
  submit(action: MemePauseAction, token: string): Promise<MemePauseOutcome>;
  transactionState(hash: string): Promise<MemePauseTransactionState>;
}

export function createMemePauseSender(input: {
  readonly privateKey: `0x${string}`;
  readonly curveAddress: string;
  readonly chainReference: LaunchChainReference;
  readonly rpcUrls: readonly string[];
  readonly transport?: Transport;
}): MemePauseSender {
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
      input.rpcUrls.map((url) => http(url, { timeout: 8_000, retryCount: 0 })),
      { retryCount: 0 },
    );
  const account = privateKeyToAccount(input.privateKey);
  const wallet = createWalletClient({ account, chain, transport });
  const reader = createPublicClient({ chain, transport });
  const curve = input.curveAddress.toLowerCase() as Address;
  return Object.freeze({
    address: account.address.toLowerCase(),
    async submit(
      action: MemePauseAction,
      token: string,
    ): Promise<MemePauseOutcome> {
      const data = encodeMemePauseCalldata(action, token);
      try {
        await reader.call({ account: account.address, to: curve, data });
      } catch {
        return { status: "simulation_reverted" };
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
      } catch {
        return { status: "failed", errorCode: "MEME_PAUSE_BROADCAST_FAILED" };
      }
      return { status: "submitted", transactionHash: hash.toLowerCase() };
    },
    async transactionState(hash: string): Promise<MemePauseTransactionState> {
      if (!/^0x[0-9a-f]{64}$/u.test(hash)) {
        return "unknown";
      }
      try {
        await reader.getTransactionReceipt({ hash: hash as Hex });
        return "settled";
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) {
          return "unknown";
        }
      }
      try {
        await reader.getTransaction({ hash: hash as Hex });
        return "pending";
      } catch (error) {
        return error instanceof TransactionNotFoundError
          ? "settled"
          : "unknown";
      }
    },
  });
}
