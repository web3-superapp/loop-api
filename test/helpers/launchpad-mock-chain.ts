/**
 * TEST ONLY (Decision 0076). An in-memory EIP-1193 provider that answers the
 * handful of JSON-RPC methods the Launch contract adapter uses, with values
 * encoded through ABI v1. Every number below is a fixture for tests; none of
 * it is a product parameter, a chain fact, or a default.
 */
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  type Transport,
} from "viem";

import { launchpadAbiV1 } from "../../src/integrations/launch/launchpad-abi.v1.js";
import type {
  LaunchContractLog,
  LaunchContractTransportFactory,
} from "../../src/integrations/launch/launch-contract-adapter.js";

export const mockLaunchpadAddress =
  "0x1111111111111111111111111111111111111111";
export const mockUsd1Address = "0x2222222222222222222222222222222222222222";
export const mockProjectTokenAddress =
  "0x3333333333333333333333333333333333333333";
export const mockConfigVersion = `0x${"ab".repeat(32)}`;
export const mockStateTupleDigest = `0x${"cd".repeat(32)}`;
export const mockAllowlistRoot = `0x${"ef".repeat(32)}`;
export const mockBlockNumber = 45_000_000n;
export const mockBlockHash = `0x${"12".repeat(32)}`;

export interface MockLaunchpadState {
  saleState: number;
  entitlementState: number;
  liquidityState: number;
  operationalState: number;
  configVersion: string;
  stateTupleDigest: string;
}

export interface MockLaunchpadChain {
  chainIdHex: string;
  code: Hex;
  blockNumber: bigint;
  blockHash: string;
  /** When set, the second read of the snapshot block returns this hash. */
  reorgHash: string | null;
  state: MockLaunchpadState;
  usd1: string;
  saleConfigVersion: string;
  failCalls: boolean;
  readonly calls: { method: string; params: readonly unknown[] }[];
}

export function createMockLaunchpadChain(
  overrides: Partial<MockLaunchpadChain> = {},
): MockLaunchpadChain {
  return {
    chainIdHex: "0x61",
    code: "0x6080604052",
    blockNumber: mockBlockNumber,
    blockHash: mockBlockHash,
    reorgHash: null,
    state: {
      saleState: 1,
      entitlementState: 0,
      liquidityState: 0,
      operationalState: 0,
      configVersion: mockConfigVersion,
      stateTupleDigest: mockStateTupleDigest,
    },
    usd1: mockUsd1Address,
    saleConfigVersion: mockConfigVersion,
    failCalls: false,
    calls: [],
    ...overrides,
  };
}

const oneToken = 10n ** 18n;

function callResult(chain: MockLaunchpadChain, data: Hex): Hex {
  const decoded = decodeFunctionData({ abi: launchpadAbiV1, data });
  switch (decoded.functionName) {
    case "getState": {
      return encodeFunctionResult({
        abi: launchpadAbiV1,
        functionName: "getState",
        result: {
          saleState: chain.state.saleState,
          entitlementState: chain.state.entitlementState,
          liquidityState: chain.state.liquidityState,
          operationalState: chain.state.operationalState,
          configVersion: chain.state.configVersion as Hex,
          stateTupleDigest: chain.state.stateTupleDigest as Hex,
        },
      });
    }
    case "getRounds": {
      return encodeFunctionResult({
        abi: launchpadAbiV1,
        functionName: "getRounds",
        result: [
          {
            roundId: 1,
            startAt: 1_790_000_000n,
            endAt: 1_790_172_800n,
            priceUsd1PerToken: 10n ** 16n,
            roundCapUsd1: 40_000n * oneToken,
            walletRoundCapUsd1: 500n * oneToken,
            allowlistRoot: mockAllowlistRoot as Hex,
            raisedUsd1: 1_234n * oneToken,
          },
          {
            roundId: 2,
            startAt: 1_790_172_800n,
            endAt: 1_790_432_000n,
            priceUsd1PerToken: 10n ** 16n,
            roundCapUsd1: 60_000n * oneToken,
            walletRoundCapUsd1: 500n * oneToken,
            allowlistRoot: `0x${"00".repeat(32)}`,
            raisedUsd1: 0n,
          },
        ],
      });
    }
    case "getSaleConfig": {
      return encodeFunctionResult({
        abi: launchpadAbiV1,
        functionName: "getSaleConfig",
        result: {
          projectToken: mockProjectTokenAddress,
          usd1: chain.usd1 as Hex,
          softCapUsd1: 20_000n * oneToken,
          hardCapUsd1: 100_000n * oneToken,
          walletProjectCapUsd1: 1_000n * oneToken,
          minPurchaseUsd1: 10n * oneToken,
          protocolFeeBps: 300,
          liquidityBps: 5_000,
          tgeBps: 2_500,
          cliffSeconds: 0,
          vestingSeconds: 7_776_000,
          poolFeeTier: 2_500,
          lpLockSeconds: 31_536_000,
          configVersion: chain.saleConfigVersion as Hex,
        },
      });
    }
    case "quote": {
      const [, , usd1Amount] = decoded.args;
      return encodeFunctionResult({
        abi: launchpadAbiV1,
        functionName: "quote",
        result: usd1Amount * 100n,
      });
    }
    case "getPosition": {
      return encodeFunctionResult({
        abi: launchpadAbiV1,
        functionName: "getPosition",
        result: {
          cumulativeUsd1: 100n * oneToken,
          purchasedTokens: 10_000n * oneToken,
          entitledTokens: 0n,
          claimableTokens: 0n,
          claimedTokens: 0n,
          refundableUsd1: 0n,
          refundedUsd1: 0n,
        },
      });
    }
    case "getRoundPosition": {
      return encodeFunctionResult({
        abi: launchpadAbiV1,
        functionName: "getRoundPosition",
        result: 100n * oneToken,
      });
    }
    default: {
      throw new Error(`unexpected call ${decoded.functionName}`);
    }
  }
}

