import { randomUUID } from "node:crypto";

import { isLosslessNumber } from "lossless-json";
import { z } from "zod";

import type {
  HyperliquidPrivateReadInput,
  HyperliquidPrivateReadKind,
  HyperliquidPrivateReader,
} from "./private-reader.js";
import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
} from "./private-reader.js";
import type {
  HyperliquidInfoRequest,
  HyperliquidLosslessInfoTransport,
} from "./lossless-info-transport.js";

const coreCoins = ["BTC", "ETH", "SOL"] as const;
type CoreCoin = (typeof coreCoins)[number];

const coreCoinSchema = z.enum(coreCoins);
const decimalPattern =
  /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|-(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*))$/;
const positiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const addressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/;
const clientOrderIdPattern = /^0x[0-9a-fA-F]{32}$/;
const providerCursorStatePattern = /^[A-Za-z0-9_-]{1,768}$/;
const maximumUnsigned64 = 18_446_744_073_709_551_615n;
const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const sevenDaysMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const privateSourceTtlMilliseconds = 2_000;
const metaSourceTtlMilliseconds = 60_000;
const fillProviderCap = 2_000;
const fundingProviderCap = 500;

export const HYPERLIQUID_INFO_WEIGHT = Object.freeze({
  meta: 20,
  clearinghouseState: 2,
  frontendOpenOrders: 20,
  userFillsByTime: 120,
  userFunding: 45,
} as const);

interface LosslessJsonNumber {
  readonly isLosslessNumber: true;
  toString(): string;
}

const losslessNumberSchema = z.custom<LosslessJsonNumber>((value) =>
  isLosslessNumber(value),
);
const decimalStringSchema = z.string().max(128).regex(decimalPattern);
const positiveDecimalStringSchema = z
  .string()
  .max(128)
  .regex(positiveDecimalPattern);
const hashSchema = z.string().regex(transactionHashPattern);

const marginTierSchema = z
  .object({
    lowerBound: z
      .string()
      .max(128)
      .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
    maxLeverage: losslessNumberSchema,
  })
  .strict();
const marginTableSchema = z.tuple([
  losslessNumberSchema,
  z
    .object({
      description: z.string().max(512),
      marginTiers: z.array(marginTierSchema).min(1).max(100),
    })
    .strict(),
]);
const universeAssetSchema = z
  .object({
    szDecimals: losslessNumberSchema,
    name: z.string().min(1).max(128),
    maxLeverage: losslessNumberSchema,
    marginTableId: losslessNumberSchema,
    onlyIsolated: z.boolean().optional(),
    isDelisted: z.boolean().optional(),
    marginMode: z.enum(["strictIsolated", "noCross"]).optional(),
    growthMode: z.literal("enabled").optional(),
    lastGrowthModeChangeTime: z.string().min(1).max(64).optional(),
  })
  .strict();
const metaSchema = z
  .object({
    universe: z.array(universeAssetSchema).min(3).max(2_000),
    marginTables: z.array(marginTableSchema).min(1).max(2_000),
    collateralToken: losslessNumberSchema,
  })
  .strict();

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
    assetPositions: z.array(assetPositionSchema).max(2_000),
    time: losslessNumberSchema,
  })
  .strict();

const frontendOrderSchema = z
  .object({
    coin: z.string().min(1).max(128),
    side: z.enum(["B", "A"]),
    limitPx: positiveDecimalStringSchema,
    sz: positiveDecimalStringSchema,
    oid: losslessNumberSchema,
    timestamp: losslessNumberSchema,
    origSz: positiveDecimalStringSchema,
    triggerCondition: z.string().min(1).max(128),
    isTrigger: z.boolean(),
    triggerPx: z
      .string()
      .max(128)
      .regex(/^(?:0)(?:\.0+)?$/),
    children: z.array(z.unknown()).max(0),
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
    tif: z
      .enum(["Gtc", "Ioc", "Alo", "FrontendMarket", "LiquidationMarket"])
      .nullable(),
    cloid: z.string().regex(clientOrderIdPattern).nullable(),
  })
  .strict();
const frontendOrdersSchema = z.array(frontendOrderSchema).max(5_000);

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
    hash: hashSchema,
    oid: losslessNumberSchema,
    crossed: z.boolean(),
    fee: decimalStringSchema,
    builderFee: decimalStringSchema.optional(),
    tid: losslessNumberSchema,
    feeToken: z.string().min(1).max(32),
    feeTrialEscrow: positiveDecimalStringSchema.optional(),
    twapId: losslessNumberSchema.nullable(),
    cloid: z.string().regex(clientOrderIdPattern).optional(),
    liquidation: liquidationSchema.optional(),
  })
  .strict();
