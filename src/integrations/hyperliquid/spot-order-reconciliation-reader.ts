import { randomUUID } from "node:crypto";

import { isLosslessNumber } from "lossless-json";
import { z } from "zod";

import type {
  SpotOrderAuthoritativeReader,
  SpotOrderAuthoritativeReadResult,
} from "../../features/spot/spot-order-reconciliation-handler.js";
import type {
  SpotIntentReconciliationSubject,
  SpotIntentTerminalResolution,
  SpotRejectedReconciliationReasonCode,
} from "../../features/spot/spot-reconciliation-contract.js";
import {
  addExactUnsignedDecimals,
  compareExactUnsignedDecimals,
  divideExactUnsignedDecimals,
  exactUnsignedDecimalsEqual,
  multiplyExactUnsignedDecimals,
} from "../../features/spot/spot-exact-decimal.js";
import type { HyperliquidInfoQuota } from "./info-quota.js";
import {
  HyperliquidSpotInfoUnavailableError,
  RetryableHyperliquidSpotInfoError,
  type HyperliquidSpotInfoRequest,
  type HyperliquidSpotInfoTransport,
} from "./spot-info-contract.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const addressPattern = /^0x[0-9a-f]{40}$/;
const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;
const tokenIdPattern = /^0x[0-9a-f]{32}$/;
const assetDisplayIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const signedDecimalPattern =
  /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|-(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*))$/;
const nonnegativeDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const positiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const zeroDecimalPattern = /^0(?:\.0+)?$/;
const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/;
const reasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const maximumUnsigned64 = 18_446_744_073_709_551_615n;
const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const maximumPostgresInteger = 2_147_483_647n;
const maximumDecimalLength = 128;
const sevenDaysMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const openOrderSafetyCap = 5_000;
const fillProviderCap = 2_000;
const historicalOrderProviderCap = 2_000;
const balanceSafetyCap = 10_000;
const requiredInfoCallCount = 5;

export const HYPERLIQUID_SPOT_ORDER_RECONCILIATION_INFO_WEIGHT = 264;

const rejectionStatusToReason = Object.freeze({
  insufficientSpotBalanceRejected:
    "hyperliquid_insufficient_spot_balance_rejected",
  minTradeNtlRejected: "hyperliquid_min_trade_ntl_rejected",
  oracleRejected: "hyperliquid_oracle_rejected",
  tickRejected: "hyperliquid_tick_rejected",
  rejected: "hyperliquid_rejected",
} satisfies Readonly<Record<string, SpotRejectedReconciliationReasonCode>>);

interface LosslessJsonNumber {
  readonly isLosslessNumber: true;
  toString(): string;
}

interface ExpectedSpotOrder {
  readonly accountAddress: string;
  readonly providerCoin: string;
  readonly side: "buy" | "sell";
  readonly sideCode: "B" | "A";
  readonly limitPrice: string;
  readonly originalSize: string;
  readonly clientOrderId: string;
  readonly attemptCommittedAt: number;
  readonly baseTokenIndex: number;
  readonly baseTokenId: string;
  readonly baseDisplayIdentity: string;
  readonly quoteTokenIndex: number;
  readonly quoteTokenId: string;
  readonly quoteDisplayIdentity: string;
}

interface MappedOrder {
  readonly coin: string;
  readonly side: "B" | "A";
  readonly limitPrice: string;
  readonly remainingSize: string;
  readonly orderId: string;
  readonly timestamp: number;
  readonly originalSize: string;
  readonly reduceOnly: boolean;
  readonly orderType: string;
  readonly timeInForce: string | null;
  readonly clientOrderId: string | null;
  readonly triggerCondition: string;
  readonly isTrigger: boolean;
  readonly triggerPrice: string;
  readonly childCount: number;
  readonly isPositionTpsl: boolean;
}

interface MappedFill {
  readonly coin: string;
  readonly side: "B" | "A";
  readonly price: string;
  readonly size: string;
  readonly orderId: string;
  readonly tradeId: string;
  readonly timestamp: number;
  readonly clientOrderId: string | null;
  readonly twapId: string | null;
  readonly crossed: boolean;
  readonly fee: string;
  readonly feeToken: string;
  readonly hasBuilderFee: boolean;
  readonly hasFeeTrialEscrow: boolean;
  readonly hasLiquidation: boolean;
}

interface MappedHistoricalOrder {
  readonly order: MappedOrder;
  readonly status: string;
  readonly statusTimestamp: number;
}

class EvidenceFailure extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super("Hyperliquid Spot reconciliation evidence is unusable");
    this.name = "EvidenceFailure";
    this.reasonCode = reasonCode;
  }
}

