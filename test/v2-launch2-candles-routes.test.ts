import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { formatLaunch2Amount } from "../src/features/launch2/launch2-contract.js";
import {
  fillLaunch2Candles,
  launch2CandleWindow,
  parseLaunch2CandleQuery,
  type Launch2CandleBoundsRecord,
  type Launch2CandleWindowRecord,
} from "../src/features/launch2/launch2-candles.js";
import { launch2PriceAt } from "../src/features/launch2/launch2-curve-math.js";
import { launch2CandlesResourceSchema } from "../src/routes/v2/launch2-candles-schemas.js";
import {
  createFakeLaunch2Chain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  graduatedInstance,
  instanceFixture,
  launch2Env,
  launch2NowSeconds,
  wad,
  type InMemoryLaunch2Repository,
} from "./helpers/launch2-fakes.js";
import { walletsFake } from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
} from "./helpers/meme-service-fakes.js";
import {
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0171: `GET /v2/launch2/instances/{instanceId}/candles` over the
 * in-memory repository — query rules (422 reason codes), the detail's 404,
 * auth and contract headers, 503 without the candle reads, the filler rule
 * and the resource shape. The SQL itself: launch2-candles.integration.
 */

const now = new Date(Number(launch2NowSeconds) * 1000);
const nowSeconds = Number(launch2NowSeconds);
const start = launch2PriceAt(0n);

describe("launch2 candle query and fill (Decision 0171)", () => {
  it("parses the defaults and every interval", () => {
    expect(parseLaunch2CandleQuery({})).toEqual({
      interval: "5m",
      stepSeconds: 300,
      limit: 200,
      before: null,
    });
    const steps = ["1m", "5m", "15m", "1h", "4h", "1d"].map(
      (interval) => parseLaunch2CandleQuery({ interval }).stepSeconds,
    );
    expect(steps).toEqual([60, 300, 900, 3_600, 14_400, 86_400]);
    expect(
      parseLaunch2CandleQuery({ limit: "500", before: "1800000000" }),
    ).toMatchObject({ limit: 500, before: 1_800_000_000 });
  });

  it.each([
    [{ interval: "2m" }, "LAUNCH2_CANDLE_INTERVAL_INVALID"],
    [{ interval: "toString" }, "LAUNCH2_CANDLE_INTERVAL_INVALID"],
    [{ limit: "0" }, "LAUNCH2_CANDLE_LIMIT_INVALID"],
    [{ limit: "501" }, "LAUNCH2_CANDLE_LIMIT_INVALID"],
    [{ limit: "1.5" }, "LAUNCH2_CANDLE_LIMIT_INVALID"],
    [{ before: "0" }, "LAUNCH2_CANDLE_BEFORE_INVALID"],
    [{ before: "-5" }, "LAUNCH2_CANDLE_BEFORE_INVALID"],
    [{ before: "999999999999" }, "LAUNCH2_CANDLE_BEFORE_INVALID"],
  ])("refuses %j with 422 %s", (query, reasonCode) => {
    expect(() => parseLaunch2CandleQuery(query)).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        detailsSafe: { reasonCode },
      }) as Error,
    );
  });

  it("windows the newest `limit` buckets, bounded by the first fact and before", () => {
    const query = parseLaunch2CandleQuery({ limit: "3" });
    expect(
      launch2CandleWindow({
        query,
        firstAt: 1_000,
        latestAt: 2_000,
        nowSeconds: 3_100,
      }),
    ).toEqual({ fromSeconds: 2_400, endBucket: 3_000 });
    // The first fact's bucket bounds the window.
    expect(
      launch2CandleWindow({
        query,
        firstAt: 2_950,
        latestAt: 2_950,
        nowSeconds: 3_100,
      }),
    ).toEqual({ fromSeconds: 2_700, endBucket: 3_000 });
    // before = a bucket start excludes that bucket.
    expect(
      launch2CandleWindow({
        query: parseLaunch2CandleQuery({ limit: "3", before: "2700" }),
        firstAt: 1_000,
        latestAt: 2_000,
        nowSeconds: 3_100,
      }),
    ).toEqual({ fromSeconds: 1_800, endBucket: 2_400 });
    // Nothing before the first fact.
    expect(
      launch2CandleWindow({
        query: parseLaunch2CandleQuery({ before: "900" }),
        firstAt: 1_000,
        latestAt: 2_000,
        nowSeconds: 3_100,
      }),
    ).toBeNull();
  });

  it("opens at the previous close and fills empty buckets flat", () => {
    const filled = fillLaunch2Candles({
      fromSeconds: 0,
      endBucket: 900,
      stepSeconds: 300,
      priorCloseE18: 10n,
      priorSource: "curve",
      buckets: [
        {
          t: 0,
          highE18: "15",
          lowE18: "12",
          closeE18: "12",
          volumeMeme: (3n * wad).toString(),
          volumeUsd1: (2n * wad).toString(),
          count: 2,
          hasCurve: true,
          hasPool: false,
        },
        {
          t: 600,
          highE18: "20",
          lowE18: "20",
          closeE18: "20",
          volumeMeme: wad.toString(),
          volumeUsd1: wad.toString(),
          count: 1,
          hasCurve: false,
          hasPool: true,
        },
      ],
    });
    const raw = (n: bigint) => formatLaunch2Amount(n);
    expect(filled.candles).toEqual([
      {
        t: 0,
        o: raw(10n),
        h: raw(15n),
        l: raw(10n),
        c: raw(12n),
        v: "3",
        q: "2",
        n: 2,
      },
      {
        t: 300,
        o: raw(12n),
        h: raw(12n),
        l: raw(12n),
        c: raw(12n),
        v: "0",
        q: "0",
        n: 0,
      },
      {
        t: 600,
        o: raw(12n),
        h: raw(20n),
        l: raw(12n),
        c: raw(20n),
        v: "1",
        q: "1",
        n: 1,
      },
      {
        t: 900,
        o: raw(20n),
        h: raw(20n),
        l: raw(20n),
        c: raw(20n),
        v: "0",
        q: "0",
        n: 0,
      },
    ]);
    expect([...filled.sources].sort()).toEqual(["curve", "pool"]);
  });
});