const userFillsSchema = z.array(userFillSchema).max(fillProviderCap);

const userFundingSchema = z
  .array(
    z
      .object({
        time: losslessNumberSchema,
        hash: hashSchema,
        delta: z
          .object({
            type: z.literal("funding"),
            coin: z.string().min(1).max(128),
            usdc: decimalStringSchema,
            szi: decimalStringSchema,
            fundingRate: decimalStringSchema,
            nSamples: losslessNumberSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
  )
  .max(fundingProviderCap);

const cursorIntegerSchema = z.string().max(20).regex(unsignedIntegerPattern);
const positionsCursorSchema = z
  .object({
    v: z.literal(1),
    k: z.literal("positions"),
    c: coreCoinSchema,
  })
  .strict();
const ordersCursorSchema = z
  .object({
    v: z.literal(1),
    k: z.literal("orders"),
    t: cursorIntegerSchema,
    i: cursorIntegerSchema,
  })
  .strict();
const fillsCursorSchema = z
  .object({
    v: z.literal(1),
    k: z.literal("fills"),
    s: cursorIntegerSchema,
    e: cursorIntegerSchema,
    t: cursorIntegerSchema,
    i: cursorIntegerSchema,
  })
  .strict();
const fundingCursorSchema = z
  .object({
    v: z.literal(1),
    k: z.literal("funding"),
    s: cursorIntegerSchema,
    e: cursorIntegerSchema,
    t: cursorIntegerSchema,
    c: coreCoinSchema,
    h: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();
const providerCursorSchema = z.discriminatedUnion("k", [
  positionsCursorSchema,
  ordersCursorSchema,
  fillsCursorSchema,
  fundingCursorSchema,
]);
type ProviderCursor = z.infer<typeof providerCursorSchema>;

interface CoreMetaAsset {
  readonly coin: CoreCoin;
  readonly size_decimals: number;
  readonly size_increment: string;
  readonly max_leverage: string;
  readonly margin_mode: "cross_and_isolated" | "isolated_only";
  readonly minimum_order_notional_usdc: Readonly<{
    state: "unavailable";
  }>;
}

interface SourceEnvelope {
  readonly provider: "hyperliquid";
  readonly network: "testnet";
  readonly market: "core_perps";
  readonly dex: "";
  readonly dataset: HyperliquidPrivateReadKind;
  readonly fetched_at: string;
  readonly expires_at: string;
}

interface CoreMetaSnapshot {
  readonly assets: readonly CoreMetaAsset[];
  readonly source: SourceEnvelope;
  readonly expiresAtMilliseconds: number;
}

interface MappedPosition {
  readonly coin: CoreCoin;
  readonly side: "long" | "short";
  readonly size: string;
  readonly entry_price: string | null;
  readonly leverage: Readonly<{
    mode: "cross" | "isolated";
    value: string;
    raw_usd: string | null;
  }>;
  readonly liquidation_price: string | null;
  readonly margin_used: string;
  readonly position_value: string;
  readonly return_on_equity: string;
  readonly unrealized_pnl: string;
  readonly position_mode: "one_way";
}

interface MappedOrder {
  readonly order_id: string;
  readonly client_order_id: string | null;
  readonly coin: CoreCoin;
  readonly side: "buy" | "sell";
  readonly order_type: "limit";
  readonly time_in_force: "gtc" | "alo" | "ioc";
  readonly limit_price: string;
  readonly original_size: string;
  readonly remaining_size: string;
  readonly reduce_only: boolean;
  readonly status: "open";
  readonly created_at: string;
  readonly status_at: string;
  readonly createdAtMilliseconds: number;
}

interface MappedFill {
  readonly trade_id: string;
  readonly order_id: string;
  readonly transaction_hash: string;
  readonly coin: CoreCoin;
  readonly side: "buy" | "sell";
  readonly price: string;
  readonly size: string;
  readonly start_position: string;
  readonly closed_pnl: string;
  readonly fee: string;
  readonly fee_asset: "USDC";
  readonly crossed: boolean;
  readonly filled_at: string;
  readonly filledAtMilliseconds: number;
}

interface MappedFunding {
  readonly transaction_hash: string;
  readonly coin: CoreCoin;
  readonly funding_rate: string;
  readonly position_size: string;
  readonly payment_usdc: string;
  readonly settled_at: string;
  readonly settledAtMilliseconds: number;
}

export interface HyperliquidInfoQuota {
  reserveWeight(cost: number, signal: AbortSignal): Promise<void>;
}

export interface CreateHyperliquidInfoPrivateReaderInput {
  readonly transport: HyperliquidLosslessInfoTransport;
  readonly quota: HyperliquidInfoQuota;
  readonly now?: () => Date;
}

function unavailable(): never {
  throw new HyperliquidPrivateReaderUnavailableError();
}

function readNow(now: () => Date): number {
  const value = now().getTime();
  if (!Number.isSafeInteger(value) || value < 0) {
    return unavailable();
  }
  return value;
}

function sourceEnvelope(
  kind: HyperliquidPrivateReadKind,
  fetchedAtMilliseconds: number,
): SourceEnvelope {
  const ttl =
    kind === "config"
      ? metaSourceTtlMilliseconds
      : privateSourceTtlMilliseconds;
  return Object.freeze({
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    dataset: kind,
    fetched_at: new Date(fetchedAtMilliseconds).toISOString(),
    expires_at: new Date(fetchedAtMilliseconds + ttl).toISOString(),
  });
}

function rawInteger(value: LosslessJsonNumber, maximum: bigint): string {
  const text = value.toString();
  if (!unsignedIntegerPattern.test(text)) {
    return unavailable();
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    return unavailable();
  }
  if (parsed > maximum) {
    return unavailable();
  }
  return text;
}

function rawPositiveInteger(
  value: LosslessJsonNumber,
  maximum: bigint,
): string {
  const text = rawInteger(value, maximum);
  if (!positiveIntegerPattern.test(text)) {
    return unavailable();
  }
  return text;
}

function rawSafeInteger(value: LosslessJsonNumber): number {
  return Number(rawInteger(value, maximumSafeInteger));
}

function timestamp(value: LosslessJsonNumber): number {
  const parsed = rawSafeInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return unavailable();
  }
  return parsed;
}

function coreCoin(value: string): CoreCoin {
  const parsed = coreCoinSchema.safeParse(value);
  if (!parsed.success) {
    return unavailable();
  }
  return parsed.data;
}

function sizeIncrement(sizeDecimals: number): string {
  return sizeDecimals === 0 ? "1" : `0.${"0".repeat(sizeDecimals - 1)}1`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function mapMeta(
  raw: unknown,
  fetchedAtMilliseconds: number,
): CoreMetaSnapshot {
  const parsed = metaSchema.parse(raw);
  const universeNames = new Set<string>();
  for (const asset of parsed.universe) {
    if (universeNames.has(asset.name)) {
      return unavailable();
    }
    universeNames.add(asset.name);
  }

  rawSafeInteger(parsed.collateralToken);
  const marginTableIds = new Set<string>();
  for (const [rawId, table] of parsed.marginTables) {
    const id = rawInteger(rawId, maximumSafeInteger);
    if (marginTableIds.has(id)) {
      return unavailable();
    }
    marginTableIds.add(id);
    for (const tier of table.marginTiers) {
      rawPositiveInteger(tier.maxLeverage, maximumSafeInteger);
    }
  }

  const assets = coreCoins.map((coin): CoreMetaAsset => {
    const matches = parsed.universe.filter((asset) => asset.name === coin);
    if (matches.length !== 1) {
      return unavailable();
    }
    const asset = matches[0];
    if (asset === undefined || asset.isDelisted === true) {
      return unavailable();
    }
    rawInteger(asset.marginTableId, maximumSafeInteger);
    const sizeDecimals = rawSafeInteger(asset.szDecimals);
    if (sizeDecimals < 0 || sizeDecimals > 18) {
      return unavailable();
    }
    const maxLeverage = rawPositiveInteger(
      asset.maxLeverage,
      maximumSafeInteger,
    );
    return Object.freeze({
      coin,
      size_decimals: sizeDecimals,
      size_increment: sizeIncrement(sizeDecimals),
      max_leverage: maxLeverage,
      margin_mode:
        asset.marginMode !== undefined || asset.onlyIsolated === true
          ? "isolated_only"
          : "cross_and_isolated",
      minimum_order_notional_usdc: Object.freeze({ state: "unavailable" }),
    });
  });
  const source = sourceEnvelope("config", fetchedAtMilliseconds);
  return deepFreeze({
    assets,
    source,
    expiresAtMilliseconds: fetchedAtMilliseconds + metaSourceTtlMilliseconds,
  });
}

function configProjection(meta: CoreMetaSnapshot): unknown {
  return deepFreeze({
    scope: {
      network: "testnet",
      market: "core_perps",
      dex: "",
      coins: [...coreCoins],
    },
    assets: meta.assets,
    fees: {
      maker_rate: { state: "unavailable" },
      taker_rate: { state: "unavailable" },
    },
    capabilities: {
      private_reads: "available",
      trading_mutations: "disabled",
    },
    source: meta.source,
  });
}

function validateMetaCoin(meta: CoreMetaSnapshot, value: string): CoreCoin {
  const coin = coreCoin(value);
  if (!meta.assets.some((asset) => asset.coin === coin)) {
    return unavailable();
  }
  return coin;
}

function mapPositions(
  parsed: z.infer<typeof clearinghouseStateSchema>,
  meta: CoreMetaSnapshot,
): MappedPosition[] {
  const seen = new Set<CoreCoin>();
  const items = parsed.assetPositions.map(({ position }): MappedPosition => {
    const coin = validateMetaCoin(meta, position.coin);
    if (seen.has(coin) || /^-?0(?:\.0+)?$/.test(position.szi)) {
      return unavailable();
    }
    seen.add(coin);
    const isShort = position.szi.startsWith("-");
    const leverage = rawPositiveInteger(
      position.leverage.value,
      maximumSafeInteger,
    );
    return {
      coin,
      side: isShort ? "short" : "long",
      size: isShort ? position.szi.slice(1) : position.szi,
      entry_price: position.entryPx,
      leverage: {
        mode: position.leverage.type,
        value: leverage,
        raw_usd:
          position.leverage.type === "isolated"
            ? position.leverage.rawUsd
            : null,
      },
      liquidation_price: position.liquidationPx,
      margin_used: position.marginUsed,
      position_value: position.positionValue,
      return_on_equity: position.returnOnEquity,
      unrealized_pnl: position.unrealizedPnl,
      position_mode: "one_way",
    };
  });
  return items.sort(
    (left, right) =>
      coreCoins.indexOf(left.coin) - coreCoins.indexOf(right.coin),
  );
}

function accountProjection(
  parsed: z.infer<typeof clearinghouseStateSchema>,
  source: SourceEnvelope,
): unknown {
  const mapSummary = (summary: z.infer<typeof marginSummarySchema>) => ({
    account_value: summary.accountValue,
    total_margin_used: summary.totalMarginUsed,
    total_notional_position: summary.totalNtlPos,
    total_raw_usd: summary.totalRawUsd,
  });
  return {
    margin_summary: mapSummary(parsed.marginSummary),
    cross_margin_summary: mapSummary(parsed.crossMarginSummary),
    withdrawable: parsed.withdrawable,
    cross_maintenance_margin_used: parsed.crossMaintenanceMarginUsed,
    source,
  };
}

function compareDescendingTuple(
  leftTime: number,
  leftId: string,
  rightTime: number,
  rightId: string,
): number {
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const left = BigInt(leftId);
  const right = BigInt(rightId);
  return left === right ? 0 : left > right ? -1 : 1;
}

function mapOrders(
  raw: unknown,
  meta: CoreMetaSnapshot,
  fetchedAtMilliseconds: number,
): MappedOrder[] {
  const parsed = frontendOrdersSchema.parse(raw);
  const seenOrders = new Set<string>();
  const seenClientOrders = new Set<string>();
  const items = parsed.map((order): MappedOrder => {
    if (
      order.isTrigger ||
      order.isPositionTpsl ||
      order.orderType !== "Limit" ||
      order.tif === null ||
      !["Gtc", "Alo", "Ioc"].includes(order.tif) ||
      order.triggerCondition !== "N/A"
    ) {
      return unavailable();
    }
    const orderId = rawInteger(order.oid, maximumUnsigned64);
    if (seenOrders.has(orderId)) {
      return unavailable();
    }
    seenOrders.add(orderId);
    const clientOrderId = order.cloid?.toLowerCase() ?? null;
    if (
      clientOrderId !== null &&
      (seenClientOrders.has(clientOrderId) ||
        !/^0x[0-9a-f]{32}$/.test(clientOrderId))
    ) {
      return unavailable();
    }
    if (clientOrderId !== null) {
      seenClientOrders.add(clientOrderId);
    }
    const createdAtMilliseconds = timestamp(order.timestamp);
    if (createdAtMilliseconds > fetchedAtMilliseconds) {
      return unavailable();
    }
    const timeInForce =
      order.tif === "Gtc" ? "gtc" : order.tif === "Alo" ? "alo" : "ioc";
    return {
      order_id: orderId,
      client_order_id: clientOrderId,
      coin: validateMetaCoin(meta, order.coin),
      side: order.side === "B" ? "buy" : "sell",
      order_type: "limit",
      time_in_force: timeInForce,
      limit_price: order.limitPx,
      original_size: order.origSz,
      remaining_size: order.sz,
      reduce_only: order.reduceOnly,
      status: "open",
      created_at: new Date(createdAtMilliseconds).toISOString(),
      status_at: new Date(fetchedAtMilliseconds).toISOString(),
      createdAtMilliseconds,
    };
  });
  return items.sort((left, right) =>
    compareDescendingTuple(
      left.createdAtMilliseconds,
      left.order_id,
      right.createdAtMilliseconds,
      right.order_id,
    ),
  );
}

function mapFills(
  raw: unknown,
  meta: CoreMetaSnapshot,
  startedAt: number,
  endedAt: number,
): MappedFill[] {
  const parsed = userFillsSchema.parse(raw);
  const seenTrades = new Set<string>();
  const items = parsed.map((fill): MappedFill => {
    if (
      fill.builderFee !== undefined ||
      fill.twapId !== null ||
      fill.feeToken !== "USDC"
    ) {
      return unavailable();
    }
    const tradeId = rawInteger(fill.tid, maximumUnsigned64);
    const orderId = rawInteger(fill.oid, maximumUnsigned64);
    if (seenTrades.has(tradeId)) {
      return unavailable();
    }
    seenTrades.add(tradeId);
    const filledAtMilliseconds = timestamp(fill.time);
    if (filledAtMilliseconds < startedAt || filledAtMilliseconds > endedAt) {
      return unavailable();
    }
    return {
      trade_id: tradeId,
      order_id: orderId,
      transaction_hash: fill.hash.toLowerCase(),
      coin: validateMetaCoin(meta, fill.coin),
      side: fill.side === "B" ? "buy" : "sell",
      price: fill.px,
      size: fill.sz,
      start_position: fill.startPosition,
      closed_pnl: fill.closedPnl,
      fee: fill.fee,
      fee_asset: "USDC",
      crossed: fill.crossed,
      filled_at: new Date(filledAtMilliseconds).toISOString(),
      filledAtMilliseconds,
    };
  });
  return items.sort((left, right) =>
    compareDescendingTuple(
      left.filledAtMilliseconds,
      left.trade_id,
      right.filledAtMilliseconds,
      right.trade_id,
    ),
  );
}

function mapFunding(
  raw: unknown,
  meta: CoreMetaSnapshot,
  startedAt: number,
  endedAt: number,
): MappedFunding[] {
  const parsed = userFundingSchema.parse(raw);
  const seenKeys = new Set<string>();
  const seenTimeCoins = new Set<string>();
  const items = parsed.map((funding): MappedFunding => {
    if (funding.delta.nSamples !== null) {
      rawSafeInteger(funding.delta.nSamples);
    }
    const coin = validateMetaCoin(meta, funding.delta.coin);
    const settledAtMilliseconds = timestamp(funding.time);
    if (settledAtMilliseconds < startedAt || settledAtMilliseconds > endedAt) {
      return unavailable();
    }
    const hash = funding.hash.toLowerCase();
    const key = `${hash}\0${coin}`;
    const timeCoin = `${settledAtMilliseconds}\0${coin}`;
    if (seenKeys.has(key) || seenTimeCoins.has(timeCoin)) {
      return unavailable();
    }
    seenKeys.add(key);
    seenTimeCoins.add(timeCoin);
    return {
      transaction_hash: hash,
      coin,
      funding_rate: funding.delta.fundingRate,
      position_size: funding.delta.szi,
      payment_usdc: funding.delta.usdc,
      settled_at: new Date(settledAtMilliseconds).toISOString(),
      settledAtMilliseconds,
    };
  });
  return items.sort((left, right) => {
    if (left.settledAtMilliseconds !== right.settledAtMilliseconds) {
      return right.settledAtMilliseconds - left.settledAtMilliseconds;
    }
    const coinComparison =
      coreCoins.indexOf(left.coin) - coreCoins.indexOf(right.coin);
    return coinComparison !== 0
      ? coinComparison
      : left.transaction_hash.localeCompare(right.transaction_hash);
  });
}

function encodeCursor(value: ProviderCursor): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  if (encoded.length > 768) {
    return unavailable();
  }
  return encoded;
}

function decodeCursor(value: string | undefined): ProviderCursor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!providerCursorStatePattern.test(value)) {
    return unavailable();
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      return unavailable();
    }
    return providerCursorSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return unavailable();
  }
}

function pagePositions(
  items: readonly MappedPosition[],
  limit: number,
  cursor: ProviderCursor | undefined,
  source: SourceEnvelope,
): unknown {
  if (cursor !== undefined && cursor.k !== "positions") {
    return unavailable();
  }
  const afterIndex = cursor === undefined ? -1 : coreCoins.indexOf(cursor.c);
  const remaining = items.filter(
    (item) => coreCoins.indexOf(item.coin) > afterIndex,
  );
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const next =
    remaining.length > limit && last !== undefined
      ? encodeCursor({ v: 1, k: "positions", c: last.coin })
      : undefined;
  return next === undefined
    ? { items: page, source }
    : { items: page, source, next_provider_cursor_state: next };
}

function isAfterDescendingTuple(
  itemTime: number,
  itemId: string,
  cursorTime: number,
  cursorId: string,
): boolean {
  return (
    itemTime < cursorTime ||
    (itemTime === cursorTime && BigInt(itemId) < BigInt(cursorId))
  );
}

function cursorSafeInteger(value: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return unavailable();
  }
  if (parsed > maximumSafeInteger) {
    return unavailable();
  }
  return Number(parsed);
}

function cursorUnsigned64(value: string): string {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return unavailable();
  }
  if (parsed > maximumUnsigned64) {
    return unavailable();
  }
  return value;
}

