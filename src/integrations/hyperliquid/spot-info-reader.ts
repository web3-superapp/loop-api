import { createHash, randomUUID } from "node:crypto";

import { isLosslessNumber } from "lossless-json";
import { z } from "zod";

import type { HyperliquidInfoQuota } from "./info-quota.js";
import { hasAtMostExactUnsignedDecimalPlaces } from "./spot-order-precision.js";
import {
  HYPERLIQUID_SPOT_BOOK_MAX_AGE_MILLISECONDS,
  HYPERLIQUID_SPOT_BOOK_MAX_FUTURE_SKEW_MILLISECONDS,
  HYPERLIQUID_SPOT_INFO_WEIGHT,
  HYPERLIQUID_SPOT_METADATA_TTL_MILLISECONDS,
  HYPERLIQUID_SPOT_PRIVATE_SOURCE_TTL_MILLISECONDS,
  HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
  HyperliquidSpotInfoUnavailableError,
  RetryableHyperliquidSpotInfoError,
  type HyperliquidSpotBalanceItem,
  type HyperliquidSpotBalancesSnapshot,
  type HyperliquidSpotBookLevel,
  type HyperliquidSpotBookSnapshot,
  type HyperliquidSpotInfoReader,
  type HyperliquidSpotInfoRequest,
  type HyperliquidSpotInfoTransport,
  type HyperliquidSpotMarketAllowlistEntry,
  type HyperliquidSpotMarketContext,
  type HyperliquidSpotMarketMetadata,
  type HyperliquidSpotMetadataSnapshot,
  type HyperliquidSpotTokenMetadata,
  type HyperliquidSpotUserFeesSnapshot,
} from "./spot-info-contract.js";

const metadataVersionDomain = "loop.hyperliquid.spot.metadata.v1\0";
const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const maximumDateMilliseconds = 8_640_000_000_000_000;
const marketIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidPattern = marketIdPattern;
const addressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const tokenIdPattern = /^0x[0-9a-f]{32}$/;
const evmAddressPattern = /^0x[0-9a-f]{40}$/;
const tokenDisplayPattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const nonnegativeDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const positiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const signedDecimalPattern =
  /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|-(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*))$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const signedIntegerPattern = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;

interface LosslessJsonNumber {
  readonly isLosslessNumber: true;
  toString(): string;
}

const losslessNumberSchema = z.custom<LosslessJsonNumber>((value) =>
  isLosslessNumber(value),
);
const nonnegativeDecimalSchema = z
  .string()
  .max(128)
  .regex(nonnegativeDecimalPattern);
const positiveDecimalSchema = z.string().max(128).regex(positiveDecimalPattern);
const signedDecimalSchema = z.string().max(128).regex(signedDecimalPattern);
const tokenIdSchema = z.string().regex(tokenIdPattern);
const providerDisplayTextSchema = z.string().min(1).max(128);

const evmContractSchema = z
  .object({
    address: z.string().regex(evmAddressPattern),
    evm_extra_wei_decimals: losslessNumberSchema,
  })
  .strict();
