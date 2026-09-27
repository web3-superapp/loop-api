import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import {
  createLaunchService,
  type LaunchService,
} from "../src/features/launch/launch-service.js";
import { launchpadAbiV1 } from "../src/integrations/launch/launchpad-abi.v1.js";
import {
  createFakeLaunchAdapter,
  createFakeLaunchChainState,
  createFakeLaunchSlotClient,
  fakeLaunchContract,
  fakeNowSeconds,
  fakeProjectToken,
  type FakeLaunchChainState,
  type FakeLaunchSlotFunds,
} from "./helpers/launch-fake-adapter.js";
import { fixtureBlockHash, oneUsd1 } from "./helpers/launch-lane-fixtures.js";
import {
  accountId,
  chainRepositoryFake,
  launchId,
  launchRepositoryFor,
  registeredDetail,
  roundOneId,
  walletAddress,
  walletId,
  walletsFake,
  writesConfig,
} from "./helpers/launch-service-fakes.js";

/**
 * Decision 0087: `claim` / `claimRefund` Intents on the purchase Intent
 * route. Admission reads the 0085 sale snapshot plus `getPosition` at the
 * same block; each refusal names its rule. All chain values are fixtures.
 */

const principal = Object.freeze({
  userId: accountId,
  privyUserId: "did:privy:verified-user",
}) as never;
const other = "0x00000000000000000000000000000000000000bb";
const base = createFakeLaunchChainState();

/** A SUCCEEDED sale whose vesting is open and whose wallet can claim. */
const vesting: Partial<FakeLaunchChainState> = {
  tuple: {
    ...base.tuple,
    saleState: "SUCCEEDED",
    entitlementState: "VESTING",
    liquidityState: "LP_LOCKED",
  },
  position: {
    ...base.position,
    entitledTokens: 10_000n * oneUsd1,
    claimableTokens: 2_500n * oneUsd1,
    claimedTokens: 0n,
  },
};

/** A FAILED sale in its refund window with a frozen refund. */
const refunding: Partial<FakeLaunchChainState> = {
  tuple: {
    ...base.tuple,
    saleState: "FAILED",
    entitlementState: "REFUNDING",
  },
  position: {
    ...base.position,
    refundableUsd1: 100n * oneUsd1,
    refundedUsd1: 0n,
  },
};

interface Scenario {
  readonly chainState?: Partial<FakeLaunchChainState>;
  readonly funds?: Partial<FakeLaunchSlotFunds>;
  readonly writes?: Parameters<typeof writesConfig>[0] | null;
}

