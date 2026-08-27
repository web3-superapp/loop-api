import { parse } from "lossless-json";
import { describe, expect, it, vi } from "vitest";

import type { SpotIntentReconciliationSubject } from "../src/features/spot/spot-reconciliation-contract.js";
import type { HyperliquidInfoQuota } from "../src/integrations/hyperliquid/info-quota.js";
import {
  RetryableHyperliquidSpotInfoError,
  type HyperliquidSpotInfoRequest,
  type HyperliquidSpotInfoTransport,
} from "../src/integrations/hyperliquid/spot-info-contract.js";
import {
  createHyperliquidSpotOrderReconciliationReader,
  HYPERLIQUID_SPOT_ORDER_RECONCILIATION_INFO_WEIGHT,
} from "../src/integrations/hyperliquid/spot-order-reconciliation-reader.js";

const accountAddress = `0x${"12".repeat(20)}`;
const clientOrderId = `0x${"ab".repeat(16)}`;
const baseTokenId = `0x${"01".repeat(16)}`;
const quoteTokenId = `0x${"02".repeat(16)}`;
const attemptCommittedAt = Date.parse("2026-08-26T00:00:00.000Z");
const readStartedAt = attemptCommittedAt + 10_000;
const observedAt = attemptCommittedAt + 20_000;
const orderTimestamp = attemptCommittedAt + 1_000;
const statusTimestamp = attemptCommittedAt + 5_000;
const readRequestId = "10000000-0000-4000-8000-000000000000";
const callIds = [
  "20000000-0000-4000-8000-000000000000",
  "30000000-0000-4000-8000-000000000000",
  "40000000-0000-4000-8000-000000000000",
  "50000000-0000-4000-8000-000000000000",
  "60000000-0000-4000-8000-000000000000",
] as const;
const maximumUnsigned64 = "18446744073709551615";

function raw(value: unknown): unknown {
  return parse(JSON.stringify(value));
}

function rawWithNumericLiterals(
  value: unknown,
  literals: Readonly<Record<string, string>>,
): unknown {
  let source = JSON.stringify(value);
  for (const [marker, literal] of Object.entries(literals)) {
    source = source.replaceAll(JSON.stringify(marker), literal);
  }
  return parse(source);
}

function providerOrder(overrides: Record<string, unknown> = {}) {
  return {
    coin: "PURR/USDC",
    side: "B",
    limitPx: "51",
    sz: "0",
    oid: 123,
    timestamp: orderTimestamp,
    triggerCondition: "N/A",
    isTrigger: false,
    triggerPx: "0",
    children: [],
    isPositionTpsl: false,
    reduceOnly: false,
    orderType: "Limit",
    origSz: "0.2",
    tif: "Ioc",
    cloid: clientOrderId,
    ...overrides,
  };
}

function providerFill(
  size: string,
  price: string,
  tradeId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    coin: "PURR/USDC",
    px: price,
    sz: size,
    side: "B",
    time: attemptCommittedAt + 3_000 + tradeId,
    startPosition: "0",
    dir: "Buy",
    closedPnl: "0",
    hash: `0x${tradeId.toString(16).padStart(64, "0")}`,
    oid: 123,
    crossed: true,
    fee: "0.001",
    tid: tradeId,
    feeToken: "USDC",
    twapId: null,
    cloid: clientOrderId,
    ...overrides,
  };
}

function providerBalance(overrides: Record<string, unknown> = {}) {
  return {
    coin: "PURR",
    token: 1,
    total: "100",
    hold: "0",
    entryNtl: "0",
    ...overrides,
  };
}

function balancesResponse(): unknown {
  return raw({
    balances: [
      providerBalance(),
      providerBalance({
        coin: "USDC",
        token: 0,
        total: "1000",
      }),
    ],
  });
}

interface SubjectOptions {
  readonly side?: "buy" | "sell";
  readonly size?: string;
  readonly limitPrice?: string;
  readonly overrides?: Partial<SpotIntentReconciliationSubject>;
}