function pageOrders(
  items: readonly MappedOrder[],
  limit: number,
  cursor: ProviderCursor | undefined,
  source: SourceEnvelope,
): unknown {
  if (cursor !== undefined && cursor.k !== "orders") {
    return unavailable();
  }
  const cursorTime =
    cursor === undefined ? undefined : cursorSafeInteger(cursor.t);
  const cursorId =
    cursor === undefined ? undefined : cursorUnsigned64(cursor.i);
  if (cursorTime !== undefined && cursorTime > Date.parse(source.fetched_at)) {
    return unavailable();
  }
  const remaining =
    cursor === undefined
      ? items
      : items.filter((item) =>
          isAfterDescendingTuple(
            item.createdAtMilliseconds,
            item.order_id,
            cursorTime as number,
            cursorId as string,
          ),
        );
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const next =
    remaining.length > limit && last !== undefined
      ? encodeCursor({
          v: 1,
          k: "orders",
          t: String(last.createdAtMilliseconds),
          i: last.order_id,
        })
      : undefined;
  const output = page.map((item) => ({
    order_id: item.order_id,
    client_order_id: item.client_order_id,
    coin: item.coin,
    side: item.side,
    order_type: item.order_type,
    time_in_force: item.time_in_force,
    limit_price: item.limit_price,
    original_size: item.original_size,
    remaining_size: item.remaining_size,
    reduce_only: item.reduce_only,
    status: item.status,
    created_at: item.created_at,
    status_at: item.status_at,
  }));
  return next === undefined
    ? { items: output, source }
    : { items: output, source, next_provider_cursor_state: next };
}

