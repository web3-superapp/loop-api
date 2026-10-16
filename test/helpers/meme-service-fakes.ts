/**
 * TEST ONLY (Decision 0101). An in-memory MemeRepository, a curve adapter
 * whose state is a fixture, and a launch-slot client with separate USD1,
 * token, and native balances. Nothing here is a product parameter.
 */
import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import type {
  BscAllowanceRequestItem,
  BscBalanceRequestItem,
  BscChainCallClient,
  BscTransactionObservation,
} from "../../src/integrations/bsc/rpc-client.js";
import { createUnavailableBscReadClient } from "../../src/integrations/bsc/rpc-client.js";
import {
  encodeMemeBuyCalldata,
  encodeMemeCreateTokenCalldata,
  encodeMemeGraduateCalldata,
  encodeMemeSellCalldata,
  decodeMemeCurveLogs,
  type MemeContractAdapter,
  type MemeContractConfig,
  type MemeCurveStatus,
} from "../../src/integrations/meme/meme-contract-adapter.js";
import {
  freshMemeCurve,
  memeV0,
  memeT0,
  quoteMemeBuy,
  quoteMemeSell,
  type MemeCurveState,
} from "../../src/features/meme/meme-curve-math.js";
import {
  MemeCreateIntentInFlightError,
  MemeCreateRateLimitedError,
  MemeIdempotencyConflictError,
  MemeIntentReportConflictError,
  MemeRepositoryUnavailableError,
  type CreateMemeIntentRecord,
  type MemeBestTradeRecord,
  type MemeIntentRecord,
  type MemeRepository,
  type MemeTokenListRecord,
  type MemeTokenRecord,
} from "../../src/features/meme/meme-repository.js";
import { fixtureBlockHash, memeCurveAddress } from "./meme-fixtures.js";

export const memeUsd1 = "0x2222222222222222222222222222222222222222";
export const memeImplementation = "0xa87a54dc67e407e8b6d67e690abdfe02f979f4da";
export const memeSnapshotBlock = 5_000n;
export const memeNowSeconds = 1_791_590_400n;

export const memeContractConfig: MemeContractConfig = Object.freeze({
  address: memeCurveAddress,
  version: "1.0.0",
  versionMajor: 1,
  startBlock: 100n,
  tokenImplementation: memeImplementation,
  usd1Address: memeUsd1,
});

/** API environment that configures the curve on the 97 launch slot. */
export const memeEnv = Object.freeze({
  V2_MODULES_ENABLED: "meme",
  LAUNCH_CHAIN_ID: "97",
  LAUNCH_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
  LAUNCH_CONTRACT_VERSION: "1.0.0",
  LAUNCH_CONTRACT_START_BLOCK: "100",
  LAUNCH_USD1_ADDRESS: memeUsd1,
  MEME_CONTRACT_ADDRESS: memeCurveAddress,
  MEME_CONTRACT_VERSION: "1.0.0",
  MEME_CONTRACT_START_BLOCK: "100",
  MEME_TOKEN_IMPLEMENTATION: memeImplementation,
  // Decision 0151: classic creation is off by default; these suites
  // exercise the pre-0151 behaviour behind the explicit switch.
  MEME_CLASSIC_CREATE_ENABLED: "true",
});

export const memeWritesEnv = Object.freeze({
  BSC_WRITES_ENABLED: "true",
  BSC_RPC_URLS: "https://bsc-rpc.invalid/",
  BSC_WRITE_CANARY_ASSETS: `eip155:97:${memeUsd1}`,
  BSC_WRITE_CANARY_MAX_USD: "5000",
});

export interface FakeCurveChain {
  curves: Map<string, { curve: MemeCurveState; status: MemeCurveStatus }>;
  unavailable: boolean;
  /** Decision 0103: `slot0().sqrtPriceX96` by pool address; absent = read fails. */
  pools?: Map<string, bigint>;
}