function setup(scenario: Scenario = {}) {
  const state = createFakeLaunchChainState(scenario.chainState);
  const chain = chainRepositoryFake();
  const service: LaunchService = createLaunchService({
    repository: launchRepositoryFor(registeredDetail()),
    cursorCodec: null,
    contract: createFakeLaunchAdapter(state),
    chain,
    wallets: walletsFake(),
    now: () => new Date(Number(fakeNowSeconds) * 1000),
    intentRuntime: {
      writes:
        scenario.writes === null ? null : writesConfig(scenario.writes ?? {}),
      readClient: createFakeLaunchSlotClient({
        usd1Balance: 0n,
        allowance: 0n,
        nativeBalance: 10n ** 17n,
        simulation: "passed",
        ...scenario.funds,
      }),
      wallets: walletsFake(),
      // A claim or refund never reads the daily exposure (nothing is paid).
      walletIntentExposureUsd: () =>
        Promise.reject(new Error("exposure must not be read")),
      now: () => new Date(Number(fakeNowSeconds) * 1000),
      createUuid: () => "7a2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    },
  });
  return { service, chain, state };
}

function prepare(
  service: LaunchService,
  body: Record<string, unknown>,
  key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba",
) {
  return service.prepareIntent({
    principal,
    launchId,
    body,
    idempotencyKey: key,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
}

async function refusal(promise: Promise<unknown>): Promise<{
  code: string;
  reasonCode: unknown;
  details: unknown;
}> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof V2ApiError) {
      return {
        code: error.code,
        reasonCode: error.detailsSafe?.["reasonCode"] ?? null,
        details: error.detailsSafe,
      };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

/** Every key of a pre-0087 purchase Intent (S83b/S83b2/S83b3 shape). */
const buyKeys = [
  "chainId",
  "configVersion",
  "contractAddress",
  "createdAt",
  "deadline",
  "eligibilityProof",
  "expectedTokenAmount",
  "expiresAt",
  "launchId",
  "launchIntentId",
  "minTokenAmount",
  "payloadDigest",
  "policy",
  "projectAssetId",
  "projectId",
  "quoteAssetId",
  "roundId",
  "roundIndex",
  "saleId",
  "signing",
  "simulation",
  "snapshotBlockHash",
  "snapshotBlockNumber",
  "state",
  "stateTupleDigest",
  "transactionHash",
  "unsignedTransaction",
  "usd1Amount",
  "walletCumulativeUsd1",
  "walletId",
  "walletProjectCapUsd1",
  "walletRoundCapUsd1",
];

describe("Launch claim / claimRefund Intent prepare (Decision 0087)", () => {
  it("prepares claim(saleId) from the sale snapshot and getPosition at one block", async () => {
    const { service, state, chain } = setup({ chainState: vesting });
    const { created, resource } = await prepare(service, {
      kind: "claim",
      walletId,
    });
    expect(created).toBe(true);
    const intent = resource.launchIntent;
    expect(intent).toEqual({
      launchIntentId: "7a2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      kind: "claim",
      state: "awaiting_signature",
      launchId,
      projectId: registeredDetail().launch.projectId,
      walletId,
      roundId: null,
      roundIndex: null,
      chainId: "eip155:97",
      contractAddress: fakeLaunchContract.address,
      quoteAssetId: `eip155:97:${fakeLaunchContract.usd1Address}`,
      usd1Amount: "0",
      expectedTokenAmount: (2_500n * oneUsd1).toString(),
      minTokenAmount: "0",
      walletCumulativeUsd1: (100n * oneUsd1).toString(),
      deadline: new Date(Number(fakeNowSeconds + 120n) * 1000).toISOString(),
      eligibilityProof: [],
      configVersion: state.tuple.configVersion,
      stateTupleDigest: state.tuple.stateTupleDigest,
      snapshotBlockNumber: "900",
      snapshotBlockHash: fixtureBlockHash(900n),
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      unsignedTransaction: {
        chainId: 97,
        to: fakeLaunchContract.address,
        data: expect.any(String) as unknown,
        value: "0x0",
        from: walletAddress,
        gas: "0x1d4c0",
        nonce: "0x3",
        type: "legacy",
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        gasPrice: "0x3b9aca00",
      },
      expiresAt: new Date(Number(fakeNowSeconds + 120n) * 1000).toISOString(),
      createdAt: "2026-09-08T01:00:00.000Z",
      projectAssetId: `eip155:97:${fakeProjectToken}`,
      saleId: "7",
      claimableTokens: (2_500n * oneUsd1).toString(),
      transactionHash: null,
      simulation: { status: "passed", reasonCode: null },
      policy: {
        configVersion: "bscWriteCanaryV1",
        canaryMaxUsd: "50",
        valueUsd: "0",
        priceSource: "usd1_par",
      },
      signing: {
        mode: "device_eth_send_transaction",
        allowed: true,
        reasonCode: null,
      },
    });
    const tx = intent["unsignedTransaction"] as Record<string, unknown>;
    const decoded = decodeFunctionData({
      abi: launchpadAbiV1,
      data: tx["data"] as Hex,
    });
    expect(decoded.functionName).toBe("claim");
    expect(decoded.args).toEqual([7n]);
    // One sale snapshot + one getPosition; no separate getState/getRounds.
    expect(state.calls).toEqual(["readSaleSnapshot", "getPosition"]);
    expect([...chain.intents.values()][0]?.record).toMatchObject({
      kind: "claim",
      roundId: null,
      roundIndex: null,
      payAmountRaw: "0",
      expectedReceiveRaw: (2_500n * oneUsd1).toString(),
    });
  });

  it("prepares claimRefund(saleId) for a FAILED or CANCELLED sale in REFUNDING", async () => {
    for (const saleState of ["FAILED", "CANCELLED"] as const) {
      const { service } = setup({
        chainState: {
          ...refunding,
          tuple: { ...refunding.tuple!, saleState },
        },
      });
      const { resource } = await prepare(service, {
        kind: "claimRefund",
        walletId,
      });
      const intent = resource.launchIntent;
      expect(intent).toMatchObject({
        kind: "claimRefund",
        state: "awaiting_signature",
        roundId: null,
        roundIndex: null,
        usd1Amount: "0",
        expectedTokenAmount: "0",
        minTokenAmount: "0",
        refundableUsd1: (100n * oneUsd1).toString(),
        policy: { valueUsd: "0" },
        signing: { allowed: true },
      });
      expect(intent).not.toHaveProperty("claimableTokens");
      expect(intent).not.toHaveProperty("walletRoundCapUsd1");
      const decoded = decodeFunctionData({
        abi: launchpadAbiV1,
        data: (intent["unsignedTransaction"] as Record<string, unknown>)[
          "data"
        ] as Hex,
      });
      expect(decoded.functionName).toBe("claimRefund");
      expect(decoded.args).toEqual([7n]);
    }
  });

  const claimCases: readonly {
    readonly name: string;
    readonly chainState: Partial<FakeLaunchChainState>;
    readonly reasonCode: string;
    readonly details?: Record<string, unknown>;
  }[] = [
    {
      name: "entitlement FROZEN (before TGE / pool)",
      chainState: {
        ...vesting,
        tuple: { ...vesting.tuple!, entitlementState: "FROZEN" },
      },
      reasonCode: "LAUNCH_CLAIM_NOT_OPEN",
      details: { entitlementState: "FROZEN" },
    },
    {
      name: "sale still LIVE (entitlement NONE)",
      chainState: { position: vesting.position! },
      reasonCode: "LAUNCH_CLAIM_NOT_OPEN",
      details: { entitlementState: "NONE" },
    },
    {
      name: "entitlement COMPLETED (06 §4.1 claim needs VESTING)",
      chainState: {
        ...vesting,
        tuple: { ...vesting.tuple!, entitlementState: "COMPLETED" },
      },
      reasonCode: "LAUNCH_CLAIM_NOT_OPEN",
      details: { entitlementState: "COMPLETED" },
    },
    {
      name: "paused",
      chainState: {
        ...vesting,
        tuple: { ...vesting.tuple!, operationalState: "PAUSED" },
      },
      reasonCode: "LAUNCH_SALE_PAUSED",
    },
    {
      name: "never bought",
      chainState: {
        ...vesting,
        position: {
          cumulativeUsd1: 0n,
          purchasedTokens: 0n,
          entitledTokens: 0n,
          claimableTokens: 0n,
          claimedTokens: 0n,
          refundableUsd1: 0n,
          refundedUsd1: 0n,
        },
      },
      reasonCode: "LAUNCH_NOT_PARTICIPANT",
    },
    {
      name: "nothing matured yet",
      chainState: {
        ...vesting,
        position: { ...vesting.position!, claimableTokens: 0n },
      },
      reasonCode: "LAUNCH_NOTHING_TO_CLAIM",
    },
    {
      name: "already claimed everything",
      chainState: {
        ...vesting,
        position: {
          ...vesting.position!,
          claimableTokens: 0n,
          claimedTokens: 10_000n * oneUsd1,
        },
      },
      reasonCode: "LAUNCH_NOTHING_TO_CLAIM",
    },
  ];
  for (const scenario of claimCases) {
    it(`refuses claim with 409: ${scenario.name}`, async () => {
      const { service, chain } = setup({ chainState: scenario.chainState });
      const result = await refusal(
        prepare(service, { kind: "claim", walletId }),
      );
      expect(result.code).toBe("DATA_STALE");
      expect(result.reasonCode).toBe(scenario.reasonCode);
      if (scenario.details !== undefined) {
        expect(result.details).toMatchObject(scenario.details);
      }
      expect([...chain.intents.values()]).toEqual([]);
    });
  }

  const refundCases: readonly {
    readonly name: string;
    readonly chainState: Partial<FakeLaunchChainState>;
    readonly reasonCode: string;
    readonly details?: Record<string, unknown>;
  }[] = [
    {
      name: "sale LIVE",
      chainState: { position: refunding.position! },
      reasonCode: "LAUNCH_REFUND_NOT_OPEN",
      details: { saleState: "LIVE", entitlementState: "NONE" },
    },
    {
      name: "sale SUCCEEDED",
      chainState: {
        ...refunding,
        tuple: {
          ...refunding.tuple!,
          saleState: "SUCCEEDED",
          entitlementState: "VESTING",
        },
      },
      reasonCode: "LAUNCH_REFUND_NOT_OPEN",
      details: { saleState: "SUCCEEDED" },
    },
    {
      name: "refund window closed (REFUNDED)",
      chainState: {
        ...refunding,
        tuple: { ...refunding.tuple!, entitlementState: "REFUNDED" },
      },
      reasonCode: "LAUNCH_REFUND_NOT_OPEN",
      details: { saleState: "FAILED", entitlementState: "REFUNDED" },
    },
    {
      name: "paused",
      chainState: {
        ...refunding,
        tuple: { ...refunding.tuple!, operationalState: "PAUSED" },
      },
      reasonCode: "LAUNCH_SALE_PAUSED",
    },
    {
      name: "never bought",
      chainState: {
        ...refunding,
        position: {
          cumulativeUsd1: 0n,
          purchasedTokens: 0n,
          entitledTokens: 0n,
          claimableTokens: 0n,
          claimedTokens: 0n,
          refundableUsd1: 0n,
          refundedUsd1: 0n,
        },
      },
      reasonCode: "LAUNCH_NOT_PARTICIPANT",
    },
    {
      name: "already refunded",
      chainState: {
        ...refunding,
        position: {
          ...refunding.position!,
          refundableUsd1: 0n,
          refundedUsd1: 100n * oneUsd1,
        },
      },
      reasonCode: "LAUNCH_NOTHING_TO_REFUND",
    },
  ];
  for (const scenario of refundCases) {
    it(`refuses claimRefund with 409: ${scenario.name}`, async () => {
      const { service, chain } = setup({ chainState: scenario.chainState });
      const result = await refusal(
        prepare(service, { kind: "claimRefund", walletId }),
      );
      expect(result.code).toBe("DATA_STALE");
      expect(result.reasonCode).toBe(scenario.reasonCode);
      if (scenario.details !== undefined) {
        expect(result.details).toMatchObject(scenario.details);
      }
      expect([...chain.intents.values()]).toEqual([]);
    });
  }

  it("keeps the shared refusals: config drift, gas, counterparty, unreadable chain, unknown sale", async () => {
    const drift = setup({
      chainState: {
        ...vesting,
        config: { ...base.config, configVersion: `0x${"ee".repeat(32)}` },
      },
    });
    expect(
      await refusal(prepare(drift.service, { kind: "claim", walletId })),
    ).toMatchObject({
      code: "DATA_STALE",
      reasonCode: "LAUNCH_CONFIG_VERSION_MISMATCH",
    });
    const gas = setup({ chainState: vesting, funds: { nativeBalance: 1n } });
    expect(
      await refusal(prepare(gas.service, { kind: "claim", walletId })),
    ).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      reasonCode: "LAUNCH_GAS_INSUFFICIENT",
    });
    const counterparty = setup({
      chainState: refunding,
      writes: { canaryCounterpartyAddresses: [other] },
    });
    expect(
      await refusal(
        prepare(counterparty.service, { kind: "claimRefund", walletId }),
      ),
    ).toMatchObject({
      code: "POLICY_BLOCKED",
      reasonCode: "COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST",
    });
    const down = setup({
      chainState: { ...vesting, unavailable: "LAUNCH_CONTRACT_READ_FAILED" },
    });
    expect(
      await refusal(prepare(down.service, { kind: "claim", walletId })),
    ).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "LAUNCH_CONTRACT_READ_FAILED",
    });
    const unknown = setup({
      chainState: {
        ...vesting,
        tuple: { ...vesting.tuple!, configVersion: `0x${"00".repeat(32)}` },
      },
    });
    expect(
      await refusal(prepare(unknown.service, { kind: "claim", walletId })),
    ).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "LAUNCH_SALE_NOT_FOUND",
    });
  });

  it("does not require the claimed asset in the canary asset allowlist (nothing is paid)", async () => {
    const { service } = setup({
      chainState: vesting,
      writes: { canaryAssetIds: [], canaryDailyMaxUsd: "0" },
    });
    const { resource } = await prepare(service, { kind: "claim", walletId });
    expect(resource.launchIntent["state"]).toBe("awaiting_signature");
  });

  it("keeps a reverted simulation unsignable instead of refusing", async () => {
    const { service } = setup({
      chainState: refunding,
      funds: { simulation: "reverted" },
    });
    const { resource } = await prepare(service, {
      kind: "claimRefund",
      walletId,
    });
    expect(resource.launchIntent).toMatchObject({
      kind: "claimRefund",
      state: "prepared",
      signing: { allowed: false, reasonCode: "LAUNCH_SIMULATION_REVERTED" },
    });
  });

  it("replays the same key and kind, and a different kind under the key is IDEMPOTENCY_CONFLICT", async () => {
    const { service, chain } = setup({ chainState: vesting });
    const first = await prepare(service, { kind: "claim", walletId });
    const replay = await prepare(service, { kind: "claim", walletId });
    expect(replay.created).toBe(false);
    expect(replay.resource).toEqual(first.resource);
    expect(chain.builds).toBe(1);
    expect(
      await refusal(prepare(service, { kind: "claimRefund", walletId })),
    ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await refusal(
        prepare(service, { walletId, roundId: roundOneId, payAmount: "10" }),
      ),
    ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a malformed body: unknown kind, round or amount on a claim, missing wallet", async () => {
    const { service } = setup({ chainState: vesting });
    for (const body of [
      { kind: "sell", walletId },
      { kind: "claim", walletId, roundId: roundOneId },
      { kind: "claimRefund", walletId, payAmount: "1" },
      { kind: "claim" },
      { kind: null, walletId },
    ]) {
      expect(await refusal(prepare(service, body))).toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
  });

  it("stays the bare CAPABILITY_UNAVAILABLE without BSC_WRITES_ENABLED", async () => {
    const { service } = setup({ chainState: vesting, writes: null });
    await expect(
      prepare(service, { kind: "claim", walletId }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: null,
    });
  });

  it("reports and reads a claim Intent through the shared report / read paths", async () => {
    const { service } = setup({ chainState: vesting });
    const { resource } = await prepare(service, { kind: "claim", walletId });
    const id = resource.launchIntent["launchIntentId"] as string;
    const txHash = `0x${"77".repeat(32)}`;
    const reported = await service.reportIntent({
      principal,
      launchId,
      launchIntentId: id,
      body: { txHash },
    });
    expect(reported.launchIntent).toMatchObject({
      kind: "claim",
      state: "submitted",
      transactionHash: txHash,
      signing: { allowed: false, reasonCode: "LAUNCH_INTENT_ALREADY_REPORTED" },
    });
    const read = await service.getIntent({
      principal,
      launchId,
      launchIntentId: id,
    });
    expect(read).toEqual(reported);
  });
});