function pageFills(
  items: readonly MappedFill[],
  limit: number,
  cursor: z.infer<typeof fillsCursorSchema> | undefined,
  source: SourceEnvelope,
  startedAt: number,
  endedAt: number,
  truncated: boolean,
): unknown {
  if (cursor !== undefined) {
    cursorUnsigned64(cursor.i);
  }
  const remaining =
    cursor === undefined
      ? items
      : items.filter((item) =>
          isAfterDescendingTuple(
            item.filledAtMilliseconds,
            item.trade_id,
            Number(cursor.t),
            cursor.i,
          ),
        );
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const next =
    remaining.length > limit && last !== undefined
      ? encodeCursor({
          v: 1,
          k: "fills",
          s: String(startedAt),
          e: String(endedAt),
          t: String(last.filledAtMilliseconds),
          i: last.trade_id,
        })
      : undefined;
  const output = page.map((item) => ({
    trade_id: item.trade_id,
    order_id: item.order_id,
    transaction_hash: item.transaction_hash,
    coin: item.coin,
    side: item.side,
    price: item.price,
    size: item.size,
    start_position: item.start_position,
    closed_pnl: item.closed_pnl,
    fee: item.fee,
    fee_asset: item.fee_asset,
    crossed: item.crossed,
    filled_at: item.filled_at,
  }));
  const base = {
    items: output,
    coverage: {
      kind: "recent_window",
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      truncated,
    },
    source,
  };
  return next === undefined
    ? base
    : { ...base, next_provider_cursor_state: next };
}

