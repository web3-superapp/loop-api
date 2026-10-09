import { parse } from "lossless-json";
import { describe, expect, it, vi } from "vitest";

import type { PerpReconciliationSubject } from "../src/features/perp/perp-reconciliation-contract.js";
import type { HyperliquidInfoQuota } from "../src/integrations/hyperliquid/info-private-reader.js";
import type { HyperliquidInfoRequest } from "../src/integrations/hyperliquid/lossless-info-transport.js";
import type { HyperliquidLosslessInfoTransport } from "../src/integrations/hyperliquid/lossless-info-transport.js";
import {
  createHyperliquidPerpOrderReconciliationReader,
  HYPERLIQUID_PERP_ORDER_RECONCILIATION_INFO_WEIGHT,
} from "../src/integrations/hyperliquid/perp-order-reconciliation-reader.js";
import { RetryableHyperliquidReadError } from "../src/integrations/hyperliquid/private-reader.js";

const accountAddress = `0x${"12".repeat(20)}`;
const clientOrderId = `0x${"ab".repeat(16)}`;
const attemptCommittedAt = Date.parse("2026-08-25T00:00:00.000Z");
const sevenDaysMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const readStartedAt = attemptCommittedAt + 10_000;
const observedAt = attemptCommittedAt + 20_000;
const orderTimestamp = attemptCommittedAt + 1_000;
const statusTimestamp = attemptCommittedAt + 2_000;
const clearinghouseTimestamp = attemptCommittedAt + 9_000;
const readRequestId = "10000000-0000-4000-8000-000000000000";
const callIds = [
  "20000000-0000-4000-8000-000000000000",
  "30000000-0000-4000-8000-000000000000",
  "40000000-0000-4000-8000-000000000000",
  "50000000-0000-4000-8000-000000000000",
] as const;

function raw(value: unknown): unknown {
  return parse(JSON.stringify(value));
}

function providerOrder(overrides: Record<string, unknown> = {}) {
  return {
    coin: "BTC",
    side: "B",
    limitPx: "100",
    sz: "1.5",
    oid: 123,
    timestamp: orderTimestamp,
    triggerCondition: "N/A",
    isTrigger: false,
    triggerPx: "0.0",
    children: [],
    isPositionTpsl: false,
    reduceOnly: false,
    orderType: "Limit",
    origSz: "1.500",
    tif: "Gtc",
    cloid: clientOrderId,
    ...overrides,
  };
}

function orderStatus(
  status: string,
  orderOverrides: Record<string, unknown> = {},
): unknown {
  return raw({
    status: "order",
    order: {
      order: providerOrder(orderOverrides),
      status,
      statusTimestamp,
    },
  });
}

function fill(
  size: string,
  tradeId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    coin: "BTC",
    px: "100",
    sz: size,
    side: "B",
    time: attemptCommittedAt + 3_000 + tradeId,
    startPosition: "0",
    dir: "Open Long",
    closedPnl: "0",
    hash: `0x${tradeId.toString(16).padStart(64, "0")}`,
    oid: 123,
    crossed: true,
    fee: "0.01",
    tid: tradeId,
    feeToken: "USDC",
    twapId: null,
    cloid: clientOrderId,
    ...overrides,
  };
}

function clearinghouse(
  time = clearinghouseTimestamp,
  assetPositions: readonly unknown[] = [],
): unknown {
  const summary = {
    accountValue: "1000",
    totalNtlPos: "0",
    totalRawUsd: "1000",
    totalMarginUsed: "0",
  };
  return raw({
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: "0",
    withdrawable: "1000",
    assetPositions,
    time,
  });
}

function subject(
  overrides: Partial<PerpReconciliationSubject> = {},
): PerpReconciliationSubject {
  return {
    operationId: "60000000-0000-4000-8000-000000000000",
    ownerUserId: "70000000-0000-4000-8000-000000000000",
    action: "order",
    accountAddress,
    accountKind: "master",
    attemptCommittedAt: new Date(attemptCommittedAt).toISOString(),
    intentRecordVersion: "1",
    canonicalAction: {
      action: "order",
      coin: "BTC",
      side: "buy",
      order_type: "limit",
      size: "1.5",
      limit_price: "100.00",
      time_in_force: "gtc",
      reduce_only: false,
    },
    items: [
      {
        index: 0,
        coin: "BTC",
        targetKind: null,
        targetOrderId: null,
        targetClientOrderId: null,
        generatedClientOrderId: clientOrderId,
      },
    ],
    ...overrides,
  };
}