const losslessNumberSchema = z.custom<LosslessJsonNumber>((value) =>
  isLosslessNumber(value),
);
const signedDecimalSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(signedDecimalPattern);
const nonnegativeDecimalSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(nonnegativeDecimalPattern);
const positiveDecimalSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(positiveDecimalPattern);
const clientOrderIdSchema = z.string().regex(clientOrderIdPattern);
const uuidSchema = z.string().regex(uuidPattern);
const nonnegativePostgresIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number(maximumPostgresInteger));
const reconciliationSubjectSchema = z
  .object({
    operationId: uuidSchema,
    ownerUserId: uuidSchema,
    network: z.literal("testnet"),
    transportAttemptId: uuidSchema,
    attemptCommittedAt: z.string().max(64),
    intentRecordVersion: z.string().regex(positiveIntegerPattern),
    marketId: uuidSchema,
    providerCoin: z.string().min(2).max(64),
    baseTokenIndex: nonnegativePostgresIntegerSchema,
    baseTokenId: z.string().regex(tokenIdPattern),
    baseDisplayIdentity: z.string().regex(assetDisplayIdentityPattern),
    quoteTokenIndex: nonnegativePostgresIntegerSchema,
    quoteTokenId: z.string().regex(tokenIdPattern),
    quoteDisplayIdentity: z.string().regex(assetDisplayIdentityPattern),
    spotPairIndex: nonnegativePostgresIntegerSchema,
    exchangeOrderAsset: nonnegativePostgresIntegerSchema,
    side: z.enum(["buy", "sell"]),
    amountMode: z.enum(["quote", "base"]),
    amountValue: positiveDecimalSchema,
    computedBaseSize: positiveDecimalSchema,
    worstIocLimitPrice: positiveDecimalSchema,
    accountAddress: z
      .string()
      .regex(addressPattern)
      .refine((value) => value !== `0x${"0".repeat(40)}`),
    accountKind: z.literal("master"),
    clientOrderId: clientOrderIdSchema,
    canonicalAction: z
      .object({
        type: z.literal("order"),
        orders: z.tuple([
          z
            .object({
              a: nonnegativePostgresIntegerSchema,
              b: z.boolean(),
              p: positiveDecimalSchema,
              s: positiveDecimalSchema,
              r: z.literal(false),
              t: z
                .object({
                  limit: z.object({ tif: z.literal("Ioc") }).strict(),
                })
                .strict(),
              c: clientOrderIdSchema,
            })
            .strict(),
        ]),
        grouping: z.literal("na"),
      })
      .strict(),
  })
  .strict();

const providerOrderSchema = z
  .object({
    coin: z.string().min(1).max(128),
    side: z.enum(["B", "A"]),
    limitPx: positiveDecimalSchema,
    sz: nonnegativeDecimalSchema,
    oid: losslessNumberSchema,
    timestamp: losslessNumberSchema,
    triggerCondition: z.string().min(1).max(128),
    isTrigger: z.boolean(),
    triggerPx: nonnegativeDecimalSchema,
    children: z.array(z.unknown()).max(100),
    isPositionTpsl: z.boolean(),
    reduceOnly: z.boolean(),
    orderType: z.enum([
      "Market",
      "Limit",
      "Stop Market",
      "Stop Limit",
      "Take Profit Market",
      "Take Profit Limit",
      "Twap Slice",
      "Vault Close",
      "Spot Dust Conversion",
    ]),
    origSz: positiveDecimalSchema,
    tif: z
      .enum(["Gtc", "Ioc", "Alo", "FrontendMarket", "LiquidationMarket"])
      .nullable(),
    cloid: clientOrderIdSchema.nullable(),
  })
  .strict();
const orderStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknownOid") }).strict(),
  z
    .object({
      status: z.literal("order"),
      order: z
        .object({
          order: providerOrderSchema,
          status: z.string().min(1).max(128),
          statusTimestamp: losslessNumberSchema,
        })
        .strict(),
    })
    .strict(),
]);
const frontendOpenOrdersSchema = z
  .array(providerOrderSchema)
  .max(openOrderSafetyCap);
const historicalOrderSchema = z
  .object({
    order: providerOrderSchema,
    status: z.string().min(1).max(128),
    statusTimestamp: losslessNumberSchema,
  })
  .strict();
const historicalOrdersSchema = z
  .array(historicalOrderSchema)
  .max(historicalOrderProviderCap);
const liquidationSchema = z
  .object({
    liquidatedUser: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    markPx: positiveDecimalSchema,
    method: z.enum(["market", "backstop"]),
  })
  .strict();
