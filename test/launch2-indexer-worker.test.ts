import { describe, expect, it } from "vitest";

import { buildLaunchMerkleTree } from "../src/features/launch/launch-merkle.js";
import type {
  Launch2Chain,
  Launch2Checkpoint,
  Launch2DecodedLog,
  Launch2LaneInstance,
  Launch2Repository,
  Launch2SnapshotMemberRecord,
} from "../src/features/launch2/launch2-ports.js";
import { createLaunch2Lane } from "../src/launch2-indexer-worker.js";
import {
  instanceFixture,
  launch2Factory,
  launch2SaleEndAfter,
} from "./helpers/launch2-fakes.js";

/**
 * Decision 0114: the `launch2_event` lane against a scripted chain and a
 * recording repository — seeding at the oldest deploy block, the checkpoint
 * reorg rewind, the re-scan for a late-registered instance, routing of
 * logs to instances, snapshot reproduction, and the stage refresh.
 */

const hash = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

function laneInstance(
  overrides: Partial<Launch2LaneInstance> = {},
  saleSeconds = 604_800n,
): Launch2LaneInstance {
  const record = instanceFixture();
  const nftSaleStart = overrides.nftSaleStart ?? record.nftSaleStart;
  return {
    instanceId: record.instanceId,
    launchId: record.launchId,
    addresses: record.addresses,
    deployBlockNumber: "100",
    nftSaleStart,
    nftSaleEnd: launch2SaleEndAfter(nftSaleStart, saleSeconds),
    holdReason: null,
    graduated: false,
    snapshotPublishedAt: null,
    activatedAt: record.activatedAt,
    stage: "upcoming",
    nextChangeAt: null,
    ...overrides,
  };
}

function harness(options: {
  readonly instances: Launch2LaneInstance[];
  readonly head: bigint;
  readonly logs?: Launch2DecodedLog[];
  readonly checkpoint?: Launch2Checkpoint | null;
  readonly registered?: string[];
  readonly hashes?: Map<bigint, string>;
}) {
  const commits: Parameters<Launch2Repository["commitSegment"]>[0][] = [];
  const verifications: Parameters<
    Launch2Repository["recordSnapshotVerification"]
  >[0][] = [];
  const stageUpdates: Parameters<Launch2Repository["updateStages"]>[0][] = [];
  const logQueries: { fromBlock: bigint; toBlock: bigint }[] = [];
  let checkpoint = options.checkpoint ?? null;
  let snapshotsToVerify: Awaited<
    ReturnType<Launch2Repository["listSnapshotsToVerify"]>
  > = [];
  let holders: { address: string; balance: number }[] = [];
  const blockHash = (n: bigint) => options.hashes?.get(n) ?? hash(n);
  const repository = {
    registerActivatedInstances: () => Promise.resolve(options.registered ?? []),
    listLaneInstances: () => Promise.resolve(options.instances),
    getCheckpoint: () => Promise.resolve(checkpoint),
    commitSegment: (
      input: Parameters<Launch2Repository["commitSegment"]>[0],
    ) => {
      commits.push(input);
      checkpoint = {
        ...input.checkpoint,
        updatedAt: new Date().toISOString(),
      };
      return Promise.resolve({ storedCount: input.events.length, touched: 1 });
    },
    listSnapshotsToVerify: () => Promise.resolve(snapshotsToVerify),
    nftHoldersAt: () => Promise.resolve(holders),
    recordSnapshotVerification: (
      input: Parameters<Launch2Repository["recordSnapshotVerification"]>[0],
    ) => {
      verifications.push(input);
      snapshotsToVerify = [];
      return Promise.resolve();
    },
    updateStages: (
      updates: Parameters<Launch2Repository["updateStages"]>[0],
    ) => {
      stageUpdates.push(updates);
      return Promise.resolve(updates.length);
    },
  } as unknown as Launch2Repository;
  const chain: Launch2Chain = {
    verifyChain: () => Promise.resolve("ok"),
    getHead: () =>
      Promise.resolve({
        blockNumber: options.head,
        blockHash: blockHash(options.head),
        timestamp: 1_800_000_000n,
      }),
    getBlock: (n) =>
      Promise.resolve({ hash: blockHash(n), timestamp: 1_000n + n }),
    getLogs: (input) => {
      logQueries.push({ fromBlock: input.fromBlock, toBlock: input.toBlock });
      return Promise.resolve({
        logs: (options.logs ?? []).filter(
          (log) =>
            log.blockNumber >= input.fromBlock &&
            log.blockNumber <= input.toBlock,
        ),
        ignored: 0,
      });
    },
    readSnapshotPublication: () => Promise.resolve(null),
    recoverSnapshotSigners: () => Promise.resolve([]),
    readViewerState: () => Promise.reject(new Error("unused")),
    readBuybackState: () => Promise.reject(new Error("unused")),
  };
  const lane = createLaunch2Lane({
    repository,
    chain,
    chainId: "eip155:97",
    factoryAddress: launch2Factory,
    reorgDepthBlocks: 15,
    maxLogRange: 1_000n,
    pollIntervalMs: 1_000,
    now: () => new Date(1_800_000_000_000),
  });
  return {
    lane,
    commits,
    verifications,
    stageUpdates,
    logQueries,
    setSnapshot(value: typeof snapshotsToVerify, list: typeof holders) {
      snapshotsToVerify = value;
      holders = list;
    },
  };
}

