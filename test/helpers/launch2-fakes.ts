/**
 * TEST ONLY (Decision 0114). An in-memory launch2 repository and a chain
 * reader whose state is a fixture. Nothing here is a product parameter.
 */
import { randomUUID } from "node:crypto";

import {
  Launch2IdempotencyConflictError,
  type CreateLaunch2IntentRecord,
  type Launch2BuybackRecord,
  type Launch2Chain,
  type Launch2InstanceRecord,
  type Launch2IntentRecord,
  type Launch2PositionRecord,
  type Launch2Repository,
  type Launch2SnapshotMemberRecord,
  type Launch2TradeRecord,
  type Launch2ViewerChainState,
} from "../../src/features/launch2/launch2-ports.js";
import { launch2ReserveAt } from "../../src/features/launch2/launch2-curve-math.js";
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

export function instanceFixture(
  overrides: Partial<Launch2InstanceRecord> = {},
): Launch2InstanceRecord {
  return {
    instanceId: randomUUID(),
    jobId: randomUUID(),
    projectId: randomUUID(),
    configVersion: 1,
    ownerUserId: "0f1e2d3c-4b5a-4968-8776-655443322110",
    chainId: "eip155:97",
    factoryAddress: launch2Factory,
    launchId: `0x${"11".repeat(32)}`,
    configHash: `0x${"22".repeat(32)}`,
    projectOwner: address("7"),
    name: "Frog Launch",
    ticker: "FROG",
    logoUrl: "https://example.com/frog.png",
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
    nftSaleStart: new Date(
      Number(launch2NowSeconds - 3_600n) * 1000,
    ).toISOString(),
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
    graduation: null,
    buyback: { paused: false, count: "0", usd1: "0", meme: "0", lastAt: null },
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
}

export function createInMemoryLaunch2Repository(): InMemoryLaunch2Repository {
  const instances = new Map<string, Launch2InstanceRecord>();
  const positions: Launch2PositionRecord[] = [];
  const members = new Map<string, Launch2SnapshotMemberRecord[]>();
  const buybacks = new Map<string, Launch2BuybackRecord[]>();
  const trades = new Map<string, Launch2TradeRecord[]>();
  const intents = new Map<string, Launch2IntentRecord>();
  const keys = new Map<string, { sha: string; intentId: string | null }>();
  const builds = { count: 0 };
  const unused = () => Promise.reject(new Error("not used in route tests"));
  return {
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
            (input.stage === null || row.stage === input.stage),
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
        paused: false,
        lastSuccessfulAt: 0n,
        availableBudget: 200n * wad,
        totalRecorded: 200n * wad,
        totalSpent: 0n,
        nextOrderAmountIn: 100n * wad,
        nextOrderMinMemeOut: 0n,
      }),
  };
}
