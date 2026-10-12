import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  createLaunch2Chain,
  launch2DefaultMaxAddressesPerLogQuery,
} from "../src/integrations/launch2/launch2-chain.js";
import {
  officialPoolRouterAbi,
  poolManagerAbi,
  snapshotRegistryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

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
  it("asks the PoolManager for Swap logs by pool id only (topic1), in batches, decoded as Swap (Decision 0124)", async () => {
    const poolManager = `0x${"99".repeat(20)}`;
    const ids = Array.from(
      { length: 10 },
      (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`,
    );
    const requests: { address: unknown; topics: unknown }[] = [];
    const chain = createLaunch2Chain({
      rpcUrls: [],
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
          const filter = (
            params as [{ address: unknown; topics?: unknown }]
          )[0];
          requests.push({ address: filter.address, topics: filter.topics });
          if (requests.length !== 1) return Promise.resolve([]);
          return Promise.resolve([
            {
              address: poolManager,
              topics: encodeEventTopics({
                abi: poolManagerAbi,
                eventName: "Swap",
                args: {
                  id: ids[0] as Hex,
                  sender: `0x${"55".repeat(20)}`,
                },
              }) as Hex[],
              data: encodeAbiParameters(
                [
                  { type: "int128" },
                  { type: "int128" },
                  { type: "uint160" },
                  { type: "uint128" },
                  { type: "int24" },
                  { type: "uint24" },
                ],
                [-5n, 7n, 2n ** 96n, 1n, -3, 2500],
              ),
              blockNumber: "0x10",
              blockHash,
              transactionHash: `0x${"ab".repeat(32)}`,
              transactionIndex: "0x0",
              logIndex: "0x1",
              removed: false,
            },
          ]);
        },
      }),
    });
    const result = await chain.getLogs({
      roles: new Map(),
      fromBlock: 1n,
      toBlock: 20n,
      poolSwaps: new Map([[poolManager, ids]]),
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(String(request.address).toLowerCase()).toBe(poolManager);
    }
    const topics = requests.map((request) => request.topics as unknown[]);
    expect((topics[0]?.[1] as string[]).length).toBe(8);
    expect((topics[1]?.[1] as string[]).length).toBe(2);
    expect(result.logs).toEqual([
      expect.objectContaining({
        contractAddress: poolManager,
        eventName: "Swap",
        args: expect.objectContaining({
          id: ids[0],
          amount0: "-5",
          amount1: "7",
          tick: "-3",
        }) as unknown,
      }),
    ]);
  });

  it("asks the router for its Swap logs by pool id (topic1), batched, decoded as RouterSwap (Decision 0126)", async () => {
    const router = `0x${"cc".repeat(20)}`;
    const payer = `0x${"aa".repeat(20)}`;
    const ids = Array.from(
      { length: 9 },
      (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`,
    );
    const requests: { address: unknown; topics: unknown }[] = [];
    const chain = createLaunch2Chain({
      rpcUrls: [],
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
          const filter = (
            params as [{ address: unknown; topics?: unknown }]
          )[0];
          requests.push({ address: filter.address, topics: filter.topics });
          if (requests.length !== 1) return Promise.resolve([]);
          return Promise.resolve([
            {
              address: router,
              topics: encodeEventTopics({
                abi: officialPoolRouterAbi,
                eventName: "Swap",
                args: {
                  poolId: ids[0] as Hex,
                  payer: payer as Hex,
                  recipient: payer as Hex,
                },
              }) as Hex[],
              data: encodeAbiParameters(
                [{ type: "bool" }, { type: "uint256" }, { type: "uint256" }],
                [true, 10n, 15n],
              ),
              blockNumber: "0x10",
              blockHash,
              transactionHash: `0x${"ab".repeat(32)}`,
              transactionIndex: "0x0",
              logIndex: "0x4",
              removed: false,
            },
          ]);
        },
      }),
    });
    const result = await chain.getLogs({
      roles: new Map(),
      fromBlock: 1n,
      toBlock: 20n,
      routerSwaps: { router, poolIds: ids },
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(String(request.address).toLowerCase()).toBe(router);
    }
    const topics = requests.map((request) => request.topics as unknown[]);
    expect((topics[0]?.[1] as string[]).length).toBe(8);
    expect((topics[1]?.[1] as string[]).length).toBe(1);
    expect(result.logs).toEqual([
      {
        contractAddress: router,
        eventName: "RouterSwap",
        args: {
          poolId: ids[0],
          payer,
          recipient: payer,
          zeroForOne: "true",
          amountIn: "10",
          amountOut: "15",
        },
        transactionHash: `0x${"ab".repeat(32)}`,
        logIndex: 4,
        blockNumber: 16n,
        blockHash,
      },
    ]);
  });
});

describe("launch2 chain reader distrusts a log answer without the deploy-block mint (Decision 0129 §2)", () => {
  const meme = `0x${"4d".repeat(20)}`;
  const holder = `0x${"cc".repeat(20)}`;
  function mintLog(block: number) {
    return {
      address: meme,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: {
          from: `0x${"0".repeat(40)}`,
          to: holder as Hex,
        },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [1_000n]),
      blockNumber: `0x${block.toString(16)}`,
      blockHash,
      transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    };
  }
  function endpoint(answer: unknown[] | "fail", calls: string[], name: string) {
    return custom(
      {
        request: ({ method }: { method: string }) => {
          if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
          calls.push(name);
          if (answer === "fail") return Promise.reject(new Error("down"));
          return Promise.resolve(answer);
        },
      },
      { retryCount: 0 },
    );
  }
  const request = {
    roles: new Map([[meme, "meme" as const]]),
    fromBlock: 90n,
    toBlock: 200n,
    mintAnchors: [{ token: meme, blockNumber: 100n }],
  };

  it("asks the next endpoint when the first answers [] for a range holding the deploy block", async () => {
    const calls: string[] = [];
    const chain = createLaunch2Chain({
      rpcUrls: [],
      endpointTransports: [
        endpoint([], calls, "silent"),
        endpoint("fail", calls, "down"),
        endpoint([mintLog(100)], calls, "archive"),
      ],
    });
    const result = await chain.getLogs(request);
    expect(result.logs).toMatchObject([
      {
        contractAddress: meme,
        eventName: "Transfer",
        blockNumber: 100n,
        args: { from: `0x${"0".repeat(40)}`, to: holder, value: "1000" },
      },
    ]);
    // The fallback answer (silent), then each endpoint in order.
    expect(calls).toEqual(["silent", "silent", "down", "archive"]);
  });

  it("throws LAUNCH2_RPC_LOGS_UNTRUSTED when no endpoint has the mint", async () => {
    const calls: string[] = [];
    const chain = createLaunch2Chain({
      rpcUrls: [],
      endpointTransports: [
        endpoint([], calls, "a"),
        endpoint([mintLog(101)], calls, "b"),
      ],
    });
    await expect(chain.getLogs(request)).rejects.toMatchObject({
      name: "Launch2ChainRefusedError",
      reasonCode: "LAUNCH2_RPC_LOGS_UNTRUSTED",
    });
  });

  it("ignores anchors outside the range and keeps one request", async () => {
    const calls: string[] = [];
    const chain = createLaunch2Chain({
      rpcUrls: [],
      endpointTransports: [endpoint([], calls, "only")],
    });
    const result = await chain.getLogs({
      ...request,
      mintAnchors: [{ token: meme, blockNumber: 50n }],
    });
    expect(result.logs).toEqual([]);
    expect(calls).toEqual(["only"]);
  });
});
