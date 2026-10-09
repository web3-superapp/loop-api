import { decodeFunctionData, multicall3Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { createLaunchService } from "../src/features/launch/launch-service.js";
import {
  createLaunchContractAdapter,
  LaunchContractUnavailableError,
  type LaunchContractConfig,
} from "../src/integrations/launch/launch-contract-adapter.js";
import { launchpadAbiV1 } from "../src/integrations/launch/launchpad-abi.v1.js";
import {
  createMockLaunchpadChain,
  mockBlockHash,
  mockBlockNumber,
  mockLaunchpadAddress,
  mockLaunchpadTransportFactory,
  mockMulticall3Address,
  mockStateTupleDigest,
  mockUsd1Address,
  type MockLaunchpadChain,
} from "./helpers/launchpad-mock-chain.js";
import {
  accountId,
  chainRepositoryFake,
  launchId,
  launchRepositoryFor,
  registeredDetail,
  walletsFake,
} from "./helpers/launch-service-fakes.js";

/**
 * Decision 0085: the Launch sale snapshot is one head read, one Multicall3
 * `eth_call` pinned to that block, and one reorg check; a successful read is
 * reused for `snapshotCacheTtlMs`, a failed one never is.
 */

const contract: LaunchContractConfig = Object.freeze({
  address: mockLaunchpadAddress,
  version: "1.0.0",
  versionMajor: 1,
  startBlock: 44_000_000n,
  usd1Address: mockUsd1Address,
});

const blockTag = (block: bigint): string => `0x${block.toString(16)}`;

function adapterFor(
  chain: MockLaunchpadChain,
  options: { readonly ttlMs?: number; readonly clock?: { now: number } } = {},
) {
  return createLaunchContractAdapter({
    contract,
    chain: {
      chainId: "eip155:97",
      chainReference: 97,
      rpcUrls: ["https://launch-rpc.invalid/"],
    },
    verifyChain: () => Promise.resolve("verified"),
    transportFactory: mockLaunchpadTransportFactory(chain),
    ...(options.ttlMs === undefined
      ? {}
      : { snapshotCacheTtlMs: options.ttlMs }),
    ...(options.clock === undefined
      ? {}
      : { nowMs: () => (options.clock as { now: number }).now }),
  });
}

/** Probes once (eth_getCode), then forgets the probe's traffic. */
async function warmed(
  chain: MockLaunchpadChain,
  options: Parameters<typeof adapterFor>[1] = {},
) {
  const adapter = adapterFor(chain, options);
  await expect(adapter.availability()).resolves.toEqual({
    status: "available",
  });
  chain.calls.length = 0;
  chain.timeline.length = 0;
  return adapter;
}

function innerFunctions(data: Hex): { target: string; name: string }[] {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data });
  if (decoded.functionName !== "aggregate3") {
    throw new Error("not aggregate3");
  }
  return decoded.args[0].map((call) => ({
    target: call.target.toLowerCase(),
    name: decodeFunctionData({ abi: launchpadAbiV1, data: call.callData })
      .functionName,
  }));
}