function fundingAfterCursor(
  item: MappedFunding,
  cursor: z.infer<typeof fundingCursorSchema>,
): boolean {
  const cursorTime = Number(cursor.t);
  if (item.settledAtMilliseconds !== cursorTime) {
    return item.settledAtMilliseconds < cursorTime;
  }
  const coinComparison =
    coreCoins.indexOf(item.coin) - coreCoins.indexOf(cursor.c);
  return (
    coinComparison > 0 ||
    (coinComparison === 0 && item.transaction_hash > cursor.h)
  );
}

function pageFunding(
  items: readonly MappedFunding[],
  limit: number,
  cursor: z.infer<typeof fundingCursorSchema> | undefined,
  source: SourceEnvelope,
  startedAt: number,
  endedAt: number,
  truncated: boolean,
): unknown {
  const remaining =
    cursor === undefined
      ? items
      : items.filter((item) => fundingAfterCursor(item, cursor));
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const next =
    remaining.length > limit && last !== undefined
      ? encodeCursor({
          v: 1,
          k: "funding",
          s: String(startedAt),
          e: String(endedAt),
          t: String(last.settledAtMilliseconds),
          c: last.coin,
          h: last.transaction_hash,
        })
      : undefined;
  const output = page.map((item) => ({
    transaction_hash: item.transaction_hash,
    coin: item.coin,
    funding_rate: item.funding_rate,
    position_size: item.position_size,
    payment_usdc: item.payment_usdc,
    settled_at: item.settled_at,
  }));
  const base = {
    items: output,
    coverage: {
      kind: "recent_window",
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      truncated,
    },
    source,
  };
  return next === undefined
    ? base
    : { ...base, next_provider_cursor_state: next };
}

