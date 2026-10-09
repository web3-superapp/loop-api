import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  LaunchChainRepositoryUnavailableError,
  type LaunchChainRepository,
} from "../src/features/launch/launch-chain-repository.js";
import {
  createFakeLaunchAdapter,
  createFakeLaunchChainState,
  createFakeLaunchSlotClient,
  fakeLaunchContract,
  fakeNowSeconds,
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
 * Decision 0081 route contract: `GET /v2/launch/{launchId}/intents/
 * {launchIntentId}` returns the prepare `201` projection byte for byte,
 * owner-scoped (another account's Intent is NOT_FOUND), with the Decision
 * 0080 settlements, and `transactionHash` always lowercase. Fixtures only.
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
const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];
const otherAccountId = "0f1e2d3c-4b5a-4968-8776-655443322110";
const unknownIntentId = "11111111-2222-4333-8444-555555555555";
const otherLaunchId = "99999999-8888-4777-8666-555555555555";

describe("GET /v2/launch/{launchId}/intents/{launchIntentId} (Decision 0081)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly chain?: LaunchChainRepository;
      readonly blankContract?: boolean;
    } = {},
  ) {
    const app = await buildApp({
      config: s7TestConfig(
        options.blankContract === true
          ? { ...options.env }
          : { ...contractEnv, ...options.env },
      ),
      contractSurface: "v2",
      database: {
        ...s7Database({ launch: launchRepositoryFor(registeredDetail()) }),
        launchChain: options.chain ?? chainRepositoryFake(),
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      // Blank keys compose the config-built adapter (contract null).
      ...(options.blankContract === true
        ? {}
        : {
            launchContractAdapter: createFakeLaunchAdapter(
              createFakeLaunchChainState(),
            ),
          }),
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

  async function prepared(app: FastifyInstance) {
    const response = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders(),
      payload: { walletId, roundId: roundOneId, payAmount: "10" },
    });
    expect(response.statusCode).toBe(201);
    return {
      body: response.body,
      launchIntentId: response.json<{
        launchIntent: { launchIntentId: string };
      }>().launchIntent.launchIntentId,
    };
  }

  const read = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });

  it("returns the prepare 201 body byte for byte with cache-control no-store", async () => {
    const app = await createApp({ env: writesEnv });
    const { body, launchIntentId } = await prepared(app);
    const response = await read(
      app,
      `/v2/launch/${launchId}/intents/${launchIntentId}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe(body);
    expect(response.json()).toMatchObject({
      launchIntent: {
        launchIntentId,
        state: "awaiting_signature",
        transactionHash: null,
      },
      contractVersion: "2.0",
    });
    expect(
      response.json<{ launchIntent: object }>().launchIntent,
    ).not.toHaveProperty("revertReason");
  });

  it("is owner-scoped: another account, an unknown id, and another launch are the same NOT_FOUND", async () => {
    const chain = chainRepositoryFake();
    const app = await createApp({ env: writesEnv, chain });
    const { launchIntentId } = await prepared(app);
    const urls = [
      `/v2/launch/${launchId}/intents/${unknownIntentId}`,
      `/v2/launch/${otherLaunchId}/intents/${launchIntentId}`,
    ];
    const entry = [...chain.intents.values()][0];
    if (entry === undefined) {
      throw new Error("no intent stored");
    }
    const bodies: unknown[] = [];
    for (const url of urls) {
      const response = await read(app, url);
      expect(response.statusCode).toBe(404);
      bodies.push(response.json());
    }
    entry.record = { ...entry.record, ownerUserId: otherAccountId };
    const foreign = await read(
      app,
      `/v2/launch/${launchId}/intents/${launchIntentId}`,
    );
    expect(foreign.statusCode).toBe(404);
    bodies.push(foreign.json());
    for (const body of bodies) {
      expect(Object.keys(body as object).sort()).toEqual(errorKeys);
      expect(body).toMatchObject({ code: "NOT_FOUND", detailsSafe: null });
    }
    expect(foreign.body).not.toContain(otherAccountId);
  });

  it("projects the Decision 0080 settlements: reverted with revertReason, expired and failed without it", async () => {
    const chain = chainRepositoryFake();
    const app = await createApp({ env: writesEnv, chain });
    const { launchIntentId } = await prepared(app);
    const entry = [...chain.intents.values()][0];
    if (entry === undefined) {
      throw new Error("no intent stored");
    }
    const url = `/v2/launch/${launchId}/intents/${launchIntentId}`;
    const txHash = `0x${"ab".repeat(32)}`;
    const receipt = {
      status: "reverted" as const,
      blockNumber: "990",
      blockHash: fixtureBlockHash(990n),
      gasUsed: "120000",
      effectiveGasPrice: "1000000000",
      confirmations: 5,
      observedAt: entry.record.createdAt,
    };
    const original = entry.record;
    entry.record = {
      ...original,
      state: "reverted",
      transactionHash: txHash,
      payloadVerified: true,
      reportedAt: original.createdAt,
      reasonCode: "LAUNCH_TX_REVERTED",
      revertReason: null,
      receipt,
    };
    const reverted = await read(app, url);
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json()).toMatchObject({
      launchIntent: {
        state: "reverted",
        revertReason: null,
        transactionHash: txHash,
        signing: { allowed: false, reasonCode: "LAUNCH_TX_REVERTED" },
      },
    });
    expect(reverted.body).not.toContain("effectiveGasPrice");

    entry.record = {
      ...original,
      state: "expired",
      transactionHash: txHash,
      reportedAt: original.createdAt,
      reasonCode: "LAUNCH_TX_NOT_OBSERVED",
    };
    const expired = (await read(app, url)).json<{
      launchIntent: Record<string, unknown>;
    }>();
    expect(expired.launchIntent).toMatchObject({
      state: "expired",
      signing: { allowed: false, reasonCode: "LAUNCH_TX_NOT_OBSERVED" },
    });
    expect(expired.launchIntent).not.toHaveProperty("revertReason");

    // An unreported Intent past expiresAt reads expired (the 0077 rule).
    entry.record = { ...original, expiresAt: "2000-01-01T00:00:00.000Z" };
    expect((await read(app, url)).json()).toMatchObject({
      launchIntent: {
        state: "expired",
        signing: { reasonCode: "LAUNCH_INTENT_EXPIRED" },
      },
    });

    entry.record = { ...original, state: "failed", reasonCode: null };
    const failed = (await read(app, url)).json<{
      launchIntent: Record<string, unknown>;
    }>();
    expect(failed.launchIntent["state"]).toBe("failed");
    expect(failed.launchIntent).not.toHaveProperty("revertReason");
  });

  it("stores and returns transactionHash lowercase: an uppercase report reads back lowercase and replays", async () => {
    const chain = chainRepositoryFake();
    const app = await createApp({ env: writesEnv, chain });
    const { launchIntentId } = await prepared(app);
    const lower = `0x${"ab".repeat(32)}`;
    const upper = `0x${"AB".repeat(32)}`;
    const report = (txHash: string, key: string) =>
      app.inject({
        method: "POST",
        url: `/v2/launch/${launchId}/intents/${launchIntentId}/broadcast-report`,
        headers: s7CommandHeaders({ "idempotency-key": key }),
        payload: { txHash },
      });
    const first = await report(upper, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      launchIntent: { state: "submitted", transactionHash: lower },
    });
    expect([...chain.intents.values()][0]?.record.transactionHash).toBe(lower);
    // The same hash in either case is the same report, never a conflict.
    const replay = await report(lower, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    const readBack = await read(
      app,
      `/v2/launch/${launchId}/intents/${launchIntentId}`,
    );
    expect(readBack.body).toBe(first.body);
    const hash = readBack.json<{
      launchIntent: { transactionHash: string };
    }>().launchIntent.transactionHash;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // A malformed hash is refused before any lookup.
    const malformed = await report(
      `0x${"zz".repeat(32)}`,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    expect(malformed.statusCode).toBe(400);
  });

  it("keeps the bare 503 while writes are off or the contract keys are blank", async () => {
    for (const app of [
      await createApp(),
      await createApp({ env: writesEnv, blankContract: true }),
    ]) {
      const response = await read(
        app,
        `/v2/launch/${launchId}/intents/${unknownIntentId}`,
      );
      expect(response.statusCode).toBe(503);
      expect(Object.keys(response.json<object>()).sort()).toEqual(errorKeys);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: null,
      });
    }
  });

  it("answers 503 when the Intent store is unreadable, never NOT_FOUND", async () => {
    const chain = {
      ...chainRepositoryFake(),
      getIntent: () =>
        Promise.reject(new LaunchChainRepositoryUnavailableError()),
    };
    const app = await createApp({ env: writesEnv, chain });
    const response = await read(
      app,
      `/v2/launch/${launchId}/intents/${unknownIntentId}`,
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: null,
    });
  });

  it("validates path, query, and headers", async () => {
    const app = await createApp({ env: writesEnv });
    const { launchIntentId } = await prepared(app);
    const url = `/v2/launch/${launchId}/intents/${launchIntentId}`;
    expect(
      (await read(app, `/v2/launch/${launchId}/intents/x`)).statusCode,
    ).toBe(400);
    expect((await read(app, `${url}?a=1`)).statusCode).toBe(400);
    const noAuth = await app.inject({
      method: "GET",
      url,
      headers: s7CommonHeaders({ authorization: undefined }),
    });
    expect(noAuth.statusCode).toBe(401);
    const noContract = await app.inject({
      method: "GET",
      url,
      headers: s7CommonHeaders({ "x-loop-contract-version": undefined }),
    });
    expect(noContract.statusCode).toBe(400);
  });
});
