import { custom, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  createLaunch2Chain,
  launch2DefaultMaxAddressesPerLogQuery,
} from "../src/integrations/launch2/launch2-chain.js";
import { snapshotRegistryAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

/**
 * Public BSC Testnet RPCs refuse `eth_getLogs` with ≥ 10 filter addresses
 * (publicnode: HTTP 403 "Request blocked", measured 2026-10-11). The reader
 * splits the address filter into batches and merges the answers in
 * (blockNumber, logIndex) order so the lane sees one ordered stream.
 */

const blockHash = `0x${"bb".repeat(32)}`;
const launchId = `0x${"11".repeat(32)}`;

function openedLog(address: string, block: number, index: number) {
  return {
    address,
    topics: encodeEventTopics({
      abi: snapshotRegistryAbi,
      eventName: "PublicRoundOpenedWithoutHolders",
      args: { launchId: launchId as Hex },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint64" }, { type: "uint64" }],
      [BigInt(block), BigInt(block)],
    ),
    blockNumber: `0x${block.toString(16)}`,
    blockHash,
    transactionHash: `0x${(block * 100 + index).toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0",
    logIndex: `0x${index.toString(16)}`,
    removed: false,
  };
}

describe("launch2 chain reader splits the eth_getLogs address filter", () => {
  it("defaults to batches of 8 addresses", () => {
    expect(launch2DefaultMaxAddressesPerLogQuery).toBe(8);
  });

  it("queries 13 addresses in batches of ≤ 5 and merges the logs in chain order", async () => {
    const addresses = Array.from(
      { length: 13 },
      (_, i) => `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`,
    );
    const requests: string[][] = [];
    const chain = createLaunch2Chain({
      rpcUrls: [],
      maxAddressesPerLogQuery: 5,
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
          const filter = (params as [{ address: string[] }])[0];
          requests.push(filter.address);
          // Later batches answer with earlier blocks so the merge must sort.
          const batch = requests.length;
          return Promise.resolve(
            filter.address
              .slice(0, 2)
              .map((address, i) => openedLog(address, 30 - batch * 5, i)),
          );
        },
      }),
    });
    const result = await chain.getLogs({
      roles: new Map(addresses.map((address) => [address, "snapshots"])),
      fromBlock: 10n,
      toBlock: 30n,
    });
    expect(requests.map((batch) => batch.length)).toEqual([5, 5, 3]);
    expect(requests.flat()).toEqual(addresses);
    expect(result.ignored).toBe(0);
    expect(
      result.logs.map((entry) => [entry.blockNumber, entry.logIndex]),
    ).toEqual([
      [15n, 0],
      [15n, 1],
      [20n, 0],
      [20n, 1],
      [25n, 0],
      [25n, 1],
    ]);
  });

  it("keeps a single request when the filter fits one batch", async () => {
    let calls = 0;
    const chain = createLaunch2Chain({
      rpcUrls: [],
      transport: custom({
        request: () => {
          calls += 1;
          return Promise.resolve([]);
        },
      }),
    });
    await chain.getLogs({
      roles: new Map(
        Array.from({ length: 8 }, (_, i) => [
          `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`,
          "curve" as const,
        ]),
      ),
      fromBlock: 1n,
      toBlock: 2n,
    });
    expect(calls).toBe(1);
  });
});
