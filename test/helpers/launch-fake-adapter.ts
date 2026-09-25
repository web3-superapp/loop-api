/**
 * TEST ONLY (Decision 0077). An in-memory LaunchContractAdapter and a
 * launch-slot call client whose every value is a test fixture: nothing here
 * is a product parameter, a default, or a chain fact.
 */
import type {
  BscAllowanceRequestItem,
  BscBalanceRequestItem,
  BscChainCallClient,
  BscTransactionObservation,
} from "../../src/integrations/bsc/rpc-client.js";
import { createUnavailableBscReadClient } from "../../src/integrations/bsc/rpc-client.js";
import {
  LaunchContractUnavailableError,
  decodeLaunchpadLogs,
  encodeLaunchBuyCalldata,
  encodeLaunchClaimCalldata,
  encodeLaunchClaimRefundCalldata,
  type LaunchContractAdapter,
  type LaunchContractConfig,
  type LaunchContractPosition,
  type LaunchContractRound,
  type LaunchContractSaleConfig,
  type LaunchSaleStateTuple,
} from "../../src/integrations/launch/launch-contract-adapter.js";
import type { LaunchContractReasonCode } from "../../src/features/launch/launch-contract.js";
import { fixtureBlockHash, oneUsd1 } from "./launch-lane-fixtures.js";

export const fakeLaunchContract: LaunchContractConfig = Object.freeze({
  address: "0x1111111111111111111111111111111111111111",
  version: "1.0.0",
  versionMajor: 1,
  startBlock: 100n,
  usd1Address: "0x2222222222222222222222222222222222222222",
});
export const fakeProjectToken = "0x3333333333333333333333333333333333333333";
export const fakeConfigVersion = `0x${"ab".repeat(32)}`;
export const fakeDigest = `0x${"cd".repeat(32)}`;
export const fakeSnapshotBlock = 900n;
/** 2026-09-22T00:00:00Z, inside round 1 below. */
export const fakeNowSeconds = 1_790_035_200n;

export interface FakeLaunchChainState {
  tuple: LaunchSaleStateTuple;
  rounds: LaunchContractRound[];
  config: LaunchContractSaleConfig;
  position: LaunchContractPosition;
  roundPosition: bigint;
  /** Tokens per 1 USD1 base unit. */
  tokensPerUsd1: bigint;
  blockTimestamp: bigint;
  unavailable: LaunchContractReasonCode | null;
  calls: string[];
}

export function createFakeLaunchChainState(
  overrides: Partial<FakeLaunchChainState> = {},
): FakeLaunchChainState {
  return {
    tuple: {
      saleState: "LIVE",
      entitlementState: "NONE",
      liquidityState: "NOT_STARTED",
      operationalState: "ACTIVE",
      configVersion: fakeConfigVersion,
      stateTupleDigest: fakeDigest,
    },
    rounds: [
      {
        roundId: 1,
        startAt: fakeNowSeconds - 3_600n,
        endAt: fakeNowSeconds + 86_400n,
        priceUsd1PerToken: 10n ** 16n,
        roundCapUsd1: 40_000n * oneUsd1,
        walletRoundCapUsd1: 500n * oneUsd1,
        allowlistRoot: `0x${"00".repeat(32)}`,
        raisedUsd1: 1_000n * oneUsd1,
      },
      {
        roundId: 2,
        startAt: fakeNowSeconds + 86_400n,
        endAt: fakeNowSeconds + 172_800n,
        priceUsd1PerToken: 10n ** 16n,
        roundCapUsd1: 60_000n * oneUsd1,
        walletRoundCapUsd1: 500n * oneUsd1,
        allowlistRoot: `0x${"00".repeat(32)}`,
        raisedUsd1: 0n,
      },
    ],
    config: {
      projectToken: fakeProjectToken,
      usd1: fakeLaunchContract.usd1Address,
      softCapUsd1: 20_000n * oneUsd1,
      hardCapUsd1: 100_000n * oneUsd1,
      walletProjectCapUsd1: 1_000n * oneUsd1,
      minPurchaseUsd1: 10n * oneUsd1,
      protocolFeeBps: 300,
      liquidityBps: 5_000,
      tgeBps: 2_500,
      cliffSeconds: 0,
      vestingSeconds: 7_776_000,
      poolFeeTier: 2_500,
      lpLockSeconds: 31_536_000,
      configVersion: fakeConfigVersion,
    },
    position: {
      cumulativeUsd1: 100n * oneUsd1,
      purchasedTokens: 10_000n * oneUsd1,
      entitledTokens: 0n,
      claimableTokens: 0n,
      claimedTokens: 0n,
      refundableUsd1: 0n,
      refundedUsd1: 0n,
    },
    roundPosition: 100n * oneUsd1,
    tokensPerUsd1: 100n,
    blockTimestamp: fakeNowSeconds,
    unavailable: null,
    calls: [],
    ...overrides,
  };
}