describe("purchase Intent bytes are unchanged by Decision 0087", () => {
  it("a body without kind is a purchase whose launchIntent has exactly the pre-0087 keys", async () => {
    // A purchase reads the daily exposure, so it gets its own runtime.
    const buyService = createLaunchService({
      repository: launchRepositoryFor(registeredDetail()),
      cursorCodec: null,
      contract: createFakeLaunchAdapter(createFakeLaunchChainState()),
      chain: chainRepositoryFake(),
      wallets: walletsFake(),
      now: () => new Date(Number(fakeNowSeconds) * 1000),
      intentRuntime: {
        writes: writesConfig(),
        readClient: createFakeLaunchSlotClient({
          usd1Balance: 1_000n * oneUsd1,
          allowance: 1_000n * oneUsd1,
          nativeBalance: 10n ** 17n,
          simulation: "passed",
        }),
        wallets: walletsFake(),
        walletIntentExposureUsd: () => Promise.resolve("0"),
        now: () => new Date(Number(fakeNowSeconds) * 1000),
        createUuid: () => "7a2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      },
    });
    const legacy = await prepare(buyService, {
      walletId,
      roundId: roundOneId,
      payAmount: "10",
    });
    expect(Object.keys(legacy.resource.launchIntent).sort()).toEqual(buyKeys);
    expect(JSON.stringify(legacy.resource)).not.toContain('"kind"');
    // An explicit kind "buy" is the same request (same digest): a replay.
    const explicit = await prepare(buyService, {
      kind: "buy",
      walletId,
      roundId: roundOneId,
      payAmount: "10",
    });
    expect(explicit.created).toBe(false);
    expect(JSON.stringify(explicit.resource)).toBe(
      JSON.stringify(legacy.resource),
    );
  });
});