interface HarnessOptions {
  readonly responses?: Partial<Record<HyperliquidInfoRequest["type"], unknown>>;
  readonly quotaFailure?: Error;
  readonly transportFailure?: Error;
  readonly uuids?: readonly string[];
}

function harness(options: HarnessOptions = {}) {
  const reserveWeight = vi.fn<HyperliquidInfoQuota["reserveWeight"]>(
    (_cost, signal) => {
      signal.throwIfAborted();
      return options.quotaFailure === undefined
        ? Promise.resolve()
        : Promise.reject(options.quotaFailure);
    },
  );
  const responses: Record<HyperliquidInfoRequest["type"], unknown> = {
    meta: raw({}),
    clearinghouseState: clearinghouse(),
    frontendOpenOrders: raw([providerOrder()]),
    userFillsByTime: raw([]),
    userFunding: raw([]),
    orderStatus: orderStatus("open"),
    ...options.responses,
  };
  const post = vi.fn<HyperliquidLosslessInfoTransport["post"]>(
    (request, signal) => {
      signal.throwIfAborted();
      if (options.transportFailure !== undefined) {
        return Promise.reject(options.transportFailure);
      }
      return Promise.resolve(responses[request.type]);
    },
  );
  let uuidIndex = 0;
  const uuids = options.uuids ?? callIds;
  const reader = createHyperliquidPerpOrderReconciliationReader({
    quota: { reserveWeight },
    transport: { post },
    now: vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date(readStartedAt))
      .mockReturnValue(new Date(observedAt)),
    createUuid: () => uuids[uuidIndex++] ?? callIds[0],
  });
  return { post, reader, reserveWeight };
}