const userFillSchema = z
  .object({
    coin: z.string().min(1).max(128),
    px: positiveDecimalSchema,
    sz: positiveDecimalSchema,
    side: z.enum(["B", "A"]),
    time: losslessNumberSchema,
    startPosition: signedDecimalSchema,
    dir: z.string().min(1).max(64),
    closedPnl: signedDecimalSchema,
    hash: z.string().regex(transactionHashPattern),
    oid: losslessNumberSchema,
    crossed: z.boolean(),
    fee: signedDecimalSchema,
    builderFee: signedDecimalSchema.optional(),
    tid: losslessNumberSchema,
    feeToken: z.string().min(1).max(128),
    feeTrialEscrow: signedDecimalSchema.optional(),
    twapId: losslessNumberSchema.nullable(),
    cloid: clientOrderIdSchema.nullable().optional(),
    liquidation: liquidationSchema.optional(),
  })
  .strict();
const userFillsSchema = z.array(userFillSchema).max(fillProviderCap);
const balanceSchema = z
  .object({
    coin: z.string().min(1).max(128),
    token: losslessNumberSchema,
    total: nonnegativeDecimalSchema,
    hold: nonnegativeDecimalSchema,
    entryNtl: signedDecimalSchema,
  })
  .strict();
const balancesResponseSchema = z
  .object({ balances: z.array(balanceSchema).max(balanceSafetyCap) })
  .strict();

export type HyperliquidSpotOrderReconciliationReadResult =
  SpotOrderAuthoritativeReadResult;

export interface HyperliquidSpotOrderReconciliationReadInput {
  readonly readRequestId: string;
  readonly subject: SpotIntentReconciliationSubject;
  readonly signal: AbortSignal;
}

export type HyperliquidSpotOrderReconciliationReader =
  SpotOrderAuthoritativeReader;

export interface CreateHyperliquidSpotOrderReconciliationReaderInput {
  readonly transport: HyperliquidSpotInfoTransport;
  readonly quota: HyperliquidInfoQuota;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}

function fail(reasonCode: string): never {
  if (!reasonCodePattern.test(reasonCode)) {
    throw new TypeError("Spot reconciliation reason code is invalid");
  }
  throw new EvidenceFailure(reasonCode);
}

function operatorRequired(
  reasonCode: string,
): HyperliquidSpotOrderReconciliationReadResult {
  return Object.freeze({ kind: "operator_required", reasonCode });
}

function pending(
  reasonCode: string,
): HyperliquidSpotOrderReconciliationReadResult {
  return Object.freeze({ kind: "pending", reasonCode });
}

function retry(
  reasonCode: string,
): HyperliquidSpotOrderReconciliationReadResult {
  return Object.freeze({ kind: "retry", reasonCode });
}

function readNow(now: () => Date): number {
  const milliseconds = now().getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return fail("invalid_reconciliation_clock");
  }
  return milliseconds;
}

function rawInteger(value: LosslessJsonNumber, maximum: bigint): string {
  const text = value.toString();
  if (!unsignedIntegerPattern.test(text)) {
    return fail("hyperliquid_evidence_malformed");
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    return fail("hyperliquid_evidence_malformed");
  }
  if (parsed > maximum) {
    return fail("hyperliquid_evidence_malformed");
  }
  return text;
}

function timestamp(value: LosslessJsonNumber): number {
  const parsed = Number(rawInteger(value, maximumSafeInteger));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fail("hyperliquid_evidence_malformed");
  }
  return parsed;
}

function mapOrder(order: z.infer<typeof providerOrderSchema>): MappedOrder {
  return Object.freeze({
    coin: order.coin,
    side: order.side,
    limitPrice: order.limitPx,
    remainingSize: order.sz,
    orderId: rawInteger(order.oid, maximumUnsigned64),
    timestamp: timestamp(order.timestamp),
    originalSize: order.origSz,
    reduceOnly: order.reduceOnly,
    orderType: order.orderType,
    timeInForce: order.tif,
    clientOrderId: order.cloid,
    triggerCondition: order.triggerCondition,
    isTrigger: order.isTrigger,
    triggerPrice: order.triggerPx,
    childCount: order.children.length,
    isPositionTpsl: order.isPositionTpsl,
  });
}

function mapFill(fill: z.infer<typeof userFillSchema>): MappedFill {
  return Object.freeze({
    coin: fill.coin,
    side: fill.side,
    price: fill.px,
    size: fill.sz,
    orderId: rawInteger(fill.oid, maximumUnsigned64),
    tradeId: rawInteger(fill.tid, maximumUnsigned64),
    timestamp: timestamp(fill.time),
    clientOrderId: fill.cloid ?? null,
    twapId:
      fill.twapId === null ? null : rawInteger(fill.twapId, maximumUnsigned64),
    crossed: fill.crossed,
    fee: fill.fee,
    feeToken: fill.feeToken,
    hasBuilderFee: fill.builderFee !== undefined,
    hasFeeTrialEscrow: fill.feeTrialEscrow !== undefined,
    hasLiquidation: fill.liquidation !== undefined,
  });
}

