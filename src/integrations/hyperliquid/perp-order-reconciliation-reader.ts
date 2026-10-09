import { randomUUID } from "node:crypto";

import { isLosslessNumber } from "lossless-json";
import { z } from "zod";

import type {
  PerpOrderAuthoritativeReader,
  PerpOrderAuthoritativeReadResult,
} from "../../features/perp/perp-order-reconciliation-handler.js";
import type {
  PerpOrderReconciliationResolution,
  PerpOrderReconciliationResolutionItem,
  PerpReconciliationCoin,
  PerpReconciliationSubject,
} from "../../features/perp/perp-reconciliation-contract.js";
import { parsePerpIntentRequest } from "../../features/perp/perp-intent-contract.js";
import type { HyperliquidInfoQuota } from "./info-quota.js";
import type {
  HyperliquidInfoRequest,
  HyperliquidLosslessInfoTransport,
} from "./lossless-info-transport.js";
import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
} from "./private-reader.js";

const addressPattern = /^0x[0-9a-f]{40}$/;
const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const decimalPattern =
  /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|-(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*))$/;
const nonnegativeDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const positiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const zeroDecimalPattern = /^0(?:\.0+)?$/;
const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/;
const reasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const maximumUnsigned64 = 18_446_744_073_709_551_615n;
const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const maximumDecimalLength = 128;
const sevenDaysMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const fillProviderCap = 2_000;
const frontendOrderSafetyCap = 5_000;
const positionSafetyCap = 2_000;
const requiredInfoCallCount = 4;

export const HYPERLIQUID_PERP_ORDER_RECONCILIATION_INFO_WEIGHT = 144;

const cancellationStatuses = new Set([
  "canceled",
  "delistedCanceled",
  "liquidatedCanceled",
  "marginCanceled",
  "openInterestCapCanceled",
  "reduceOnlyCanceled",
  "scheduledCancel",
  "selfTradeCanceled",
]);
const rejectionStatuses = new Set([
  "badAloPxRejected",
  "iocCancelRejected",
  "marketOrderNoLiquidityRejected",
  "minTradeNtlRejected",
  "openInterestIncreaseRejected",
  "oracleRejected",
  "perpMarginRejected",
  "perpMaxPositionRejected",
  "positionFlipAtOpenInterestCapRejected",
  "positionIncreaseAtOpenInterestCapRejected",
  "reduceOnlyRejected",
  "rejected",
  "tickRejected",
  "tooAggressiveAtOpenInterestCapRejected",
]);
const excludedStatuses = new Set([
  "badTriggerPxRejected",
  "insufficientSpotBalanceRejected",
  "siblingFilledCanceled",
  "triggered",
  "vaultWithdrawalCanceled",
]);

interface LosslessJsonNumber {
  readonly isLosslessNumber: true;
  toString(): string;
}

interface ExpectedOrder {
  readonly accountAddress: string;
  readonly coin: PerpReconciliationCoin;
  readonly side: "buy" | "sell";
  readonly sideCode: "B" | "A";
  readonly limitPrice: string;
  readonly originalSize: string;
  readonly reduceOnly: boolean;
  readonly timeInForce: "gtc" | "alo" | "ioc";
  readonly providerTimeInForce: "Gtc" | "Alo" | "Ioc";
  readonly clientOrderId: string;
  readonly attemptCommittedAt: number;
  readonly index: number;
}

interface DecimalValue {
  readonly coefficient: bigint;
  readonly scale: number;
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
  readonly feeToken: string;
}

class EvidenceFailure extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super("Hyperliquid reconciliation evidence is unusable");
    this.name = "EvidenceFailure";
    this.reasonCode = reasonCode;
  }
}

const losslessNumberSchema = z.custom<LosslessJsonNumber>((value) =>
  isLosslessNumber(value),
);
const decimalStringSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(decimalPattern);
const nonnegativeDecimalStringSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(nonnegativeDecimalPattern);
const positiveDecimalStringSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(positiveDecimalPattern);
const clientOrderIdSchema = z.string().regex(clientOrderIdPattern);

