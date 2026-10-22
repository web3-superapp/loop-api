/**
 * TEST ONLY (Decision 0114). An in-memory launch2 repository and a chain
 * reader whose state is a fixture. Nothing here is a product parameter.
 */
import { randomUUID } from "node:crypto";

import { decodeFunctionData } from "viem";

import {
  Launch2IdempotencyConflictError,
  type CreateLaunch2IntentRecord,
  type Launch2ActivityRecord,
  type Launch2BuybackRecord,
  type Launch2Chain,
  type Launch2DynamicClaimReportRecord,
  type Launch2DynamicRewardRecord,
  type Launch2DynamicRoundBuyerRecord,
  type Launch2DynamicRoundSummary,
  type Launch2InstanceRecord,
  type Launch2IntentRecord,
  type Launch2PoolCall,
  type Launch2PoolChain,
  type Launch2PoolRouterCheck,
  type Launch2PoolSimulation,
  type Launch2PoolTradeRecord,
  type Launch2PositionRecord,
  type Launch2PublicCandleRecord,
  type Launch2PublicMemeFacts,
  type Launch2Repository,
  type Launch2SnapshotMemberRecord,
  type Launch2TradeRecord,
  type Launch2ViewerChainState,
} from "../../src/features/launch2/launch2-ports.js";
import { launch2ReserveAt } from "../../src/features/launch2/launch2-curve-math.js";
import {
  launch2PoolId,
  launch2PoolKey,
} from "../../src/features/launch2/launch2-pool.js";
import { officialPoolRouterAbi } from "../../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import { memeUsd1 } from "./meme-service-fakes.js";

export const launch2Factory = "0x5555555555555555555555555555555555555555";
export const launch2FactoryCodeHash = `0x${"ab".repeat(32)}`;
export const launch2NowSeconds = 1_800_000_000n;
export const wad = 10n ** 18n;

/** API env: the module, the BSC Testnet slot, the Hooks Factory pair. */
export const launch2Env = Object.freeze({
  V2_MODULES_ENABLED: "launch2",
  LAUNCH_CHAIN_ID: "97",
  HOOKS_LAUNCH_FACTORY_ADDRESS: launch2Factory,
  HOOKS_LAUNCH_FACTORY_CODE_HASH: launch2FactoryCodeHash,
});

export const launch2WritesEnv = Object.freeze({
  BSC_WRITES_ENABLED: "true",
  BSC_RPC_URLS: "https://bsc-rpc.invalid/",
  BSC_WRITE_CANARY_ASSETS: `eip155:97:${memeUsd1}`,
  BSC_WRITE_CANARY_MAX_USD: "5000",
});

function address(fill: string): string {
  return `0x${fill.repeat(40)}`.slice(0, 42);
}

/** The ISO sale end `seconds` after an ISO sale start (Decision 0119). */
export function launch2SaleEndAfter(startIso: string, seconds: bigint): string {
  return new Date(Date.parse(startIso) + Number(seconds) * 1000).toISOString();
}

/**
 * `nftSaleEnd` defaults to start + 604,800 s (the 7-day Factory); pass
 * `saleSeconds` (e.g. 3_600n for the testnet Factory) or an explicit end.
 */