function mapHistoricalOrder(
  value: z.infer<typeof historicalOrderSchema>,
): MappedHistoricalOrder {
  return Object.freeze({
    order: mapOrder(value.order),
    status: value.status,
    statusTimestamp: timestamp(value.statusTimestamp),
  });
}

function isExactExpectedOrder(
  order: MappedOrder,
  expected: ExpectedSpotOrder,
): boolean {
  return (
    order.coin === expected.providerCoin &&
    order.side === expected.sideCode &&
    exactUnsignedDecimalsEqual(order.limitPrice, expected.limitPrice) &&
    exactUnsignedDecimalsEqual(order.originalSize, expected.originalSize) &&
    order.reduceOnly === false &&
    order.orderType === "Limit" &&
    order.timeInForce === "Ioc" &&
    order.clientOrderId === expected.clientOrderId &&
    order.triggerCondition === "N/A" &&
    order.isTrigger === false &&
    zeroDecimalPattern.test(order.triggerPrice) &&
    order.childCount === 0 &&
    order.isPositionTpsl === false
  );
}

function validateExpectedOrder(
  input: HyperliquidSpotOrderReconciliationReadInput,
  readStartedAt: number,
): ExpectedSpotOrder {
  if (
    !(input.signal instanceof AbortSignal) ||
    typeof input.readRequestId !== "string" ||
    !uuidPattern.test(input.readRequestId)
  ) {
    return fail("invalid_reconciliation_read_input");
  }
  const parsedSubject = reconciliationSubjectSchema.safeParse(input.subject);
  if (!parsedSubject.success) {
    return fail("invalid_spot_reconciliation_subject");
  }
  const subject = parsedSubject.data;
  const [order] = subject.canonicalAction.orders;
  const expectedProviderCoin =
    subject.spotPairIndex === 0 ? "PURR/USDC" : `@${subject.spotPairIndex}`;
  if (
    subject.providerCoin !== expectedProviderCoin ||
    subject.baseTokenId === subject.quoteTokenId ||
    subject.baseDisplayIdentity === subject.quoteDisplayIdentity ||
    subject.baseTokenIndex === subject.quoteTokenIndex ||
    subject.exchangeOrderAsset !== 10_000 + subject.spotPairIndex ||
    order.a !== subject.exchangeOrderAsset ||
    order.b !== (subject.side === "buy") ||
    order.p !== subject.worstIocLimitPrice ||
    order.s !== subject.computedBaseSize ||
    order.c !== subject.clientOrderId
  ) {
    return fail("invalid_spot_reconciliation_subject");
  }

  const attemptCommittedAt = Date.parse(subject.attemptCommittedAt);
  if (
    !Number.isSafeInteger(attemptCommittedAt) ||
    attemptCommittedAt < 0 ||
    attemptCommittedAt > readStartedAt ||
    new Date(attemptCommittedAt).toISOString() !== subject.attemptCommittedAt
  ) {
    return fail("invalid_spot_reconciliation_subject");
  }
  if (readStartedAt - attemptCommittedAt > sevenDaysMilliseconds) {
    return fail("hyperliquid_fill_window_expired");
  }

  return Object.freeze({
    accountAddress: subject.accountAddress,
    providerCoin: subject.providerCoin,
    side: subject.side,
    sideCode: subject.side === "buy" ? "B" : "A",
    limitPrice: subject.worstIocLimitPrice,
    originalSize: subject.computedBaseSize,
    clientOrderId: subject.clientOrderId,
    attemptCommittedAt,
    baseTokenIndex: subject.baseTokenIndex,
    baseTokenId: subject.baseTokenId,
    baseDisplayIdentity: subject.baseDisplayIdentity,
    quoteTokenIndex: subject.quoteTokenIndex,
    quoteTokenId: subject.quoteTokenId,
    quoteDisplayIdentity: subject.quoteDisplayIdentity,
  });
}

function createCallIds(
  createUuid: () => string,
  readRequestId: string,
): readonly string[] {
  const ids = Array.from({ length: requiredInfoCallCount }, () => createUuid());
  if (
    ids.some(
      (id) =>
        typeof id !== "string" || !uuidPattern.test(id) || id === readRequestId,
    ) ||
    new Set(ids).size !== requiredInfoCallCount
  ) {
    return fail("invalid_reconciliation_call_id");
  }
  return Object.freeze(ids);
}