function subject(
  options: SubjectOptions = {},
): SpotIntentReconciliationSubject {
  const side = options.side ?? "buy";
  const size = options.size ?? "0.2";
  const limitPrice = options.limitPrice ?? "51";
  return {
    operationId: "70000000-0000-4000-8000-000000000000",
    ownerUserId: "80000000-0000-4000-8000-000000000000",
    network: "testnet",
    transportAttemptId: "90000000-0000-4000-8000-000000000000",
    attemptCommittedAt: new Date(attemptCommittedAt).toISOString(),
    intentRecordVersion: "1",
    marketId: "a0000000-0000-4000-8000-000000000000",
    providerCoin: "PURR/USDC",
    baseTokenIndex: 1,
    baseTokenId,
    baseDisplayIdentity: "PURR",
    quoteTokenIndex: 0,
    quoteTokenId,
    quoteDisplayIdentity: "USDC",
    spotPairIndex: 0,
    exchangeOrderAsset: 10_000,
    side,
    amountMode: "base",
    amountValue: size,
    computedBaseSize: size,
    worstIocLimitPrice: limitPrice,
    accountAddress,
    accountKind: "master",
    clientOrderId,
    canonicalAction: {
      type: "order",
      orders: [
        {
          a: 10_000,
          b: side === "buy",
          p: limitPrice,
          s: size,
          r: false,
          t: { limit: { tif: "Ioc" } },
          c: clientOrderId,
        },
      ],
      grouping: "na",
    },
    ...options.overrides,
  };
}

interface TerminalEvidenceOptions {
  readonly status?: string;
  readonly orderOverrides?: Record<string, unknown>;
  readonly fills?: readonly unknown[];
  readonly openOrders?: readonly unknown[];
  readonly history?: readonly unknown[];
  readonly balances?: unknown;
}

function terminalEvidence(
  options: TerminalEvidenceOptions = {},
): Partial<Record<HyperliquidSpotInfoRequest["type"], unknown>> {
  const status = options.status ?? "filled";
  const order = providerOrder(options.orderOverrides);
  const history = options.history ?? [
    {
      order,
      status,
      statusTimestamp,
    },
  ];
  return {
    orderStatus: raw({
      status: "order",
      order: { order, status, statusTimestamp },
    }),
    frontendOpenOrders: raw(options.openOrders ?? []),
    userFillsByTime: raw(
      options.fills ?? [
        providerFill("0.1", "49", 1),
        providerFill("0.1", "51", 2, { fee: "0.002" }),
      ],
    ),
    historicalOrders: raw(history),
    spotClearinghouseState: options.balances ?? balancesResponse(),
  };
}

function unknownOidEvidence(
  overrides: Partial<Record<HyperliquidSpotInfoRequest["type"], unknown>> = {},
): Partial<Record<HyperliquidSpotInfoRequest["type"], unknown>> {
  return {
    orderStatus: raw({ status: "unknownOid" }),
    frontendOpenOrders: raw([]),
    userFillsByTime: raw([]),
    historicalOrders: raw([]),
    spotClearinghouseState: balancesResponse(),
    ...overrides,
  };
}

