import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { LaunchChainRepository } from "../src/features/launch/launch-chain-repository.js";
import { buildLaunchMerkleTree } from "../src/features/launch/launch-merkle.js";
import type { LaunchDetailRecord } from "../src/features/launch/launch-repository.js";
import {
  createFakeLaunchAdapter,
  createFakeLaunchChainState,
  createFakeLaunchSlotClient,
  fakeLaunchContract,
  fakeNowSeconds,
  type FakeLaunchChainState,
} from "./helpers/launch-fake-adapter.js";
import { fixtureBlockHash, oneUsd1 } from "./helpers/launch-lane-fixtures.js";
import {
  chainRepositoryFake,
  launchId,
  launchRepositoryFor,
  registeredDetail,
  roundOneId,
  walletAddress,
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
 * Decision 0077 route contract: the `available` branches of overview,
 * holders, history, eligibility, and economy, and the Intent `201`, through
 * the real Fastify schemas (fast-json-stringify refuses a missing required
 * field). Fixtures only; no network.
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

describe("V2 launch routes with the launch_event lane and Intent (Decision 0077)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly state?: FakeLaunchChainState;
      readonly chain?: LaunchChainRepository;
      readonly detail?: LaunchDetailRecord;
    } = {},
  ) {
    const state = options.state ?? createFakeLaunchChainState();
    const app = await buildApp({
      config: s7TestConfig({ ...contractEnv, ...options.env }),
      contractSurface: "v2",
      database: {
        ...s7Database({
          launch: launchRepositoryFor(options.detail ?? registeredDetail()),
        }),
        launchChain: options.chain ?? chainRepositoryFake(),
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launchContractAdapter: createFakeLaunchAdapter(state),
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

  const get = async (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });

  it("overview publishes the lane's projection (source chain) and NOT_INDEXED without a checkpoint", async () => {
    const app = await createApp();
    const response = await get(app, "/v2/launch/overview");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      segments: {
        live: [
          {
            contractAddress: fakeLaunchContract.address,
            onChainState: {
              saleState: "LIVE",
              stateTupleDigest: `0x${"cd".repeat(32)}`,
              snapshotBlockNumber: "950",
              snapshotBlockHash: fixtureBlockHash(950n),
              configVersion: `0x${"ab".repeat(32)}`,
              source: "chain",
              reasonCode: null,
            },
          },
        ],
      },
    });
    const unindexed = await createApp({
      chain: chainRepositoryFake({ checkpoint: null }),
    });
    expect((await get(unindexed, "/v2/launch/overview")).json()).toMatchObject({
      segments: {
        live: [
          {
            onChainState: {
              source: "unavailable",
              reasonCode: "LAUNCH_ONCHAIN_STATE_NOT_INDEXED",
            },
          },
        ],
      },
    });
  });

  describe("overview segments follow the sale axis of a projected sale (S83b7)", () => {
    const unscheduled = (saleId: string | null = "7"): LaunchDetailRecord => {
      const detail = registeredDetail();
      return {
        ...detail,
        launch: { ...detail.launch, saleId, scheduleStatus: "unscheduled" },
      };
    };
    const projectedAs = (saleState: string): LaunchChainRepository => {
      const base = chainRepositoryFake();
      return {
        ...base,
        listStateProjections: async (ids) => {
          const map = await base.listStateProjections(ids);
          return new Map(
            [...map].map(([id, record]) => [
              id,
              { ...record, saleState } as typeof record,
            ]),
          );
        },
      };
    };
    const segmentsOf = async (app: FastifyInstance) => {
      const response = await get(app, "/v2/launch/overview");
      expect(response.statusCode).toBe(200);
      const segments = response.json<{
        segments: Record<
          string,
          { launchId: string; scheduleStatus: string }[]
        >;
      }>().segments;
      return Object.fromEntries(
        Object.entries(segments).map(([name, list]) => [
          name,
          list.map((item) => `${item.launchId}:${item.scheduleStatus}`),
        ]),
      );
    };
    const only = (segment: string) => ({
      live: segment === "live" ? [`${launchId}:unscheduled`] : [],
      upcoming: segment === "upcoming" ? [`${launchId}:unscheduled`] : [],
      awaitingSchedule:
        segment === "awaitingSchedule" ? [`${launchId}:unscheduled`] : [],
      ended: segment === "ended" ? [`${launchId}:unscheduled`] : [],
    });

    it.each([
      ["SCHEDULED", "upcoming"],
      ["LIVE", "live"],
      ["ENDED", "ended"],
      ["SUCCEEDED", "ended"],
      ["FAILED", "ended"],
      ["CANCELLED", "ended"],
    ])(
      "registered + %s projection lands in %s; scheduleStatus stays unscheduled",
      async (saleState, segment) => {
        const app = await createApp({
          detail: unscheduled(),
          chain: projectedAs(saleState),
        });
        expect(await segmentsOf(app)).toEqual(only(segment));
      },
    );

    it("an unregistered sale keeps its schedule segment", async () => {
      const app = await createApp({ detail: unscheduled(null) });
      expect(await segmentsOf(app)).toEqual(only("awaitingSchedule"));
    });

    it("a registered sale without a checkpoint keeps its schedule segment", async () => {
      const app = await createApp({
        detail: unscheduled(),
        chain: chainRepositoryFake({ checkpoint: null }),
      });
      expect(await segmentsOf(app)).toEqual(only("awaitingSchedule"));
    });

    it("a registered sale with no projection row keeps its schedule segment", async () => {
      const app = await createApp({
        detail: unscheduled(),
        chain: {
          ...chainRepositoryFake(),
          listStateProjections: () => Promise.resolve(new Map()),
        },
      });
      expect(await segmentsOf(app)).toEqual(only("awaitingSchedule"));
    });

    it("graduated keeps its frozen unavailable branch (no available branch in the OpenAPI)", async () => {
      const app = await createApp({
        detail: unscheduled(),
        chain: projectedAs("SUCCEEDED"),
      });
      expect((await get(app, "/v2/launch/overview")).json()).toMatchObject({
        graduated: {
          status: "unavailable",
          reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
        },
      });
    });
  });

  it("holders: index count, getPosition, and the wallet caps at one block", async () => {
    const app = await createApp();
    const response = await get(app, `/v2/launch/${launchId}/holders`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      launchId,
      holders: {
        status: "available",
        holderCount: 3,
        indexedBlockNumber: "950",
      },
      myPosition: {
        status: "available",
        walletId,
        cumulativeUsd1: (100n * oneUsd1).toString(),
        purchasedTokens: (10_000n * oneUsd1).toString(),
        entitledTokens: "0",
        claimableTokens: "0",
        claimedTokens: "0",
        refundableUsd1: "0",
        refundedUsd1: "0",
        snapshotBlockNumber: "900",
        snapshotBlockHash: fixtureBlockHash(900n),
      },
      walletCap: {
        status: "available",
        walletProjectCapUsd1: (1_000n * oneUsd1).toString(),
        rounds: [
          {
            roundIndex: 1,
            walletRoundCapUsd1: (500n * oneUsd1).toString(),
            cumulativeUsd1: (100n * oneUsd1).toString(),
          },
          {
            roundIndex: 2,
            walletRoundCapUsd1: (500n * oneUsd1).toString(),
            cumulativeUsd1: (100n * oneUsd1).toString(),
          },
        ],
        snapshotBlockNumber: "900",
        snapshotBlockHash: fixtureBlockHash(900n),
      },
      contractVersion: "2.0",
    });
  });

  it("history lists the caller's indexed records with the checkpoint as source", async () => {
    const app = await createApp();
    const response = await get(app, `/v2/launch/${launchId}/history`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      purchaseRecords: [
        {
          walletId,
          roundId: roundOneId,
          roundIndex: 1,
          usd1Amount: "10000000000000000000",
          confirmationState: "confirmed",
        },
      ],
      entitlements: [],
      refunds: [],
      source: {
        status: "available",
        indexedBlockNumber: "950",
        indexedBlockHash: fixtureBlockHash(950n),
      },
    });
  });

  it("eligibility returns tier, snapshot block, and a verifiable proof; a foreign chain root is a mismatch", async () => {
    const tree = buildLaunchMerkleTree([
      walletAddress,
      "0x00000000000000000000000000000000000000bb",
    ]);
    const state = createFakeLaunchChainState();
    state.rounds = state.rounds.map((round) =>
      round.roundId === 1 ? { ...round, allowlistRoot: tree.root } : round,
    );
    const root = {
      allowlistRootId: "8b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      launchId,
      roundIndex: 1,
      snapshotBlock: "880",
      snapshotBlockHash: fixtureBlockHash(880n),
      root: tree.root,
      leafCount: 2,
      mode: "whitelist" as const,
      members: tree.members,
      computedAt: "2026-09-21T00:00:00.000Z",
    };
    const app = await createApp({
      state,
      chain: chainRepositoryFake({ roots: [root] }),
    });
    const response = await get(
      app,
      `/v2/launch/${launchId}/eligibility?roundIndex=1`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: "whitelist",
      result: {
        status: "available",
        tier: "priority",
        reasonCode: null,
        snapshotBlock: "880",
        roundIndex: 1,
        allowlistRoot: tree.root,
        eligibilityProof: tree.proofFor(walletAddress),
      },
    });
    const open = await get(
      app,
      `/v2/launch/${launchId}/eligibility?roundIndex=2`,
    );
    expect(open.json()).toMatchObject({
      result: {
        status: "available",
        tier: "public",
        eligibilityProof: [],
        roundIndex: 2,
      },
    });
    const mismatch = await createApp({
      state,
      chain: chainRepositoryFake({
        roots: [{ ...root, root: `0x${"99".repeat(32)}` }],
      }),
    });
    expect(
      (
        await get(mismatch, `/v2/launch/${launchId}/eligibility?roundIndex=1`)
      ).json(),
    ).toMatchObject({
      result: {
        tier: null,
        reasonCode: "LAUNCH_ALLOWLIST_ROOT_MISMATCH",
        snapshotBlock: null,
      },
    });
    expect(
      (await get(app, `/v2/launch/${launchId}/eligibility?roundIndex=x`))
        .statusCode,
    ).toBe(400);
  });

  describe("open rounds (Decision 0084)", () => {
    const zeroRoot = `0x${"00".repeat(32)}`;
    const nonZeroRoot = `0x${"42".repeat(32)}`;
    const pendingModeDetail = (): LaunchDetailRecord => {
      const detail = registeredDetail();
      return {
        ...detail,
        configs: detail.configs.map((config) => ({
          ...config,
          status: "pending_confirmation" as const,
        })),
      };
    };
    const unsetModeDetail = (): LaunchDetailRecord => registeredDetail("");

    it("answers the open branch for an all-zero root while tierModeV1 is unconfirmed", async () => {
      for (const detail of [pendingModeDetail(), unsetModeDetail()]) {
        const app = await createApp({ detail });
        const response = await get(
          app,
          `/v2/launch/${launchId}/eligibility?roundIndex=2`,
        );
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          mode: "unavailable",
          result: {
            status: "available",
            tier: "public",
            reasonCode: null,
            snapshotBlock: "900",
            roundIndex: 2,
            allowlistRoot: zeroRoot,
            eligibilityProof: [],
          },
        });
      }
    });

    it("answers the open branch for an all-zero root with no LOOP root computed", async () => {
      const chain = chainRepositoryFake({ roots: [] });
      const listRoots = vi.spyOn(chain, "listAllowlistRoots");
      const app = await createApp({ chain });
      const response = await get(
        app,
        `/v2/launch/${launchId}/eligibility?roundIndex=1`,
      );
      expect(response.json()).toMatchObject({
        mode: "whitelist",
        result: {
          status: "available",
          // Round 1 carries a configured tier; the open branch keeps it.
          tier: "priority",
          reasonCode: null,
          allowlistRoot: zeroRoot,
          eligibilityProof: [],
        },
      });
      expect(listRoots).not.toHaveBeenCalled();
    });

    it("keeps the three refusals for a non-zero root", async () => {
      const state = createFakeLaunchChainState();
      state.rounds = state.rounds.map((round) =>
        round.roundId === 1 ? { ...round, allowlistRoot: nonZeroRoot } : round,
      );
      const refused = (reasonCode: string) => ({
        result: { tier: null, reasonCode, snapshotBlock: null },
      });
      const url = `/v2/launch/${launchId}/eligibility?roundIndex=1`;
      const pending = await createApp({ state, detail: pendingModeDetail() });
      expect((await get(pending, url)).json()).toMatchObject(
        refused("TIER_MODE_PENDING"),
      );
      const notComputed = await createApp({
        state,
        chain: chainRepositoryFake({ roots: [] }),
      });
      expect((await get(notComputed, url)).json()).toMatchObject(
        refused("LAUNCH_ALLOWLIST_NOT_COMPUTED"),
      );
      const tree = buildLaunchMerkleTree([walletAddress]);
      const mismatch = await createApp({
        state,
        chain: chainRepositoryFake({
          roots: [
            {
              allowlistRootId: "8b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
              launchId,
              roundIndex: 1,
              snapshotBlock: "880",
              snapshotBlockHash: fixtureBlockHash(880n),
              root: tree.root,
              leafCount: 1,
              mode: "whitelist",
              members: tree.members,
              computedAt: "2026-09-21T00:00:00.000Z",
            },
          ],
        }),
      });
      expect((await get(mismatch, url)).json()).toMatchObject(
        refused("LAUNCH_ALLOWLIST_ROOT_MISMATCH"),
      );
    });
  });

  it("economy adds the provable on-chain counts only while a contract is configured", async () => {
    const app = await createApp();
    const response = await get(app, "/v2/launch/economy");
    expect(response.json()).toMatchObject({
      onChain: {
        status: "available",
        registeredSaleCount: 1,
        totalRaisedUsd1: "170000000000000000000",
        lockedLpCount: 1,
        source: "loop_indexer",
        indexedBlockNumber: "950",
        indexedBlockHash: fixtureBlockHash(950n),
      },
      source: "loop",
    });
    const blank = await buildApp({
      config: s7TestConfig(),
      contractSurface: "v2",
      database: {
        ...s7Database({ launch: launchRepositoryFor(registeredDetail()) }),
        launchChain: chainRepositoryFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(blank);
    expect((await get(blank, "/v2/launch/economy")).json()).not.toHaveProperty(
      "onChain",
    );
  });

  it("prepares a Launch Intent with 201 when writes are on, and keeps the bare 503 when they are off", async () => {
    const app = await createApp({ env: writesEnv });
    const response = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders(),
      payload: { walletId, roundId: roundOneId, payAmount: "10" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      launchIntent: {
        state: "awaiting_signature",
        usd1Amount: "10000000000000000000",
        unsignedTransaction: {
          chainId: 97,
          to: fakeLaunchContract.address,
          value: "0x0",
        },
      },
      contractVersion: "2.0",
    });
    const refused = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders({
        "idempotency-key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
      }),
      payload: { walletId, roundId: roundOneId, payAmount: "1" },
    });
    expect(refused.statusCode).toBe(422);
    expect(Object.keys(refused.json<Record<string, unknown>>()).sort()).toEqual(
      [
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ],
    );
    expect(refused.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "LAUNCH_BELOW_MIN_PURCHASE" },
    });
    const off = await createApp();
    const closed = await off.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders(),
      payload: { walletId, roundId: roundOneId, payAmount: "10" },
    });
    expect(closed.statusCode).toBe(503);
    expect(closed.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: null,
    });
    expect(response.body).not.toContain("invalid/");
  });

  it("projects the reconciled states through the report replay: reverted carries revertReason null, submitted has no revertReason (Decision 0080)", async () => {
    const chain = chainRepositoryFake();
    const app = await createApp({ env: writesEnv, chain });
    const prepared = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders(),
      payload: { walletId, roundId: roundOneId, payAmount: "10" },
    });
    expect(prepared.statusCode).toBe(201);
    const launchIntentId = prepared.json<{
      launchIntent: { launchIntentId: string };
    }>().launchIntent.launchIntentId;
    const txHash = `0x${"ab".repeat(32)}`;
    const entry = [...chain.intents.values()][0];
    if (entry === undefined) {
      throw new Error("no intent stored");
    }
    const report = () =>
      app.inject({
        method: "POST",
        url: `/v2/launch/${launchId}/intents/${launchIntentId}/broadcast-report`,
        headers: s7CommandHeaders({
          "idempotency-key": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        }),
        payload: { txHash },
      });
    entry.record = {
      ...entry.record,
      state: "submitted",
      transactionHash: txHash,
      payloadVerified: true,
      reportedAt: entry.record.createdAt,
    };
    const submitted = await report();
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({
      launchIntent: { state: "submitted", transactionHash: txHash },
    });
    expect(
      submitted.json<{ launchIntent: object }>().launchIntent,
    ).not.toHaveProperty("revertReason");
    entry.record = {
      ...entry.record,
      state: "reverted",
      reasonCode: "LAUNCH_TX_REVERTED",
      revertReason: null,
      receipt: {
        status: "reverted",
        blockNumber: "990",
        blockHash: fixtureBlockHash(990n),
        gasUsed: "120000",
        effectiveGasPrice: "1000000000",
        confirmations: 5,
        observedAt: entry.record.createdAt,
      },
    };
    const reverted = await report();
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json()).toMatchObject({
      launchIntent: {
        state: "reverted",
        revertReason: null,
        transactionHash: txHash,
        signing: { allowed: false, reasonCode: "LAUNCH_TX_REVERTED" },
      },
      contractVersion: "2.0",
    });
    // The receipt fact is internal: it never reaches the wire.
    expect(reverted.body).not.toContain("effectiveGasPrice");
  });
});