async function collectEvidence(
  transport: HyperliquidSpotInfoTransport,
  expected: ExpectedSpotOrder,
  fillWindowEnd: number,
  signal: AbortSignal,
  callIds: readonly string[],
): Promise<readonly [unknown, unknown, unknown, unknown, unknown]> {
  const requests: readonly HyperliquidSpotInfoRequest[] = Object.freeze([
    {
      type: "orderStatus",
      user: expected.accountAddress,
      oid: expected.clientOrderId,
    },
    {
      type: "frontendOpenOrders",
      user: expected.accountAddress,
      dex: "",
    },
    {
      type: "userFillsByTime",
      user: expected.accountAddress,
      startTime: expected.attemptCommittedAt,
      endTime: fillWindowEnd,
      aggregateByTime: false,
    },
    { type: "historicalOrders", user: expected.accountAddress },
    { type: "spotClearinghouseState", user: expected.accountAddress },
  ]);
  const evidence: unknown[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    signal.throwIfAborted();
    const request = requests[index];
    const callId = callIds[index];
    if (request === undefined || callId === undefined) {
      return fail("invalid_reconciliation_call_id");
    }
    evidence.push(await transport.post(request, signal, callId));
  }
  const [orderStatus, openOrders, fills, historicalOrders, balances] = evidence;
  if (
    orderStatus === undefined ||
    openOrders === undefined ||
    fills === undefined ||
    historicalOrders === undefined ||
    balances === undefined
  ) {
    return fail("hyperliquid_evidence_malformed");
  }
  return [orderStatus, openOrders, fills, historicalOrders, balances];
}

function validateOpenOrders(
  raw: unknown,
  expected: ExpectedSpotOrder,
): readonly MappedOrder[] {
  const parsed = frontendOpenOrdersSchema.parse(raw);
  if (parsed.length === openOrderSafetyCap) {
    return fail("hyperliquid_evidence_truncated");
  }
  const orders = parsed.map(mapOrder);
  const orderIds = new Set<string>();
  const clientOrderIds = new Set<string>();
  for (const order of orders) {
    if (orderIds.has(order.orderId)) {
      return fail("hyperliquid_snapshot_conflict");
    }
    orderIds.add(order.orderId);
    if (order.clientOrderId !== null) {
      if (clientOrderIds.has(order.clientOrderId)) {
        return fail("hyperliquid_snapshot_conflict");
      }
      clientOrderIds.add(order.clientOrderId);
    }
    if (
      order.clientOrderId === expected.clientOrderId &&
      order.timestamp < expected.attemptCommittedAt
    ) {
      return fail("hyperliquid_order_identity_conflict");
    }
  }
  return Object.freeze(orders);
}

function validateFills(
  raw: unknown,
  expected: ExpectedSpotOrder,
  fillWindowEnd: number,
): readonly MappedFill[] {
  const parsed = userFillsSchema.parse(raw);
  if (parsed.length === fillProviderCap) {
    return fail("hyperliquid_evidence_truncated");
  }
  const fills = parsed.map(mapFill);
  const tradeIds = new Set<string>();
  for (const fill of fills) {
    if (
      tradeIds.has(fill.tradeId) ||
      fill.timestamp < expected.attemptCommittedAt ||
      fill.timestamp > fillWindowEnd
    ) {
      return fail("hyperliquid_evidence_malformed");
    }
    tradeIds.add(fill.tradeId);
  }
  return Object.freeze(fills);
}

function validateHistoricalOrders(
  raw: unknown,
): readonly MappedHistoricalOrder[] {
  const parsed = historicalOrdersSchema.parse(raw);
  if (parsed.length === historicalOrderProviderCap) {
    return fail("hyperliquid_evidence_truncated");
  }
  const orders = parsed.map(mapHistoricalOrder);
  const orderIds = new Set<string>();
  const clientOrderIds = new Set<string>();
  for (const item of orders) {
    if (orderIds.has(item.order.orderId)) {
      return fail("hyperliquid_snapshot_conflict");
    }
    orderIds.add(item.order.orderId);
    if (item.order.clientOrderId !== null) {
      if (clientOrderIds.has(item.order.clientOrderId)) {
        return fail("hyperliquid_snapshot_conflict");
      }
      clientOrderIds.add(item.order.clientOrderId);
    }
  }
  return Object.freeze(orders);
}

function validateBalances(raw: unknown, expected: ExpectedSpotOrder): void {
  const parsed = balancesResponseSchema.parse(raw);
  if (parsed.balances.length === balanceSafetyCap) {
    return fail("hyperliquid_evidence_truncated");
  }
  const indexes = new Set<string>();
  for (const balance of parsed.balances) {
    const tokenIndex = rawInteger(balance.token, maximumPostgresInteger);
    if (indexes.has(tokenIndex)) {
      return fail("hyperliquid_snapshot_conflict");
    }
    indexes.add(tokenIndex);
    if (
      (tokenIndex === String(expected.baseTokenIndex) &&
        balance.coin !== expected.baseDisplayIdentity) ||
      (tokenIndex === String(expected.quoteTokenIndex) &&
        balance.coin !== expected.quoteDisplayIdentity)
    ) {
      return fail("hyperliquid_order_identity_conflict");
    }
    if (compareExactUnsignedDecimals(balance.hold, balance.total) > 0) {
      return fail("hyperliquid_snapshot_conflict");
    }
  }
}