export function instanceFixture(
  overrides: Partial<Launch2InstanceRecord> = {},
  saleSeconds = 604_800n,
): Launch2InstanceRecord {
  const nftSaleStart =
    overrides.nftSaleStart ??
    new Date(Number(launch2NowSeconds - 3_600n) * 1000).toISOString();
  return {
    instanceId: randomUUID(),
    jobId: randomUUID(),
    projectId: randomUUID(),
    configVersion: 1,
    ownerUserId: "0f1e2d3c-4b5a-4968-8776-655443322110",
    chainId: "eip155:97",
    factoryAddress: launch2Factory,
    generation: "v3",
    launchId: `0x${"11".repeat(32)}`,
    configHash: `0x${"22".repeat(32)}`,
    projectOwner: address("7"),
    name: "Frog Launch",
    ticker: "FROG",
    logoUrl: "https://example.com/frog.png",
    nftImageUrl: null,
    nftImageCid: null,
    listing: "visible",
    projectProfile: {
      description: "A frog launch.",
      links: ["https://example.com/frog"],
    },
    addresses: {
      meme: `0x${"a".repeat(36)}6666`,
      hook: address("b"),
      nft: address("c"),
      curve: address("d"),
      gate: address("e"),
      escrow: address("f"),
      snapshots: address("1"),
      graduationAdapter: address("2"),
      buybackAdapter: address("3"),
      priceRecorder: address("4"),
      buybackExecutor: address("6"),
    },
    buybackRecipient: "0x28816c4c4792467390c90e5b426f198570e29307",
    nftSaleStart,
    nftSaleEnd: launch2SaleEndAfter(nftSaleStart, saleSeconds),
    deployBlockNumber: "100",
    activationBlockNumber: "102",
    deployedEventSeen: true,
    activatedAt: new Date(
      Number(launch2NowSeconds - 86_400n) * 1000,
    ).toISOString(),
    holdReason: null,
    stage: "nft_sale",
    nextChangeAt: null,
    nftMintedCount: "2",
    soldSupply: "0",
    reserveUsd1: "0",
    priceE18: "41666666250000",
    tradeCount: "0",
    buyVolumeUsd1: "0",
    taxUsd1: "0",
    snapshot: null,
    snapshotPublication: null,
    noHoldersClosure: null,
    openedWithoutHolders: null,
    graduation: null,
    buyback: { paused: false, count: "0", usd1: "0", meme: "0", lastAt: null },
    pool: {
      tradeCount: "0",
      buyCount: "0",
      sellCount: "0",
      buyVolumeUsd1: "0",
      sellVolumeUsd1: "0",
      volume24hUsd1: "0",
      taxUsd1: "0",
      taxMeme: "0",
      lastPriceE18: null,
      lastTradeAt: null,
      userTradeCount: "0",
      userBuyVolumeUsd1: "0",
      userSellVolumeUsd1: "0",
    },
    buybackKeeper: null,
    registeredAt: new Date(
      Number(launch2NowSeconds - 86_400n) * 1000,
    ).toISOString(),
    projectedAt: new Date(Number(launch2NowSeconds) * 1000).toISOString(),
    ...overrides,
  };
}

/** An instance in the priority hour with a verified snapshot. */
export function priorityInstance(
  overrides: Partial<Launch2InstanceRecord> = {},
): Launch2InstanceRecord {
  const publishedAt = launch2NowSeconds - 600n;
  return instanceFixture({
    nftSaleStart: new Date(
      Number(publishedAt - 604_800n - 100n) * 1000,
    ).toISOString(),
    snapshot: {
      root: `0x${"33".repeat(32)}`,
      dataHash: `0x${"44".repeat(32)}`,
      cutoffBlock: "500",
      cutoffBlockHash: `0x${"55".repeat(32)}`,
      publishedAt: new Date(Number(publishedAt) * 1000).toISOString(),
      publishedBlock: "510",
      transactionHash: `0x${"66".repeat(32)}`,
      verification: "verified",
      memberCount: 2,
      signers: [address("9"), address("8")],
    },
    stage: "priority",
    ...overrides,
  });
}

export interface InMemoryLaunch2Repository extends Launch2Repository {
  readonly instances: Map<string, Launch2InstanceRecord>;
  readonly positions: Launch2PositionRecord[];
  readonly members: Map<string, Launch2SnapshotMemberRecord[]>;
  readonly buybacks: Map<string, Launch2BuybackRecord[]>;
  readonly trades: Map<string, Launch2TradeRecord[]>;
  readonly intents: Map<string, Launch2IntentRecord>;
  readonly builds: { count: number };
  /** Decision 0139: returned as-is by listActivity (the service sorts / caps). */
  readonly activity: Launch2ActivityRecord[];
  /** Decision 0126: attributed pool trades keyed `instanceId|wallet`. */
  readonly poolTrades: Map<string, Launch2PoolTradeRecord[]>;
  /** Decision 0131: LoopDynamic projections keyed `instanceId|wallet`. */
  readonly dynamicRewards: Map<string, Launch2DynamicRewardRecord[]>;
  /** Decision 0146: round buyers keyed `instanceId|roundId`, heaviest first. */
  readonly dynamicRoundBuyers: Map<string, Launch2DynamicRoundBuyerRecord[]>;
  readonly dynamicSummaries: Map<string, Launch2DynamicRoundSummary>;
  readonly dynamicReports: Map<string, Launch2DynamicClaimReportRecord>;
  /** Indexed claims keyed `instanceId|txHash|roundId|buyer`. */
  readonly dynamicClaims: Map<
    string,
    { amountUsd1: string; blockNumber: string; claimedAt: string }
  >;
  /** Decision 0147: public page facts keyed by instance (default: empty). */
  readonly publicFacts: Map<string, Partial<Launch2PublicMemeFacts>>;
  /** Decision 0147: public candles keyed `instanceId|kind`. */
  readonly publicCandles: Map<string, Launch2PublicCandleRecord[]>;
  /** Decision 0147: the `since` cutoffs the service asked for. */
  readonly publicFactsCalls: {
    instanceIds: readonly string[];
    since: string;
  }[];
}

