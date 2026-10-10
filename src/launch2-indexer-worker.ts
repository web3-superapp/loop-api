import { waitFor } from "./bsc-meme-indexer-worker.js";
import {
  allowlistLeaf,
  buildLaunchMerkleTree,
} from "./features/launch/launch-merkle.js";
import {
  launch2EventLane,
  launch2ReasonCodes,
} from "./features/launch2/launch2-contract.js";
import type {
  Launch2Chain,
  Launch2ContractRole,
  Launch2LaneEvent,
  Launch2LaneInstance,
  Launch2Repository,
  Launch2SnapshotMemberRecord,
} from "./features/launch2/launch2-ports.js";
import {
  deriveLaunch2Stage,
  launch2NftSaleEnd,
} from "./features/launch2/launch2-stage.js";

/**
 * Decision 0114: the `launch2_event` lane (default off,
 * `LAUNCH2_INDEXER_ENABLED`). One tick:
 *
 * 1. registers every S132 task that reached `activated` on the configured
 *    Factory (the task row is the registry: launchId + 11 module addresses);
 * 2. reads the logs of the Factory and every instance's gate / NFT /
 *    snapshot registry / curve / buyback executor over ≤ `maxLogRange`
 *    blocks, with the Decision 0034 checkpoint discipline of the S116 lanes
 *    (one `(launch2_event, chain)` checkpoint; a hash mismatch at the
 *    checkpoint rewinds by the slot's reorg depth and marks the facts above
 *    it `removed`; a newly registered instance older than the checkpoint
 *    re-scans from its deploy block — idempotent upserts);
 * 3. rebuilds a published snapshot from the indexed NFT transfers at the
 *    cutoff block and keeps the proofs only when the Merkle root and the
 *    cutoff block hash/time reproduce;
 * 4. re-derives every instance stage and `nextChangeAt` from the clock.
 *
 * It never signs or sends.
 */

export const launch2DefaultMaxLogRange = 2_000n;

export type Launch2LaneResult = {
  readonly kind:
    "seeded" | "advanced" | "reorged" | "idle" | "unavailable" | "aborted";
  readonly reasonCode: string | null;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly eventCount: number;
  readonly ignoredCount: number;
  readonly registered: number;
  readonly snapshotsChecked: number;
  readonly stagesChanged: number;
};

