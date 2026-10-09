import { parse } from "lossless-json";
import { describe, expect, it, vi } from "vitest";

import { createPerpPrivateReadCursorCodec } from "../src/features/perp/private-read-cursor.js";
import { createPerpPrivateReadService } from "../src/features/perp/private-read-service.js";
import {
  createHyperliquidInfoPrivateReader,
  HYPERLIQUID_INFO_WEIGHT,
  type HyperliquidInfoQuota,
} from "../src/integrations/hyperliquid/info-private-reader.js";
import type {
  HyperliquidInfoRequest,
  HyperliquidLosslessInfoTransport,
} from "../src/integrations/hyperliquid/lossless-info-transport.js";
import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
  type HyperliquidPrivateReadInput,
  type HyperliquidPrivateReadKind,
} from "../src/integrations/hyperliquid/private-reader.js";

const nowIso = "2026-08-25T04:00:00.000Z";
const initialNow = Date.parse(nowIso);
const sevenDays = 7 * 24 * 60 * 60 * 1_000;
const accountAddress = `0x${"12".repeat(20)}`;
const attemptId = "12345678-1234-4123-8123-123456789abc";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashA = `0x${"aa".repeat(32)}`;
const hashB = `0x${"bb".repeat(32)}`;
const cloidA = `0x${"11".repeat(16)}`;

function raw(text: string): unknown {
  return parse(text);
}

function meta(overrides = ""): unknown {
  return raw(`{
    "universe":[
      {"szDecimals":5,"name":"BTC","maxLeverage":40,"marginTableId":0},
      {"szDecimals":4,"name":"ETH","maxLeverage":25,"marginTableId":0},
      {"szDecimals":2,"name":"SOL","maxLeverage":20,"marginTableId":0,"onlyIsolated":true${overrides}}
    ],
    "marginTables":[[0,{"description":"","marginTiers":[{"lowerBound":"0.0","maxLeverage":40}]}]],
    "collateralToken":0
  }`);
}

function marginSummary(): string {
  return `{
    "accountValue":"1000.25",
    "totalNtlPos":"740.005",
    "totalRawUsd":"1000.25",
    "totalMarginUsed":"263.335"
  }`;
}

function position(
  coin: string,
  size: string,
  leverage: string,
  entryPrice: string,
): string {
  const isolated = leverage === "isolated";
  return `{
    "type":"oneWay",
    "position":{
      "coin":"${coin}",
      "szi":"${size}",
      "leverage":${
        isolated
          ? '{"type":"isolated","value":2,"rawUsd":"50"}'
          : '{"type":"cross","value":3}'
      },
      "entryPx":"${entryPrice}",
      "positionValue":"${coin === "BTC" ? "640.005" : "100"}",
      "unrealizedPnl":"${coin === "BTC" ? "10.25" : "-1"}",
      "returnOnEquity":"${coin === "BTC" ? "0.05" : "-0.01"}",
      "liquidationPx":${coin === "BTC" ? '"51000"' : "null"},
      "marginUsed":"${coin === "BTC" ? "213.335" : "50"}",
      "maxLeverage":${coin === "BTC" ? "40" : "25"},
      "cumFunding":{"allTime":"0","sinceOpen":"0","sinceChange":"0"}
    }
  }`;
}

function clearinghouse(positions?: readonly string[]): unknown {
  const items = positions ?? [
    position("BTC", "0.01", "cross", "64000.5"),
    position("ETH", "-0.2", "isolated", "3000"),
  ];
  return raw(`{
    "marginSummary":${marginSummary()},
    "crossMarginSummary":${marginSummary()},
    "crossMaintenanceMarginUsed":"2.5",
    "withdrawable":"974.75",
    "assetPositions":[${items.join(",")}],
    "time":${initialNow - 10}
  }`);
}

function order(
  oid: string,
  coin: string,
  timestamp: number,
  extra = "",
): string {
  return `{
    "coin":"${coin}",
    "side":"B",
    "limitPx":"63000",
    "sz":"0.03",
    "oid":${oid},
    "timestamp":${timestamp},
    "origSz":"0.10",
    "triggerCondition":"N/A",
    "isTrigger":false,
    "triggerPx":"0.0",
    "children":[],
    "isPositionTpsl":false,
    "reduceOnly":false,
    "orderType":"Limit",
    "tif":"Gtc",
    "cloid":"${cloidA}"${extra}
  }`;
}