/** Decision 0131: an empty round summary. */
export const emptyDynamicSummary: Launch2DynamicRoundSummary = Object.freeze({
  roundCount: 0,
  closedRoundCount: 0,
  allocatedUsd1: "0",
  claimedUsd1: "0",
  extraFeesUsd1: "0",
  baseSellFeesUsd1: "0",
  buyFeesMeme: "0",
  buyFeesUsd1: "0",
  lastRound: null,
});

export function createInMemoryLaunch2Repository(): InMemoryLaunch2Repository {
  const instances = new Map<string, Launch2InstanceRecord>();
  const positions: Launch2PositionRecord[] = [];
  const members = new Map<string, Launch2SnapshotMemberRecord[]>();
  const buybacks = new Map<string, Launch2BuybackRecord[]>();
  const trades = new Map<string, Launch2TradeRecord[]>();
  const intents = new Map<string, Launch2IntentRecord>();
  const keys = new Map<string, { sha: string; intentId: string | null }>();
  const builds = { count: 0 };
  const activity: Launch2ActivityRecord[] = [];
  const poolTrades = new Map<string, Launch2PoolTradeRecord[]>();
  const dynamicRewards = new Map<string, Launch2DynamicRewardRecord[]>();
  const dynamicRoundBuyers = new Map<
    string,
    Launch2DynamicRoundBuyerRecord[]
  >();
  const dynamicSummaries = new Map<string, Launch2DynamicRoundSummary>();
  const dynamicReports = new Map<string, Launch2DynamicClaimReportRecord>();
  const dynamicClaims = new Map<
    string,
    { amountUsd1: string; blockNumber: string; claimedAt: string }
  >();
  const publicFacts = new Map<string, Partial<Launch2PublicMemeFacts>>();
  const publicCandles = new Map<string, Launch2PublicCandleRecord[]>();
  const publicFactsCalls: {
    instanceIds: readonly string[];
    since: string;
  }[] = [];
  const unused = () => Promise.reject(new Error("not used in route tests"));
  return {
    publicFacts,
    publicCandles,
    publicFactsCalls,
    getPublicMemeFacts: (input) => {
      publicFactsCalls.push(input);
      return Promise.resolve(
        input.instanceIds.map((instanceId): Launch2PublicMemeFacts => ({
          instanceId,
          community: null,
          curveTaxUsd1: "0",
          poolTaxMeme: "0",
          poolTaxUsd1: "0",
          lastClosedRound: null,
          poolReferencePriceE18: null,
          curveSoldAtSince: "0",
          ...publicFacts.get(instanceId),
        })),
      );
    },
    listPublicCandles: (input) =>
      Promise.resolve(
        (
          publicCandles.get(`${input.instanceId}|${input.source.kind}`) ?? []
        ).slice(-input.limit),
      ),
    poolTrades,
    dynamicRewards,
    dynamicRoundBuyers,
    dynamicSummaries,
    dynamicReports,
    dynamicClaims,
    dynamicRoundSummary: (instanceId) =>
      Promise.resolve(dynamicSummaries.get(instanceId) ?? emptyDynamicSummary),
    listDynamicRewards: (input) =>
      Promise.resolve(
        (
          dynamicRewards.get(
            `${input.instanceId}|${input.walletAddress.toLowerCase()}`,
          ) ?? []
        ).slice(0, input.limit),
      ),
    listDynamicRoundBuyers: (input) => {
      const all =
        dynamicRoundBuyers.get(`${input.instanceId}|${input.roundId}`) ?? [];
      return Promise.resolve({
        buyerCount: all.length,
        buyers: all.slice(0, input.limit),
      });
    },
    getDynamicBuyWeight: (input) =>
      Promise.resolve(
        (
          dynamicRoundBuyers.get(`${input.instanceId}|${input.roundId}`) ?? []
        ).find((buyer) => buyer.address === input.address.toLowerCase())
          ?.weightUsd1 ?? "0",
      ),
    getDynamicClaimIntent: (input) => {
      const intent = intents.get(input.intentId);
      return Promise.resolve(
        intent !== undefined &&
          intent.ownerUserId === input.ownerUserId &&
          intent.kind === "dynamic_claim"
          ? intent
          : null,
      );
    },
    recordDynamicClaimReport: (input) => {
      const existing = dynamicReports.get(input.intentId);
      if (existing !== undefined) {
        return Promise.resolve({
          outcome:
            existing.transactionHash === input.transactionHash
              ? ("same" as const)
              : ("conflict" as const),
          report: existing,
        });
      }
      const report: Launch2DynamicClaimReportRecord = {
        intentId: input.intentId,
        instanceId: input.instanceId,
        walletId: input.walletId,
        walletAddress: input.walletAddress,
        roundId: input.roundId,
        transactionHash: input.transactionHash,
        reportedAt: new Date(Number(launch2NowSeconds) * 1000).toISOString(),
      };
      dynamicReports.set(input.intentId, report);
      return Promise.resolve({ outcome: "created" as const, report });
    },
    findDynamicClaim: (input) =>
      Promise.resolve(
        dynamicClaims.get(
          `${input.instanceId}|${input.transactionHash}|${input.roundId}|${input.buyer.toLowerCase()}`,
        ) ?? null,
      ),
    activity,
    listActivity: () => Promise.resolve([...activity]),
    listOverviewFacts: (input) =>
      Promise.resolve(
        [...instances.values()]
          .filter(
            (row) =>
              row.chainId === input.chainId &&
              (row.activatedAt !== null || row.holdReason !== null) &&
              row.listing === "visible",
          )
          .map((row) => ({
            instanceId: row.instanceId,
            nftSaleStart: row.nftSaleStart,
            nftSaleEnd: row.nftSaleEnd,
            holdReason: row.holdReason,
            snapshot: row.snapshot,
            graduation: row.graduation,
            noHoldersClosure: row.noHoldersClosure,
            openedWithoutHolders: row.openedWithoutHolders,
            nftMintedCount: row.nftMintedCount,
            buybackUsd1: row.buyback.usd1,
          })),
      ),
    instances,
    positions,
    members,
    buybacks,
    trades,
    intents,
    builds,
    registerActivatedInstances: unused,
    listLaneInstances: unused,
    getCheckpoint: unused,
    commitSegment: unused,
    listMemeCoverageChecks: unused,
    recordMemeCoverage: unused,
    listSnapshotsToVerify: unused,
    nftHoldersAt: unused,
    recordSnapshotVerification: unused,
    updateStages: unused,
    listInstances: (input) => {
      const rows = [...instances.values()]
        .filter(
          (row) =>
            row.chainId === input.chainId &&
            (row.activatedAt !== null || row.holdReason !== null) &&
            row.listing === "visible" &&
            (input.stage === null || row.stage === input.stage) &&
            (input.notStage === undefined ||
              input.notStage === null ||
              row.stage !== input.notStage),
        )
        .sort((a, b) =>
          `${b.activatedAt ?? b.registeredAt}${b.instanceId}`.localeCompare(
            `${a.activatedAt ?? a.registeredAt}${a.instanceId}`,
          ),
        )
        .filter(
          (row) =>
            input.after === null ||
            `${row.activatedAt ?? row.registeredAt}${row.instanceId}` <
              `${input.after.activatedAt}${input.after.instanceId}`,
        );
      return Promise.resolve(rows.slice(0, input.limit));
    },
    getInstance: (instanceId) =>
      Promise.resolve(instances.get(instanceId) ?? null),
    getInstanceByLaunchId: (launchId) =>
      Promise.resolve(
        [...instances.values()].find(
          (row) => row.launchId.toLowerCase() === launchId.toLowerCase(),
        ) ?? null,
      ),
    listPositions: (input) =>
      Promise.resolve(
        positions.filter(
          (row) =>
            input.holderAddresses.includes(row.holderAddress) &&
            (input.instanceId === null || row.instanceId === input.instanceId),
        ),
      ),
    getSnapshotMember: (input) =>
      Promise.resolve(
        (members.get(input.instanceId) ?? []).find(
          (member) => member.memberAddress === input.address.toLowerCase(),
        ) ?? null,
      ),
    listBuybacks: (input) =>
      Promise.resolve(
        (buybacks.get(input.instanceId) ?? [])
          .filter(
            (row) =>
              input.after === null ||
              `${row.executedAt}${row.buybackId}` <
                `${input.after.executedAt}${input.after.buybackId}`,
          )
          .slice(0, input.limit),
      ),
    listTrades: (input) =>
      Promise.resolve(
        (trades.get(input.instanceId) ?? []).slice(0, input.limit),
      ),
    listPoolTrades: (input) =>
      Promise.resolve(
        (
          poolTrades.get(
            `${input.instanceId}|${input.walletAddress.toLowerCase()}`,
          ) ?? []
        ).slice(0, input.limit),
      ),
    poolTradeStats: (input) =>
      Promise.resolve(
        [...poolTrades.entries()].flatMap(([key, rows]) => {
          const [instanceId, wallet] = key.split("|") as [string, string];
          if (
            rows.length === 0 ||
            !input.walletAddresses
              .map((address) => address.toLowerCase())
              .includes(wallet) ||
            (input.instanceId !== null && input.instanceId !== instanceId)
          ) {
            return [];
          }
          return [
            {
              instanceId,
              walletAddress: wallet,
              count: String(rows.length),
              lastAt: rows[0]?.tradedAt ?? null,
            },
          ];
        }),
      ),
    createIntent: async (input) => {
      const key = `${input.ownerUserId}:${input.idempotencyKey}`;
      const claimed = keys.get(key);
      if (claimed !== undefined && claimed.sha !== input.requestSha256) {
        throw new Launch2IdempotencyConflictError();
      }
      if (claimed?.intentId !== undefined && claimed.intentId !== null) {
        return {
          created: false,
          intent: intents.get(claimed.intentId) as Launch2IntentRecord,
        };
      }
      keys.set(key, { sha: input.requestSha256, intentId: null });
      builds.count += 1;
      const built: CreateLaunch2IntentRecord = await input.build();
      const admission = input.canaryAdmission(built);
      admission?.admit("0");
      const record: Launch2IntentRecord = {
        ...built,
        state: "prepared",
        createdAt: new Date(Number(launch2NowSeconds) * 1000).toISOString(),
      };
      intents.set(record.intentId, record);
      keys.set(key, { sha: input.requestSha256, intentId: record.intentId });
      return { created: true, intent: record };
    },
  };
}