export function createFakeLaunchAdapter(
  state: FakeLaunchChainState,
  contract: LaunchContractConfig | null = fakeLaunchContract,
): LaunchContractAdapter {
  const snapshot = Object.freeze({
    blockNumber: fakeSnapshotBlock,
    blockHash: fixtureBlockHash(fakeSnapshotBlock),
  });
  function read<T>(name: string, value: () => T) {
    state.calls.push(name);
    if (state.unavailable !== null) {
      return Promise.reject(
        new LaunchContractUnavailableError(state.unavailable),
      );
    }
    return Promise.resolve(Object.freeze({ value: value(), snapshot }));
  }
  const availability = () =>
    contract === null
      ? ({
          status: "unavailable",
          reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
        } as const)
      : ({ status: "available" } as const);
  const adapter: LaunchContractAdapter = {
    contract,
    chainId: "eip155:97" as const,
    availability: () => Promise.resolve(availability()),
    currentAvailability: availability,
    verifyAtStartup: () => Promise.resolve(availability()),
    takeSnapshot: () => Promise.resolve(snapshot),
    confirmSnapshot: () => Promise.resolve(),
    getState: () => read("getState", () => state.tuple),
    getRounds: () => read("getRounds", () => state.rounds),
    getSaleConfig: () => read("getSaleConfig", () => state.config),
    quote: (input) =>
      read("quote", () => input.usd1Amount * state.tokensPerUsd1),
    getPosition: () => read("getPosition", () => state.position),
    getRoundPosition: () => read("getRoundPosition", () => state.roundPosition),
    encodeBuy: (input) =>
      Object.freeze({
        to: fakeLaunchContract.address,
        data: encodeLaunchBuyCalldata(input),
        value: 0n as const,
      }),
    encodeClaim: (saleId) =>
      Object.freeze({
        to: fakeLaunchContract.address,
        data: encodeLaunchClaimCalldata(saleId),
        value: 0n as const,
      }),
    encodeClaimRefund: (saleId) =>
      Object.freeze({
        to: fakeLaunchContract.address,
        data: encodeLaunchClaimRefundCalldata(saleId),
        value: 0n as const,
      }),
    decodeEvents: (logs) => decodeLaunchpadLogs(logs),
    readLogs: () => Promise.resolve([]),
    readBlock: (blockNumber) =>
      Promise.resolve(
        Object.freeze({
          blockNumber,
          blockHash: fixtureBlockHash(blockNumber),
          timestamp: state.blockTimestamp,
        }),
      ),
  };
  return Object.freeze(adapter);
}

export interface FakeLaunchSlotFunds {
  usd1Balance: bigint;
  allowance: bigint;
  nativeBalance: bigint;
  simulation: "passed" | "reverted";
  /** What eth_getTransactionByHash returns for a report (default: unseen). */
  observed?: BscTransactionObservation | null;
}

export function createFakeLaunchSlotClient(
  funds: FakeLaunchSlotFunds,
): BscChainCallClient {
  const head = () => ({
    blockNumber: fakeSnapshotBlock,
    blockHash: fixtureBlockHash(fakeSnapshotBlock),
    observedAt: new Date(Number(fakeNowSeconds) * 1000).toISOString(),
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
            item.address === null ? funds.nativeBalance : funds.usd1Balance,
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
          rawValue: funds.allowance,
          reasonCode: null,
        })),
      }),
    call: () =>
      Promise.resolve(
        funds.simulation === "passed"
          ? { status: "passed" as const, returnData: "0x" as const }
          : { status: "reverted" as const, reasonCode: "EXECUTION_REVERTED" },
      ),
    estimateGas: () => Promise.resolve(100_000n),
    getFeeData: () =>
      Promise.resolve({ type: "legacy" as const, gasPrice: 1_000_000_000n }),
    getTransactionCount: () => Promise.resolve(3),
    getCode: () => Promise.resolve("0x6080" as const),
    getTransaction: () => Promise.resolve(funds.observed ?? null),
  });
}