const tokenSchema = z
  .object({
    name: providerDisplayTextSchema,
    szDecimals: losslessNumberSchema,
    weiDecimals: losslessNumberSchema,
    index: losslessNumberSchema,
    tokenId: tokenIdSchema,
    isCanonical: z.boolean().optional(),
    evmContract: evmContractSchema.nullable().optional(),
    fullName: z.string().min(1).max(128).nullable().optional(),
    deployerTradingFeeShare: nonnegativeDecimalSchema.optional(),
    deployerLabel: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();
const universeEntrySchema = z
  .object({
    tokens: z.tuple([losslessNumberSchema, losslessNumberSchema]),
    name: z.string().min(2).max(129),
    index: losslessNumberSchema,
    isCanonical: z.boolean().optional(),
    isDelisted: z.boolean().optional(),
  })
  .strict();
const spotMetaSchema = z
  .object({
    tokens: z.array(tokenSchema).min(2).max(10_000),
    universe: z.array(universeEntrySchema).min(1).max(10_000),
  })
  .strict();
const assetContextSchema = z
  .object({
    prevDayPx: nonnegativeDecimalSchema,
    dayNtlVlm: nonnegativeDecimalSchema,
    markPx: positiveDecimalSchema,
    midPx: positiveDecimalSchema.nullable(),
    circulatingSupply: nonnegativeDecimalSchema,
    coin: z.string().min(2).max(129),
    totalSupply: nonnegativeDecimalSchema,
    dayBaseVlm: nonnegativeDecimalSchema,
  })
  .strict();
const metadataResponseSchema = z.tuple([
  spotMetaSchema,
  z.array(assetContextSchema).min(1).max(10_000),
]);

const bookLevelSchema = z
  .object({
    px: positiveDecimalSchema,
    sz: positiveDecimalSchema,
    n: losslessNumberSchema,
  })
  .strict();
const bookResponseSchema = z
  .object({
    coin: z.string().min(2).max(129),
    time: losslessNumberSchema,
    spread: nonnegativeDecimalSchema.optional(),
    levels: z.tuple([
      z.array(bookLevelSchema).min(1).max(20),
      z.array(bookLevelSchema).min(1).max(20),
    ]),
  })
  .strict();

const balanceSchema = z
  .object({
    coin: providerDisplayTextSchema,
    token: losslessNumberSchema,
    total: nonnegativeDecimalSchema,
    hold: nonnegativeDecimalSchema,
    entryNtl: signedDecimalSchema,
  })
  .strict();
const balancesResponseSchema = z
  .object({
    balances: z.array(balanceSchema).max(10_000),
  })
  .strict();

const userFeesAllowedTopLevelKeys: ReadonlySet<string> = new Set([
  "dailyUserVlm",
  "feeSchedule",
  "userCrossRate",
  "userAddRate",
  "userSpotCrossRate",
  "userSpotAddRate",
  "activeReferralDiscount",
  "trial",
  "feeTrialReward",
  "feeTrialEscrow",
  "nextTrialAvailableTimestamp",
  "stakingLink",
  "activeStakingDiscount",
]);

interface NormalizedAllowlistEntry {
  readonly marketId: string;
  readonly baseTokenId: string;
  readonly quoteTokenId: typeof HYPERLIQUID_TESTNET_USDC_TOKEN_ID;
  readonly spotPairIndex: number;
}

interface InternalMetadataSnapshot {
  readonly publicSnapshot: HyperliquidSpotMetadataSnapshot;
  readonly allTokens: readonly HyperliquidSpotTokenMetadata[];
  readonly expiresAtMilliseconds: number;
}

interface ExactUnsignedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export interface CreateHyperliquidSpotInfoReaderInput {
  readonly transport: HyperliquidSpotInfoTransport;
  readonly quota: HyperliquidInfoQuota;
  readonly markets: readonly HyperliquidSpotMarketAllowlistEntry[];
  readonly now?: () => Date;
}

function unavailable(): never {
  throw new HyperliquidSpotInfoUnavailableError();
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataProperties(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string")
  ) {
    return false;
  }
  const expected = new Set(expectedKeys);
  for (const key of keys) {
    if (typeof key !== "string" || !expected.has(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
  }
  return expectedKeys.every((key) => Object.hasOwn(value, key));
}

function hasAllowedDataProperties(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
  }
  return requiredKeys.every((key) => Object.hasOwn(value, key));
}

function normalizeAllowlist(
  value: readonly HyperliquidSpotMarketAllowlistEntry[],
): readonly NormalizedAllowlistEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new TypeError("Hyperliquid Spot market allowlist is invalid");
  }

  const marketIds = new Set<string>();
  const pairIndexes = new Set<number>();
  const stableIdentities = new Set<string>();
  const normalized = value.map((entry): NormalizedAllowlistEntry => {
    if (
      !isPlainDataRecord(entry) ||
      !hasExactDataProperties(entry, [
        "marketId",
        "baseTokenId",
        "quoteTokenId",
        "spotPairIndex",
      ]) ||
      typeof entry["marketId"] !== "string" ||
      !marketIdPattern.test(entry["marketId"]) ||
      typeof entry["baseTokenId"] !== "string" ||
      !tokenIdPattern.test(entry["baseTokenId"]) ||
      typeof entry["quoteTokenId"] !== "string" ||
      entry["quoteTokenId"] !== HYPERLIQUID_TESTNET_USDC_TOKEN_ID ||
      entry["baseTokenId"] === entry["quoteTokenId"] ||
      typeof entry["spotPairIndex"] !== "number" ||
      !Number.isSafeInteger(entry["spotPairIndex"]) ||
      entry["spotPairIndex"] < 0 ||
      entry["spotPairIndex"] > Number.MAX_SAFE_INTEGER - 10_000
    ) {
      throw new TypeError("Hyperliquid Spot market allowlist is invalid");
    }

    const stableIdentity = `${entry["baseTokenId"]}\0${entry["quoteTokenId"]}\0${entry["spotPairIndex"]}`;
    if (
      marketIds.has(entry["marketId"]) ||
      pairIndexes.has(entry["spotPairIndex"]) ||
      stableIdentities.has(stableIdentity)
    ) {
      throw new TypeError("Hyperliquid Spot market allowlist is invalid");
    }
    marketIds.add(entry["marketId"]);
    pairIndexes.add(entry["spotPairIndex"]);
    stableIdentities.add(stableIdentity);

    return Object.freeze({
      marketId: entry["marketId"],
      baseTokenId: entry["baseTokenId"],
      quoteTokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
      spotPairIndex: entry["spotPairIndex"],
    });
  });
  return Object.freeze(normalized);
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

function readNow(now: () => Date): number {
  const value = now().getTime();
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximumDateMilliseconds
  ) {
    return unavailable();
  }
  return value;
}

function isoTimestamp(value: number): string {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximumDateMilliseconds
  ) {
    return unavailable();
  }
  return new Date(value).toISOString();
}

