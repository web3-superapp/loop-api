/**
 * TEST ONLY (Decision 0077): in-memory repositories for the Launch service.
 */
import { vi } from "vitest";

import type { BscWriteConfig } from "../../src/config.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../src/database/account-wallet-repository.js";
import {
  createUnavailableLaunchChainRepository,
  LaunchIntentIdempotencyConflictError,
  LaunchIntentReportConflictError,
  type LaunchAllowlistRootRecord,
  type LaunchChainRepository,
  type LaunchCheckpointRecord,
  type LaunchIntentRecord,
} from "../../src/features/launch/launch-chain-repository.js";
import {
  createUnavailableLaunchRepository,
  type LaunchDetailRecord,
  type LaunchRepository,
} from "../../src/features/launch/launch-repository.js";
import { fakeLaunchContract, fakeProjectToken } from "./launch-fake-adapter.js";
import { fixtureBlockHash } from "./launch-lane-fixtures.js";

export const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
export const walletId = "d64786bb-408d-415d-8a69-6277d56c921b";
export const walletAddress = "0x000000000000000000000000000000000000000a";
export const launchId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
export const projectId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
export const roundOneId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
export const roundTwoId = "1b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4f";
export const usd1AssetId = `eip155:97:${fakeLaunchContract.usd1Address}`;
const createdAt = "2026-09-08T01:00:00.000Z";

export function registeredDetail(tierModeV1 = "whitelist"): LaunchDetailRecord {
  return {
    launch: {
      launchId,
      projectId,
      chainId: "eip155:97",
      contractAddress: fakeLaunchContract.address,
      saleId: "7",
      contractVersion: "1.0.0",
      configVersionOnchain: null,
      quoteAssetId: usd1AssetId,
      projectAssetId: `eip155:97:${fakeProjectToken}`,
      configDigest: null,
      scheduleStatus: "live",
      createdAt,
      updatedAt: createdAt,
    },
    project: {
      projectId,
      ownerUserId: accountId,
      name: "MoonCat",
      ticker: "MCAT",
      narrative: null,
      officialLinks: { website: null, x: null, telegram: null, discord: null },
      materialVersion: 1,
      reviewStatus: "approved",
      kybStatus: "unavailable",
      reviewReasonCode: null,
      submittedAt: createdAt,
      reviewedAt: createdAt,
      launchId,
      version: 3,
      createdAt,
      updatedAt: createdAt,
    },
    configs: [
      {
        configId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
        launchId,
        configVersion: "launchMoonCatV1",
        parameters: { tierModeV1, projectTokenAddress: fakeProjectToken },
        status: "confirmed",
        effectiveAt: createdAt,
      },
    ],
    rounds: [
      {
        roundId: roundOneId,
        launchId,
        roundIndex: 1,
        configVersion: "launchMoonCatV1",
        status: "confirmed",
        startsAt: null,
        endsAt: null,
        priceUsd1: "0.01",
        eligibilityTier: "priority",
        walletRoundCapRaw: null,
      },
      {
        roundId: roundTwoId,
        launchId,
        roundIndex: 2,
        configVersion: "launchMoonCatV1",
        status: "confirmed",
        startsAt: null,
        endsAt: null,
        priceUsd1: "0.01",
        eligibilityTier: null,
        walletRoundCapRaw: null,
      },
    ],
  };
}

export function launchRepositoryFor(
  detail: LaunchDetailRecord,
): LaunchRepository {
  return {
    ...createUnavailableLaunchRepository(),
    getLaunch: vi.fn(() => Promise.resolve(detail)),
    listLaunches: vi.fn(() =>
      Promise.resolve([
        {
          launch: detail.launch,
          projectName: detail.project.name,
          projectTicker: detail.project.ticker,
          confirmedConfigVersion: "launchMoonCatV1",
        },
      ]),
    ),
    getEconomyCounts: vi.fn(() =>
      Promise.resolve({
        projectsByStatus: {
          draft: 0,
          submitted: 0,
          in_review: 0,
          returned: 0,
          approved: 1,
          rejected: 0,
        },
        launchesByScheduleStatus: {
          unscheduled: 0,
          scheduled: 0,
          live: 1,
          ended: 0,
        },
        confirmedRoundCount: 2,
        observedAt: createdAt,
      }),
    ),
  };
}

export const checkpoint: LaunchCheckpointRecord = Object.freeze({
  lastBlockNumber: "950",
  lastBlockHash: fixtureBlockHash(950n),
  startedFromBlockNumber: "100",
  updatedAt: createdAt,
});