interface HarnessOptions {
  readonly responses?: Partial<
    Record<HyperliquidSpotInfoRequest["type"], unknown>
  >;
  readonly quotaFailure?: Error;
  readonly transportFailure?: Error;
  readonly uuids?: readonly string[];
  readonly times?: readonly Date[];
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
  const responses = {
    ...terminalEvidence(),
    ...options.responses,
  };
  const post = vi.fn<HyperliquidSpotInfoTransport["post"]>(
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
  const times = options.times ?? [
    new Date(readStartedAt),
    new Date(observedAt),
  ];
  let timeIndex = 0;
  const reader = createHyperliquidSpotOrderReconciliationReader({
    quota: { reserveWeight },
    transport: { post },
    now: () => times[timeIndex++] ?? times.at(-1) ?? new Date(observedAt),
    createUuid: () => uuids[uuidIndex++] ?? callIds[0],
  });
  return { post, reader, reserveWeight };
}

async function read(
  reader: ReturnType<typeof createHyperliquidSpotOrderReconciliationReader>,
  readSubject = subject(),
  signal = new AbortController().signal,
) {
  return reader.read({ readRequestId, subject: readSubject, signal });
}

describe("Hyperliquid Spot order reconciliation reader", () => {
  it("reserves all 264 weight and performs the five ordered reads with fresh UUIDs", async () => {
    const { post, reader, reserveWeight } = harness();
    const signal = new AbortController().signal;

    const result = await reader.read({
      readRequestId,
      subject: subject(),
      signal,
    });

    expect(reserveWeight).toHaveBeenCalledOnce();
    expect(reserveWeight).toHaveBeenCalledWith(
      HYPERLIQUID_SPOT_ORDER_RECONCILIATION_INFO_WEIGHT,
      signal,
    );
    expect(HYPERLIQUID_SPOT_ORDER_RECONCILIATION_INFO_WEIGHT).toBe(264);
    expect(post).toHaveBeenCalledTimes(5);
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
      { type: "historicalOrders", user: accountAddress },
      { type: "spotClearinghouseState", user: accountAddress },
    ]);
    expect(post.mock.calls.map(([, , callId]) => callId)).toEqual(callIds);
    expect(new Set(post.mock.calls.map(([, , callId]) => callId)).size).toBe(5);
    expect(post.mock.calls.map(([, , callId]) => callId)).not.toContain(
      readRequestId,
    );
    expect(result).toEqual({
      kind: "resolved",
      resolution: {
        state: "filled",
        providerOrderId: "123",
        clientOrderId,
        filledBaseSize: "0.2",
        quoteAmount: "10",
        averageFillPrice: "50",
        fee: {
          amount: "0.003",
          tokenIndex: 0,
          tokenId: quoteTokenId,
          assetDisplayIdentity: "USDC",
        },
        observedAt: new Date(observedAt).toISOString(),
        reasonCode: null,
      },
    });
  });

  it("maps exact sell fills and a base-denominated fee without floating point arithmetic", async () => {
    const evidence = terminalEvidence({
      orderOverrides: {
        side: "A",
        limitPx: "49",
      },
      fills: [
        providerFill("0.1", "51", 1, {
          side: "A",
          fee: "0.0001",
          feeToken: "PURR",
        }),
        providerFill("0.1", "49", 2, {
          side: "A",
          fee: "0.0002",
          feeToken: "PURR",
        }),
      ],
    });
    const { reader } = harness({ responses: evidence });

    await expect(
      read(reader, subject({ side: "sell", limitPrice: "49" })),
    ).resolves.toMatchObject({
      kind: "resolved",
      resolution: {
        state: "filled",
        filledBaseSize: "0.2",
        quoteAmount: "10",
        averageFillPrice: "50",
        fee: {
          amount: "0.0003",
          tokenIndex: 1,
          tokenId: baseTokenId,
          assetDisplayIdentity: "PURR",
        },
      },
    });
  });

  it("proves the indexed Spot pair identity without treating pair zero as generic", async () => {
    const indexed = subject();
    const indexedSubject: SpotIntentReconciliationSubject = {
      ...indexed,
      providerCoin: "@107",
      baseTokenIndex: 8,
      baseDisplayIdentity: "KORILA",
      spotPairIndex: 107,
      exchangeOrderAsset: 10_107,
      canonicalAction: {
        ...indexed.canonicalAction,
        orders: [
          {
            ...indexed.canonicalAction.orders[0],
            a: 10_107,
          },
        ],
      },
    };
    const { reader } = harness({
      responses: terminalEvidence({
        orderOverrides: { coin: "@107" },
        fills: [
          providerFill("0.1", "49", 1, { coin: "@107" }),
          providerFill("0.1", "51", 2, {
            coin: "@107",
            fee: "0.002",
          }),
        ],
        balances: raw({
          balances: [
            providerBalance({ coin: "KORILA", token: 8 }),
            providerBalance({ coin: "USDC", token: 0 }),
          ],
        }),
      }),
    });

    await expect(read(reader, indexedSubject)).resolves.toMatchObject({
      kind: "resolved",
      resolution: {
        state: "filled",
        fee: {
          tokenIndex: 0,
          tokenId: quoteTokenId,
          assetDisplayIdentity: "USDC",
        },
      },
    });
  });