function rawUnsignedInteger(
  value: LosslessJsonNumber,
  maximum = maximumSafeInteger,
): string {
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

function rawPositiveInteger(value: LosslessJsonNumber): string {
  const text = rawUnsignedInteger(value);
  if (!positiveIntegerPattern.test(text)) {
    return unavailable();
  }
  return text;
}

function rawSafeInteger(value: LosslessJsonNumber): number {
  return Number(rawUnsignedInteger(value));
}

function rawSignedSafeInteger(value: LosslessJsonNumber): number {
  const text = value.toString();
  if (!signedIntegerPattern.test(text)) {
    return unavailable();
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    return unavailable();
  }
  if (parsed < -maximumSafeInteger || parsed > maximumSafeInteger) {
    return unavailable();
  }
  return Number(parsed);
}

function providerTimestamp(value: LosslessJsonNumber): number {
  const parsed = rawSafeInteger(value);
  if (parsed > maximumDateMilliseconds) {
    return unavailable();
  }
  return parsed;
}

function expectedProviderCoin(
  pairIndex: number,
  base: HyperliquidSpotTokenMetadata,
  quote: HyperliquidSpotTokenMetadata,
): string {
  if (pairIndex === 0 && base.symbol === "PURR" && quote.symbol === "USDC") {
    return "PURR/USDC";
  }
  return `@${pairIndex}`;
}

function exactUnsignedDecimal(value: string): ExactUnsignedDecimal {
  if (!nonnegativeDecimalPattern.test(value) || value.length > 128) {
    return unavailable();
  }
  const point = value.indexOf(".");
  const scale = point === -1 ? 0 : value.length - point - 1;
  const digits =
    point === -1 ? value : value.slice(0, point) + value.slice(point + 1);
  return { coefficient: BigInt(digits), scale };
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 128) {
    return unavailable();
  }
  return 10n ** BigInt(exponent);
}

function compareUnsignedDecimals(left: string, right: string): number {
  const a = exactUnsignedDecimal(left);
  const b = exactUnsignedDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const leftCoefficient = a.coefficient * powerOfTen(scale - a.scale);
  const rightCoefficient = b.coefficient * powerOfTen(scale - b.scale);
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
}

function normalizedScale(value: string): number {
  const point = value.indexOf(".");
  if (point === -1) {
    return 0;
  }
  const fraction = value.slice(point + 1).replace(/0+$/, "");
  return fraction.length;
}

function significantFigures(value: string): number {
  const significant = value.replace(".", "").replace(/^0+/, "");
  return significant.length;
}