export interface Launch2LaneOptions {
  readonly repository: Launch2Repository;
  readonly chain: Launch2Chain;
  readonly chainId: string;
  readonly factoryAddress: string;
  readonly reorgDepthBlocks: number;
  readonly maxLogRange?: bigint;
  readonly pollIntervalMs: number;
  readonly now?: () => Date;
  readonly onWarning?: (warning: {
    readonly reasonCode: string;
    readonly count: number;
    readonly instanceId?: string;
  }) => void;
  readonly onIdle?: (reasonCode: string) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function rolesOf(
  factoryAddress: string,
  instances: readonly Launch2LaneInstance[],
): {
  readonly roles: Map<string, Launch2ContractRole>;
  readonly owners: Map<string, string>;
  readonly byLaunchId: Map<string, string>;
} {
  const roles = new Map<string, Launch2ContractRole>([
    [factoryAddress, "factory"],
  ]);
  const owners = new Map<string, string>();
  const byLaunchId = new Map<string, string>();
  for (const instance of instances) {
    byLaunchId.set(instance.launchId, instance.instanceId);
    const entries: [string, Launch2ContractRole][] = [
      [instance.addresses.gate, "gate"],
      [instance.addresses.nft, "nft"],
      [instance.addresses.snapshots, "snapshots"],
      [instance.addresses.curve, "curve"],
      [instance.addresses.buybackExecutor, "buybackExecutor"],
    ];
    for (const [address, role] of entries) {
      roles.set(address, role);
      owners.set(address, instance.instanceId);
    }
  }
  return { roles, owners, byLaunchId };
}

function result(
  kind: Launch2LaneResult["kind"],
  reasonCode: string | null,
  extra: Partial<Launch2LaneResult> = {},
): Launch2LaneResult {
  return Object.freeze({
    kind,
    reasonCode,
    fromBlockNumber: null,
    toBlockNumber: null,
    eventCount: 0,
    ignoredCount: 0,
    registered: 0,
    snapshotsChecked: 0,
    stagesChanged: 0,
    ...extra,
  });
}

export interface Launch2Lane {
  readonly lane: typeof launch2EventLane;
  runOnce(signal?: AbortSignal): Promise<Launch2LaneResult>;
  run(signal: AbortSignal): Promise<void>;
}

export function createLaunch2Lane(options: Launch2LaneOptions): Launch2Lane {
  const now = options.now ?? ((): Date => new Date());
  const maxRange = options.maxLogRange ?? launch2DefaultMaxLogRange;
  const factory = options.factoryAddress.toLowerCase();

  async function verifySnapshots(): Promise<number> {
    const pending = await options.repository.listSnapshotsToVerify(
      options.chainId,
    );
    const instances = new Map(
      (await options.repository.listLaneInstances(options.chainId)).map(
        (instance) => [instance.instanceId, instance],
      ),
    );
    for (const snapshot of pending) {
      const instance = instances.get(snapshot.instanceId);
      const holders = await options.repository.nftHoldersAt({
        instanceId: snapshot.instanceId,
        blockNumber: snapshot.cutoffBlock,
      });
      let verified = holders.length > 0;
      let tree: ReturnType<typeof buildLaunchMerkleTree> | null = null;
      if (verified) {
        tree = buildLaunchMerkleTree(holders.map((holder) => holder.address));
        verified = tree.root === snapshot.root;
      }
      // The contract binds, but does not check, the cutoff: the last
      // canonical block whose timestamp is before the NFT sale end.
      if (verified && instance !== undefined) {
        const saleEnd = launch2NftSaleEnd(
          BigInt(Math.floor(Date.parse(instance.nftSaleStart) / 1000)),
        );
        const cutoff = BigInt(snapshot.cutoffBlock);
        const [block, next] = await Promise.all([
          options.chain.getBlock(cutoff),
          options.chain.getBlock(cutoff + 1n),
        ]);
        verified =
          block !== null &&
          next !== null &&
          block.hash === snapshot.cutoffBlockHash &&
          block.timestamp < saleEnd &&
          next.timestamp >= saleEnd;
      }
      if (!verified) {
        options.onWarning?.({
          reasonCode: "LAUNCH2_SNAPSHOT_NOT_REPRODUCED",
          count: holders.length,
          instanceId: snapshot.instanceId,
        });
      }
      const members: Launch2SnapshotMemberRecord[] = holders.map((holder) => ({
        memberAddress: holder.address,
        leaf: allowlistLeaf(holder.address),
        proof: verified && tree !== null ? tree.proofFor(holder.address) : null,
        nftBalance: holder.balance,
      }));
      const publication = await options.chain.readSnapshotPublication(
        snapshot.transactionHash,
      );
      const signers =
        publication === null
          ? null
          : await options.chain.recoverSnapshotSigners({
              snapshots: snapshot.snapshots,
              launchId: snapshot.launchId,
              nft: snapshot.nft,
              cutoffBlock: BigInt(snapshot.cutoffBlock),
              cutoffBlockHash: snapshot.cutoffBlockHash,
              dataHash: snapshot.dataHash,
              root: snapshot.root,
              signatures: publication.signatures,
            });
      await options.repository.recordSnapshotVerification({
        instanceId: snapshot.instanceId,
        root: snapshot.root,
        verification: verified ? "verified" : "mismatch",
        members,
        signers,
      });
    }
    return pending.length;
  }

  async function refreshStages(): Promise<number> {
    const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
    const instances = await options.repository.listLaneInstances(
      options.chainId,
    );
    const updates = [];
    for (const instance of instances) {
      const projection = deriveLaunch2Stage({
        nowSeconds,
        nftSaleStart: BigInt(
          Math.floor(Date.parse(instance.nftSaleStart) / 1000),
        ),
        snapshotPublishedAt:
          instance.snapshotPublishedAt === null
            ? null
            : BigInt(
                Math.floor(Date.parse(instance.snapshotPublishedAt) / 1000),
              ),
        graduated: instance.graduated,
        holdReason: instance.holdReason,
      });
      const nextChangeAt =
        projection.nextChangeAt === null
          ? null
          : new Date(Number(projection.nextChangeAt) * 1000).toISOString();
      if (
        projection.stage !== instance.stage ||
        nextChangeAt !== instance.nextChangeAt
      ) {
        updates.push({
          instanceId: instance.instanceId,
          stage: projection.stage,
          nextChangeAt,
        });
      }
    }
    return updates.length === 0 ? 0 : options.repository.updateStages(updates);
  }

  async function tick(signal?: AbortSignal): Promise<Launch2LaneResult> {
    if ((await options.chain.verifyChain()) !== "ok") {
      return result("unavailable", "LAUNCH2_CHAIN_MISMATCH");
    }
    const registered = await options.repository.registerActivatedInstances({
      chainId: options.chainId,
      factoryAddress: factory,
    });
    const instances = await options.repository.listLaneInstances(
      options.chainId,
    );
    if (instances.length === 0) {
      return result("idle", launch2ReasonCodes.noInstances);
    }
    const registeredSet = new Set(registered);
    const head = await options.chain.getHead();
    if (aborted(signal)) return result("aborted", null);
    const checkpoint = await options.repository.getCheckpoint(options.chainId);
    const deployBlocks = instances.map((instance) =>
      BigInt(instance.deployBlockNumber),
    );
    const minDeploy = deployBlocks.reduce((a, b) => (a < b ? a : b));
    const newDeploys = instances
      .filter((instance) => registeredSet.has(instance.instanceId))
      .map((instance) => BigInt(instance.deployBlockNumber));
    let kind: Launch2LaneResult["kind"] = "advanced";
    let fromBlock: bigint;
    let startedFrom: bigint;
    let rewindFrom: bigint | null = null;
    if (checkpoint === null) {
      kind = "seeded";
      fromBlock = minDeploy;
      startedFrom = minDeploy;
    } else {
      startedFrom = BigInt(checkpoint.startedFromBlockNumber);
      if (minDeploy < startedFrom) startedFrom = minDeploy;
      const last = BigInt(checkpoint.lastBlockNumber);
      const observed = await options.chain.getBlock(last);
      if (observed === null || observed.hash !== checkpoint.lastBlockHash) {
        const depth = BigInt(options.reorgDepthBlocks);
        const rewound = last > depth ? last - depth : 0n;
        fromBlock = rewound > startedFrom ? rewound : startedFrom;
        rewindFrom = fromBlock;
        kind = "reorged";
      } else {
        fromBlock = last + 1n;
      }
      for (const deploy of newDeploys) {
        // A late-registered instance: re-scan from its deploy block.
        if (deploy < fromBlock) fromBlock = deploy;
      }
    }
    let scanned: Partial<Launch2LaneResult> = {};
    if (fromBlock <= head.blockNumber) {
      const maximumTo = fromBlock + maxRange - 1n;
      const toBlock =
        maximumTo < head.blockNumber ? maximumTo : head.blockNumber;
      const { roles, owners, byLaunchId } = rolesOf(factory, instances);
      const decoded = await options.chain.getLogs({
        roles,
        fromBlock,
        toBlock,
      });
      if (aborted(signal)) return result("aborted", null);
      const timestamps = new Map<bigint, bigint>();
      const events: Launch2LaneEvent[] = [];
      let ignored = decoded.ignored;
      for (const log of decoded.logs) {
        const instanceId =
          log.eventName === "LaunchDeployed"
            ? byLaunchId.get(log.args["launchId"] ?? "")
            : owners.get(log.contractAddress);
        if (instanceId === undefined) {
          // Factory deployments that are not LOOP-registered instances.
          ignored += 1;
          continue;
        }
        let at = timestamps.get(log.blockNumber);
        if (at === undefined) {
          const block = await options.chain.getBlock(log.blockNumber);
          if (block === null || block.hash !== log.blockHash) {
            // The block moved under us; the next tick re-reads it.
            return result("unavailable", "LAUNCH2_BLOCK_MOVED");
          }
          at = block.timestamp;
          timestamps.set(log.blockNumber, at);
        }
        events.push({
          instanceId,
          contractAddress: log.contractAddress,
          eventName: log.eventName,
          args: log.args,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber.toString(10),
          blockHash: log.blockHash,
          at: at.toString(10),
        });
      }
      const toHash =
        toBlock === head.blockNumber
          ? head.blockHash
          : (await options.chain.getBlock(toBlock))?.hash;
      if (toHash === undefined) {
        return result("unavailable", "LAUNCH2_BLOCK_HASH_UNAVAILABLE");
      }
      await options.repository.commitSegment({
        chainId: options.chainId,
        events,
        checkpoint: {
          lastBlockNumber: toBlock.toString(10),
          lastBlockHash: toHash,
          startedFromBlockNumber: startedFrom.toString(10),
        },
        ...(rewindFrom === null
          ? {}
          : { rewindFromBlockNumber: rewindFrom.toString(10) }),
        activationGraceBlocks: options.reorgDepthBlocks,
      });
      if (ignored > 0) {
        options.onWarning?.({
          reasonCode: "LAUNCH2_EVENTS_IGNORED",
          count: ignored,
        });
      }
      scanned = {
        fromBlockNumber: fromBlock.toString(10),
        toBlockNumber: toBlock.toString(10),
        eventCount: events.length,
        ignoredCount: ignored,
      };
    } else {
      kind = "idle";
    }
    const snapshotsChecked = await verifySnapshots();
    const stagesChanged = await refreshStages();
    return result(kind, null, {
      ...scanned,
      registered: registered.length,
      snapshotsChecked,
      stagesChanged,
    });
  }

  let inFlight: Promise<Launch2LaneResult> | null = null;
  function runOnce(signal?: AbortSignal): Promise<Launch2LaneResult> {
    if (inFlight !== null) return inFlight;
    const tracked = tick(signal).finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  }

  return Object.freeze({
    lane: launch2EventLane,
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      let lastIdle: string | null = null;
      while (!signal.aborted) {
        try {
          const outcome = await runOnce(signal);
          failures = 0;
          const idle =
            outcome.kind === "idle" || outcome.kind === "unavailable"
              ? outcome.reasonCode
              : null;
          if (idle !== null && idle !== lastIdle) options.onIdle?.(idle);
          lastIdle = idle;
          if (
            outcome.kind !== "advanced" &&
            outcome.kind !== "reorged" &&
            outcome.kind !== "seeded"
          ) {
            await waitFor(options.pollIntervalMs, signal);
          } else if (
            outcome.toBlockNumber !== null &&
            outcome.fromBlockNumber !== null &&
            BigInt(outcome.toBlockNumber) -
              BigInt(outcome.fromBlockNumber) +
              1n <
              maxRange
          ) {
            // Caught up with the head: poll instead of spinning.
            await waitFor(options.pollIntervalMs, signal);
          }
        } catch (error) {
          if (aborted(signal)) break;
          failures += 1;
          const delay = Math.min(1_000 * 2 ** (failures - 1), 60_000);
          options.onInfrastructureBackoff?.({
            lane: launch2EventLane,
            consecutiveFailureCount: failures,
            retryDelayMs: delay,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
          await waitFor(delay, signal);
        }
      }
    },
  });
}
