import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  toFunctionSelector,
  type Abi,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  createLaunch2ExitProbe,
  deriveLaunch2ExitPaths,
  parseLaunch2TokenId,
  type Launch2ExitPathsInput,
} from "../src/features/launch2/launch2-escrow-exit.js";
import { deriveLaunch2Stage } from "../src/features/launch2/launch2-stage.js";
import type {
  Launch2Chain,
  Launch2ContractRole,
  Launch2LaneInstance,
  Launch2Repository,
} from "../src/features/launch2/launch2-ports.js";
import {
  launch2ExitNftEscrowAbi,
  launch2ExitSnapshotRegistryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi-escrow-exit.js";
import { createLaunch2Chain } from "../src/integrations/launch2/launch2-chain.js";
import { createLaunch2Lane } from "../src/launch2-indexer-worker.js";
import {
  instanceFixture,
  launch2Factory,
  launch2SaleEndAfter,
} from "./helpers/launch2-fakes.js";

/**
 * Decision 0137: the escrow exit-path read model — the two derived states,
 * the per-Factory capability probe (supported / unsupported / RPC failure),
 * decoding of the S175 events with the ABI copied from the Foundry build,
 * the stage after a timeout opening, and the lane's escrow role (only for a
 * supporting Factory).
 */

const timing = { snapshotTimeout: 3_600n, refundDelay: 7_200n };
const saleEnd = 1_000_000n;

function exitInput(
  overrides: Partial<Launch2ExitPathsInput> = {},
): Launch2ExitPathsInput {
  return {
    nowSeconds: saleEnd + 10n,
    nftSaleEnd: saleEnd,
    timing,
    openedAt: null,
    openedAfterTimeoutAt: null,
    graduated: false,
    totalMinted: 3n,
    refundedCount: 0n,
    ...overrides,
  };
}

describe("Decision 0137 exit paths derivation", () => {
  it("derives timeoutOpenState: not_applicable, waiting, available, opened_by_timeout", () => {
    const sale = deriveLaunch2ExitPaths(
      exitInput({ nowSeconds: saleEnd - 1n }),
    );
    expect(sale.timeoutOpenState).toBe("not_applicable");
    expect(sale.snapshotTimeoutAt).toBe(saleEnd + 3_600n);
    const normal = deriveLaunch2ExitPaths(
      exitInput({ openedAt: saleEnd + 5n, nowSeconds: saleEnd + 9_000n }),
    );
    expect(normal.timeoutOpenState).toBe("not_applicable");
    expect(
      deriveLaunch2ExitPaths(exitInput({ nowSeconds: saleEnd + 3_599n }))
        .timeoutOpenState,
    ).toBe("waiting");
    expect(
      deriveLaunch2ExitPaths(exitInput({ nowSeconds: saleEnd + 3_600n }))
        .timeoutOpenState,
    ).toBe("available");
    expect(
      deriveLaunch2ExitPaths(
        exitInput({
          nowSeconds: saleEnd + 4_000n,
          openedAfterTimeoutAt: saleEnd + 3_700n,
        }),
      ).timeoutOpenState,
    ).toBe("opened_by_timeout");
  });

  it("derives refundOpensAt = min(rootPublishedAt, timeoutAt) + delay and refundState", () => {
    // Not opened: timeoutAt + delay.
    const unopened = deriveLaunch2ExitPaths(exitInput());
    expect(unopened.refundOpensAt).toBe(saleEnd + 3_600n + 7_200n);
    expect(unopened.refundState).toBe("waiting");
    // Normal snapshot before the timeout: publishedAt + delay.
    const early = deriveLaunch2ExitPaths(
      exitInput({ openedAt: saleEnd + 100n, nowSeconds: saleEnd + 7_300n }),
    );
    expect(early.refundOpensAt).toBe(saleEnd + 7_300n);
    expect(early.refundState).toBe("open");
    // Late opening never pushes the window back (S175 §2.3-1).
    const late = deriveLaunch2ExitPaths(
      exitInput({ openedAfterTimeoutAt: saleEnd + 9_000n }),
    );
    expect(late.refundOpensAt).toBe(saleEnd + 3_600n + 7_200n);
    expect(
      deriveLaunch2ExitPaths(exitInput({ graduated: true, openedAt: saleEnd }))
        .refundState,
    ).toBe("closed_graduated");
    expect(
      deriveLaunch2ExitPaths(exitInput({ totalMinted: 0n, graduated: true }))
        .refundState,
    ).toBe("not_applicable");
  });

  it("parses token ids as uint256 decimal strings", () => {
    expect(parseLaunch2TokenId("1")).toBe(1n);
    expect(parseLaunch2TokenId("0")).toBe(0n);
    for (const bad of ["01", "-1", "1.0", 1, `${2n ** 256n}`, ""]) {
      expect(parseLaunch2TokenId(bad)).toBeNull();
    }
  });

  it("a timeout opening is public with no early round", () => {
    expect(
      deriveLaunch2Stage({
        nowSeconds: saleEnd + 4_000n,
        nftSaleStart: saleEnd - 3_600n,
        nftSaleEnd: saleEnd,
        snapshotPublishedAt: null,
        graduated: false,
        holdReason: null,
        openedAfterTimeoutAt: saleEnd + 3_700n,
      }),
    ).toEqual({ stage: "public", nextChangeAt: null });
    expect(
      deriveLaunch2Stage({
        nowSeconds: saleEnd + 4_000n,
        nftSaleStart: saleEnd - 3_600n,
        nftSaleEnd: saleEnd,
        snapshotPublishedAt: null,
        graduated: false,
        holdReason: null,
      }).stage,
    ).toBe("snapshot_pending");
  });
});

/** A viem transport answering eth_call / eth_getLogs from a script. */
function scriptedTransport(
  answer: (method: string, params: unknown) => unknown,
) {
  return custom({
    request: ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "eth_chainId") return Promise.resolve("0x61");
      if (method === "eth_blockNumber") return Promise.resolve("0x10");
      try {
        return Promise.resolve(answer(method, params));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  });
}

function revertError(): Error {
  return Object.assign(new Error("execution reverted"), {
    code: 3,
    data: "0x",
  });
}

describe("Decision 0137 capability probe", () => {
  it("supported Factory: snapshotTimeout / refundDelay; cached", async () => {
    let calls = 0;
    const chain = createLaunch2Chain({
      rpcUrls: [],
      transport: scriptedTransport((method, params) => {
        if (method !== "eth_call") throw new Error(method);
        calls += 1;
        const data = (params as [{ data: string }])[0].data;
        // snapshotTimeout() / refundDelay() selectors.
        return encodeAbiParameters(
          [{ type: "uint64" }],
          [
            data.startsWith(toFunctionSelector("snapshotTimeout()"))
              ? 3_600n
              : 7_200n,
          ],
        );
      }),
    });
    const probe = createLaunch2ExitProbe((factory) =>
      (chain.readExitTiming as NonNullable<Launch2Chain["readExitTiming"]>)(
        factory,
      ),
    );
    expect(await probe.timingOf(launch2Factory)).toEqual({
      snapshotTimeout: 3_600n,
      refundDelay: 7_200n,
    });
    await probe.timingOf(launch2Factory.toUpperCase().replace("0X", "0x"));
    expect(calls).toBe(2);
  });

  it("unsupported Factory: a revert or an empty answer is null; an RPC failure throws and is not cached", async () => {
    const reverting = createLaunch2Chain({
      rpcUrls: [],
      transport: scriptedTransport(() => {
        throw revertError();
      }),
    });
    expect(await reverting.readExitTiming!(launch2Factory)).toBeNull();
    const empty = createLaunch2Chain({
      rpcUrls: [],
      transport: scriptedTransport(() => "0x"),
    });
    expect(await empty.readExitTiming!(launch2Factory)).toBeNull();
    let fail = true;
    let reads = 0;
    const flaky = createLaunch2ExitProbe(() => {
      reads += 1;
      if (fail) return Promise.reject(new Error("socket hang up"));
      return Promise.resolve(null);
    });
    await expect(flaky.timingOf(launch2Factory)).rejects.toThrow(
      "socket hang up",
    );
    fail = false;
    expect(await flaky.timingOf(launch2Factory)).toBeNull();
    expect(await flaky.timingOf(launch2Factory)).toBeNull();
    expect(reads).toBe(2);
    // Without the reader nothing is supported.
    expect(
      await createLaunch2ExitProbe(undefined).timingOf(launch2Factory),
    ).toBeNull();
  });
});

describe("Decision 0137 event decoding (S175 Foundry ABI)", () => {
  const snapshots = `0x${"1".repeat(40)}`;
  const escrow = `0x${"f".repeat(40)}`;
  const owner = `0x${"a".repeat(40)}`;
  const launchId = `0x${"11".repeat(32)}`;

  function rpcLog(address: string, topics: Hex[], data: Hex, logIndex: number) {
    return {
      address,
      topics,
      data,
      blockNumber: "0x5",
      blockHash: `0x${"ab".repeat(32)}`,
      transactionHash: `0x${"cd".repeat(32)}`,
      transactionIndex: "0x0",
      logIndex: `0x${logIndex.toString(16)}`,
      removed: false,
    };
  }

  it("decodes PublicRoundOpenedAfterTimeout (snapshots) and RefundClaimed (escrow)", async () => {
    const opened = getAbiItem({
      abi: launch2ExitSnapshotRegistryAbi,
      name: "PublicRoundOpenedAfterTimeout",
    });
    const refunded = getAbiItem({
      abi: launch2ExitNftEscrowAbi,
      name: "RefundClaimed",
    });
    const logs = [
      rpcLog(
        snapshots,
        encodeEventTopics({
          abi: [opened] as Abi,
          eventName: "PublicRoundOpenedAfterTimeout",
          args: { launchId },
        }) as Hex[],
        encodeAbiParameters(
          [{ type: "uint64" }, { type: "uint64" }, { type: "uint256" }],
          [1_700_000_000n, 1234n, 3n],
        ),
        0,
      ),
      rpcLog(
        escrow,
        encodeEventTopics({
          abi: [refunded] as Abi,
          eventName: "RefundClaimed",
          args: { tokenId: 2n, owner: owner },
        }) as Hex[],
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }],
          [100n * 10n ** 18n, 200n * 10n ** 18n],
        ),
        1,
      ),
      // The same RefundClaimed topic from an untracked-role address is ignored.
      rpcLog(
        snapshots,
        encodeEventTopics({
          abi: [refunded] as Abi,
          eventName: "RefundClaimed",
          args: { tokenId: 3n, owner: owner },
        }) as Hex[],
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }],
          [1n, 1n],
        ),
        2,
      ),
    ];
    const chain = createLaunch2Chain({
      rpcUrls: [],
      transport: scriptedTransport((method) => {
        if (method === "eth_getLogs") return logs;
        throw new Error(method);
      }),
    });
    const roles = new Map<string, Launch2ContractRole>([
      [snapshots, "snapshots"],
      [escrow, "escrow"],
    ]);
    const answer = await chain.getLogs({ roles, fromBlock: 1n, toBlock: 9n });
    expect(answer.ignored).toBe(1);
    expect(answer.logs.map((log) => [log.eventName, log.args])).toEqual([
      [
        "PublicRoundOpenedAfterTimeout",
        {
          launchId,
          openedAt: "1700000000",
          openedBlock: "1234",
          totalMinted: "3",
        },
      ],
      [
        "RefundClaimed",
        {
          tokenId: "2",
          owner,
          amount: "100000000000000000000",
          remainingRecorded: "200000000000000000000",
        },
      ],
    ]);
  });
});