  it("preserves uint64 order and trade identifiers through lossless JSON", async () => {
    const marker = "__MAX_UINT64__";
    const order = providerOrder({ oid: marker });
    const fill = providerFill("0.2", "50", 1, {
      oid: marker,
      tid: marker,
      fee: "0.003",
    });
    const responses = {
      orderStatus: rawWithNumericLiterals(
        {
          status: "order",
          order: { order, status: "filled", statusTimestamp },
        },
        { [marker]: maximumUnsigned64 },
      ),
      frontendOpenOrders: raw([]),
      userFillsByTime: rawWithNumericLiterals([fill], {
        [marker]: maximumUnsigned64,
      }),
      historicalOrders: rawWithNumericLiterals(
        [{ order, status: "filled", statusTimestamp }],
        { [marker]: maximumUnsigned64 },
      ),
      spotClearinghouseState: balancesResponse(),
    };
    const { reader } = harness({ responses });

    await expect(read(reader)).resolves.toMatchObject({
      kind: "resolved",
      resolution: { providerOrderId: maximumUnsigned64 },
    });
  });

  it("maps iocCancelRejected to the only allowlisted not-filled resolution", async () => {
    const { reader } = harness({
      responses: terminalEvidence({
        status: "iocCancelRejected",
        orderOverrides: { sz: "0.2" },
        fills: [],
      }),
    });

    await expect(read(reader)).resolves.toEqual({
      kind: "resolved",
      resolution: {
        state: "not_filled",
        providerOrderId: "123",
        clientOrderId,
        filledBaseSize: null,
        quoteAmount: null,
        averageFillPrice: null,
        fee: null,
        observedAt: new Date(observedAt).toISOString(),
        reasonCode: "hyperliquid_ioc_cancel_rejected",
      },
    });
  });

  it.each([
    [
      "insufficientSpotBalanceRejected",
      "hyperliquid_insufficient_spot_balance_rejected",
    ],
    ["minTradeNtlRejected", "hyperliquid_min_trade_ntl_rejected"],
    ["oracleRejected", "hyperliquid_oracle_rejected"],
    ["tickRejected", "hyperliquid_tick_rejected"],
    ["rejected", "hyperliquid_rejected"],
  ] as const)("maps %s to rejected/%s", async (status, reasonCode) => {
    const { reader } = harness({
      responses: terminalEvidence({
        status,
        orderOverrides: { sz: "0.2" },
        fills: [],
      }),
    });

    await expect(read(reader)).resolves.toMatchObject({
      kind: "resolved",
      resolution: {
        state: "rejected",
        providerOrderId: "123",
        clientOrderId,
        fee: null,
        reasonCode,
      },
    });
  });

