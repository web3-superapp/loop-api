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
  Launch2DecodedLog,
  Launch2LaneEvent,
  Launch2LaneInstance,
  Launch2MemeTransferRecord,
  Launch2Repository,
  Launch2SnapshotMemberRecord,
} from "./features/launch2/launch2-ports.js";
import {
  registerPendingLaunch2MemeAssets,
  type Launch2MemeAssetRepository,
  type Launch2TokenIdentityReader,
} from "./features/launch2/launch2-meme-assets.js";
import type { Launch2FactoryEntry } from "./features/launch2/launch2-generation.js";
import { deriveLaunch2Stage } from "./features/launch2/launch2-stage.js";
import {
  assessLaunch2MemeCoverage,
  launch2MemeCoverageMaxAttempts,
  launch2MemeCoverageReasonCode,
  type Launch2MemeCoverageGap,
} from "./features/launch2/launch2-meme-coverage.js";

/**
 * Decision 0114: the `launch2_event` lane (default off,
 * `LAUNCH2_INDEXER_ENABLED`). One tick:
 *
 * 1. registers every S132 task that reached `activated` on a configured
 *    Factory (the task row is the registry: launchId + 11 module addresses;
 *    Decision 0122: the current Factory and the read-only legacy ones, the
 *    Factory's generation recorded on the instance);
 * 2. reads the logs of the Factory and every instance's gate / NFT /
 *    snapshot registry / curve / buyback executor over ≤ `maxLogRange`
 *    blocks — Decision 0124: plus the PoolManager `Swap` logs of every
 *    graduated instance's `officialPoolId` (topic-filtered by pool id; a
 *    graduation in the same segment triggers a second, pool-only read), with the Decision 0034 checkpoint discipline of the S116 lanes
 *    (one `(launch2_event, chain)` checkpoint; a hash mismatch at the
 *    checkpoint rewinds by the slot's reorg depth and marks the facts above
 *    it `removed`; a newly registered instance older than the checkpoint
 *    re-scans from its deploy block — idempotent upserts);
 * 3. rebuilds a published snapshot from the indexed NFT transfers at the
 *    cutoff block and keeps the proofs only when the Merkle root and the
 *    cutoff block hash/time reproduce;
 * 4. re-derives every instance stage and `nextChangeAt` from the clock;
 * 5. Decision 0125: also reads every instance's MEME ERC-20 `Transfer`
 *    logs into `launch2_meme_transfers` (an instance whose coverage never
 *    started re-scans once from its deploy block, like a late-registered
 *    one), and registers each deployed MEME in the Asset Registry with the
 *    project's community binding (`memeAssets`, retried every tick).
 * 6. Decision 0129 §2: a segment that contains an instance's deploy block
 *    must return that MEME's deploy-block mint (`mintAnchors`; the reader
 *    asks the next endpoint, else the tick is `unavailable` with
 *    `LAUNCH2_RPC_LOGS_UNTRUSTED`), and a re-scan that reached its target
 *    is marked complete only when the indexed transfers hold the mint and
 *    no negative balance (else one more re-scan; after three failures the
 *    lane stops re-scanning that instance and reports it as an error).
 *
 * It never signs or sends.
 */

export const launch2DefaultMaxLogRange = 2_000n;

/** Decision 0129 §2: no endpoint returned an instance's deploy-block mint. */
const rpcLogsUntrustedReasonCode = "LAUNCH2_RPC_LOGS_UNTRUSTED";

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
  /** Decision 0125: MEME registry rows inserted this tick. */
  readonly assetsRegistered: number;
};