function decimalWithoutFractionalTrailingZeros(value: string): string {
  const point = value.indexOf(".");
  if (point === -1) {
    return value;
  }
  const fraction = value.slice(point + 1).replace(/0+$/, "");
  return fraction.length === 0
    ? value.slice(0, point)
    : `${value.slice(0, point)}.${fraction}`;
}

function validPriceSignificantFigures(value: string): boolean {
  const wireValue = decimalWithoutFractionalTrailingZeros(value);
  return !wireValue.includes(".") || significantFigures(wireValue) <= 5;
}

function subtractUnsignedDecimals(total: string, hold: string): string {
  const left = exactUnsignedDecimal(total);
  const right = exactUnsignedDecimal(hold);
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * powerOfTen(scale - left.scale);
  const rightCoefficient = right.coefficient * powerOfTen(scale - right.scale);
  if (rightCoefficient > leftCoefficient) {
    return unavailable();
  }
  const difference = leftCoefficient - rightCoefficient;
  if (difference === 0n) {
    return "0";
  }

  let digits = difference.toString();
  if (scale === 0) {
    return digits;
  }
  digits = digits.padStart(scale + 1, "0");
  const point = digits.length - scale;
  const normalized = `${digits.slice(0, point)}.${digits.slice(point)}`
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return normalized;
}

function tokenProjection(
  token: z.infer<typeof tokenSchema>,
): HyperliquidSpotTokenMetadata {
  const tokenIndex = rawSafeInteger(token.index);
  const sizeDecimals = rawSafeInteger(token.szDecimals);
  const weiDecimals = rawSafeInteger(token.weiDecimals);
  if (
    sizeDecimals < 0 ||
    sizeDecimals > 8 ||
    weiDecimals < 0 ||
    weiDecimals > 18 ||
    sizeDecimals > weiDecimals
  ) {
    return unavailable();
  }
  if (token.evmContract !== undefined && token.evmContract !== null) {
    rawSignedSafeInteger(token.evmContract.evm_extra_wei_decimals);
  }
  return Object.freeze({
    tokenIndex,
    tokenId: token.tokenId,
    symbol: token.name,
    fullName: token.fullName ?? null,
    sizeDecimals,
    weiDecimals,
  });
}

function contextProjection(
  context: z.infer<typeof assetContextSchema>,
): HyperliquidSpotMarketContext {
  if (
    !positiveDecimalPattern.test(context.prevDayPx) ||
    context.midPx === null
  ) {
    return unavailable();
  }
  return Object.freeze({
    previousDayPrice: context.prevDayPx,
    dayNotionalVolume: context.dayNtlVlm,
    markPrice: context.markPx,
    midPrice: context.midPx,
    circulatingSupply: context.circulatingSupply,
    totalSupply: context.totalSupply,
    dayBaseVolume: context.dayBaseVlm,
  });
}