function fill(
  tid: string,
  oid: string,
  coin: string,
  time: number,
  hash: string,
  extra = "",
): string {
  return `{
    "coin":"${coin}",
    "px":"64000",
    "sz":"0.01",
    "side":"B",
    "time":${time},
    "startPosition":"0",
    "dir":"Open Long",
    "closedPnl":"0",
    "hash":"${hash}",
    "oid":${oid},
    "crossed":true,
    "fee":"0.224",
    "tid":${tid},
    "feeToken":"USDC",
    "twapId":null${extra}
  }`;
}

function funding(coin: string, time: number, hash: string, extra = ""): string {
  return `{
    "time":${time},
    "hash":"${hash}",
    "delta":{
      "type":"funding",
      "coin":"${coin}",
      "usdc":"-0.008",
      "szi":"0.01",
      "fundingRate":"0.0000125",
      "nSamples":null${extra}
    }
  }`;
}

interface HarnessOptions {
  readonly responses?: Partial<Record<HyperliquidInfoRequest["type"], unknown>>;
  readonly reserveFailure?: Error;
  readonly transportFailure?: Error;
}

function harness(options: HarnessOptions = {}) {
  let nowMilliseconds = initialNow;
  const reserveWeight = vi.fn<HyperliquidInfoQuota["reserveWeight"]>(
    (_cost, signal) => {
      signal.throwIfAborted();
      return options.reserveFailure === undefined
        ? Promise.resolve()
        : Promise.reject(options.reserveFailure);
    },
  );
  const defaults: Record<HyperliquidInfoRequest["type"], unknown> = {
    meta: meta(),
    clearinghouseState: clearinghouse(),
    frontendOpenOrders: raw("[]"),
    userFillsByTime: raw("[]"),
    userFunding: raw("[]"),
    orderStatus: raw('{"status":"unknownOid"}'),
  };
  const post = vi.fn<HyperliquidLosslessInfoTransport["post"]>(
    (request, signal) => {
      signal.throwIfAborted();
      if (options.transportFailure !== undefined) {
        return Promise.reject(options.transportFailure);
      }
      return Promise.resolve(
        options.responses?.[request.type] ?? defaults[request.type],
      );
    },
  );
  const reader = createHyperliquidInfoPrivateReader({
    quota: { reserveWeight },
    transport: { post },
    now: () => new Date(nowMilliseconds),
  });

  return {
    post,
    reader,
    reserveWeight,
    setNow(value: number) {
      nowMilliseconds = value;
    },
  };
}