describe("Decision 0137 launch2_event lane escrow role", () => {
  function laneInstance(factoryAddress?: string): Launch2LaneInstance {
    const record = instanceFixture();
    return {
      instanceId: record.instanceId,
      launchId: record.launchId,
      generation: "v3",
      addresses: record.addresses,
      deployBlockNumber: "100",
      nftSaleStart: record.nftSaleStart,
      nftSaleEnd: launch2SaleEndAfter(record.nftSaleStart, 3_600n),
      holdReason: null,
      graduated: false,
      officialPoolId: null,
      snapshotPublishedAt: null,
      closedNoHolders: false,
      openedWithoutHoldersAt: null,
      activatedAt: record.activatedAt,
      stage: "snapshot_pending",
      nextChangeAt: null,
      ...(factoryAddress === undefined ? {} : { factoryAddress }),
    };
  }

  async function rolesFor(
    instance: Launch2LaneInstance,
    readExitTiming?: Launch2Chain["readExitTiming"],
  ) {
    const asked: ReadonlyMap<string, Launch2ContractRole>[] = [];
    const repository = {
      registerActivatedInstances: () => Promise.resolve([]),
      listLaneInstances: () => Promise.resolve([instance]),
      getCheckpoint: () => Promise.resolve(null),
      commitSegment: () => Promise.resolve({ storedCount: 0, touched: 0 }),
      listMemeCoverageChecks: () => Promise.resolve([]),
      recordMemeCoverage: () => Promise.resolve(),
      listSnapshotsToVerify: () => Promise.resolve([]),
      nftHoldersAt: () => Promise.resolve([]),
      recordSnapshotVerification: () => Promise.resolve(),
      updateStages: () => Promise.resolve(0),
    } as unknown as Launch2Repository;
    const chain = {
      verifyChain: () => Promise.resolve("ok"),
      getHead: () =>
        Promise.resolve({
          blockNumber: 150n,
          blockHash: `0x${"0".repeat(63)}1`,
          timestamp: 1_800_000_000n,
        }),
      getBlock: () =>
        Promise.resolve({ hash: `0x${"0".repeat(63)}1`, timestamp: 1n }),
      getLogs: (input: Parameters<Launch2Chain["getLogs"]>[0]) => {
        asked.push(input.roles);
        return Promise.resolve({ logs: [], ignored: 0 });
      },
      ...(readExitTiming === undefined ? {} : { readExitTiming }),
    } as unknown as Launch2Chain;
    const lane = createLaunch2Lane({
      repository,
      chain,
      chainId: "eip155:97",
      factories: [{ address: launch2Factory, generation: "v3", current: true }],
      reorgDepthBlocks: 15,
      pollIntervalMs: 1_000,
      now: () => new Date(1_800_000_000_000),
    });
    const result = await lane.runOnce();
    return { result, roles: asked[0] };
  }

  it("adds the escrow only for an instance of a supporting Factory", async () => {
    const instance = laneInstance(launch2Factory);
    const supported = await rolesFor(instance, () => Promise.resolve(timing));
    expect(supported.roles?.get(instance.addresses.escrow)).toBe("escrow");
    const unsupported = await rolesFor(instance, () => Promise.resolve(null));
    expect(unsupported.roles?.has(instance.addresses.escrow)).toBe(false);
    // An older reader (no probe) or a row without its Factory: unchanged.
    const old = await rolesFor(instance);
    expect(old.roles?.has(instance.addresses.escrow)).toBe(false);
    const unknown = await rolesFor(laneInstance(), () =>
      Promise.resolve(timing),
    );
    expect(unknown.roles?.has(instance.addresses.escrow)).toBe(false);
  });

  it("an RPC failure of the probe fails the tick instead of skipping refunds", async () => {
    await expect(
      rolesFor(laneInstance(launch2Factory), () =>
        Promise.reject(new Error("socket hang up")),
      ),
    ).rejects.toThrow("socket hang up");
  });
});
