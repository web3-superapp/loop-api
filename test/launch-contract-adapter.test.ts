import {
  decodeFunctionData,
  toEventSelector,
  toFunctionSelector,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  createLaunchContractAdapter,
  decodeLaunchpadLogs,
  encodeLaunchBuyCalldata,
  LaunchContractUnavailableError,
  type LaunchContractConfig,
} from "../src/integrations/launch/launch-contract-adapter.js";
import { launchpadAbiV1 } from "../src/integrations/launch/launchpad-abi.v1.js";
import type { ChainVerificationState } from "../src/integrations/bsc/rpc-client.js";
import {
  createMockLaunchpadChain,
  encodeLaunchpadLog,
  mockAllowlistRoot,
  mockBlockHash,
  mockBlockNumber,
  mockConfigVersion,
  mockLaunchpadAddress,
  mockLaunchpadTransportFactory,
  mockProjectTokenAddress,
  mockStateTupleDigest,
  mockUsd1Address,
  type MockLaunchpadChain,
} from "./helpers/launchpad-mock-chain.js";

const contract: LaunchContractConfig = Object.freeze({
  address: mockLaunchpadAddress,
  version: "1.0.0",
  versionMajor: 1,
  startBlock: 44_000_000n,
  usd1Address: mockUsd1Address,
});

const testnet = Object.freeze({
  chainId: "eip155:97" as const,
  chainReference: 97 as const,
  rpcUrls: ["https://launch-rpc.invalid/"],
});

function adapterFor(
  chain: MockLaunchpadChain,
  options: {
    readonly contract?: LaunchContractConfig | null;
    readonly verification?: ChainVerificationState;
    readonly rpcUrls?: readonly string[];
  } = {},
) {
  const logger = { warn: vi.fn(), info: vi.fn() };
  const adapter = createLaunchContractAdapter({
    contract: options.contract === undefined ? contract : options.contract,
    chain: { ...testnet, rpcUrls: options.rpcUrls ?? testnet.rpcUrls },
    verifyChain: () => Promise.resolve(options.verification ?? "verified"),
    transportFactory: mockLaunchpadTransportFactory(chain),
    logger,
  });
  return { adapter, logger };
}

describe("Launch contract adapter availability (Decision 0076)", () => {
  it("is BASELINE_PENDING without configuration and never touches the network", async () => {
    const chain = createMockLaunchpadChain();
    const { adapter, logger } = adapterFor(chain, { contract: null });
    expect(adapter.currentAvailability()).toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
    });
    await expect(adapter.verifyAtStartup()).resolves.toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
    });
    await expect(adapter.getState(1n)).rejects.toMatchObject({
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
    });
    expect(() => adapter.encodeClaim(1n)).toThrow(
      LaunchContractUnavailableError,
    );
    expect(chain.calls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("refuses an unsupported ABI major and an endpoint-less slot without a probe", async () => {
    const chain = createMockLaunchpadChain();
    const v2 = adapterFor(chain, {
      contract: { ...contract, version: "2.0.0", versionMajor: 2 },
    });
    await expect(v2.adapter.availability()).resolves.toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_VERSION_UNSUPPORTED",
    });
    const noRpc = adapterFor(chain, { rpcUrls: [] });
    await expect(noRpc.adapter.availability()).resolves.toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
    });
    expect(chain.calls).toEqual([]);
  });

  it("follows the launch slot's chain verification", async () => {
    const chain = createMockLaunchpadChain();
    const mismatched = adapterFor(chain, { verification: "mismatched" });
    await expect(mismatched.adapter.availability()).resolves.toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CHAIN_ID_MISMATCH",
    });
    const unreachable = adapterFor(chain, { verification: "unreachable" });
    await expect(unreachable.adapter.availability()).resolves.toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CHAIN_RPC_UNREACHABLE",
    });
    expect(chain.calls).toEqual([]);
  });

  it("keeps LAUNCH_CONTRACT_CODE_MISSING sticky and logs it once at startup, without a URL", async () => {
    const chain = createMockLaunchpadChain({ code: "0x" });
    const { adapter, logger } = adapterFor(chain);
    expect(adapter.currentAvailability()).toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_VERIFICATION_PENDING",
    });
    await expect(adapter.verifyAtStartup()).resolves.toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_CODE_MISSING",
    });
    chain.code = "0x6080";
    await expect(adapter.availability()).resolves.toMatchObject({
      reasonCode: "LAUNCH_CONTRACT_CODE_MISSING",
    });
    expect(
      chain.calls.filter((call) => call.method === "eth_getCode"),
    ).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "launch-rpc.invalid",
    );
  });

  it("becomes available once code is observed", async () => {
    const chain = createMockLaunchpadChain();
    const { adapter, logger } = adapterFor(chain);
    await expect(adapter.verifyAtStartup()).resolves.toEqual({
      status: "available",
    });
    expect(adapter.currentAvailability()).toEqual({ status: "available" });
    expect(logger.info).toHaveBeenCalledOnce();
  });
});

