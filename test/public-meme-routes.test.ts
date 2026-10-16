import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  openApiPublicArtifactPath,
  renderOpenApiPublicArtifact,
} from "../scripts/generate-openapi.js";
import { buildApp } from "../src/app.js";
import type { Launch2Repository } from "../src/features/launch2/launch2-ports.js";
import {
  launch2PublicChangePct,
  launch2PublicSlogan,
  launch2PublicSocials,
  launch2PublicTotalTaxUsd1,
} from "../src/features/launch2/launch2-public.js";
import {
  publicMemeCacheControl,
  publicMemeCandlesSchema,
  publicMemeDetailSchema,
  publicMemeListSchema,
} from "../src/routes/public-meme.js";
import {
  createFakeLaunch2DynamicChain,
  defaultDynamicState,
  graduatedDynamicInstance,
  launch2DynamicHook,
  type FakeLaunch2DynamicState,
} from "./helpers/launch2-dynamic-fakes.js";
import {
  createFakeLaunch2Chain,
  createFakeLaunch2PoolChain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  defaultPoolState,
  graduatedInstance,
  launch2Env,
  launch2NowSeconds,
  launch2PoolEnv,
  priorityInstance,
  wad,
  type InMemoryLaunch2Repository,
} from "./helpers/launch2-fakes.js";
import { walletsFake } from "./helpers/launch-service-fakes.js";
import {
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0147: the public MEME page read surface `/public/v1/meme*` —
 * no auth, CORS `*` on every answer (only under /public), cache 15 s on a
 * 200, `{ code, reasonCode }` failures (503 reasons as is), a per-IP
 * fixed-window rate limit, and no wallet / user / viewer field anywhere.
 */

const forbiddenKeys = [
  "viewer",
  "walletId",
  "walletAddress",
  "ownerUserId",
  "viewerIsProjectOwner",
  "projectOwnerAddress",
  "buyers",
  "currentRoundBuyers",
  "traderAddress",
  "recentTrades",
  "userId",
];

function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysDeep(inner, into);
    }
  }
  return into;
}

function expectKeys(
  value: unknown,
  schema: { readonly required: readonly string[] },
): void {
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual(
    [...schema.required].sort(),
  );
}