describe("Hyperliquid Perp order reconciliation reader", () => {
  it("reserves all 144 weight once and reads four evidence classes with new UUIDs", async () => {
    const { post, reader, reserveWeight } = harness();
    const signal = new AbortController().signal;

    const result = await reader.read({
      readRequestId,
      subject: subject(),
      signal,
    });

    expect(reserveWeight).toHaveBeenCalledOnce();
    expect(reserveWeight).toHaveBeenCalledWith(
      HYPERLIQUID_PERP_ORDER_RECONCILIATION_INFO_WEIGHT,
      signal,
    );
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls.map(([request]) => request)).toEqual([
      { type: "orderStatus", user: accountAddress, oid: clientOrderId },
      { type: "frontendOpenOrders", user: accountAddress, dex: "" },
      {
        type: "userFillsByTime",
        user: accountAddress,
        startTime: attemptCommittedAt,
        endTime: readStartedAt,
        aggregateByTime: false,
      },
      { type: "clearinghouseState", user: accountAddress, dex: "" },
    ]);
    expect(post.mock.calls.map(([, , callId]) => callId)).toEqual(callIds);
    expect(new Set(post.mock.calls.map(([, , callId]) => callId)).size).toBe(4);
    expect(post.mock.calls.map(([, , callId]) => callId)).not.toContain(
      readRequestId,
    );
    expect(result).toEqual({
      kind: "resolved",
      resolution: {
        genericState: "accepted",
        intentState: "accepted",
        observedAt: new Date(observedAt).toISOString(),
        reasonCode: null,
        items: [
          {
            index: 0,
            coin: "BTC",
            generatedClientOrderId: clientOrderId,
            state: "accepted",
            providerOrderId: "123",
            clientOrderId,
            filledSize: null,
            averageFillPrice: null,
            reasonCode: null,
          },
        ],
      },
    });
  });

  it("sums partial fills exactly without floating point arithmetic", async () => {
    const { reader } = harness({
      responses: {
        orderStatus: orderStatus("open", { sz: "1.5000" }),
        frontendOpenOrders: raw([providerOrder({ sz: "1" })]),
        userFillsByTime: raw([fill("0.2", 1), fill("0.300", 2)]),
      },
    });

    const result = await reader.read({
      readRequestId,
      subject: subject(),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: "resolved",
      resolution: {
        genericState: "accepted",
        intentState: "partial",
        items: [
          {
            state: "partial",
            filledSize: "0.5",
            averageFillPrice: null,
          },
        ],
      },
    });
  });

  it.each([
    ["buy", "B", "100.0001"],
    ["sell", "A", "99.9999"],
  ] as const)(
    "rejects a %s fill price that crosses the reviewed limit",
    async (side, sideCode, fillPrice) => {
      const { reader } = harness({
        responses: {
          orderStatus: orderStatus("open", { side: sideCode, sz: "1.0" }),
          frontendOpenOrders: raw([
            providerOrder({ side: sideCode, sz: "1.0" }),
          ]),
          userFillsByTime: raw([
            fill("0.5", 1, { side: sideCode, px: fillPrice }),
          ]),
        },
      });

      await expect(
        reader.read({
          readRequestId,
          subject: subject({
            canonicalAction: {
              action: "order",
              coin: "BTC",
              side,
              order_type: "limit",
              size: "1.5",
              limit_price: "100",
              time_in_force: "gtc",
              reduce_only: false,
            },
          }),
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "hyperliquid_order_identity_conflict",
      });
    },
  );

  it("parks an attempt older than the complete seven-day fill window before quota or reads", async () => {
    const { post, reader, reserveWeight } = harness();
    const expiredAttempt = readStartedAt - sevenDaysMilliseconds - 1;

    await expect(
      reader.read({
        readRequestId,
        subject: subject({
          attemptCommittedAt: new Date(expiredAttempt).toISOString(),
        }),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_fill_window_expired",
    });
    expect(reserveWeight).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("maps exact filled evidence to succeeded", async () => {
    const { reader } = harness({
      responses: {
        orderStatus: orderStatus("filled", { sz: "0.0" }),
        frontendOpenOrders: raw([]),
        userFillsByTime: raw([fill("1.5", 1)]),
      },
    });

    await expect(
      reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      resolution: {
        genericState: "succeeded",
        intentState: "filled",
        items: [{ state: "filled", filledSize: "1.5" }],
      },
    });
  });

  it.each([
    ["marginCanceled", "cancelled", "succeeded", "gtc"],
    ["badAloPxRejected", "rejected", "rejected", "alo"],
  ] as const)(
    "maps the allowlisted %s terminal status",
    async (providerStatus, intentState, genericState, timeInForce) => {
      const cancellation = intentState === "cancelled";
      const { reader } = harness({
        responses: {
          orderStatus: orderStatus(providerStatus, {
            sz: cancellation ? "1.0" : "1.5",
            tif: timeInForce === "alo" ? "Alo" : "Gtc",
          }),
          frontendOpenOrders: raw([]),
          userFillsByTime: raw(cancellation ? [fill("0.5", 1)] : []),
        },
      });

      const result = await reader.read({
        readRequestId,
        subject: subject({
          canonicalAction: {
            action: "order",
            coin: "BTC",
            side: "buy",
            order_type: "limit",
            size: "1.5",
            limit_price: "100",
            time_in_force: timeInForce,
            reduce_only: false,
          },
        }),
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        kind: "resolved",
        resolution: {
          genericState,
          intentState,
          reasonCode:
            providerStatus === "marginCanceled"
              ? "hyperliquid_margin_canceled"
              : "hyperliquid_bad_alo_px_rejected",
          items: [{ state: intentState }],
        },
      });
    },
  );

  it("rejects a rejected status whose remaining size changed", async () => {
    const { reader } = harness({
      responses: {
        orderStatus: orderStatus("tickRejected", { sz: "0" }),
        frontendOpenOrders: raw([]),
      },
    });

    await expect(
      reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_snapshot_conflict",
    });
  });

  it.each([
    "badAloPxRejected",
    "iocCancelRejected",
    "marketOrderNoLiquidityRejected",
    "reduceOnlyRejected",
    "reduceOnlyCanceled",
  ])(
    "parks status %s when it contradicts the reviewed GTC non-reduce-only limit",
    async (providerStatus) => {
      const { reader } = harness({
        responses: {
          orderStatus: orderStatus(providerStatus, { sz: "1.5" }),
          frontendOpenOrders: raw([]),
        },
      });

      await expect(
        reader.read({
          readRequestId,
          subject: subject(),
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "hyperliquid_order_identity_conflict",
      });
    },
  );

  it("keeps unknownOid pending after collecting every evidence class", async () => {
    const { post, reader } = harness({
      responses: {
        orderStatus: raw({ status: "unknownOid" }),
        frontendOpenOrders: raw([]),
      },
    });

    await expect(
      reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "pending",
      reasonCode: "hyperliquid_unknown_oid",
    });
    expect(post).toHaveBeenCalledTimes(4);
  });

  it.each(["triggered", "futureProviderStatus"])(
    "parks excluded or unknown status %s without fabricating a terminal state",
    async (providerStatus) => {
      const { reader } = harness({
        responses: {
          orderStatus: orderStatus(providerStatus),
          frontendOpenOrders: raw([]),
        },
      });

      await expect(
        reader.read({
          readRequestId,
          subject: subject(),
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        kind: "operator_required",
        reasonCode:
          providerStatus === "triggered"
            ? "hyperliquid_excluded_order_status"
            : "hyperliquid_unknown_order_status",
      });
    },
  );

  it.each([
    ["coin", { coin: "ETH" }],
    ["side", { side: "A" }],
    ["limit price", { limitPx: "101" }],
    ["original size", { origSz: "1.6" }],
    ["reduce only", { reduceOnly: true }],
    ["order type", { orderType: "Market", tif: "FrontendMarket" }],
    ["time in force", { tif: "Alo" }],
    ["cloid", { cloid: `0x${"cd".repeat(16)}` }],
  ])("rejects a conflicting %s identity", async (_label, mutation) => {
    const { reader } = harness({
      responses: { orderStatus: orderStatus("open", mutation) },
    });

    await expect(
      reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_order_identity_conflict",
    });
  });

  it("rejects an OID conflict between orderStatus and the open snapshot", async () => {
    const { reader } = harness({
      responses: {
        frontendOpenOrders: raw([providerOrder({ oid: 124 })]),
      },
    });

    await expect(
      reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_order_identity_conflict",
    });
  });

  it("rejects a contradictory open snapshot and arithmetic", async () => {
    const { reader } = harness({
      responses: {
        frontendOpenOrders: raw([]),
      },
    });

    await expect(
      reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_snapshot_conflict",
    });
  });

  it("rejects malformed and capacity-truncated evidence without a terminal state", async () => {
    const malformed = harness({
      responses: {
        orderStatus: raw({
          status: "unknownOid",
          rawProviderField: accountAddress,
        }),
        frontendOpenOrders: raw([]),
      },
    });
    await expect(
      malformed.reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_evidence_malformed",
    });

    const truncatedFills = Array.from({ length: 2_000 }, (_, index) =>
      fill("0.0001", index + 1, {
        oid: index + 10_000,
        cloid: undefined,
        coin: "ETH",
      }),
    );
    const truncated = harness({
      responses: {
        orderStatus: raw({ status: "unknownOid" }),
        frontendOpenOrders: raw([]),
        userFillsByTime: raw(truncatedFills),
      },
    });
    await expect(
      truncated.reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_evidence_truncated",
    });
  });

  it("rejects market orders and numeric order targets before quota or provider reads", async () => {
    const market = harness();
    await expect(
      market.reader.read({
        readRequestId,
        subject: subject({
          canonicalAction: {
            action: "order",
            coin: "BTC",
            side: "buy",
            order_type: "market",
            size: "1.5",
            max_slippage_percent: "0.5",
            reduce_only: false,
          },
        }),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "unsupported_perp_order_type",
    });
    expect(market.reserveWeight).not.toHaveBeenCalled();
    expect(market.post).not.toHaveBeenCalled();

    const numeric = harness();
    const base = subject();
    await expect(
      numeric.reader.read({
        readRequestId,
        subject: subject({
          items: [
            {
              ...base.items[0]!,
              targetKind: "order_id",
              targetOrderId: "123",
            },
          ],
        }),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "numeric_order_id_not_supported",
    });
    expect(numeric.reserveWeight).not.toHaveBeenCalled();
    expect(numeric.post).not.toHaveBeenCalled();
  });

  it("rejects reused call UUIDs before any provider read", async () => {
    const { post, reader, reserveWeight } = harness({
      uuids: [callIds[0], callIds[0], callIds[2], callIds[3]],
    });

    await expect(
      reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "invalid_reconciliation_call_id",
    });
    expect(reserveWeight).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("returns sanitized retry decisions for quota and retryable transport failures", async () => {
    const quota = harness({
      quotaFailure: new Error(`quota ${accountAddress}`),
    });
    await expect(
      quota.reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "retry",
      reasonCode: "hyperliquid_info_quota_unavailable",
    });
    expect(quota.post).not.toHaveBeenCalled();

    const transport = harness({
      transportFailure: new RetryableHyperliquidReadError(
        "pre_response_transport",
      ),
    });
    await expect(
      transport.reader.read({
        readRequestId,
        subject: subject(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "retry",
      reasonCode: "hyperliquid_info_retryable",
    });
  });
});
