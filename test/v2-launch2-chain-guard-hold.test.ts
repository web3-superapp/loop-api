import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  ChainGuardIncidentKind,
  ChainGuardIncidentRecord,
  ChainGuardRepository,
} from "../src/features/chain-guard/chain-guard-contract.js";
import { launch2TradingHoldOf } from "../src/features/launch2/launch2-trading-hold.js";
import { launch2InstanceDetailResourceSchema } from "../src/routes/v2/launch2-schemas.js";
import {
  launch2DynamicFactoryEnv,
  createFakeLaunch2DynamicChain,
  defaultDynamicState,
  graduatedDynamicInstance,
} from "./helpers/launch2-dynamic-fakes.js";
import {
  createFakeLaunch2Chain,
  createFakeLaunch2PoolChain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  defaultPoolState,
  launch2Env,
  launch2NowSeconds,
  launch2PoolEnv,
  launch2WritesEnv,
} from "./helpers/launch2-fakes.js";
import { walletId, walletsFake } from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
} from "./helpers/meme-service-fakes.js";
import {
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0136: under a chain guard hold (unresolved `usd1_paused` /
 * `usd1_address_frozen` on the launch chain) the six launch2 write paths
 * answer 503 CAPABILITY_UNAVAILABLE / LAUNCH2_USD1_PAUSED |
 * LAUNCH2_ADDRESS_FROZEN, the read routes and the claim report do not, and
 * the instance detail carries `tradingHold`.
 */

const launchChainId = "eip155:97";

function incident(
  kind: ChainGuardIncidentKind,
  firstSeenAt: string,
): ChainGuardIncidentRecord {
  return {
    incidentId: randomUUID(),
    chainId: launchChainId,
    kind,
    subject: "0x00000000000000000000000000000000000005d1",
    details: {},
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    resolvedAt: null,
    resolution: null,
    resolvedBy: null,
    resolutionNote: null,
  };
}

interface FakeHolds {
  holds: ChainGuardIncidentRecord[];
  fail: boolean;
  readonly calls: string[];
  readonly repository: ChainGuardRepository;
}

function fakeHolds(holds: ChainGuardIncidentRecord[] = []): FakeHolds {
  const state = {
    holds,
    fail: false,
    calls: [] as string[],
  };
  const repository = {
    listHolds: (chainId: string) => {
      state.calls.push(chainId);
      if (state.fail) return Promise.reject(new Error("db down"));
      return Promise.resolve(
        state.holds.filter((hold) => hold.chainId === chainId),
      );
    },
  } as unknown as ChainGuardRepository;
  return Object.assign(state, { repository });
}

const pausedAt = "2026-10-14T01:00:00.000Z";
const frozenAt = "2026-10-13T23:00:00.000Z";

describe("launch2 under the chain guard hold (Decision 0136)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(options: {
    readonly guard?: FakeHolds;
    readonly enabled?: boolean;
    readonly logLines?: string[];
  }) {
    const repository = createInMemoryLaunch2Repository();
    const record = graduatedDynamicInstance();
    repository.instances.set(record.instanceId, record);
    const lines = options.logLines;
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...launch2DynamicFactoryEnv,
        ...launch2PoolEnv,
        ...launch2WritesEnv,
        ...(options.enabled === false ? {} : { CHAIN_GUARD_ENABLED: "true" }),
      }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
        ...(options.guard === undefined
          ? {}
          : { chainGuard: options.guard.repository }),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: createFakeLaunch2Chain(defaultChainState()),
      launch2PoolChain: createFakeLaunch2PoolChain(defaultPoolState()),
      launch2DynamicChain: createFakeLaunch2DynamicChain(defaultDynamicState()),
      launchChainReadClient: createFakeMemeSlotClient(
        defaultMemeFunds({ usd1Allowance: 0n, tokenAllowance: 0n }),
      ),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger:
        lines === undefined
          ? false
          : {
              level: "warn",
              stream: { write: (line: string) => lines.push(line) },
            },
    });
    apps.push(app);
    return { app, id: record.instanceId };
  }

  const inject = (
    app: FastifyInstance,
    method: "GET" | "POST",
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    method === "GET"
      ? app.inject({ method, url, headers: s7CommonHeaders() })
      : app.inject({
          method,
          url,
          headers: s7CommandHeaders({ "idempotency-key": randomUUID() }),
          payload: payload ?? {},
        });

  const writes = (id: string) =>
    [
      [
        "GET",
        `/v2/launch2/instances/${id}/quote?side=buy&amount=10&walletId=${walletId}`,
      ],
      [
        "POST",
        `/v2/launch2/instances/${id}/trade/prepare`,
        {
          walletId,
          side: "buy",
          amount: "10",
          minOut: "1",
          deadline: new Date(
            Number(launch2NowSeconds + 60n) * 1000,
          ).toISOString(),
        },
      ],
      ["POST", `/v2/launch2/instances/${id}/nft/prepare`, { walletId }],
      [
        "GET",
        `/v2/launch2/instances/${id}/pool/quote?walletId=${walletId}&side=buy&mode=exactIn&amount=10`,
      ],
      [
        "POST",
        `/v2/launch2/instances/${id}/pool/trade/prepare`,
        {
          walletId,
          side: "buy",
          mode: "exactIn",
          amount: "10",
          slippageBps: 50,
        },
      ],
      [
        "POST",
        `/v2/launch2/instances/${id}/dynamic-pool/claim/prepare`,
        { walletId, roundId: "2" },
      ],
    ] as const;

  const reads = (id: string) =>
    [
      ["GET", `/v2/launch2/instances`],
      ["GET", `/v2/launch2/instances/${id}`],
      ["GET", `/v2/launch2/instances/${id}/dynamic-pool`],
      [
        "GET",
        `/v2/launch2/instances/${id}/dynamic-pool/rewards?walletId=${walletId}`,
      ],
      ["GET", `/v2/launch2/instances/${id}/pool/trades?walletId=${walletId}`],
      ["GET", `/v2/launch2/instances/${id}/buybacks`],
      ["GET", `/v2/launch2/me/positions`],
    ] as const;

  async function detailHold(app: FastifyInstance, id: string) {
    const response = await inject(app, "GET", `/v2/launch2/instances/${id}`);
    expect(response.statusCode).toBe(200);
    const instance = response.json<{ instance: Record<string, unknown> }>()
      .instance;
    expect(Object.hasOwn(instance, "tradingHold")).toBe(true);
    return instance["tradingHold"];
  }

  for (const [kind, reasonCode, since] of [
    ["usd1_paused", "LAUNCH2_USD1_PAUSED", pausedAt],
    ["usd1_address_frozen", "LAUNCH2_ADDRESS_FROZEN", frozenAt],
  ] as const) {
    it(`refuses the six write paths with 503 ${reasonCode}`, async () => {
      const guard = fakeHolds([incident(kind, since)]);
      const { app, id } = await createApp({ guard });
      for (const [method, url, payload] of writes(id)) {
        const response = await inject(app, method, url, payload);
        expect(response.statusCode, url).toBe(503);
        expect(response.json(), url).toMatchObject({
          code: "CAPABILITY_UNAVAILABLE",
          retryable: true,
          detailsSafe: { reasonCode, since },
        });
      }
      expect(new Set(guard.calls)).toEqual(new Set([launchChainId]));
    });
  }

  it("leaves the read routes and the claim report alone", async () => {
    const guard = fakeHolds([incident("usd1_paused", pausedAt)]);
    const { app, id } = await createApp({ guard });
    for (const [method, url] of reads(id)) {
      const response = await inject(app, method, url);
      expect(response.statusCode, url).toBe(200);
    }
    const report = await inject(
      app,
      "POST",
      `/v2/launch2/instances/${id}/dynamic-pool/claim/report`,
      { intentId: randomUUID(), transactionHash: `0x${"ab".repeat(32)}` },
    );
    expect(report.statusCode).not.toBe(503);
    expect(JSON.stringify(report.json())).not.toContain("LAUNCH2_USD1_PAUSED");
  });

  it("shows tradingHold null / usd1_paused / address_frozen, paused first", async () => {
    const guard = fakeHolds([]);
    const { app, id } = await createApp({ guard });
    expect(await detailHold(app, id)).toBeNull();
    guard.holds = [incident("usd1_address_frozen", frozenAt)];
    expect(await detailHold(app, id)).toEqual({
      kind: "address_frozen",
      since: frozenAt,
    });
    guard.holds = [
      incident("usd1_address_frozen", frozenAt),
      incident("usd1_paused", pausedAt),
    ];
    expect(await detailHold(app, id)).toEqual({
      kind: "usd1_paused",
      since: pausedAt,
    });
    // Another chain's hold is not ours.
    guard.holds = [
      { ...incident("usd1_paused", pausedAt), chainId: "eip155:56" },
    ];
    expect(await detailHold(app, id)).toBeNull();
    expect(
      launch2InstanceDetailResourceSchema.properties.instance.required,
    ).toContain("tradingHold");
  });

  it("applies no hold with CHAIN_GUARD_ENABLED off", async () => {
    const guard = fakeHolds([incident("usd1_paused", pausedAt)]);
    const { app, id } = await createApp({ guard, enabled: false });
    expect(await detailHold(app, id)).toBeNull();
    const quote = await inject(
      app,
      "GET",
      `/v2/launch2/instances/${id}/pool/quote?walletId=${walletId}&side=buy&mode=exactIn&amount=10`,
    );
    expect(quote.statusCode).toBe(200);
    expect(guard.calls).toEqual([]);
  });

  it("applies no hold without a chain guard repository", async () => {
    const { app, id } = await createApp({});
    expect(await detailHold(app, id)).toBeNull();
    const claim = await inject(
      app,
      "POST",
      `/v2/launch2/instances/${id}/dynamic-pool/claim/prepare`,
      { walletId, roundId: "2" },
    );
    expect(claim.statusCode).toBe(201);
  });

  it("refuses writes 503 CHAIN_GUARD_REPOSITORY_UNAVAILABLE when the hold cannot be read, and warns once", async () => {
    const guard = fakeHolds([]);
    guard.fail = true;
    const lines: string[] = [];
    const { app, id } = await createApp({ guard, logLines: lines });
    for (const [method, url, payload] of writes(id)) {
      const response = await inject(app, method, url, payload);
      expect(response.statusCode, url).toBe(503);
      expect(response.json(), url).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "CHAIN_GUARD_REPOSITORY_UNAVAILABLE" },
      });
    }
    expect(await detailHold(app, id)).toBeNull();
    const warned = () =>
      lines.filter((line) =>
        line.includes("launch2.chain_guard_hold_unreadable"),
      ).length;
    expect(warned()).toBe(1);
    // Recovery re-arms the warning.
    guard.fail = false;
    expect(await detailHold(app, id)).toBeNull();
    guard.fail = true;
    expect(await detailHold(app, id)).toBeNull();
    expect(warned()).toBe(2);
  });
});

describe("launch2TradingHoldOf (Decision 0136)", () => {
  it("prefers usd1_paused and the earliest first_seen_at within a kind", () => {
    expect(launch2TradingHoldOf([])).toBeNull();
    expect(
      launch2TradingHoldOf([
        incident("usd1_address_frozen", "2026-10-14T02:00:00.000Z"),
        incident("usd1_address_frozen", frozenAt),
      ]),
    ).toEqual({ kind: "address_frozen", since: frozenAt });
    expect(
      launch2TradingHoldOf([
        incident("usd1_address_frozen", frozenAt),
        incident("usd1_paused", "2026-10-14T03:00:00.000Z"),
        incident("usd1_paused", pausedAt),
      ]),
    ).toEqual({ kind: "usd1_paused", since: pausedAt });
  });
});