describe("public MEME routes (Decision 0147)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly repository?: Launch2Repository;
      readonly dynamic?: FakeLaunch2DynamicState | null;
      readonly ratePerWindow?: number;
      readonly clock?: { ms: number };
      readonly env?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const repository = options.repository ?? createInMemoryLaunch2Repository();
    const dynamic =
      options.dynamic === undefined ? defaultDynamicState() : options.dynamic;
    const clock = options.clock ?? { ms: 1_000_000 };
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...launch2PoolEnv,
        ...options.env,
      }),
      contractSurface: "runtime",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(defaultChainState()),
      launch2PoolChain: createFakeLaunch2PoolChain(defaultPoolState()),
      launch2DynamicChain:
        dynamic === null ? null : createFakeLaunch2DynamicChain(dynamic),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      publicMeme: {
        nowMs: () => clock.ms,
        ...(options.ratePerWindow === undefined
          ? {}
          : { ratePerWindow: options.ratePerWindow }),
      },
      logger: false,
    });
    apps.push(app);
    return { app, clock };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: { origin: "https://x.dev" } });

  function seeded(
    ...records: ReturnType<typeof graduatedDynamicInstance>[]
  ): InMemoryLaunch2Repository {
    const repository = createInMemoryLaunch2Repository();
    for (const record of records) {
      repository.instances.set(record.instanceId, record);
    }
    return repository;
  }

  it("answers a graduated LoopDynamic MEME with the contract's fields only", async () => {
    const record = graduatedDynamicInstance({
      projectProfile: {
        description: "  Frog to the moon.  ",
        links: [
          "https://x.com/frog",
          "https://frog.example",
          "https://t.me/frog",
        ],
      },
      taxUsd1: (99n * wad).toString(),
      pool: {
        ...graduatedDynamicInstance().pool,
        lastPriceE18: (625n * 10n ** 12n).toString(),
        lastTradeAt: "2027-01-15T08:00:00.000Z",
      },
      buyback: {
        paused: false,
        count: "2",
        usd1: (50n * wad).toString(),
        meme: (80_000n * wad).toString(),
        lastAt: "2027-01-15T07:00:00.000Z",
      },
    });
    const repository = seeded(record);
    const communityId = randomUUID();
    repository.publicFacts.set(record.instanceId, {
      community: {
        communityId,
        name: "Frog Club",
        description: "\n  Hop together.\nSecond line",
        memberCount: 12,
        verified: true,
      },
      curveTaxUsd1: (99n * wad).toString(),
      lastClosedRound: {
        roundId: "2",
        closedAt: "2027-01-15T06:00:00.000Z",
        allocationUsd1: (7n * wad).toString(),
        buyerCount: 3,
      },
      poolReferencePriceE18: (500n * 10n ** 12n).toString(),
    });
    repository.dynamicSummaries.set(record.instanceId, {
      roundCount: 3,
      closedRoundCount: 2,
      allocatedUsd1: (30n * wad).toString(),
      claimedUsd1: (12n * wad).toString(),
      extraFeesUsd1: (70n * wad).toString(),
      baseSellFeesUsd1: (4n * wad).toString(),
      buyFeesMeme: (1_000n * wad).toString(),
      lastRound: null,
    });
    repository.dynamicRoundBuyers.set(`${record.instanceId}|3`, [
      {
        address: `0x${"a9".repeat(20)}`,
        weightUsd1: (5n * wad).toString(),
        creditedUsd1: (5n * wad).toString(),
        movedInUsd1: "0",
        movedOutUsd1: "0",
        creditCount: 1,
        attributions: ["loopRouter"],
        lastCreditedAt: "2027-01-15T07:30:00.000Z",
      },
    ]);
    const { app } = await createApp({
      repository,
      dynamic: defaultDynamicState({ maxDynamicFeeWad: 2n * 10n ** 17n }),
    });
    const response = await get(app, `/public/v1/meme/${record.instanceId}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["cache-control"]).toBe(publicMemeCacheControl);
    const body = response.json<Record<string, Record<string, unknown>>>();
    expectKeys(body, publicMemeDetailSchema);
    const p = publicMemeDetailSchema.properties;
    expectKeys(body["instance"], p.instance);
    expectKeys(body["community"], p.community.anyOf[0]);
    expectKeys(body["price"], p.price);
    expectKeys(body["dynamic"], p.dynamic.anyOf[0]);
    expectKeys(body["totals"], p.totals);
    for (const key of forbiddenKeys) {
      expect(keysDeep(body).has(key)).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain("a9a9a9");
    expect(body["instance"]).toMatchObject({
      instanceId: record.instanceId,
      name: "Frog Launch",
      symbol: "FROG",
      description: "Frog to the moon.",
      stage: "graduated",
      hookAddress: launch2DynamicHook,
      poolId: record.graduation?.poolId,
      chainId: "eip155:97",
      explorerBaseUrl: "https://testnet.bscscan.com",
      socials: {
        website: "https://frog.example",
        x: "https://x.com/frog",
        telegram: "https://t.me/frog",
      },
    });
    expect(body["community"]).toEqual({
      communityId,
      name: "Frog Club",
      slogan: "Hop together.",
      description: "\n  Hop together.\nSecond line",
      memberCount: 12,
      verified: true,
      avatarUrl: null,
    });
    expect(body["price"]).toEqual({
      lastPriceUsd1: "0.000625",
      change24hPct: "25.00",
      asOf: "2027-01-15T08:00:00.000Z",
    });
    expect(body["dynamic"]).toEqual({
      hookKind: "loopDynamic",
      armed: true,
      currentRound: {
        roundId: "3",
        startCandle: (launch2NowSeconds / 300n - 2n).toString(),
        openPriceUsd1: "0.000625",
        buyerCount: 1,
        totalBuyWeightUsd1: "100",
      },
      // min(drop 30 %, cap 20 %).
      currentDynamicTaxBps: 2000,
      maxDynamicFeeBps: 2000,
      baseBuyFeeBps: 200,
      baseSellFeeBps: 200,
      pendingPotUsd1: "45",
      carryUsd1: "40",
      currentRoundDynamicFeesUsd1: "5",
      roundCloseRule: "closeAtOrAboveOpen",
      lastClosedRound: {
        roundId: "2",
        closedAt: "2027-01-15T06:00:00.000Z",
        allocationUsd1: "7",
        buyerCount: 3,
      },
      asOfBlock: "6000",
    });
    expect(body["totals"]).toEqual({
      curveTaxUsd1: "99",
      poolBaseBuyFeeMeme: "1000",
      poolBaseSellFeeUsd1: "4",
      dynamicFeesUsd1: "70",
      // 99 + 4 + 70 + 1,000 MEME × 0.000625.
      totalTaxUsd1Equivalent: "173.625",
      rewardsAllocatedUsd1: "30",
      rewardsClaimedUsd1: "12",
      buyback: {
        executedCount: 2,
        spentUsd1: "50",
        boughtMeme: "80000",
        escrowRemainingUsd1: "150",
        recipientAddress: "0x28816c4c4792467390c90e5b426f198570e29307",
        lastAt: "2027-01-15T07:00:00.000Z",
      },
    });
    expect(repository.publicFactsCalls[0]?.since).toBe(
      new Date(Number(launch2NowSeconds - 86_400n) * 1000).toISOString(),
    );
  });

  it("answers dynamic null for OfficialTax and pre-graduation instances (never 503)", async () => {
    const official = graduatedInstance({
      pool: {
        ...graduatedInstance().pool,
        lastPriceE18: (600n * 10n ** 12n).toString(),
      },
    });
    const curve = priorityInstance({ soldSupply: (1_000n * wad).toString() });
    const repository = seeded(official, curve);
    repository.publicFacts.set(official.instanceId, {
      poolTaxMeme: (300n * wad).toString(),
      poolTaxUsd1: (2n * wad).toString(),
      curveTaxUsd1: (10n * wad).toString(),
    });
    const { app } = await createApp({ repository, dynamic: null });
    const a = await get(app, `/public/v1/meme/${official.instanceId}`);
    expect(a.statusCode).toBe(200);
    const officialBody = a.json<Record<string, Record<string, unknown>>>();
    expect(officialBody["dynamic"]).toBeNull();
    expect(officialBody["community"]).toBeNull();
    expect(officialBody["totals"]).toMatchObject({
      curveTaxUsd1: "10",
      poolBaseBuyFeeMeme: "300",
      poolBaseSellFeeUsd1: "2",
      dynamicFeesUsd1: "0",
      totalTaxUsd1Equivalent: "12.18",
      rewardsAllocatedUsd1: "0",
    });
    // No reference swap: no 24 h change.
    expect(officialBody["price"]?.["change24hPct"]).toBeNull();
    const b = await get(app, `/public/v1/meme/${curve.instanceId}`);
    expect(b.statusCode).toBe(200);
    const curveBody = b.json<Record<string, Record<string, unknown>>>();
    expect(curveBody["dynamic"]).toBeNull();
    expect(curveBody["instance"]).toMatchObject({
      stage: "priority",
      poolId: null,
      graduatedAt: null,
    });
    // Reference = the curve price at 0 sold (the fixture's price is p(0)).
    expect(curveBody["price"]).toMatchObject({
      lastPriceUsd1: "0.00004166666625",
      change24hPct: "0.00",
    });
  });

  it("passes every Hook / registry 503 through as { code, reasonCode } without a body", async () => {
    const record = graduatedDynamicInstance();
    const { app } = await createApp({
      repository: seeded(record),
      dynamic: defaultDynamicState({ failRead: true }),
    });
    const response = await get(app, `/public/v1/meme/${record.instanceId}`);
    expect(response.statusCode).toBe(503);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "LAUNCH2_CHAIN_READ_FAILED",
    });
    const { app: noRouter } = await createApp({
      repository: seeded(record),
      dynamic: null,
    });
    expect(
      (await get(noRouter, `/public/v1/meme/${record.instanceId}`)).json(),
    ).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED",
    });
    const { app: mismatch } = await createApp({
      repository: seeded(record),
      dynamic: defaultDynamicState({
        hook: { trustedRouter: `0x${"12".repeat(20)}` },
      }),
    });
    expect(
      (await get(mismatch, `/public/v1/meme/${record.instanceId}`)).json(),
    ).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "LAUNCH2_DYNAMIC_HOOK_MISMATCH",
    });
  });

  it("answers 503 when the repository lacks the public reads, 404 for an unknown instance", async () => {
    const record = graduatedInstance();
    const full = seeded(record);
    // A repository from before Decision 0147 (no public reads).
    const older: Partial<Launch2Repository> = { ...full };
    delete older.getPublicMemeFacts;
    delete older.listPublicCandles;
    const { app } = await createApp({
      repository: older as Launch2Repository,
    });
    const response = await get(app, `/public/v1/meme/${record.instanceId}`);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "LAUNCH2_REPOSITORY_UNAVAILABLE",
    });
    const missing = await get(app, `/public/v1/meme/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["access-control-allow-origin"]).toBe("*");
    expect(missing.json()).toEqual({
      code: "NOT_FOUND",
      reasonCode: "LAUNCH2_INSTANCE_NOT_FOUND",
    });
    const malformed = await get(app, "/public/v1/meme/not-an-id");
    expect(malformed.statusCode).toBe(404);
    const unknown = await get(app, "/public/v1/nothing");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      code: "NOT_FOUND",
      reasonCode: "PUBLIC_NOT_FOUND",
    });
  });

  it("lists MEMEs with the stage filter, per-row dynamic, and 400 on bad input", async () => {
    const dynamic = graduatedDynamicInstance({
      activatedAt: "2027-01-15T03:00:00.000Z",
    });
    const official = graduatedInstance({
      activatedAt: "2027-01-15T02:00:00.000Z",
    });
    const curve = priorityInstance({ activatedAt: "2027-01-15T01:00:00.000Z" });
    const repository = seeded(dynamic, official, curve);
    repository.publicFacts.set(official.instanceId, {
      community: {
        communityId: randomUUID(),
        name: "Official Club",
        description: null,
        memberCount: 1,
        verified: false,
      },
    });
    const { app } = await createApp({ repository });
    const all = await get(app, "/public/v1/meme");
    expect(all.statusCode).toBe(200);
    expect(all.headers["access-control-allow-origin"]).toBe("*");
    const body = all.json<{ items: Record<string, unknown>[] }>();
    expectKeys(body, publicMemeListSchema);
    expect(body.items.map((item) => item["instanceId"])).toEqual([
      dynamic.instanceId,
      official.instanceId,
      curve.instanceId,
    ]);
    for (const item of body.items) {
      expectKeys(item, publicMemeListSchema.properties.items.items);
    }
    expect(body.items[0]).toMatchObject({
      stage: "graduated",
      dynamic: { armed: true, currentDynamicTaxBps: 3000 },
      dynamicReasonCode: null,
    });
    expect(body.items[1]).toMatchObject({
      communityName: "Official Club",
      dynamic: null,
      dynamicReasonCode: null,
    });
    expect(body.items[2]).toMatchObject({ stage: "priority", dynamic: null });
    const graduated = await get(app, "/public/v1/meme?stage=graduated");
    expect(
      graduated
        .json<{ items: Record<string, unknown>[] }>()
        .items.map((item) => item["instanceId"]),
    ).toEqual([dynamic.instanceId, official.instanceId]);
    const curveOnly = await get(app, "/public/v1/meme?stage=curve&limit=5");
    expect(
      curveOnly
        .json<{ items: Record<string, unknown>[] }>()
        .items.map((item) => item["instanceId"]),
    ).toEqual([curve.instanceId]);
    for (const [url, reasonCode] of [
      ["/public/v1/meme?stage=nft", "PUBLIC_STAGE_INVALID"],
      ["/public/v1/meme?limit=0", "PUBLIC_LIMIT_INVALID"],
      ["/public/v1/meme?limit=51", "PUBLIC_LIMIT_INVALID"],
    ] as const) {
      const refused = await get(app, url);
      expect(refused.statusCode).toBe(400);
      expect(refused.headers["access-control-allow-origin"]).toBe("*");
      expect(refused.json()).toEqual({ code: "INVALID_REQUEST", reasonCode });
    }
  });

  it("keeps a list row whose Hook read is unavailable as dynamic null with the reason", async () => {
    const record = graduatedDynamicInstance();
    const { app } = await createApp({
      repository: seeded(record),
      dynamic: defaultDynamicState({ failRead: true }),
    });
    const response = await get(app, "/public/v1/meme");
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ items: Record<string, unknown>[] }>().items[0],
    ).toMatchObject({
      dynamic: null,
      dynamicReasonCode: "LAUNCH2_CHAIN_READ_FAILED",
    });
  });

  it("serves 5m candles from the right source and refuses other intervals", async () => {
    const dynamic = graduatedDynamicInstance();
    const official = graduatedInstance();
    const curve = priorityInstance();
    const repository = seeded(dynamic, official, curve);
    const candle = (minute: number, price: bigint, volume: bigint | null) => ({
      openTime: new Date(Date.UTC(2027, 0, 15, 8, minute)).toISOString(),
      openE18: price.toString(),
      highE18: (price + 10n).toString(),
      lowE18: (price - 10n).toString(),
      closeE18: price.toString(),
      volumeUsd1: volume === null ? null : volume.toString(),
    });
    repository.publicCandles.set(`${curve.instanceId}|curve`, [
      candle(0, 4n * 10n ** 13n, 9n * wad),
      candle(5, 5n * 10n ** 13n, 1n * wad),
    ]);
    // The LoopDynamic instance has no Hook candle yet: the swaps answer.
    repository.publicCandles.set(`${dynamic.instanceId}|pool`, [
      candle(10, 6n * 10n ** 14n, 3n * wad),
    ]);
    repository.publicCandles.set(`${official.instanceId}|pool`, [
      candle(15, 7n * 10n ** 14n, null),
    ]);
    const { app } = await createApp({ repository });
    const a = await get(app, `/public/v1/meme/${curve.instanceId}/candles`);
    expect(a.statusCode).toBe(200);
    expect(a.headers["cache-control"]).toBe(publicMemeCacheControl);
    const curveBody = a.json<Record<string, unknown>>();
    expectKeys(curveBody, publicMemeCandlesSchema);
    expect(curveBody).toMatchObject({
      interval: "5m",
      source: "curve",
      candles: [
        {
          t: "2027-01-15T08:00:00.000Z",
          o: "0.00004",
          h: "0.00004000000000001",
          l: "0.00003999999999999",
          c: "0.00004",
          v: "9",
        },
        { t: "2027-01-15T08:05:00.000Z", v: "1" },
      ],
    });
    const limited = await get(
      app,
      `/public/v1/meme/${curve.instanceId}/candles?interval=5m&limit=1`,
    );
    expect(
      limited.json<{ candles: { t: string }[] }>().candles.map((c) => c.t),
    ).toEqual(["2027-01-15T08:05:00.000Z"]);
    const b = await get(app, `/public/v1/meme/${dynamic.instanceId}/candles`);
    expect(b.json()).toMatchObject({
      source: "pool",
      candles: [{ t: "2027-01-15T08:10:00.000Z", v: "3" }],
    });
    repository.publicCandles.set(`${dynamic.instanceId}|dynamic`, [
      candle(20, 8n * 10n ** 14n, 0n),
    ]);
    const c = await get(
      app,
      `/public/v1/meme/${dynamic.instanceId}/candles?limit=300`,
    );
    expect(c.json()).toMatchObject({
      source: "pool",
      candles: [{ t: "2027-01-15T08:20:00.000Z", v: "0" }],
    });
    const d = await get(app, `/public/v1/meme/${official.instanceId}/candles`);
    expect(d.json()).toMatchObject({
      source: "pool",
      candles: [{ v: null }],
    });
    for (const [query, reasonCode] of [
      ["interval=1h", "PUBLIC_CANDLE_INTERVAL_UNSUPPORTED"],
      ["interval=", "PUBLIC_CANDLE_INTERVAL_UNSUPPORTED"],
      ["limit=301", "PUBLIC_LIMIT_INVALID"],
      ["limit=abc", "PUBLIC_LIMIT_INVALID"],
    ] as const) {
      const refused = await get(
        app,
        `/public/v1/meme/${curve.instanceId}/candles?${query}`,
      );
      expect(refused.statusCode).toBe(400);
      expect(refused.headers["access-control-allow-origin"]).toBe("*");
      expect(refused.headers["cache-control"]).toBe("no-store");
      expect(refused.json()).toEqual({ code: "INVALID_REQUEST", reasonCode });
    }
  });

  it("answers the CORS preflight with 204 and adds CORS only under /public", async () => {
    const { app } = await createApp();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/public/v1/meme",
      headers: {
        origin: "https://loop-meme.vercel.app",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers["access-control-allow-methods"]).toBe(
      "GET, OPTIONS",
    );
    const v2 = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
      headers: { ...s7CommonHeaders(), origin: "https://x.dev" },
    });
    expect(v2.headers["access-control-allow-origin"]).toBeUndefined();
    const v2Preflight = await app.inject({
      method: "OPTIONS",
      url: "/v2/launch2/instances",
      headers: {
        origin: "https://x.dev",
        "access-control-request-method": "GET",
      },
    });
    expect(v2Preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate-limits each client IP per one-minute window with Retry-After", async () => {
    const clock = { ms: 1_000_000 };
    const { app } = await createApp({ ratePerWindow: 2, clock });
    expect((await get(app, "/public/v1/meme")).statusCode).toBe(200);
    expect((await get(app, "/public/v1/meme?stage=all")).statusCode).toBe(200);
    clock.ms += 15_000;
    const limited = await get(app, "/public/v1/meme");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["access-control-allow-origin"]).toBe("*");
    expect(limited.headers["retry-after"]).toBe("45");
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.headers["x-ratelimit-limit"]).toBe("2");
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.json()).toEqual({
      code: "RATE_LIMITED",
      reasonCode: "PUBLIC_RATE_LIMITED",
    });
    // TRUST_PROXY is off: forwarded headers never open a new window.
    const forged = await app.inject({
      method: "GET",
      url: "/public/v1/meme",
      headers: {
        "x-forwarded-for": "198.51.100.77",
        "cf-connecting-ip": "198.51.100.78",
      },
    });
    expect(forged.statusCode).toBe(429);
    // Another IP has its own window.
    const other = await app.inject({
      method: "GET",
      url: "/public/v1/meme",
      remoteAddress: "203.0.113.9",
    });
    expect(other.statusCode).toBe(200);
    // A preflight is never counted.
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/public/v1/meme",
    });
    expect(preflight.statusCode).toBe(204);
    clock.ms += 45_000;
    expect((await get(app, "/public/v1/meme")).statusCode).toBe(200);
  });

  it("S211: behind a proxy, keys each visitor on the right-most public X-Forwarded-For", async () => {
    const clock = { ms: 1_000_000 };
    const { app } = await createApp({
      clock,
      env: { TRUST_PROXY: "true", PUBLIC_RATE_LIMIT_PER_MINUTE: "10" },
    });
    // Every request reaches Fastify from the proxy container's address.
    const viaProxy = (headers: Record<string, string>) =>
      app.inject({
        method: "GET",
        url: "/public/v1/meme",
        remoteAddress: "172.18.0.5",
        headers,
      });
    for (let index = 0; index < 10; index += 1) {
      expect(
        (await viaProxy({ "x-forwarded-for": "203.0.113.1" })).statusCode,
      ).toBe(200);
    }
    const limited = await viaProxy({ "x-forwarded-for": "203.0.113.1" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe("10");
    // A forged left part, or a forged cf-connecting-ip (not configured by
    // default), does not escape the visitor's window.
    expect(
      (await viaProxy({ "x-forwarded-for": "1.2.3.4, 203.0.113.1" }))
        .statusCode,
    ).toBe(429);
    expect(
      (
        await viaProxy({
          "x-forwarded-for": "203.0.113.1",
          "cf-connecting-ip": "198.51.100.9",
          "x-real-ip": "198.51.100.10",
        })
      ).statusCode,
    ).toBe(429);
    // Another visitor behind the same proxy has its own window.
    expect(
      (await viaProxy({ "x-forwarded-for": "203.0.113.2" })).statusCode,
    ).toBe(200);
  });

  it("S211: PUBLIC_CLIENT_IP_HEADERS can put cf-connecting-ip first", async () => {
    const { app } = await createApp({
      ratePerWindow: 1,
      env: {
        TRUST_PROXY: "true",
        PUBLIC_CLIENT_IP_HEADERS: "cf-connecting-ip,x-forwarded-for",
      },
    });
    const viaTunnel = (client: string) =>
      app.inject({
        method: "GET",
        url: "/public/v1/meme",
        remoteAddress: "172.18.0.6",
        headers: {
          "cf-connecting-ip": client,
          "x-forwarded-for": "162.158.1.1",
        },
      });
    expect((await viaTunnel("2001:db8::1")).statusCode).toBe(200);
    expect((await viaTunnel("2001:DB8:0:0:0:0:0:1")).statusCode).toBe(429);
    expect((await viaTunnel("2001:db8::2")).statusCode).toBe(200);
  });

  it("shares one answer per URL for 5 s", async () => {
    const record = graduatedInstance();
    const repository = seeded(record);
    const clock = { ms: 1_000_000 };
    const { app } = await createApp({ repository, clock });
    const url = `/public/v1/meme/${record.instanceId}`;
    await get(app, url);
    await get(app, url);
    expect(repository.publicFactsCalls).toHaveLength(1);
    clock.ms += 5_000;
    await get(app, url);
    expect(repository.publicFactsCalls).toHaveLength(2);
  });
});

