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
import type { Launch2MemeCoverageFacts } from "../src/features/launch2/launch2-meme-coverage.js";
import { Launch2ChainRefusedError } from "../src/integrations/launch2/launch2-chain.js";
import {
  classifyLaunch2DynamicCredits,
  createLaunch2Lane,
  pairLaunch2DynamicFees,
  pairLaunch2DynamicSenders,
  pairLaunch2RouterSwaps,
} from "../src/launch2-indexer-worker.js";
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
const zeroAddress = `0x${"0".repeat(40)}`;

function laneInstance(
  overrides: Partial<Launch2LaneInstance> = {},
  saleSeconds = 604_800n,
): Launch2LaneInstance {
  const record = instanceFixture();
  const nftSaleStart = overrides.nftSaleStart ?? record.nftSaleStart;
  return {
    instanceId: record.instanceId,
    launchId: record.launchId,
    generation: "v3",
    addresses: record.addresses,
    deployBlockNumber: "100",
    nftSaleStart,
    nftSaleEnd: launch2SaleEndAfter(nftSaleStart, saleSeconds),
    holdReason: null,
    graduated: false,
    officialPoolId: null,
    snapshotPublishedAt: null,
    closedNoHolders: false,
    openedWithoutHoldersAt: null,
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
  readonly memeAssets?: Parameters<typeof createLaunch2Lane>[0]["memeAssets"];
  readonly hookPool?: {
    readonly poolManager: string;
    readonly currency0: string;
    /** Decision 0132: the LoopDynamic Hook's trustedRouter(). */
    readonly trustedRouter?: string;
  };
  readonly poolRouter?: string;
  /** Decision 0132: tx hash → parties (readTransactionParties). */
  readonly parties?: ReadonlyMap<string, { from: string; to: string | null }>;
  /** Decision 0132: anchor tokens the reader could not vouch for. */
  readonly untrustedTokens?: readonly string[];
  /** Decision 0132: the repository's ledger below a block (tracked). */
  readonly ledger?: NonNullable<Launch2Repository["memeLedgerBalances"]>;
  /** Decision 0132: balanceOf at the segment end; "unavailable" = refused. */
  readonly chainBalances?:
    NonNullable<Launch2Chain["readMemeBalances"]> | "unavailable";
  /** Decision 0132: per-endpoint MEME Transfer answers. */
  readonly alternatives?: readonly (readonly Launch2DecodedLog[])[];
  /** Decision 0129 §2: what listMemeCoverageChecks returns. */
  readonly coverageChecks?: Launch2MemeCoverageFacts[];
  /** Decision 0129 §2: the chain refuses a range missing a mint anchor. */
  readonly enforceMintAnchors?: boolean;
}) {
  const commits: Parameters<Launch2Repository["commitSegment"]>[0][] = [];
  const verifications: Parameters<
    Launch2Repository["recordSnapshotVerification"]
  >[0][] = [];
  const stageUpdates: Parameters<Launch2Repository["updateStages"]>[0][] = [];
  const logQueries: {
    fromBlock: bigint;
    toBlock: bigint;
    roles?: number;
    poolSwaps?: ReadonlyMap<string, readonly string[]>;
    routerSwaps?: { router: string; poolIds: readonly string[] };
    roleMap: ReadonlyMap<string, string>;
  }[] = [];
  const warnings: { reasonCode: string; instanceId?: string }[] = [];
  const coverageQueries: Parameters<
    Launch2Repository["listMemeCoverageChecks"]
  >[0][] = [];
  const coverageRecords: Parameters<
    Launch2Repository["recordMemeCoverage"]
  >[0][] = [];
  const coverageEvents: Parameters<
    NonNullable<
      Parameters<typeof createLaunch2Lane>[0]["onMemeCoverageIncomplete"]
    >
  >[0][] = [];
  const anchorsAsked: (readonly { token: string; blockNumber: bigint }[])[] =
    [];
  const partyQueries: string[][] = [];
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
    listMemeCoverageChecks: (
      input: Parameters<Launch2Repository["listMemeCoverageChecks"]>[0],
    ) => {
      coverageQueries.push(input);
      return Promise.resolve(options.coverageChecks ?? []);
    },
    recordMemeCoverage: (
      input: Parameters<Launch2Repository["recordMemeCoverage"]>[0],
    ) => {
      coverageRecords.push(input);
      return Promise.resolve();
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
    ...(options.ledger === undefined
      ? {}
      : { memeLedgerBalances: options.ledger }),
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
      logQueries.push({
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
        roles: input.roles.size,
        ...(input.poolSwaps === undefined
          ? {}
          : { poolSwaps: input.poolSwaps }),
        ...(input.routerSwaps === undefined
          ? {}
          : { routerSwaps: input.routerSwaps }),
        roleMap: input.roles,
      });
      if (input.mintAnchors !== undefined) anchorsAsked.push(input.mintAnchors);
      if (
        options.enforceMintAnchors === true &&
        (input.mintAnchors ?? []).some(
          (anchor) =>
            !(options.logs ?? []).some(
              (log) =>
                log.contractAddress === anchor.token &&
                log.blockNumber === anchor.blockNumber &&
                log.eventName === "Transfer" &&
                log.args["from"] === zeroAddress,
            ),
        )
      ) {
        return Promise.reject(
          new Launch2ChainRefusedError("LAUNCH2_RPC_LOGS_UNTRUSTED"),
        );
      }
      return Promise.resolve({
        ...(options.untrustedTokens === undefined
          ? {}
          : { untrustedTokens: options.untrustedTokens }),
        logs: (options.logs ?? []).filter(
          (log) =>
            log.blockNumber >= input.fromBlock &&
            log.blockNumber <= input.toBlock &&
            (log.eventName === "Swap"
              ? (input.poolSwaps
                  ?.get(log.contractAddress)
                  ?.includes(log.args["id"] ?? "") ?? false)
              : log.eventName === "RouterSwap"
                ? input.routerSwaps !== undefined &&
                  input.routerSwaps.router === log.contractAddress &&
                  input.routerSwaps.poolIds.includes(log.args["poolId"] ?? "")
                : // Decision 0131: with a Hook role in the query, only the
                  // asked addresses answer (the second pass re-reads a range).
                  [...input.roles.values()].some(
                      (role) =>
                        role === "dynamicHook" ||
                        role === "dynamicGraduationAdapter",
                    )
                  ? input.roles.has(log.contractAddress)
                  : input.roles.size > 0),
        ),
        ignored: 0,
      });
    },
    readSnapshotPublication: () => Promise.resolve(null),
    recoverSnapshotSigners: () => Promise.resolve([]),
    readViewerState: () => Promise.reject(new Error("unused")),
    readWalletBalances: () => Promise.reject(new Error("unused")),
    readBuybackState: () => Promise.reject(new Error("unused")),
    readHookPool: () =>
      options.hookPool === undefined
        ? Promise.reject(new Error("unused"))
        : Promise.resolve(options.hookPool),
    readDynamicHookPool: () =>
      options.hookPool === undefined
        ? Promise.reject(new Error("unused"))
        : Promise.resolve(options.hookPool),
    ...(options.parties === undefined
      ? {}
      : {
          readTransactionParties: (hashes: readonly string[]) => {
            partyQueries.push([...hashes]);
            return Promise.resolve(options.parties!);
          },
        }),
    ...(options.chainBalances === undefined
      ? {}
      : {
          readMemeBalances:
            options.chainBalances === "unavailable"
              ? () =>
                  Promise.reject(
                    new Launch2ChainRefusedError(
                      "LAUNCH2_RPC_STATE_UNAVAILABLE",
                    ),
                  )
              : options.chainBalances,
        }),
    ...(options.alternatives === undefined
      ? {}
      : {
          readMemeTransferAlternatives: () =>
            Promise.resolve(options.alternatives!),
        }),
  };
  const lane = createLaunch2Lane({
    repository,
    chain,
    chainId: "eip155:97",
    factories: [{ address: launch2Factory, generation: "v3", current: true }],
    reorgDepthBlocks: 15,
    maxLogRange: 1_000n,
    pollIntervalMs: 1_000,
    now: () => new Date(1_800_000_000_000),
    onWarning: (warning) => warnings.push(warning),
    onMemeCoverageIncomplete: (event) => coverageEvents.push(event),
    ...(options.memeAssets === undefined
      ? {}
      : { memeAssets: options.memeAssets }),
    ...(options.poolRouter === undefined
      ? {}
      : { poolRouter: options.poolRouter }),
  });
  return {
    lane,
    warnings,
    coverageQueries,
    coverageRecords,
    coverageEvents,
    anchorsAsked,
    partyQueries,
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
    // The foreign Factory deployment is skipped as not ours (Decision
    // 0135), never attributed, and is not an "ignored" unknown topic.
    expect(result.ignoredCount).toBe(0);
    expect(result.skippedForeignCount).toBe(1);
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

  it("Decision 0125: indexes the MEME ERC-20 and stores its transfers apart from the module events", async () => {
    const instance = laneInstance({ memeTransfersTargetBlock: "50" });
    const holder = "0x" + "c".repeat(40);
    const logs: Launch2DecodedLog[] = [
      {
        contractAddress: instance.addresses.meme,
        eventName: "Transfer",
        args: {
          from: instance.addresses.curve,
          to: holder,
          value: "1000",
        },
        transactionHash: hash(9n),
        logIndex: 3,
        blockNumber: 150n,
        blockHash: hash(150n),
      },
      {
        contractAddress: instance.addresses.nft,
        eventName: "Transfer",
        args: { from: holder, to: instance.addresses.curve, tokenId: "1" },
        transactionHash: hash(10n),
        logIndex: 0,
        blockNumber: 151n,
        blockHash: hash(151n),
      },
    ];
    const { lane, commits, logQueries } = harness({
      instances: [instance],
      head: 400n,
      logs,
    });
    const result = await lane.runOnce();
    expect(logQueries[0]?.roleMap.get(instance.addresses.meme)).toBe("meme");
    expect(result.eventCount).toBe(2);
    // The NFT Transfer stays a module event; the MEME one is a transfer.
    expect(commits[0]?.events.map((event) => event.contractAddress)).toEqual([
      instance.addresses.nft,
    ]);
    expect(commits[0]?.memeTransfers).toEqual([
      {
        instanceId: instance.instanceId,
        from: instance.addresses.curve,
        to: holder,
        amount: "1000",
        transactionHash: hash(9n),
        logIndex: 3,
        blockNumber: "150",
        blockHash: hash(150n),
        at: "1150",
      },
    ]);
    // Coverage already started: no re-scan, no coverage update.
    expect(commits[0]?.memeTransferCoverage).toBeUndefined();
  });

  it("Decision 0125: an instance whose MEME coverage never started re-scans once from its deploy block up to the old checkpoint", async () => {
    const covered = laneInstance({
      deployBlockNumber: "100",
      memeTransfersTargetBlock: "900",
    });
    const uncovered = laneInstance({
      deployBlockNumber: "300",
      launchId: hash(78n),
      memeTransfersTargetBlock: null,
    });
    const { lane, commits } = harness({
      instances: [covered, uncovered],
      head: 2_500n,
      checkpoint: {
        lastBlockNumber: "2000",
        lastBlockHash: hash(2_000n),
        startedFromBlockNumber: "100",
        updatedAt: new Date().toISOString(),
      },
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("advanced");
    expect(result.fromBlockNumber).toBe("300");
    expect(result.toBlockNumber).toBe("1299");
    expect(commits[0]?.rewindFromBlockNumber).toBeUndefined();
    expect(commits[0]?.memeTransferCoverage).toEqual({
      instanceIds: [uncovered.instanceId],
      targetBlockNumber: "2000",
    });
    // A repository without coverage tracking never triggers a re-scan.
    const untracked = laneInstance({ deployBlockNumber: "300" });
    const plain = harness({
      instances: [untracked],
      head: 2_500n,
      checkpoint: {
        lastBlockNumber: "2000",
        lastBlockHash: hash(2_000n),
        startedFromBlockNumber: "100",
        updatedAt: new Date().toISOString(),
      },
    });
    const next = await plain.lane.runOnce();
    expect(next.fromBlockNumber).toBe("2001");
    expect(plain.commits[0]?.memeTransferCoverage).toBeUndefined();
  });

  it("Decision 0125: registers pending MEMEs every tick, skips unreadable or invalid identities with a warning", async () => {
    const instance = laneInstance();
    const registrations: { instanceId: string; identity: unknown }[] = [];
    const pending = [
      {
        instanceId: "11111111-1111-4111-8111-111111111111",
        chainId: "eip155:97",
        memeAddress: "0x" + "1".repeat(36) + "6666",
        assetRegistered: false,
      },
      {
        instanceId: "22222222-2222-4222-8222-222222222222",
        chainId: "eip155:97",
        memeAddress: "0x" + "2".repeat(36) + "6666",
        assetRegistered: false,
      },
      {
        instanceId: "33333333-3333-4333-8333-333333333333",
        chainId: "eip155:97",
        memeAddress: "0x" + "3".repeat(36) + "6666",
        assetRegistered: true,
      },
      {
        instanceId: "44444444-4444-4444-8444-444444444444",
        chainId: "eip155:97",
        memeAddress: "0x" + "4".repeat(36) + "6666",
        assetRegistered: false,
      },
    ];
    const { lane, warnings } = harness({
      instances: [instance],
      head: 50n,
      memeAssets: {
        repository: {
          listPendingMemeAssets: () => Promise.resolve(pending),
          registerMemeAsset: (input) => {
            registrations.push(input);
            return Promise.resolve({
              assetId: `eip155:97:${input.instanceId}`,
              inserted: input.identity !== null,
              communityBinding: "bound",
            });
          },
        },
        reader: {
          readTokenIdentity: (address) => {
            if (address.startsWith("0x2")) {
              return Promise.reject(new Error("rpc down"));
            }
            return Promise.resolve({
              symbol: address.startsWith("0x4") ? "  " : "FROG",
              name: "Frog Coin",
              decimals: 18,
              blockNumber: 77n,
            });
          },
        },
      },
    });
    const result = await lane.runOnce();
    expect(result.assetsRegistered).toBe(1);
    expect(registrations).toEqual([
      {
        instanceId: pending[0]?.instanceId,
        identity: {
          symbol: "FROG",
          name: "Frog Coin",
          decimals: 18,
          blockNumber: 77n,
        },
      },
      // Already in the registry: only the community binding is attempted.
      { instanceId: pending[2]?.instanceId, identity: null },
    ]);
    expect(warnings).toEqual([
      {
        reasonCode: "LAUNCH2_ASSET_IDENTITY_UNAVAILABLE",
        count: 1,
        instanceId: pending[1]?.instanceId,
      },
      {
        reasonCode: "LAUNCH2_ASSET_IDENTITY_INVALID",
        count: 1,
        instanceId: pending[3]?.instanceId,
      },
    ]);
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

describe("launch2_event lane: official-pool swaps (Decision 0124)", () => {
  const poolManager = "0x" + "9".repeat(40);
  const poolId = hash(4242n);

  function swapLog(
    block: bigint,
    index: number,
    id = poolId,
  ): Launch2DecodedLog {
    return {
      contractAddress: poolManager,
      eventName: "Swap",
      args: {
        id,
        sender: "0x" + "5".repeat(40),
        amount0: "-1000",
        amount1: "1500",
        sqrtPriceX96: "79228162514264337593543950336",
        liquidity: "1",
        tick: "0",
        fee: "2500",
      },
      transactionHash: hash(block * 10n + BigInt(index)),
      logIndex: index,
      blockNumber: block,
      blockHash: hash(block),
    };
  }

  it("asks for the Swap logs of a graduated instance's pool id only and tags which side is MEME", async () => {
    const graduated = laneInstance({
      deployBlockNumber: "100",
      graduated: true,
      officialPoolId: poolId,
    });
    const other = laneInstance({
      deployBlockNumber: "100",
      launchId: hash(5n),
    });
    const { lane, commits, logQueries } = harness({
      instances: [graduated, other],
      head: 200n,
      logs: [swapLog(150n, 0), swapLog(151n, 0, hash(1n))],
      hookPool: { poolManager, currency0: graduated.addresses.meme },
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("seeded");
    expect(logQueries).toHaveLength(1);
    expect(logQueries[0]?.poolSwaps).toEqual(
      new Map([[poolManager, [poolId]]]),
    );
    const events = commits[0]?.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      instanceId: graduated.instanceId,
      eventName: "Swap",
      args: { id: poolId, memeIsCurrency0: "true", amount0: "-1000" },
    });
  });

  it("reads the pool of a graduation inside the same segment in a second, pool-only pass", async () => {
    const instance = laneInstance({ deployBlockNumber: "100" });
    const graduatedLog: Launch2DecodedLog = {
      contractAddress: instance.addresses.curve,
      eventName: "Graduated",
      args: { officialPoolId: poolId, soldSupply: "1", usd1Reserve: "1" },
      transactionHash: hash(9n),
      logIndex: 3,
      blockNumber: 140n,
      blockHash: hash(140n),
    };
    const { lane, commits, logQueries } = harness({
      instances: [instance],
      head: 200n,
      logs: [graduatedLog, swapLog(150n, 0)],
      hookPool: { poolManager, currency0: "0x" + "0".repeat(39) + "1" },
    });
    await lane.runOnce();
    expect(logQueries).toHaveLength(2);
    expect(logQueries[0]?.poolSwaps).toBeUndefined();
    expect(logQueries[1]).toMatchObject({ roles: 0, fromBlock: 100n });
    expect(logQueries[1]?.poolSwaps).toEqual(
      new Map([[poolManager, [poolId]]]),
    );
    expect(commits[0]?.events.map((event) => event.eventName)).toEqual([
      "Graduated",
      "Swap",
    ]);
    expect(commits[0]?.events[1]?.args["memeIsCurrency0"]).toBe("false");
  });
});

describe("launch2_event lane: router attribution (Decision 0126)", () => {
  const poolManager = "0x" + "9".repeat(40);
  const router = "0x" + "c".repeat(40);
  const buyback = "0x" + "5".repeat(40);
  const trader = "0x" + "a".repeat(40);
  const poolId = hash(4242n);

  function poolSwap(
    block: bigint,
    tx: bigint,
    index: number,
    sender = router,
    amounts: { amount0: string; amount1: string } = {
      amount0: "-1000",
      amount1: "1500",
    },
  ): Launch2DecodedLog {
    return {
      contractAddress: poolManager,
      eventName: "Swap",
      args: {
        id: poolId,
        sender,
        ...amounts,
        sqrtPriceX96: "79228162514264337593543950336",
        liquidity: "1",
        tick: "0",
        fee: "2500",
      },
      transactionHash: hash(tx),
      logIndex: index,
      blockNumber: block,
      blockHash: hash(block),
    };
  }

  function routerSwap(
    block: bigint,
    tx: bigint,
    index: number,
    overrides: Record<string, string> = {},
  ): Launch2DecodedLog {
    return {
      contractAddress: router,
      eventName: "RouterSwap",
      args: {
        poolId,
        payer: trader,
        recipient: trader,
        zeroForOne: "true",
        amountIn: "1000",
        amountOut: "1470",
        ...overrides,
      },
      transactionHash: hash(tx),
      logIndex: index,
      blockNumber: block,
      blockHash: hash(block),
    };
  }

  const graduated = () =>
    laneInstance({
      deployBlockNumber: "100",
      graduated: true,
      officialPoolId: poolId,
      graduationBlockNumber: "140",
      poolRouterTargetBlock: "120",
    });

  it("asks for the router's Swap logs by pool id and attributes the PoolManager swap it made to the payer", async () => {
    const instance = graduated();
    const { lane, commits, logQueries } = harness({
      instances: [instance],
      head: 200n,
      logs: [
        // A routed buy: PoolManager log 2, router log 5 (same tx).
        poolSwap(150n, 1n, 2),
        routerSwap(150n, 1n, 5),
        // The buyback executor: no router log, never attributed.
        poolSwap(160n, 2n, 1, buyback),
      ],
      hookPool: { poolManager, currency0: instance.addresses.meme },
      poolRouter: router,
    });
    await lane.runOnce();
    expect(logQueries[0]?.routerSwaps).toEqual({ router, poolIds: [poolId] });
    const events = commits[0]?.events ?? [];
    expect(events.map((event) => event.eventName)).toEqual([
      "Swap",
      "RouterSwap",
      "Swap",
    ]);
    expect(events[0]?.args).toMatchObject({
      routerPayer: trader,
      routerRecipient: trader,
      routerAmountIn: "1000",
      routerAmountOut: "1470",
      routerLogIndex: "5",
    });
    expect(events[1]?.instanceId).toBe(instance.instanceId);
    expect(events[2]?.args["routerPayer"]).toBeUndefined();
  });

  it("pairs only the same transaction, a router-sent swap before the router log, with the same input", () => {
    const pairs = pairLaunch2RouterSwaps(
      [
        // tx 1: two routed swaps in one transaction (a batch caller).
        poolSwap(150n, 1n, 1),
        routerSwap(150n, 1n, 2),
        poolSwap(150n, 1n, 3, router, { amount0: "-2000", amount1: "2900" }),
        routerSwap(150n, 1n, 4, {
          payer: "0x" + "b".repeat(40),
          amountIn: "2000",
        }),
        // tx 2: the router log names another input amount → unpaired.
        poolSwap(151n, 2n, 1),
        routerSwap(151n, 2n, 2, { amountIn: "999" }),
        // tx 3: the PoolManager sender is not the router → unpaired.
        poolSwap(152n, 3n, 1, buyback),
        routerSwap(152n, 3n, 2),
        // tx 4: the router log comes first → unpaired.
        routerSwap(153n, 4n, 1),
        poolSwap(153n, 4n, 2),
        // tx 5: a sell (zeroForOne false: the input is currency1).
        poolSwap(154n, 5n, 1, router, { amount0: "300", amount1: "-500" }),
        routerSwap(154n, 5n, 2, {
          zeroForOne: "false",
          amountIn: "500",
          amountOut: "294",
        }),
      ],
      router,
    );
    expect([...pairs.keys()].sort()).toEqual(
      [`${hash(1n)}:1`, `${hash(1n)}:3`, `${hash(5n)}:1`].sort(),
    );
    expect(pairs.get(`${hash(1n)}:3`)?.payer).toBe("0x" + "b".repeat(40));
    expect(pairs.get(`${hash(5n)}:1`)).toMatchObject({
      amountIn: "500",
      amountOut: "294",
      routerLogIndex: 2,
    });
  });

  it("re-scans a graduated instance once from its graduation block to attribute older swaps", async () => {
    const instance = { ...graduated(), poolRouterTargetBlock: null };
    const { lane, commits, logQueries } = harness({
      instances: [instance],
      head: 400n,
      checkpoint: {
        lastBlockNumber: "300",
        lastBlockHash: hash(300n),
        startedFromBlockNumber: "100",
        updatedAt: new Date().toISOString(),
      },
      logs: [poolSwap(150n, 1n, 2), routerSwap(150n, 1n, 5)],
      hookPool: { poolManager, currency0: instance.addresses.meme },
      poolRouter: router,
    });
    await lane.runOnce();
    expect(logQueries[0]?.fromBlock).toBe(140n);
    expect(commits[0]?.poolRouterCoverage).toEqual({
      instanceIds: [instance.instanceId],
      // The segment (140..400) already passes the old checkpoint (300).
      targetBlockNumber: "400",
    });
    expect(commits[0]?.events[0]?.args["routerPayer"]).toBe(trader);
  });

  it("reads no router logs and starts no re-scan without the router", async () => {
    const instance = { ...graduated(), poolRouterTargetBlock: null };
    const { lane, commits, logQueries } = harness({
      instances: [instance],
      head: 400n,
      checkpoint: {
        lastBlockNumber: "300",
        lastBlockHash: hash(300n),
        startedFromBlockNumber: "100",
        updatedAt: new Date().toISOString(),
      },
      logs: [poolSwap(350n, 1n, 2), routerSwap(350n, 1n, 5)],
      hookPool: { poolManager, currency0: instance.addresses.meme },
    });
    await lane.runOnce();
    expect(logQueries[0]?.fromBlock).toBe(301n);
    expect(logQueries[0]?.routerSwaps).toBeUndefined();
    expect(commits[0]?.poolRouterCoverage).toBeUndefined();
    expect(commits[0]?.events.map((event) => event.eventName)).toEqual([
      "Swap",
    ]);
    expect(commits[0]?.events[0]?.args["routerPayer"]).toBeUndefined();
  });
});

describe("launch2_event lane MEME coverage integrity (Decision 0129 §2)", () => {
  const checkpointAt = (block: bigint): Launch2Checkpoint => ({
    lastBlockNumber: block.toString(10),
    lastBlockHash: hash(block),
    startedFromBlockNumber: "100",
    updatedAt: new Date().toISOString(),
  });
  const facts = (
    instanceId: string,
    overrides: Partial<Launch2MemeCoverageFacts> = {},
  ): Launch2MemeCoverageFacts => ({
    instanceId,
    deployMintPresent: true,
    negativeBalanceCount: 0,
    failedAttempts: 0,
    ...overrides,
  });

  it("asks for the deploy-block mint of every instance deployed inside the range", async () => {
    const inside = laneInstance({ deployBlockNumber: "100" });
    const later = laneInstance({
      deployBlockNumber: "5000",
      launchId: hash(79n),
    });
    const { lane, anchorsAsked } = harness({
      instances: [inside, later],
      head: 400n,
    });
    await lane.runOnce();
    expect(anchorsAsked[0]).toEqual([
      { token: inside.addresses.meme, blockNumber: 100n },
    ]);
  });

  it("treats a range holding a deploy block without its mint as an untrusted RPC answer: unavailable, nothing committed", async () => {
    const instance = laneInstance({ deployBlockNumber: "100" });
    const { lane, commits } = harness({
      instances: [instance],
      head: 400n,
      logs: [],
      enforceMintAnchors: true,
    });
    const result = await lane.runOnce();
    expect(result).toMatchObject({
      kind: "unavailable",
      reasonCode: "LAUNCH2_RPC_LOGS_UNTRUSTED",
    });
    expect(commits).toHaveLength(0);
  });

  it("indexes the range normally when the mint is in the answer", async () => {
    const instance = laneInstance({ deployBlockNumber: "100" });
    const mint: Launch2DecodedLog = {
      contractAddress: instance.addresses.meme,
      eventName: "Transfer",
      args: { from: zeroAddress, to: instance.addresses.curve, value: "1000" },
      transactionHash: hash(1n),
      logIndex: 0,
      blockNumber: 100n,
      blockHash: hash(100n),
    };
    const { lane, commits } = harness({
      instances: [instance],
      head: 400n,
      logs: [mint],
      enforceMintAnchors: true,
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("seeded");
    expect(commits[0]?.memeTransfers).toHaveLength(1);
  });

  it("checks coverage through the committed block and marks a proven one complete (no event)", async () => {
    const instance = laneInstance({ memeTransfersTargetBlock: "2000" });
    const { lane, coverageQueries, coverageRecords, coverageEvents } = harness({
      instances: [instance],
      head: 2_500n,
      checkpoint: checkpointAt(2_000n),
      coverageChecks: [facts(instance.instanceId)],
    });
    await lane.runOnce();
    expect(coverageQueries).toEqual([
      { chainId: "eip155:97", throughBlockNumber: "2500", maxAttempts: 3 },
    ]);
    expect(coverageRecords[0]?.verdicts).toEqual([
      { kind: "complete", instanceId: instance.instanceId },
    ]);
    expect(coverageEvents).toEqual([]);
  });

  it("does not mark complete without the deploy-block mint: one more re-scan and a warning", async () => {
    const instance = laneInstance({ memeTransfersTargetBlock: "2000" });
    const { lane, coverageRecords, coverageEvents } = harness({
      instances: [instance],
      head: 2_500n,
      checkpoint: checkpointAt(2_000n),
      coverageChecks: [
        facts(instance.instanceId, { deployMintPresent: false }),
      ],
    });
    await lane.runOnce();
    expect(coverageRecords[0]?.verdicts).toEqual([
      {
        kind: "retry",
        instanceId: instance.instanceId,
        gaps: ["DEPLOY_MINT_MISSING"],
        failedAttempts: 1,
        negativeBalanceCount: 0,
      },
    ]);
    expect(coverageEvents).toEqual([
      {
        reasonCode: "LAUNCH2_MEME_COVERAGE_INCOMPLETE",
        instanceId: instance.instanceId,
        gaps: ["DEPLOY_MINT_MISSING"],
        failedAttempts: 1,
        negativeBalanceCount: 0,
        stalled: false,
      },
    ]);
  });

  it("does not mark complete with a negative balance", async () => {
    const instance = laneInstance({ memeTransfersTargetBlock: "2000" });
    const { lane, coverageRecords, coverageEvents } = harness({
      instances: [instance],
      head: 2_500n,
      checkpoint: checkpointAt(2_000n),
      coverageChecks: [
        facts(instance.instanceId, {
          negativeBalanceCount: 1,
          failedAttempts: 1,
        }),
      ],
    });
    await lane.runOnce();
    expect(coverageRecords[0]?.verdicts[0]).toMatchObject({
      kind: "retry",
      gaps: ["NEGATIVE_BALANCE"],
      failedAttempts: 2,
    });
    expect(coverageEvents[0]).toMatchObject({ stalled: false });
  });

  it("stops re-scanning after the third consecutive failure and reports it as stalled", async () => {
    const instance = laneInstance({ memeTransfersTargetBlock: "2000" });
    const { lane, coverageRecords, coverageEvents } = harness({
      instances: [instance],
      head: 2_500n,
      checkpoint: checkpointAt(2_000n),
      coverageChecks: [
        facts(instance.instanceId, {
          deployMintPresent: false,
          negativeBalanceCount: 2,
          failedAttempts: 2,
        }),
      ],
    });
    await lane.runOnce();
    expect(coverageRecords[0]?.verdicts[0]).toMatchObject({
      kind: "stalled",
      gaps: ["DEPLOY_MINT_MISSING", "NEGATIVE_BALANCE"],
      failedAttempts: 3,
    });
    expect(coverageEvents[0]).toMatchObject({
      stalled: true,
      failedAttempts: 3,
      negativeBalanceCount: 2,
    });
  });

  it("records nothing when no re-scan reached its target", async () => {
    const instance = laneInstance({ memeTransfersTargetBlock: "2000" });
    const { lane, coverageRecords } = harness({
      instances: [instance],
      head: 2_500n,
      checkpoint: checkpointAt(2_000n),
    });
    await lane.runOnce();
    expect(coverageRecords).toEqual([]);
  });
});

describe("launch2_event lane — LoopDynamic (Decision 0131)", () => {
  const poolManager = "0x" + "8".repeat(40);
  const loopRouter = "0x" + "7".repeat(40);
  const hook = `0x${"c".repeat(36)}10c4`;
  const poolId = hash(4242n);

  function dynamicInstance(overrides: Partial<Launch2LaneInstance> = {}) {
    const base = laneInstance();
    return laneInstance({
      ...base,
      addresses: { ...base.addresses, hook: zeroAddress },
      ...overrides,
    });
  }

  it("binds the Hook from LoopHookBound, re-reads the segment for its logs, and pairs each swap's fee", async () => {
    const instance = dynamicInstance();
    const adapter = instance.addresses.graduationAdapter;
    const log = (
      contractAddress: string,
      eventName: Launch2DecodedLog["eventName"],
      args: Record<string, string>,
      logIndex: number,
      blockNumber = 300n,
      tx = hash(9n),
    ): Launch2DecodedLog => ({
      contractAddress,
      eventName,
      args,
      transactionHash: tx,
      logIndex,
      blockNumber,
      blockHash: hash(blockNumber),
    });
    const logs = [
      log(adapter, "LoopHookBound", { hook, poolId }, 1),
      log(
        instance.addresses.curve,
        "Graduated",
        { officialPoolId: poolId, soldSupply: "1", usd1Reserve: "1" },
        2,
      ),
      log(
        poolManager,
        "Swap",
        {
          id: poolId,
          sender: loopRouter,
          amount0: "-100",
          amount1: "160000",
          sqrtPriceX96: "1",
        },
        3,
        310n,
        hash(10n),
      ),
      log(
        hook,
        "BuyFeeCharged",
        { buyer: "0x" + "a".repeat(40), grossMeme: "160000", fee: "3200" },
        5,
        310n,
        hash(10n),
      ),
      log(
        hook,
        "RoundActivated",
        { round: "1", startCandle: "5", carriedQuote: "0" },
        6,
        310n,
        hash(10n),
      ),
    ];
    const { lane, commits, logQueries } = harness({
      instances: [instance],
      head: 400n,
      logs,
      hookPool: { poolManager, currency0: "0x" + "2".repeat(40) },
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("seeded");
    // The first pass asks the adapter; the second asks the bound Hook and
    // the pool's swaps over the same range.
    expect(logQueries[0]?.roleMap.get(adapter)).toBe(
      "dynamicGraduationAdapter",
    );
    expect(logQueries[1]?.roleMap.get(hook)).toBe("dynamicHook");
    expect(logQueries[1]?.poolSwaps?.get(poolManager)).toEqual([poolId]);
    const events = commits[0]?.events ?? [];
    expect(events.map((event) => event.eventName)).toEqual([
      "LoopHookBound",
      "Graduated",
      "Swap",
      "BuyFeeCharged",
      "RoundActivated",
    ]);
    expect(
      events.every((event) => event.instanceId === instance.instanceId),
    ).toBe(true);
    expect(events[2]?.args).toMatchObject({
      poolHookKind: "loopDynamic",
      dynamicFee: "3200",
      memeIsCurrency0: "false",
    });
  });

  it("reads an indexed Hook's logs directly once the binding is known", async () => {
    const instance = dynamicInstance({
      graduated: true,
      officialPoolId: poolId,
      dynamicHook: hook,
    });
    const { lane, logQueries } = harness({
      instances: [instance],
      head: 400n,
      logs: [],
      hookPool: { poolManager, currency0: "0x" + "2".repeat(40) },
    });
    await lane.runOnce();
    expect(logQueries[0]?.roleMap.get(hook)).toBe("dynamicHook");
    expect(logQueries[0]?.poolSwaps?.get(poolManager)).toEqual([poolId]);
  });

  it("pairs SellFeeCharged (base + extra) with the newest earlier swap of the Hook's pool", () => {
    const swap = (logIndex: number): Launch2DecodedLog => ({
      contractAddress: poolManager,
      eventName: "Swap",
      args: { id: poolId },
      transactionHash: hash(1n),
      logIndex,
      blockNumber: 5n,
      blockHash: hash(5n),
    });
    const fee: Launch2DecodedLog = {
      contractAddress: hook,
      eventName: "SellFeeCharged",
      args: {
        round: "1",
        grossQuote: "100",
        baseFee: "2",
        extraFee: "29",
        dropWad: "1",
      },
      transactionHash: hash(1n),
      logIndex: 9,
      blockNumber: 5n,
      blockHash: hash(5n),
    };
    const paired = pairLaunch2DynamicFees(
      [swap(1), swap(4), fee],
      new Map([[hook, poolId]]),
    );
    expect([...paired.entries()]).toEqual([[`${hash(1n)}:4`, "31"]]);
  });
});

describe("launch2_event lane — LoopDynamic wallet attribution (Decision 0132)", () => {
  const poolManager = "0x" + "8".repeat(40);
  const loopRouter = "0x" + "7".repeat(40);
  const otherRouter = "0x" + "5".repeat(40);
  const wallet = "0x" + "a".repeat(40);
  const hook = `0x${"c".repeat(36)}10c4`;
  const poolId = hash(4242n);
  const txA = hash(0xa1n);
  const txB = hash(0xb1n);
  const txC = hash(0xc1n);

  function graduatedDynamic() {
    const base = laneInstance();
    return laneInstance({
      ...base,
      addresses: { ...base.addresses, hook: zeroAddress },
      graduated: true,
      officialPoolId: poolId,
      dynamicHook: hook,
    });
  }
  const swap = (
    tx: string,
    sender: string,
    logIndex: number,
  ): Launch2DecodedLog => ({
    contractAddress: poolManager,
    eventName: "Swap",
    args: {
      id: poolId,
      sender,
      amount0: "-100",
      amount1: "160000",
      sqrtPriceX96: "1",
    },
    transactionHash: tx,
    logIndex,
    blockNumber: 300n,
    blockHash: hash(300n),
  });
  const buyFee = (tx: string, logIndex: number): Launch2DecodedLog => ({
    contractAddress: hook,
    eventName: "BuyFeeCharged",
    args: { buyer: wallet, grossMeme: "160000", fee: "3200" },
    transactionHash: tx,
    logIndex,
    blockNumber: 300n,
    blockHash: hash(300n),
  });

  it("attributes a direct LoopRouter swap to tx.from (net of the Hook fee) and leaves other swaps anonymous", async () => {
    const { lane, commits, partyQueries } = harness({
      instances: [graduatedDynamic()],
      head: 400n,
      logs: [
        swap(txA, loopRouter, 1),
        buyFee(txA, 2),
        // Through LoopRouter, but not a direct call (e.g. the buyback).
        swap(txB, loopRouter, 3),
        // Another router: no transaction read at all.
        swap(txC, otherRouter, 4),
      ],
      hookPool: {
        poolManager,
        currency0: "0x" + "2".repeat(40),
        trustedRouter: loopRouter,
      },
      parties: new Map([
        [txA, { from: wallet, to: loopRouter }],
        [txB, { from: wallet, to: "0x" + "6".repeat(40) }],
      ]),
    });
    await lane.runOnce();
    expect(partyQueries).toEqual([[txA, txB]]);
    const swaps = (commits[0]?.events ?? []).filter(
      (event) => event.eventName === "Swap",
    );
    expect(swaps[0]?.args).toMatchObject({
      poolHookKind: "loopDynamic",
      dynamicFee: "3200",
      attributionSource: "transactionSender",
      routerPayer: wallet,
      routerRecipient: wallet,
      routerAmountIn: "100",
      routerAmountOut: "156800",
    });
    for (const anonymous of swaps.slice(1)) {
      expect(anonymous.args).not.toHaveProperty("routerPayer");
      expect(anonymous.args).not.toHaveProperty("attributionSource");
    }
  });

  it("attributes nothing without the Hook's trusted router or a transaction reader", async () => {
    const unreported = harness({
      instances: [graduatedDynamic()],
      head: 400n,
      logs: [swap(txA, loopRouter, 1)],
      hookPool: { poolManager, currency0: "0x" + "2".repeat(40) },
      parties: new Map([[txA, { from: wallet, to: loopRouter }]]),
    });
    await unreported.lane.runOnce();
    expect(unreported.partyQueries).toEqual([]);
    expect(unreported.commits[0]?.events[0]?.args).not.toHaveProperty(
      "routerPayer",
    );
    const noReader = harness({
      instances: [graduatedDynamic()],
      head: 400n,
      logs: [swap(txA, loopRouter, 1)],
      hookPool: {
        poolManager,
        currency0: "0x" + "2".repeat(40),
        trustedRouter: loopRouter,
      },
    });
    await noReader.lane.runOnce();
    expect(noReader.commits[0]?.events[0]?.args).not.toHaveProperty(
      "routerPayer",
    );
  });

  it("refuses two router swaps in one transaction and an output eaten by the fee", () => {
    const pools = new Map([
      [
        poolId,
        {
          poolManager,
          memeIsCurrency0: false,
          dynamicHook: hook,
          dynamicRouter: loopRouter,
        },
      ],
    ]);
    const parties = new Map([[txA, { from: wallet, to: loopRouter }]]);
    expect(
      pairLaunch2DynamicSenders({
        logs: [swap(txA, loopRouter, 1), swap(txA, loopRouter, 3)],
        pools,
        fees: new Map(),
        parties,
      }).size,
    ).toBe(0);
    expect(
      pairLaunch2DynamicSenders({
        logs: [swap(txA, loopRouter, 1)],
        pools,
        fees: new Map([[`${txA}:1`, "160000"]]),
        parties,
      }).size,
    ).toBe(0);
    expect(
      pairLaunch2DynamicSenders({
        logs: [swap(txA, loopRouter, 1)],
        pools,
        fees: new Map(),
        parties,
      }).get(`${txA}:1`),
    ).toEqual({
      payer: wallet,
      recipient: wallet,
      amountIn: "100",
      amountOut: "160000",
    });
  });
});

describe("launch2_event lane — LoopDynamic delivery attribution (Decision 0146)", () => {
  const poolManager = "0x" + "8".repeat(40);
  const loopRouter = "0x" + "7".repeat(40);
  const listedRouter = "0x" + "5".repeat(40);
  const universalRouter = "0x" + "4".repeat(40);
  const feeVault = "0x" + "9".repeat(40);
  const alice = "0x" + "a".repeat(40);
  const bob = "0x" + "b".repeat(40);
  const hook = `0x${"c".repeat(36)}10c4`;
  const meme = `0x${"d".repeat(36)}6666`;
  const poolId = hash(4242n);
  const at = (
    contractAddress: string,
    eventName: Launch2DecodedLog["eventName"],
    args: Record<string, string>,
    tx: string,
    logIndex: number,
  ): Launch2DecodedLog => ({
    contractAddress,
    eventName,
    args,
    transactionHash: tx,
    logIndex,
    blockNumber: 300n,
    blockHash: hash(300n),
  });
  const swap = (tx: string, sender: string, logIndex: number) =>
    at(
      poolManager,
      "Swap",
      {
        id: poolId,
        sender,
        amount0: "-100",
        amount1: "160000",
        sqrtPriceX96: "1",
      },
      tx,
      logIndex,
    );
  const credited = (tx: string, buyer: string, logIndex: number) =>
    at(
      hook,
      "BuyCredited",
      { round: "1", buyer, quoteSpent: "100" },
      tx,
      logIndex,
    );
  const transfer = (tx: string, from: string, to: string, logIndex: number) =>
    at(meme, "Transfer", { from, to, value: "156800" }, tx, logIndex);
  const hooks = (router: string | null) =>
    new Map([[hook, { poolId, poolManager, router, meme }]]);
  const txA = hash(0xa1n);
  const txB = hash(0xb1n);
  const txC = hash(0xc1n);
  const txD = hash(0xd1n);

  it("tells tier 1, tier 2 and delivery credits apart from the log right before them", () => {
    const logs = [
      // Tier 1: LoopRouter's swap, credit in afterSwap right after Swap.
      swap(txA, loopRouter, 1),
      credited(txA, alice, 2),
      // Tier 2: a listed router's msgSender().
      swap(txB, listedRouter, 1),
      credited(txB, bob, 2),
      // Delivery: Universal Router — fee take, BuyFeeCharged, then the
      // PoolManager's take to the user and the credit right after it.
      swap(txC, universalRouter, 1),
      transfer(txC, poolManager, feeVault, 2),
      at(
        hook,
        "BuyFeeCharged",
        { buyer: zeroAddress, grossMeme: "160000", fee: "3200" },
        txC,
        3,
      ),
      transfer(txC, poolManager, alice, 4),
      credited(txC, alice, 5),
      // An aggregator takes to itself, then forwards (CreditMoved is not
      // a BuyCredited: classified at projection time as moved).
      swap(txD, universalRouter, 1),
      transfer(txD, poolManager, universalRouter, 4),
      credited(txD, universalRouter, 5),
      transfer(txD, universalRouter, bob, 6),
      at(
        hook,
        "CreditMoved",
        { round: "1", from: universalRouter, to: bob, quoteSpent: "100" },
        txD,
        7,
      ),
    ];
    const result = classifyLaunch2DynamicCredits(logs, hooks(loopRouter));
    expect([...result.entries()]).toEqual([
      [`${txA}:2`, "loopRouter"],
      [`${txB}:2`, "registryRouter"],
      [`${txC}:5`, "delivery"],
      [`${txD}:5`, "delivery"],
    ]);
  });

  it("falls back to unknown: router unknown, the log before not read, or a transfer to someone else", () => {
    const tier = classifyLaunch2DynamicCredits(
      [swap(txA, loopRouter, 1), credited(txA, alice, 2)],
      hooks(null),
    );
    expect(tier.get(`${txA}:2`)).toBe("unknown");
    // The MEME segment was not read: only the Hook's logs are there.
    const gap = classifyLaunch2DynamicCredits(
      [swap(txC, universalRouter, 1), credited(txC, alice, 5)],
      hooks(loopRouter),
    );
    expect(gap.get(`${txC}:5`)).toBe("unknown");
    const other = classifyLaunch2DynamicCredits(
      [transfer(txC, poolManager, bob, 4), credited(txC, alice, 5)],
      hooks(loopRouter),
    );
    expect(other.get(`${txC}:5`)).toBe("unknown");
    // Another block (a reorged copy) never pairs.
    const moved = classifyLaunch2DynamicCredits(
      [
        { ...swap(txA, loopRouter, 1), blockHash: hash(301n) },
        credited(txA, alice, 2),
      ],
      hooks(loopRouter),
    );
    expect(moved.get(`${txA}:2`)).toBe("unknown");
  });

  it("stores the attribution on BuyCredited and passes CreditMoved through", async () => {
    const base = laneInstance();
    const instance = laneInstance({
      ...base,
      addresses: { ...base.addresses, hook: zeroAddress },
      graduated: true,
      officialPoolId: poolId,
      dynamicHook: hook,
    });
    const { lane, commits } = harness({
      instances: [instance],
      head: 400n,
      logs: [
        swap(txA, loopRouter, 1),
        credited(txA, alice, 2),
        swap(txB, listedRouter, 1),
        credited(txB, bob, 2),
        at(
          hook,
          "CreditMoved",
          { round: "1", from: bob, to: alice, quoteSpent: "40" },
          txB,
          9,
        ),
      ],
      hookPool: {
        poolManager,
        currency0: "0x" + "2".repeat(40),
        trustedRouter: loopRouter,
      },
    });
    await lane.runOnce();
    const events = commits[0]?.events ?? [];
    const byName = (name: string) =>
      events.filter((event) => event.eventName === name);
    expect(
      byName("BuyCredited").map((event) => event.args["attribution"]),
    ).toEqual(["loopRouter", "registryRouter"]);
    expect(byName("CreditMoved")[0]?.args).toEqual({
      round: "1",
      from: bob,
      to: alice,
      quoteSpent: "40",
    });
  });
});

describe("launch2_event lane — per-instance MEME coverage and balance checks (Decision 0132)", () => {
  const holder = "0x" + "9".repeat(40);
  function tracked(
    overrides: Partial<Launch2LaneInstance> = {},
  ): Launch2LaneInstance {
    return laneInstance({
      memeTransfersTargetBlock: "150",
      memeTransfersCoverageFailures: 0,
      ...overrides,
    });
  }
  const checkpoint = (n: bigint): Launch2Checkpoint => ({
    lastBlockNumber: n.toString(10),
    lastBlockHash: hash(n),
    startedFromBlockNumber: "100",
    updatedAt: new Date(0).toISOString(),
  });
  const transfer = (
    instance: Launch2LaneInstance,
    from: string,
    to: string,
    value: string,
    logIndex: number,
    blockNumber = 300n,
  ): Launch2DecodedLog => ({
    contractAddress: instance.addresses.meme,
    eventName: "Transfer",
    args: { from, to, value },
    transactionHash: hash(BigInt(1_000 + logIndex)),
    logIndex,
    blockNumber,
    blockHash: hash(blockNumber),
  });
  const coverageFacts = (instanceId: string): Launch2MemeCoverageFacts => ({
    instanceId,
    deployMintPresent: true,
    negativeBalanceCount: 0,
    failedAttempts: 0,
  });

  it("degrades only the instance whose mint anchor no endpoint returned; the segment still commits", async () => {
    const bad = tracked({ memeTransfersTargetBlock: null });
    const good = laneInstance();
    const { lane, commits, coverageEvents } = harness({
      instances: [bad, good],
      head: 400n,
      untrustedTokens: [bad.addresses.meme],
      ledger: () => Promise.resolve({ balances: {}, supply: "0" }),
      chainBalances: () => Promise.resolve({ balances: {}, totalSupply: "0" }),
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("seeded");
    expect(commits).toHaveLength(1);
    expect(commits[0]?.memeCoverageDegraded).toEqual([
      { instanceId: bad.instanceId, kind: "retry", failedAttempts: 1 },
    ]);
    expect(coverageEvents).toEqual([
      expect.objectContaining({
        instanceId: bad.instanceId,
        gaps: ["DEPLOY_MINT_UNTRUSTED"],
        stalled: false,
      }),
    ]);
  });

  it("vouches for an empty or partial answer with balanceOf at the segment end and completes the coverage", async () => {
    const instance = tracked();
    const curve = instance.addresses.curve;
    const ledgerCalls: unknown[] = [];
    const balanceCalls: unknown[] = [];
    const { lane, commits, coverageRecords } = harness({
      instances: [instance],
      head: 400n,
      checkpoint: checkpoint(199n),
      logs: [transfer(instance, curve, holder, "100", 1)],
      ledger: (input) => {
        ledgerCalls.push(input);
        return Promise.resolve({
          balances: { [curve]: "800" },
          supply: "1000",
        });
      },
      chainBalances: (input) => {
        balanceCalls.push(input);
        return Promise.resolve({
          balances: { [curve]: "700", [holder]: "100" },
          totalSupply: "1000",
        });
      },
      coverageChecks: [coverageFacts(instance.instanceId)],
    });
    await lane.runOnce();
    expect(ledgerCalls).toEqual([
      expect.objectContaining({
        instanceId: instance.instanceId,
        addresses: [curve, holder],
        beforeBlockNumber: "200",
      }),
    ]);
    expect(balanceCalls).toEqual([
      expect.objectContaining({
        token: instance.addresses.meme,
        blockNumber: 400n,
      }),
    ]);
    expect(commits[0]?.memeCoverageDegraded).toBeUndefined();
    expect(coverageRecords[0]?.verdicts).toEqual([
      { kind: "complete", instanceId: instance.instanceId },
    ]);
  });

  it("keeps the union with another endpoint's answer when it reconciles", async () => {
    const instance = tracked();
    const curve = instance.addresses.curve;
    const missing = transfer(instance, curve, holder, "100", 1);
    const { lane, commits } = harness({
      instances: [instance],
      head: 400n,
      checkpoint: checkpoint(199n),
      logs: [],
      ledger: () =>
        Promise.resolve({ balances: { [curve]: "800" }, supply: "1000" }),
      chainBalances: () =>
        Promise.resolve({
          balances: { [curve]: "700" },
          totalSupply: "1000",
        }),
      alternatives: [[], [missing]],
    });
    await lane.runOnce();
    expect(commits[0]?.memeCoverageDegraded).toBeUndefined();
    expect(commits[0]?.memeTransfers).toEqual([
      expect.objectContaining({
        instanceId: instance.instanceId,
        from: curve,
        to: holder,
        amount: "100",
        at: (1_000n + 300n).toString(10),
      }),
    ]);
  });

  it("degrades and re-scans when the ledger is above the chain (the one-directional gap), stalls on the third failure", async () => {
    const instance = tracked();
    const curve = instance.addresses.curve;
    const run = async (failures: number) => {
      const state = harness({
        instances: [
          tracked({ ...instance, memeTransfersCoverageFailures: failures }),
        ],
        head: 400n,
        checkpoint: checkpoint(199n),
        logs: [],
        ledger: () =>
          Promise.resolve({ balances: { [curve]: "800" }, supply: "1000" }),
        chainBalances: () =>
          Promise.resolve({
            balances: { [curve]: "600" },
            totalSupply: "1000",
          }),
        alternatives: [[]],
      });
      await state.lane.runOnce();
      return state;
    };
    const first = await run(0);
    expect(first.commits[0]?.memeCoverageDegraded).toEqual([
      { instanceId: instance.instanceId, kind: "retry", failedAttempts: 1 },
    ]);
    expect(first.coverageEvents[0]).toMatchObject({
      gaps: ["LEDGER_ABOVE_CHAIN"],
      stalled: false,
    });
    const third = await run(2);
    expect(third.commits[0]?.memeCoverageDegraded).toEqual([
      { instanceId: instance.instanceId, kind: "stalled", failedAttempts: 3 },
    ]);
    // A stalled instance is no longer checked.
    const stalled = await run(3);
    expect(stalled.commits[0]?.memeCoverageDegraded).toBeUndefined();
  });

  it("un-marks the coverage without a failure when no endpoint serves the state, and records no verdict", async () => {
    const instance = tracked();
    const { lane, commits, coverageRecords, warnings } = harness({
      instances: [instance],
      head: 400n,
      checkpoint: checkpoint(199n),
      logs: [],
      ledger: () => Promise.resolve({ balances: {}, supply: "0" }),
      chainBalances: "unavailable",
      coverageChecks: [coverageFacts(instance.instanceId)],
    });
    const result = await lane.runOnce();
    expect(result.kind).toBe("advanced");
    expect(commits[0]?.memeCoverageDegraded).toEqual([
      {
        instanceId: instance.instanceId,
        kind: "unverified",
        failedAttempts: 0,
      },
    ]);
    expect(coverageRecords[0]?.verdicts).toEqual([
      { kind: "pending", instanceId: instance.instanceId },
    ]);
    expect(warnings).toContainEqual({
      reasonCode: "LAUNCH2_MEME_BALANCE_UNVERIFIABLE",
      count: 1,
    });
  });

  it("detects a missing mint / burn through totalSupply", async () => {
    const instance = tracked();
    const { lane, coverageEvents } = harness({
      instances: [instance],
      head: 400n,
      checkpoint: checkpoint(199n),
      logs: [],
      ledger: () => Promise.resolve({ balances: {}, supply: "900" }),
      chainBalances: () =>
        Promise.resolve({ balances: {}, totalSupply: "1000" }),
    });
    await lane.runOnce();
    expect(coverageEvents[0]).toMatchObject({ gaps: ["SUPPLY_MISMATCH"] });
  });
});
