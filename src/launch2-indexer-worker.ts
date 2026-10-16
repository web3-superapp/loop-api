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
  Launch2DynamicCreditAttribution,
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
  launch2DynamicBuyFeeTokenOfLog,
  launch2HookKindOf,
  type Launch2DynamicBuyFeeToken,
} from "./features/launch2/launch2-dynamic.js";
import { launch2PoolSwapFacts } from "./features/launch2/launch2-pool.js";
import {
  assessLaunch2MemeCoverage,
  compareLaunch2MemeBalances,
  launch2MemeCoverageMaxAttempts,
  launch2MemeCoverageReasonCode,
  selectLaunch2MemeBalanceSample,
  type Launch2MemeBalanceVerdict,
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
 * 7. Decision 0131: a LoopDynamic instance (registry hook = 0) also has its
 *    graduation adapter read for `LoopHookBound(hook, poolId)`, and once the
 *    Hook is known (indexed, or bound in this very segment: a second pass
 *    over the same range) the Hook's fee / candle / round / reward logs.
 *    Its pool swaps are read like the OfficialTax ones (PoolManager `Swap`
 *    by pool id, PoolManager and currency0 from the Hook); each swap's fee
 *    is the Hook's `BuyFeeCharged` / `SellFeeCharged` of the same swap
 *    (`pairLaunch2DynamicFees`). OfficialTax instances are unaffected.
 *
 * It never signs or sends.
 */

export const launch2DefaultMaxLogRange = 2_000n;

const zeroAddress = "0x0000000000000000000000000000000000000000";

/** Decision 0129 §2: no endpoint returned an instance's deploy-block mint. */
const rpcLogsUntrustedReasonCode = "LAUNCH2_RPC_LOGS_UNTRUSTED";

export type Launch2LaneResult = {
  readonly kind:
    "seeded" | "advanced" | "reorged" | "idle" | "unavailable" | "aborted";
  readonly reasonCode: string | null;
  readonly fromBlockNumber: string | null;
  readonly toBlockNumber: string | null;
  readonly eventCount: number;
  /** A tracked address's log whose topic its role does not know. */
  readonly ignoredCount: number;
  /**
   * Decision 0135: logs that are not ours — an address outside the tracked
   * set, or a tracked Factory / PoolManager / router log of an instance
   * LOOP did not register. Debug-level, never a warning.
   */
  readonly skippedForeignCount: number;
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
  /** Decision 0135: per tick, the count of logs that are not ours (debug). */
  readonly onSkippedForeign?: (count: number) => void;
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
    // Decision 0131: LoopDynamic — the adapter's Hook binding, then the Hook.
    if (launch2HookKindOf(instance.addresses.hook) === "loopDynamic") {
      entries.push([
        instance.addresses.graduationAdapter,
        "dynamicGraduationAdapter",
      ]);
      const hook = instance.dynamicHook ?? null;
      if (hook !== null) entries.push([hook, "dynamicHook"]);
    }
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

function senderAttributionArgs(
  attribution:
    | {
        readonly payer: string;
        readonly recipient: string;
        readonly amountIn: string;
        readonly amountOut: string;
      }
    | undefined,
): Record<string, string> {
  if (attribution === undefined) return {};
  return {
    attributionSource: "transactionSender",
    routerPayer: attribution.payer,
    routerRecipient: attribution.recipient,
    routerAmountIn: attribution.amountIn,
    routerAmountOut: attribution.amountOut,
  };
}

interface PoolOwner {
  readonly instanceId: string;
  readonly poolManager: string;
  readonly memeIsCurrency0: boolean;
  /** Decision 0131: the LoopDynamic Hook of the pool (null: OfficialTax). */
  readonly dynamicHook: string | null;
  /**
   * Decision 0132: the LoopDynamic Hook's `trustedRouter()` (LoopRouter);
   * null for OfficialTax or a reader that does not report it.
   */
  readonly dynamicRouter: string | null;
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

/**
 * Decision 0131: pairs each LoopDynamic Hook fee log with the PoolManager
 * `Swap` it charged — same transaction and block, the Hook's pool, the
 * newest such swap before the fee log, not paired yet (the PoolManager
 * emits `Swap` before it calls `afterSwap`, where the Hook takes the fee).
 * `SellFeeCharged` is `baseFee + extraFee` USD1. `BuyFeeCharged.fee`:
 * Decision 0152 (loop-contracts Decision 0015) — an S209 Hook's
 * `BuyFeeCharged(round, buyer, grossQuote, fee)` is USD1 taken from the
 * input in `beforeSwap` (charged in `afterSwap`, so still after the
 * `Swap`), a pre-S209 Hook's `BuyFeeCharged(buyer, grossMeme, fee)` is
 * MEME taken from the output. Returns PoolManager log key → the fee (raw
 * integer string) and its token.
 */
export function pairLaunch2DynamicFeeFacts(
  logs: readonly Launch2DecodedLog[],
  hookPools: ReadonlyMap<string, string>,
): Map<
  string,
  { readonly fee: string; readonly token: Launch2DynamicBuyFeeToken }
> {
  const paired = new Map<
    string,
    { readonly fee: string; readonly token: Launch2DynamicBuyFeeToken }
  >();
  const keyOf = (log: Launch2DecodedLog): string =>
    `${log.transactionHash}:${log.logIndex}`;
  for (const charged of logs) {
    if (
      charged.eventName !== "BuyFeeCharged" &&
      charged.eventName !== "SellFeeCharged"
    ) {
      continue;
    }
    const poolId = hookPools.get(charged.contractAddress);
    if (poolId === undefined) continue;
    let match: Launch2DecodedLog | null = null;
    for (const swap of logs) {
      if (
        swap.eventName === "Swap" &&
        swap.transactionHash === charged.transactionHash &&
        swap.blockHash === charged.blockHash &&
        swap.logIndex < charged.logIndex &&
        swap.args["id"] === poolId &&
        !paired.has(keyOf(swap)) &&
        (match === null || swap.logIndex > match.logIndex)
      ) {
        match = swap;
      }
    }
    if (match === null) continue;
    const fee =
      charged.eventName === "BuyFeeCharged"
        ? BigInt(charged.args["fee"] ?? "0")
        : BigInt(charged.args["baseFee"] ?? "0") +
          BigInt(charged.args["extraFee"] ?? "0");
    paired.set(
      keyOf(match),
      Object.freeze({
        fee: fee.toString(10),
        token:
          charged.eventName === "BuyFeeCharged"
            ? launch2DynamicBuyFeeTokenOfLog(charged.args)
            : "usd1",
      }),
    );
  }
  return paired;
}

/** Decision 0131: `pairLaunch2DynamicFeeFacts` without the token. */
export function pairLaunch2DynamicFees(
  logs: readonly Launch2DecodedLog[],
  hookPools: ReadonlyMap<string, string>,
): Map<string, string> {
  return new Map(
    [...pairLaunch2DynamicFeeFacts(logs, hookPools)].map(([key, value]) => [
      key,
      value.fee,
    ]),
  );
}

/** Decision 0146: how a LoopDynamic Hook credited a buy's weight. */
export type Launch2DynamicBuyCreditAttribution = Exclude<
  Launch2DynamicCreditAttribution,
  "moved"
>;

/**
 * Decision 0146 (loop-contracts S200, Decision 0014 §2): tells each
 * `BuyCredited` of a LoopDynamic Hook apart from the log right before it in
 * the same transaction and block (`logIndex − 1`):
 *
 * - the PoolManager `Swap` of the Hook's pool — tiers 1 / 2 credit in
 *   `afterSwap`, the first log after the swap: `sender` = the Hook's
 *   trusted LoopRouter → `loopRouter`, another router → `registryRouter`
 *   (a listed router's `msgSender()`); the trusted router unknown →
 *   `unknown`;
 * - the instance MEME's `Transfer` from the PoolManager to the credited
 *   address — the S200 transfer hook credits a `take` right after the
 *   transfer → `delivery`;
 * - anything else (a log not read, e.g. an untrusted MEME segment) →
 *   `unknown`.
 *
 * Returns Hook log key → attribution (every BuyCredited of a known Hook).
 */
export function classifyLaunch2DynamicCredits(
  logs: readonly Launch2DecodedLog[],
  hooks: ReadonlyMap<
    string,
    {
      readonly poolId: string;
      readonly poolManager: string;
      readonly router: string | null;
      readonly meme: string | null;
    }
  >,
): Map<string, Launch2DynamicBuyCreditAttribution> {
  const keyOf = (log: Launch2DecodedLog): string =>
    `${log.transactionHash}:${log.logIndex}`;
  const byKey = new Map(logs.map((log) => [keyOf(log), log]));
  const result = new Map<string, Launch2DynamicBuyCreditAttribution>();
  for (const credit of logs) {
    if (credit.eventName !== "BuyCredited") continue;
    const hook = hooks.get(credit.contractAddress);
    if (hook === undefined) continue;
    const prev =
      credit.logIndex === 0
        ? undefined
        : byKey.get(`${credit.transactionHash}:${credit.logIndex - 1}`);
    let attribution: Launch2DynamicBuyCreditAttribution = "unknown";
    if (prev !== undefined && prev.blockHash === credit.blockHash) {
      if (
        prev.eventName === "Swap" &&
        prev.contractAddress === hook.poolManager &&
        prev.args["id"] === hook.poolId
      ) {
        if (hook.router !== null) {
          attribution =
            prev.args["sender"] === hook.router
              ? "loopRouter"
              : "registryRouter";
        }
      } else if (
        prev.eventName === "Transfer" &&
        hook.meme !== null &&
        prev.contractAddress === hook.meme &&
        prev.args["from"] === hook.poolManager &&
        prev.args["to"] === credit.args["buyer"]
      ) {
        attribution = "delivery";
      }
    }
    result.set(keyOf(credit), attribution);
  }
  return result;
}

/**
 * Decision 0132: the LoopDynamic swaps attributable to a wallet — the
 * coordinator's ruling: LoopRouter emits no event and the user's wallet
 * calls it directly, so the trader is the transaction's `from`. A
 * PoolManager `Swap` of a LoopDynamic pool is attributed when
 *
 * - its `sender` is the pool Hook's trusted LoopRouter,
 * - the transaction's `to` is that LoopRouter (a direct call; the buyback
 *   reaches LoopRouter through its executor / adapter and other routers
 *   or contract wallets have another `to`), and
 * - it is the only such swap of the transaction (one direct
 *   `swapExactInput` call swaps exactly once),
 *
 * with `amountIn` = the swap's input and `amountOut` = its output minus the
 * Hook fee of the same swap (`pairLaunch2DynamicFees`; LoopRouter pays the
 * caller exactly that). Decision 0152: a USD1 buy fee (S209 Hook,
 * `feeTokens`) was taken from the input instead — `amountIn` = the swap's
 * pool input + the fee (what the caller paid), `amountOut` = the whole
 * MEME output. Everything else stays anonymous: pool statistics
 * only. Returns PoolManager log key → attribution.
 */
export function pairLaunch2DynamicSenders(input: {
  readonly logs: readonly Launch2DecodedLog[];
  readonly pools: ReadonlyMap<
    string,
    Pick<
      PoolOwner,
      "poolManager" | "memeIsCurrency0" | "dynamicHook" | "dynamicRouter"
    >
  >;
  readonly fees: ReadonlyMap<string, string>;
  /** Decision 0152: the paired fee's token (absent = MEME / sell USD1). */
  readonly feeTokens?: ReadonlyMap<string, Launch2DynamicBuyFeeToken>;
  readonly parties: ReadonlyMap<
    string,
    { readonly from: string; readonly to: string | null }
  >;
}): Map<
  string,
  {
    readonly payer: string;
    readonly recipient: string;
    readonly amountIn: string;
    readonly amountOut: string;
  }
> {
  const keyOf = (log: Launch2DecodedLog): string =>
    `${log.transactionHash}:${log.logIndex}`;
  const routed = input.logs.filter((log) => {
    if (log.eventName !== "Swap") return false;
    const pool = input.pools.get(log.args["id"] ?? "");
    return (
      pool !== undefined &&
      pool.dynamicHook !== null &&
      pool.dynamicRouter !== null &&
      pool.poolManager === log.contractAddress &&
      log.args["sender"] === pool.dynamicRouter
    );
  });
  const perTransaction = new Map<string, number>();
  for (const log of routed) {
    perTransaction.set(
      log.transactionHash,
      (perTransaction.get(log.transactionHash) ?? 0) + 1,
    );
  }
  const attributed = new Map<
    string,
    {
      readonly payer: string;
      readonly recipient: string;
      readonly amountIn: string;
      readonly amountOut: string;
    }
  >();
  for (const log of routed) {
    const pool = input.pools.get(log.args["id"] ?? "");
    const party = input.parties.get(log.transactionHash);
    if (
      pool === undefined ||
      party === undefined ||
      party.to === null ||
      party.to !== pool.dynamicRouter ||
      perTransaction.get(log.transactionHash) !== 1 ||
      !/^0x[0-9a-f]{40}$/u.test(party.from)
    ) {
      continue;
    }
    let facts: ReturnType<typeof launch2PoolSwapFacts>;
    try {
      facts = launch2PoolSwapFacts({
        amount0: BigInt(log.args["amount0"] ?? "0"),
        amount1: BigInt(log.args["amount1"] ?? "0"),
        memeIsCurrency0: pool.memeIsCurrency0,
      });
    } catch {
      continue;
    }
    if (facts === null) continue;
    const fee = BigInt(input.fees.get(keyOf(log)) ?? "0");
    const usd1BuyFee =
      facts.side === "buy" && input.feeTokens?.get(keyOf(log)) === "usd1";
    const amountIn =
      facts.side === "buy"
        ? facts.usd1Amount + (usd1BuyFee ? fee : 0n)
        : facts.memeAmount;
    const gross = facts.side === "buy" ? facts.memeAmount : facts.usd1Amount;
    const amountOut = usd1BuyFee ? gross : gross - fee;
    if (amountIn <= 0n || amountOut <= 0n) continue;
    attributed.set(keyOf(log), {
      payer: party.from,
      recipient: party.from,
      amountIn: amountIn.toString(10),
      amountOut: amountOut.toString(10),
    });
  }
  return attributed;
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
    skippedForeignCount: 0,
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
    {
      readonly poolManager: string;
      readonly currency0: string;
      /** Decision 0132: LoopDynamic only. */
      readonly trustedRouter?: string;
    }
  >();

  async function addPools(
    into: Map<string, PoolOwner>,
    entries: readonly {
      readonly instance: Launch2LaneInstance;
      readonly poolId: string;
      /** Decision 0131: the LoopDynamic Hook (null: OfficialTax). */
      readonly dynamicHook?: string | null;
    }[],
  ): Promise<void> {
    for (const { instance, poolId, dynamicHook } of entries) {
      const dynamic =
        launch2HookKindOf(instance.addresses.hook) === "loopDynamic";
      const hook = dynamic ? (dynamicHook ?? null) : instance.addresses.hook;
      // A LoopDynamic pool whose Hook binding is not indexed yet waits.
      if (hook === null) continue;
      let facts = hookPools.get(hook);
      if (facts === undefined) {
        facts = dynamic
          ? await options.chain.readDynamicHookPool(hook)
          : await options.chain.readHookPool(hook);
        hookPools.set(hook, facts);
      }
      into.set(poolId.toLowerCase(), {
        instanceId: instance.instanceId,
        poolManager: facts.poolManager,
        memeIsCurrency0: facts.currency0 === instance.addresses.meme,
        dynamicHook: dynamic ? hook : null,
        dynamicRouter: dynamic ? (facts.trustedRouter ?? null) : null,
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
  async function checkMemeCoverage(
    throughBlock: bigint,
    /** Decision 0132: this tick's `balanceOf` verdicts at `throughBlock`. */
    balances: ReadonlyMap<string, Launch2MemeBalanceVerdict>,
  ): Promise<void> {
    const checks = await options.repository.listMemeCoverageChecks({
      chainId: options.chainId,
      throughBlockNumber: throughBlock.toString(10),
      maxAttempts: launch2MemeCoverageMaxAttempts,
    });
    if (checks.length === 0) return;
    const verdicts = checks.map((facts) => {
      const balance = balances.get(facts.instanceId);
      return assessLaunch2MemeCoverage(
        balance === undefined ? facts : { ...facts, balance },
      );
    });
    await options.repository.recordMemeCoverage({
      chainId: options.chainId,
      verdicts,
    });
    for (const verdict of verdicts) {
      if (verdict.kind === "complete" || verdict.kind === "pending") continue;
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

  /**
   * Decision 0132: what this segment proves about each tracked instance's
   * MEME transfer coverage (see `launch2-meme-coverage.ts`). Pure reads;
   * the degradations are committed with the segment.
   */
  async function verifyMemeSegment(input: {
    readonly instances: readonly Launch2LaneInstance[];
    readonly untrustedTokens: ReadonlySet<string>;
    readonly memeTransfers: readonly Launch2MemeTransferRecord[];
    readonly pools: ReadonlyMap<string, PoolOwner>;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly timestamps: Map<bigint, bigint>;
  }): Promise<
    | { readonly kind: "moved" }
    | {
        readonly kind: "ok";
        readonly ran: boolean;
        readonly memeTransfers: Launch2MemeTransferRecord[];
        readonly degraded: {
          readonly instanceId: string;
          readonly kind: "retry" | "stalled" | "unverified";
          readonly failedAttempts: number;
        }[];
        readonly events: Parameters<
          NonNullable<Launch2LaneOptions["onMemeCoverageIncomplete"]>
        >[0][];
        readonly balances: Map<string, Launch2MemeBalanceVerdict>;
        readonly unverifiedCount: number;
      }
  > {
    let transfers = [...input.memeTransfers];
    const degraded: {
      readonly instanceId: string;
      readonly kind: "retry" | "stalled" | "unverified";
      readonly failedAttempts: number;
    }[] = [];
    const events: Parameters<
      NonNullable<Launch2LaneOptions["onMemeCoverageIncomplete"]>
    >[0][] = [];
    const balances = new Map<string, Launch2MemeBalanceVerdict>();
    let unverifiedCount = 0;
    let ran = false;
    const ledgerOf = options.repository.memeLedgerBalances?.bind(
      options.repository,
    );
    if (ledgerOf === undefined) {
      return {
        kind: "ok",
        ran,
        memeTransfers: transfers,
        degraded,
        events,
        balances,
        unverifiedCount,
      };
    }
    const fail = (
      instance: Launch2LaneInstance,
      failures: number,
      gaps: readonly Launch2MemeCoverageGap[],
    ): void => {
      const failedAttempts = failures + 1;
      const stalled = failedAttempts >= launch2MemeCoverageMaxAttempts;
      degraded.push({
        instanceId: instance.instanceId,
        kind: stalled ? "stalled" : "retry",
        failedAttempts,
      });
      events.push({
        reasonCode: launch2MemeCoverageReasonCode,
        instanceId: instance.instanceId,
        gaps,
        failedAttempts,
        negativeBalanceCount: 0,
        stalled,
      });
    };
    const blockAt = async (blockNumber: bigint, hash: string) => {
      let at = input.timestamps.get(blockNumber);
      if (at === undefined) {
        const block = await options.chain.getBlock(blockNumber);
        if (block === null || block.hash !== hash) return null;
        at = block.timestamp;
        input.timestamps.set(blockNumber, at);
      }
      return at;
    };
    for (const instance of input.instances) {
      const failures = instance.memeTransfersCoverageFailures;
      if (
        instance.memeTransfersTargetBlock === undefined ||
        failures === undefined ||
        failures >= launch2MemeCoverageMaxAttempts ||
        BigInt(instance.deployBlockNumber) > input.toBlock
      ) {
        continue;
      }
      const token = instance.addresses.meme;
      // 3a: no endpoint returned this instance's deploy-block mint.
      if (input.untrustedTokens.has(token)) {
        fail(instance, failures, ["DEPLOY_MINT_UNTRUSTED"]);
        continue;
      }
      // 3b: balanceOf at the segment's last block against the ledger.
      ran = true;
      const own = transfers.filter(
        (transfer) => transfer.instanceId === instance.instanceId,
      );
      const hot = [
        instance.addresses.curve,
        ...[...input.pools.values()]
          .filter((pool) => pool.instanceId === instance.instanceId)
          .map((pool) => pool.poolManager),
      ];
      const sample = selectLaunch2MemeBalanceSample({ hot, transfers: own });
      const before = await ledgerOf({
        chainId: options.chainId,
        instanceId: instance.instanceId,
        addresses: sample,
        beforeBlockNumber: input.fromBlock.toString(10),
      });
      let onChain: Awaited<
        ReturnType<NonNullable<Launch2Chain["readMemeBalances"]>>
      > | null = null;
      if (options.chain.readMemeBalances !== undefined) {
        try {
          onChain = await options.chain.readMemeBalances({
            token,
            addresses: sample,
            blockNumber: input.toBlock,
          });
        } catch (error) {
          if (!(
            error instanceof Error &&
            (error as { reasonCode?: unknown }).reasonCode ===
              "LAUNCH2_RPC_STATE_UNAVAILABLE"
          )) {
            throw error;
          }
        }
      }
      if (onChain === null) {
        balances.set(instance.instanceId, { kind: "unverified" });
        degraded.push({
          instanceId: instance.instanceId,
          kind: "unverified",
          failedAttempts: failures,
        });
        unverifiedCount += 1;
        continue;
      }
      const chainBalances = new Map(
        sample.map((address) => [
          address,
          BigInt(onChain.balances[address] ?? "0"),
        ]),
      );
      const chainSupply = BigInt(onChain.totalSupply);
      const verdictOf = (
        segment: readonly Launch2MemeTransferRecord[],
      ): Launch2MemeBalanceVerdict => {
        const ledger = new Map(
          sample.map((address) => [
            address,
            BigInt(before.balances[address] ?? "0"),
          ]),
        );
        let supply = BigInt(before.supply);
        for (const transfer of segment) {
          const amount = BigInt(transfer.amount);
          if (ledger.has(transfer.from)) {
            ledger.set(
              transfer.from,
              (ledger.get(transfer.from) ?? 0n) - amount,
            );
          }
          if (ledger.has(transfer.to)) {
            ledger.set(transfer.to, (ledger.get(transfer.to) ?? 0n) + amount);
          }
          if (transfer.from === zeroAddress) supply += amount;
          if (transfer.to === zeroAddress) supply -= amount;
        }
        return compareLaunch2MemeBalances({
          ledger,
          ledgerSupply: supply,
          chain: chainBalances,
          chainSupply,
        });
      };
      let verdict = verdictOf(own);
      if (
        verdict.kind === "mismatch" &&
        options.chain.readMemeTransferAlternatives !== undefined
      ) {
        // Second chance: the segment's MEME logs from every endpoint; the
        // union with the first answer is kept when it reconciles.
        const answers = await options.chain.readMemeTransferAlternatives({
          token,
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
        });
        for (const answer of answers) {
          const merged = new Map(
            own.map((transfer) => [
              `${transfer.transactionHash}:${transfer.logIndex}`,
              transfer,
            ]),
          );
          for (const log of answer) {
            const key = `${log.transactionHash}:${log.logIndex}`;
            if (merged.has(key) || log.contractAddress !== token) continue;
            const at = await blockAt(log.blockNumber, log.blockHash);
            if (at === null) return { kind: "moved" };
            merged.set(key, {
              instanceId: instance.instanceId,
              from: log.args["from"] ?? "",
              to: log.args["to"] ?? "",
              amount: log.args["value"] ?? "",
              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
              blockNumber: log.blockNumber.toString(10),
              blockHash: log.blockHash,
              at: at.toString(10),
            });
          }
          const candidate = [...merged.values()].sort((a, b) =>
            a.blockNumber === b.blockNumber
              ? a.logIndex - b.logIndex
              : BigInt(a.blockNumber) < BigInt(b.blockNumber)
                ? -1
                : 1,
          );
          const second = verdictOf(candidate);
          if (second.kind === "verified") {
            transfers = [
              ...transfers.filter(
                (transfer) => transfer.instanceId !== instance.instanceId,
              ),
              ...candidate,
            ];
            verdict = second;
            break;
          }
        }
      }
      balances.set(instance.instanceId, verdict);
      if (verdict.kind === "mismatch") {
        fail(instance, failures, verdict.gaps);
      }
    }
    return {
      kind: "ok",
      ran,
      memeTransfers: transfers,
      degraded,
      events,
      balances,
      unverifiedCount,
    };
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
          : [
              {
                instance,
                poolId: instance.officialPoolId,
                dynamicHook: instance.dynamicHook ?? null,
              },
            ],
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
      // Decision 0131: Hooks bound in this segment (LoopHookBound of a
      // LoopDynamic instance's own graduation adapter) join the roles.
      const boundHooks = new Map<string, string>();
      const freshHookRoles = new Map<string, Launch2ContractRole>();
      for (const log of first.logs) {
        const owner = owners.get(log.contractAddress);
        const hook = log.args["hook"];
        if (
          log.eventName !== "LoopHookBound" ||
          owner === undefined ||
          roles.get(log.contractAddress) !== "dynamicGraduationAdapter" ||
          hook === undefined ||
          boundHooks.has(owner)
        ) {
          continue;
        }
        boundHooks.set(owner, hook);
        if (!roles.has(hook)) {
          freshHookRoles.set(hook, "dynamicHook");
          roles.set(hook, "dynamicHook");
          owners.set(hook, owner);
        }
      }
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
            ? [
                {
                  instance,
                  poolId,
                  dynamicHook:
                    instance.dynamicHook ??
                    boundHooks.get(instance.instanceId) ??
                    null,
                },
              ]
            : [];
        }),
      );
      const second =
        fresh.size === 0 && freshHookRoles.size === 0
          ? null
          : await options.chain.getLogs({
              roles: freshHookRoles,
              fromBlock,
              toBlock,
              ...(fresh.size === 0 ? {} : { poolSwaps: poolFilter(fresh) }),
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
        skippedForeign:
          (first.skippedForeign ?? 0) + (second?.skippedForeign ?? 0),
      };
      if (aborted(signal)) return result("aborted", null);
      const attributions =
        poolRouter === null
          ? new Map<string, never>()
          : pairLaunch2RouterSwaps(decoded.logs, poolRouter);
      // Decision 0131: each LoopDynamic swap's fee from its Hook's log.
      const dynamicHookPools = new Map<string, string>();
      for (const [poolId, owner] of pools) {
        if (owner.dynamicHook !== null) {
          dynamicHookPools.set(owner.dynamicHook, poolId);
        }
      }
      const dynamicFeeFacts =
        dynamicHookPools.size === 0
          ? new Map<
              string,
              {
                readonly fee: string;
                readonly token: Launch2DynamicBuyFeeToken;
              }
            >()
          : pairLaunch2DynamicFeeFacts(decoded.logs, dynamicHookPools);
      const dynamicFees = new Map(
        [...dynamicFeeFacts].map(([key, value]) => [key, value.fee]),
      );
      const dynamicFeeTokens = new Map(
        [...dynamicFeeFacts].map(([key, value]) => [key, value.token]),
      );
      // Decision 0132: LoopDynamic swaps of a direct LoopRouter call are the
      // transaction sender's (the only transactions whose parties are read).
      const senderCandidates = [
        ...new Set(
          decoded.logs
            .filter((log) => {
              if (log.eventName !== "Swap") return false;
              const pool = pools.get(log.args["id"] ?? "");
              return (
                pool !== undefined &&
                pool.dynamicRouter !== null &&
                log.args["sender"] === pool.dynamicRouter
              );
            })
            .map((log) => log.transactionHash),
        ),
      ];
      const senderAttributions =
        senderCandidates.length === 0 ||
        options.chain.readTransactionParties === undefined
          ? new Map<string, never>()
          : pairLaunch2DynamicSenders({
              logs: decoded.logs,
              pools,
              fees: dynamicFees,
              feeTokens: dynamicFeeTokens,
              parties:
                await options.chain.readTransactionParties(senderCandidates),
            });
      // Decision 0146: how each BuyCredited was credited (the log before it).
      const creditHooks = new Map<
        string,
        {
          poolId: string;
          poolManager: string;
          router: string | null;
          meme: string | null;
        }
      >();
      for (const [poolId, owner] of pools) {
        if (owner.dynamicHook === null) continue;
        creditHooks.set(owner.dynamicHook, {
          poolId,
          poolManager: owner.poolManager,
          router: owner.dynamicRouter,
          meme: byInstance.get(owner.instanceId)?.addresses.meme ?? null,
        });
      }
      const creditAttributions =
        creditHooks.size === 0
          ? new Map<string, Launch2DynamicBuyCreditAttribution>()
          : classifyLaunch2DynamicCredits(decoded.logs, creditHooks);
      const timestamps = new Map<bigint, bigint>();
      const events: Launch2LaneEvent[] = [];
      let memeTransfers: Launch2MemeTransferRecord[] = [];
      const ignored = decoded.ignored;
      let skippedForeign = decoded.skippedForeign;
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
          // Factory deployments that are not LOOP-registered instances (and
          // pool / router logs of pools that are not ours): not ours, not
          // an unknown fact — Decision 0135 counts them apart.
          skippedForeign += 1;
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
            log.eventName === "BuyCredited"
              ? Object.freeze({
                  ...log.args,
                  // Decision 0146: the lane's attribution of this credit.
                  attribution:
                    creditAttributions.get(
                      `${log.transactionHash}:${log.logIndex}`,
                    ) ?? "unknown",
                })
              : swapPool === undefined || log.eventName !== "Swap"
                ? log.args
                : swapPool.dynamicHook !== null
                  ? Object.freeze({
                      ...log.args,
                      memeIsCurrency0: swapPool.memeIsCurrency0
                        ? "true"
                        : "false",
                      // Decision 0131: the Hook's fee of this swap, if paired.
                      poolHookKind: "loopDynamic",
                      dynamicFee:
                        dynamicFees.get(
                          `${log.transactionHash}:${log.logIndex}`,
                        ) ?? "0",
                      // Decision 0152: USD1 for an S209 Hook's buy fee.
                      ...(dynamicFeeTokens.get(
                        `${log.transactionHash}:${log.logIndex}`,
                      ) === "usd1"
                        ? { dynamicFeeToken: "usd1" }
                        : {}),
                      // Decision 0132: the transaction sender, if attributable.
                      ...senderAttributionArgs(
                        senderAttributions.get(
                          `${log.transactionHash}:${log.logIndex}`,
                        ),
                      ),
                    })
                  : Object.freeze({
                      ...log.args,
                      memeIsCurrency0: swapPool.memeIsCurrency0
                        ? "true"
                        : "false",
                      // Decision 0126: the router's payer / recipient, if paired.
                      ...attributionArgs(
                        attributions.get(
                          `${log.transactionHash}:${log.logIndex}`,
                        ),
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
      // Decision 0132: per-instance MEME coverage of this segment — a
      // missing mint anchor degrades only its instance (3a); every other
      // tracked instance is vouched for by balanceOf at toBlock (3b).
      const coverage = await verifyMemeSegment({
        instances,
        untrustedTokens: new Set(first.untrustedTokens ?? []),
        memeTransfers,
        pools,
        fromBlock,
        toBlock,
        timestamps,
      });
      if (coverage.kind === "moved") {
        return result("unavailable", "LAUNCH2_BLOCK_MOVED");
      }
      memeTransfers = coverage.memeTransfers;
      if (coverage.ran) {
        // The balances were read by number: the block must still be ours.
        const after = await options.chain.getBlock(toBlock);
        if (after === null || after.hash !== toHash) {
          return result("unavailable", "LAUNCH2_BLOCK_MOVED");
        }
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
        ...(coverage.degraded.length === 0
          ? {}
          : { memeCoverageDegraded: coverage.degraded }),
      });
      for (const event of coverage.events) {
        options.onMemeCoverageIncomplete?.(event);
      }
      if (coverage.unverifiedCount > 0) {
        options.onWarning?.({
          reasonCode: "LAUNCH2_MEME_BALANCE_UNVERIFIABLE",
          count: coverage.unverifiedCount,
        });
      }
      if (ignored > 0) {
        options.onWarning?.({
          reasonCode: "LAUNCH2_EVENTS_IGNORED",
          count: ignored,
        });
      }
      if (skippedForeign > 0) {
        options.onSkippedForeign?.(skippedForeign);
      }
      await checkMemeCoverage(toBlock, coverage.balances);
      scanned = {
        fromBlockNumber: fromBlock.toString(10),
        toBlockNumber: toBlock.toString(10),
        eventCount: events.length + memeTransfers.length,
        ignoredCount: ignored,
        skippedForeignCount: skippedForeign,
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