export function createFakeMemeAdapter(
  chain: FakeCurveChain,
  contract: MemeContractConfig | null = memeContractConfig,
): MemeContractAdapter {
  const snapshot = Object.freeze({
    blockNumber: memeSnapshotBlock,
    blockHash: fixtureBlockHash(memeSnapshotBlock),
  });
  const read = <T>(value: () => T) =>
    chain.unavailable
      ? Promise.reject(new Error("unreachable"))
      : Promise.resolve(Object.freeze({ value: value(), snapshot }));
  const curveOf = (token: string) =>
    chain.curves.get(token) ?? {
      curve: freshMemeCurve,
      status: "NONE" as const,
    };
  return Object.freeze({
    contract,
    chainId: "eip155:97" as const,
    chainReference: 97 as const,
    availability: () =>
      Promise.resolve(
        contract === null
          ? {
              status: "unavailable" as const,
              reasonCode: "MEME_CONTRACT_NOT_CONFIGURED" as const,
            }
          : { status: "available" as const },
      ),
    currentAvailability: () =>
      contract === null
        ? {
            status: "unavailable" as const,
            reasonCode: "MEME_CONTRACT_NOT_CONFIGURED" as const,
          }
        : { status: "available" as const },
    verifyAtStartup: () => Promise.resolve({ status: "available" as const }),
    takeSnapshot: () => Promise.resolve(snapshot),
    confirmSnapshot: () => Promise.resolve(),
    getCurve: (token: string) =>
      read(() => {
        const entry = curveOf(token);
        return {
          vUsd1: entry.curve.vUsd1,
          vToken: entry.curve.vToken,
          realUsd1: entry.curve.vUsd1 - memeV0,
          sold: memeT0 - entry.curve.vToken,
          createdAt: memeNowSeconds,
          creator: "0x0000000000000000000000000000000000000001",
          status: entry.status,
          pool: "0x0000000000000000000000000000000000000000",
          graduatedAt: 0n,
        };
      }),
    quoteBuy: (input: { token: string; usd1In: bigint }) =>
      read(() => {
        const quote = quoteMemeBuy(curveOf(input.token).curve, input.usd1In);
        return {
          tokensOut: quote.tokensOut,
          fee: quote.fee,
          refund: quote.refund,
        };
      }),
    quoteSell: (input: { token: string; tokensIn: bigint }) =>
      read(() => {
        const quote = quoteMemeSell(curveOf(input.token).curve, input.tokensIn);
        return { usd1Out: quote.usd1Out, fee: quote.fee };
      }),
    readPoolSqrtPriceX96: (pool: string) => {
      const price = chain.pools?.get(pool.toLowerCase());
      return chain.unavailable || price === undefined
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve(price);
    },
    encodeCreateToken: (input) => ({
      to: memeCurveAddress,
      data: encodeMemeCreateTokenCalldata(input),
      value: 0n as const,
    }),
    encodeBuy: (input) => ({
      to: memeCurveAddress,
      data: encodeMemeBuyCalldata(input),
      value: 0n as const,
    }),
    encodeSell: (input) => ({
      to: memeCurveAddress,
      data: encodeMemeSellCalldata(input),
      value: 0n as const,
    }),
    encodeGraduate: (token: string) => ({
      to: memeCurveAddress,
      data: encodeMemeGraduateCalldata(token),
      value: 0n as const,
    }),
    decodeEvents: (logs) => decodeMemeCurveLogs(logs),
    readLogs: () => Promise.resolve([]),
    readBlock: (blockNumber: bigint) =>
      Promise.resolve({
        blockNumber,
        blockHash: fixtureBlockHash(blockNumber),
        timestamp: memeNowSeconds,
      }),
  } satisfies MemeContractAdapter);
}

export interface FakeMemeFunds {
  usd1Balance: bigint;
  tokenBalance: bigint;
  nativeBalance: bigint;
  usd1Allowance: bigint;
  tokenAllowance: bigint;
  simulation: "passed" | "reverted";
  /** Addresses that already have code (a salt taken on chain). */
  codeAt: Set<string>;
  observed: BscTransactionObservation | null;
}