function validateReaderInput(input: HyperliquidPrivateReadInput): void {
  const rawInput: unknown = input;
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    unavailable();
  }
  const value = rawInput as Record<string, unknown>;
  const kind = value["kind"];
  if (
    value["network"] !== "testnet" ||
    value["dex"] !== "" ||
    typeof value["accountAddress"] !== "string" ||
    !addressPattern.test(value["accountAddress"]) ||
    value["accountAddress"] === zeroAddress ||
    typeof value["transportAttemptId"] !== "string" ||
    !uuidPattern.test(value["transportAttemptId"]) ||
    !(value["signal"] instanceof AbortSignal) ||
    typeof kind !== "string" ||
    !["config", "account", "positions", "orders", "fills", "funding"].includes(
      kind,
    )
  ) {
    unavailable();
  }
  if (kind === "config" || kind === "account") {
    if (
      Object.hasOwn(value, "limit") ||
      Object.hasOwn(value, "providerCursorState")
    ) {
      unavailable();
    }
    return;
  }
  const limit = value["limit"];
  const providerCursorState = value["providerCursorState"];
  const maximum = kind === "positions" ? 3 : 50;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > maximum ||
    (providerCursorState !== undefined &&
      (typeof providerCursorState !== "string" ||
        !providerCursorStatePattern.test(providerCursorState)))
  ) {
    unavailable();
  }
}

