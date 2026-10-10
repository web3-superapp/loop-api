import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  toFunctionSelector,
  type Abi,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { createLaunch2Chain } from "../src/integrations/launch2/launch2-chain.js";
import { legacyV2BuybackExecutorAbi } from "../src/integrations/launch/hooks-launch-protocol-abi-legacy-v2.js";
import {
  buybackExecutorAbi,
  nftEscrowAbi,
  snapshotRegistryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0122: the launch2 chain reader decodes each buyback executor
 * with its own generation's ABI (role `buybackExecutorV2` = the frozen v2
 * ABI), indexes `PublicRoundOpenedWithoutHolders`, and reads
 * `quoteNextOrder()` in either shape.
 */

const v2Executor = `0x${"a2".repeat(20)}`;
const v3Executor = `0x${"a3".repeat(20)}`;
const snapshots = `0x${"5b".repeat(20)}`;
const escrow = `0x${"e5".repeat(20)}`;
const blockHash = `0x${"bb".repeat(32)}`;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function log(
  address: string,
  topics: readonly Hex[],
  data: Hex,
  index: number,
) {
  return {
    address,
    topics,
    data,
    blockNumber: "0x10",
    blockHash,
    transactionHash: tx(index + 1),
    transactionIndex: "0x0",
    logIndex: `0x${index.toString(16)}`,
    removed: false,
  };
}

const latestBlock = {
  number: "0x10",
  hash: blockHash,
  timestamp: "0x3e8",
  parentHash: `0x${"00".repeat(32)}`,
  transactions: [],
  logsBloom: `0x${"00".repeat(256)}`,
  gasLimit: "0x1",
  gasUsed: "0x0",
  miner: `0x${"00".repeat(20)}`,
  difficulty: "0x0",
  extraData: "0x",
  nonce: "0x0000000000000000",
  sha3Uncles: `0x${"00".repeat(32)}`,
  stateRoot: `0x${"00".repeat(32)}`,
  receiptsRoot: `0x${"00".repeat(32)}`,
  transactionsRoot: `0x${"00".repeat(32)}`,
  size: "0x0",
  uncles: [],
};

function chainWith(handler: (method: string, params: unknown[]) => unknown) {
  return createLaunch2Chain({
    rpcUrls: [],
    transport: custom({
      request: ({ method, params }: { method: string; params?: unknown }) =>
        Promise.resolve(handler(method, (params ?? []) as unknown[])),
    }),
  });
}

describe("Decision 0122 launch2 chain reader by generation", () => {
  it("decodes the v2 and v3 BuybackCompleted with their own ABI and indexes the opening", async () => {
    const v2Topics = encodeEventTopics({
      abi: legacyV2BuybackExecutorAbi,
      eventName: "BuybackCompleted",
    }) as Hex[];
    const v3Topics = encodeEventTopics({
      abi: buybackExecutorAbi,
      eventName: "BuybackCompleted",
    }) as Hex[];
    const openedTopics = encodeEventTopics({
      abi: snapshotRegistryAbi,
      eventName: "PublicRoundOpenedWithoutHolders",
      args: { launchId: `0x${"11".repeat(32)}` },
    }) as Hex[];
    const logs = [
      log(
        v2Executor,
        v2Topics,
        encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint192" },
            { type: "uint192" },
            { type: "uint64" },
          ],
          [100n, 5n, 4n, 7n, 8n, 999n],
        ),
        0,
      ),
      log(
        v3Executor,
        v3Topics,
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
          [100n, 6n, 1000n],
        ),
        1,
      ),
      // A v3-shaped log from the v2 executor is not guessed.
      log(
        v2Executor,
        v3Topics,
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
          [1n, 1n, 1n],
        ),
        2,
      ),
      log(
        snapshots,
        openedTopics,
        encodeAbiParameters(
          [{ type: "uint64" }, { type: "uint64" }],
          [3_600n, 16n],
        ),
        3,
      ),
    ];
    const chain = chainWith((method) => {
      if (method === "eth_getLogs") return logs;
      throw new Error(`unexpected ${method}`);
    });
    const result = await chain.getLogs({
      roles: new Map([
        [v2Executor, "buybackExecutorV2"],
        [v3Executor, "buybackExecutor"],
        [snapshots, "snapshots"],
      ]),
      fromBlock: 16n,
      toBlock: 16n,
    });
    expect(result.ignored).toBe(1);
    expect(result.logs.map((entry) => [entry.eventName, entry.args])).toEqual([
      [
        "BuybackCompleted",
        {
          usd1Spent: "100",
          memeDelivered: "5",
          minMemeOut: "4",
          referencePrice: "7",
          spotPrice: "8",
          successfulAt: "999",
        },
      ],
      [
        "BuybackCompleted",
        { usd1Spent: "100", memeDelivered: "6", successfulAt: "1000" },
      ],
      [
        "PublicRoundOpenedWithoutHolders",
        {
          launchId: `0x${"11".repeat(32)}`,
          openedAt: "3600",
          openedBlock: "16",
        },
      ],
    ]);
  });

  it("reads quoteNextOrder as (amountIn, executable) on v3 and derives it on v2", async () => {
    const answer = (abi: Abi, quote: readonly unknown[]) => {
      const results = new Map<string, Hex>([
        [
          toFunctionSelector("paused()"),
          encodeFunctionResult({ abi, functionName: "paused", result: false }),
        ],
        [
          toFunctionSelector("lastSuccessfulAt()"),
          encodeFunctionResult({
            abi,
            functionName: "lastSuccessfulAt",
            result: 990n,
          }),
        ],
        [
          toFunctionSelector("availableBudget()"),
          encodeFunctionResult({
            abi: nftEscrowAbi,
            functionName: "availableBudget",
            result: 200n,
          }),
        ],
        [
          toFunctionSelector("totalRecorded()"),
          encodeFunctionResult({
            abi: nftEscrowAbi,
            functionName: "totalRecorded",
            result: 200n,
          }),
        ],
        [
          toFunctionSelector("totalSpent()"),
          encodeFunctionResult({
            abi: nftEscrowAbi,
            functionName: "totalSpent",
            result: 0n,
          }),
        ],
        [
          toFunctionSelector("quoteNextOrder()"),
          encodeFunctionResult({
            abi,
            functionName: "quoteNextOrder",
            result: quote,
          }),
        ],
      ]);
      return chainWith((method, params) => {
        if (method === "eth_getBlockByNumber") return latestBlock;
        if (method === "eth_call") {
          const call = params[0] as { data: Hex };
          const hit = results.get(call.data.slice(0, 10));
          if (hit === undefined) throw new Error(`no answer ${call.data}`);
          return hit;
        }
        throw new Error(`unexpected ${method}`);
      });
    };
    const v3 = await answer(buybackExecutorAbi, [100n, false]).readBuybackState(
      {
        buybackExecutor: v3Executor,
        escrow,
        generation: "v3",
      },
    );
    expect(v3).toMatchObject({
      blockTimestamp: 1000n,
      lastSuccessfulAt: 990n,
      nextOrderAmountIn: 100n,
      nextOrderExecutable: false,
    });
    const v2 = await answer(legacyV2BuybackExecutorAbi, [
      100n,
      50n,
      49n,
    ]).readBuybackState({
      buybackExecutor: v2Executor,
      escrow,
      generation: "v2",
    });
    expect(v2).toMatchObject({
      nextOrderAmountIn: 100n,
      nextOrderExecutable: true,
    });
  });
});