export interface FakeLaunch2ChainState {
  viewer: Omit<Launch2ViewerChainState, "curve"> & {
    curve: Partial<Launch2ViewerChainState["curve"]>;
  };
  failViewer: boolean;
  viewerReads: number;
  /** Decision 0126: wallet balance reads (and a switch to fail them). */
  balanceReads: number;
  failBalances: boolean;
  /**
   * Decision 0152: what `readCurvePurchaseCap` answers (default the
   * pre-S209 5,000,000 MEME constant) and a switch to fail it.
   */
  curvePurchaseCap?: bigint;
  failCurvePurchaseCap?: boolean;
  curvePurchaseCapReads?: number;
}

export function defaultChainState(
  overrides: Partial<FakeLaunch2ChainState["viewer"]> = {},
): FakeLaunch2ChainState {
  return {
    viewer: {
      blockNumber: 5_000n,
      blockHash: `0x${"77".repeat(32)}`,
      curve: {},
      cumulativeBought: 0n,
      nftMinted: false,
      nftTotalMinted: 2n,
      snapshotRootPublishedAt: launch2NowSeconds - 600n,
      usd1: memeUsd1,
      usd1Balance: 1_000_000n * wad,
      memeBalance: 0n,
      ...overrides,
    },
    failViewer: false,
    viewerReads: 0,
    balanceReads: 0,
    failBalances: false,
  };
}