function listLimit(input: HyperliquidPrivateReadInput): number {
  if (input.kind === "config" || input.kind === "account") {
    return unavailable();
  }
  if (input.limit === undefined) {
    return unavailable();
  }
  return input.limit;
}

function validateWindowCursor(
  cursor:
    z.infer<typeof fillsCursorSchema> | z.infer<typeof fundingCursorSchema>,
  nowMilliseconds: number,
): { readonly startedAt: number; readonly endedAt: number } {
  const startedAt = Number(cursor.s);
  const endedAt = Number(cursor.e);
  const tupleTime = Number(cursor.t);
  if (
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(endedAt) ||
    !Number.isSafeInteger(tupleTime) ||
    startedAt < 0 ||
    endedAt - startedAt !== sevenDaysMilliseconds ||
    endedAt > nowMilliseconds ||
    tupleTime < startedAt ||
    tupleTime > endedAt
  ) {
    return unavailable();
  }
  return { startedAt, endedAt };
}

async function reserveAndPost(
  quota: HyperliquidInfoQuota,
  transport: HyperliquidLosslessInfoTransport,
  cost: number,
  request: HyperliquidInfoRequest,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  try {
    await quota.reserveWeight(cost, signal);
  } catch {
    signal.throwIfAborted();
    return unavailable();
  }
  signal.throwIfAborted();
  const callId = randomUUID();
  if (typeof callId !== "string" || !uuidPattern.test(callId)) {
    return unavailable();
  }
  signal.throwIfAborted();
  return transport.post(request, signal, callId);
}