export function createFakeMemeSlotClient(
  funds: FakeMemeFunds,
): BscChainCallClient {
  const head = () => ({
    blockNumber: memeSnapshotBlock,
    blockHash: fixtureBlockHash(memeSnapshotBlock),
    observedAt: new Date(Number(memeNowSeconds) * 1000).toISOString(),
  });
  return Object.freeze({
    ...createUnavailableBscReadClient({
      chainId: "eip155:97",
      chainReference: 97,
      confirmations: 5,
      reorgDepthBlocks: 15,
    }),
    endpointRefs: Object.freeze(["rpc-test"]),
    verifyChain: () => Promise.resolve("verified" as const),
    currentVerification: () => "verified" as const,
    getHead: () => Promise.resolve(head()),
    readBalances: (_owner: string, items: readonly BscBalanceRequestItem[]) =>
      Promise.resolve({
        head: head(),
        balances: items.map((item) => ({
          assetId: item.assetId,
          rawValue:
            item.address === null
              ? funds.nativeBalance
              : item.address === memeUsd1
                ? funds.usd1Balance
                : funds.tokenBalance,
          reasonCode: null,
        })),
      }),
    readAllowances: (
      _owner: string,
      items: readonly BscAllowanceRequestItem[],
    ) =>
      Promise.resolve({
        head: head(),
        allowances: items.map((item) => ({
          assetId: item.assetId,
          spender: item.spender,
          rawValue:
            item.token === memeUsd1
              ? funds.usd1Allowance
              : funds.tokenAllowance,
          reasonCode: null,
        })),
      }),
    call: () =>
      Promise.resolve(
        funds.simulation === "passed"
          ? { status: "passed" as const, returnData: "0x" as const }
          : { status: "reverted" as const, reasonCode: "EXECUTION_REVERTED" },
      ),
    estimateGas: () => Promise.resolve(200_000n),
    getFeeData: () =>
      Promise.resolve({ type: "legacy" as const, gasPrice: 1_000_000_000n }),
    getTransactionCount: () => Promise.resolve(7),
    getCode: (address: string) =>
      Promise.resolve(
        funds.codeAt.has(address) ? ("0x6080" as const) : ("0x" as const),
      ),
    getTransaction: () => Promise.resolve(funds.observed),
  });
}

export function defaultMemeFunds(
  overrides: Partial<FakeMemeFunds> = {},
): FakeMemeFunds {
  return {
    usd1Balance: 1_000n * 10n ** 18n,
    tokenBalance: 0n,
    nativeBalance: 10n ** 17n,
    usd1Allowance: 0n,
    tokenAllowance: 0n,
    simulation: "passed",
    codeAt: new Set(),
    observed: null,
    ...overrides,
  };
}

const createdAt = "2026-10-08T00:00:00.000Z";

export function memeTokenFixture(
  overrides: Partial<MemeTokenRecord> = {},
): MemeTokenRecord {
  return {
    memeTokenId: randomUUID(),
    chainId: "eip155:97",
    contractAddress: memeCurveAddress,
    contractVersion: "1.0.0",
    creatorUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
    creatorWallet: "0x000000000000000000000000000000000000000a",
    creator: {
      publicProfileId: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      displayName: "frogmaker",
      avatarRef: null,
    },
    name: "Frog",
    symbol: "FROG",
    description: "",
    imageMediaId: null,
    links: { twitter: null, telegram: null, website: null },
    metadataHash: `0x${"cd".repeat(32)}`,
    salt: `0x${"ab".repeat(32)}`,
    predictedAddress: "0xac42e9101f379437f3cce49a5b58609dd9a0ca94",
    vanity: false,
    tokenAddress: "0xac42e9101f379437f3cce49a5b58609dd9a0ca94",
    assetId: "eip155:97:0xac42e9101f379437f3cce49a5b58609dd9a0ca94",
    status: "trading",
    createdBlock: "120",
    createdTxHash: `0x${"01".repeat(32)}`,
    chainCreatedAt: createdAt,
    vUsd1: freshMemeCurve.vUsd1.toString(),
    vToken: freshMemeCurve.vToken.toString(),
    realUsd1: "0",
    sold: "0",
    holderCount: 0,
    tradeCount: 0,
    lastTradeAt: null,
    fullAt: null,
    graduatedAt: null,
    poolAddress: null,
    graduationTxHash: null,
    lpTokenId: null,
    usd1ToPool: null,
    tokensToPool: null,
    graduationFeeUsd1: null,
    residualUsd1: null,
    residualTokens: null,
    graduationAttempts: 0,
    graduationNeedsOperator: false,
    createdAt,
    updatedAt: createdAt,
    listing: "listed",
    listingReasonCode: null,
    listingReasonText: null,
    ...overrides,
  };
}

function listRecord(token: MemeTokenRecord): MemeTokenListRecord {
  return { ...token, volume24hRaw: "0", price1hAgoE18: null };
}