function metadataVersion(
  markets: readonly HyperliquidSpotMarketMetadata[],
): string {
  const canonical = [...markets]
    .sort((left, right) =>
      left.marketId < right.marketId
        ? -1
        : left.marketId > right.marketId
          ? 1
          : 0,
    )
    .map((market) => ({
      marketId: market.marketId,
      coin: market.coin,
      base: market.base,
      quote: market.quote,
      spotPairIndex: market.spotPairIndex,
      exchangeOrderAsset: market.exchangeOrderAsset,
    }));
  return createHash("sha256")
    .update(metadataVersionDomain, "utf8")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function parseMetadata(
  raw: unknown,
  allowlist: readonly NormalizedAllowlistEntry[],
  fetchedAtMilliseconds: number,
): InternalMetadataSnapshot {
  const parsed = metadataResponseSchema.parse(raw);
  const [meta, contexts] = parsed;

  const contextsByCoin = new Map<string, z.infer<typeof assetContextSchema>>();
  for (const context of contexts) {
    if (contextsByCoin.has(context.coin)) {
      return unavailable();
    }
    contextsByCoin.set(context.coin, context);
  }

  const tokenIndexes = new Set<number>();
  const tokenIds = new Set<string>();
  const tokens = meta.tokens.map((token): HyperliquidSpotTokenMetadata => {
    const mapped = tokenProjection(token);
    if (tokenIndexes.has(mapped.tokenIndex) || tokenIds.has(mapped.tokenId)) {
      return unavailable();
    }
    tokenIndexes.add(mapped.tokenIndex);
    tokenIds.add(mapped.tokenId);
    return mapped;
  });

  const pairIndexes = new Set<number>();
  const pairCoins = new Set<string>();
  const pairTokenKeys = new Set<string>();
  const providerPairs = meta.universe.map((pair) => {
    const pairIndex = rawSafeInteger(pair.index);
    const baseTokenIndex = rawSafeInteger(pair.tokens[0]);
    const quoteTokenIndex = rawSafeInteger(pair.tokens[1]);
    const base = tokens.find((token) => token.tokenIndex === baseTokenIndex);
    const quote = tokens.find((token) => token.tokenIndex === quoteTokenIndex);
    const context = contextsByCoin.get(pair.name);
    if (
      base === undefined ||
      quote === undefined ||
      base.tokenIndex === quote.tokenIndex ||
      context === undefined ||
      pair.name !== expectedProviderCoin(pairIndex, base, quote) ||
      context.coin !== pair.name
    ) {
      return unavailable();
    }
    const tokenKey = `${baseTokenIndex}\0${quoteTokenIndex}`;
    if (
      pairIndexes.has(pairIndex) ||
      pairCoins.has(pair.name) ||
      pairTokenKeys.has(tokenKey)
    ) {
      return unavailable();
    }
    pairIndexes.add(pairIndex);
    pairCoins.add(pair.name);
    pairTokenKeys.add(tokenKey);
    return {
      pair,
      pairIndex,
      base,
      quote,
      context,
    };
  });

  const markets = allowlist.map((allowed): HyperliquidSpotMarketMetadata => {
    const providerPair = providerPairs.find(
      (candidate) => candidate.pairIndex === allowed.spotPairIndex,
    );
    if (
      providerPair === undefined ||
      providerPair.base.tokenId !== allowed.baseTokenId ||
      providerPair.quote.tokenId !== allowed.quoteTokenId ||
      !tokenDisplayPattern.test(providerPair.base.symbol) ||
      !tokenDisplayPattern.test(providerPair.quote.symbol) ||
      providerPair.quote.symbol !== "USDC" ||
      providerPair.pair.isCanonical !== true ||
      providerPair.pair.isDelisted === true
    ) {
      return unavailable();
    }
    const rawBase = meta.tokens.find(
      (token) => rawSafeInteger(token.index) === providerPair.base.tokenIndex,
    );
    const rawQuote = meta.tokens.find(
      (token) => rawSafeInteger(token.index) === providerPair.quote.tokenIndex,
    );
    if (rawBase?.isCanonical !== true || rawQuote?.isCanonical !== true) {
      return unavailable();
    }
    const exchangeOrderAsset = 10_000 + providerPair.pairIndex;
    if (!Number.isSafeInteger(exchangeOrderAsset)) {
      return unavailable();
    }
    return deepFreeze({
      marketId: allowed.marketId,
      coin: providerPair.pair.name,
      base: providerPair.base,
      quote: providerPair.quote,
      spotPairIndex: providerPair.pairIndex,
      exchangeOrderAsset,
      context: contextProjection(providerPair.context),
    });
  });

  const version = metadataVersion(markets);
  const expiresAtMilliseconds =
    fetchedAtMilliseconds + HYPERLIQUID_SPOT_METADATA_TTL_MILLISECONDS;
  if (expiresAtMilliseconds > maximumDateMilliseconds) {
    return unavailable();
  }
  const publicSnapshot = deepFreeze({
    markets,
    metadataVersion: version,
    source: {
      provider: "hyperliquid" as const,
      network: "testnet" as const,
      dataset: "spotMetaAndAssetCtxs" as const,
      fetchedAt: isoTimestamp(fetchedAtMilliseconds),
      expiresAt: isoTimestamp(expiresAtMilliseconds),
    },
  });
  return deepFreeze({
    publicSnapshot,
    allTokens: tokens,
    expiresAtMilliseconds,
  });
}

function mapBookLevel(
  value: z.infer<typeof bookLevelSchema>,
  market: HyperliquidSpotMarketMetadata,
): HyperliquidSpotBookLevel {
  if (
    normalizedScale(value.px) > 8 - market.base.sizeDecimals ||
    !validPriceSignificantFigures(value.px) ||
    normalizedScale(value.sz) > market.base.sizeDecimals
  ) {
    return unavailable();
  }
  return Object.freeze({
    price: value.px,
    size: value.sz,
    orderCount: rawPositiveInteger(value.n),
  });
}

function validateBookOrdering(
  bids: readonly HyperliquidSpotBookLevel[],
  asks: readonly HyperliquidSpotBookLevel[],
): void {
  for (let index = 1; index < bids.length; index += 1) {
    const previous = bids[index - 1];
    const current = bids[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareUnsignedDecimals(previous.price, current.price) <= 0
    ) {
      return unavailable();
    }
  }
  for (let index = 1; index < asks.length; index += 1) {
    const previous = asks[index - 1];
    const current = asks[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareUnsignedDecimals(previous.price, current.price) >= 0
    ) {
      return unavailable();
    }
  }
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (
    bestBid === undefined ||
    bestAsk === undefined ||
    compareUnsignedDecimals(bestBid.price, bestAsk.price) >= 0
  ) {
    return unavailable();
  }
}

function mapBook(
  raw: unknown,
  market: HyperliquidSpotMarketMetadata,
  metadata: InternalMetadataSnapshot,
  fetchedAtMilliseconds: number,
): HyperliquidSpotBookSnapshot {
  const parsed = bookResponseSchema.parse(raw);
  if (parsed.coin !== market.coin) {
    return unavailable();
  }
  const providerTimeMilliseconds = providerTimestamp(parsed.time);
  if (
    providerTimeMilliseconds >
      fetchedAtMilliseconds +
        HYPERLIQUID_SPOT_BOOK_MAX_FUTURE_SKEW_MILLISECONDS ||
    fetchedAtMilliseconds - providerTimeMilliseconds >=
      HYPERLIQUID_SPOT_BOOK_MAX_AGE_MILLISECONDS
  ) {
    return unavailable();
  }
  const expiresAtMilliseconds = Math.min(
    providerTimeMilliseconds + HYPERLIQUID_SPOT_BOOK_MAX_AGE_MILLISECONDS,
    fetchedAtMilliseconds + HYPERLIQUID_SPOT_PRIVATE_SOURCE_TTL_MILLISECONDS,
  );
  if (
    expiresAtMilliseconds <= fetchedAtMilliseconds ||
    expiresAtMilliseconds > maximumDateMilliseconds
  ) {
    return unavailable();
  }

  const bids = parsed.levels[0].map((level) => mapBookLevel(level, market));
  const asks = parsed.levels[1].map((level) => mapBookLevel(level, market));
  validateBookOrdering(bids, asks);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (bestBid === undefined || bestAsk === undefined) {
    return unavailable();
  }
  return deepFreeze({
    marketId: market.marketId,
    coin: market.coin,
    bids,
    asks,
    bestBid,
    bestAsk,
    source: {
      provider: "hyperliquid" as const,
      network: "testnet" as const,
      dataset: "l2Book" as const,
      providerTime: isoTimestamp(providerTimeMilliseconds),
      fetchedAt: isoTimestamp(fetchedAtMilliseconds),
      expiresAt: isoTimestamp(expiresAtMilliseconds),
      metadataVersion: metadata.publicSnapshot.metadataVersion,
    },
  });
}

function mapBalances(
  raw: unknown,
  metadata: InternalMetadataSnapshot,
  fetchedAtMilliseconds: number,
): HyperliquidSpotBalancesSnapshot {
  const parsed = balancesResponseSchema.parse(raw);
  const seenTokenIndexes = new Set<number>();
  const items = parsed.balances.map((balance): HyperliquidSpotBalanceItem => {
    const tokenIndex = rawSafeInteger(balance.token);
    const token = metadata.allTokens.find(
      (candidate) => candidate.tokenIndex === tokenIndex,
    );
    if (
      token === undefined ||
      token.symbol !== balance.coin ||
      seenTokenIndexes.has(tokenIndex) ||
      compareUnsignedDecimals(balance.hold, balance.total) > 0 ||
      !hasAtMostExactUnsignedDecimalPlaces(balance.total, token.weiDecimals) ||
      !hasAtMostExactUnsignedDecimalPlaces(balance.hold, token.weiDecimals)
    ) {
      return unavailable();
    }
    seenTokenIndexes.add(tokenIndex);
    return Object.freeze({
      token,
      total: balance.total,
      hold: balance.hold,
      available: subtractUnsignedDecimals(balance.total, balance.hold),
      entryNotional: balance.entryNtl,
    });
  });
  const expiresAtMilliseconds =
    fetchedAtMilliseconds + HYPERLIQUID_SPOT_PRIVATE_SOURCE_TTL_MILLISECONDS;
  if (expiresAtMilliseconds > maximumDateMilliseconds) {
    return unavailable();
  }
  return deepFreeze({
    items,
    source: {
      provider: "hyperliquid" as const,
      network: "testnet" as const,
      dataset: "spotClearinghouseState" as const,
      fetchedAt: isoTimestamp(fetchedAtMilliseconds),
      expiresAt: isoTimestamp(expiresAtMilliseconds),
      metadataVersion: metadata.publicSnapshot.metadataVersion,
    },
  });
}

function mapUserFees(
  raw: unknown,
  fetchedAtMilliseconds: number,
): HyperliquidSpotUserFeesSnapshot {
  if (
    !isPlainDataRecord(raw) ||
    !hasAllowedDataProperties(raw, userFeesAllowedTopLevelKeys, [
      "userSpotAddRate",
      "userSpotCrossRate",
    ])
  ) {
    return unavailable();
  }
  const makerRate = raw["userSpotAddRate"];
  const takerRate = raw["userSpotCrossRate"];
  if (
    typeof makerRate !== "string" ||
    makerRate.length > 128 ||
    !signedDecimalPattern.test(makerRate) ||
    typeof takerRate !== "string" ||
    takerRate.length > 128 ||
    !nonnegativeDecimalPattern.test(takerRate)
  ) {
    return unavailable();
  }
  const expiresAtMilliseconds =
    fetchedAtMilliseconds + HYPERLIQUID_SPOT_PRIVATE_SOURCE_TTL_MILLISECONDS;
  if (expiresAtMilliseconds > maximumDateMilliseconds) {
    return unavailable();
  }
  return deepFreeze({
    accountSpotMakerRate: makerRate,
    accountSpotTakerRate: takerRate,
    source: {
      provider: "hyperliquid" as const,
      network: "testnet" as const,
      dataset: "userFees" as const,
      fetchedAt: isoTimestamp(fetchedAtMilliseconds),
      expiresAt: isoTimestamp(expiresAtMilliseconds),
    },
  });
}

function ensureSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    return unavailable();
  }
  value.throwIfAborted();
  return value;
}