function matchingOrders(
  orders: readonly MappedOrder[],
  expected: ExpectedSpotOrder,
  providerOrderId: string | null,
): readonly MappedOrder[] {
  return orders.filter(
    (order) =>
      order.clientOrderId === expected.clientOrderId ||
      (providerOrderId !== null && order.orderId === providerOrderId),
  );
}

function matchingFills(
  fills: readonly MappedFill[],
  expected: ExpectedSpotOrder,
  providerOrderId: string | null,
): readonly MappedFill[] {
  return fills.filter(
    (fill) =>
      fill.clientOrderId === expected.clientOrderId ||
      (providerOrderId !== null && fill.orderId === providerOrderId),
  );
}

function matchingHistory(
  history: readonly MappedHistoricalOrder[],
  expected: ExpectedSpotOrder,
  providerOrderId: string | null,
): readonly MappedHistoricalOrder[] {
  return history.filter(
    ({ order }) =>
      order.clientOrderId === expected.clientOrderId ||
      (providerOrderId !== null && order.orderId === providerOrderId),
  );
}

function validateMatchingHistory(
  history: readonly MappedHistoricalOrder[],
  statusOrder: MappedOrder,
  providerStatus: string,
  statusTimestamp: number,
  expected: ExpectedSpotOrder,
): "matched" | "pending" {
  const identified = matchingHistory(history, expected, statusOrder.orderId);
  if (identified.length === 0) {
    return "pending";
  }
  const item = identified[0];
  if (
    identified.length !== 1 ||
    item === undefined ||
    item.order.orderId !== statusOrder.orderId ||
    !isExactExpectedOrder(item.order, expected) ||
    !exactUnsignedDecimalsEqual(
      item.order.remainingSize,
      statusOrder.remainingSize,
    ) ||
    item.order.timestamp !== statusOrder.timestamp ||
    item.status !== providerStatus ||
    item.statusTimestamp !== statusTimestamp
  ) {
    return fail("hyperliquid_snapshot_conflict");
  }
  return "matched";
}

function terminalFillResolution(
  fills: readonly MappedFill[],
  expected: ExpectedSpotOrder,
  providerOrderId: string,
  orderTimestamp: number,
  statusTimestamp: number,
  observedAt: number,
): SpotIntentTerminalResolution | null {
  if (fills.length === 0) {
    return null;
  }
  let feeToken: string | undefined;
  const quoteParts: string[] = [];
  const feeParts: string[] = [];
  for (const fill of fills) {
    if (
      fill.orderId !== providerOrderId ||
      (fill.clientOrderId !== null &&
        fill.clientOrderId !== expected.clientOrderId) ||
      fill.coin !== expected.providerCoin ||
      fill.side !== expected.sideCode ||
      fill.timestamp < orderTimestamp ||
      fill.twapId !== null ||
      fill.crossed !== true ||
      (expected.side === "buy"
        ? compareExactUnsignedDecimals(fill.price, expected.limitPrice) > 0
        : compareExactUnsignedDecimals(fill.price, expected.limitPrice) < 0)
    ) {
      return fail("hyperliquid_order_identity_conflict");
    }
    if (fill.timestamp > statusTimestamp) {
      return fail("hyperliquid_snapshot_conflict");
    }
    if (fill.hasBuilderFee || fill.hasFeeTrialEscrow || fill.hasLiquidation) {
      return fail("hyperliquid_ancillary_fill_evidence_unsupported");
    }
    if (!nonnegativeDecimalPattern.test(fill.fee)) {
      return fail("hyperliquid_negative_fee_unsupported");
    }
    if (
      fill.feeToken !== expected.baseDisplayIdentity &&
      fill.feeToken !== expected.quoteDisplayIdentity
    ) {
      return fail("hyperliquid_fee_identity_unsupported");
    }
    feeToken ??= fill.feeToken;
    if (feeToken !== fill.feeToken) {
      return fail("hyperliquid_mixed_fee_identity_unsupported");
    }
    const quotePart = multiplyExactUnsignedDecimals(fill.size, fill.price);
    if (quotePart === null) {
      return fail("hyperliquid_evidence_malformed");
    }
    quoteParts.push(quotePart);
    feeParts.push(fill.fee);
  }

  const filledBaseSize = addExactUnsignedDecimals(
    fills.map((fill) => fill.size),
  );
  const quoteAmount = addExactUnsignedDecimals(quoteParts);
  const feeAmount = addExactUnsignedDecimals(feeParts);
  if (
    filledBaseSize === null ||
    quoteAmount === null ||
    feeAmount === null ||
    feeToken === undefined
  ) {
    return fail("hyperliquid_evidence_malformed");
  }
  const fillSizeComparison = compareExactUnsignedDecimals(
    filledBaseSize,
    expected.originalSize,
  );
  if (fillSizeComparison < 0) {
    return fail("hyperliquid_partial_fill_unsupported");
  }
  if (fillSizeComparison > 0) {
    return fail("hyperliquid_snapshot_conflict");
  }
  const averageFillPrice = divideExactUnsignedDecimals(
    quoteAmount,
    filledBaseSize,
  );
  if (averageFillPrice === null) {
    return fail("hyperliquid_average_price_unsupported");
  }

  const feeIsBase = feeToken === expected.baseDisplayIdentity;
  const feeEconomicMaximum = feeIsBase ? filledBaseSize : quoteAmount;
  if (compareExactUnsignedDecimals(feeAmount, feeEconomicMaximum) > 0) {
    return fail("hyperliquid_fee_amount_unsupported");
  }
  return Object.freeze({
    state: "filled",
    providerOrderId,
    clientOrderId: expected.clientOrderId,
    filledBaseSize,
    quoteAmount,
    averageFillPrice,
    fee: Object.freeze({
      amount: feeAmount,
      tokenIndex: feeIsBase
        ? expected.baseTokenIndex
        : expected.quoteTokenIndex,
      tokenId: feeIsBase ? expected.baseTokenId : expected.quoteTokenId,
      assetDisplayIdentity: feeToken,
    }),
    observedAt: new Date(observedAt).toISOString(),
    reasonCode: null,
  });
}