export interface InMemoryMemeRepository extends MemeRepository {
  readonly tokens: Map<string, MemeTokenRecord>;
  readonly intents: Map<string, MemeIntentRecord>;
  /** What `rankBestTrades` answers; `bestTradeCalls` records each read. */
  bestTrades: readonly MemeBestTradeRecord[];
  readonly bestTradeCalls: Parameters<MemeRepository["rankBestTrades"]>[0][];
  rateLimited: boolean;
  /** What `sumRecentExposureUsd` answers (the pre-check). */
  exposureUsd: string;
  /**
   * What the insert-time re-check sees (Decision 0104 M2); defaults to
   * `exposureUsd`. A different value models a concurrent Intent stored
   * between the pre-check and the insert.
   */
  insertExposureUsd: string | null;
}

/** Only what the API process calls; lane / pool / executor methods reject. */
export function createInMemoryMemeRepository(): InMemoryMemeRepository {
  const tokens = new Map<string, MemeTokenRecord>();
  const intents = new Map<string, MemeIntentRecord>();
  const drafts = new Map<string, { sha: string; id: string }>();
  const intentKeys = new Map<string, { sha: string; id: string }>();
  const fail = vi.fn(() =>
    Promise.reject(new MemeRepositoryUnavailableError()),
  );
  const repository: InMemoryMemeRepository = {
    tokens,
    intents,
    bestTrades: [],
    bestTradeCalls: [],
    rankBestTrades: (input) => {
      repository.bestTradeCalls.push(input);
      return Promise.resolve(repository.bestTrades);
    },
    rateLimited: false,
    exposureUsd: "0",
    insertExposureUsd: null,
    getToken: (id) => Promise.resolve(tokens.get(id) ?? null),
    listTokens: (input) => {
      const ordered = [...tokens.values()]
        .filter((token) => token.listing === "listed")
        .filter((token) =>
          input.tab === "graduated"
            ? token.status === "graduated"
            : input.tab === "graduating"
              ? token.status === "trading"
              : token.status !== "draft" && token.status !== "pending_chain",
        )
        .sort((left, right) => (left.memeTokenId < right.memeTokenId ? 1 : -1));
      const after = input.after;
      const start =
        after === null
          ? 0
          : ordered.findIndex(
              (token) => token.memeTokenId === after.memeTokenId,
            ) + 1;
      return Promise.resolve(
        ordered.slice(start, start + input.limit).map(listRecord),
      );
    },
    rankHotTokens: () =>
      Promise.resolve(
        [...tokens.values()]
          .filter(
            (token) =>
              token.tokenAddress !== null && token.listing === "listed",
          )
          .map((token) => ({ memeTokenId: token.memeTokenId, volumeRaw: "0" })),
      ),
    listTokensByIds: (input) =>
      Promise.resolve(
        input.memeTokenIds.flatMap((id) => {
          const token = tokens.get(id);
          return token === undefined ? [] : [listRecord(token)];
        }),
      ),
    tokenStats: () =>
      Promise.resolve({
        volume24hRaw: "5000000000000000000",
        price1hAgoE18: null,
      }),
    listTrades: () =>
      Promise.resolve([
        {
          transactionHash: `0x${"02".repeat(32)}`,
          logIndex: 3,
          blockNumber: "121",
          wallet: "0x000000000000000000000000000000000000000a",
          isBuy: true,
          usd1Amount: "5000000000000000000",
          tokenAmount: "890000000000000000000000",
          feeUsd1: "50000000000000000",
          priceAfterE18: "5600000000000",
          tradedAt: createdAt,
          account: null,
        },
      ]),
    listCandles: () =>
      Promise.resolve([
        {
          openTime: createdAt,
          openE18: "5600000000000",
          highE18: "5700000000000",
          lowE18: "5600000000000",
          closeE18: "5650000000000",
          volumeUsd1Raw: "5000000000000000000",
          tradeCount: 2,
        },
      ]),
    listHolders: () =>
      Promise.resolve([
        {
          wallet: "0x000000000000000000000000000000000000000a",
          balance: "100000000000000000000000000",
          frozenAt: null,
          ownerUserId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
          account: null,
        },
      ]),
    createDraft: (input) => {
      const replay = drafts.get(input.idempotencyKey);
      if (replay !== undefined) {
        if (replay.sha !== input.requestSha256) {
          return Promise.reject(new MemeIdempotencyConflictError());
        }
        return Promise.resolve({
          created: false,
          token: tokens.get(replay.id) as MemeTokenRecord,
        });
      }
      if (repository.rateLimited) {
        return Promise.reject(new MemeCreateRateLimitedError(input.dailyLimit));
      }
      const token = memeTokenFixture({
        memeTokenId: input.draft.memeTokenId,
        creatorUserId: input.ownerUserId,
        creatorWallet: null,
        name: input.draft.name,
        symbol: input.draft.symbol,
        description: input.draft.description,
        links: input.draft.links,
        metadataHash: input.draft.metadataHash,
        salt: input.fallbackSalt.salt,
        predictedAddress: input.fallbackSalt.predictedAddress,
        vanity: false,
        tokenAddress: null,
        assetId: null,
        status: "draft",
        createdBlock: null,
        createdTxHash: null,
        chainCreatedAt: null,
      });
      tokens.set(token.memeTokenId, token);
      drafts.set(input.idempotencyKey, {
        sha: input.requestSha256,
        id: token.memeTokenId,
      });
      return Promise.resolve({ created: true, token });
    },
    replaceDraftSalt: (input) => {
      const token = tokens.get(input.memeTokenId);
      if (token === undefined || token.salt !== input.expectedSalt) {
        return Promise.resolve(null);
      }
      const next = {
        ...token,
        salt: input.fallbackSalt.salt,
        predictedAddress: input.fallbackSalt.predictedAddress,
        vanity: false,
      };
      tokens.set(token.memeTokenId, next);
      return Promise.resolve(next);
    },
    touchDraftSalt: () => Promise.resolve(),
    createIntent: async (input) => {
      const replay = intentKeys.get(input.idempotencyKey);
      if (replay !== undefined) {
        if (replay.sha !== input.requestSha256) {
          throw new MemeIdempotencyConflictError();
        }
        return {
          created: false,
          intent: intents.get(replay.id) as MemeIntentRecord,
        };
      }
      const live = (memeTokenId: string) =>
        [...intents.values()].some(
          (intent) =>
            intent.memeTokenId === memeTokenId &&
            intent.kind === "create" &&
            (intent.state === "broadcast_reported" ||
              intent.state === "prepared"),
        );
      const exclusive = input.exclusiveCreate ?? null;
      if (exclusive !== null && live(exclusive.memeTokenId)) {
        throw new MemeCreateIntentInFlightError();
      }
      const built: CreateMemeIntentRecord = await input.build();
      if (exclusive !== null && live(exclusive.memeTokenId)) {
        throw new MemeCreateIntentInFlightError();
      }
      const admission = input.canaryAdmission?.(built) ?? null;
      admission?.admit(repository.insertExposureUsd ?? repository.exposureUsd);
      const record: MemeIntentRecord = {
        ...built,
        reasonCode: null,
        transactionHash: null,
        payloadVerified: false,
        receipt: null,
        createdAt: new Date(Number(memeNowSeconds) * 1000).toISOString(),
        updatedAt: new Date(Number(memeNowSeconds) * 1000).toISOString(),
      };
      intents.set(record.intentId, record);
      intentKeys.set(input.idempotencyKey, {
        sha: input.requestSha256,
        id: record.intentId,
      });
      return { created: true, intent: record };
    },
    getIntent: (input) => {
      const record = intents.get(input.intentId);
      return Promise.resolve(
        record === undefined || record.ownerUserId !== input.ownerUserId
          ? null
          : record,
      );
    },
    reportIntentBroadcast: (input) => {
      const record = intents.get(input.intentId);
      if (record === undefined || record.transactionHash !== null) {
        return Promise.reject(new MemeIntentReportConflictError());
      }
      const next: MemeIntentRecord = {
        ...record,
        state: "broadcast_reported",
        transactionHash: input.transactionHash,
        payloadVerified: input.payloadVerified,
      };
      intents.set(record.intentId, next);
      return Promise.resolve(next);
    },
    sumRecentExposureUsd: () => Promise.resolve(repository.exposureUsd),
    leaseReconcilableIntents: fail,
    markIntentPayloadVerified: fail,
    settleIntent: fail,
    getCheckpoint: fail,
    commitSegment: fail,
    countFreeSalts: fail,
    insertSalts: fail,
    releaseStaleSaltReservations: fail,
    listGraduationCandidates: fail,
    recordGraduationAttempt: fail,
  };
  return repository;
}