describe("Launch sale snapshot read (Decision 0085)", () => {
  it("reads the head, then all three sale reads in one eth_call at that block, then checks the hash", async () => {
    const chain = createMockLaunchpadChain({ latencyMs: 5 });
    const adapter = await warmed(chain);
    const read = await adapter.readSaleSnapshot(1n);

    expect(chain.calls.map((call) => call.method)).toEqual([
      "eth_getBlockByNumber",
      "eth_call",
      "eth_getBlockByNumber",
    ]);
    const [head, call, confirm] = chain.calls;
    expect(head?.params[0]).toBe("latest");
    // Every eth_call of the read carries the snapshot's block number.
    expect(call?.params[1]).toBe(blockTag(mockBlockNumber));
    expect(confirm?.params[0]).toBe(blockTag(mockBlockNumber));
    const request = call?.params[0] as { to: string; data: Hex };
    expect(request.to.toLowerCase()).toBe(mockMulticall3Address);
    // The three reads leave together, in one request, to the launchpad.
    expect(innerFunctions(request.data)).toEqual([
      { target: mockLaunchpadAddress, name: "getState" },
      { target: mockLaunchpadAddress, name: "getRounds" },
      { target: mockLaunchpadAddress, name: "getSaleConfig" },
    ]);
    // Strictly three round trips: nothing overlaps, nothing is repeated.
    expect(chain.timeline).toEqual([
      "start eth_getBlockByNumber:latest",
      "end eth_getBlockByNumber:latest",
      `start eth_call:${blockTag(mockBlockNumber)}`,
      `end eth_call:${blockTag(mockBlockNumber)}`,
      `start eth_getBlockByNumber:${blockTag(mockBlockNumber)}`,
      `end eth_getBlockByNumber:${blockTag(mockBlockNumber)}`,
    ]);

    expect(read.snapshot).toEqual({
      blockNumber: mockBlockNumber,
      blockHash: mockBlockHash,
    });
    expect(read.state).toMatchObject({
      saleState: "LIVE",
      stateTupleDigest: mockStateTupleDigest,
    });
    expect(read.rounds.map((round) => round.roundId)).toEqual([1, 2]);
    expect(read.config.usd1).toBe(mockUsd1Address);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const chain = createMockLaunchpadChain({ latencyMs: 20 });
    const adapter = await warmed(chain, { ttlMs: 1_500 });
    const reads = await Promise.all([
      adapter.readSaleSnapshot(1n),
      adapter.readSaleSnapshot(1n),
      adapter.readSaleSnapshot(1n),
    ]);
    expect(chain.calls).toHaveLength(3);
    expect(new Set(reads).size).toBe(1);
    // A different sale is a different entry.
    await adapter.readSaleSnapshot(2n);
    expect(chain.calls).toHaveLength(6);
  });

  it("never caches when the TTL is 0 (the adapter default, e.g. the worker)", async () => {
    const chain = createMockLaunchpadChain();
    const adapter = await warmed(chain);
    await adapter.readSaleSnapshot(1n);
    await adapter.readSaleSnapshot(1n);
    expect(chain.calls).toHaveLength(6);
  });

  it("serves the same snapshot within the TTL and reads the chain again after it", async () => {
    const clock = { now: 10_000 };
    const chain = createMockLaunchpadChain();
    const adapter = await warmed(chain, { ttlMs: 1_500, clock });
    const first = await adapter.readSaleSnapshot(1n);
    expect(chain.calls).toHaveLength(3);

    // The chain moves on, but within the TTL the cached read is returned
    // unchanged: its block and digest are the ones that read observed.
    chain.blockNumber = mockBlockNumber + 1n;
    chain.blockHash = `0x${"34".repeat(32)}`;
    chain.state = { ...chain.state, stateTupleDigest: `0x${"ee".repeat(32)}` };
    clock.now += 1_499;
    const second = await adapter.readSaleSnapshot(1n);
    expect(chain.calls).toHaveLength(3);
    expect(second).toBe(first);
    expect(second.snapshot.blockNumber).toBe(mockBlockNumber);
    expect(second.state.stateTupleDigest).toBe(mockStateTupleDigest);

    clock.now += 1;
    const third = await adapter.readSaleSnapshot(1n);
    expect(chain.calls).toHaveLength(6);
    expect(third.snapshot.blockNumber).toBe(mockBlockNumber + 1n);
    expect(third.state.stateTupleDigest).toBe(`0x${"ee".repeat(32)}`);
  });

  it("fails the whole read when any one of the three calls fails, and never caches a failure", async () => {
    for (const revertFunction of ["getState", "getRounds", "getSaleConfig"]) {
      const clock = { now: 0 };
      const chain = createMockLaunchpadChain({ revertFunction });
      const adapter = await warmed(chain, { ttlMs: 1_500, clock });
      const error: unknown = await adapter
        .readSaleSnapshot(1n)
        .catch((caught: unknown) => caught);
      expect(error, revertFunction).toBeInstanceOf(
        LaunchContractUnavailableError,
      );
      expect(error, revertFunction).toMatchObject({
        reasonCode: "LAUNCH_CONTRACT_READ_FAILED",
      });
      // A failure is not a snapshot: the next read goes to the chain.
      chain.revertFunction = null;
      const calls = chain.calls.length;
      await expect(adapter.readSaleSnapshot(1n)).resolves.toMatchObject({
        snapshot: { blockNumber: mockBlockNumber },
      });
      expect(chain.calls.length, revertFunction).toBe(calls + 3);
    }
  });

  it("names a transport failure, an invalid value, and a reorg exactly as before", async () => {
    const failing = createMockLaunchpadChain({ failCalls: true });
    await expect(
      (await warmed(failing, { ttlMs: 1_500 })).readSaleSnapshot(1n),
    ).rejects.toMatchObject({ reasonCode: "LAUNCH_CONTRACT_READ_FAILED" });

    const invalid = createMockLaunchpadChain();
    invalid.state = { ...invalid.state, saleState: 9 };
    await expect(
      (await warmed(invalid)).readSaleSnapshot(1n),
    ).rejects.toMatchObject({ reasonCode: "LAUNCH_CONTRACT_READ_INVALID" });

    const reorged = createMockLaunchpadChain({
      reorgHash: `0x${"99".repeat(32)}`,
    });
    const adapter = await warmed(reorged, { ttlMs: 1_500 });
    await expect(adapter.readSaleSnapshot(1n)).rejects.toMatchObject({
      reasonCode: "LAUNCH_SNAPSHOT_REORGED",
    });
    // The reorged read was dropped, not cached.
    await expect(adapter.readSaleSnapshot(1n)).rejects.toMatchObject({
      reasonCode: "LAUNCH_SNAPSHOT_REORGED",
    });
    expect(
      reorged.calls.filter((call) => call.method === "eth_call"),
    ).toHaveLength(2);
  });
});

