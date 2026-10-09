import { custom, type Transport } from "viem";
import { describe, expect, it } from "vitest";

import {
  createLaunchContractAdapter,
  launchContractMaximumLogRange,
} from "../src/integrations/launch/launch-contract-adapter.js";
import {
  fixtureBlockHash,
  fixtureLog,
} from "./helpers/launch-lane-fixtures.js";
import {
  mockLaunchpadAddress,
  mockUsd1Address,
} from "./helpers/launchpad-mock-chain.js";

/** Decision 0077 adapter additions: readLogs and readBlock (fixtures only). */

function adapterWith(
  handler: (method: string, params: readonly unknown[]) => unknown,
) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const transport = (): Transport =>
    custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        const list = (params ?? []) as readonly unknown[];
        calls.push({ method, params: list });
        if (method === "eth_chainId") return Promise.resolve("0x61");
        if (method === "eth_getCode") return Promise.resolve("0x6080");
        return Promise.resolve(handler(method, list));
      },
    });
  const adapter = createLaunchContractAdapter({
    contract: {
      address: mockLaunchpadAddress,
      version: "1.0.0",
      versionMajor: 1,
      startBlock: 1n,
      usd1Address: mockUsd1Address,
    },
    chain: {
      chainId: "eip155:97",
      chainReference: 97,
      rpcUrls: ["https://launch.invalid/"],
    },
    verifyChain: () => Promise.resolve("verified"),
    transportFactory: transport,
  });
  return { adapter, calls };
}

describe("launch adapter log and block reads (Decision 0077)", () => {
  it("reads the configured contract's logs over an inclusive range and decodes them", async () => {
    const log = fixtureLog(
      "Paused",
      { saleId: 3n, by: mockLaunchpadAddress },
      { block: 150n, logIndex: 2 },
    );
    const { adapter, calls } = adapterWith((method) =>
      method === "eth_getLogs"
        ? [
            {
              address: log.address,
              topics: log.topics,
              data: log.data,
              blockNumber: "0x96",
              blockHash: log.blockHash,
              transactionHash: log.transactionHash,
              transactionIndex: "0x0",
              logIndex: "0x2",
              removed: false,
            },
          ]
        : null,
    );
    const logs = await adapter.readLogs({ fromBlock: 100n, toBlock: 200n });
    expect(logs).toEqual([{ ...log, blockNumber: 150n }]);
    const request = calls.find((call) => call.method === "eth_getLogs");
    expect(request?.params[0]).toMatchObject({
      address: mockLaunchpadAddress,
      fromBlock: "0x64",
      toBlock: "0xc8",
    });
    expect(adapter.decodeEvents(logs).events[0]).toMatchObject({
      eventName: "Paused",
      saleId: 3n,
    });
    await expect(
      adapter.readLogs({
        fromBlock: 1n,
        toBlock: launchContractMaximumLogRange + 1n,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("reads a block header and maps an endpoint failure to LAUNCH_CONTRACT_READ_FAILED", async () => {
    const { adapter } = adapterWith((method) => {
      if (method === "eth_getBlockByNumber") {
        return {
          number: "0x384",
          hash: fixtureBlockHash(900n),
          timestamp: "0x6aaf0000",
          parentHash: `0x${"00".repeat(32)}`,
          transactions: [],
          gasLimit: "0x1",
          gasUsed: "0x0",
          logsBloom: `0x${"00".repeat(256)}`,
          miner: `0x${"00".repeat(20)}`,
          nonce: "0x0000000000000000",
          difficulty: "0x0",
          extraData: "0x",
          receiptsRoot: `0x${"00".repeat(32)}`,
          sha3Uncles: `0x${"00".repeat(32)}`,
          size: "0x1",
          stateRoot: `0x${"00".repeat(32)}`,
          totalDifficulty: "0x0",
          transactionsRoot: `0x${"00".repeat(32)}`,
          uncles: [],
        };
      }
      throw new Error("endpoint down");
    });
    expect(await adapter.readBlock(900n)).toEqual({
      blockNumber: 900n,
      blockHash: fixtureBlockHash(900n),
      timestamp: 0x6aaf0000n,
    });
    await expect(
      adapter.readLogs({ fromBlock: 1n, toBlock: 2n }),
    ).rejects.toMatchObject({
      reasonCode: "LAUNCH_CONTRACT_READ_FAILED",
    });
  });
});
