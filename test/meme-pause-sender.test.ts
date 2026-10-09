import { custom } from "viem";
import { describe, expect, it } from "vitest";

import { bscTestnetChainReference } from "../src/features/chain/chain-contract.js";
import { createMemePauseSender } from "../src/integrations/meme/meme-pause-sender.js";

/**
 * Decision 0105: the operator signer reports where a broadcast pause stands
 * (pending / settled / unknown) from the receipt and the mempool.
 */

const hash = `0x${"ab".repeat(32)}`;

function sender(
  answer: (method: string) => unknown,
): ReturnType<typeof createMemePauseSender> {
  return createMemePauseSender({
    privateKey: `0x${"11".repeat(32)}`,
    curveAddress: "0x00000000000000000000000000000000000000c1",
    chainReference: bscTestnetChainReference,
    rpcUrls: [],
    transport: custom({
      request: ({ method }: { method: string }) => {
        const value = answer(method);
        return value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value);
      },
    }),
  });
}

describe("MemePauseSender.transactionState (Decision 0105)", () => {
  it("is settled once a receipt exists", async () => {
    const state = await sender((method) =>
      method === "eth_getTransactionReceipt"
        ? {
            transactionHash: hash,
            blockHash: `0x${"cd".repeat(32)}`,
            blockNumber: "0x10",
            transactionIndex: "0x0",
            from: "0x00000000000000000000000000000000000000e5",
            to: "0x00000000000000000000000000000000000000c1",
            cumulativeGasUsed: "0x1",
            gasUsed: "0x1",
            effectiveGasPrice: "0x1",
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            type: "0x0",
          }
        : null,
    ).transactionState(hash);
    expect(state).toBe("settled");
  });

  it("is pending while the node knows the transaction but has no receipt", async () => {
    const state = await sender((method) =>
      method === "eth_getTransactionByHash"
        ? {
            hash,
            blockHash: null,
            blockNumber: null,
            transactionIndex: null,
            from: "0x00000000000000000000000000000000000000e5",
            to: "0x00000000000000000000000000000000000000c1",
            input: "0x",
            value: "0x0",
            gas: "0x5208",
            gasPrice: "0x1",
            nonce: "0x0",
            v: "0x1b",
            r: "0x1",
            s: "0x1",
            type: "0x0",
            chainId: "0x61",
          }
        : null,
    ).transactionState(hash);
    expect(state).toBe("pending");
  });

  it("is settled when the transaction was dropped, unknown when the RPC fails", async () => {
    expect(await sender(() => null).transactionState(hash)).toBe("settled");
    expect(
      await sender(() => new Error("rpc down")).transactionState(hash),
    ).toBe("unknown");
    expect(await sender(() => null).transactionState("0x12")).toBe("unknown");
  });
});