describe("Launch detail and eligibility share one sale snapshot (Decision 0085)", () => {
  const principal = Object.freeze({
    userId: accountId,
    privyUserId: "did:privy:verified-user",
    streamUserId: accountId,
  });

  function serviceFor(chain: MockLaunchpadChain, clock: { now: number }) {
    const adapter = adapterFor(chain, { ttlMs: 1_500, clock });
    return createLaunchService({
      repository: launchRepositoryFor(registeredDetail()),
      cursorCodec: null,
      contract: adapter,
      chain: chainRepositoryFake(),
      wallets: walletsFake(),
      now: () => new Date(1_790_200_000_000),
    });
  }

  it("reads the chain once for a detail and an eligibility request fired together", async () => {
    const clock = { now: 0 };
    const chain = createMockLaunchpadChain({ latencyMs: 10 });
    const service = serviceFor(chain, clock);
    const [detail, eligibility] = await Promise.all([
      service.getLaunch({ launchId }),
      service.getEligibility({ principal, launchId, roundIndex: "2" }),
    ]);
    expect(detail.launch.onChainState).toMatchObject({
      source: "chain",
      snapshotBlockNumber: mockBlockNumber.toString(),
      stateTupleDigest: mockStateTupleDigest,
    });
    expect(eligibility.result).toMatchObject({
      status: "available",
      roundIndex: 2,
      snapshotBlock: mockBlockNumber.toString(),
    });
    // One probe (eth_getCode) and one snapshot read for both requests.
    expect(chain.calls.map((call) => call.method)).toEqual([
      "eth_getCode",
      "eth_getBlockByNumber",
      "eth_call",
      "eth_getBlockByNumber",
    ]);

    // Within the TTL a second detail costs no RPC; after it, one read.
    await service.getLaunch({ launchId });
    expect(chain.calls).toHaveLength(4);
    clock.now += 1_500;
    await service.getLaunch({ launchId });
    expect(chain.calls).toHaveLength(7);
  });
});