export interface Launch2LaneOptions {
  readonly repository: Launch2Repository;
  readonly chain: Launch2Chain;
  readonly chainId: string;
  /**
   * Decision 0122: the current Factory first, then the read-only legacy
   * ones (`LAUNCH2_LEGACY_FACTORIES`), each with its generation.
   */
  readonly factories: readonly Launch2FactoryEntry[];
  readonly reorgDepthBlocks: number;
  /**
   * Decision 0125: Asset Registry + community binding of deployed MEMEs.
   * Absent: nothing is registered (the lane still indexes).
   */
  readonly memeAssets?: {
    readonly repository: Launch2MemeAssetRepository;
    readonly reader: Launch2TokenIdentityReader;
  };
  /**
   * Decision 0126: `LAUNCH2_POOL_ROUTER_ADDRESS` (lower-case). Present: the
   * lane also reads the router's `Swap(poolId, payer, recipient, …)` logs of
   * the official pools and attributes each PoolManager swap the router made
   * to its payer; every graduated instance re-scans once from its
   * graduation block so earlier swaps are attributed too.
   */
  readonly poolRouter?: string;
  readonly maxLogRange?: bigint;
  readonly pollIntervalMs: number;
  readonly now?: () => Date;
  readonly onWarning?: (warning: {
    readonly reasonCode: string;
    readonly count: number;
    readonly instanceId?: string;
  }) => void;
  readonly onIdle?: (reasonCode: string) => void;
  /**
   * Decision 0129 §2: a MEME transfer coverage check failed. `stalled`:
   * the third consecutive failure, the lane stops re-scanning the instance
   * (operator reset needed).
   */
  readonly onMemeCoverageIncomplete?: (event: {
    readonly reasonCode: typeof launch2MemeCoverageReasonCode;
    readonly instanceId: string;
    readonly gaps: readonly Launch2MemeCoverageGap[];
    readonly failedAttempts: number;
    readonly negativeBalanceCount: number;
    readonly stalled: boolean;
  }) => void;
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
  factories: readonly Launch2FactoryEntry[],
  instances: readonly Launch2LaneInstance[],
): {
  readonly roles: Map<string, Launch2ContractRole>;
  readonly owners: Map<string, string>;
  readonly byLaunchId: Map<string, string>;
} {
  const roles = new Map<string, Launch2ContractRole>(
    factories.map((factory) => [factory.address, "factory"]),
  );
  const owners = new Map<string, string>();
  const byLaunchId = new Map<string, string>();
  for (const instance of instances) {
    byLaunchId.set(instance.launchId, instance.instanceId);
    const entries: [string, Launch2ContractRole][] = [
      [instance.addresses.gate, "gate"],
      [instance.addresses.nft, "nft"],
      [instance.addresses.snapshots, "snapshots"],
      [instance.addresses.curve, "curve"],
      // Decision 0122: the executor ABI follows the instance's generation.
      [
        instance.addresses.buybackExecutor,
        instance.generation === "v2" ? "buybackExecutorV2" : "buybackExecutor",
      ],
      // Decision 0125: MEME ERC-20 transfers (post-graduation balances).
      [instance.addresses.meme, "meme"],
    ];
    for (const [address, role] of entries) {
      roles.set(address, role);
      owners.set(address, instance.instanceId);
    }
  }
  return { roles, owners, byLaunchId };
}

function attributionArgs(
  attribution: ReturnType<typeof pairLaunch2RouterSwaps> extends Map<
    string,
    infer V
  >
    ? V | undefined
    : never,
): Record<string, string> {
  if (attribution === undefined) return {};
  return {
    routerPayer: attribution.payer,
    routerRecipient: attribution.recipient,
    routerAmountIn: attribution.amountIn,
    routerAmountOut: attribution.amountOut,
    routerLogIndex: String(attribution.routerLogIndex),
  };
}

interface PoolOwner {
  readonly instanceId: string;
  readonly poolManager: string;
  readonly memeIsCurrency0: boolean;
}

/** PoolManager → the pool ids it serves (lane → chain filter). */
function poolFilter(
  pools: ReadonlyMap<string, PoolOwner>,
): Map<string, string[]> {
  const filter = new Map<string, string[]>();
  for (const [poolId, owner] of pools) {
    const ids = filter.get(owner.poolManager) ?? [];
    ids.push(poolId);
    filter.set(owner.poolManager, ids);
  }
  return filter;
}

/**
 * Decision 0126: pairs each router `Swap` with the PoolManager `Swap` it
 * caused — same transaction, same pool id, PoolManager `sender` = the
 * router, the newest such log before the router's, not paired yet, and the
 * same input amount (the router's `amountIn` = the swap's negative input
 * delta). Returns PoolManager log key → the router's attribution.
 */
export function pairLaunch2RouterSwaps(
  logs: readonly Launch2DecodedLog[],
  router: string,
): Map<
  string,
  {
    readonly payer: string;
    readonly recipient: string;
    readonly amountIn: string;
    readonly amountOut: string;
    readonly routerLogIndex: number;
  }