export function chainRepositoryFake(
  options: {
    readonly checkpoint?: LaunchCheckpointRecord | null;
    readonly roots?: readonly LaunchAllowlistRootRecord[];
  } = {},
): LaunchChainRepository & {
  readonly intents: Map<string, { sha: string; record: LaunchIntentRecord }>;
  builds: number;
} {
  const intents = new Map<
    string,
    { sha: string; record: LaunchIntentRecord }
  >();
  const fake = {
    ...createUnavailableLaunchChainRepository(),
    intents,
    builds: 0,
    getCheckpoint: () =>
      Promise.resolve(
        options.checkpoint === undefined ? checkpoint : options.checkpoint,
      ),
    listStateProjections: () =>
      Promise.resolve(
        new Map([
          [
            launchId,
            {
              launchId,
              saleState: "LIVE" as const,
              entitlementState: "NONE" as const,
              liquidityState: "NOT_STARTED" as const,
              operationalState: "ACTIVE" as const,
              configVersion: `0x${"ab".repeat(32)}`,
              stateTupleDigest: `0x${"cd".repeat(32)}`,
              snapshotBlockNumber: "950",
              snapshotBlockHash: fixtureBlockHash(950n),
            },
          ],
        ]),
      ),
    countHolders: () => Promise.resolve(3),
    listHistory: () =>
      Promise.resolve({
        purchaseRecords: [
          {
            purchaseRecordId: "5b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
            walletId,
            roundId: roundOneId,
            roundIndex: 1,
            usd1Amount: "10000000000000000000",
            tokenAmount: "1000000000000000000000",
            transactionHash: `0x${"aa".repeat(32)}`,
            logIndex: 0,
            blockNumber: "940",
            blockHash: fixtureBlockHash(940n),
            confirmationState: "confirmed" as const,
            observedAt: createdAt,
          },
        ],
        entitlements: [],
        refunds: [],
        settlements: [],
      }),
    getEconomyChain: () =>
      Promise.resolve({
        registeredSaleCount: 1,
        totalRaisedUsd1: "170000000000000000000",
        lockedLpCount: 1,
      }),
    listAllowlistRoots: () => Promise.resolve(options.roots ?? []),
    createIntent: async (
      input: Parameters<LaunchChainRepository["createIntent"]>[0],
    ) => {
      const existing = intents.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.sha !== input.requestSha256) {
          throw new LaunchIntentIdempotencyConflictError();
        }
        return { created: false, intent: existing.record };
      }
      fake.builds += 1;
      const built = await input.build();
      const record: LaunchIntentRecord = {
        ...built,
        transactionHash: null,
        payloadVerified: false,
        reportedAt: null,
        createdAt,
        receipt: null,
        reasonCode: null,
        revertReason: null,
      };
      intents.set(input.idempotencyKey, { sha: input.requestSha256, record });
      return { created: true, intent: record };
    },
    // Owner-scoped like the PostgreSQL repository: another account's
    // Intent is simply not found (Decision 0081).
    getIntent: (input: {
      readonly ownerUserId: string;
      readonly intentId: string;
      readonly launchId: string;
    }) =>
      Promise.resolve(
        [...intents.values()].find(
          (entry) =>
            entry.record.ownerUserId === input.ownerUserId &&
            entry.record.intentId === input.intentId &&
            entry.record.launchId === input.launchId,
        )?.record ?? null,
      ),
    reportIntentBroadcast: (input: {
      readonly intentId: string;
      readonly transactionHash: string;
      readonly payloadVerified: boolean;
    }) => {
      const entry = [...intents.values()].find(
        (item) => item.record.intentId === input.intentId,
      );
      if (entry === undefined) {
        return Promise.reject(new Error("unknown intent"));
      }
      if (entry.record.transactionHash !== null) {
        return entry.record.transactionHash === input.transactionHash
          ? Promise.resolve(entry.record)
          : Promise.reject(new LaunchIntentReportConflictError());
      }
      entry.record = {
        ...entry.record,
        state: "submitted",
        transactionHash: input.transactionHash,
        payloadVerified: input.payloadVerified,
        reportedAt: createdAt,
      };
      return Promise.resolve(entry.record);
    },
  };
  return fake;
}

export function walletsFake(
  wallet: Partial<AccountWalletRecord> = {},
): AccountWalletRepository {
  const record: AccountWalletRecord = {
    walletId,
    providerWalletId: "privy-wallet-1",
    address: walletAddress,
    kind: "embedded",
    status: "active",
    isActive: true,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    ...wallet,
  };
  return {
    sync: vi.fn(() => Promise.reject(new Error("not used"))),
    list: vi.fn(() => Promise.resolve([record])),
    get: vi.fn((_owner: string, id: string) =>
      Promise.resolve(id === record.walletId ? record : null),
    ),
    setActive: vi.fn(() => Promise.reject(new Error("not used"))),
    recordBalanceSnapshot: vi.fn(() => Promise.resolve()),
  };
}

export function writesConfig(
  overrides: Partial<BscWriteConfig> = {},
): BscWriteConfig {
  return {
    configVersion: "bscWriteCanaryV1",
    canaryAssetIds: [usd1AssetId],
    canaryMaxUsd: "50",
    canaryDailyMaxUsd: "100",
    canaryCounterpartyAddresses: [],
    ...overrides,
  } as BscWriteConfig;
}