function notFilledResolution(
  expected: ExpectedSpotOrder,
  providerOrderId: string,
  observedAt: number,
): Extract<SpotIntentTerminalResolution, { readonly state: "not_filled" }> {
  return Object.freeze({
    state: "not_filled",
    providerOrderId,
    clientOrderId: expected.clientOrderId,
    filledBaseSize: null,
    quoteAmount: null,
    averageFillPrice: null,
    fee: null,
    observedAt: new Date(observedAt).toISOString(),
    reasonCode: "hyperliquid_ioc_cancel_rejected",
  });
}

function rejectedResolution(
  expected: ExpectedSpotOrder,
  providerOrderId: string,
  observedAt: number,
  reasonCode: SpotRejectedReconciliationReasonCode,
): Extract<SpotIntentTerminalResolution, { readonly state: "rejected" }> {
  return Object.freeze({
    state: "rejected",
    providerOrderId,
    clientOrderId: expected.clientOrderId,
    filledBaseSize: null,
    quoteAmount: null,
    averageFillPrice: null,
    fee: null,
    observedAt: new Date(observedAt).toISOString(),
    reasonCode,
  });
}

function reconcileEvidence(
  rawOrderStatus: unknown,
  rawOpenOrders: unknown,
  rawFills: unknown,
  rawHistoricalOrders: unknown,
  rawBalances: unknown,
  expected: ExpectedSpotOrder,
  fillWindowEnd: number,
  observedAt: number,
): HyperliquidSpotOrderReconciliationReadResult {
  if (observedAt < fillWindowEnd) {
    return fail("invalid_reconciliation_clock");
  }
  const statusResponse = orderStatusSchema.parse(rawOrderStatus);
  const openOrders = validateOpenOrders(rawOpenOrders, expected);
  const fills = validateFills(rawFills, expected, fillWindowEnd);
  const history = validateHistoricalOrders(rawHistoricalOrders);
  validateBalances(rawBalances, expected);

  if (statusResponse.status === "unknownOid") {
    if (
      matchingOrders(openOrders, expected, null).length > 0 ||
      matchingFills(fills, expected, null).length > 0 ||
      matchingHistory(history, expected, null).length > 0
    ) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    return pending("hyperliquid_unknown_oid");
  }

  const statusOrder = mapOrder(statusResponse.order.order);
  const providerStatus = statusResponse.order.status;
  const statusTimestamp = timestamp(statusResponse.order.statusTimestamp);
  if (
    !isExactExpectedOrder(statusOrder, expected) ||
    statusOrder.timestamp < expected.attemptCommittedAt ||
    statusTimestamp < statusOrder.timestamp ||
    statusTimestamp > observedAt
  ) {
    return operatorRequired("hyperliquid_order_identity_conflict");
  }
  if (
    statusOrder.timestamp > fillWindowEnd ||
    statusTimestamp > fillWindowEnd
  ) {
    return pending("hyperliquid_evidence_window_pending");
  }

  const identifiedOpenOrders = matchingOrders(
    openOrders,
    expected,
    statusOrder.orderId,
  );
  if (
    identifiedOpenOrders.some(
      (order) =>
        order.orderId !== statusOrder.orderId ||
        !isExactExpectedOrder(order, expected),
    )
  ) {
    return operatorRequired("hyperliquid_order_identity_conflict");
  }
  const identifiedFills = matchingFills(fills, expected, statusOrder.orderId);
  const recognizedTerminalStatus =
    providerStatus === "filled" ||
    providerStatus === "iocCancelRejected" ||
    Object.hasOwn(rejectionStatusToReason, providerStatus);
  if (!recognizedTerminalStatus) {
    return operatorRequired(
      identifiedFills.length > 0
        ? "hyperliquid_partial_fill_unsupported"
        : providerStatus === "open"
          ? "hyperliquid_nonterminal_order_status"
          : "hyperliquid_unknown_order_status",
    );
  }
  if (providerStatus !== "filled" && identifiedFills.length > 0) {
    return operatorRequired("hyperliquid_partial_fill_unsupported");
  }
  if (
    validateMatchingHistory(
      history,
      statusOrder,
      providerStatus,
      statusTimestamp,
      expected,
    ) === "pending"
  ) {
    return pending("hyperliquid_history_pending");
  }

  if (providerStatus === "filled") {
    if (
      identifiedOpenOrders.length !== 0 ||
      !zeroDecimalPattern.test(statusOrder.remainingSize)
    ) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    const resolution = terminalFillResolution(
      identifiedFills,
      expected,
      statusOrder.orderId,
      statusOrder.timestamp,
      statusTimestamp,
      observedAt,
    );
    return resolution === null
      ? operatorRequired("hyperliquid_snapshot_conflict")
      : Object.freeze({ kind: "resolved", resolution });
  }

  if (providerStatus === "iocCancelRejected") {
    if (
      identifiedOpenOrders.length !== 0 ||
      identifiedFills.length !== 0 ||
      !exactUnsignedDecimalsEqual(
        statusOrder.remainingSize,
        expected.originalSize,
      )
    ) {
      return operatorRequired("hyperliquid_partial_fill_unsupported");
    }
    return Object.freeze({
      kind: "resolved",
      resolution: notFilledResolution(
        expected,
        statusOrder.orderId,
        observedAt,
      ),
    });
  }

  if (Object.hasOwn(rejectionStatusToReason, providerStatus)) {
    if (
      identifiedOpenOrders.length !== 0 ||
      identifiedFills.length !== 0 ||
      !exactUnsignedDecimalsEqual(
        statusOrder.remainingSize,
        expected.originalSize,
      )
    ) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    const reasonCode =
      rejectionStatusToReason[
        providerStatus as keyof typeof rejectionStatusToReason
      ];
    return Object.freeze({
      kind: "resolved",
      resolution: rejectedResolution(
        expected,
        statusOrder.orderId,
        observedAt,
        reasonCode,
      ),
    });
  }

  return operatorRequired("hyperliquid_unknown_order_status");
}