export function createFakeLaunch2Chain(
  state: FakeLaunch2ChainState,
): Launch2Chain {
  const unused = () => Promise.reject(new Error("not used in route tests"));
  return {
    verifyChain: () => Promise.resolve("ok"),
    getHead: unused,
    getBlock: unused,
    getLogs: unused,
    readSnapshotPublication: unused,
    recoverSnapshotSigners: unused,
    readHookPool: unused,
    readDynamicHookPool: unused,
    readCurvePurchaseCap: () => {
      state.curvePurchaseCapReads = (state.curvePurchaseCapReads ?? 0) + 1;
      if (state.failCurvePurchaseCap === true) {
        return Promise.reject(new Error("rpc down"));
      }
      return Promise.resolve(state.curvePurchaseCap ?? 5_000_000n * wad);
    },
    readWalletBalances: () => {
      state.balanceReads += 1;
      if (state.failBalances) return Promise.reject(new Error("rpc down"));
      return Promise.resolve({
        blockNumber: state.viewer.blockNumber,
        memeBalance: state.viewer.memeBalance ?? 0n,
        usd1Balance: state.viewer.usd1Balance ?? 0n,
      });
    },
    readViewerState: () => {
      state.viewerReads += 1;
      if (state.failViewer) return Promise.reject(new Error("rpc down"));
      const soldSupply = state.viewer.curve.soldSupply ?? 0n;
      return Promise.resolve({
        ...state.viewer,
        curve: {
          published: true,
          graduated: false,
          earlyRoundEndsAt: launch2NowSeconds - 600n + 3_600n,
          soldSupply,
          accountedReserve: launch2ReserveAt(soldSupply),
          blockTimestamp: launch2NowSeconds,
          ...state.viewer.curve,
        },
      });
    },
    readBuybackState: () =>
      Promise.resolve({
        blockTimestamp: launch2NowSeconds,
        paused: false,
        lastSuccessfulAt: 0n,
        availableBudget: 200n * wad,
        totalRecorded: 200n * wad,
        totalSpent: 0n,
        nextOrderAmountIn: 100n * wad,
        nextOrderExecutable: false,
      }),
  };
}