describe("V2 launch2 candles route (Decision 0171)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(repository: InMemoryLaunch2Repository) {
    const app = await buildApp({
      config: s7TestConfig(launch2Env),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(defaultChainState()),
      launchChainReadClient: createFakeMemeSlotClient(defaultMemeFunds({})),
      walletIntentNow: () => now,
      logger: false,
    });
    apps.push(app);
    return app;
  }

  function withCandles(
    repository: InMemoryLaunch2Repository,
    bounds: Launch2CandleBoundsRecord,
    window: Launch2CandleWindowRecord,
  ) {
    const calls: unknown[] = [];
    repository.readCandleBounds = () => Promise.resolve(bounds);
    repository.readCandleWindow = (input) => {
      calls.push(input);
      return Promise.resolve(window);
    };
    return calls;
  }

  const get = (
    app: FastifyInstance,
    instanceId: string,
    query = "",
    headers = s7CommonHeaders(),
  ) =>
    app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${instanceId}/candles${query}`,
      headers,
    });

  it("answers an instance with no trade: no candles, the start price at activation", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = instanceFixture({ stage: "public" });
    repository.instances.set(record.instanceId, record);
    const calls = withCandles(
      repository,
      { firstAt: null, latest: null },
      { priorCloseE18: null, priorPool: null, buckets: [] },
    );
    const app = await createApp(repository);
    const response = await get(app, record.instanceId);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(body).toEqual({
      instanceId: record.instanceId,
      interval: "5m",
      quoteAsset: "USD1",
      source: "curve",
      candles: [],
      latest: {
        price: formatLaunch2Amount(start),
        at: Math.floor(Date.parse(record.activatedAt!) / 1000),
      },
      contractVersion: "2.0",
    });
    expect(Object.keys(body).sort()).toEqual(
      [...launch2CandlesResourceSchema.required].sort(),
    );
    expect(calls).toEqual([]);
  });

  it("fills from the first trade to now and reads the window it needs", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = graduatedInstance();
    repository.instances.set(record.instanceId, record);
    const first = nowSeconds - 900; // 1_799_999_100, a 5m bucket start.
    const calls = withCandles(
      repository,
      {
        firstAt: first + 5,
        latest: { priceE18: "50000000000000", at: first + 400 },
      },
      {
        priorCloseE18: null,
        priorPool: null,
        buckets: [
          {
            t: first,
            highE18: "45000000000000",
            lowE18: "45000000000000",
            closeE18: "45000000000000",
            volumeMeme: (1_000n * wad).toString(),
            volumeUsd1: (45n * wad).toString(),
            count: 1,
            hasCurve: true,
            hasPool: false,
          },
          {
            t: first + 300,
            highE18: "50000000000000",
            lowE18: "50000000000000",
            closeE18: "50000000000000",
            volumeMeme: (10n * wad).toString(),
            volumeUsd1: wad.toString(),
            count: 1,
            hasCurve: false,
            hasPool: true,
          },
        ],
      },
    );
    const app = await createApp(repository);
    const response = await get(app, record.instanceId, "?interval=5m");
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      source: string;
      candles: { t: number; o: string; c: string; n: number }[];
      latest: unknown;
    }>();
    expect(calls).toEqual([
      {
        instanceId: record.instanceId,
        stepSeconds: 300,
        fromSeconds: first,
        toSeconds: nowSeconds + 300,
      },
    ]);
    expect(body.source).toBe("mixed");
    expect(
      body.candles.map((candle) => [candle.t, candle.o, candle.c, candle.n]),
    ).toEqual([
      [first, formatLaunch2Amount(start), "0.000045", 1],
      [first + 300, "0.000045", "0.00005", 1],
      [first + 600, "0.00005", "0.00005", 0],
      [first + 900, "0.00005", "0.00005", 0],
    ]);
    expect(body.latest).toEqual({ price: "0.00005", at: first + 400 });
  });

  it.each([
    ["?interval=3m", "LAUNCH2_CANDLE_INTERVAL_INVALID"],
    ["?limit=501", "LAUNCH2_CANDLE_LIMIT_INVALID"],
    ["?limit=0", "LAUNCH2_CANDLE_LIMIT_INVALID"],
    ["?before=abc", "LAUNCH2_CANDLE_BEFORE_INVALID"],
  ])("answers %s with 422 %s", async (query, reasonCode) => {
    const repository = createInMemoryLaunch2Repository();
    const record = instanceFixture();
    repository.instances.set(record.instanceId, record);
    const app = await createApp(repository);
    const response = await get(app, record.instanceId, query);
    expect(response.statusCode).toBe(422);
    const body = response.json<Record<string, unknown>>();
    expect(body["code"]).toBe("VALIDATION_FAILED");
    expect(body["detailsSafe"]).toEqual({ reasonCode });
    expect(Object.keys(body).sort()).toEqual(
      [
        "category",
        "code",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
        "retryable",
        "userMessageKey",
      ].sort(),
    );
  });

  it("refuses an unknown query key with 400", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = instanceFixture();
    repository.instances.set(record.instanceId, record);
    const app = await createApp(repository);
    const response = await get(app, record.instanceId, "?from=1");
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe("INVALID_REQUEST");
  });

  it("answers an unknown or never-activated instance like the detail (404)", async () => {
    const repository = createInMemoryLaunch2Repository();
    const pending = instanceFixture({ activatedAt: null, holdReason: null });
    repository.instances.set(pending.instanceId, pending);
    withCandles(
      repository,
      { firstAt: null, latest: null },
      { priorCloseE18: null, priorPool: null, buckets: [] },
    );
    const app = await createApp(repository);
    for (const instanceId of [randomUUID(), pending.instanceId]) {
      const response = await get(app, instanceId);
      expect(response.statusCode).toBe(404);
      expect(response.json<{ detailsSafe: unknown }>().detailsSafe).toEqual({
        reasonCode: "LAUNCH2_INSTANCE_NOT_FOUND",
      });
    }
  });

  it("requires the bearer and the contract headers", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = instanceFixture();
    repository.instances.set(record.instanceId, record);
    const app = await createApp(repository);
    const anonymous = await get(
      app,
      record.instanceId,
      "",
      s7CommonHeaders({ authorization: undefined }),
    );
    expect(anonymous.statusCode).toBe(401);
    const noContract = await get(
      app,
      record.instanceId,
      "",
      s7CommonHeaders({ "x-loop-contract-version": undefined }),
    );
    expect(noContract.statusCode).toBe(400);
  });

  it("fails closed with 503 when the repository has no candle reads", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = instanceFixture();
    repository.instances.set(record.instanceId, record);
    const app = await createApp(repository);
    const response = await get(app, record.instanceId);
    expect(response.statusCode).toBe(503);
    expect(
      response.json<{ code: string; detailsSafe: unknown }>(),
    ).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "LAUNCH2_REPOSITORY_UNAVAILABLE" },
    });
  });

  it("fails closed with 503 when the candle read fails", async () => {
    const repository = createInMemoryLaunch2Repository();
    const record = instanceFixture();
    repository.instances.set(record.instanceId, record);
    repository.readCandleBounds = () => Promise.reject(new Error("db down"));
    repository.readCandleWindow = () => Promise.reject(new Error("db down"));
    const app = await createApp(repository);
    const response = await get(app, record.instanceId);
    expect(response.statusCode).toBe(503);
  });
});