const providerOrderSchema = z
  .object({
    coin: z.string().min(1).max(128),
    side: z.enum(["B", "A"]),
    limitPx: positiveDecimalStringSchema,
    sz: nonnegativeDecimalStringSchema,
    oid: losslessNumberSchema,
    timestamp: losslessNumberSchema,
    triggerCondition: z.string().min(1).max(128),
    isTrigger: z.boolean(),
    triggerPx: nonnegativeDecimalStringSchema,
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
    origSz: positiveDecimalStringSchema,
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
const frontendOrdersSchema = z
  .array(providerOrderSchema)
  .max(frontendOrderSafetyCap);

const liquidationSchema = z
  .object({
    liquidatedUser: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    markPx: positiveDecimalStringSchema,
    method: z.enum(["market", "backstop"]),
  })
  .strict();
const userFillSchema = z
  .object({
    coin: z.string().min(1).max(128),
    px: positiveDecimalStringSchema,
    sz: positiveDecimalStringSchema,
    side: z.enum(["B", "A"]),
    time: losslessNumberSchema,
    startPosition: decimalStringSchema,
    dir: z.string().min(1).max(64),
    closedPnl: decimalStringSchema,
    hash: z.string().regex(transactionHashPattern),
    oid: losslessNumberSchema,
    crossed: z.boolean(),
    fee: decimalStringSchema,
    builderFee: decimalStringSchema.optional(),
    tid: losslessNumberSchema,
    feeToken: z.string().min(1).max(32),
    feeTrialEscrow: positiveDecimalStringSchema.optional(),
    twapId: losslessNumberSchema.nullable(),
    cloid: clientOrderIdSchema.optional(),
    liquidation: liquidationSchema.optional(),
  })
  .strict();
const userFillsSchema = z.array(userFillSchema).max(fillProviderCap);

const marginSummarySchema = z
  .object({
    accountValue: decimalStringSchema,
    totalNtlPos: decimalStringSchema,
    totalRawUsd: decimalStringSchema,
    totalMarginUsed: decimalStringSchema,
  })
  .strict();
const cumulativeFundingSchema = z
  .object({
    allTime: decimalStringSchema,
    sinceOpen: decimalStringSchema,
    sinceChange: decimalStringSchema,
  })
  .strict();
const leverageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cross"),
      value: losslessNumberSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("isolated"),
      value: losslessNumberSchema,
      rawUsd: decimalStringSchema,
    })
    .strict(),
]);
const assetPositionSchema = z
  .object({
    type: z.literal("oneWay"),
    position: z
      .object({
        coin: z.string().min(1).max(128),
        szi: decimalStringSchema,
        leverage: leverageSchema,
        entryPx: positiveDecimalStringSchema.nullable(),
        positionValue: decimalStringSchema,
        unrealizedPnl: decimalStringSchema,
        returnOnEquity: decimalStringSchema,
        liquidationPx: positiveDecimalStringSchema.nullable(),
        marginUsed: decimalStringSchema,
        maxLeverage: losslessNumberSchema,
        cumFunding: cumulativeFundingSchema,
      })
      .strict(),
  })
  .strict();
const clearinghouseStateSchema = z
  .object({
    marginSummary: marginSummarySchema,
    crossMarginSummary: marginSummarySchema,
    crossMaintenanceMarginUsed: decimalStringSchema,
    withdrawable: decimalStringSchema,
    assetPositions: z.array(assetPositionSchema).max(positionSafetyCap),
    time: losslessNumberSchema,
  })
  .strict();

export type HyperliquidPerpOrderReconciliationReadResult =
  PerpOrderAuthoritativeReadResult;

export interface HyperliquidPerpOrderReconciliationReadInput {
  readonly readRequestId: string;
  readonly subject: PerpReconciliationSubject;
  readonly signal: AbortSignal;
}

export type HyperliquidPerpOrderReconciliationReader =
  PerpOrderAuthoritativeReader;

export interface CreateHyperliquidPerpOrderReconciliationReaderInput {
  readonly transport: HyperliquidLosslessInfoTransport;
  readonly quota: HyperliquidInfoQuota;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}

function fail(reasonCode: string): never {
  if (!reasonCodePattern.test(reasonCode)) {
    throw new TypeError("Reconciliation reason code is invalid");
  }
  throw new EvidenceFailure(reasonCode);
}

function operatorRequired(
  reasonCode: string,
): HyperliquidPerpOrderReconciliationReadResult {
  return Object.freeze({ kind: "operator_required", reasonCode });
}

