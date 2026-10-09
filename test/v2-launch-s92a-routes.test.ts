import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { LaunchChainRepository } from "../src/features/launch/launch-chain-repository.js";
import {
  createFakeLaunchAdapter,
  createFakeLaunchChainState,
  createFakeLaunchSlotClient,
  fakeLaunchContract,
  fakeNowSeconds,
  fakeProjectToken,
  type FakeLaunchChainState,
} from "./helpers/launch-fake-adapter.js";
import { fixtureBlockHash, oneUsd1 } from "./helpers/launch-lane-fixtures.js";
import {
  chainRepositoryFake,
  launchId,
  launchRepositoryFor,
  registeredDetail,
  roundOneId,
  walletId,
  walletsFake,
} from "./helpers/launch-service-fakes.js";
import {
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0087 route contract: `kind` on the Intent route through the real
 * Fastify schemas (Ajv on the body, fast-json-stringify on the 201, which
 * drops any property the schema does not declare), the seven-field 409, the
 * history `settlements`, and the holders `myPosition` settlement fields.
 */

const contractEnv = {
  LAUNCH_CHAIN_ID: "97",
  LAUNCH_CONTRACT_ADDRESS: fakeLaunchContract.address,
  LAUNCH_CONTRACT_VERSION: "1.0.0",
  LAUNCH_CONTRACT_START_BLOCK: "100",
  LAUNCH_USD1_ADDRESS: fakeLaunchContract.usd1Address,
};
const writesEnv = {
  BSC_WRITES_ENABLED: "true",
  BSC_RPC_URLS: "https://bsc-rpc.invalid/",
  BSC_WRITE_CANARY_ASSETS: `eip155:97:${fakeLaunchContract.usd1Address}`,
  BSC_WRITE_CANARY_MAX_USD: "50",
};
const base = createFakeLaunchChainState();
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];