// ---------------------------------------------------------------------------
// Decision 0124: official-pool fixtures.
// ---------------------------------------------------------------------------

export const launch2PoolRouter = "0x9999999999999999999999999999999999999999";
export const launch2PoolRouterCodeHash = `0x${"cd".repeat(32)}`;
export const launch2PoolManager = "0x8888888888888888888888888888888888888888";
/** USD1 (0x22…) sorts before MEME (0xaa…6666): currency0 = USD1. */
export const launch2PoolSqrtPriceX96 = 40n * 2n ** 96n;
/** 1 USD1 buys 1,600 MEME at the fixture price (0.000625 USD1 / MEME). */
export const launch2PoolMemePerUsd1 = 1_600n;

export const launch2PoolEnv = Object.freeze({
  LAUNCH2_POOL_ROUTER_ADDRESS: launch2PoolRouter,
  LAUNCH2_POOL_ROUTER_CODE_HASH: launch2PoolRouterCodeHash,
});

export function graduatedInstance(
  overrides: Partial<Launch2InstanceRecord> = {},
): Launch2InstanceRecord {
  const base = instanceFixture({
    nftSaleStart: new Date(
      Number(launch2NowSeconds - 604_800n - 7_200n) * 1000,
    ).toISOString(),
  });
  const key = launch2PoolKey({
    meme: base.addresses.meme,
    usd1: memeUsd1,
    hook: base.addresses.hook,
  });
  return instanceFixture({
    ...base,
    snapshot: {
      root: `0x${"33".repeat(32)}`,
      dataHash: `0x${"44".repeat(32)}`,
      cutoffBlock: "500",
      cutoffBlockHash: `0x${"55".repeat(32)}`,
      publishedAt: new Date(
        Number(launch2NowSeconds - 7_000n) * 1000,
      ).toISOString(),
      publishedBlock: "510",
      transactionHash: `0x${"66".repeat(32)}`,
      verification: "verified",
      memberCount: 2,
      signers: null,
    },
    soldSupply: (800_000_000n * wad).toString(10),
    stage: "graduated",
    graduation: {
      graduatedAt: new Date(
        Number(launch2NowSeconds - 1_000n) * 1000,
      ).toISOString(),
      blockNumber: "4000",
      transactionHash: `0x${"67".repeat(32)}`,
      poolId: launch2PoolId(key),
    },
    ...overrides,
  });
}