describe("launch2_event lane (Decision 0114)", () => {
  it("idles without an activated instance", async () => {
    const { lane, commits } = harness({ instances: [], head: 500n });
    const result = await lane.runOnce();
    expect(result.kind).toBe("idle");
    expect(result.reasonCode).toBe("LAUNCH2_NO_INSTANCES");
    expect(commits).toHaveLength(0);
  });

  it("seeds at the oldest deploy block and routes logs to their instance", async () => {
    const a = laneInstance({ deployBlockNumber: "300" });
    const b = laneInstance({ deployBlockNumber: "120", launchId: hash(77n) });
    const logs: Launch2DecodedLog[] = [
      {
        contractAddress: b.addresses.curve,
        eventName: "CurveBought",
        args: { buyer: "0x" + "a".repeat(40), memeOut: "1" },
        transactionHash: hash(1n),
        logIndex: 0,
        blockNumber: 130n,
        blockHash: hash(130n),
      },
      {
        contractAddress: launch2Factory,
        eventName: "LaunchDeployed",
        args: { launchId: a.launchId },
        transactionHash: hash(2n),
        logIndex: 1,
        blockNumber: 300n,
        blockHash: hash(300n),
      },
      {
        contractAddress: launch2Factory,
        eventName: "LaunchDeployed",
        args: { launchId: hash(999n) },
        transactionHash: hash(3n),
        logIndex: 0,
        blockNumber: 301n,
        blockHash: hash(301n),
      },
    ];
    const { lane, commits } = harness({ instances: [a, b], head: 400n, logs });
    const result = await lane.runOnce();
    expect(result.kind).toBe("seeded");
    expect(result.fromBlockNumber).toBe("120");
    expect(result.toBlockNumber).toBe("400");
    // The foreign Factory deployment is ignored, never attributed.
    expect(result.ignoredCount).toBe(1);
    const events = commits[0]?.events ?? [];
    expect(events.map((event) => [event.instanceId, event.eventName])).toEqual([
      [b.instanceId, "CurveBought"],
      [a.instanceId, "LaunchDeployed"],
    ]);
    expect(events[0]?.at).toBe("1130");
    expect(commits[0]?.checkpoint).toMatchObject({
      lastBlockNumber: "400",
      lastBlockHash: hash(400n),
      startedFromBlockNumber: "120",
    });
    expect(commits[0]?.activationGraceBlocks).toBe(15);
  });

  it("rewinds by the reorg depth when the checkpoint hash moved", async () => {
    const instance = laneInstance();
    const { lane, commits } = harness({
      instances: [instance],
      head: 600n,
      checkpoint: {
        lastBlockNumber: "500",
        lastBlockHash: hash(12_345n),
        startedFromBlockNumber: "100",
        updatedAt: new Date().toISOString(),
      },
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("reorged");
    expect(result.fromBlockNumber).toBe("485");
    expect(commits[0]?.rewindFromBlockNumber).toBe("485");
  });

  it("re-scans from a late-registered instance's deploy block without a rewind", async () => {
    const old = laneInstance({ deployBlockNumber: "100" });
    const late = laneInstance({ deployBlockNumber: "250" });
    const { lane, commits } = harness({
      instances: [old, late],
      head: 900n,
      registered: [late.instanceId],
      checkpoint: {
        lastBlockNumber: "800",
        lastBlockHash: hash(800n),
        startedFromBlockNumber: "100",
        updatedAt: new Date().toISOString(),
      },
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("advanced");
    expect(result.fromBlockNumber).toBe("250");
    expect(commits[0]?.rewindFromBlockNumber).toBeUndefined();
    expect(result.registered).toBe(1);
  });

  it("keeps proofs only when the rebuilt holder list reproduces the root and the cutoff", async () => {
    const saleStartSeconds = 2_000n;
    const instance = laneInstance({
      nftSaleStart: new Date(Number(saleStartSeconds) * 1000).toISOString(),
    });
    // getBlock(n).timestamp = 1000 + n; sale end = 2000 + 604800.
    const saleEnd = saleStartSeconds + 604_800n;
    const cutoff = saleEnd - 1_000n - 1n; // timestamp saleEnd − 1; next = saleEnd.
    const holders = [
      { address: "0x" + "1".repeat(40), balance: 1 },
      { address: "0x" + "2".repeat(40), balance: 2 },
    ];
    const tree = buildLaunchMerkleTree(holders.map((holder) => holder.address));
    const snapshot = {
      instanceId: instance.instanceId,
      launchId: instance.launchId,
      nft: instance.addresses.nft,
      snapshots: instance.addresses.snapshots,
      root: tree.root,
      dataHash: hash(5n),
      cutoffBlock: cutoff.toString(10),
      cutoffBlockHash: hash(cutoff),
      transactionHash: hash(6n),
    };
    const run = harness({ instances: [instance], head: 50n });
    run.setSnapshot([snapshot], holders);
    await run.lane.runOnce();
    const verified = run.verifications[0];
    expect(verified?.verification).toBe("verified");
    expect(
      verified?.members.map((member: Launch2SnapshotMemberRecord) => [
        member.memberAddress,
        member.proof,
      ]),
    ).toEqual(
      holders.map((holder) => [holder.address, tree.proofFor(holder.address)]),
    );
    // A root that the indexed transfers do not reproduce: no proofs at all.
    const wrong = harness({ instances: [instance], head: 50n });
    wrong.setSnapshot([{ ...snapshot, root: hash(42n) }], holders);
    await wrong.lane.runOnce();
    expect(wrong.verifications[0]?.verification).toBe("mismatch");
    expect(
      wrong.verifications[0]?.members.every((member) => member.proof === null),
    ).toBe(true);
    // The right root on a block that is not the last one before the sale end.
    const early = harness({ instances: [instance], head: 50n });
    early.setSnapshot(
      [
        {
          ...snapshot,
          cutoffBlock: (cutoff - 5n).toString(10),
          cutoffBlockHash: hash(cutoff - 5n),
        },
      ],
      holders,
    );
    await early.lane.runOnce();
    expect(early.verifications[0]?.verification).toBe("mismatch");
  });

  it("re-derives stages from the clock and writes only the changes", async () => {
    const now = 1_800_000_000n;
    const selling = laneInstance({
      nftSaleStart: new Date(Number(now - 10n) * 1000).toISOString(),
      stage: "upcoming",
    });
    const unchanged = laneInstance({
      graduated: true,
      stage: "graduated",
      nextChangeAt: null,
    });
    const { lane, stageUpdates } = harness({
      instances: [selling, unchanged],
      head: 50n,
    });
    await lane.runOnce();
    expect(stageUpdates).toEqual([
      [
        {
          instanceId: selling.instanceId,
          stage: "nft_sale",
          nextChangeAt: new Date(
            Number(now - 10n + 604_800n) * 1000,
          ).toISOString(),
        },
      ],
    ]);
  });

  it("uses the instance's 1-hour saleEnd for the stage and the snapshot cutoff (Decision 0119)", async () => {
    const now = 1_800_000_000n;
    const ended = laneInstance(
      {
        nftSaleStart: new Date(Number(now - 3_600n) * 1000).toISOString(),
        stage: "nft_sale",
      },
      3_600n,
    );
    const selling = laneInstance(
      {
        nftSaleStart: new Date(Number(now - 10n) * 1000).toISOString(),
        stage: "upcoming",
      },
      3_600n,
    );
    const stages = harness({ instances: [ended, selling], head: 50n });
    await stages.lane.runOnce();
    expect(stages.stageUpdates).toEqual([
      [
        {
          instanceId: ended.instanceId,
          stage: "snapshot_pending",
          nextChangeAt: null,
        },
        {
          instanceId: selling.instanceId,
          stage: "nft_sale",
          nextChangeAt: new Date(
            Number(now - 10n + 3_600n) * 1000,
          ).toISOString(),
        },
      ],
    ]);

    // getBlock(n).timestamp = 1000 + n; sale end = 2000 + 3600.
    const saleStartSeconds = 2_000n;
    const hourly = laneInstance(
      {
        nftSaleStart: new Date(Number(saleStartSeconds) * 1000).toISOString(),
      },
      3_600n,
    );
    const cutoff = saleStartSeconds + 3_600n - 1_000n - 1n;
    const holders = [{ address: "0x" + "1".repeat(40), balance: 1 }];
    const tree = buildLaunchMerkleTree(holders.map((holder) => holder.address));
    const snapshot = {
      instanceId: hourly.instanceId,
      launchId: hourly.launchId,
      nft: hourly.addresses.nft,
      snapshots: hourly.addresses.snapshots,
      root: tree.root,
      dataHash: hash(5n),
      cutoffBlock: cutoff.toString(10),
      cutoffBlockHash: hash(cutoff),
      transactionHash: hash(6n),
    };
    const run = harness({ instances: [hourly], head: 50n });
    run.setSnapshot([snapshot], holders);
    await run.lane.runOnce();
    expect(run.verifications[0]?.verification).toBe("verified");
    // The 7-day cutoff for the same start is not this instance's cutoff.
    const weeklyCutoff = saleStartSeconds + 604_800n - 1_000n - 1n;
    const wrong = harness({ instances: [hourly], head: 50n });
    wrong.setSnapshot(
      [
        {
          ...snapshot,
          cutoffBlock: weeklyCutoff.toString(10),
          cutoffBlockHash: hash(weeklyCutoff),
        },
      ],
      holders,
    );
    await wrong.lane.runOnce();
    expect(wrong.verifications[0]?.verification).toBe("mismatch");
  });
});