> {
  const paired = new Map<
    string,
    {
      readonly payer: string;
      readonly recipient: string;
      readonly amountIn: string;
      readonly amountOut: string;
      readonly routerLogIndex: number;
    }
  >();
  const keyOf = (log: Launch2DecodedLog): string =>
    `${log.transactionHash}:${log.logIndex}`;
  for (const routed of logs) {
    if (
      routed.eventName !== "RouterSwap" ||
      routed.contractAddress !== router
    ) {
      continue;
    }
    const poolId = routed.args["poolId"];
    const zeroForOne = routed.args["zeroForOne"];
    const amountIn = routed.args["amountIn"];
    if (poolId === undefined || amountIn === undefined) continue;
    let match: Launch2DecodedLog | null = null;
    for (const swap of logs) {
      if (
        swap.eventName === "Swap" &&
        swap.transactionHash === routed.transactionHash &&
        swap.blockHash === routed.blockHash &&
        swap.logIndex < routed.logIndex &&
        swap.args["id"] === poolId &&
        swap.args["sender"] === router &&
        !paired.has(keyOf(swap)) &&
        (match === null || swap.logIndex > match.logIndex)
      ) {
        match = swap;
      }
    }
    if (match === null) continue;
    const inputDelta = BigInt(
      (zeroForOne === "true" ? match.args["amount0"] : match.args["amount1"]) ??
        "0",
    );
    if (-inputDelta !== BigInt(amountIn)) continue;
    paired.set(keyOf(match), {
      payer: routed.args["payer"] ?? "",
      recipient: routed.args["recipient"] ?? "",
      amountIn,
      amountOut: routed.args["amountOut"] ?? "0",
      routerLogIndex: routed.logIndex,
    });
  }
  return paired;
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
    assetsRegistered: 0,
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
  const factories = options.factories.map((factory) =>
    Object.freeze({ ...factory, address: factory.address.toLowerCase() }),
  );
  const poolRouter = options.poolRouter?.toLowerCase() ?? null;

  /** Hook → (PoolManager, currency0): immutable, read once per hook. */
  const hookPools = new Map<
    string,
    { readonly poolManager: string; readonly currency0: string }
  >();

  async function addPools(
    into: Map<string, PoolOwner>,
    entries: readonly {
      readonly instance: Launch2LaneInstance;
      readonly poolId: string;
    }[],
  ): Promise<void> {
    for (const { instance, poolId } of entries) {
      const hook = instance.addresses.hook;
      let facts = hookPools.get(hook);
      if (facts === undefined) {
        facts = await options.chain.readHookPool(hook);
        hookPools.set(hook, facts);
      }
      into.set(poolId.toLowerCase(), {
        instanceId: instance.instanceId,
        poolManager: facts.poolManager,
        memeIsCurrency0: facts.currency0 === instance.addresses.meme,
      });
    }
  }

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
        const saleEnd = BigInt(
          Math.floor(Date.parse(instance.nftSaleEnd) / 1000),
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

  /**
   * Decision 0129 §2: re-scans whose target the checkpoint reached are
   * complete only when the indexed transfers prove it.
   */
  async function checkMemeCoverage(throughBlock: bigint): Promise<void> {
    const checks = await options.repository.listMemeCoverageChecks({
      chainId: options.chainId,
      throughBlockNumber: throughBlock.toString(10),
      maxAttempts: launch2MemeCoverageMaxAttempts,
    });
    if (checks.length === 0) return;
    const verdicts = checks.map((facts) => assessLaunch2MemeCoverage(facts));
    await options.repository.recordMemeCoverage({
      chainId: options.chainId,
      verdicts,
    });
    for (const verdict of verdicts) {
      if (verdict.kind === "complete") continue;
      options.onMemeCoverageIncomplete?.({
        reasonCode: launch2MemeCoverageReasonCode,
        instanceId: verdict.instanceId,
        gaps: verdict.gaps,
        failedAttempts: verdict.failedAttempts,
        negativeBalanceCount: verdict.negativeBalanceCount,
        stalled: verdict.kind === "stalled",
      });
    }
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
        nftSaleEnd: BigInt(Math.floor(Date.parse(instance.nftSaleEnd) / 1000)),
        snapshotPublishedAt:
          instance.snapshotPublishedAt === null
            ? null
            : BigInt(
                Math.floor(Date.parse(instance.snapshotPublishedAt) / 1000),
              ),
        graduated: instance.graduated,
        holdReason: instance.holdReason,
        closedNoHolders: instance.closedNoHolders,
        openedWithoutHoldersAt:
          instance.openedWithoutHoldersAt === null
            ? null
            : BigInt(
                Math.floor(Date.parse(instance.openedWithoutHoldersAt) / 1000),
              ),
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
      factories: factories.map(({ address, generation }) => ({
        address,
        generation,
      })),
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
    // Decision 0125: instances whose MEME transfer coverage never started
    // re-scan once from their deploy block (idempotent upserts).
    const memeRescans = instances.filter(
      (instance) => instance.memeTransfersTargetBlock === null,
    );
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
    // The re-scan must reach the block the lane had already passed.
    const memeTarget =
      checkpoint === null ? null : BigInt(checkpoint.lastBlockNumber);
    for (const instance of memeRescans) {
      const deploy = BigInt(instance.deployBlockNumber);
      if (deploy < fromBlock) fromBlock = deploy;
    }
    // Decision 0126: graduated instances whose router attribution never
    // started re-scan once from their graduation block (idempotent upserts
    // that only fill the missing wallet).
    const routerRescans =
      poolRouter === null
        ? []
        : instances.filter(
            (instance) =>
              instance.poolRouterTargetBlock === null &&
              instance.officialPoolId !== null &&
              instance.graduationBlockNumber !== undefined &&
              instance.graduationBlockNumber !== null,
          );
    for (const instance of routerRescans) {
      const graduated = BigInt(instance.graduationBlockNumber as string);
      if (graduated < fromBlock) fromBlock = graduated;
    }
    let scanned: Partial<Launch2LaneResult> = {};
    if (fromBlock <= head.blockNumber) {
      const maximumTo = fromBlock + maxRange - 1n;
      const toBlock =
        maximumTo < head.blockNumber ? maximumTo : head.blockNumber;
      const { roles, owners, byLaunchId } = rolesOf(factories, instances);
      // Decision 0124: the official pools of graduated instances (Swap logs
      // by pool id); a graduation inside this very segment is read in a
      // second pass over the same range.
      const pools = new Map<string, PoolOwner>();
      const known = instances.flatMap((instance) =>
        instance.officialPoolId === null
          ? []
          : [{ instance, poolId: instance.officialPoolId }],
      );
      await addPools(pools, known);
      const routerFilter = (
        ids: ReadonlyMap<string, PoolOwner>,
      ): { routerSwaps?: { router: string; poolIds: string[] } } =>
        poolRouter === null || ids.size === 0
          ? {}
          : { routerSwaps: { router: poolRouter, poolIds: [...ids.keys()] } };
      // Decision 0129 §2: every MEME mints at its deploy block; an answer
      // for a range holding that block without the mint is untrusted.
      const mintAnchors = instances.flatMap((instance) => {
        const deploy = BigInt(instance.deployBlockNumber);
        return deploy >= fromBlock && deploy <= toBlock
          ? [{ token: instance.addresses.meme, blockNumber: deploy }]
          : [];
      });
      let first: Awaited<ReturnType<Launch2Chain["getLogs"]>>;
      try {
        first = await options.chain.getLogs({
          roles,
          fromBlock,
          toBlock,
          ...(pools.size === 0 ? {} : { poolSwaps: poolFilter(pools) }),
          ...routerFilter(pools),
          ...(mintAnchors.length === 0 ? {} : { mintAnchors }),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error as { reasonCode?: unknown }).reasonCode ===
            rpcLogsUntrustedReasonCode
        ) {
          return result("unavailable", rpcLogsUntrustedReasonCode);
        }
        throw error;
      }
      const byInstance = new Map(
        instances.map((instance) => [instance.instanceId, instance]),
      );
      const fresh = new Map<string, PoolOwner>();
      await addPools(
        fresh,
        first.logs.flatMap((log) => {
          const owner = owners.get(log.contractAddress);
          const instance =
            owner === undefined ? undefined : byInstance.get(owner);
          const poolId = log.args["officialPoolId"];
          return log.eventName === "Graduated" &&
            instance !== undefined &&
            poolId !== undefined &&
            !pools.has(poolId)
            ? [{ instance, poolId }]
            : [];
        }),
      );
      const second =
        fresh.size === 0
          ? null
          : await options.chain.getLogs({
              roles: new Map(),
              fromBlock,
              toBlock,
              poolSwaps: poolFilter(fresh),
              ...routerFilter(fresh),
            });
      for (const [poolId, owner] of fresh) pools.set(poolId, owner);
      const decoded = {
        logs: [...first.logs, ...(second?.logs ?? [])].sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
        ),
        ignored: first.ignored + (second?.ignored ?? 0),
      };
      if (aborted(signal)) return result("aborted", null);
      const attributions =
        poolRouter === null
          ? new Map<string, never>()
          : pairLaunch2RouterSwaps(decoded.logs, poolRouter);
      const timestamps = new Map<bigint, bigint>();
      const events: Launch2LaneEvent[] = [];
      const memeTransfers: Launch2MemeTransferRecord[] = [];
      let ignored = decoded.ignored;
      for (const log of decoded.logs) {
        const swapPool =
          log.eventName === "Swap"
            ? pools.get(log.args["id"] ?? "")
            : log.eventName === "RouterSwap"
              ? pools.get(log.args["poolId"] ?? "")
              : undefined;
        const instanceId =
          log.eventName === "LaunchDeployed"
            ? byLaunchId.get(log.args["launchId"] ?? "")
            : log.eventName === "Swap"
              ? swapPool?.poolManager === log.contractAddress
                ? swapPool.instanceId
                : undefined
              : log.eventName === "RouterSwap"
                ? poolRouter !== null && log.contractAddress === poolRouter
                  ? swapPool?.instanceId
                  : undefined
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
        if (roles.get(log.contractAddress) === "meme") {
          memeTransfers.push({
            instanceId,
            from: log.args["from"] ?? "",
            to: log.args["to"] ?? "",
            amount: log.args["value"] ?? "",
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            blockNumber: log.blockNumber.toString(10),
            blockHash: log.blockHash,
            at: at.toString(10),
          });
          continue;
        }
        events.push({
          instanceId,
          contractAddress: log.contractAddress,
          eventName: log.eventName,
          // Decision 0124: which side of a Swap is MEME (hook currency0).
          args:
            swapPool === undefined || log.eventName !== "Swap"
              ? log.args
              : Object.freeze({
                  ...log.args,
                  memeIsCurrency0: swapPool.memeIsCurrency0 ? "true" : "false",
                  // Decision 0126: the router's payer / recipient, if paired.
                  ...attributionArgs(
                    attributions.get(`${log.transactionHash}:${log.logIndex}`),
                  ),
                }),
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
        ...(memeTransfers.length === 0 ? {} : { memeTransfers }),
        ...(routerRescans.length === 0
          ? {}
          : {
              poolRouterCoverage: {
                instanceIds: routerRescans.map(
                  (instance) => instance.instanceId,
                ),
                targetBlockNumber: (memeTarget !== null && memeTarget > toBlock
                  ? memeTarget
                  : toBlock
                ).toString(10),
              },
            }),
        ...(memeRescans.length === 0
          ? {}
          : {
              memeTransferCoverage: {
                instanceIds: memeRescans.map((instance) => instance.instanceId),
                targetBlockNumber: (memeTarget !== null && memeTarget > toBlock
                  ? memeTarget
                  : toBlock
                ).toString(10),
              },
            }),
      });
      if (ignored > 0) {
        options.onWarning?.({
          reasonCode: "LAUNCH2_EVENTS_IGNORED",
          count: ignored,
        });
      }
      await checkMemeCoverage(toBlock);
      scanned = {
        fromBlockNumber: fromBlock.toString(10),
        toBlockNumber: toBlock.toString(10),
        eventCount: events.length + memeTransfers.length,
        ignoredCount: ignored,
      };
    } else {
      kind = "idle";
    }
    const snapshotsChecked = await verifySnapshots();
    const stagesChanged = await refreshStages();
    const assets =
      options.memeAssets === undefined
        ? null
        : await registerPendingLaunch2MemeAssets({
            repository: options.memeAssets.repository,
            reader: options.memeAssets.reader,
            chainId: options.chainId,
            ...(options.onWarning === undefined
              ? {}
              : { onWarning: options.onWarning }),
          });
    return result(kind, null, {
      ...scanned,
      registered: registered.length,
      snapshotsChecked,
      stagesChanged,
      assetsRegistered: assets?.registered ?? 0,
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