function ensureMetadataFresh(
  metadata: InternalMetadataSnapshot,
  nowMilliseconds: number,
): void {
  if (nowMilliseconds >= metadata.expiresAtMilliseconds) {
    return unavailable();
  }
}

async function reserveAndPost(
  quota: HyperliquidInfoQuota,
  transport: HyperliquidSpotInfoTransport,
  cost: number,
  request: HyperliquidSpotInfoRequest,
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
  if (!uuidPattern.test(callId)) {
    return unavailable();
  }
  signal.throwIfAborted();
  return transport.post(request, signal, callId);
}

function sanitizeFailure(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  if (
    error instanceof HyperliquidSpotInfoUnavailableError ||
    error instanceof RetryableHyperliquidSpotInfoError
  ) {
    throw error;
  }
  return unavailable();
}

export function createHyperliquidSpotInfoReader(
  input: CreateHyperliquidSpotInfoReaderInput,
): HyperliquidSpotInfoReader {
  const allowlist = normalizeAllowlist(input.markets);
  const now = input.now ?? (() => new Date());
  let cachedMetadata: InternalMetadataSnapshot | undefined;

  const resolveMetadata = async (
    signal: AbortSignal,
  ): Promise<InternalMetadataSnapshot> => {
    const beforeFetch = readNow(now);
    if (
      cachedMetadata !== undefined &&
      beforeFetch < cachedMetadata.expiresAtMilliseconds
    ) {
      return cachedMetadata;
    }
    cachedMetadata = undefined;
    const raw = await reserveAndPost(
      input.quota,
      input.transport,
      HYPERLIQUID_SPOT_INFO_WEIGHT.spotMetaAndAssetCtxs,
      { type: "spotMetaAndAssetCtxs" },
      signal,
    );
    signal.throwIfAborted();
    const fetchedAt = readNow(now);
    const parsed = parseMetadata(raw, allowlist, fetchedAt);
    cachedMetadata = parsed;
    return parsed;
  };

  return Object.freeze({
    async readMetadata({ signal }: { readonly signal: AbortSignal }) {
      const checkedSignal = ensureSignal(signal);
      try {
        return (await resolveMetadata(checkedSignal)).publicSnapshot;
      } catch (error) {
        return sanitizeFailure(error, checkedSignal);
      }
    },

    async readBook({
      marketId,
      signal,
    }: {
      readonly marketId: string;
      readonly signal: AbortSignal;
    }) {
      const checkedSignal = ensureSignal(signal);
      try {
        if (
          typeof marketId !== "string" ||
          !marketIdPattern.test(marketId) ||
          !allowlist.some((entry) => entry.marketId === marketId)
        ) {
          return unavailable();
        }
        const metadata = await resolveMetadata(checkedSignal);
        const market = metadata.publicSnapshot.markets.find(
          (candidate) => candidate.marketId === marketId,
        );
        if (market === undefined) {
          return unavailable();
        }
        const raw = await reserveAndPost(
          input.quota,
          input.transport,
          HYPERLIQUID_SPOT_INFO_WEIGHT.l2Book,
          {
            type: "l2Book",
            coin: market.coin,
            nSigFigs: 5,
            mantissa: null,
          },
          checkedSignal,
        );
        checkedSignal.throwIfAborted();
        const fetchedAt = readNow(now);
        ensureMetadataFresh(metadata, fetchedAt);
        return mapBook(raw, market, metadata, fetchedAt);
      } catch (error) {
        return sanitizeFailure(error, checkedSignal);
      }
    },

    async readBalances({
      accountAddress,
      signal,
    }: {
      readonly accountAddress: string;
      readonly signal: AbortSignal;
    }) {
      const checkedSignal = ensureSignal(signal);
      try {
        if (
          typeof accountAddress !== "string" ||
          !addressPattern.test(accountAddress) ||
          accountAddress === zeroAddress
        ) {
          return unavailable();
        }
        const metadata = await resolveMetadata(checkedSignal);
        const raw = await reserveAndPost(
          input.quota,
          input.transport,
          HYPERLIQUID_SPOT_INFO_WEIGHT.spotClearinghouseState,
          { type: "spotClearinghouseState", user: accountAddress },
          checkedSignal,
        );
        checkedSignal.throwIfAborted();
        const fetchedAt = readNow(now);
        ensureMetadataFresh(metadata, fetchedAt);
        return mapBalances(raw, metadata, fetchedAt);
      } catch (error) {
        return sanitizeFailure(error, checkedSignal);
      }
    },

    async readUserFees(requestInput: {
      readonly accountAddress: string;
      readonly signal: AbortSignal;
    }) {
      const raw: unknown = requestInput;
      if (
        !isPlainDataRecord(raw) ||
        !hasExactDataProperties(raw, ["accountAddress", "signal"]) ||
        typeof raw["accountAddress"] !== "string" ||
        !addressPattern.test(raw["accountAddress"]) ||
        raw["accountAddress"] === zeroAddress
      ) {
        return unavailable();
      }
      const checkedSignal = ensureSignal(raw["signal"]);
      try {
        const response = await reserveAndPost(
          input.quota,
          input.transport,
          HYPERLIQUID_SPOT_INFO_WEIGHT.userFees,
          { type: "userFees", user: raw["accountAddress"] },
          checkedSignal,
        );
        checkedSignal.throwIfAborted();
        return mapUserFees(response, readNow(now));
      } catch (error) {
        return sanitizeFailure(error, checkedSignal);
      }
    },
  });
}