describe("Launch contract adapter reads (Decision 0076)", () => {
  it("reads the four axes at one block and returns the contract's digest verbatim", async () => {
    const chain = createMockLaunchpadChain();
    const { adapter } = adapterFor(chain);
    const read = await adapter.getState(7n);
    expect(read).toEqual({
      value: {
        saleState: "LIVE",
        entitlementState: "NONE",
        liquidityState: "NOT_STARTED",
        operationalState: "ACTIVE",
        configVersion: mockConfigVersion,
        stateTupleDigest: mockStateTupleDigest,
      },
      snapshot: { blockNumber: mockBlockNumber, blockHash: mockBlockHash },
    });
    const call = chain.calls.find((entry) => entry.method === "eth_call");
    // Pinned to the snapshot block, never "latest".
    expect(call?.params[1]).toBe(`0x${mockBlockNumber.toString(16)}`);
    const request = call?.params[0] as { to: string; data: Hex };
    expect(request.to.toLowerCase()).toBe(mockLaunchpadAddress);
    expect(
      decodeFunctionData({ abi: launchpadAbiV1, data: request.data }),
    ).toMatchObject({ functionName: "getState", args: [7n] });
  });

  it("maps every axis encoding in 06 §2 table order", async () => {
    const chain = createMockLaunchpadChain();
    const { adapter } = adapterFor(chain);
    chain.state = {
      ...chain.state,
      saleState: 5,
      entitlementState: 5,
      liquidityState: 5,
      operationalState: 1,
    };
    await expect(adapter.getState(1n)).resolves.toMatchObject({
      value: {
        saleState: "CANCELLED",
        entitlementState: "REFUNDED",
        liquidityState: "RETRY_SCHEDULED",
        operationalState: "PAUSED",
      },
    });
    chain.state = { ...chain.state, saleState: 6 };
    await expect(adapter.getState(1n)).rejects.toMatchObject({
      reasonCode: "LAUNCH_CONTRACT_READ_INVALID",
    });
    chain.state = { ...chain.state, saleState: 0, operationalState: 2 };
    await expect(adapter.getState(1n)).rejects.toMatchObject({
      reasonCode: "LAUNCH_CONTRACT_READ_INVALID",
    });
  });

  it("reads rounds, configuration, quote, and positions with struct fields in 06 order", async () => {
    const chain = createMockLaunchpadChain();
    const { adapter } = adapterFor(chain);
    const snapshot = await adapter.takeSnapshot();
    const rounds = await adapter.getRounds(3n, snapshot);
    expect(rounds.value[0]).toEqual({
      roundId: 1,
      startAt: 1_790_000_000n,
      endAt: 1_790_172_800n,
      priceUsd1PerToken: 10n ** 16n,
      roundCapUsd1: 40_000n * 10n ** 18n,
      walletRoundCapUsd1: 500n * 10n ** 18n,
      allowlistRoot: mockAllowlistRoot,
      raisedUsd1: 1_234n * 10n ** 18n,
    });
    expect(Object.keys(rounds.value[0] ?? {})).toEqual([
      "roundId",
      "startAt",
      "endAt",
      "priceUsd1PerToken",
      "roundCapUsd1",
      "walletRoundCapUsd1",
      "allowlistRoot",
      "raisedUsd1",
    ]);
    const config = await adapter.getSaleConfig(3n, snapshot);
    expect(config.value).toMatchObject({
      projectToken: mockProjectTokenAddress,
      usd1: mockUsd1Address,
      protocolFeeBps: 300,
      poolFeeTier: 2_500,
      configVersion: mockConfigVersion,
    });
    const quote = await adapter.quote(
      { saleId: 3n, roundId: 1, usd1Amount: 10n },
      snapshot,
    );
    expect(quote.value).toBe(1_000n);
    const position = await adapter.getPosition(
      { saleId: 3n, wallet: "0x4444444444444444444444444444444444444444" },
      snapshot,
    );
    expect(Object.keys(position.value)).toEqual([
      "cumulativeUsd1",
      "purchasedTokens",
      "entitledTokens",
      "claimableTokens",
      "claimedTokens",
      "refundableUsd1",
      "refundedUsd1",
    ]);
    const roundPosition = await adapter.getRoundPosition(
      {
        saleId: 3n,
        roundId: 2,
        wallet: "0x4444444444444444444444444444444444444444",
      },
      snapshot,
    );
    expect(roundPosition.value).toBe(100n * 10n ** 18n);
    // Explicit snapshots are confirmed by the caller, once.
    await expect(adapter.confirmSnapshot(snapshot)).resolves.toBeUndefined();
    const callBlocks = chain.calls
      .filter((entry) => entry.method === "eth_call")
      .map((entry) => entry.params[1]);
    expect(new Set(callBlocks)).toEqual(
      new Set([`0x${mockBlockNumber.toString(16)}`]),
    );
  });

  it("fails closed on a reorged snapshot and on an endpoint failure", async () => {
    const reorged = createMockLaunchpadChain({
      reorgHash: `0x${"99".repeat(32)}`,
    });
    await expect(
      adapterFor(reorged).adapter.getState(1n),
    ).rejects.toMatchObject({ reasonCode: "LAUNCH_SNAPSHOT_REORGED" });
    const failing = createMockLaunchpadChain({ failCalls: true });
    const error: unknown = await adapterFor(failing)
      .adapter.getState(1n)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchContractUnavailableError);
    expect(error).toMatchObject({ reasonCode: "LAUNCH_CONTRACT_READ_FAILED" });
    expect(String((error as Error).message)).not.toContain("launch-rpc");
  });
});