export interface FakeLaunch2PoolState {
  routerCheck: Launch2PoolRouterCheck;
  failRead: boolean;
  /** Overrides the computed simulation outcome. */
  simulation: Launch2PoolSimulation | null;
  /** The prepare's simulation (real balance) reverts. */
  prepareReverts: boolean;
  estimate: bigint | null;
  usd1Balance: bigint;
  memeBalance: bigint;
  hookPoolManager: string;
  currency0: string | null;
  calls: Launch2PoolCall[];
  estimates: Launch2PoolCall[];
}

export function defaultPoolState(
  overrides: Partial<FakeLaunch2PoolState> = {},
): FakeLaunch2PoolState {
  return {
    routerCheck: { status: "ok", poolManager: launch2PoolManager },
    failRead: false,
    simulation: null,
    prepareReverts: false,
    estimate: 180_000n,
    usd1Balance: 1_000n * wad,
    memeBalance: 2_000_000n * wad,
    hookPoolManager: launch2PoolManager,
    currency0: null,
    calls: [],
    estimates: [],
    ...overrides,
  };
}

/**
 * A pool at a constant price (no impact): exactIn returns the net output
 * after the 2 % tax; exactOut returns the input for the net output.
 */
export function createFakeLaunch2PoolChain(
  state: FakeLaunch2PoolState,
): Launch2PoolChain {
  return {
    router: launch2PoolRouter,
    verifyRouter: () => Promise.resolve(state.routerCheck),
    readPoolState: (input) => {
      if (state.failRead) return Promise.reject(new Error("rpc down"));
      const key = launch2PoolKey({
        meme: input.meme,
        usd1: memeUsd1,
        hook: input.hook,
      });
      return Promise.resolve({
        blockNumber: 5_000n,
        blockHash: `0x${"77".repeat(32)}`,
        blockTimestamp: launch2NowSeconds,
        hookPoolManager: state.hookPoolManager,
        currency0: state.currency0 ?? key.currency0,
        currency1: key.currency1,
        curveUsd1: memeUsd1,
        sqrtPriceX96: launch2PoolSqrtPriceX96,
        usd1Balance: state.usd1Balance,
        memeBalance: state.memeBalance,
        usd1Allowance: 0n,
        memeAllowance: 0n,
      });
    },
    simulate: (call) => {
      state.calls.push(call);
      if (state.simulation !== null) return Promise.resolve(state.simulation);
      if (
        state.prepareReverts &&
        (call.override === null || call.override.balance === null)
      ) {
        return Promise.resolve({
          status: "reverted",
          errorName: "ERC20InsufficientBalance",
        });
      }
      const decoded = decodeFunctionData({
        abi: officialPoolRouterAbi,
        data: call.data as `0x${string}`,
      });
      const zeroForOne = decoded.args[1];
      const amount = decoded.args[2] as bigint;
      // zeroForOne = USD1 in (buy).
      const grossOf = (input: bigint) =>
        zeroForOne
          ? input * launch2PoolMemePerUsd1
          : input / launch2PoolMemePerUsd1;
      if (decoded.functionName === "swapExactIn") {
        const gross = grossOf(amount);
        return Promise.resolve({
          status: "ok",
          returned: gross - (gross * 200n) / 10_000n,
        });
      }
      const gross = amount + (amount * 200n + 9_799n) / 9_800n;
      const input = zeroForOne
        ? (gross + launch2PoolMemePerUsd1 - 1n) / launch2PoolMemePerUsd1
        : gross * launch2PoolMemePerUsd1;
      return Promise.resolve({ status: "ok", returned: input });
    },
    estimateGas: (call) => {
      state.estimates.push(call);
      return Promise.resolve(state.estimate);
    },
  };
}