export function createHyperliquidSpotOrderReconciliationReader(
  input: CreateHyperliquidSpotOrderReconciliationReaderInput,
): HyperliquidSpotOrderReconciliationReader {
  const now = input.now ?? (() => new Date());
  const createUuid = input.createUuid ?? randomUUID;

  return Object.freeze({
    async read(
      readInput: HyperliquidSpotOrderReconciliationReadInput,
    ): Promise<HyperliquidSpotOrderReconciliationReadResult> {
      try {
        const readStartedAt = readNow(now);
        const expected = validateExpectedOrder(readInput, readStartedAt);
        readInput.signal.throwIfAborted();
        const callIds = createCallIds(createUuid, readInput.readRequestId);

        try {
          await input.quota.reserveWeight(
            HYPERLIQUID_SPOT_ORDER_RECONCILIATION_INFO_WEIGHT,
            readInput.signal,
          );
        } catch {
          readInput.signal.throwIfAborted();
          return retry("hyperliquid_info_quota_unavailable");
        }
        readInput.signal.throwIfAborted();

        const [
          rawOrderStatus,
          rawOpenOrders,
          rawFills,
          rawHistoricalOrders,
          rawBalances,
        ] = await collectEvidence(
          input.transport,
          expected,
          readStartedAt,
          readInput.signal,
          callIds,
        );
        readInput.signal.throwIfAborted();
        const observedAt = readNow(now);
        return reconcileEvidence(
          rawOrderStatus,
          rawOpenOrders,
          rawFills,
          rawHistoricalOrders,
          rawBalances,
          expected,
          readStartedAt,
          observedAt,
        );
      } catch (error) {
        readInput.signal.throwIfAborted();
        if (error instanceof RetryableHyperliquidSpotInfoError) {
          return retry("hyperliquid_info_retryable");
        }
        if (error instanceof EvidenceFailure) {
          return operatorRequired(error.reasonCode);
        }
        if (error instanceof HyperliquidSpotInfoUnavailableError) {
          return operatorRequired("hyperliquid_evidence_unavailable");
        }
        return operatorRequired("hyperliquid_evidence_malformed");
      }
    },
  });
}