function input(
  kind: HyperliquidPrivateReadKind,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): HyperliquidPrivateReadInput {
  const base = {
    network: "testnet",
    dex: "",
    accountAddress,
    transportAttemptId: attemptId,
    signal: new AbortController().signal,
  } as const;
  if (kind === "config" || kind === "account") {
    return { ...base, kind };
  }
  return options.cursor === undefined
    ? { ...base, kind, limit: options.limit ?? (kind === "positions" ? 3 : 20) }
    : {
        ...base,
        kind,
        limit: options.limit ?? (kind === "positions" ? 3 : 20),
        providerCursorState: options.cursor,
      };
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function items(value: unknown): Record<string, unknown>[] {
  return record(value)["items"] as Record<string, unknown>[];
}

describe("Hyperliquid Info private reader", () => {
  it("maps strict Core meta and caches it only through its 60-second expiry", async () => {
    const inputs = harness();

    const first = record(await inputs.reader.read(input("config")));
    expect(first).toMatchObject({
      scope: {
        network: "testnet",
        market: "core_perps",
        dex: "",
        coins: ["BTC", "ETH", "SOL"],
      },
      assets: [
        {
          coin: "BTC",
          size_decimals: 5,
          size_increment: "0.00001",
          max_leverage: "40",
          margin_mode: "cross_and_isolated",
          minimum_order_notional_usdc: { state: "unavailable" },
        },
        {
          coin: "ETH",
          size_increment: "0.0001",
        },
        {
          coin: "SOL",
          size_increment: "0.01",
          margin_mode: "isolated_only",
        },
      ],
      fees: {
        maker_rate: { state: "unavailable" },
        taker_rate: { state: "unavailable" },
      },
      capabilities: {
        private_reads: "available",
        trading_mutations: "disabled",
      },
      source: {
        fetched_at: nowIso,
        expires_at: "2026-08-25T04:01:00.000Z",
      },
    });
    expect(inputs.reserveWeight).toHaveBeenCalledWith(
      HYPERLIQUID_INFO_WEIGHT.meta,
      expect.any(AbortSignal),
    );

    inputs.setNow(initialNow + 59_999);
    await inputs.reader.read(input("config"));
    expect(inputs.post).toHaveBeenCalledTimes(1);

    inputs.setNow(initialNow + 60_000);
    await inputs.reader.read(input("config"));
    expect(inputs.post).toHaveBeenCalledTimes(2);
    expect(inputs.reserveWeight).toHaveBeenCalledTimes(2);
  });

  it("assigns a fresh internal UUID to every actual provider call", async () => {
    const inputs = harness();

    await inputs.reader.read(input("account"));
    const missCallIds = inputs.post.mock.calls.map((call) => call[2]);
    expect(missCallIds).toHaveLength(2);
    expect(missCallIds).toEqual([
      expect.stringMatching(uuidPattern),
      expect.stringMatching(uuidPattern),
    ]);
    expect(new Set(missCallIds).size).toBe(2);
    expect(missCallIds).not.toContain(attemptId);

    inputs.post.mockClear();
    await inputs.reader.read(input("account"));
    const hitCallIds = inputs.post.mock.calls.map((call) => call[2]);
    expect(hitCallIds).toEqual([expect.stringMatching(uuidPattern)]);
    expect(missCallIds).not.toContain(hitCallIds[0]);
  });

  it("maps account and live-keyset positions without trusting client authority", async () => {
    const inputs = harness();
    const account = record(await inputs.reader.read(input("account")));
    expect(account).toMatchObject({
      margin_summary: {
        account_value: "1000.25",
        total_margin_used: "263.335",
        total_notional_position: "740.005",
        total_raw_usd: "1000.25",
      },
      withdrawable: "974.75",
      cross_maintenance_margin_used: "2.5",
    });

    const first = record(
      await inputs.reader.read(input("positions", { limit: 1 })),
    );
    expect(items(first)).toEqual([
      expect.objectContaining({
        coin: "BTC",
        side: "long",
        size: "0.01",
        position_mode: "one_way",
      }),
    ]);
    expect(first["next_provider_cursor_state"]).toEqual(expect.any(String));

    const second = await inputs.reader.read(
      input("positions", {
        limit: 1,
        cursor: first["next_provider_cursor_state"] as string,
      }),
    );
    expect(items(second)).toEqual([
      expect.objectContaining({
        coin: "ETH",
        side: "short",
        size: "0.2",
        leverage: { mode: "isolated", value: "2", raw_usd: "50" },
      }),
    ]);
    expect(inputs.reserveWeight.mock.calls.map(([cost]) => cost)).toEqual([
      20, 2, 2, 2,
    ]);
    expect(inputs.post.mock.calls[1]?.[0]).toEqual({
      type: "clearinghouseState",
      user: accountAddress,
      dex: "",
    });
  });

  it("preserves exact uint64 order IDs and pages by time plus ID", async () => {
    const orderTime = initialNow - 1_000;
    const max = "18446744073709551615";
    const beforeMax = "18446744073709551614";
    const inputs = harness({
      responses: {
        frontendOpenOrders: raw(
          `[${order(beforeMax, "ETH", orderTime).replace(
            cloidA,
            `0x${"22".repeat(16)}`,
          )},${order(max, "BTC", orderTime)}]`,
        ),
      },
    });

    const first = record(
      await inputs.reader.read(input("orders", { limit: 1 })),
    );
    expect(items(first)[0]).toMatchObject({
      order_id: max,
      client_order_id: cloidA,
      coin: "BTC",
      order_type: "limit",
      time_in_force: "gtc",
      status: "open",
    });
    const second = await inputs.reader.read(
      input("orders", {
        limit: 1,
        cursor: first["next_provider_cursor_state"] as string,
      }),
    );
    expect(items(second)[0]?.["order_id"]).toBe(beforeMax);
  });

  it("freezes the seven-day fill window across exact-tuple pages", async () => {
    const filledAt = initialNow - 1_000;
    const max = "18446744073709551615";
    const beforeMax = "18446744073709551614";
    const inputs = harness({
      responses: {
        userFillsByTime: raw(
          `[${fill(
            beforeMax,
            "20",
            "ETH",
            filledAt,
            hashB,
          )},${fill(max, max, "BTC", filledAt, hashA)}]`,
        ),
      },
    });

    const first = record(
      await inputs.reader.read(input("fills", { limit: 1 })),
    );
    expect(items(first)[0]).toMatchObject({
      trade_id: max,
      order_id: max,
      coin: "BTC",
      fee_asset: "USDC",
    });
    expect(first["coverage"]).toEqual({
      kind: "recent_window",
      started_at: new Date(initialNow - sevenDays).toISOString(),
      ended_at: nowIso,
      truncated: false,
    });
    const firstRequest = inputs.post.mock.calls.find(
      ([request]) => request.type === "userFillsByTime",
    )?.[0];

    inputs.setNow(initialNow + 1_000);
    const second = await inputs.reader.read(
      input("fills", {
        limit: 1,
        cursor: first["next_provider_cursor_state"] as string,
      }),
    );
    expect(items(second)[0]?.["trade_id"]).toBe(beforeMax);
    const fillRequests = inputs.post.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === "userFillsByTime");
    expect(fillRequests).toHaveLength(2);
    expect(fillRequests[1]).toEqual(firstRequest);
  });

  it("sorts funding by time then Core coin and freezes its window cursor", async () => {
    const settledAt = initialNow - 1_000;
    const inputs = harness({
      responses: {
        userFunding: raw(
          `[${funding("ETH", settledAt, hashB)},${funding(
            "BTC",
            settledAt,
            hashA,
          )}]`,
        ),
      },
    });

    const first = record(
      await inputs.reader.read(input("funding", { limit: 1 })),
    );
    expect(items(first)[0]).toMatchObject({
      coin: "BTC",
      transaction_hash: hashA,
      payment_usdc: "-0.008",
    });
    const second = await inputs.reader.read(
      input("funding", {
        limit: 1,
        cursor: first["next_provider_cursor_state"] as string,
      }),
    );
    expect(items(second)[0]?.["coin"]).toBe("ETH");
  });

  it.each([
    [
      "non-Core position",
      "positions",
      {
        clearinghouseState: clearinghouse([
          position("AVAX", "1", "cross", "10"),
        ]),
      },
    ],
    [
      "trigger order",
      "orders",
      {
        frontendOpenOrders: raw(
          `[${order("20", "BTC", initialNow - 1_000, ',"unexpected":true')}]`,
        ),
      },
    ],
    [
      "builder fill",
      "fills",
      {
        userFillsByTime: raw(
          `[${fill("30", "20", "BTC", initialNow - 1_000, hashA, ',"builderFee":"0.01"')}]`,
        ),
      },
    ],
    [
      "TWAP fill",
      "fills",
      {
        userFillsByTime: raw(
          `[${fill("30", "20", "BTC", initialNow - 1_000, hashA).replace('"twapId":null', '"twapId":123')}]`,
        ),
      },
    ],
    [
      "Spot fill",
      "fills",
      {
        userFillsByTime: raw(
          `[${fill("30", "20", "@107", initialNow - 1_000, hashA)}]`,
        ),
      },
    ],
    [
      "HIP-3 funding",
      "funding",
      {
        userFunding: raw(
          `[${funding("xyz:XYZ100", initialNow - 1_000, hashA)}]`,
        ),
      },
    ],
  ] as const)("fails closed for %s", async (_label, kind, responses) => {
    const inputs = harness({ responses });
    await expect(
      inputs.reader.read(input(kind, { limit: kind === "positions" ? 3 : 20 })),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
  });

  it("rejects duplicate or delisted Core meta before any private request", async () => {
    const duplicate = raw(`{
      "universe":[
        {"szDecimals":5,"name":"BTC","maxLeverage":40,"marginTableId":0},
        {"szDecimals":5,"name":"BTC","maxLeverage":40,"marginTableId":0},
        {"szDecimals":4,"name":"ETH","maxLeverage":25,"marginTableId":0},
        {"szDecimals":2,"name":"SOL","maxLeverage":20,"marginTableId":0}
      ],
      "marginTables":[[0,{"description":"","marginTiers":[{"lowerBound":"0","maxLeverage":40}]}]],
      "collateralToken":0
    }`);
    const duplicateInputs = harness({ responses: { meta: duplicate } });
    await expect(
      duplicateInputs.reader.read(input("account")),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
    expect(duplicateInputs.post).toHaveBeenCalledTimes(1);

    const delistedInputs = harness({
      responses: { meta: meta(',"isDelisted":true') },
    });
    await expect(
      delistedInputs.reader.read(input("config")),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
  });

  it("reserves conservative provider weight before every actual request", async () => {
    const inputs = harness();
    await inputs.reader.read(input("funding", { limit: 20 }));

    expect(inputs.reserveWeight.mock.calls.map(([cost]) => cost)).toEqual([
      HYPERLIQUID_INFO_WEIGHT.meta,
      HYPERLIQUID_INFO_WEIGHT.userFunding,
    ]);
    expect(inputs.reserveWeight.mock.invocationCallOrder[0]).toBeLessThan(
      inputs.post.mock.invocationCallOrder[0] ?? 0,
    );
    expect(inputs.reserveWeight.mock.invocationCallOrder[1]).toBeLessThan(
      inputs.post.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it("sanitizes quota failure before fetch and preserves transport retry classification", async () => {
    const quotaFailure = harness({
      reserveFailure: new Error(`quota ${accountAddress}`),
    });
    await expect(
      quotaFailure.reader.read(input("account")),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
    expect(quotaFailure.post).not.toHaveBeenCalled();

    const retryable = new RetryableHyperliquidReadError("provider_5xx");
    const transportFailure = harness({ transportFailure: retryable });
    await expect(transportFailure.reader.read(input("account"))).rejects.toBe(
      retryable,
    );
  });

  it("preserves an outer abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("request stopped");
    controller.abort(reason);
    const inputs = harness();
    const readInput = {
      ...input("config"),
      signal: controller.signal,
    } satisfies HyperliquidPrivateReadInput;

    await expect(inputs.reader.read(readInput)).rejects.toBe(reason);
    expect(inputs.reserveWeight).not.toHaveBeenCalled();
  });

  it("marks exact provider caps as truncated without inventing older history", async () => {
    const fillRows = Array.from({ length: 2_000 }, (_, index) =>
      fill(
        String(10_000 + index),
        String(20_000 + index),
        coreCoinAt(index),
        initialNow - index,
        `0x${index.toString(16).padStart(64, "0")}`,
      ),
    );
    const fillInputs = harness({
      responses: { userFillsByTime: raw(`[${fillRows.join(",")}]`) },
    });
    const fillPage = record(
      await fillInputs.reader.read(input("fills", { limit: 50 })),
    );
    expect(record(fillPage["coverage"])["truncated"]).toBe(true);
    expect(items(fillPage)).toHaveLength(50);

    const fundingRows = Array.from({ length: 500 }, (_, index) =>
      funding(
        coreCoinAt(index),
        initialNow - index,
        `0x${(index + 3_000).toString(16).padStart(64, "0")}`,
      ),
    );
    const fundingInputs = harness({
      responses: { userFunding: raw(`[${fundingRows.join(",")}]`) },
    });
    const fundingPage = record(
      await fundingInputs.reader.read(input("funding", { limit: 50 })),
    );
    expect(record(fundingPage["coverage"])["truncated"]).toBe(true);
    expect(items(fundingPage)).toHaveLength(50);
  });

  it("produces all six shapes accepted by the existing service boundary", async () => {
    const inputs = harness();
    const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
    const privyUserId = "did:privy:verified-user";
    const service = createPerpPrivateReadService({
      bindingResolver: {
        resolve: () =>
          Promise.resolve({
            ownerUserId,
            privyUserId,
            accountAddress,
            accountKind: "master",
            bindingVersion: "1",
            verifiedAt: new Date(initialNow - 1_000).toISOString(),
            expiresAt: new Date(initialNow + 60_000).toISOString(),
          }),
      },
      cursorCodec: createPerpPrivateReadCursorCodec({
        secret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        now: () => new Date(initialNow),
      }),
      reader: inputs.reader,
      now: () => new Date(initialNow),
    });
    const principal = {
      userId: ownerUserId,
      privyUserId,
      streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
    } as const;

    for (const kind of [
      "config",
      "account",
      "positions",
      "orders",
      "fills",
      "funding",
    ] as const) {
      await expect(
        service.read({
          principal,
          kind,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeDefined();
    }
  });
});

function coreCoinAt(index: number): "BTC" | "ETH" | "SOL" {
  return ["BTC", "ETH", "SOL"][index % 3] as "BTC" | "ETH" | "SOL";
}