  it("keeps unknownOid pending only when all other evidence is empty", async () => {
    const { post, reader } = harness({ responses: unknownOidEvidence() });

    await expect(read(reader)).resolves.toEqual({
      kind: "pending",
      reasonCode: "hyperliquid_unknown_oid",
    });
    expect(post).toHaveBeenCalledTimes(5);

    const conflict = harness({
      responses: unknownOidEvidence({
        historicalOrders: raw([
          {
            order: providerOrder(),
            status: "filled",
            statusTimestamp,
          },
        ]),
      }),
    });
    await expect(read(conflict.reader)).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_snapshot_conflict",
    });
  });

  it("keeps a terminal snapshot pending until matching history arrives", async () => {
    const { reader } = harness({
      responses: terminalEvidence({ history: [] }),
    });

    await expect(read(reader)).resolves.toEqual({
      kind: "pending",
      reasonCode: "hyperliquid_history_pending",
    });
  });

  it.each([
    ["open", [], "hyperliquid_nonterminal_order_status"],
    [
      "open",
      [providerFill("0.1", "50", 1)],
      "hyperliquid_partial_fill_unsupported",
    ],
    ["canceled", [], "hyperliquid_unknown_order_status"],
    ["futureStatus", [], "hyperliquid_unknown_order_status"],
  ] as const)(
    "parks non-terminal/unknown status %s with matching fills=%s",
    async (status, fills, reasonCode) => {
      const { reader } = harness({
        responses: terminalEvidence({
          status,
          orderOverrides: { sz: fills.length === 0 ? "0.2" : "0.1" },
          fills,
        }),
      });

      await expect(read(reader)).resolves.toEqual({
        kind: "operator_required",
        reasonCode,
      });
    },
  );

  it("parks an underfilled terminal snapshot instead of inventing a full fill", async () => {
    const { reader } = harness({
      responses: terminalEvidence({
        fills: [providerFill("0.1", "50", 1)],
      }),
    });

    await expect(read(reader)).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_partial_fill_unsupported",
    });
  });

  it("parks an overfilled or post-terminal fill as a conflicting snapshot", async () => {
    for (const fills of [
      [providerFill("0.3", "50", 1)],
      [
        providerFill("0.2", "50", 1, {
          time: statusTimestamp + 1,
        }),
      ],
    ]) {
      const { reader } = harness({
        responses: terminalEvidence({ fills }),
      });

      await expect(read(reader)).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "hyperliquid_snapshot_conflict",
      });
    }
  });

  it.each([
    ["coin", { coin: "@1" }],
    ["side", { side: "A" }],
    ["limit", { limitPx: "50" }],
    ["size", { origSz: "0.3" }],
    ["cloid", { cloid: `0x${"cd".repeat(16)}` }],
  ])("rejects a conflicting order %s identity", async (_label, mutation) => {
    const { reader } = harness({
      responses: terminalEvidence({ orderOverrides: mutation }),
    });

    await expect(read(reader)).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_order_identity_conflict",
    });
  });

  it.each([
    ["buy", "B", "51", "51.0001"],
    ["sell", "A", "49", "48.9999"],
  ] as const)(
    "rejects a %s fill outside the reviewed IOC price bound",
    async (side, sideCode, limitPrice, fillPrice) => {
      const { reader } = harness({
        responses: terminalEvidence({
          orderOverrides: { side: sideCode, limitPx: limitPrice },
          fills: [
            providerFill("0.2", fillPrice, 1, {
              side: sideCode,
              fee: "0.001",
            }),
          ],
        }),
      });

      await expect(
        read(reader, subject({ side, limitPrice })),
      ).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "hyperliquid_order_identity_conflict",
      });
    },
  );

  it.each([
    [
      "negative",
      [providerFill("0.2", "50", 1, { fee: "-0.001" })],
      "hyperliquid_negative_fee_unsupported",
    ],
    [
      "mixed identity",
      [
        providerFill("0.1", "50", 1, { feeToken: "USDC" }),
        providerFill("0.1", "50", 2, { feeToken: "PURR" }),
      ],
      "hyperliquid_mixed_fee_identity_unsupported",
    ],
    [
      "unknown identity",
      [providerFill("0.2", "50", 1, { feeToken: "BTC" })],
      "hyperliquid_fee_identity_unsupported",
    ],
    [
      "economically impossible",
      [providerFill("0.2", "50", 1, { fee: "10.0001" })],
      "hyperliquid_fee_amount_unsupported",
    ],
  ] as const)("parks %s fee evidence", async (_label, fills, reasonCode) => {
    const { reader } = harness({
      responses: terminalEvidence({ fills }),
    });

    await expect(read(reader)).resolves.toEqual({
      kind: "operator_required",
      reasonCode,
    });
  });

  it.each([
    ["builderFee", { builderFee: "0" }],
    ["feeTrialEscrow", { feeTrialEscrow: "0" }],
    [
      "liquidation",
      {
        liquidation: {
          liquidatedUser: accountAddress,
          markPx: "50",
          method: "market",
        },
      },
    ],
  ])("parks ancillary %s fill evidence", async (_label, ancillary) => {
    const { reader } = harness({
      responses: terminalEvidence({
        fills: [providerFill("0.2", "50", 1, ancillary)],
      }),
    });

    await expect(read(reader)).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_ancillary_fill_evidence_unsupported",
    });
  });

  it("parks an exact weighted average that has no finite decimal representation", async () => {
    const { reader } = harness({
      responses: terminalEvidence({
        orderOverrides: { limitPx: "0.2", origSz: "3" },
        fills: [
          providerFill("1", "0.1", 1, { fee: "0" }),
          providerFill("2", "0.2", 2, { fee: "0" }),
        ],
      }),
    });

    await expect(
      read(reader, subject({ size: "3", limitPrice: "0.2" })),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "hyperliquid_average_price_unsupported",
    });
  });

  it("keeps evidence created after the bounded read window pending", async () => {
    const futureOrderTimestamp = readStartedAt + 1;
    const futureStatusTimestamp = readStartedAt + 2;
    const order = providerOrder({
      timestamp: futureOrderTimestamp,
      sz: "0.2",
    });
    const responses = {
      orderStatus: raw({
        status: "order",
        order: {
          order,
          status: "iocCancelRejected",
          statusTimestamp: futureStatusTimestamp,
        },
      }),
      frontendOpenOrders: raw([]),
      userFillsByTime: raw([]),
      historicalOrders: raw([
        {
          order,
          status: "iocCancelRejected",
          statusTimestamp: futureStatusTimestamp,
        },
      ]),
      spotClearinghouseState: balancesResponse(),
    };
    const { reader } = harness({ responses });

    await expect(read(reader)).resolves.toEqual({
      kind: "pending",
      reasonCode: "hyperliquid_evidence_window_pending",
    });
  });

  it("fails closed when the observation clock moves backwards during the read", async () => {
    const { reader } = harness({
      times: [new Date(readStartedAt), new Date(readStartedAt - 1)],
    });

    await expect(read(reader)).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "invalid_reconciliation_clock",
    });
  });

  it.each([
    [
      "open orders",
      {
        frontendOpenOrders: raw(
          Array.from({ length: 5_000 }, () => providerOrder({ cloid: null })),
        ),
      },
    ],
    [
      "fills",
      {
        userFillsByTime: raw(
          Array.from({ length: 2_000 }, (_, index) =>
            providerFill("0.0001", "50", index + 1),
          ),
        ),
      },
    ],
    [
      "history",
      {
        historicalOrders: raw(
          Array.from({ length: 2_000 }, () => ({
            order: providerOrder({ cloid: null }),
            status: "filled",
            statusTimestamp,
          })),
        ),
      },
    ],
    [
      "balances",
      {
        spotClearinghouseState: raw({
          balances: Array.from({ length: 10_000 }, () => providerBalance()),
        }),
      },
    ],
  ] as const)(
    "fails closed at the documented/safety %s cap",
    async (_label, cap) => {
      const { reader } = harness({
        responses: unknownOidEvidence(cap),
      });

      await expect(read(reader)).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "hyperliquid_evidence_truncated",
      });
    },
  );

  it("returns sanitized retry decisions for quota and retryable transport failures", async () => {
    const quota = harness({ quotaFailure: new Error(accountAddress) });
    await expect(read(quota.reader)).resolves.toEqual({
      kind: "retry",
      reasonCode: "hyperliquid_info_quota_unavailable",
    });
    expect(quota.post).not.toHaveBeenCalled();

    const transport = harness({
      transportFailure: new RetryableHyperliquidSpotInfoError(
        "pre_response_transport",
      ),
    });
    await expect(read(transport.reader)).resolves.toEqual({
      kind: "retry",
      reasonCode: "hyperliquid_info_retryable",
    });
  });

  it("rejects invalid subjects and reused provider-call UUIDs before quota", async () => {
    const invalidSubject = harness();
    await expect(
      read(
        invalidSubject.reader,
        subject({ overrides: { providerCoin: "@0" } }),
      ),
    ).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "invalid_spot_reconciliation_subject",
    });
    expect(invalidSubject.reserveWeight).not.toHaveBeenCalled();
    expect(invalidSubject.post).not.toHaveBeenCalled();

    const invalidCalls = harness({
      uuids: [callIds[0], callIds[0], callIds[2], callIds[3], callIds[4]],
    });
    await expect(read(invalidCalls.reader)).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "invalid_reconciliation_call_id",
    });
    expect(invalidCalls.reserveWeight).not.toHaveBeenCalled();
    expect(invalidCalls.post).not.toHaveBeenCalled();
  });

  it("propagates aborts without spending quota or converting them to evidence decisions", async () => {
    const { post, reader, reserveWeight } = harness();
    const controller = new AbortController();
    const reason = new Error("reader stopped");
    controller.abort(reason);

    await expect(read(reader, subject(), controller.signal)).rejects.toBe(
      reason,
    );
    expect(reserveWeight).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