export function createHyperliquidInfoPrivateReader(
  input: CreateHyperliquidInfoPrivateReaderInput,
): HyperliquidPrivateReader {
  const now = input.now ?? (() => new Date());
  let cachedMeta: CoreMetaSnapshot | undefined;

  const resolveMeta = async (
    signal: AbortSignal,
  ): Promise<CoreMetaSnapshot> => {
    const beforeFetch = readNow(now);
    if (
      cachedMeta !== undefined &&
      beforeFetch < cachedMeta.expiresAtMilliseconds
    ) {
      return cachedMeta;
    }
    cachedMeta = undefined;
    const raw = await reserveAndPost(
      input.quota,
      input.transport,
      HYPERLIQUID_INFO_WEIGHT.meta,
      { type: "meta", dex: "" },
      signal,
    );
    signal.throwIfAborted();
    const fetchedAt = readNow(now);
    const parsed = mapMeta(raw, fetchedAt);
    cachedMeta = parsed;
    return parsed;
  };

  return Object.freeze({
    async read(readInput: HyperliquidPrivateReadInput) {
      try {
        validateReaderInput(readInput);
        readInput.signal.throwIfAborted();
        const cursor = decodeCursor(readInput.providerCursorState);
        const requestStartedAt = readNow(now);
        const meta = await resolveMeta(readInput.signal);

        if (readInput.kind === "config") {
          return configProjection(meta);
        }

        if (readInput.kind === "account" || readInput.kind === "positions") {
          const raw = await reserveAndPost(
            input.quota,
            input.transport,
            HYPERLIQUID_INFO_WEIGHT.clearinghouseState,
            {
              type: "clearinghouseState",
              user: readInput.accountAddress,
              dex: "",
            },
            readInput.signal,
          );
          const parsed = clearinghouseStateSchema.parse(raw);
          timestamp(parsed.time);
          const positions = mapPositions(parsed, meta);
          const fetchedAt = readNow(now);
          const source = sourceEnvelope(readInput.kind, fetchedAt);
          if (readInput.kind === "account") {
            if (cursor !== undefined) {
              return unavailable();
            }
            return accountProjection(parsed, source);
          }
          return pagePositions(positions, listLimit(readInput), cursor, source);
        }

        if (readInput.kind === "orders") {
          const raw = await reserveAndPost(
            input.quota,
            input.transport,
            HYPERLIQUID_INFO_WEIGHT.frontendOpenOrders,
            {
              type: "frontendOpenOrders",
              user: readInput.accountAddress,
              dex: "",
            },
            readInput.signal,
          );
          const fetchedAt = readNow(now);
          const source = sourceEnvelope("orders", fetchedAt);
          const orders = mapOrders(raw, meta, fetchedAt);
          return pageOrders(orders, listLimit(readInput), cursor, source);
        }

        if (readInput.kind === "fills") {
          if (cursor !== undefined && cursor.k !== "fills") {
            return unavailable();
          }
          const window =
            cursor === undefined
              ? {
                  startedAt: requestStartedAt - sevenDaysMilliseconds,
                  endedAt: requestStartedAt,
                }
              : validateWindowCursor(cursor, requestStartedAt);
          const raw = await reserveAndPost(
            input.quota,
            input.transport,
            HYPERLIQUID_INFO_WEIGHT.userFillsByTime,
            {
              type: "userFillsByTime",
              user: readInput.accountAddress,
              startTime: window.startedAt,
              endTime: window.endedAt,
              aggregateByTime: false,
            },
            readInput.signal,
          );
          const rawItems = userFillsSchema.parse(raw);
          const items = mapFills(
            rawItems,
            meta,
            window.startedAt,
            window.endedAt,
          );
          const fetchedAt = readNow(now);
          return pageFills(
            items,
            listLimit(readInput),
            cursor,
            sourceEnvelope("fills", fetchedAt),
            window.startedAt,
            window.endedAt,
            rawItems.length === fillProviderCap,
          );
        }

        if (cursor !== undefined && cursor.k !== "funding") {
          return unavailable();
        }
        const window =
          cursor === undefined
            ? {
                startedAt: requestStartedAt - sevenDaysMilliseconds,
                endedAt: requestStartedAt,
              }
            : validateWindowCursor(cursor, requestStartedAt);
        const raw = await reserveAndPost(
          input.quota,
          input.transport,
          HYPERLIQUID_INFO_WEIGHT.userFunding,
          {
            type: "userFunding",
            user: readInput.accountAddress,
            startTime: window.startedAt,
            endTime: window.endedAt,
          },
          readInput.signal,
        );
        const rawItems = userFundingSchema.parse(raw);
        const items = mapFunding(
          rawItems,
          meta,
          window.startedAt,
          window.endedAt,
        );
        const fetchedAt = readNow(now);
        return pageFunding(
          items,
          listLimit(readInput),
          cursor,
          sourceEnvelope("funding", fetchedAt),
          window.startedAt,
          window.endedAt,
          rawItems.length === fundingProviderCap,
        );
      } catch (error) {
        readInput.signal.throwIfAborted();
        if (
          error instanceof RetryableHyperliquidReadError ||
          error instanceof HyperliquidPrivateReaderUnavailableError
        ) {
          throw error;
        }
        return unavailable();
      }
    },
  });
}