function blockObject(number: bigint, hash: string): Record<string, unknown> {
  return {
    number: `0x${number.toString(16)}`,
    hash,
    parentHash: `0x${"00".repeat(32)}`,
    timestamp: "0x68000000",
    transactions: [],
    gasLimit: "0x1",
    gasUsed: "0x0",
    baseFeePerGas: null,
    difficulty: "0x0",
    extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`,
    miner: `0x${"00".repeat(20)}`,
    nonce: "0x0000000000000000",
    receiptsRoot: `0x${"00".repeat(32)}`,
    sha3Uncles: `0x${"00".repeat(32)}`,
    size: "0x1",
    stateRoot: `0x${"00".repeat(32)}`,
    totalDifficulty: "0x0",
    transactionsRoot: `0x${"00".repeat(32)}`,
    uncles: [],
  };
}

export function mockLaunchpadTransportFactory(
  chain: MockLaunchpadChain,
): LaunchContractTransportFactory {
  let snapshotReads = 0;
  return (): Transport =>
    custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        const list = (params ?? []) as readonly unknown[];
        chain.calls.push({ method, params: list });
        switch (method) {
          case "eth_chainId": {
            return Promise.resolve(chain.chainIdHex);
          }
          case "eth_getCode": {
            return Promise.resolve(chain.code);
          }
          case "eth_getBlockByNumber": {
            const tag = list[0];
            if (tag === "latest") {
              return Promise.resolve(
                blockObject(chain.blockNumber, chain.blockHash),
              );
            }
            snapshotReads += 1;
            const hash =
              chain.reorgHash !== null && snapshotReads >= 1
                ? chain.reorgHash
                : chain.blockHash;
            return Promise.resolve(blockObject(BigInt(tag as string), hash));
          }
          case "eth_call": {
            if (chain.failCalls) {
              return Promise.reject(new Error("mock endpoint failure"));
            }
            const [request, block] = list as [{ data: Hex }, string];
            if (block !== `0x${chain.blockNumber.toString(16)}`) {
              return Promise.reject(
                new Error(`call not pinned to the snapshot block: ${block}`),
              );
            }
            return Promise.resolve(callResult(chain, request.data));
          }
          default: {
            return Promise.reject(new Error(`unexpected method ${method}`));
          }
        }
      },
    });
}

/**
 * TEST ONLY: encodes one of the 14 events as a raw log through ABI v1, so a
 * fixture log is exactly what a v1 contract would emit.
 */
export function encodeLaunchpadLog(
  eventName: (typeof launchpadAbiV1)[number]["name"],
  args: Readonly<Record<string, unknown>>,
  logIndex = 0,
): LaunchContractLog {
  const event = launchpadAbiV1.find(
    (entry) => entry.type === "event" && entry.name === eventName,
  );
  if (event === undefined || event.type !== "event") {
    throw new Error(`unknown event ${eventName}`);
  }
  const topics = encodeEventTopics({
    abi: [event],
    eventName: event.name,
    args: Object.fromEntries(
      event.inputs
        .filter((input) => input.indexed)
        .map((input) => [input.name, args[input.name]]),
    ),
  });
  const nonIndexed = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => args[input.name]) as never,
  );
  return {
    address: mockLaunchpadAddress,
    topics: topics.filter((topic): topic is Hex => topic !== null),
    data,
    blockNumber: mockBlockNumber,
    blockHash: mockBlockHash,
    transactionHash: `0x${"aa".repeat(32)}`,
    logIndex,
    removed: false,
  };
}
