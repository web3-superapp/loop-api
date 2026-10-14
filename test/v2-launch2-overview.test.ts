import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  launch2WeekStart,
  projectLaunch2Overview,
} from "../src/features/launch2/launch2-overview.js";
import type {
  Launch2ActivityKind,
  Launch2ActivityRecord,
} from "../src/features/launch2/launch2-ports.js";
import { launch2OverviewResourceSchema } from "../src/routes/v2/launch2-schemas.js";
import {
  createFakeLaunch2Chain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  graduatedInstance,
  instanceFixture,
  launch2Env,
  launch2NowSeconds,
  priorityInstance,
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
 * Decision 0139: `GET /v2/launch2/overview` — the seven activity kinds,
 * order and cap, anonymous actors, the stage counts (the list's derivation)
 * with the UTC-Monday week boundary, and the empty read model.
 */

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const now = new Date(Number(launch2NowSeconds) * 1000);
// 2027-01-15T08:00:00Z is a Friday; the week starts Monday 2027-01-11.
const weekStartSeconds = 1_799_625_600n;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const trader = "0x1234567890abcdef1234567890abcdef12345678";

function activity(
  kind: Launch2ActivityKind,
  overrides: Partial<Launch2ActivityRecord> = {},
): Launch2ActivityRecord {
  return {
    kind,
    instanceId: "8d7b8d64-35a6-4cb8-9b8f-2d0e3f6a1c11",
    ticker: "FROG",
    name: "Frog Launch",
    logoUrl: "https://example.com/frog.png",
    actor: trader,
    amountUsd1: (20n * wad).toString(10),
    at: iso(launch2NowSeconds - 60n),
    transactionHash: hash("ab"),
    blockNumber: "1000",
    logIndex: 1,
    ...overrides,
  };
}

describe("V2 launch2 overview (Decision 0139)", () => {
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

  const get = (app: FastifyInstance, url = "/v2/launch2/overview") =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });

  it("answers the empty read model with zero counts and no activity", async () => {
    const app = await createApp(createInMemoryLaunch2Repository());
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(body).toEqual({
      activity: [],
      stats: {
        liveCount: 0,
        mintingCount: 0,
        priorityCount: 0,
        curveCount: 0,
        upcomingCount: 0,
        graduatedTotal: 0,
        graduatedThisWeek: 0,
        buybackUsd1Total: "0",
        nftMintedTotal: 0,
      },
      observedAt: now.toISOString(),
      contractVersion: expect.any(String) as unknown,
    });
    expect(Object.keys(body).sort()).toEqual(
      [...launch2OverviewResourceSchema.required].sort(),
    );
  });

  it("projects each of the seven kinds with its amount and actor", async () => {
    const repository = createInMemoryLaunch2Repository();
    const at = (offset: bigint) => iso(launch2NowSeconds - offset);
    repository.activity.push(
      activity("curve_buy", {
        at: at(10n),
        amountUsd1: "20500000000000000000",
      }),
      activity("curve_sell", {
        at: at(20n),
        amountUsd1: (9n * wad).toString(),
      }),
      // An anonymous official-pool swap (Decision 0132): actor null.
      activity("curve_buy", { at: at(25n), actor: null, logIndex: 3 }),
      activity("nft_mint", {
        at: at(30n),
        amountUsd1: (100n * wad).toString(),
      }),
      activity("graduated", {
        at: at(40n),
        actor: null,
        amountUsd1: null,
        logIndex: null,
      }),
      activity("buyback", {
        at: at(50n),
        actor: null,
        amountUsd1: (125n * wad).toString(),
      }),
      activity("round_activated", {
        at: at(60n),
        actor: null,
        amountUsd1: null,
        logIndex: null,
        transactionHash: hash("cd"),
      }),
      activity("reward_claimed", {
        at: at(70n),
        amountUsd1: "1250000000000000",
      }),
    );
    const app = await createApp(repository);
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ activity: Record<string, unknown>[] }>()
      .activity;
    expect(
      rows.map((row) => [row["kind"], row["actor"], row["amountUsd1"]]),
    ).toEqual([
      ["curve_buy", trader, "20.5"],
      ["curve_sell", trader, "9"],
      ["curve_buy", null, "20"],
      ["nft_mint", trader, "100"],
      ["graduated", null, null],
      ["buyback", null, "125"],
      ["round_activated", null, null],
      ["reward_claimed", trader, "0.00125"],
    ]);
    expect(rows[0]).toEqual({
      kind: "curve_buy",
      instanceId: "8d7b8d64-35a6-4cb8-9b8f-2d0e3f6a1c11",
      ticker: "FROG",
      name: "Frog Launch",
      logoUrl: "https://example.com/frog.png",
      actor: trader,
      amountUsd1: "20.5",
      at: at(10n),
      transactionHash: hash("ab"),
    });
  });

  it("orders newest first (block, log index as tie-breaks) and keeps at most 30", () => {
    const rows: Launch2ActivityRecord[] = [];
    for (let index = 0; index < 45; index += 1) {
      rows.push(
        activity("curve_buy", {
          at: iso(launch2NowSeconds - BigInt((index * 7) % 45) * 10n),
          blockNumber: String(1000 + index),
          logIndex: index,
        }),
      );
    }
    // Same second as the newest: the higher block wins, a null block last.
    rows.push(
      activity("graduated", {
        at: iso(launch2NowSeconds),
        blockNumber: null,
        logIndex: null,
        actor: null,
        amountUsd1: null,
      }),
      activity("nft_mint", {
        at: iso(launch2NowSeconds),
        blockNumber: "99999",
        logIndex: 0,
      }),
    );
    const overview = projectLaunch2Overview({ activity: rows, facts: [], now });
    const list = overview["activity"] as Record<string, unknown>[];
    expect(list).toHaveLength(30);
    expect(list[0]?.["kind"]).toBe("nft_mint");
    expect(list[1]?.["kind"]).toBe("curve_buy");
    expect(list[2]?.["kind"]).toBe("graduated");
    const times = list.map((row) => Date.parse(row["at"] as string));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("counts stages with the list's derivation and the UTC-Monday week", async () => {
    const repository = createInMemoryLaunch2Repository();
    const add = (record: ReturnType<typeof instanceFixture>) =>
      repository.instances.set(record.instanceId, record);
    // nft_sale ×2 (fixture: started an hour ago, 7-day sale), 2 NFTs each.
    add(instanceFixture());
    add(instanceFixture());
    // upcoming (stored stage is stale on purpose: derivation wins).
    add(
      instanceFixture({
        nftSaleStart: iso(launch2NowSeconds + 3_600n),
        nftSaleEnd: iso(launch2NowSeconds + 3_600n + 604_800n),
        stage: "nft_sale",
        nftMintedCount: "0",
      }),
    );
    // priority ×1, public ×1 (published 2 hours ago).
    add(priorityInstance({ nftMintedCount: "5" }));
    const publicRow = priorityInstance({ nftMintedCount: "1" });
    add({
      ...publicRow,
      snapshot:
        publicRow.snapshot === null
          ? null
          : {
              ...publicRow.snapshot,
              publishedAt: iso(launch2NowSeconds - 7_200n),
            },
    });
    // graduated: one on the week boundary, one a second before it.
    const graduated = (at: bigint, usd1: bigint) => {
      const row = graduatedInstance({ nftMintedCount: "3" });
      return {
        ...row,
        graduation:
          row.graduation === null
            ? null
            : { ...row.graduation, graduatedAt: iso(at) },
        buyback: { ...row.buyback, usd1: usd1.toString(10) },
      };
    };
    add(graduated(weekStartSeconds, 125n * wad));
    add(graduated(weekStartSeconds - 1n, wad / 2n));
    // paused (hold) and not listed (no activation): not counted as live.
    add(instanceFixture({ holdReason: "LAUNCH2_ACTIVATION_MISSING" }));
    add(instanceFixture({ activatedAt: null, nftMintedCount: "9" }));
    const app = await createApp(repository);
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ stats: unknown }>().stats).toEqual({
      liveCount: 4,
      mintingCount: 2,
      priorityCount: 1,
      curveCount: 1,
      upcomingCount: 1,
      graduatedTotal: 2,
      graduatedThisWeek: 1,
      buybackUsd1Total: "125.5",
      nftMintedTotal: 2 + 2 + 0 + 5 + 1 + 3 + 3 + 2,
    });
  });

  it("starts the week at the server's UTC Monday 00:00", () => {
    expect(launch2WeekStart(now).toISOString()).toBe(iso(weekStartSeconds));
    expect(
      launch2WeekStart(new Date("2027-01-11T00:00:00.000Z")).toISOString(),
    ).toBe("2027-01-11T00:00:00.000Z");
    expect(
      launch2WeekStart(new Date("2027-01-10T23:59:59.999Z")).toISOString(),
    ).toBe("2027-01-04T00:00:00.000Z");
    expect(
      launch2WeekStart(new Date("2027-01-17T23:59:59.000Z")).toISOString(),
    ).toBe("2027-01-11T00:00:00.000Z");
  });

  it("answers 503 with the reason while the Factory is not configured", async () => {
    const app = await buildApp({
      config: s7TestConfig({ V2_MODULES_ENABLED: "launch2" }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: createInMemoryLaunch2Repository(),
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      logger: false,
    });
    apps.push(app);
    const response = await get(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: { reasonCode: "LAUNCH2_FACTORY_NOT_CONFIGURED" },
    });
  });

  it("refuses a query string", async () => {
    const app = await createApp(createInMemoryLaunch2Repository());
    const response = await get(app, "/v2/launch2/overview?limit=5");
    expect(response.statusCode).toBe(400);
  });
});