describe("V2 launch claim / claimRefund Intents (Decision 0087)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly state?: Partial<FakeLaunchChainState>;
      readonly chain?: LaunchChainRepository;
    } = {},
  ) {
    const app = await buildApp({
      config: s7TestConfig({ ...contractEnv, ...writesEnv, ...options.env }),
      contractSurface: "v2",
      database: {
        ...s7Database({ launch: launchRepositoryFor(registeredDetail()) }),
        launchChain: options.chain ?? chainRepositoryFake(),
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launchContractAdapter: createFakeLaunchAdapter(
        createFakeLaunchChainState(options.state),
      ),
      launchChainReadClient: createFakeLaunchSlotClient({
        usd1Balance: 1_000n * oneUsd1,
        allowance: 1_000n * oneUsd1,
        nativeBalance: 10n ** 17n,
        simulation: "passed",
      }),
      walletIntentNow: () => new Date(Number(fakeNowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  const post = (
    app: FastifyInstance,
    payload: Record<string, unknown>,
    key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba",
  ) =>
    app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders({ "idempotency-key": key }),
      payload,
    });

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
      claimedTokens: 1_000n * oneUsd1,
    },
  };
  const refunding: Partial<FakeLaunchChainState> = {
    tuple: {
      ...base.tuple,
      saleState: "CANCELLED",
      entitlementState: "REFUNDING",
    },
    position: {
      ...base.position,
      refundableUsd1: 60n * oneUsd1,
      refundedUsd1: 40n * oneUsd1,
    },
  };

  it("prepares a claim with 201: kind, null round, claim(saleId), claimableTokens", async () => {
    const app = await createApp({ state: vesting });
    const response = await post(app, { kind: "claim", walletId });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ launchIntent: Record<string, unknown> }>();
    expect(body).toMatchObject({
      launchIntent: {
        kind: "claim",
        state: "awaiting_signature",
        roundId: null,
        roundIndex: null,
        usd1Amount: "0",
        expectedTokenAmount: (2_500n * oneUsd1).toString(),
        claimableTokens: (2_500n * oneUsd1).toString(),
        saleId: "7",
        projectAssetId: `eip155:97:${fakeProjectToken}`,
        unsignedTransaction: {
          chainId: 97,
          to: fakeLaunchContract.address,
          // claim(uint256) selector + saleId 7.
          data: `0x379607f5${"7".padStart(64, "0")}`,
          value: "0x0",
        },
        policy: { valueUsd: "0" },
        signing: { allowed: true, reasonCode: null },
      },
      contractVersion: "2.0",
    });
    const launchIntentId = body.launchIntent["launchIntentId"] as string;
    const read = await app.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/intents/${launchIntentId}`,
      headers: s7CommonHeaders(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe(response.body);
    const reported = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents/${launchIntentId}/broadcast-report`,
      headers: s7CommandHeaders({
        "idempotency-key": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
      payload: { txHash: `0x${"AB".repeat(32)}` },
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({
      launchIntent: {
        kind: "claim",
        state: "submitted",
        transactionHash: `0x${"ab".repeat(32)}`,
      },
    });
  });

  it("prepares a claimRefund with 201: kind, claimRefund(saleId), refundableUsd1", async () => {
    const app = await createApp({ state: refunding });
    const response = await post(app, { kind: "claimRefund", walletId });
    expect(response.statusCode).toBe(201);
    const intent = response.json<{ launchIntent: Record<string, unknown> }>()
      .launchIntent;
    expect(intent).toMatchObject({
      kind: "claimRefund",
      roundId: null,
      roundIndex: null,
      usd1Amount: "0",
      expectedTokenAmount: "0",
      refundableUsd1: (60n * oneUsd1).toString(),
      unsignedTransaction: {
        // claimRefund(uint256) selector + saleId 7.
        data: `0x5b7baf64${"7".padStart(64, "0")}`,
      },
    });
    expect(intent).not.toHaveProperty("claimableTokens");
  });

  it("answers each refusal as a seven-field 409 DATA_STALE with its reason code", async () => {
    const cases: readonly [
      Record<string, unknown>,
      Partial<FakeLaunchChainState>,
      string,
    ][] = [
      [{ kind: "claim", walletId }, {}, "LAUNCH_CLAIM_NOT_OPEN"],
      [
        { kind: "claim", walletId },
        {
          ...vesting,
          tuple: { ...vesting.tuple!, operationalState: "PAUSED" },
        },
        "LAUNCH_SALE_PAUSED",
      ],
      [
        { kind: "claim", walletId },
        {
          ...vesting,
          position: { ...vesting.position!, claimableTokens: 0n },
        },
        "LAUNCH_NOTHING_TO_CLAIM",
      ],
      [
        { kind: "claim", walletId },
        {
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
        "LAUNCH_NOT_PARTICIPANT",
      ],
      [{ kind: "claimRefund", walletId }, vesting, "LAUNCH_REFUND_NOT_OPEN"],
      [
        { kind: "claimRefund", walletId },
        {
          ...refunding,
          tuple: { ...refunding.tuple!, operationalState: "PAUSED" },
        },
        "LAUNCH_SALE_PAUSED",
      ],
      [
        { kind: "claimRefund", walletId },
        {
          ...refunding,
          position: { ...refunding.position!, refundableUsd1: 0n },
        },
        "LAUNCH_NOTHING_TO_REFUND",
      ],
      [
        { kind: "claimRefund", walletId },
        {
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
        "LAUNCH_NOT_PARTICIPANT",
      ],
    ];
    for (const [payload, state, reasonCode] of cases) {
      const app = await createApp({ state });
      const response = await post(app, payload);
      expect(response.statusCode, reasonCode).toBe(409);
      const body = response.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(errorKeys);
      expect(body).toMatchObject({
        code: "DATA_STALE",
        detailsSafe: { reasonCode },
      });
    }
  });

  it("refuses malformed bodies with 400 and keeps the bare 503 while writes are off", async () => {
    const app = await createApp({ state: vesting });
    for (const payload of [
      { kind: "claim", walletId, payAmount: "1" },
      { kind: "claimRefund", walletId, roundId: roundOneId },
      { kind: "claim" },
      { kind: "redeem", walletId },
      { kind: "buy", walletId },
    ]) {
      const response = await post(app, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    const off = await createApp({
      state: vesting,
      env: { BSC_WRITES_ENABLED: "false" },
    });
    const closed = await post(off, { kind: "claim", walletId });
    expect(closed.statusCode).toBe(503);
    expect(closed.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: null,
    });
  });

  it("a legacy purchase body still answers 201 without a kind key", async () => {
    const app = await createApp();
    const response = await post(app, {
      walletId,
      roundId: roundOneId,
      payAmount: "10",
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('"kind"');
    expect(response.json()).toMatchObject({
      launchIntent: {
        roundId: roundOneId,
        roundIndex: 1,
        usd1Amount: (10n * oneUsd1).toString(),
      },
    });
  });

  it("history lists Claimed / Refunded events under settlements with their own kind", async () => {
    const chain = chainRepositoryFake();
    const settlements = [
      {
        settlementRecordId: "6b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
        kind: "claimed" as const,
        walletId,
        assetId: `eip155:97:${fakeProjectToken}`,
        amount: (2_500n * oneUsd1).toString(),
        cumulativeAmount: (2_500n * oneUsd1).toString(),
        transactionHash: `0x${"c1".repeat(32)}`,
        logIndex: 1,
        blockNumber: "945",
        blockHash: fixtureBlockHash(945n),
        confirmationState: "confirmed" as const,
        observedAt: "2026-09-08T01:00:00.000Z",
      },
      {
        settlementRecordId: "7b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
        kind: "refunded" as const,
        walletId,
        assetId: `eip155:97:${fakeLaunchContract.usd1Address}`,
        amount: (100n * oneUsd1).toString(),
        cumulativeAmount: (100n * oneUsd1).toString(),
        transactionHash: `0x${"c2".repeat(32)}`,
        logIndex: 0,
        blockNumber: "944",
        blockHash: fixtureBlockHash(944n),
        confirmationState: "pending" as const,
        observedAt: "2026-09-08T01:00:00.000Z",
      },
    ];
    const withSettlements: LaunchChainRepository = {
      ...chain,
      listHistory: async (input) => ({
        ...(await chain.listHistory(input)),
        settlements,
      }),
    };
    const app = await createApp({ chain: withSettlements });
    const response = await app.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/history`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settlements,
      source: { status: "available" },
    });
    const unindexed = await createApp({
      chain: chainRepositoryFake({ checkpoint: null }),
    });
    const unavailable = await unindexed.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/history`,
      headers: s7CommonHeaders(),
    });
    // The unavailable branch keeps its pre-0087 bytes: no settlements key.
    expect(unavailable.json()).not.toHaveProperty("settlements");
    expect(unavailable.json()).toMatchObject({
      source: {
        status: "unavailable",
        reasonCode: "LAUNCH_ONCHAIN_STATE_NOT_INDEXED",
      },
    });
  });

  it("holders myPosition carries the four claim / refund amounts from getPosition", async () => {
    const app = await createApp({
      state: {
        position: {
          ...base.position,
          claimableTokens: 2_500n * oneUsd1,
          claimedTokens: 1_000n * oneUsd1,
          refundableUsd1: 60n * oneUsd1,
          refundedUsd1: 40n * oneUsd1,
        },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/v2/launch/${launchId}/holders`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      myPosition: {
        status: "available",
        claimableTokens: (2_500n * oneUsd1).toString(),
        claimedTokens: (1_000n * oneUsd1).toString(),
        refundableUsd1: (60n * oneUsd1).toString(),
        refundedUsd1: (40n * oneUsd1).toString(),
      },
    });
  });
});