function retry(
  reasonCode: string,
): HyperliquidPerpOrderReconciliationReadResult {
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

function decimalValue(value: string): DecimalValue {
  const [integer = "", fraction = ""] = value.split(".");
  if (!nonnegativeDecimalPattern.test(value)) {
    return fail("hyperliquid_evidence_malformed");
  }
  return {
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

function alignDecimals(
  left: DecimalValue,
  right: DecimalValue,
): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient =
    right.coefficient * 10n ** BigInt(scale - right.scale);
  return [leftCoefficient, rightCoefficient, scale];
}

function decimalEquals(left: string, right: string): boolean {
  const [leftCoefficient, rightCoefficient] = alignDecimals(
    decimalValue(left),
    decimalValue(right),
  );
  return leftCoefficient === rightCoefficient;
}

function decimalCompare(left: string, right: string): number {
  const [leftCoefficient, rightCoefficient] = alignDecimals(
    decimalValue(left),
    decimalValue(right),
  );
  return leftCoefficient === rightCoefficient
    ? 0
    : leftCoefficient < rightCoefficient
      ? -1
      : 1;
}

function formatDecimal(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) {
    return "0";
  }
  let digits = coefficient.toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    const splitAt = digits.length - scale;
    digits = `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
    digits = digits.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (digits.length > maximumDecimalLength) {
    return fail("hyperliquid_evidence_malformed");
  }
  return digits;
}

function addDecimals(values: readonly string[]): string {
  let total: DecimalValue = { coefficient: 0n, scale: 0 };
  for (const value of values) {
    const next = decimalValue(value);
    const [left, right, scale] = alignDecimals(total, next);
    total = { coefficient: left + right, scale };
  }
  return formatDecimal(total.coefficient, total.scale);
}

function mapOrder(order: z.infer<typeof providerOrderSchema>): MappedOrder {
  return {
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
  };
}

function mapFill(fill: z.infer<typeof userFillSchema>): MappedFill {
  return {
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
    feeToken: fill.feeToken,
  };
}

function isExactExpectedOrder(
  order: MappedOrder,
  expected: ExpectedOrder,
): boolean {
  return (
    order.coin === expected.coin &&
    order.side === expected.sideCode &&
    decimalEquals(order.limitPrice, expected.limitPrice) &&
    decimalEquals(order.originalSize, expected.originalSize) &&
    order.reduceOnly === expected.reduceOnly &&
    order.orderType === "Limit" &&
    order.timeInForce === expected.providerTimeInForce &&
    order.clientOrderId === expected.clientOrderId &&
    order.triggerCondition === "N/A" &&
    order.isTrigger === false &&
    zeroDecimalPattern.test(order.triggerPrice) &&
    order.childCount === 0 &&
    order.isPositionTpsl === false
  );
}

function validateExpectedOrder(
  input: HyperliquidPerpOrderReconciliationReadInput,
  readStartedAt: number,
): ExpectedOrder {
  if (
    !(input.signal instanceof AbortSignal) ||
    typeof input.readRequestId !== "string" ||
    !uuidPattern.test(input.readRequestId)
  ) {
    return fail("invalid_reconciliation_read_input");
  }
  const subject = input.subject;
  if (
    typeof subject.operationId !== "string" ||
    !uuidPattern.test(subject.operationId) ||
    typeof subject.ownerUserId !== "string" ||
    !uuidPattern.test(subject.ownerUserId) ||
    !addressPattern.test(subject.accountAddress) ||
    subject.accountAddress === `0x${"0".repeat(40)}` ||
    !["master", "subaccount"].includes(subject.accountKind) ||
    !positiveIntegerPattern.test(subject.intentRecordVersion)
  ) {
    return fail("invalid_perp_reconciliation_subject");
  }

  if (subject.action !== "order") {
    return fail("unsupported_perp_reconciliation_action");
  }

  let canonicalAction: ReturnType<typeof parsePerpIntentRequest>;
  try {
    canonicalAction = parsePerpIntentRequest(subject.canonicalAction);
  } catch {
    return fail("invalid_perp_reconciliation_subject");
  }
  if (canonicalAction.action !== "order") {
    return fail("invalid_perp_reconciliation_subject");
  }
  if (canonicalAction.order_type !== "limit") {
    return fail("unsupported_perp_order_type");
  }

  if (subject.items.length !== 1) {
    return fail("invalid_perp_reconciliation_subject");
  }
  const item: PerpReconciliationSubject["items"][number] | undefined =
    subject.items[0];
  if (item === undefined) {
    return fail("invalid_perp_reconciliation_subject");
  }
  if (
    item.index !== 0 ||
    item.coin !== canonicalAction.coin ||
    item.targetKind !== null ||
    item.targetOrderId !== null ||
    item.targetClientOrderId !== null ||
    item.generatedClientOrderId === null ||
    !clientOrderIdPattern.test(item.generatedClientOrderId)
  ) {
    return fail(
      item.targetOrderId !== null || item.targetKind === "order_id"
        ? "numeric_order_id_not_supported"
        : "invalid_perp_reconciliation_subject",
    );
  }

  const attemptCommittedAt = Date.parse(subject.attemptCommittedAt);
  if (
    !Number.isSafeInteger(attemptCommittedAt) ||
    attemptCommittedAt < 0 ||
    attemptCommittedAt > readStartedAt ||
    new Date(attemptCommittedAt).toISOString() !== subject.attemptCommittedAt
  ) {
    return fail("invalid_perp_reconciliation_subject");
  }
  if (readStartedAt - attemptCommittedAt > sevenDaysMilliseconds) {
    return fail("hyperliquid_fill_window_expired");
  }

  const providerTimeInForce =
    canonicalAction.time_in_force === "gtc"
      ? "Gtc"
      : canonicalAction.time_in_force === "alo"
        ? "Alo"
        : "Ioc";
  return Object.freeze({
    accountAddress: subject.accountAddress,
    coin: canonicalAction.coin,
    side: canonicalAction.side,
    sideCode: canonicalAction.side === "buy" ? "B" : "A",
    limitPrice: canonicalAction.limit_price,
    originalSize: canonicalAction.size,
    reduceOnly: canonicalAction.reduce_only,
    timeInForce: canonicalAction.time_in_force,
    providerTimeInForce,
    clientOrderId: item.generatedClientOrderId,
    attemptCommittedAt,
    index: item.index,
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
  transport: HyperliquidLosslessInfoTransport,
  expected: ExpectedOrder,
  fillWindowEnd: number,
  signal: AbortSignal,
  callIds: readonly string[],
): Promise<readonly [unknown, unknown, unknown, unknown]> {
  const requests: readonly HyperliquidInfoRequest[] = Object.freeze([
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
    {
      type: "clearinghouseState",
      user: expected.accountAddress,
      dex: "",
    },
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
  const [orderStatus, openOrders, fills, clearinghouse] = evidence;
  if (
    orderStatus === undefined ||
    openOrders === undefined ||
    fills === undefined ||
    clearinghouse === undefined
  ) {
    return fail("hyperliquid_evidence_malformed");
  }
  return [orderStatus, openOrders, fills, clearinghouse];
}

function validateOpenOrders(
  raw: unknown,
  expected: ExpectedOrder,
): readonly MappedOrder[] {
  const parsed = frontendOrdersSchema.parse(raw);
  if (parsed.length === frontendOrderSafetyCap) {
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
      order.timestamp < expected.attemptCommittedAt &&
      order.clientOrderId === expected.clientOrderId
    ) {
      return fail("hyperliquid_order_identity_conflict");
    }
  }
  return orders;
}

function validateFills(
  raw: unknown,
  expected: ExpectedOrder,
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
  return fills;
}

function validateClearinghouse(
  raw: unknown,
  earliestSnapshotTime: number,
  observedAt: number,
): void {
  const parsed = clearinghouseStateSchema.parse(raw);
  if (parsed.assetPositions.length === positionSafetyCap) {
    return fail("hyperliquid_evidence_truncated");
  }
  const coins = new Set<string>();
  for (const { position } of parsed.assetPositions) {
    if (coins.has(position.coin)) {
      return fail("hyperliquid_snapshot_conflict");
    }
    coins.add(position.coin);
    rawInteger(position.leverage.value, maximumSafeInteger);
    rawInteger(position.maxLeverage, maximumSafeInteger);
  }
  const snapshotTime = timestamp(parsed.time);
  if (snapshotTime < earliestSnapshotTime || snapshotTime > observedAt) {
    return fail("hyperliquid_snapshot_conflict");
  }
}

function matchingOpenOrders(
  orders: readonly MappedOrder[],
  expected: ExpectedOrder,
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
  expected: ExpectedOrder,
  providerOrderId: string | null,
): readonly MappedFill[] {
  return fills.filter(
    (fill) =>
      fill.clientOrderId === expected.clientOrderId ||
      (providerOrderId !== null && fill.orderId === providerOrderId),
  );
}

function validateMatchingFills(
  fills: readonly MappedFill[],
  expected: ExpectedOrder,
  providerOrderId: string,
  orderTimestamp: number,
): string {
  for (const fill of fills) {
    if (
      fill.orderId !== providerOrderId ||
      (fill.clientOrderId !== null &&
        fill.clientOrderId !== expected.clientOrderId) ||
      fill.coin !== expected.coin ||
      fill.side !== expected.sideCode ||
      (expected.side === "buy"
        ? decimalCompare(fill.price, expected.limitPrice) > 0
        : decimalCompare(fill.price, expected.limitPrice) < 0) ||
      fill.timestamp < orderTimestamp ||
      fill.twapId !== null ||
      fill.feeToken !== "USDC"
    ) {
      return fail("hyperliquid_order_identity_conflict");
    }
  }
  const filledSize = addDecimals(fills.map((fill) => fill.size));
  if (decimalCompare(filledSize, expected.originalSize) > 0) {
    return fail("hyperliquid_snapshot_conflict");
  }
  return filledSize;
}

function providerReasonCode(status: string): string {
  const snake = status.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const reasonCode = `hyperliquid_${snake}`;
  if (!reasonCodePattern.test(reasonCode)) {
    return fail("hyperliquid_unknown_order_status");
  }
  return reasonCode;
}

function isStatusCompatibleWithReviewedOrder(
  status: string,
  expected: ExpectedOrder,
): boolean {
  switch (status) {
    case "badAloPxRejected":
      return expected.timeInForce === "alo";
    case "iocCancelRejected":
      return expected.timeInForce === "ioc";
    case "marketOrderNoLiquidityRejected":
      return false;
    case "reduceOnlyCanceled":
    case "reduceOnlyRejected":
      return expected.reduceOnly;
    default:
      return true;
  }
}

function resolution(
  expected: ExpectedOrder,
  providerOrderId: string,
  state: PerpOrderReconciliationResolutionItem["state"],
  filledSize: string,
  observedAt: number,
  providerStatus: string,
): HyperliquidPerpOrderReconciliationReadResult {
  const positiveFilledSize = zeroDecimalPattern.test(filledSize)
    ? null
    : filledSize;
  if (
    (state === "partial" || state === "filled") &&
    positiveFilledSize === null
  ) {
    return fail("hyperliquid_snapshot_conflict");
  }
  const reasonCode =
    state === "cancelled" || state === "rejected"
      ? providerReasonCode(providerStatus)
      : null;
  const item = Object.freeze({
    index: expected.index,
    coin: expected.coin,
    generatedClientOrderId: expected.clientOrderId,
    state,
    providerOrderId,
    clientOrderId: expected.clientOrderId,
    filledSize: positiveFilledSize,
    averageFillPrice: null,
    reasonCode,
  }) satisfies PerpOrderReconciliationResolutionItem;
  const resolved = Object.freeze({
    genericState:
      state === "accepted" || state === "partial"
        ? "accepted"
        : state === "rejected"
          ? "rejected"
          : "succeeded",
    intentState: state,
    observedAt: new Date(observedAt).toISOString(),
    reasonCode,
    items: Object.freeze([item]),
  }) satisfies PerpOrderReconciliationResolution;
  return Object.freeze({ kind: "resolved", resolution: resolved });
}

function reconcileEvidence(
  rawOrderStatus: unknown,
  rawOpenOrders: unknown,
  rawFills: unknown,
  rawClearinghouse: unknown,
  expected: ExpectedOrder,
  fillWindowEnd: number,
  observedAt: number,
): HyperliquidPerpOrderReconciliationReadResult {
  const statusResponse = orderStatusSchema.parse(rawOrderStatus);
  const openOrders = validateOpenOrders(rawOpenOrders, expected);
  const fills = validateFills(rawFills, expected, fillWindowEnd);

  if (statusResponse.status === "unknownOid") {
    const identifiedOpenOrders = matchingOpenOrders(openOrders, expected, null);
    const identifiedFills = matchingFills(fills, expected, null);
    const latestEvidenceTime = Math.max(
      expected.attemptCommittedAt,
      ...identifiedOpenOrders.map((order) => order.timestamp),
      ...identifiedFills.map((fill) => fill.timestamp),
    );
    validateClearinghouse(rawClearinghouse, latestEvidenceTime, observedAt);
    if (identifiedOpenOrders.length > 0 || identifiedFills.length > 0) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    return Object.freeze({
      kind: "pending",
      reasonCode: "hyperliquid_unknown_oid",
    });
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

  const identifiedOpenOrders = matchingOpenOrders(
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
  const filledSize = validateMatchingFills(
    identifiedFills,
    expected,
    statusOrder.orderId,
    statusOrder.timestamp,
  );
  const latestEvidenceTime = Math.max(
    statusTimestamp,
    ...identifiedOpenOrders.map((order) => order.timestamp),
    ...identifiedFills.map((fill) => fill.timestamp),
  );
  validateClearinghouse(rawClearinghouse, latestEvidenceTime, observedAt);

  if (!isStatusCompatibleWithReviewedOrder(providerStatus, expected)) {
    return operatorRequired("hyperliquid_order_identity_conflict");
  }

  if (providerStatus === "open") {
    if (
      identifiedOpenOrders.length !== 1 ||
      identifiedOpenOrders[0] === undefined ||
      !decimalEquals(statusOrder.remainingSize, expected.originalSize) ||
      !decimalEquals(
        addDecimals([filledSize, identifiedOpenOrders[0].remainingSize]),
        expected.originalSize,
      ) ||
      zeroDecimalPattern.test(identifiedOpenOrders[0].remainingSize)
    ) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    return resolution(
      expected,
      statusOrder.orderId,
      zeroDecimalPattern.test(filledSize) ? "accepted" : "partial",
      filledSize,
      observedAt,
      providerStatus,
    );
  }

  if (providerStatus === "filled") {
    if (
      identifiedOpenOrders.length !== 0 ||
      !zeroDecimalPattern.test(statusOrder.remainingSize) ||
      !decimalEquals(filledSize, expected.originalSize)
    ) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    return resolution(
      expected,
      statusOrder.orderId,
      "filled",
      filledSize,
      observedAt,
      providerStatus,
    );
  }

  if (cancellationStatuses.has(providerStatus)) {
    if (
      identifiedOpenOrders.length !== 0 ||
      zeroDecimalPattern.test(statusOrder.remainingSize) ||
      !decimalEquals(
        addDecimals([filledSize, statusOrder.remainingSize]),
        expected.originalSize,
      )
    ) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    return resolution(
      expected,
      statusOrder.orderId,
      "cancelled",
      filledSize,
      observedAt,
      providerStatus,
    );
  }

  if (rejectionStatuses.has(providerStatus)) {
    if (
      identifiedOpenOrders.length !== 0 ||
      !zeroDecimalPattern.test(filledSize) ||
      !decimalEquals(statusOrder.remainingSize, expected.originalSize)
    ) {
      return operatorRequired("hyperliquid_snapshot_conflict");
    }
    return resolution(
      expected,
      statusOrder.orderId,
      "rejected",
      filledSize,
      observedAt,
      providerStatus,
    );
  }

  return operatorRequired(
    excludedStatuses.has(providerStatus)
      ? "hyperliquid_excluded_order_status"
      : "hyperliquid_unknown_order_status",
  );
}

export function createHyperliquidPerpOrderReconciliationReader(
  input: CreateHyperliquidPerpOrderReconciliationReaderInput,
): HyperliquidPerpOrderReconciliationReader {
  const now = input.now ?? (() => new Date());
  const createUuid = input.createUuid ?? randomUUID;

  const reader = Object.freeze({
    async read(
      readInput: HyperliquidPerpOrderReconciliationReadInput,
    ): Promise<HyperliquidPerpOrderReconciliationReadResult> {
      try {
        const readStartedAt = readNow(now);
        const expected = validateExpectedOrder(readInput, readStartedAt);
        readInput.signal.throwIfAborted();
        const callIds = createCallIds(createUuid, readInput.readRequestId);

        try {
          await input.quota.reserveWeight(
            HYPERLIQUID_PERP_ORDER_RECONCILIATION_INFO_WEIGHT,
            readInput.signal,
          );
        } catch {
          readInput.signal.throwIfAborted();
          return retry("hyperliquid_info_quota_unavailable");
        }
        readInput.signal.throwIfAborted();

        const [rawOrderStatus, rawOpenOrders, rawFills, rawClearinghouse] =
          await collectEvidence(
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
          rawClearinghouse,
          expected,
          readStartedAt,
          observedAt,
        );
      } catch (error) {
        readInput.signal.throwIfAborted();
        if (error instanceof RetryableHyperliquidReadError) {
          return retry("hyperliquid_info_retryable");
        }
        if (error instanceof EvidenceFailure) {
          return operatorRequired(error.reasonCode);
        }
        if (error instanceof HyperliquidPrivateReaderUnavailableError) {
          return operatorRequired("hyperliquid_evidence_unavailable");
        }
        return operatorRequired("hyperliquid_evidence_malformed");
      }
    },
  }) satisfies PerpOrderAuthoritativeReader;
  return reader;
}