describe("Launch contract calldata (06 §4.1)", () => {
  it("encodes buy with the 06 selector and parameter order", () => {
    const chain = createMockLaunchpadChain();
    const { adapter } = adapterFor(chain);
    const proof = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`];
    const call = adapter.encodeBuy({
      saleId: 9n,
      roundId: 2,
      usd1Amount: 25n * 10n ** 18n,
      minTokenAmount: 2_400n * 10n ** 18n,
      deadline: 1_790_000_600n,
      eligibilityProof: proof,
    });
    expect(call.to).toBe(mockLaunchpadAddress);
    expect(call.value).toBe(0n);
    expect(call.data.slice(0, 10)).toBe(
      toFunctionSelector(
        "buy(uint256,uint16,uint256,uint256,uint64,bytes32[])",
      ),
    );
    // Head words in 06 order: saleId, roundId, usd1Amount, minTokenAmount,
    // deadline, then the offset of the dynamic eligibilityProof array.
    const words = call.data
      .slice(10)
      .match(/.{64}/g)
      ?.map((word) => BigInt(`0x${word}`));
    expect(words?.slice(0, 6)).toEqual([
      9n,
      2n,
      25n * 10n ** 18n,
      2_400n * 10n ** 18n,
      1_790_000_600n,
      6n * 32n,
    ]);
    expect(words?.[6]).toBe(2n);
    expect(
      decodeFunctionData({ abi: launchpadAbiV1, data: call.data }).args,
    ).toEqual([
      9n,
      2,
      25n * 10n ** 18n,
      2_400n * 10n ** 18n,
      1_790_000_600n,
      proof,
    ]);
  });

  it("encodes claim and claimRefund and refuses out-of-range arguments", () => {
    const chain = createMockLaunchpadChain();
    const { adapter } = adapterFor(chain);
    expect(adapter.encodeClaim(9n).data).toBe(
      `${toFunctionSelector("claim(uint256)")}${9n.toString(16).padStart(64, "0")}`,
    );
    expect(adapter.encodeClaimRefund(9n).data).toBe(
      `${toFunctionSelector("claimRefund(uint256)")}${9n.toString(16).padStart(64, "0")}`,
    );
    const base = {
      saleId: 1n,
      roundId: 1,
      usd1Amount: 1n,
      minTokenAmount: 0n,
      deadline: 1n,
      eligibilityProof: [] as string[],
    };
    expect(() => encodeLaunchBuyCalldata({ ...base, roundId: 65_536 })).toThrow(
      RangeError,
    );
    expect(() =>
      encodeLaunchBuyCalldata({ ...base, deadline: 1n << 64n }),
    ).toThrow(RangeError);
    expect(() =>
      encodeLaunchBuyCalldata({ ...base, eligibilityProof: ["0x01"] }),
    ).toThrow(RangeError);
  });
});

describe("Launch contract events (06 §3)", () => {
  const wallet = "0x5555555555555555555555555555555555555555";
  const pool = "0x6666666666666666666666666666666666666666";
  const fixtures = [
    [
      "SaleStateChanged",
      { saleId: 4n, fromState: 0, toState: 1, at: 1_790_000_000n },
      { fromState: "SCHEDULED", toState: "LIVE", at: 1_790_000_000n },
    ],
    [
      "Purchased",
      {
        saleId: 4n,
        buyer: wallet,
        roundId: 1,
        usd1Amount: 10n,
        tokenAmount: 1_000n,
        walletCumulativeUsd1: 30n,
        purchaseIndex: 2n,
      },
      {
        buyer: wallet,
        roundId: 1,
        usd1Amount: 10n,
        tokenAmount: 1_000n,
        walletCumulativeUsd1: 30n,
        purchaseIndex: 2n,
      },
    ],
    [
      "SaleFinalized",
      { saleId: 4n, outcome: 3, totalRaisedUsd1: 5n, totalTokensSold: 6n },
      { outcome: "SUCCEEDED", totalRaisedUsd1: 5n, totalTokensSold: 6n },
    ],
    [
      "BudgetsFrozen",
      {
        saleId: 4n,
        usd1ToLiquidity: 1n,
        tokenToLiquidity: 2n,
        usd1ToProject: 3n,
        protocolFeeUsd1: 4n,
      },
      {
        usd1ToLiquidity: 1n,
        tokenToLiquidity: 2n,
        usd1ToProject: 3n,
        protocolFeeUsd1: 4n,
      },
    ],
    [
      "RefundLiabilityFrozen",
      { saleId: 4n, wallet, usd1Amount: 7n },
      { wallet, usd1Amount: 7n },
    ],
    [
      "Refunded",
      { saleId: 4n, wallet, usd1Amount: 7n, cumulativeRefunded: 7n },
      { wallet, usd1Amount: 7n, cumulativeRefunded: 7n },
    ],
    [
      "VestingScheduleCreated",
      {
        saleId: 4n,
        tgeBps: 2_500,
        cliffSeconds: 0,
        durationSeconds: 7_776_000,
        tgeAt: 1_790_500_000n,
      },
      {
        tgeBps: 2_500,
        cliffSeconds: 0,
        durationSeconds: 7_776_000,
        tgeAt: 1_790_500_000n,
      },
    ],
    [
      "Claimed",
      { saleId: 4n, wallet, tokenAmount: 8n, cumulativeClaimed: 9n },
      { wallet, tokenAmount: 8n, cumulativeClaimed: 9n },
    ],
    [
      "PoolPrepared",
      {
        saleId: 4n,
        pool,
        feeTier: 2_500,
        initialSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n,
        tickLower: -887_250,
        tickUpper: 887_250,
      },
      {
        pool,
        feeTier: 2_500,
        initialSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n,
        tickLower: -887_250,
        tickUpper: 887_250,
      },
    ],
    [
      "LiquidityAdded",
      { saleId: 4n, pool, lpTokenId: 11n, usd1Amount: 12n, tokenAmount: 13n },
      { pool, lpTokenId: 11n, usd1Amount: 12n, tokenAmount: 13n },
    ],
    [
      "LPNFTLocked",
      { saleId: 4n, locker: pool, lpTokenId: 11n, unlockAt: 1_822_000_000n },
      { locker: pool, lpTokenId: 11n, unlockAt: 1_822_000_000n },
    ],
    [
      "LiquidityRetryScheduled",
      {
        saleId: 4n,
        reasonCode: `0x${"0a".repeat(32)}`,
        retryAfter: 1_790_600_000n,
      },
      { reasonCode: `0x${"0a".repeat(32)}`, retryAfter: 1_790_600_000n },
    ],
    ["Paused", { saleId: 4n, by: wallet }, { by: wallet }],
    ["Unpaused", { saleId: 4n, by: wallet }, { by: wallet }],
  ] as const;

  it("names exactly the 14 events of 06 §3 with their 06 signatures", () => {
    const signatures = [
      "SaleStateChanged(uint256,uint8,uint8,uint64)",
      "Purchased(uint256,address,uint16,uint256,uint256,uint256,uint256)",
      "SaleFinalized(uint256,uint8,uint256,uint256)",
      "BudgetsFrozen(uint256,uint256,uint256,uint256,uint256)",
      "RefundLiabilityFrozen(uint256,address,uint256)",
      "Refunded(uint256,address,uint256,uint256)",
      "VestingScheduleCreated(uint256,uint16,uint32,uint32,uint64)",
      "Claimed(uint256,address,uint256,uint256)",
      "PoolPrepared(uint256,address,uint24,uint160,int24,int24)",
      "LiquidityAdded(uint256,address,uint256,uint256,uint256)",
      "LPNFTLocked(uint256,address,uint256,uint64)",
      "LiquidityRetryScheduled(uint256,bytes32,uint64)",
      "Paused(uint256,address)",
      "Unpaused(uint256,address)",
    ];
    expect(fixtures.map(([name]) => name)).toEqual(
      signatures.map((signature) => signature.split("(")[0]),
    );
    fixtures.forEach(([name, args], index) => {
      const log = encodeLaunchpadLog(name, args, index);
      expect(log.topics[0]).toBe(toEventSelector(signatures[index] as string));
      // saleId is the first indexed topic of every event.
      expect(BigInt(log.topics[1] as string)).toBe(4n);
    });
  });

  it("decodes all 14 events into a saleId-keyed discriminated union", () => {
    const chain = createMockLaunchpadChain();
    const { adapter } = adapterFor(chain);
    const logs = fixtures.map(([name, args], index) =>
      encodeLaunchpadLog(name, args, index),
    );
    const decoded = adapter.decodeEvents(logs);
    expect(decoded.unrecognized).toEqual([]);
    expect(decoded.events).toHaveLength(14);
    fixtures.forEach(([name, , expected], index) => {
      expect(decoded.events[index]).toEqual({
        saleId: 4n,
        address: mockLaunchpadAddress,
        blockNumber: mockBlockNumber,
        blockHash: mockBlockHash,
        transactionHash: `0x${"aa".repeat(32)}`,
        logIndex: index,
        removed: false,
        eventName: name,
        ...expected,
      });
    });
  });

  it("reports an unknown topic, refuses a malformed body, an invalid outcome, and a foreign address", () => {
    const chain = createMockLaunchpadChain();
    const { adapter } = adapterFor(chain);
    const ownership = {
      ...encodeLaunchpadLog("Paused", { saleId: 1n, by: wallet }),
      topics: [
        toEventSelector("OwnershipTransferred(address,address)"),
        `0x${"00".repeat(32)}`,
        `0x${"00".repeat(32)}`,
      ],
      data: "0x",
    };
    expect(adapter.decodeEvents([ownership])).toEqual({
      events: [],
      unrecognized: [
        {
          transactionHash: `0x${"aa".repeat(32)}`,
          logIndex: 0,
          topic0: toEventSelector("OwnershipTransferred(address,address)"),
        },
      ],
    });
    const truncated = {
      ...encodeLaunchpadLog("Claimed", {
        saleId: 1n,
        wallet,
        tokenAmount: 1n,
        cumulativeClaimed: 1n,
      }),
      data: "0x01",
    };
    expect(() => decodeLaunchpadLogs([truncated])).toThrow(
      LaunchContractUnavailableError,
    );
    const liveOutcome = encodeLaunchpadLog("SaleFinalized", {
      saleId: 1n,
      outcome: 1,
      totalRaisedUsd1: 0n,
      totalTokensSold: 0n,
    });
    expect(() => decodeLaunchpadLogs([liveOutcome])).toThrow(
      LaunchContractUnavailableError,
    );
    expect(() =>
      adapter.decodeEvents([
        {
          ...encodeLaunchpadLog("Paused", { saleId: 1n, by: wallet }),
          address: "0x7777777777777777777777777777777777777777",
        },
      ]),
    ).toThrow(LaunchContractUnavailableError);
  });
});