describe("public MEME OpenAPI artifact (Decision 0147)", () => {
  it("is its own deterministic artifact with no security on the public routes", async () => {
    const [first, second, committed] = await Promise.all([
      renderOpenApiPublicArtifact(),
      renderOpenApiPublicArtifact(),
      readFile(openApiPublicArtifactPath, "utf8"),
    ]);
    expect(committed).toBe(first);
    expect(first).toBe(second);
    const document = JSON.parse(committed) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(Object.keys(document.paths).sort()).toEqual([
      "/health/live",
      "/health/ready",
      "/public/v1/meme",
      "/public/v1/meme/{instanceId}",
      "/public/v1/meme/{instanceId}/candles",
    ]);
    expect(document.components?.securitySchemes ?? {}).toEqual({});
    for (const path of Object.keys(document.paths).filter((key) =>
      key.startsWith("/public/"),
    )) {
      const operation = document.paths[path]?.["get"];
      expect(operation?.["security"]).toBeUndefined();
      expect(operation?.["tags"]).toEqual(["public"]);
      expect(operation?.["parameters"]).not.toContainEqual(
        expect.objectContaining({ name: "x-loop-contract-version" }),
      );
    }
  });
});

describe("public MEME helpers (Decision 0147)", () => {
  it("formats the 24 h change truncated to two decimals", () => {
    expect(launch2PublicChangePct(110n, 100n)).toBe("10.00");
    expect(launch2PublicChangePct(96_79n, 100_00n)).toBe("-3.21");
    expect(launch2PublicChangePct(99_999n, 100_000n)).toBe("0.00");
    expect(launch2PublicChangePct(1n, null)).toBeNull();
    expect(launch2PublicChangePct(1n, 0n)).toBeNull();
  });

  it("sorts saved links into website / x / telegram", () => {
    expect(
      launch2PublicSocials([
        "https://www.twitter.com/a",
        "https://x.com/b",
        "https://telegram.me/c",
        "https://a.example",
        "https://b.example",
      ]),
    ).toEqual({
      website: "https://a.example",
      x: "https://www.twitter.com/a",
      telegram: "https://telegram.me/c",
    });
    expect(launch2PublicSocials([])).toEqual({
      website: null,
      x: null,
      telegram: null,
    });
  });

  it("derives the slogan from the description's first line", () => {
    expect(launch2PublicSlogan(null)).toBeNull();
    expect(launch2PublicSlogan("  \n ")).toBeNull();
    expect(launch2PublicSlogan(`${"字".repeat(70)}\nmore`)).toBe(
      `${"字".repeat(60)}…`,
    );
  });

  it("converts the MEME fee at the last price, or gives up without one", () => {
    expect(
      launch2PublicTotalTaxUsd1({
        usd1Parts: [1n, 2n],
        memeFee: 0n,
        priceE18: null,
      }),
    ).toBe(3n);
    expect(
      launch2PublicTotalTaxUsd1({
        usd1Parts: [0n],
        memeFee: 10n * wad,
        priceE18: null,
      }),
    ).toBeNull();
  });
});
